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
// Pinned to the REDACTED dataset that shipped publicly (v1.0.0): the capture's `events[]` array of
// raw HTTP records carried session-scoped `security_token` values and was emptied before publication
// (meta.eventsRedacted records the count, reason and date). No verifier step reads `events`, so the
// scored population is unchanged. The pre-redaction capture hashed 9f6d854e…ef65.
export const EXPECTED_HASH = '3034cb1284bc1a87d82a0d8f914b19d7f1a8f16894ffe601242bd29e3873b967';

// ── POPULATION OF RECORD ──────────────────────────────────────────────────────
// The capture plan stated as CODE, next to the dataset pin, so the scored steps have
// something to check the data against that the data does not control. The file carries
// its own plan in meta.phasesRun; reconciling against that would prove nothing, because
// deleting bets and editing the header together leaves a file that is internally
// consistent and re-pins cleanly — and re-pinning is what a forger does. Anything scored
// against these numbers has to fail hard when they disagree.
export const EXPECTED_BETS = 6225;
/** Regular (non-free-spin) entries: 5,730 base/bonus spins + 20 bonus buys. */
export const EXPECTED_REGULAR_BETS   = 5750;
export const EXPECTED_FREE_SPIN_BETS = 475;
export const EXPECTED_PHASE_BETS: Readonly<Record<string, number>> =
  Object.freeze({ A: 5248, B: 30, C: 223, D: 524, E: 200 });
export const EXPECTED_MODE_BETS: Readonly<Record<string, number>> =
  Object.freeze({ spin: 5730, free_spin: 475, buy: 20 });

// 117 rotation records. 116 carry a revealed plaintext; the 117th is the seed that was
// still active when the capture closed, and no captured bet was served under it — so 116
// is the number of commitments this dataset can actually open, and the number of epochs.
export const EXPECTED_SEED_RECORDS   = 117;
export const EXPECTED_REVEALED_SEEDS = 116;
export const EXPECTED_SEED_LINKS     = 116;
export const EXPECTED_EPOCHS         = 116;

// The capture rotated the seed after every 50 regular bets (its own schedule, not a tested Duel
// limit), so epochs run to 50. Two are short and both are phase close-outs:
// one of 30 regular bets and one of 20. Declaring the exceptions by size is what makes the
// step fail on a uniform shrink — "no epoch exceeds 50" does not.
export const EXPECTED_EPOCH_SIZE = 50;
export const EXPECTED_SHORT_EPOCH_SIZES: readonly number[] = Object.freeze([20, 30]);

// Phase D rotates a fresh auditor-supplied client seed every 50 spins.
export const PHASE_D_SEED_COUNT     = 10;
export const PHASE_D_BETS_PER_SEED  = 50;

// Cluster pays: a payout cell is (condition, symbol, cluster-size tier). The published
// paytable has 96 of them across base_game and bonus_game. Live play is not expected to
// reach every one — the theoretical return comes from the exhaustive 2^32 enumeration,
// not from live play — so the floor is set at the share live play actually reached, and
// the cells it never reached are named rather than left implicit.
export const MIN_PAYTABLE_CELLS_EXERCISED = 55;

// ── SCORED POPULATIONS (measured 2026-09-23 on the pinned dataset 3034cb12…) ─────────────────
// Each scored step below counts what it actually examined and FAILS when that count is not the
// number here. Before these existed, a step that examined nothing — an emptied rounds[] array, a
// deleted paylines block, a dataset with the buys removed — reported "0/0 … 0 mismatched" and
// PASSED. A forger who edits the dataset and re-pins its hash is exactly the case the hash pin
// cannot see, so the populations have to be asserted from code the dataset does not control.
/** Non-buy entries (5,730 spins + 475 free spins): every one is grid-recomputable (Steps 5, 7). */
export const EXPECTED_NON_BUY_BETS = 6205;
/** Paylines of every kind across the non-buy entries (Step 8). */
export const EXPECTED_PAYLINES = 4985;
/** Cluster paylines on regular, tumble and bonus_game rounds of non-buy entries (Step 19). */
export const EXPECTED_CLUSTER_PAYLINES = 4982;
/** Cascade rounds (round index ≥ 1) across non-buy entries — the population Step 28 also replays (Step 20). */
export const EXPECTED_CASCADE_ROUNDS = 4323;
/** Non-tumble rounds with ≥ 2 distinct paying cluster symbols AND ≥ 1 wild on the grid (Step 21). */
export const EXPECTED_SHARED_WILD_ROUNDS = 410;
/** Feature sessions: 33 organic triggers + 20 bonus buys (Steps 22, 23). */
export const EXPECTED_BONUS_SESSIONS = 53;
/** Multiplier-symbol cells seen on bonus-condition grids, every one carrying a value (Step 27). */
export const EXPECTED_BONUS_MULTIPLIER_CELLS = 935;
/**
 * Capture-retry nonce gaps (Step 4) — BOUND BY IDENTITY since 2026-09-26: one unused nonce in each of
 * four epochs, named by full server-seed hash and nonce. Every other epoch is a clean 0..N-1 run. A gap
 * anywhere else, a moved gap, or one gap fewer is a FAIL. A property of the capture, disclosed as a
 * capture-origin FLAG by Step 4 (decision-13: never an operator finding).
 *
 * CORRECTED 2026-09-26. Until today this list named nonces 48, 23 and 10 in three of the epochs. Those
 * were the nonces the capture's pre-bet snapshot had NOT recorded — but they are exactly the nonces three
 * captured bets were actually served at (CAPTURE_NONCE_CORRECTIONS below): the snapshot recorded n, a
 * retried request had consumed n, and the bet that reached the capture was served at n + 1. So the round
 * that was never captured is at n (47, 22, 9), and the "reconstructed" outcome Step 4 printed for 48 / 23 /
 * 10 was in fact the outcome of a captured bet. Measured on the pinned dataset: each of the three bets
 * reproduces its 30-cell grid at n + 1 and NOT at n.
 *
 * CORRECTED AGAIN 2026-10-04 (the fourth epoch, 22f48a0f…). Spin 1974625 is recorded at nonce 2 but its own
 * verify record says nonce 3, and its grid reproduces at 3 and NOT at 2 (measured on the pinned dataset).
 * Step 5 used to take a verify payload's nonce without checking the recorded one, so this fourth
 * correction was missed on 2026-09-26 and the gap was named at 3 — the nonce 1974625 was served at. The
 * round that was never captured is at 2 (outcome index 4089378259). All four bets are now in
 * CAPTURE_NONCE_CORRECTIONS.
 */
