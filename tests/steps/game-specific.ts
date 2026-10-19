/**
 * Steps 19–27: Groomer's Van game-specific verification.
 *
 *   19. Cluster Pays Anywhere       — every captured payline's count is
 *                                     consistent with (cells of symbol
 *                                     S) + (cells of wild). Anywhere
 *                                     model verified against captured
 *                                     paylines.
 *   20. Tumble Determinism          — each tumble round in the captured
 *                                     view reproduces from
 *                                     deriveTumbleSeed(outcome_index,
 *                                     round_index, tumble_index).
 *   21. Wild Substitution Rule      — on every round where ≥ 2 symbols pay
 *                                     and a wild is on the grid, every
 *                                     cluster's count includes every wild.
 *   22. Bonus Trigger               — every captured feature_triggered=true
 *                                     bet has ≥ 3 scatters on its initial
 *                                     deal; free-spin award matches the
 *                                     published spins_per_scatters table.
 *   23. Retrigger Behaviour         — within bonus sessions, free spins
 *                                     that land ≥ 3 scatters trigger the
 *                                     retrigger award (capped at 3 per
 *                                     session). Verified empirically.
 *   24. pf_skipped Flag Accuracy    — every captured free spin marked
 *                                     pf_skipped=true is the FIRST free
 *                                     spin of a buy session and produces
 *                                     no clusters/wins (cosmetic only).
 *   25. Buy-Bonus Structure         — every captured buy displays exactly
 *                                     4 scatters → triggers exactly 10
 *                                     free spins (per buy_scatter_count=4
 *                                     and spins_per_scatters[4]=10).
 *   26. Free-Spin Payout Recon      — each free spin's amount_won (USD) matches
 *                                     sum(payline base × bomb_multiplier).
 *                                     (Step 7 covers this for non-buy bets;
 *                                     this re-verifies for the bonus
 *                                     condition specifically.)
 *   27. Bonus Multiplier Symbol     — multiplier symbols only appear in
 *                                     bonus_game spins (never in base
 *                                     game) and their values come from
 *                                     the published distribution.
 */

import { step, type VerifyContext, type StepResult } from './context';
import { computeOutcomeIndex, deriveTumbleSeed, Pcg32, generateGrid, generateMultipliers, REELS, ROWS } from '../../src/rng';
import { findClusters, BONUS_CODE, WILD_CODE, MULTIPLIER_CODE } from '../../src/cluster';
import { freeSpinsAwarded } from '../../src/paytable';
import { centsOf } from './payouts';
import {
  EXPECTED_CLUSTER_PAYLINES, EXPECTED_CASCADE_ROUNDS, EXPECTED_SHARED_WILD_ROUNDS, EXPECTED_BONUS_SESSIONS,
  EXPECTED_FREE_SPIN_BETS, EXPECTED_MODE_BETS, EXPECTED_BONUS_MULTIPLIER_CELLS, servedNonce,
} from '../../src/loader';

export function run(ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];

  // ── Step 19: Cluster Pays Anywhere ─────────────────────────────────────
  // For every captured payline (cluster type), confirm the published
  // count equals (cells of that symbol) + (cells of wild) on the round's
  // grid. Catches any drift from the "anywhere with wild substitution"
  // rule.
  {
    let checked = 0, ok = 0, bad = 0;
    const fails: string[] = [];
    for (const b of ctx.bets) {
      if (b.mode === 'buy') continue;     // buys are server-canned (R-BUY)
      for (const round of b.response.rounds) {
        if (round.type !== 'regular' && round.type !== 'bonus_game' && round.type !== 'tumble') continue;
        for (const pl of round.data.paylines) {
          if (pl.win_type !== 'cluster') continue;
          checked++;
          let symCount = 0, wildCount = 0;
          for (let c = 0; c < REELS; c++) {
            for (let r = 0; r < ROWS; r++) {
              const cell = round.data.view[c][r];
              if (cell.symbol === pl.symbol) symCount++;
              else if (cell.symbol === WILD_CODE) wildCount++;
            }
          }
          // The captured "count" should equal symCount + wildCount.
          // (Note: tumble rounds preserve `removed_on_round` markers
          // for cells that participated in PRIOR cluster wins; those
          // ARE present in the view at the tumble step.)
          if (pl.count === symCount + wildCount) ok++;
          else {
            bad++;
            if (fails.length < 3) fails.push(`bet ${b.spinId} ${pl.identifier}: API count=${pl.count} but ${symCount} ${pl.symbol} + ${wildCount} wild = ${symCount + wildCount}`);
          }
        }
      }
    }
    // BOUND TO THE POPULATION: with every paylines[] emptied this reported 0/0 and PASSED.
    const pop19 = checked === EXPECTED_CLUSTER_PAYLINES ? '' : `cluster paylines checked ${checked} != ${EXPECTED_CLUSTER_PAYLINES}`;
    results.push(step(19, 'Cluster Pays Anywhere',
      bad === 0 && !pop19 ? 'PASS' : 'FAIL',
      `${ok}/${checked} cluster paylines have count = (cells of symbol) + (cells of wild) (src/loader.ts: ${EXPECTED_CLUSTER_PAYLINES}). ` +
      `Confirms the "anywhere with wild substitution" rule.` +
      (pop19 ? ` POPULATION: ${pop19}.` : '') +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : ''),
      { checked, matched: ok, mismatched: bad, populationIssue: pop19 || null },
    ));
  }

  // ── Step 20: Tumble Cascade Structural Integrity ──────────────────────
  // For every captured spin with > 1 round, verify the cascade follows
  // the documented gravity-fill structure:
  //   1. Cells marked `removed_on_round=N` in round N-1 are NOT present
  //      at the same position in round N.
  //   2. Cells NOT marked removed in round N-1 are still present in
  //      round N at the BOTTOM of their column (gravity pulls them down).
  //   3. The number of "new" cells at the top of each column equals the
  //      number of removed cells in that column.
  //
  // This is a structural check — the per-cell RNG verification of the
  // new cells (i.e., deriveTumbleSeed → exact symbols at the top of
  // each post-removal column) is performed in Step 28 (Cascade RNG
  // Byte-Exact Replay), which closes the previously-deferred
  // R-CASCADE-RNG concern: 4,323/4,323 cascades, 129,690/129,690 cells
  // and 146/146 captured multiplier values reproduce byte-exact.
  {
    let totalCascades = 0, structurallyOk = 0, mismatched = 0;
    const fails: string[] = [];
    for (const b of ctx.bets) {
      if (b.mode === 'buy') continue;
      const rounds = b.response.rounds;
      if (rounds.length < 2) continue;
      for (let tIdx = 1; tIdx < rounds.length; tIdx++) {
        const prev = rounds[tIdx - 1].data.view;
        const cur  = rounds[tIdx].data.view;
        totalCascades++;
        if (!prev || !cur || prev.length !== REELS || cur.length !== REELS) {
          // A cascade with no grid on either side used to be skipped without being counted.
          mismatched++;
          if (fails.length < 3) fails.push(`bet ${b.spinId} round ${tIdx}: grid missing or not ${REELS} reels`);
          continue;
        }
        let valid = true;
        for (let col = 0; col < REELS && valid; col++) {
          // Survivors from prev round: cells NOT marked removed_on_round = tIdx
          const survivors: string[] = [];
          for (let row = 0; row < ROWS; row++) {
            if (prev[col][row].removed_on_round !== tIdx) survivors.push(prev[col][row].symbol);
          }
          // Bottom-N of cur should equal survivors (gravity pulls survivors down).
          const N = survivors.length;
          for (let i = 0; i < N; i++) {
            if (cur[col][ROWS - N + i].symbol !== survivors[i]) { valid = false; break; }
          }
        }
        if (valid) structurallyOk++;
        else {
          mismatched++;
          if (fails.length < 3) fails.push(`bet ${b.spinId} round ${tIdx}: gravity-survivor mismatch`);
        }
      }
    }
    const pop20 = totalCascades === EXPECTED_CASCADE_ROUNDS ? '' : `cascade rounds checked ${totalCascades} != ${EXPECTED_CASCADE_ROUNDS}`;
    results.push(step(20, 'Tumble Cascade Structural Integrity',
      mismatched === 0 && !pop20 ? 'PASS' : 'FAIL',
      `${structurallyOk}/${totalCascades} cascade rounds preserve un-removed cells at the bottom of their column (gravity rule) (src/loader.ts: ${EXPECTED_CASCADE_ROUNDS}). ` +
      `${mismatched} gravity violations or missing grids. ` +
      (pop20 ? `POPULATION: ${pop20}. ` : '') +
      `Per-cell RNG verification of NEW drop-fill cells: covered byte-exactly by Step 28 (Cascade RNG Byte-Exact Replay) — R-CASCADE-RNG closed.` +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : ''),
      { checked: totalCascades, structurallyOk, mismatched, populationIssue: pop20 || null },
    ));
  }

  // ── Step 21: Wild Substitution Rule ────────────────────────────────────
  // The help-panel rule is "wilds contribute to every cluster win": on a grid where two or more
  // symbols pay at once, a wild on that grid counts toward EVERY one of those clusters. This step
  // used to count the rounds where at least two clusters used the wilds and PASS if that count
  // was above zero — an existence check, FLAG otherwise, with no FAIL branch: a grid on which
  // one cluster was paid WITHOUT the shared wild was never looked at.
  //
  // Now: on every non-tumble round with ≥ 2 distinct paying cluster symbols and ≥ 1 wild, EVERY
  // cluster payline's count must equal (cells of its symbol) + (all wilds on the grid). One
  // payline that leaves a wild out is a FAIL, and the number of such rounds must equal the
  // population declared in src/loader.ts.
  {
    let rounds = 0, allCredit = 0, violations = 0;
    const examples: string[] = [], fails: string[] = [];
    for (const b of ctx.bets) {
      if (b.mode === 'buy') continue;
      for (const round of b.response.rounds) {
        if (round.type === 'tumble') continue;   // tumble rounds reuse the cluster from prior round
        const clusters = round.data.paylines.filter(pl => pl.win_type === 'cluster');
        const distinctSymbols = new Set(clusters.map(pl => pl.symbol));
        if (distinctSymbols.size < 2) continue;
        let wilds = 0;
        for (let c = 0; c < REELS; c++) for (let r = 0; r < ROWS; r++) if (round.data.view[c][r].symbol === WILD_CODE) wilds++;
        if (wilds === 0) continue;
        rounds++;
        const leftOut: string[] = [];
        for (const pl of clusters) {
          let symCount = 0;
          for (let c = 0; c < REELS; c++) for (let r = 0; r < ROWS; r++) if (round.data.view[c][r].symbol === pl.symbol) symCount++;
          if (symCount + wilds !== pl.count) leftOut.push(`${pl.symbol} count ${pl.count} ≠ ${symCount} + ${wilds} wild`);
        }
        if (leftOut.length === 0) {
          allCredit++;
          if (examples.length < 3) examples.push(`bet ${b.spinId}: ${[...distinctSymbols].join('+')} share ${wilds} wild(s)`);
        } else {
          violations++;
          if (fails.length < 3) fails.push(`bet ${b.spinId}: ${leftOut.join(', ')}`);
        }
      }
    }
    const pop21 = rounds === EXPECTED_SHARED_WILD_ROUNDS ? '' : `shared-wild rounds ${rounds} != ${EXPECTED_SHARED_WILD_ROUNDS}`;
    results.push(step(21, 'Wild Substitution Rule',
      violations === 0 && !pop21 ? 'PASS' : 'FAIL',
      `${allCredit}/${rounds} rounds with ≥ 2 simultaneous paying cluster symbols and ≥ 1 wild credit every wild to EVERY cluster (src/loader.ts: ${EXPECTED_SHARED_WILD_ROUNDS} such rounds). ` +
      `${violations} rounds pay a cluster whose count leaves out a wild on the grid. Rule tested: "wilds contribute to every cluster win".` +
      (pop21 ? ` POPULATION: ${pop21}.` : '') +
      (fails.length ? ` Violations: ${fails.join(' | ')}` : '') +
      (examples.length ? ` Examples: ${examples.join(' | ')}` : ''),
      { rounds, allWildsCreditedToEveryCluster: allCredit, violations, populationIssue: pop21 || null },
    ));
  }

  // ── Step 22: Bonus Trigger ─────────────────────────────────────────────
  // Use the operator-published `feature_status.trigger_data.scatter_count`
  // (which captures scatters from BOTH the initial deal AND any tumbles
  // that landed additional scatters before the cascade settled).
  {
    let triggers = 0, mismatched = 0;
    const fails: string[] = [];
    let gridScatterMismatched = 0;
    for (const b of ctx.bets) {
      if (!b.response.feature_triggered) continue;
      if (b.mode === 'free_spin') continue;
      triggers++;
      const fs = b.response.feature_status;
      const scatters = fs?.trigger_data?.scatter_count ?? 0;
      const expectedSpins = freeSpinsAwarded(ctx.paytable, scatters, false);
      const awardedSpins = fs ? (fs.current_spin || 0) + (fs.remaining_spins || 0) : 0;
      if (scatters >= 3 && awardedSpins === expectedSpins) {
        // ok
      } else {
        mismatched++;
        if (fails.length < 3) fails.push(`bet ${b.spinId}: scatters=${scatters}, expected_spins=${expectedSpins}, awarded=${awardedSpins}`);
      }
      // Cross-check: independently count scatter cells across all cascade
      // rounds of the captured spin and verify they equal the operator-
      // reported trigger_data.scatter_count. This prevents the operator
      // from inflating both fields together (a self-consistent identity).
      // Scatters never participate in clusters, so they persist across
      // cascades; the post-cascade-final grid contains the cumulative count.
      const rounds = b.response.rounds;
      if (rounds && rounds.length > 0) {
        const finalView = rounds[rounds.length - 1].data?.view;
        let gridScatters = 0;
        if (finalView) {
          for (let col = 0; col < REELS; col++) {
            for (let row = 0; row < ROWS; row++) {
              if (finalView[col][row]?.symbol === BONUS_CODE) gridScatters++;
            }
          }
        }
        if (gridScatters !== scatters) {
          gridScatterMismatched++;
          if (fails.length < 3) fails.push(`bet ${b.spinId}: trigger_data.scatter_count=${scatters} but grid has ${gridScatters} scatters`);
        }
      }
    }
    const pop22 = triggers === EXPECTED_BONUS_SESSIONS ? '' : `trigger events ${triggers} != ${EXPECTED_BONUS_SESSIONS}`;
    const status: 'PASS' | 'FAIL' = (mismatched === 0 && gridScatterMismatched === 0 && !pop22) ? 'PASS' : 'FAIL';
    results.push(step(22, 'Bonus Trigger',
      status,
      `${triggers} captured trigger events (src/loader.ts: ${EXPECTED_BONUS_SESSIONS}). ${pop22 ? `POPULATION: ${pop22}. ` : ''}${triggers - mismatched}/${triggers} match the published spins_per_scatters table {3→8, 4→10, 5→12, 6→14}. ` +
      `Independent grid cross-check: ${triggers - gridScatterMismatched}/${triggers} captured triggers have a final-grid scatter count matching the operator-reported trigger_data.scatter_count (catches dual-field inflation).` +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : '')
    ));
  }

  // ── Step 23: Retrigger Behaviour ───────────────────────────────────────
  // Detects retrigger events (a free spin in which the cumulative scatter
  // count across all cascades reaches ≥ minScattersToTrigger) and verifies
  // no session exceeds the operator-published max_retriggers cap. Counts
  // sessions across BOTH buy-bonus and organic triggers.
  {
    let retriggers = 0;
    let sessions = 0;
    const observed: string[] = [];
    const cap = ctx.paytable.maxBonusRetriggers;
    const sessionRetriggers = new Map<number, number>();
    const violations: string[] = [];
    let capViolations = 0;

    // Count every session start (buy or organic trigger).
    for (const b of ctx.bets) {
      if (b.mode === 'buy' || (b.mode === 'spin' && b.response.feature_triggered)) {
        sessions++;
        sessionRetriggers.set(b.spinId, 0);
      }
    }

    // For each free spin, count scatters in the FINAL cascade view (since
    // scatters never participate in clusters, the post-final-cascade view
    // contains the cumulative scatter count across all cascades). A free
    // spin with ≥ minScattersToTrigger scatters is a retrigger event.
    let freeSpinsExamined = 0, unattached = 0, noGrid = 0;
    for (const b of ctx.bets) {
      if (b.mode !== 'free_spin') continue;
      // A free spin with no session to belong to, or no grid to count scatters on, used to be
      // skipped without being counted. Both are now counted and FAIL the step.
      if (!b.triggerSpinId || !sessionRetriggers.has(b.triggerSpinId)) {
        unattached++;
        if (violations.length < 3) violations.push(`free spin ${b.spinId}: triggerSpinId ${b.triggerSpinId} is not a captured session`);
        continue;
      }
      const rounds = b.response.rounds;
      const finalView = rounds && rounds.length > 0 ? rounds[rounds.length - 1].data?.view : undefined;
      if (!finalView) { noGrid++; continue; }
      freeSpinsExamined++;
      let scatters = 0;
      for (let c = 0; c < REELS; c++) {
        for (let r = 0; r < ROWS; r++) {
          if (finalView[c][r]?.symbol === BONUS_CODE) scatters++;
        }
      }
      if (scatters >= ctx.paytable.minScattersToTrigger) {
        retriggers++;
        const sid = b.triggerSpinId;
        const n = (sessionRetriggers.get(sid) ?? 0) + 1;
        sessionRetriggers.set(sid, n);
        if (n > cap) { capViolations++; violations.push(`session ${sid}: ${n} retriggers (cap ${cap})`); }
        if (observed.length < 3) observed.push(`bet ${b.spinId}: ${scatters} scatters in final cascade view (retrigger)`);
      }
    }

    const pop23: string[] = [];
    if (sessions !== EXPECTED_BONUS_SESSIONS) pop23.push(`sessions ${sessions} != ${EXPECTED_BONUS_SESSIONS}`);
    if (freeSpinsExamined !== EXPECTED_FREE_SPIN_BETS) pop23.push(`free spins examined ${freeSpinsExamined} != ${EXPECTED_FREE_SPIN_BETS}`);
    if (unattached > 0) pop23.push(`${unattached} free spins attached to no captured session`);
    if (noGrid > 0) pop23.push(`${noGrid} free spins with no grid`);
    const status: 'PASS' | 'FAIL' = violations.length === 0 && pop23.length === 0 ? 'PASS' : 'FAIL';
    results.push(step(23, 'Retrigger Behaviour',
      status,
      `${sessions} bonus sessions captured; ${freeSpinsExamined} free spins examined (src/loader.ts: ${EXPECTED_BONUS_SESSIONS} sessions, ${EXPECTED_FREE_SPIN_BETS} free spins). ` +
      (pop23.length ? `POPULATION: ${pop23.join('; ')}. ` : '') +
      `${retriggers} retrigger events observed (free spins in which the cumulative scatter count across all cascades reached ≥ ${ctx.paytable.minScattersToTrigger}). ` +
      `Per-session retrigger cap = ${cap} (operator config). ${capViolations} sessions exceeded the cap.` +
      (violations.length ? ` Violations: ${violations.slice(0, 3).join(' | ')}` : '') +
      (observed.length ? ` Examples: ${observed.join(' | ')}` : ''),
      { sessions, freeSpinsExamined, unattachedFreeSpins: unattached, freeSpinsWithoutGrid: noGrid, retriggers, populationIssues: pop23 },
    ));
  }

  // ── Step 24: Cosmetic Buy-Spin Disclosure Accuracy ─────────────────────
  // Every captured `buy` bet must (a) carry the operator's bonus-buy
  // disclosure flag `verifyData._verify_session.is_bonus_buy === true`
  // marking the buy spin as cosmetic / non-PF, AND (b) carry NO cluster
  // paylines (only the deterministic 4-scatter scatter pay is allowed —
  // the cosmetic grid never forms winning clusters).
  //
  // Per operator: the buy spin is "marked non-verifiable" via this flag
  // (the internal-doc names `pf_skipped` / `nonce=-1` map to the public
  // API field `_verify_session.is_bonus_buy=true`).
  {
    let totalBuys = 0, ok = 0, mismatched = 0;
    const fails: string[] = [];
    for (const b of ctx.bets) {
      if (b.mode !== 'buy') continue;
      totalBuys++;
      const isBonusBuy = b.verifyData?._verify_session?.is_bonus_buy === true;
      // The buy spin always carries the guaranteed 4-scatter scatter-pay
      // payline (3× stake). It must have NO cluster paylines — the
      // cosmetic grid is not allowed to form any winning clusters.
      const noClusterPaylines = b.response.rounds.every(r =>
        (r.data.paylines || []).every(pl => pl.win_type !== 'cluster')
      );
      if (isBonusBuy && noClusterPaylines) ok++;
      else {
        mismatched++;
        if (fails.length < 3) fails.push(`bet ${b.spinId} is_bonus_buy=${isBonusBuy}, noClusterPaylines=${noClusterPaylines}`);
      }
    }
    const pop24 = totalBuys === EXPECTED_MODE_BETS.buy ? '' : `buys ${totalBuys} != ${EXPECTED_MODE_BETS.buy}`;
    results.push(step(24, 'Cosmetic Buy-Spin Disclosure',
      mismatched === 0 && !pop24 ? 'PASS' : 'FAIL',
      `${totalBuys} buy bets captured (src/loader.ts: ${EXPECTED_MODE_BETS.buy}). ${pop24 ? `POPULATION: ${pop24}. ` : ''}${ok}/${totalBuys} carry the operator's bonus-buy disclosure (verifyData._verify_session.is_bonus_buy=true) AND have no cluster paylines (only the guaranteed 4-scatter scatter pay; cosmetic grid never forms clusters, per operator disclosure).` +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : '')
    ));
  }

  // ── Step 25: Buy-Bonus Structure ───────────────────────────────────────
  {
    const buys = ctx.bets.filter(b => b.mode === 'buy');
    let exact4Scatters = 0, exact10FreeSpins = 0, mismatch: string[] = [];
    for (const b of buys) {
      let scatters = 0;
      const v = b.response.rounds[0]?.data?.view;
      if (v) for (let c = 0; c < REELS; c++) for (let r = 0; r < ROWS; r++) if (v[c][r].symbol === BONUS_CODE) scatters++;
      if (scatters === 4) exact4Scatters++;
      else if (mismatch.length < 3) mismatch.push(`bet ${b.spinId} scatters=${scatters}`);
      const fs = b.response.feature_status;
      const awarded = fs ? (fs.current_spin || 0) + (fs.remaining_spins || 0) : 0;
      if (awarded === 10) exact10FreeSpins++;
    }
    results.push(step(25, 'Buy-Bonus Structure',
      exact4Scatters === buys.length && exact10FreeSpins === buys.length && buys.length === EXPECTED_MODE_BETS.buy ? 'PASS' : 'FAIL',
      `${buys.length} buys captured (src/loader.ts: ${EXPECTED_MODE_BETS.buy}${buys.length === EXPECTED_MODE_BETS.buy ? '' : ' — POPULATION MISMATCH'}). ${exact4Scatters}/${buys.length} display exactly 4 scatters (per buy_scatter_count=${ctx.config.features[0]?.metadata?.buy_scatter_count ?? 4}). ${exact10FreeSpins}/${buys.length} award exactly 10 free spins (per spins_per_scatters[4]=10).` +
      (mismatch.length ? ` Examples: ${mismatch.join(' | ')}` : '')
    ));
  }

  // ── Step 26: Free-Spin Payout Reconciliation ───────────────────────────
  // Re-verify the bonus condition specifically: every free spin's
  // amount_won = sum of (base × bomb_multiplier) per payline.
  {
    let checked = 0, ok = 0, bad = 0;
    const fails: string[] = [];
    for (const b of ctx.bets) {
      if (b.mode !== 'free_spin') continue;
      checked++;
      // EXACT IN INTEGER CENTS (2026-09-26) — was ±max(1e-6, 0.05 %) on parsed doubles. Every one of
      // the 475 free spins reconciles to the cent on the pinned dataset (measured), so no exception.
      // IN USD SINCE 2026-10-05: the paylines are USD amounts, so they are compared with amount_won (USD),
      // as Step 7 now does; until then this read amount_won_coins, the coins credit (Step 7 checks that
      // field against the conversion rule). Measured on the pinned dataset: 475 / 475 either way.
      let summed: bigint | null = 0n;
      for (const round of b.response.rounds) {
        for (const pl of round.data.paylines) {
          const base = centsOf(pl.base_payout_currency || pl.payout_currency || '0');
          const bomb = pl.bomb_multiplier ?? 0;
          if (base === null || summed === null || !Number.isInteger(bomb)) { summed = null; continue; }
          summed += base * BigInt(Math.max(bomb, 1));
        }
      }
      const reported = centsOf(b.response.amount_won);
      if (summed !== null && reported !== null && summed === reported) ok++;
      else {
        bad++;
        if (fails.length < 3) fails.push(`bet ${b.spinId}: sum ${summed === null ? 'off-grid' : `${summed}¢`} vs amount_won ${reported === null ? 'off-grid' : `${reported}¢`}`);
      }
    }

    // BOUND TO THE POPULATION: with the free spins removed this reported 0/0 and PASSED. The
    // field compared is amount_won (USD); the sentence names the field the code reads.
    const pop26 = checked === EXPECTED_FREE_SPIN_BETS ? '' : `free spins checked ${checked} != ${EXPECTED_FREE_SPIN_BETS}`;
    results.push(step(26, 'Free-Spin Payout Reconciliation',
      bad === 0 && !pop26 ? 'PASS' : 'FAIL',
      `${ok}/${checked} captured free spins reconcile amount_won (USD) to sum(base_payout × max(bomb_multiplier, 1)) across paylines exactly in integer cents (src/loader.ts: ${EXPECTED_FREE_SPIN_BETS}). ${bad} mismatched.` +
      (pop26 ? ` POPULATION: ${pop26}.` : '') +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : ''),
      { checked, reconciled: ok, mismatched: bad, populationIssue: pop26 || null },
    ));
  }

  // ── Step 27: Bonus Multiplier Symbol ───────────────────────────────────
  // Multiplier symbols only appear in bonus_game spins, never in base, and every value shown
  // must be one the operator publishes. The step used to print the observed values next to
  // the published set and never compare them — a value outside the published set passed. Now
  // an unpublished value, a multiplier cell with no value, a base-game sighting, or a sighting
  // count different from src/loader.ts is a FAIL. A published value that live play never showed
  // is reported, not failed: live play is not expected to reach every value.
  {
    let baseGameMultiplierSightings = 0;
    let bonusGameMultiplierSightings = 0;
    let missingValue = 0;
    const observedValues = new Set<string>();
    for (const b of ctx.bets) {
      const isBonus = b.response.spin_type === 'bonus_game' || b.mode === 'free_spin';
      for (const round of b.response.rounds) {
        for (let c = 0; c < REELS; c++) {
          for (let r = 0; r < ROWS; r++) {
            const cell = round.data.view[c][r];
            if (cell.symbol === MULTIPLIER_CODE) {
              if (isBonus) {
                bonusGameMultiplierSightings++;
                if (cell.multiplier_value) observedValues.add(cell.multiplier_value);
                else missingValue++;
              } else {
                baseGameMultiplierSightings++;
              }
            }
          }
        }
      }
    }
    const byNum = (a: string, b: string) => parseFloat(a) - parseFloat(b);
    const expectedValues = Array.from(ctx.paytable.multiplierValues.keys()).map(String).sort(byNum);
    const publishedNums = new Set(expectedValues.map(v => parseFloat(v)));
    const observedSorted = [...observedValues].sort(byNum);
    // Compare numerically: the grid serves the value as a string ("2"), the paytable as a key.
    const unpublished = observedSorted.filter(v => !publishedNums.has(parseFloat(v)));
    const observedNums = new Set(observedSorted.map(v => parseFloat(v)));
    const neverSeen = expectedValues.filter(v => !observedNums.has(parseFloat(v)));
    const issues: string[] = [];
    if (baseGameMultiplierSightings > 0) issues.push(`${baseGameMultiplierSightings} multiplier symbols in base_game`);
    if (unpublished.length > 0) issues.push(`values not in the published set: {${unpublished.join(', ')}}`);
    if (missingValue > 0) issues.push(`${missingValue} multiplier cells carry no value`);
    if (bonusGameMultiplierSightings !== EXPECTED_BONUS_MULTIPLIER_CELLS) issues.push(`bonus-game multiplier cells ${bonusGameMultiplierSightings} != ${EXPECTED_BONUS_MULTIPLIER_CELLS} (src/loader.ts)`);
    results.push(step(27, 'Bonus Multiplier Symbol',
      issues.length === 0 ? 'PASS' : 'FAIL',
      `Multiplier symbol appearances: ${bonusGameMultiplierSightings} in bonus_game (src/loader.ts: ${EXPECTED_BONUS_MULTIPLIER_CELLS}), ${baseGameMultiplierSightings} in base_game (must be 0). ` +
      `Observed multiplier values across all bonus spins: {${observedSorted.join(', ')}}. ` +
      `Published values: {${expectedValues.join(', ')}}. ` +
      `${unpublished.length} observed value(s) outside the published set (must be 0); ${neverSeen.length} published value(s) never observed${neverSeen.length ? ` ({${neverSeen.join(', ')}}, reported, not scored)` : ''}. ` +
      `Mode separation confirms multiplier_bombs_applies_to: 'feature' rule.` +
      (issues.length ? ` FAILED: ${issues.join('; ')}.` : ''),
      { bonusGameSightings: bonusGameMultiplierSightings, baseGameSightings: baseGameMultiplierSightings, missingValue,
        observedValues: observedSorted, publishedValues: expectedValues, unpublishedObserved: unpublished, publishedNeverObserved: neverSeen, issues },
    ));
  }

  // ── Step 28: Cascade RNG Byte-Exact Replay ─────────────────────────────
  // For every captured cascade (round 1..N) of every captured spin:
  //   tumbleSeed = deriveTumbleSeed(outcome_index, round_index, tumble_index)
  //   freshPcg32 = new Pcg32(tumbleSeed)
  //   newGrid    = generateGrid(freshPcg32, weights[condition])
  //   apply gravity from prev grid (skip cells with removed_on_round=N)
  //   fill empty top cells from newGrid (top-down per column)
  //   compare to captured round-N view cell-by-cell
  // Plus: in bonus_game, draw multipliers from the same per-cascade PCG32
  // stream and check captured multiplier_value at filled positions.
  // Closes R-CASCADE-RNG (previously disclosed as deferred).
  {
    const baseTables  = buildSymbolTables(ctx, 'base_game');
    const bonusTables = buildSymbolTables(ctx, 'bonus_game');

    let cascadesChecked = 0;
    let cellsChecked    = 0;
    let cellMismatches  = 0;
    let multChecked     = 0;
    let multMismatches  = 0;
    let spinsWithCascades = 0;
    let spinsSkipped    = 0;
    const examples: string[] = [];

    for (const b of ctx.bets) {
      if (b.mode === 'buy') { spinsSkipped++; continue; }
      const rounds = b.response.rounds;
      if (!rounds || rounds.length < 2) continue;

      const condition: 'base_game' | 'bonus_game' =
        (b.response.spin_type === 'bonus_game' || b.mode === 'free_spin') ? 'bonus_game' : 'base_game';
      const tables = condition === 'bonus_game' ? bonusTables : baseTables;
      const codeToIdx = tables.codeToIdx;

      // Resolve (outcomeIndex, roundIndex). Use verifyData when present
      // (covers free spins where the trigger nonce is shared across the
      // session); otherwise compute from (server_seed, client_seed, served nonce).
      let outcomeIndex: number, roundIndex: number;
      const vd: any = b.verifyData;
      if (vd?.outcome_index_hex) {
        outcomeIndex = parseInt(vd.outcome_index_hex, 16);
        roundIndex   = vd.round_index ?? 0;
      } else {
        const hash = (b as any).activeAtSpin?.server_seed_hashed;
        const serverSeed = hash ? ctx.seedMap.get(hash) : undefined;
        const clientSeed = (b as any).activeAtSpin?.client_seed ?? '';
        // The SERVED nonce, exact (the ±1 search this used until 2026-09-26 is gone): the verify
        // payload's, else the recorded one or the correction declared by spin id in src/loader.ts.
        const nonceBase  = vd?.nonce ?? servedNonce(b as any);
        if (!serverSeed || !clientSeed || nonceBase == null) { spinsSkipped++; continue; }
        roundIndex = vd?.round_index ?? 0;
        let chosen: number | undefined = undefined;
        {
          const oi  = computeOutcomeIndex(serverSeed, clientSeed, nonceBase);
          const tseed = deriveTumbleSeed(oi, roundIndex, 0);
          const grid  = generateGrid(new Pcg32(tseed), tables.weights);
          let match = true;
          const r0v = rounds[0].data.view;
          for (let col = 0; col < REELS && match; col++) {
            for (let row = 0; row < ROWS && match; row++) {
              if (tables.codes[grid[col][row]] !== r0v[col][row].symbol) match = false;
            }
          }
          if (match) chosen = oi;
        }
        if (chosen === undefined) { spinsSkipped++; continue; }
        outcomeIndex = chosen;
      }

      // Reconstruct prev grid (round 0) from captured view
      let prevGrid: number[][] = [];
      const r0view = rounds[0].data.view;
      for (let col = 0; col < REELS; col++) {
        const reel: number[] = [];
        for (let row = 0; row < ROWS; row++) {
          const sym = r0view[col][row].symbol as string;
          const idx = codeToIdx.get(sym);
          if (idx === undefined) { reel.push(-1); }
          else                   { reel.push(idx); }
        }
        prevGrid.push(reel);
      }

      spinsWithCascades++;

      for (let n = 1; n < rounds.length; n++) {
        const prevView = rounds[n - 1].data.view;
        const removed = new Set<number>();
        for (let col = 0; col < REELS; col++) {
          for (let row = 0; row < ROWS; row++) {
            if (prevView[col][row].removed_on_round === n) removed.add(col * ROWS + row);
          }
        }

        const afterGravity: (number | null)[][] = [];
        for (let col = 0; col < REELS; col++) {
          const survivors: number[] = [];
          for (let row = 0; row < ROWS; row++) {
            if (!removed.has(col * ROWS + row)) survivors.push(prevGrid[col][row]);
          }
          const newCount = ROWS - survivors.length;
          const colArr: (number | null)[] = new Array(ROWS).fill(null);
          for (let i = 0; i < newCount; i++) colArr[i] = null;
          for (let i = 0; i < survivors.length; i++) colArr[newCount + i] = survivors[i];
          afterGravity.push(colArr);
        }

        const tumbleSeed  = deriveTumbleSeed(outcomeIndex, roundIndex, n);
        const cascadePrng = new Pcg32(tumbleSeed);
        const newGrid     = generateGrid(cascadePrng, tables.weights);

        let newGridMultipliers: { position: number; value: number }[] = [];
        if (condition === 'bonus_game') {
          newGridMultipliers = generateMultipliers(
            newGrid, cascadePrng, tables.multiplierSymbolIndex,
            ctx.paytable.multiplierValuesList, ctx.paytable.multiplierWeightsList,
          );
        }
        const multByPosition = new Map(newGridMultipliers.map(m => [m.position, m.value]));

        const replayed: number[][] = afterGravity.map(c => c.slice() as any);
        for (let col = 0; col < REELS; col++) {
          for (let row = 0; row < ROWS; row++) {
            if (replayed[col][row] === null) replayed[col][row] = newGrid[col][row];
          }
        }

        const cap = rounds[n].data.view;
        for (let col = 0; col < REELS; col++) {
          for (let row = 0; row < ROWS; row++) {
            cellsChecked++;
            const repCode = tables.codes[replayed[col][row]];
            const capCode = cap[col][row].symbol;
            if (repCode !== capCode) {
              cellMismatches++;
              if (examples.length < 5) {
                examples.push(`spin ${b.spinId} cascade ${n} (col=${col},row=${row}): replayed=${repCode} captured=${capCode}`);
              }
            }
            if (condition === 'bonus_game' && cap[col][row].multiplier_value != null) {
              if (afterGravity[col][row] === null) {
                multChecked++;
                const expected = multByPosition.get(col * ROWS + row);
                const captured = parseFloat(cap[col][row].multiplier_value as any);
                if (expected !== captured) {
                  multMismatches++;
                  if (examples.length < 5) {
                    examples.push(`spin ${b.spinId} cascade ${n} (col=${col},row=${row}) multiplier: replayed=${expected} captured=${captured}`);
                  }
                }
              }
            }
          }
        }
        cascadesChecked++;
        prevGrid = replayed as number[][];
      }
    }

    // Guard: PASS requires non-zero coverage. A dataset with all cascade
    // spins skipped (e.g. missing outcome_index everywhere) would trivially
    // PASS the byte-exact check with 0/0 reproductions otherwise.
    // BOUND TO THE POPULATION (2026-09-26): a spin whose round-0 grid did not reproduce at its served
    // nonce used to be counted as "skipped" and dropped silently. Every cascade round src/loader.ts
    // declares must be replayed, and the only permitted skips are the declared bonus buys.
    const pop28: string[] = [];
    if (cascadesChecked !== EXPECTED_CASCADE_ROUNDS) pop28.push(`cascades replayed ${cascadesChecked} != ${EXPECTED_CASCADE_ROUNDS}`);
    if (spinsSkipped !== EXPECTED_MODE_BETS.buy) pop28.push(`spins skipped ${spinsSkipped} != the ${EXPECTED_MODE_BETS.buy} declared buys`);
    const status = (
      spinsWithCascades > 0 && pop28.length === 0 &&
      cellMismatches === 0 && multMismatches === 0
    ) ? 'PASS' : 'FAIL';
    results.push(step(28, 'Cascade RNG Byte-Exact Replay',
      status,
      `${cascadesChecked} captured cascades replayed via deriveTumbleSeed(outcome_index, round_index, tumble_index) ` +
      `→ fresh PCG32 → generateGrid + gravity-fill. ` +
      `${cellsChecked - cellMismatches}/${cellsChecked} cells reproduce byte-exact. ` +
      `${multChecked - multMismatches}/${multChecked} captured multiplier values reproduce byte-exact. ` +
      `${spinsWithCascades} spins exercised; ${spinsSkipped} skipped (the declared bonus buys; bound to EXPECTED_MODE_BETS.buy, cascades bound to EXPECTED_CASCADE_ROUNDS). ` +
      (pop28.length ? `POPULATION: ${pop28.join('; ')}. ` : '') +
      (examples.length ? `Examples of mismatches: ${examples.join(' | ')}` : 'Closes R-CASCADE-RNG.')
    ));
  }

  return results;
}

interface BuiltTables {
  codes: string[];
  codeToIdx: Map<string, number>;
  weights: number[][];
  multiplierSymbolIndex: number;
}
function buildSymbolTables(ctx: VerifyContext, condition: 'base_game' | 'bonus_game'): BuiltTables {
  const symbols = [...ctx.config.weights.symbols_by_condition[condition]]
    .sort((a, b) => a.symbol_index - b.symbol_index);
  const codes = symbols.map(s => s.code);
  const weights: number[][] = [];
  for (let r = 0; r < REELS; r++) weights.push(symbols.map(s => s.weights_per_reel[r]));
  const codeToIdx = new Map<string, number>(codes.map((c, i) => [c, i]));
  const multIdx   = symbols.findIndex(s => s.code === 'multiplier');
  return { codes, codeToIdx, weights, multiplierSymbolIndex: multIdx };
}
