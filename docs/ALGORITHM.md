# Duel.com Groomer's Van: clean-room algorithm specification

Written 20 Oct 2026 for the ProvablyFair.org audit of Duel.com Groomer's Van.

## 0. Provenance

| Steps | Came from |
|---|---|
| Inputs (server seed, client seed, nonce), commitment = SHA-256 of the revealed seed, "fair result = server seed + client seed + nonce", new cells filled "from matching positions in the new grid" | Duel's public pages (provably-fair Overview and Verify "How it works", read 20 Oct 2026), §1, §2.4 |
| HMAC-SHA256 as the keyed function, SHA-256 commitment, PCG32 XSH-RR output function | Standard constructions |
| Grid geometry, generated positions, per-reel weight tables, multiplier value weights, clusters, removal, gravity, paytable, scatters, free spins, totals, money, round index of free spins, commitment encoding | Public config and rules endpoints + the captured data (§2.1, §2.4 tables, §2.6, §3) |
| Generator shape (one PCG32 stream per round and tumble, column-major fresh grid, then one draw per multiplier cell) | Duel's public Verify form used as a black box (§2.5), checked on the data |
| **seeds → `outcome_index` (§2.2), `outcome_index` + round + tumble → 32-bit tumble seed, tumble seed → PCG32 state and increment (§2.4a), and the exact draw rule (rejection, §2.4b)** | **Duel's Verify-tab code (captured 2026-05-19), used for these steps only, by the client's ruling of 20 Oct 2026 (13:30) that the one step no public page describes may be written from Duel's Verify-tab code if the page says so.** Every other step was written without that code. Each such step is marked SOURCE: VERIFY-TAB CODE. |

Every step was then checked end to end against all 6,228 spins and free spins in the
data (§7, third pass): **6,228 / 6,228** reproduced from the seeds alone.

The first two passes were written without opening any Duel source code, any port of
it, any copy of Duel's in-site verifier code, the package's `cuda/`, `src/`, `tests/`,
`scripts/`, `capture/`, `verifier-parity/` or `evidence/verify-tab/`, or the
package's `MANIFEST.md` / `README.md`. The third pass opened exactly one Duel code
file, `evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json`
(see §8 for every file and URL opened).

**Status, read this first (updated 20 Oct 2026, third pass).** The spec is complete:
server seed + client seed + nonce → `outcome_index` (§2.2) → one 32-bit tumble seed
per (round, tumble) → PCG32 state (§2.4a) → fresh grid and multiplier values with
rejection sampling (§2.4, §2.4b) → tumbles, wins, totals and money (§3). O1, O2 and O8
are closed; O5 is explained (§6).

- server seed + client seed + nonce → the 32-bit `outcome_index`: specified (§2.2, VERIFY-TAB CODE);
- (`outcome_index`, round, tumble) → PCG32 state: specified (§2.4a, VERIFY-TAB CODE);
- PCG32 state → grid symbols and multiplier values: specified (§2.4, §2.4b).

Every step names where it came from:

- **PAGE**: Duel's public pages, quoted with location and date.
- **CONFIG**: Duel's public game config and rules endpoints, captured as
  `pf-duel-workspace/games/groomers-van/data/raw/groomers-van-config-v1.4.json`
  (captured 4 May 2026, `updated_at` 2026-04-03, `active_version` 1.4, the config
  live before the bets) and `raw/paytable-from-rules-endpoint.json`
  (`GET /api/v2/slots/groomers-van/rules`). The `/api/v2/slots` capture of
  5 Oct 2026 (`raw/slots-2026-10-05.json`) carries identical `weights`,
  `features`, `mechanics` and `scaling_edge`.
- **HELP**: the in-game rules panel, captured 2026-05-06 as DOM text
  (`raw/paytable-extracted-from-help.json`).
- **STANDARD**: the standard provably-fair construction.
- **DATA**: fixed by testing candidates against the captured rounds: 6,250 spin
  records in the four datasets (6,225 in `groomers-van-smoke-test-1778204681017.json.gz`,
  captured 7–8 May 2026, plus 3 + 9 + 13 in the three smoke files), 10,595 rounds
  (initial drops and tumbles). 623 records also carry Duel's verify-endpoint output
  (`verifyData`, from `GET /api/v2/slots/spins/{id}/verify`), which states the
  `outcome_index` and a per-tumble `tumble_hash_hex`. Those are the operator's
  **claims** about intermediate values, used here to pin down structure, never as
  inputs to the derivation.
- **PROFILE**: `_workspace/pf-audit-framework/games/groomers-van/profile.json`
  (our own framework profile, not an operator source).
- **VERIFY-TAB CODE**: Duel's Verify-tab code (captured 2026-05-19), used for this
  step only by the client's ruling of 20 Oct 2026; disclosed. Read from
  `pf-duel-workspace/games/groomers-van/evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json`.
  Restated here in our own words; no code was copied.

---

## 1. Inputs and commitment

### 1.1 Inputs

| Input | Form | Source |
|---|---|---|
| `serverSeed` | 64 lowercase hex characters (32 bytes) | PAGE: "Server seed - a random string provided by us" (duel.com/provably-fair, Overview, rendered 20 Oct 2026). Form: DATA (all 121 revealed seeds are 64 hex) |
| `clientSeed` | text | PAGE: "Client seed - a random string provided by you". The site's default generator draws 16 characters from `A–Z a–z 0–9 _` in the browser (evidence `client-seed-origin.png`). Captured seeds are ASCII (`pf_…`) |
| `nonce` | non-negative integer, 0 on the first bet after a rotation, +1 per paid base spin | PAGE: "Nonce - a number that increases with each bet". DATA: 115 of 122 seed epochs (grouped by commitment, free spins excluded) run 0, 1, 2, … with no gap (see O5 for the other 7) |
| `round_index` | 0 for a base spin; the free-spin ordinal inside a bonus session | DATA (`verifyData.round_index`), see §2.6 |
| `stake` | `bet_amount_currency` (decimal); `bet_amount` is the same stake in coins | DATA |

### 1.2 Commitment

PAGE (duel.com/provably-fair, Overview tab, rendered 20 Oct 2026):

> "We then send you the hex-encoded SHA-256 hash of our server seed before you
> place your bets, to prove we won't change our minds."
>
> "After the game, we reveal the unhashed Server Seed. You can verify that: The
> server seed matches the original hash. The combined seeds generated the exact
> result you played."

```
commitment = lowercase_hex( SHA-256( hex_decode(serverSeed) ) )     # hash the 32 raw bytes
```

- SOURCE: PAGE + STANDARD; encoding by DATA. SHA-256 over the 32 decoded bytes
  resolves **121 / 121** distinct `server_seed_hashed` values (all 6,250 records);
  SHA-256 over the 64 ASCII characters resolves **0 / 121**.
- Forward chain: each rotation record's `nextServerSeedHash` equals the next
  record's `serverSeedHashed` on **120 / 120** rotations (DATA).
- Pairing: a rotation record carries the revealed OLD seed beside the NEW hash.
  Pair seeds to bets by hashing, never by record position.

---

## 2. Outcome derivation

PAGE gives only: "Fair result = Server seed + Client seed + Nonce". It names no
algorithm. PROFILE describes the game's RNG as "a two-layer RNG (HMAC → 32-bit
outcome index → PCG32 per cascade)" and "the whole round is a deterministic
function of a 32-bit outcome index". The data agrees with the shape. The two RNG
layers are now written from Duel's Verify-tab code (§2.2, §2.4a, §2.4b), under the
client's ruling, and reproduce every captured spin (§7, third pass).

### 2.1 Grid geometry and numbering

- 6 reels (columns) × 5 rows. CONFIG `columns: 6, rows: 5`.
- `position = reel × 5 + row`, reel 0–5 left to right, row 0 = top … row 4 =
  bottom. DATA: the response's `view[reel][row]` carries `position = reel*5+row`
  on every cell of every round; the verify output's `generated_positions`
  carries the same `(position, column, row)` triples.

### 2.2 Step A: seeds → `outcome_index` (SPECIFIED; closes O1)

`outcome_index` is an unsigned 32-bit integer (served range 60,462,566 –
4,268,979,530 over 623 records; served also as 8 hex digits,
`outcome_index_hex`, equal to `format(outcome_index, '08x')` on 623 / 623).

SOURCE: Duel's Verify-tab code (captured 2026-05-19), used for this step only by the
client's ruling of 20 Oct 2026; disclosed.

1. **Key**: the server seed's hex text decoded two characters at a time into bytes
   (64 hex characters → 32 bytes). Hex digit case does not matter.
2. **Client-seed part**: take the client seed's UTF-8 bytes and write each byte as
   two lowercase hex digits, in order, with nothing between them. The client seed is
   therefore hex-encoded text before it enters the message, not the raw text
   (this also settles O8: the encoding is UTF-8).
