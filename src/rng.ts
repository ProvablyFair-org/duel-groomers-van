/**
 * PROVENANCE (header added on integration, 20 Oct 2026; everything below this comment is the
 * clean-room module byte for byte).
 *
 * This module was REBUILT FROM A WRITTEN SPECIFICATION, not ported from Duel's code:
 *   spec      docs/ALGORITHM.md, a copy of games/groomers-van/ALGORITHM.md in the ProvablyFair.org
 *             audit framework (pf-audit, branch clean-room-spec-2026-10-20). This module was written
 *             from commit ef7fa03; the copy in docs/ is commit cae1782, which changes only the text
 *             of open point O5 and one line of 2.6 (nonce gaps), nothing this module reads. Its
 *             inputs, commitment, grid, weight tables, fill order, multiplier values and tumbles come
 *             from Duel's public pages, its public Verify form used as a black box, the public config
 *             and rules endpoints and the captured data. One
 *             step is different, and the spec says so in its Provenance section: no public page
 *             describes the per-spin seed step (seeds -> outcome_index, outcome_index + round +
 *             tumble -> PCG32 state, and the discard rule of each draw, spec 2.2, 2.4a, 2.4b), so
 *             by the client's ruling of 20 Oct 2026 that step of the spec was written from Duel's
 *             Verify-tab code, restated in the spec's own words, and disclosed.
 *   rebuild   written by an implementer who read ONLY that spec and a module-interface file, and
 *             never opened Duel's code, its Verify-tab file, or this package's earlier src/rng.ts.
 *   self-test tests/groomers-van/RngSpecTests.ts (the spec's vectors and properties).
 *
 * Duel's published Verify-tab code (evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19
 * .captured.json, E04) is NOT the source of this module. It is run byte for byte as a SECOND CHECK
 * by Step 5 and the unit tests (src/operator-verifier.ts), next to the ProvablyFair.org docs-site
 * verifier copy (src/site-verifier.ts).
 *
 * Three-way agreement measured on integration (20 Oct 2026; the four redacted datasets in data/ of
 * the workshop: 6,250 records, 6,228 spins and free spins, 10,573 rounds): this module vs the live
 * rounds, every round's 30 cells and every multiplier value 10,573/10,573 (317,190 cells, 945
 * values), outcome_index 623/623, commitments 6,250/6,250; vs Duel's Verify-tab code
 * 10,573/10,573 rounds (outcome index, fresh grid, multiplier values); vs the docs-site verifier
 * copy 10,573/10,573. Step 5 of `npm run verify` re-measures the live and Verify-tab legs on the
 * pinned dataset on every run.
 */
// Groomer's Van RNG, clean-room implementation written from ALGORITHM.md and INTERFACE.md only.
// Section references (§) point at ALGORITHM.md. Node `crypto` is the only dependency.

import { createHash, createHmac } from "crypto";

export const REELS: number = 6; // §2.1: 6 reels (columns)
export const ROWS: number = 5; // §2.1: 5 rows, row 0 = top

export type SymbolGrid = number[][]; // grid[col][row]
export interface PositionMultiplier { position: number; value: number }
export interface SpinResult {
  outcomeIndex: number;
  outcomeIndexHex: string;
  tumbleSeed: number;
  grid: SymbolGrid;
  multipliers: PositionMultiplier[];
}

const MASK64 = (1n << 64n) - 1n;
const U32_MAX = 0xffffffff;

// §2.4 / §2.4b: the multiplier value list the spec defines is the 200-entry list in which each
// value appears as many times as its weight, values ascending.
const SPEC_MULTIPLIER_TABLE: ReadonlyArray<readonly [number, number]> = [
  [2, 90], [3, 25], [4, 18], [5, 13], [6, 10], [7, 8], [8, 7],
  [10, 6], [12, 5], [15, 4], [25, 4], [50, 4], [100, 3], [250, 3],
];
const SPEC_MULTIPLIER_LIST: number[] = SPEC_MULTIPLIER_TABLE.flatMap(([v, w]) => Array<number>(w).fill(v));

