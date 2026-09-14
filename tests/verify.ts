/**
 * Groomer's Van — verification orchestrator.
 *
 * Loads the captured dataset, validates the SHA-256 hash before reading,
 * builds the verification context (seed map, epoch grouping, paytable,
 * config), then runs each scored step in order. Final summary tallies
 * passes/flags/failures and writes outputs/verification-results.json.
 *
 * Run with:  npm run verify
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadDataset,
  loadOperatorConfig,
  buildSeedMap,
  groupByEpoch,
  groupByPhase,
  checkDatasetHash,
} from '../src/loader';
import { loadPaytable } from '../src/paytable';
import * as commitment   from './steps/commitment';
import * as determinism  from './steps/determinism';
import * as payouts      from './steps/payouts';
import * as dataset      from './steps/dataset';
import * as simulation   from './steps/simulation';
import * as gameSpecific from './steps/game-specific';
import * as enumeration  from './steps/enumeration';
import * as artifacts   from './steps/artifacts';
import { type VerifyContext, type StepResult } from './steps/context';

// ── Hash guard runs FIRST, before loading the dataset into memory ─────────────
{
  const r = checkDatasetHash();
  console.log('Dataset hash check:');
  console.log(`  Expected: ${r.expected}`);
  console.log(`  Actual:   ${r.actual}`);
  console.log(`  Status:   ${r.match ? 'MATCH' : 'MISMATCH'}`);
  if (!r.match) {
    console.error('FATAL: dataset has been modified since the hash was pinned. Aborting.');
    process.exit(1);
  }
}

// ── Build context ──────────────────────────────────────────────────────────────
const ds       = loadDataset();
const config   = loadOperatorConfig();
const paytable = loadPaytable();
const seedMap  = buildSeedMap(ds);
const byEpoch  = groupByEpoch(ds.bets);
const byPhase  = groupByPhase(ds.bets);
const outputsDir = path.join(__dirname, '..', 'outputs');
fs.mkdirSync(outputsDir, { recursive: true });

const ctx: VerifyContext = {
  dataset: ds,
  bets:    ds.bets,
  seeds:   ds.seeds,
  config,
  paytable,
  seedMap,
  byEpoch,
  byPhase,
  outputsDir,
};

console.log('');
console.log('==============================================================');
console.log('  GROOMER\'S VAN AUDIT — VERIFICATION SUITE');
console.log('==============================================================');
console.log(`  Dataset: ${ds.bets.length} bets  |  Seeds: ${ds.seeds.length}  |  Revealed: ${seedMap.size}`);
const phaseSummary = Object.entries(byPhase)
  .map(([p, bets]) => `${p}: ${bets.length}`)
  .sort()
  .join('  ');
console.log(`  ${phaseSummary}`);
console.log('');

// ── Run steps ──────────────────────────────────────────────────────────────────
const results: StepResult[] = [
  ...commitment.run(ctx),    // Steps  1– 4
  ...determinism.run(ctx),   // Steps  5– 6
  ...payouts.run(ctx),       // Steps  7– 9
  ...dataset.run(ctx),       // Steps 10–15
  ...simulation.run(ctx),    // Steps 16–18
  ...gameSpecific.run(ctx),  // Steps 19–28
  ...enumeration.run(ctx),   // Steps 29–32 (2³² exhaustive enumeration artifacts + headline RTP)
  ...artifacts.run(ctx),    // Step 33
];

// ── Summary ────────────────────────────────────────────────────────────────────
const passed   = results.filter(r => r.status === 'PASS').length;
const flags    = results.filter(r => r.status === 'FLAG').length;
const failed   = results.filter(r => r.status === 'FAIL').length;
const info     = results.filter(r => r.status === 'INFO').length;
const verdict  = failed > 0
  ? 'NOT PROVABLY FAIR'
  : flags > 0
    ? 'PROVABLY FAIR — Conditional Pass'
    : 'PROVABLY FAIR — Full Pass';

console.log('');
console.log('==============================================================');
console.log('  RESULTS SUMMARY');
console.log('==============================================================');
console.log(`  Passed:     ${passed}/${results.length}`);
console.log(`  Hard fails: ${failed}`);
console.log(`  Flags:      ${flags}`);
console.log(`  Info:       ${info}`);
console.log('');
console.log(`  VERDICT: ${verdict}`);
console.log('==============================================================');

// ── Persist results ────────────────────────────────────────────────────────────
fs.writeFileSync(
  path.join(outputsDir, 'verification-results.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalBets:   ds.bets.length,
    totalSeeds:  ds.seeds.length,
    revealedSeeds: seedMap.size,
    steps: results,
    summary: { passed, flags, failed, info, verdict },
  }, null, 2),
);
console.log('');
console.log(`  Outputs written to: outputs/verification-results.json`);

if (failed > 0) process.exit(1);
