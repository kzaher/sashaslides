#!/usr/bin/env node
// tools/aot-user.mjs — precompile a USER program of the guest ahead of time (TASKS.md R): codex, agy.
//
// Same shape as tools/aot-kernel.mjs (this file is the harness' --aot-script, so session() runs inside
// the engine between traces) with two differences a user binary forces:
//   * WHERE the code is: a PIE lands at a load base chosen by the kernel, so the guest is asked for
//     its own map — the run starts the program, then a background shell dumps /proc/<pid>/maps into
//     the transcript and prints the marker; session() reads the transcript back and derives the base.
//   * WHOSE page tables are live: the engine reads the bytes through the CURRENT CR3, so the session
//     only sees the program's text while its address space is the one installed. The census reports
//     how many functions were not mapped at that moment (`notMapped`) — that number is the honest
//     measure of how much of the binary this run could translate.
// Region keys in AOT mode carry no site address (content only), so a translation made at whatever base
// this boot happened to use is found again in any later boot at any other base.
//
//   node tools/aot-user.mjs codex [--elf work/aot/codex.bin] [--out build/aot/jit/aot-codex.nbjb]
//                                 [--engine build/aot/out.wasm] [--at 25] [--limit N] [--report F]
//
// Node and Bun are deliberately NOT translated: they generate code at runtime, and in the sandbox they
// run on the browser's own V8 instead (docs/system-node.md) — the platform is what gets optimised here.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadImage, parseMaps } from "./guest-symbolize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROGRAMS = {
  codex: { bin: "/usr/local/bin/codex", elf: "work/aot/codex.bin" },
  agy:   { bin: "/usr/local/bin/agy",   elf: "work/aot/agy.bin" },
};

