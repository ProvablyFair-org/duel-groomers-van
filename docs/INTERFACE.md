# Module interface the audit package expects (written by the auditor, not from the casino)

Write `rng.ts` (TypeScript, strict, Node `crypto` only, no dependencies) exporting exactly these names.
Semantics come from ALGORITHM.md; this file only fixes names, types and the package's own conventions.
Grid convention: grid[col][row], 6 columns x 5 rows, symbol = index 0..K-1 into the reel's weight list; positions are column-major (col * ROWS + row).

```ts
// The commitment for a server seed (lowercase hex), per the spec.
export function hashServerSeed(serverSeedHex: string): string;
// The spin's 32-bit outcome index from (server seed, client seed, nonce), per the spec.
export function computeOutcomeIndex(serverSeedHex: string, clientSeed: string, nonce: number): number;
// The 32-bit tumble seed from the outcome index, round index and tumble index (both 0-based), per the spec.
export function deriveTumbleSeed(outcomeIndex: number, roundIndex: number, tumbleIndex: number): number;
// The spec's PCG32 generator, initialised from a tumble seed exactly as the spec says (incl. any seeding/mixing step).
export class Pcg32 {
  state: bigint;
  constructor(seed32: number);
  nextUint32(): number;   // next 32-bit output
}
// THE single-draw acceptance rule for a draw over `total` outcomes: index in [0,total) or null if rejected.
export function acceptedDraw(value: number, total: number): number | null;
// Weighted pick of an index from `weights` using the prng and acceptedDraw (redrawing on rejection), per the spec.
export function pickWeighted(prng: Pcg32, weights: number[]): number;
export const REELS: number;   // 6
export const ROWS: number;    // 5
export type SymbolGrid = number[][];
// A fresh grid from the prng and the per-reel weight lists, in the spec's draw order.
export function generateGrid(prng: Pcg32, weightsPerReel: number[][]): SymbolGrid;
export interface PositionMultiplier { position: number; value: number }
// For each cell holding the multiplier symbol, draw its value from the same prng after the grid, per the spec.
// multiplierValues = the value list the spec defines; if multiplierWeights is given, pick by those weights instead of uniformly over the list.
export function generateMultipliers(grid: SymbolGrid, prng: Pcg32, multiplierSymbolIndex: number, multiplierValues: number[], multiplierWeights?: number[]): PositionMultiplier[];
export interface SpinResult { outcomeIndex: number; outcomeIndexHex: string; tumbleSeed: number; grid: SymbolGrid; multipliers: PositionMultiplier[] }
// One round/tumble's fresh grid (+ multipliers when a multiplier symbol index is given), end to end from the seeds.
export function reproduceSpin(args: { serverSeed: string; clientSeed: string; nonce: number; roundIndex: number; tumbleIndex: number;
  weightsPerReel: number[][]; multiplierSymbolIndex?: number | null; multiplierValues?: number[] | null; multiplierWeights?: number[] | null }): SpinResult;
```
Cluster evaluation, tumbling/refill and payouts are NOT part of this module (the package has its own); implement only the above.
