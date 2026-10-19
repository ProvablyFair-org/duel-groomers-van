/**
 * Groomer's Van — RNG core.
 *
 * Ported to TypeScript from Duel's published Verify-tab code at
 * https://duel.com/fairness/verify (Game selector → "Groomer's Van"):
 * it was written from a verbatim copy of that code taken on 2026-05-08
 * (kept in the auditor's working notes, which do not ship), and the
 * operator lines it ports are cited below (OPERATOR_SOURCE_CITES) against
 * the copy vendored on 2026-05-19 under evidence/verify-tab/. It is not an
 * independent, spec-only rewrite; Step 5 also runs Duel's code unmodified
 * as a cross-check.
 *
 * Pipeline (per spin):
 *   1. outcome_index = first 4 bytes BE of
 *        HMAC-SHA256(hex_decode(server_seed),
 *                    bytesToHex(client_seed) + ":" + nonce)
 *      — the client seed is HEX-ENCODED before going into the message,
 *      and there is no `:cursor` suffix (different from keno/dice/bj).
 *
 *   2. tumble_seed = mix(outcome_index, round_index, tumble_index)
 *      using xorshift+imul (Murmur3 finalise variant).
 *
 *   3. PCG32 PRNG seeded with tumble_seed (SplitMix64 expansion).
 *
 *   4. grid[col][row] (column-major) = rejection-sampled symbol from
 *      that reel's weighted distribution.
 *
 *   5. multiplier values (bonus only) for each cell whose symbol is
 *      `multiplier`: rejection-sampled from `multiplier_values` array.
 *
 * The capture's per-spin /verify response includes outcome_index,
 * server_seed, server_seed_hash, and the 30-cell grid; this module is
 * what re-derives the grid byte-for-byte from the seed inputs.
 */

import * as crypto from 'crypto';

/**
 * THE OPERATOR LINES THIS FILE PORTS (profile GROOMERS-09, 2026-09-26). Line numbers are of the DECODED
 * text of evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json — Duel's own Verify-tab
 * code; src/operator-verifier.ts checkOperatorCites FAILs any citation whose line does not carry its text.
 */
export const OPERATOR_SOURCE_CITES: ReadonlyArray<{ line: number; text: string; ports: string }> = Object.freeze([
  { line: 51,  text: 'const clientSeedHex = bytesToHex(encoder.encode(clientSeed));', ports: 'computeOutcomeIndex: client seed hex-encoded' },
  { line: 52,  text: "const message = clientSeedHex + ':' + nonce;", ports: 'computeOutcomeIndex: message, no cursor' },
  { line: 67,  text: 'return view.getUint32(0, false);', ports: 'computeOutcomeIndex: first 4 bytes big-endian' },
  { line: 77,  text: 'x ^= Math.imul(roundIndex + 1, 0x9e3779b9) >>> 0;', ports: 'deriveTumbleSeed: round mix' },
  { line: 80,  text: 'x ^= Math.imul(tumbleIndex + 1, 0x85ebca6b) >>> 0;', ports: 'deriveTumbleSeed: tumble mix' },
  { line: 83,  text: 'x = Math.imul(x, 0xc2b2ae35) >>> 0;', ports: 'deriveTumbleSeed: finaliser' },
  { line: 24,  text: 'this.increment = 0x5851f42d4c957f2dn;', ports: 'Pcg32: increment' },
  { line: 28,  text: 'seed64 = (seed64 + 0x9e3779b97f4a7c15n) & 0xFFFFFFFFFFFFFFFFn;', ports: 'Pcg32: SplitMix64 step 1' },
  { line: 38,  text: 'this.state = (oldState * 6364136223846793005n + this.increment) & 0xFFFFFFFFFFFFFFFFn;', ports: 'Pcg32.nextUint32: LCG step' },
  { line: 43,  text: 'return ((xorShifted >>> rot) | (xorShifted << ((32 - rot) & 31))) >>> 0;', ports: 'Pcg32.nextUint32: XSH-RR output' },
  { line: 109, text: 'const maxFair = MAX_UINT32 - (MAX_UINT32 % totalWeight);', ports: 'acceptedDraw: window' },
  { line: 116, text: '} while (rnd >= maxFair);', ports: 'acceptedDraw: rejection' },
  { line: 118, text: 'const pick = rnd % totalWeight;', ports: 'acceptedDraw: reduction' },
  { line: 125, text: 'if (pick < cumulativeWeight) {', ports: 'indexFromPick: cumulative walk' },
]);

