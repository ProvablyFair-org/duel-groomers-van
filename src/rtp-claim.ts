/**
 * RTP-CLAIM — the rule for what a casino's published RTP has to mean.
 *
 * 1.0.0 — agreed 2026-09-29. Rule text:
 *
 *   "the casino can publish either
 *    1. a single number ("99% rtp") → every setting has to be within the band of it
 *    2. a range ("rtp 98.65–99.07% depending on settings"), anywhere findable, fairness page or
 *       rules is fine → every setting has to sit inside it, and the range has to be the real
 *       one: bottom = their actual worst setting, top = their actual best (within the band).
 *       no "up to 99%", no range wider than reality
 *    … our audit publishes the full per-setting table …
 *    band: pass if within 0.1pp of what they state, past that on the house side is a fail.
 *    player-favourable never fails"
 *
 * 1.1.0 — NO CLAIM. Agreed 2026-10-01. Rule text:
 *
 *   "locking the claim to the figure shown to players, on the game page, fairness page or help
 *    page. a game with no shown figure is marked no claim and still gets its full per-setting
 *    table."
 *
 * So a claim has a third kind, { kind: 'none', source }: no RTP figure is shown to players. Its
 * source must name every place a figure can be shown (the game page, the fairness page, the help
 * page) and state that no RTP figure is shown there — an absence is stated by listing where it was
 * looked for, never by one look. A no-claim still gets the full per-setting table (true min, true
 * max, every row). Its outcome is NO_CLAIM: never a FAIL, enforced or not, and no setting is a
 * house-side failure, because there is no figure to fall short of. flat and range are unchanged
 * from 1.0.0.
 *
 * 1.2.0 — Methodology v1.1. Agreed 2026-10-14 (decisions D2, D3; Mike, DM 14 Oct 14:32 UTC:
 * "D2: as written. The edge in Duel's game settings counts, no screenshot needed." / "D3: rule 1.2.0
 * switched on for all three casinos. A miss is a fail until fixed, but reported as 'RTP Figure
 * Overstated', not 'Not Provably Fair', since the draws themselves pass."). What changes:
 *
 *   - PLACES. A figure can be shown on the game page, the fairness page, the help page, the bet
 *     panel, the rules, or in the game settings the casino's site loads (a stated edge or RTP there
 *     counts as published). A no-claim's source names all six.
 *   - PER-SETTING figures. { kind: 'per-setting', figures: { [setting]: rtp }, source }: each row is
 *     held to its own published figure. A row with no figure is 'unstated': printed, never a miss.
 *   - STAKE TIERS (D2). { kind: 'tiered', tiers: [{ tier, rtp, source }], source }: a row carries the
 *     stake tier it was priced at (SettingRtp.tier) and is held to the figure the casino states for
 *     that tier. A tier with no stated figure is 'unstated': printed as information, never a miss.
 *   - NOTED (D3). { kind: 'noted', source, text }: a site-wide line, rakeback, zero-edge or a
 *     promotion. It is recorded and tabled, never tested: outcome NOTED, never a miss.
 *   - REAL FIGURES PUBLISHED (D3). A flat or range claim may carry realFiguresPublished: { source }:
 *     the casino publishes the real per-setting figures elsewhere it controls. A miss then has the
 *     outcome PUBLISHED, never a miss. A bare paytable does NOT qualify (code cannot tell the two
 *     apart; the package's source string must name the published figures, not a paytable).
 *   - THE OUTCOME OF A MISS (D3). A house-side miss is outcome FAIL in the table (a fail until
 *     fixed) and, when enforced, the -19 check's status is OVERSTATED: the package's verdict is
 *     RTP_FIGURE_OVERSTATED ("RTP FIGURE OVERSTATED", exit RTP_FIGURE_OVERSTATED_EXIT), never
 *     "NOT PROVABLY FAIR" and never a pass. Precedence in a package verdict: a failed draw check
 *     (NOT PROVABLY FAIR, exit 1) > INCOMPLETE (exit 3) > RTP FIGURE OVERSTATED (exit 5) > Conditional
 *     Pass (exit 2) > Full Pass (exit 0). See rtpClaimVerdict.
 *
 * Industry context: GLI-11 v2.0 §4.4.1(b) requires the minimum RTP to hold "at all times … at the
 * lowest end of a non-linear paytable" (it names keno spot combinations), and the lab reports the
 * minimum and maximum theoretical payout. This rule is the same idea stated for a published claim.
 *
 * ENFORCEMENT. The rule is scored only where a package switches it on: RTP_CLAIM_RULE_ENFORCED,
 * imported from ./rtp-claim-switch, default false. Off: a package computes the per-setting table
 * and this rule's outcome and PRINTS them as INFO; no verdict moves. On: the outcome is scored on
 * the game profile's -19 check (a miss → OVERSTATED, see 1.2.0); NO_CLAIM, NOTED and PUBLISHED
 * stay INFO either way.
 *
 * Two files, two roles. THIS file is the rule: every package carries a byte-identical copy
 * (src/rtp-claim.ts) and the framework's conformance gate (C-13) compares the copy's SHA-256 with
 * the framework's core/rtp-claim.ts, so no package can change the rule. The SWITCH is the only
 * per-package part: src/rtp-claim-switch.ts beside the copy, a one-line file exporting
 * `RTP_CLAIM_RULE_ENFORCED: boolean`. `node bin/sync-rtp-claim.mjs` re-vendors this file into the
 * packages, creates a missing switch file with false and never overwrites an existing one; its
 * `--check` compares the copies' bytes and reports each package's switch value. Switching a
 * package on is an edit to that package's switch file only.
 *
 * ARITHMETIC. Everything is exact: RTPs, the claim and the band are rationals over bigint. A
 * per-setting RTP is given either as a Rational or as a plain decimal string ("0.99", "98.65%"
 * is NOT accepted — percentages are written as fractions of 1). Nothing here uses a float.
 *
 * This file must stay self-contained (Node built-ins and ./rtp-claim-switch only): it is vendored
 * verbatim.
 */
