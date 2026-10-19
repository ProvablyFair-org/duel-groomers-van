/**
 * Pure-JS HMAC-SHA256 — browser-compatible port of Node's `crypto.createHmac`.
 *
 * Chosen over Web Crypto's async `SubtleCrypto.sign()` because this tool runs
 * tight loops (bulk mode: up to 10,000 nonces × 16 rows = 160,000 HMACs) where
 * Promise overhead is prohibitive.
 *
 * Matches the reference implementation used in all ProvablyFair.org audit
 * repos:  crypto.createHmac('sha256', key).update(message).digest('hex')
 */

// ── SHA-256 ─────────────────────────────────────────────────────────────────
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function sha256Bytes(bytes) {
  // Padding
  const len = bytes.length;
  const bitLen = len * 8;
  const padLen = ((len + 9 + 63) & ~63) - len;
  const padded = new Uint8Array(len + padLen);
  padded.set(bytes);
  padded[len] = 0x80;
  // Write bit length as big-endian 64-bit at the tail
  padded[padded.length - 4] = (bitLen >>> 24) & 0xff;
  padded[padded.length - 3] = (bitLen >>> 16) & 0xff;
  padded[padded.length - 2] = (bitLen >>> 8) & 0xff;
  padded[padded.length - 1] = bitLen & 0xff;

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  const W = new Uint32Array(64);
  const blocks = padded.length / 64;

  for (let b = 0; b < blocks; b++) {
    const off = b * 64;
    for (let i = 0; i < 16; i++) {
      W[i] = (padded[off + i * 4] << 24) |
             (padded[off + i * 4 + 1] << 16) |
             (padded[off + i * 4 + 2] << 8) |
             (padded[off + i * 4 + 3]);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }

    let a = H[0], bb = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = bb; bb = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4]     = (H[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >>> 8)  & 0xff;
    out[i * 4 + 3] = H[i] & 0xff;
  }
  return out;
}

// ── Encoding helpers ────────────────────────────────────────────────────────
function utf8ToBytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      // Surrogate pair
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(b)) throw new Error('invalid hex');
    out[i] = b;
  }
  return out;
}

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}

// ── HMAC-SHA256 ─────────────────────────────────────────────────────────────
const BLOCK_SIZE = 64;

/**
 * HMAC-SHA256. Returns hex digest.
 *
 * `key` must be a Uint8Array (typically `hexToBytes(serverSeed)` to match
 * Node's `Buffer.from(serverSeed, 'hex')`).
 */
export function hmacSha256Hex(key, message) {
  let k = key;
  if (k.length > BLOCK_SIZE) k = sha256Bytes(k);

  const paddedKey = new Uint8Array(BLOCK_SIZE);
  paddedKey.set(k);

  const oKey = new Uint8Array(BLOCK_SIZE);
  const iKey = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    oKey[i] = paddedKey[i] ^ 0x5c;
    iKey[i] = paddedKey[i] ^ 0x36;
  }

  const msgBytes = typeof message === 'string' ? utf8ToBytes(message) : message;

  const inner = new Uint8Array(iKey.length + msgBytes.length);
  inner.set(iKey);
  inner.set(msgBytes, iKey.length);
  const innerHash = sha256Bytes(inner);

  const outer = new Uint8Array(oKey.length + innerHash.length);
  outer.set(oKey);
  outer.set(innerHash, oKey.length);

  return bytesToHex(sha256Bytes(outer));
}

// ── Plain SHA-256 (for commit-reveal hash verification) ────────────────────

/**
 * SHA-256 of a byte array, returned as a 64-char hex digest.
 *
 * Used for commit-reveal verification: the casino publishes
 *   serverSeedHashed = sha256(hexBytes(serverSeed))
 * before the bet, and reveals `serverSeed` after. To verify, hex-decode
 * the revealed seed and pass the bytes here, then compare against the
 * published hash. See games/{game}/derive.js for usage in source code displays.
 */
export function sha256Hex(bytes) {
  return bytesToHex(sha256Bytes(bytes));
}
