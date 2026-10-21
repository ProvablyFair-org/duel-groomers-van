/**
 * DUEL'S OWN Groomer's Van verification code, vendored and pinned (profile GROOMERS-09).
 *
 * WHAT THIS IS. duel.com → Provably Fair → Verify, game Groomer's Van, shows a JavaScript code panel headed
 * "// Provably Fair Slots Verification (PCG32 PRNG)". It was pulled from https://duel.com/fairness/verify on
 * 2026-05-19 and saved as one JSON string literal to qa-workspace/duel/findings/duel-gv-verify-code.js
 * (qa-workspace/duel/findings/verify-bets-tool-groomers-van.md, "Addendum — Random parity vs
 * duel.com/fairness/verify (2026-05-19, per Mike DM)"); copied byte for byte into this package on 2026-09-26
 * (SHA-256 20fefa7d…, identical to the source file).
 *
 * The runner (verifier-parity/operator/run-operator-verifier.cjs) decodes the literal and runs the code
 * unedited under Node's WebCrypto; both files are pinned below and checked before it runs. Step 5 runs it on
 * every recomputable entry.
 *
 * A SECOND CHECK, NOT THE SOURCE (20 Oct 2026). src/rng.ts is rebuilt from the written spec docs/ALGORITHM.md
 * by an implementer who never opened this code (the spec's per-spin seed step was written from this code by the
 * client's ruling of 20 Oct 2026, and the spec says so); this file runs Duel's code next to it as a second check.
 * The line-citation table src/rng.ts used to carry (OPERATOR_SOURCE_CITES, the operator lines the earlier
 * ported module copied) and its checker checkOperatorCites were removed with that module.
 *
 * Harness adapted from this workshop's video-poker src/operator-verifier.ts (2026-09-26).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

export const PACKAGE_ROOT = path.join(__dirname, '..');
export const OPERATOR_VERIFIER_FILE = 'evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json';
export const OPERATOR_VERIFIER_RUNNER = 'verifier-parity/operator/run-operator-verifier.cjs';

export const OPERATOR_VERIFIER_PINS: Readonly<Record<string, string>> = Object.freeze({
  'evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json': '20fefa7d2ad374b50d9ad83b98f79edff4fc5b34e2bb88706dfde022d31539d2',
  'verifier-parity/operator/run-operator-verifier.cjs':                        '6f9e748c1acfd73a3e14db14369ea9e54e6a8c5c61b8c117cd5b323a80be6c4a',
});

/**
 * THE MULTIPLIER LIST THE CODE IS GIVEN (2026-10-05). The code draws a bonus multiplier value as
 * `multiplierValues[rnd % multiplierValues.length]` (decoded L141–L170) and, as pulled on 2026-05-19, carries
 * `const multiplierValues = null;` (L17): the code as pulled leaves the list empty, so it comes from outside the
 * code. A live check of Duel's Verify page on 2026-10-05 saw the page supply a 200-entry list built from the
 * published weights; that check was not captured into this package. Until 2026-10-05
 * Step 5 fed it the 14 DISTINCT values and recorded that the result matched 32 / 335 served values — a
 * property of that harness input, not of Duel's code. Step 5 now feeds the published weights as a list in
 * which each value appears as many times as its weight, in the config's order (2 ×90, 3 ×25, … 250 ×3:
 * 200 entries), so a uniform pick over the list is the weighted draw, and SCORES the multiplier values.
 * The list is built from the pinned operator config and its bytes are pinned below; a different config,
 * order or builder FAILs Step 5. NOT YET COMPARED with the list the live page injects: that needs the page's
 * code as copied after a run, which this package does not hold.
 */
export function operatorMultiplierList(values: readonly number[], weights: readonly number[]): number[] {
  if (values.length !== weights.length) throw new Error('multiplier values and weights differ in length');
  const out: number[] = [];
  values.forEach((v, i) => { for (let k = 0; k < weights[i]; k++) out.push(v); });
  return out;
}
/** SHA-256 of JSON.stringify(operatorMultiplierList(config values, config weights)) — 200 entries. */
export const OPERATOR_MULTIPLIER_LIST_SHA256 = 'f07398af4e1934e470a8422e83b8df4dedee3b04f5c9db71cffb1c85e1d6eac1';

