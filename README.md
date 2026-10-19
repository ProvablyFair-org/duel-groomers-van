# Duel Groomer's Van — Provably Fair Audit

**Auditor:** [ProvablyFair.org](https://www.provablyfair.org) · **Audit ID:** PF-2026-DL10 · **Release:** `v1.1.0` · **Audit period:** 2026-05-04 – 2026-05-11

**Result: PROVABLY FAIR — Full Pass.** 34 of 35 scored verification steps pass against a 6,225-bet captured dataset; the 35th is one capture-origin flag (Step 4: four nonces the capture missed on a retried request, each under a revealed, commitment-checked seed; the rounds themselves were not captured; disclosed, verdict-neutral). Every recomputable initial grid (6,205 / 6,205) and every captured cascade round (4,323 / 4,323) reproduces byte-exact from the committed seeds. The cryptography, the cascade RNG, the paytable and the bonus mechanics are faithful to the operator's published config, rules and help panel.

**Scope:** Groomer's Van is a 5×6 cluster-pays slot with tumbling reels and free spins, captured from one test account against operator game config v1.4. Exhaustive 2³² enumeration of the published math model gives a **raw game RTP of 99.972%** (model RTP, ±0.02 points; see [Exact RTP](MANIFEST.md#exact-rtp-authoritative)), and a 30M Monte Carlo corroborates it at 100.06% within noise; the 0.028% gap to the operator's stated `rtp_per_condition.blended = 100.0%` is the bonus paytable's intrinsic edge. Zero Edge is a structural override (`edge_multiplier = 1` on every captured bet) under which the captured stakes ($0.20–$50 spins, $0.20 buys) pay the full math-model RTP of 99.9720%; stakes above $50 and buys above $0.20 were not captured, and account-level rakeback and promotions are out of scope. The 20 bought bonus spins are server-canned (operator-disclosed), and the scaling edge at any bracket was verified analytically only: no edge was applied to any captured bet, so every without-Zero-Edge figure is analytical.

## What was verified

| Check | Captured evidence |
|---|---|
| Commitment chain | 116 / 116 revealed seeds hash to their commitment; 116 / 116 commitment links |
| Initial grids | 6,205 / 6,205 non-buy entries reproduce 30/30 cells from (server_seed, client_seed, nonce) (Step 5) |
| Cascade RNG | 4,323 / 4,323 cascades, 129,690 / 129,690 cells, 146 / 146 multiplier values byte-exact (Step 28) |
| Payouts | 6,205 / 6,205 non-buy bets reconcile exactly in integer cents (Step 7); the coins field matches each bet's conversion rate on 6,225 / 6,225; 475 / 475 free spins (Step 26) |
| Paytable | 4,985 / 4,985 payline multipliers match the published paytable (Step 8) |
| Bonus rules | 53 / 53 triggers award the published free spins; 20 / 20 buys show 4 scatters and award 10 spins |
| Theoretical RTP | 99.9720% from the exact 2³² enumeration and exact session convolution, re-derived on every run (Step 32) |
| Observed return | 56.87% base-game RTP over 5,730 captured base spins; reported separately from theoretical RTP |
| Simulation | 30,000,000 Monte Carlo base spins (100.06% blended); Pass 2 aggregate z = +0.91σ and 4 / 115 forward-replay flags (binomial p = 0.83) |
| Player verification | ProvablyFair.org site verifier on all 5,730 base spins; Duel's own Verify-tab code, given the published weights (the multiplier weights as a 200-entry list): outcome index and grid agree on all 6,205 recomputable entries, initial-grid multiplier values on 335 / 335 |

The declared limitations DL-1 … DL-9, the bounded-trust items (bought bonus spin, scaling-edge brackets, multi-account, seed selection) and the premises are kept in the [overview's limitations](MANIFEST.md#limitations-and-trust).

## Run the audit

Open a terminal in the package directory. Use **Node 22.x**, as declared in [.nvmrc](.nvmrc) and [package.json](package.json).

```sh
npm ci
npm test
```

Expected: **mocha 20 passing; 34 PASS + 1 capture-origin FLAG; zero hard fails; PROVABLY FAIR — Full Pass; REPRODUCED; exit 0.** `npm test` replays every captured spin and cascade and re-derives the headline RTP from the committed, pinned 2³² enumeration artifacts in seconds; it does not rerun the Monte Carlo or the enumeration. The exit code is the verdict: `0` PROVABLY FAIR — Full Pass · `2` PROVABLY FAIR — Conditional Pass · `5` RTP FIGURE OVERSTATED (the RTP-CLAIM rule 1.2.0 found a published RTP figure above the game's real RTP; the draws pass) · `1` NOT PROVABLY FAIR, or a reproduction difference.

**RTP claim (RTP-CLAIM 1.2.0, switched on).** The paid spin (base game and triggered bonus) is held to the flat 100% stated in Duel's game settings (`"rtp": "100.0000"` in the Groomer's Van game config v1.4). Scored on Step 32: PASS at 99.972000%, within the 0.1 pp band ([table](outputs/rtp-claim-table.json)).

```sh
npm run test:full                 # optional: re-runs the 30M Monte Carlo as a run record (tens of minutes)
node scripts/release-manifest.mjs --check
```

Ordinary runs write only to `outputs/run/` and leave the evidence of record intact. See [reproduction details](MANIFEST.md#reproduce-the-audit) for the gate, exit codes, enumeration layers, mutation battery and the deliberate artifact-refresh procedure.

## Verify a bet

Before you bet, save the server seed hash (the commitment) Duel shows for your seed pair. After playing, rotate your seed pair to reveal the server seed and check that it hashes to the saved value: a match means hash equality, and the assurance that the seed was fixed before your bet comes from the copy you saved beforehand. Then use the [ProvablyFair.org verifier](https://www.provablyfair.org/verify-bets) or follow the [complete verification instructions](MANIFEST.md#verify-a-bet). They cover the commitment encoding, the hex-encoded client seed in the outcome index, the cascade seed and PCG32 draw, the column-major grid numbering and the pay rules.

## Files and evidence

There are two documentation files: this README and [MANIFEST.md — consolidated audit overview](MANIFEST.md). The overview contains the game rules, algorithm, RTP derivation, verification results, evidence, limitations and release history.

- [Captured dataset](data/groomers-van-smoke-test-1778204681017.json.gz) — 6,225 entries, SHA-256 of the uncompressed bytes `3034cb1284bc1a87d82a0d8f914b19d7f1a8f16894ffe601242bd29e3873b967`.
- [Operator game config v1.4](data/raw/groomers-van-config-v1.4.json) and [paytable](data/raw/paytable-from-rules-endpoint.json) — pinned with the other files under `data/raw/` (Step 14).
- [Verification results](outputs/verification-results.json), [RTP claim table](outputs/rtp-claim-table.json), [2³² base enumeration](outputs/base-2pow32.json), [simulation results](outputs/simulation-results.json) and [release manifest](RELEASE-MANIFEST.json).
- [Audit report](https://audit.provablyfair.org/casino/duel/games/groomers-van/overview) · [Public repository](https://github.com/ProvablyFair-org/duel-groomers-van) · [MIT license](LICENSE).

The operator's written answers on the cascade mechanics (evidence E03, `Groomer's Van audit questions.pdf`) are held on file by ProvablyFair.org in its private audit workspace, outside this package; the file is not in this package and is not published. Its SHA-256 is recorded under E03 in [MANIFEST.md](MANIFEST.md#evidence). The release's changes and the documentation consolidation are recorded in the [release history](MANIFEST.md#release-history).
