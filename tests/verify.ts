/**
 * Groomer's Van — verification orchestrator.
 *
 * Loads the captured dataset, validates the SHA-256 hash before reading,
 * builds the verification context (seed map, epoch grouping, paytable,
 * config), then runs each scored step in order. Final summary tallies
 * passes/flags/failures and writes outputs/verification-results.json.
 *
 * Run with:  npm run verify
 * Expected: 34/35 PASS + 1 capture-origin FLAG (Step 4, the four capture-retry nonce gaps),
 * verdict PROVABLY FAIR — Full Pass, exit 0. A capture-origin FLAG is disclosed, verdict-neutral.
 */

import * as fs from 'fs';
import * as path from 'path';
import { labelFor, profileCoverageBlock } from '../src/profile-map';
import { runRtpClaimGate, RTP_CLAIM_STEP } from '../src/rtp-settings';
import { rtpClaimVerdict, RTP_FIGURE_OVERSTATED, RTP_FIGURE_OVERSTATED_EXIT } from '../src/rtp-claim';
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
import * as artifacts    from './steps/artifacts';
import * as maxWin       from './steps/max-win';
import * as liveFit      from './steps/live-fit';
import { type VerifyContext, type StepResult } from './steps/context';
import { fieldDiff, beyondTolerance, maxima, DIFF_ATOL, DIFF_RTOL } from '../src/diff';

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
  ...simulation.run(ctx),    // Steps 16–18 (read outputs/simulation-results.json, pinned in Step 33)
  ...gameSpecific.run(ctx),  // Steps 19–28
  ...enumeration.run(ctx),   // Steps 29–32 (2³² exhaustive enumeration artifacts + headline RTP)
  ...artifacts.run(ctx),     // Step  33    (every artifact of record hashed against src/artifact-pins.ts)
  ...maxWin.run(ctx),        // Step  34    (max-win cap & payout bounds, FLAG-only)
  ...liveFit.run(ctx),       // Step  35    (live-sample fit, informational: INFO on a deviation)
];

