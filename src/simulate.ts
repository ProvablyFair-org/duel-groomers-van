/**
 * Groomer's Van — Monte Carlo simulator.
 *
 * Two-pass design (matches the PF.org methodology used on every prior
 * Duel original audit):
 *
 *   PASS 1: theoretical-RTP convergence using a pinned master seed
 *           (HMAC-derived PCG32 state) — fully reproducible across runs.
 *           Confirms the Monte Carlo estimate of base-game RTP +
 *           bonus contribution converges to ~100% (the game's claimed
 *           Zero Edge target). Reports chi-squared on the cluster-size
 *           distribution per reel and serial-independence on per-spin
 *           payouts.
 *
 *   PASS 2: forward-replay cherry-pick detection on the audit's
 *           captured server seeds. For each committed (serverSeed,
 *           clientSeed) epoch, replay 10,000 nonces through the
 *           verified base-game algorithm. Each seed's early window
 *           (nonces 0..49 — what an operator could have inspected
 *           before committing) and late window (50..9,999) are
 *           chi-squared (win/no-win, 1 d.o.f.) against the exact
 *           enumerated win rate from base-2pow32.json. Flag = early
 *           p<0.05 AND late p≥0.05. Verdict via binomial
 *           P(X ≥ flags | n=epochs, p=0.05) ≥ 0.01.
 *
 * Output:
 *   outputs/simulation-results.json   — machine-readable summary
 *   outputs/rtp-convergence.html      — self-contained Chart.js page
 *
 * Run with:  npm run simulate
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Pcg32, generateGrid, generateMultipliers, REELS, ROWS } from './rng';
import { findClusters, countScatters, BONUS_CODE } from './cluster';
import {
  loadOperatorConfig, loadDataset, buildSeedMap,
} from './loader';
import { loadPaytable, freeSpinsAwarded, scatterMultiplier, clusterMultiplier, type Paytable, type Condition } from './paytable';
import { computeOutcomeIndex, deriveTumbleSeed } from './rng';
import type { OperatorConfig } from './types';
import {
  chiSquaredPValue, poolTailBins, lag1Autocorrelation, waldWolfowitzRunsP,
  bonferroniCriticalZ,
} from './stats';

// ── Tuning knobs ────────────────────────────────────────────────────────────
//
// Production sample: 30M base spins (default for `npm run simulate`).
//
// GVS_QUICK=1                       — 50K dev sim (~1s, wider MC noise but still PASS)
// GVS_BASE_SPINS=<N>                — override sample size
// GVS_MASTER_SEED=<string>          — override master seed (default pinned, see below)
const QUICK = ['1', 'true', 'yes'].includes(String(process.env.GVS_QUICK ?? '').toLowerCase());
const PASS1_BASE_SPINS     = parseInt(process.env.GVS_BASE_SPINS ?? '', 10) || (QUICK ? 50_000 : 30_000_000);

// Pinned master seed for reproducibility. Same master seed → same PRNG state →
// same simulation output. Reviewers running the audit pipeline get bit-for-bit
// identical numbers to the published headline.
//
// The PRNG seed is derived via HMAC-SHA256(masterSeed, "groomers-van-pass1"),
// taking the first 4 bytes BE — same HMAC primitive the operator uses for
// outcome_index, so no extra crypto dependency.
const MASTER_SEED   = process.env.GVS_MASTER_SEED ?? 'pf-audit-groomers-van-v1';
const PRNG_SEED_HEX = crypto.createHmac('sha256', MASTER_SEED).update('groomers-van-pass1').digest();
const PRNG_SEED     = PRNG_SEED_HEX.readUInt32BE(0);

// Convergence snapshots adapt to PASS1_BASE_SPINS — any value ≤ run size is
// recorded. Final snapshot always equals the run's last spin.
const CONVERGENCE_SAMPLES  = (QUICK
  ? [1_000, 5_000, 10_000, 50_000]
  : [1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000,
     5_000_000, 10_000_000, 30_000_000, 100_000_000]
).filter(n => n <= PASS1_BASE_SPINS);
if (CONVERGENCE_SAMPLES[CONVERGENCE_SAMPLES.length - 1] !== PASS1_BASE_SPINS) {
  CONVERGENCE_SAMPLES.push(PASS1_BASE_SPINS);
}

const OUTPUTS = path.join(__dirname, '..', 'outputs');
fs.mkdirSync(OUTPUTS, { recursive: true });

// ── Symbol-table builder ────────────────────────────────────────────────────

interface SymbolTables {
  codes:   string[];
  weights: number[][];
  multiplierSymbolIndex: number;
  multiplierValues:      number[];
  multiplierWeights:     number[];
}

function buildTables(config: OperatorConfig, paytable: Paytable, condition: Condition): SymbolTables {
  const symbols = [...config.weights.symbols_by_condition[condition]]
    .sort((a, b) => a.symbol_index - b.symbol_index);
  const codes = symbols.map(s => s.code);
  const weights: number[][] = [];
  for (let r = 0; r < REELS; r++) weights.push(symbols.map(s => s.weights_per_reel[r]));
  const multIdx  = symbols.findIndex(s => s.code === 'multiplier');
  const multVals = condition === 'bonus_game' ? paytable.multiplierValuesList   : [];
  const multWts  = condition === 'bonus_game' ? paytable.multiplierWeightsList  : [];
  return { codes, weights, multiplierSymbolIndex: multIdx, multiplierValues: multVals, multiplierWeights: multWts };
}

// ── Single-spin / single-session payout ────────────────────────────────────

/**
 * Sample one symbol-INDEX from a per-reel weight table using the
 * shared PRNG (rejection-sampled — bias-free).
 */