import * as fs from 'fs';
import { createHash } from 'crypto';

import { RTP_CLAIM_RULE_ENFORCED } from './rtp-claim-switch';

/** The enforcement switch, read from the package's own ./rtp-claim-switch. See the header. */
export { RTP_CLAIM_RULE_ENFORCED };

/** Rule identity, printed with every outcome. */
export const RTP_CLAIM_RULE_ID = 'RTP-CLAIM';
export const RTP_CLAIM_RULE_VERSION = '1.2.0 (Methodology v1.1: places, per-setting, stake tiers, noted, published, RTP Figure Overstated; agreed 2026-10-14; 1.1.0 2026-10-01; 1.0.0 2026-09-29)';

/** The verdict a package prints when the enforced rule finds a miss and no draw check failed (D3). */
export const RTP_FIGURE_OVERSTATED = 'RTP FIGURE OVERSTATED';
/** Its exit code: distinct from 0 Full Pass, 1 NOT PROVABLY FAIR, 2 Conditional Pass, 3 INCOMPLETE, 4 stale bundle. */
export const RTP_FIGURE_OVERSTATED_EXIT = 5;

/**
 * The package verdict with the rule folded in, so every carrier ranks the outcomes the same way:
 * a failed draw check > INCOMPLETE > RTP FIGURE OVERSTATED > Conditional Pass > Full Pass.
 * `overstated` is true when the -19 check's status is OVERSTATED.
 */
export function rtpClaimVerdict(v: { fails: number; complete: boolean; overstated: boolean; opFlags: number }): { verdict: string; exit: number } {
  if (v.fails > 0) return { verdict: 'NOT PROVABLY FAIR', exit: 1 };
  if (!v.complete) return { verdict: 'INCOMPLETE', exit: 3 };
  if (v.overstated) return { verdict: RTP_FIGURE_OVERSTATED, exit: RTP_FIGURE_OVERSTATED_EXIT };
  if (v.opFlags > 0) return { verdict: 'PROVABLY FAIR — Conditional Pass', exit: 2 };
  return { verdict: 'PROVABLY FAIR — Full Pass', exit: 0 };
}

/**
 * The band: 0.1 percentage point = 0.001 as a fraction of 1. Policy: a setting within 0.1 pp of
 * what the casino states passes; past that on the house side is a fail; player-favourable
 * (above the claim) never fails. For a range claim the published ends must also be within 0.1 pp
 * of the true worst / best setting ("no range wider than reality").
 */
export const RTP_CLAIM_BAND = '0.001';

export interface Rational { n: bigint; d: bigint }

/** 1.2.0 (D3): the casino publishes its real per-setting figures elsewhere it controls; not a bare paytable. */
export interface RealFiguresPublished { source: string }

/** 1.2.0 (D2): the figure a casino states for one stake tier ("$0–$200", "tier 3"). */
export interface RtpTier { tier: string; rtp: string; source: string }

export type RtpClaim =
  | { kind: 'flat'; rtp: string; source: string; realFiguresPublished?: RealFiguresPublished }
  | { kind: 'range'; min: string; max: string; source: string; realFiguresPublished?: RealFiguresPublished }
  /**
   * No RTP figure is shown to players (1.1.0). `source` names every place a figure can be shown —
   * RTP_CLAIM_PLACES — and states that no RTP figure is shown there, e.g. "no RTP figure on the
   * game page, the fairness page, the help page, the bet panel, the rules or the game settings
   * (read 2026-10-14)". Checked by checkNoClaimSource.
   */
  | { kind: 'none'; source: string }
  /** 1.2.0: one published figure per setting; a row is held to its own figure. */
  | { kind: 'per-setting'; figures: Record<string, string>; source: string }
  /** 1.2.0 (D2): one published figure per stake tier; a row is held to its tier's figure. */
  | { kind: 'tiered'; tiers: RtpTier[]; source: string }
  /** 1.2.0 (D3): a site-wide line, rakeback, zero-edge or a promotion: recorded, never tested. */
  | { kind: 'noted'; source: string; text: string };

/**
 * Every place the rule lets a casino show its figure (1.1.0: the first three; 1.2.0 adds the bet
 * panel, the rules and the game settings the site loads). A no-claim names each.
 */
export const RTP_CLAIM_PLACES = ['game page', 'fairness page', 'help page', 'bet panel', 'rules', 'game settings'] as const;

/**
 * A no-claim's source, held to what the rule asks of it: a non-empty string that names each of
 * RTP_CLAIM_PLACES and says "no RTP figure" (case-insensitive). Throws, naming what is missing.
 */
export function checkNoClaimSource(source: unknown): void {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('rtp-claim: a no-claim needs a source saying where a figure was looked for and that none is shown');
  }
  const t = source.toLowerCase();
  const missing: string[] = RTP_CLAIM_PLACES.filter(p => !t.includes(p));
  if (!/\bno rtp figure/.test(t)) missing.push('"no RTP figure"');
  if (missing.length) {
    throw new Error(`rtp-claim: a no-claim source must name the ${RTP_CLAIM_PLACES.join(', the ')} and say "no RTP figure"; missing: ${missing.join(', ')}`);
  }
}