// ── HMAC + outcome_index ────────────────────────────────────────────────────

/**
 * SHA-256 of the hex-decoded server seed bytes — i.e. the commitment hash
 * the casino pre-publishes before the seed is revealed.
 */
export function hashServerSeed(serverSeedHex: string): string {
  return crypto.createHash('sha256').update(Buffer.from(serverSeedHex, 'hex')).digest('hex');
}

/**
 * outcome_index for one spin.
 *
 * Replicates the official verifier's Step 1:
 *   message = bytesToHex(utf8Bytes(clientSeed)) + ":" + nonce
 *   hmac    = HMAC-SHA256(hex_decode(serverSeed), message)
 *   return  hmac[0..4] read big-endian as uint32
 */
export function computeOutcomeIndex(
  serverSeedHex: string,
  clientSeed: string,
  nonce: number,
): number {
  const clientSeedHex = Buffer.from(clientSeed, 'utf-8').toString('hex');
  const message       = `${clientSeedHex}:${nonce}`;
  const key           = Buffer.from(serverSeedHex, 'hex');
  const hmac          = crypto.createHmac('sha256', key).update(message).digest();
  return hmac.readUInt32BE(0);
}

// ── tumble_seed mix ─────────────────────────────────────────────────────────

const u32 = (x: number): number => x >>> 0;

// JS `Math.imul` semantics — signed 32-bit multiply with low-32 truncation.
// Node has Math.imul natively; we wrap for clarity.
const imul = (a: number, b: number): number => Math.imul(a, b) >>> 0;

/**
 * Derive the tumble seed by mixing outcome_index with the round index
 * (free-spin index inside a bonus session) and tumble index (cascade
 * depth inside a single spin).
 *
 * Both indices are 0-based; the +1 is in the original verifier source.
 */
export function deriveTumbleSeed(
  outcomeIndex: number,
  roundIndex: number,
  tumbleIndex: number,
): number {
  let x = u32(outcomeIndex);
  x = u32(x ^ imul(roundIndex + 1, 0x9e3779b9));
  x = u32(x ^ imul(tumbleIndex + 1, 0x85ebca6b));
  x = u32(x ^ (x >>> 16));
  x = imul(x, 0xc2b2ae35);
  x = u32(x ^ (x >>> 16));
  return x;
}

// ── PCG32 PRNG ──────────────────────────────────────────────────────────────

const MASK64    = (1n << 64n) - 1n;
const PCG_MULT  = 6364136223846793005n;
const PCG_INC   = 0x5851f42d4c957f2dn;

/**
 * PCG-XSH-RR 64/32 with SplitMix64 seed expansion.
 *
 * Matches the `Pcg32` class in the verifier source verbatim.
 */
export class Pcg32 {
  state: bigint;

