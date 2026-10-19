/**
 * Step 35 — Live-Sample Fit (profile GROOMERS-22). Added 2026-09-26, the Duel Crash Step 18 pattern.
 *
 * INFORMATIONAL AND VERDICT-LIGHT BY DESIGN. 5,730 captured base spins are too few to prove a
 * distribution — Step 5's recomputation of every grid, the 2^32 enumeration (Steps 29–32) and the
 * 30,000,000-spin simulation (Steps 16–17) do that — but a scored step whose statistics REACT to the live
 * sample means a corrupted or reordered sample cannot pass silently. Every test at the Bonferroni level
 * LIVE_FIT_ALPHA / (number of tests):
 *
 *  1. SYMBOL FREQUENCIES per reel: the initial deal (rounds[0].data.view, 5 cells per reel) of every
 *     regular base spin (mode 'spin'; buys force 4 scatters and are excluded) against the operator's
 *     published base-game reel weights (data/raw/groomers-van-config-v1.4.json), χ² with bins pooled to
 *     an expected count ≥ 5 — 6 tests.
 *  2. HIT RATE: the share of those spins that credit anything, against the base enumeration's exact
 *     win_rate (outputs/base-2pow32.json) — two-sided exact binomial.
 *  3. TRIGGER RATE: the share that trigger the bonus (feature_triggered), against the exact P(≥ 3
 *     scatters) from the same enumeration's scatter histogram — two-sided exact binomial.
 *
 * A deviation turns the step to INFO — never to FLAG or FAIL: profile policy INFORMATIONAL (Mike
 * 2026-09-29), reported, never counted, verdict unchanged. The measured statistics live in `data`.
 */

import * as fs   from 'fs';
import * as path from 'path';
import { step, type VerifyContext, type StepResult } from './context';
import { REELS, ROWS } from '../../src/rng';
import { chiSquaredPValue, poolTailBins } from '../../src/stats';
import { EXPECTED_MODE_BETS, LIVE_FIT_ALPHA } from '../../src/loader';
import { deriveEnumeratedRtp } from './enumeration';

function logPmf(k: number, n: number, p: number): number {
  let l = 0;
  for (let i = 0; i < k; i++) l += Math.log(n - i) - Math.log(i + 1);
  return l + k * Math.log(p) + (n - k) * Math.log(1 - p);
}
/** Two-sided exact binomial p-value: 2 × min(P(X ≤ k), P(X ≥ k)), capped at 1. */
function twoSidedBinomial(k: number, n: number, p: number): number {
  let lower = 0, upper = 0;
  for (let i = 0; i <= n; i++) {
    const v = Math.exp(logPmf(i, n, p));
    if (i <= k) lower += v;
    if (i >= k) upper += v;
  }
  return Math.min(1, 2 * Math.min(lower, upper));
}

export function run(ctx: VerifyContext): StepResult[] {
  const problems: string[] = [];
  const spins = (ctx.bets as any[]).filter(b => b.mode === 'spin');
  if (spins.length !== EXPECTED_MODE_BETS.spin) problems.push(`${spins.length} regular spins, ${EXPECTED_MODE_BETS.spin} declared`);
  const nTests = REELS + 2;
  const alpha = LIVE_FIT_ALPHA / nTests;

  // ── 1. Symbol frequencies per reel ──────────────────────────────────────────────────────────────
  const symbols = [...ctx.config.weights.symbols_by_condition.base_game].sort((a: any, b: any) => a.symbol_index - b.symbol_index);
  const codeIdx = new Map<string, number>(symbols.map((s: any, i: number) => [s.code, i]));
  const counts: number[][] = Array.from({ length: REELS }, () => new Array(symbols.length).fill(0));
  let malformed = 0;
  for (const b of spins) {
    const view = b.response?.rounds?.[0]?.data?.view;
    if (!Array.isArray(view) || view.length !== REELS) { malformed++; continue; }
    for (let r = 0; r < REELS; r++) {
      const col = view[r];
      if (!Array.isArray(col) || col.length !== ROWS) { malformed++; continue; }
      for (const cell of col) {
        const i = codeIdx.get(cell?.symbol);
        if (i === undefined) { malformed++; continue; }
        counts[r][i]++;
      }
    }
  }
  if (malformed > 0) problems.push(`${malformed} initial-deal column(s)/cell(s) not on the published base-game reel strip`);
  const reels = counts.map((obs, r) => {
    const w = symbols.map((s: any) => s.weights_per_reel[r]);
    const tw = w.reduce((a: number, x: number) => a + x, 0);
    const n = obs.reduce((a, x) => a + x, 0);
    const pooled = poolTailBins(obs, w.map((x: number) => (x / tw) * n), 5);
    let chi2 = 0;
    for (let i = 0; i < pooled.observed.length; i++) chi2 += (pooled.observed[i] - pooled.expected[i]) ** 2 / pooled.expected[i];
    const df = pooled.observed.length - 1;
    const p = df > 0 ? chiSquaredPValue(chi2, df) : 0;
    if (n === 0) problems.push(`reel ${r}: no cells`);
    else if (p < alpha) problems.push(`reel ${r} symbol frequencies χ² p below ${alpha}`);
    return { reel: r, cells: n, chi2, df, p };
  });

  // ── 2–3. Hit and trigger rates ──────────────────────────────────────────────────────────────────
  const baseArt = (() => { try { return JSON.parse(fs.readFileSync(path.join(ctx.outputsDir, 'base-2pow32.json'), 'utf8')); } catch { return null; } })();
  const exact = deriveEnumeratedRtp(ctx.outputsDir);
  const hits = spins.filter(b => { const w = Number(b.response?.total_win_currency); return Number.isFinite(w) && w > 0; }).length;
  const triggers = spins.filter(b => b.response?.feature_triggered === true).length;
  const hitP = baseArt ? twoSidedBinomial(hits, spins.length, baseArt.win_rate) : 0;
  const trigP = exact ? twoSidedBinomial(triggers, spins.length, exact.pTrig) : 0;
  if (!baseArt || !exact) problems.push('base 2^32 enumeration absent — no exact hit / trigger rate');
  else {
    if (hitP < alpha) problems.push(`hit rate p below ${alpha}`);
    if (trigP < alpha) problems.push(`trigger rate p below ${alpha}`);
  }

  const ok = problems.length === 0;
  return [step(35, 'Live-Sample Fit (informational, GROOMERS-22)',
    ok ? 'PASS' : 'INFO',
    ok
      ? `the ${spins.length} regular base spins' initial-deal symbol frequencies fit the published base-game reel weights on all ${REELS} reels (χ², bins pooled to expected ≥ 5), and their hit rate and bonus-trigger rate fit the exact 2^32-enumeration probabilities (two-sided exact binomial); all ${nTests} tests p ≥ ${alpha} (Bonferroni ${LIVE_FIT_ALPHA}/${nTests}); informational — the distribution is proven by Steps 5, 16–17 and 29–32. Statistics in this step's data block.`
      : `live-sample deviation (INFO, informational — reported, not counted, verdict unchanged): ${problems.join('; ')}`,
    {
      tests: nTests, alpha, spins: spins.length, reels,
      hitRate: { hits, n: spins.length, exact: baseArt?.win_rate ?? null, p: hitP },
      triggerRate: { triggers, n: spins.length, exact: exact?.pTrig ?? null, p: trigP },
    },
  )];
}
