/**
 * Duel.com Groomer's Van RNG — port of Duel's HMAC-SHA256 → PCG32 →
 * cascading-cluster slot algorithm.
 *
 * Source of truth (audit repo):
 *   https://github.com/ProvablyFair-org/duel-groomers-van/blob/main/src/rng.ts
 *
 * Verified bit-for-bit against the live audit dataset: every cell of
 * every cascade across the captured spins reproduces from the seeds
 * alone. The bonus-buy fixture set (19/20 buys reproducing exactly)
 * exercises the full session simulator including retriggers.
 *
 * ── Pipeline (per spin) ────────────────────────────────────────────────────
 *
 *   1. outcome_index = first 4 bytes BE of
 *        HMAC-SHA256(hex_decode(server_seed),
 *                    bytesToHex(utf8(client_seed)) + ':' + nonce)
 *
 *      Note the client seed is HEX-ENCODED before going into the message,
 *      and there is no `:cursor` suffix (unlike keno/dice/blackjack).
 *
 *   2. For each cascade in the spin:
 *        tumble_seed = mix32(outcome_index, round_index, tumble_index)
 *        prng        = PCG32(SplitMix64(tumble_seed))
 *        grid[c][r]  = rejection-sampled symbol via prng + reel weights
 *        In bonus mode: additional uint32 draws produce multiplier values
 *        for each cell whose symbol is `multiplier` (drawn AFTER the grid).
 *
 *   3. Cluster detection: same-symbol cells + wilds. Cluster pays when
 *      size ≥ 8 (paytable indexed 8..12 with size>=12 capped at the 12+ tier).
 *
 *   4. Gravity-fill on win: cluster cells removed, survivors slide DOWN
 *      per column, new top-of-column cells from a fresh PCG32 grid.
 *      Bombs (bonus multipliers) on survivors stay sticky.
 *
 *   5. Final payout = sum(cluster_base_multipliers) × max(sum(bombs), 1).
 *
 *   6. Trigger: ≥ 3 bonus scatters award a free-spin session (3→8 spins,
 *      4→10, 5→12, 6+→14). Each free spin advances round_index. Retriggers
 *      add spins (capped at 3). Max-win cap applies per spin and per session.
 *
 * ── Bonus-buy variant ──────────────────────────────────────────────────────
 *
 *   The buy spin grid itself is operator-canned (pf_skipped=true on every
 *   buy) — Duel's published behaviour. We skip rendering it and run the
 *   session directly with the initial free-spin count derived from
 *   buy_scatter_count (default 4 → 10 spins). The buy spin's 4-scatter
 *   scatter pay is structural per `buy_awards_scatter_payout: true` and
 *   is added deterministically to the session payout to match Duel's total.
 */

import { hmacSha256Hex, hexToBytes } from '../../lib/hmac-sha256';
import { CONFIG, REELS, ROWS, MAX_WIN_X } from './paytables';

// Maximum cascades per spin. Matches the production cap; in practice cascades
// terminate well before this when no cluster meets the minimum size.
const MAX_CASCADES = 30;

// ── HMAC + outcome_index ────────────────────────────────────────────────────

const u32 = (x) => x >>> 0;
const imul = (a, b) => Math.imul(a, b) >>> 0;

function utf8Bytes(s) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s);
  }
  // SSR fallback
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}