export interface SettingRtp {
  /** A stable, human-readable key for the setting: "risk=high picks=10", "target=2.00". */
  setting: string;
  /** Exact RTP as a fraction of 1: a Rational, or a decimal string / "n/d" string. */
  rtp: Rational | string;
  /** 1.2.0: the stake tier the setting is priced at; required under a 'tiered' claim. */
  tier?: string;
}

/**
 * 'no-claim': the setting is measured, but there is no figure to hold it to (kind 'none').
 * 'noted': the claim is kind 'noted' — recorded, not tested. 'unstated': a per-setting or tiered
 * claim states no figure for this row's setting / tier — printed, never a miss.
 */
export type RtpSide = 'within-band' | 'player-favourable' | 'house-side-beyond-band' | 'no-claim' | 'noted' | 'unstated';

export type RtpRowOutcome = 'PASS' | 'FAIL' | 'NO_CLAIM' | 'NOTED' | 'INFO';
/**
 * FAIL: a house-side miss (reported, when enforced, as RTP FIGURE OVERSTATED). NO_CLAIM / NOTED:
 * nothing to test. PUBLISHED: a miss, but the claim carries realFiguresPublished — never a miss.
 */
export type RtpOutcome = 'PASS' | 'FAIL' | 'NO_CLAIM' | 'NOTED' | 'PUBLISHED';

export interface RtpClaimRow {
  setting: string;
  /** 1.2.0: the row's stake tier, when the package gives one. */
  tier?: string;
  /** Exact value, "n/d" in lowest terms. */
  rtpExact: string;
  /** RTP in percent, 6 decimals (half-up), for reading only; rtpExact is the value of record. */
  rtpPct: string;
  /**
   * RTP minus the reference the claim sets for this setting, in percentage points, 6 decimals;
   * null when the row has no reference (no-claim, noted, unstated).
   */
  gapPp: string | null;
  side: RtpSide;
  outcome: RtpRowOutcome;
}

export interface RtpRangeCheck {
  id: 'published-min-vs-true-min' | 'published-max-vs-true-max';
  publishedPct: string;
  truePct: string;
  /** published minus true, percentage points. */
  gapPp: string;
  outcome: 'PASS' | 'FAIL';
  why: string;
}

export interface RtpClaimResult {
  rule: string;
  ruleVersion: string;
  enforced: boolean;
  bandPp: string;
  claim: RtpClaim;
  settings: number;
  trueMin: { setting: string; rtpExact: string; rtpPct: string };
  trueMax: { setting: string; rtpExact: string; rtpPct: string };
  houseSideFailures: number;
  playerFavourable: number;
  /**
   * The row furthest below its reference and its gap (under flat and range: the true minimum
   * setting); gapPp null when no row has a reference.
   */
  worst: { setting: string; gapPp: string | null };
  rangeChecks: RtpRangeCheck[];
  /** NO_CLAIM (kind 'none'), NOTED (kind 'noted') and PUBLISHED are never a miss, enforced or not. */
  outcome: RtpOutcome;
  /** 1.2.0: rows whose setting / tier has no stated figure (per-setting, tiered); never a miss. */
  unstated: number;
  /**
   * What the casino would minimally have to change for the outcome to be PASS. Under a no-claim
   * there is nothing to change: it says so and gives the true range.
   */
  minimalFix: string;
  /** true when `rows` is the full per-setting table; false when capped (see RtpClaimOptions). */
  rowsComplete: boolean;
  rows: RtpClaimRow[];
  /** Per-bucket summary when the package groups its settings (a target grid by decade). */
  buckets: RtpClaimBucket[];
}

// ---------------------------------------------------------------------------------------------
// exact rationals

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);

function gcd(a: bigint, b: bigint): bigint {
  if (a < ZERO) a = -a;
  if (b < ZERO) b = -b;
  while (b !== ZERO) { const t = a % b; a = b; b = t; }
  return a;
}

export function rat(n: bigint, d: bigint = ONE): Rational {
  if (d === ZERO) throw new Error('rtp-claim: zero denominator');
  if (d < ZERO) { n = -n; d = -d; }
  const g = gcd(n, d) || ONE;
  return { n: n / g, d: d / g };
}

/** "0.99", "-1.5", "12", "989/1000" → exact Rational. No exponents, no percent signs. */
export function parseRational(s: string): Rational {
  const t = s.trim();
  const frac = /^(-?\d+)\s*\/\s*(\d+)$/.exec(t);
  if (frac) return rat(BigInt(frac[1] as string), BigInt(frac[2] as string));
  const dec = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!dec) throw new Error(`rtp-claim: not an exact decimal or fraction: "${s}"`);
  const sign = dec[1] === '-' ? -ONE : ONE;
  const whole = dec[2] as string;
  const fracDigits = dec[3] ?? '';
  return rat(sign * BigInt(whole + fracDigits), TEN ** BigInt(fracDigits.length));
}

/**
 * The exact value of a finite double (every double is m·2^e). For an RTP a package derives
 * numerically — a recursive EV engine, a double-precision convolution — the rule is then exact on
 * that figure, and the package states the figure's own precision beside it.
 */
export function rationalFromDouble(x: number): Rational {
  if (!Number.isFinite(x)) throw new Error(`rtp-claim: ${x} is not a finite number`);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const sign = hi >>> 31 ? -ONE : ONE;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << BigInt(32)) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else { mant |= ONE << BigInt(52); e = exp - 1075; }
  return e >= 0 ? rat(sign * mant * (ONE << BigInt(e)), ONE) : rat(sign * mant, ONE << BigInt(-e));
}

