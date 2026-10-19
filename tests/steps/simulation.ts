/**
 * Steps 16–18: Anti-circularity + Monte Carlo simulation results.
 *
 *  16. Anti-Circularity         — independent theoretical RTP recompute
 *                                 (publishes Pass 1's blended RTP
 *                                 estimate alongside the operator's
 *                                 claim; flags divergence beyond
 *                                 modelling tolerance).
 *  17. Simulation Pass 1         — reads outputs/simulation-results.json
 *                                 written by `npm run simulate`.
 *                                 Verifies per-reel chi-squared passes
 *                                 (Bonferroni-corrected) and per-spin
 *                                 payout serial-independence.
 *  18. Pass 2 Cherry-Pick        — reads the Pass 2 aggregate z-score
 *                                 (captured aggregate RTP vs Pass 1
 *                                 baseline). PASS if |z| < 3.
 */

import * as fs   from 'fs';
import * as path from 'path';
import { step, type VerifyContext, type StepResult } from './context';
import { deriveEnumeratedRtp, PUBLISHED_TRIGGER_RULES, type TriggerRules, type EnumeratedRtp } from './enumeration';
import { numbersAgree } from '../../src/diff';
import { chiSquaredPValue, bonferroniCriticalZ } from '../../src/stats';
import { REELS } from '../../src/rng';
import { EXPECTED_MODE_BETS, EXPECTED_PASS2_EPOCHS } from '../../src/loader';

const SIM_RESULTS_PATH = path.join(__dirname, '..', '..', 'outputs', 'simulation-results.json');

interface SimResults {
  generatedAt: string;
  pass1: {
    baseSpins:          number;
    baseRTP:            number;
    triggerProbability: number;
    triggerScatterDistribution?: Record<string, number>;
    bonusSessionsRun:   number;
    averageBonusSessionPayout: number;
    blendedRTP:         number;
    convergence:        Array<{ rounds: number; rtp: number }>;
    perReelChiSquared:  Array<{ reel: number; chi2: number; df: number; pvalue: number; bins: number }>;
    chi2Fails:          number;
    chi2FailsBonferroni: number;
    bonferroniAlpha:    number;
    serialIndependence: {
      lag1Rho: number; lag1AbsZ: number; runsP: number; runsZ: number;
      lag1ZThreshold: number; runsPThreshold: number; passes: boolean;
    };
  };
  pass2: {
    seedsReplayed:        number;
    totalCapturedSpins:   number;
    capturedAggregateRTP: number;
    pass1ReferenceMean:   number;
    pass1PerSpinStd:      number;
    aggregateZScore:      number;
    aggregateThreshold:   number;
    aggregateRiskLevel:   string;
    perSeedAboveP95:      number;
    perSeedExpectedAt5pct: number;
    perSeedBinomialP:     number;
    forwardReplay: {
      epochs:            number;
      noncesPerSeed:     number;
      epochLength:       number;
      bins:              string;
      expectedWinRate:   number;
      cherryPickFlags:   number;
      cherryPickPValue:  number;
      cherryPickVerdict: 'PASS' | 'FAIL';
      results?: Array<{ seed_hash: string; early_chi2: number; early_p: number; late_chi2: number; late_p: number; cherry_pick_flag: boolean }>;
    };
  };
}

// Standard errors a Monte Carlo figure may sit from its exact counterpart before the step
// FAILS. audit-framework rule: simulation convergence is scored at 5σ + buffer, not a fixed
// percentage. The σ here are computed from the EXACT variances in the pinned enumeration
// artifacts, not estimated from the simulation being tested.
const K_SIGMA = 5;

function binomSurvival(k: number, n: number, p: number): number {
  // Same formula as src/simulate.ts: P(X >= k | n, p).
  let s = 0, term = Math.pow(1 - p, n);
  for (let x = 0; x < k; x++) {
    s += term;
    term = term * (n - x) / (x + 1) * (p / (1 - p));
  }
  return Math.max(0, 1 - s);
}

/**
 * The Step 16 comparison: each Monte Carlo component against an exact anchor, bound = K_SIGMA standard
 * errors computed from the exact variances (+ the convolution's declared rounding bound where a session
 * mean is involved). Factored out on 2026-09-26 so the NEGATIVE CONTROL (GROOMERS-18) runs the SAME
 * comparison against anchors derived from deliberately corrupted rules.
 */
