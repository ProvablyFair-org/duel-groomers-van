#!/usr/bin/env node
/**
 * Duel Groomer's Van — generator for RELEASE-MANIFEST.json.
 *
 * Same generator as games/plinko/scripts/release-manifest.mjs, adapted only in its paths and declared
 * facts. NOTHING MEASURABLE IS TYPED: artifact hashes are computed from the bytes on disk; the verdict
 * and scored counts are read out of outputs/verification-results.json; the capture window comes from
 * the dataset itself. What stays typed is the set of facts no file supplies (the audit's identity, the
 * release, the environment, the last mutation-battery result, measured wall time) — those are DECLARED,
 * and a change to one is a visible source edit.
 *
 * Usage:
 *   node scripts/release-manifest.mjs            write RELEASE-MANIFEST.json
 *   node scripts/release-manifest.mjs --check     exit 1 if the committed file is stale or missing
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'RELEASE-MANIFEST.json');
const CHECK = process.argv.includes('--check');

/** The facts no file in this package can supply. `signature` stays null until actually signed. */
const DECLARED = {
  auditId: 'PF-2026-DL10',
  game: 'groomers-van',
  casino: 'duel',
  release: 'v1.2.1',
  framework: '1.1',
  environmentHost: 'duel.com',
  environmentStage: 'production',
  environmentQualifier: null,
  supersedes: 'v1.2.0',
  signature: 'SHA256:gEujiJm2pRyq7lQsfYQfQ1r97H/J7GdaKHbOW8GtikY',
  pending: '',
};

/** How Pass 1 is seeded and attested — described as the package declares it (its src/ and MANIFEST.md). */
const SIMULATION = {
  seeding: 'pinned',
  seedSource: "src/simulate.ts MASTER_SEED 'pf-audit-groomers-van-v1' (PRNG seed = HMAC-SHA256(masterSeed, 'groomers-van-pass1'))",
  attestation: 'npm test scores the committed, pinned outputs/simulation-results.json (Steps 16-18) and does not regenerate it; npm run test:full regenerates the Monte Carlo into outputs/run/ and the verifier field-diffs it against the committed artifact at the reproduction tolerance (outputs/run/diff.json)',
};

/** The dataset of record; its sha256 is also listed under artifacts. */
const DATASET = 'data/groomers-van-smoke-test-1778204681017.json.gz';
/** The dataset ships gzipped (the uncompressed JSON is 334 MB, over GitHub's file limit). The audit's dataset
 * pin (src/loader.ts EXPECTED_HASH) is over the UNCOMPRESSED bytes, so datasetSha256 is that hash; the .gz
 * file's own hash is listed under artifacts. */
const readDatasetBytes = () => { const a = path.join(ROOT, DATASET); return fs.existsSync(a) ? gunzipSync(fs.readFileSync(a)) : null; };

/** Every file whose bytes the release is a claim about: the dataset, the pinned config (if any) and
 * every artifact src/artifact-pins.ts pins. Order is the manifest's order. */
const ARTIFACTS = [
  DATASET,
  // operator artifacts of record pinned in src/loader.ts RAW_FILE_PINS
  'data/raw/client-seed-snapshot.json',
  'data/raw/groomers-van-config-v1.4.json',
  'data/raw/paytable-extracted-from-help.json',
  'data/raw/paytable-from-rules-endpoint.json',
  'data/raw/spin-1835724-request.json',
  'data/raw/spin-1835724-response.json',
  'data/raw/spin-1835725-request.json',
  'data/raw/spin-1835725-response.json',
  // the duel.com config as fetched 2026-10-05 in a logged-in session (read-only GET): the two response bodies are
  // pinned in RAW_FILE_PINS too; the .meta.json fetch records (path, status, headers, fetched_utc) only here
  'data/raw/slots-2026-10-05.json',
  'data/raw/slots-2026-10-05.json.meta.json',
  'data/raw/slots-groomers-van-rules-2026-10-05.json',
  'data/raw/slots-groomers-van-rules-2026-10-05.json.meta.json',
  // every artifact src/artifact-pins.ts pins
  'outputs/base-2pow32.json',
  'outputs/bonus-2pow32-uncapped.json',
  'outputs/bonus-2pow32.json',
  'outputs/bonus-session-ev-exact-10.json',
  'outputs/bonus-session-ev-exact-12.json',
  'outputs/bonus-session-ev-exact-14.json',
  'outputs/bonus-session-ev-exact-8.json',
  'outputs/bonus-session-ev-exact.json',
  'outputs/bonus-session-ev.json',
  'outputs/cpu-base-2pow32.json',
  'outputs/cpu-bonus-2pow32.json',
  'outputs/rtp-convergence.html',
  'outputs/simulation-results.json',
  'outputs/verification-results.json',
  'outputs/rtp-claim-table.json',   // RTP-CLAIM per-setting table (src/rtp-settings.ts pins it)
];