function pickIndex(prng: Pcg32, weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  const maxFair = 0xFFFFFFFF - (0xFFFFFFFF % total);
  let rnd: number;
  do { rnd = prng.nextUint32(); } while (rnd >= maxFair);
  const pick = rnd % total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (pick < acc) return i;
  }
  throw new Error('pickIndex unreachable');
}

// Max-win cap (5000× stake). Per Duel: enforced per-spin (after each
// cascade and after the end-of-feature bomb) AND per bonus session
// (after each free spin). Once hit, the response uses the capped value
// and remaining spins are zeroed.
const MAX_WIN_X = 5000;

/**
 * Core spin payout from a deterministic outcome_index. Pulled out so
 * Pass 2 forward-replay can call the same code path with an outcome_index
 * derived from (serverSeed, clientSeed, nonce) rather than from a PRNG.
 *
 * Per Duel: each spin has its own outcome_index (one nonce → one HMAC).
 * Each cascade derives a fresh tumble_seed from (outcome_index, round, tumble)
 * and a fresh PCG32 instance, then generates a full 30-cell grid. The top
 * of each column is filled from the new grid; survivors slide down.
 */
function spinPayoutFromOutcomeIndex(
  outcomeIndex: number,
  paytable: Paytable, condition: Condition, tables: SymbolTables,
): { payout: number; scatters: number; clusterSizesByReel: Record<number, number[]>; maxWinReached: boolean } {
  const roundIndex = 0;

  let totalBaseMult  = 0;     // sum of cluster base multipliers across all cascades
  let maxWinReached  = false;
  const clusterSizesByReel: Record<number, number[]> = {};

  // ── Cascade 0 (initial deal) ──────────────────────────────────────────
  let tumbleIndex = 0;
  let tumbleSeed  = deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex);
  let cascadePrng = new Pcg32(tumbleSeed);
  let idxGrid     = generateGrid(cascadePrng, tables.weights);

  for (let col = 0; col < REELS; col++) {
    const sizes: number[] = [];
    for (let row = 0; row < ROWS; row++) sizes.push(idxGrid[col][row]);
    clusterSizesByReel[col] = sizes;
  }

  let codeGrid: string[][] = idxGrid.map(col => col.map(i => tables.codes[i]));
  // Trigger / retrigger uses the cumulative scatter count across all
  // cascade levels. Scatters never appear in clusters and so are never
  // removed — count in the final post-cascade grid is the cumulative count.
  let cumulativeScatters = countScatters(codeGrid);

  // Bombs accumulate across all cascades and apply ONCE at end of spin to
  // the sum of all cluster base payouts. Verified against 475/475 captured
  // free spins: every payline records the same final bomb_multiplier and
  // total_win = sum(base) × max(bomb, 1) reconciles exactly. Multipliers
  // only appear in bonus_game (per the operator's tumble_multiplier weight
  // table — base_game has no multiplier symbol).
  let cumulativeBombs = 0;
  if (condition === 'bonus_game') {
    const initialMultipliers = generateMultipliers(
      idxGrid, cascadePrng, tables.multiplierSymbolIndex, tables.multiplierValues, tables.multiplierWeights,
    );
    for (const m of initialMultipliers) cumulativeBombs += m.value;
  }

  // ── Cascade loop ──────────────────────────────────────────────────────
  for (let cascade = 0; cascade < 30; cascade++) {
    const clusters = findClusters(codeGrid);
    const removedSet = new Set<number>();
    for (const c of clusters) {
      // `paytable.minClusterSize` is the operator's `rules.min_cluster_size`
      // (= 4) — the engine's geometric minimum. The effective PAYING
      // minimum is 8: per-symbol tables publish no entries for sizes 4–7,
      // so `clusterMultiplier` returns 0 for those and the `baseMult <= 0`
      // guard below skips removal. RTP-equivalent to gating at 8 directly.
      if (c.size < paytable.minClusterSize) continue;
      const baseMult = clusterMultiplier(paytable, condition, c.symbol, c.size);
      if (baseMult <= 0) continue;
      totalBaseMult += baseMult;
      for (const p of c.positions) removedSet.add(p);
    }
    if (removedSet.size === 0) break;

    // Next cascade level: fresh tumble_seed → fresh PCG32 → full new grid
    tumbleIndex += 1;
    tumbleSeed   = deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex);
    cascadePrng  = new Pcg32(tumbleSeed);
    const newGrid = generateGrid(cascadePrng, tables.weights);

    // Multipliers in the new grid are drawn from the same per-cascade PCG32
    // stream right after the grid (per Duel spec).
    const newGridMultipliers = condition === 'bonus_game'
      ? generateMultipliers(newGrid, cascadePrng, tables.multiplierSymbolIndex, tables.multiplierValues, tables.multiplierWeights)
      : [];

    // Gravity per column + fill top empty cells from newGrid (top-down)
    const filledNewPositions = new Set<number>();
    for (let col = 0; col < REELS; col++) {
      const survivors: number[] = [];
      for (let row = 0; row < ROWS; row++) {
        const pos = col * ROWS + row;
        if (!removedSet.has(pos)) survivors.push(idxGrid[col][row]);
      }
      const newCount = ROWS - survivors.length;
      for (let i = 0; i < newCount; i++) {
        idxGrid[col][i]  = newGrid[col][i];
        codeGrid[col][i] = tables.codes[newGrid[col][i]];
        filledNewPositions.add(col * ROWS + i);
      }
      for (let i = 0; i < survivors.length; i++) {
        const targetRow = newCount + i;
        idxGrid[col][targetRow]  = survivors[i];
        codeGrid[col][targetRow] = tables.codes[survivors[i]];
      }
    }

    // Only multipliers landing on actual play-grid positions contribute bombs
    for (const m of newGridMultipliers) {
      if (filledNewPositions.has(m.position)) cumulativeBombs += m.value;
    }

    cumulativeScatters = countScatters(codeGrid);
  }

  // End-of-spin payout: every cluster pay × the final cumulative bomb.
  let payout = totalBaseMult * Math.max(cumulativeBombs, 1);

  // Scatter pay (base_game only, applied once at end of spin per Duel spec).
  // Gate on the operator-published minScattersToTrigger; the paytable has no
  // entries below that count, so scatterMultiplier returns 0 naturally —
  // keeps all three engines consistent without coupling to a literal.
  if (condition === 'base_game' && cumulativeScatters >= paytable.minScattersToTrigger) {
    payout += scatterMultiplier(paytable, condition, cumulativeScatters);
  }

  if (payout > MAX_WIN_X) {
    payout = MAX_WIN_X;
    maxWinReached = true;
  }

  return { payout, scatters: cumulativeScatters, clusterSizesByReel, maxWinReached };
}

