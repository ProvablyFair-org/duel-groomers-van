/**
 * Groomer's Van — symbol-count "cluster" detection.
 *
 * IMPORTANT: this game's "cluster" mechanic is NOT geometric connectivity.
 * Per MANIFEST.md#game-and-algorithm and the operator's published rules:
 *
 *   pay_mechanic:           "cluster"
 *   symbols_paying_logic:   "anywhere"
 *   min_cluster_size:        8
 *
 * "Anywhere" means: a payline triggers when the **total count** of cells
 * with a payable symbol (plus wild substitutions) reaches the minimum
 * cluster size. Cells need NOT be 4-directionally connected.
 *
 * This was confirmed empirically against the captured dataset (bet
 * 1964425: 7 symbol_1 cells + 1 wild = 8 → cluster_symbol_1_8). A
 * connectivity-based detector miscounts — we use a simple global count.
 *
 * Wild substitution rule (also empirically confirmed, see bet 1964428):
 *   - Each wild contributes to EVERY simultaneous payable-symbol count.
 *   - The same wild can lift multiple symbols' counts to a payable size
 *     in the same spin.
 *
 * Bonus scatters (`bonus`) and the multiplier symbol (`multiplier`) do
 * NOT participate in cluster counts. Bonus scatters pay separately on
 * count (the scatter pay table); multiplier symbols only act as sticky
 * multipliers in bonus mode.
 */

import { REELS, ROWS } from './rng';

export const WILD_CODE       = 'wild';
export const BONUS_CODE      = 'bonus';
export const MULTIPLIER_CODE = 'multiplier';

const NON_PAYABLE = new Set([WILD_CODE, BONUS_CODE, MULTIPLIER_CODE]);

export interface Cluster {
  symbol:    string;             // payout symbol (never wild / bonus / multiplier)
  positions: number[];           // EVERY position with that symbol OR a wild (sorted)
  size:      number;             // positions.length
}

/**
 * Find every payable-symbol "cluster" in the grid, applying global
 * counts with wild substitution. Returns one Cluster per distinct
 * payable symbol present (size includes shared wilds).
 */
export function findClusters(grid: string[][]): Cluster[] {
  if (grid.length !== REELS) throw new Error(`grid must have ${REELS} columns`);
  for (const col of grid) if (col.length !== ROWS) throw new Error(`each column must have ${ROWS} rows`);

  const wildPositions: number[] = [];
  const symbolPositions = new Map<string, number[]>();

  for (let c = 0; c < REELS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const sym = grid[c][r];
      const pos = c * ROWS + r;
      if (sym === WILD_CODE) {
        wildPositions.push(pos);
      } else if (!NON_PAYABLE.has(sym)) {
        const list = symbolPositions.get(sym) ?? [];
        list.push(pos);
        symbolPositions.set(sym, list);
      }
    }
  }

  const clusters: Cluster[] = [];
  for (const [sym, positions] of symbolPositions) {
    const all = positions.concat(wildPositions).sort((a, b) => a - b);
    clusters.push({ symbol: sym, positions: all, size: all.length });
  }
  return clusters;
}

export function countScatters(grid: string[][]): number {
  let n = 0;
  for (let c = 0; c < REELS; c++) for (let r = 0; r < ROWS; r++) if (grid[c][r] === BONUS_CODE) n++;
  return n;
}

export function indexGridToCodeGrid(indexGrid: number[][], symbolCodes: string[]): string[][] {
  return indexGrid.map(col => col.map(idx => symbolCodes[idx]));
}
