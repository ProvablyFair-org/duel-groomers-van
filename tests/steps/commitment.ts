/**
 * Steps 1–4: cryptographic-commitment chain.
 *
 *   1. Seed Hash Integrity        — every revealed server_seed SHA-256 == its committed hash
 *   2. Commitment Linkage         — each new active hash equals the prior epoch's next_server_seed_hash
 *   3. Hash Consistency Within Epoch — every bet carries the hash committed by the rotation record
 *                                      active when it was placed (epochs from the TIMELINE, not the hash)
 *   4. Nonce Audit                — within each epoch, nonces 0..K-1 (K ≤ 50, the capture's rotation schedule), no reuse; every gap
 *                                   recomputed from the revealed seed and bound to the declared count;
 *                                   the declared gaps are a capture-origin FLAG (verdict-neutral)
 */

import * as crypto from 'crypto';
import { step, type VerifyContext, type StepResult } from './context';
import {
  EXPECTED_SEED_RECORDS, EXPECTED_REVEALED_SEEDS, EXPECTED_SEED_LINKS, EXPECTED_EPOCHS,
  EXPECTED_BETS, EXPECTED_REGULAR_BETS, EXPECTED_CAPTURE_RETRY_GAPS, groupByEpochWindow,
  EXPECTED_NONCE_GAPS, servedNonce,
} from '../../src/loader';
import { computeOutcomeIndex } from '../../src/rng';

// The capture rotated the seed after every 50 regular bets (BETS_PER_EPOCH in capture/capture.reference.js).
// That is the capture's schedule, not a tested Duel limit; an epoch over it contradicts the capture plan.
const CAPTURE_EPOCH_SIZE = 50;

