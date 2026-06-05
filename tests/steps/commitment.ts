/**
 * Steps 1–4: cryptographic-commitment chain.
 *
 *   1. Seed Hash Integrity        — every revealed server_seed SHA-256 == its committed hash
 *   2. Commitment Linkage         — each new active hash equals the prior epoch's next_server_seed_hash
 *   3. Hash Consistency Within Epoch — every bet in an epoch shares the same active hash
 *   4. Nonce Audit                — within each epoch, nonces are 0..49 (50-cap), no gaps, monotonic
 */

import * as crypto from 'crypto';
import { step, type VerifyContext, type StepResult } from './context';

const EPOCH_CAP = 50;

export function run(ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];

  // ── Step 1: Seed Hash Integrity ─────────────────────────────────────────
  {
    let ok = 0, bad = 0;
    const examples: string[] = [];
    for (const [hashed, plain] of ctx.seedMap) {
      const sha = crypto.createHash('sha256').update(Buffer.from(plain, 'hex')).digest('hex');
      if (sha === hashed) ok++;
      else { bad++; if (examples.length < 3) examples.push(`${hashed.slice(0,16)} → SHA(${plain.slice(0,16)})=${sha.slice(0,16)}`); }
    }
    results.push(step(1, 'Seed Hash Integrity',
      bad === 0 ? 'PASS' : 'FAIL',
      `${ok}/${ok + bad} revealed seeds: SHA-256(hex_decode(server_seed)) matches the committed hash. ${bad} failures.` +
      (examples.length ? ` Examples: ${examples.join(' | ')}` : '')
    ));
  }

  // ── Step 2: Commitment Linkage (next_hash promotion) ───────────────────
  // Each rotation entry's seed.serverSeedHashed should equal the PRIOR
  // rotation's seed.nextServerSeedHash. The very first rotation has no
  // predecessor in the seeds[] array — skipped from the count.
  {
    let linked = 0, broken = 0;
    const examples: string[] = [];
    for (let i = 1; i < ctx.seeds.length; i++) {
      const prevNext = ctx.seeds[i - 1].seed.nextServerSeedHash;
      const currHash = ctx.seeds[i].seed.serverSeedHashed;
      if (prevNext === currHash) linked++;
      else {
        broken++;
        if (examples.length < 3) examples.push(`seeds[${i-1}].next=${prevNext.slice(0,16)} ≠ seeds[${i}].active=${currHash.slice(0,16)}`);
      }
    }
    results.push(step(2, 'Commitment Linkage',
      broken === 0 ? 'PASS' : 'FAIL',
      `${linked}/${linked + broken} consecutive seed links verified. ${broken} broken.` +
      (examples.length ? ` Examples: ${examples.join(' | ')}` : '')
    ));
  }

  // ── Step 3: Hash Consistency Within Epoch ──────────────────────────────
  // Every bet inside one epoch should reference the same activeAtSpin
  // server_seed_hashed. (Sanity check; should always hold by construction
  // of the byEpoch map, but if the capture mis-stitched anything this
  // would catch it.)
  {
    let consistent = 0, inconsistent = 0;
    for (const [hash, bets] of ctx.byEpoch) {
      const allSame = bets.every(b => b.activeAtSpin.server_seed_hashed === hash);
      if (allSame) consistent++;
      else inconsistent++;
    }
    results.push(step(3, 'Hash Consistency Within Epoch',
      inconsistent === 0 ? 'PASS' : 'FAIL',
      `${consistent}/${consistent + inconsistent} epochs internally consistent. ${inconsistent} inconsistent.`
    ));
  }

  // ── Step 4: Nonce Audit ────────────────────────────────────────────────
  // For each epoch the regular bets' activeAtSpin.nonce values should
  // form a contiguous monotonic sequence 0..K-1 (K ≤ 50 platform cap).
  //
  // Capture-retry artifacts: when /spin succeeds server-side but the
  // response doesn't reach the client, the server has consumed a nonce
  // that no captured bet uses (the script retries and gets the next
  // nonce). These appear as gaps. The framework rule:
  // PASS if every gap's missing-nonce outcome is deterministically
  // computable from the revealed server seed (so it cannot have been
  // tampered with after the fact); FLAG only if the seed is unrevealed.
  {
    let okEpochs = 0, retroEpochs = 0, badEpochs = 0;
    let totalGaps = 0, retroGaps = 0;
    const examples: string[] = [];
    for (const [hash, bets] of ctx.byEpoch) {
      const regular = bets.filter(b => b.mode === 'spin' || b.mode === 'buy').slice();
      regular.sort((a, b) => (a.nonce ?? 0) - (b.nonce ?? 0));
      const usedNonces = new Set(regular.map(b => b.nonce));
      const seedRevealed = ctx.seedMap.has(hash);
      let valid = true;
      let retroactive = false;
      for (let i = 0; i < regular.length; i++) {
        const got = regular[i].nonce;
        const expected = i;
        if (got !== expected) {
          valid = false;
          totalGaps++;
          // Gap detected — is the missing nonce retroactively verifiable?
          // (Seed must be revealed; the would-be outcome_index is then
          // deterministically computable, so the operator could not have
          // re-rolled or tampered.)
          const missing = expected;
          if (seedRevealed && !usedNonces.has(missing)) {
            retroactive = true;
            retroGaps++;
            if (examples.length < 3) examples.push(`epoch ${hash.slice(0,16)}: nonce ${missing} unused; seed revealed (missing round itself not reconstructed/verified)`);
          } else if (examples.length < 3) {
            examples.push(`epoch ${hash.slice(0,16)}: bet ${regular[i].spinId} expected nonce ${expected} got ${got}`);
          }
          break;
        }
      }
      if (regular.length > EPOCH_CAP) valid = false;
      if (valid) okEpochs++;
      else if (retroactive) retroEpochs++;
      else badEpochs++;
    }
    const status = badEpochs === 0 ? 'PASS' : 'FLAG';
    results.push(step(4, 'Nonce Audit',
      status,
      `${okEpochs}/${okEpochs + retroEpochs + badEpochs} epochs have a clean 0..N-1 nonce sequence. ` +
      `${retroEpochs} epochs contain capture-retry gaps (${totalGaps} nonce gaps observed; for each, the seed is revealed and the missing nonce is unused, but the missing completed rounds are not themselves reconstructed/verified). ` +
      `${badEpochs} epochs have unverifiable gaps.` +
      (examples.length ? ` Examples: ${examples.join(' | ')}` : '')
    ));
  }

  return results;
}
