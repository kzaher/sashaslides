#!/usr/bin/env node
// Unit test of the claude-native target of the first-run installer (web/native/installer.js) WITHOUT
// the network: a stub of downloads.claude.ai served from a local copy of the Bun standalone executable
// (work/bun/claude-bun.bin — `node tools/bun-extract.mjs` produced it). Checks the URL sequence, the
// Range request, the layout in the tree, the recorded provenance, the bigger-slice fallback and the
// cache round trip.
//   node test/claude-native-unit.mjs [--bin work/bun/claude-bun.bin] [--no-full]
//     --no-full   skip the opts.verifyFull case (which hashes the whole 324 MB binary)
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const BIN = opt("--bin", join(HERE, "../work/bun/claude-bun.bin"));
const FULL = !argv.includes("--no-full");
if (!existsSync(BIN)) { console.error(`no stand-in binary at ${BIN} — download one with:\n  curl -o ${BIN} https://downloads.claude.ai/claude-code-releases/$(curl -s https://downloads.claude.ai/claude-code-releases/latest)/linux-x64/claude`); process.exit(2); }
await import(join(HERE, "../web/wasifs.js"));
await import(join(HERE, "../web/oci.js"));
await import(join(HERE, "../web/native/bunfs.js"));
await import(join(HERE, "../web/native/installer.js"));
const { NanoboxInstaller: I, NanoboxFs: F, NanoboxBunFs: B } = globalThis;

// ---- the stand-in vendor: downloads.claude.ai out of the local binary ------------------------------
const SIZE = statSync(BIN).size;
const VERSION = "2.1.233";
const RELEASES = "https://downloads.claude.ai/claude-code-releases";
const BIN_URL = `${RELEASES}/${VERSION}/linux-x64/claude`;
const wholeSha256 = createHash("sha256").update(readFileSync(BIN)).digest("hex");
const readRange = (start, end) => { const fd = openSync(BIN, "r"); const buf = Buffer.alloc(end - start + 1); readSync(fd, buf, 0, buf.length, start); closeSync(fd); return buf; };
const requests = [];
function vendor(url, init) {
  const range = ((init && init.headers && (init.headers.Range || init.headers.range)) || "").trim();
  requests.push({ url, range });
  if (url === RELEASES + "/latest") return new Response(VERSION + "\n", { status: 200 });
  if (url === `${RELEASES}/${VERSION}/manifest.json`) return new Response(JSON.stringify({ version: VERSION, platforms: { "linux-x64": { binary: "claude", checksum: wholeSha256, size: SIZE } } }), { status: 200 });
  if (url !== BIN_URL) return new Response("not found", { status: 404 });
  if (!range) return new Response(readRange(0, SIZE - 1), { status: 200 });
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return new Response("bad range", { status: 416 });
  const [start, end] = m[1] === "" ? [SIZE - Number(m[2]), SIZE - 1] : [Number(m[1]), m[2] === "" ? SIZE - 1 : Number(m[2])];
  return new Response(readRange(start, end), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${SIZE}` } });
}
const noNet = (what) => (u) => { throw new Error(`${what} must not be fetched here: ${u}`); };

// the truth to compare against, straight out of the binary
const truthMods = B.modules(readRange(Math.max(0, SIZE - B.SEARCH_TAIL_BYTES), SIZE - 1));
const truthEntry = B.entry(truthMods);
const entrySha256 = createHash("sha256").update(Buffer.from(truthEntry.bytes())).digest("hex");

let bad = 0;
const check = (ok, what, detail) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? "  " + detail : ""}`); if (!ok) bad++; };

// ---- cold install ---------------------------------------------------------------------------------
const store = new Map(), metaStore = new Map();
const have = async (key) => store.get(key) || null;
const haveMeta = async (key) => metaStore.get(key) || null;
const keep = async (key, pkg) => { store.set(key, pkg.tar); metaStore.set(key, JSON.parse(JSON.stringify(pkg.meta))); };
let t = performance.now();
const cold = await I.install(["claude-native"], { noNode: true, have, haveMeta, keep, fetch: noNet("the registry"), relay: vendor, onProgress: () => {} });
const coldMs = Math.round(performance.now() - t);
const pkg = cold.packages[0];
console.log(`cold install: ${coldMs} ms, ${(cold.stats.relayed / 1e6).toFixed(1)} MB relayed of the ${(SIZE / 1e6).toFixed(0)} MB binary, tar ${(pkg.tar.length / 1e6).toFixed(1)} MB (${pkg.files} files, ${(pkg.unpackedBytes / 1e6).toFixed(1)} MB unpacked)`);
check(requests.length === 3, "three vendor requests (latest, manifest.json, the binary)", requests.map((r) => r.url.replace(RELEASES, "…") + (r.range ? " " + r.range : "")).join(" | "));
check(requests[2].range === `bytes=${SIZE - B.SEARCH_TAIL_BYTES}-${SIZE - 1}`, "the binary is range-fetched, tail only", requests[2].range);
check(cold.stats.relayed < SIZE * 0.25, "a fraction of the binary on the wire", `${(cold.stats.relayed / 1e6).toFixed(1)} of ${(SIZE / 1e6).toFixed(0)} MB`);
check(pkg.key === `pkg-claude-native@${VERSION}` && pkg.version === VERSION, "package key carries the resolved version", pkg.key);

