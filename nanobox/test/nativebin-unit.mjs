#!/usr/bin/env node
// Unit test of the installer's `nativebin` package kind (web/native/installer.js) — the one that
// installs the CURRENT Claude Code as the vendor's own linux-x64 EXECUTABLE for the emulated guest
// (cli key `claude-bin`), instead of extracting its JavaScript out of the Bun standalone.
//
// The real binary is ~246 MB, so the vendor's three endpoints (/latest, /<v>/manifest.json,
// /<v>/linux-x64/claude) are stubbed here with a few bytes: what is under test is the resolve ->
// verify -> place -> cache chain and, above all, that a checksum that does NOT match is REFUSED.
//   node test/nativebin-unit.mjs
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
await import(join(HERE, "../web/wasifs.js")); await import(join(HERE, "../web/oci.js")); await import(join(HERE, "../web/native/installer.js"));
const { NanoboxInstaller: I, NanoboxFs: F } = globalThis;

const VERSION = "9.9.9";
const RELEASES = "https://downloads.claude.ai/claude-code-releases";
// a stand-in for the ELF: binary, with NULs, so the tar round trip is tested on non-text bytes
const BINARY = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 256);
const SHA256 = createHash("sha256").update(BINARY).digest("hex");

let bad = 0;
const check = (ok, what, detail) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? " — " + detail : ""}`); if (!ok) bad++; };

// a relay stub for the vendor's three endpoints; `checksum` is what the manifest will claim
function relayFor({ checksum, size }) {
  const calls = [];
  const reply = (body) => new Response(body, { status: 200 });
  const relay = async (url) => {
    calls.push(String(url));
    if (url === RELEASES + "/latest") return reply(VERSION + "\n");
    if (url === `${RELEASES}/${VERSION}/manifest.json`) return reply(JSON.stringify({ version: VERSION, platforms: { "linux-x64": { binary: "claude", checksum, size } } }));
    if (url === `${RELEASES}/${VERSION}/linux-x64/claude`) return reply(BINARY);
    throw new Error("unexpected relay url " + url);
  };
  return { relay, calls };
}
// one cold install of claude-bin against a given manifest claim
async function installColdly({ checksum, size, store }) {
  const { relay, calls } = relayFor({ checksum, size });
  const mem = store || new Map();
  const r = await I.install(["claude-bin"], {
    noNode: true, relay, fetch: () => { throw new Error("nativebin must not use a direct fetch (downloads.claude.ai answers no CORS)"); },
    have: async (k) => mem.get(k) || null, keep: async (k, p) => { mem.set(k, p.tar); },
    haveMeta: async () => null,
  });
  return { result: r, calls, mem };
}

// 1. the happy path: resolve, verify against the manifest's sha256, place the executable
{
  const { result, calls, mem } = await installColdly({ checksum: SHA256, size: BINARY.length });
  const pkg = result.packages[0];
  check(result.packages.length === 1 && pkg.cli === "claude-bin", "one package for claude-bin", pkg && pkg.key);
  check(pkg.version === VERSION, "version from /latest", pkg.version);
  check(pkg.meta.kind === "nativebin", "package kind", pkg.meta.kind);
  check(pkg.meta.source.fileSha256 === SHA256 && pkg.meta.source.fileSha256Verified === true, "whole-file sha256 recorded as verified");
  check(calls.length === 3, "three relay requests (latest, manifest, binary)", calls.join(" "));
  const root = F.dir(); I.applyPackage(root, pkg);
  const bin = F.lookup(root, "usr/local/bin/claude");
  check(!!bin && bin.t === "f", "usr/local/bin/claude is a regular file (not a launcher symlink)");
  check(!!bin && bin.mode === 0o755, "mode 0755", bin && bin.mode != null ? bin.mode.toString(8) : "none");
  check(!!bin && bin.data.byteLength === BINARY.length && Buffer.compare(Buffer.from(bin.data), Buffer.from(BINARY)) === 0, "the installed bytes are the downloaded binary, byte for byte");
  check(!F.lookup(root, "usr/local/lib/claude-native"), "no claude-native JS tree and no $bunfs modules");

  // 2. warm: the stored package is reused and nothing is fetched
  const warm = await I.install(["claude-bin"], {
    noNode: true, have: async (k) => mem.get(k) || null, keep: async () => {}, haveMeta: async () => null,
    relay: () => { throw new Error("relay must not be called on a warm install"); },
    fetch: () => { throw new Error("fetch must not be called on a warm install"); },
  });
  check(warm.stats.fromCache === 1 && warm.stats.downloads.length === 0, "warm install downloads nothing", JSON.stringify(warm.stats.downloads));
  const warmRoot = F.dir(); I.applyPackage(warmRoot, warm.packages[0]);
  const warmBin = F.lookup(warmRoot, "usr/local/bin/claude");
  check(!!warmBin && warmBin.mode === 0o755 && warmBin.data.byteLength === BINARY.length, "the cached package lays out the same executable");
}

// 3. a checksum that does not match must FAIL, and must not store anything
{
  const wrong = "0".repeat(64);
  const store = new Map();
  let message = null;
  try { await installColdly({ checksum: wrong, size: BINARY.length, store }); } catch (e) { message = String(e && e.message || e); }
  check(!!message && /sha256 mismatch/.test(message), "a wrong checksum is refused", message);
  check(![...store.keys()].some((k) => k.includes("@" + VERSION)), "nothing was stored for the rejected version", [...store.keys()].join(" "));
}

// 4. a manifest without a checksum must FAIL (never install unverified bytes)
{
  let message = null;
  try { await installColdly({ checksum: null, size: BINARY.length }); } catch (e) { message = String(e && e.message || e); }
  check(!!message && /no checksum/.test(message), "a manifest without a checksum is refused", message);
}

// 5. a size the manifest disagrees with must FAIL before hashing
{
  let message = null;
  try { await installColdly({ checksum: SHA256, size: BINARY.length + 1 }); } catch (e) { message = String(e && e.message || e); }
  check(!!message && /manifest says/.test(message), "a short/long download is refused", message);
}

// 6. what the guest is told to run: the binary itself, in the guest (no node shim)
{
  const cmd = I.command("claude-bin");
  check(cmd.argv.length === 1 && cmd.argv[0] === "/usr/local/bin/claude", "argv", JSON.stringify(cmd.argv));
  check(cmd.shim === false, "no node shim (it is a native binary, like codex/agy)");
  check(Object.keys(cmd.env).length === 0, "no extra environment", JSON.stringify(cmd.env));
  check(I.CLIS.includes("claude-bin"), "claude-bin is a known cli", I.CLIS.join(","));
  // the other two Claude options must be untouched
  check(I.command("claude").shim === true && I.command("claude-native").shim === true, "claude and claude-native still run on the node shim");
  check(I.CATALOG.claude.packages[0].version === "2.1.112", "the npm build is still pinned at 2.1.112");
  check(!!I.CATALOG["claude-native"].bun, "claude-native is still the bun (extracted JS) kind");
}

console.log(bad ? `FAILED (${bad})` : "ALL OK");
process.exit(bad ? 1 : 0);