/** The capture window, read from the dataset's own fields (never typed): the earliest and latest
 * bets[].startedAt (the dataset meta carries only capturedAt, the close of the capture). */
function captureWindow(dataset) {
  const t = (dataset?.bets ?? []).map((b) => b.startedAt).filter((x) => typeof x === 'string').sort();
  return { from: t[0] ?? null, to: t[t.length - 1] ?? null };
}

/** The falsifiability battery. `mutations` is computed from the registry; the RUN RESULT is DECLARED
 * from the last completed `npm run mutate` (cite it in `source`) and must be refreshed by re-running
 * the battery — a generator never asserts a kill it did not run. null = not run for this manifest. */
const FALSIFIABILITY_DECLARED = { killed: 51, scoredStepsCovered: '35/35', declaredSurvivors: 0, source: 'npm run mutate 2026-10-20, the whole registry (51 entries; M05g retired with the src/rng.ts citation table, M05e retargeted to the clean-room acceptedDraw) in one run on the clean-room tree (Apple M2 Max, 12 cores, node v22.23.1): "51/51 mutations killed", "35/35 scored steps have a mutation that kills them"' };

/** How long `npm test` takes, and on what — a property of the machine, so DECLARED from measured runs. */
const RUNTIME = {
  command: 'npm test',
  measured: [
    { date: '2026-09-28', machine: 'Apple M2 Max', cores: 12, node: '22.23.1', wallSeconds: 3.737, by: 'time npm test' },
  ],
};

const AUDIT_ID_DOCS = ['README.md', 'MANIFEST.md'];

const problems = [];
const fail = (m) => problems.push(m);
const abs = (rel) => path.join(ROOT, rel);
const sha256 = (rel) => { const a = abs(rel); if (!fs.existsSync(a)) { fail(`${rel} is missing`); return null; } return createHash('sha256').update(fs.readFileSync(a)).digest('hex'); };
const readJson = (rel) => { const a = abs(rel); if (!fs.existsSync(a)) { fail(`${rel} is missing`); return null; } try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { fail(`${rel} invalid JSON: ${e.message}`); return null; } };

const results = readJson('outputs/verification-results.json');
const datasetBytes = readDatasetBytes();
if (!datasetBytes) fail(`${DATASET} is missing`);
let dataset = null;
try { dataset = datasetBytes ? JSON.parse(datasetBytes.toString('utf8')) : null; } catch (e) { fail(`${DATASET} invalid JSON: ${e.message}`); }
const mutations = fs.existsSync(abs('tests/mutations.json')) ? readJson('tests/mutations.json') : null;

const artifacts = {};
for (const rel of ARTIFACTS) { const h = sha256(rel); if (h) artifacts[rel] = h; }

