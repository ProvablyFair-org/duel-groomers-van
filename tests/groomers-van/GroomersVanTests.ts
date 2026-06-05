/**
 * Groomer's Van — Unit Tests
 *
 * Validates the RNG core (HMAC → outcome_index → tumble_seed → PCG32 →
 * grid) against the operator's published verifier output for a single
 * known spin. Anchors the audit's algorithm claim — if any of these
 * tests change in the future, src/rng.ts has drifted from the operator's
 * spec at https://duel.com/fairness/verify.
 */

import { strict as assert } from 'assert';
import {
  hashServerSeed,
  computeOutcomeIndex,
  deriveTumbleSeed,
  Pcg32,
  pickWeighted,
  generateGrid,
  reproduceSpin,
} from '../../src/rng';

// ── Known good spin from the captured dataset ───────────────────────────────
//   bet 1964586  (Phase A, $0.20, base_game spin)
//   server_seed_hashed = 1966b35c0357323c0e3f5f7150805522bfb6d7db386dab31340e7bc9c4d9a3dd
//   server_seed       = 38daabbe1a0a8e472690d8359f05bd5ad44dee3f60902dc14eeed66bdb710e67
//   client_seed       = pf_ww6Oka8nm8byd
//   nonce             = 49
//   round_index       = 0
//   tumble_index      = 0
//   outcome_index     = 442730823 (0x1a638947)   ← from /verify response
//   grid (col-major)  = the 30 cells in the spin's view
const KNOWN = {
  serverSeed:       '38daabbe1a0a8e472690d8359f05bd5ad44dee3f60902dc14eeed66bdb710e67',
  serverSeedHashed: '1966b35c0357323c0e3f5f7150805522bfb6d7db386dab31340e7bc9c4d9a3dd',
  clientSeed:       'pf_ww6Oka8nm8byd',
  nonce:            49,
  roundIndex:       0,
  tumbleIndex:      0,
  outcomeIndex:     442730823,
  outcomeIndexHex:  '1a638947',
  // Symbol order in /api/v2/slots base_game weights:
  //   0=symbol_1, 1=symbol_2, 2=symbol_3, 3=symbol_4, 4=symbol_5,
  //   5=symbol_6, 6=symbol_7, 7=symbol_8, 8=symbol_9, 9=wild, 10=bonus
  expectedGrid: [
    // col 0
    [0, 2, 4, 1, 5],
    // col 1
    [3, 2, 1, 7, 1],
    // col 2
    [4, 6, 0, 3, 1],
    // col 3
    [3, 7, 1, 2, 2],
    // col 4
    [8, 6, 7, 4, 4],
    // col 5
    [7, 6, 6, 0, 4],
  ],
};

// Per-reel weights for base_game (from /api/v2/slots
// weights.symbols_by_condition.base_game). Order matches the symbol_index
// array above.
const BASE_GAME_WEIGHTS: number[][] = [
  // reel 0
  [88, 92, 72, 65, 52, 42, 43, 39, 26, 8, 3],
  // reel 1
  [110903, 96200, 62000, 63000, 46000, 42000, 51000, 44000, 17000, 8000, 4900],
  // reel 2
  [734, 839, 520, 540, 460, 230, 470, 310, 351, 122, 55],
  // reel 3
  [64, 77, 52, 41, 31, 29, 42, 45, 27, 8, 5],
  // reel 4
  [82, 72, 74, 51, 52, 42, 63, 28, 31, 8, 5],
  // reel 5
  [480, 412, 360, 300, 265, 135, 320, 276, 62, 80, 18],
];

describe('Cryptographic Core — Known-Answer Tests', () => {
  it('SHA-256(hex_decode(serverSeed)) matches the published commitment hash', () => {
    assert.equal(hashServerSeed(KNOWN.serverSeed), KNOWN.serverSeedHashed);
  });

  it('rejects a tampered server seed (negative control)', () => {
    const tampered = KNOWN.serverSeed.slice(0, -1) + '0';
    assert.notEqual(hashServerSeed(tampered), KNOWN.serverSeedHashed);
  });

  it('outcome_index reproduces from (serverSeed, clientSeed, nonce)', () => {
    const oi = computeOutcomeIndex(KNOWN.serverSeed, KNOWN.clientSeed, KNOWN.nonce);
    assert.equal(oi, KNOWN.outcomeIndex);
    assert.equal(oi.toString(16).padStart(8, '0'), KNOWN.outcomeIndexHex);
  });

  it('outcome_index changes when client seed changes (negative control)', () => {
    const wrong = computeOutcomeIndex(KNOWN.serverSeed, 'pf_DIFFERENT_SEED', KNOWN.nonce);
    assert.notEqual(wrong, KNOWN.outcomeIndex);
  });

  it('outcome_index changes when nonce changes (negative control)', () => {
    const wrong = computeOutcomeIndex(KNOWN.serverSeed, KNOWN.clientSeed, KNOWN.nonce + 1);
    assert.notEqual(wrong, KNOWN.outcomeIndex);
  });

  it('outcome_index changes when server seed changes (negative control)', () => {
    const wrong = computeOutcomeIndex(KNOWN.serverSeed.slice(0, -1) + '0', KNOWN.clientSeed, KNOWN.nonce);
    assert.notEqual(wrong, KNOWN.outcomeIndex);
  });
});