export const EXPECTED_NONCE_GAPS: readonly { epochHash: string; nonce: number }[] = Object.freeze([
  { epochHash: 'd6bebb438befe8fbed71330f892e2fa74e1e5c4211194a554049c3355631e405', nonce: 47 },
  { epochHash: '22f48a0f53065c9ccefbf65ee00bfb9a86d9bbfd8ae3a6bc52078b49bddfc42e', nonce: 2 },
  { epochHash: '77544e55cb2fdf56d555fdc2aafe690a3f50253979c247568f34c27ad49bba61', nonce: 22 },
  { epochHash: '3052a819eb48435100abf5cf5a51cec05b51c41056c790f516d9f70fc36f5500', nonce: 9 },
]);
export const EXPECTED_CAPTURE_RETRY_GAPS = EXPECTED_NONCE_GAPS.length;

/**
 * THE FOUR RECORDED-NONCE CORRECTIONS (three on 2026-09-26, 1974625 on 2026-10-04). The capture records a
 * bet's nonce from a snapshot taken BEFORE the /spin call (activeAtSpin.nonce). On four bets a retried
 * request consumed that nonce first, so the bet was served at recorded + 1: each one's grid reproduces 30/30
 * at `served` and not at `recorded`, and in each epoch `served` is otherwise unused while `recorded` is the
 * lost round (EXPECTED_NONCE_GAPS). Steps 4, 5, 9 and 28 use `served` for exactly these four spin ids —
 * bound by id, no ±1 search — and Step 5 FAILs if the grid reproduces at `recorded` or not at `served`.
 * 1974625 is the one that carries a verify payload (it triggered a bonus); its payload nonce is 3, and
 * Step 5 now requires every base spin's payload nonce to equal its served nonce.
 */
export const CAPTURE_NONCE_CORRECTIONS: readonly { spinId: number; recorded: number; served: number }[] = Object.freeze([
  { spinId: 1965523, recorded: 47, served: 48 },
  { spinId: 1974625, recorded: 2,  served: 3 },
  { spinId: 1976463, recorded: 22, served: 23 },
  { spinId: 1987633, recorded: 9,  served: 10 },
]);

/** The nonce a regular bet was served at: its recorded nonce, or the declared correction for its spin id. */
export function servedNonce(b: { spinId: number; nonce: number | null }): number | null {
  const c = CAPTURE_NONCE_CORRECTIONS.find(x => x.spinId === b.spinId);
  return c ? c.served : b.nonce;
}
/**
 * Entries carrying an operator /verify payload WITH a seed pair and a published outcome_index
 * (Step 6). 643 entries carry a payload; the other 20 are the bonus buys, whose payload holds
 * only `_verify_session`.
 */
export const EXPECTED_VERIFY_PAYLOAD_BETS = 623;
/**
 * Epochs Pass 2 of the simulator replays (Step 18): epochs holding at least one base_game spin.
 * One of the 116 epochs — 2cb17d5b…, Phase C — holds only the 20 bonus buys and their 203 free
 * spins, so it has no base spin.
 */
export const EXPECTED_PASS2_EPOCHS = 115;

