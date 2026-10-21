/**
 * THE DRAW BIAS BOUND (profile GROOMERS-08). Audit code, not game code: it measures the acceptance rule
 * of the module the game runs (src/rng.ts acceptedDraw, which pickWeighted and generateMultipliers call),
 * so the bound is a property of that code and not of a re-statement of it.
 *
 * Moved here from src/rng.ts on 20 Oct 2026, when src/rng.ts was replaced by the clean-room rebuild from
 * docs/ALGORITHM.md (whose interface does not carry audit helpers). The method is unchanged (added
 * 2026-09-26; same method as Duel Mines/Beef drawBiasBound): for each weight total the draws use, the
 * accepted window is located by binary search on acceptedDraw and ~600 probes confirm it IS
 * "v < window ? v mod total : null". Exactly uniform on the residues iff the window is a whole number of
 * totals; then each symbol's probability is its weight / total exactly, given a uniform 32-bit source.
 */
import { acceptedDraw } from './rng';

const MAX_UINT32 = 0xFFFFFFFF;

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