export function run(ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];

  // ── Step 1: Seed Hash Integrity ─────────────────────────────────────────
  // This step used to walk ctx.seedMap and check that each entry's plaintext hashed to its
  // key. buildSeedMap() performs exactly that check before it inserts anything, so `bad`
  // could not be anything but zero: the step could not fail, and an empty map reported
  // "0/0 revealed seeds, 0 failures" and passed. It was decoration.
  //
  // What matters is not that the map is self-consistent but that every EPOCH a captured bet
  // was served under has an opened commitment, and that the number of them matches the
  // population declared in src/loader.ts. Both are checked from the seed records rather than
  // from the derived map, and an epoch with no revealed seed is named. The records' serverSeed
  // field was attached at export by the capture's save step from post-rotation /verify responses
  // (MANIFEST, Dataset and capture); it is not part of the recorded rotation response.
  {
    const failures: string[] = [];
    let opened = 0;

    for (const s of ctx.seeds) {
      const plain = s.seed.serverSeed;
      if (!plain) continue;   // the seed still active when the capture closed
      const sha = crypto.createHash('sha256').update(Buffer.from(plain, 'hex')).digest('hex');
      if (sha === s.seed.serverSeedHashed) opened++;
      else failures.push(`seed record '${s.context}': SHA-256(server_seed) ≠ serverSeedHashed ${s.seed.serverSeedHashed.slice(0, 16)}…`);
    }

    // Every epoch a bet was actually served under must resolve to a plaintext.
    const unresolvedEpochs: string[] = [];
    for (const hash of ctx.byEpoch.keys()) {
      if (!ctx.seedMap.has(hash)) unresolvedEpochs.push(hash.slice(0, 16));
    }
    if (unresolvedEpochs.length > 0) {
      failures.push(`${unresolvedEpochs.length} epochs were played under a commitment that was never opened: ${unresolvedEpochs.slice(0, 5).join(', ')}`);
    }

    const popIssues: string[] = [];
    if (ctx.seeds.length !== EXPECTED_SEED_RECORDS) popIssues.push(`seed records ${ctx.seeds.length} != ${EXPECTED_SEED_RECORDS}`);
    if (opened !== EXPECTED_REVEALED_SEEDS) popIssues.push(`commitments opened ${opened} != ${EXPECTED_REVEALED_SEEDS}`);
    if (ctx.byEpoch.size !== EXPECTED_EPOCHS) popIssues.push(`epochs ${ctx.byEpoch.size} != ${EXPECTED_EPOCHS}`);

    const ok = failures.length === 0 && popIssues.length === 0;
    results.push(step(1, 'Seed Hash Integrity',
      ok ? 'PASS' : 'FAIL',
      ok
        ? `All ${EXPECTED_REVEALED_SEEDS} commitments required by src/loader.ts opened and verified against the seed records' serverSeed fields (attached at export by the capture's save step from the post-rotation /verify responses: MANIFEST, Dataset and capture) — SHA-256(hex_decode(server_seed)) matches the committed hash — and all ${EXPECTED_EPOCHS} epochs a captured bet was served under resolve to a revealed plaintext. The 117th record is the seed still active when the capture closed; no captured bet used it.`
        : popIssues.length > 0
          ? `POPULATION MISMATCH vs src/loader.ts: ${popIssues.join('; ')}`
          : `${failures.length} commitment failures: ${failures.slice(0, 3).join(' | ')}`,
      {
        seedRecords: ctx.seeds.length,
        commitmentsOpened: opened,
        epochs: ctx.byEpoch.size,
        epochsWithoutRevealedSeed: unresolvedEpochs.length,
        populationIssues: popIssues,
        failures: failures.slice(0, 10),
      },
    ));
  }

  // ── Step 2: Commitment Linkage (next_hash promotion) ───────────────────
  // Each rotation entry's seed.serverSeedHashed should equal the PRIOR
  // rotation's seed.nextServerSeedHash. The very first rotation has no
  // predecessor in the seeds[] array — skipped from the count.
  //
  // Set membership shows a bet was served under SOME captured seed; the chain shows the records
  // agree on the ORDER the seeds were activated in. Both are consistency checks: a pair or chain
  // built after settlement would pass them too, so the timing rests on the capture's recorded
  // order (Step 3) and capture integrity (MANIFEST premise P1). The link count is bound to the
  // population — with one seed record there are no links to check, and "0 broken" used to be enough.
  //
  // SCOPE LIMIT, recorded rather than scored: this capture carries no PRE-CAPTURE link. The
  // first rotation record's active hash is the one the auditor's own rotation produced, and
  // nothing in the dataset shows that hash was already outstanding as "next" beforehand. So
  // the chain is established from the first captured epoch onward, not into it. Every later epoch
  // is covered. The figure is reported here so a reader sees the boundary instead of
  // inferring one that is not there.
  {
    let linked = 0;
    const examples: string[] = [];
    for (let i = 1; i < ctx.seeds.length; i++) {
      const prevNext = ctx.seeds[i - 1].seed.nextServerSeedHash;
      const currHash = ctx.seeds[i].seed.serverSeedHashed;
      if (prevNext === currHash) linked++;
      else if (examples.length < 3) {
        examples.push(`seeds[${i - 1}].next=${prevNext.slice(0, 16)} ≠ seeds[${i}].active=${currHash.slice(0, 16)}`);
      }
    }
    const examined = Math.max(0, ctx.seeds.length - 1);
    const broken = examined - linked;

    const first = ctx.seeds[0];
    const preCaptureLinkPresent =
      first !== undefined
      && typeof (first as unknown as { previousNextServerSeedHash?: string }).previousNextServerSeedHash === 'string'
      && (first as unknown as { previousNextServerSeedHash: string }).previousNextServerSeedHash === first.seed.serverSeedHashed;

    const popIssues: string[] = [];
    if (examined !== EXPECTED_SEED_LINKS) popIssues.push(`links examined ${examined} != ${EXPECTED_SEED_LINKS}`);

    const ok = broken === 0 && popIssues.length === 0;
    results.push(step(2, 'Commitment Linkage',
      ok ? 'PASS' : 'FAIL',
      ok
        ? `All ${EXPECTED_SEED_LINKS} consecutive seed links required by src/loader.ts verified: each rotation's active hash equals the next hash recorded at the previous rotation, so the records agree on epoch ORDER and not merely epoch membership. `
          + `Link equality is a consistency check, not a timing proof: that each next hash was shown before its epoch's bets rests on the capture's recorded order (rotation records in time order, every bet placed after the record that committed its hash: Step 3), conditional on capture integrity, which the package assumes (MANIFEST premise P1). `
          + `The capture carries no pre-capture link, so the chain is established from the first captured epoch onward, not into it.`
        : popIssues.length > 0
          ? `POPULATION MISMATCH vs src/loader.ts: ${popIssues.join('; ')}`
          : `${broken}/${examined} consecutive seed links broken.` + (examples.length ? ` Examples: ${examples.join(' | ')}` : ''),
      {
        linksExamined: examined,
        linksVerified: linked,
        linksBroken: broken,
        preCaptureLinkPresent,
        preCaptureNote: 'The dataset records no commitment outstanding before the first rotation, so for the first captured '
                      + 'epoch there is no recorded observation of its hash as "next" before its rotation. For every later '
                      + 'epoch the capture recorded it as "next" at the previous rotation; that timing rests on the capture '
                      + 'record (MANIFEST premise P1), not on the hash equality.',
        populationIssues: popIssues,
        failures: examples,
      },
    ));
  }

  // ── Step 3: Hash Consistency Within Epoch ──────────────────────────────
  // This step used to group bets BY activeAtSpin.server_seed_hashed (ctx.byEpoch) and then
  // assert that every bet in a group carried that group's hash — true by construction, so the
  // FAIL branch was unreachable on any input. Epoch membership now comes from the capture
  // TIMELINE (src/loader.ts groupByEpochWindow): a bet belongs to the rotation record that was
  // active when it was placed, decided by timestamps alone. The bet's recorded hash is then
  // compared with the hash that record committed to. A bet whose recorded hash is not the one
  // in force at its time, a bet placed before the first rotation, a timeline out of order, or
  // an epoch count different from src/loader.ts all FAIL.
  {
    const { windows, orphans, unordered } = groupByEpochWindow(ctx.bets, ctx.seeds);
    let betsChecked = 0, betsMismatched = 0, clientSeedMismatched = 0;
    let windowsWithBets = 0, windowsInconsistent = 0;
    const examples: string[] = [];
    for (const w of windows) {
      if (w.bets.length === 0) continue;
      windowsWithBets++;
      let bad = 0;
      for (const b of w.bets) {
        betsChecked++;
        // CLIENT-SEED CONJUNCT (2026-09-26, profile GROOMERS-03): the bet's client seed — the snapshot
        // and, where the operator's /verify payload publishes one, that too — must be the client seed
        // the active rotation record set. Until today no step asserted it.
        const vdCs = b.verifyData?.client_seed;
        if (b.activeAtSpin.client_seed !== w.record.seed.clientSeed || (vdCs !== undefined && vdCs !== null && vdCs !== w.record.seed.clientSeed)) {
          clientSeedMismatched++;
          bad++;
          if (examples.length < 3) examples.push(`bet ${b.spinId}: client seed ${b.activeAtSpin.client_seed}${vdCs ? ` / verify ${vdCs}` : ''} ≠ rotation '${w.record.context}' client seed ${w.record.seed.clientSeed}`);
          continue;
        }
        if (b.activeAtSpin.server_seed_hashed !== w.record.seed.serverSeedHashed) {
          bad++;
          if (examples.length < 3) {
            examples.push(`bet ${b.spinId} placed ${b.startedAt} under rotation '${w.record.context}' (${w.record.at}) records hash `
              + `${b.activeAtSpin.server_seed_hashed.slice(0, 16)}… but that rotation committed ${w.record.seed.serverSeedHashed.slice(0, 16)}…`);
          }
        }
      }
      betsMismatched += bad;
      if (bad > 0) windowsInconsistent++;
    }
    const emptyWindows = windows.filter(w => w.bets.length === 0).map(w => w.record.context);

    const popIssues: string[] = [];
    if (betsChecked + orphans.length !== ctx.bets.length) popIssues.push(`bets placed ${betsChecked + orphans.length} != dataset ${ctx.bets.length}`);
    if (ctx.bets.length !== EXPECTED_BETS) popIssues.push(`bets ${ctx.bets.length} != ${EXPECTED_BETS}`);
    if (windowsWithBets !== EXPECTED_EPOCHS) popIssues.push(`epochs with bets ${windowsWithBets} != ${EXPECTED_EPOCHS}`);
    if (orphans.length > 0) popIssues.push(`${orphans.length} bets placed before the first rotation record`);
    if (unordered > 0) popIssues.push(`${unordered} rotation records out of time order`);

    const ok = betsMismatched === 0 && popIssues.length === 0;
    results.push(step(3, 'Hash Consistency Within Epoch',
      ok ? 'PASS' : 'FAIL',
      ok
        ? `Epochs assigned from the rotation timeline, not from the bets' own hash field: all ${betsChecked} bets carry the server-seed hash `
          + `committed by the rotation record active when they were placed, across ${windowsWithBets} epochs (src/loader.ts: ${EXPECTED_EPOCHS}). `
          + `Every bet also carries the client seed that rotation set (0 mismatches). `
          + `${emptyWindows.length} rotation record(s) with no bet: ${emptyWindows.join(', ') || 'none'}.`
        : `${betsMismatched}/${betsChecked} bets carry a hash or client seed that is not the one committed at their time (${clientSeedMismatched} client-seed mismatches), in ${windowsInconsistent}/${windowsWithBets} epochs.`
          + (popIssues.length ? ` POPULATION: ${popIssues.join('; ')}.` : '')
          + (examples.length ? ` Examples: ${examples.join(' | ')}` : ''),
      {
        betsChecked,
        betsMismatched,
        clientSeedMismatched,
        epochsWithBets: windowsWithBets,
        epochsInconsistent: windowsInconsistent,
        orphanBets: orphans.length,
        rotationRecordsOutOfOrder: unordered,
        rotationRecordsWithoutBets: emptyWindows,
        populationIssues: popIssues,
      },
    ));
  }

  // ── Step 4: Nonce Audit ────────────────────────────────────────────────
  // For each epoch the regular bets' nonces should form a contiguous run 0..K-1, K ≤ 50 (the
  // capture's rotation schedule), with no nonce used twice.
  //
  // Capture-retry artifacts: when /spin succeeds server-side but the response does not reach
  // the client, the server has consumed a nonce that no captured bet uses and the script's
  // retry gets the next one. That shows as a gap. A gap is acceptable only when the seed is
  // revealed, so the round at the missing nonce is fixed by committed inputs; this step
  // RECOMPUTES that round's outcome_index from (revealed server seed, the epoch's client seed,
  // missing nonce) and records it in `data`. The capture holds no bet at that nonce, so there is
  // nothing to compare the recomputed value against — it is recorded, not matched.
  //
  // What used to hide here, and now fails: the step could only return PASS or FLAG; it stopped
  // at the FIRST gap in an epoch, so a second gap in the same epoch was never seen; an epoch
  // over 50 bets was forgiven if it also had a revealed-seed gap; and "retroactively
  // verifiable" was asserted without recomputing anything. A duplicated nonce, a null nonce, an
  // epoch over 50 bets, a gap under an unrevealed seed, or a gap count different from the declared
  // capture-retry count in src/loader.ts is now a FAIL.
  //
  // Duel video-poker / plinko standard (2026-09-23): the declared gaps are a capture-origin FLAG,
  // not a PASS — the rounds at those nonces were not captured, so the recomputed outcome_index
  // has nothing to be matched against. Disclosed on every run, verdict-neutral.
  {
    let okEpochs = 0, retroEpochs = 0, badEpochs = 0;
    let regularChecked = 0;
    const gaps: { epoch: string; nonce: number; outcomeIndex: number | null }[] = [];
    const problems: string[] = [];
    for (const [hash, bets] of ctx.byEpoch) {
      const regular = bets.filter(b => b.mode === 'spin' || b.mode === 'buy');
      regularChecked += regular.length;
      const seedPlain = ctx.seedMap.get(hash);
      const clientSeeds = new Set(regular.map(b => b.activeAtSpin.client_seed));
      const used = new Map<number, number>();
      let bad = false;
      if (clientSeeds.size !== 1) {
        bad = true;
        if (problems.length < 5) problems.push(`epoch ${hash.slice(0, 16)}: ${clientSeeds.size} client seeds`);
      }
      for (const b of regular) {
        // The SERVED nonce: the recorded one, or the declared correction for four spin ids
        // (src/loader.ts CAPTURE_NONCE_CORRECTIONS — bound by id, Step 5 proves each).
        const n = servedNonce(b);
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
          bad = true;
          if (problems.length < 5) problems.push(`epoch ${hash.slice(0, 16)}: bet ${b.spinId} has no usable nonce (${JSON.stringify(b.nonce)})`);
          continue;
        }
        used.set(n, (used.get(n) ?? 0) + 1);
      }
      for (const [n, c] of used) {
        if (c > 1) {
          bad = true;
          if (problems.length < 5) problems.push(`epoch ${hash.slice(0, 16)}: nonce ${n} used by ${c} bets`);
        }
      }
      if (regular.length > CAPTURE_EPOCH_SIZE) {
        bad = true;
        if (problems.length < 5) problems.push(`epoch ${hash.slice(0, 16)}: ${regular.length} regular bets exceed the capture's ${CAPTURE_EPOCH_SIZE}-bet rotation schedule`);
      }
      const maxNonce = used.size > 0 ? Math.max(...used.keys()) : -1;
      let epochGaps = 0;
      for (let n = 0; n <= maxNonce; n++) {
        if (used.has(n)) continue;
        epochGaps++;
        // BOUND BY IDENTITY (2026-09-26): a gap must be one src/loader.ts names by (epoch, nonce).
        if (!EXPECTED_NONCE_GAPS.some(g => g.epochHash === hash && g.nonce === n)) {
          bad = true;
          if (problems.length < 5) problems.push(`epoch ${hash.slice(0, 16)}: undeclared nonce gap at ${n}`);
        }
        if (seedPlain && clientSeeds.size === 1) {
          const oi = computeOutcomeIndex(seedPlain, [...clientSeeds][0], n);
          gaps.push({ epoch: hash.slice(0, 16), nonce: n, outcomeIndex: oi });
        } else {
          bad = true;
          gaps.push({ epoch: hash.slice(0, 16), nonce: n, outcomeIndex: null });
          if (problems.length < 5) {
            problems.push(`epoch ${hash.slice(0, 16)}: nonce ${n} unused and NOT recomputable `
              + (seedPlain ? `(${clientSeeds.size} client seeds in the epoch)` : '(server seed not revealed)'));
          }
        }
      }
      if (bad) badEpochs++;
      else if (epochGaps > 0) retroEpochs++;
      else okEpochs++;
    }
    const recomputed = gaps.filter(g => g.outcomeIndex !== null).length;

    const popIssues: string[] = [];
    if (regularChecked !== EXPECTED_REGULAR_BETS) popIssues.push(`regular bets examined ${regularChecked} != ${EXPECTED_REGULAR_BETS}`);
    if (ctx.byEpoch.size !== EXPECTED_EPOCHS) popIssues.push(`epochs ${ctx.byEpoch.size} != ${EXPECTED_EPOCHS}`);
    if (gaps.length !== EXPECTED_CAPTURE_RETRY_GAPS) popIssues.push(`nonce gaps ${gaps.length} != the ${EXPECTED_CAPTURE_RETRY_GAPS} capture-retry gaps declared in src/loader.ts`);
    for (const g of EXPECTED_NONCE_GAPS) {
      if (!gaps.some(x => g.epochHash.startsWith(x.epoch) && x.nonce === g.nonce)) popIssues.push(`declared gap ${g.epochHash.slice(0, 16)}…#${g.nonce} not present in the data`);
    }

    const ok = badEpochs === 0 && popIssues.length === 0;
    const epochs = okEpochs + retroEpochs + badEpochs;
    results.push(step(4, 'Nonce Audit',
      !ok ? 'FAIL' : gaps.length === 0 ? 'PASS' : 'FLAG',
      `${okEpochs}/${epochs} epochs have a clean 0..N-1 nonce run with no reuse; ${retroEpochs} contain capture-retry gaps; ${badEpochs} are defective. `
        + `${gaps.length} unused nonce(s) in total (src/loader.ts declares ${EXPECTED_CAPTURE_RETRY_GAPS}); ${recomputed}/${gaps.length} recomputed to an outcome_index from the revealed seed (values in this step's data block — the capture has no bet at those nonces to match them against, so those rounds are NOT verified${ok && gaps.length > 0 ? '; capture-origin FLAG: disclosed, verdict-neutral' : ''}). `
        + `${regularChecked} regular bets examined (src/loader.ts: ${EXPECTED_REGULAR_BETS}).`
        + (popIssues.length ? ` POPULATION: ${popIssues.join('; ')}.` : '')
        + (problems.length ? ` Problems: ${problems.join(' | ')}` : ''),
      {
        epochs,
        cleanEpochs: okEpochs,
        retryGapEpochs: retroEpochs,
        defectiveEpochs: badEpochs,
        regularBetsExamined: regularChecked,
        gaps,
        populationIssues: popIssues,
        problems,
      },
      'capture',
    ));
  }

  return results;
}