/**
 * Pass 1 entry point: draw a fresh outcome_index from the shared PRNG and
 * defer to the deterministic core. Same code path Pass 2 forward-replay
 * uses with a (serverSeed, clientSeed, nonce)-derived outcome_index.
 */
function spinPayout(
  paytable: Paytable, condition: Condition, tables: SymbolTables, prng: Pcg32,
): { payout: number; scatters: number; clusterSizesByReel: Record<number, number[]>; maxWinReached: boolean } {
  return spinPayoutFromOutcomeIndex(prng.nextUint32(), paytable, condition, tables);
}

function sessionPayout(
  paytable: Paytable, tables: SymbolTables, prng: Pcg32, initialSpins: number,
): number {
  let total = 0, remaining = initialSpins, retriggers = 0;
  while (remaining > 0) {
    if (total >= MAX_WIN_X) {
      total = MAX_WIN_X;
      break; // remaining session spins capped to 0 per Duel spec
    }
    const r = spinPayout(paytable, 'bonus_game', tables, prng);
    total += r.payout;
    if (total >= MAX_WIN_X) {
      total = MAX_WIN_X;
      break;
    }
    remaining--;
    if (retriggers < paytable.maxBonusRetriggers && r.scatters >= paytable.minScattersToTrigger) {
      remaining += freeSpinsAwarded(paytable, r.scatters, true);
      retriggers++;
    }
  }
  return total;
}