export function session(ctx) {
  const { exports: ex, args, jitState, log } = ctx;
  for (const n of ["nanobox_aot_compile_function", "nanobox_aot_stat", "nanobox_jit_flush_batch"])
    if (typeof ex[n] !== "function") return { error: `engine has no export ${n}` };
  const t0 = performance.now();
  // 1. the load base, from the map the guest just printed
  let text = ctx.transcript || "";
  if (!text) { try { text = fs.readFileSync(args.transcript, "latin1"); } catch (e) { return { error: `no guest output: ${e.message}` }; } }
  const maps = parseMaps({ text });
  const bin = args.bin;
  const exec = maps.filter((m) => m.path === bin && m.executable);
  const anyOfBin = maps.filter((m) => m.path === bin);
  if (!exec.length) return { error: `no executable mapping of ${bin} in the guest map (${anyOfBin.length} other mappings, ${maps.length} lines)` };
  const base = exec[0].start - BigInt(exec[0].fileOffset);
  log(`[aot] ${args.kind}: ${bin} text at ${hex(exec[0].start)}..${hex(exec[0].end)} (base ${hex(base)}, ${exec.length} exec mappings)`);

  // 2. the function list of the binary itself
  const image = loadImage({ elfPath: args.elf });
  const fns = image.functions.filter((f) => f.size > 0 || f.end).map((f) => ({ addr: f.addr, len: Number((f.end || f.addr + BigInt(f.size || 1)) - f.addr), name: f.name }));
  fns.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
  const list = (args.limit ? fns.slice(args.first || 0, (args.first || 0) + args.limit) : fns.slice(args.first || 0));
  log(`[aot] ${args.kind}: ${list.length} of ${fns.length} functions from ${path.basename(args.elf)} (${image.source})`);

  const stats = { kind: args.kind, bin, elf: args.elf, base: hex(base), functions: list.length, source: image.source,
    compiled: 0, notMapped: 0, notLong: 0, off: 0, noBytes: 0, windows: 0, wasmBytes0: jitState.bytes, installed0: jitState.installed };

  // 3. the bytes: read from the program's ELF and handed to the engine (its page tables are not the
  //    ones installed while this session runs — see the header). One window per function, page
  //    aligned, so a walk that leaves the function simply ends there.
  const useSource = typeof ex.nanobox_aot_source === "function" && args.fromElf !== false;
  const fd = fs.openSync(args.elf, "r");
  const loads = readLoads(fd);
  const bufAddr = useSource ? ex.nanobox_aot_srcbuf_addr() : 0;
  const bufSize = useSource ? ex.nanobox_aot_srcbuf_size() : 0;
  const heap = () => new Uint8Array(ctx.memory());
  const setWindow = (lin, len) => {
    const pageLin = lin & ~0xfffn;
    const want = Math.min(bufSize, Number(lin - pageLin) + len + 4096);
    const buf = Buffer.alloc(want);
    let got = 0;
    for (const l of loads) {
      const vlo = l.vaddr + base, vhi = vlo + BigInt(l.memsz);
      const from = pageLin > vlo ? pageLin : vlo, to = pageLin + BigInt(want) < vhi ? pageLin + BigInt(want) : vhi;
      if (to <= from) continue;
      const rel = Number(from - vlo);
      const n = Math.min(Number(to - from), Math.max(0, l.filesz - rel));
      if (n > 0) { fs.readSync(fd, buf, Number(from - pageLin), n, l.offset + rel); got += n; }
    }
    if (!got) return false;
    heap().set(buf, bufAddr);
    ex.nanobox_aot_source(Number(pageLin & 0xffffffffn) >>> 0, Number(pageLin >> 32n) >>> 0, want);
    stats.windows++;
    return true;
  };
  let lastLog = performance.now();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const lin = f.addr + base;
    const lo = Number(lin & 0xffffffffn) >>> 0, hi = Number(lin >> 32n) >>> 0;
    if (useSource && !setWindow(lin, Math.max(1, f.len))) { stats.noBytes++; continue; }
    const r = ex.nanobox_aot_compile_function(lo, hi, Math.max(1, f.len), 3, args.sweep === false ? 0 : 1);
    if (r >= 0) stats.compiled += r;
    else if (r === -2) stats.notMapped++;
    else if (r === -3) { stats.notLong++; break; }
    else { stats.off++; break; }
    if (performance.now() - lastLog > 5000) {
      lastLog = performance.now();
      log(`[aot] ${i + 1}/${list.length} functions, ${stats.compiled} translations, ${stats.notMapped} not mapped, ${((jitState.bytes - stats.wasmBytes0) / 1e6).toFixed(1)} MB wasm`);
    }
  }
  if (useSource) { ex.nanobox_aot_source(0, 0, 0); fs.closeSync(fd); }   // back to reading guest RAM
  ex.nanobox_jit_flush_batch();
  stats.census = Array.from({ length: 8 }, (_, i) => ex.nanobox_aot_stat(i));
  stats.wasmBytes = jitState.bytes - stats.wasmBytes0;
  stats.installedFns = jitState.installed - stats.installed0;
  stats.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  log(`[aot] DONE ${args.kind}: ${stats.functions} functions -> ${stats.compiled} translations (${stats.notMapped} not mapped, ${stats.noBytes} with no bytes in the ELF, ${stats.windows} windows), ${(stats.wasmBytes / 1e6).toFixed(1)} MB wasm, ${stats.seconds} s`);
  return stats;
}
const hex = (b) => "0x" + BigInt(b).toString(16);

// PT_LOAD segments of an ELF64 file: where each piece of the file lands in the program's address space
function readLoads(fd) {
  const h = Buffer.alloc(64); fs.readSync(fd, h, 0, 64, 0);
  const phoff = Number(h.readBigUInt64LE(0x20)), phentsize = h.readUInt16LE(0x36), phnum = h.readUInt16LE(0x38);
  const t = Buffer.alloc(phentsize * phnum); fs.readSync(fd, t, 0, t.length, phoff);
  const loads = [];
  for (let i = 0; i < phnum; i++) {
    const at = i * phentsize;
    if (t.readUInt32LE(at) !== 1) continue;   // PT_LOAD
    loads.push({ offset: Number(t.readBigUInt64LE(at + 0x08)), vaddr: t.readBigUInt64LE(at + 0x10),
      filesz: Number(t.readBigUInt64LE(at + 0x20)), memsz: Number(t.readBigUInt64LE(at + 0x28)) });
  }
  return loads;
}

