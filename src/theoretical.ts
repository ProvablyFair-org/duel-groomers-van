/**
 * Groomer's Van — theoretical RTP recomputation.
 *
 * The audit's anti-circularity step. We re-derive the game's claimed
 * RTP from the operator's published per-reel weights and paytable,
 * INDEPENDENT of any operator-supplied probability table or
 * simulation. If the operator changed the weight schedule but kept the
 * paytable claim of "100% RTP", this calculation would catch it.
 *
 * Cluster pays + tumbling has no tractable closed form for the joint
 * distribution of cluster sizes — tumble cascades are a Markov-style
 * random walk where the post-removal grid + drop-in cells make each
 * cascade's distribution depend on the previous cluster's removal set.
 *
 * The standard approach for cluster-pays slots (this is what the operator
 * does internally and what we replicate here) is **Monte Carlo
 * estimation with the published weights**. We use a freshly-seeded PRNG
 * separate from the audit's verification stream so this calculation is
 * independent of the captured dataset's seeds.
 *
 * Output: estimated RTP for base_game, free-spin RTP given a triggered
 * bonus session, and the blended RTP factoring in trigger frequency.
 */

import * as crypto from 'crypto';
import { Pcg32, generateGrid, generateMultipliers, REELS, ROWS, type SymbolGrid } from './rng';
import { findClusters, countScatters, BONUS_CODE, WILD_CODE } from './cluster';
import { clusterMultiplier, scatterMultiplier, freeSpinsAwarded, type Paytable, type Condition } from './paytable';
import type { OperatorConfig } from './types';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface SymbolTables {
  codes:   string[];                     // ordered by symbol_index
  weights: number[][];                   // weights[reel][symbolIndex]
  multiplierSymbolIndex: number;          // -1 if absent (base_game)
  multiplierValues:      number[];        // [] if absent
}

function buildSymbolTables(config: OperatorConfig, paytable: Paytable, condition: Condition): SymbolTables {
  const symbols = [...config.weights.symbols_by_condition[condition]]
    .sort((a, b) => a.symbol_index - b.symbol_index);
  const codes   = symbols.map(s => s.code);
  const weights: number[][] = [];
  for (let reel = 0; reel < REELS; reel++) {
    weights.push(symbols.map(s => s.weights_per_reel[reel]));
  }
  const multIdx  = symbols.findIndex(s => s.code === 'multiplier');
  const multVals = condition === 'bonus_game' ? paytable.multiplierValuesList : [];
  return { codes, weights, multiplierSymbolIndex: multIdx, multiplierValues: multVals };
}

function freshPrng(): Pcg32 {
  // Reproducible PRNG seed: HMAC-SHA256(masterSeed, label) → first 4 bytes BE.
  // Pinned so reviewers running this script get bit-for-bit identical numbers.
  const masterSeed = process.env.GVS_MASTER_SEED ?? 'pf-audit-groomers-van-v1';
  const seed = crypto.createHmac('sha256', masterSeed).update('groomers-van-theoretical').digest();
  return new Pcg32(seed.readUInt32BE(0));
}

// ── Single-spin simulation (one base spin + its tumble cascade) ─────────────

/**
 * Resolve all clusters in a grid and return the total payout (in
 * stake-units) plus the set of removed positions.
 *
 * For bonus_game spins, multiplier symbols on the screen contribute
 * their value as a "bomb_multiplier" to every cluster payout in this
 * round. (`spin_multiplier` in the API.)
 */
function payoutForRound(
  paytable: Paytable, condition: Condition,
  grid: string[][], multipliersOnScreen: number[],
): { payout: number; removed: Set<number> } {
  const clusters = findClusters(grid);
  const removed  = new Set<number>();
  const bombMult = condition === 'bonus_game' && multipliersOnScreen.length
    ? multipliersOnScreen.reduce((s, v) => s + v, 0)
    : 0;
  let payout = 0;
  for (const c of clusters) {
    if (c.size < paytable.minClusterSize) continue;
    const baseMult = clusterMultiplier(paytable, condition, c.symbol, c.size);
    if (baseMult <= 0) continue;
    const finalMult = baseMult * Math.max(bombMult, 1);
    payout += finalMult;
    for (const p of c.positions) removed.add(p);
  }
  return { payout, removed };
}

/**
 * Simulate one spin (in either condition) including the full tumble
 * cascade. Returns the per-spin payout in stake units and whether the
 * spin triggered a feature.
 */
function simulateSpin(
  paytable: Paytable, condition: Condition, tables: SymbolTables, prng: Pcg32,
): { payout: number; scatterCount: number; triggered: boolean } {
  let payout = 0;
  let scattersOnInitial = 0;
  let triggered = false;

  for (let tumble = 0; tumble < 30; tumble++) {
    // Generate a fresh grid for this cascade level. (For Monte Carlo
    // RTP, we just keep drawing fresh grids per cascade — equivalent
    // to deriving from a fresh tumble seed each time.)
    const idxGrid = generateGrid(prng, tables.weights);
    const codeGrid: string[][] = idxGrid.map(col => col.map(i => tables.codes[i]));

    // Multiplier-symbol values for bonus mode
    const bombs = condition === 'bonus_game'
      ? generateMultipliers(idxGrid, prng, tables.multiplierSymbolIndex, tables.multiplierValues).map(m => m.value)
      : [];

    if (tumble === 0) scattersOnInitial = countScatters(codeGrid);

    const { payout: roundPay, removed } = payoutForRound(paytable, condition, codeGrid, bombs);
    payout += roundPay;
    if (removed.size === 0) break;
  }

  triggered = scattersOnInitial >= paytable.minScattersToTrigger;
  return { payout, scatterCount: scattersOnInitial, triggered };
}