// ── Progress bars ───────────────────────────────────────────────────────────

function progress(label: string, current: number, total: number, startMs: number): void {
  const pct = current / total;
  const w   = 30;
  const filled = Math.floor(pct * w);
  const bar = '━'.repeat(filled) + '╌'.repeat(w - filled);
  const elapsed = (Date.now() - startMs) / 1000;
  const eta     = pct > 0 ? Math.max(0, elapsed / pct - elapsed) : 0;
  process.stdout.write(`\r  ${label} [${bar}] ${(pct * 100).toFixed(1).padStart(5)}%  elapsed ${elapsed.toFixed(1)}s  eta ${eta.toFixed(0)}s`);
  if (current >= total) process.stdout.write('\n');
}

// ── Pass 1 ──────────────────────────────────────────────────────────────────

console.log('==============================================================');
console.log("  GROOMER'S VAN — Monte Carlo Simulation");
console.log('==============================================================');

const config   = loadOperatorConfig();
const paytable = loadPaytable();
const baseTables  = buildTables(config, paytable, 'base_game');
const bonusTables = buildTables(config, paytable, 'bonus_game');

const prng1 = new Pcg32(PRNG_SEED);

console.log(`\nPass 1: ${PASS1_BASE_SPINS.toLocaleString()} base spins (integrated trigger+session, pinned PCG32 stream)`);
const pass1Start = Date.now();

// Per-reel symbol-index counts for chi-squared.
const reelCounts: number[][] = [];
for (let r = 0; r < REELS; r++) reelCounts.push(new Array(baseTables.codes.length).fill(0));

const baseConvergence: { rounds: number; rtp: number }[] = [];
const baseSpinPayouts: number[] = [];   // for serial-independence test
let baseTotalPayout = 0, baseTriggered = 0;
let bonusTotalPayout = 0, bonusSessionsRun = 0;
const triggerScatterDist: Record<number, number> = {};
let nextSnapshot = 0;

// Integrated theoretical-RTP simulation:
// for each base spin, compute its base payout AND, if it triggers, run its
// bonus session with the right number of initial free spins from the
// spin's own scatter count. blendedRTP = (baseTotal + bonusTotal) / N_base.
// This is the correct theoretical-RTP estimator: it weights bonus
// contribution by the scatter-count distribution at trigger events.
for (let i = 0; i < PASS1_BASE_SPINS; i++) {
  const r = spinPayout(paytable, 'base_game', baseTables, prng1);
  baseTotalPayout += r.payout;
  if (r.scatters >= paytable.minScattersToTrigger) {
    baseTriggered++;
    triggerScatterDist[r.scatters] = (triggerScatterDist[r.scatters] ?? 0) + 1;
    const initialFS = freeSpinsAwarded(paytable, r.scatters, false);
    const sessionPayoutVal = sessionPayout(paytable, bonusTables, prng1, initialFS);
    bonusTotalPayout += sessionPayoutVal;
    bonusSessionsRun++;
  }
  // Sample-store payouts for autocorrelation (cap at 100k for memory).
  if (baseSpinPayouts.length < 100_000) baseSpinPayouts.push(r.payout);
  // Track per-reel symbol-index counts for chi-squared
  for (let col = 0; col < REELS; col++) {
    for (const idx of r.clusterSizesByReel[col] || []) reelCounts[col][idx]++;
  }
  if (i === CONVERGENCE_SAMPLES[nextSnapshot] - 1) {
    baseConvergence.push({ rounds: i + 1, rtp: (baseTotalPayout + bonusTotalPayout) / (i + 1) });
    nextSnapshot++;
  }
  if ((i + 1) % 50_000 === 0 || i + 1 === PASS1_BASE_SPINS) {
    progress('base spins  ', i + 1, PASS1_BASE_SPINS, pass1Start);
  }
}
const baseRTP          = baseTotalPayout / PASS1_BASE_SPINS;
const triggerProb      = baseTriggered / PASS1_BASE_SPINS;
const avgSessionPayout = bonusSessionsRun > 0 ? bonusTotalPayout / bonusSessionsRun : 0;
const blendedRTP       = (baseTotalPayout + bonusTotalPayout) / PASS1_BASE_SPINS;