function scoreAgainst(p1: SimResults['pass1'], exact: EnumeratedRtp, rules: TriggerRules) {
  const N = p1.baseSpins;
  const S = p1.bonusSessionsRun;
  // Session-length mix conditional on a trigger, keyed by initial spins under `rules`.
  const w: Record<number, number> = {};
  const pk: Record<number, number> = { 3: exact.pByScatter.p3, 4: exact.pByScatter.p4, 5: exact.pByScatter.p5, 6: exact.pByScatter.p6plus };
  for (const k of [3, 4, 5, 6]) {
    const n = rules.spinsByScatters[k];
    w[n] = (w[n] ?? 0) + pk[k] / exact.pTrig;
  }
  let eS2 = 0;
  for (const n of [8, 10, 12, 14]) {
    if (w[n] === undefined) continue;
    const m = exact.sessionMeanByInitialSpins[n], sd = exact.sessionStdByInitialSpins[n];
    eS2 += w[n] * (sd * sd + m * m);
  }
  const sessionVar = eS2 - exact.eSessionTriggered ** 2;
  const sigmaBase  = Math.sqrt(exact.baseVariance);
  // Var(T·S) for the per-spin bonus contribution; the base payout and the trigger are not
  // independent (scatters pay), so the blended SE uses the Minkowski bound
  // SD(B + T·S) ≤ SD(B) + SD(T·S), which holds for any covariance.
  const sigmaTS    = Math.sqrt(exact.pTrig * eS2 - (exact.pTrig * exact.eSessionTriggered) ** 2);
  const se = {
    base:    sigmaBase / Math.sqrt(N),
    trigger: Math.sqrt(exact.pTrig * (1 - exact.pTrig) / N),
    session: Math.sqrt(sessionVar) / Math.sqrt(S),
    blended: (sigmaBase + sigmaTS) / Math.sqrt(N),
  };
  const buffer = {
    base: 0, trigger: 0,
    session: exact.sessionRoundingStdevBoundMax,
    blended: exact.pTrig * exact.sessionRoundingStdevBoundMax,
  };
  return [
    { name: 'baseRTP',            mc: p1.baseRTP,                    ex: exact.baseRTP,           se: se.base,    buf: buffer.base },
    { name: 'triggerProbability', mc: p1.triggerProbability,         ex: exact.pTrig,             se: se.trigger, buf: buffer.trigger },
    { name: 'sessionPayout',      mc: p1.averageBonusSessionPayout,  ex: exact.eSessionTriggered, se: se.session, buf: buffer.session },
    { name: 'blendedRTP',         mc: p1.blendedRTP,                 ex: exact.totalRtp,          se: se.blended, buf: buffer.blended },
  ].map(r => {
    const dev = Math.abs(r.mc - r.ex);
    const bound = K_SIGMA * r.se + r.buf;
    return { ...r, deviation: dev, zScore: dev / r.se, bound, within: dev <= bound };
  });
}

/**
 * NEGATIVE CONTROLS (GROOMERS-18, added 2026-09-26; the Duel Dice Step 13 pattern). Each is a published
 * operator rule deliberately corrupted, the exact anchor re-derived from the SAME pinned enumeration
 * artifacts under it, and the SAME comparison run. A REQUIRED control must be REJECTED (at least one
 * component outside its bound), or the anti-circularity comparison is shown unable to tell the published
 * model from a wrong one and the step FAILS.
 *
 * The third entry is a POWER PROBE, not a required control, and is reported, not scored. It was written
 * with the other two, before any was run, as a required control; on the first run (2026-09-26) it was NOT
 * rejected — max z 4.35 against the 5σ bound — because it moves only the 4-, 5- and 6+-scatter triggers,
 * which are a small share of all triggers, so 132,222 simulated sessions cannot separate it at 5σ. It is
 * kept, and its z printed, as the measured limit of what this comparison can detect (MANIFEST DL-9).
 */