3. **Message**: that hex string, then one colon `:`, then the nonce as a plain
   decimal integer (no padding, no sign). The message is ASCII.
4. **Digest**: HMAC-SHA256 with that key over that message (32 bytes).
5. **`outcome_index`** = the first 4 bytes of the digest read as one unsigned
   32-bit integer, most significant byte first (big-endian).

For a free spin the nonce is the trigger's (or the buy's) nonce (§2.6).

Example (V1): client seed `pf_jaTw5uQPC05yB`, nonce 49 → message
`70665f6a615477357551504330357942:49`; HMAC-SHA256 with the V1 server seed =
`fe73754a…`; `outcome_index` = 0xfe73754a = 4268979530, the served value.

DATA: equals the served `outcome_index` on **623 / 623** records (§7, third pass;
614 / 623 when the capture's recorded nonce is used as-is, the 9 others all belong to
the session of spin 1974625, whose recorded nonce is stale, see O5).

Why the search below found nothing: every family tried put the client seed into the
message as its raw text; none hex-encoded it first.

**Search record (first and second passes, before the ruling).** The STANDARD
candidate is the first 4 bytes, big-endian, of
`HMAC-SHA256(key = hex_decode(serverSeed), msg = clientSeed + ":" + nonce)`. It
matches **0 / 623**. Every candidate below also matched **0**:

| Family tried (each against the served `outcome_index`) | Result |
|---|---|
| HMAC with key ∈ {seed bytes, seed ASCII, seed-hash ASCII, seed-hash bytes, client seed, nonce} × hash ∈ {SHA-256, SHA-512, SHA-1, MD5, SHA3-256, SHA3-512, BLAKE2b, BLAKE2s, SHA-384, SHA-224} × message = every ordering of 1–4 of {serverSeed, clientSeed, nonce, seed hash, "0", "groomers-van"} joined by `:` `-` `_` `|` `,` space or nothing × every 4-byte window × BE/LE, and as a hex substring | 0 |
| Plain hash of the same strings | 0 |
| Extra message tokens: game id `3`, `groomers-van`, `groomers_van`, `slots`, `base_game`, `0`, `1`, the spin id, `slot`, `spin` | 0 |
| Nonce as 4/8-byte BE/LE binary, appended or prepended | 0 |
| Nonce offsets −3 … +3 | 0 |
| Reductions: top 32/40/48/52/53/56/64 bits scaled to 2³², ±16 tolerance; 8/13/16 hex digits mod 2³²±8; XOR / sum folds of all 32-bit words; whole digest mod 2³²−5 | 0 |
| Double hashing: SHA-256/SHA-512/SHA-1/MD5 or HMAC over the first HMAC (bytes, hex, HEX) | 0 |

The consolidated re-run (`rng_search.py`, §7) tried 17,730 combinations per bet on
20 bets: best combination 0 / 20.

### 2.3 Step B: tumble hash (SPECIFIED)

For each drop of a round (tumble index `t` = 0 for the initial drop, 1, 2, … for
each refill after a win):

```
tumble_hash = first 8 bytes of SHA-256( ASCII( decimal(outcome_index) + ":" + decimal(t) ) )
              # shown as 16 lowercase hex digits
```

e.g. `outcome_index` 4268979530, t = 0 → SHA-256("4268979530:0") →
`e0890224720444d8`.

- SOURCE: DATA. **1,331 / 1,331** served `tumble_hash_hex` values (base spins and
  free spins) match. `t` restarts at 0 in every round (every free spin), and the
  hash does **not** include `round_index`: free spins 1…N of a session and their
  triggering base spin share one `outcome_index` and therefore the same tumble
  hashes, yet their grids differ (spins 1966407, 1966413, 1966422 all show
  `82b9aac41d56ab92` at t = 0 with different grids). So the symbol generator
  (Step C) must take `round_index` (or something else) as a further input. The
  Verify form (§2.5) confirms that the round index changes the seed.
- **Not an input to the grid (third pass).** Duel's Verify-tab code does not compute
  or use this hash at all; the grid seed comes from §2.4a. The served
  `tumble_hash_hex` is a label in the verify-endpoint output only. It still matches
  **1,331 / 1,331** when `outcome_index` is computed from the seeds by §2.2 (§7, third
  pass), so it can be kept as a cross-check, but no step depends on it.

### 2.4 Step C: symbols for the generated positions (generator SPECIFIED; its seed in §2.4a)

What is settled by DATA and CONFIG:

- **Which cells are generated.** Initial drop: all 30 cells. Tumble `t ≥ 1`: in
  each reel, the top `k` rows, where `k` = number of cells removed from that reel
  by the previous round's win (§3.2). DATA: 4,345 / 4,345 tumbles.
- **Each generated cell is an independent draw from its reel's weight table.**
  The draw table is CONFIG `weights.symbols_by_condition[cond]`, entry order =
  draw order, `weights_per_reel[reel]` = weight:

  base_game (11 symbols; reel 0 … reel 5):

  | idx | symbol | r0 | r1 | r2 | r3 | r4 | r5 |
  |---|---|---|---|---|---|---|---|
  | 0 | symbol_1 | 88 | 110903 | 734 | 64 | 82 | 480 |
  | 1 | symbol_2 | 92 | 96200 | 839 | 77 | 72 | 412 |
  | 2 | symbol_3 | 72 | 62000 | 520 | 52 | 74 | 360 |
  | 3 | symbol_4 | 65 | 63000 | 540 | 41 | 51 | 300 |
  | 4 | symbol_5 | 52 | 46000 | 460 | 31 | 52 | 265 |
  | 5 | symbol_6 | 42 | 42000 | 230 | 29 | 42 | 135 |
  | 6 | symbol_7 | 43 | 51000 | 470 | 42 | 63 | 320 |
  | 7 | symbol_8 | 39 | 44000 | 310 | 45 | 28 | 276 |
  | 8 | symbol_9 | 26 | 17000 | 351 | 27 | 31 | 62 |
  | 9 | wild | 8 | 8000 | 122 | 8 | 8 | 80 |
  | 10 | bonus | 3 | 4900 | 55 | 5 | 5 | 18 |

  bonus_game (12 symbols):

  | idx | symbol | r0 | r1 | r2 | r3 | r4 | r5 |
  |---|---|---|---|---|---|---|---|
  | 0 | symbol_1 | 143 | 4448 | 129 | 1349 | 194 | 175 |
  | 1 | symbol_2 | 72 | 5769 | 206 | 1351 | 68 | 66 |
  | 2 | symbol_3 | 79 | 1840 | 59 | 433 | 72 | 120 |
  | 3 | symbol_4 | 86 | 3440 | 51 | 773 | 74 | 43 |
  | 4 | symbol_5 | 33 | 1400 | 30 | 262 | 84 | 36 |
  | 5 | symbol_6 | 45 | 540 | 12 | 170 | 11 | 30 |
  | 6 | symbol_7 | 50 | 2960 | 43 | 714 | 52 | 48 |
  | 7 | symbol_8 | 31 | 1480 | 24 | 352 | 21 | 41 |
  | 8 | symbol_9 | 20 | 1120 | 24 | 235 | 12 | 10 |
  | 9 | wild | 5 | 428 | 11 | 117 | 4 | 8 |
  | 10 | multiplier | 14 | 632 | 16 | 153 | 10 | 12 |
  | 11 | bonus | 3 | 120 | 3 | 26 | 3 | 3 |

  `cond` = `base_game` for a paid spin, `bonus_game` for a free spin. DATA: the
  observed per-reel frequencies over 5,742 paid base-spin initial grids agree with the base
  table to within ±0.005 on every symbol and reel; over 486 free-spin initial grids
  with the bonus table to within ±0.017 (a smaller sample). Adjacent cells in a reel
  are uncorrelated (same-symbol neighbour rate equals Σp² on every reel, e.g. reel 0
  0.1222 vs 0.1218), so this is a per-cell weighted draw, not a reel strip.
- **Multiplier value.** A cell that draws `multiplier` gets a value from CONFIG
  `features[0].metadata.multiplier_values` (value: weight, ascending value order):
  2:90, 3:25, 4:18, 5:13, 6:10, 7:8, 8:7, 10:6, 12:5, 15:4, 25:4, 50:4, 100:3,
  250:3 (total 200). HELP shows the same distribution as percentages (weight/200).
  DATA: all 945 multiplier cells in the served free-spin rounds (a cell is counted
  once per round it appears in) carry a value in this set.