// ── Per-reel chi-squared ────────────────────────────────────────────────────

console.log('\n\nPer-reel chi-squared (initial-deal symbol distribution):');
const reelChi2: { reel: number; chi2: number; df: number; pvalue: number; bins: number }[] = [];
for (let col = 0; col < REELS; col++) {
  const observed = reelCounts[col];
  const totalDraws = observed.reduce((a, b) => a + b, 0);
  const reelW   = baseTables.weights[col];
  const totalW  = reelW.reduce((a, b) => a + b, 0);
  const expected = reelW.map(w => (w / totalW) * totalDraws);
  const pooled = poolTailBins(observed, expected, 5);
  let chi2 = 0;
  for (let i = 0; i < pooled.observed.length; i++) {
    const o = pooled.observed[i], e = pooled.expected[i];
    chi2 += (o - e) ** 2 / e;
  }
  const df = pooled.observed.length - 1;
  const p  = chiSquaredPValue(chi2, df);
  reelChi2.push({ reel: col, chi2, df, pvalue: p, bins: pooled.observed.length });
  console.log(`  reel ${col}: chi²=${chi2.toFixed(2)}, df=${df}, p=${p.toFixed(4)}, bins=${pooled.observed.length}`);
}

// ── Serial independence on base-spin payouts ────────────────────────────────

const lag1 = lag1Autocorrelation(baseSpinPayouts);
const runs = waldWolfowitzRunsP(baseSpinPayouts);
console.log(`\nSerial independence (n=${baseSpinPayouts.length} base-spin payouts):`);
console.log(`  lag-1 autocorrelation: ρ=${lag1.rho.toFixed(5)}, |z|=${Math.abs(lag1.z).toFixed(2)}`);
console.log(`  Wald-Wolfowitz runs:   runs=${runs.runs}, expected=${runs.expected.toFixed(1)}, |z|=${Math.abs(runs.z).toFixed(2)}, p=${runs.p.toFixed(4)}`);

// ── Pass 2 — cherry-pick detection on captured seeds ────────────────────────

console.log('\nPass 2: cherry-pick detection on captured server seeds');
const dataset = loadDataset();
const seedMap = buildSeedMap(dataset);

// Count captured base-game spins per epoch for context metadata.
// The actual cherry-pick test is the forward-replay below; this map
// only feeds seedsReplayed / totalCapturedSpins in the output JSON.
const epochs = new Map<string, { spins: number }>();
for (const b of dataset.bets) {
  if (b.mode !== 'spin') continue;        // skip buys + free spins
  if (b.response.spin_type !== 'base_game') continue;
  const seed = seedMap.get(b.activeAtSpin.server_seed_hashed);
  if (!seed) continue;
  const e = epochs.get(seed) || { spins: 0 };
  e.spins++;
  epochs.set(seed, e);
}
let totalCapturedSpins = 0;
for (const e of epochs.values()) totalCapturedSpins += e.spins;
const seedsReplayed = epochs.size;
console.log(`  ${seedsReplayed} epochs found, ${totalCapturedSpins.toLocaleString()} captured base spins`);

function binomSurvival(k: number, n: number, p: number): number {
  let s = 0, term = Math.pow(1 - p, n);
  for (let x = 0; x < k; x++) {
    s += term;
    term = term * (n - x) / (x + 1) * (p / (1 - p));
  }
  return Math.max(0, 1 - s);
}

// ── Pass 2 (forward-replay) — 10k-nonce per-epoch cherry-pick test ─────────
//
// For each captured epoch with a revealed serverSeed, replay nonces 0..9999
// through the base-game algorithm. Bin per-spin outcomes into win/no-win
// (the most cherry-pick-relevant categorical given GV's heavy-tail payout
// distribution). Chi-squared each window separately against the expected
// proportion derived from the committed `base-2pow32.json` Layer-1
// artifact. Flag = early p<0.05 AND late p>=0.05 — the cherry-pick
// signature: the early (captured) window deviates from the audit's own
// reference distribution while the rest of the seed does not. Aggregate
// via binomial survival on the flag count across all epochs.
//
// 2-bin discretisation (df=1) keeps chi-squared validity at n=50 per
// window without pooling and aligns directly with the operator's
// strongest cherry-pick incentive (inflate early win rate). Note this
// is a smaller categorical than plinko's slot-bin chi-squared (where
// slot count is finite and exact-binomial); for GV the per-spin payout
// distribution is continuous and heavy-tailed, so binarising at the
// win/no-win threshold is the chosen analog.