  constructor(seed32: number) {
    let s = BigInt(u32(seed32));
    s = (s + 0x9e3779b97f4a7c15n) & MASK64;
    s = ((s ^ (s >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    s = ((s ^ (s >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    s ^= (s >> 31n);
    this.state = s & MASK64;
  }

  nextUint32(): number {
    const oldState = this.state;
    this.state     = (oldState * PCG_MULT + PCG_INC) & MASK64;
    const xorShifted = u32(Number(((oldState >> 18n) ^ oldState) >> 27n));
    const rot        = Number(oldState >> 59n) & 31;
    return u32((xorShifted >>> rot) | (xorShifted << ((32 - rot) & 31)));
  }
}

// ── Rejection-sampled weighted pick ─────────────────────────────────────────

const MAX_UINT32 = 0xFFFFFFFF;

/**
 * THE ACCEPTANCE RULE of every weighted draw (grid symbols and bonus multiplier values) — the one
 * place it lives since 2026-09-26, so the draw-bias bound (Step 5, profile GROOMERS-08) probes the
 * rule the recomputation actually runs. A PCG32 output v is accepted iff v < MAX − (MAX mod total),
 * and then reduced mod total; null = rejected, draw again.
 */
export function acceptedDraw(value: number, total: number): number | null {
  const maxFair = MAX_UINT32 - (MAX_UINT32 % total);
  return value < maxFair ? value % total : null;
}

/** Cumulative walk from a reduced draw to the weighted index (the operator verifier's pattern). */
function indexFromPick(pick: number, weights: number[]): number {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (pick < acc) return i;
  }
  // Unreachable when weights[] is well-formed (acc reaches total exactly).
  throw new Error('pickWeighted: cumulative weights did not cover total');
}

/**
 * Sample one symbol index from a weighted distribution, drawing uint32s
 * from `prng` until a bias-free value is found.
 */
export function pickWeighted(prng: Pcg32, weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  let pick: number | null;
  do {
    pick = acceptedDraw(prng.nextUint32(), total);
  } while (pick === null);
  return indexFromPick(pick, weights);
}

/** One weight total's row of the draw-bias bound. */
export interface TotalBias {
  total: number;
  /** Accepted window's exclusive end, MEASURED from acceptedDraw by binary search. */
  acceptedWindow: number;
  remainder: number;
  perResidue: number;
  /** max over residues r of |P(r) − 1/total|; 0 when the window is a whole number of totals. */
  bias: number;
  predicateProbeFailures: number;
  exact: boolean;
}

/**
 * THE DRAW BIAS BOUND (profile GROOMERS-08, added 2026-09-26; same method as Duel Mines/Beef
 * drawBiasBound). For each weight total the draws use, the accepted window is located by binary search
 * on acceptedDraw and ~600 probes confirm it IS "v < window ? v mod total : null". Exactly uniform on
 * the residues iff the window is a whole number of totals — then each symbol's probability is its
 * weight / total exactly, given a uniform 32-bit source.
 */
export function drawBiasBound(totals: number[]): { rows: TotalBias[]; worstBias: number; inexact: number[] } {
  const domain = MAX_UINT32 + 1;
  const rows: TotalBias[] = [];
  for (const total of [...new Set(totals)].sort((a, b) => a - b)) {
    let lo = 0, hi = domain;
    if (acceptedDraw(0, total) === null) hi = 0;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (acceptedDraw(mid, total) !== null) lo = mid; else hi = mid;
    }
    const W = hi === 0 ? 0 : (acceptedDraw(lo, total) !== null ? lo + 1 : lo);
    const probes = new Set<number>();
    for (let d = 0; d < 100; d++) {
      probes.add(d); probes.add(MAX_UINT32 - d);
      if (W - 1 - d >= 0) probes.add(W - 1 - d);
      if (W + d <= MAX_UINT32) probes.add(W + d);
    }
    for (let k = 0; k < 200; k++) probes.add(Math.floor(k * (domain / 200)) + (k % total));
    let predicateProbeFailures = 0;
    for (const v of probes) {
      if (v < 0 || v > MAX_UINT32) continue;
      if (acceptedDraw(v, total) !== (v < W ? v % total : null)) predicateProbeFailures++;
    }
    const remainder = W % total;
    const perResidue = Math.floor(W / total);
    const maxC = remainder === 0 ? perResidue : perResidue + 1;
    const bias = W === 0 ? 1 : Math.max(maxC * total - W, W - perResidue * total) / (W * total);
    rows.push({ total, acceptedWindow: W, remainder, perResidue, bias, predicateProbeFailures,
      exact: remainder === 0 && W > 0 && predicateProbeFailures === 0 });
  }
  return { rows, worstBias: Math.max(...rows.map(r => r.bias)), inexact: rows.filter(r => !r.exact).map(r => r.total) };
}

// ── Grid generation ─────────────────────────────────────────────────────────

export const REELS = 6;  // columns
export const ROWS  = 5;

export type SymbolGrid = number[][];   // grid[col][row] = symbol index 0..K-1

/**
 * Generate the column-major grid for one tumble round.
 *
 * `weightsPerReel` is `weights[col][symbolIndex]` — the per-reel
 * weights for whichever condition (base_game or bonus_game) applies
 * to this spin.
 */
export function generateGrid(prng: Pcg32, weightsPerReel: number[][]): SymbolGrid {
  const grid: SymbolGrid = [];
  for (let col = 0; col < REELS; col++) {
    const reel: number[] = [];
    const weights = weightsPerReel[col];
    for (let row = 0; row < ROWS; row++) {
      reel.push(pickWeighted(prng, weights));
    }
    grid.push(reel);
  }
  return grid;
}

// ── Multiplier-symbol values (bonus only) ───────────────────────────────────

export interface PositionMultiplier {
  position: number;   // column-major: col * ROWS + row
  value:    number;   // multiplier (e.g. 2, 3, 5, 250, …)
}

/**
 * For each cell whose symbol index equals `multiplierSymbolIndex`,
 * draw the next PCG32 uint32 (with rejection) and pick from
 * `multiplierValues`.
 *
 * The PRNG state is shared with `generateGrid` — multiplier values
 * consume from the same stream after the grid is fully drawn.
 */
export function generateMultipliers(
  grid: SymbolGrid,
  prng: Pcg32,
  multiplierSymbolIndex: number,
  multiplierValues: number[],
  multiplierWeights?: number[],
): PositionMultiplier[] {
  if (multiplierSymbolIndex == null || multiplierValues.length === 0) return [];
  const out: PositionMultiplier[] = [];
  // Weighted sampling per the operator's published `multiplier_values`
  // distribution (e.g. 2× weight 90, 3× weight 25, …, 250× weight 3).
  // Uniform sampling would inflate the expected multiplier value by ~3×
  // and was the structural cause of the 21pp blended-RTP overestimate.
  const weights = multiplierWeights ?? new Array(multiplierValues.length).fill(1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  for (let col = 0; col < REELS; col++) {
    for (let row = 0; row < ROWS; row++) {
      if (grid[col][row] === multiplierSymbolIndex) {
        let pick: number | null;
        do {
          pick = acceptedDraw(prng.nextUint32(), totalWeight);
        } while (pick === null);
        // Cumulative-accumulator walker — matches the operator's published
        // verifier code exactly (same pattern as Step 4 grid generation).
        const chosen = indexFromPick(pick, weights);
        out.push({ position: col * ROWS + row, value: multiplierValues[chosen] });
      }
    }
  }
  return out;
}

// ── End-to-end one-call helper ──────────────────────────────────────────────

export interface SpinResult {
  outcomeIndex:    number;
  outcomeIndexHex: string;
  tumbleSeed:      number;
  grid:            SymbolGrid;            // grid[col][row] = symbol index
  multipliers:     PositionMultiplier[];  // empty for base_game
}

/**
 * One full re-derivation: (server_seed, client_seed, nonce, round_index,
 * tumble_index) → grid + multipliers.
 *
 * `weightsPerReel` and `multiplierSymbolIndex`/`multiplierValues` are
 * looked up from `/api/v2/slots` (`weights.symbols_by_condition.<base|bonus>_game`
 * and `symbols.multiplier.symbol_index` / `features[].metadata.multiplier_values`).
 */
export function reproduceSpin(args: {
  serverSeed:            string;
  clientSeed:            string;
  nonce:                 number;
  roundIndex:            number;
  tumbleIndex:           number;
  weightsPerReel:        number[][];
  multiplierSymbolIndex?: number | null;
  multiplierValues?:     number[] | null;
  multiplierWeights?:    number[] | null;
}): SpinResult {
  const outcomeIndex = computeOutcomeIndex(args.serverSeed, args.clientSeed, args.nonce);
  const tumbleSeed   = deriveTumbleSeed(outcomeIndex, args.roundIndex, args.tumbleIndex);
  const prng         = new Pcg32(tumbleSeed);
  const grid         = generateGrid(prng, args.weightsPerReel);
  const multipliers  =
    args.multiplierSymbolIndex != null && args.multiplierValues && args.multiplierValues.length
      ? generateMultipliers(grid, prng, args.multiplierSymbolIndex, args.multiplierValues, args.multiplierWeights ?? undefined)
      : [];
  return {
    outcomeIndex,
    outcomeIndexHex: outcomeIndex.toString(16).padStart(8, '0'),
    tumbleSeed,
    grid,
    multipliers,
  };
}