// ── RTP-CLAIM rule (1.2.0, Methodology v1.1; 1.0.0 agreed on Slack 2026-09-29) ──
// The per-setting exact RTP table held to the published claim (src/rtp-settings.ts). The package
// switch RTP_CLAIM_RULE_ENFORCED is true (D3, 2026-10-14). Status OVERSTATED (a house-side miss) is
// scored on the step carrying GROOMERS-19 as an operator-origin FLAG (the profile's policy) and the
// verdict becomes RTP FIGURE OVERSTATED, exit 5 (rtpClaimVerdict) — never NOT PROVABLY FAIR: the
// draws themselves pass. Status FAIL means the committed table no longer equals this run (or its
// pin): a reproduction failure, exit 1, whether or not the rule is enforced; no step moves for it.
const rtpClaim = runRtpClaimGate();
console.log('');
for (const line of rtpClaim.lines) console.log(`  ${line}`);
const rtpOverstated = rtpClaim.status === 'OVERSTATED';
if (rtpOverstated) {
  const s = (results as any[]).find(r => r.step === RTP_CLAIM_STEP);
  if (s && s.status !== 'FAIL') {
    s.status = 'FLAG'; delete s.origin;   // operator-origin: this package marks only capture flags
    s.detail += ` — ${RTP_FIGURE_OVERSTATED} (RTP-CLAIM enforced): ${rtpClaim.result.minimalFix}`;
    // The step printed its own line when it ran, before this rule was scored. Print it again at the
    // status it is now counted at, so the console agrees with the summary and the emitted record.
    console.log(`  [FLAG] Step ${s.step} — ${s.name} (re-scored: RTP-CLAIM enforced, ${RTP_FIGURE_OVERSTATED})`);
    console.log(`         ${s.detail}`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────
const passed   = results.filter(r => r.status === 'PASS').length;
const flags    = results.filter(r => r.status === 'FLAG').length;
const failed   = results.filter(r => r.status === 'FAIL').length;
// INFO (profile policy INFORMATIONAL — the live-sample fit, Mike 2026-09-29): reported, never counted
// as a flag, never enters the verdict or the exit code.
const informational = results.filter(r => r.status === 'INFO').length;
// A capture-origin FLAG (an auditor-side capture retry that left a nonce gap) is disclosed but
// verdict-neutral; only an operator-origin FLAG downgrades to Conditional Pass. Same rule as Duel
// plinko (adopted 2026-09-22): not a PASS, but not against the verdict either.
const captureFlags  = results.filter(r => r.status === 'FLAG' && r.origin === 'capture');
const operatorFlags = results.filter(r => r.status === 'FLAG' && r.origin !== 'capture');
// Ranked by the rule's rtpClaimVerdict: a failed draw check (NOT PROVABLY FAIR) > RTP FIGURE
// OVERSTATED > Conditional Pass > Full Pass. This suite has no INCOMPLETE state.
const ruled    = rtpClaimVerdict({ fails: failed, complete: true, overstated: rtpOverstated, opFlags: operatorFlags.length });
const verdict  = ruled.verdict;

console.log('');
console.log('==============================================================');
console.log('  RESULTS SUMMARY');
console.log('==============================================================');
console.log(`  Passed:     ${passed}/${results.length}`);
console.log(`  Hard fails: ${failed}`);
console.log(`  Flags:      ${flags} (${operatorFlags.length} verdict-affecting, ${captureFlags.length} capture-origin)`);
if (informational > 0) console.log(`  Informational deviations: ${informational} (reported, not counted, verdict unchanged)`);
if (captureFlags.length > 0) {
  console.log('');
  console.log('  CAPTURE-ORIGIN LIMITATIONS (disclosed, verdict-neutral):');
  for (const r of captureFlags) console.log(`  ⚑ Step ${r.step}: ${r.name}`);
}
console.log('');
console.log(`  VERDICT: ${verdict}`);
console.log('==============================================================');

// ── Persist results ────────────────────────────────────────────────────────────
// ARTIFACTS OF RECORD CARRY NO RUN METADATA (profile GROOMERS-27). This object carried `generatedAt`
// and the reproduction gate excluded that field by name; since 2026-09-26 it is ABSENT, so no field is
// excluded. Each step also carries the ProvablyFair.org Groomer's Van profile check(s) it implements
// (src/profile-map.ts) — a label on the emitted record only; it cannot change what a step asserts.
const verificationOutput = {
  totalBets:   ds.bets.length,
  totalSeeds:  ds.seeds.length,
  revealedSeeds: seedMap.size,
  steps: results.map(r => ({ ...r, ...labelFor(r.step) })),
  profileCoverage: profileCoverageBlock(),
  summary: { passed, flags, operatorFlags: operatorFlags.length, captureFlags: captureFlags.length, hardFail: failed, verdict },
};

// A VERIFICATION RUN MUST NOT REWRITE THE ARTIFACT IT SCORES. A run that disagrees with the
// committed evidence would otherwise destroy the evidence of the disagreement, and the next run
// would compare the repo against what the failing run had just written. This run writes under
// outputs/run/ — gitignored, a run record rather than audit evidence. The committed copy in
// outputs/ is refreshed only by PF_EMIT=1.
const PF_EMIT = process.env.PF_EMIT === '1';
const RUN_DIR = path.join(outputsDir, 'run');
const RESULTS_DIR = PF_EMIT ? outputsDir : RUN_DIR;
fs.mkdirSync(outputsDir, { recursive: true });
fs.mkdirSync(RUN_DIR, { recursive: true });

fs.writeFileSync(path.join(RESULTS_DIR, 'verification-results.json'), JSON.stringify(verificationOutput, null, 2));

console.log('');
console.log(`  Outputs written to: ${PF_EMIT ? 'outputs' : 'outputs/run'}/verification-results.json`);
if (!PF_EMIT) console.log('  Committed artifact NOT modified.');

// ── Reproduction gate ─────────────────────────────────────────────────────────
// THE GATE IS "BEYOND TOLERANCE", NOT "ANY FIELD". Byte identity is the right bar for exact
// content — the dataset, hash-guarded above. It is the wrong bar for a DERIVED statistic:
// recomputed on other hardware a floating-point figure can move by a unit in the last place.
// Scoring that as a disagreement trains a reader to ignore the diff, which is the one outcome
// that makes it useless. The bound is declared in src/diff.ts, far below the precision of any
// figure this audit publishes; outside it is a DIFFERENT result, and the run exits 1.
let reproductionFailures = 0;
if (!PF_EMIT) {
  const readJsonOrNull = (p: string): unknown => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const targets: { file: string; fresh: unknown }[] = [
    { file: 'verification-results.json', fresh: verificationOutput },
  ];
  // test:full regenerates the Monte Carlo into outputs/run/ (`npm run simulate` without PF_EMIT); when that
  // regeneration is present it is field-diffed against the pinned committed artifact (added 2026-09-26,
  // profile GROOMERS-28). Plain `npm test` does not regenerate it.
  const runSim = readJsonOrNull(path.join(RUN_DIR, 'simulation-results.json'));
  if (runSim !== null) targets.push({ file: 'simulation-results.json', fresh: runSim });
  const perFile = targets.map(t => {
    const committed = readJsonOrNull(path.join(outputsDir, t.file));
    // No field is excluded: run metadata is ABSENT from every artifact, not skipped by the diff.
    const diffs = fieldDiff(committed, t.fresh, []);
    return { file: t.file, readable: committed !== null, diffs, real: beyondTolerance(diffs) };
  });
  const allDiffs  = perFile.flatMap(p => p.diffs);
  const realTotal = perFile.reduce((n, p) => n + p.real.length, 0);
  const gap       = maxima(allDiffs);

  fs.writeFileSync(path.join(RUN_DIR, 'diff.json'), JSON.stringify({
    runtime: process.versions.node,
    verdict,
    tolerance: { atol: DIFF_ATOL, rtol: DIFF_RTOL, rule: '|a-b| <= atol + rtol*max(|a|,|b|); two distinct integers never agree' },
    reproduced: realTotal === 0,
    beyondToleranceCount: realTotal,
    withinToleranceCount: allDiffs.length - realTotal,
    largestGap: gap,
    note: 'Field-level diff between the COMMITTED artifact and THIS RUN. No field is excluded: the '
      + 'artifact of record carries no run metadata. Entries marked `withinTolerance` are the '
      + 'same result computed on different hardware and are recorded, not scored. Any entry NOT '
      + 'so marked means this run disagrees with the committed evidence — investigate it; do not '
      + 're-run until it goes away, and do not regenerate the committed artifact to make it go away.',
    files: perFile.map(p => ({ file: `outputs/${p.file}`, committedReadable: p.readable, differences: p.diffs })),
  }, null, 2));

  console.log(`  Reproduction vs the committed artifact on Node ${process.versions.node}: `
    + `${realTotal === 0 ? 'REPRODUCED' : `${realTotal} field(s) BEYOND TOLERANCE`}`
    + `${allDiffs.length - realTotal > 0 ? ` (${allDiffs.length - realTotal} within tolerance` + (gap ? `, largest ${gap.absDiff.toExponential(2)} at ${gap.path}` : '') + ')' : ''}`);
  console.log(`  Diff written to: outputs/run/diff.json`);
  if (realTotal > 0) {
    console.log('  ⚠ THIS RUN DISAGREES WITH THE COMMITTED EVIDENCE:');
    for (const p of perFile) {
      if (!p.readable) { console.log(`      outputs/${p.file}: committed copy absent or unreadable`); continue; }
      for (const d of p.real.slice(0, 4)) {
        console.log(`      ${p.file} ${d.path}: committed ${JSON.stringify(d.committed)} vs this run ${JSON.stringify(d.thisRun)}`);
      }
    }
  }
  reproductionFailures = realTotal;
} else {
  console.log('  REPORT GENERATION (PF_EMIT=1): the committed artifact in outputs/ was rewritten.');
}

// ── Exit contract ─────────────────────────────────────────────────────────────
// FAIL -> 1, RTP FIGURE OVERSTATED -> 5, operator-origin FLAG -> 2, otherwise 0, so an automated
// caller reads the verdict from the exit status. A reproduction beyond tolerance is a FAIL, not a
// warning: a gate that only prints is not a gate.
if (failed > 0 || reproductionFailures > 0 || !rtpClaim.tableMatches) process.exit(1);
if (ruled.exit === RTP_FIGURE_OVERSTATED_EXIT) process.exit(RTP_FIGURE_OVERSTATED_EXIT);
if (operatorFlags.length > 0) process.exit(2);
// A capture-origin FLAG is disclosed but verdict-neutral: exit 0, so npm test stays green.