function isHex(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Compute outcome_index for a single spin.
 *
 * If serverSeed is non-hex (e.g. a test value like "abc"), fall back to
 * UTF-8 encoding of the serverSeed bytes as the HMAC key. This yields a
 * deterministic result but won't match a real Duel bet — Duel's revealed
 * server seeds are always 64-char hex.
 */
export function computeOutcomeIndex(serverSeed, clientSeed, nonce) {
  const key = isHex(serverSeed) ? hexToBytes(serverSeed) : utf8Bytes(serverSeed);
  const clientSeedHex = bytesToHex(utf8Bytes(clientSeed));
  const message = `${clientSeedHex}:${nonce}`;
  const hmacHex = hmacSha256Hex(key, message);
  // First 4 bytes big-endian
  return u32(parseInt(hmacHex.substring(0, 8), 16));
}

// ── tumble seed mix (Murmur3 finalise variant) ──────────────────────────────

export function deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex) {
  let x = u32(outcomeIndex);
  x = u32(x ^ imul(roundIndex + 1, 0x9e3779b9));
  x = u32(x ^ imul(tumbleIndex + 1, 0x85ebca6b));
  x = u32(x ^ (x >>> 16));
  x = imul(x, 0xc2b2ae35);
  x = u32(x ^ (x >>> 16));
  return x;
}

// ── PCG32 PRNG (SplitMix64-expanded seed) ───────────────────────────────────

const MASK64 = (1n << 64n) - 1n;
const PCG_MULT = 6364136223846793005n;
const PCG_INC  = 0x5851f42d4c957f2dn;

class Pcg32 {
  constructor(seed32) {
    let s = BigInt(u32(seed32));
    s = (s + 0x9e3779b97f4a7c15n) & MASK64;
    s = ((s ^ (s >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    s = ((s ^ (s >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    s ^= (s >> 31n);
    this.state = s & MASK64;
  }
  nextUint32() {
    const old = this.state;
    this.state = (old * PCG_MULT + PCG_INC) & MASK64;
    const xs = u32(Number(((old >> 18n) ^ old) >> 27n));
    const rot = Number(old >> 59n) & 31;
    return u32((xs >>> rot) | (xs << ((32 - rot) & 31)));
  }
}

// ── Weighted sampling (rejection-sampled, unbiased) ─────────────────────────

const MAX_U32 = 0xFFFFFFFF;

function pickWeighted(prng, weights) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  const maxFair = MAX_U32 - (MAX_U32 % total);
  let r;
  do { r = prng.nextUint32(); } while (r >= maxFair);
  const pick = r % total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (pick < acc) return i;
  }
  // Unreachable — pick < total by construction.
  return weights.length - 1;
}

function generateGrid(prng, weightsPerReel) {
  const g = [];
  for (let c = 0; c < REELS; c++) {
    const col = [];
    for (let r = 0; r < ROWS; r++) col.push(pickWeighted(prng, weightsPerReel[c]));
    g.push(col);
  }
  return g;
}

function generateMultipliers(idxGrid, prng, multSymbolIndex, multValues, multWeights) {
  if (multSymbolIndex == null) return [];
  const out = [];
  let totalW = 0;
  for (let i = 0; i < multWeights.length; i++) totalW += multWeights[i];
  const maxFair = MAX_U32 - (MAX_U32 % totalW);
  for (let c = 0; c < REELS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (idxGrid[c][r] === multSymbolIndex) {
        let rnd;
        do { rnd = prng.nextUint32(); } while (rnd >= maxFair);
        const pick = rnd % totalW;
        let acc = 0, chosen = 0;
        for (let i = 0; i < multWeights.length; i++) {
          acc += multWeights[i];
          if (pick < acc) { chosen = i; break; }
        }
        out.push({ position: c * ROWS + r, value: multValues[chosen] });
      }
    }
  }
  return out;
}

// ── Cluster detection + payout ──────────────────────────────────────────────

const NON_PAYABLE = new Set(['wild', 'bonus', 'multiplier']);

function findClusters(codeGrid) {
  const wilds = [];
  const bySym = new Map();
  for (let c = 0; c < REELS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const s = codeGrid[c][r];
      const p = c * ROWS + r;
      if (s === 'wild') wilds.push(p);
      else if (!NON_PAYABLE.has(s)) {
        if (!bySym.has(s)) bySym.set(s, []);
        bySym.get(s).push(p);
      }
    }
  }
  const out = [];
  for (const [s, ps] of bySym) {
    const all = ps.concat(wilds).sort((a, b) => a - b);
    out.push({
      symbol: s,
      positions: all,
      size: all.length,
      wildCount: wilds.length,
    });
  }
  return out;
}

function countScatters(codeGrid) {
  let n = 0;
  for (let c = 0; c < REELS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (codeGrid[c][r] === 'bonus') n++;
    }
  }
  return n;
}

function clusterMultiplier(paytable, symbol, size) {
  const min = CONFIG.min_cluster_size;
  if (size < min) return 0;
  const sym = paytable[symbol];
  if (!sym) return 0;
  const lookup = size >= 12 ? 12 : size;
  return sym[lookup] ?? 0;
}

function scatterPay(condition, scatters) {
  const tbl = CONFIG[condition].scatter_pay;
  const lookup = scatters >= 6 ? 6 : scatters;
  return tbl[lookup] ?? 0;
}

function freeSpinsAwarded(scatters, isRetrigger) {
  if (scatters < CONFIG.min_scatters_to_trigger) return 0;
  const tbl = isRetrigger
    ? CONFIG.retrigger_spins_per_scatters
    : CONFIG.spins_per_scatters;
  const lookup = scatters >= 6 ? 6 : scatters;
  return tbl[lookup] ?? 0;
}

// ── Per-spin simulation (cascades + payout) ─────────────────────────────────

function simulateSpin(condition, outcomeIndex, roundIndex) {
  const cfg = CONFIG[condition];
  const codes = cfg.symbol_codes;
  const weights = cfg.weights_per_reel;
  const multIdx = cfg.multiplier_symbol_index;
  const multValues = Object.keys(CONFIG.multiplier_values_weights)
    .map(Number)
    .sort((a, b) => a - b);
  const multWeights = multValues.map(v => CONFIG.multiplier_values_weights[v]);

  let tumbleIndex = 0;
  let tumbleSeed = deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex);
  let prng = new Pcg32(tumbleSeed);
  let idxGrid = generateGrid(prng, weights);
  let codeGrid = idxGrid.map(col => col.map(i => codes[i]));

