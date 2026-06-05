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
 *                                   artifact in full; numerical parity against the committed file
 *                                   expected — CUDA float32 vs TS float64 has a documented noise
 *                                   floor, see `scripts/cpu-cuda-parity.ts` for tolerances)
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

// Operator's published game RTP (Zero Edge, bracket 0).
const OPERATOR_RTP = 1.0;

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
  const deviation = Math.abs(totalRtp - OPERATOR_RTP);

  const detail =
    `base RTP=${base.rtp.toFixed(6)}, P(trigger)=${pTrig.toFixed(8)} (1/${(1/pTrig).toFixed(1)}), ` +
    `E[session|trig]=${eSessionTriggered.toFixed(4)}, ` +
    `total RTP = ${totalRtp.toFixed(6)} = ${(totalRtp * 100).toFixed(4)}%  ` +
    `(operator claim ${OPERATOR_RTP * 100}%, deviation ${(deviation * 100).toFixed(4)}%)`;

  if (deviation < 0.001) {
    // Within 0.1% of operator's claim → PASS
    results.push(step(32, 'Headline game RTP derivation', 'PASS', detail));
  } else if (deviation < 0.01) {
    // Within 1% — likely MC variance in session-EV, surface as FLAG
    results.push(step(32, 'Headline game RTP derivation', 'FLAG', detail));
  } else {
    results.push(step(32, 'Headline game RTP derivation', 'FAIL', detail));
  }

  return results;
}
