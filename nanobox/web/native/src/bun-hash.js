// Bun.hash — the bundle hashes skill/prompt text and message content with it and puts the result in
// on-disk cache keys (`Bun.hash(x).toString(36)`), so the only contract that matters here is: same
// input, same value, for the lifetime of a cache directory. It does NOT have to be Bun's wyhash —
// nothing reads those keys back with a real Bun. What it does have to be is fast and 64-bit-ish:
// hashing runs on serialized messages, and a 32-bit value collides at ~77k keys (birthday bound).
// So: two xxHash32 lanes with decorrelated seeds, packed into the 53 bits a JS number holds exactly
// — the type `Bun.hash()` itself returns (call sites also accept a bigint, hence the `typeof` checks
// around them in the bundle).

const encoder = new TextEncoder();

export function bunHash(input, seed) {
  const bytes = toBytes(input);
  const base = seedOf(seed);
  const high = xxHash32(bytes, base);
  const low = xxHash32(bytes, (base ^ 0x9e3779b1) >>> 0);
  return high * 0x200000 + (low >>> 11); // 32 + 21 = 53 bits, exact as a double
}

// The 32-bit checksums of Bun.hash's namespace that are cheap to provide honestly; the 64-bit named
// ones (wyhash, cityHash64, …) are left to the recorder rather than aliased onto the lanes above,
// because a member named after a published algorithm should produce that algorithm's values.
bunHash.crc32 = function crc32(input) {
  const bytes = toBytes(input);
  let hash = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) hash = CRC_TABLE[(hash ^ bytes[index]) & 0xff] ^ (hash >>> 8);
  return (hash ^ 0xffffffff) >>> 0;
};

bunHash.adler32 = function adler32(input) {
  const bytes = toBytes(input);
  let a = 1, b = 0;
  for (let index = 0; index < bytes.length; index++) { a = (a + bytes[index]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
};

function toBytes(input) {
  if (typeof input === "string") return encoder.encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return encoder.encode(String(input));
}

// a seed is often a previous Bun.hash result (53 bits) or a bigint; fold either onto 32 bits
function seedOf(seed) {
  if (seed === undefined || seed === null) return 0;
  if (typeof seed === "bigint") return Number(BigInt.asUintN(32, seed)) >>> 0;
  const value = Number(seed);
  if (!Number.isFinite(value)) return 0;
  return ((value >>> 0) ^ (Math.floor(Math.abs(value) / 4294967296) >>> 0)) >>> 0;
}

const P1 = 0x9e3779b1, P2 = 0x85ebca77, P3 = 0xc2b2ae3d, P4 = 0x27d4eb2f, P5 = 0x165667b1;

function xxHash32(bytes, seed) {
  const length = bytes.length;
  let index = 0, hash;
  if (length >= 16) {
    let v1 = (seed + P1 + P2) | 0, v2 = (seed + P2) | 0, v3 = seed | 0, v4 = (seed - P1) | 0;
    const limit = length - 16;
    while (index <= limit) {
      v1 = accumulate(v1, read32(bytes, index)); index += 4;
      v2 = accumulate(v2, read32(bytes, index)); index += 4;
      v3 = accumulate(v3, read32(bytes, index)); index += 4;
      v4 = accumulate(v4, read32(bytes, index)); index += 4;
    }
    hash = (rotate(v1, 1) + rotate(v2, 7) + rotate(v3, 12) + rotate(v4, 18)) | 0;
  } else hash = (seed + P5) | 0;
  hash = (hash + length) | 0;
  while (index + 4 <= length) {
    hash = Math.imul(rotate((hash + Math.imul(read32(bytes, index), P3)) | 0, 17), P4) | 0;
    index += 4;
  }
  while (index < length) {
    hash = Math.imul(rotate((hash + Math.imul(bytes[index], P5)) | 0, 11), P1) | 0;
    index++;
  }
  hash ^= hash >>> 15; hash = Math.imul(hash, P2);
  hash ^= hash >>> 13; hash = Math.imul(hash, P3);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function accumulate(lane, value) { return Math.imul(rotate((lane + Math.imul(value, P2)) | 0, 13), P1) | 0; }
function rotate(value, bits) { return (value << bits) | (value >>> (32 - bits)); }
function read32(bytes, at) { return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) | 0; }

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
