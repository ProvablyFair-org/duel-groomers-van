/**
 * Step result shapes + helpers shared across every verifier step.
 *
 * Same convention used by the duel-blackjack / duel-keno / duel-mines
 * audits: each scored step pushes one StepResult; the orchestrator
 * tallies passes/flags/failures at the end.
 */

import type { GVBet, SeedRotation, GVDataset, OperatorConfig } from '../../src/types';
import type { Paytable } from '../../src/paytable';

/** INFO: an informational step's deviation (profile policy INFORMATIONAL — the live-sample fit, Mike
 *  2026-09-29): reported, never counted as a flag, never affects the verdict. */
export type StepStatus = 'PASS' | 'FLAG' | 'FAIL' | 'INFO';

export interface StepResult {
  step:   number;
  name:   string;
  status: StepStatus;
  detail: string;
  /**
   * Machine-readable measurements for this step. A measured float belongs here and never
   * inside `detail`: the reproduction gate compares the committed artifact with a fresh run
   * field by field, and a string leaf can only be compared for equality — so a float
   * rendered into prose disagrees forever on any machine whose libm differs by a unit in
   * the last place, which is exactly the reader the gate exists for. `detail` states the
   * BOUND; `data` carries the measurement.
   */
  data?: Record<string, unknown>;
  /**
   * 'capture' marks a FLAG raised by the AUDITOR'S capture (a retried request that left a nonce
   * gap), not by anything the operator served. It is disclosed on every run but is
   * verdict-neutral: the verdict stays Full Pass and the exit status 0. Only an operator-origin
   * FLAG downgrades to Conditional Pass. Same rule as Duel plinko (adopted 2026-09-22).
   */
  origin?: 'capture';
}

export interface InfoItem {
  label:  string;
  detail: string;
}

export interface VerifyContext {
  dataset:    GVDataset;
  bets:       GVBet[];
  seeds:      SeedRotation[];
  config:     OperatorConfig;
  paytable:   Paytable;
  seedMap:    Map<string, string>;       // serverSeedHashed → revealed plaintext
  byEpoch:    Map<string, GVBet[]>;      // grouped by activeAtSpin.server_seed_hashed
  byPhase:    Record<string, GVBet[]>;
  outputsDir: string;
}

export function step(
  num: number,
  name: string,
  status: StepStatus,
  detail: string,
  data?: Record<string, unknown>,
  origin?: 'capture',
): StepResult {
  const tag = status === 'PASS' ? '[PASS]' : status === 'INFO' ? '[INFO]' : status === 'FLAG' ? (origin === 'capture' ? '[FLAG:capture]' : '[FLAG]') : '[FAIL]';
  // eslint-disable-next-line no-console
  console.log(`  ${tag} Step ${num} — ${name}`);
  if (status !== 'PASS') {
    // eslint-disable-next-line no-console
    console.log(`         ${detail}`);
  }
  const r: StepResult = data === undefined
    ? { step: num, name, status, detail }
    : { step: num, name, status, detail, data };
  if (status === 'FLAG' && origin === 'capture') r.origin = 'capture';
  return r;
}