  // Track which positions were "freshly dealt" this tumble (vs slid down as
  // survivors). Tumble 0: every cell is freshly dealt. Tumble N≥1: only the
  // top-of-column cells filled from newGrid.
  let freshPositionsThisTumble = new Set();
  for (let p = 0; p < REELS * ROWS; p++) freshPositionsThisTumble.add(p);

  const cascades = [];

  // Initial multipliers (bonus only) — drawn from same PCG32 after grid
  let cumulativeBombs = 0;
  const initialMultipliers = condition === 'bonus_game'
    ? generateMultipliers(idxGrid, prng, multIdx, multValues, multWeights)
    : [];
  for (const m of initialMultipliers) cumulativeBombs += m.value;

  // Bombs visible on the CURRENT grid (sticky positions that survived).
  let currentBombMap = new Map();
  for (const m of initialMultipliers) currentBombMap.set(m.position, m.value);

  let totalBaseMult = 0;
  let cumulativeScatters = countScatters(codeGrid);

  while (cascades.length < MAX_CASCADES) {
    const clusters = findClusters(codeGrid);
    const removed = new Set();
    const winningClusters = [];
    let roundBaseMult = 0;
    for (const c of clusters) {
      if (c.size < CONFIG.min_cluster_size) continue;
      const mult = clusterMultiplier(cfg.paytable, c.symbol, c.size);
      if (mult <= 0) continue;
      roundBaseMult += mult;
      winningClusters.push({
        symbol: c.symbol,
        size: c.size,
        positions: c.positions,
        baseMult: mult,
      });
      for (const p of c.positions) removed.add(p);
    }
    totalBaseMult += roundBaseMult;

    cascades.push({
      tumbleIndex,
      tumbleSeed,
      grid: codeGrid.map(col => col.slice()),
      idxGrid: idxGrid.map(col => col.slice()),
      bombs: Array.from(currentBombMap.entries()).map(([p, v]) => ({ position: p, value: v })),
      clusters: winningClusters,
      removedPositions: Array.from(removed).sort((a, b) => a - b),
      freshPositions: Array.from(freshPositionsThisTumble).sort((a, b) => a - b),
      roundBaseMult,
      scatterCountOnGrid: countScatters(codeGrid),
    });

    if (removed.size === 0) break;

    // Advance to next cascade
    tumbleIndex += 1;
    tumbleSeed = deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex);
    prng = new Pcg32(tumbleSeed);
    const newGrid = generateGrid(prng, weights);
    const newGridMultipliers = condition === 'bonus_game'
      ? generateMultipliers(newGrid, prng, multIdx, multValues, multWeights)
      : [];