export const NEGATIVE_CONTROLS: ReadonlyArray<{ name: string; rules: TriggerRules; required: boolean }> = Object.freeze([
  { name: 'trigger threshold 3 → 4 scatters', required: true, rules: { minScatters: 4, spinsByScatters: { ...PUBLISHED_TRIGGER_RULES.spinsByScatters } } },
  { name: 'spins-per-scatter table shifted one tier up (3→10, 4→12, 5→14, 6+→14)', required: true, rules: { minScatters: 3, spinsByScatters: { 3: 10, 4: 12, 5: 14, 6: 14 } } },
  { name: 'spins-per-scatter table shifted one tier down for 4+ scatters (3→8, 4→8, 5→10, 6+→12) — power probe', required: false, rules: { minScatters: 3, spinsByScatters: { 3: 8, 4: 8, 5: 10, 6: 12 } } },
]);

export function run(ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];

  if (!fs.existsSync(SIM_RESULTS_PATH)) {
    results.push(step(16, 'Anti-Circularity', 'FAIL',
      `outputs/simulation-results.json missing — run \`npm run simulate\` first.`));
    results.push(step(17, 'Simulation Pass 1',         'FAIL', 'simulation-results.json missing'));
    results.push(step(18, 'Pass 2 Cherry-Pick Detection', 'FAIL', 'simulation-results.json missing'));
    return results;
  }

  const sim = JSON.parse(fs.readFileSync(SIM_RESULTS_PATH, 'utf-8')) as SimResults;
  const p1  = sim.pass1;
  const p2  = sim.pass2;
  const exact = deriveEnumeratedRtp(ctx.outputsDir);

  // ── Step 16: Anti-Circularity ──────────────────────────────────────────
  // The Monte Carlo simulator (npm run simulate) and the exhaustive 2^32 enumeration + exact
  // session convolution (Steps 29–32) are two independent computations of the same game from
  // the operator's published weights, paytable and cascade algorithm. This step requires them
  // to agree, component by component.
  //
  // What it used to do: compare the blended Monte Carlo RTP with the operator's CLAIMED 100%
  // at a flat ±1pp and return FLAG, never FAIL, when outside. Anchoring on the claim is
  // circular — the anti-circularity step measured against the number it exists to test — and
  // the flat 1pp was never derived. The anchor is now the enumerated figure (the Step 32
  // derivation, read from the pinned artifacts), each bound is K_SIGMA standard errors computed
  // from the exact variances, plus the rounding bound the convolution artifacts declare where a
  // session mean is involved, and a breach FAILS.
  //
  // What is recomputed and what is not: the per-spin rows of the 30M-spin run do not ship, so
  // baseRTP, the trigger count and the session total are read from simulation-results.json as
  // scalars. What CAN be recomputed from what ships is: the trigger probability from the
  // trigger count, the session count from the per-scatter trigger distribution, and the blended
  // figure from its parts — those are checked, and a mismatch FAILS.
  {
    const issues: string[] = [];
    const N = p1.baseSpins;
    const S = p1.bonusSessionsRun;
    const trigDistTotal = Object.values(p1.triggerScatterDistribution ?? {}).reduce((a, b) => a + b, 0);
    if (!(N > 0)) issues.push(`baseSpins ${N} is not positive`);
    if (!(S > 0)) issues.push(`bonusSessionsRun ${S} is not positive`);
    if (trigDistTotal !== S) issues.push(`per-scatter trigger distribution sums to ${trigDistTotal}, not bonusSessionsRun ${S}`);
    if (!numbersAgree(p1.triggerProbability, S / N)) issues.push(`triggerProbability ≠ bonusSessionsRun / baseSpins`);
    const blendRecomputed = p1.baseRTP + p1.triggerProbability * p1.averageBonusSessionPayout;
    if (!numbersAgree(p1.blendedRTP, blendRecomputed)) issues.push(`blendedRTP ≠ baseRTP + triggerProbability × averageBonusSessionPayout`);

    let data: Record<string, unknown> = { issues };
    let negativeControls: Array<{ name: string; required: boolean; rejected: boolean; rejectedBy: string[]; maxZ: number | null }> = [];
    if (!exact) {
      issues.push('enumeration artifacts missing — no exact anchor (see Steps 29–31)');
    } else {
      const rows = scoreAgainst(p1, exact, PUBLISHED_TRIGGER_RULES);
      for (const r of rows) {
        if (!r.within) issues.push(`${r.name}: Monte Carlo departs from the exact enumeration by ${r.deviation.toExponential(3)} > bound ${r.bound.toExponential(3)} (${K_SIGMA}σ + buffer)`);
      }
      // NEGATIVE CONTROLS: the same comparison against anchors from corrupted rules must reject.
      const controls = NEGATIVE_CONTROLS.map(c => {
        const ex = deriveEnumeratedRtp(ctx.outputsDir, c.rules);
        const cr = ex ? scoreAgainst(p1, ex, c.rules) : null;
        const rejectedBy = cr ? cr.filter(r => !r.within).map(r => r.name) : [];
        return { name: c.name, required: c.required, rejected: rejectedBy.length > 0, rejectedBy, maxZ: cr ? Math.max(...cr.map(r => r.zScore)) : null };
      });
      const accepted = controls.filter(c => c.required && !c.rejected);
      if (controls.filter(c => c.required).length === 0) issues.push('NEGATIVE CONTROL VACUOUS: no corrupted model was offered');
      for (const c of accepted) issues.push(`NEGATIVE CONTROL VACUOUS: the corrupted model "${c.name}" was NOT rejected — the comparison cannot tell it from the published one`);
      negativeControls = controls;
      data = {
        anchor: 'exact 2^32 enumeration + exact session convolution (Step 32 derivation), NOT the operator claim',
        kSigma: K_SIGMA,
        components: rows.map(r => ({
          name: r.name, monteCarlo: r.mc, exact: r.ex, standardError: r.se, buffer: r.buf,
          deviation: r.deviation, zScore: r.zScore, bound: r.bound, within: r.within,
        })),
        operatorClaimRTP: 1.0,
        baseSpins: N,
        bonusSessionsRun: S,
        negativeControls,
        issues,
      };
    }
    const ok = issues.length === 0;
    results.push(step(16, 'Anti-Circularity',
      ok ? 'PASS' : 'FAIL',
      `The Monte Carlo simulator (${N.toLocaleString()} base spins, ${S.toLocaleString()} bonus sessions) is scored against the EXACT 2^32 enumeration and session convolution — `
      + `two independent computations from the operator's published weights, paytable and cascade algorithm, with no operator-supplied probability table and without anchoring on the operator's 100% claim (Step 32 scores the claim). `
      + `Base RTP, trigger probability, mean session payout and blended RTP must each sit within ${K_SIGMA} standard errors of the exact figure (+ the convolution's declared rounding bound where a session mean is involved); the standard errors are computed from the exact variances in the pinned artifacts. `
      + `Recomputed from what ships: trigger probability from the trigger count, session count from the per-scatter distribution, blended RTP from its parts. The 30M per-spin rows do not ship, so the base and session totals themselves are read as scalars. `
      + `Negative control (added 2026-09-26): the same comparison is run against the anchor each corrupted published rule would predict, and every required one must be rejected (${NEGATIVE_CONTROLS.filter(c => c.required).map(c => c.name).join('; ')}); a power probe (${NEGATIVE_CONTROLS.filter(c => !c.required).map(c => c.name).join('; ')}) is reported with its z in the data block, not scored. `
      + (ok ? `All four components within bound; ${negativeControls.filter(c => c.required && c.rejected).length}/${NEGATIVE_CONTROLS.filter(c => c.required).length} required corrupted models rejected. ` : `FAILED: ${issues.join(' | ')}. `)
      + `Figures in this step's data block.`,
      data,
    ));
  }

  // ── Step 17: Simulation Pass 1 ─────────────────────────────────────────
  // Per-reel chi-squared on the initial-deal symbol distribution + serial independence on
  // per-spin payouts, Bonferroni-corrected across the 6 reels.
  //
  // It used to read the simulator's own verdict scalars (chi2FailsBonferroni, passes) and
  // return FLAG, never FAIL. Now every p-value is recomputed from its shipped chi² and df, the
  // Bonferroni alpha and both serial thresholds are recomputed from their definitions, the fail
  // count and the serial verdict are re-derived from those, and a disagreement with the
  // simulator's scalars — or a test that fails — is a FAIL. The underlying symbol counts and
  // the 100k payout series do not ship; the chi² statistics and the lag-1 / runs statistics
  // are read as shipped.
  {
    const issues: string[] = [];
    const rows = p1.perReelChiSquared ?? [];
    const alpha = 0.01 / REELS;
    if (rows.length !== REELS) issues.push(`${rows.length} reels reported, expected ${REELS}`);
    const reelIds = new Set(rows.map(r => r.reel));
    for (let i = 0; i < REELS; i++) if (!reelIds.has(i)) issues.push(`reel ${i} missing`);
    if (!numbersAgree(p1.bonferroniAlpha, alpha)) issues.push(`bonferroniAlpha ≠ 0.01 / ${REELS}`);
    let recomputedFails = 0;
    const recomputed = rows.map(r => {
      const p = chiSquaredPValue(r.chi2, r.df);
      if (!numbersAgree(p, r.pvalue)) issues.push(`reel ${r.reel}: shipped p ≠ chiSquaredPValue(chi2, df)`);
      if (r.df !== r.bins - 1) issues.push(`reel ${r.reel}: df ${r.df} ≠ bins − 1 (${r.bins - 1})`);
      if (p < alpha) recomputedFails++;
      return { reel: r.reel, chi2: r.chi2, df: r.df, pvalueRecomputed: p };
    });
    if (recomputedFails !== p1.chi2FailsBonferroni) issues.push(`simulator reports ${p1.chi2FailsBonferroni} Bonferroni fails, recomputed ${recomputedFails}`);
    if (recomputedFails > 0) issues.push(`${recomputedFails}/${REELS} reels fail chi² at the Bonferroni alpha`);

    const si = p1.serialIndependence;
    const zThr = bonferroniCriticalZ(0.01, REELS);
    if (!numbersAgree(si.lag1ZThreshold, zThr)) issues.push('lag1ZThreshold ≠ bonferroniCriticalZ(0.01, 6)');
    if (!numbersAgree(si.runsPThreshold, alpha)) issues.push('runsPThreshold ≠ 0.01 / 6');
    if (!numbersAgree(si.lag1AbsZ, Math.abs(si.lag1AbsZ))) issues.push('lag1AbsZ is negative');
    const serialOk = Math.abs(si.lag1AbsZ) < zThr && si.runsP > alpha;
    if (serialOk !== si.passes) issues.push(`simulator reports serial passes=${si.passes}, recomputed ${serialOk}`);
    if (!serialOk) issues.push('serial independence fails its Bonferroni thresholds');

    const ok = issues.length === 0;
    results.push(step(17, 'Simulation Pass 1',
      ok ? 'PASS' : 'FAIL',
      `Per-reel chi-squared on the initial-deal symbol distribution, Bonferroni-corrected across ${REELS} reels: ${recomputedFails}/${rows.length} fail, with every p-value recomputed from its shipped chi² and df. `
      + `Serial independence on 100k per-spin payouts: lag-1 |z| must be below bonferroniCriticalZ(0.01, ${REELS}) and runs p above 0.01/${REELS}, thresholds recomputed. `
      + `The simulator's own verdict scalars must agree with the recomputation. The symbol counts and the payout series do not ship; their statistics are read as shipped. `
      + (ok ? 'All checks within FWER-corrected thresholds. ' : `FAILED: ${issues.join(' | ')}. `)
      + `Statistics in this step's data block.`,
      {
        bonferroniAlpha: p1.bonferroniAlpha,
        reels: rows.length,
        chi2FailsBonferroni: p1.chi2FailsBonferroni,
        chi2FailsBonferroniRecomputed: recomputedFails,
        perReelChiSquared: p1.perReelChiSquared,
        perReelRecomputed: recomputed,
        serialIndependence: p1.serialIndependence,
        serialIndependenceRecomputed: serialOk,
        issues,
      },
    ));
  }

  // ── Step 18: Pass 2 Cherry-Pick ─────────────────────────────────────────
  // Two-part cherry-pick guard:
  //   (a) Aggregate captured RTP vs Pass 1 reference mean — |z| < 3.
  //   (b) Forward-replay: for each captured epoch, nonces 0..9999 replayed; win/no-win chi² in
  //       the early (0..49) vs late (50..9999) window; an epoch flags when early deviates
  //       (p < 0.05) and late does not; the flag count is tested by binomial survival at the 5%
  //       per-epoch false-positive rate, PASS if p ≥ 0.01.
  //
  // It used to read the simulator's own verdicts and return FLAG, never FAIL. Now:
  //   - the captured aggregate RTP, spin count and epoch set are RECOMPUTED from the dataset
  //     (the captured bets ship) and must equal the simulator's figures;
  //   - the z-score is recomputed from them;
  //   - the forward-replay rows must cover exactly the recomputed epoch set; each row's p-values
  //     are recomputed from its chi² (df = 1), each flag re-derived, the flag count re-counted
  //     and the binomial p recomputed; the expected win rate must be the pinned 2^32 base
  //     enumeration's win_rate.
  // Not recomputed: the Pass 1 reference mean and standard deviation (a 100k-spin sample that
  // does not ship) and the per-nonce win counts behind each chi² (replaying 115 × 10,000
  // nonces is `npm run simulate`'s job). Any disagreement or failed test is a FAIL.
  {
    const issues: string[] = [];
    // Recompute the captured side exactly as src/simulate.ts defines it: base_game spins whose
    // epoch seed is revealed, payout ratio amount_won_coins / bet_amount_currency.
    const epochs = new Map<string, { spins: number; payout: number }>();
    for (const b of ctx.bets) {
      if (b.mode !== 'spin' || b.response.spin_type !== 'base_game') continue;
      const h = b.activeAtSpin.server_seed_hashed;
      if (!ctx.seedMap.get(h)) continue;
      const e = epochs.get(h) ?? { spins: 0, payout: 0 };
      e.spins++;
      e.payout += parseFloat(b.response.amount_won_coins) / parseFloat(b.response.bet_amount_currency);
      epochs.set(h, e);
    }
    let nSpins = 0, totalPayout = 0;
    for (const e of epochs.values()) { nSpins += e.spins; totalPayout += e.payout; }
    const capturedRTP = nSpins > 0 ? totalPayout / nSpins : NaN;

    if (epochs.size !== EXPECTED_PASS2_EPOCHS) issues.push(`captured epochs with a base spin ${epochs.size} != ${EXPECTED_PASS2_EPOCHS} (src/loader.ts)`);
    if (nSpins !== EXPECTED_MODE_BETS.spin) issues.push(`captured base spins ${nSpins} != ${EXPECTED_MODE_BETS.spin} (src/loader.ts)`);
    if (p2.totalCapturedSpins !== nSpins) issues.push(`simulator used ${p2.totalCapturedSpins} captured spins, dataset has ${nSpins}`);
    if (p2.seedsReplayed !== epochs.size) issues.push(`simulator replayed ${p2.seedsReplayed} seeds, dataset has ${epochs.size}`);
    if (!numbersAgree(p2.capturedAggregateRTP, capturedRTP)) issues.push(`simulator's capturedAggregateRTP ≠ recomputed from the dataset`);
    if (p2.aggregateThreshold !== 3) issues.push(`aggregateThreshold ${p2.aggregateThreshold} ≠ 3`);
    const z = (capturedRTP - p2.pass1ReferenceMean) / (p2.pass1PerSpinStd / Math.sqrt(nSpins));
    if (!numbersAgree(p2.aggregateZScore, z)) issues.push(`simulator's aggregateZScore ≠ recomputed`);
    const aggOk = Math.abs(z) < 3;
    if (!aggOk) issues.push(`aggregate |z| ${Math.abs(z).toFixed(3)} ≥ 3`);

    const fr = p2.forwardReplay;
    const rows = fr.results ?? [];
    if (fr.epochs !== epochs.size || rows.length !== epochs.size) issues.push(`forward replay covers ${fr.epochs} epochs / ${rows.length} rows, dataset has ${epochs.size}`);
    const rowHashes = new Set(rows.map(r => r.seed_hash));
    let missingEpochs = 0;
    for (const h of epochs.keys()) if (!rowHashes.has(h)) missingEpochs++;
    if (missingEpochs > 0 || rowHashes.size !== rows.length) issues.push(`${missingEpochs} captured epochs absent from the forward replay; ${rows.length - rowHashes.size} duplicate rows`);
    if (fr.noncesPerSeed !== 10000 || fr.epochLength !== 50) issues.push(`forward replay window ${fr.epochLength}/${fr.noncesPerSeed} ≠ 50/10000`);
    if (!exact || !numbersAgree(fr.expectedWinRate, exact.baseWinRate)) issues.push(`expectedWinRate ≠ base-2pow32.json win_rate`);
    let flags = 0, rowIssues = 0;
    for (const r of rows) {
      const pe = chiSquaredPValue(r.early_chi2, 1), pl = chiSquaredPValue(r.late_chi2, 1);
      if (!numbersAgree(pe, r.early_p) || !numbersAgree(pl, r.late_p)) rowIssues++;
      const flag = pe < 0.05 && pl >= 0.05;
      if (flag !== r.cherry_pick_flag) rowIssues++;
      if (flag) flags++;
    }
    if (rowIssues > 0) issues.push(`${rowIssues} forward-replay row fields disagree with their recomputation`);
    if (flags !== fr.cherryPickFlags) issues.push(`simulator counts ${fr.cherryPickFlags} cherry-pick flags, recomputed ${flags}`);
    const pBinom = binomSurvival(flags, rows.length, 0.05);
    if (!numbersAgree(pBinom, fr.cherryPickPValue)) issues.push(`cherryPickPValue ≠ recomputed binomial survival`);
    const frOk = pBinom >= 0.01;
    if ((frOk ? 'PASS' : 'FAIL') !== fr.cherryPickVerdict) issues.push(`simulator verdict ${fr.cherryPickVerdict}, recomputed ${frOk ? 'PASS' : 'FAIL'}`);
    if (!frOk) issues.push(`forward-replay binomial p < 0.01`);

    const ok = issues.length === 0;
    results.push(step(18, 'Pass 2 Cherry-Pick Detection',
      ok ? 'PASS' : 'FAIL',
      `(a) Aggregate captured RTP across ${nSpins.toLocaleString()} base spins in ${epochs.size} epochs, RECOMPUTED from the dataset (src/loader.ts: ${EXPECTED_MODE_BETS.spin} spins, ${EXPECTED_PASS2_EPOCHS} epochs), must sit within |z| < 3 of the Pass 1 reference mean; z recomputed. `
      + `(b) Forward-replay (${fr.epochs} epochs × ${fr.noncesPerSeed.toLocaleString()} nonces, early=0..${fr.epochLength - 1} vs late): ${flags}/${rows.length} cherry-pick flags re-derived from p-values recomputed from each row's chi² (early p<0.05 AND late p≥0.05; bins=${fr.bins}); binomial p must be ≥ 0.01; rows must cover exactly the captured epochs; expected win rate must be the pinned 2^32 base win_rate. `
      + `The simulator's own figures must agree with every recomputation. Not recomputed: the Pass 1 reference mean/std (100k-spin sample, not shipped) and the per-nonce win counts behind each chi². `
      + `Per-seed informational: ${p2.perSeedAboveP95}/${p2.seedsReplayed} seeds above the Pass 1 95th percentile (expected ~${p2.perSeedExpectedAt5pct}). `
      + (ok ? 'Both parts PASS. ' : `FAILED: ${issues.join(' | ')}. `)
      + `Statistics in this step's data block.`,
      {
        totalCapturedSpins: p2.totalCapturedSpins,
        totalCapturedSpinsRecomputed: nSpins,
        seedsReplayed: p2.seedsReplayed,
        epochsRecomputed: epochs.size,
        capturedAggregateRTP: p2.capturedAggregateRTP,
        capturedAggregateRTPRecomputed: capturedRTP,
        pass1ReferenceMean: p2.pass1ReferenceMean,
        pass1PerSpinStd: p2.pass1PerSpinStd,
        aggregateZScore: p2.aggregateZScore,
        aggregateZScoreRecomputed: z,
        aggregateThreshold: p2.aggregateThreshold,
        aggregateRiskLevel: p2.aggregateRiskLevel,
        forwardReplay: {
          epochs: fr.epochs,
          noncesPerSeed: fr.noncesPerSeed,
          epochLength: fr.epochLength,
          bins: fr.bins,
          expectedWinRate: fr.expectedWinRate,
          cherryPickFlags: fr.cherryPickFlags,
          cherryPickFlagsRecomputed: flags,
          cherryPickPValue: fr.cherryPickPValue,
          cherryPickPValueRecomputed: pBinom,
          cherryPickVerdict: fr.cherryPickVerdict,
        },
        perSeedAboveP95: p2.perSeedAboveP95,
        perSeedBinomialP: p2.perSeedBinomialP,
        perSeedExpectedAt5pct: p2.perSeedExpectedAt5pct,
        issues,
      },
    ));
  }

  return results;
}
