/**
 * Step 33 — Artifact Integrity.
 *
 * Recompute the SHA-256 of every artifact of record and compare it with the pin in
 * src/artifact-pins.ts. A missing or altered artifact is a HARD FAIL, not a flag: the figures in
 * these files are published, and a flag exits 0.
 *
 * outputs/verification-results.json is not pinned here — it is this verifier's own output, and
 * the reproduction gate in tests/verify.ts compares it field by field against a fresh run.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { step, type VerifyContext, type StepResult } from './context';
import { ARTIFACT_PINS } from '../../src/artifact-pins';

export function run(ctx: VerifyContext): StepResult[] {
  const outputsDir = ctx.outputsDir;

  const notes: string[] = [];
  const files: { file: string; status: 'match' | 'absent' | 'mismatch' }[] = [];
  let bad = 0;

  for (const [file, expected] of Object.entries(ARTIFACT_PINS)) {
    const fp = path.join(outputsDir, file);
    if (!fs.existsSync(fp)) {
      bad++;
      files.push({ file, status: 'absent' });
      notes.push(`${file} ABSENT — a pinned artifact of record is missing`);
      continue;
    }
    const actual = createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
    if (actual !== expected) {
      bad++;
      files.push({ file, status: 'mismatch' });
      notes.push(`${file} sha256 ${actual.slice(0, 16)}… != pin ${expected.slice(0, 16)}… — the scored artifact is not the committed one`);
    } else {
      files.push({ file, status: 'match' });
      notes.push(`${file} matches its pin`);
    }
  }

  const total = Object.keys(ARTIFACT_PINS).length;
  return [step(33, 'Artifact Integrity (pinned artifacts of record)',
    bad === 0 ? 'PASS' : 'FAIL',
    `${total} artifact(s) checked against src/artifact-pins.ts; ${total - bad} match, ${bad} missing or altered. ` +
    notes.join('; '),
    { checked: total, matched: total - bad, missingOrAltered: bad, files },
  )];
}