/** The only thing the code prints when it runs as shipped (its inputs are empty strings). */
export const OPERATOR_EXPECTED_LOGS: readonly string[] = Object.freeze([
  'Please provide valid serverSeed, clientSeed, and nonce (>=0) before running.',
]);

export interface OperatorRound {
  id: string; serverSeed: string; clientSeed: string; nonce: number; roundIndex: number; tumbleIndex: number;
  condition: 'base_game' | 'bonus_game';
}
export interface OperatorResult { outcomeIndex: number; grid: number[][]; multipliers: Array<{ position: number; value: number }> }
export interface OperatorRun {
  files: Array<{ file: string; pinned: string; actual: string | null; match: boolean }>;
  hashesMatch: boolean;
  results: Map<string, OperatorResult | null> | null;
  logs: string[];
  error: string | null;
}
export interface OperatorSettings {
  reelConfigs: Record<string, Array<{ reelIndex: number; symbolWeights: number[] }>>;
  multiplierSymbolIndex: number;
  multiplierValues: number[];
}

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

export const OPERATOR_RUNNER_TIMEOUT_MS = 300_000;
function runPinnedRunner(root: string, input: string): { status: number | null; stdout: string; stderr: string; error?: Error } {
  // Temp files and a hard timeout, not a pipe (the pipe deadlock seen in the blackjack battery).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-operator-runner-'));
  const inPath = path.join(dir, 'jobs.json');
  const outPath = path.join(dir, 'out.json');
  fs.writeFileSync(inPath, input);
  const inFd = fs.openSync(inPath, 'r');
  const outFd = fs.openSync(outPath, 'w');
  try {
    const r = spawnSync(process.execPath, [path.join(root, OPERATOR_VERIFIER_RUNNER), path.join(root, OPERATOR_VERIFIER_FILE)], {
      stdio: [inFd, outFd, 'pipe'], encoding: 'utf8', timeout: OPERATOR_RUNNER_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1 << 24,
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL';
    return {
      status: timedOut ? null : r.status,
      stdout: fs.readFileSync(outPath, 'utf8'),
      stderr: timedOut ? `runner killed after ${OPERATOR_RUNNER_TIMEOUT_MS} ms (hard timeout)` : (r.stderr || ''),
      error: r.error,
    };
  } finally {
    fs.closeSync(inFd); fs.closeSync(outFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function runOperatorVerifier(rounds: OperatorRound[], settings: OperatorSettings, root = PACKAGE_ROOT): OperatorRun {
  const files = Object.entries(OPERATOR_VERIFIER_PINS).map(([file, pinned]) => {
    const p = path.join(root, file);
    const actual = fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
    return { file, pinned, actual, match: actual === pinned };
  });
  const hashesMatch = files.every(f => f.match);
  if (!hashesMatch) return { files, hashesMatch, results: null, logs: [], error: 'operator Verify-tab code or its runner does not match its pinned SHA-256' };
  const r = runPinnedRunner(root, JSON.stringify({ ...settings, rounds }));
  if (r.status !== 0) {
    return { files, hashesMatch, results: null, logs: [],
      error: `operator verifier runner exited ${r.status}: ${(r.stderr || String(r.error || '')).trim().slice(0, 400)}` };
  }
  try {
    const out = JSON.parse(r.stdout) as { logs: string[]; results: Array<{ id: string; outcomeIndex: number | null; grid: number[][] | null; multipliers: Array<{ position: number; value: number }> | null }> };
    const results = new Map<string, OperatorResult | null>();
    for (const x of out.results) results.set(String(x.id), x.grid && x.outcomeIndex !== null ? { outcomeIndex: x.outcomeIndex, grid: x.grid, multipliers: x.multipliers ?? [] } : null);
    return { files, hashesMatch, results, logs: out.logs, error: null };
  } catch (e) {
    return { files, hashesMatch, results: null, logs: [], error: `operator verifier output unreadable: ${(e as Error).message}` };
  }
}