> **SUPERSEDED by §2.4a and §2.4b (marked 20 Oct 2026, on integration into the
> package).** The generator box below (increment 1, O'Neill-style seeding from a
> 64-bit `S(r,t)`, plain `v = next() mod T`) is the second pass's description, kept
> for the record and not deleted. It is not the construction to implement: build the
> tumble seed, the PCG32 state, the increment 0x5851F42D4C957F2D and the first output
> from §2.4a, and every draw with the §2.4b discard rule. Where this box and §2.4a /
> §2.4b disagree, §2.4a / §2.4b govern. The rest of §2.4 (which cells are generated,
> the per-reel weight tables, the multiplier value weights, the fill order) stands.

**The generator (VERIFY-FORM black box + DATA, §2.5).** Second-pass text, kept as
written. Third-pass corrections: the state and increment as Duel's code builds them
are in §2.4a (same outputs, different parametrisation), and the draw is the §2.4b
discard rule, not a plain modulo. For each round `r` and
tumble `t` there is one 64-bit seed `S(r,t)` (its derivation is now §2.4a), and:

```
PCG32 XSH-RR, 64-bit state, multiplier 6364136223846793005, increment 1:
    next():  old = state
             state = (old * 6364136223846793005 + 1) mod 2^64
             x   = uint32( ((old >> 18) XOR old) >> 27 )
             rot = old >> 59
             return rotr32(x, rot)
    seeding (O'Neill pcg32_srandom with initseq 0, i.e. increment 1):
             state = 0; next(); state += S(r,t); next()
      (equivalently: the first output is produced from state (S+1)·M + 1)

fresh grid G_t (30 cells), position p = 0 … 29 in order (column-major, top-down):
    reel = p div 5;  w = weight table of reel (config order, §2.4 tables);  T = Σ w
    v = next() mod T
    G_t[p] = the first symbol i with v < w[0] + … + w[i]
then, for every p = 0 … 29 with G_t[p] = multiplier, in position order:
    v = next() mod 200
    value(p) = the first value (ascending) whose cumulative weight exceeds v
```

- Tumble `t = 0`: the grid is `G_0`. Tumble `t ≥ 1`: after removal and gravity
  (§3.2), each emptied top cell at position `p` takes `G_t[p]` (and its value).
  Duel's Verify page says the same in prose: "Symbol grid is generated for next
  tumble … Empty spaces at the top of the grid are filled from matching positions
  in the new grid" (duel.com/provably-fair/verify, Groomer's Van, "How it works",
  read 20 Oct 2026).
- **CORRECTED (third pass): the draw uses rejection sampling, and its bias is exactly
  0.** The second pass wrote here: "No rejection sampling: `v = u32 mod T` straight.
  With the base reel-1 total 545,903 the modulo bias is at most T / 2³² ≈ 1.3 × 10⁻⁴
  per draw, which is above the profile's 2⁻³² bound (GROOMERS-08)." That was wrong.
  Duel's Verify-tab code discards any draw at or above a limit before taking the
  residue (exact rule in §2.4b), and the data confirms it: the captures contain 3
  draws that the rule discards, and the 3 spins holding them (1977498, 1986651,
  1991598) reproduce only with the discard; with plain `u32 mod T` all 3 fail
  (§7, third pass). The evidence the second pass gave for plain modulo (residues mod
  41 and 43 agreeing with the form) cannot tell the two apart: on every draw that is
  kept, both rules return the same `u32 mod T`. They differ only when a draw is
  discarded, which no form query hit. Also, the base reel-1 total is **545,003**, not
  545,903 (sum of the reel-1 column in the table above). Read the generator box
  above with `v = next() mod T` replaced by the §2.4b rule.
- Increment 1 and output-from-old-state were found, not assumed: for each of 10
  recovered tumbles exactly one 64-bit state reproduces all 30 draws as 30
  consecutive outputs (`oracle_check.py`, §7).
- Checked against served grids, reading `S` back from the form: spin 1965140
  rounds 0, 1, 2 (30/30, 8/8, 8/8 generated cells); free spin 1966450 (30/30, its
  one multiplier value 1/1); free spin 1968778 (30/30, multiplier values 4/4, in
  position order); free spin 1987729 tumble 1 (18/18 cells, the multiplier's value
  1/1).

### 2.4a Step B′: `outcome_index`, round, tumble → PCG32 state (SPECIFIED; closes O2)

SOURCE: Duel's Verify-tab code (captured 2026-05-19), used for this step only by the
client's ruling of 20 Oct 2026; disclosed.

**Tumble seed (32 bits).** Inputs: `outcome_index` (§2.2), round index `r` (0 for a
base spin, §2.6 for free spins), tumble index `t` (0 for the initial drop, then 1,
2, …). All arithmetic is on unsigned 32-bit words; "low32" keeps the low 32 bits of
a product; `>>` is a logical right shift; ⊕ is XOR.

```
x = outcome_index
x = x ⊕ low32( (r + 1) × 0x9E3779B9 )
x = x ⊕ low32( (t + 1) × 0x85EBCA6B )
x = x ⊕ (x >> 16)
x = low32( x × 0xC2B2AE35 )
x = x ⊕ (x >> 16)
tumble_seed(r, t) = x
```

Round and tumble enter with different constants, which is why swapping round and
tumble index gave different grids through the form (§2.5).

**PCG32 state (64 bits) from the tumble seed.** Arithmetic is modulo 2⁶⁴. The 32-bit
tumble seed is widened to 64 bits (high half zero) and passed once through the
SplitMix64 output step:

```
z = tumble_seed + 0x9E3779B97F4A7C15
z = (z ⊕ (z >> 30)) × 0xBF58476D1CE4E5B9
z = (z ⊕ (z >> 27)) × 0x94D049BB133111EB
state₀ = z ⊕ (z >> 31)
```

