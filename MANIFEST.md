# Duel Groomer's Van — Consolidated Audit Overview

**Audit ID:** PF-2026-DL10 · **Auditor:** ProvablyFair.org · **Release:** `v1.2.1` · **Framework:** 1.1

Audit dates: 2026-05-04 – 2026-05-11 (capture and verification); enumeration artifacts 2026-05-23 – 2026-05-28. Publication date: 4 June 2026 (v1.0.0 public release). Audit report: https://audit.provablyfair.org/casino/duel/games/groomers-van/overview. Game type: slot (5×6 cluster pays, cascading tumbles, sticky tumble multipliers in the bonus, free-spin bonus with retriggers, bonus buy). Runtime: Node 22.x (`package.json` `engines`, `.nvmrc`). Each scored step carries the ProvablyFair.org Groomer's Van profile check(s) it implements (`src/profile-map.ts`, emitted as `profileIds` in `outputs/verification-results.json`); the profile is **1.0.2** (approved as cited, Methodology v1.1 decision D6, 14 October 2026). The machine-readable release identity is in [RELEASE-MANIFEST.json](RELEASE-MANIFEST.json).

## Conclusion and scope

**PROVABLY FAIR — Full Pass.** 34 of 35 scored verification steps pass against a 6,225-bet captured dataset; the 35th is one capture-origin flag (Step 4: four nonces the capture missed on a retried request, each under a revealed, commitment-checked seed; the rounds themselves were not captured; disclosed, verdict-neutral). The casino is running the algorithm its config, rules and help panel publish, with the seeds it commits to, paying the multipliers its paytable lists. Cell by cell and cascade by cascade the captured data reproduces from public seeds, including byte-exact verification of all 4,323 captured cascade rounds (Step 28).

