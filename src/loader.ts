/**
 * Dataset loader for the Groomer's Van audit.
 *
 * Pinned SHA-256 of `data/groomers-van-smoke-test-1778204681017.json`.
 * Verify scripts must call `checkDatasetHash()` BEFORE `loadDataset()`
 * and abort with `process.exit(1)` on mismatch — otherwise the test
 * suite could silently run against a swapped-out dataset.
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import type { GVDataset, GVBet, SeedRotation, OperatorConfig } from './types';

const DATA_DIR     = path.join(__dirname, '..', 'data');
const DATASET_FILE = 'groomers-van-smoke-test-1778204681017.json';
const DATASET_PATH = path.join(DATA_DIR, DATASET_FILE);
const DATASET_PATH_GZ = `${DATASET_PATH}.gz`;

// Pinned SHA-256 of the UNCOMPRESSED dataset bytes. Hashing the raw
// JSON bytes (not the .gz envelope) so the hash is stable whether you
// have the .json or the .json.gz on disk.
export const EXPECTED_HASH = '3034cb1284bc1a87d82a0d8f914b19d7f1a8f16894ffe601242bd29e3873b967';

export function getDatasetPath(): string {
  return fs.existsSync(DATASET_PATH) ? DATASET_PATH : DATASET_PATH_GZ;
}

/** Read the uncompressed dataset bytes, transparently un-gzipping if needed. */
function readDatasetBytes(): Buffer {
  if (fs.existsSync(DATASET_PATH))    return fs.readFileSync(DATASET_PATH);
  if (fs.existsSync(DATASET_PATH_GZ)) return zlib.gunzipSync(fs.readFileSync(DATASET_PATH_GZ));
  throw new Error(`Dataset not found at ${DATASET_PATH} or ${DATASET_PATH_GZ}`);
}

// ── Hash guard ──────────────────────────────────────────────────────────────

export function computeDatasetHash(): string {
  return crypto.createHash('sha256').update(readDatasetBytes()).digest('hex');
}

export function checkDatasetHash(): { expected: string; actual: string; match: boolean } {
  const actual = computeDatasetHash();
  return { expected: EXPECTED_HASH, actual, match: actual === EXPECTED_HASH };
}

// ── Dataset load ────────────────────────────────────────────────────────────

export function loadDataset(): GVDataset {
  return JSON.parse(readDatasetBytes().toString('utf-8')) as GVDataset;
}

// ── Operator config (paytable, weights, scaling-edge) ───────────────────────

const CONFIG_PATH = path.join(DATA_DIR, 'raw', 'groomers-van-config-v1.4.json');

export function loadOperatorConfig(): OperatorConfig {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as OperatorConfig;
}

// ── Seed-map: serverSeedHashed → revealed plaintext ─────────────────────────

/**
 * Walk the `bets[]` array (preferred — every bet's verifyData carries
 * the revealed seed once the next rotation reveals it) and the
 * `seeds[]` array (rotation events with prev-epoch reveals) to assemble
 * the full O(1) lookup. Verify SHA-256 before accepting any pair.
 *
 * After build, every captured bet's `activeAtSpin.server_seed_hashed`
 * should resolve to a plaintext seed (only the post-final-rotation
 * seed remains unrevealed; no bets used it).
 */
export function buildSeedMap(dataset: GVDataset): Map<string, string> {
  const m = new Map<string, string>();

  function tryAdd(hashed: string | null | undefined, plain: string | null | undefined): void {
    if (!hashed || !plain || m.has(hashed)) return;
    const sha = crypto.createHash('sha256').update(Buffer.from(plain, 'hex')).digest('hex');
    if (sha === hashed) m.set(hashed, plain);
  }

  // Source 1: every bet's verifyData (when present) carries the revealed
  // server_seed for that bet's epoch. Most reliable when triggers exist.
  for (const b of dataset.bets) {
    const vd = b.verifyData;
    if (vd?.server_seed && vd?.server_seed_hash) {
      tryAdd(vd.server_seed_hash, vd.server_seed);
    }
  }

  // Source 2: rotation entries — each `prevSpinSeedRevealed` is the
  // revealed seed of the epoch that just closed. Pair it with the
  // serverSeedHashed of any prior seed entry whose hash matches.
  for (let i = 0; i < dataset.seeds.length; i++) {
    const s = dataset.seeds[i];
    const revealed = s.prevSpinSeedRevealed || null;
    if (!revealed) continue;
    const sha = crypto.createHash('sha256').update(Buffer.from(revealed, 'hex')).digest('hex');
    // Find the seed entry whose serverSeedHashed equals sha (the active hash
    // when prevSpinId was placed). That entry's seed is now revealed.
    for (let j = 0; j < dataset.seeds.length; j++) {
      if (dataset.seeds[j].seed.serverSeedHashed === sha && !m.has(sha)) {
        m.set(sha, revealed);
        break;
      }
    }
  }

  // Source 3: rotation entry's verified[] block — /verify response per
  // trigger spin returns the full revealed seed for that feature session.
  for (const s of dataset.seeds) {
    for (const v of s.verified ?? []) {
      tryAdd(v.serverSeedHashed, v.serverSeed);
    }
  }

  return m;
}

// ── Phase grouping ──────────────────────────────────────────────────────────

export function groupByPhase(bets: GVBet[]): Record<string, GVBet[]> {
  const out: Record<string, GVBet[]> = {};
  for (const b of bets) {
    (out[b.phase] ??= []).push(b);
  }
  return out;
}

// ── Epoch grouping (by active server_seed_hashed) ──────────────────────────

export function groupByEpoch(bets: GVBet[]): Map<string, GVBet[]> {
  const m = new Map<string, GVBet[]>();
  for (const b of bets) {
    const h = b.activeAtSpin.server_seed_hashed;
    const arr = m.get(h) ?? [];
    arr.push(b);
    m.set(h, arr);
  }
  return m;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Bets where a base_game spin or buy actively triggered a feature. */
export function triggerBets(bets: GVBet[]): GVBet[] {
  return bets.filter(b => b.response.feature_triggered);
}

/** Free spins played out from a feature session. */
export function freeSpinBets(bets: GVBet[]): GVBet[] {
  return bets.filter(b => b.mode === 'free_spin');
}
