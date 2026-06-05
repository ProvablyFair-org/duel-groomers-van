# Duel Groomers Van — Verifier

Independent verifier for the ProvablyFair.org audit of **Duel.com Groomer's Van** (slot game with cluster pays, cascading tumbles, bonus features, and tumble-multiplier mechanics).

- **Audit report:** https://audit.provablyfair.org/casino/duel/games/groomers-van/overview
- **Audit ID:** PF-2026-DL10
- **Audited:** April–May 2026
- **Algorithm:** HMAC-SHA256 cluster RNG + cascading tumbles + bonus mechanics

## What's in this repo

This is the verification codebase for the Groomers Van audit. It re-derives every seed-derived spin (base + cascades + bonus free spins) from the captured dataset and the operator's published math model, and re-derives the headline game RTP from a committed 2³² exhaustive enumeration of the base + bonus condition spaces. Buy-bonus opening displays are operator-canned cosmetic setup (guaranteed 4 scatters / 10 free spins), disclosed and excluded from the provably-fair chain — see the buy-bonus section. The full audit report — methodology, evidence, findings, recommendations — lives on the docusaurus page linked above.

## Reproduce

```sh
git clone git@github.com:ProvablyFair-org/duel-groomers-van.git
cd duel-groomers-van
npm install
npm test
```

`npm test` runs mocha unit tests + 32-step verifier reading the committed artifacts. Expected: **32/32 PASS** · **PROVABLY FAIR — Full Pass** · **headline RTP 99.9720%** re-derived from the enumeration artifacts in a few seconds, with no billion-spin run on the default path.

If you want to regenerate the underlying artifacts from scratch instead of trusting the committed ones, the heavy operations are opt-in:

```sh
npm run verify              # 32-step verification of the captured dataset (default `npm test`)
npm run simulate            # ~30M-spin Monte Carlo cross-check (optional, tens of minutes)
npm run enumerate:cpu:both  # full 2³² CPU enumeration (~4.4h on a 20-thread desktop)
npm run enumerate:cuda      # full 2³² CUDA enumeration (~90s on RTX 5060; requires build)
npm run parity:base         # CPU↔CUDA numerical parity check (base condition)
npm run parity:bonus        # CPU↔CUDA numerical parity check (bonus condition)
npm run session-ev-exact:10 # exact dense-lane-convolution session-EV at 10 initial spins
```

## Dataset

- **Master file (gzipped):** `data/groomers-van-smoke-test-1778204681017.json.gz` (~24 MB compressed; the loader decompresses transparently — uncompressed JSON is ~334 MB)
- **Bets:** 6,225 in the captured dataset
- **Operator artifacts** (`data/raw/`):
  - `groomers-van-config-v1.4.json` — operator math model
  - `paytable-extracted-from-help.json` — paytable from the `#help` panel
  - `paytable-from-rules-endpoint.json` — paytable from the `/api/rules` endpoint
  - `client-seed-snapshot.json` — client seed observed at capture time
  - 4 raw spin request/response pairs — for reference

## Verification

- **Verification steps:** 32 scored steps in `tests/verify.ts` (Steps 1–28 dataset replay + Steps 29–32 enumeration-artifact integrity and headline RTP re-derivation)
- **Headline game RTP:** **99.9720%** — re-derived deterministically from the committed 2³² enumeration artifacts (`outputs/base-2pow32.json`, `outputs/bonus-2pow32.json`, plus the exact session-EV artifacts at granularities 8/10/12/14) in `tests/steps/enumeration.ts` Step 32. Anyone running `npm test` after cloning reproduces this number in seconds without re-running the 4.3-billion-spin enumeration.
- **Monte Carlo cross-check:** the `npm run simulate` script regenerates `outputs/simulation-results.json` as a 30M-spin Monte Carlo cross-check of the per-spin engine. It is optional and does NOT affect the verdict — Steps 16–18 degrade to INFO if the file is absent.
- **CPU↔CUDA numerical parity:** `scripts/cpu-cuda-parity.ts` checks the committed CUDA artifact against an independently produced CPU enumeration within a documented float32 vs float64 noise floor (exact on wins/win_rate/max_payout/scatter_histogram; |Δrtp| ≤ 1e-6; histogram mass per 1×-stake coarse bucket within Poisson noise — `|Δ| ≤ max(20, 5×√N)`).
- **Cascade RNG closure (Step 28):** byte-exact replay confirms every captured cascade matches independent recomputation via the two-layer scheme — one HMAC per spin (`HMAC-SHA256(hex_decode(serverSeed), bytesToHex(clientSeed) + ":" + nonce)` → `outcome_index`), then PCG32 seeded by `deriveTumbleSeed(outcome_index, round_index, tumble_index)` driving the rejection-sampled weighted draws for each cascade fill.
- **Expected `npm test` result:** 32/32 PASS · PROVABLY FAIR — Full Pass

## License

MIT
