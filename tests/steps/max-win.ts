/**
 * Step 34 — Max-Win Cap & Payout Bounds (profile GROOMERS-14). Added 2026-09-26.
 *
 * FLAG-ONLY BY POLICY (R2): a violation is disclosed, never failed.
 *
 *  1. THE CAP. The operator's published config (data/raw/groomers-van-config-v1.4.json, pinned by
 *     RAW_FILE_PINS, Step 14) declares max_multiplier = 5000; declarations/duel.groomers-van.json
 *     records maxWinX 5000. The enumerators apply the same figure: the capped 2^32 bonus enumeration's
 *     max_payout must not exceed it, every exact session artifact must declare max_win_x equal to it.
 *
 *  2. SERVED ROUNDS. Every one of the 6,225 captured entries: the served total_multiplier ≤ cap, and the
 *     credited total_win_currency ≤ cap × bet_amount_currency, compared EXACTLY as 18-dp decimals.
 *
 *  3. SERVED SESSIONS. Every bonus session (free spins grouped by featureId, bound to
 *     EXPECTED_BONUS_SESSIONS): the summed free-spin credits ≤ cap × the session's bet, exactly.
 *
 *  4. THE RTP THE CAP REMOVES, disclosed with its magnitude: the pinned capped vs uncapped 2^32 bonus
 *     enumerations give the per-bonus-spin return with and without the per-spin cap; their difference is
 *     printed, with an upper bound on its share of the whole-game RTP (P(trigger) × the most bonus spins
 *     a session can play × the per-spin difference). The base game's own enumeration maximum is printed
 *     against the cap. The SESSION-level cap's effect is not enumerated (no uncapped session convolution is
 *     pinned); its per-session hit probability from each capped convolution is printed instead.
 */

import * as fs   from 'fs';
import * as path from 'path';
import { step, type VerifyContext, type StepResult } from './context';
import { EXPECTED_BETS, EXPECTED_BONUS_SESSIONS } from '../../src/loader';
import { deriveEnumeratedRtp } from './enumeration';

const SCALE = 18;
/** An 18-dp decimal string as an integer number of 1e-18 units; null if not a plain decimal. */
function units(s: unknown): bigint | null {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) return null;
  const [a, b = ''] = s.split('.');
  if (b.length > SCALE) return null;
  return BigInt(a + b.padEnd(SCALE, '0'));
}

