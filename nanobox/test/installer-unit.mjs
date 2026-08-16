#!/usr/bin/env node
// Unit test of the first-run installer (web/native/installer.js) in node: real downloads from the
// vendors (registry.npmjs.org direct; the agy manifest/tarball fetched directly here — in the browser
// they go through the /net/fetch relay), integrity check, layout like `npm -g`, cache round trip.
//   node test/installer-unit.mjs [claude,codex,agy] [--sharp]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
await import(join(HERE, "../web/wasifs.js")); await import(join(HERE, "../web/oci.js")); await import(join(HERE, "../web/native/installer.js"));
const { NanoboxInstaller: I, NanoboxFs: F } = globalThis;
const clis = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "claude,codex,agy").split(",");
const sharp = process.argv.includes("--sharp");
const mem = new Map(); const have = async (k) => mem.get(k) || null, keep = async (k, p) => { mem.set(k, p.tar); };
const log = (p) => console.log("  " + JSON.stringify(p).slice(0, 200));
let t = performance.now();
const r1 = await I.install(clis, { have, keep, relay: (u) => fetch(u), onProgress: log, sharp });
console.log(`install #1: ${Math.round(performance.now() - t)} ms; direct ${(r1.stats.direct / 1e6).toFixed(1)} MB, relayed ${(r1.stats.relayed / 1e6).toFixed(1)} MB, ${r1.stats.packages} packages`);
const root = F.dir(); let files = 0;
for (const p of r1.packages) { const r = I.applyPackage(root, p); files += r.files; console.log(`  ${p.key}: ${p.files} files, ${(p.unpackedBytes / 1e6).toFixed(1)} MB unpacked, tar ${(p.tar.length / 1e6).toFixed(1)} MB, download ${(p.download.bytes / 1e6).toFixed(1)} MB in ${p.download.ms} ms (${p.download.integrity || "cache"})`); }
const must = [["usr/local/bin/node", "f", 0o755], ["usr/local/include/node/node.h", "f"], ["usr/local/package.json", null], ["usr/local/lib/node_modules/npm/bin/npm-cli.js", "f", 0o755], ["usr/local/bin/npm", "l", "../lib/node_modules/npm/bin/npm-cli.js"], ["usr/local/bin/npx", "l", "../lib/node_modules/npm/bin/npx-cli.js"]];
if (clis.includes("claude")) must.push(["usr/local/bin/claude", "l", "../lib/node_modules/@anthropic-ai/claude-code/cli.js"], ["usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "f", 0o755], ["usr/local/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-linux/rg", "f"], ["usr/local/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-linux/rg", null]);
if (clis.includes("codex")) must.push(["usr/local/bin/codex", "l", "../lib/node_modules/@openai/codex/bin/codex.js"], ["usr/local/lib/node_modules/@openai/codex/bin/codex.js", "f", 0o755], ["usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex", "f", 0o755], ["usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/package.json", "f"], ["usr/local/bin/codex-linux-x64", null]);
if (clis.includes("agy")) must.push(["usr/local/bin/agy", "f", 0o755]);
if (sharp) must.push(["usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@img/sharp-linux-x64/package.json", "f"], ["usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.42", "f"]);
let bad = 0;
for (const [p, t, x] of must) {
  const n = F.lookup(root, p);
  const ok = t === null ? !n : n && n.t === t && (t === "l" ? n.target === x : x == null || ((n.mode != null ? n.mode : 0o644) & 0o111) !== 0);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${p} ${n ? n.t + (n.t === "l" ? " -> " + n.target : n.t === "f" ? " " + n.data.byteLength + " B mode " + ((n.mode != null ? n.mode : 0o644).toString(8)) : "") : "(missing)"}`);
  if (!ok) bad++;
}
// cache round trip: nothing downloaded the second time
t = performance.now();
const r2 = await I.install(clis, { have, keep, relay: () => { throw new Error("relay must not be called on a warm install"); }, fetch: () => { throw new Error("fetch must not be called on a warm install"); }, sharp });
console.log(`install #2 (warm): ${Math.round(performance.now() - t)} ms; fromCache ${r2.stats.fromCache}/${r2.stats.packages}, downloads ${r2.stats.downloads.length}`);
if (r2.stats.fromCache !== r2.stats.packages || r2.stats.downloads.length) bad++;
for (const p of r2.packages) { const rr = I.applyPackage(F.dir(), p); if (rr.files !== p.files) { console.log("FAIL file count differs on re-apply " + p.key); bad++; } }
// journal: guest-write records with whiteouts, compaction, re-apply
{
  const persist = F.dir(); F.add(persist, "root/.claude.json", { data: new TextEncoder().encode("{}") }); F.add(persist, "root/tmp/x", { data: new Uint8Array(3) });
  const bundle = F.dir(); bundle.e.set("persist", persist);
  const j1 = I.tar.pack(I.journal.entries(bundle, { op: "write", path: ["persist", "root", ".claude.json"] }));
  F.remove(persist, "root/tmp/x");
  const j2 = I.tar.pack(I.journal.entries(bundle, { op: "remove", path: ["persist", "root", "tmp", "x"] }));
  F.add(persist, "root/.claude/settings.json", { data: new TextEncoder().encode("s") });
  const j3 = I.tar.pack(I.journal.entries(bundle, { op: "rename", path: ["persist", "root", "old"], to: ["persist", "root", ".claude", "settings.json"] }));
  const re = F.dir(); F.add(re, "root/tmp/x", { data: new Uint8Array(3) }); F.add(re, "root/old", { data: new Uint8Array(1) });
  for (const t of [j1, j2, j3]) globalThis.NanoboxOci.applyLayer(re, t);
  const ok1 = F.lookup(re, "root/.claude.json") && !F.lookup(re, "root/tmp/x") && !F.lookup(re, "root/old") && F.lookup(re, "root/.claude/settings.json");
  console.log(`  ${ok1 ? "ok  " : "FAIL"} journal apply (write, remove whiteout, rename)`); if (!ok1) bad++;
  const c = I.journal.compact([j1, j2, j3]); const re2 = F.dir(); F.add(re2, "root/tmp/x", { data: new Uint8Array(3) }); F.add(re2, "root/old", { data: new Uint8Array(1) }); globalThis.NanoboxOci.applyLayer(re2, c);
  const ok2 = F.lookup(re2, "root/.claude.json") && !F.lookup(re2, "root/tmp/x") && !F.lookup(re2, "root/old") && F.lookup(re2, "root/.claude/settings.json") && c.byteLength < j1.byteLength + j2.byteLength + j3.byteLength;
  console.log(`  ${ok2 ? "ok  " : "FAIL"} journal compaction (${c.byteLength} B from ${j1.byteLength + j2.byteLength + j3.byteLength} B)`); if (!ok2) bad++;
}
console.log(bad ? `FAILED (${bad})` : "ALL OK", `(${files} files in the tree)`);
process.exit(bad ? 1 : 0);