const NONCES_PER_SEED = 10_000;
const EPOCH_LENGTH    = 50;

interface Base2Pow32 { range: { count: number }; win_rate: number }
const baseRef = JSON.parse(
  fs.readFileSync(path.join(OUTPUTS, 'base-2pow32.json'), 'utf-8'),
) as Base2Pow32;
const P_WIN   = baseRef.win_rate;
const P_NOWIN = 1 - P_WIN;

function chi2WinNoWin(obsWin: number, obsNoWin: number, expWin: number, expNoWin: number): { chi2: number; p: number } {
  let chi2 = 0;
  chi2 += (obsWin   - expWin)   ** 2 / expWin;
  chi2 += (obsNoWin - expNoWin) ** 2 / expNoWin;
  return { chi2, p: chiSquaredPValue(chi2, 1) };
}

interface ForwardReplayResult {
  seed_hash: string;
  full_chi2: number;  full_p: number;
  early_chi2: number; early_p: number;
  late_chi2: number;  late_p: number;
  cherry_pick_flag: boolean;
}

// Build (serverSeed, clientSeed) pairs for each epoch that has any captured
// base spin AND a revealed serverSeed. clientSeed is taken from the first
// base-spin of the epoch (each epoch has exactly one clientSeed in this
// dataset, verified by capture-shape inspection — 115/115 epochs).
interface EpochPair { seedHashed: string; serverSeed: string; clientSeed: string }
const epochPairs: EpochPair[] = [];
const seenEpochs = new Set<string>();
for (const b of dataset.bets) {
  if (b.mode !== 'spin' || b.response.spin_type !== 'base_game') continue;
  const h = b.activeAtSpin.server_seed_hashed;
  if (seenEpochs.has(h)) continue;
  const serverSeed = seedMap.get(h);
  if (!serverSeed) continue;
  epochPairs.push({ seedHashed: h, serverSeed, clientSeed: b.activeAtSpin.client_seed });
  seenEpochs.add(h);
}

console.log(`\nPass 2 (forward-replay): ${epochPairs.length} epochs × ${NONCES_PER_SEED.toLocaleString()} nonces`);
console.log(`  Bins: {payout=0, payout>0}; expected = {${P_NOWIN.toFixed(4)}, ${P_WIN.toFixed(4)}} from base-2pow32.json`);
console.log(`  Window: early=nonces 0..${EPOCH_LENGTH - 1} vs late=${EPOCH_LENGTH}..${NONCES_PER_SEED - 1}`);

const forwardReplayResults: ForwardReplayResult[] = [];
let cherryPickFlags = 0;
const forwardReplayStart = Date.now();

for (let idx = 0; idx < epochPairs.length; idx++) {
  const ep = epochPairs[idx];
  let fullW = 0, fullNW = 0, earlyW = 0, earlyNW = 0, lateW = 0, lateNW = 0;

  for (let n = 0; n < NONCES_PER_SEED; n++) {
    const outcomeIndex = computeOutcomeIndex(ep.serverSeed, ep.clientSeed, n);
    const r = spinPayoutFromOutcomeIndex(outcomeIndex, paytable, 'base_game', baseTables);
    const isWin = r.payout > 0;
    if (isWin) {
      fullW++;
      if (n < EPOCH_LENGTH) earlyW++; else lateW++;
    } else {
      fullNW++;
      if (n < EPOCH_LENGTH) earlyNW++; else lateNW++;
    }
  }

  const fullTest  = chi2WinNoWin(fullW,  fullNW,  P_WIN * NONCES_PER_SEED,                  P_NOWIN * NONCES_PER_SEED);
  const earlyTest = chi2WinNoWin(earlyW, earlyNW, P_WIN * EPOCH_LENGTH,                     P_NOWIN * EPOCH_LENGTH);
  const lateTest  = chi2WinNoWin(lateW,  lateNW,  P_WIN * (NONCES_PER_SEED - EPOCH_LENGTH), P_NOWIN * (NONCES_PER_SEED - EPOCH_LENGTH));

  const flag = earlyTest.p < 0.05 && lateTest.p >= 0.05;
  if (flag) cherryPickFlags++;

  forwardReplayResults.push({
    seed_hash:        ep.seedHashed,
    full_chi2:        fullTest.chi2,
    full_p:           fullTest.p,
    early_chi2:       earlyTest.chi2,
    early_p:          earlyTest.p,
    late_chi2:        lateTest.chi2,
    late_p:           lateTest.p,
    cherry_pick_flag: flag,
  });

  if ((idx + 1) % 5 === 0 || idx + 1 === epochPairs.length) {
    progress('fwd-replay  ', idx + 1, epochPairs.length, forwardReplayStart);
  }
}