export function run(ctx: VerifyContext): StepResult[] {
  const issues: string[] = [];
  const cap = Number(ctx.config.max_multiplier);
  if (!Number.isInteger(cap) || cap <= 0) issues.push(`operator config max_multiplier ${JSON.stringify(ctx.config.max_multiplier)} is not a positive integer`);
  const capU = BigInt(Number.isInteger(cap) && cap > 0 ? cap : 0);

  // ── 1. The enumerators apply the same cap ────────────────────────────────────────────────────────
  const read = (f: string): any => { try { return JSON.parse(fs.readFileSync(path.join(ctx.outputsDir, f), 'utf8')); } catch { return null; } };
  const base = read('base-2pow32.json'), bonus = read('bonus-2pow32.json'), unc = read('bonus-2pow32-uncapped.json');
  if (!base || !bonus || !unc) issues.push('a 2^32 enumeration artifact (base / bonus / bonus-uncapped) is absent');
  if (bonus && !(bonus.max_payout <= cap)) issues.push(`capped bonus enumeration max_payout ${bonus.max_payout} exceeds the cap ${cap}`);
  const sessionCapHit: Record<number, number> = {};
  for (const n of [8, 10, 12, 14]) {
    const s = read(`bonus-session-ev-exact-${n}.json`);
    if (!s) { issues.push(`bonus-session-ev-exact-${n}.json absent`); continue; }
    if (s.max_win_x !== cap) issues.push(`bonus-session-ev-exact-${n}.json max_win_x ${s.max_win_x} ≠ the cap ${cap}`);
    sessionCapHit[n] = s.result?.cap_hit_probability;
  }

  // ── 2. Served rounds ─────────────────────────────────────────────────────────────────────────────
  let roundsChecked = 0, malformed = 0, overMult = 0, overWin = 0;
  let maxMult = 0, maxWinOverBet = 0;
  const offenders: string[] = [];
  for (const b of ctx.bets) {
    const r: any = b.response;
    const m = Number(r?.total_multiplier);
    const w = units(r?.total_win_currency), s = units(r?.bet_amount_currency);
    if (!Number.isFinite(m) || w === null || s === null || s <= 0n) { malformed++; continue; }
    roundsChecked++;
    if (m > maxMult) maxMult = m;
    const ratio = Number((w * 1_000_000n) / s) / 1e6;
    if (ratio > maxWinOverBet) maxWinOverBet = ratio;
    if (m > cap) { overMult++; offenders.push(`spin ${b.spinId} total_multiplier ${r.total_multiplier}`); }
    if (w > capU * s) { overWin++; offenders.push(`spin ${b.spinId} credit ${r.total_win_currency} > ${cap} × ${r.bet_amount_currency}`); }
  }
  if (malformed > 0) issues.push(`${malformed} entr(y/ies) without a parseable total_multiplier / total_win_currency / bet_amount_currency`);
  if (roundsChecked !== EXPECTED_BETS) issues.push(`${roundsChecked} entries checked, ${EXPECTED_BETS} declared`);
  if (overMult + overWin > 0) issues.push(`${overMult + overWin} served round(s) above the ${cap}× cap: ${offenders.slice(0, 3).join('; ')}`);

  // ── 3. Served sessions ───────────────────────────────────────────────────────────────────────────
  const sessions = new Map<string, { win: bigint; bet: bigint }>();
  for (const b of ctx.bets as any[]) {
    if (b.mode !== 'free_spin') continue;
    const w = units(b.response?.total_win_currency), s = units(b.response?.bet_amount_currency);
    if (w === null || s === null) continue;
    const k = String(b.featureId);
    const cur = sessions.get(k) ?? { win: 0n, bet: s };
    cur.win += w;
    sessions.set(k, cur);
  }
  let overSession = 0, maxSessionOverBet = 0;
  for (const [id, x] of sessions) {
    const ratio = Number((x.win * 1_000_000n) / x.bet) / 1e6;
    if (ratio > maxSessionOverBet) maxSessionOverBet = ratio;
    if (x.win > capU * x.bet) { overSession++; offenders.push(`feature ${id} session credit above ${cap}×`); }
  }
  if (sessions.size !== EXPECTED_BONUS_SESSIONS) issues.push(`${sessions.size} bonus sessions grouped, ${EXPECTED_BONUS_SESSIONS} declared`);
  if (overSession > 0) issues.push(`${overSession} bonus session(s) above the ${cap}× cap`);

  // ── 4. The RTP the cap removes ───────────────────────────────────────────────────────────────────
  const perBonusSpinRemoved = bonus && unc ? unc.rtp - bonus.rtp : null;
  if (perBonusSpinRemoved !== null && !(perBonusSpinRemoved >= 0)) issues.push(`uncapped bonus RTP is below the capped one (${perBonusSpinRemoved})`);
  const exact = deriveEnumeratedRtp(ctx.outputsDir);
  // Most bonus spins one session can play: the largest initial award + max_retriggers × the largest retrigger award.
  const meta = ctx.config.features?.[0]?.metadata;
  const maxInitial = meta ? Math.max(...Object.values(meta.scatter_rewards)) : NaN;
  const maxRetrig = meta ? Math.max(...Object.values(meta.retrigger_rewards)) : NaN;
  const maxSpinsPerSession = meta ? maxInitial + meta.max_retriggers * maxRetrig : NaN;
  const gameRtpRemovedUpperBound = exact && perBonusSpinRemoved !== null && Number.isFinite(maxSpinsPerSession)
    ? exact.pTrig * maxSpinsPerSession * perBonusSpinRemoved : null;
  if (gameRtpRemovedUpperBound === null) issues.push('the RTP removed by the cap could not be derived from the pinned artifacts and the operator config');

  const ok = issues.length === 0;
  return [step(34, 'Max-Win Cap & Payout Bounds (GROOMERS-14)',
    ok ? 'PASS' : 'FLAG',
    ok
      ? `cap ${cap}× from the operator config (max_multiplier), applied by the enumerators (capped bonus 2^32 max_payout within it; all 4 exact session artifacts declare max_win_x ${cap}); all ${roundsChecked} served entries have total_multiplier ≤ ${cap} and credit ≤ ${cap} × stake (exact 18-dp decimals), and all ${sessions.size} bonus sessions' summed credits ≤ ${cap} × stake; the RTP the per-spin cap removes (uncapped − capped 2^32 bonus enumeration, per bonus spin) and its upper bound on the whole-game RTP (P(trigger) × ${maxSpinsPerSession} spins × that difference), the largest served multipliers and each session artifact's cap-hit probability are in this step's data block. The session-level cap's removed return is not enumerated (no uncapped session convolution is pinned)`
      : `MAX-WIN CAP (FLAG, disclosed per R2): ${issues.join('; ')}`,
    {
      cap, roundsChecked, sessionsChecked: sessions.size,
      largestServedTotalMultiplier: maxMult, largestServedWinOverStake: maxWinOverBet, largestSessionWinOverStake: maxSessionOverBet,
      baseEnumerationMaxPayout: base?.max_payout ?? null,
      bonusEnumerationMaxPayoutCapped: bonus?.max_payout ?? null, bonusEnumerationMaxPayoutUncapped: unc?.max_payout ?? null,
      bonusRtpPerSpinCapped: bonus?.rtp ?? null, bonusRtpPerSpinUncapped: unc?.rtp ?? null,
      rtpRemovedPerBonusSpin: perBonusSpinRemoved,
      maxBonusSpinsPerSession: maxSpinsPerSession,
      gameRtpRemovedByPerSpinCapUpperBound: gameRtpRemovedUpperBound,
      sessionCapHitProbabilityByInitialSpins: sessionCapHit,
      issues,
    },
  )];
}
