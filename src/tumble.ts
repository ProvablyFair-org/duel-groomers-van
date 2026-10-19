/**
 * Groomer's Van — tumble cascade simulator.
 *
 * After each round resolves clusters, every cell that was part of a
 * winning cluster is removed. The cells above slide down to fill the
 * gaps, and new symbols drop in from the top of each reel. The next
 * tumble round generates a fresh grid from the same `outcome_index`
 * with `tumble_index` incremented.
 *
 * The audit doesn't need to simulate the cascade visually — the
 * captured `view` already shows the post-tumble state per round
 * (`view[reel][row]` for round id `r` is the state at the end of
 * tumble round `r`). What this module DOES is:
 *
 *   1. Re-derive the column-major grid for tumble index 0..N
 *      (using `rng.generateGrid` + `rng.deriveTumbleSeed`).
 *   2. Apply the casino's removal rule to compute which cells were
 *      cleared after each round, given the cluster paylines.
 *   3. Confirm the simulator's removed-cells set matches the captured
 *      `removed_on_round` field on each cell — that's the equivalence
 *      check.
 *
 * The actual symbol values for tumble rounds 1..N come from rng.ts
 * with `tumbleIndex` set accordingly. Row-fill order: top-down (row 0
 * is the top of the screen; gravity pulls down).
 */

import { Pcg32, deriveTumbleSeed, generateGrid, REELS, ROWS, type SymbolGrid } from './rng';
import { findClusters, countScatters, type Cluster } from './cluster';

export interface TumbleRound {
  index:           number;            // 0 = initial deal, 1+ = cascade rounds
  grid:            string[][];        // grid[col][row] of symbol codes
  clusters:        Cluster[];
  removedPositions: Set<number>;
  scatterCount:    number;
}

/**
 * Replay a single tumble round given the current grid. Returns the
 * winning clusters and the set of positions to clear after this round.
 *
 * Note: this does NOT advance to the next round's grid; the next
 * round's symbols come from rng.ts with `tumbleIndex+1`. `tumble.ts`
 * is purely the cluster-resolution side of the cascade loop.
 */
export function resolveRound(grid: string[][]): {
  clusters: Cluster[];
  removed:  Set<number>;
  scatters: number;
} {
  const clusters = findClusters(grid);
  const removed  = new Set<number>();
  // Min cluster size = 8; smaller clusters do not pay or remove.
  for (const c of clusters) {
    if (c.size >= 8) for (const p of c.positions) removed.add(p);
  }
  return { clusters, removed, scatters: countScatters(grid) };
}

/**
 * Reproduce the FULL cascade for a single spin.
 *
 * Inputs:
 *   - server seed (hex), client seed, nonce, round_index
 *   - paytable's symbol code list (index → code, ordered to match the
 *     reel-weight arrays)
 *   - per-reel weights for the active condition (base_game / bonus_game)
 *   - max tumble depth (terminate if cascade runs longer; the operator
 *     stops cascading once `max_multiplier` is reached anyway)
 *
 * Returns one `TumbleRound` per cascade level. Caller compares each
 * round's grid + removed set against the captured response's
 * `rounds[i].data.view`.
 */
export interface ReplayArgs {
  outcomeIndex:    number;            // pre-computed via computeOutcomeIndex()
  roundIndex:      number;            // free-spin index inside a feature; 0 for base spins
  weightsPerReel:  number[][];        // condition-specific
  symbolCodes:     string[];          // index-aligned to weightsPerReel
  maxTumbles?:     number;            // safety cap, default 30
}

export function replayTumbles(args: ReplayArgs): TumbleRound[] {
  const max = args.maxTumbles ?? 30;
  const out: TumbleRound[] = [];
  for (let t = 0; t < max; t++) {
    const seed = deriveTumbleSeed(args.outcomeIndex, args.roundIndex, t);
    const prng = new Pcg32(seed);
    const idxGrid: SymbolGrid = generateGrid(prng, args.weightsPerReel);
    const grid: string[][]    = idxGrid.map(col => col.map(i => args.symbolCodes[i]));
    const { clusters, removed, scatters } = resolveRound(grid);
    out.push({ index: t, grid, clusters, removedPositions: removed, scatterCount: scatters });
    if (removed.size === 0) break;   // no winning cluster → cascade terminates
  }
  return out;
}
