/**
 * Steps 7–9: payout reconciliation.
 *
 *   7. Payout Math               — for every spin, sum every payline's
 *                                  payout and confirm it equals the
 *                                  spin's amount_won (USD, the unit the
 *                                  paylines are in), exactly in integer
 *                                  cents; the coins field must be that
 *                                  amount at the bet's own coins/USD
 *                                  rate (since 2026-10-05).
 *   8. Multiplier Provenance     — for every captured payline, recompute
 *                                  the cluster multiplier from the
 *                                  published paytable + cluster size and
 *                                  confirm the API's value matches.
 *   9. Bet-Size Invariance       — for every Phase B bet (high stake)
 *                                  reproduce the round-0 grid from
 *                                  (server_seed, client_seed, nonce).
 *                                  Cells must be identical regardless of
 *                                  stake (proves the stake is NOT an
 *                                  HMAC input — same seed → same grid).
 */

import { step, type VerifyContext, type StepResult } from './context';
import { computeOutcomeIndex, deriveTumbleSeed, Pcg32, generateGrid, REELS, ROWS } from '../../src/rng';
import { clusterMultiplier, scatterMultiplier, type Condition } from '../../src/paytable';
import type { GVBet } from '../../src/types';
import { EXPECTED_BETS, EXPECTED_NON_BUY_BETS, EXPECTED_PAYLINES, EXPECTED_PHASE_BETS, servedNonce } from '../../src/loader';

/**
 * Exact integer cents from a served decimal string; null when the string is not a legal 2-dp amount
 * (more than two decimals that are not all zero, or not a plain decimal). No floating point.
 */
export function centsOf(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '');
  if (frac.length > 2 && !/^0*$/.test(frac.slice(2))) return null;
  const c = BigInt(m[2]) * 100n + BigInt((frac + '00').slice(0, 2));
  return m[1] === '-' ? -c : c;
}

// MONEY IS A VALUE DOMAIN, IN TWO UNITS. The API reports every credit twice in USD (amount_won,
// total_win_currency; the paylines' base_payout_currency is USD too) and twice in the account's coins
// (amount_won_coins, total_win), and records the stake both ways (bet_amount in coins,
// bet_amount_currency in USD). Measured on the pinned dataset (2026-10-05): the coins amount is the USD
// amount converted at the bet's own coins/USD rate and rounded to 2 dp on 6,225 / 6,225 bets; 2,619 of
// them carry a win at a rate other than 1. Until 2026-10-05 Step 7 compared the USD paylines with the
// coins field, so the conversion of three Phase B $50 stakes (recorded as 49.9915 coins) read as three
// one-cent underpayments, declared by spin id. Every comparison below is exact in integer cents (BigInt),
// USD with USD and coins with coins, with no tolerance and no exception; a figure that is not a legal 2-dp
// amount is rejected before any comparison happens.

/** A served decimal string as an exact (digits, scale) pair; null when it is not a plain decimal. */
function decimalOf(v: unknown): { n: bigint; scale: number } | null {
  if (v === null || v === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v));
  if (!m) return null;
  const frac = m[3] ?? '';
  const n = BigInt(m[2] + frac);
  return { n: m[1] === '-' ? -n : n, scale: frac.length };
}

/**
 * round_half_up(amount × num / den, 2 dp) in integer cents, computed exactly as a BigInt ratio; null when an
 * input is not a non-negative plain decimal or den is zero. `tie` reports an exact half cent, the only case
 * in which half-up and half-even differ.
 */
export function convertedCents(amount: unknown, num: unknown, den: unknown): { cents: bigint; tie: boolean } | null {
  const a = decimalOf(amount), b = decimalOf(num), c = decimalOf(den);
  if (!a || !b || !c || a.n < 0n || b.n < 0n || c.n <= 0n) return null;
  const p10 = (k: number): bigint => 10n ** BigInt(k);
  const top = a.n * b.n * p10(c.scale) * 100n;
  const bottom = p10(a.scale) * p10(b.scale) * c.n;
  const q = top / bottom, r = top % bottom;
  return { cents: 2n * r >= bottom ? q + 1n : q, tie: 2n * r === bottom };
}

