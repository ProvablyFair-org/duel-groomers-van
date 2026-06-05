# Manifest — Duel Groomers Van Audit

- **Audit ID:** PF-2026-DL10
- **Publication date:** 4 June 2026
- **Audit report:** https://audit.provablyfair.org/casino/duel/games/groomers-van/overview
- **Auditor:** ProvablyFair.org
- **Audit dates:** April–May 2026
- **Game type:** Slot game (cluster pays, cascade tumbles, tumble-multiplier mechanics, bonus rounds)

## Algorithm

Two-layer RNG: one HMAC-SHA256 per spin produces an `outcome_index`, then a deterministic PCG32 stream seeded from that index drives the grid + cascade tumbles. The client seed is hex-encoded before going into the HMAC message, and there is no `:cursor` suffix.

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

The cluster-detection, tumble-replacement, multiplier-sampling, and bonus-trigger logic is mathematically defined by the operator's published config (`data/raw/groomers-van-config-v1.4.json`) and the paytable (`data/raw/paytable-*.json`). The verifier replays every captured spin byte-exact against this spec, and re-derives the headline game RTP from a committed 2³² exhaustive enumeration of the base + bonus condition spaces.

## Dataset

- **Master file:** `data/groomers-van-smoke-test-1778204681017.json.gz` (9.5 MB compressed / ~75 MB uncompressed)
- **Loader:** `src/loader.ts` decompresses transparently
- **Bets:** 6,225 (captured spins)
- **Operator artifacts (`data/raw/`):**
  - `groomers-van-config-v1.4.json` — operator math model
  - `paytable-extracted-from-help.json` — paytable from `#help` panel
  - `paytable-from-rules-endpoint.json` — paytable from `/api/rules`
  - `client-seed-snapshot.json` — client seed at capture

### Pre-publish redaction (2026-06-10)

The original capture included an `events[]` array of 13,525 raw API request/response records carrying ~75 distinct rotating `security_token` values across 6,342 occurrences. These tokens were session-scoped and expired since the May 8 capture (no active compromise), but a published audit repository should not ship captured authentication material. Action taken:

1. The `events[]` array in the master dataset was emptied; redaction metadata is preserved at `meta.eventsRedacted` (count + reason + date).
2. The `security_token` field in the 2 raw spin request files (`spin-1835724-request.json`, `spin-1835725-request.json`) was replaced with `[REDACTED]`.
3. `EXPECTED_HASH` in `src/loader.ts` was re-pinned to the post-redaction dataset hash.

**No verifier code path consumes `dataset.events` or the `security_token` field, so the redaction is transparent to the audit pipeline** — all 32 scored steps still PASS with the redacted dataset.

## Verification

- **Verification steps:** 32 scored steps in `tests/verify.ts`
  - Steps 1–28: dataset replay (commitment, determinism, payouts, dataset integrity, simulation cross-check, game-specific mechanics, cascade RNG byte-exact replay)
  - Steps 29–32: enumeration artifact integrity + headline RTP re-derivation
- **Unit tests:** Mocha (`tests/**/*Tests.ts`)
- **Headline game RTP:** **99.9720%** — re-derived deterministically from the committed 2³² enumeration artifacts (`outputs/base-2pow32.json`, `outputs/bonus-2pow32.json`, exact session-EV artifacts at granularities 8/10/12/14) in Step 32. Reproduces in seconds on clone — no billion-spin enumeration needed on the default path.
- **Monte Carlo cross-check:** 30M-spin simulation (`npm run simulate`) is **optional and opt-in**; if the artifact is absent, Steps 16–18 degrade to INFO and the verdict is not affected.
- **CPU↔CUDA numerical parity:** `scripts/cpu-cuda-parity.ts` documents the float32 vs float64 noise floor between the CUDA fast-path enumerator and the TS reference enumerator (exact on wins/win_rate/max_payout/scatter_histogram; |Δrtp| ≤ 1e-6; histogram mass per 1×-stake coarse bucket within Poisson noise — `|Δ| ≤ max(20, 5×√N)`).
- **Cascade RNG closure (Step 28):** byte-exact replay confirms every captured cascade matches independent recomputation.
- **Scaling edge:** documented split between base game and bonus schedule — see audit report.
- **Expected `npm test` result:** 32/32 PASS · PROVABLY FAIR — Full Pass

## Reproducibility

Cloning this repo at the publication commit and running `npm install && npm test` reproduces the 32-step verification and the **99.9720%** headline RTP in seconds against committed artifacts. The dataset hash is verified at startup; the verifier recomputes every spin byte-exact from `(serverSeed, clientSeed, nonce)` via the two-layer scheme above (one HMAC per spin → `outcome_index`; PCG32 stream driven by `deriveTumbleSeed(outcome_index, round_index, tumble_index)` for grid + cascade fills); the operator's math model is loaded from `data/raw/groomers-van-config-v1.4.json` (their published config — not derived).

For deeper reproduction of the underlying artifacts, opt-in scripts are available — see README "Reproduce" section.
