#!/usr/bin/env node
// bundle-diff.mjs — compare two JIT bundles (--jit-bundle-out files): how many of B's modules would
// be served from A (same content key), how many are byte-identical translations filed under a
// DIFFERENT key (the key hashes something the translation does not depend on -> the engine's key
// is over-specific), and how many are genuinely new. Also prints a bundle's summary when given one.
//
//   node bundle-diff.mjs A.nbjb [B.nbjb]
import fs from "node:fs";
import crypto from "node:crypto";
await import("../web/jit-bundle.js");
const files = process.argv.slice(2);
if (!files.length) { console.error("usage: bundle-diff.mjs A.nbjb [B.nbjb]"); process.exit(2); }
const load = (f) => { const b = NanoboxJitBundle.decode(fs.readFileSync(f)); b.file = f; return b; };
const keyOf = (m) => m.funcKeys.map(([lo, hi]) => NanoboxJitBundle.keyString(lo, hi)).join(",");
const sha = (m) => crypto.createHash("sha1").update(m.bytes).digest("hex");
const summary = (b) => {
  const bytes = b.modules.reduce((n, m) => n + m.bytes.length, 0), funcs = b.modules.reduce((n, m) => n + m.funcKeys.length, 0);
  const batch = b.modules.filter((m) => m.funcKeys.length > 1).length;
  console.log(`${b.file}: engine ${b.tag}, ${b.modules.length} modules (${batch} multi-function), ${funcs} functions, ${(bytes / 1e6).toFixed(2)} MB of wasm, link fn @${b.linkSlot || "none"}`);
};
const A = load(files[0]); summary(A);
if (files.length < 2) process.exit(0);
const B = load(files[1]); summary(B);
if (A.tag !== B.tag) console.log("(different engine builds: keys/bytes are not comparable)");
const aKeys = new Map(A.modules.map((m) => [keyOf(m), m])), aBytes = new Map(A.modules.map((m) => [sha(m), m]));
let sameKey = 0, sameKeyDiffBytes = 0, sameBytesDiffKey = 0, fresh = 0;
for (const m of B.modules) {
  const a = aKeys.get(keyOf(m));
  if (a) { sameKey++; if (sha(a) !== sha(m)) sameKeyDiffBytes++; continue; }
  if (aBytes.has(sha(m))) sameBytesDiffKey++; else fresh++;
}
console.log(`B vs A: ${sameKey} same key (${sameKeyDiffBytes} of them with DIFFERENT bytes = key collision or non-deterministic compile), ${sameBytesDiffKey} byte-identical translations under a different key, ${fresh} new`);