describe('PCG32 PRNG — Known-Answer Tests', () => {
  it('produces a deterministic uint32 stream from a fixed seed', () => {
    const a = new Pcg32(0x12345678);
    const b = new Pcg32(0x12345678);
    const seqA = Array.from({ length: 16 }, () => a.nextUint32());
    const seqB = Array.from({ length: 16 }, () => b.nextUint32());
    assert.deepEqual(seqA, seqB);
  });

  it('different seeds produce different streams', () => {
    const a = new Pcg32(1).nextUint32();
    const b = new Pcg32(2).nextUint32();
    assert.notEqual(a, b);
  });

  it('all uint32 values fit in 32 bits', () => {
    const p = new Pcg32(0xdeadbeef);
    for (let i = 0; i < 100; i++) {
      const v = p.nextUint32();
      assert.ok(v >= 0 && v <= 0xFFFFFFFF, `out of range: ${v}`);
      assert.equal(v, v >>> 0);
    }
  });
});

describe('tumble_seed mix function', () => {
  it('is deterministic for fixed inputs', () => {
    const a = deriveTumbleSeed(123, 0, 0);
    const b = deriveTumbleSeed(123, 0, 0);
    assert.equal(a, b);
  });

  it('changes when round_index changes', () => {
    const a = deriveTumbleSeed(123, 0, 0);
    const b = deriveTumbleSeed(123, 1, 0);
    assert.notEqual(a, b);
  });

  it('changes when tumble_index changes', () => {
    const a = deriveTumbleSeed(123, 0, 0);
    const b = deriveTumbleSeed(123, 0, 1);
    assert.notEqual(a, b);
  });

  it('produces a uint32', () => {
    const v = deriveTumbleSeed(0xFFFFFFFF, 0xFFFF, 0xFFFF);
    assert.ok(v >= 0 && v <= 0xFFFFFFFF);
  });
});

describe('Weighted-pick rejection sampler', () => {
  it('returns 0 when only the first weight is non-zero', () => {
    const prng = new Pcg32(1);
    const idx = pickWeighted(prng, [100, 0, 0, 0]);
    assert.equal(idx, 0);
  });

  it('returns last index when only the last weight is non-zero', () => {
    const prng = new Pcg32(1);
    const idx = pickWeighted(prng, [0, 0, 0, 100]);
    assert.equal(idx, 3);
  });

  it('every draw is in valid range', () => {
    const weights = [10, 20, 30, 40];
    const prng = new Pcg32(0xcafebabe);
    for (let i = 0; i < 1000; i++) {
      const idx = pickWeighted(prng, weights);
      assert.ok(idx >= 0 && idx < weights.length);
    }
  });
});

describe('End-to-end grid reproduction (against captured /verify spin)', () => {
  it('reproduces the 30-cell grid byte-for-byte for bet 1964586', () => {
    const result = reproduceSpin({
      serverSeed:    KNOWN.serverSeed,
      clientSeed:    KNOWN.clientSeed,
      nonce:         KNOWN.nonce,
      roundIndex:    KNOWN.roundIndex,
      tumbleIndex:   KNOWN.tumbleIndex,
      weightsPerReel: BASE_GAME_WEIGHTS,
    });

    assert.equal(result.outcomeIndex, KNOWN.outcomeIndex);
    assert.deepEqual(result.grid, KNOWN.expectedGrid);
    assert.deepEqual(result.multipliers, [], 'base_game spin should have no multipliers');
  });

  it('a single-cell change in the seed flips many cells (avalanche)', () => {
    const tampered = KNOWN.serverSeed.slice(0, -1) + (KNOWN.serverSeed.slice(-1) === '0' ? '1' : '0');
    const result = reproduceSpin({
      serverSeed:    tampered,
      clientSeed:    KNOWN.clientSeed,
      nonce:         KNOWN.nonce,
      roundIndex:    KNOWN.roundIndex,
      tumbleIndex:   KNOWN.tumbleIndex,
      weightsPerReel: BASE_GAME_WEIGHTS,
    });
    let same = 0, total = 0;
    for (let col = 0; col < KNOWN.expectedGrid.length; col++) {
      for (let row = 0; row < KNOWN.expectedGrid[col].length; row++) {
        total++;
        if (result.grid[col][row] === KNOWN.expectedGrid[col][row]) same++;
      }
    }
    // With 11 symbols + per-reel skew the chance match rate is ~14%; any
    // tamper should knock at least half of the cells out of place.
    assert.ok(same < total * 0.6, `avalanche too weak: ${same}/${total} cells matched`);
  });
});
