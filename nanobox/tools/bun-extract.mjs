#!/usr/bin/env node
// List / extract the files a Bun standalone executable embeds (web/native/bunfs.js does the parsing;
// the browser installer uses the same module):
//
//   node tools/bun-extract.mjs <binary>                  list the embedded modules (name, size)
//   node tools/bun-extract.mjs <binary> --out DIR        write them all to DIR
//   node tools/bun-extract.mjs <binary> --entry FILE     write just the entry module (Claude Code's cli.js)
//   node tools/bun-extract.mjs <binary> --tail 64        parse only the last N MB (what a range fetch would get)
//   node tools/bun-extract.mjs <binary> --install DIR    lay the files out the way the guest needs them:
//                                                        usr/local/lib/claude-native/cli.js, the assets at their
//                                                        literal $bunfs/root/… path, and the launcher
//                                                        usr/local/bin/claude (`exec /bundle/nb/node …/cli.js`)
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { dirname, join, basename } from "node:path";
await import("../web/native/bunfs.js");
const B = globalThis.NanoboxBunFs;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const file = argv.find((a) => !a.startsWith("--") && !(argv[argv.indexOf(a) - 1] || "").startsWith("--"));
if (!file) { console.error("usage: bun-extract.mjs <binary> [--out DIR] [--entry FILE] [--tail MB]"); process.exit(2); }

const tailMb = Number(opt("--tail", 0));
let bytes, base = 0;
if (tailMb > 0) {
  const fd = openSync(file, "r"); const size = fstatSync(fd).size;
  base = Math.max(0, size - tailMb * 1024 * 1024);
  bytes = Buffer.alloc(size - base); readSync(fd, bytes, 0, bytes.length, base); closeSync(fd);
  console.log(`parsing the last ${(bytes.length / 1e6).toFixed(1)} MB of ${basename(file)} (offset ${base})`);
} else {
  bytes = readFileSync(file);
}
const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const sec = B.section(u8);
console.log(sec ? `.bun section at ${sec.off} (${(sec.size / 1e6).toFixed(1)} MB)` : "no ELF section table in this slice — scanning all of it");
const mods = B.modules(u8, sec ? { section: sec } : undefined);
console.log(`${mods.length} embedded modules:`);
for (const m of mods.slice(0, 40)) console.log(`  ${(m.len / 1e6).toFixed(2).padStart(8)} MB  ${m.name}`);
if (mods.length > 40) console.log(`  … ${mods.length - 40} more`);

const main = B.entry(mods);
if (main) {
  const { wrapped } = B.unwrapCjs(main.text());
  console.log(`entry: ${main.name} (${(main.len / 1e6).toFixed(2)} MB, ${wrapped ? "CJS-wrapped" : "plain"})`);
}
const out = opt("--out", null);
if (out) {
  for (const m of mods) {
    const p = join(out, m.name.replace(/^\/\$bunfs\//, ""));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, m.bytes());
  }
  console.log(`wrote ${mods.length} files to ${out}`);
}
const install = opt("--install", null);
if (install && main) {
  const write = (rel, data, mode) => { const p = join(install, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data, mode ? { mode } : undefined); };
  write("usr/local/lib/claude-native/cli.js", main.bytes());
  for (const m of mods) { if (m === main) continue; write(m.name.replace(/^\//, ""), m.bytes()); }
  write("usr/local/bin/claude", '#!/bin/sh\nexec /bundle/nb/node /usr/local/lib/claude-native/cli.js "$@"\n', 0o755);
  console.log(`installed ${mods.length} files + the launcher under ${install} (copy it over the sandbox's persistent tree, or into the guest)`);
}
const entryOut = opt("--entry", null);
if (entryOut && main) { mkdirSync(dirname(entryOut), { recursive: true }); writeFileSync(entryOut, main.bytes()); console.log(`wrote ${entryOut}`); }
