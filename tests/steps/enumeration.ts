/**
 * Steps 29–32: exhaustive 2³² enumeration artifact verification.
 *
 *   29. Base 2³² artifact integrity      — file SHA-256 matches pinned hash
 *   30. Bonus 2³² artifact integrity     — file SHA-256 matches pinned hash
 *   31. Session-EV artifact integrity    — file SHA-256 matches pinned hash (4 exact session artifacts)
 *   32. Headline game RTP derivation     — re-derives 99.9720% (raw, exact) from the artifacts
 *
 * Designed so anyone running `npm test` after cloning the repo gets the
 * audit's primary RTP claim verified in seconds, without re-running the
 * 4.3-billion-spin enumeration.
 *
 * If the verifier wants to re-derive results themselves:
 *   - `npm run enumerate:both`    — CPU per-spin RTP sanity check, ~4.4h on 20-thread desktop
 *                                   (re-derives the per-spin aggregate RTPs; does NOT regenerate the
 *                                   joint_histogram / scatter_histogram in the committed artifact)
 *   - `npm run enumerate:cuda`    — CUDA fast path, ~90s on RTX 5060 (re-derives the committed
 *                                   artifact in full; byte-parity against the committed file expected)
 *
 * See MANIFEST.md#reproduce-the-audit (enumeration layers) and MANIFEST.md#payouts-and-rtp for the 3-layer
 * reproducibility plan and what each layer proves.
 */

import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';
import { step, type VerifyContext, type StepResult } from './context';

// Pinned hashes — produced 2026-05-23 from the corrected CUDA + TS enumerator
// (both bit-parity, both fixed for the new-grid multiplier filtering bug).
const EXPECTED_BASE_HASH    = '0b890eef7153fcdf14c69d8559de8d3f50af558e5464974627db2103ee22d5a1';
const EXPECTED_BONUS_HASH   = 'e878256256cf59edb458d6ec0f5b1cc5ea6e2d45764636676362345d4cdfdb14';

// Exact dense-lane-convolution session artifacts, one per distinct initial-spin
// count (8/10/12/14, keyed by the scatter trigger that produces it). Deterministic —
// no Monte Carlo seed — so a hash mismatch is a hard FAIL, not a soft FLAG.
// Hashes pinned 2026-05-28 after re-running session-ev-exact per initial-spin count.
const EXPECTED_SESSION_HASHES: Record<number, string> = {
  8:  '15a11d74e7fc10e4426bb013e4d5e1f9204e2620cf5307f51ba8f7c01b4945e2',
  10: 'a03b4e024b1182ad62e64739e47069b2a4d302430f9153a9d1f26d8104072257',
  12: '334e55e3183065cd0e3a0e5157f11d8d37e5f1ad435e8d4d91083028c8905fda',
  14: '79236fe8facf3b6ab33238a51a121f333f80bb38e0ec9361a5585fd81bc97461',
};

// Initial-spin counts per scatter count (from operator config).
// 3 → 8, 4 → 10, 5 → 12, 6+ → 14
const INITIAL_SPINS_BY_SCATTERS: Record<number, number> = { 3: 8, 4: 10, 5: 12, 6: 14 };