// Decode a hex string to bytes; both letter cases accepted (§2.2 step 1: case does not matter).
// The spec only describes well-formed hex, so anything else is refused rather than guessed at.
function hexToBytes(hex: string): Buffer {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("server seed must be an even-length hex string");
  }
  return Buffer.from(hex, "hex");
}

function assertUint32(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) throw new Error(`${name} must be an unsigned 32-bit integer`);
}

function assertIndex(n: number, name: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
}

// §1.2: the commitment is SHA-256 over the decoded seed bytes (not over its ASCII text), as lowercase hex.
export function hashServerSeed(serverSeedHex: string): string {
  return createHash("sha256").update(hexToBytes(serverSeedHex)).digest("hex");
}

// §2.2: outcome_index.
export function computeOutcomeIndex(serverSeedHex: string, clientSeed: string, nonce: number): number {
  assertIndex(nonce, "nonce");
  // §2.2 step 1: the HMAC key is the server seed decoded from hex.
  const key = hexToBytes(serverSeedHex);
  // §2.2 step 2: the client seed's UTF-8 bytes, each written as two lowercase hex digits.
  const clientPart = Buffer.from(clientSeed, "utf8").toString("hex");
  // §2.2 step 3: that hex text, a colon, then the nonce in plain decimal; ASCII message.
  const message = `${clientPart}:${nonce.toString(10)}`;
  // §2.2 step 4: HMAC-SHA256 with the key over the message.
  const digest = createHmac("sha256", key).update(message, "ascii").digest();
  // §2.2 step 5: first 4 digest bytes as an unsigned big-endian 32-bit integer.
  return digest.readUInt32BE(0);
}

// §2.4a "Tumble seed": mix outcome_index with round and tumble using 32-bit arithmetic.
export function deriveTumbleSeed(outcomeIndex: number, roundIndex: number, tumbleIndex: number): number {
  assertUint32(outcomeIndex, "outcomeIndex");
  assertIndex(roundIndex, "roundIndex");
  assertIndex(tumbleIndex, "tumbleIndex");
  let x = outcomeIndex >>> 0;
  // XOR in the low 32 bits of (r + 1) * 0x9E3779B9; Math.imul keeps exactly the low 32 bits.
  x = (x ^ Math.imul((roundIndex + 1) >>> 0, 0x9e3779b9)) >>> 0;
  // XOR in the low 32 bits of (t + 1) * 0x85EBCA6B.
  x = (x ^ Math.imul((tumbleIndex + 1) >>> 0, 0x85ebca6b)) >>> 0;
  // Final avalanche: xor-shift 16, multiply by 0xC2B2AE35 (low 32 bits), xor-shift 16.
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

// §2.4a "PCG32 step": multiplier and increment are the same 64-bit constant.
const PCG_MULT = 0x5851f42d4c957f2dn; // 6364136223846793005
const PCG_INC = 0x5851f42d4c957f2dn;

export class Pcg32 {
  state: bigint;

  constructor(seed32: number) {
    assertUint32(seed32, "seed32");
    // §2.4a "PCG32 state from the tumble seed": widen to 64 bits, then one SplitMix64 output step.
    let z = (BigInt(seed32 >>> 0) + 0x9e3779b97f4a7c15n) & MASK64;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    // No warm-up draw: the first output is produced from this state (§2.4a).
    this.state = (z ^ (z >> 31n)) & MASK64;
  }

  nextUint32(): number {
    const old = this.state;
    // §2.4a: XSH-RR output from the current state ...
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    const out = ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
    // ... then advance: state = state * multiplier + increment (mod 2^64).
    this.state = (old * PCG_MULT + PCG_INC) & MASK64;
    return out;
  }
}

// §2.4b: keep a draw only if it is below limit = (2^32 - 1) - ((2^32 - 1) mod T); a kept draw maps to u mod T.
export function acceptedDraw(value: number, total: number): number | null {
  assertUint32(value, "value");
  if (!Number.isInteger(total) || total < 1 || total > U32_MAX) throw new Error("total must be an integer in [1, 2^32-1]");
  const limit = U32_MAX - (U32_MAX % total);
  return value < limit ? value % total : null;
}

// One draw below `total` per §2.4b: discard and draw again until a value is kept.
function drawBelow(prng: Pcg32, total: number): number {
  for (;;) {
    const r = acceptedDraw(prng.nextUint32(), total);
    if (r !== null) return r;
  }
}

// §2.4b "Symbols": T = sum of the weights; the result picks the first index whose running sum exceeds it.
export function pickWeighted(prng: Pcg32, weights: number[]): number {
  if (weights.length === 0) throw new Error("weights must not be empty");
  let total = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) throw new Error("weights must be non-negative integers");
    total += w;
  }
  const v = drawBelow(prng, total);
  let running = 0;
  for (let i = 0; i < weights.length; i++) {
    running += weights[i];
    if (v < running) return i;
  }
  throw new Error("unreachable: draw outside the weight total");
}