/** The bet's coins/USD rate as (coins, usd): the stake for spins and buys, the trigger stake for free spins. */
function rateOf(b: GVBet): { num: string; den: string } | null {
  const r = b.response;
  if (b.mode === 'free_spin') {
    const fs = r.feature_status;
    return fs && fs.trigger_bet_amount_coins != null && fs.trigger_bet_amount_currency != null
      ? { num: fs.trigger_bet_amount_coins, den: fs.trigger_bet_amount_currency } : null;
  }
  return r.bet_amount != null && r.bet_amount_currency != null ? { num: r.bet_amount, den: r.bet_amount_currency } : null;
}

function buildSymbolTables(ctx: VerifyContext) {
  const out: any = {};
  for (const cond of ['base_game', 'bonus_game'] as const) {
    const symbols = ctx.config.weights.symbols_by_condition[cond];
    const sorted  = [...symbols].sort((a, b) => a.symbol_index - b.symbol_index);
    const codes   = sorted.map(s => s.code);
    const weightsPerReel: number[][] = [];
    for (let reel = 0; reel < REELS; reel++) {
      weightsPerReel.push(sorted.map(s => s.weights_per_reel[reel]));
    }
    out[cond === 'base_game' ? 'base' : 'bonus'] = { codes, weights: weightsPerReel };
  }
  return out;
}

function condOf(b: GVBet): Condition {
  return b.response.spin_type === 'bonus_game' || b.mode === 'free_spin' ? 'bonus_game' : 'base_game';
}