// Live-sample fit (profile GROOMERS-22, Step 35, added 2026-09-26): family level for the informational fits.
export const LIVE_FIT_ALPHA = 0.01;

/**
 * OPERATOR ARTIFACTS OF RECORD — pinned 2026-09-26 (profile GROOMERS-13 / GROOMERS-26). The reel
 * weights, trigger tables and max-win cap every recomputation reads come from
 * data/raw/groomers-van-config-v1.4.json, and every payline is scored against
 * data/raw/paytable-from-rules-endpoint.json; until today nothing hashed either, so an edited weight
 * or paytable cell would have been scored as the operator's. Step 14 hashes every file below against
 * these constants (shasum -a 256, 2026-09-26) and FAILs on any mismatch or absence.
 *
 * The last two (added 2026-10-05) are the duel.com config as fetched 2026-10-05 in a logged-in session
 * (read-only GET): the /api/v2/slots and /api/v2/slots/groomers-van/rules response bodies, byte for
 * byte; the path, status, response headers and fetched_utc of each are in the .meta.json beside it. No
 * recomputation reads them. They show the config as fetched that day equals the pinned one: the
 * groomers-van entry equals groomers-van-config-v1.4.json, and the rules body has the same SHA-256 as
 * paytable-from-rules-endpoint.json (MANIFEST, Dataset and capture).
 */
export const RAW_FILE_PINS: Readonly<Record<string, string>> = Object.freeze({
  'client-seed-snapshot.json':          'e0b1e4a62e78f28ed13c57d6cb3ce6885ee98a04b7c051b1e46b526c88b3e3db',
  'groomers-van-config-v1.4.json':      'e08f41da9a1d2ab4a634e3f14dc2d52858520dc9620c327599cac1e5c09c2b87',
  'paytable-extracted-from-help.json':  'd10e08fa0887c07d9123bd0d815a14fd61e74dee4cb2c0e2ed76efe56a98ec9a',
  'paytable-from-rules-endpoint.json':  'c3479bf62ee9ed45896506db8972a9b338b693345db47633687af440b27ffcd1',
  'spin-1835724-request.json':          '1586b652311511643cdba65f39f90b86516b11e624aaf3017e8d5c9f58b0711b',
  'spin-1835724-response.json':         'e1ec2db3e732f96aef23c232767abd8972655656ad21adbac67381be410089ea',
  'spin-1835725-request.json':          '1586b652311511643cdba65f39f90b86516b11e624aaf3017e8d5c9f58b0711b',
  'spin-1835725-response.json':         'eef6c74abfb51d92c7ceb6523c96ec8d93032c5c16317412d0a84349c978eb54',
  'slots-2026-10-05.json':              'f112728a0343c0cf8f6ed05d1801fc828be34b99bbaafdf1b20005534a4f7dc6',
  'slots-groomers-van-rules-2026-10-05.json': 'c3479bf62ee9ed45896506db8972a9b338b693345db47633687af440b27ffcd1',
});

/** Hash every pinned operator file under data/raw/. An absent file is a mismatch. */
export function checkRawFiles(): Array<{ file: string; pinned: string; actual: string | null; match: boolean }> {
  return Object.entries(RAW_FILE_PINS).map(([file, pinned]) => {
    const p = path.join(DATA_DIR, 'raw', file);
    const actual = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
    return { file, pinned, actual, match: actual === pinned };
  });
}

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

// ── Epoch grouping (by the rotation TIMELINE) ────────────────────────────────

/**
 * Assign every bet to the seed record that was active when it was placed, using ONLY the
 * capture timeline: a bet belongs to the latest rotation record whose `at` is at or before the
 * bet's `startedAt`. The bet's own `activeAtSpin.server_seed_hashed` is NOT consulted, so a
 * step can compare that field against the window's committed hash and actually fail —
 * grouping by the hash and then asserting one hash per group (the old Step 3) could not.
 * Bets placed before the first rotation record are returned as orphans.
 */
export function groupByEpochWindow(
  bets: GVBet[],
  seeds: SeedRotation[],
): { windows: { index: number; record: SeedRotation; bets: GVBet[] }[]; orphans: GVBet[]; unordered: number } {
  const windows = seeds.map((record, index) => ({ index, record, bets: [] as GVBet[] }));
  const orphans: GVBet[] = [];
  // The linear scan below assumes the records are in time order; count any that are not so a
  // caller can refuse to score a timeline it cannot trust.
  let unordered = 0;
  for (let i = 1; i < seeds.length; i++) if (seeds[i].at < seeds[i - 1].at) unordered++;
  for (const b of bets) {
    // ISO-8601 UTC timestamps compare correctly as strings.
    let idx = -1;
    for (let j = 0; j < seeds.length; j++) {
      if (seeds[j].at <= b.startedAt) idx = j; else break;
    }
    if (idx < 0) { orphans.push(b); continue; }
    windows[idx].bets.push(b);
  }
  return { windows, orphans, unordered };
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