// §2.4 box + §2.4b: fresh 30-cell grid, positions 0..29 in column-major order (reel = p div 5, top row first),
// each cell one weighted draw from its reel's table.
export function generateGrid(prng: Pcg32, weightsPerReel: number[][]): SymbolGrid {
  if (weightsPerReel.length !== REELS) throw new Error(`weightsPerReel must have ${REELS} reels`);
  const grid: SymbolGrid = [];
  for (let col = 0; col < REELS; col++) {
    const column: number[] = [];
    for (let row = 0; row < ROWS; row++) column.push(pickWeighted(prng, weightsPerReel[col]));
    grid.push(column);
  }
  return grid;
}

// §2.4b "Multiplier values": after the 30 cells, one draw per multiplier cell, in position order, from the same stream.
export function generateMultipliers(
  grid: SymbolGrid,
  prng: Pcg32,
  multiplierSymbolIndex: number,
  multiplierValues: number[],
  multiplierWeights?: number[],
): PositionMultiplier[] {
  if (multiplierValues.length === 0) throw new Error("multiplierValues must not be empty");
  if (multiplierWeights !== undefined && multiplierWeights.length !== multiplierValues.length) {
    throw new Error("multiplierWeights must match multiplierValues in length");
  }
  const out: PositionMultiplier[] = [];
  for (let col = 0; col < REELS; col++) {
    for (let row = 0; row < ROWS; row++) {
      if (grid[col][row] !== multiplierSymbolIndex) continue;
      // Spec form: T = list length, value = list[index]. With weights, the same §2.4b weighted pick over the
      // distinct values (equal to the §2.4 cumulative rule when the weights are those of §2.4).
      const idx = multiplierWeights !== undefined
        ? pickWeighted(prng, multiplierWeights)
        : drawBelow(prng, multiplierValues.length);
      out.push({ position: col * ROWS + row, value: multiplierValues[idx] });
    }
  }
  return out;
}

// End to end for one (round, tumble): §2.2 -> §2.4a -> §2.4/§2.4b. Returns the fresh grid G_t; applying it to a
// tumble (gravity, refilling only the emptied top cells, §2.4 bullet 1) is the caller's job.
export function reproduceSpin(args: {
  serverSeed: string; clientSeed: string; nonce: number; roundIndex: number; tumbleIndex: number;
  weightsPerReel: number[][]; multiplierSymbolIndex?: number | null; multiplierValues?: number[] | null;
  multiplierWeights?: number[] | null;
}): SpinResult {
  const outcomeIndex = computeOutcomeIndex(args.serverSeed, args.clientSeed, args.nonce);
  const tumbleSeed = deriveTumbleSeed(outcomeIndex, args.roundIndex, args.tumbleIndex);
  // §2.4a: one fresh stream per (round, tumble); nothing carries over.
  const prng = new Pcg32(tumbleSeed);
  const grid = generateGrid(prng, args.weightsPerReel);
  let multipliers: PositionMultiplier[] = [];
  if (args.multiplierSymbolIndex !== undefined && args.multiplierSymbolIndex !== null) {
    const values = args.multiplierValues ?? SPEC_MULTIPLIER_LIST;
    const weights = args.multiplierWeights ?? undefined;
    multipliers = generateMultipliers(grid, prng, args.multiplierSymbolIndex, values, weights);
  }
  return {
    outcomeIndex,
    outcomeIndexHex: outcomeIndex.toString(16).padStart(8, "0"), // §2.2: format(outcome_index, '08x')
    tumbleSeed,
    grid,
    multipliers,
  };
}