// One summary shape across the Duel packages (Mike 2026-09-28, F20):
// { passed, flags, operatorFlags, captureFlags, hardFail, verdict }.
const summary = results?.summary ?? {};
const verdict = summary.verdict;
const scored = {
  passed: summary.passed,
  flags: summary.flags,
  operatorFlags: summary.operatorFlags,
  captureFlags: summary.captureFlags,
  hardFail: summary.hardFail,
};
for (const k of Object.keys(scored)) if (typeof scored[k] !== 'number') fail(`verification-results.json summary.${k} is not a number — the summary is not in the one Duel shape`);
scored.of = [scored.passed, scored.flags, scored.hardFail].every((n) => typeof n === 'number') ? scored.passed + scored.flags + scored.hardFail : undefined;
if (typeof verdict !== 'string' || !verdict) fail('verification-results.json has no summary.verdict — run npm test first');
if (scored.hardFail !== 0) fail(`the committed run has hardFail=${scored.hardFail} — a release manifest may only describe a run with no hard failures`);
if (typeof scored.flags === 'number' && scored.flags !== scored.operatorFlags + scored.captureFlags) fail(`summary.flags ${scored.flags} != operatorFlags + captureFlags`);

const capturedAt = captureWindow(dataset);
if (!capturedAt.from || !capturedAt.to) fail('the dataset does not yield a capture window (from / to)');

if (DECLARED.auditId) {
  for (const doc of AUDIT_ID_DOCS) { const a = abs(doc); if (!fs.existsSync(a)) { fail(`${doc} is missing`); continue; } if (!fs.readFileSync(a, 'utf8').includes(DECLARED.auditId)) fail(`${doc} does not carry the declared audit ID ${DECLARED.auditId}`); }
}
if (!fs.existsSync(abs('LICENSE'))) fail('LICENSE is missing');

const manifest = {
  auditId: DECLARED.auditId,
  game: DECLARED.game,
  casino: DECLARED.casino,
  release: DECLARED.release,
  framework: DECLARED.framework,
  simulation: SIMULATION,
  runtime: RUNTIME,
  datasetSha256: datasetBytes ? createHash('sha256').update(datasetBytes).digest('hex') : null,
  artifacts,
  verdict,
  scored,
  capturedAt,
  environment: { host: DECLARED.environmentHost, stage: DECLARED.environmentStage, qualifier: DECLARED.environmentQualifier },
  supersedes: DECLARED.supersedes,
  signature: DECLARED.signature,
  falsifiability: {
    registry: mutations ? 'tests/mutations.json' : null,
    runner: fs.existsSync(abs('scripts/mutate.mjs')) ? 'scripts/mutate.mjs' : null,
    mutations: Array.isArray(mutations) ? mutations.length : (Array.isArray(mutations?.mutations) ? mutations.mutations.length : null),
    killed: FALSIFIABILITY_DECLARED.killed,
    scoredStepsCovered: FALSIFIABILITY_DECLARED.scoredStepsCovered,
    declaredSurvivors: FALSIFIABILITY_DECLARED.declaredSurvivors,
    source: FALSIFIABILITY_DECLARED.source,
  },
  pending: DECLARED.pending,
};

if (problems.length) { console.error('  [release-manifest] cannot produce a manifest:'); for (const p of problems) console.error(`    - ${p}`); process.exit(1); }

const rendered = `${JSON.stringify(manifest, null, 2)}\n`;

if (CHECK) {
  if (!fs.existsSync(MANIFEST_PATH)) { console.error('  [release-manifest] RELEASE-MANIFEST.json missing — run npm run release-manifest'); process.exit(1); }
  if (fs.readFileSync(MANIFEST_PATH, 'utf8') !== rendered) { console.error('  [release-manifest] RELEASE-MANIFEST.json is STALE — regenerate with npm run release-manifest'); process.exit(1); }
  console.log(`  [release-manifest] OK: ${Object.keys(artifacts).length} artifact hashes match disk, verdict "${verdict}", scored ${scored.passed}/${scored.of} (flags ${scored.flags})`);
  process.exit(0);
}
fs.writeFileSync(MANIFEST_PATH, rendered);
console.log(`  [release-manifest] wrote RELEASE-MANIFEST.json — ${Object.keys(artifacts).length} artifacts, verdict "${verdict}", scored ${scored.passed}/${scored.of} (flags ${scored.flags})`);