async function main() {
  const argv = process.argv.slice(2);
  const what = argv[0];
  if (!PROGRAMS[what]) { console.error(`usage: aot-user.mjs ${Object.keys(PROGRAMS).join("|")} [--elf F] [--out F] [--engine E] [--at SEC] [--limit N] [--report F]`); process.exit(2); }
  const o = {};
  for (let i = 1; i < argv.length; i++) { const a = argv[i]; if (a === "--no-sweep") o.sweep = false; else if (a.startsWith("--")) o[a.slice(2)] = argv[++i]; }
  const engine = path.resolve(o.engine || path.join(ROOT, "build/aot/out.wasm"));
  const out = path.resolve(o.out || path.join(path.dirname(engine), `jit/aot-${what}.nbjb`));
  const transcript = path.resolve(o.transcript || path.join(ROOT, `work/prof/aot-data/maps-${what}.txt`));
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const p = PROGRAMS[what];
  const args = { kind: what, bin: p.bin, elf: path.resolve(o.elf || path.join(ROOT, p.elf)), transcript,
    limit: o.limit ? Number(o.limit) : 0, first: o.first ? Number(o.first) : 0, sweep: o.sweep !== false };
  const at = Number(o.at || 25);
  // start the program, let it reach its steady state, then print its map and arm the session
  const cmd = `/bin/sh -c "(sleep ${at}; cat /proc/*/maps 2>/dev/null | grep -F ${p.bin}; echo @@NANOBOX-DUMP:aot@@) & exec ${p.bin}"`;
  const harnessArgs = [path.join(ROOT, "harness/run.mjs"), engine,
    "--oci", `http://localhost:8093/c2w/images/${o.image || what}/`, "--spec", path.join(ROOT, `web/images/${o.image || what}/config.json`),
    "--oci-cache", path.join(ROOT, "work/oci-cache"), "--quiet", "--no-hash",
    "--jit", o.jit || "2:1000000000", "--jit-bundle-out", out, "--transcript", transcript,
    "--cmd", cmd, "--aot-script", fileURLToPath(import.meta.url), "--aot-args", JSON.stringify(args), "--aot-at", "aot",
    "--timeout", String(o.timeout || 3600)];
  console.error(`[aot-user] ${what}: node ${harnessArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const child = spawn("node", harnessArgs, { cwd: path.join(ROOT, "harness"), env: Object.assign({}, process.env, { NANOBOX_AOT: "1", NANOBOX_THRESHOLD: o.threshold || "1000000000" }), stdio: ["ignore", "inherit", "pipe"] });
    let tail = "", sum = null;
    child.stderr.on("data", (d) => { const s = d.toString(); process.stderr.write(s); tail = (tail + s).slice(-200000); const m = /\[harness\] SUMMARY (\{.*\})/.exec(tail); if (m) sum = m[1]; });
    child.on("close", (code) => { let js = null; try { js = sum ? JSON.parse(sum) : null; } catch {} resolve({ code, summary: js }); });
  });
  const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
  const result = { program: what, exit: res.code, bundle: out, bundleBytes: bytes, wallSec: +((Date.now() - t0) / 1000).toFixed(1), session: res.summary && res.summary.aotSession };
  console.error(`[aot-user] ${what}: exit ${res.code}, bundle ${out} (${(bytes / 1e6).toFixed(1)} MB), ${result.wallSec} s`);
  if (o.report) fs.writeFileSync(path.resolve(o.report), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
