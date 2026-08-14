// Deterministic, synchronous content hash for change detection.
//
// Why not SubtleCrypto? It's async and browser/Node signatures differ, which makes the sync
// engine and its tests async-tangled for no real benefit here — this hash only needs to detect
// "did the bytes change", not resist adversaries. Two independent FNV-1a streams + the length
// give a 64-bit-ish fingerprint; collision odds are negligible for a personal file tree.
//
// PRODUCTION NOTE: if you ever sync untrusted content where a deliberate collision could hide a
// change, swap this for `crypto.subtle.digest('SHA-256', bytes)` (both Node 20+ and browsers have
// it on globalThis.crypto) and make snapshot() async throughout.

import { toBytes } from "./util.js";

export function hashBytes(input) {
  const bytes = toBytes(input);
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ ((b + i) & 0xff), 0x01000193);
  }
  h1 >>>= 0;
  h2 >>>= 0;
  return (
    h1.toString(16).padStart(8, "0") +
    h2.toString(16).padStart(8, "0") +
    ":" + bytes.length
  );
}