// ---- the layout in the tree -----------------------------------------------------------------------
const root = F.dir();
I.applyPackage(root, pkg);
const ENTRY = "usr/local/lib/claude-native/cli.js";
const entry = F.lookup(root, ENTRY);
check(!!entry && entry.t === "f" && entry.data.byteLength === truthEntry.len, `${ENTRY} = the entry module verbatim`, entry ? `${entry.data.byteLength} B` : "missing");
check(!!entry && B.unwrapCjs(new TextDecoder().decode(entry.data.subarray(0, 200))).wrapped, "…and it is still Bun's CJS wrapper (no transform)");
const launcher = F.lookup(root, "usr/local/bin/claude");
check(!!launcher && launcher.t === "f" && (launcher.mode & 0o111) !== 0 && new TextDecoder().decode(launcher.data) === `#!/bin/sh\nexec /bundle/nb/node /${ENTRY} "$@"\n`, "usr/local/bin/claude is a 755 launcher for the shim", launcher ? JSON.stringify(new TextDecoder().decode(launcher.data)) : "missing");
for (const m of truthMods) {
  if (m === truthEntry) continue;
  const p = m.name.replace(/^\/+/, "");
  const n = F.lookup(root, p);
  check(!!n && n.t === "f" && n.data.byteLength === m.len, `/${p} (${m.len} B)`, n ? `${n.data.byteLength} B` : "missing");
}

// ---- the recorded provenance (the whole-file checksum cannot be checked from a slice) --------------
const src = pkg.meta.source;
check(pkg.meta.kind === "files" && pkg.meta.version === VERSION, "meta: kind files, version recorded", pkg.meta.version);
check(src.range.start === SIZE - B.SEARCH_TAIL_BYTES && src.range.end === SIZE - 1 && src.range.of === SIZE, "meta: the exact byte range", JSON.stringify(src.range));
check(src.entry.sha256 === entrySha256, "meta: sha256 of the extracted entry", src.entry.sha256.slice(0, 16) + "…");
check(src.fileSha256 === wholeSha256 && src.fileSha256Verified === false, "meta: the vendor's whole-file sha256 recorded but NOT verified");

// ---- warm: nothing is fetched ---------------------------------------------------------------------
requests.length = 0;
t = performance.now();
const warm = await I.install(["claude-native"], { noNode: true, have, haveMeta, keep, fetch: noNet("the registry"), relay: noNet("the vendor") });
console.log(`warm install: ${Math.round(performance.now() - t)} ms`);
check(requests.length === 0 && warm.stats.downloads.length === 0 && warm.stats.fromCache === 1, "warm install downloads nothing");
check(warm.packages[0].meta.source.entry.sha256 === entrySha256, "warm install reports the stored provenance");
const warmRoot = F.dir(); const warmApplied = I.applyPackage(warmRoot, warm.packages[0]);
check(warmApplied.files === pkg.files && !!F.lookup(warmRoot, ENTRY), "warm install lays out the same tree", `${warmApplied.files} files`);

// ---- a tail too small: the installer retries with a bigger slice ------------------------------------
{
  const saved = B.SEARCH_TAIL_BYTES;
  B.SEARCH_TAIL_BYTES = 12 * 1024 * 1024;   // the sources start ~36 MB before EOF: the first slice misses them
  requests.length = 0;
  const retry = await I.install(["claude-native"], { noNode: true, have: async (k) => (k.endsWith("-manifest") ? store.get(k) || null : null), haveMeta, keep: async () => {}, fetch: noNet("the registry"), relay: vendor });
  B.SEARCH_TAIL_BYTES = saved;
  const ranges = requests.filter((r) => r.url === BIN_URL).map((r) => r.range);
  check(ranges.length === 2 && ranges[0] === `bytes=${SIZE - 12 * 1024 * 1024}-${SIZE - 1}` && ranges[1] === `bytes=${SIZE - 48 * 1024 * 1024}-${SIZE - 1}`, "a slice without the entry is retried 4x bigger", ranges.join(" then "));
  check(retry.packages[0].meta.install.entry === "/" + ENTRY, "…and the retry finds the entry");
}

// ---- opts.verifyFull: the whole binary, checked against the vendor's sha256 --------------------------
if (FULL) {
  requests.length = 0;
  t = performance.now();
  const full = await I.install(["claude-native"], { noNode: true, verifyFull: true, have: async (k) => (k.endsWith("-manifest") ? store.get(k) || null : null), haveMeta, keep: async () => {}, fetch: noNet("the registry"), relay: vendor });
  console.log(`verifyFull install: ${Math.round(performance.now() - t)} ms`);
  const s = full.packages[0].meta.source;
  check(requests.some((r) => r.url === BIN_URL && !r.range), "verifyFull fetches the whole binary");
  check(s.fileSha256Verified === true && s.range.whole === true, "verifyFull verifies the vendor's whole-file sha256");
  let threw = null;
  const badVendor = (u, init) => (u === `${RELEASES}/${VERSION}/manifest.json` ? new Response(JSON.stringify({ version: VERSION, platforms: { "linux-x64": { binary: "claude", checksum: "0".repeat(64), size: SIZE } } }), { status: 200 }) : vendor(u, init));
  try { await I.install(["claude-native"], { noNode: true, verifyFull: true, have: async () => null, haveMeta, keep: async () => {}, fetch: noNet("the registry"), relay: badVendor }); } catch (e) { threw = e; }
  check(!!threw && /sha256 mismatch/.test(String(threw.message)), "verifyFull rejects a wrong checksum", threw ? String(threw.message).slice(0, 60) : "no throw");
} else console.log("  (verifyFull case skipped: --no-full)");

console.log(bad ? `FAILED (${bad})` : "ALL OK");
process.exit(bad ? 1 : 0);
