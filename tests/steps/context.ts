/**
 * Step result shapes + helpers shared across every verifier step.
 *
 * Same convention used by the duel-blackjack / duel-keno / duel-mines
 * audits: each scored step pushes one StepResult; the orchestrator
 * tallies passes/flags/failures at the end.
 */

import type { GVBet, SeedRotation, GVDataset, OperatorConfig } from '../../src/types';
import type { Paytable } from '../../src/paytable';

export type StepStatus = 'PASS' | 'FLAG' | 'FAIL' | 'INFO';

export interface StepResult {
  step:   number;
  name:   string;
  status: StepStatus;
  detail: string;
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

export function step(num: number, name: string, status: StepStatus, detail: string): StepResult {
  const tag =
    status === 'PASS' ? '[PASS]' :
    status === 'FLAG' ? '[FLAG]' :
    status === 'INFO' ? '[INFO]' :
                        '[FAIL]';
  // eslint-disable-next-line no-console
  console.log(`  ${tag} Step ${num} — ${name}`);
  if (status !== 'PASS') {
    // eslint-disable-next-line no-console
    console.log(`         ${detail}`);
  }
  return { step: num, name, status, detail };
}