const N_fr = forwardReplayResults.length;
// One-sided binomial P(X >= flags | n=N_fr, p=0.05). PASS if observed flag
// count is within what 5% per-epoch false-positive rate would produce
// (binomial p ≥ 0.01).
const cherryPickPValue  = binomSurvival(cherryPickFlags, N_fr, 0.05);
const cherryPickVerdict = cherryPickPValue >= 0.01 ? 'PASS' : 'FAIL';
const forwardReplayElapsedMs = Date.now() - forwardReplayStart;

console.log(`\nPass 2 forward-replay verdict:`);
console.log(`  Epochs replayed: ${N_fr}`);
console.log(`  Cherry-pick flags (early dev + late not): ${cherryPickFlags}/${N_fr}`);
console.log(`  Binomial P(X ≥ ${cherryPickFlags} | n=${N_fr}, p=0.05) = ${cherryPickPValue.toFixed(6)} → ${cherryPickVerdict}`);
console.log(`  Time: ${(forwardReplayElapsedMs / 1000).toFixed(1)}s`);

// ── Output JSON ────────────────────────────────────────────────────────────

const out = {
  generatedAt: new Date().toISOString(),
  pass1: {
    baseSpins: PASS1_BASE_SPINS,
    baseRTP,
    triggerProbability:           triggerProb,
    bonusSessionsRun:             bonusSessionsRun,
    averageBonusSessionPayout:    avgSessionPayout,
    triggerScatterDistribution:   triggerScatterDist,
    blendedRTP,
    convergence:                  baseConvergence,
    perReelChiSquared:            reelChi2,
    chi2Fails:                    reelChi2.filter(r => r.pvalue < 0.01).length,
    chi2FailsBonferroni:          reelChi2.filter(r => r.pvalue < (0.01 / reelChi2.length)).length,
    bonferroniAlpha:              0.01 / reelChi2.length,
    serialIndependence: {
      lag1Rho:        lag1.rho,
      lag1AbsZ:       Math.abs(lag1.z),
      runsP:          runs.p,
      runsZ:          runs.z,
      lag1ZThreshold: bonferroniCriticalZ(0.01, REELS),
      runsPThreshold: 0.01 / REELS,
      passes:         Math.abs(lag1.z) < bonferroniCriticalZ(0.01, REELS) && runs.p > (0.01 / REELS),
    },
  },
  pass2: {
    seedsReplayed,
    totalCapturedSpins,
    forwardReplay: {
      epochs:           N_fr,
      noncesPerSeed:    NONCES_PER_SEED,
      epochLength:      EPOCH_LENGTH,
      bins:             'win/no-win',
      expectedWinRate:  P_WIN,
      cherryPickFlags,
      cherryPickPValue,
      cherryPickVerdict,
      executionTimeMs:  forwardReplayElapsedMs,
      results:          forwardReplayResults,
    },
  },
};
fs.writeFileSync(path.join(OUTPUTS, 'simulation-results.json'), JSON.stringify(out, null, 2));
console.log(`\nWrote outputs/simulation-results.json (${(fs.statSync(path.join(OUTPUTS, 'simulation-results.json')).size / 1024).toFixed(1)} KB)`);

// ── RTP convergence chart (self-contained HTML) ────────────────────────────

const chartHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>DUEL.COM GROOMER'S VAN RTP CONVERGENCE — ${(PASS1_BASE_SPINS / 1e6).toFixed(0)}M BASE SPINS</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fafafa; padding: 24px; }
  .container { max-width: 1100px; margin: 0 auto; background: #fff; border-radius: 12px; border: 1px solid #e0e0e0; padding: 32px; }
  h1 { text-align: center; font-size: 16px; font-weight: 600; color: #333; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; }
  .subtitle { text-align: center; font-size: 12px; color: #888; margin-bottom: 24px; }
  .chart-wrap { position: relative; height: 420px; }
  .legend { text-align: center; margin-top: 12px; font-size: 13px; color: #666; }
  .legend span { margin: 0 12px; }
  .legend .dot { display: inline-block; width: 12px; height: 3px; vertical-align: middle; margin-right: 4px; }
  .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-top: 20px; }
  .stat { border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; text-align: center; }
  .stat .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 18px; font-weight: 700; color: #333; margin-top: 4px; }
  .stat.final { border: 2px solid #4caf50; }
  .stat.final .value { color: #2e7d32; }
</style>
</head>
<body>
<div class="container">
  <h1>DUEL.COM GROOMER'S VAN RTP CONVERGENCE — ${(PASS1_BASE_SPINS / 1e6).toFixed(0)}M BASE SPINS</h1>
  <div class="subtitle">Integrated trigger + session blended RTP — single PCG32 stream from pinned master seed</div>
  <div class="chart-wrap"><canvas id="chart"></canvas></div>
  <div class="legend">
    <span><span class="dot" style="background:#1565c0;height:3px"></span> Cumulative blended RTP</span>
    <span><span class="dot" style="background:#e57373;border-top:2px dashed #e57373;height:0"></span> Theoretical (${parseFloat(config.rtp).toFixed(4)}%)</span>
  </div>
  <div class="summary">
    <div class="stat"><div class="label">Base RTP</div><div class="value">${(baseRTP*100).toFixed(4)}%</div></div>
    <div class="stat"><div class="label">Trigger Prob</div><div class="value">${(triggerProb*100).toFixed(4)}%</div></div>
    <div class="stat"><div class="label">Avg Session Payout</div><div class="value">${avgSessionPayout.toFixed(4)}×</div></div>
    <div class="stat final"><div class="label">Final Blended RTP</div><div class="value">${(blendedRTP*100).toFixed(4)}%</div></div>
    <div class="stat"><div class="label">Theoretical</div><div class="value">${parseFloat(config.rtp).toFixed(4)}%</div></div>
  </div>
</div>
<script>
const data = ${JSON.stringify(baseConvergence)};
const labels = data.map(d => {
  const m = d.rounds / 1e6;
  if (m >= 1) return m % 1 === 0 ? m.toFixed(0) + 'M' : m.toFixed(1) + 'M';
  return (d.rounds / 1e3).toFixed(0) + 'K';
});
const rtps = data.map(d => d.rtp * 100);
const theoretical = ${parseFloat(config.rtp)};

new Chart(document.getElementById('chart').getContext('2d'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'Theoretical (' + theoretical.toFixed(4) + '%)',
        data: rtps.map(() => theoretical),
        borderColor: '#e57373',
        borderWidth: 2,
        borderDash: [8, 4],
        fill: false,
        pointRadius: 0,
      },
      {
        label: 'Cumulative blended RTP',
        data: rtps,
        borderColor: '#1565c0',
        borderWidth: 2.5,
        fill: false,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#1565c0',
        tension: 0.3,
      },
      {
        label: 'Final',
        data: rtps.map((v, i) => i === rtps.length - 1 ? v : null),
        borderColor: '#1565c0',
        backgroundColor: '#1565c0',
        pointRadius: 6,
        pointHoverRadius: 8,
        showLine: false,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => labels[items[0].dataIndex] + ' base spins',
          label: (item) => {
            if (item.datasetIndex === 1) return 'Blended RTP: ' + item.parsed.y.toFixed(4) + '%';
            if (item.datasetIndex === 0) return 'Theoretical: ' + theoretical.toFixed(4) + '%';
            return null;
          },
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: 'Base Spins Simulated', font: { size: 12 }, color: '#666' },
        ticks: { color: '#666', maxTicksLimit: 10 },
        grid: { color: '#e0e0e0' },
      },
      y: {
        title: { display: false },
        ticks: { color: '#666', callback: v => v.toFixed(1) + '%' },
        grid: { color: '#e0e0e0' },
      },
    },
  },
});
</script>
</body>
</html>`;
fs.writeFileSync(path.join(OUTPUTS, 'rtp-convergence.html'), chartHtml);
console.log(`Wrote outputs/rtp-convergence.html`);

console.log(`\nTotal elapsed: ${((Date.now() - pass1Start) / 1000).toFixed(1)}s`);