    // Gravity per column: survivors slide down, new top-of-column from newGrid
    const newIdxGrid = idxGrid.map(col => col.slice());
    const filledNewPositions = new Set();
    const newBombMap = new Map();
    for (let col = 0; col < REELS; col++) {
      const survivors = [];
      for (let row = 0; row < ROWS; row++) {
        const pos = col * ROWS + row;
        if (!removed.has(pos)) {
          survivors.push({ idx: idxGrid[col][row], bombValue: currentBombMap.get(pos) ?? null });
        }
      }
      const newCount = ROWS - survivors.length;
      for (let i = 0; i < newCount; i++) {
        newIdxGrid[col][i] = newGrid[col][i];
        filledNewPositions.add(col * ROWS + i);
      }
      for (let i = 0; i < survivors.length; i++) {
        const targetRow = newCount + i;
        newIdxGrid[col][targetRow] = survivors[i].idx;
        if (survivors[i].bombValue != null) {
          newBombMap.set(col * ROWS + targetRow, survivors[i].bombValue);
        }
      }
    }
    idxGrid = newIdxGrid;
    codeGrid = idxGrid.map(col => col.map(i => codes[i]));

    // Apply new multipliers landing on filled-from-newGrid positions
    for (const m of newGridMultipliers) {
      if (filledNewPositions.has(m.position)) {
        cumulativeBombs += m.value;
        newBombMap.set(m.position, m.value);
      }
    }
    currentBombMap = newBombMap;
    freshPositionsThisTumble = filledNewPositions;

    cumulativeScatters = countScatters(codeGrid);
  }

  // End-of-spin payout — single multiplication (the audited bomb rule).
  let payout = totalBaseMult * Math.max(cumulativeBombs, 1);

  // Scatter pay (base game only; bonus mode handles retriggers separately)
  if (condition === 'base_game' && cumulativeScatters >= 4) {
    payout += scatterPay('base_game', cumulativeScatters);
  }

  let maxWinReached = false;
  if (payout > MAX_WIN_X) {
    payout = MAX_WIN_X;
    maxWinReached = true;
  }

  return {
    cascades,
    totalBaseMult,
    cumulativeBombs,
    cumulativeScatters,
    payout,
    maxWinReached,
    triggered: condition === 'base_game' && cumulativeScatters >= CONFIG.min_scatters_to_trigger,
  };
}

// ── Free-spin session simulation ────────────────────────────────────────────

