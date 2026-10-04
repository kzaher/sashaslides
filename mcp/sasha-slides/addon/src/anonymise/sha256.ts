/**
 * sha256.ts — a dependency-free, synchronous SHA-256.
 *
 * WHY HAND-ROLLED. The substitution key stream (key-stream.ts) must be a pseudo-random FUNCTION of
 * `(seed, plaintext)`, not merely "random-looking". The character substitution picks a replacement
 * out of a small candidate set with the original EXCLUDED, so recovering the key stream is
 * equivalent to recovering the plaintext: a 32-bit hash plus xorshift would let a recipient who
 * knows the algorithm solve for the state from a few hundred observed characters and then invert
 * every run on the slide. That is the leak this whole module exists to prevent, so the derivation
 * has to be a real PRF.
 *
 * It cannot come from a library: these sources ship into the Apps Script sidebar iframe, which has
 * no `node:crypto`, and `crypto.subtle` is async-only while the anonymiser is a pure synchronous
 * function over strings (that purity is what lets the leak test enumerate thousands of cases in
 * plain node). So: FIPS 180-4, 60 lines, checked against the published vectors in sha256.test.ts.
 */

/** Lowercase hex digest of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return sha256Bytes(utf8Bytes(text))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The 32 digest bytes of `message`. */
export function sha256Bytes(message: readonly number[]): readonly number[] {
  const padded = padMessage(message);
  const state = [...INITIAL_STATE];
  const schedule = new Array<number>(64).fill(0);

  for (let blockStart = 0; blockStart < padded.length; blockStart += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = blockStart + index * 4;
      schedule[index] =
        (byteAt(padded, at) << 24) | (byteAt(padded, at + 1) << 16) | (byteAt(padded, at + 2) << 8) | byteAt(padded, at + 3);
    }
    for (let index = 16; index < 64; index += 1) {
      const fifteen = wordAt(schedule, index - 15);
      const two = wordAt(schedule, index - 2);
      const sigma0 = rotateRight(fifteen, 7) ^ rotateRight(fifteen, 18) ^ (fifteen >>> 3);
      const sigma1 = rotateRight(two, 17) ^ rotateRight(two, 19) ^ (two >>> 10);
      schedule[index] = (wordAt(schedule, index - 16) + sigma0 + wordAt(schedule, index - 7) + sigma1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = [
      wordAt(state, 0),
      wordAt(state, 1),
      wordAt(state, 2),
      wordAt(state, 3),
      wordAt(state, 4),
      wordAt(state, 5),
      wordAt(state, 6),
      wordAt(state, 7),
    ];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + wordAt(ROUND_CONSTANTS, index) + wordAt(schedule, index)) | 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    const round = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) state[index] = (wordAt(state, index) + wordAt(round, index)) | 0;
  }

  const digest: number[] = [];
  for (const word of state) {
    digest.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  return digest;
}

/**
 * UTF-8 bytes of `text`. Written out rather than taken from `TextEncoder` so the module has one
 * behaviour in node, in the sidebar iframe and in a converter staging frame alike. Lone surrogates
 * (a string sliced through an astral pair) become U+FFFD, which is what TextEncoder does too.
 */
export function utf8Bytes(text: string): readonly number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0xfffd;
    const point = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code;
    if (point < 0x80) {
      bytes.push(point);
      continue;
    }
    if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
      continue;
    }
    if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      continue;
    }
    bytes.push(
      0xf0 | (point >> 18),
      0x80 | ((point >> 12) & 0x3f),
      0x80 | ((point >> 6) & 0x3f),
      0x80 | (point & 0x3f),
    );
  }
  return bytes;
}

const INITIAL_STATE: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

/** FIPS 180-4 5.1.1: a 0x80 byte, zeroes to 56 mod 64, then the length in bits, big-endian. */
function padMessage(message: readonly number[]): readonly number[] {
  const bitLength = message.length * 8;
  const padded = [...message, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  // A slide document is far below 2^32 bits, so the high word is always zero — but write it anyway,
  // because a wrong length field is a silent wrong digest rather than a crash.
  const high = Math.floor(bitLength / 0x100000000);
  padded.push(
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
    (bitLength >>> 24) & 0xff,
    (bitLength >>> 16) & 0xff,
    (bitLength >>> 8) & 0xff,
    bitLength & 0xff,
  );
  return padded;
}

function rotateRight(word: number, bits: number): number {
  return (word >>> bits) | (word << (32 - bits));
}

/**
 * `noUncheckedIndexedAccess` is on, and these two readers are the whole reason the loops above stay
 * readable: every index below is bounded by the loop that produced it.
 */
function byteAt(bytes: readonly number[], index: number): number {
  return bytes[index] ?? 0;
}

function wordAt(words: readonly number[], index: number): number {
  return words[index] ?? 0;
}