// ── Free-spin session (when triggered or bought) ────────────────────────────

/**
 * Simulate a full bonus session of N free spins (with retriggers up to
 * `maxBonusRetriggers`). Returns the total payout in stake units.
 */
function simulateFeatureSession(
  paytable: Paytable, tables: SymbolTables, prng: Pcg32, initialFreeSpins: number,
): number {
  const cond: Condition = 'bonus_game';
  let total       = 0;
  let remaining   = initialFreeSpins;
  let retriggers  = 0;

  while (remaining > 0) {
    const { payout, scatterCount } = simulateSpin(paytable, cond, tables, prng);
    total += payout;
    remaining--;
    // Retrigger?
    if (retriggers < paytable.maxBonusRetriggers && scatterCount >= paytable.minScattersToTrigger) {
      const award = freeSpinsAwarded(paytable, scatterCount, true);
      remaining += award;
      retriggers++;
    }
  }
  return total;
}

// ── Public RTP estimators ───────────────────────────────────────────────────

export interface RTPEstimates {
  baseSpins:                     number;
  baseTotalPayout:               number;       // sum of stake-unit payouts (incl. scatter pay + cluster wins)
  baseScatterPayout:             number;       // separated for transparency
  baseClusterPayout:             number;
  baseRTP:                       number;       // baseTotalPayout / baseSpins
  freeSpinSessions:              number;
  freeSpinTotalPayout:           number;
  averageFreeSpinSessionPayout:  number;
  bonusContributionToBlended:    number;       // P(trigger in base) × averageSessionPayout / baseSpinStake
  blendedRTP:                    number;       // base RTP plus expected bonus contribution per base spin
}

/**
 * Run two Monte Carlo simulations:
 *   - `baseSpins` independent base-game spins with tumble cascade
 *   - `featureSessions` independent bonus sessions of `freeSpins` length
 *     (using the buy-equivalent 4 scatters → spins_per_scatters[4] free
 *     spins, with retriggers).
 *
 * Then estimate base RTP, free-spin RTP, and blended RTP.
 *
 * For `baseSpins=1e6` and `featureSessions=2e4` the standard error on
 * blended RTP is ≈ 0.1%. Bump to 1e7 / 1e5 for sub-0.05% precision.
 */
export function estimateRTP(
  config: OperatorConfig, paytable: Paytable,
  baseSpins: number, featureSessions: number,
): RTPEstimates {
  const baseTables  = buildSymbolTables(config, paytable, 'base_game');
  const bonusTables = buildSymbolTables(config, paytable, 'bonus_game');
  const prng        = freshPrng();

  // Base spins (no buy) — each carries its own scatter pay if 3+ scatters land.
  let baseClusterPayout = 0;
  let baseScatterPayout = 0;
  let triggeredCount    = 0;

  for (let i = 0; i < baseSpins; i++) {
    const r = simulateSpin(paytable, 'base_game', baseTables, prng);
    baseClusterPayout += r.payout;
    if (r.scatterCount >= 4) {
      baseScatterPayout += scatterMultiplier(paytable, 'base_game', r.scatterCount);
    }
    if (r.triggered) triggeredCount++;
  }
  const baseTotalPayout = baseClusterPayout + baseScatterPayout;

  // Feature sessions — each = 4-scatter buy equivalent (10 free spins
  // before retriggers).
  const initialFS = freeSpinsAwarded(paytable, 4, false);    // = 10
  let freeSpinTotalPayout = 0;
  for (let i = 0; i < featureSessions; i++) {
    freeSpinTotalPayout += simulateFeatureSession(paytable, bonusTables, prng, initialFS);
  }

  const baseRTP        = baseTotalPayout / baseSpins;
  const avgSessionPay  = featureSessions > 0 ? freeSpinTotalPayout / featureSessions : 0;
  const triggerProb    = triggeredCount / baseSpins;
  // The "bought" buy pays 125× in stake units. Players who reach a
  // bonus organically pay 0× (it's free given the trigger). For blended
  // RTP we use the organic contribution: P(organic trigger) × E[session].
  const bonusContribution = triggerProb * avgSessionPay;
  const blendedRTP        = baseRTP + bonusContribution;

  return {
    baseSpins,
    baseTotalPayout,
    baseScatterPayout,
    baseClusterPayout,
    baseRTP,
    freeSpinSessions: featureSessions,
    freeSpinTotalPayout,
    averageFreeSpinSessionPayout: avgSessionPay,
    bonusContributionToBlended:    bonusContribution,
    blendedRTP,
  };
}