export function run(ctx: VerifyContext): StepResult[] {
  const results: StepResult[] = [];

  // ── Step 7: Payout Math ────────────────────────────────────────────────
  // For each captured spin, sum every cluster + scatter payline's
  // `payout_currency` (USD) across all rounds and confirm it equals the spin's
  // `amount_won` (the USD credit); then check the coins credit against the bet's rate.
  {
    let ok = 0, mismatched = 0;
    const fails: string[] = [];

    for (const b of ctx.bets) {
      // Skip buys (server-canned, no RNG-derived payouts to reconcile —
      // the buy returns a fixed scatter pay equal to the trigger value).
      if (b.mode === 'buy') continue;

      // Bonus_game cluster paylines store the BASE payout in
      // `payout_currency`, with the sticky-multiplier sum stored
      // separately in `bomb_multiplier`. Final award per payline =
      // base_payout_currency × max(bomb_multiplier, 1). For base_game
      // bomb_multiplier=0; max(0,1)=1, so the formula degenerates to
      // base_payout (correct).
      // EXACT ON THE MONEY GRID, IN USD (2026-10-05): every payline's base payout (USD) is parsed to integer
      // cents, multiplied by its integer bomb multiplier (max(bomb, 1)), summed in BigInt, and compared with
      // amount_won — the USD credit — in cents. No tolerance and no exception. Until 2026-10-05 this compared
      // amount_won_coins (the coins credit), which differs from the USD sum wherever the conversion rounds a
      // cent away; that was the three one-cent exceptions src/loader.ts used to declare by spin id.
      let summed: bigint | null = 0n;
      for (const round of b.response.rounds) {
        for (const pl of round.data.paylines) {
          const base = centsOf(pl.base_payout_currency || pl.payout_currency || '0');
          const bomb = pl.bomb_multiplier ?? 0;
          if (base === null || summed === null || !Number.isInteger(bomb)) { summed = null; continue; }
          summed += base * BigInt(Math.max(bomb, 1));
        }
      }
      const reported = centsOf(b.response.amount_won ?? '0');
      if (summed !== null && reported !== null && reported === summed) ok++;
      else {
        mismatched++;
        if (fails.length < 3) fails.push(`bet ${b.spinId}: sum(paylines) ${summed === null ? 'off-grid' : `${summed}¢`} vs amount_won ${reported === null ? `off-grid ${b.response.amount_won}` : `${reported}¢`}`);
      }
    }

    // ── The coins field is the USD credit at the bet's own rate (added 2026-10-05) ──────────
    // amount_won_coins must equal round_half_up(amount_won × rate, 2 dp), exactly, on every bet. rate =
    // bet_amount / bet_amount_currency (coins per USD of the stake) for spins and buys, and
    // feature_status.trigger_bet_amount_coins / trigger_bet_amount_currency for free spins. Counted beside
    // it: the bets whose win was converted at a rate other than 1 (the cases that exercise the rule) and
    // exact half-cent ties (the only cases in which half-up and half-even differ).
    let coinsChecked = 0, coinsOk = 0, coinsNoRate = 0, winsAtRateNot1 = 0, halfCentTies = 0;
    const coinsFails: string[] = [];
    for (const b of ctx.bets) {
      const rate = rateOf(b);
      if (!rate) { coinsNoRate++; continue; }
      coinsChecked++;
      const conv = convertedCents(b.response.amount_won, rate.num, rate.den);
      const coins = centsOf(b.response.amount_won_coins);
      if (conv && conv.tie) halfCentTies++;
      const won = centsOf(b.response.amount_won);
      const rn = decimalOf(rate.num), rd = decimalOf(rate.den);
      const rateIsOne = !!rn && !!rd && rn.n * 10n ** BigInt(rd.scale) === rd.n * 10n ** BigInt(rn.scale);
      if (won !== null && won > 0n && !rateIsOne) winsAtRateNot1++;
      if (conv && coins !== null && conv.cents === coins) coinsOk++;
      else if (coinsFails.length < 3) coinsFails.push(`bet ${b.spinId}: amount_won_coins ${b.response.amount_won_coins} != round(amount_won ${b.response.amount_won} × ${rate.num} / ${rate.den}, 2) = ${conv ? `${conv.cents}¢` : 'not computable'}`);
    }

    // ── Sibling consistency: USD with USD, coins with coins (since 2026-10-05) ────────────────
    // The API reports the award twice in each unit: amount_won and total_win_currency (USD), amount_won_coins
    // and total_win (coins). Step 7 above scores amount_won and amount_won_coins; a forger who moves the other
    // field of either pair — total_win is the one the wallet follows — would otherwise change the published
    // credit untouched. All four must be legal 2-dp amounts and each pair must be equal exactly. The one-unit
    // allowance this check used to grant on three declared ids compared the two units with each other; it is
    // gone, and the units are no longer compared here (the conversion check above relates them).
    let sibChecked = 0, sibBad = 0, sibOffGrid = 0, sibMissing = 0;
    const sibFails: string[] = [];
    const PAIRS: Array<[string, string]> = [['amount_won', 'total_win_currency'], ['amount_won_coins', 'total_win']];
    for (const b of ctx.bets) {
      const r = b.response as unknown as Record<string, unknown>;
      const keys = PAIRS.flat();
      if (keys.some(k => r[k] == null)) { sibMissing++; continue; }
      sibChecked++;
      const off = keys.filter(k => centsOf(r[k]) === null);
      if (off.length > 0) {
        sibOffGrid++; sibBad++;
        if (sibFails.length < 3) sibFails.push(`bet ${b.spinId}: ${off.map(k => `${k}=${r[k]}`).join(', ')} not a legal 2-dp amount`);
        continue;
      }
      const bad = PAIRS.filter(([x, y]) => centsOf(r[x]) !== centsOf(r[y]));
      if (bad.length > 0) {
        sibBad++;
        if (sibFails.length < 3) sibFails.push(`bet ${b.spinId}: ${bad.map(([x, y]) => `${x}=${r[x]} != ${y}=${r[y]}`).join(', ')}`);
      }
    }

    // BOUND TO THE POPULATION. With every bet removed, or every money field dropped, every half of this
    // step used to report 0/0 and PASS. The reconciliation must have examined every non-buy entry, and the
    // conversion and sibling checks every entry, as src/loader.ts declares.
    const popIssues7: string[] = [];
    if (ok + mismatched !== EXPECTED_NON_BUY_BETS) popIssues7.push(`non-buy bets reconciled ${ok + mismatched} != ${EXPECTED_NON_BUY_BETS}`);
    if (coinsChecked !== EXPECTED_BETS) popIssues7.push(`bets conversion-checked ${coinsChecked} != ${EXPECTED_BETS} (${coinsNoRate} with no coins/USD rate)`);
    if (sibChecked !== EXPECTED_BETS) popIssues7.push(`bets sibling-checked ${sibChecked} != ${EXPECTED_BETS}`);
    if (sibMissing > 0) popIssues7.push(`${sibMissing} bets lack one of the four credit fields`);
    const ok7 = mismatched === 0 && coinsOk === coinsChecked && sibBad === 0 && popIssues7.length === 0;
    results.push(step(7, 'Payout Math',
      ok7 ? 'PASS' : 'FAIL',
      `${ok}/${ok + mismatched} non-buy bets reconcile sum(payline payouts × max(bomb_multiplier, 1)) = amount_won (USD, the unit the paylines are stated in) EXACTLY in integer cents, with no exception. ${mismatched} mismatched. ` +
      `${coinsOk}/${coinsChecked} bets: amount_won_coins = round_half_up(amount_won × coins/USD rate, 2 dp) exactly — rate = bet_amount / bet_amount_currency for spins and buys, the trigger's rate for free spins; ${winsAtRateNot1} of them carry a win converted at a rate other than 1; ${halfCentTies} land on an exact half cent. ` +
      `${sibChecked - sibBad}/${sibChecked} bets: all four credit fields are legal 2-dp amounts and amount_won = total_win_currency (USD), amount_won_coins = total_win (coins) exactly (${sibOffGrid} off-grid, ${sibBad - sibOffGrid} unequal).` +
      (popIssues7.length ? ` POPULATION: ${popIssues7.join('; ')}.` : '') +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : '') +
      (coinsFails.length ? ` Conversion examples: ${coinsFails.join(' | ')}` : '') +
      (sibFails.length ? ` Sibling examples: ${sibFails.join(' | ')}` : ''),
      { reconciled: ok + mismatched, reconciledOk: ok, mismatched,
        coinsConversion: { checked: coinsChecked, agree: coinsOk, noRate: coinsNoRate, winsAtRateNot1, halfCentTies },
        siblingChecked: sibChecked, siblingBad: sibBad, siblingOffGrid: sibOffGrid, siblingMissingFields: sibMissing, populationIssues: popIssues7 },
    ));
  }

  // ── Step 8: Multiplier Provenance ──────────────────────────────────────
  // Each cluster payline's `multiplier` field must equal the published
  // paytable value for (symbol, cluster_size). Scatter paylines (bonus
  // symbol) check against the scatter pay table. Catches a casino that
  // pays a multiplier different from what `/api/v2/slots/groomers-van/rules`
  // publishes.
  {
    let checked = 0, ok = 0, mismatched = 0, betsExamined = 0;
    const fails: string[] = [];

    for (const b of ctx.bets) {
      if (b.mode === 'buy') continue;   // buy scatter pay is structural, not a paytable lookup
      betsExamined++;
      const cond: Condition = condOf(b);
      for (const round of b.response.rounds) {
        for (const pl of round.data.paylines) {
          const expected = pl.win_type === 'scatter'
            ? scatterMultiplier(ctx.paytable, cond, pl.count)
            : clusterMultiplier(ctx.paytable, cond, pl.symbol, pl.count);
          checked++;
          // EXACT (2026-09-26): both sides are the same published decimal; a 1e-6 window forgave a
          // served multiplier moved in its 7th digit.
          if (expected === pl.multiplier) ok++;
          else {
            mismatched++;
            if (fails.length < 3) {
              fails.push(`bet ${b.spinId} ${pl.identifier}: paytable ${expected} ≠ API ${pl.multiplier}`);
            }
          }
        }
      }
    }

    // BOUND TO THE POPULATION: emptying every paylines[] array used to leave "0/0 … 0 mismatched"
    // and a PASS. The payline count is declared in src/loader.ts.
    const popIssues8: string[] = [];
    if (betsExamined !== EXPECTED_NON_BUY_BETS) popIssues8.push(`bets examined ${betsExamined} != ${EXPECTED_NON_BUY_BETS}`);
    if (checked !== EXPECTED_PAYLINES) popIssues8.push(`paylines checked ${checked} != ${EXPECTED_PAYLINES}`);
    results.push(step(8, 'Multiplier Provenance',
      mismatched === 0 && popIssues8.length === 0 ? 'PASS' : 'FAIL',
      `${ok}/${checked} payline multipliers match the published paytable (cluster-pays for ${ctx.paytable.bySymbol.base_game.size}-symbol base + ${ctx.paytable.bySymbol.bonus_game.size}-symbol bonus; src/loader.ts: ${EXPECTED_PAYLINES} paylines). ${mismatched} mismatched.` +
      (popIssues8.length ? ` POPULATION: ${popIssues8.join('; ')}.` : '') +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : ''),
      { betsExamined, paylinesChecked: checked, matched: ok, mismatched, populationIssues: popIssues8 },
    ));
  }

  // ── Step 9: Bet-Size Invariance (Phase B at $1–$50) ────────────────────
  // For every Phase B bet, reproduce the 30-cell grid using the same
  // algorithm. Cells must be identical regardless of stake — the stake
  // is not an HMAC input and not a PRNG input. Catches a casino that
  // would substitute a worse-paying grid at higher stakes.
  {
    const phaseB = ctx.byPhase['B'] ?? [];
    const tables = buildSymbolTables(ctx);
    let checked = 0, ok = 0, mismatched = 0, skipped = 0;
    const fails: string[] = [];
    const stakesSeen = new Set<string>();

    for (const b of phaseB) {
      if (b.mode === 'free_spin') continue;
      stakesSeen.add(b.response.bet_amount_currency);
      const seedHashed = b.activeAtSpin.server_seed_hashed;
      const seedPlain  = ctx.seedMap.get(seedHashed);
      if (!seedPlain) { skipped++; continue; }

      const cond  = b.response.spin_type === 'bonus_game' ? tables.bonus : tables.base;
      const view  = b.response.rounds[0]?.data?.view;
      if (!view) { skipped++; continue; }
      const captured: string[][] = view.map(reelCol => reelCol.map(c => c.symbol));
      // The SERVED nonce — recorded, or the correction declared by spin id (src/loader.ts
      // CAPTURE_NONCE_CORRECTIONS; one Phase B bet, 1987633). Exact: the ±1 search this used until
      // 2026-09-26 is gone.
      const n = servedNonce(b);
      let matched = false;
      if (typeof n === 'number' && n >= 0) {
        const oi   = computeOutcomeIndex(seedPlain, b.activeAtSpin.client_seed, n);
        const seed = deriveTumbleSeed(oi, 0, 0);
        const prng = new Pcg32(seed);
        const idxGrid = generateGrid(prng, cond.weights);
        let cellsOk = 0;
        for (let c = 0; c < REELS; c++)
          for (let r = 0; r < ROWS; r++)
            if (cond.codes[idxGrid[c][r]] === captured[c][r]) cellsOk++;
        matched = cellsOk === 30;
      }
      checked++;
      if (matched) ok++;
      else {
        mismatched++;
        if (fails.length < 3) fails.push(`bet ${b.spinId} stake ${b.response.bet_amount_currency}: the grid does not reproduce at its served nonce`);
      }
    }

    const stakeList = [...stakesSeen].sort((a, b) => parseFloat(a) - parseFloat(b)).join(', ');
    // BOUND TO THE POPULATION. `checked === 0` used to be a FLAG, and a Phase B bet with no
    // revealed seed or no grid was skipped silently. Every Phase B bet src/loader.ts declares must
    // be recomputed.
    const popIssues9: string[] = [];
    if (checked !== EXPECTED_PHASE_BETS.B) popIssues9.push(`Phase B bets recomputed ${checked} != ${EXPECTED_PHASE_BETS.B}`);
    if (skipped > 0) popIssues9.push(`${skipped} Phase B bets skipped with no revealed seed or no grid`);
    results.push(step(9, 'Bet-Size Invariance',
      mismatched === 0 && popIssues9.length === 0 ? 'PASS' : 'FAIL',
      `${ok}/${checked} Phase B bets recompute byte-equal cells from (server_seed, client_seed, nonce) (src/loader.ts: ${EXPECTED_PHASE_BETS.B}). ` +
      `Stakes spanned: $${stakeList}. Stake is not an HMAC input — same seed → same grid regardless of stake.` +
      (popIssues9.length ? ` POPULATION: ${popIssues9.join('; ')}.` : '') +
      (fails.length ? ` Examples: ${fails.join(' | ')}` : ''),
      { checked, matched: ok, mismatched, skipped, distinctStakes: stakesSeen.size, populationIssues: popIssues9 },
    ));
  }

  return results;
}