const asRat = (v: Rational | string): Rational => (typeof v === 'string' ? parseRational(v) : rat(v.n, v.d));
export const add = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational): Rational => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d);
export const cmp = (a: Rational, b: Rational): number => {
  const l = a.n * b.d, r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
export const ratStr = (a: Rational): string => `${a.n}/${a.d}`;

/** Decimal string with `places` decimals, rounded half away from zero. Display only. */
export function toFixed(a: Rational, places: number): string {
  const neg = a.n < ZERO;
  const n = neg ? -a.n : a.n;
  const scale = TEN ** BigInt(places);
  const q = (n * scale * BigInt(2) + a.d) / (a.d * BigInt(2));
  const s = q.toString().padStart(places + 1, '0');
  const body = places > 0 ? `${s.slice(0, s.length - places)}.${s.slice(s.length - places)}` : s;
  return (neg && q !== ZERO ? '-' : '') + body;
}

/** Decimal string with `places` decimals, rounded toward -infinity / +infinity. */
function toFixedDir(a: Rational, places: number, dir: 'down' | 'up'): string {
  const scale = TEN ** BigInt(places);
  const num = a.n * scale;
  let q = num / a.d; // truncates toward zero
  const exact = q * a.d === num;
  if (!exact) {
    if (dir === 'down' && num < ZERO) q -= ONE;
    if (dir === 'up' && num > ZERO) q += ONE;
  }
  const neg = q < ZERO;
  const s = (neg ? -q : q).toString().padStart(places + 1, '0');
  const body = places > 0 ? `${s.slice(0, s.length - places)}.${s.slice(s.length - places)}` : s;
  return (neg ? '-' : '') + body;
}

const HUNDRED: Rational = { n: BigInt(100), d: ONE };
const pct = (a: Rational): string => toFixed(mul(a, HUNDRED), 6);

// ---------------------------------------------------------------------------------------------
// the rule

type Num = number | bigint;
const big = (x: Num): bigint => (typeof x === 'bigint' ? x : BigInt(x));

/**
 * a/b < c/d for positive denominators; exact. A double comparison decides only when the two
 * quotients are separated by more than 1e-9 relative — each Number() conversion and division is
 * correctly rounded, so the double quotients carry at most ~4·2^-53 relative error and cannot swap
 * order across that gap. Anything closer (or not finite as a double) is decided in bigint.
 */
function lt(an: Num, ad: Num, cn: Num, cd: Num): boolean {
  const qa = Number(an) / Number(ad), qc = Number(cn) / Number(cd);
  if (Number.isFinite(qa) && Number.isFinite(qc)) {
    const scale = Math.max(Math.abs(qa), Math.abs(qc));
    if (Math.abs(qc - qa) > 1e-9 * scale) return qa < qc;
  }
  return big(an) * big(cd) < big(cn) * big(ad);
}

export interface RtpClaimBucket {
  bucket: string;
  settings: number;
  minPct: string;
  maxPct: string;
  houseSideFailures: number;
  playerFavourable: number;
}

export interface RtpClaimOptions {
  /**
   * 'all' keeps every row (the full per-setting table). A number keeps at most that many
   * house-side rows plus the true min and max rows — for legal-target grids with millions of
   * settings, where the committed table is the buckets and the full table is regenerable.
   */
  retainRows?: 'all' | number;
}

/** A reference a row is held to: the claim's bottom and top, and the band around them. */
interface Ref { lo: Rational; hi: Rational; floor: Rational; ceil: Rational }

function refOf(lo: Rational, hi: Rational): Ref {
  const band = parseRational(RTP_CLAIM_BAND);
  if (cmp(lo, hi) > 0) throw new Error('rtp-claim: range claim with min > max');
  return { lo, hi, floor: sub(lo, band), ceil: add(hi, band) };
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A row kept for the table; `ref` is the reference it was held to (null: none). */
interface Kept { s: string; r: Rational; tier?: string; ref: Ref | null }

/**
 * Streaming form of the rule, for settings counted in millions (a limbo target grid). Every
 * setting still goes through the exact comparison; only what is RETAINED for the table is capped.
 * Per-setting and tiered claims keep every row (their tables are small and each row has its own
 * reference).
 */
export class RtpClaimAccumulator {
  private readonly claim: RtpClaim;
  private readonly retain: 'all' | number;
  /** flat / range: the one reference; null for every other kind. */
  private readonly ref: Ref | null;
  /** per-setting (by setting) and tiered (by tier): the reference of each key. */
  private readonly keyed: Map<string, Ref> | null;
  private n = 0;
  private houseFails = 0;
  private fav = 0;
  private unstated = 0;
  private minV: { s: string; n: Num; d: Num } | null = null;
  private maxV: { s: string; n: Num; d: Num } | null = null;
  private rows: Kept[] = [];
  private buckets = new Map<string, { settings: number; minN: Num; minD: Num; maxN: Num; maxD: Num; house: number; fav: number }>();

  constructor(claim: RtpClaim, opts: RtpClaimOptions = {}) {
    this.claim = claim;
    this.retain = opts.retainRows ?? 'all';
    if (claim.kind !== 'none' && !nonEmpty(claim.source)) throw new Error(`rtp-claim: a ${claim.kind} claim needs a source`);
    const stray = (allowed: string[]): void => {
      const extra = ['rtp', 'min', 'max', 'figures', 'tiers', 'text', 'realFiguresPublished'].filter(k => k in claim && !allowed.includes(k));
      if (extra.length) throw new Error(`rtp-claim: a ${claim.kind === 'none' ? 'no-claim states no figure, but' : `${claim.kind} claim`} carries ${extra.join(', ')}`);
    };
    this.ref = null;
    this.keyed = null;
    switch (claim.kind) {
      case 'none':
        checkNoClaimSource(claim.source);
        stray([]);
        return;
      case 'noted':
        if (!nonEmpty(claim.text)) throw new Error('rtp-claim: a noted claim needs the text it records');
        stray(['text']);
        return;
      case 'flat':
      case 'range': {
        stray(claim.kind === 'flat' ? ['rtp', 'realFiguresPublished'] : ['min', 'max', 'realFiguresPublished']);
        const p = claim.realFiguresPublished;
        if (p !== undefined) {
          if (!nonEmpty(p.source)) throw new Error('rtp-claim: realFiguresPublished needs the source of the published figures');
          if (/paytable/i.test(p.source)) throw new Error('rtp-claim: a bare paytable is not published RTP figures (D3); name where the figures themselves are published');
        }
        const lo = claim.kind === 'flat' ? parseRational(claim.rtp) : parseRational(claim.min);
        const hi = claim.kind === 'flat' ? lo : parseRational(claim.max);
        this.ref = refOf(lo, hi);
        return;
      }
      case 'per-setting':
      case 'tiered': {
        stray(claim.kind === 'per-setting' ? ['figures'] : ['tiers']);
        if (this.retain !== 'all') throw new Error(`rtp-claim: a ${claim.kind} claim keeps every row (retainRows 'all')`);
        const m = new Map<string, Ref>();
        if (claim.kind === 'per-setting') {
          for (const [k, v] of Object.entries(claim.figures ?? {})) { const f = parseRational(v); m.set(k, refOf(f, f)); }
        } else {
          for (const t of claim.tiers ?? []) {
            if (!nonEmpty(t.tier) || !nonEmpty(t.source)) throw new Error('rtp-claim: every stated tier needs a tier name and a source');
            if (m.has(t.tier)) throw new Error(`rtp-claim: tier "${t.tier}" stated twice`);
            const f = parseRational(t.rtp);
            m.set(t.tier, refOf(f, f));
          }
        }
        if (m.size === 0) throw new Error(`rtp-claim: a ${claim.kind} claim states no figure; use kind 'none'`);
        this.keyed = m;
        return;
      }
      default:
        throw new Error(`rtp-claim: unknown claim kind ${(claim as { kind?: unknown }).kind}`);
    }
  }

  /**
   * One setting. `num/den` is its exact RTP (den > 0). `label` may be a thunk so a grid of
   * millions does not build millions of strings; `bucket` groups the committed summary; `tier` is
   * the stake tier the setting is priced at (required under a tiered claim).
   */
  add(label: string | (() => string), num: Num, den: Num, bucket?: string, tier?: string): void {
    if ((typeof den === 'bigint' ? den <= ZERO : den <= 0)) throw new Error('rtp-claim: non-positive denominator');
    if (typeof num === 'number' && !Number.isSafeInteger(num)) throw new Error(`rtp-claim: numerator ${num} is not an exact integer`);
    if (typeof den === 'number' && !Number.isSafeInteger(den)) throw new Error(`rtp-claim: denominator ${den} is not an exact integer`);
    if (this.claim.kind === 'tiered' && !nonEmpty(tier)) throw new Error('rtp-claim: under a tiered claim every setting needs its stake tier');
    this.n++;
    const name = (): string => (typeof label === 'string' ? label : label());
    let keptName: string | null = null;
    const nm = (): string => (keptName ??= name());
    let ref: Ref | null = this.ref;
    if (this.keyed) {
      ref = this.keyed.get(this.claim.kind === 'tiered' ? (tier as string) : nm()) ?? null;
      if (ref === null) this.unstated++;
    }
    // No reference (no claim, noted, unstated): no floor and no ceiling, so neither house-side nor favourable.
    const house = ref !== null && lt(num, den, ref.floor.n, ref.floor.d);
    const fav = !house && ref !== null && lt(ref.ceil.n, ref.ceil.d, num, den);
    if (house) this.houseFails++;
    if (fav) this.fav++;
    if (this.minV === null || lt(num, den, this.minV.n, this.minV.d)) this.minV = { s: nm(), n: num, d: den };
    if (this.maxV === null || lt(this.maxV.n, this.maxV.d, num, den)) this.maxV = { s: nm(), n: num, d: den };
    if (this.retain === 'all' || (house && this.rows.length < this.retain)) {
      const k: Kept = { s: nm(), r: rat(big(num), big(den)), ref };
      if (tier !== undefined) k.tier = tier;
      this.rows.push(k);
    }
    if (bucket !== undefined) {
      const b = this.buckets.get(bucket);
      if (!b) this.buckets.set(bucket, { settings: 1, minN: num, minD: den, maxN: num, maxD: den, house: house ? 1 : 0, fav: fav ? 1 : 0 });
      else {
        b.settings++;
        if (lt(num, den, b.minN, b.minD)) { b.minN = num; b.minD = den; }
        if (lt(b.maxN, b.maxD, num, den)) { b.maxN = num; b.maxD = den; }
        if (house) b.house++;
        if (fav) b.fav++;
      }
    }
  }

  result(): RtpClaimResult {
    if (this.n === 0 || !this.minV || !this.maxV) throw new Error('rtp-claim: no settings — a rule over nothing is not a pass');
    if (this.keyed && this.unstated === this.n) throw new Error(`rtp-claim: the ${this.claim.kind} claim holds no setting (every row unstated); use kind 'none'`);
    const band = parseRational(RTP_CLAIM_BAND);
    const loR = rat(big(this.minV.n), big(this.minV.d));
    const hiR = rat(big(this.maxV.n), big(this.maxV.d));
    const minV = this.minV, maxV = this.maxV;
    const claim = this.claim;
    const published = (claim.kind === 'flat' || claim.kind === 'range') && claim.realFiguresPublished !== undefined;
    const gapOf = (r: Rational, f: Ref): Rational =>
      cmp(r, f.lo) < 0 ? sub(r, f.lo) : cmp(r, f.hi) > 0 ? sub(r, f.hi) : rat(ZERO);
    const row = (k: Kept): RtpClaimRow => {
      const base = { setting: k.s, ...(k.tier !== undefined ? { tier: k.tier } : {}), rtpExact: ratStr(k.r), rtpPct: pct(k.r) };
      if (claim.kind === 'none') return { ...base, gapPp: null, side: 'no-claim', outcome: 'NO_CLAIM' };
      if (claim.kind === 'noted') return { ...base, gapPp: null, side: 'noted', outcome: 'NOTED' };
      if (k.ref === null) return { ...base, gapPp: null, side: 'unstated', outcome: 'INFO' };
      const side: RtpSide = cmp(k.r, k.ref.floor) < 0 ? 'house-side-beyond-band'
        : cmp(k.r, k.ref.ceil) > 0 ? 'player-favourable' : 'within-band';
      return { ...base, gapPp: toFixed(mul(gapOf(k.r, k.ref), HUNDRED), 6), side,
        outcome: side === 'house-side-beyond-band' && !published ? 'FAIL' : side === 'house-side-beyond-band' ? 'INFO' : 'PASS' };
    };
    const rows = this.rows.map(row);
    if (this.retain !== 'all') {
      // Always carry the two extremes, even when they pass.
      const have = new Set(rows.map(r => r.setting));
      if (!have.has(minV.s)) rows.unshift(row({ s: minV.s, r: loR, ref: this.ref }));
      if (!have.has(maxV.s) && maxV.s !== minV.s) rows.push(row({ s: maxV.s, r: hiR, ref: this.ref }));
    }
    // The honest range, in percent with 2 decimals rounded outward (bottom down, top up): always
    // within 0.01 pp of the truth, so inside the band.
    const trueRange = `${toFixedDir(mul(loR, HUNDRED), 2, 'down')}–${toFixedDir(mul(hiR, HUNDRED), 2, 'up')}%`;
    const buckets: RtpClaimBucket[] = [...this.buckets.entries()].map(([k, b]) => ({
      bucket: k, settings: b.settings,
      minPct: pct(rat(big(b.minN), big(b.minD))), maxPct: pct(rat(big(b.maxN), big(b.maxD))),
      houseSideFailures: b.house, playerFavourable: b.fav,
    }));
    const common = {
      rule: RTP_CLAIM_RULE_ID,
      ruleVersion: RTP_CLAIM_RULE_VERSION,
      enforced: RTP_CLAIM_RULE_ENFORCED,
      bandPp: toFixed(mul(band, HUNDRED), 2),
      claim,
      settings: this.n,
      trueMin: { setting: minV.s, rtpExact: ratStr(loR), rtpPct: pct(loR) },
      trueMax: { setting: maxV.s, rtpExact: ratStr(hiR), rtpPct: pct(hiR) },
    };
    const tail = { unstated: this.unstated, rowsComplete: this.retain === 'all', rows, buckets };

    if (claim.kind === 'none' || claim.kind === 'noted') {
      // Nothing to hold: every setting is measured and tabled; none is held to a figure.
      return {
        ...common, houseSideFailures: 0, playerFavourable: 0,
        worst: { setting: minV.s, gapPp: null }, rangeChecks: [],
        outcome: claim.kind === 'none' ? 'NO_CLAIM' : 'NOTED',
        minimalFix: claim.kind === 'none'
          ? `none — no RTP figure is shown to players, so there is no claim to hold; the true range is ${trueRange}`
          : `none — a noted line (site-wide, rakeback, zero-edge or promotion) is recorded, not tested; the true range is ${trueRange}`,
        ...tail,
      };
    }

    const rangeChecks: RtpRangeCheck[] = [];
    let worst: { setting: string; gapPp: string | null };
    if (claim.kind === 'flat' || claim.kind === 'range') {
      const f = this.ref as Ref;
      worst = { setting: minV.s, gapPp: toFixed(mul(gapOf(loR, f), HUNDRED), 6) };
      if (claim.kind === 'range') {
        const gMin = sub(f.lo, loR);
        rangeChecks.push({
          id: 'published-min-vs-true-min',
          publishedPct: pct(f.lo), truePct: pct(loR), gapPp: toFixed(mul(gMin, HUNDRED), 6),
          outcome: cmp(gMin, rat(-band.n, band.d)) < 0 ? 'FAIL' : 'PASS',
          why: 'the published bottom must be the actual worst setting within the band — no range wider than reality (a bottom above the worst setting shows up as house-side rows)',
        });
        const gMax = sub(f.hi, hiR);
        rangeChecks.push({
          id: 'published-max-vs-true-max',
          publishedPct: pct(f.hi), truePct: pct(hiR), gapPp: toFixed(mul(gMax, HUNDRED), 6),
          outcome: cmp(gMax, band) > 0 ? 'FAIL' : 'PASS',
          why: 'the published top must be the actual best setting within the band — no "up to", no range wider than reality',
        });
      }
    } else {
      // per-setting / tiered: the row furthest below its own reference.
      let w: { s: string; g: Rational } | null = null;
      for (const k of this.rows) {
        if (k.ref === null) continue;
        const g = gapOf(k.r, k.ref);
        if (w === null || cmp(g, w.g) < 0) w = { s: k.s, g };
      }
      const ww = w as { s: string; g: Rational };
      worst = { setting: ww.s, gapPp: toFixed(mul(ww.g, HUNDRED), 6) };
    }

    const miss = this.houseFails > 0 || rangeChecks.some(c => c.outcome === 'FAIL');
    const outcome: RtpOutcome = !miss ? 'PASS' : published ? 'PUBLISHED' : 'FAIL';

    let minimalFix: string;
    if (outcome === 'PASS') minimalFix = 'none — the claim holds for every setting it states a figure for';
    else if (outcome === 'PUBLISHED') {
      minimalFix = `none — the figure is missed by ${this.houseFails} setting(s), but the real per-setting figures are published (${(claim as { realFiguresPublished: RealFiguresPublished }).realFiguresPublished.source}); the true range is ${trueRange}`;
    } else if (claim.kind === 'flat') {
      const f = this.ref as Ref;
      minimalFix = `publish the real range "rtp ${trueRange} depending on settings", or change the ${this.houseFails} setting(s) below ${pct(f.floor)}% so each returns at least ${pct(f.floor)}%`;
    } else if (claim.kind === 'range') {
      const parts: string[] = [];
      if (this.houseFails > 0) parts.push(`${this.houseFails} setting(s) sit below the published bottom by more than the band`);
      for (const c of rangeChecks) if (c.outcome === 'FAIL') parts.push(`${c.id} off by ${c.gapPp} pp`);
      minimalFix = `publish the real range "rtp ${trueRange} depending on settings" (${parts.join('; ')})`;
    } else {
      const what = claim.kind === 'tiered'
        ? `tier(s) ${[...new Set(this.rows.filter(k => k.ref !== null && cmp(k.r, k.ref.floor) < 0).map(k => k.tier))].join(', ')}`
        : `${this.houseFails} setting(s)`;
      minimalFix = `publish the real figure for ${what} (worst ${worst.setting} at ${worst.gapPp} pp), or change them so each returns at least its published figure less the band`;
    }

    return { ...common, houseSideFailures: this.houseFails, playerFavourable: this.fav, worst, rangeChecks, outcome, minimalFix, ...tail };
  }
}

/** The rule over a list: every row retained (the full per-setting table). */
export function evaluateRtpClaim(input: SettingRtp[], claim: RtpClaim, opts: RtpClaimOptions = {}): RtpClaimResult {
  const acc = new RtpClaimAccumulator(claim, opts);
  for (const s of input) { const r = asRat(s.rtp); acc.add(s.setting, r.n, r.d, undefined, s.tier); }
  return acc.result();
}

/** Outcomes that are never a miss, enforced or not. */
const NEVER_A_MISS: ReadonlyArray<RtpOutcome> = ['NO_CLAIM', 'NOTED', 'PUBLISHED'];

/**
 * The status a package's -19 step takes from this rule. Not enforced → 'INFO' (printed, never
 * counted, verdict unchanged). Enforced → 'PASS', or 'OVERSTATED' for a miss (1.2.0, D3: the
 * package verdict is RTP FIGURE OVERSTATED, see rtpClaimVerdict — never NOT PROVABLY FAIR).
 * NO_CLAIM, NOTED and PUBLISHED → 'INFO' either way.
 */
export function rtpClaimStatus(r: RtpClaimResult): 'INFO' | 'PASS' | 'OVERSTATED' {
  if (!RTP_CLAIM_RULE_ENFORCED || NEVER_A_MISS.includes(r.outcome)) return 'INFO';
  return r.outcome === 'PASS' ? 'PASS' : 'OVERSTATED';
}

/** The claim in one phrase, for the console. */
function claimText(c: RtpClaim): string {
  switch (c.kind) {
    case 'flat': return `flat ${pct(parseRational(c.rtp))}%`;
    case 'range': return `range ${pct(parseRational(c.min))}–${pct(parseRational(c.max))}%`;
    case 'per-setting': return `per-setting figures (${Object.keys(c.figures).length} stated)`;
    case 'tiered': return `stake tiers ${c.tiers.map(t => `${t.tier} ${pct(parseRational(t.rtp))}%`).join(' · ')}`;
    case 'none': return 'no claim: no RTP figure shown to players';
    case 'noted': return `noted, not tested: "${c.text}"`;
  }
}

/**
 * Console lines for a verifier. Deliberately free of the "[PASS] / [FAIL] / [INFO] Step N"
 * markers and of upper-case verdict words while the rule is not enforced, so no existing
 * output parser (mutation batteries, release bars) can read it as a step.
 */
export function formatRtpClaim(r: RtpClaimResult, maxRows = 10): string[] {
  const n = r.settings.toLocaleString('en-US');
  const off = 'informational (RTP_CLAIM_RULE_ENFORCED = false) — reported only, verdict unchanged';
  if (r.claim.kind === 'none' || r.claim.kind === 'noted') {
    return [
      `rtp-claim: ${r.enforced ? `ENFORCED — ${r.outcome}, never scored as a miss` : off}`,
      `rtp-claim:   ${claimText(r.claim)} — source: ${r.claim.source}`,
      `rtp-claim:   true range ${r.trueMin.rtpPct}–${r.trueMax.rtpPct}% over ${n} settings · true min ${r.trueMin.rtpPct}% (${r.trueMin.setting}) · true max ${r.trueMax.rtpPct}% (${r.trueMax.setting})`,
      `rtp-claim:   outcome ${r.enforced ? r.outcome : r.outcome.toLowerCase().replace('_', ' ')} (never a miss, enforced or not) · per-setting table: `
        + (r.rowsComplete ? `all ${n} rows` : `${r.rows.length.toLocaleString('en-US')} rows retained of ${n}, ${r.buckets.length} buckets`),
    ];
  }
  const said = (o: RtpOutcome): string => (!r.enforced ? o.toLowerCase() : o === 'FAIL' ? RTP_FIGURE_OVERSTATED : o);
  const lines = [
    `rtp-claim: ${r.enforced ? `ENFORCED — ${said(r.outcome)}` : off}`,
    `rtp-claim:   claim ${claimText(r.claim)} — source: ${r.claim.source}`,
    `rtp-claim:   band ±${r.bandPp} pp · ${n} settings · true min ${r.trueMin.rtpPct}% (${r.trueMin.setting}) · true max ${r.trueMax.rtpPct}% (${r.trueMax.setting})`,
    `rtp-claim:   house side beyond band: ${r.houseSideFailures.toLocaleString('en-US')} · player-favourable beyond band: ${r.playerFavourable.toLocaleString('en-US')}`
      + (r.unstated ? ` · no figure stated: ${r.unstated.toLocaleString('en-US')} (information only)` : '')
      + ` · worst ${r.worst.setting} at ${r.worst.gapPp} pp`,
  ];
  if ((r.claim.kind === 'flat' || r.claim.kind === 'range') && r.claim.realFiguresPublished) {
    lines.push(`rtp-claim:   real per-setting figures published: ${r.claim.realFiguresPublished.source}`);
  }
  for (const c of r.rangeChecks) lines.push(`rtp-claim:   ${c.id}: published ${c.publishedPct}% vs true ${c.truePct}% (${c.gapPp} pp) → ${r.enforced ? c.outcome : c.outcome.toLowerCase()}`);
  const bad = r.rows.filter(x => x.side === 'house-side-beyond-band').slice(0, maxRows);
  for (const b of bad) lines.push(`rtp-claim:     house side ${b.setting}${b.tier !== undefined ? ` [tier ${b.tier}]` : ''}: ${b.rtpPct}% (${b.gapPp} pp)`);
  if (r.houseSideFailures > bad.length) lines.push(`rtp-claim:     … ${(r.houseSideFailures - bad.length).toLocaleString('en-US')} more house-side setting(s) — see the committed table`);
  lines.push(`rtp-claim:   outcome ${said(r.outcome)}${r.enforced ? '' : ` (a miss is scored as ${RTP_FIGURE_OVERSTATED.toLowerCase()} only when enforced)`} · minimal fix: ${r.minimalFix}`);
  return lines;
}

/**
 * The committed per-setting table (outputs/rtp-claim-table.json): the result minus `enforced`,
 * which is policy, not measurement — so flipping the switch does not rewrite evidence. One row per
 * line, so a table of ten thousand settings stays diffable.
 */
export function rtpClaimTable(r: RtpClaimResult, meta: { package: string; game: string; settingSpace: string; rtpMethod: string }): string {
  const { enforced: _e, rows, buckets, ...rest } = r;
  const head = JSON.stringify({ ...meta, ...rest }, null, 2).replace(/\n}$/, '');
  const list = (xs: unknown[]): string =>
    xs.length === 0 ? '[]' : `[\n${xs.map(x => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`;
  return `${head},\n  "buckets": ${list(buckets)},\n  "rows": ${list(rows)}\n}\n`;
}

export interface RtpClaimGate {
  result: RtpClaimResult;
  /** The committed table equals this run's table byte for byte AND its SHA-256 equals the pin. */
  tableMatches: boolean;
  /**
   * 'INFO' while not enforced, and always for NO_CLAIM / NOTED / PUBLISHED. Enforced: 'PASS',
   * 'OVERSTATED' for a miss (verdict RTP FIGURE OVERSTATED), or 'FAIL' when the committed table
   * does not match this run (evidence that no longer matches its code — a reproduction failure).
   */
  status: 'INFO' | 'PASS' | 'OVERSTATED' | 'FAIL';
  lines: string[];
}

/**
 * The verifier hook. Recomputes nothing itself: it takes this run's result and table text, holds
 * the committed table to both (bytes and pin), and returns the lines to print. A committed table
 * that disagrees is evidence that no longer matches its code — the caller treats it as a
 * reproduction failure (exit 1) whether or not the rule is enforced, because it is about the
 * artifact, not about the claim.
 */
export function rtpClaimGate(r: RtpClaimResult, tableText: string, committedPath: string, pinnedSha256: string): RtpClaimGate {
  let committed: string | null = null;
  try { committed = fs.readFileSync(committedPath, 'utf8'); } catch { committed = null; }
  const sha = committed === null ? null : createHash('sha256').update(committed).digest('hex');
  const bytesMatch = committed === tableText;
  const pinMatch = sha === pinnedSha256;
  const tableMatches = bytesMatch && pinMatch;
  const lines = formatRtpClaim(r);
  lines.push(`rtp-claim:   committed table ${committedPath.split(/[\\/]/).slice(-2).join('/')}: `
    + (committed === null ? 'ABSENT'
      : `${bytesMatch ? 'equals this run' : 'DIFFERS from this run'}; sha256 ${sha!.slice(0, 16)}… ${pinMatch ? 'matches' : 'DOES NOT MATCH'} the pin`));
  const s = rtpClaimStatus(r);
  const status: RtpClaimGate['status'] = s === 'INFO' ? 'INFO' : !tableMatches ? 'FAIL' : s;
  return { result: r, tableMatches, status, lines };
}