**Exhaustive 2³² enumeration of the published math model gives a raw game RTP of 99.972%** (model RTP, ±0.02 points; see [Exact RTP](#exact-rtp-authoritative)), and a 30M Monte Carlo corroborates it at 100.06% within noise; the 0.028% gap to the operator's stated `rtp_per_condition.blended = 100.0%` is the bonus paytable's intrinsic edge. Zero Edge is a structural override (`edge_multiplier = 1` on every captured bet) under which the captured stakes ($0.20–$50 spins, $0.20 buys) pay the full math-model RTP of 99.9720%; stakes above $50 and buys above $0.20 were not captured, and account-level rakeback and promotions are out of scope.

Coverage operates at two levels:

- **Per-bet cryptographic commitment.** Base spins, cascade fills, multiplier values, scatter generation, free spins and retriggers are derived from the published seed chain and reproduce from `(server_seed, client_seed, nonce)` and the cascade RNG (`deriveTumbleSeed`). Individually verifiable per spin.
- **Published-parameter commitment.** The bonus-buy trigger is cosmetic (operator-disclosed: `verifyData._verify_session.is_bonus_buy = true` on every buy bet, marking the buy spin as non-PF; the operator's internal-doc naming for this is `pf_skipped` / `nonce=-1`). The free-spin award is fixed by the published config (`spins_per_scatters[buy_scatter_count] = spins_per_scatters[4] = 10`). Verified 20/20 in the captured buys, and detectable if the published config is ever changed.

A Conditional Pass would require an unresolved discrepancy between the operator's published specification (config, `/rules` and help panel) and what was delivered. There is none at the cell, payline, cascade or per-spin level. The 0.028% gap is a characterised property of the specification itself, not a discrepancy between specification and delivery. The findings apply to the captured config version (1.4); a later change to the per-reel weights, paytable or scaling-edge schedule would need a re-audit. Residual trust (the bought bonus spin, the scaling edge at any bracket, multi-account treatment, seed selection) is recorded under [Limitations and trust](#limitations-and-trust).

## Contents

- [Dataset and capture](#dataset-and-capture)
- [Game and algorithm](#game-and-algorithm)
- [Payouts and RTP](#payouts-and-rtp)
- [Verification results](#verification-results)
- [Reproduce the audit](#reproduce-the-audit)
- [Verify a bet](#verify-a-bet)
- [Evidence](#evidence)
- [Limitations and trust](#limitations-and-trust)
- [Terms](#terms)
- [Release history](#release-history)

## Dataset and capture

The 6,225 bets were recorded through a logged-in browser session against the live Duel.com API. The capture script authenticated with the standard session cookie, requested a security token at start-up, placed bets one at a time, stored every API request and response in IndexedDB and exported them as one JSON file. Its methodology is published as [capture/capture.reference.js](capture/capture.reference.js), a reference record and not a runnable tool, and the only capture file in this package. Its phase plan (`PHASES`: A 5,000 · B 30 · C 20 buys · D 500 on 10 custom seeds · E 200) equals the dataset's `meta.phasesRun`. The runnable capture tools are kept in ProvablyFair.org's private workshop and are not published, because they place bets on duel.com; nothing about them below can be checked from this package:

- the runnable capture script, pasted into the browser console on the logged-in duel.com/groomers-van tab (control panel, IndexedDB store, resume, `groomers.save()` export), whose export writes the dataset's `meta` fields and file name (`groomers-van-smoke-test-<timestamp>.json`). The 9-bet smoke pre-flight was this script run with smaller phase totals; that pre-flight's output is not in the package. A hash of the copy that ran on 7–8 May was not recorded.
- a separate end-to-end smoke test (`smoke-3@1.0.0`): one $0.20 spin, one $0.20 buy with its 10 free spins drained, one more spin and a final rotation, with request bodies and order taken from a recorded browser session (a HAR file that is not in the package). It ran on 7 May 2026 at 01:31 UTC, before the capture's first bet (19:13 UTC that day); its output (13 bets, 4 seed records) is not in the package, and no step reads it.

Two fields were filled in at export, not when their record was written: the plaintext `seed.serverSeed` on 116 of the 117 seed records and the `verifyData` block on 643 bets were attached by the runnable script's save step (`pub.save`, not in this package), from the `GET /api/v2/slots/spins/{spin_id}/verify` responses the script requested after each rotation, so each seed record's `at` timestamp dates its rotation response (client seed, commitment, next commitment) and not its plaintext, which was first served after that epoch's last bet. What the package does show: the reference record requests those `/verify` responses after each rotation (`getVerify`), says in its comments that `save()` stitches them into the export, writes `serverSeed: null` and keeps each revealed seed only as the next record's `prevSpinSeedRevealed`; the dataset carries the plaintext on 116 of 117 seed records and `verifyData` on 643 bets; and Step 1 checks every one of the 116 plaintexts against its commitment.

| Phase | Plan | Captured |
|---|---|---:|
| A — Baseline | 5,000 spins @ $0.20 | 5,000 base + 248 organic free-spin records |
| B — Bracket sampling | 30 spins staircased $1, $5, $9.50, $18.50, $27.50, $50 | 30 |
| C — Buy-bonus | 20 buys @ $0.20 (= $25 each via the 125× buy multiplier) | 20 buys + 203 free-spin records |
| D — Custom client seeds | 500 spins across 10 auditor-chosen client seeds (50 each) | 500 base + 24 organic free-spin records |
| E — Edge cases / replay | 200 spins @ $0.20 | 200 |

Total wagered: ~$2,197.50. Total wins: ~$1,946.02. Net cost: ~$251.48.

**Population of record** (code constants in `src/loader.ts`, scored by Steps 1, 2, 12, 13, 15; the per-step scored populations — non-buy bets, paylines, cascades, sessions, nonce gaps and the rest — are declared beside them and bind Steps 3–9 and 18–27): 6,225 entries — 5,750 regular bets (5,730 spins + 20 bonus buys) and 475 free-spin records; phases A 5,248 · B 30 · C 223 · D 524 · E 200; 117 seed records, 116 revealed, 116 epochs (114 of 50 bets plus close-outs of 20 and 30). The 117th seed record is the seed still active when the capture closed; no captured bet used it. Each seed record is the response to a rotation the capture script requested: at each phase start, after every 50 regular bets (`BETS_PER_EPOCH = 50` in the capture reference) and once after the last bet. The 50-bet epoch is the capture's rotation schedule, not a tested Duel limit: the reference's comments call it a "Duel platform-enforced epoch cap", which was not tested, since no captured epoch ran past 50 bets. Duel reveals a server seed when the player rotates ([Verify a bet](#verify-a-bet), step 1).

| Input | Identity |
|---|---|
| [data/groomers-van-smoke-test-1778204681017.json.gz](data/groomers-van-smoke-test-1778204681017.json.gz) | 6,225 bets, 117 seed rotations; 9.5 MB gzipped (9,544,283 bytes), 72.9 MB raw (72,856,521 bytes). SHA-256 of the uncompressed bytes `3034cb1284bc1a87d82a0d8f914b19d7f1a8f16894ffe601242bd29e3873b967` |
| [data/raw/groomers-van-config-v1.4.json](data/raw/groomers-van-config-v1.4.json) | Operator game config (`/api/v2/slots` filtered to groomers-van): per-reel weights, free-spin feature rules with the multiplier weights, scaling-edge schedule. It holds no paytable; the payouts are in the `/rules` response below |
| [data/raw/paytable-from-rules-endpoint.json](data/raw/paytable-from-rules-endpoint.json) | Paytable from `/api/v2/slots/groomers-van/rules` |
| [data/raw/paytable-extracted-from-help.json](data/raw/paytable-extracted-from-help.json) | Paytable extracted from the in-game `#help` panel (cross-check; full agreement) |
| [data/raw/client-seed-snapshot.json](data/raw/client-seed-snapshot.json) | Client seed observed at capture time |
| `data/raw/spin-1835724-*.json`, `data/raw/spin-1835725-*.json` | Two raw spin request/response pairs |
| [data/raw/slots-2026-10-05.json](data/raw/slots-2026-10-05.json) | Re-fetch of `/api/v2/slots`, part of the duel.com config as fetched 2026-10-05 in a logged-in session (read-only GET), at 12:16:06 UTC: the response body byte for byte. Its path, status, response headers and `fetched_utc` are in the `.meta.json` beside it |
| [data/raw/slots-groomers-van-rules-2026-10-05.json](data/raw/slots-groomers-van-rules-2026-10-05.json) | Re-fetch of `/api/v2/slots/groomers-van/rules`, part of the same 2026-10-05 fetch (same logged-in session, read-only GET), at 12:16:11 UTC: the response body byte for byte, with its `.meta.json` |

`src/loader.ts` decompresses the dataset transparently (it prefers a gunzipped `.json` if present) and checks its hash before any step runs, aborting with `process.exit(1)` on a mismatch. The 10 operator files under `data/raw/` match their SHA-256 pins (Step 14); the two `.meta.json` fetch records are hashed in `RELEASE-MANIFEST.json`.

**Re-fetched 5 Oct 2026:** weights, paytable, multiplier weights and scaling-edge schedule identical to v1.4. This is the duel.com config as fetched 2026-10-05 in a logged-in session (read-only GET), the two re-fetch files above. The `/api/v2/slots` body holds one entry, groomers-van, and that entry equals `groomers-van-config-v1.4.json` in every field, value and key order (`active_version` "1.4", `updated_at` "2026-04-03T14:53:48.000000Z"): indented by two spaces it is byte-identical to the pinned file. That entry carries no paytable; the paytable is in the `/rules` body, which has the same SHA-256 as `paytable-from-rules-endpoint.json` (`c3479bf6…`).

**Pre-publish redaction (2026-06-10).** The original capture included an `events[]` array of 13,525 raw API request/response records carrying rotating `security_token` values across 6,342 occurrences. These tokens were session-scoped and expired since the May 8 capture (no active compromise), but a published audit repository should not ship captured authentication material. Action taken:

1. The `events[]` array in the master dataset was emptied; redaction metadata is preserved at `meta.eventsRedacted` (`count: 13525`, reason, `date: "2026-06-10"`).
2. The `security_token` field in the 2 raw spin request files (`spin-1835724-request.json`, `spin-1835725-request.json`) was replaced with `[REDACTED]`.
3. `EXPECTED_HASH` in `src/loader.ts` was re-pinned to the post-redaction dataset hash (`3034cb12…`; the pre-redaction capture hashed `9f6d854e…`).

**No verifier code path consumes `dataset.events` or the `security_token` field, so the redaction is transparent to the audit pipeline.** Measured 2026-09-23 by re-running the verifier against both datasets: every scored step's status, detail string and data block is identical except Step 14 (Dataset Hash), which reports the new hash; bets 6,225 / seed records 117 / revealed 116 unchanged; 33/33 PASS, reproduced (as scored at that time — Step 4 has since been re-scored to the capture-origin FLAG standard and Steps 34–35 added, so the current result is 34/35 PASS + 1 capture-origin FLAG; the redacted-vs-unredacted comparison was not re-run after those changes).

The capture touched these endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v2/slots` | Game catalogue; the groomers-van entry carries per-reel weights, free-spin feature rules with the multiplier weights, and the scaling-edge schedule, and no paytable (D02; D06 as fetched 2026-10-05) |
| GET | `/api/v2/slots/groomers-van/rules` | Dedicated paytable and bonus rules (cross-check against `/slots`) |
| GET | `/api/v2/slots/groomers-van/active` | Resume-active-spin probe (pre-flight) |
| GET | `/api/v2/client-seed` | Active client seed, hashed server seed, next hash, nonce |
| POST | `/api/v2/client-seed/rotate` | Rotate seeds; `client_seed` body for the custom-seed phase |
| POST | `/api/v2/slots/groomers-van/spin` | Place a regular spin |
| POST | `/api/v2/slots/groomers-van/buy` | Buy a bonus (125× stake); body `feature_code: "bombs_bonus"` |
| POST | `/api/v2/slots/spins/{spin_id}/confirm-animation` | Acknowledge the animation; required between free spins in a bonus session |
| GET | `/api/v2/slots/spins/{spin_id}/verify` | Per-spin reproduction data: server_seed (post-rotation), outcome_index, pf_skipped, tumbles |
| POST | `/api/v2/user/security/token` | Refresh the ~10-minute security token |
| GET | `/api/v2/blackjack`, `/api/v2/mines/active`, `/api/v2/cross-road/active` | Pre-flight probes for open game state that would block rotation |

The auditor's client seeds were not from a CSPRNG (DL-2): phases A, B, C and E used `'pf_'` + 13 characters from `Math.random()`, and Phase D the fixed strings `pfaudit_groomers_seed00` … `09`.

## Game and algorithm

| Field | Value | Source |
|---|---|---|
| Name / code / game id | Groomer's Van / `groomers-van` / `3` | `/api/v2/slots` |
| Active version | `1.4` | same |
| Type | Duel Original — Zero Edge | UI tagging |
| Grid | 5 rows × 6 columns (30 cells) | every captured spin (Step 5 reproduces 30/30 cells; Step 11 verifies config shape) |
| Pay mechanic | Cluster pays, **anywhere**, min cluster 8 | `/api/v2/slots` mechanics block |
| Reel mechanic | Tumbling (cascading) | same |
| Wilds | `wild` symbol (symbol_index 9) | same |
| Stake range | min `$0.20`, max `$1000` | same |
| Max win | 5000× stake | same |
| Claimed RTP | 100.0000% (Zero Edge) | same |

The configuration, the `/rules` endpoint and the in-game help panel agree on every rule except one `/rules` field: `/rules` gives `min_cluster_size` as 8 in its `game.mechanics` block, as the config does, and as 4 in its `rules` block. The TypeScript code reads the 4 (`src/paytable.ts`), but neither the `/rules` paytable nor the help panel has a symbol tier below 8 (the scatter pays from 4), so a cluster of 4–7 has no payout to look up: the verifier prices it at 0, the enumeration and the simulation neither pay nor remove it, and no captured payline hit a cell outside the published tiers (Step 11). Symbols: `symbol_1`–`symbol_4` (index 0–3, common), `symbol_5`–`symbol_7` (4–6, rare), `symbol_8` (7, epic), `symbol_9` (8, premium), `wild` (9), `multiplier` (10, bonus mode only) and `bonus` (the scatter; index 11, 10 in base). `/rules` publishes 11 active symbols in `base_game` and 12 in `bonus_game`. Each reel has its own weighted distribution (`weights.symbols_by_condition` in the config); the heavy weights on reel 1 (totals ~545k against ~530 on reel 0) are part of the published model and are used unchanged by the verifier.

### Pay rules

A cluster is a **global count, not a connected group**: `cluster_size(S) = (cells of S on screen) + (cells of wild)`. If `cluster_size(S) ≥ 8` for a payable symbol S, S pays at the tier `min(cluster_size(S), 12)`. Several symbols can pay at once, and one wild contributes to every cluster it can lift. The config states it directly (`"pay_mechanic": "cluster"`, `"min_cluster_size": 8`, `"symbols_paying_logic": "anywhere"`), and the help panel says: *"Symbols pay wherever they land. Win depends on how many of the same symbol appear at the end of a spin."* A connectivity flood-fill model, tried in early draft work, produced ~1.2% paying clusters per spin in simulation against the 74% observed in the captured data. On bet 1964425, seven `symbol_1` cells plus one wild pay `cluster_symbol_1_8`; on bet 1964428 one wild lifts both `symbol_1` and `symbol_7` from 7 to 8.

| Symbol | Type | 8 | 9 | 10 | 11 | 12+ |
|---|---|---:|---:|---:|---:|---:|
| symbol_1 | common | 0.4× | 0.4× | 0.6× | 0.7× | 2× |
| symbol_2 | common | 0.5× | 0.6× | 0.7× | 1× | 2.5× |
| symbol_3 | common | 0.6× | 0.7× | 0.9× | 1.2× | 3× |
| symbol_4 | common | 0.7× | 0.9× | 1.2× | 1.5× | 4× |
| symbol_5 | rare | 1× | 1.2× | 1.5× | 2× | 5× |
| symbol_6 | rare | 1.5× | 1.6× | 2.2× | 2.8× | 7× |
| symbol_7 | rare | 1.8× | 2.2× | 2.8× | 3.5× | 9× |
| symbol_8 | epic | 2.5× | 3.5× | 4.5× | 5.5× | 14× |
| symbol_9 | premium | 5× | 6× | 8× | 10× | 25× |
| wild | wild | substitutes for any payable symbol; no standalone payout | | | | |
| bonus | scatter | 4 → 3× · 5 → 5× · 6+ → 100× (in addition to the free-spin award) | | | | |

Source: `/rules` `symbols_by_condition.base_game.payouts` (identical in `bonus_game`). Wilds do not substitute for `bonus` or `multiplier`.

**Tumbling.** After every winning round the cells of every winning cluster are removed, survivors slide down within their column, and new cells fill the empty positions at the top. The cascade repeats until no new winning cluster forms or the 5,000× cap is reached. Each cascade level is generated from the same `outcome_index` with `tumble_index` incremented.

### Bonus game (`bombs_bonus`)

The operator publishes `feature.bombs_bonus.metadata` in `/api/v2/slots`:

```json
{
  "code": "bombs_bonus",
  "type": "bonus_game",
  "metadata": {
    "scatter_rewards":   { "3": 8,  "4": 10, "5": 12, "6": 14 },
    "buy_scatter_count": 4,
    "retrigger_rewards": { "3": 3,  "4": 5,  "5": 8,  "6": 10 },
    "max_retriggers":    3,
    "multiplier_values": { "2": 90, "3": 25, "4": 18, "5": 13, "6": 10, "7": 8, "8": 7, "10": 6, "12": 5, "15": 4, "25": 4, "50": 4, "100": 3, "250": 3 },
    "multiplier_bombs_enabled":  true,
    "buy_awards_scatter_payout": true
  },
  "is_buyable":     true,
  "buy_multiplier": 125
}
```

Three or more scatters on screen at any point during a spin's cascade (initial deal or tumble fill) award 8 / 10 / 12 / 14 free spins for 3 / 4 / 5 / 6 scatters; in a free spin they retrigger +3 / +5 / +8 / +10, capped at 3 retriggers per session. In free spins, `multiplier` symbols land with values drawn from the published weights (summing to 200): 2× 45.0%, 3× 12.5%, 4× 9.0%, 5× 6.5%, 6× 5.0%, 7× 4.0%, 8× 3.5%, 10× 3.0%, 12× 2.5%, 15× 2.0%, 25× 2.0%, 50× 2.0%, 100× 1.5%, 250× 1.5%, matching the help panel. Multipliers never take part in clusters and are never removed. When the free spin's cascade settles, the values that landed on the play grid across all its cascade rounds are summed (`bomb_multiplier`) and multiply that spin's total cluster pay.

**Buy bonus.** Pay 125× the bet to enter the bonus: the buy spin shows exactly 4 scatters and triggers 10 free spins. The in-game help panel discloses: *"The first spin of a bought bonus game is purely cosmetic and no clusters or wins trigger. It simply shows a guaranteed bonus, thus isn't verifiable through the Provably Fair system."* The buy spin's grid is server-canned, not generated by the published HMAC + PCG32 algorithm, and the operator's `/verify` endpoint omits it. It always pays the 4-scatter pay (3× stake = $0.60 on a $0.20 buy). The 10 free spins that follow are provably fair and were verified.

### RNG

Two-layer RNG: one HMAC-SHA256 per spin produces an `outcome_index`, then a deterministic PCG32 stream seeded from that index drives the grid and every cascade fill. The operator's published verifier is at `https://duel.com/fairness/verify` (Game selector → "Groomer's Van"). Since v1.2.0 the RNG code in `src/rng.ts` is rebuilt from a written specification, [`docs/ALGORITHM.md`](docs/ALGORITHM.md) (a copy of the ProvablyFair.org framework's `games/groomers-van/ALGORITHM.md` at commit `cae1782`; the rebuild was written from commit `ef7fa03`, and `cae1782` changes only the text of open point O5 and one line of §2.6 about nonce gaps, nothing the RNG reads), by an implementer who read only that specification and an interface file and never opened Duel's code. The specification takes the grid, the per-reel weights, the fill order, the multiplier values, the clusters, the tumbles and the payouts from Duel's public pages, its public config and rules endpoints, its public Verify form used as a black box (inputs typed, only the displayed grid read) and the captured data. No public page describes the per-spin seed step (seeds → `outcome_index`; `outcome_index`, round and tumble → PCG32 state; the discard rule of each draw), so, by the client's ruling of 20 October 2026, that step of the specification was written from Duel's Verify-tab code, restated in the specification's own words; its Provenance section says so and marks each such step. Duel's Verify-tab code (E04, below) is also run as a second check, not used as the source. Through v1.1.0 `src/rng.ts` was ported from that code.

```
// Layer 1 — per-spin outcome index
clientSeedHex = bytesToHex(utf8Bytes(clientSeed))
message       = clientSeedHex + ":" + nonce          // hex-encoded, no :cursor
hmac          = HMAC-SHA256(hex_decode(serverSeed), message)
outcome_index = hmac[0..4] read big-endian as uint32

// Layer 2 — per-cascade randomness (no cursor in any HMAC)
tumble_seed = deriveTumbleSeed(outcome_index, round_index, tumble_index)
            → SplitMix64 expand → PCG32-XSH-RR → rejection-sampled weighted draw
```

The client seed is **hex-encoded** before it enters the HMAC message, unlike the other Duel originals (Keno, Dice, Mines, Blackjack), which send `${clientSeed}:${nonce}:${cursor}` with the seed as raw text, and there is no `:cursor`. `round_index` is the free-spin index inside a bonus session (0 for a base spin; 1..N in a triggered bonus, where the trigger spin is round 0; 0..N−1 in a bought bonus; see [Verify a bet](#verify-a-bet)); `tumble_index` is the cascade depth (0 for the initial deal).

```typescript
function deriveTumbleSeed(outcomeIndex, roundIndex, tumbleIndex) {
  let x = outcomeIndex >>> 0;
  x ^= Math.imul(roundIndex + 1, 0x9e3779b9) >>> 0;   // golden-ratio mix
  x ^= Math.imul(tumbleIndex + 1, 0x85ebca6b) >>> 0;  // Murmur3 finalise constant
  x ^= x >>> 16;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
```

The PRNG is the standard PCG-XSH-RR 64/32 generator with a SplitMix64 seed expansion at construction (constants `0x9e3779b97f4a7c15`, `0xbf58476d1ce4e5b9`, `0x94d049bb133111eb`; state step `× 6364136223846793005 + 0x5851f42d4c957f2d`). The grid is filled column-major (column 0..5, row 0..4). Each cell is one weighted draw: take a PCG32 uint32 `v`, reject while `v ≥ 0xFFFFFFFF − (0xFFFFFFFF mod W)` (W = the reel's total weight), then walk the reel's cumulative weights to `v mod W`. After the grid is drawn, each `multiplier` cell, in column-major order, draws its value with the next PCG32 uint32 (with rejection) from the `multiplier_values` weights. Step 5 asserts the draw is exactly uniform on all 13 weight totals: every rejection window is a whole number of totals. `src/rng.ts` takes probabilities only from the per-reel weights and rejection sampling, never from an operator probability table.

**Cascades.** For cascade t the engine re-seeds a fresh PCG32 from `deriveTumbleSeed(outcome_index, round_index, t)`, generates a full 30-cell grid, applies gravity to the previous grid and fills the empty top cells of each column from the new grid, top-down. Inside a free spin, new multiplier symbols that drop in add to the running total. Step 28 replays all 4,323 captured cascade rounds this way: 129,690 / 129,690 cells and 146 / 146 multiplier values reproduce byte-exact. This closes R-CASCADE-RNG, which earlier drafts disclosed as deferred. Through v1.1.0 this package named the operator's written answers on the cascade RNG mechanics (E03, held on file and not published) as the source of this cascade algorithm. Since v1.2.0 its source is [docs/ALGORITHM.md](docs/ALGORITHM.md), which does not use E03: there the generator shape (a fresh PCG32 grid per round and tumble, column-major, new cells from matching positions) comes from Duel's public pages, its Verify form used as a black box and the captured data; removal, gravity and the tumble loop from the help panel and the data; and the tumble seed from Duel's Verify-tab code (its Provenance section and §2.4, §2.4a, §3.2).

**Operator code (E04).** Duel's own Groomer's Van Verify-tab code ("Provably Fair Slots Verification (PCG32 PRNG)"), pulled from duel.com/fairness/verify on 2026-05-19, is vendored byte for byte and run unmodified by Step 5 on all 6,205 recomputable entries, as a second check next to `src/rng.ts`, not as its source: outcome index and grid agree on 6,205 / 6,205. The 14-line citation table of the v1.1.0 port was removed with it. The code as pulled leaves its multiplier list empty (`const multiplierValues = null;`), so the list comes from outside the code. On 5 Oct 2026 Duel's Verify page supplied it as a 200-entry list built from the published weights (90×2, 25×3, … 3×250; seen in a live check of the page, which was not captured into this package), so the code's draw is the weighted draw. Given that list built from the pinned config (each value repeated by its weight, in the config's order, pinned by SHA-256 in `src/operator-verifier.ts`), the code reproduces 335 / 335 initial-grid multiplier values (Step 5, scored); this list is not compared with the page's, since no copy of the page's list is in the package.

**Site verifier.** The ProvablyFair.org docs-site Groomer's Van verifier (`VerifyBets/games/groomers-van/derive.js`, its `paytables.js` and `lib/hmac-sha256.js`, mikepforg/pf-audit-duel `origin/main` @ `bd4d59c`) is vendored under `verifier-parity/` and pinned in `src/site-verifier.ts`. Step 5 executes it on all 5,730 captured base spins: outcome index, trigger flag and base-spin multiple agree. Its free-spin session simulator and the 20 bonus buys are not compared. The live page is a separate build and is not checked.

### Zero Edge and scaling edge

The audit account had **Zero Edge** active for every captured bet: all 6,225 returned `edge_multiplier: "1"`, at the stakes captured (plain spins at $0.20, $1, $5, $9.50, $18.50, $27.50 and $50; bonus buys and their free spins at $0.20, a $25 buy cost). Zero Edge is a Duel.com account-level flag, and a player can check their account state in the `edge_multiplier` field of a bet response. Whether Zero Edge also returns `"1"` at stakes above $50 (the stake range runs to $1,000) or on buys above $0.20 was not captured.

Without Zero Edge, config v1.4 as pinned in this package (`data/raw/groomers-van-config-v1.4.json`, `updated_at` 2026-04-03) holds two scaling-edge schedules in `scaling_edge`, each stepping +0.01% per bracket. Every bracket, edge and effective-RTP figure in this section is for that schedule. The duel.com config as fetched 2026-10-05 in a logged-in session (read-only GET) carries the same schedule ([Dataset and capture](#dataset-and-capture)); a schedule changed after that fetch is not covered:

| Schedule | Brackets | Lookup range | Bottom edge (bracket 1) | Top edge (last bracket) |
|---|---:|---|---:|---:|
| `scaling_edge.base_game` | 116 | $0 – $1,011.7326 | 0.01% (stake ≤ $9.0664) | 1.16% ($1,007.84 – $1,011.73) |
| `scaling_edge.bonus_game` | 184 | $0 – $126,466.5758 | 0.01% (lookup ≤ $701.16) | 1.84% ($126,009.52 – $126,466.58) |

This audit reads the brackets from the config: a plain spin's stake falls in the row of `scaling_edge.base_game` with `min_bet ≤ stake < max_bet`, and the bonus-mode figures (bought or triggered) use `scaling_edge.bonus_game`, whose upper bound is 125× the base schedule's (the buy multiplier) to within 7.5 × 10⁻¹² dollars: the decimal strings give `126466.575782740930` against 125 × `1011.7326062619275` = 126466.5757827409375, and the two are equal in double precision. Both schedules are monotonic, contiguous and gap-free (Step 11). No captured bet had an edge applied, so which row the server applies to a given bet was not observed (R-BRACKET-EMPIRICAL). Read this way and applied on top of the math-model RTP, the config gives:

| Bet | Base bracket | Base edge | Buy-bonus cost (= 125×) | Bonus bracket | Bonus edge |
|---:|:---:|---:|---:|:---:|---:|
| $0.20 | 1 | 0.01% | $25 | 1 | 0.01% |
| $10 | 2 | 0.02% | $1,250 | 2 | 0.02% |
| $50 | 6 | 0.06% | $6,250 | 9 | 0.09% |
| $100 | 12 | 0.12% | $12,500 | 18 | 0.18% |
| $500 | 57 | 0.57% | $62,500 | 90 | 0.90% |
| $1,000 | 115 | 1.15% | $125,000 | 182 | 1.82% |

A non-Zero-Edge player betting $1,000 plain-mode pays a 1.15% house edge (effective RTP 98.5–99.3%, depending on whether a triggered bonus is priced at the stake or at 125× the stake on the bonus schedule; analytical, not observed, since every captured bet had Zero Edge), not the 1.84% headline figure, which applies only at the top of the bonus schedule (buy cost above ~$126,009). Selected brackets: base 10 ($81.3881 – $90.4708) 0.10%, base 50 ($438.1154 – $446.9024) 0.50%, base 100 ($871.8705 – $880.3757) 1.00%; bonus 10 ($6,305.5813 – $7,005.5541) 0.10%, bonus 50 ($34,199.4129 – $34,893.9490) 0.50%, bonus 100 ($68,758.4213 – $69,446.0082) 1.00%. No captured spin exercised either schedule (R-BRACKET-EMPIRICAL).

Effective RTP without Zero Edge, computed as base-game RTP × (1 − base edge) + bonus contribution × (1 − bonus edge) from the model figures in [Exact RTP](#exact-rtp-authoritative) and the brackets above; a range where the bonus is priced at the stake or at 125× the stake on the bonus schedule. Every figure in this table is analytical, bracket 1 ($0.20) included: every captured bet had Zero Edge, so no edge was applied to any captured bet.

| Spin | Without Zero Edge (analytical) |
|---|---|
| $0.20 | 99.962% |
| $10 | 99.95–99.96% |
| $100 | 99.83–99.90% |
| $1,000 | 98.5–99.3% |

## Payouts and RTP

A base spin credits `Σ rounds Σ paylines base_payout_currency`; a free spin credits `Σ rounds Σ paylines (base_payout_currency × max(bomb_multiplier, 1))`, capped at 5000× the stake. In base-game spins `bomb_multiplier = 0` on every payline, so the factor is 1. Within every captured free spin the `bomb_multiplier` on every payline is identical across all paylines and all cascade rounds (0 / 475 spins vary), so the bomb is a per-spin quantity applied once at the end of the spin, monotone non-decreasing as the cascade proceeds. Example, free spin 1966450 (Phase A, $0.20): round 0 pays `symbol_1` size 8 (0.4×) and `symbol_2` size 8 (0.5×); round 1 pays `symbol_4` size 8 (0.7×), base sum 1.6×; round 2 forms no new cluster. The one multiplier, of value 7, is on the opening grid (round 0, position 18) and stays on the grid through both tumbles (the same cell, position 19 by round 2); every payline records `bomb_multiplier` 7, and `amount_won` is $2.24 = $0.20 × 1.6 × 7. Groomer's Van has no side bets.

Step 7 reconciles 6,205 of 6,205 non-buy bets exactly in integer cents against `amount_won`, the USD amount the paylines are stated in. The coins fields (`amount_won_coins`, `total_win`) carry the same amounts converted at the bet's own coins/USD rate (`bet_amount / bet_amount_currency`, the trigger's rate for a free spin; a $50.00 stake is recorded as 49.9915) and rounded to 2 dp; that rule holds on 6,225 / 6,225. Step 8 looks up every payline in `/rules` for `(symbol_code, cluster_size capped at 12)`: 4,985 / 4,985 match. Step 19 checks 4,982 cluster paylines; the difference from Step 8's 4,985 is scatter-trigger payline records, which Step 8 includes and Step 19 excludes.

### Exact RTP (authoritative)

The per-spin outcome is a deterministic function of one 32-bit `outcome_index`, so the whole input space is exactly 2³² = 4,294,967,296 values per mode. The audit enumerates it for the base and bonus modes and computes the bonus session EV by exact dense lane convolution, a state-space DP over `(running_total, retriggers_used, spins_remaining)` with a 5000× absorbing barrier, per initial-spin count, scatter-weighted. Inputs are only the operator's per-reel weights, paytable, multiplier-value distribution, cascade algorithm and 5000× max-win cap:

```
base RTP (cluster + scatter pays, no bonus)  = 0.5613760  (exact)
P(trigger) per base spin                     = 0.0044042  (1 in 227)
E[triggered session] (scatter-weighted)      = 99.5286× stake  (exact)
expected bonus contribution per base spin    = 0.0044042 × 99.5286 = 0.4383440

raw game RTP per base spin = 0.5613760 + 0.4383440 = 0.9997200 = 99.9720%
```

| Quantity | Value |
|---|---|
| Base-game per-spin RTP | 0.561376× |
| Bonus-game per-spin RTP | 12.153351× |
| E[session], 8 / 10 / 12 / 14 initial spins | 97.5997× / 121.9996× / 146.3995× / 170.7994× stake |
| E[10-spin bonus-buy session] | 121.9996× stake (exact); 5000× cap-hit probability 5.15×10⁻⁷ |
| E[triggered session, scatter-weighted] | 99.5286× stake (exact) |
| P(bonus trigger per base spin) | 1 in 227.1 |
| **Raw game RTP** | **99.9720%** |

**Model and game.** The figures above treat each free spin as an independent draw from its 2³² distribution. In the game, every free spin of a bonus derives from the trigger spin's outcome index (round_index 1..N), so a session is a deterministic function of one 32-bit value. Averaged over all 2³² indices, the game's RTP equals the model's up to the sampling spread of about 19 million triggered sessions, roughly ±0.02 points (one standard deviation). The 99.972% headline and the 0.028% gap carry that tolerance. The spread is an estimate, computed from the pinned artifacts as the within-count session standard deviation (165.13× stake: the square root of the mean of the four exact session artifacts' variances, weighted by the base enumeration's 3 / 4 / 5 / 6+ scatter counts) × √18,915,899 triggering indices / 2³² = 0.0167 points; the game's own average over the 2³² indices has not been enumerated.

The exact convolution replaced an earlier linear-scaling approximation; the two agree to ~5×10⁻⁵. The earlier 10M-session Monte Carlo (`outputs/bonus-session-ev.json`, retained for reference) returned 122.08× ± 0.058× SE for the 10-spin buy.

**The 0.028% gap.** The base game has no cap (its 2³² maximum is 112.8×). Re-running the full 2³² bonus enumeration with the per-spin cap removed gives an uncapped per-spin RTP of 12.153376 against 12.153351 capped (Δ 2.472×10⁻⁵ × stake per bonus spin, true max single-spin 8232.8× against the 5000× clamp). Step 34 bounds what that removes from the whole game at P(trigger) × 44 spins (the most a session can run) × 2.472×10⁻⁵ = at most 4.79×10⁻⁶ of RTP, 0.0005 points: with the per-spin cap removed the headline is at most 99.9725%, not 100%, so the per-spin cap accounts for at most 1.7% of the 0.028-point gap and the rest is the paytable itself under the per-spin model. The session-level 5000× cap's removed return is not enumerated (no uncapped session convolution is pinned; Step 34). Step 32 re-derives the headline on every run. `outputs/rtp-claim-table.json` scores the paid spin against the flat 100% claim (`"rtp": "100.0000"` in config v1.4) on Step 32 (RTP-CLAIM, switched on): true minimum and maximum 99.972000%, within the 0.1 pp band, outcome pass.

**RTP claim.** `outputs/rtp-claim-table.json` holds the paid spin (base game and triggered bonus) against a flat 100% claim from the game settings, one of the RTP-CLAIM rule's six places (game page, fairness page, help page, bet panel, rules, game settings): `"rtp": "100.0000"` in Duel's Groomer's Van game config v1.4. The rule (RTP-CLAIM 1.2.0, Methodology v1.1) is switched on (decision D3, 14 October 2026): the outcome is scored on Step 32, the step carrying GROOMERS-19, and a house-side miss would make the verdict RTP FIGURE OVERSTATED (exit 5), never NOT PROVABLY FAIR, because the draws themselves pass. Outcome: pass, 99.972000% (0.028 pp below the claim, inside the 0.1 pp band). The bonus buy is not in the table (its grid is operator-canned, DL-3).

**A bug the cross-check caught.** The first CUDA kernel and TypeScript enumerator both over-counted bonus multipliers: they added every multiplier value in the freshly generated cascade grid, including cells that never reach the play grid. Duel's reference verifier counts only multipliers on the top-filled positions. The bug doubled the bonus per-spin RTP from 12.15× to 22.85× (a 1.88× over-count); comparing against `src/simulate.ts`, which implements the pipeline independently, revealed it.

**CPU ↔ CUDA parity.** `scripts/cpu-cuda-parity.ts` compares the TypeScript enumeration (`src/enumerate-mt.ts`) with the CUDA kernel (`cuda/gv_cuda.cu`) field by field. The residual is float accumulation order, not algorithmic disagreement; the two paths agree to 6 decimal places of RTP (base 0.561376, bonus 12.153351 per spin; they differ by 2.9×10⁻⁷ on the base and 4.6×10⁻⁷ on the bonus, so not at the 7th), while the headline is published to 4.

| Field | Base CPU | Base CUDA | Bonus CPU | Bonus CUDA |
|---|---|---|---|---|
| range.count | 4,294,967,296 | 4,294,967,296 | 4,294,967,296 | 4,294,967,296 |
| max_payout | 112.8 | 112.8 | 5,000 | 5,000 |
| rtp | 0.5613757394 | 0.5613760344 | 12.1533506237 | 12.1533510841 |
| sum | 2,411,090,441.56 | 2,411,091,708.54 | 52,198,243,465.66 | 52,198,245,442.95 |
| Max count difference in any bin | 8 / 4.29B | | 2 / 4.29B | |

The base scatter histograms are byte-exact. Rounding to nearest at the bucketing step (`Math.round(payout*100)` and `(int)(p*100+0.5)`) removed an earlier mass shift between adjacent buckets (~28M counts before the fix); the remaining differences are single-LSB float differences at rare payouts ≥ 33.4×, affecting 1–8 spins per bucket.

### Monte Carlo cross-check (100.06%)

`src/simulate.ts` replays the same pipeline on a pinned master seed: 30,000,000 base spins with integrated trigger and session.

| Component | Value |
|---|---:|
| Base-game RTP per spin (cluster + scatter pay) | 56.13% |
| Trigger probability per base spin (cumulative scatters across cascades) | 0.4407% (≈ 1 in 227) |
| Average free-spin session payout (132,222 organic sessions, scatter-count distribution from real triggers) | 99.66× stake |
| Bonus contribution per base spin | 0.4407% × 99.6647× ≈ 43.93% (full precision 43.9262%) |
| Blended RTP | 0.561324 + 0.0044074 × 99.6647 = 1.000586 ≈ **100.06%** |

In the bonus, scatters do not pay (per the operator: "bonus uses scatters only for retrigger eval"), the multiplier EV per drop is 2094 / 200 = 10.47×, and each free spin pays `sum(cluster bases) × max(bomb total, 1)`. Precision at 30M is about ±0.1pp (per-spin std ≈ 0.97; SE on the blended mean ≈ 0.17pp, dominated by rare heavy-tail sessions; variance on the average session payout about ±0.9). Step 16 scores the simulation against the exact enumeration, not the 100% claim.

| Rounds | 1K | 5K | 10K | 50K | 100K | 500K | 1M | 5M | 10M | 30M |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cumulative blended RTP | 90.26% | 102.81% | 95.41% | 103.04% | 99.85% | 100.73% | 101.71% | 101.50% | 100.65% | **100.06%** |

The residual +0.09pp at 30M is Monte Carlo noise from rare heavy-tail sessions. The chart is [outputs/rtp-convergence.html](outputs/rtp-convergence.html); with the pinned master seed (`pf-audit-groomers-van-v1`) the trace is deterministic.

### Captured returns

| Source | Sample | Result |
|---|---:|---|
| Captured base-game spins (mode=spin, spin_type=base_game; includes scatter pays) | 5,730 | **56.87%** RTP; Pass 1 reference 55.71%, z = +0.91σ |
| Captured organic triggers | 33 / 5,730 | 0.576% (95% CI [0.38%, 0.77%]; the simulated 0.44% is inside) |
| Captured organic bonus sessions | 33 | average **104.1×** trigger bet, free spins only (95% CI ≈ [58, 150]); exact expectation 99.53× |
| Captured buy-bonus sessions | 20 | average **95.2×** bet including the 3× buy-spin scatter pay, i.e. **76.2%** of the 125× buy cost (95% CI ≈ [57, 133]× bet); exact expectation 125.0× bet |
| Phase A wallet (5,000 base + 248 free) | $1,000 → $1,210.92 | 121.09%, ~+1.4σ above 100% at n=5,000 |

These finite returns illustrate variance; they are not the RTP evidence. Both session averages are within 1.6 standard errors of their exact expectations (organic z = +0.20, buy z = −1.53). Session figures: the sum of `amount_won` over each session's free spins divided by the trigger stake, plus the buy spin's 3× scatter pay for bought sessions; CI = mean ± 1.96 × sample SD / √n (SD 135.6 organic, 87.3 buy); the expectations are E[triggered session, scatter-weighted] = 99.5286× and E[10-spin buy session] 121.9996× + the 3× scatter pay from [Exact RTP](#exact-rtp-authoritative). 100rtp.games, an independent reviewer of 0%-house-edge games, wrote in its April 2026 rules review that *"The 100% claim is verified at the rules level but not yet confirmed through end-to-end mathematical audit"*; its multiplier EV per drop, 10.47×, equals this audit's.

## Verification results

The suite evaluates the 6,225 captured entries and the pinned operator files. Its 35 scored steps report **34 PASS, one capture-origin FLAG and zero hard fails**, `PROVABLY FAIR — Full Pass`, with 0 verdict-affecting flags.

| # | Check | Result | Finding |
|---:|---|---|---|
| 1 | Seed hash integrity | PASS | 116 / 116 commitments opened: SHA-256(hex_decode(server_seed)) matches; all 116 bet-bearing epochs resolve to a revealed plaintext |
| 2 | Commitment linkage | PASS | 116 / 116 links: each rotation's active hash equals the next hash recorded at the previous rotation (a consistency check; that each next hash was shown before its epoch's bets rests on the capture's recorded order, premise P1); no pre-capture link, so the chain is established from the first captured epoch onward |
| 3 | Hash consistency within epoch | PASS | Epochs from the rotation timeline: all 6,225 bets carry the hash and client seed of the rotation active when placed, across 116 epochs |
| 4 | Nonce audit | FLAG (capture-origin) | 112 / 116 clean 0..N-1 runs, no reuse; 4 declared capture-retry gaps, each recomputed from the revealed seed but not captured, so NOT verified |
| 5 | Outcome recomputation | PASS | 6,205 / 6,205 reproduce 30/30 cells (5,726 base spins at the recorded nonce, 4 at the declared served nonce, 475 free spins at their verify record's nonce and round_index); 148 / 148 base-spin verify payloads carry the served nonce and 475 / 475 free spins follow the free-spin nonce / round_index rule; draw exactly uniform on all 13 weight totals; site verifier on 5,730 base spins; Duel's Verify-tab code (second check) 6,205 / 6,205, its initial-grid multiplier values 335 / 335 |
| 6 | Client seed influence | PASS | 623 / 623 bets with a published outcome_index change it under a tampered client seed (every one required) |
| 7 | Payout math | PASS | 6,205 / 6,205 non-buy bets reconcile exactly in integer cents against `amount_won` (USD); 6,225 / 6,225 bets: the four money fields are legal 2-dp amounts, the coins field is that amount at the bet's own coins/USD rate, and the two USD and the two coins credit fields agree |
| 8 | Multiplier provenance | PASS | 4,985 / 4,985 payline multipliers match the published paytable (11-symbol base + 12-symbol bonus) |
| 9 | Bet-size invariance | PASS | 30 / 30 Phase B bets ($1–$50) recompute byte-equal grids; stake is not an HMAC input |
| 10 | House edge audit (Zero Edge consistency) | PASS | 6,225 / 6,225 bets have edge_multiplier = 1; 7 distinct stakes, $0.20–$50 |
| 11 | Config completeness & paytable coverage | PASS | 6/6 required config fields; 62 of 96 (condition, symbol, cluster-tier) payout cells exercised, above the 55-cell floor; the 34 others are covered by the 2³² enumeration |
| 12 | Epoch size | PASS | 116 epochs: 114 of 50 bets, the capture's rotation schedule, plus close-outs of 20 and 30 |
| 13 | Population & phase labels | PASS | 6,225 entries (5,750 regular, 475 free-spin) and 117 seed records match the plan in code |
| 14 | Dataset hash | PASS | `3034cb12…` matches; 10/10 operator files under `data/raw/` match their pins |
| 15 | Phase D client seed variation | PASS | 500 regular bets across 10 auditor client seeds (10 × 50), 524 entries with free spins |
| 16 | Anti-circularity | PASS | 30M Monte Carlo scored against the exact 2³² enumeration (99.972%), not the 100% claim: base RTP, trigger probability, session payout and blended RTP each within 5 standard errors; 2/2 required corrupted models rejected |
| 17 | Simulation Pass 1 | PASS | Per-reel chi-squared 0/6 fail (Bonferroni α = 0.01/6); serial independence within thresholds; p-values recomputed |
| 18 | Pass 2 cherry-pick detection | PASS | Aggregate z = +0.91σ (|z| < 3); forward replay 4 / 115 flags, binomial p = 0.83 (≥ 0.01) |
| 19 | Cluster pays anywhere | PASS | 4,982 / 4,982 cluster paylines: count = symbol cells + wild cells |
| 20 | Tumble cascade structural integrity | PASS | 4,323 / 4,323 cascades keep survivors at the column bottom; 0 gravity violations |
| 21 | Wild substitution rule | PASS | 410 / 410 rounds with ≥ 2 paying symbols and a wild credit every wild to every cluster |
| 22 | Bonus trigger | PASS | 53 / 53 triggers match `spins_per_scatters`; 53 / 53 final-grid scatter counts match the reported count |
| 23 | Retrigger behaviour | PASS | 53 sessions, 475 free spins; 1 retrigger; 0 sessions over the cap of 3 |
| 24 | Cosmetic buy-spin disclosure | PASS | 20 / 20 buys carry `_verify_session.is_bonus_buy=true` and have no cluster paylines |
| 25 | Buy-bonus structure | PASS | 20 / 20 show exactly 4 scatters and award exactly 10 free spins |
| 26 | Free-spin payout reconciliation | PASS | 475 / 475 free spins reconcile exactly in integer cents |
| 27 | Bonus multiplier symbol | PASS | 935 multiplier cells in bonus_game, 0 in base_game; all 14 published values observed, none outside the set |
| 28 | Cascade RNG byte-exact replay | PASS | 4,323 cascades: 129,690 / 129,690 cells and 146 / 146 multiplier values; 2,974 spins exercised, the 20 declared buys skipped |
| 29 | Base 2³² artifact integrity | PASS | SHA-256 matches the pin (`0b890eef7153fcdf…`) |
| 30 | Bonus 2³² artifact integrity | PASS | SHA-256 matches the pin (`e878256256cf59ed…`) |
| 31 | Session-EV artifact integrity | PASS | All 4 exact session artifacts (8/10/12/14 initial spins) match their pins |
| 32 | Headline game RTP derivation | PASS | 99.9720% re-derived from the 2³² base enumeration and the exact session convolution; the base RTP equals the base artifact's own sum / count and histogram mean. The derived total is the RTP table's one row, held to the 100% claim by RTP-CLAIM on this step (within the 0.1 pp band). Until 14 October 2026 (C3) the step compared the total with the claim itself: an operator FLAG (exit 2) within 1 pp, FAIL beyond |
| 33 | Artifact integrity (pinned artifacts of record) | PASS | 13 / 13 tracked `outputs/` artifacts match their pins in `src/artifact-pins.ts` |
| 34 | Max-win cap & payout bounds (flag-only) | PASS | 6,225 / 6,225 rounds and 53 / 53 sessions within 5,000× (largest 630× per spin, 647.1× per session) |
| 35 | Live-sample fit (informational, flag-only) | PASS | Initial-deal symbol frequencies of the 5,730 base spins fit the weights on all 6 reels; hit and trigger rates fit the enumeration (8 tests, Bonferroni 0.01/8) |

**The nonce flag (Step 4).** Four epochs have one nonce missing from the capture: epoch `d6bebb43…` nonce 47, `22f48a0f…` nonce 2, `77544e55…` nonce 22 and `3052a819…` nonce 9, declared by identity in `src/loader.ts` `EXPECTED_NONCE_GAPS`. The server consumed nonce N and resolved the bet, the response was lost in transit, and the retry was served at N+1. The outcome at each missing nonce is computable from the revealed seed, but the round was not captured, so it is not verified. A gap more or fewer, a reused nonce or a gap under an unrevealed seed is a hard FAIL. **Corrected 26 September and 4 October 2026:** until 26 September the missing nonces were named 48, 3, 23 and 10. In four epochs the capture's pre-bet snapshot recorded nonce N for the bet actually served at N+1: spin ids 1965523, 1974625, 1976463 and 1987633 reproduce at recorded + 1 and not at the recorded nonce (`CAPTURE_NONCE_CORRECTIONS`), and Step 5 proves each correction. The 26 September correction found three of them; until then Step 5 tried `nonce`, `nonce+1` and `nonce-1` on every spin and accepted any match. The fourth, 1974625 in epoch `22f48a0f…`, was corrected on 4 October 2026: it triggered a bonus, so it carries a verify record (nonce 3), and Step 5 took that record's nonce without comparing it with the recorded nonce 2. Step 5 now requires every base spin's verify-record nonce to equal its served nonce.

**Client seed (Steps 6, 15).** Each of the 623 bets whose /verify payload publishes a seed pair and an `outcome_index` is recomputed with `_PF_TAMPERED` appended to its client seed; all 623 move (the step previously sampled 100 bets and passed at 95/100). The 500 Phase D bets on `pfaudit_groomers_seed00` … `09` reproduce 30/30 cells.

**How Steps 16–18 score the simulation.** Step 16's standard errors come from the exact variances in the pinned artifacts (the base game's 2³² payout histogram, each session artifact's `std`), not from the simulation tested; the blended bound uses SD(base + bonus) ≤ SD(base) + SD(bonus). It also recomputes the trigger probability from the trigger count, the session count from the per-scatter distribution and the blended figure from its parts; the 30M per-spin rows do not ship, so the base and session totals are read as scalars. Step 17 recomputes every per-reel p-value (150M draws per reel, exact incomplete-gamma p-values) and both serial thresholds (lag-1 |z| < bonferroniCriticalZ(0.01, 6) ≈ 3.14 and runs p > 0.01/6 on 100,000 per-spin payouts). Step 18 (a) recomputes the captured aggregate over 5,730 spins in 115 epochs against the Pass 1 reference mean 55.71% (a 100K-spin subsample of the 30M run; per-spin std 0.97, SE 0.0128); (b) replays each epoch's revealed seed over nonces 0..9999, bins win/no-win, and flags an epoch whose early window (0..49) deviates at p < 0.05 while its late window does not, with expected proportions from the pinned `outputs/base-2pow32.json`: 4 / 115 flags against ~5.75 expected, binomial P(X ≥ 4 | n=115, p=0.05) = 0.83. Per-seed informational: 5 / 115 seeds above the Pass 1 95th percentile (expected ~6). Not recomputed: the 100K reference sample and the per-nonce win counts, which do not ship (DL-7).

**Bonus triggers (Step 22).** By scatter count: 3 (organic) 30 triggers → 8 spins; 4 (organic) 2 → 10; 4 (buys) 20 → 10; 5 (organic) 1 → 12; 6: none. Free spins by source: Phase A organic 248 (27×8 + 2×10 + 1×12), Phase C buys 203 (200 + 3 from the single retrigger, +3 under `retrigger_rewards[3]`), Phase D organic 24 (3×8). Simulated trigger rate 0.4407% against the captured 0.576%.

**Rule coverage.** 23 rules have a directly verifying scored step, one is verified analytically only (scaling edge at any bracket) and three are disclosed as operator trust. The 50-bet epoch, counted here as a rule until 6 October 2026, is the capture's rotation schedule, not a game rule; Step 12 checks the epochs against it as part of the population of record.

| Rule | Step(s) | Evidence |
|---|---|---|
| 5×6 grid; min cluster 8 | 5, 11 | 6,225 / 6,225 deals show 6 reels × 5 rows; no captured cluster payline below 8 (4,982 / 4,982 at tiers 8–12+, Step 11); `/rules` also gives `rules.min_cluster_size` = 4 ([Game and algorithm](#game-and-algorithm)) |
| Cluster pays anywhere with wild substitution | 19, 21 | 4,982 / 4,982 paylines |
| Wild contributes to every simultaneous cluster | 21 | 410 / 410 rounds |
| Tumbling with gravity fill; per-cell drop fill | 20, 28 | 4,323 / 4,323 cascades; 129,690 / 129,690 cells |
| Trigger threshold 3; awards 3→8, 4→10, 5→12, 6→14 | 22 | 53 / 53 |
| Retriggers 3→+3, 4→+5, 5→+8, 6→+10; cap 3 | 23 | 0 sessions over the cap |
| Multiplier symbols only in bonus; values from the published set | 27, 28 | 0 base sightings; 935 cells; 146 / 146 values replayed |
| Sticky multiplier applied to the spin's total cluster win | 26 | 475 / 475 |
| Buy = 4 scatters → 10 spins; buy first spin cosmetic | 24, 25 | 20 / 20; disclosed (R-BUY-FIRSTSPIN) |
| Max win 5,000× | 34 | 0 of 6,225 rounds and 0 of 53 sessions above the cap |
| Stake range; stake not an HMAC input | 9 | Phase B $1–$50 |
| Theoretical RTP vs the 100% claim | 16, 32 | 99.9720% exact; 100.06% Monte Carlo |
| Zero Edge at this account; scaling edge at any bracket | 10; analytical | 6,225 / 6,225; disclosed (R-BRACKET-EMPIRICAL) |
| Commit-reveal chain | 1, 2 | 116 / 116 |
| Outcome reproduction; payouts; paytable | 5; 7; 8 | 6,205 / 6,205; 6,205 / 6,205; 4,985 multipliers |
| Client-seed influence | 6, 15 | 623 / 623; 500 / 500 |

Steps 1–4 are in `tests/steps/commitment.ts`, 5–6 `determinism.ts`, 7–9 `payouts.ts`, 10–15 `dataset.ts`, 16–18 `simulation.ts`, 19–28 `game-specific.ts`, 29–32 `enumeration.ts`, 33 `artifacts.ts`, 34 `max-win.ts`, 35 `live-fit.ts`.

### Framework S5 matrix and attack categories

S5: fairness-integrity matrix; game-integrity testing not commissioned.

The standardized fairness-integrity matrix (framework layer S5), restated on 26 September 2026 from the package categories below. Each row is tied to the scored step that decides it on the 6,225-entry capture (`outputs/verification-results.json`: 34 PASS + 1 capture-origin FLAG, PROVABLY FAIR — Full Pass).

<!-- S5-MATRIX:START -->
| Test | Category | Attack | Expected fair behaviour | Result | Decided by |
|------|----------|--------|-------------------------|--------|------------|
| S5-1 | Seed substitution | Reveal a seed other than the one committed | Every revealed seed hashes to its commitment; rotation order pre-committed | Pass (hash and link equality are consistency checks; that each commitment was shown before its bets rests on the capture's pre-bet records, Step 3, conditional on capture integrity, premise P1; no pre-capture link — the chain is anchored from the first captured epoch) | Steps 1, 2, 3, 14 |
| S5-2 | Client-seed manipulation | Ignore the player's client seed | A different client seed changes the outcome index | Pass | Steps 6 (623/623 tampered), 15 (10 auditor seeds, 500 bets recompute) |
| S5-3 | Stake-conditional outcome | Serve worse grids at higher stakes | Same seed → same grid at any stake | Pass (30 elevated-stake bets, $1–$50) | Step 9 |
| S5-4 | Server-seed cherry-picking | Pre-select seeds whose first spins run cold | No early-window bias across revealed seeds | Pass (limited power) | Step 18 — 115 epochs × 10,000 nonces, 4/115 flags |
| S5-5 | Seed-rotation race (TOCTOU) | Rotate the seed while a bonus session is open | The session settles under the seed it started with | Not tested — disclosed | No capture rotates mid-session |
| S5-6 | Multiplier tampering | Pay a multiplier other than the published table's | Every payline multiplier and bomb value from the published tables | Pass | Steps 7, 8, 26, 27 |
| S5-7 | Nonce manipulation | Skip, repeat or reorder nonces | Nonces 0…N−1 per epoch, no reuse | Pass (4 capture-retry gaps disclosed as a capture-origin FLAG) | Step 4 |
| S5-8 | Range-mapping bias | Map PRNG output to symbols with a biased reduction | Every weighted draw exactly proportional to its weights | Pass (rejection sampling — bias exactly 0 on all 13 weight totals) | Step 5; Step 17 (per-reel chi-squared on 30,000,000 simulated spins) |
<!-- S5-MATRIX:END -->

| # | Package category | Attack idea | Detector | Result |
|---:|---|---|---|---|
| 1 | Server-side seed substitution | Reveal a different seed than committed | Step 1 | All 116 match |
| 2 | Outcome forgery / replay | Serve grids that do not reproduce | Step 5 | 6,205 / 6,205 |
| 3 | Stake-dependent payouts | Worse grids at higher stakes | Step 9 | 30 / 30 |
| 4 | Client-seed disregard | Ignore the player's seed | Steps 6, 15 | 623 / 623 + 500 / 500 |
| 5 | Paytable manipulation | Pay a multiplier not in the table | Step 8 (two paytable sources agree) | 4,985, 0 mismatches |
| 6 | Cluster-size manipulation | Report a count that differs from the grid | Step 19 | 4,982 / 4,982 |
| 7 | Tumble re-roll bias | Re-shuffle a cascade until favourable | Steps 20, 28, 17 | Survivors preserved; cells byte-exact |
| 8 | Bonus-frequency suppression | Trigger less often than the weights predict | Steps 18, 22 | z = +0.91; 53 / 53 |
| 9 | Multiplier-bomb skew | Weighted values actually skewed low | Steps 27, 17 | All 14 values observed |
| 10 | Edge applied to the Zero-Edge account | An edge charged on a captured bet inside the Zero-Edge allowance (which bracket the server applies was not exercised, R-BRACKET-EMPIRICAL) | Step 10 | 6,225 / 6,225 at edge_multiplier 1 |

Acknowledged but not detectable from this capture: multi-account differential treatment (R-MULTI), cherry-picked seed selection (R-CHERRY-PICK, statistically bounded by Step 18) and buy-spin grid content (R-BUY-FIRSTSPIN). Per-cell tumble-fill verification, listed here in earlier drafts, is now detected by Step 28.

## Reproduce the audit

Use **Node.js 22.x**, as pinned by `.nvmrc` and `package.json`; the committed artifacts were produced on that line, and the last bits of a derived floating-point statistic are runtime-dependent. Dependencies (TypeScript, ts-node, Mocha) come from the included lockfile; there are no global installs and no third-party statistical libraries (`src/stats.ts` implements chi-squared via the regularised incomplete gamma, lag-1 autocorrelation, the Wald-Wolfowitz runs test, Bonferroni critical values, a Beasley-Springer-Moro probit, tail-bin pooling, mean/std and Fisher's combined p-value).

```sh
npm ci
npm test
```

- **Verification steps:** 35 scored steps in `tests/verify.ts`. Steps 1–28: dataset replay — commitment chain (1–4), outcome determinism (5–6), payout reconciliation and sibling money-field consistency (7–9), population and dataset integrity (10–15), Monte Carlo cross-check and cherry-pick detectors (16–18), game-specific mechanics and byte-exact cascade RNG replay (19–28). Steps 29–32: enumeration artifact integrity and the headline RTP re-derivation. Step 33: artifact integrity. Step 34 (added 26 Sep 2026, flag-only): the 5,000× max-win cap on every served round and bonus session, and the RTP the per-spin cap removes. Step 35 (added 26 Sep 2026, informational flag-only): live-sample fit.
- **Unit tests:** Mocha, 21 tests (`tests/groomers-van/GroomersVanTests.ts`, 20 tests; known-answer tests anchored to captured bet 1964586: SHA-256 commitment, outcome_index with client/server/nonce negative controls, PCG32 determinism, weighted-pick boundaries, 30/30 grid reproduction, single-bit avalanche; the 19th, added 26 Sep 2026, runs Duel's own Verify-tab code on a fixed captured spin as a second check; the 20th, added 4 Oct 2026, holds two captured free-spin vectors — free spin 1966413 of a triggered bonus at nonce 40 / round 1 and free spin 1987729 of a bought bonus at nonce 0 / round 0 — to outcome index, grid and multiplier values, with negative controls at the previously documented inputs; and `tests/groomers-van/RngSpecTests.ts`, added 20 Oct 2026: the specification's own vectors and properties, 166 checks against `src/rng.ts`, written by the clean-room implementer with the module)
- **Expected `npm test` result:** mocha 21 passing · 34/35 PASS + 1 capture-origin FLAG (Step 4, the 4 capture-retry nonce gaps; verdict-neutral) · PROVABLY FAIR — Full Pass · REPRODUCED · exit 0

| Script | What it does | Writes |
|---|---|---|
| `npm test` | mocha + `npm run verify` | `outputs/run/` |
| `npm run test:full` | mocha + `npm run simulate` + `npm run verify` | `outputs/run/` |
| `npm run verify` | 35-step verifier + reproduction gate | `outputs/run/verification-results.json`, `outputs/run/diff.json` |
| `PF_EMIT=1 npm run verify` | Refresh the committed verifier artifact | `outputs/verification-results.json` |
| `npm run simulate` | 30M-spin Monte Carlo cross-check (tens of minutes; `GVS_QUICK=1` runs a 50K dev sim in ~1 s, `GVS_BASE_SPINS=<N>` overrides the size) | `outputs/run/simulation-results.json`, `outputs/run/rtp-convergence.html` |
| `PF_EMIT=1 npm run simulate` | Refresh the committed Monte Carlo artifacts — re-pin afterwards | `outputs/simulation-results.json`, `outputs/rtp-convergence.html` |
| `npm run enumerate:cpu:both` | Full 2³² CPU enumeration (hours) | `outputs/cpu-*-2pow32.json` |
| `npm run enumerate:cuda` | Full 2³² CUDA enumeration (requires `npm run enumerate:cuda:build`) | `outputs/*-2pow32.json` |
| `npm run parity:base` / `parity:bonus` | CPU↔CUDA numerical parity (`scripts/cpu-cuda-parity.ts`) | — |
| `npm run session-ev-exact:{8,10,12,14}` | Exact dense-lane-convolution session EV | `outputs/bonus-session-ev-exact-N.json` |
| `npm run mutate` | Mutation battery in a disposable copy | — |
| `npm run rtp-claim:write` | Rewrite the RTP claim table and print its SHA-256 to pin | `outputs/rtp-claim-table.json` |

**Enumeration layers.** Layer 1 (everyone, seconds): the committed 2³² and session-EV artifacts are hash-verified by `npm test`, and Step 32 re-derives the headline from them. Layer 2 (a desktop CPU, hours): `src/enumerate-mt.ts` walks all 2³² outcome indices on `worker_threads`, ~1.8h base + ~2.6h bonus = ~4.4h on a 20-thread i5-14600K-class CPU, and emits the same JSON schema as the CUDA artifact, confirming the per-spin figures 0.561376× base and 12.153351× bonus from the shared `rng.ts` / `cluster.ts` / `paytable.ts` path. Layer 3 (NVIDIA GPU, seconds): `cuda/gv_cuda.cu`, ~37s base + ~55s bonus on an RTX 5060, produced the committed artifacts; operator constants are extracted by `src/dump-cuda-constants.ts` into `cuda/gv-constants.json` and compiled in via `cuda/gen_constants_h.py`.

**The gate.** `npm run verify` writes **nothing** into `outputs/`. This run's results and `diff.json` go to `outputs/run/` (gitignored), so a re-run cannot replace the evidence it scores. `outputs/run/diff.json` compares the run with the committed artifact field by field (`src/diff.ts`) and records the runtime; the tolerance is **1e-14 absolute + 1e-12 relative**, and two distinct integers never agree. The SHA-256 dataset guard is never rewritten to make a run agree. The simulator follows the same rule: `npm run simulate` writes under `outputs/run/`, and only `PF_EMIT=1 npm run simulate` rewrites the committed pair. `outputs/verification-results.json` carries no timestamp (removed 26 Sep 2026), so a re-emission that computes the same result reproduces its bytes.

| Code | Meaning |
|---:|---|
| 0 | `PROVABLY FAIR — Full Pass`, and this run reproduces the committed artifact |
| 1 | At least one hard fail, **or** a reproduction difference beyond tolerance |
| 2 | At least one operator-origin FLAG — `PROVABLY FAIR — Conditional Pass`. A capture-origin FLAG (Step 4's capture-retry gaps) is printed and recorded but is verdict-neutral and exits `0` |
| 5 | `RTP FIGURE OVERSTATED`: no draw check failed, but the RTP-CLAIM rule (1.2.0, switched on) found settings beyond the 0.1 pp band on the house side of the published figure. It outranks a Conditional Pass; a hard fail (exit 1) outranks it |

**Artifacts of record.** Every tracked file under `outputs/` other than the verifier's own output is pinned by SHA-256 in `src/artifact-pins.ts` and checked by Step 33 on every run — 13 files: the 2³² base and bonus enumerations (capped and uncapped), the CPU re-enumerations, the exact session-EV convolutions at 8/10/12/14 initial spins plus the default, the Monte Carlo session-EV, `simulation-results.json` and `rtp-convergence.html`. `outputs/verification-results.json` is protected by the reproduction gate instead. Any script that regenerates a pinned artifact must be followed by re-pinning it in `src/artifact-pins.ts` (and, for the enumeration and session-EV files, in `tests/steps/enumeration.ts`) in the same commit as the run that produced it. The RTP claim table has its own pin in `src/rtp-settings.ts`; `npm run release-manifest` rewrites [RELEASE-MANIFEST.json](RELEASE-MANIFEST.json).

**Deterministic.** `npm run verify` gives the same 35-step output on every run. `npm run simulate` derives its Pass 1 PCG32 seed as `HMAC-SHA256(MASTER_SEED, "groomers-van-pass1")` with `MASTER_SEED = "pf-audit-groomers-van-v1"` (override with `GVS_MASTER_SEED=<string>`), so a run gives bit-for-bit identical numbers. To audit a fresh capture: replace the dataset, update `EXPECTED_HASH` and the population constants in `src/loader.ts`, run `PF_EMIT=1 npm run simulate`, re-pin the Monte Carlo pair, run `PF_EMIT=1 npm run verify`, then `npm test` must report `REPRODUCED`.

**Mutation battery.** `npm run mutate` runs 51 step-named mutations in `tests/mutations.json` (48 until 14 October 2026, 52 until 20 October 2026, when M05g, which moved a `src/rng.ts` citation, was retired with the citation table and M05e was retargeted to the rebuilt module's acceptance rule) in a disposable copy (300 s hard timeout per run), each with the marker of the guard that must fire, including forgeries that edit a pinned artifact and re-pin it. Measured 5 Oct 2026 (Apple M2 Max, Node v22.23.1): 48/48 killed, 35/35 scored steps covered; no declared survivors. Rerun on 14 October 2026 on the tree carrying RTP-CLAIM 1.2.0 switched on (same machine and Node): 48/48 killed, 35/35 scored steps covered. M05i and M05j kill the Step 5 payload-nonce and free-spin-rule guards; M05k gives Duel's Verify-tab code the 14 distinct multiplier values instead of the weighted list and kills the Step 5 multiplier comparison (32 / 335 agree); M07b sets one bet's coins credit to its unconverted USD figure and kills the Step 7 conversion check. The 4 October run fixed the battery's disposable copy, which had not copied `outputs/rtp-claim-table.json` since that table was committed on 30 September, so the copy's baseline exited 1 and no mutation could run. Second pass, 14–15 October 2026 (FIXPASS2 class C3, the exit-5 entries): see the release-history entry "14 October 2026 (second pass)". Rerun on 20 October 2026 on the clean-room tree (same machine and Node), the whole registry of 51 entries in one run: 51/51 killed, 35/35 scored steps covered; the release manifest records that run.

### Fresh-clone reproduction (measured 26 Sep 2026)

| Run | Tree | Node | Result |
|-----|------|------|--------|
| `git clone` of `ProvablyFair-org/pf-duel-workspace` → `npm ci` → `npm test` | origin/main @ `79aa65b` (this game last changed in `8f13658`) | v22.23.1 | npm ci exit 0; npm test exit 0 — 18 passing, 32/33 + 1 capture-origin FLAG, Full Pass, REPRODUCED; `outputs/run/verification-results.json` byte-identical to the committed file |
| same clone → `npm run test:full` | as above | v22.23.1 | **exit 1 after 496 s**: `src/simulate.ts` read the pinned base enumeration from `outputs/run/` instead of `outputs/` and crashed (ENOENT) after Pass 1 — fixed on 26 Sep 2026 |
| copy of exactly the files the next commit carries (`git ls-files` + untracked-not-ignored) → `npm ci` → `npm test` → `npm run test:full` | working tree on `8f13658` + this round's changes | v22.23.1 | npm ci exit 0; npm test exit 0 (REPRODUCED, byte-identical); test:full exit 0 (497 s on the final copy) — regenerated `simulation-results.json` and `rtp-convergence.html` byte-identical to the pinned files, and the diff against the pin is now part of test:full |

## Verify a bet

An ordered path a player can follow to check one Groomer's Van spin end to end. Field names are the ones Duel serves and the ones the Framework 1.1 declaration (`duel.groomers-van`) records: the active seed pair under `activeAtSpin.*` (Duel's `GET /api/v2/client-seed`), the spin under `response.*`, and the reveal and reproduction data under Duel's per-spin verify record (`GET /api/v2/slots/spins/{spin_id}/verify`, captured as `verifyData.*`). Nothing below reads an operator probability or odds table.

1. **Save the commitment, then reveal the server seed.** Before you bet, copy the commitment Duel shows for your seed pair, `activeAtSpin.server_seed_hashed`, and keep that copy outside the site; step 3 compares the revealed seed against it. After playing, rotate your seed pair (Duel's seed-rotation modal, `POST /api/v2/client-seed/rotate`). Rotation ends the epoch and reveals the plaintext server seed of the epoch you played in; until then only its commitment `activeAtSpin.server_seed_hashed` is public, and the next epoch's commitment `activeAtSpin.next_server_seed_hash` is already shown before you rotate. After rotation the spin's verify record carries `server_seed`, `server_seed_hash`, `client_seed`, `nonce`, `round_index` and the operator's own `outcome_index` / `outcome_index_hex`.
2. **Collect the fields to paste.** `server_seed` (the revealed plaintext, 64 hex characters, 32 bytes); `activeAtSpin.server_seed_hashed` (the commitment you saved before the spin, step 1); `activeAtSpin.client_seed` (your client seed for that epoch, as typed, a UTF-8 string); `nonce`: for a base spin, `activeAtSpin.nonce` (the spin's index within the epoch, counted from **0**). For a free spin, the nonce of the spin that started the bonus (the trigger spin, or the buy), as carried in the free spin's verify record (`nonce`). During a bonus, `activeAtSpin.nonce` (Duel's `GET /api/v2/client-seed`) already reads one higher. `round_index`: **0** for a base spin. For a free spin, the verify record's top-level `round_index`: **1..N** in a triggered bonus (the trigger spin is round 0) and **0..N−1** in a bought bonus. Do not use `tumbles[].round_index`; in a triggered bonus it is one lower and does not reproduce. Then the served outcome you are checking: `response.rounds[t].data.view` (the grid of cascade t), `response.total_multiplier`, `response.total_win_currency` and your stake in USD, `response.bet_amount_currency`. Compare the USD credit (`total_win_currency`, `amount_won`) with the USD stake: `response.bet_amount` is the stake in the account's coins (a $50.00 stake is recorded as 49.991500), so a 1× win of $50.00 computed from it rounds to $49.99 (spin ids 1987702 and 1987704; 1987715, a 0.7× win of $35.00, gives $34.99).
3. **Check the commitment encoding.** The seed is hashed as **bytes**, not as its hex string: `SHA-256( hex_decode(server_seed) ) ==` the `activeAtSpin.server_seed_hashed` you saved in step 1. A PASS here means hash equality: the revealed seed is the one behind that hash. It does not show when the hash was made, since a seed and hash produced after the spin would also match each other; the assurance that the seed was fixed before your bet comes from the copy you saved before betting.
4. **Derive the outcome index.** One HMAC per spin, no cursor; the client seed is **hex-encoded** first: `message = hex( utf8(client_seed) ) + ":" + nonce`, and `outcome_index` is the first 4 bytes, big-endian, of `HMAC-SHA256( key = hex_decode(server_seed), message )`. Where Duel's verify record is available it carries this `outcome_index`. This audit recomputes it on all 6,205 non-buy entries with its own code and with Duel's own Verify-tab code, which agree on 6,205 / 6,205 (Step 5).
5. **Derive each cascade's seed and PRNG.** For cascade t = 0, 1, 2, …: `tumble_seed = deriveTumbleSeed(outcome_index, round_index, t)` (x = outcome_index; x ^= imul(round_index + 1, 0x9e3779b9); x ^= imul(t + 1, 0x85ebca6b); x ^= x >>> 16; x = imul(x, 0xc2b2ae35); x ^= x >>> 16, all unsigned 32-bit), and the PRNG is PCG32 (XSH-RR 64/32) seeded from `tumble_seed` by the SplitMix64 expansion. Each symbol is one weighted draw: take a PCG32 uint32 v, reject it while v ≥ 0xFFFFFFFF − (0xFFFFFFFF mod W) (W = the reel's total weight), then walk the reel's cumulative weights to `v mod W`. The weights are the operator's published per-reel table (`data/raw/groomers-van-config-v1.4.json`, `base_game` for a base spin, `bonus_game` for a free spin); in the bonus, each multiplier cell then draws its value from the published weighted value list (the served values follow those weights on 335 / 335 initial-grid multipliers, and Duel's Verify-tab code, given those weights as a 200-entry list, gives the same values). `src/rng.ts` implements exactly this; rebuilt from [docs/ALGORITHM.md](docs/ALGORITHM.md).
6. **Lay out the grid and apply the rules.** The grid is **6 columns × 5 rows, column-major**: cells are drawn column 0 top-to-bottom, then column 1, …, so cell (col, row) is `position = col × 5 + row` (0-based) and `response.rounds[t].data.view[col][row]` is that cell. A symbol pays when it appears **anywhere** on the grid at least 8 times, wilds counting toward every symbol (sizes above 12 pay the 12 tier); winning cells are removed, survivors fall, and the empty top cells are filled from cascade t + 1's freshly drawn grid; the spin ends on the first cascade with no win. 3 / 4 / 5 / 6+ scatters award 8 / 10 / 12 / 14 free spins. The credit is the sum of the paylines × max(bonus multiplier total, 1) in free spins, capped at 5000× the stake (Step 7 reconciles it in integer cents against `amount_won`, the USD credit, on 6,205 / 6,205 non-buy spins; Step 34 checks the cap).

On Duel's Verify tab, choose Groomer's Van and the Symbol Distribution (Base game or Bonus game), and paste that mode's per-reel weights into Symbol Weights as JSON, for example `[{"reelIndex":0,"symbolWeights":[…]}, …]` from `data/raw/groomers-van-config-v1.4.json` (`weights.symbol_distributions_by_condition`). The page does not prefill them; with the field empty it shows no result. The field names and the empty default are as seen on Duel's Verify page on 5 Oct 2026, in a live check that was not captured into this package. The code as pulled on 19 May (E04) matches: it carries `const reelConfigs = [];` (decoded line 15), and a reel with no entry stops the run at ``throw new Error(`No config for reel ${col}`)`` (line 100).

If all six checks hold, and the hash in step 3 is the one you saved before the spin, the spin is provably fair: every cell of every cascade follows from the seed behind that saved commitment and from your client seed and nonce, and the credit follows the published paytable. The hash match is a consistency check; the timing comes from your saved copy. For the captured spins the timing rests instead on the capture's pre-bet records: the commitment snapshot taken before each spin request (`activeAtSpin`, per the published capture methodology in [capture/capture.reference.js](capture/capture.reference.js)) and the rotation records' commitment fields and timestamps (the plaintext `serverSeed` on 116 of the 117 records was attached at export, [Dataset and capture](#dataset-and-capture)), with every bet placed after the record that committed its hash (Step 3), conditional on capture integrity, which the package assumes (premise P1). The audit runs this path on the captured spins (Steps 1, 5, 7, 19–21, 28, 34), and Step 5 checks that every free spin's nonce and round_index follow step 2 (475 / 475); the 20 bought bonuses are the exception — their trigger spin is server-canned to guarantee the scatters and is not in the published RNG (Step 5 skips them; Steps 24–25).

Worked captured vector (the anchor bet, verified in `tests/groomers-van/GroomersVanTests.ts`): spin_id **1964586** (Phase A, $0.20, base_game); server_seed `38daabbe1a0a8e472690d8359f05bd5ad44dee3f60902dc14eeed66bdb710e67`; server_seed_hashed `1966b35c0357323c0e3f5f7150805522bfb6d7db386dab31340e7bc9c4d9a3dd`; client_seed `pf_ww6Oka8nm8byd`; nonce 49. The operator-published `outcome_index_hex` is `1a638947`, and `src/rng.ts` computes **`1a638947`**; the 30-cell grid reproduces 30/30 cells.

## Evidence

Every empirical claim is anchored to a file in `data/` or a step in `outputs/verification-results.json`: find the step's `detail` and `data` under `steps[]`, then the function in `tests/steps/*.ts` that produced it from the loaded dataset. Screenshots are contextual rather than load-bearing. Exhibits were numbered from E01 with their evidential role on 2026-09-26 (profile GROOMERS-30: E03 and E04 were in the package before but carried no exhibit number).

| ID | File | Contents and role |
|---|---|---|
| E01 | [evidence/E01-groomers-van-game-ui.png](evidence/E01-groomers-van-game-ui.png) | The live Groomer's Van game page on duel.com: the 6×5 grid, the "Buy Bonus" panel, and the "Provably Fair" / "Zero Edge" / "House Edge 0%" labels the operator displays on the game. |
| E02 | [evidence/client-seed-origin.png](evidence/client-seed-origin.png) | DevTools capture (2026-06-03) of the live duel.com JS bundle showing how the default client seed is generated: a 16-character string drawn per character from a 63-character alphabet via rejection-sampled `crypto.getRandomValues`, pre-filled client-side by the seed-rotation modal and sent to the server only on "Rotate Seed". Supports the client-seed-influence discussion (Step 6, Step 15). |
| E03 | `Groomer's Van audit questions.pdf` (held on file by ProvablyFair.org in its private audit workspace, outside this package; not in this package and not published; also listed as D05) | The operator's (Duel's) written answers, received 2026-05-09, on the cascade RNG mechanics, the max-win cap behaviour and the base-vs-bonus rules. Evidential role: through v1.1.0, named as the source of the cascade algorithm Step 28 replays; since v1.2.0 that algorithm is taken from `docs/ALGORITHM.md`, which does not use this file (see [RNG](#rng), Cascades). The 5000× cap value Step 34 asserts is taken from D02, the operator config, not from this PDF. No step reads the file. SHA-256 of the file on record: `af9329dd6c7972452f3bbda262305185d0b97f31c89dac0a239e8147e089531b`. |
| E04 | [evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json](evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json) | Duel's own Groomer's Van Verify-tab code ("Provably Fair Slots Verification (PCG32 PRNG)"), pulled from duel.com/fairness/verify on 2026-05-19 and vendored byte for byte. Evidential role: the operator's published verifier, run unmodified by Step 5 on all 6,205 recomputable entries as a second check; not the source of `src/rng.ts`, which is rebuilt from `docs/ALGORITHM.md` (through v1.1.0 it was ported from this file); pinned in `src/operator-verifier.ts` (SHA-256 `20fefa7d2ad374b50d9ad83b98f79edff4fc5b34e2bb88706dfde022d31539d2`). |

| ID | File | Contents |
|---|---|---|
| D01 | [data/groomers-van-smoke-test-1778204681017.json.gz](data/groomers-van-smoke-test-1778204681017.json.gz) | Primary captured dataset — 6,225 bets, 117 seed rotations; the 13,525 raw HTTP events were redacted before publication (`meta.eventsRedacted`; no verifier step reads them). SHA-256 (uncompressed): `3034cb1284bc1a87d82a0d8f914b19d7f1a8f16894ffe601242bd29e3873b967` |
| D02 | [data/raw/groomers-van-config-v1.4.json](data/raw/groomers-van-config-v1.4.json) | Operator's `/api/v2/slots` response, filtered to groomers-van: per-reel weights, free-spin feature rules with the multiplier weights, scaling-edge schedule. It holds no paytable; the payouts are in D03 |
| D03 | [data/raw/paytable-from-rules-endpoint.json](data/raw/paytable-from-rules-endpoint.json) | Operator's `/api/v2/slots/groomers-van/rules` response; cross-checked against the help panel: full agreement |
| D04 | [data/raw/paytable-extracted-from-help.json](data/raw/paytable-extracted-from-help.json) | DOM-extracted paytable from the in-game help panel; cross-check source for D03 |
| D05 | `Groomer's Van audit questions.pdf` — held on file by ProvablyFair.org in its private audit workspace, outside this package; not in this package and not published | Operator written answers on cascade RNG mechanics, max-win cap behaviour and base-vs-bonus rules; received 2026-05-09; no step reads the file; its SHA-256 is recorded under E03 |
| D06 | [data/raw/slots-2026-10-05.json](data/raw/slots-2026-10-05.json) (+ `.meta.json`) | Operator's `/api/v2/slots` response, part of the duel.com config as fetched 2026-10-05 in a logged-in session (read-only GET), unfiltered; its one entry, groomers-van, equals D02, so it holds no paytable either. SHA-256 `f112728a0343c0cf8f6ed05d1801fc828be34b99bbaafdf1b20005534a4f7dc6`, pinned (Step 14) |
| D07 | [data/raw/slots-groomers-van-rules-2026-10-05.json](data/raw/slots-groomers-van-rules-2026-10-05.json) (+ `.meta.json`) | Operator's `/api/v2/slots/groomers-van/rules` response, part of the same 2026-10-05 fetch (same logged-in session, read-only GET); byte-identical to D03, so it carries the same paytable. SHA-256 `c3479bf62ee9ed45896506db8972a9b338b693345db47633687af440b27ffcd1`, pinned (Step 14) |

### Files supporting the recorded result

| File | Role |
|---|---|
| [outputs/verification-results.json](outputs/verification-results.json) | The 35 scored results with detail strings, machine-readable `data` blocks, profile mappings and the verdict; diffed field by field against each fresh run |
| [outputs/simulation-results.json](outputs/simulation-results.json) | Pass 1 (30M base spins, integrated trigger and session, per-reel chi², serial independence, 100.06% blended) and Pass 2 (aggregate z, forward replay); pinned (Step 33) |
| [outputs/rtp-convergence.html](outputs/rtp-convergence.html) | Self-contained convergence chart of cumulative blended RTP over the 30M Pass 1 sequence; pinned (Step 33) |
| [outputs/base-2pow32.json](outputs/base-2pow32.json), [outputs/bonus-2pow32.json](outputs/bonus-2pow32.json) | Canonical 2³² enumerations (CUDA) the headline RTP is derived from; pinned in `tests/steps/enumeration.ts` (Steps 29–30) and `src/artifact-pins.ts` (Step 33) |
| [outputs/cpu-base-2pow32.json](outputs/cpu-base-2pow32.json), [outputs/cpu-bonus-2pow32.json](outputs/cpu-bonus-2pow32.json) | Independent CPU 2³² enumerations (Layer 2), used by the parity check |
| [outputs/bonus-2pow32-uncapped.json](outputs/bonus-2pow32-uncapped.json) | Bonus 2³² with the per-spin 5000× cap removed (cap-impact analysis; per-spin RTP 12.153376, max 8232.8×) |
| `outputs/bonus-session-ev-exact{,-8,-10,-12,-14}.json` | Exact dense-lane-convolution session EV per initial-spin count (97.5997×, 121.9996×, 146.3995×, 170.7994×); pinned (Steps 31 and 33) |
| [outputs/bonus-session-ev.json](outputs/bonus-session-ev.json) | Legacy 10M-session Monte Carlo (122.08× ± 0.058× SE), retained for reference |
| [outputs/rtp-claim-table.json](outputs/rtp-claim-table.json) | The paid spin against the flat 100% claim; RTP-CLAIM 1.2.0, scored on Step 32 |
| [RELEASE-MANIFEST.json](RELEASE-MANIFEST.json) | Release identity, artifact hashes, recorded score and mutation-run record |

Canonical hashes of the enumeration and session-EV artifacts (`npm test` verifies them; any divergence from a freshly enumerated artifact is a hard fail):

```
base-2pow32.json                 sha256: 0b890eef7153fcdf14c69d8559de8d3f50af558e5464974627db2103ee22d5a1
bonus-2pow32.json                sha256: e878256256cf59edb458d6ec0f5b1cc5ea6e2d45764636676362345d4cdfdb14
bonus-session-ev.json            sha256: 3825f47da8873725071dae171df82462e395669454180303ef04258ce3692125
cpu-base-2pow32.json             sha256: 2007a70eef5e6f6ebb23eb50eb1df0e7967a41b308fd7f49f330e6b7f3758ab7
cpu-bonus-2pow32.json            sha256: 7f4b0f588723e48b8552e1dd240f1045a4df5144e4193736f3100faae8f8b086
bonus-session-ev-exact-8.json    sha256: 15a11d74e7fc10e4426bb013e4d5e1f9204e2620cf5307f51ba8f7c01b4945e2
bonus-session-ev-exact-10.json   sha256: a03b4e024b1182ad62e64739e47069b2a4d302430f9153a9d1f26d8104072257
bonus-session-ev-exact-12.json   sha256: 334e55e3183065cd0e3a0e5157f11d8d37e5f1ad435e8d4d91083028c8905fda
bonus-session-ev-exact-14.json   sha256: 79236fe8facf3b6ab33238a51a121f333f80bb38e0ec9361a5585fd81bc97461
```

Reference implementation: `src/rng.ts` (HMAC + PCG32 + grid, rebuilt from the written specification `docs/ALGORITHM.md`), `src/bias.ts` (the Step 5 draw-bias bound, measured from `src/rng.ts`'s acceptance rule), `src/cluster.ts` ("anywhere" cluster with wild substitution), `src/tumble.ts` (cascade replay), `src/paytable.ts` ((symbol, cluster_size) → multiplier), `src/simulate.ts` (Monte Carlo and the Step 16 anti-circularity loop; it uses the same `Pcg32` class as verification), `src/theoretical.ts` (a standalone theoretical-RTP reference, not used by the audit pipeline), `src/stats.ts`, `src/loader.ts` (hash guard, population of record, seed map), `src/artifact-pins.ts` + `tests/steps/artifacts.ts` (Step 33), `src/diff.ts` (the reproduction-gate diff), `src/enumerate-mt.ts`, `src/session-ev-exact.ts` and `cuda/` (the enumerations). The working notes are gitignored and do not ship.

## Limitations and trust

The verdict rests on direct cryptographic checks (the seed chain, per-spin RNG output, per-payline payout and paytable lookup, the cluster, wild, cascade and bonus rules, Zero Edge consistency), on statistical agreement (captured RTP within 1σ of the simulated reference, z = +0.91σ) and on structural checks (the scaling-edge schedule, not exercised at any bracket, the per-reel chi-squared). The player does **not** need to trust the operator that any captured spin's grid (Step 5), payout (Step 7) or paytable lookup (Step 8) is what the operator says, or that the seed chain is intact (Steps 1, 2).

### Declared limitations register

| ID | Limitation | Magnitude (measured) | Where it is enforced or disclosed |
|----|------------|----------------------|-----------------------------------|
| DL-1 | Capture-retry nonce artefacts | 4 rounds not captured (epoch `d6bebb43…` nonce 47, `22f48a0f…` 2, `77544e55…` 22, `3052a819…` 9) and 4 bets whose recorded nonce is one below the nonce they were served at (spin ids 1965523, 1974625, 1976463, 1987633) | Step 4 — gaps bound by identity (`EXPECTED_NONCE_GAPS`), capture-origin FLAG; Step 5 proves each nonce correction (`CAPTURE_NONCE_CORRECTIONS`). Corrected 26 Sep 2026 (three gaps) and 4 Oct 2026 (the `22f48a0f…` gap): each had been named one nonce too high |
| DL-2 | Auditor client seeds are not from a CSPRNG | phases A, B, C, E: `'pf_'` + 13 characters from `Math.random()` (`capture/capture.reference.js:260`); Phase D: the fixed, predictable strings `pfaudit_groomers_seed00` … `09` (`capture/capture.reference.js:263`), 500 bets | Disclosed here; the CSPRNG requirement is newer than the May 2026 capture |
| DL-3 | The bonus-buy spin grid is operator-canned | 20 buys; their 10-spin sessions are provably fair | R-BUY-FIRSTSPIN (below); Steps 24–25 |
| DL-4 | Scaling edge not exercised at any bracket | every captured entry (6,225 / 6,225) has `edge_multiplier = 1` (Zero Edge); no edge was applied to any captured bet, so every without-Zero-Edge figure is analytical | Step 10; R-BRACKET-EMPIRICAL |
| DL-5 | Money fields in two units | Each credit is reported in USD (`amount_won`, `total_win_currency`; the paylines are USD amounts) and in the account's coins (`amount_won_coins`, `total_win`). The coins amount is the USD amount converted at the bet's own coins/USD rate (`bet_amount / bet_amount_currency`, the trigger's rate for a free spin) and rounded to 2 dp: 6,225 / 6,225 bets, 2,619 of them with a win converted at a rate other than 1. A $50.00 stake recorded as 49.9915 coins gives a $50 win as 49.99 coins (spin ids 1987702, 1987704) and a $35 win as 34.99 (1987715) | Step 7 — the paylines reconciled exactly against `amount_won` (USD), the coins field checked against the conversion rule, each unit's two credit fields compared with each other; no exceptions |
| DL-6 | Run metadata in the enumeration artifacts | the five 2³² enumeration files carry `elapsed_sec` | Pinned as they are (Steps 29–30, 33); not stripped because they are produced by the CUDA/CPU enumerators and pinned twice |
| DL-7 | Statistical passes partly read, not re-derived | Pass 1 symbol counts and payout series, and Pass 2 per-nonce win counts, do not ship; the stake-variation phase has 30 bets | Steps 9, 16–18 |
| DL-8 | Not tested | multiple accounts (R-MULTI); seed rotation during an open bonus session (S5-5). (The max-win cap on served payouts, listed here until 26 Sep 2026, is now asserted by Step 34: 0 of 6,225 rounds and 0 of 53 sessions above 5,000×; the largest served is 630× per spin and 647.1× per session, so the cap itself was never reached in the capture) | S5 matrix under [Verification results](#verification-results); R-MULTI (below) |
| DL-9 | The anti-circularity comparison cannot detect every wrong trigger rule | Step 16's negative control rejects a trigger threshold of 4 scatters (max z 1,233) and a spins-per-scatter table shifted one tier up (max z 47.8), but NOT a table shifted one tier down for 4+ scatters only (max z 4.35 < 5): those triggers are a small share of all triggers and 132,222 simulated sessions cannot separate the change at 5σ | Step 16 data block (`negativeControls`, the third entry is a reported power probe, not a required control). The exact 2³² enumeration + convolution, not the Monte Carlo, is what the headline RTP rests on (Step 32) |

### Load-bearing premises

| ID | Premise | Could the captured data contradict it? | Status |
|----|---------|----------------------------------------|--------|
| P1 | The capture records what Duel served | Only in part: a forged grid would still have to recompute from a seed that hashes to its commitment. The timing of every commitment (shown before its bets) rests on this premise: the capture's pre-bet snapshot and the rotation records' commitment fields and timestamps (Step 3) carry it (the plaintext `serverSeed` on 116 of the 117 rotation records was attached at export from a later reveal), while the hash and link checks (Steps 1, 2) establish consistency, not timing | ASSUMED (browser-session capture) |
| P2 | Duel derives every grid and cascade with the algorithm in `src/rng.ts` | Yes — 6,205/6,205 initial grids and 4,323/4,323 cascades recompute (Steps 5, 28) | Witnessed for captured spins |
| P3 | The weights and paytables under `data/raw/` are the ones the live game uses | Yes — every recomputed grid uses those weights and every payline matches that paytable | Witnessed for captured spins (files pinned, Step 14) |
| P4 | The exhaustive enumeration covers every outcome | Yes — a round is a deterministic function of the 32-bit outcome index | Witnessed by construction (Steps 29–32) |
| P5 | Nonces start at 0 in every epoch | Yes — Step 4 | Witnessed |

### Bounded-trust items

| R-ID | Severity | Status / mitigation | What would close it |
|---|:---:|---|---|
| R-BUY-FIRSTSPIN | Low (operator-disclosed) | Cosmetic; no payout dependency on the grid | Operator-side: extend `/verify` to the buy spin and derive its grid from the seed chain |
| R-BRACKET-EMPIRICAL | Low (sample coverage) | Schedule structurally validated (monotonic boundaries and edges, no gaps, recomputes from `min_bet`/`max_bet`/`house_edge`) | A follow-up run from a non-Zero-Edge account across the bracket range |
| R-CASCADE-RNG | **CLOSED** | Step 28: 4,323 / 4,323 byte-exact | n/a |
| R-MULTI | Low (sample coverage) | Not tested; single account | Parallel capture from several accounts with matched seed/nonce ranges |
| R-CHERRY-PICK | Low (statistically not detected) | Step 18: aggregate z = +0.91σ; forward replay 4 / 115 flags, p = 0.83 | Engine-side: a drand-style external entropy model |

**R-BUY-FIRSTSPIN.** The buy spin's display grid is server-chosen and `/verify` returns reproduction data only for the 10 free spins. It does not affect fairness: the operator discloses it in the help panel; the buy's payout is structurally fixed (scatter pay 3× for 4 scatters plus 10 free spins), and the non-scatter cells of the cosmetic grid enter no payout calculation; and the 203 free-spin records from the 20 buys (200 standard + 3 retrigger spins) reproduce 30/30 cells (Step 5). The player still trusts that the canned spin pays the 4-scatter award; all 20 captured buys did.

**R-BRACKET-EMPIRICAL.** The account has Zero Edge, so no edge was applied to any captured bet and the 300-bracket scaling-edge schedule of config v1.4 (116 base + 184 bonus) is verified analytically only, at any bracket. Every without-Zero-Edge figure is therefore analytical: a bracket-1 player without Zero Edge would see `0.9999 × 99.972% ≈ 99.962%` by calculation from the schedule; no captured bet shows it. The player still trusts that every bracket, bracket 1 included, applies the published edge.

**R-MULTI.** Single-account audit: differential treatment between players (for example different RTP for high- and low-volume players) is structurally undetectable from one account.

**R-CHERRY-PICK and the entropy model.** The entropy model is server seed + client seed: commit-reveal without external entropy, the same model as Plinko, Dice, Mines, Keno, Blackjack and Beef on Duel.com, not the drand-based model of Crash. The server seed is operator-generated; the capture recorded each epoch's commitment before the epoch's bets (Step 3) and, for every epoch after the first, as the previous rotation's next hash (Step 2). That timing rests on the capture record (premise P1); the hash and link checks establish consistency. The client seed is player-chosen, replacing the operator-generated default (Phase D); the nonce is an account-global counter, contiguous within each epoch except the 4 capture-retry gaps (Step 4). This is a Tier B game: a commitment recorded before the bets rules out substituting the seed afterwards, but the operator could still pre-evaluate candidate seeds and commit one biased toward bad-luck windows. A per-seed test at n=50 is too noisy (standard error per seed ≈ 18%), so Step 18 uses the aggregate z-test and the 10,000-nonce forward replay; the replay closes the gap the aggregate test leaves, since the aggregate sees only the captured window. It is structurally weaker than the slot-distribution test used for Plinko, where per-slot probabilities are exact-binomial. No cherry-pick evidence was found in this dataset; ruling it out structurally would need a Tier A (drand-style) entropy model.

**Outside the scope.** The audit relies on the captured API responses being authentic copies of what the operator served; TLS authenticity is not independently verified, and if the operator served the auditor different responses than other players, this audit would not detect it (premise P1). The operator's internal payout funding is not examined; this is a player-facing outcomes audit. The findings apply to config version 1.4.

## Terms

**Cluster pays anywhere:** a cluster of size N for symbol S is N cells of S plus wilds anywhere on the grid, not a connected group. **`outcome_index`:** the first 4 bytes, big-endian, of `HMAC-SHA256(hex_decode(serverSeed), bytesToHex(clientSeed) + ":" + nonce)`. **`tumble_seed`:** `deriveTumbleSeed(outcome_index, round_index, tumble_index)`, the seed of each cascade level's fresh PCG32. **PCG32:** the PCG-XSH-RR 64/32 PRNG. **`bomb_multiplier`:** the sum of multiplier values landed during a free spin, applied once to that spin's total cluster pay. **`_verify_session.is_bonus_buy`:** the operator's flag marking the cosmetic buy spin as non-PF. **Zero Edge:** Duel.com account flag; with it active, every captured bet returned `edge_multiplier = "1"` ($0.20–$50 spins, $0.20 buys and free spins). **Scaling edge:** the two operator schedules for non-Zero-Edge accounts. **Capture-retry artefact:** an epoch with one nonce consumed by the server whose response the capture lost. **Anti-circularity:** recomputing RTP from published weights, never operator-supplied probabilities. **Pass 1 / Pass 2:** the pinned-seed reference simulation, and the test of captured RTP against it. **Base game / bonus game:** spins outside a bonus session (`base_game` weights) and free spins inside one (`bonus_game` weights, including the multiplier symbol). **Tier A / B / C entropy:** a future-revealed external beacon / standard commit-reveal / server-only RNG. **RTP:** expected or observed return divided by stake; theoretical here unless labelled observed.

## Release history

| Release | What changed | Verdict |
|---------|--------------|---------|
| `v1.0.0` | The original audit. | PROVABLY FAIR — Full Pass |
| `v1.1.0` | Re-certification under Framework 1.1, October 2026, below. The dataset of record is unchanged. | unchanged |
| `v1.2.0` | The RNG rebuilt from a written specification instead of ported from Duel's code; Duel's code kept as a second check. Below, "21 October 2026" and "20 October 2026". | unchanged |
| `v1.2.1` | Errata: adds `.gitattributes` (`* -text`) so a Windows git clone keeps every file byte-identical; no audit content changed. | unchanged |

### 21 October 2026 — final QA corrections (v1.2.0)

No code path, scored step status, figure or verdict changed. The dataset and every pinned artifact are unchanged.

- **Verify a bet, step 5** said `src/rng.ts` cites the 14 lines of Duel's Verify-tab code it ports. The citation table was removed on 20 October; the step now says the module implements exactly this and is rebuilt from `docs/ALGORITHM.md`.
- **E03's role.** [RNG](#rng) (Cascades) and the Evidence table called the operator's written answers (E03) the source of the cascade algorithm Step 28 replays. That was the package's statement through v1.1.0. The specification `src/rng.ts` is rebuilt from does not use E03; both places now say so in the past tense and name where the specification takes the cascade from.
- **Specification, open point O5.** `docs/ALGORITHM.md` said the four recorded-nonce corrections close the nonce gaps, so the nonce sequence has no gap. They move each gap down by one: after them one served nonce per affected epoch is still not captured (47, 2, 22 and 9; Step 4). The framework's specification was corrected (commit `cae1782`, which changes only O5 and the matching line of §2.6) and copied in again with the same neutral wording as before in place of browser-tool names and one local path; the rebuild was written from `ef7fa03` and nothing it reads changed.
- **Dataset and capture.** The section said the runnable capture script and the smoke test ship beside the reference record. They do not: the runnable capture tools place bets on duel.com and stay in ProvablyFair.org's private workshop. The section now lists the one capture file that ships, `capture/capture.reference.js`, scopes what is said about the two tools as not checkable from the package, and points the export explanation at what the package shows. The dataset's size read 24 MB gzipped and 334 MB raw; the shipped file is 9.5 MB gzipped (9,544,283 bytes) and 72.9 MB raw (72,856,521 bytes). Its SHA-256 is unchanged.
- **Version labels.** The header, the README, `package.json`, `package-lock.json` and the release manifest named `v1.2.0-draft` / `1.1.0` and called v1.2.0 "unreleased"; they now name `v1.2.0`. The 19 October entry's "both now say so" is put in the past tense.
- **Release wording.** At tagging, the README, this overview and the release manifest stopped describing `v1.2.0` as a draft until tagged. The release manifest records `v1.2.0`, superseding `v1.1.0`, and the fingerprint of the ProvablyFair.org signing key (`signature`, `SHA256:gEujiJm2pRyq7lQsfYQfQ1r97H/J7GdaKHbOW8GtikY`), as tagged `v1.2.0`; it was refreshed with `npm run release-manifest`. No check, figure or verdict changed.

### 20 October 2026 — RNG rebuilt from a written specification (v1.2.0)

The verdict, the score (34 PASS, 1 capture-origin FLAG, 0 hard fails) and the dataset are unchanged. Through v1.1.0, `src/rng.ts` was ported from Duel's published Verify-tab code (E04). A port can copy the casino's own mistake into the check of it, so the RNG is now rebuilt from a written specification instead.

- **Specification.** [`docs/ALGORITHM.md`](docs/ALGORITHM.md), a copy of the ProvablyFair.org framework's `games/groomers-van/ALGORITHM.md` (commit `cae1782`; the rebuild was written from commit `ef7fa03`, and `cae1782` changes only the text of open point O5 and one line of §2.6: after the four nonce corrections one served nonce per affected epoch, 47, 2, 22 and 9, is still not captured, as Step 4 flags, and free spins do not consume a nonce). Its grid, weights, fill order, multiplier values, clusters, tumbles and payouts come from Duel's public pages, its public config and rules endpoints, its Verify form used as a black box and the captured data. No public page describes the per-spin seed step (seeds → `outcome_index`; `outcome_index`, round and tumble → PCG32 state; the discard rule of each draw), so, by the client's ruling of 20 October 2026, that step was written from Duel's Verify-tab code, in the specification's own words; its Provenance section says so and marks each such step (§2.2, §2.4a, §2.4b). The second-pass generator description in its §2.4 is marked as superseded by §2.4a and §2.4b and kept for the record.
- **Rebuild.** `src/rng.ts` was written by an implementer who read only that specification and an interface file and never opened Duel's code or the earlier `src/rng.ts`. Its body is that implementer's file byte for byte; only a provenance header was added. Its self-test is now a unit test, `tests/groomers-van/RngSpecTests.ts` (166/166), so mocha reports 21 passing.
- **Duel's code is a second check, not the source.** Step 5 and the 19th unit test still run Duel's Verify-tab file byte for byte: outcome index and grid 6,205 / 6,205, initial-grid multiplier values 335 / 335. The 14-line citation table of the port (`OPERATOR_SOURCE_CITES`) and its check `checkOperatorCites` are removed; mutation M05g, which moved a citation, is retired and the registry holds 51 entries.
- **Draw-bias bound.** `drawBiasBound`, our audit code rather than Duel's, moved from `src/rng.ts` to `src/bias.ts` and is built on the rebuilt module's `acceptedDraw`, the rule its draws run; Step 5's result is unchanged (all 13 windows a whole number of totals, worst bias 0). M05e now widens the rebuilt module's acceptance limit and is still killed.
- **Three-way agreement (measured on integration).** Over the four redacted datasets of the workshop (6,250 records, 6,228 spins and free spins, 10,573 rounds): the rebuilt module reproduces every round's 30 cells and every multiplier value of the live rounds (10,573 / 10,573; 317,190 cells, 945 values), the served `outcome_index` 623 / 623 and every commitment 6,250 / 6,250; Duel's Verify-tab code gives the same outcome index, fresh grid and multiplier values on 10,573 / 10,573 rounds; the ProvablyFair.org docs-site verifier copy in `verifier-parity/` agrees on 10,573 / 10,573. The four recorded-nonce corrections (spins 1965523, 1974625, 1976463, 1987633: each reproduces only at the recorded nonce + 1) are the capture's labelling issue, already declared by spin id in `src/loader.ts` and disclosed under Step 4 as capture-origin, not an operator finding. The live page www.provablyfair.org/verify-bets is not in this package and was not run.
- **Artifacts.** `npm run simulate` reproduced `outputs/simulation-results.json` and `outputs/rtp-convergence.html` byte for byte, so nothing was re-pinned. The 2³² enumeration and session-EV artifacts were not regenerated: they were made with the v1.1.0 module, and the rebuilt module returns the same grid, multiplier values and final PCG32 state on 1,000,000 random (outcome index, round, tumble) inputs (measured on integration). `outputs/verification-results.json` was regenerated with `PF_EMIT=1 npm run verify` (the Step 5 detail and data and the GROOMERS-08/09 notes changed; no status or figure), and the release manifest written by `npm run release-manifest` as `v1.2.0-draft`, unsigned. `npm run mutate`, the whole registry in one run: 51/51 killed, 35/35 scored steps covered.

### v1.1.0 — what changed

- **Scored steps: 33 in v1.0.0, 35 now.** The verdict is unchanged, PROVABLY FAIR — Full Pass. The dataset of record is byte-identical to v1.0.0. New: Max-Win Cap & Payout Bounds and Live-Sample Fit (informational).
- **Step 4 (Nonce Audit) is now a capture-origin FLAG.** It reports the same 4 capture-retry epochs as v1.0.0, with the missing nonces corrected to 47, 2, 22 and 9; the seed is revealed and the missing nonce unused at each. A capture-origin FLAG is disclosed and does not move the verdict; the step passed in v1.0.0.
- **RTP claim table, scored.** `outputs/rtp-claim-table.json` scores the paid spin (base game and triggered bonus) against a flat 100% claim ("rtp": "100.0000" in Duel's game settings, the game config v1.4); under RTP-CLAIM 1.2.0, switched on, the outcome is scored on Step 32. Outcome: pass (true minimum 99.972000%, true maximum 99.972000%).
- **Errata (2026-09-29):** the RTP convergence chart (`outputs/rtp-convergence.html`) loaded Chart.js 4.4.7 from cdn.jsdelivr.net, so a pinned artifact depended on a third-party host. The same version is now inlined, byte for byte from the npm package pinned in package-lock.json. Every figure and data point in the chart is unchanged.
- **Steps 5, 7 and 26.** Step 5 reproduces every base spin at one nonce, with four recorded-nonce corrections declared by spin id, checks every base spin's verify-payload nonce and every free spin's nonce and round_index against the published free-spin rule, and runs Duel's own Verify-tab code on every recomputable entry, scoring its outcome index, grid and initial-grid multiplier values; a 20th unit test holds two captured free-spin vectors. Step 7 reconciles the paylines exactly in integer cents against `amount_won`, the USD credit, and checks the coins field against each bet's coins/USD rate; Step 26 reconciles free spins against `amount_won`. [Verify a bet](#verify-a-bet) gives the player's path for base and free spins.
- **Commitment timing and stake units (5 Oct 2026).** The Step 2 detail, the S5-1 row, premise P1, the entropy-model paragraph and [Verify a bet](#verify-a-bet) now describe hash and link equality as consistency checks; the timing of each commitment rests on the capture's pre-bet records, conditional on capture integrity (P1), and a player saves the commitment before betting. Verify a bet step 2 now takes the USD stake `bet_amount_currency`, not the coins stake `bet_amount`, to compare with the USD credit. No step status, figure or verdict changed.
- **Scaling edge at any bracket (6 Oct 2026).** The README scope paragraph, the conclusion, the rule-coverage line and row, the limitations summary, DL-4, R-BRACKET-EMPIRICAL and the Step 10 detail string said scaling-edge brackets above bracket 1 were verified analytically only; all 6,225 captured bets have `edge_multiplier = 1`, so no edge was applied to any captured bet, and they now say the scaling edge at any bracket was verified analytically only, with every without-Zero-Edge figure, 99.962% at $0.20 included, marked analytical. `outputs/verification-results.json` and `RELEASE-MANIFEST.json` were re-emitted by the package's own commands; no step status, figure or verdict changed.
- **Seed records, the 50-bet epoch and the Zero Edge scope (6 October 2026).** [Dataset and capture](#dataset-and-capture) said the capture stored every response "without modification", and the Step 1 detail string said the seeds were verified "against the raw seed records". Both now say that the plaintext `serverSeed` on 116 seed records and the `verifyData` block on 643 bets were attached at export by the capture script's save step, which is not in the capture reference, from post-rotation `/verify` responses; premise P1 and [Verify a bet](#verify-a-bet) now rest the timing on the rotation records' commitment fields and timestamps, not on those plaintexts. The population of record, the Step 12 row and detail string, the Step 4 profile note and the rule coverage called the 50-bet epoch a platform cap; it is the capture's rotation schedule, the rule-coverage row is now the commit-reveal chain alone, and the count of directly verified rules is 23, not 24. The README scope paragraph, the conclusion, the Zero Edge section and Terms said Zero Edge returns `edge_multiplier = "1"` on every spin regardless of mode or stake; they are now scoped to the captured stakes ($0.20–$50 spins, $0.20 buys), and the bracket lookup is described as the audit's reading of the config. Source comments in `src/loader.ts`, `src/types.ts` and `tests/steps/` follow. The dataset is unchanged; `outputs/verification-results.json` and `RELEASE-MANIFEST.json` were re-emitted by the package's own commands, and no step status, score or verdict changed.
- **Minimum cluster size and the redaction note (6 October 2026).** [Game and algorithm](#game-and-algorithm) and the rule-coverage row now say that `/rules` gives `min_cluster_size` as 4 in its `rules` block and 8 in `game.mechanics`; the redaction paragraph gives the current result as 34/35 PASS + 1 capture-origin FLAG. No step status, score or verdict changed.
- **Added:** `LICENSE` (MIT), `.nvmrc` (Node 22), `RELEASE-MANIFEST.json` (written by `scripts/release-manifest.mjs`), the mutation battery (`npm run mutate`, `tests/mutations.json`) and the duel.com config as fetched 2026-10-05 in a logged-in session (read-only GET): the `/api/v2/slots` and `/rules` bodies under `data/raw/`, identical to config v1.4 and the pinned `/rules` paytable, and pinned by Step 14 ([Dataset and capture](#dataset-and-capture)). The documentation is README.md and this MANIFEST.md, as in v1.0.0 (see the consolidation below).

Earlier corrections recorded in the package: the pre-publish redaction of 2026-06-10 ([Dataset and capture](#dataset-and-capture)); the 26 September 2026 nonce-gap correction, exact-cent payout reconciliation and timestamp removal from `verification-results.json`; Steps 34–35 and the 19th unit test (26 September 2026).

### 19 October 2026 — v1.1 review corrections

No draw check, scored step status or verdict changed. The dataset and the enumeration and session-EV artifacts are unchanged.

- **RNG code provenance.** [RNG](#rng) and the `src/rng.ts` header said the RNG code was an independent re-implementation. It was a port of Duel's published Verify-tab code, and on 19 October both were changed to say so. Since v1.2.0 (20 October, above) `src/rng.ts` is rebuilt from `docs/ALGORITHM.md` and both say that instead.
- **Convergence chart.** `outputs/rtp-convergence.html` drew the operator's 100% claim as its "Theoretical" line. The line is now the exact 2³² figure, 99.9720% (Step 32's derivation), and the claim is named beside it. The chart was regenerated with `PF_EMIT=1 npm run simulate` and re-pinned in `src/artifact-pins.ts`; `outputs/simulation-results.json` came back byte-identical.
- **Step 10** counted 8 distinct stakes: the 20 bonus buys record $0.20 as `"0.2"`, every other $0.20 bet as `"0.200000000000000000"`. It now counts by value: 7.
- **Text.** The runnable capture script and the smoke test were described in [Dataset and capture](#dataset-and-capture) (since 21 October that section says they stay in the private workshop and do not ship); the 5 October Verify-page check is no longer cited as an exhibit E05, which the package never held; the free spin 1966450 example puts its multiplier on the opening grid, where the data has it; the uncapped headline is at most 99.9725% (Step 34's bound), not ~99.975%; the CPU and CUDA enumerations agree to 6 decimal places, not 7; the profile notes for GROOMERS-19 (Step 32, rewritten on 14 October) and GROOMERS-23 (10 package attack categories, not 13) were brought up to date. `outputs/verification-results.json` and `RELEASE-MANIFEST.json` were re-emitted by the package's own commands.

### 4 October 2026 — consolidated documentation

The 23 Markdown documents were reduced to **README.md and this MANIFEST.md**. Repeated explanations, superseded examples and the comparison with other Duel games were removed; the dataset, operator files, evidence, enumeration artifacts, algorithm and settlement logic were retained. Documentation references in the profile-coverage map (`src/profile-map.ts`), the Step 10 detail string (`tests/steps/dataset.ts`) and source comments now point to the retained sections; the verification results and the release manifest were regenerated by the package's own commands, with no change to any step status, figure or verdict. No new casino capture, enumeration, simulation regeneration or mutation campaign is asserted for this update.

### 14 October 2026 (second pass) — an RTP miss ends RTP FIGURE OVERSTATED (FIXPASS2 class C3)

No verdict, scored step status or figure changed. `outputs/verification-results.json` was re-emitted; Step 32's detail line and data block changed.

- **Step 32 no longer pre-empts the rule.** It held the derived total to the 100 % claim itself: PASS within 0.1 pp, an operator FLAG (exit 2) within 1 pp, FAIL (exit 1) beyond. It now scores the derivation only: the base RTP must equal the base artifact's own sum / count (relative 1e-12) and its histogram's mean (within 1e-6; measured gap 1.9e-9); the derived total is the RTP table's one row, held to the claim by RTP-CLAIM on Step 32. The hand copy of the claim (`OPERATOR_RTP = 1.0`) is gone. M32 (base RTP forged and re-pinned) is killed by the new recompute.
- **Exit-5 mutations.** `scripts/mutate.mjs` gained `regen` (in the disposable copy: the RTP table rewritten by `src/rtp-settings.ts` and re-pinned, then the committed record re-emitted with `PF_EMIT=1`), `expectExit` (an entry counts as killed only when the run also ends with that exit code) and runner `test` (mocha, then the verifier, as `npm test` runs them). New entries: MC3a (the 5-scatter free-spin award lowered 12 → 8 in the map the derived RTP reads: 99.884020 %, 0.116 pp under the 100 % claim) and MC3b (the claim raised to 100.2 %), each with the table and record regenerated and expected to end RTP FIGURE OVERSTATED, exit 5. MC3as and MC3bs make the same changes without regenerating the table and are expected to end exit 1: a committed RTP table that differs from the run, or from its pin, is a reproduction failure, miss or no miss.
- **Battery (Apple M2 Max, 12 cores, Node v22.23.1).** The whole registry (52 entries) in one `npm run mutate` on this tree, 14 October 2026 evening (baseline green): 52/52 killed, 35/35 scored steps covered. On 15 October `--only` (now taking several comma-separated substrings) reran the four C3 entries and every entry naming Step 32, the RTP-claim step (M32, MC3): 5/5 killed; MC3a and MC3b ended `VERDICT: RTP FIGURE OVERSTATED`, exit 5; MC3as and MC3bs exit 1 with the committed table reported as differing from the run.

### 14 October 2026 — Methodology v1.1

No draw check, scored step status, figure or verdict changed. The dataset and the artifacts pinned in `src/artifact-pins.ts` are unchanged; the RTP-claim table, pinned in `src/rtp-settings.ts`, was rewritten and re-pinned (below).

- **Framework 1.1.** The audit is re-certified under ProvablyFair.org Framework 1.1 (decision D1); the release manifest's `framework` field and the release row above say 1.1.
- **RTP-CLAIM 1.2.0, switched on.** `src/rtp-claim.ts` is the framework's rule 1.2.0, byte-identical to `core/rtp-claim.ts` (SHA-256 `c9a9c1c4…5f131c`), and `src/rtp-claim-switch.ts` is set to true (decision D3). The outcome is scored on Step 32 (GROOMERS-19): a house-side miss would be an operator-origin FLAG on that step and the verdict RTP FIGURE OVERSTATED, exit 5, never NOT PROVABLY FAIR. The claim source now names its place, the game settings (`"rtp": "100.0000"` in the game config v1.4). Outcome: pass, as before. In `outputs/rtp-claim-table.json` only `ruleVersion` and the source wording changed.
- **Profile.** The Groomer's Van profile version this suite cites is 1.0.2 (decision D6, approved as cited; the `-proposed` suffix is dropped, no check changed). In `outputs/verification-results.json` only `profileCoverage.profileVersion` changed.
- **S5 level.** The adversarial matrix states the S5 level received: the fairness-integrity matrix; game-integrity testing was not commissioned (decision D5).
- **Exit 5** (RTP FIGURE OVERSTATED) is added to the exit codes.
- `outputs/rtp-claim-table.json` was rewritten with `npm run rtp-claim:write` and re-pinned, `outputs/verification-results.json` regenerated with `PF_EMIT=1 npm run verify`, and the release manifest refreshed with `npm run release-manifest`. The mutation battery was rerun: 48/48 killed, 35/35 scored steps covered.

### Where the former chapters went

| Former documentation | Consolidated location |
|---|---|
| `executive-summary.md`, `conclusion.md` | Conclusion and scope; README |
| `game-rules.md`, `system-architecture.md`, `rng-algorithm-analysis.md`, `bonus-game-analysis.md` | Game and algorithm; Dataset and capture |
| `game-logic-verifiability.md` | Verify a bet; Game and algorithm |
| `rule-checks.md` | Verification results (rule coverage) |
| `live-parity-testing.md` | Dataset and capture; Verification results |
| `payout-verification.md`, `rtp-analysis.md`, `ENUMERATION.md` | Payouts and RTP; Evidence |
| `simulation-methodology.md` | Payouts and RTP; Verification results |
| `exploit-testing.md`, `edge-case-analysis.md` | Verification results; Limitations and trust |
| `operator-trust-analysis.md`, `recommendations.md` | Limitations and trust |
| `reproducibility.md` | Reproduce the audit |
| `evidence.md` | Evidence |
| `glossary.md` | Terms |
| `SUMMARY.md`, README table of contents | Contents; README |
