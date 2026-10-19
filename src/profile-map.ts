/**
 * Which ProvablyFair.org Groomer's Van profile check each scored step implements.
 *
 * The profile (`_workspace/pf-audit-framework/games/groomers-van/profile.json`, GROOMERS-01 …
 * GROOMERS-30, 1.0.2 — approved 2026-10-14, Methodology v1.1 D6) declares the checks; this
 * suite scores 35 steps under its own numbering. The mapping is emitted into
 * `outputs/verification-results.json` beside the step results and read back by `pf-audit matrix`.
 *
 * THIS FILE LABELS; IT DOES NOT CHECK. A check is claimed only where the step's assertion decides the
 * profile's `asserts` text, read from the CURRENT step code (2026-09-26).
 *
 * COVERAGE DESCRIBES THE PACKAGE, NOT THE STEP: `full` = nothing the profile requires is unimplemented
 * (split checks: each note names its half); `partial` = something is implemented nowhere, named.
 */

export type Coverage = 'full' | 'partial';
export interface CheckClaim { id: string; coverage: Coverage; note?: string }
export interface StepClaims { claims: CheckClaim[]; reason?: string }

export const PROFILE_GAME = 'groomers-van';
export const PROFILE_VERSION = '1.0.2';

export const STEP_CLAIMS: Record<number, StepClaims> = {
  1: { claims: [{ id: 'GROOMERS-01', coverage: 'full',
    note: 'SHA-256(hex_decode(server_seed)) against the committed hash on all 116 revealed seeds, bound to EXPECTED_REVEALED_SEEDS; '
      + 'every epoch a captured bet was served under must resolve to a revealed plaintext (the 117th record is the seed still '
      + 'active when the capture closed, with no bet)' }] },
  2: { claims: [{ id: 'GROOMERS-02', coverage: 'partial',
    note: 'all 116 consecutive links (each rotation\'s active hash = the hash the previous rotation published as next), bound '
      + 'to EXPECTED_SEED_LINKS. PARTIAL: the capture carries no pre-capture link, so the chain is anchored from the first '
      + 'captured epoch onward, not into it (capture-origin; the step says so)' }] },
  3: { claims: [{ id: 'GROOMERS-03', coverage: 'full',
    note: 'epochs from the rotation timeline: all 6,225 entries carry the hash of the rotation active when placed, 116 epochs '
      + 'bound to EXPECTED_EPOCHS; since 2026-09-26 also the client seed that rotation set (the snapshot and, where the /verify '
      + 'payload publishes one, that too) — and Step 4 fails an epoch with more than one client seed. FAIL probed (one bet '
      + 'given a forged client seed)' }] },
  4: { claims: [{ id: 'GROOMERS-04', coverage: 'full',
    note: 'per epoch, on the SERVED nonce (recorded, or the correction declared by spin id — see Step 5): nonces from 0, no reuse, '
      + 'no null, at most 50 regular bets (the capture\'s rotation schedule), one client seed; since 2026-09-26 every gap must be declared BY IDENTITY in src/loader.ts '
      + 'EXPECTED_NONCE_GAPS (epoch hash, nonce) and every declared gap must be present — a moved gap fails. The 4 gaps are a '
      + 'capture-origin FLAG (decision-13). CORRECTED 2026-09-26: three of the four were declared at nonces 48 / 23 / 10, which '
      + 'are the nonces three captured bets were actually served at; the lost rounds are at 47 / 22 / 9, and the outcome_index '
      + 'this step printed for the old three was a captured bet\'s. CORRECTED 2026-10-04: the fourth (epoch 22f48a0f…) was '
      + 'declared at nonce 3, the nonce spin 1974625 was served at; the lost round is at 2. Lost rounds now at 47 / 2 / 22 / 9. '
      + 'FAIL probed (a declared gap moved from nonce 2 to 3)' }] },
  5: { claims: [
    { id: 'GROOMERS-07', coverage: 'full',
      note: 'all 6,205 non-buy entries recompute the full 30-cell initial grid (and the published outcome_index where present) at '
        + 'ONE nonce, bound to EXPECTED_NON_BUY_BETS; the 20 bonus buys are skipped by declaration (R-BUY-FIRSTSPIN). Since '
        + '2026-09-26 there is no ±1 search: 5,726 base spins reproduce at their recorded nonce, 4 (spin ids 1965523, 1974625, '
        + '1976463, 1987633) at recorded + 1, declared by id in src/loader.ts CAPTURE_NONCE_CORRECTIONS — the capture\'s pre-bet '
        + 'snapshot recorded a nonce a retried request had consumed; each is proven to reproduce at the served nonce AND NOT '
        + 'at the recorded one, else FAIL — and 475 free spins at their verify record\'s nonce and round_index. Since 2026-10-04 '
        + '(when 1974625 was added as the fourth correction) every base spin\'s verify-payload nonce must equal its served nonce '
        + '(148/148), and every free spin\'s payload must carry the trigger\'s served nonce and round_index = current_spin in a '
        + 'triggered bonus, current_spin − 1 in a bought one (475/475). FAIL probed (one correction removed; the 1974625 '
        + 'correction removed; one free spin\'s current_spin moved by one)' },
    { id: 'GROOMERS-08', coverage: 'full',
      note: 'added 2026-09-26 (R1): measured from src/rng.ts acceptedDraw — the one acceptance rule pickWeighted (grid) and '
        + 'generateMultipliers (bonus values) call since this change — on every distinct weight total the draws use (6 base '
        + 'reels, 6 bonus reels, the multiplier-value weights; binary search for the window + ~600 probes per total): every '
        + 'window is a whole number of totals, worst bias 0; HARD FAIL otherwise. The HMAC → outcome-index layer is covered by '
        + 'the exhaustive 2^32 enumeration (Steps 29–32). FAIL probed (acceptance window widened to all of 2^32 − 1)' },
    { id: 'GROOMERS-24', coverage: 'full',
      note: 'added 2026-09-26: the ProvablyFair.org docs-site VerifyBets games/groomers-van/derive.js + paytables.js + '
        + 'lib/hmac-sha256.js, read with `git cat-file -p origin/main:<path>` from mikepforg/pf-audit-duel origin/main @ bd4d59c '
        + '(derive.js / paytables.js last changed 4aaa1b2, 2026-06-07), vendored under verifier-parity/ and pinned in '
        + 'src/site-verifier.ts (095e552b…, 57fd0e4a…, bc30bfe9…). Step 5 FAILs unless all three hash to the pins, then EXECUTES '
        + 'the site\'s deriveGroomersVan on all 5,730 base spins at the nonce whose grid matched and requires the outcome_index '
        + 'of src/rng.ts, the served feature_triggered flag and the served total_multiplier (base spin incl. cascades) within '
        + '1e-12 relative. Scope: the site\'s free-spin session simulator and the 20 buys are NOT compared. FAIL probed '
        + '(paytables.js cell changed and re-pinned; a derive.js byte changed without re-pin)' },
  ] },
  6: { claims: [{ id: 'GROOMERS-06', coverage: 'partial',
    note: 'client-seed half: a tampered client seed changes the outcome_index on every one of the 623 entries whose /verify '
      + 'payload publishes one (bound to EXPECTED_VERIFY_PAYLOAD_BETS). PARTIAL: the tamper runs on 623 of 6,205 '
      + 'recomputable entries; no empty-seed control; the A–C and E client seeds come from Math.random() in the capture script '
      + '(capture/capture.reference.js:260) — not a CSPRNG, RULE-NEWER-THAN-CAPTURE — and the Phase D seeds are the fixed strings '
      + 'pfaudit_groomers_seed00…09 (capture/capture.reference.js:263); both disclosed MANIFEST DL-2, exposed epochs not enumerated by a step' }] },
  7: { claims: [{ id: 'GROOMERS-11', coverage: 'full',
    note: 'EXACT in integer cents, in USD since 2026-10-05: every payline base payout (USD) × its integer bomb multiplier '
      + 'summed in BigInt must equal amount_won (USD) on all 6,205 non-buy entries, with no exception (was ±max(1e-6, 0.05 %) '
      + 'on doubles until 2026-09-26). The coins field is the same credit in the account\'s coins: amount_won_coins must equal '
      + 'round_half_up(amount_won × rate, 2 dp) on all 6,225 entries, rate = bet_amount / bet_amount_currency (the trigger\'s '
      + 'rate for free spins); 2,619 wins are converted at a rate other than 1, and no value lands on a half cent. Siblings '
      + 'compare like units only: amount_won = total_win_currency and amount_won_coins = total_win. A $50.00 stake is '
      + 'recorded as 49.9915 coins, so a $50 win is 49.99 coins (MANIFEST DL-5, money fields in two units). FAIL probed '
      + '(a 0.40 credit set to 0.39 on all four fields; a coins credit one cent off its rate)' }] },
  8: { claims: [{ id: 'GROOMERS-13', coverage: 'full',
    note: 'served-vs-declared half: all 4,985 payline multipliers EQUAL the published rules-endpoint paytable cell (exact since '
      + '2026-09-26; was a 1e-6 window), bound to EXPECTED_PAYLINES; the table and config are hash-pinned by Step 14; '
      + 'multiplier-symbol values are Step 27. FAIL probed (a multiplier moved 1e-7)' }] },
  9: { claims: [{ id: 'GROOMERS-12', coverage: 'partial',
    note: 'what IS asserted: all 30 Phase B entries ($1–$50) recompute the same 30-cell grid, bound to EXPECTED_PHASE_BETS.B; '
      + 'stake is not an HMAC input. PARTIAL: 30 elevated-stake bets against the profile floor of 100 (capture-origin — the '
      + 'capture plan ran 30); the stake-variation phase is labelled B, not C' }] },
  10: { claims: [{ id: 'GROOMERS-19', coverage: 'full',
    note: 'operator half: edge_multiplier = 1 (Zero Edge) on all 6,225 entries, compared, never used as the derivation; the '
      + 'derived half is Steps 29–32' }] },
  11: { claims: [{ id: 'GROOMERS-15', coverage: 'full',
    note: '6 required config fields present; 62 of the 96 (condition, symbol, cluster-tier) cells exercised, above the '
      + 'MIN_PAYTABLE_CELLS_EXERCISED = 55 floor; no payline outside the table; the 34 unexercised cells named, their return '
      + 'carried by the exhaustive enumeration (Steps 29–32)' }] },
  12: { claims: [{ id: 'GROOMERS-05', coverage: 'full',
    note: 'epoch half: 116 epochs, 114 at exactly 50 and the declared short epochs [20, 30]' }] },
  13: { claims: [{ id: 'GROOMERS-05', coverage: 'full',
    note: 'population half: 6,225 entries (5,750 regular, 475 free spins), 117 seed records, phases A 5,248 / B 30 / C 223 / '
      + 'D 524 / E 200 and modes spin / free_spin / buy against src/loader.ts, not the dataset header' }] },
  14: { claims: [
    { id: 'GROOMERS-26', coverage: 'full',
      note: 'the uncompressed dataset\'s SHA-256 against EXPECTED_HASH (the pre-flight also aborts on a mismatch before any step '
        + 'runs); since 2026-09-26 the operator files under data/raw/ against RAW_FILE_PINS (8 files; 10 since 2026-10-05, '
        + 'adding the /api/v2/slots and /rules bodies of the duel.com config as fetched 2026-10-05 in a logged-in session '
        + '(read-only GET)) — a mismatch or absence FAILs. FAIL '
        + 'probed (one byte of the config changed)' },
    { id: 'GROOMERS-13', coverage: 'full',
      note: 'provenance half: the reel-weight config and both paytables (rules endpoint, in-game help) are the operator\'s '
        + 'published artifacts, pinned by hash since 2026-09-26' },
  ] },
  15: { claims: [{ id: 'GROOMERS-06', coverage: 'partial',
    note: 'Phase D half: 500 regular bets on 10 distinct auditor client seeds (the 10 × 50 plan), recomputed in Step 5. '
      + 'PARTIAL for the reasons on Step 6' }] },
  16: { claims: [{ id: 'GROOMERS-18', coverage: 'full',
    note: 'the Monte Carlo (30,000,000 base spins, 132,222 sessions) is scored against the EXACT 2^32 enumeration and session '
      + 'convolution — independent computations from the published weights, paytable and cascade rules, no operator '
      + 'probability table — within 5 SE per component. NEGATIVE CONTROL added 2026-09-26 (the Duel Dice Step 13 pattern): '
      + 'the same comparison is run against the anchor re-derived from the same pinned artifacts under a corrupted published '
      + 'rule, and each required control must be rejected — trigger threshold 3 → 4 scatters (rejected on trigger probability, '
      + 'session payout and blended RTP, max z 1,233) and the spins-per-scatter table shifted one tier up (rejected on session '
      + 'payout and blended RTP, max z 47.8). A third corruption written with them (the table shifted one tier DOWN for 4+ '
      + 'scatters) was NOT rejected on the first run (max z 4.35 < 5) — it is kept as a reported power probe, not a required '
      + 'control, and disclosed (MANIFEST DL-9): the comparison cannot separate a change confined to the rare 4+-scatter '
      + 'triggers at 132,222 sessions. FAIL probed (M16b: the corruption removed from the threshold control)' }] },
  17: { claims: [{ id: 'GROOMERS-20', coverage: 'partial',
    note: 'what IS asserted: per-reel initial-deal chi-squared, Bonferroni over 6 reels, p recomputed from the shipped chi² and '
      + 'df; lag-1 and runs thresholds recomputed; simulator verdicts must agree. PARTIAL: the symbol counts and the payout '
      + 'series do not ship, so the statistics are read, not re-derived; no part of the 30M-spin run is replayed by verify' }] },
  18: { claims: [{ id: 'GROOMERS-21', coverage: 'partial',
    note: 'what IS asserted: 115 epochs × 10,000 nonces (rows bound to the captured epochs), early 0–49 vs late flags re-derived '
      + 'from each row\'s chi², binomial p ≥ 0.01; aggregate captured RTP z recomputed. PARTIAL: the per-nonce win counts '
      + 'behind each chi² are not replayed; win/no-win bins, not the return of the configs served; no detection power printed' }] },
  19: { claims: [{ id: 'GROOMERS-10', coverage: 'full',
    note: 'cluster half: all 4,982 cluster paylines have count = symbol cells + wild cells (bound to EXPECTED_CLUSTER_PAYLINES)' }] },
  20: { claims: [{ id: 'GROOMERS-10', coverage: 'full',
    note: 'gravity half: all 4,323 cascade rounds keep un-removed cells at the bottom of their column (EXPECTED_CASCADE_ROUNDS)' }] },
  21: { claims: [{ id: 'GROOMERS-10', coverage: 'full',
    note: 'wild half: all 410 rounds with ≥ 2 paying symbols and a wild credit the wild to every cluster' }] },
  22: { claims: [{ id: 'GROOMERS-17', coverage: 'full',
    note: 'trigger half: 53/53 triggers match spins_per_scatters and the final-grid scatter count' }] },
  23: { claims: [{ id: 'GROOMERS-17', coverage: 'full', note: 'retrigger half: 53 sessions, 475 free spins, retrigger cap 3 never exceeded' }] },
  24: { claims: [{ id: 'GROOMERS-17', coverage: 'full', note: 'buy-disclosure half: 20/20 buys carry is_bonus_buy and no cluster payline' }] },
  25: { claims: [{ id: 'GROOMERS-17', coverage: 'full', note: 'buy-structure half: 20/20 show 4 scatters and award 10 free spins' }] },
  26: { claims: [{ id: 'GROOMERS-17', coverage: 'full', note: 'free-spin payout half: 475/475 reconcile exactly in integer cents (since 2026-09-26), against amount_won (USD) since 2026-10-05' }] },
  27: { claims: [
    { id: 'GROOMERS-17', coverage: 'full', note: 'multiplier-symbol half: 935 appearances in bonus only, 0 in base' },
    { id: 'GROOMERS-13', coverage: 'full', note: 'value half: every observed multiplier value is in the published set; all 14 observed' },
  ] },
  28: { claims: [
    { id: 'GROOMERS-10', coverage: 'full',
      note: 'cascade half: 4,323 cascades replayed from deriveTumbleSeed → PCG32 → grid + gravity fill, 129,690/129,690 cells and '
        + '146/146 multiplier values byte-exact' },
    { id: 'GROOMERS-17', coverage: 'full', note: 'bonus cascades are among the 4,323 replayed byte-exact' },
  ] },
  29: { claims: [{ id: 'GROOMERS-27', coverage: 'partial', note: 'base 2^32 enumeration artifact hash-pinned (see Step 33)' }] },
  30: { claims: [{ id: 'GROOMERS-27', coverage: 'partial', note: 'bonus 2^32 enumeration artifact hash-pinned (see Step 33)' }] },
  31: { claims: [{ id: 'GROOMERS-27', coverage: 'partial', note: 'the 4 exact session-EV artifacts hash-pinned (see Step 33)' }] },
  32: { claims: [{ id: 'GROOMERS-19', coverage: 'full',
    note: 'derived half: total RTP = base RTP (exhaustive 2^32) + P(trigger) × E[session | trigger] (exact convolution) = '
      + '99.9720 %, 0.028 pp below the operator\'s 100 % claim. Since 14 Oct 2026 (FIXPASS2 C3) the step scores the derivation '
      + 'only (the base RTP must equal the base artifact\'s own sum / count and histogram mean), and the derived total is the RTP '
      + 'claim table\'s one row, held to the claim by RTP-CLAIM 1.2.0, switched on (src/rtp-settings.ts): outcome PASS, within the '
      + '0.1 pp band; a house-side miss would be an operator-origin FLAG here and the verdict RTP FIGURE OVERSTATED (exit 5), never '
      + 'NOT PROVABLY FAIR. Until 14 Oct the step compared the total with the claim itself (PASS within 0.1 pp, FLAG 0.1–1 pp, '
      + 'FAIL beyond). Note restated 19 Oct 2026 (Mike\'s QA)' }] },
  33: { claims: [{ id: 'GROOMERS-27', coverage: 'partial',
    note: 'all 13 tracked artifacts under outputs/ hash-checked against src/artifact-pins.ts (absent/altered FAILs), each '
      + 'un-ignored by name; verify writes only to outputs/run/ unless PF_EMIT=1; since 2026-09-26 simulation-results.json '
      + 'carries no generatedAt / executionTimeMs (re-pinned) and verification-results.json no generatedAt. PARTIAL: the five '
      + '2^32 enumeration artifacts still carry `elapsed_sec` (run metadata, disclosed MANIFEST DL-6); no declared value '
      + 'domains' }] },
  34: { claims: [{ id: 'GROOMERS-14', coverage: 'full',
    note: 'added 2026-09-26, FLAG-only (R2): the cap 5000× is read from the operator\'s published config (max_multiplier, the '
      + 'pinned data/raw/groomers-van-config-v1.4.json) and must be the one the enumerators apply (capped bonus 2^32 max_payout '
      + '5,000 ≤ cap; all 4 exact session artifacts max_win_x 5,000); all 6,225 served entries have total_multiplier ≤ 5,000 and '
      + 'credit ≤ 5,000 × stake, compared exactly as 18-dp decimals (largest served 630×), and all 53 bonus sessions\' summed '
      + 'credits ≤ 5,000 × stake (largest 647.1×). RTP the cap removes, from the pinned capped vs uncapped 2^32 bonus '
      + 'enumerations: 12.153375804 − 12.153351084 = 2.472e-5 × stake per bonus spin (uncapped max 8,232.8×), at most '
      + 'P(trigger) × 44 spins × that = 4.79e-6 of whole-game RTP; the base enumeration maximum is 112.8×, so the cap never '
      + 'binds in the base game. The SESSION-level cap\'s removed return is not enumerated (no uncapped session convolution '
      + 'is pinned); its per-session hit probability from each capped convolution is printed (3.9e-7 … 8.1e-7). Measured 0 '
      + 'violations. FLAG probed (M34: one served multiplier forged to 5,001)' }] },
  35: { claims: [{ id: 'GROOMERS-22', coverage: 'full',
    note: 'added 2026-09-26, informational (a deviation is INFO — reported, never counted, verdict unchanged; profile '
      + 'policy INFORMATIONAL, Mike 2026-09-29): the initial-deal symbol frequencies of the 5,730 regular base spins per '
      + 'reel against the published base-game reel weights (χ², bins pooled to expected ≥ 5), the hit rate against the base '
      + 'enumeration\'s exact win_rate and the trigger rate against the exact P(≥ 3 scatters) (two-sided exact binomial); 8 '
      + 'tests at Bonferroni 0.01/8. Measured: all 8 above the bound (smallest: trigger rate p = 0.156, 33 triggers vs 25.2 '
      + 'expected). INFO probed (M35: every initial-deal cell counted as the reel\'s first symbol)' }] },
};

