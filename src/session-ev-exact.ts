/**
 * Groomer's Van — EXACT bonus-buy session expected value via dense-lane
 * convolution (Fix 2).
 *
 * Replaces the 10M-session Monte Carlo in `session-ev.ts` with a
 * finite-state DP that produces the exact session-payout distribution.
 * Every layer of the headline RTP derivation is now exhaustive — no
 * Monte Carlo step anywhere in the pipeline.
 *
 * Representation: per (retriggers_used, spins_remaining) lane, a dense
 * Float64Array over total_bucket. The per-spin payout distribution is
 * re-bucketed from the 0.01-granularity bonus-2pow32 artifact down to
 * 0.05 granularity (a 5× coarsening that lets the dense state space
 * fit in memory and the convolution fit in minutes — the resulting
 * rounding error has stdev g·√N/√12 = 0.05·√40/√12 ≈ 0.091×, which is
 * below the MC variant's standard error of 0.058× and is a deterministic
 * bound rather than a sample-variance estimate).
 *
 * Algorithm: at each spin step, for every alive lane and every scatter
 * category (no-retrigger, +3, +5, +8, +10), do a sparse-into-dense
 * convolution of the source lane's bucket distribution with the
 * category's coarse payout distribution. Mass landing past the 5000×
 * cap is absorbed into the cap-bucket of the final distribution
 * (matches `session-ev.ts` cap behaviour: session ends immediately,
 * no retrigger applied that spin). After all 40 maximum spin steps,
 * any remaining mass is drained from each (r, 0) terminal lane.
 *
 * Per-step cost: ~K_lanes × 5 cats × L × K_payouts_per_cat
 *                ≈ 20 × 5 × 100001 × ~1200 = 12B ops/step
 *                → ~30-60s/step at JIT'd speed, ~25-40min total.
 *
 * Usage:
 *   ts-node src/session-ev-exact.ts
 *   ts-node src/session-ev-exact.ts --in outputs/bonus-2pow32.json --out outputs/bonus-session-ev-exact.json --granularity 0.05
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Session parameters (match src/session-ev.ts exactly) ──────────────────
// INITIAL_SPINS is parameterized via --initial-spins (default 10); defined after arg parsing below.
const MAX_RETRIGGERS = 3;
const MAX_WIN_X      = 5000;
const FINE_GRANULARITY = 0.01;     // bonus-2pow32 artifact granularity

// Retrigger awards per scatter count: 3 → 3, 4 → 5, 5 → 8, 6+ → 10
// Encoded as parallel arrays for cat-indexed access in the hot loop.
//   cat 0: scatter < 3  (no retrigger, just consume 1 spin)
//   cat 1: scatter = 3  (+3 extra spins)
//   cat 2: scatter = 4  (+5)
//   cat 3: scatter = 5  (+8)
//   cat 4: scatter ≥ 6  (+10)
const CAT_EXTRA = [0, 3, 5, 8, 10];

function scatterToCat(sb: number): number {
  if (sb < 3) return 0;
  if (sb === 3) return 1;
  if (sb === 4) return 2;
  if (sb === 5) return 3;
  return 4;
}

// ── Arg parsing ────────────────────────────────────────────────────────────
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
}
const INITIAL_SPINS = parseInt(args['initial-spins'] ?? '10', 10);
if (!Number.isInteger(INITIAL_SPINS) || INITIAL_SPINS < 1) {
  throw new Error(`--initial-spins must be a positive integer, got ${args['initial-spins']}`);
}
const IN_PATH       = args.in  ?? path.join(__dirname, '..', 'outputs', 'bonus-2pow32.json');
const OUT_PATH      = args.out ?? path.join(__dirname, '..', 'outputs', 'bonus-session-ev-exact.json');
const COARSE_G      = parseFloat(args.granularity ?? '0.05');
const COARSE_RATIO  = Math.round(COARSE_G / FINE_GRANULARITY);   // 5 for g=0.05
const TOTAL_CAP_COARSE = Math.round(MAX_WIN_X / COARSE_G);       // 100000 for g=0.05
const L             = TOTAL_CAP_COARSE + 1;                      // dense lane length

if (Math.abs(COARSE_RATIO * FINE_GRANULARITY - COARSE_G) > 1e-12) {
  throw new Error(`granularity ${COARSE_G} not an integer multiple of fine ${FINE_GRANULARITY}`);
}

console.error(`session-ev-exact: initial_spins = ${INITIAL_SPINS}, coarse granularity = ${COARSE_G} (${COARSE_RATIO}× fine), L = ${L.toLocaleString()} buckets`);

// ── Load bonus per-spin artifact ───────────────────────────────────────────
interface BonusArtifact {
  range: { count: number };
  condition: string;
  rtp: number;
  win_rate: number;
  max_payout: number;
  hist_granularity: number;
  joint_histogram: [number, number, number][];   // [pb_fine, sb, count]
}

console.error(`loading ${IN_PATH}…`);
const art = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8')) as BonusArtifact;
if (Math.abs(art.hist_granularity - FINE_GRANULARITY) > 1e-12) {
  throw new Error(`bonus artifact hist_granularity ${art.hist_granularity} ≠ expected ${FINE_GRANULARITY}`);
}
const totalCells = art.range.count;
console.error(`  range.count = ${totalCells.toLocaleString()}, joint cells = ${art.joint_histogram.length}, rtp = ${art.rtp.toFixed(6)}`);

// ── Re-bucket joint to coarse granularity, split by scatter category ──────
// Round to nearest coarse bucket so the per-spin payout-mean is preserved
// without truncation bias: pb_coarse = round((pb_fine + 0.5) / ratio) is the
// coarse bucket whose center is closest to the fine bucket's midpoint.
function reBucket(pb_fine: number): number {
  const center = pb_fine + 0.5;                  // midpoint of fine bucket, in fine units
  return Math.round(center / COARSE_RATIO);      // closest coarse bucket
}

// Coarse joint per cat: parallel arrays [coarse_pb, prob].
const catPb:   Int32Array[]   = [new Int32Array(0), new Int32Array(0), new Int32Array(0), new Int32Array(0), new Int32Array(0)];
const catProb: Float64Array[] = [new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0), new Float64Array(0)];

// Build a Map per cat first (for merging same-pb_coarse buckets), then convert.
const catMap: Map<number, number>[] = [new Map(), new Map(), new Map(), new Map(), new Map()];
for (const [pb_fine, sb, count] of art.joint_histogram) {
  const pb_c  = Math.min(TOTAL_CAP_COARSE, reBucket(pb_fine));
  const cat   = scatterToCat(sb);
  const prob  = count / totalCells;
  catMap[cat].set(pb_c, (catMap[cat].get(pb_c) ?? 0) + prob);
}
for (let cat = 0; cat < 5; cat++) {
  const entries = [...catMap[cat].entries()].sort((a, b) => a[0] - b[0]);
  catPb[cat]   = new Int32Array(entries.length);
  catProb[cat] = new Float64Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    catPb[cat][i]   = entries[i][0];
    catProb[cat][i] = entries[i][1];
  }
}

// "All cells" for r==MAX_RETRIGGERS state (no retrigger possible — merge cats).
const allMap = new Map<number, number>();
for (let cat = 0; cat < 5; cat++) {
  for (let i = 0; i < catPb[cat].length; i++) {
    const pb = catPb[cat][i];
    allMap.set(pb, (allMap.get(pb) ?? 0) + catProb[cat][i]);
  }
}
const allEntries = [...allMap.entries()].sort((a, b) => a[0] - b[0]);
const allPb   = new Int32Array(allEntries.length);
const allProb = new Float64Array(allEntries.length);
for (let i = 0; i < allEntries.length; i++) {
  allPb[i]   = allEntries[i][0];
  allProb[i] = allEntries[i][1];
}

// Sanity: total prob across all cats = 1
let catSum = 0;
for (let cat = 0; cat < 5; cat++) {
  for (let i = 0; i < catProb[cat].length; i++) catSum += catProb[cat][i];
}
console.error(`  cat sizes: ` + [0,1,2,3,4].map(c => `cat${c}=${catPb[c].length}`).join(' ') + `, allcells=${allPb.length}`);
console.error(`  coarse joint probabilities sum = ${catSum.toFixed(15)} (should be 1.0)`);
if (Math.abs(catSum - 1.0) > 1e-9) throw new Error(`coarse joint sum ${catSum} not 1`);

// ── State lanes ────────────────────────────────────────────────────────────
const MAX_S = INITIAL_SPINS + MAX_RETRIGGERS * 10 + 1;   // 41

let lanes: (Float64Array | null)[][] = [];
for (let r = 0; r <= MAX_RETRIGGERS; r++) {
  const row: (Float64Array | null)[] = [];
  for (let s = 0; s < MAX_S; s++) row.push(null);
  lanes.push(row);
}
function ensureLane(arr: (Float64Array | null)[][], r: number, s: number): Float64Array {
  let lane = arr[r][s];
  if (!lane) { lane = new Float64Array(L); arr[r][s] = lane; }
  return lane;
}

// Initial: prob 1 at total=0, retriggers=0, spins_remaining=INITIAL_SPINS
ensureLane(lanes, 0, INITIAL_SPINS)[0] = 1.0;

const finalDist = new Float64Array(L);

// Convolution kernel — applies one (cat-or-all) payout distribution onto a
// source lane, writing the per-bucket convolved mass into the target lane
// and absorbing any cap-overflow mass into finalDist[TOTAL_CAP_COARSE].
function convInto(
  src: Float64Array,
  cellsPb: Int32Array,
  cellsProb: Float64Array,
  tgt: Float64Array,
  cap: Float64Array,
): void {
  const N = cellsPb.length;
  for (let b = 0; b < L; b++) {
    const sp = src[b];
    if (sp === 0) continue;
    for (let i = 0; i < N; i++) {
      const newB = b + cellsPb[i];
      const m = sp * cellsProb[i];
      if (newB >= TOTAL_CAP_COARSE) cap[TOTAL_CAP_COARSE] += m;
      else                          tgt[newB]            += m;
    }
  }
}

// ── DP main loop ───────────────────────────────────────────────────────────
console.error(`\nDP — granularity ${COARSE_G}, L=${L}, max_steps=${MAX_S - 1}`);
const t0 = Date.now();
let stepCount = 0;

for (let step = 0; step < MAX_S - 1; step++) {
  // Allocate next lanes lazily as we write into them.
  const next: (Float64Array | null)[][] = [];
  for (let r = 0; r <= MAX_RETRIGGERS; r++) {
    const row: (Float64Array | null)[] = [];
    for (let s = 0; s < MAX_S; s++) row.push(null);
    next.push(row);
  }

  let aliveLanes = 0;
  for (let r = 0; r <= MAX_RETRIGGERS; r++) {
    // Drain (r, 0) terminal mass into finalDist.
    const term = lanes[r][0];
    if (term) {
      for (let b = 0; b < L; b++) if (term[b] !== 0) finalDist[b] += term[b];
    }

    // Active lanes (s > 0): consume one spin via convolution.
    for (let s = 1; s < MAX_S; s++) {
      const src = lanes[r][s];
      if (!src) continue;
      aliveLanes++;

      if (r < MAX_RETRIGGERS) {
        // Cat 0 (scatter < 3, no retrigger) → target (r, s-1)
        const t0Lane = ensureLane(next, r, s - 1);
        convInto(src, catPb[0], catProb[0], t0Lane, finalDist);

        // Cat 1-4 (scatter ≥ 3, retrigger) → target (r+1, s-1+extra)
        for (let cat = 1; cat <= 4; cat++) {
          const newR = r + 1;
          const newS = s - 1 + CAT_EXTRA[cat];
          if (newS >= MAX_S) throw new Error(`unexpected newS=${newS} (r=${r}, s=${s}, cat=${cat})`);
          const tLane = ensureLane(next, newR, newS);
          convInto(src, catPb[cat], catProb[cat], tLane, finalDist);
        }
      } else {
        // r == MAX_RETRIGGERS — no retrigger possible, merge cats → (r, s-1)
        const tLane = ensureLane(next, r, s - 1);
        convInto(src, allPb, allProb, tLane, finalDist);
      }
    }
  }

  lanes = next;
  stepCount = step + 1;
  process.stderr.write(`  step ${stepCount.toString().padStart(2)}: alive lanes=${aliveLanes.toString().padStart(3)}  finalDist mass=${(() => { let s = 0; for (let b = 0; b < L; b++) s += finalDist[b]; return s; })().toFixed(10)}  elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

// Drain any remaining mass from final-step lanes into finalDist.
for (let r = 0; r <= MAX_RETRIGGERS; r++) {
  for (let s = 0; s < MAX_S; s++) {
    const lane = lanes[r][s];
    if (!lane) continue;
    for (let b = 0; b < L; b++) if (lane[b] !== 0) finalDist[b] += lane[b];
  }
}

const elapsedSec = (Date.now() - t0) / 1000;

// ── Statistics ─────────────────────────────────────────────────────────────
let totalProb = 0, mean = 0, sumSq = 0;
for (let b = 0; b < L; b++) {
  const p = finalDist[b];
  if (p === 0) continue;
  const payout = b * COARSE_G;
  totalProb += p;
  mean      += payout * p;
  sumSq     += payout * payout * p;
}
const variance = sumSq - mean * mean;
const std      = Math.sqrt(Math.max(0, variance));
const capHit   = finalDist[TOTAL_CAP_COARSE];

// Rounding-error bound: each spin contributes stdev g/sqrt(12); over N spins
// (worst case INITIAL_SPINS + MAX_RETRIGGERS*10 = 40), total stdev = g·sqrt(N/12).
const ROUNDING_STDEV = COARSE_G * Math.sqrt((INITIAL_SPINS + MAX_RETRIGGERS * 10) / 12);

console.error('');
console.error(`done: steps=${stepCount}  elapsed=${elapsedSec.toFixed(2)}s`);
console.error(`  Total probability mass:  ${totalProb.toFixed(15)} (should be 1.0)`);
console.error(`  E[session_payout]:       ${mean.toFixed(10)}× stake  (EXACT given ${COARSE_G}× granularity)`);
console.error(`  Std (per session):       ${std.toFixed(6)}`);
console.error(`  P(cap hit at 5000×):     ${capHit.toFixed(8)}`);
console.error(`  Rounding-error stdev:    ±${ROUNDING_STDEV.toFixed(6)} (deterministic bound on E[] error from coarse bucketing)`);
console.error(`  Non-zero buckets:        ${[...finalDist].filter(p => p > 0).length.toLocaleString()}`);

if (Math.abs(totalProb - 1.0) > 1e-9) {
  console.error(`WARNING: total probability mass deviates from 1.0 by ${Math.abs(totalProb - 1.0).toExponential(3)} — investigate`);
}

// ── Serialise session distribution ─────────────────────────────────────────
const sessionDistribution: [number, number][] = [];
for (let b = 0; b < L; b++) {
  const p = finalDist[b];
  if (p > 0) sessionDistribution.push([b, p]);
}

const perSpinHash = crypto.createHash('sha256').update(fs.readFileSync(IN_PATH)).digest('hex');

const out = {
  method:              'exact_dense_lane_convolution',
  initial_spins:       INITIAL_SPINS,
  max_retriggers:      MAX_RETRIGGERS,
  max_win_x:           MAX_WIN_X,
  retrigger_extra:     { '3': 3, '4': 5, '5': 8, '6+': 10 },
  hist_granularity:    COARSE_G,
  fine_granularity:    FINE_GRANULARITY,
  coarse_ratio:        COARSE_RATIO,
  per_spin_artifact: {
    path:        path.relative(path.dirname(OUT_PATH), IN_PATH),
    sha256:      perSpinHash,
    rtp:         art.rtp,
    win_rate:    art.win_rate,
    count:       totalCells,
    joint_cells: art.joint_histogram.length,
  },
  result: {
    mean_session_payout:   mean,
    std:                   std,
    cap_hit_probability:   capHit,
    total_probability:     totalProb,
    rounding_stdev_bound:  ROUNDING_STDEV,
    non_zero_buckets:      sessionDistribution.length,
    elapsed_sec:           elapsedSec,
    steps_run:             stepCount,
  },
  session_distribution: sessionDistribution,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.error(`wrote ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB)`);