function simulateSession(outcomeIndex, initialFreeSpins, startRound) {
  let sessionPayout = 0;
  let remaining = initialFreeSpins;
  let retriggers = 0;
  let roundIndex = startRound;
  const sessionSpins = [];
  let maxWinReached = false;

  while (remaining > 0) {
    if (sessionPayout >= MAX_WIN_X) {
      sessionPayout = MAX_WIN_X;
      maxWinReached = true;
      break;
    }
    const r = simulateSpin('bonus_game', outcomeIndex, roundIndex);
    const isRetrigger = r.cumulativeScatters >= CONFIG.min_scatters_to_trigger
      && retriggers < CONFIG.max_bonus_retriggers;
    const addedSpins = isRetrigger ? freeSpinsAwarded(r.cumulativeScatters, true) : 0;
    sessionSpins.push({
      roundIndex,
      spin: r,
      retrigger: isRetrigger,
      retriggerAddedSpins: addedSpins,
    });
    sessionPayout += r.payout;
    if (sessionPayout >= MAX_WIN_X) {
      sessionPayout = MAX_WIN_X;
      maxWinReached = true;
      break;
    }
    remaining--;
    if (isRetrigger) {
      remaining += addedSpins;
      retriggers++;
    }
    roundIndex++;
  }

  return { sessionPayout, sessionSpins, retriggers, maxWinReached };
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Derive the full Groomer's Van outcome for one bet.
 *
 * @param {Object} params
 * @param {string} params.clientSeed
 * @param {string} params.serverSeed
 * @param {number} params.nonce
 * @param {'regular'|'buy'} [params.spinType='regular']
 *
 * @returns {{
 *   spinType: 'regular' | 'buy',
 *   outcomeIndex: number,
 *   firstHmac: string,
 *   trigger: object | null,        // base-game spin result; null for buys
 *   session: object | null,        // free-spin session result; null if no trigger
 *   triggered: boolean,
 *   buyScatterPay: number,         // deterministic 4-scatter buy pay (buy only)
 *   payout: number,                // final stake multiplier (trigger + session)
 *   multiplier: number,            // = payout (contract field)
 *   maxWinReached: boolean
 * }}
 */
export function deriveGroomersVan({ clientSeed, serverSeed, nonce, spinType = 'regular' }) {
  // The first HMAC (whose first 4 BE bytes ARE the outcome_index) is the
  // entropy fingerprint we surface in Computation Details — same role as
  // the other games' `firstHmac` field.
  const key = isHex(serverSeed) ? hexToBytes(serverSeed) : utf8Bytes(serverSeed);
  const clientSeedHex = bytesToHex(utf8Bytes(clientSeed));
  const firstHmac = hmacSha256Hex(key, `${clientSeedHex}:${nonce}`);
  const outcomeIndex = u32(parseInt(firstHmac.substring(0, 8), 16));

  let trigger = null;
  let session = null;
  let buyScatterPay = 0;
  let isTriggered = false;
  let maxWinReached = false;

  if (spinType === 'buy') {
    // Bonus buy: cosmetic buy spin grid is operator-canned (pf_skipped=true)
    // so it's not seed-derived and not rendered. Run the free-spin session
    // directly with the initial spin count derived from buy_scatter_count.
    // Bonus buys use round_index = 0..N-1 (no trigger spin consumed index 0).
    const buyScatterCount = CONFIG.buy_scatter_count;
    const initialFS = CONFIG.spins_per_scatters[buyScatterCount]
      ?? CONFIG.spins_per_scatters[String(buyScatterCount)];
    session = simulateSession(outcomeIndex, initialFS, 0);

    if (CONFIG.buy_awards_scatter_payout) {
      buyScatterPay = scatterPay('base_game', buyScatterCount);
      session.sessionPayout = Math.min(session.sessionPayout + buyScatterPay, MAX_WIN_X);
      session.buyScatterPay = buyScatterPay;
    }
    isTriggered = true;
    maxWinReached = session.maxWinReached;
  } else {
    // Regular spin: derive base-game grid, run session if triggered.
    trigger = simulateSpin('base_game', outcomeIndex, 0);
    if (trigger.triggered) {
      const initialFS = freeSpinsAwarded(trigger.cumulativeScatters, false);
      session = simulateSession(outcomeIndex, initialFS, 1);
      isTriggered = true;
    }
    maxWinReached = trigger.maxWinReached || (session?.maxWinReached ?? false);
  }

  const triggerPayout = trigger ? trigger.payout : 0;
  const sessionPayout = session ? session.sessionPayout : 0;
  const payout = triggerPayout + sessionPayout;

  return {
    spinType,
    outcomeIndex,
    firstHmac,
    trigger,
    session,
    triggered: isTriggered,
    buyScatterPay,
    payout,
    multiplier: payout,
    maxWinReached,
  };
}
