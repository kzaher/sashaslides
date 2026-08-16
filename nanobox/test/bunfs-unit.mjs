// web/native/bunfs.js — reading the files out of a Bun standalone executable (that is how the
// sandbox gets the JS of Claude Code's NATIVE build, docs/system-node.md). Runs without a browser:
//
//   node test/bunfs-unit.mjs [path/to/bun-standalone-binary]
//
// The synthetic cases always run; if the real binary is around (work/bun/claude-bun.bin, produced by
// `tar -xOf work/oci-cache/<layer>.tar usr/local/bin/claude`) it is parsed too — whole and as the
// 64 MB tail slice the browser installer range-fetches.
import { openSync, readSync, fstatSync, closeSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
await import("../web/native/bunfs.js");
const B = globalThis.NanoboxBunFs;
const HERE = dirname(fileURLToPath(import.meta.url));

// the loader in web/native/src/worker.js recognises a Bun entry with this regexp; both must agree
const BUN_CJS_ENTRY = /^\/\/ @bun[^\n]*\n\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)/;

let failures = 0;
const ok = (cond, what, got) => { console.log(`  ${cond ? "ok" : "FAIL"}: ${what}${cond ? "" : ` (got ${JSON.stringify(got)})`}`); if (!cond) failures++; };

console.log("synthetic standalone:");
{
  const entrySrc = "// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {module.exports = 42;})\n";
  const bin = synthetic([
    ["/$bunfs/root/src/entrypoints/cli.js", null],           // alias record: name followed by a name
    ["/$bunfs/root/cli", entrySrc],
    ["/$bunfs/root/mermaid.min.js", "/* mermaid */\n"],
    ["/$bunfs/root/audio-capture.node", "\x7fELF-ish-addon"],
  ]);
  const sec = B.section(bin);
  ok(!!sec, "finds the .bun section in an ELF64 image", sec);
  const mods = B.modules(bin, sec ? { section: sec } : undefined);
  ok(mods.length === 3, "skips the alias record and reads the three real files", mods.map((m) => m.name));
  ok(mods[0].name === "/$bunfs/root/cli", "the entry keeps its stored name", mods[0].name);
  ok(mods[0].text() === entrySrc, "contents are byte-exact", mods[0].text().slice(0, 40));
  const entry = B.entry(mods);
  ok(entry && entry.name === "/$bunfs/root/cli", "entry() picks the @bun-wrapped module, not the biggest asset", entry && entry.name);
  const un = B.unwrapCjs(entry.text());
  ok(un.wrapped, "unwrapCjs recognises Bun's CJS wrapper");
  ok(BUN_CJS_ENTRY.test(entry.text()), "the runtime loader's regexp agrees with unwrapCjs");
  ok(runAsRuntimeWould(entry.text()) === 42, "the wrapper runs when called with a module context");
}

console.log("truncated slice (what a range fetch gets):");
{
  const bin = synthetic([["/$bunfs/root/cli", "// @bun\n(function(exports, require, module, __filename, __dirname) {})\n"]]);
  const tail = bin.subarray(40);                                // mid-header slice: no usable ELF header
  ok(B.section(tail) === null, "section() gives up on a slice without the section table");
  const mods = B.modules(tail);
  ok(mods.length === 1 && mods[0].name === "/$bunfs/root/cli", "modules() still finds the records by scanning", mods.map((m) => m.name));
}

const real = process.argv[2] || join(HERE, "../work/bun/claude-bun.bin");
if (existsSync(real)) {
  console.log(`real binary ${real}:`);
  const whole = readAll(real);
  const sec = B.section(whole);
  ok(!!sec && sec.size > 1e6, "`.bun` section found", sec);
  const mods = B.modules(whole, { section: sec });
  const entry = B.entry(mods);
  ok(mods.length >= 5, `${mods.length} embedded modules`);
  ok(!!entry && /\/cli$/.test(entry.name) && entry.len > 1e6, "entry is the multi-MB /root/cli module", entry && `${entry.name} ${entry.len}`);
  ok(BUN_CJS_ENTRY.test(entry.text()), "the real entry matches the runtime loader's regexp");
  const tail = whole.subarray(Math.max(0, whole.length - B.SEARCH_TAIL_BYTES));
  const tailEntry = B.entry(B.modules(tail));
  ok(!!tailEntry && tailEntry.name === entry.name && tailEntry.len === entry.len,
    `the ${(B.SEARCH_TAIL_BYTES / 1e6) | 0} MB tail slice yields the same entry (the installer never downloads the whole binary)`,
    tailEntry && `${tailEntry.name} ${tailEntry.len}`);
} else {
  console.log(`real binary not present (${real}) — synthetic cases only`);
}

console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);

// a minimal ELF64 image whose `.bun` section holds `\0name\0contents` records (contents null = alias)
function synthetic(records) {
  const enc = new TextEncoder();
  const parts = [];
  for (const [name, contents] of records) { parts.push(enc.encode("\0" + name + "\0")); if (contents !== null) parts.push(enc.encode(contents)); }
  const payload = concat(parts);
  const shstr = enc.encode("\0.bun\0.shstrtab\0");
  const ehsize = 64, shentsize = 64, shnum = 3;
  const secOff = ehsize;
  const shstrOff = secOff + payload.length;
  const shoff = shstrOff + shstr.length;
  const out = new Uint8Array(shoff + shnum * shentsize);
  const dv = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);               // \x7fELF, 64-bit, little endian
  dv.setBigUint64(0x28, BigInt(shoff), true);
  dv.setUint16(0x3a, shentsize, true); dv.setUint16(0x3c, shnum, true); dv.setUint16(0x3e, 2, true);
  out.set(payload, secOff); out.set(shstr, shstrOff);
  const sh = (i, nameOff, off, size) => { const b = shoff + i * shentsize; dv.setUint32(b, nameOff, true); dv.setBigUint64(b + 0x18, BigInt(off), true); dv.setBigUint64(b + 0x20, BigInt(size), true); };
  sh(0, 0, 0, 0);                                              // null section
  sh(1, 1, secOff, payload.length);                            // ".bun"
  sh(2, 6, shstrOff, shstr.length);                            // ".shstrtab"
  return out;
}

function runAsRuntimeWould(text) {
  const module = { exports: {} };
  const call = `\n(module.exports, require, module, "/x/cli.js", "/x");\n`;
  return new Function("module", "require", `${text}${call}\nreturn module.exports;`)(module, () => { throw new Error("no require in this test"); });
}

function concat(list) { const n = list.reduce((s, b) => s + b.length, 0); const out = new Uint8Array(n); let o = 0; for (const b of list) { out.set(b, o); o += b.length; } return out; }
function readAll(path) { const fd = openSync(path, "r"); const size = fstatSync(fd).size; const buf = Buffer.alloc(size); let off = 0; while (off < size) off += readSync(fd, buf, off, Math.min(1 << 26, size - off), off); closeSync(fd); return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }
