/**
 * Steps 10–15: dataset-integrity + per-phase scaffolding.
 *
 *  10. House Edge Audit         — every bet's edge_multiplier is 1 (Zero Edge); no bracket exercised
 *  11. Config Completeness      — paytable + weights + scaling-edge fields present
 *  12. Epoch Size               — every epoch is exactly 50 bets (the capture's rotation schedule) except the declared close-outs
 *  13. Phase Labels             — A, B, C, D, E (+ free_spin sub-records) all present, no extras
 *  14. Dataset Hash             — file SHA-256 matches the pinned EXPECTED_HASH
 *  15. Phase D Client-Seed Variation — 10 distinct auditor seeds at 50 bets each
 */

import { step, type VerifyContext, type StepResult } from './context';
import {
  checkDatasetHash,
  EXPECTED_BETS, EXPECTED_REGULAR_BETS, EXPECTED_FREE_SPIN_BETS,
  EXPECTED_PHASE_BETS, EXPECTED_MODE_BETS, EXPECTED_SEED_RECORDS,
  EXPECTED_EPOCHS, EXPECTED_EPOCH_SIZE, EXPECTED_SHORT_EPOCH_SIZES,
  PHASE_D_SEED_COUNT, PHASE_D_BETS_PER_SEED,
  MIN_PAYTABLE_CELLS_EXERCISED,
  checkRawFiles,
} from '../../src/loader';

const EXPECTED_PHASES = ['A', 'B', 'C', 'D', 'E'];

export function run(ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];

  // ── Step 10: House Edge Audit ──────────────────────────────────────────
  // The audit account has Zero Edge active — every bet's
  // `response.edge_multiplier` is "1", meaning no payout reduction was
  // applied at any captured stake ($0.20–$50). This proves Zero Edge is
  // consistently honoured for the captured account, but it also means
  // the scaling-edge schedule (116 base + 184 bonus brackets) is NOT
  // empirically exercised at this account, at any bracket, bracket 1
  // included. The schedule is verified analytically in Step 11 (Config
  // Completeness) instead, and the un-exercised schedule is disclosed as
  // R-BRACKET-EMPIRICAL.
  {
    let ok = 0, bad = 0;
    const seenStakes = new Set<string>();
    const examples: string[] = [];
    for (const b of ctx.bets) {
      // Counted by VALUE, not by string: the 20 bonus buys record their $0.20 stake as "0.2" and
      // every other $0.20 bet as "0.200000000000000000", which a string Set counted as two stakes
      // (8 reported until 19 Oct 2026; there are 7 — Mike's QA, 19 Oct 2026).
      seenStakes.add(String(Number(b.response.bet_amount_currency)));
      const em = parseFloat(b.response.edge_multiplier);
      if (Math.abs(em - 1) < 1e-9) ok++;
      else {
        bad++;
        if (examples.length < 3) examples.push(`bet ${b.spinId}: stake=${b.response.bet_amount_currency} edge_multiplier=${em}`);
      }
    }
    results.push(step(10, 'House Edge Audit (Zero Edge consistency)',
      bad === 0 ? 'PASS' : 'FAIL',
      `${ok}/${ok + bad} bets have edge_multiplier = 1 (Zero Edge active). ${bad} deviations. ` +
      `Distinct stakes observed: ${seenStakes.size}. Stakes spanned ${[...seenStakes].sort((a,b)=>parseFloat(a)-parseFloat(b)).slice(0,1)[0]}–${[...seenStakes].sort((a,b)=>parseFloat(b)-parseFloat(a)).slice(0,1)[0]}. ` +
      `(The scaling edge at any bracket is disclosed as R-BRACKET-EMPIRICAL in MANIFEST.md#limitations-and-trust — it is verified analytically from the published schedule but not exercised at a Zero-Edge audit account.)` +
      (examples.length ? ` Examples: ${examples.join(' | ')}` : '')
    ));
  }

  // ── Step 11: Config Completeness & Paytable Coverage ───────────────────
  // Checking that the config object has the right KEYS says nothing about whether live play
  // ever exercised the payout table those keys describe. A payout cell here is
  // (condition, symbol, cluster-size tier); the published paytable has 96 of them, and the
  // step now measures how many the capture actually landed on, names the ones it did not,
  // and holds the total to a floor from src/loader.ts.
  //
  // On what an unexercised cell means for this game: the theoretical return is NOT taken
  // from live play. It comes from the exhaustive enumeration of all 2^32 base outcomes and
  // the exact bonus-session convolution (Steps 29–32), which reach every cell the engine can
  // produce. So an unexercised cell is a statement about the size of the live capture, not
  // an unverified return — but a reader should be able to see which cells that is, so they
  // are listed rather than left implicit.
  {
    const required = [
      'mechanics', 'symbols', 'rtp_per_condition', 'scaling_edge', 'weights', 'features',
    ];
    const missing = required.filter(k => !(k in ctx.config));
    const ptOk = ctx.paytable.bySymbol.base_game.size > 0 && ctx.paytable.bySymbol.bonus_game.size > 0;

    // Every published cell, and the multiplier on it.
    const allCells = new Map<string, number>();
    for (const cond of ['base_game', 'bonus_game'] as const) {
      for (const [code, sym] of ctx.paytable.bySymbol[cond]) {
        for (const [count, mult] of sym.payoutByCount) {
          allCells.set(`${cond}|${code}|${count}`, mult);
        }
      }
    }

    // Cells live play actually landed on. Cluster tiers cap at 12; scatter pays cap at 6.
    const exercised = new Map<string, number>();
    for (const b of ctx.bets) {
      const cond = (b.response.spin_type === 'bonus_game' || b.mode === 'free_spin')
        ? 'bonus_game' : 'base_game';
      for (const round of b.response.rounds ?? []) {
        for (const pl of round.data.paylines ?? []) {
          const cap = pl.symbol === 'bonus' ? 6 : 12;
          const tier = pl.count >= cap ? cap : pl.count;
          const key = `${cond}|${pl.symbol}|${tier}`;
          exercised.set(key, (exercised.get(key) ?? 0) + 1);
        }
      }
    }

    const neverExercised = [...allCells.keys()].filter(k => !exercised.has(k)).sort();
    const maxMultiplierUnexercised = neverExercised.reduce((m, k) => Math.max(m, allCells.get(k) ?? 0), 0);

    const failures: string[] = [];
    if (missing.length) failures.push(`config fields missing: ${missing.join(', ')}`);
    if (!ptOk) failures.push('paytable did not load for both conditions');
    for (const k of exercised.keys()) {
      if (!allCells.has(k)) failures.push(`payline hit cell '${k}', which is not in the published paytable`);
    }
    const exercisedCount = allCells.size - neverExercised.length;
    if (exercisedCount < MIN_PAYTABLE_CELLS_EXERCISED) {
      failures.push(`only ${exercisedCount} of ${allCells.size} paytable cells exercised (floor ${MIN_PAYTABLE_CELLS_EXERCISED})`);
    }

    results.push(step(11, 'Config Completeness & Paytable Coverage',
      failures.length === 0 ? 'PASS' : 'FAIL',
      failures.length === 0
        ? `Required config fields: ${required.length}/${required.length} present. `
          + `Paytable: base_game ${ctx.paytable.bySymbol.base_game.size} symbols, bonus_game ${ctx.paytable.bySymbol.bonus_game.size} symbols. `
          + `Coverage: ${exercisedCount} of ${allCells.size} (condition, symbol, cluster-tier) payout cells exercised by live play, above the ${MIN_PAYTABLE_CELLS_EXERCISED}-cell floor in src/loader.ts; no payline hit a cell outside the published table. `
          + `The ${neverExercised.length} unexercised cells are named in this step's data block — their return is established by the exhaustive 2^32 enumeration in Steps 29–32, not by live play.`
        : `${failures.length} config/coverage failures: ${failures.slice(0, 3).join('; ')}`,
      {
        requiredConfigFields: required.length,
        missingConfigFields: missing,
        baseGameSymbols: ctx.paytable.bySymbol.base_game.size,
        bonusGameSymbols: ctx.paytable.bySymbol.bonus_game.size,
        totalPaytableCells: allCells.size,
        exercisedCells: exercisedCount,
        minCellsExercised: MIN_PAYTABLE_CELLS_EXERCISED,
        neverExercisedCells: neverExercised,
        maxMultiplierOnUnexercisedCell: maxMultiplierUnexercised,
        note: 'Theoretical RTP for this game is derived from the exhaustive 2^32 enumeration and the '
            + 'exact bonus-session convolution (Steps 29-32), which reach every cell the engine can '
            + 'produce. An unexercised cell therefore reflects the size of the live capture, not an '
            + 'unverified return.',
        failures,
      },
    ));
  }

  // ── Step 12: Epoch Size ────────────────────────────────────────────────
  // The capture rotated the seed after every 50 regular bets (BETS_PER_EPOCH in
  // capture/capture.reference.js): the capture's schedule, not a tested Duel limit.
  // Each epoch should contain ≤ 50 regular bets
  // (free_spin records are sub-events of a trigger and don't count).
  // Failing only on an epoch over 50 is not a check on epoch size: nothing in this audit
  // was ever at risk of producing one, and every uniform shrink — 116 epochs of five bets
  // apiece — passed it, as did deleting epochs outright. The declared size is asserted
  // instead, together with the epoch count and the exact multiset of the two documented
  // phase close-outs, so shrinking the data and the header together cannot satisfy it.
  {
    const sizes: number[] = [];
    const offenders: string[] = [];
    for (const [hash, bets] of ctx.byEpoch) {
      const regular = bets.filter(b => b.mode !== 'free_spin').length;
      sizes.push(regular);
      if (regular > EXPECTED_EPOCH_SIZE) {
        if (offenders.length < 3) offenders.push(`${hash.slice(0, 16)}=${regular}`);
      }
    }
    const minS = sizes.length ? Math.min(...sizes) : 0;
    const maxS = sizes.length ? Math.max(...sizes) : 0;
    const fullSize = sizes.filter(n => n === EXPECTED_EPOCH_SIZE).length;
    const shortObserved = sizes.filter(n => n !== EXPECTED_EPOCH_SIZE).sort((a, b) => a - b);
    const shortExpected = [...EXPECTED_SHORT_EPOCH_SIZES].sort((a, b) => a - b);

    const issues: string[] = [];
    if (ctx.byEpoch.size !== EXPECTED_EPOCHS) issues.push(`epochs ${ctx.byEpoch.size} != ${EXPECTED_EPOCHS}`);
    if (shortObserved.length !== shortExpected.length || shortObserved.some((n, i) => n !== shortExpected[i])) {
      issues.push(`epochs not of ${EXPECTED_EPOCH_SIZE} regular bets are [${shortObserved.join(', ')}], expected exactly [${shortExpected.join(', ')}]`);
    }
    if (offenders.length) issues.push(`epochs above the capture's ${EXPECTED_EPOCH_SIZE}-bet rotation schedule: ${offenders.join(', ')}`);

    results.push(step(12, 'Epoch Size',
      issues.length === 0 ? 'PASS' : 'FAIL',
      issues.length === 0
        ? `${EXPECTED_EPOCHS} epochs as declared in src/loader.ts: ${fullSize} of exactly ${EXPECTED_EPOCH_SIZE} regular bets (the capture script rotated the seed every ${EXPECTED_EPOCH_SIZE} bets; its schedule, not a tested Duel limit), plus the two documented phase close-outs of ${shortExpected.join(' and ')} regular bets`
        : `EPOCH STRUCTURE MISMATCH vs src/loader.ts: ${issues.join('; ')}`,
      { epochs: ctx.byEpoch.size, fullEpochs: fullSize, shortEpochSizes: shortObserved, minSize: minS, maxSize: maxS, issues },
    ));
  }

  // ── Step 13: Phase Labels ──────────────────────────────────────────────
  // Labels are not a population. "A through E are all present and nothing else is" is
  // satisfied by five bets. Every figure a label check can reach is read from inside the
  // file being scored — including meta.phasesRun — so a uniform shrink keeps every label
  // valid and every ratio intact, and the shrunken file re-pins cleanly. The counts are
  // compared against src/loader.ts, which the dataset does not control.
  {
    const present = new Set(ctx.bets.map(b => b.phase));
    const missing = EXPECTED_PHASES.filter(p => !present.has(p));
    const extra   = [...present].filter(p => !EXPECTED_PHASES.includes(p) && p !== 'preflight-drain');

    const phaseCounts: Record<string, number> = {};
    for (const b of ctx.bets) phaseCounts[b.phase] = (phaseCounts[b.phase] ?? 0) + 1;
    const modeCounts: Record<string, number> = {};
    for (const b of ctx.bets) modeCounts[b.mode] = (modeCounts[b.mode] ?? 0) + 1;
    const regular = ctx.bets.filter(b => b.mode !== 'free_spin').length;
    const freeSpins = ctx.bets.length - regular;

    const popIssues: string[] = [];
    if (ctx.bets.length !== EXPECTED_BETS) popIssues.push(`bets ${ctx.bets.length} != ${EXPECTED_BETS}`);
    if (regular !== EXPECTED_REGULAR_BETS) popIssues.push(`regular bets ${regular} != ${EXPECTED_REGULAR_BETS}`);
    if (freeSpins !== EXPECTED_FREE_SPIN_BETS) popIssues.push(`free-spin records ${freeSpins} != ${EXPECTED_FREE_SPIN_BETS}`);
    if (ctx.seeds.length !== EXPECTED_SEED_RECORDS) popIssues.push(`seed records ${ctx.seeds.length} != ${EXPECTED_SEED_RECORDS}`);
    for (const [p, n] of Object.entries(EXPECTED_PHASE_BETS)) {
      const got = phaseCounts[p] ?? 0;
      if (got !== n) popIssues.push(`phase ${p} ${got} != ${n}`);
    }
    for (const [m, n] of Object.entries(EXPECTED_MODE_BETS)) {
      const got = modeCounts[m] ?? 0;
      if (got !== n) popIssues.push(`mode ${m} ${got} != ${n}`);
    }
    if (missing.length) popIssues.push(`phases missing: ${missing.join(', ')}`);
    if (extra.length)   popIssues.push(`unexpected phases: ${extra.join(', ')}`);

    results.push(step(13, 'Population & Phase Labels',
      popIssues.length === 0 ? 'PASS' : 'FAIL',
      popIssues.length === 0
        ? `${ctx.bets.length} entries (${regular} regular, ${freeSpins} free-spin records) and ${ctx.seeds.length} seed records match the capture plan in src/loader.ts (code constants, not the dataset's own meta.phasesRun header); phases A, B, C, D, E all present with no extras`
        : `POPULATION MISMATCH vs the capture plan in src/loader.ts: ${popIssues.join('; ')}`,
      { phaseCounts, modeCounts, regularBets: regular, freeSpinRecords: freeSpins, seedRecords: ctx.seeds.length, populationIssues: popIssues },
    ));
  }

  // ── Step 14: Dataset Hash ──────────────────────────────────────────────
  // Since 2026-09-26 also every operator file under data/raw/ (config, both paytables, the client-seed
  // snapshot and the two raw spins) against RAW_FILE_PINS in src/loader.ts — the config and the
  // rules-endpoint paytable are what every recomputation and payline check reads. Since 2026-10-05
  // also the /api/v2/slots and /rules bodies of the duel.com config as fetched 2026-10-05 in a
  // logged-in session (read-only GET) (10 files).
  {
    const r = checkDatasetHash();
    const raw = checkRawFiles();
    const rawBad = raw.filter(f => !f.match);
    const ok14 = r.match && rawBad.length === 0;
    results.push(step(14, 'Dataset Hash',
      ok14 ? 'PASS' : 'FAIL',
      `Actual SHA-256: ${r.actual}. Expected: ${r.expected}. ${r.match ? 'Match.' : 'MISMATCH — dataset has been modified since the hash was pinned.'} `
      + `Operator files under data/raw/: ${raw.length - rawBad.length}/${raw.length} match their pins in src/loader.ts`
      + (rawBad.length ? ` — MISMATCH: ${rawBad.map(f => `${f.file} ${f.actual ?? '(absent)'} != ${f.pinned}`).join('; ')}` : ''),
      { expected: r.expected, actual: r.actual, match: r.match, rawFiles: raw },
    ));
  }

  // ── Step 15: Phase D Client-Seed Variation ─────────────────────────────
  // 10 distinct auditor seeds, 50 bets each = 500 phase D bets. Verifies
  // the custom-seed rotation flow + that recompute holds across multiple
  // client seeds.
  {
    const phaseD = ctx.byPhase['D'] ?? [];
    const seenSeeds = new Set<string>();
    for (const b of phaseD) seenSeeds.add(b.activeAtSpin.client_seed);
    const regularD = phaseD.filter(b => b.mode !== 'free_spin').length;
    const issues: string[] = [];
    if (seenSeeds.size !== PHASE_D_SEED_COUNT) issues.push(`distinct client seeds ${seenSeeds.size} != ${PHASE_D_SEED_COUNT}`);
    if (regularD !== PHASE_D_SEED_COUNT * PHASE_D_BETS_PER_SEED) {
      issues.push(`Phase D regular bets ${regularD} != ${PHASE_D_SEED_COUNT * PHASE_D_BETS_PER_SEED}`);
    }
    results.push(step(15, 'Phase D Client Seed Variation',
      issues.length === 0 ? 'PASS' : 'FAIL',
      issues.length === 0
        ? `${phaseD.length} Phase D entries (incl. free spins); ${regularD} regular bets across ${seenSeeds.size} distinct auditor client seeds, matching the ${PHASE_D_SEED_COUNT} × ${PHASE_D_BETS_PER_SEED} plan in src/loader.ts`
        : `PHASE D MISMATCH vs src/loader.ts: ${issues.join('; ')}`,
      { phaseDEntries: phaseD.length, phaseDRegularBets: regularD, distinctClientSeeds: seenSeeds.size, issues },
    ));
  }

  return results;
}
