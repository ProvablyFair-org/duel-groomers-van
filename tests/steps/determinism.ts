/**
 * Steps 5–6: outcome determinism.
 *
 *  5. Outcome Recomputation     — for every bet whose epoch's server seed
 *                                 has been revealed, re-derive the
 *                                 outcome_index AND the round-0 30-cell
 *                                 grid from (server_seed, client_seed,
 *                                 nonce). Both must match the operator's
 *                                 published values byte-for-byte.
 *  6. Client Seed Influence     — same nonce+server_seed but a tampered
 *                                 client_seed produces a different
 *                                 outcome_index on EVERY eligible bet
 *                                 (proves the client seed is a real
 *                                 input, not theatre).
 *
 * Step 5 is the audit's strongest claim — if every captured spin
 * recomputes from public seeds, the casino cannot have invented or
 * adjusted any cell after the fact.
 */

import { step, type VerifyContext, type StepResult } from './context';
import { computeOutcomeIndex, deriveTumbleSeed, Pcg32, generateGrid, generateMultipliers, REELS, ROWS } from '../../src/rng';
import { drawBiasBound } from '../../src/bias';
import { loadSiteVerifier, SITE_VERIFIER_PROVENANCE } from '../../src/site-verifier';
import { runOperatorVerifier, OPERATOR_EXPECTED_LOGS, operatorMultiplierList, OPERATOR_MULTIPLIER_LIST_SHA256, type OperatorRound } from '../../src/operator-verifier';
import * as crypto from 'crypto';

/** The profile's ceiling on per-outcome draw bias (GROOMERS-08, rule R1): one part in 2^32. */
const BIAS_CEILING = Math.pow(2, -32);
/** Relative bound for the site verifier's stake multiple against the served total_multiplier. */
const SITE_REL_TOL = 1e-12;
/** How many disagreements a leg names in its detail (a display cap, not a population). */
const MAX_LISTED = 3;
import type { GVBet } from '../../src/types';
import { EXPECTED_NON_BUY_BETS, EXPECTED_MODE_BETS, EXPECTED_VERIFY_PAYLOAD_BETS, EXPECTED_FREE_SPIN_BETS, CAPTURE_NONCE_CORRECTIONS, servedNonce } from '../../src/loader';

/**
 * Build the per-condition (base_game / bonus_game) symbol-code list and
 * weights array, in symbol-index order, from the operator config.
 */
function buildSymbolTables(ctx: VerifyContext): {
  base:  { codes: string[]; weights: number[][] };
  bonus: { codes: string[]; weights: number[][] };
} {
  const out: any = {};
  for (const cond of ['base_game', 'bonus_game'] as const) {
    const symbols = ctx.config.weights.symbols_by_condition[cond];
    const sorted  = [...symbols].sort((a, b) => a.symbol_index - b.symbol_index);
    const codes   = sorted.map(s => s.code);
    // weightsPerReel[reelIndex][symbolIndex] = weight
    const weightsPerReel: number[][] = [];
    for (let reel = 0; reel < REELS; reel++) {
      weightsPerReel.push(sorted.map(s => s.weights_per_reel[reel]));
    }
    out[cond === 'base_game' ? 'base' : 'bonus'] = { codes, weights: weightsPerReel };
  }
  return out;
}

/** Pull the round-0 30 cells from a captured bet response, in column-major order, as symbol codes. */
function capturedRound0Grid(bet: GVBet): string[][] {
  const view = bet.response.rounds[0]?.data?.view;
  if (!view || view.length !== REELS) return [];
  return view.map(reelCol => reelCol.map(c => c.symbol));
}

export function run(ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];
  const { base, bonus } = buildSymbolTables(ctx);

  // ── Step 5: Outcome Recomputation ──────────────────────────────────────
  {
    let checked = 0, ok = 0, okOffByOne = 0, mismatched = 0, skippedNoSeed = 0, skippedPfSkipped = 0, skippedBuy = 0;
    const fails: string[] = [];
    /** Base spins (mode 'spin') → the nonce whose grid matched, for the site-verifier leg below. */
    const matchedSpins: Array<{ b: GVBet; serverSeed: string; clientSeed: string; nonce: number }> = [];

    /**
     * EXACT NONCE (2026-09-26). This used to try (nonce, nonce+1, nonce-1) and accept whichever
     * reproduced the grid, so for any bet the RECORDED nonce did not have to be the one used. Four
     * bets need it; each is bound by spin id in src/loader.ts CAPTURE_NONCE_CORRECTIONS with the
     * reason (the capture's pre-bet snapshot recorded a nonce a retried request had consumed). Every
     * other base spin must reproduce at its recorded nonce, and each corrected bet must reproduce at its
     * declared served nonce AND NOT at its recorded one.
     *
     * PAYLOAD NONCES (2026-10-04). Where a verify payload exists its nonce is the one used, and until
     * today it was taken as given: the correction lookup was skipped and the recorded nonce never
     * compared, which is how spin 1974625 (recorded 2, payload 3) stayed out of the corrections. Now:
     * a base spin's payload nonce must equal its served nonce, and a free spin's payload must carry
     * the trigger's served nonce and the round_index the session rule gives (MANIFEST "Verify a bet",
     * step 2: current_spin in a triggered bonus, current_spin − 1 in a bought one).
     */
    const reproducesAt = (
      serverSeed: string, clientSeed: string, n: number,
      roundIndex: number, weightsPerReel: number[][], symbolCodes: string[],
      capturedGrid: string[][],
    ): boolean => {
      if (n < 0) return false;
      const oi   = computeOutcomeIndex(serverSeed, clientSeed, n);
      const seed = deriveTumbleSeed(oi, roundIndex, 0);
      const idxGrid = generateGrid(new Pcg32(seed), weightsPerReel);
      for (let c = 0; c < REELS; c++) {
        for (let r = 0; r < ROWS; r++) {
          if (symbolCodes[idxGrid[c][r]] !== capturedGrid[c][r]) return false;
        }
      }
      return true;
    };
    let correctionsProven = 0;
    /** Every recomputed entry, for Duel's own Verify-tab code (fourth leg below). */
    const opJobs: Array<{ round: OperatorRound; captured: string[][]; codes: string[]; b: GVBet }> = [];
    /** Free spins matched at their verify record's (nonce, round_index). */
    let okFree = 0;
    /** Payload-input checks: base spins (payload nonce = served nonce) and free spins (session rule). */
    let basePayloadChecked = 0, basePayloadOk = 0, freeRuleChecked = 0, freeRuleOk = 0;
    const byId = new Map<number, GVBet>(ctx.bets.map(x => [x.spinId, x]));

    for (const b of ctx.bets) {
      // Buys are operator-canned to guarantee 4 scatters → they are NOT
      // generated by the published PCG32 algorithm. The /verify endpoint
      // omits them (returns only the 10 free spins for the resulting
      // session). Disclosed as R-BUY-FIRSTSPIN in MANIFEST.md#limitations-and-trust.
      if (b.mode === 'buy') { skippedBuy++; continue; }

      const seedHashed = b.activeAtSpin.server_seed_hashed;
      const seedPlain  = ctx.seedMap.get(seedHashed);
      if (!seedPlain) { skippedNoSeed++; continue; }

      // Determine condition + free-spin parameters
      const isBonus = b.response.spin_type === 'bonus_game' || b.mode === 'free_spin';
      const tables  = isBonus ? bonus : base;
      const vd      = b.verifyData;

      // Skip the cosmetic first spin of a bought bonus — pf_skipped: true
      // means the casino does NOT generate this spin from the seed chain
      // (per their own /verify response). This is the documented
      // unverifiable corner.
      if (vd?.pf_skipped) { skippedPfSkipped++; continue; }

      // For free spins inside a feature, nonce / round_index come from
      // the verify payload, NOT from activeAtSpin.nonce: on a free spin that
      // field is the trigger's served nonce + 1 (the seed panel has already
      // moved on), while the free spins are drawn at the trigger's nonce.
      // The correction is looked up whether or not a payload exists.
      const correction  = CAPTURE_NONCE_CORRECTIONS.find(c => c.spinId === b.spinId);
      const nonce       = vd?.nonce ?? servedNonce(b) ?? 0;
      const roundIndex  = vd?.round_index ?? 0;
      const tumbleIndex = 0;   // round 0 of the spin
      const clientSeed  = vd?.client_seed || b.activeAtSpin.client_seed;
      const serverSeed  = vd?.server_seed || seedPlain;
      if (!clientSeed || !serverSeed) { skippedNoSeed++; continue; }

      // Reproduce the round-0 grid at exactly one nonce (see reproducesAt above).
      const captured = capturedRound0Grid(b);
      if (captured.length !== REELS) { skippedNoSeed++; continue; }

      checked++;
      // A base spin's payload nonce must be its served nonce (recorded, or the declared correction).
      if (vd && b.mode === 'spin') {
        basePayloadChecked++;
        if (vd.nonce === servedNonce(b)) basePayloadOk++;
        else {
          mismatched++;
          if (fails.length < 3) fails.push(`bet ${b.spinId}: verify payload nonce ${vd.nonce} != served nonce ${servedNonce(b)} (recorded ${b.nonce})`);
        }
      }
      // A free spin's payload must follow the published path (MANIFEST "Verify a bet", step 2): the
      // nonce of the spin that started the bonus, and round_index = current_spin in a triggered bonus
      // (the trigger spin is round 0), current_spin − 1 in a bought one.
      if (b.mode === 'free_spin') {
        freeRuleChecked++;
        const trig = b.triggerSpinId != null ? byId.get(b.triggerSpinId) : undefined;
        const cur = b.response.feature_status?.current_spin;
        const expNonce = trig ? servedNonce(trig) : null;
        const expRound = typeof cur === 'number' ? (trig?.mode === 'buy' ? cur - 1 : cur) : null;
        if (trig && vd && vd.nonce === expNonce && vd.round_index === expRound) freeRuleOk++;
        else {
          mismatched++;
          if (fails.length < 3) fails.push(`free spin ${b.spinId}: payload nonce/round ${vd?.nonce}/${vd?.round_index} != free-spin rule ${expNonce}/${expRound}`);
        }
      }
      opJobs.push({ round: { id: String(opJobs.length), serverSeed, clientSeed, nonce, roundIndex, tumbleIndex: 0,
        condition: isBonus ? 'bonus_game' : 'base_game' }, captured, codes: tables.codes, b });
      const reproduced = reproducesAt(serverSeed, clientSeed, nonce, roundIndex, tables.weights, tables.codes, captured);
      if (reproduced && correction) {
        // The correction must be necessary: the recorded nonce must NOT reproduce this grid.
        if (reproducesAt(serverSeed, clientSeed, correction.recorded, roundIndex, tables.weights, tables.codes, captured)) {
          mismatched++;
          if (fails.length < 3) fails.push(`bet ${b.spinId}: declared nonce correction ${correction.recorded}→${correction.served} is not needed — the recorded nonce reproduces`);
        } else { okOffByOne++; correctionsProven++; }
      } else if (reproduced) {
        if (b.mode === 'free_spin') okFree++; else ok++;
      }
      if (reproduced) {
        if (b.mode === 'spin') matchedSpins.push({ b, serverSeed, clientSeed, nonce });
        if (vd) {
          const expectedOi = computeOutcomeIndex(serverSeed, clientSeed, nonce);
          if (expectedOi !== vd.outcome_index) {
            mismatched++;
            if (fails.length < 3) fails.push(`bet ${b.spinId}: grid matched at nonce ${nonce} but vd.outcome_index ${vd.outcome_index} ≠ computed ${expectedOi}`);
          }
        }
      } else {
        mismatched++;
        if (fails.length < 3) fails.push(`bet ${b.spinId}: the captured grid does not reproduce at nonce ${nonce}${correction ? ` (declared correction of recorded ${correction.recorded})` : ''}`);
      }
    }

    // BOUND TO THE POPULATION. `checked === 0` used to be a FLAG, and a bet skipped for a missing
    // seed, grid or view was counted but never scored — so emptying rounds[] or dropping the
    // seed map left "0/0 … 0 unverifiable" standing. Every non-buy entry must be recomputed, and
    // the only permitted skip is the 20 bonus buys src/loader.ts declares.
    const popIssues: string[] = [];
    if (checked !== EXPECTED_NON_BUY_BETS) popIssues.push(`bets recomputed ${checked} != ${EXPECTED_NON_BUY_BETS} non-buy entries`);
    if (skippedBuy !== EXPECTED_MODE_BETS.buy) popIssues.push(`buys skipped ${skippedBuy} != ${EXPECTED_MODE_BETS.buy}`);
    if (skippedNoSeed > 0) popIssues.push(`${skippedNoSeed} entries skipped with no seed or no round-0 grid`);
    if (correctionsProven !== CAPTURE_NONCE_CORRECTIONS.length) popIssues.push(`nonce corrections proven ${correctionsProven} != ${CAPTURE_NONCE_CORRECTIONS.length} declared in src/loader.ts`);
    if (skippedPfSkipped > 0) popIssues.push(`${skippedPfSkipped} entries skipped as pf_skipped (none expected: the cosmetic buy spin is the buy entry itself)`);
    // The payload-input checks are bound to the population: every free spin, and base spins + free
    // spins together = every entry with a published outcome_index (148 + 475 = 623, measured 2026-10-04).
    if (freeRuleChecked !== EXPECTED_FREE_SPIN_BETS) popIssues.push(`free-spin rule checked on ${freeRuleChecked} != ${EXPECTED_FREE_SPIN_BETS} free spins`);
    if (basePayloadChecked + freeRuleChecked !== EXPECTED_VERIFY_PAYLOAD_BETS) popIssues.push(`payload inputs checked on ${basePayloadChecked + freeRuleChecked} != ${EXPECTED_VERIFY_PAYLOAD_BETS} entries with a verify payload`);
    // ── Second leg: draw bias bound (GROOMERS-08, rule R1 — added 2026-09-26) ─────────────
    // Measured (src/bias.ts) from src/rng.ts acceptedDraw — the rule pickWeighted and generateMultipliers call —
    // for every weight total the grid and bonus-multiplier draws use (6 base + 6 bonus reels, and
    // the multiplier-value weights). HARD FAIL unless every accepted window is a whole number of
    // totals (exact) and the worst per-residue bias is inside 2^-32.
    const totals = [
      ...base.weights.map(w => w.reduce((a, x) => a + x, 0)),
      ...bonus.weights.map(w => w.reduce((a, x) => a + x, 0)),
      ctx.paytable.multiplierWeightsList.reduce((a: number, x: number) => a + x, 0),
    ];
    const bb = drawBiasBound(totals);
    if (bb.inexact.length > 0) popIssues.push(`draw acceptance window not a whole number of totals for ${bb.inexact.join(', ')}`);
    if (!(bb.worstBias <= BIAS_CEILING)) popIssues.push(`worst per-residue draw bias ${bb.worstBias.toExponential(3)} exceeds 2^-32`);

    // ── Third leg: player-verifier parity (GROOMERS-24 — added 2026-09-26) ─────────────────
    // The ProvablyFair.org docs-site Groomer's Van verifier (derive.js + paytables.js + the HMAC
    // library) is vendored and pinned in src/site-verifier.ts. Its own deriveGroomersVan is EXECUTED
    // on every captured base spin (bound to EXPECTED_MODE_BETS.spin) at the nonce whose grid matched
    // above, and must return the outcome_index src/rng.ts computes, the served feature_triggered flag,
    // and a base-spin stake multiple (trigger.payout, cascades included) equal to the served
    // total_multiplier within SITE_REL_TOL relative. Free-spin sessions and the 20 bonus buys are NOT
    // compared by this leg (the site's session simulator is not run against the served sessions).
    const sv = loadSiteVerifier();
    let siteCompared = 0, siteOi = 0, siteTrig = 0, sitePay = 0;
    let siteWorst = 0;
    const siteFails: string[] = [];
    if (sv.error) popIssues.push(sv.error);
    for (const f of sv.files) if (!f.match) popIssues.push(`${f.file}: vendored ${f.actual ?? '(absent)'} != pinned ${f.pinned}`);
    if (sv.deriveGroomersVan) {
      for (const m of matchedSpins) {
        const site = sv.deriveGroomersVan({ clientSeed: m.clientSeed, serverSeed: m.serverSeed, nonce: m.nonce });
        siteCompared++;
        const oiOk = site.outcomeIndex === computeOutcomeIndex(m.serverSeed, m.clientSeed, m.nonce);
        const trigOk = site.triggered === !!m.b.response.feature_triggered;
        const served = Number(m.b.response.total_multiplier);
        const got = site.trigger ? site.trigger.payout : NaN;
        const dev = Math.abs(got - served) / Math.max(Math.abs(served), 1);
        const payOk = Number.isFinite(served) && Number.isFinite(got) && dev <= SITE_REL_TOL;
        if (Number.isFinite(dev)) siteWorst = Math.max(siteWorst, dev);
        if (oiOk) siteOi++;
        if (trigOk) siteTrig++;
        if (payOk) sitePay++;
        if ((!oiOk || !trigOk || !payOk) && siteFails.length < MAX_LISTED) {
          siteFails.push(`bet ${m.b.spinId}: site oi ${site.outcomeIndex} trig ${site.triggered} x${got} vs served trig ${!!m.b.response.feature_triggered} x${served}`);
        }
      }
    }
    if (siteCompared !== EXPECTED_MODE_BETS.spin) popIssues.push(`site verifier compared ${siteCompared} base spins, ${EXPECTED_MODE_BETS.spin} required`);
    if (siteOi !== siteCompared || siteTrig !== siteCompared || sitePay !== siteCompared) {
      popIssues.push(`site verifier disagrees: outcome_index ${siteOi}/${siteCompared}, trigger ${siteTrig}/${siteCompared}, stake multiple ${sitePay}/${siteCompared} (${siteFails.join(' | ')})`);
    }

    // ── Fourth leg: DUEL'S OWN Verify-tab code (GROOMERS-09 — added 2026-09-26) ─────────────
    // A SECOND CHECK, NOT THE SOURCE (20 Oct 2026): src/rng.ts is rebuilt from docs/ALGORITHM.md by an
    // implementer who never opened Duel's code; Duel's code is run next to it here.
    // evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json (pulled from
    // duel.com/fairness/verify on 2026-05-19, pinned in src/operator-verifier.ts) is EXECUTED unmodified
    // on every entry recomputed above, at the same nonce and round index, with the operator config's
    // reel distributions. Scored: its outcome index must equal src/rng.ts and its 30-cell initial grid must
    // equal the served one. MULTIPLIER VALUES
    // SCORED SINCE 2026-10-05: the code picks a value as multiplierValues[rnd % multiplierValues.length]
    // and, as pulled, leaves the list empty (`const multiplierValues = null;`), so it comes from outside the
    // code (seen supplied by Duel's Verify page on 2026-10-05; that check was not captured into this package). It is given the published
    // weights as a list in which each value appears as many times as its weight, in the config's order —
    // 200 entries, built from the pinned config and pinned by SHA-256 (src/operator-verifier.ts) — so its
    // uniform pick is the weighted draw; every initial-grid multiplier value it returns must equal the
    // served one. Until 2026-10-05 it was given the 14 distinct values, recorded 32 / 335 and disclosed as an
    // operator exception; that came from the harness input, not from Duel's code. The list the live page
    // injects is not compared here (the package holds no copy of it).
    const opMultiplierList = operatorMultiplierList(ctx.paytable.multiplierValuesList, ctx.paytable.multiplierWeightsList);
    const opMultiplierListSha = crypto.createHash('sha256').update(JSON.stringify(opMultiplierList)).digest('hex');
    if (opMultiplierListSha !== OPERATOR_MULTIPLIER_LIST_SHA256) popIssues.push(`operator multiplier list (${opMultiplierList.length} entries) hashes ${opMultiplierListSha}, pinned ${OPERATOR_MULTIPLIER_LIST_SHA256}`);
    const op = runOperatorVerifier(opJobs.map(j => j.round), {
      reelConfigs: {
        base_game: (ctx.config as any).weights.symbol_distributions_by_condition.base_game,
        bonus_game: (ctx.config as any).weights.symbol_distributions_by_condition.bonus_game,
      },
      multiplierSymbolIndex: ctx.paytable.multiplierSymbolIndex,
      multiplierValues: opMultiplierList,
    });
    let opRun = 0, opOi = 0, opGrid = 0, opMultChecked = 0, opMultAgree = 0;
    const opFails: string[] = [];
    if (op.error || !op.results) popIssues.push(`operator Verify-tab code not run: ${op.error}`);
    else {
      if (JSON.stringify(op.logs) !== JSON.stringify(OPERATOR_EXPECTED_LOGS)) popIssues.push(`operator code printed ${JSON.stringify(op.logs)}`);
      for (const j of opJobs) {
        const r = op.results.get(j.round.id);
        if (!r) continue;
        opRun++;
        if (r.outcomeIndex === computeOutcomeIndex(j.round.serverSeed, j.round.clientSeed, j.round.nonce)) opOi++;
        let same = true;
        for (let c = 0; c < REELS && same; c++) for (let rr = 0; rr < ROWS && same; rr++) if (j.codes[r.grid[c][rr]] !== j.captured[c][rr]) same = false;
        if (same) opGrid++;
        else if (opFails.length < MAX_LISTED) opFails.push(`bet ${j.b.spinId}: operator grid differs from the served one`);
        if (j.round.condition === 'bonus_game') {
          const view = j.b.response.rounds[0]?.data?.view;
          for (const m of r.multipliers) {
            const cell = view?.[Math.floor(m.position / ROWS)]?.[m.position % ROWS];
            if (cell && cell.multiplier_value !== null && cell.multiplier_value !== undefined) {
              opMultChecked++;
              if (Number(cell.multiplier_value) === m.value) opMultAgree++;
            }
          }
        }
      }
      if (opRun !== EXPECTED_NON_BUY_BETS) popIssues.push(`operator code ran on ${opRun} != ${EXPECTED_NON_BUY_BETS}`);
      if (opOi !== opRun) popIssues.push(`operator outcome index differs from src/rng.ts on ${opRun - opOi} entr(ies)`);
      if (opGrid !== opRun) popIssues.push(`operator grid differs from the served grid on ${opRun - opGrid} entr(ies): ${opFails.join(' | ')}`);
      if (opMultChecked === 0) popIssues.push('operator code returned no initial-grid bonus multiplier value to compare');
      if (opMultAgree !== opMultChecked) popIssues.push(`operator multiplier values differ from the served ones on ${opMultChecked - opMultAgree} of ${opMultChecked}`);
    }
    for (const f of op.files) if (!f.match) popIssues.push(`${f.file}: ${f.actual ?? '(absent)'} != pinned ${f.pinned}`);

    // ── Fifth leg: initial-grid bonus multiplier values (added 2026-09-26) ────────────────────
    // Step 28 replays the multiplier values of cascade FILLS; the values on each bonus spin's INITIAL
    // grid were checked only for membership of the published set (Step 27). They are now recomputed —
    // drawn after the grid from the same PCG32 stream with the config's multiplier weights — and every
    // served value must equal its recomputation.
    let initMultChecked = 0, initMultAgree = 0;
    for (const j of opJobs) {
      if (j.round.condition !== 'bonus_game') continue;
      const oi = computeOutcomeIndex(j.round.serverSeed, j.round.clientSeed, j.round.nonce);
      const prng = new Pcg32(deriveTumbleSeed(oi, j.round.roundIndex, 0));
      const grid = generateGrid(prng, bonus.weights);
      const mults = generateMultipliers(grid, prng, ctx.paytable.multiplierSymbolIndex, ctx.paytable.multiplierValuesList, ctx.paytable.multiplierWeightsList);
      const view = j.b.response.rounds[0]?.data?.view;
      for (const m of mults) {
        const cell = view?.[Math.floor(m.position / ROWS)]?.[m.position % ROWS];
        if (!cell || cell.multiplier_value === null || cell.multiplier_value === undefined) continue;
        initMultChecked++;
        if (Number(cell.multiplier_value) === m.value) initMultAgree++;
      }
    }
    if (initMultChecked === 0) popIssues.push('no initial-grid bonus multiplier value was checked');
    if (initMultAgree !== initMultChecked) popIssues.push(`initial-grid bonus multiplier values: ${initMultChecked - initMultAgree} of ${initMultChecked} differ from the weighted recomputation`);
    if (op.results && opMultChecked !== initMultChecked) popIssues.push(`operator code compared ${opMultChecked} initial-grid multiplier values, src/rng.ts ${initMultChecked}`);

    const ok5 = mismatched === 0 && popIssues.length === 0;
    results.push(step(5, 'Outcome Recomputation',
      ok5 ? 'PASS' : 'FAIL',
      `${ok + okOffByOne + okFree}/${checked} bets reproduce 30/30 cells from (server_seed, client_seed, nonce, round_index) (src/loader.ts: ${EXPECTED_NON_BUY_BETS} non-buy entries). ` +
      `${ok} base spins matched at their recorded nonce; ${okOffByOne} at the served nonce declared by spin id in src/loader.ts CAPTURE_NONCE_CORRECTIONS (recorded + 1: a retried request consumed the recorded nonce; each proven to reproduce at the served nonce and not at the recorded one); ${okFree} free spins at their verify record's nonce and round_index. ` +
      `Payload inputs: ${basePayloadOk}/${basePayloadChecked} base-spin verify payloads carry the served nonce; ${freeRuleOk}/${freeRuleChecked} free spins carry the trigger's served nonce and round_index = current_spin (triggered bonus) or current_spin − 1 (bought bonus). ` +
      `${mismatched} unverifiable. Skipped: ${skippedNoSeed} (seed not revealed / no grid), ${skippedPfSkipped} (pf_skipped=true, operator-disclosed cosmetic), ${skippedBuy} (buy spins — server-canned to guarantee scatters, not in published RNG).` +
      ` Draw bias (GROOMERS-08), measured from src/rng.ts acceptedDraw on all ${bb.rows.length} distinct weight totals the draws use: ${bb.inexact.length === 0 ? 'every accepted window is a whole number of totals' : `${bb.inexact.length} window(s) NOT a whole number of totals`}, worst bias ${bb.worstBias} (ceiling 2^-32).` +
      ` Duel's own Verify-tab code (GROOMERS-09, pinned, pulled from duel.com/fairness/verify 2026-05-19), run as a second check (src/rng.ts is rebuilt from docs/ALGORITHM.md by an implementer who never opened this code), executed unmodified on ${opRun}/${EXPECTED_NON_BUY_BETS} entries: outcome index ${opOi} and 30-cell initial grid ${opGrid} agree; given the published multiplier weights as a ${opMultiplierList.length}-entry list (each value repeated by its weight, config order, pinned), its multiplier step gives ${opMultAgree}/${opMultChecked} served initial-grid multiplier values. Initial-grid bonus multiplier values recomputed by src/rng.ts with the config's weights: ${initMultAgree}/${initMultChecked} equal the served ones.` +
      ` Player-verifier parity (GROOMERS-24): the ProvablyFair.org docs-site derive.js + paytables.js (pinned, ${SITE_VERIFIER_PROVENANCE.ref} @ ${SITE_VERIFIER_PROVENANCE.head.slice(0, 7)}) executed on ${siteCompared}/${EXPECTED_MODE_BETS.spin} base spins at the matched nonce: outcome_index ${siteOi}, trigger flag ${siteTrig}, base-spin stake multiple ${sitePay} agree (relative bound ${SITE_REL_TOL.toExponential(0)}; free-spin sessions and buys not compared).` +
      (popIssues.length ? ` POPULATION: ${popIssues.join('; ')}.` : '') +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : ''),
      { checked, matchedBaseAtRecordedNonce: ok, matchedAtDeclaredCorrection: okOffByOne, matchedFreeSpinsAtPayload: okFree, mismatched,
        payloadInputs: { basePayloadChecked, basePayloadOk, freeRuleChecked, freeRuleOk },
        skippedNoSeed, skippedPfSkipped, skippedBuy, populationIssues: popIssues,
        drawBias: { ceiling: BIAS_CEILING, ...bb },
        operatorVerifier: { files: op.files, ran: opRun, outcomeIndexAgree: opOi, gridAgree: opGrid, multiplierList: { entries: opMultiplierList.length, sha256: opMultiplierListSha, pinned: OPERATOR_MULTIPLIER_LIST_SHA256 }, multipliersChecked: opMultChecked, multipliersAgree: opMultAgree, logs: op.logs },
        initialGridMultipliers: { checked: initMultChecked, agree: initMultAgree },
        siteVerifier: { provenance: SITE_VERIFIER_PROVENANCE, files: sv.files, compared: siteCompared, outcomeIndexAgree: siteOi,
          triggerAgree: siteTrig, stakeMultipleAgree: sitePay, relTol: SITE_REL_TOL, worstRelativeDeviation: siteWorst } },
    ));
  }

  // ── Step 6: Client Seed Influence ──────────────────────────────────────
  // The property is pass/fail by nature: if the client seed is a real HMAC input, changing it
  // changes the outcome_index. The step used to sample 100 bets and PASS at ≥ 95/100, which
  // would have accepted five bets on which the client seed had no effect; it also built its
  // result by hand instead of through step(). It now tampers the client seed on EVERY eligible
  // bet and requires every one to move. A false alarm needs a 32-bit collision: outcome_index
  // is the first 4 bytes of an HMAC-SHA256, so the chance any of the 623 bets collides by
  // accident is about 623 / 2^32 ≈ 1.5e-7 — the requirement is exact, not a sample.
  {
    const eligible = ctx.bets.filter(b =>
      ctx.seedMap.has(b.activeAtSpin.server_seed_hashed) &&
      b.verifyData?.server_seed &&
      b.verifyData?.client_seed
    );
    let differ = 0;
    const same: string[] = [];
    for (const b of eligible) {
      const vd = b.verifyData!;
      const tampered = computeOutcomeIndex(vd.server_seed, `${vd.client_seed}_PF_TAMPERED`, vd.nonce);
      if (tampered !== vd.outcome_index) differ++;
      else if (same.length < 3) same.push(`bet ${b.spinId}`);
    }
    // Eligible = every entry whose operator /verify payload publishes a seed pair and an
    // outcome_index to tamper against. The count is declared in src/loader.ts; the other 5,582
    // non-buy entries have no published outcome_index, and their grids are recomputed in Step 5.
    const popIssues: string[] = [];
    if (eligible.length !== EXPECTED_VERIFY_PAYLOAD_BETS) popIssues.push(`eligible bets ${eligible.length} != ${EXPECTED_VERIFY_PAYLOAD_BETS}`);
    const ok6 = differ === eligible.length && popIssues.length === 0;
    results.push(step(6, 'Client Seed Influence',
      ok6 ? 'PASS' : 'FAIL',
      `${differ}/${eligible.length} bets produce a different outcome_index when the client seed is tampered (src/loader.ts: ${EXPECTED_VERIFY_PAYLOAD_BETS} eligible — every entry with a published outcome_index). ` +
      `PASS criterion: every eligible bet — the client seed must be an input on all of them.` +
      (popIssues.length ? ` POPULATION: ${popIssues.join('; ')}.` : '') +
      (same.length ? ` Unchanged: ${same.join(', ')}` : ''),
      { eligible: eligible.length, differ, unchanged: eligible.length - differ, populationIssues: popIssues },
    ));
  }

  return results;
}