**PCG32 step.** Multiplier 6364136223846793005 (0x5851F42D4C957F2D), **increment
0x5851F42D4C957F2D** (the same number as the multiplier). Each draw computes the
XSH-RR output from the current state (xor the state with itself shifted right 18,
shift that right 27, keep 32 bits; rotate right by the state's top 5 bits), then
advances the state to `state × multiplier + increment`. There is no warm-up draw:
the first output of a tumble comes from `state₀`.

**One stream per (round, tumble).** Each tumble re-seeds from its own
`tumble_seed(r, t)`; nothing carries over from the previous tumble's stream. The
stream draws the fresh 30-cell grid and then the multiplier values (§2.4 box, with
the §2.4b draw rule).

**Disagreement with the second-pass form of §2.4 (reported, §2.4 left as written).**
§2.4 states the generator as "increment 1", seeded O'Neill-style from a 64-bit `S`,
first output from `(S+1)·M + 1`. Duel's code uses increment 0x5851F42D4C957F2D and
`state₀` as above. The two describe the same output sequence: if the code's states
are X₀, X₁, … then Y = X + 1 obeys `Y' = M·Y + 1`, and the XSH-RR output reads only
bits 27–63 of the state, so outputs from X and X + 1 differ only when the low 27 bits
of X are all ones (2⁻²⁷ per draw). All six seeds recovered through the form (§5)
satisfy `(S+1)·M + 1 = state₀ + 1` exactly (§7, third pass). The second pass's
"increment 1" was therefore an equivalent re-parametrisation inferred from outputs,
not the construction Duel uses; an implementation should follow this section.

### 2.4b The draw rule (rejection sampling)

SOURCE: Duel's Verify-tab code (captured 2026-05-19), used for this step only by the
client's ruling of 20 Oct 2026; disclosed. Confirmed by DATA (§7, third pass).

To draw a number below a total `T`:

```
limit = (2³² − 1) − ((2³² − 1) mod T)        # a multiple of T
repeat: u = next()  until  u < limit          # discard u ≥ limit, draw again
result = u mod T
```

- **Symbols**: `T` = the reel's weight total (§2.4 tables); the result picks the
  first symbol whose running weight sum exceeds it, symbols in config order. Cells
  are drawn in position order 0 … 29 (reel by reel, top row first).
- **Multiplier values**: after all 30 cells, for each cell that drew `multiplier`,
  in position order, one draw with `T` = the length of the multiplier value list,
  and the value is the list entry at that index. Duel's code takes the list as an
  input and does not contain it; the list that reproduces the data is the 200-entry
  list of §2.4 (each value repeated by its weight, ascending), which equals the
  cumulative rule in the §2.4 box. DATA: multiplier values **10,573 / 10,573**
  rounds (§7).
- Note: the limit is computed from 2³² − 1, not 2³², so it always discards
  `((2³² − 1) mod T) + 1` values (one more than strictly needed). The kept range
  `[0, limit)` still holds each residue exactly `limit / T` times.
- **Bias: exactly 0** for every symbol draw and the multiplier draw. The cost is a
  redraw with probability `(2³² − limit) / 2³²`: at most 8.0 × 10⁻⁵ per draw (base
  reel 1, `T` = 545,003, limit 4,294,623,640); 4.65 × 10⁻⁶ on bonus reel 1
  (`T` = 24,177); 2.24 × 10⁻⁸ for the multiplier draw (`T` = 200). This agrees
  with our v1.1.0 MANIFEST S5-8 as quoted in the task brief (rejection sampling,
  bias 0; the MANIFEST itself was not opened). The second pass's GROOMERS-08 bias
  figure is withdrawn.
- DATA: the captures contain 3 discarded draws, all on base reel 1 at tumble 0 (spin
  1977498 position 7, draw 4,294,666,399; spin 1986651 position 6, draw
  4,294,760,620; spin 1991598 position 5, draw 4,294,909,258; limit 4,294,623,640).
  Those 3 spins reproduce only with the discard.

**Closed, kept for the record (O2, second pass): `S(r,t)`.** The recovered seeds are not the served
`tumble_hash` (§2.3), nor `outcome_index`, under any of: O'Neill / raw / output-
before-or-after-step seeding, 2,000,000 PCG steps back from the recovered state
(V1 tumble 0),
SplitMix64 / fmix64 / RXS-M-XS-64 / golden-ratio mixing of the tumble hash (± round
index), SHA-256 / SHA-512 / HMAC (seed bytes or ASCII key) 8-byte windows (BE/LE)
and XOR / sum folds (on the V1 and zero-key recoveries) of messages built from up to 6 of {serverSeed, clientSeed,
nonce, round, tumble, outcome_index, tumble hash, "groomers-van", "base_game"} with
`:` `-` `_` `|` `,` or no separator, two-stage (4-byte window of an HMAC → "oi:t"
→ SHA-256), and an exhaustive search of all 2³² decimal X for SHA-256("X:0")[0:8]
against the zero-key seed. Every one: 0 matches. The earlier, pre-oracle candidate
table is kept below for the record.

| Family (pre-oracle, scored on served grids by the order-free test) | Best score |
|---|---|
| O'Neill `pcg32_srandom`, raw state/increment, `rand_pcg`, C++ `pcg32`, `seed_from_u64`, seeded with the tumble hash / `outcome_index` variants and increments {0, 1, 54, 721347520444481703, 1442695040888963407, 0xa02bdbf7bb3c0a7, 0xda3e39cb94b95bdb, 0x853c49e6748fea9b, reel, cell} | 9.03 – 9.29 (chance; a true generator scores ≈ 0.92) |
| 32-bit PCG hash, mulberry32, SplitMix64, xorshift32; per-cell SHA-256 / HMAC | ≥ 9.04 (chance) |

These failed because the seed was wrong, not the generator: increment 1 with an
O'Neill seed was in the table, but seeded with the tumble hash.

### 2.5 Black-box use of Duel's Verify form (disclosed)

Ruling (coordinator, 20 Oct 2026): Duel's public Verify form may be used as a
black box, typing crafted inputs and reading only the displayed result, never the
code panel. Used that way here, logged out, on `https://duel.com/provably-fair/verify`
with Game = Groomer's Van. The form takes Tumble Index, Round Index, Symbol
Distribution (Base game / Bonus game), Symbol Weights (JSON per reel), Client seed,
Server seed, Nonce, and shows a "Generated grid" of 30 symbol images. Only the
image file names of that grid and the page's prose were read; the text of every
`pre` / `code` element was stripped before reading, and no screenshot was taken.

1. With the real weights it reproduces the served grid (V1: 30/30).
2. Because the weights are an input, setting reel totals `T` (e.g. eleven weights
   of 1 → `T = 11`) makes the displayed symbol index equal `draw mod T`.
   Reading `draw mod p` for p = 11, 13, 17, 19, 23, 29, 31, 37 and combining them
   (CRT, product > 2³²) gives each cell's raw 32-bit draw; mod 41 and mod 43 were
   read as a check (consistent on 10/10 recoveries). A PCG32 state-recovery search
   (2³² candidates per increment) on two draws then gave the state.
3. Crafted-input findings: the server seed is used as a hex-decoded HMAC-style key
   (upper- and lowercase give the same grid; `01` and `0100` give the same grid,
   `01` and `0001` differ, i.e. trailing zero bytes are ignored, as with HMAC's
   key padding; non-hex text behaves as all-zero bytes); the client seed is text
   (`a`, `A`, `aa`, `zz`, `00`, `aé` all differ); round and tumble index both
   change the seed, and they are not one combined counter: (r=1, t=0) differs from
   (r=0, t) for t in {10, 16, 20, 30, 32, 50, 64, 100, 128, 256, 1000, 1024, 10000,
   65536}, and (r=0, t=1) from (r, t=0) for r in {10, 16, 20, 30, 32, 50, 64, 100,
   128, 256, 1000, 1024}; (r=1,t=11) ≠ (r=11,t=1), (n=1,r=11) ≠ (n=11,r=1),
   (n=1,t=11) ≠ (n=11,t=1);
   `ab`/12 ≠ `ab1`/2 and `ab:`/12 ≠ `ab:1`/2, so client seed and nonce are not
   simply concatenated.
4. An earlier attempt with very large weights (T up to 11¹⁰) froze the page, and the
   shared automated browser stopped responding. The rest was done in a separate
   headless Chromium with totals ≤ 43.

### 2.6 Sessions: base spin, free spins, bought bonus

- **Base spin**: one nonce, `round_index` 0.
- **Free spins triggered by a base spin**: every free spin of the session uses the
  **trigger spin's nonce and `outcome_index`**; `round_index` = the free spin's
  number (1, 2, …) = `feature_status.current_spin`. DATA: `round_index ==
  current_spin` on 272 / 272 such free spins; free-spin `outcome_index` ==
  trigger's on 272 / 272 where both are served.
- **Bought bonus**: the buy consumes a nonce; the buy record itself has no
  `outcome_index` (HELP: "first spin of a bought bonus game is purely cosmetic and
  does not produce clusters or wins. It shows a guaranteed bonus, so this initial
  spin isn't verifiable through the Provably Fair system."). Its free spins use the
  buy's nonce with `round_index` = `current_spin − 1` (0, 1, …). DATA: 203 / 203.
- Free spins do not consume a nonce of their own (DATA: 475 / 475 free spins carry
  their trigger's or buy's served nonce; the apparent exception in the session of
  1974625 is a stale recorded nonce on the trigger, O5).

---

## 3. Win condition and payout

All of §3 is evaluated on the grids as served. Nothing in §3 depends on O1/O2.

### 3.1 Clusters (anywhere pays)

For a grid, let `w` = number of `wild` cells. For each paying symbol
`s ∈ {symbol_1 … symbol_9}` with `n_s` cells:

```
cluster(s) wins  ⇔  n_s ≥ 1  and  n_s + w ≥ 8          count(s) = n_s + w
```

Several symbols can win in the same round; each wild counts toward every
winning symbol. `bonus` and `multiplier` never form clusters.

- SOURCE: CONFIG `pay_mechanic: cluster`, `symbols_paying_logic: anywhere`,
  `min_cluster_size: 8`, `skipped_symbol_types: [scatter]`; HELP "wild substitutes
  for any symbol except Bonus and contributes to every cluster win"; DATA
  **10,595 / 10,595** rounds give exactly the served set of (symbol, count).
- The rules endpoint says `min_cluster_size: 4`; DATA rejects it (57 / 10,595).
  The paytable starts at 8.
- `n_s ≥ 1` is assumed: no captured grid had 8+ wilds, so "wilds alone" is
  unwitnessed (O3).

### 3.2 Removal, gravity, tumble loop

```
round 0: grid = initial drop (30 generated cells)
loop:
    wins = clusters(grid)
    if wins is empty: stop                         # this round is the last
    remove every cell of every winning symbol and every wild cell
    (bonus and multiplier cells stay)
    in each reel: survivors keep their top-to-bottom order and settle at the bottom;
                  the empty top rows are filled by the next tumble's generated cells
    next round
```

- SOURCE: HELP "winning symbols disappear, symbols above drop down, new symbols
  drop in from the top. Continues while new wins land OR until max multiplier is
  reached." DATA: removed set == winning-symbol cells + all wilds on **10,595 /
  10,595** rounds; survivors' order and placement on **4,345 / 4,345** tumbles; a
  round is followed by a tumble iff it had a cluster win, **10,595 / 10,595**.
  Multiplier cells keep their value when they fall (DATA, same 4,345).

### 3.3 Paytable (multiplier of stake per winning cluster)

CONFIG/rules endpoint (identical in HELP), tier = `min(count, 12)`:

| symbol | 8 | 9 | 10 | 11 | 12+ |
|---|---|---|---|---|---|
| symbol_1 | 0.4 | 0.4 | 0.6 | 0.7 | 2.0 |
| symbol_2 | 0.5 | 0.6 | 0.7 | 1.0 | 2.5 |
| symbol_3 | 0.6 | 0.7 | 0.9 | 1.2 | 3.0 |
| symbol_4 | 0.7 | 0.9 | 1.2 | 1.5 | 4.0 |
| symbol_5 | 1.0 | 1.2 | 1.5 | 2.0 | 5.0 |
| symbol_6 | 1.5 | 1.6 | 2.2 | 2.8 | 7.0 |
| symbol_7 | 1.8 | 2.2 | 2.8 | 3.5 | 9.0 |
| symbol_8 | 2.5 | 3.5 | 4.5 | 5.5 | 14.0 |
| symbol_9 | 5.0 | 6.0 | 8.0 | 10.0 | 25.0 |

Same table in base and bonus. DATA: **5,007 / 5,007** served cluster multipliers
equal the table cell.

### 3.4 Scatter (`bonus`) pay and trigger, base game

Counted on the **final** grid of the spin (after the last tumble), `n` = number of
`bonus` cells:

```
scatter_pay(n) = 3 (n = 4), 5 (n = 5), 100 (n ≥ 6), else 0          # × stake
trigger        = n ≥ 3;  free spins awarded = {3: 8, 4: 10, 5: 12, 6: 14}[min(n, 6)]
```

- SOURCE: CONFIG `scatter_rewards`, rules `bonus` payouts {4: 3, 5: 5, 6: 100},
  HELP. DATA: all 25 scatter paylines sit in the last round with count == final-grid
  scatters and the table multiplier; `feature_triggered == (n ≥ 3)` on **5,764 /
  5,764** base records; `remaining_spins` on trigger == award on **33 / 33**.
- A bought bonus starts with 4 scatters: 10 free spins and a scatter pay of 3×
  stake (`buy_scatter_count: 4`, `buy_awards_scatter_payout: true`); DATA 22 / 22
  buys show `remaining_spins` 10, 4 scatters, total multiplier 3.

### 3.5 Free spins (bonus game)

- Grid draws use the `bonus_game` table (adds `multiplier`).
- Retrigger: `n ≥ 3` scatters on a free spin's final grid adds
  `{3: 3, 4: 5, 5: 8, 6: 10}[min(n, 6)]` spins, at most 3 retriggers per session
  (CONFIG `retrigger_rewards`, `max_retriggers: 3`). DATA: 1 retrigger witnessed,
  awarded 3 / 3 correct; 485 / 485 free spins with < 3 scatters did not retrigger.
  The cap was not reached (O4). No scatter pay is made in free spins (DATA: 0
  scatter paylines on 486 free-spin records, and §3.6's formula matches all 486
  without one).
- Multipliers: HELP "When tumbling stops, all multiplier symbols on screen are
  summed and applied to that tumble round's total win."

### 3.6 Spin total

```
C = Σ over all rounds of Σ over winning clusters of paytable[s][min(count,12)]
base spin : total_multiplier = C + scatter_pay(n_final)
free spin : M = Σ multiplier values on the final grid
            total_multiplier = C × M   if C > 0 and M > 0,   else C
```

DATA: base **5,764 / 5,764**, free spin **486 / 486** (e.g. spin 1966450:
C = 0.4 + 0.5 + 0.7 = 1.6, M = 7 → 11.2).

### 3.7 Money

```
total_win_currency = total_multiplier × bet_amount_currency            (exact)
amount_won         = total_win_currency
total_win (coins)  = round_to_0.01( total_multiplier × bet_amount )    (nearest)
```

DATA: exact currency product **6,250 / 6,250**; coins rounded to nearest cent
**6,250 / 6,250** (half-up and half-even agree, no tie occurs; truncation only
3,629 / 6,250). Example: spin 1987715, stake 50.00 (49.9915 coins), multiplier 0.7
→ 35 currency, 34.99 coins.

- House edge: CONFIG `rtp: 100.0000` and HELP "RTP 100%"; the page header shows
  "Zero Edge" and "House Edge 0%" (E01). CONFIG also carries a stake-tiered
  `scaling_edge` (base_game first tiers: `house_edge` 0.0001 below 9.066,
  0.0002 to 18.13, 0.0003 to 27.20, …). Every record has `edge_multiplier "1"`
  and pays exactly paytable × stake, including 11 wins at stakes 9.50–50.00, so no
  edge deduction is witnessed (O6).
- Max win: CONFIG `max_multiplier: 5000`, HELP "Max multi 5000x". No record
  reached it (`max_win_reached` false on 6,250 / 6,250) (O4).

### 3.8 Fields an implementation must not read

`outcome_index`, `tumble_hash_hex`, `expected_symbols`, `paylines`,
`spin_multiplier`, `total_multiplier`, `total_win*`, `amount_won*`,
`feature_triggered`, `respin_data`, `remaining_spins` are the operator's claims.
§3 reads only the grids, the stake and the CONFIG tables.

---

## 4. Source per step (summary)

| Step | Source | Evidence |
|---|---|---|
| Inputs: server seed, client seed, nonce | PAGE | provably-fair Overview, 20 Oct 2026 |
| Commitment = SHA-256 of decoded 32 bytes | PAGE + STANDARD + DATA | 121/121 (ASCII 0/121); chain 120/120 |
| Seeds → outcome_index = HMAC-SHA256(seed bytes, hex(UTF-8 client seed) + ":" + nonce)[0:4] BE | **VERIFY-TAB CODE** (client ruling 20 Oct 2026) + DATA | 623/623 |
| Tumble hash = SHA-256("oi:t")[0:8] | DATA | 1,331/1,331 |
| Generated positions (all 30; top k per reel after a tumble) | DATA | 4,345/4,345 |
| Per-reel weight tables, per-cell independent draws | CONFIG + DATA | frequencies within ±0.005 (base) |
| Generator: PCG32 XSH-RR, fresh 30-cell grid per tumble, column-major, then one draw per multiplier (200-entry list); new cells from matching positions | VERIFY FORM (black box) + DATA | 10/10 tumbles 30/30 consecutive draws; served grids 30/30, 8/8, 8/8, 30/30, 30/30, 18/18; multiplier values 6/6 |
| Tumble seed (32-bit mix of outcome_index, r, t) → SplitMix64 step → PCG32 state; increment 0x5851F42D4C957F2D | **VERIFY-TAB CODE** (client ruling 20 Oct 2026) + DATA | 6,228/6,228 spins, 10,573/10,573 round grids |
| Draw rule: discard u ≥ (2³²−1) − ((2³²−1) mod T), then u mod T; bias 0 (corrects the second pass's "plain mod") | **VERIFY-TAB CODE** + DATA | 3 discarded draws in the data; those 3 spins reproduce only with the discard |
| Multiplier value set and weights | CONFIG + HELP + DATA | 945/945 in set |
| Free spins share trigger nonce + outcome_index; round_index | DATA | 272/272 and 203/203 |
| Clusters: anywhere, own ≥ 1, own + wild ≥ 8 | CONFIG + HELP + DATA | 10,595/10,595 |
| Removal (winners + wilds), gravity, tumble iff win | HELP + DATA | 10,595 and 4,345 |
| Paytable tier min(count,12) | CONFIG + HELP + DATA | 5,007/5,007 |
| Scatter pay, trigger, awards on final grid | CONFIG + DATA | 25 paylines; 5,764/5,764; 33/33 |
| Bonus total = clusters × Σ final multipliers | HELP + DATA | 486/486 |
| Money: currency exact, coins nearest 0.01 | DATA | 6,250/6,250 (truncation 3,629) |

---

## 5. Test vectors (from the dataset)

Copied from `groomers-van-smoke-test-1778204681017.json.gz`. Server seed from the
revealed seed whose decoded-byte SHA-256 equals the commitment (checked for all
five). `outcome_index` is computed from the seeds by §2.2 and equals the served
value on all five (third pass);
tumble hashes are computed by §2.3 from it and equal the served ones in every
round shown. Grids are the served grids, and every round of all five is rebuilt from
the player's seeds by §2.2 → §2.4a → §2.4/§2.4b (third pass; table below);
rows top to bottom, reels left to right; `S1` = symbol_1, `W` wild,
`B` bonus, `Mx7` multiplier 7. Everything after the grid is computed by §3 and
equals the served value.

Seeds of every round (third pass): `tumble_seed(r, t)` (§2.4a, 8 hex digits) /
`state₀` (16 hex digits).

```
V1 1965140  n 49 r 0  oi fe73754a  t0 c16f6d0c/fab4b2311f120e7b  t1 35d31d7d/3ce47377bee744fd  t2 242ebed7/e649c38447a3774d
V2 1976266  n 5  r 0  oi b3ca8d89  t0 025f71ae/23152207a1ebf17b
V3 1966407  n 40 r 0  oi 328cb323  t0 fdd6f183/01eacf00c1dffe91  t1 33236083/56a1b0a5f47dae51
V4 1966450  n 40 r 5  oi 328cb323  t0 5b743e8d/7c53915a49cbb5d4  t1 674a850e/ebff4e8cbfbae814  t2 c2c9cfaa/ce87a12ef231b2cf
V5 1987729  n 0  r 0  oi c6a191fa  t0 71bbd322/582f9a996d1090c2  t1 74688a8c/49cdc19d21945e84
```

**V1: spin 1965140** (base, two tumbles)
```
serverSeed 230ba817fa7535d716b67a15e7cfbccbeb0cd0104b4e118c9bbf131d276fbe8f
commitment 4665995d6e3e03a83c42cd0427693f2e78c7b7283bdf35a3d463481fee252a21
clientSeed pf_jaTw5uQPC05yB   nonce 49   round_index 0   stake 0.20 (0.199954 coins)
outcome_index 4268979530 (fe73754a)  [served]
t=0 tumble_hash e0890224720444d8
    S2 S3 S4 S8 S3 S5 / S2 S2 S5 S3 S6 S2 / S3 S1 S2 S1 S5 S2 / S2 S8 S4 S3 S7 S8 / S1 S8 S9 S2 S9 S4
    symbol_2 × 8 → 0.5   removed 0 1 3 6 12 19 26 27
t=1 tumble_hash 41e52708292c3854
    S2 S4 S7 S3 S3 S8 / S1 S3 S4 S8 S6 W / S3 S1 S5 S3 S5 S5 / S3 S8 S4 S1 S7 S8 / S1 S8 S9 S3 S9 S4
    symbol_3 × 8 (7 + 1 wild) → 0.6   removed 2 3 6 15 17 19 20 26
t=2 tumble_hash aaf404b4c44ceac0
    S1 S4 S7 S2 S5 S4 / S1 S4 S4 S2 S6 S8 / S2 S1 S5 S4 S5 S5 / S1 S8 S4 S8 S7 S8 / S1 S8 S9 S1 S9 S4
    no win → stop
total_multiplier 1.1   total_win_currency 0.22   total_win (coins) 0.22   no scatters
```

**V2: spin 1976266** (base, scatter pay and trigger)
```
serverSeed a81baf3e7dee56be7fca67da83a809eabe5423e5b2a44bc66762b3500080b9a8
commitment 0b742c5c9410cb762cf801b218d57e79e4ef238973cdfec99f46990de5965219
clientSeed pf_r3UgUo9TKL8ea   nonce 5   stake 0.20
outcome_index 3016396169 (b3ca8d89)  [served]
t=0 tumble_hash e10181c3e19c115b
    S3 S7 S1 S6 S3 S4 / S4 B S1 S2 S8 S3 / S2 S4 S6 S9 S1 B / S6 S1 S6 S9 B S4 / S6 S4 S9 S2 S3 B
    no cluster; 4 scatters → scatter_pay 3; trigger, 10 free spins
total_multiplier 3   total_win_currency 0.6   feature_triggered true, remaining_spins 10
```

**V3: spin 1966407** (base, 3-scatter trigger after a tumble)
```
serverSeed a6f8de3ed0adf0bbbc4d2c5af73041919868c4f786f572568787c792a2f5e029
commitment 08e6584aba3d698ed8659faabec500e477a1657379b1bb081e891202fcbdbc47
clientSeed pf_raPBrzfw4Gi48   nonce 40   stake 0.20 (0.199958 coins)
outcome_index 848081699 (328cb323)  [served]
t=0 tumble_hash 82b9aac41d56ab92
    S2 S7 S3 S1 S3 S2 / B W S6 S7 S2 S5 / S2 S2 S4 S4 S9 S1 / S3 S1 S1 S8 S1 S2 / S1 S1 S3 B S1 S1
    symbol_1 × 10 (9 + 1 wild) → 0.6   removed 4 6 8 9 13 15 23 24 27 29
t=1 tumble_hash 208c42d1e5e3a03a
    S6 S7 S8 S1 S1 B / S2 S1 S3 S7 S3 S2 / B S7 S6 S4 S3 S2 / S2 S7 S4 S8 S2 S5 / S3 S2 S3 B S9 S2
    no win → stop; final grid has 3 scatters (positions 2, 19, 25) → trigger, 8 free spins, scatter_pay 0
total_multiplier 0.6   total_win_currency 0.12   remaining_spins 8
```

**V4: spin 1966450** (free spin 5 of V3's session; multiplier applied)
```
same serverSeed / clientSeed as V3; nonce 40 (trigger's); round_index 5; outcome_index 848081699 [served]
bonus_game weights; stake 0.20
t=0 tumble_hash 82b9aac41d56ab92   (same as V3 t=0; grid differs, see §2.3)
    S4 S3 S2 S2 S5 S1 / S1 S2 S4 S1 S1 S2 / S1 S5 S6 S5 S4 S8 / S7 S1 S3 Mx7 S1 W / S4 S2 S2 S4 S8 S2
    symbol_1 × 8 → 0.4, symbol_2 × 8 → 0.5   removed 1 2 6 8 9 10 14 15 16 21 23 25 26 28 29
t=1 tumble_hash 208c42d1e5e3a03a
    S4 S7 S1 S2 S1 S7 / S4 S2 S1 S3 S3 S5 / S4 W S4 S5 S5 S1 / S7 S3 S6 Mx7 S4 S2 / S4 S5 S3 S4 S8 S8
    symbol_4 × 8 → 0.7   removed 0 1 2 4 7 12 19 23
t=2 tumble_hash 21f5d79556e419d7
    S5 S2 S8 S1 S3 S7 / S5 S7 S1 S2 S1 S5 / S1 S2 S1 S3 S3 S1 / S6 S3 S6 S5 S5 S2 / S7 S5 S3 Mx7 S8 S8
    no win → stop; C = 1.6, M = 7
total_multiplier 11.2   total_win_currency 2.24
```

**V5: spin 1987729** (free spin 1 of a bought bonus; multiplier lands in a tumble)
```
serverSeed bd7c14095e8fc92a3c80212a1f0f8f7ac28bb0349c352c9156a6a24f0720db73
commitment 2cb17d5b7d6acd74d50d8f229417709f0e1fa0bf91062d3029ac93f84e68f6f7
clientSeed pf_scxjbJHFFF8jD   nonce 0 (the buy's)   round_index 0 (current_spin 1)   stake 0.20
outcome_index 3332477434 (c6a191fa)  [served]
t=0 tumble_hash 35f9e5b3a0f4bf39
    S3 S2 S2 S4 S4 S2 / S2 S1 S2 S1 S1 S2 / S9 S1 S6 S1 S8 S4 / S1 S2 S6 W S7 S4 / S1 S2 S2 S3 S2 S3
    symbol_2 × 11 (10 + 1 wild) → 1.0, symbol_1 × 8 (7 + 1 wild) → 0.4
    removed 1 3 4 5 6 7 8 9 10 11 14 16 17 18 21 24 25 26
t=1 tumble_hash d9bcfa4980d87d30
    S2 S2 S2 S2 S3 Mx3 / S4 S2 S2 S7 S5 S7 / S1 S1 S2 S4 S4 S4 / S3 S3 S6 S4 S8 S4 / S9 S6 S6 S3 S7 S3
    no win (symbol_2 × 7) → stop; C = 1.4, M = 3
total_multiplier 4.2   total_win_currency 0.84
```

**Generator vectors (§2.4), seeds read off the Verify form.** `S` is the O'Neill
`pcg32_srandom(S, 0)` initstate; the first three outputs are listed. With the §2.4
weight tables each rebuilds the grid shown above (V1 t = 0, 1, 2; V4 t = 0; V5 t = 1)
or for spin 1968778 the free-spin round 3 grid, including multiplier values.

```
V1  r=0 t=0  S=0x6d48b259ced08d46  2904762124 1640814390 3813667684
V1  r=0 t=1  S=0x9f12b4a32bfcff10  2839093011 2525730931 4018098244
V1  r=0 t=2  S=0xf7b9a03f6285eca0  2482252908 2774677785 3956507007
V4  r=5 t=0  S=0xe1efeec3058d51a3  2477462755 1680131858  910088972   (bonus weights; output 30 → 157 mod 200 → value 7)
V5  r=0 t=1  S=0xe0bf1f29f0dd8b13  3843874110 1373579023 1769272822   (bonus weights; output 30 → value 3)
1968778 (nonce 24, r=3, t=0)  S=0xecd9aa6a3bff2132  2152404752 2366013969 483651028   (outputs 30–33 → values 5, 2, 50, 2 at positions 8, 16, 19, 21)
```

Third pass: for all six, `(S+1)·M + 1 = state₀ + 1` (mod 2⁶⁴), with `state₀` from
§2.4a; e.g. V1 t=0 `state₀` = 0xfab4b2311f120e7b, form-side 0xfab4b2311f120e7c;
1968778 r=3 t=0 `tumble_seed` 0x14ec6dbd, `state₀` 0x1812c3c0940022f7. The first
three outputs above are reproduced by the §2.4a stream.

---

## 6. Open points the public sources do not settle

- **O1: CLOSED (third pass)** by §2.2 (VERIFY-TAB CODE, client ruling 20 Oct 2026):
  623 / 623. Original text kept below.
- **O2: CLOSED (third pass)** by §2.4a and §2.4b (VERIFY-TAB CODE): every round of
  6,228 / 6,228 spins rebuilt from the seeds. The "related finding for GROOMERS-08"
  in the original O2 text below is **withdrawn**: the draw uses rejection sampling
  and its bias is exactly 0 (§2.4b).
- **O5: EXPLAINED (third pass; corrected 21 Oct 2026).** The four records just before
  a recorded gap (spins 1965523, 1974625, 1976463, 1987633, one per affected epoch)
  carry a recorded nonce one lower than the nonce actually served: each reproduces only
  at recorded nonce + 1. For 1974625 the served verify nonce is 3 and its whole
  free-spin session reproduces with nonce 3. Correcting the four does not close the
  gaps; it moves each one down by one, to the nonce the record carried. After the
  correction one served nonce per affected epoch is still missing from the captured
  data: 47 (epoch `d6bebb43…`, which holds 0–46 and 48–50), 2 (`22f48a0f…`), 22
  (`77544e55…`) and 9 (`3052a819…`). Those four rounds were served by Duel and not
  captured (the capture recorded the lost round's nonce on the next bet), which is
  what the audit package's Step 4 flags. Free spins do not consume a nonce: in the
  main file every free spin's verify nonce equals its trigger's (or buy's) served
  nonce, 475 / 475, and the next paid bet after a trigger or buy is at its nonce + 1,
  52 / 52 (the 53rd is the last bet of its epoch).
  This is a capture-side issue, not an operator finding.
- **O8: CLOSED (third pass)**: the client seed is encoded as UTF-8 (§2.2).

Original open-point text (second pass), kept for the record:

- **O1: seeds → `outcome_index`.** Duel's page says only "Fair result = Server
  seed + Client seed + Nonce". The standard HMAC-SHA256 construction and every
  variant in §2.2 give 0 matches. This is the step that binds the grid to the
  seeds, so without it no spin can be verified from the seeds by this spec. To
  close: Duel's written description of how the 32-bit outcome index is formed
  (key, message format, byte selection), checked against the 623 served values.
- **O2: the 64-bit PCG32 seed `S(r,t)`.** The generator, draw, fill order and
  multiplier-value draw are now specified (§2.4, from the Verify form used as a
  black box). The seed of each (round, tumble) is not: it is not the served tumble
  hash or `outcome_index` under any seeding or mixing tried (§2.4), and the
  zero-key exhaustive 2³² search found nothing. The form shows the seed depends on
  the decoded server seed (HMAC-style key), the client seed as text, the nonce, the
  round and the tumble (§2.5). To close: Duel's written description of the seed
  derivation; it can then be checked here against the 10 recovered seeds. Related
  finding for GROOMERS-08: the draw is a plain `u32 mod T`, no rejection, so the
  modulo bias reaches T/2³² ≈ 1.3 × 10⁻⁴ on base reel 1 (T = 545,903).
- **O3: wild-only clusters.** No grid had 8 or more wilds, so whether wilds alone
  pay (and as which symbol) is not witnessed. The spec assumes they do not.
- **O4: caps.** The 5,000× max win and the 3-retrigger cap were never reached.
  How the cap truncates a spin or session (HELP: tumbling continues "until max
  multiplier is reached") is not witnessed. Only one retrigger was captured.
- **O5: nonce in 7 epochs.** In 4 epochs of the main file one base-spin nonce is
  missing, and in one session (trigger 1974625, recorded nonce 2) the served
  free-spin nonce is 3 while the next base spin is 4. Of the 3 smoke-file epochs, two
  start at 47 (the account's running nonce; one of them repeats 53) and one is a single
  buy record with no nonce field. Whether a bonus session
  ever consumes a nonce cannot be settled without O1.
- **O6: scaling edge.** CONFIG carries stake-tiered `house_edge` values (0.0001 and
  up) but every served `edge_multiplier` is "1" and every payout is paytable ×
  stake. How, or whether, the edge is applied is not settled; the buy price
  (`buy_multiplier: 125`) is not in any captured record either.
- **O7: rules-endpoint `min_cluster_size: 4`** contradicts CONFIG (8), the
  paytable (starts at 8) and the data (8). The served behaviour is 8.
- **O8: client-seed encoding beyond ASCII** is assumed UTF-8 (all captured seeds
  are ASCII).

---

## 7. Reproduction of this spec

Throwaway scripts (outside the repo, not committed):
the spec author's check scripts
(`spec_check.py`, `rng_search.py`, `vectors.py`, and the exploratory `t1`–`t14`).
Output of the last run:

```
bets loaded (4 files): 6250 Counter({'1017.json.gz': 6225, '7508616.json': 13, '9888133.json': 9, '9129314.json': 3})
commitment SHA256(hexdecode(seed)) resolves: 121/121 distinct hashes; ascii form: 0/121; bets covered 6250/6250
forward chain nextServerSeedHash -> next active hash: 120/120
tumble_hash_hex == SHA256(ascii "outcome_index:tumble_index")[0:8]: 1331/1331
amount_won == total_win_currency: 6250/6250
clusters (anywhere, own>=1, own+wild>=8): 10595/10595
feature_triggered == final-grid scatters>=3: 5764/5764
gravity (survivors keep order, settle at bottom, new cells fill top): 4345/4345
max_win_reached false and total_multiplier <= 5000: 6250/6250
payline multiplier == paytable[sym][min(count,12)]: 5007/5007
removed == cells of winning symbols + all wilds: 10595/10595
total_multiplier (base_game): 5764/5764
total_multiplier (bonus_game): 486/486
total_win(coins) == round2_down(total_multiplier x bet_amount): 3629/6250
total_win(coins) == round2_half_even(total_multiplier x bet_amount): 6250/6250
total_win(coins) == round2_half_up(total_multiplier x bet_amount): 6250/6250
total_win_currency == total_multiplier x bet_amount_currency (exact): 6250/6250
tumble continues iff a cluster won: 10595/10595
(a) outcome_index: 17730 (message x hash x key x 4-byte window x endianness) combinations per bet on 20 bets; best combination matched 0/20
(b) grid generator: 1752 (seed x PCG32 seeding x output timing x fill order x draw) combinations on 60 base grids; best coherence 9.29 (('oi', 'pcg32_srandom(s,721347520444481703)', 1, 'row-major', 'u32/2^32 x total')) ; median 9.64
    control: coherence of the true generator on synthetic grids = 0.92
```

Second pass (Verify form as a black box; `oracle/` holds the driver and the
recovered draws; `oracle_check.py` rebuilds each grid from the recovered state):

```
PCG32 XSH-RR, increment 1, 30 consecutive outputs (column-major) == the 30 recovered draws: 10/10 tumbles (unique state each)
spin 1965140: round 0: generated cells 30/30, multiplier values 0/0; round 1: generated cells 8/8, multiplier values 0/0; round 2: generated cells 8/8, multiplier values 0/0
spin 1966450: round 0: generated cells 30/30, multiplier values 1/1
spin 1968778: round 0: generated cells 30/30, multiplier values 4/4
spin 1987729: round 1: generated cells 18/18, multiplier values 1/1
lossy/latin-1 key and message family: 30 bets; best combination hits: 0
```

The last line is the crash-style family for O1 (seed bytes decoded as UTF-8 with
replacement or as Latin-1, re-encoded, as HMAC key or message prefix, with
`c:n`, `c:n:0`, `n:c` messages, SHA-256 / SHA-512, every 4-byte window BE/LE):
0 matches against the served `outcome_index`.

Third pass (`full_spec.py`: the whole spec, §2.2 → §2.4a → §2.4/§2.4b → §3, from the
revealed server seed, client seed and nonce only; served outcome fields are read only
to compare). Every record in the four redacted datasets: 6,250 records = 5,742 paid
base spins + 486 free spins + 22 buy records (cosmetic, §2.6). Three passes: the
capture's recorded nonce with the §2.4b discard rule; the same with the gap rule of
O5 applied to the 4 stale-nonce records; and that with plain `u32 mod T` instead of
the discard. Output of the last run:

```
records loaded: 6250 Counter({'1017.json.gz': 6225, '7508616.json': 13, '9888133.json': 9, '9129314.json': 3})
gap rule applied to 4 records: [(1965523, 48), (1974625, 3), (1976463, 23), (1987633, 10)]
[gapfix/mod] PCG32 draws rejected: 0
[gapfix/mod] base trigger: remaining_spins == award: 33/33
[gapfix/mod] base_game spins: 5739/5742   first fails [1977498, 1986651, 1991598]
[gapfix/mod] bonus_game free spins: 486/486
[gapfix/mod] feature_triggered == (final scatters >= 3): 5742/5742
[gapfix/mod] free spin retrigger == (final scatters >= 3): 486/486
[gapfix/mod] number of rounds (tumbles) == served: 6227/6228   first fails [1986651]
[gapfix/mod] retrigger awarded_spins == table: 1/1
[gapfix/mod] round cluster paylines (symbol, count, multiplier) == served: 10570/10573   first fails [1977498, 1986651, 1991598]
[gapfix/mod] round grid symbols (30 cells) == served: 10567/10573   first fails [1977498, 1977498, 1977498, 1986651, 1991598, 1991598]
[gapfix/mod] round multiplier values == served: 10573/10573
[gapfix/mod] spin: every round reproduced from seeds: 6225/6228   first fails [1977498, 1986651, 1991598]
[gapfix/mod] total_multiplier == served: 6225/6228   first fails [1977498, 1986651, 1991598]
[gapfix/mod] total_win (coins) == round_0.01(tm x bet_amount): 6225/6228   first fails [1977498, 1986651, 1991598]
[gapfix/mod] total_win_currency == tm x bet_amount_currency: 6225/6228   first fails [1977498, 1986651, 1991598]
[gapfix/reject] PCG32 draws rejected: 3
[gapfix/reject] base trigger: remaining_spins == award: 33/33
[gapfix/reject] base_game spins: 5742/5742
[gapfix/reject] bonus_game free spins: 486/486
[gapfix/reject] feature_triggered == (final scatters >= 3): 5742/5742
[gapfix/reject] free spin retrigger == (final scatters >= 3): 486/486
[gapfix/reject] number of rounds (tumbles) == served: 6228/6228
[gapfix/reject] retrigger awarded_spins == table: 1/1
[gapfix/reject] round cluster paylines (symbol, count, multiplier) == served: 10573/10573
[gapfix/reject] round grid symbols (30 cells) == served: 10573/10573
[gapfix/reject] round multiplier values == served: 10573/10573
[gapfix/reject] spin: every round reproduced from seeds: 6228/6228
[gapfix/reject] total_multiplier == served: 6228/6228
[gapfix/reject] total_win (coins) == round_0.01(tm x bet_amount): 6228/6228
[gapfix/reject] total_win_currency == tm x bet_amount_currency: 6228/6228
[gapfix] outcome_index (seeds) == served verifyData.outcome_index: 623/623
[gapfix] tumble_hash_hex == SHA256("oi:t")[0:8] (oi from seeds): 1331/1331
[recorded/reject] PCG32 draws rejected: 3
[recorded/reject] base trigger: remaining_spins == award: 32/32
[recorded/reject] base_game spins: 5738/5742   first fails [1965523, 1974625, 1976463, 1987633]
[recorded/reject] bonus_game free spins: 478/486   first fails [1974627, 1974630, 1974632, 1974636, 1974638, 1974639]
[recorded/reject] feature_triggered == (final scatters >= 3): 5741/5742   first fails [1974625]
[recorded/reject] free spin retrigger == (final scatters >= 3): 486/486
[recorded/reject] number of rounds (tumbles) == served: 6219/6228   first fails [1965523, 1974627, 1974630, 1974632, 1974636, 1974638]
[recorded/reject] retrigger awarded_spins == table: 1/1
[recorded/reject] round cluster paylines (symbol, count, multiplier) == served: 10556/10567   first fails [1965523, 1974627, 1974630, 1974632, 1974636, 1974636]
[recorded/reject] round grid symbols (30 cells) == served: 10551/10567   first fails [1965523, 1974625, 1974627, 1974630, 1974632, 1974636]
[recorded/reject] round multiplier values == served: 10557/10567   first fails [1974627, 1974632, 1974636, 1974636, 1974636, 1974638]
[recorded/reject] spin: every round reproduced from seeds: 6216/6228   first fails [1965523, 1974625, 1974627, 1974630, 1974632, 1974636]
[recorded/reject] total_multiplier == served: 6217/6228   first fails [1965523, 1974627, 1974630, 1974632, 1974636, 1974638]
[recorded/reject] total_win (coins) == round_0.01(tm x bet_amount): 6217/6228   first fails [1965523, 1974627, 1974630, 1974632, 1974636, 1974638]
[recorded/reject] total_win_currency == tm x bet_amount_currency: 6217/6228   first fails [1965523, 1974627, 1974630, 1974632, 1974636, 1974638]
[recorded] outcome_index (seeds) == served verifyData.outcome_index: 614/623   first fails [1974625, 1974627, 1974630, 1974632, 1974636, 1974638]
[recorded] tumble_hash_hex == SHA256("oi:t")[0:8] (oi from seeds): 1315/1331   first fails [1974625, 1974627, 1974630, 1974632, 1974632, 1974632]
buy record (cosmetic): total_multiplier 3, 10 spins: 22/22
```

Reading it: with the discard rule and the 4 stale nonces corrected, every round grid,
multiplier value, payline, tumble count, total and payout of all 6,228 spins is
rebuilt from the seeds. The 12 spins that fail on the recorded nonce are exactly the 4
stale-nonce records and the 8 free spins of 1974625's session (O5). Plain modulo fails
exactly the 3 spins holding a discarded draw. (Round counts differ between passes,
10,567 vs 10,573, because a pass compares only the rounds both sides have.)

---

## 8. Files and URLs opened while writing this spec

Files read: the task brief; `_workspace/pf-audit-framework/games/dice/ALGORITHM.md`
(model only); `_workspace/pf-audit-framework/games/groomers-van/profile.json`;
`pf-duel-workspace/games/groomers-van/evidence/E01-groomers-van-game-ui.png` and
`client-seed-origin.png` (shows Duel's client-seed generator, not the game
derivation); the four datasets in `pf-duel-workspace/games/groomers-van/data/`
(including their `events` and `verifyData` JSON); in `data/raw/`:
`groomers-van-config-v1.4.json`, `paytable-from-rules-endpoint.json`,
`paytable-extracted-from-help.json`, `slots-2026-10-05.json`,
`slots-groomers-van-rules-2026-10-05.json` and both `.meta.json`,
`client-seed-snapshot.json`, `spin-1835724-request.json`; `spin-1835724-response.json`
and `smoke/c-buy-1922931.json` were grepped for field names only. Directory
listings (names only) of the game folder, `evidence/`, `data/`, `data/raw/`,
`data/raw/smoke/`.

URLs (GET, no login, 20 Oct 2026): `https://duel.com/provably-fair` (curl: SPA
shell; rendered: Overview text quoted in §1–2), `https://duel.com/groomers-van`
(rendered; only site chrome and chat text came back), `https://duel.com/originals/groomers-van`
(404). The automated browser was shared with another session (its URL changed to
other Duel pages between calls).

Second pass: `https://duel.com/provably-fair/verify`, Game = Groomer's Van, used as
a black box under the coordinator's ruling (§2.5). First in a new tab of the shared
automated browser, which stopped responding after a query with very large weights.
Then in a separate headless Chromium driven by a local script (the globally installed
headless browser package). Read: the form's labels and prose, and the file names of
the generated-grid images. The `pre`/`code` text was stripped before every read;
4 code blocks were present and were not read. No screenshot was taken. Nothing under
the browser tool's snapshot folder was opened (the browser tool wrote snapshot and console files
there automatically).

Third pass (20 Oct 2026, after the client's ruling at 13:30): opened exactly one Duel
code file, `pf-duel-workspace/games/groomers-van/evidence/verify-tab/duel-verify-tab-groomers-van-2026-05-19.captured.json`
(Duel's Verify-tab code for Groomer's Van, captured 2026-05-19), and used it only for
§2.2, §2.4a and §2.4b. Also read: this spec, our own second-pass scratch scripts
(`load.py`, `common.py`, `mech.py`, `spec_check.py`) for the dataset loader, the four
redacted datasets and `data/raw/groomers-van-config-v1.4.json`,
`raw/paytable-from-rules-endpoint.json`. Not opened in the third pass: `src/`,
`tests/`, the package `MANIFEST.md` / `README.md`, any `.har`, any
`*.unredacted.json`, or any other Duel code.

Not opened in the first two passes: any `verify-tab` or `verifier-parity` path, `src/`, `tests/`,
`scripts/`, `capture/`, `cuda/`, `outputs/`, `working-notes/`, `verify.js`,
`test.js`, `MANIFEST.md`, `README.md`, `RELEASE-MANIFEST.json` of any Duel package,
any `.har`, `*.unredacted.json`, any saved Duel JS bundle, or the code panel of
Duel's Verify tab.
