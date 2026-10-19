/**
 * Groomer's Van — bonus-buy session expected value.
 *
 * Reads the exhaustive bonus per-spin distribution (joint histogram of
 * payout × scatter count from the 2³² CUDA enumeration) and computes
 * the expected value of a single bonus-buy session via Monte Carlo
 * over the empirically-exact per-spin distribution.
 *
 * Session model (the 5000× session cap per the operator's written answers, evidence E03 — held on file,
 * not published; the spin counts per the operator config, data/raw/groomers-van-config-v1.4.json):
 *   - Buy enters as the 4-scatter case → 10 free spins initial
 *   - Each spin: sample (payout, scatter_count) from the joint distribution
 *   - Per-spin payout already capped at 5000× by the per-spin enumeration
 *   - Per-session: running total accumulates until ≥ 5000×, then
 *     session FREEZES (payout clamped to exactly 5000×, remaining spins pay 0)
 *   - Retrigger: scatter count ≥ 3 in a bonus spin awards extra spins
 *     (3 → 3, 4 → 5, 5 → 8, 6+ → 10), max 3 retriggers per session
 *
 * Output: JSON with mean, variance, percentile distribution, and the
 * sampled session-payout histogram.
 *
 * Usage:
 *   ts-node session-ev.ts --in bonus-2pow32.json --sessions 10000000 --out bonus-session-ev.json
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

interface PerSpinArtifact {
  range: { from: number; to: number; count: number };
  condition: 'bonus_game';
  rtp: number;
  win_rate: number;
  max_payout: number;
  hist_granularity: number;          // 0.01 → buckets are payout × 100
  histogram: [number, number][];     // [bucket_int, count]
  scatter_histogram: number[];       // index = scatter count, length 8
  joint_histogram: [number, number, number][];   // [payout_bucket, scatter_bucket, count]
}

interface JointDistribution {
  // Flat arrays for fast sampling
  cumWeights:   Float64Array;        // cumulative counts as fraction of total (≤ 1)
  payouts:      Float64Array;        // payout value (un-bucketed via × 0.01)
  scatters:     Uint8Array;          // scatter count per joint cell
  totalCount:   number;
}

function buildJoint(art: PerSpinArtifact): JointDistribution {
  const total = art.range.count;
  // Sort joint entries by (payout, scatter) for deterministic ordering
  const entries = [...art.joint_histogram].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = entries.length;
  const cumWeights = new Float64Array(n);
  const payouts    = new Float64Array(n);
  const scatters   = new Uint8Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += entries[i][2];
    cumWeights[i] = acc / total;
    payouts[i]    = entries[i][0] * art.hist_granularity;   // un-bucket
    scatters[i]   = entries[i][1];
  }
  // last cumWeight should be 1.0 (modulo float epsilon)
  if (Math.abs(cumWeights[n - 1] - 1.0) > 1e-9) {
    throw new Error(`joint histogram does not sum to total: ${cumWeights[n-1]}`);
  }
  return { cumWeights, payouts, scatters, totalCount: n };
}

// Binary search for the cumWeights index where cumWeights[i] > r
function sampleIndex(joint: JointDistribution, r: number): number {
  let lo = 0, hi = joint.totalCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (joint.cumWeights[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Free spins awarded by scatter count (operator config retrigger_rewards / max_retriggers,
// data/raw/groomers-van-config-v1.4.json):
// Retriggers: 3 → 3, 4 → 5, 5 → 8, 6+ → 10
const RETRIGGER_SPINS: Record<number, number> = { 3: 3, 4: 5, 5: 8, 6: 10, 7: 10 };
const MAX_RETRIGGERS = 3;
const MAX_WIN_X = 5000;
const INITIAL_SPINS = 10;          // buy_scatter_count = 4 → 10 initial spins

function simulateSession(joint: JointDistribution, rng: () => number): { payout: number; spins: number; retriggers: number } {
  let total = 0;
  let spinsRemaining = INITIAL_SPINS;
  let spinsRun = 0;
  let retriggers = 0;
  while (spinsRemaining > 0) {
    spinsRemaining--;
    spinsRun++;
    const r = rng();
    const i = sampleIndex(joint, r);
    const p = joint.payouts[i];
    const s = joint.scatters[i];
    total += p;
    if (total >= MAX_WIN_X) {
      total = MAX_WIN_X;
      break;
    }
    if (s >= 3 && retriggers < MAX_RETRIGGERS) {
      const sLookup = s >= 6 ? 6 : s;
      const extra = RETRIGGER_SPINS[sLookup] ?? 0;
      spinsRemaining += extra;
      retriggers++;
    }
  }
  return { payout: total, spins: spinsRun, retriggers };
}

// Mulberry32 — fast deterministic PRNG with good statistical properties.
function mulberry32(seed: number) {
  return function() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  const inPath  = args.in  ?? 'bonus-2pow32.json';
  const outPath = args.out ?? 'bonus-session-ev.json';
  const N       = parseInt(args.sessions ?? '10000000', 10);
  const seed    = parseInt(args.seed ?? '1337', 10);

  console.error(`loading ${inPath}…`);
  const art = JSON.parse(fs.readFileSync(inPath, 'utf-8')) as PerSpinArtifact;
  console.error(`per-spin: count=${art.range.count.toLocaleString()}, rtp=${art.rtp.toFixed(6)}, joint cells=${art.joint_histogram.length}`);

  const joint = buildJoint(art);
  console.error(`joint distribution built (${joint.totalCount} cells)`);

  console.error(`simulating ${N.toLocaleString()} sessions (seed=${seed})…`);
  const rng = mulberry32(seed);
  let sum = 0, sumSq = 0;
  let spinsTotal = 0, retriggersTotal = 0;
  let maxSession = 0;
  let capHits = 0;
  // Histogram of session payouts at 1.0× granularity (0..5000 → 5001 buckets)
  const sessHist = new Uint32Array(5001);

  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const r = simulateSession(joint, rng);
    sum += r.payout;
    sumSq += r.payout * r.payout;
    spinsTotal += r.spins;
    retriggersTotal += r.retriggers;
    if (r.payout > maxSession) maxSession = r.payout;
    if (r.payout >= MAX_WIN_X) capHits++;
    const b = Math.floor(r.payout);
    sessHist[b >= 5000 ? 5000 : b]++;

    if ((i + 1) % 1_000_000 === 0) {
      const e = (Date.now() - t0) / 1000;
      const rate = (i + 1) / e;
      console.error(`  ${(((i + 1) / N) * 100).toFixed(1)}%  rate=${(rate / 1000).toFixed(0)}K/s  ev_so_far=${(sum / (i + 1)).toFixed(4)}`);
    }
  }
  const elapsedSec = (Date.now() - t0) / 1000;

  const mean = sum / N;
  const variance = sumSq / N - mean * mean;
  const std = Math.sqrt(variance);
  const seMean = std / Math.sqrt(N);
  const avgSpins = spinsTotal / N;
  const avgRetriggers = retriggersTotal / N;

  console.error('');
  console.error(`done: sessions=${N.toLocaleString()}  elapsed=${elapsedSec.toFixed(2)}s`);
  console.error(`  E[session_payout]   = ${mean.toFixed(6)}× stake`);
  console.error(`  SD                  = ${std.toFixed(4)}`);
  console.error(`  SE of mean          = ${seMean.toFixed(6)}`);
  console.error(`  avg spins/session   = ${avgSpins.toFixed(4)}`);
  console.error(`  avg retriggers/sess = ${avgRetriggers.toFixed(6)}`);
  console.error(`  max win cap hits    = ${capHits}/${N} (${(capHits / N * 100).toFixed(4)}%)`);
  console.error(`  max session payout  = ${maxSession.toFixed(4)}`);

  // Compute SHA-256 of the per-spin artifact for traceability
  const perSpinHash = crypto.createHash('sha256').update(fs.readFileSync(inPath)).digest('hex');

  const out = {
    sessions: N,
    seed,
    initial_spins: INITIAL_SPINS,
    max_retriggers: MAX_RETRIGGERS,
    max_win_x: MAX_WIN_X,
    retrigger_spins: RETRIGGER_SPINS,
    per_spin_artifact: { path: inPath, sha256: perSpinHash, rtp: art.rtp, win_rate: art.win_rate, count: art.range.count },
    result: {
      mean_session_payout: mean,
      std: std,
      se_of_mean: seMean,
      avg_spins_per_session: avgSpins,
      avg_retriggers_per_session: avgRetriggers,
      max_win_cap_hit_rate: capHits / N,
      max_session_payout: maxSession,
      elapsed_sec: elapsedSec,
    },
    session_histogram: Array.from(sessHist).map((c, b) => [b, c]).filter(([_, c]) => c > 0),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`wrote ${outPath}`);
}

main();
