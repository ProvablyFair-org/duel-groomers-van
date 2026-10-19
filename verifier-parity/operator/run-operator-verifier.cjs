#!/usr/bin/env node
'use strict';
/**
 * Runs DUEL'S OWN Groomer's Van verification code — the JavaScript shown in the code panel of
 * duel.com → Provably Fair → Verify (game: Groomer's Van), "Provably Fair Slots Verification (PCG32 PRNG)"
 * — on a batch of spins.
 *
 *   node run-operator-verifier.cjs <captured-file>        jobs as JSON on stdin → JSON on stdout
 *
 * jobs: { reelConfigs: { base_game: [...], bonus_game: [...] }, multiplierSymbolIndex, multiplierValues,
 *         rounds: [{ id, serverSeed, clientSeed, nonce, roundIndex, tumbleIndex, condition }] }
 *
 * WHAT RUNS. evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json, whose SHA-256 is
 * pinned in src/operator-verifier.ts and checked by the caller before this runner starts. The capture saved
 * the code panel as ONE JSON string literal; the single transformation made here is JSON.parse of that
 * literal, which recovers the panel text exactly; not one character of the decoded code is rewritten. It is
 * plain script, so it is evaluated with node:vm inside a function wrapper.
 *
 * WHAT IS NOT DUEL'S CODE (the whole harness surface):
 *   1. the wrapper `(function (crypto, TextEncoder, console) { <code> ; return { … }; })` — `crypto` is
 *      Node's WebCrypto (the W3C API the page uses), `TextEncoder` is Node's, `console` is a recorder. The
 *      code's own top level runs with its empty inputs and logs its "Please provide valid …" line.
 *   2. the calls, per spin, to the file's own functions in the order its verifySlotsResult uses them:
 *      generateOutcomeIndex → deriveTumbleSeed → new Pcg32 → generateGridFromPrng(prng, 6, 5,
 *      { reelConfigs }) → generateMultipliersForGrid (bonus condition only). The reel configs are the
 *      operator config's weights (weights.symbol_distributions_by_condition in
 *      data/raw/groomers-van-config-v1.4.json), which the player pastes into the page's Symbol Weights field
 *      (Duel's Verify page as checked on 2026-10-05; that capture, E05, is not held). The multiplier list is
 *      the caller's (Step 5: the published weights as a 200-entry list).
 * Exit 0 with JSON; exit 1 if the file will not evaluate or does not define those names.
 */
const vm = require('vm');
const fs = require('fs');

function fail(msg) { process.stderr.write(`operator verifier: ${msg}\n`); process.exit(1); }

const file = process.argv[2];
if (!file) fail('usage: run-operator-verifier.cjs <captured-file>');
let src;
try { src = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`captured file is not a JSON string literal: ${e.message}`); }
if (typeof src !== 'string') fail('captured file does not decode to a string');
const jobs = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!jobs || !Array.isArray(jobs.rounds)) fail('jobs must be { rounds: [...] }');

const logs = [];
const recorder = { log: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => logs.push(a.map(String).join(' ')) };

let mod;
try {
  const wrapped = `(function (crypto, TextEncoder, console) {\n${src}\n;return { Pcg32, generateOutcomeIndex, deriveTumbleSeed, generateGridFromPrng, generateMultipliersForGrid };\n})`;
  mod = vm.runInThisContext(wrapped, { filename: file })(globalThis.crypto, TextEncoder, recorder);
} catch (e) { fail(`file did not evaluate: ${e.message}`); }
for (const k of ['Pcg32', 'generateOutcomeIndex', 'deriveTumbleSeed', 'generateGridFromPrng', 'generateMultipliersForGrid']) {
  if (typeof mod[k] !== 'function') fail(`file does not define ${k}`);
}

(async () => {
  const results = [];
  const BATCH = 100;
  for (let i = 0; i < jobs.rounds.length; i += BATCH) {
    const slice = jobs.rounds.slice(i, i + BATCH);
    const out = await Promise.all(slice.map(async r => {
      try {
        const outcomeIndex = await mod.generateOutcomeIndex(r.serverSeed, r.clientSeed, Number(r.nonce));
        const tumbleSeed = mod.deriveTumbleSeed(outcomeIndex, Number(r.roundIndex), Number(r.tumbleIndex));
        const prng = new mod.Pcg32(tumbleSeed);
        const grid = mod.generateGridFromPrng(prng, 6, 5, { reelConfigs: jobs.reelConfigs[r.condition] });
        const multipliers = r.condition === 'bonus_game'
          ? mod.generateMultipliersForGrid(grid, 6, 5, prng, { multiplierSymbolIndex: jobs.multiplierSymbolIndex, multiplierValues: jobs.multiplierValues })
          : [];
        return { id: r.id, outcomeIndex, grid, multipliers };
      } catch (e) { return { id: r.id, outcomeIndex: null, grid: null, multipliers: null, error: e.message }; }
    }));
    results.push(...out);
  }
  await new Promise(r => setImmediate(r));
  process.stdout.write(JSON.stringify({ logs, results }));
})().catch(e => fail(e.message));