function fileHash(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface BaseArtifact {
  range: { from: number; to: number; count: number };
  condition: 'base_game';
  rtp: number;
  sum?: number;
  hist_granularity?: number;
  win_rate: number;
  histogram: [number, number][];
  scatter_histogram: number[];
}
interface BonusArtifact extends Omit<BaseArtifact, 'condition'> {
  condition: 'bonus_game';
  joint_histogram: [number, number, number][];
}
interface SessionArtifact {
  method: string;
  initial_spins: number;
  max_retriggers: number;
  max_win_x: number;
  result: { mean_session_payout: number };
}

/**
 * The headline derivation, shared by Step 32 (which scores it against the operator's claim) and
 * Step 16 (which uses it as the EXACT anchor the Monte Carlo must reproduce). Reads the pinned
 * artifacts only; returns null when any is missing (Steps 29–31 report that). Also returns what
 * Step 16 needs to size its bound from computed numbers rather than a round figure: the exact
 * per-spin variance of the base game (from the 2^32 histogram), the exact per-session mean and
 * standard deviation for each initial-spin count, and the rounding bound the session convolution
 * itself declares.
 */
export interface EnumeratedRtp {
  baseRTP: number;
  baseWinRate: number;
  baseVariance: number;
  pByScatter: { p3: number; p4: number; p5: number; p6plus: number };
  pTrig: number;
  sessionMeanByInitialSpins: Record<number, number>;
  sessionStdByInitialSpins: Record<number, number>;
  sessionRoundingStdevBoundMax: number;
  eSessionTriggered: number;
  totalRtp: number;
}

/**
 * `rules` defaults to the operator's published trigger rules. Step 16's NEGATIVE CONTROL (GROOMERS-18,
 * added 2026-09-26) passes deliberately corrupted rules — a wrong trigger threshold, a wrong
 * spins-per-scatter table — to derive the anchor a corrupted model would predict, and requires the
 * Monte Carlo to be rejected against it.
 */
export interface TriggerRules { minScatters: number; spinsByScatters: Record<number, number> }
export const PUBLISHED_TRIGGER_RULES: TriggerRules = Object.freeze({
  minScatters: 3, spinsByScatters: Object.freeze({ ...INITIAL_SPINS_BY_SCATTERS }),
}) as TriggerRules;

export function deriveEnumeratedRtp(outputsDir: string, rules: TriggerRules = PUBLISHED_TRIGGER_RULES): EnumeratedRtp | null {
  const basePath = path.join(outputsDir, 'base-2pow32.json');
  const sessionPathFor = (n: number) => path.join(outputsDir, `bonus-session-ev-exact-${n}.json`);
  const SESSION_SPIN_COUNTS = [8, 10, 12, 14];
  if (!fs.existsSync(basePath) || !SESSION_SPIN_COUNTS.every(n => fs.existsSync(sessionPathFor(n)))) return null;
  const base = JSON.parse(fs.readFileSync(basePath, 'utf-8')) as BaseArtifact & { hist_granularity: number };
  const mean: Record<number, number> = {}, std: Record<number, number> = {};
  let roundMax = 0;
  for (const n of SESSION_SPIN_COUNTS) {
    const s = JSON.parse(fs.readFileSync(sessionPathFor(n), 'utf-8')) as SessionArtifact
      & { result: { std: number; rounding_stdev_bound: number } };
    if (s.initial_spins !== n) return null;
    mean[n] = s.result.mean_session_payout;
    std[n] = s.result.std;
    roundMax = Math.max(roundMax, s.result.rounding_stdev_bound);
  }
  const sh = base.scatter_histogram;
  const totalBase = base.range.count;
  // A scatter class below the trigger threshold triggers nothing (its probability is zeroed).
  const trig = (k: number, p: number): number => (k >= rules.minScatters ? p : 0);
  const p3      = trig(3, sh[3] / totalBase);
  const p4      = trig(4, sh[4] / totalBase);
  const p5      = trig(5, sh[5] / totalBase);
  const p6plus  = trig(6, sh.slice(6).reduce((a, b) => a + b, 0) / totalBase);
  const pTrig   = p3 + p4 + p5 + p6plus;
  const sp = rules.spinsByScatters;
  if (![3, 4, 5, 6].every(k => mean[sp[k]] !== undefined)) return null;
  const eSessionTriggered =
    (p3 * mean[sp[3]] +
     p4 * mean[sp[4]] +
     p5 * mean[sp[5]] +
     p6plus * mean[sp[6]]) / pTrig;
  const totalRtp = base.rtp + pTrig * eSessionTriggered;
  // Exact per-spin variance of the base game from the full 2^32 histogram (bucket width
  // hist_granularity; values are bucket * granularity).
  let n0 = 0, m1 = 0, m2 = 0;
  for (const [k, c] of base.histogram) { const x = k * base.hist_granularity; n0 += c; m1 += c * x; m2 += c * x * x; }
  const baseVariance = m2 / n0 - (m1 / n0) ** 2;
  return {
    baseRTP: base.rtp, baseWinRate: base.win_rate, baseVariance,
    pByScatter: { p3, p4, p5, p6plus }, pTrig,
    sessionMeanByInitialSpins: mean, sessionStdByInitialSpins: std,
    sessionRoundingStdevBoundMax: roundMax,
    eSessionTriggered, totalRtp,
  };
}

export function run(_ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];
  const outputsDir = path.join(__dirname, '..', '..', 'outputs');
  const basePath    = path.join(outputsDir, 'base-2pow32.json');
  const bonusPath   = path.join(outputsDir, 'bonus-2pow32.json');
  const sessionPathFor = (n: number) => path.join(outputsDir, `bonus-session-ev-exact-${n}.json`);
  const SESSION_SPIN_COUNTS = [8, 10, 12, 14];

  // ── Step 29: Base 2³² artifact integrity ──────────────────────────────────
  if (!fs.existsSync(basePath)) {
    results.push(step(29, 'Base 2³² artifact integrity', 'FAIL',
      'outputs/base-2pow32.json missing. Run `npm run enumerate:both` or `npm run enumerate:cuda` to produce it.'));
  } else {
    const actual = fileHash(basePath);
    if (actual === EXPECTED_BASE_HASH) {
      results.push(step(29, 'Base 2³² artifact integrity', 'PASS',
        `SHA-256 matches pinned hash (${EXPECTED_BASE_HASH.slice(0, 16)}…)`));
    } else {
      results.push(step(29, 'Base 2³² artifact integrity', 'FAIL',
        `SHA-256 mismatch: expected ${EXPECTED_BASE_HASH}, got ${actual}`));
    }
  }

  // ── Step 30: Bonus 2³² artifact integrity ─────────────────────────────────
  if (!fs.existsSync(bonusPath)) {
    results.push(step(30, 'Bonus 2³² artifact integrity', 'FAIL',
      'outputs/bonus-2pow32.json missing. Run `npm run enumerate:both` or `npm run enumerate:cuda` to produce it.'));
  } else {
    const actual = fileHash(bonusPath);
    if (actual === EXPECTED_BONUS_HASH) {
      results.push(step(30, 'Bonus 2³² artifact integrity', 'PASS',
        `SHA-256 matches pinned hash (${EXPECTED_BONUS_HASH.slice(0, 16)}…)`));
    } else {
      results.push(step(30, 'Bonus 2³² artifact integrity', 'FAIL',
        `SHA-256 mismatch: expected ${EXPECTED_BONUS_HASH}, got ${actual}`));
    }
  }

  // ── Step 31: Session-EV artifact integrity ────────────────────────────────
  // Exact convolution is deterministic (no seed) → a hash mismatch is a hard FAIL,
  // same standard as the base/bonus artifacts. Verifies all four initial-spin files.
  {
    const problems: string[] = [];
    for (const n of SESSION_SPIN_COUNTS) {
      const p = sessionPathFor(n);
      if (!fs.existsSync(p)) {
        problems.push(`bonus-session-ev-exact-${n}.json missing (run \`npm run session-ev-exact:${n}\`)`);
        continue;
      }
      const actual   = fileHash(p);
      const expected = EXPECTED_SESSION_HASHES[n];
      if (actual !== expected) {
        problems.push(`initial_spins=${n}: SHA-256 mismatch, expected ${expected}, got ${actual}`);
      }
    }
    if (problems.length === 0) {
      results.push(step(31, 'Session-EV artifact integrity', 'PASS',
        `all ${SESSION_SPIN_COUNTS.length} exact session artifacts (initial_spins 8/10/12/14) match pinned SHA-256`));
    } else {
      results.push(step(31, 'Session-EV artifact integrity', 'FAIL', problems.join(' | ')));
    }
  }

  // ── Step 32: Headline game RTP derivation ─────────────────────────────────
  const allSessionsPresent = SESSION_SPIN_COUNTS.every(n => fs.existsSync(sessionPathFor(n)));
  if (!fs.existsSync(basePath) || !fs.existsSync(bonusPath) || !allSessionsPresent) {
    results.push(step(32, 'Headline game RTP derivation', 'FAIL',
      'cannot derive RTP — one or more artifacts missing (see steps 29–31)'));
    return results;
  }

  const base    = JSON.parse(fs.readFileSync(basePath, 'utf-8'))    as BaseArtifact;
  const bonus   = JSON.parse(fs.readFileSync(bonusPath, 'utf-8'))   as BonusArtifact;

  // Exact E[session | initial_spins=n] per distinct trigger spin-count, read straight
  // from the deterministic convolution artifacts — no linear scaling, no approximation.
  const evByInitialSpins = new Map<number, number>();
  for (const n of SESSION_SPIN_COUNTS) {
    const s = JSON.parse(fs.readFileSync(sessionPathFor(n), 'utf-8')) as SessionArtifact;
    if (s.initial_spins !== n) {
      results.push(step(32, 'Headline game RTP derivation', 'FAIL',
        `artifact bonus-session-ev-exact-${n}.json reports initial_spins=${s.initial_spins}, expected ${n}`));
      return results;
    }
    evByInitialSpins.set(n, s.result.mean_session_payout);
  }
  const evN = (n: number): number => {
    const v = evByInitialSpins.get(n);
    if (v === undefined) throw new Error(`no exact session EV for initial_spins=${n}`);
    return v;
  };

  // P(scatter ≥ 3 in base spin) → from base scatter_histogram
  const sh = base.scatter_histogram;
  const totalBase = base.range.count;
  const p3      = sh[3] / totalBase;
  const p4      = sh[4] / totalBase;
  const p5      = sh[5] / totalBase;
  const p6plus  = sh.slice(6).reduce((a, b) => a + b, 0) / totalBase;
  const pTrig   = p3 + p4 + p5 + p6plus;

  // E[session | triggered] = scatter-weighted mean of the EXACT per-spin-count session EVs.
  const eSessionTriggered =
    (p3 * evN(INITIAL_SPINS_BY_SCATTERS[3]) +
     p4 * evN(INITIAL_SPINS_BY_SCATTERS[4]) +
     p5 * evN(INITIAL_SPINS_BY_SCATTERS[5]) +
     p6plus * evN(INITIAL_SPINS_BY_SCATTERS[6])) / pTrig;

  const totalRtp = base.rtp + pTrig * eSessionTriggered;

  // C3 (FIXPASS2, 14 Oct 2026). This step used to hold the derived total to the operator's 100 % claim
  // itself — PASS within 0.1 pp, an operator FLAG (exit 2) within 1 pp, FAIL (exit 1) beyond — so an
  // RTP miss could end the run before the rule did. The claim is the RTP-CLAIM rule's, scored on this
  // step: the derived total is the one row of the RTP table (src/rtp-settings.ts, the same derivation)
  // and a house-side miss beyond the 0.1 pp band makes the verdict RTP FIGURE OVERSTATED, exit 5. What
  // this step decides now is the derivation itself: the base RTP it starts from is recomputed from the
  // base artifact's own sum and histogram (a forged headline field in a re-pinned artifact fails here).
  let histCount = 0, histSum = 0;
  const gran = base.hist_granularity ?? NaN;
  for (const [k, c] of base.histogram) { histCount += c; histSum += c * k * gran; }
  const sumRtp = typeof base.sum === 'number' ? base.sum / base.range.count : NaN;
  const histRtp = histSum / histCount;
  const SUM_REL_TOL = 1e-12;   // rtp is sum / count; only the double division separates them
  const HIST_ABS_TOL = 1e-6;   // bucket means at hist_granularity; measured gap 1.9e-9 on the committed artifact
  const derivationIssues: string[] = [];
  if (!(Math.abs(sumRtp - base.rtp) <= SUM_REL_TOL * base.rtp)) derivationIssues.push(`base rtp ${base.rtp} is not sum / count = ${sumRtp}`);
  if (histCount !== base.range.count) derivationIssues.push(`histogram counts ${histCount} spins, range ${base.range.count}`);
  if (!(Math.abs(histRtp - base.rtp) <= HIST_ABS_TOL)) derivationIssues.push(`base rtp ${base.rtp} is not the histogram's mean ${histRtp}`);

  // Every figure here — the base RTP, the trigger probability, the conditional session EV,
  // the derived total — is a measured float, and a float spelled into the sentence can only be
  // compared as a string by the reproduction gate. The measurements go in the machine data block.
  const data = {
    baseRTP: base.rtp,
    baseRTPFromSum: sumRtp,
    baseRTPFromHistogram: histRtp,
    triggerProbability: pTrig,
    triggerOneIn: 1 / pTrig,
    conditionalSessionEV: eSessionTriggered,
    totalRTP: totalRtp,
    sumRelTol: SUM_REL_TOL,
    histAbsTol: HIST_ABS_TOL,
  };

  if (derivationIssues.length === 0) {
    results.push(step(32, 'Headline game RTP derivation', 'PASS',
      `Total RTP derived from the exhaustive 2^32 base enumeration plus the exact bonus-session convolution — `
      + `base RTP + P(trigger) × E[session | trigger]; the base RTP equals the base artifact's own sum / count (relative ${SUM_REL_TOL}) `
      + `and its histogram's mean (within ${HIST_ABS_TOL}). The derived total is the one row of the RTP table, held to the `
      + `published figure by RTP-CLAIM on this step (band ±0.1 pp), not here. Figures in this step's data block.`,
      data));
  } else {
    results.push(step(32, 'Headline game RTP derivation', 'FAIL',
      `The base artifact does not reproduce its own headline: ${derivationIssues.join('; ')}. Figures in this step's data block.`,
      data));
  }

  return results;
}