export const NOT_APPLICABLE: Array<{ id: string; reason: string }> = [
  { id: 'GROOMERS-16',
    reason: 'applies = { money.balanceField notNull } is false — declared null. The capture carries a `balance_type` field '
      + '(an account-type code) but no balance amount; no consecutive-bet wallet delta can be reconciled. The per-spin '
      + 'credits are verified instead (Steps 7, 26)' },
];

export const PACKAGE_CHECKS: Array<{ id: string; artifact: string; coverage: Coverage | 'none'; note: string }> = [
  { id: 'GROOMERS-09', artifact: 'tests/groomers-van/GroomersVanTests.ts + src/operator-verifier.ts + src/rng.ts OPERATOR_SOURCE_CITES + Step 5 fourth leg', coverage: 'full',
    note: 'added 2026-09-26: Duel\'s own Groomer\'s Van Verify-tab code ("Provably Fair Slots Verification (PCG32 PRNG)"), pulled '
      + 'from duel.com/fairness/verify on 2026-05-19 (qa-workspace/duel/findings/duel-gv-verify-code.js, per '
      + 'verify-bets-tool-groomers-van.md), vendored byte for byte to evidence/verify-tab/ (SHA-256 20fefa7d…) and run UNMODIFIED '
      + 'by a pinned runner (JSON.parse of the captured literal, Node WebCrypto, temp files, 300 s hard timeout). (1) the 19th mocha '
      + 'test runs it on bet 1964586 and requires the outcome index and 30-cell grid; (2) Step 5 runs it on all 6,205 recomputable '
      + 'entries: outcome index and grid 6,205/6,205; (3) src/rng.ts cites 14 operator lines and checkOperatorCites FAILs any that '
      + 'does not carry its text; (4) since 2026-10-05 its multiplier values are scored: the code picks '
      + 'multiplierValues[rnd % length] and, as pulled, leaves the list empty (`const multiplierValues = null;`), so Step 5 '
      + 'gives it the published weights as a 200-entry list (each value repeated by its weight, config order; built from the '
      + 'pinned config and pinned by SHA-256 f07398af…) and requires every initial-grid multiplier value it returns to equal the '
      + 'served one: 335/335. Not compared: the list the live page injects (no copy of it is held). FAIL probed (captured file byte changed without re-pin; a citation moved; the '
      + '14 distinct values given instead of the weighted list)' },
  { id: 'GROOMERS-23', artifact: 'MANIFEST.md#verification-results', coverage: 'full',
    note: 'restated 2026-09-26 as the framework rows S5-1 … S5-8 between S5-MATRIX markers, each tied to a scored step or Not '
      + 'tested — disclosed; the package\'s own attack categories follow: 10 in the table (13 until the 4 Oct 2026 '
      + 'consolidation; the other three — multi-account treatment, cherry-picked seed selection, buy-spin grid content — are '
      + 'listed under it as acknowledged but not detectable; restated 19 Oct 2026, Mike\'s QA)' },
  { id: 'GROOMERS-25', artifact: 'MANIFEST.md#verify-a-bet', coverage: 'full',
    note: 'since 2026-09-26 the package carries an ordered six-step "Verify one of your own spins" (now MANIFEST "Verify a bet") '
      + 'paste-path in the declaration\'s field names (the Duel Dice DICE-25 pattern): (1) where the seed is revealed — seed '
      + 'rotation, then Duel\'s per-spin verify record; (2) which fields to paste — server_seed, activeAtSpin.server_seed_hashed, '
      + 'activeAtSpin.client_seed, activeAtSpin.nonce and round_index 0 for a base spin; for a free spin the verify record\'s '
      + 'nonce (the trigger\'s) and top-level round_index (1..N triggered, 0..N−1 bought; corrected 2026-10-04, and Step 5 '
      + 'checks this rule on all 475 free spins); and the served response.* fields; (3) the '
      + 'commitment encoding SHA-256(hex_decode(server_seed)); (4) the outcome-index derivation (client seed hex-encoded, '
      + 'first 4 bytes big-endian); (5) the cascade seed deriveTumbleSeed and PCG32 with SplitMix64 seeding and the weighted '
      + 'rejection draw; (6) the column-major grid numbering position = col × 5 + row and the pay rules' },
  { id: 'GROOMERS-28', artifact: 'package.json + tests/verify.ts + MANIFEST.md (Fresh-clone reproduction)', coverage: 'full',
    note: 'measured 2026-09-26, Node v22.23.1. Fresh `git clone` of origin/main @ 79aa65b (games/groomers-van at 8f13658): npm ci '
      + 'exit 0; npm test exit 0 — 18 passing, 32/33 + 1 capture-origin FLAG, Full Pass, REPRODUCED, verification-results '
      + 'byte-identical; npm run test:full exit 1 after 496 s — src/simulate.ts read the pinned 2^32 base enumeration from '
      + 'outputs/run/ instead of outputs/ and crashed (ENOENT) after Pass 1. FIXED this round (reads the committed copy) and '
      + 'test:full now field-diffs the regenerated simulation-results.json against the pin. Re-run on a copy of exactly the files '
      + 'this round will commit: npm ci exit 0; npm test exit 0 (REPRODUCED, byte-identical); npm run test:full exit 0 (502 s, and 497 s on the final copy with the Verify-tab leg) — '
      + 'simulation-results.json and rtp-convergence.html regenerated byte-identical to the pinned files. Engines node 22.x; audit ID '
      + 'PF-2026-DL10; 35 steps in README/MANIFEST (33 until Steps 34–35 were added later on 2026-09-26; the fresh-clone runs above '
      + 'predate them)' },
  { id: 'GROOMERS-29', artifact: 'tests/mutations.json + scripts/mutate.mjs', coverage: 'full',
    note: 'added 2026-09-26 (runner ported from Duel Video Poker via Beef): step-named mutations run in a disposable copy by '
      + '`npm run mutate` (300 s hard timeout per run), each with the marker of the guard that must fire; includes forgeries '
      + 'that edit a pinned artifact AND re-pin it and site-verifier forgeries re-pinned. Measured 2026-10-05: see MANIFEST '
      + '(48/48 killed, 35/35 scored steps covered, after M05k and the new M07b were added; 47/47 on 2026-10-04 after M05i/M05j; '
      + '45/45 on 2026-09-26 after Steps 34–35 and M16b/M34/M35 were added). No declared survivors' },
  { id: 'GROOMERS-30', artifact: 'MANIFEST.md#limitations-and-trust + MANIFEST.md#evidence', coverage: 'full',
    note: 'MANIFEST.md carries (since 2026-09-26) the declared-limitations register DL-1 … DL-9 and the Load-Bearing Premises '
      + 'table; MANIFEST Limitations and trust carries the R-* items. MANIFEST Evidence numbers every exhibit from E01 with its '
      + 'evidential role (completed 2026-09-26): E01 game UI, E02 client-seed origin, E03 the operator\'s written answers ("Groomer\'s Van '
      + 'audit questions.pdf", also D05; SHA-256 af9329dd…; held on file, not published), E04 Duel\'s Verify-tab code (20fefa7d…). The working notes are '
      + 'gitignored (.gitignore: working-notes/) and do not ship' },
];

export function profileCoverageBlock(): Record<string, unknown> {
  return { game: PROFILE_GAME, profileVersion: PROFILE_VERSION, notApplicable: NOT_APPLICABLE, packageChecks: PACKAGE_CHECKS };
}

export function labelFor(step: number): Record<string, unknown> {
  const entry = STEP_CLAIMS[step];
  if (!entry) return { profileIds: [], profileChecks: [], profileNote: 'no mapping declared for this step' };
  return entry.claims.length
    ? { profileIds: entry.claims.map(c => c.id), profileChecks: entry.claims }
    : { profileIds: [], profileChecks: [], profileNote: entry.reason ?? 'no reason given' };
}
