/**
 * Step 33 — Artifact Integrity.
 *
 * Recompute the SHA-256 of every artifact of record and compare it with the pin in
 * src/artifact-pins.ts. A missing or altered artifact is a HARD FAIL, not a flag: the figures in
 * these files are published, and a flag exits 0.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { StepResult } from './context';
import { step, VerifyContext } from './context';
import { ARTIFACT_PINS } from '../../src/artifact-pins';

export function run(ctx: VerifyContext): StepResult[] {
  const outputsDir = (ctx as unknown as { outputsDir?: string }).outputsDir
    ?? path.join(__dirname, '..', '..', 'outputs');

  const notes: string[] = [];
  let bad = 0;

  for (const [file, expected] of Object.entries(ARTIFACT_PINS)) {
    const fp = path.join(outputsDir, file);
    if (!fs.existsSync(fp)) {
      bad++;
      notes.push(`${file} ABSENT — a pinned artifact of record is missing`);
      continue;
    }
    const actual = createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
    if (actual !== expected) {
      bad++;
      notes.push(`${file} sha256 ${actual.slice(0, 16)}\u2026 != pin ${expected.slice(0, 16)}\u2026 — the scored artifact is not the committed one`);
    } else {
      notes.push(`${file} matches its pin`);
    }
  }

  return [step(33, 'Artifact Integrity (pinned artifacts of record)',
    bad === 0 ? 'PASS' : 'FAIL',
    `${Object.keys(ARTIFACT_PINS).length} artifact(s) checked against src/artifact-pins.ts; ` +
    notes.join('; '))];
}
