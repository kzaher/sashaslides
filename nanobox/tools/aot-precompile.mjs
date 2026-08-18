#!/usr/bin/env node
// tools/aot-precompile.mjs — the "precompile everything" pipeline of TASKS.md R.
//
// Produces .nbjb bundles holding a compiled translation of EVERY function of the guest kernel and of
// the native userland binaries (codex, agy), so that a run under NANOBOX_AOT=1 with the bundles
// loaded dispatches (nearly) nothing to the interpreter. Node/Bun are excluded by design (they run
// on the browser's V8 through runtime detection).
//
// How: the translator is the ENGINE ITSELF. This tool boots the image in the harness to a marker
// printed by the guest after boot (kernel text is then patched + resident; the CPU is in long mode
// with the steady-state fetch mode), and at that point — inside the harness poll hook, between
// traces — drives the engine's own region former + compiler once per function through the
// nanobox_aot_* exports (work/j/aotpre/bochs/nanobox_jit.cc, "AOT PRECOMPILATION" block). Every
// module the engine installs goes through the normal install/note hooks, so --jit-bundle-out writes
// them under exactly the content keys the runtime computes when it forms the same region at the
// same site. Bytes sources: the kernel is read from guest RAM (page walk, nokaslr: VA - 0xffffffff80000000
// = phys), the user binaries from their ELF files (the guest never has all 200 MB resident; PIE
// bases do not matter because AOT-mode user regions never leave their page and keys carry no address).
//
// Usage (from nanobox/):
//   node tools/aot-precompile.mjs kernel [--engine build/aotpre/out.wasm] [--out DIR/aot-kernel.nbjb] [--limit N] [--first N]
//   node tools/aot-precompile.mjs codex  [--elf work/aot/codex.bin]  [--base 0x...] [--limit N] [--first N]
//   node tools/aot-precompile.mjs agy    [--elf work/aot/agy.bin]    [--base 0x...] [--limit N] [--first N]
//   node tools/aot-precompile.mjs all
//   common: --engine E (default build/aotpre/out.wasm), --outdir D (default <engine dir>/jit), --report F (json),
//           --sysmap F (default work/pack-out-nb/symbols/System.map), --image codex (OCI image used to boot),
//           --limit N (only the first N functions: smoke tests), --first N (skip N), --no-sweep (no linear-gap sites),
//           --timeout SEC (harness wall budget, default 3600)
// The run is detached-friendly (prints progress to stderr); each engine invocation is one harness process.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadImage, loadSystemMap } from "./guest-symbolize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const KERNEL_LIN_TO_PHYS = 0xffffffff80000000n;   // nokaslr: physical = VA - this (verified at session start through nanobox_aot_xlate)

// status bits of nanobox_aot_compile (keep in sync with nanobox_jit.cc)
const ST = { HAVE: 1, REGION: 2, ALREADY: 4, PENDINGDUP: 8, NOMAP: 16, NODECODE: 32, FAIL: 64, NOTACTIVE: 128 };
const KIND = { 1: "cached", 2: "bundle", 3: "compiled", 4: "attached" };

// ---- ELF helpers (user binaries) -----------------------------------------------------------------
function readProgramHeaders(elfPath) {
  const fd = fs.openSync(elfPath, "r");
  try {
    const h = Buffer.alloc(64); fs.readSync(fd, h, 0, 64, 0);
    const phoff = Number(h.readBigUInt64LE(0x20)), phentsize = h.readUInt16LE(0x36), phnum = h.readUInt16LE(0x38);
    const t = Buffer.alloc(phentsize * phnum); fs.readSync(fd, t, 0, t.length, phoff);
    const loads = [];
    for (let i = 0; i < phnum; i++) {
      const at = i * phentsize;
      if (t.readUInt32LE(at) !== 1) continue; // PT_LOAD
      loads.push({ flags: t.readUInt32LE(at + 4), offset: Number(t.readBigUInt64LE(at + 8)), vaddr: t.readBigUInt64LE(at + 16), filesz: Number(t.readBigUInt64LE(at + 32)), memsz: Number(t.readBigUInt64LE(at + 40)) });
    }
    return loads;
  } finally { fs.closeSync(fd); }
}
// bytes of the ELF page holding vaddr (zero-filled beyond filesz), or null when no PT_LOAD covers it
function elfPage(fd, loads, pageVaddr) {
  for (const l of loads) {
    if (pageVaddr < l.vaddr || pageVaddr >= l.vaddr + BigInt(l.memsz)) continue;
    const buf = Buffer.alloc(4096);
    const rel = Number(pageVaddr - l.vaddr);
    if (rel < l.filesz) fs.readSync(fd, buf, 0, Math.min(4096, l.filesz - rel), l.offset + rel);
    return buf;
  }
  return null;
}

// ---- the session: runs INSIDE harness/run.mjs (poll hook, between traces) ------------------------
export function session(ctx) {
  const { exports: ex, memory, args, jitState, log } = ctx;
  const t0 = performance.now();
  for (const n of ["nanobox_aot_begin", "nanobox_aot_compile", "nanobox_aot_end", "nanobox_aot_out", "nanobox_aot_ilen", "nanobox_aot_byte", "nanobox_aot_xlate", "nanobox_aot_alloc", "nanobox_aot_source"])
    if (typeof ex[n] !== "function") return { error: `engine has no export ${n} (build it from work/j/aotpre)` };
  const kind = args.kind || "kernel";
  const limit = args.limit || 0, first = args.first || 0, sweep = args.sweep !== false;
  const heap = () => new Uint8Array(memory());
  const dv = () => new DataView(memory());
  const outPtr = ex.nanobox_aot_out();
  const readOut = () => {
    const d = dv(); const o = outPtr;
    const status = d.getUint32(o, true), nblocks = d.getUint32(o + 4, true), keyLo = d.getUint32(o + 8, true), keyHi = d.getUint32(o + 12, true), kind = d.getUint32(o + 16, true), nfront = d.getUint32(o + 20, true);
    const blocks = [], front = [];
    for (let j = 0; j < nblocks; j++) { const b = o + 24 + 16 * j; blocks.push({ lin: (BigInt(d.getUint32(b + 4, true)) << 32n) | BigInt(d.getUint32(b, true)), ninstr: d.getUint32(b + 8, true), nbytes: d.getUint32(b + 12, true) }); }
    const fbase = o + 24 + 16 * 24;
    for (let i = 0; i < nfront; i++) { const f = fbase + 16 * i; front.push({ lin: (BigInt(d.getUint32(f + 4, true)) << 32n) | BigInt(d.getUint32(f, true)), why: d.getUint32(f + 8, true) }); }
    return { status, blocks, front, key: keyHi.toString(16).padStart(8, "0") + ":" + keyLo.toString(16).padStart(8, "0"), kind };
  };
  const stats = { kind, functions: 0, sitesTried: 0, entrySites: 0, frontierSites: 0, sweepSites: 0, compiled: 0, cached: 0, bundle: 0, attached: 0, pendingDup: 0,
    regions: 0, plainTraces: 0, blocks: 0, instructions: 0, codeBytes: 0, coveredBytes: 0, fnFullyCovered: 0, fnPartial: 0, fnNothing: 0,
    rejected: { nomap: 0, nodecode: 0, fail: 0 }, frontierWhy: {}, wasmBytes0: jitState.bytes, installed0: jitState.installed, batches0: jitState.batches };
  // ---- the function list ----
  let functions = [], base = 0n, cpl = 0, srcMode = 0, elfFd = null, loads = null;
  if (kind === "kernel") {
    const sysmap = args.sysmap || path.join(ROOT, "work/pack-out-nb/symbols/System.map");
    const syms = loadSystemMap({ path: sysmap });
    const text = fs.readFileSync(sysmap, "utf8");
    const symAt = (name) => { const m = new RegExp("^([0-9a-f]{16}) [A-Za-z] " + name + "$", "m").exec(text); return m ? BigInt("0x" + m[1]) : null; };
    const stext = symAt("_stext") || symAt("_text"), etext = symAt("_etext");
    if (!stext || !etext) return { error: "System.map: no _stext/_etext" };
    // dedupe aliases (same address), size = distance to the next distinct address, only [_stext, _etext)
    const seen = new Set();
    for (let i = 0; i < syms.length; i++) {
      const s = syms[i];
      if (s.addr < stext || s.addr >= etext) continue;
      if (seen.has(s.addr)) continue; seen.add(s.addr);
      let j = i + 1; while (j < syms.length && syms[j].addr === s.addr) j++;
      const end = j < syms.length && syms[j].addr < etext ? syms[j].addr : etext;
      functions.push({ addr: s.addr, end, name: s.name });
    }
    stats.textRange = [hex(stext), hex(etext)]; stats.sysmap = sysmap;
    // verify the nokaslr mapping the engine will use for the kernel bytes
    const phys = ex.nanobox_aot_xlate(Number(stext));
    stats.xlate = { lin: hex(stext), phys: phys < 0 ? null : "0x" + phys.toString(16), expected: "0x" + (stext - KERNEL_LIN_TO_PHYS).toString(16) };
    if (phys < 0 || BigInt(phys) !== stext - KERNEL_LIN_TO_PHYS) log(`[aot] WARNING: kernel _stext maps to ${stats.xlate.phys}, expected ${stats.xlate.expected} (KASLR on?)`);
  } else {
    if (!args.elf) return { error: "user session needs args.elf" };
    const img = loadImage({ elfPath: args.elf });
    loads = readProgramHeaders(args.elf);
    elfFd = fs.openSync(args.elf, "r");
    base = args.base ? BigInt(args.base) : 0n; cpl = 3; srcMode = 1;
    const list = img.functions;
    // executable range: PT_LOAD with PF_X
    const xseg = loads.filter((l) => l.flags & 1);
    const inX = (a) => xseg.some((l) => a >= l.vaddr && a < l.vaddr + BigInt(l.filesz));
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!inX(s.addr)) continue;
      const end = i + 1 < list.length ? list[i + 1].addr : s.addr + BigInt(s.size || 0);
      if (end <= s.addr) continue;
      functions.push({ addr: s.addr, end, name: s.name });
    }
    stats.elf = args.elf; stats.symbolSource = img.source; stats.base = hex(base);
  }
  if (first) functions = functions.slice(first);
  if (limit) functions = functions.slice(0, limit);
  stats.functions = functions.length;
  log(`[aot] ${kind}: ${functions.length} functions (${stats.symbolSource || stats.sysmap}), cpl=${cpl}, source=${srcMode ? "ELF file" : "guest RAM"}`);
  // ---- session ----
  const pageBuf = srcMode ? ex.nanobox_aot_alloc(4096) : 0;
  if (!ex.nanobox_aot_begin(cpl, srcMode, pageBuf, srcMode ? 4096 : 0, 0)) return { error: "nanobox_aot_begin refused (CPU not in long mode / JIT off?)" };
  let curPage = -1n;
  const ensurePage = (lin) => { // user: bring the ELF page holding lin into the engine's buffer
    if (!srcMode) return true;
    const page = lin & ~0xfffn;
    if (page === curPage) return true;
    const bytes = elfPage(elfFd, loads, page - base);
    if (!bytes) return false;
    heap().set(bytes, pageBuf);
    ex.nanobox_aot_source(pageBuf, 4096, Number(page));
    curPage = page;
    return true;
  };
  const isPad = (b, b2) => b === 0xcc || b === 0x90 || (b === 0x0f && b2 === 0x1f) || (b === 0x66 && (b2 === 0x90 || b2 === 0x0f || b2 === 0x66 || b2 === 0x2e)); // int3 / nop / nopl / 66-prefixed nops
  const compileAt = (lin, why) => {
    stats.sitesTried++;
    if (why === "entry") stats.entrySites++; else if (why === "front") stats.frontierSites++; else stats.sweepSites++;
    if (!ensurePage(lin)) { stats.rejected.nomap++; return null; }
    const st = ex.nanobox_aot_compile(Number(lin));
    const r = readOut();
    if (st & ST.NOMAP) { stats.rejected.nomap++; return r; }
    if (st & ST.NODECODE) { stats.rejected.nodecode++; return r; }
    if (st & ST.FAIL) { stats.rejected.fail++; return r; }
    if (st & ST.PENDINGDUP) { stats.pendingDup++; return r; }
    if (r.kind === 3) { stats.compiled++; if (st & ST.REGION) stats.regions++; else stats.plainTraces++; stats.blocks += r.blocks.length; for (const b of r.blocks) { stats.instructions += b.ninstr; stats.codeBytes += b.nbytes; } }
    else if (r.kind === 1) stats.cached++; else if (r.kind === 2) stats.bundle++; else if (r.kind === 4) stats.attached++;
    for (const f of r.front) stats.frontierWhy[f.why] = (stats.frontierWhy[f.why] || 0) + 1;
    return r;
  };
  const tReport = performance.now();
  let lastLog = performance.now();
  for (let fi = 0; fi < functions.length; fi++) {
    const fn = functions[fi];
    const lo = fn.addr + base, hi = fn.end + base;
    // covered byte ranges of this function (from the blocks of every region/trace we got)
    const covered = []; // [start, end) sorted-ish, small
    const isCovered = (a) => covered.some(([s, e]) => a >= s && a < e);
    const coverEnd = (a) => { let best = null; for (const [s, e] of covered) if (a >= s && a < e && (best === null || e > best)) best = e; return best; };
    const addBlocks = (r) => { if (!r) return; for (const b of r.blocks) covered.push([b.lin, b.lin + BigInt(Math.max(1, b.nbytes))]); };
    const sites = [[lo, "entry"]]; const queued = new Set([lo]);
    let n = 0;
    while (sites.length && n < 512) {
      const [lin, why] = sites.shift(); n++;
      if (isCovered(lin)) continue;
      const r = compileAt(lin, why);
      addBlocks(r);
      if (r) for (const f of r.front) if (f.lin >= lo && f.lin < hi && !queued.has(f.lin) && !isCovered(f.lin)) { queued.add(f.lin); sites.push([f.lin, "front"]); }
    }
    if (sweep) {
      // linear sweep of the gaps the walk left inside [lo, hi): jump-table targets and blocks behind
      // budget cuts; padding (int3/nop) is skipped
      let pos = lo, guard = 0;
      while (pos < hi && guard < 256) {
        const ce = coverEnd(pos);
        if (ce !== null) { pos = ce; continue; }
        guard++;
        if (!ensurePage(pos)) break;
        const b = ex.nanobox_aot_byte(Number(pos));
        if (b < 0) break;
        if (isPad(b, ex.nanobox_aot_byte(Number(pos + 1n)))) { const il = ex.nanobox_aot_ilen(Number(pos)) || 1; pos += BigInt(il); continue; }
        const r = compileAt(pos, "sweep");
        addBlocks(r);
        if (!r || !(r.status & ST.HAVE)) { const il = ex.nanobox_aot_ilen(Number(pos)) || 1; pos += BigInt(il); continue; }
        const ce2 = coverEnd(pos); pos = ce2 !== null ? ce2 : pos + 1n;
      }
    }
    // coverage census of the function
    let cov = 0n; for (const [s, e] of covered) { const s2 = s < lo ? lo : s, e2 = e > hi ? hi : e; if (e2 > s2) cov += e2 - s2; }
    const size = hi - lo;
    stats.coveredBytes += Number(cov);
    if (cov === 0n) stats.fnNothing++; else if (cov >= size - 16n) stats.fnFullyCovered++; else stats.fnPartial++;
    if (performance.now() - lastLog > 5000) { lastLog = performance.now(); log(`[aot] ${fi + 1}/${functions.length} functions, ${stats.compiled} compiled (${stats.regions} regions, ${stats.plainTraces} traces), ${((jitState.bytes - stats.wasmBytes0) / 1e6).toFixed(1)} MB wasm, ${((performance.now() - t0) / 1000).toFixed(0)} s`); }
  }
  ex.nanobox_aot_end();
  if (elfFd !== null) fs.closeSync(elfFd);
  stats.wasmBytes = jitState.bytes - stats.wasmBytes0; stats.installedFns = jitState.installed - stats.installed0; stats.batches = jitState.batches - stats.batches0;
  stats.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  log(`[aot] DONE ${kind}: ${stats.functions} functions, ${stats.sitesTried} sites (entry ${stats.entrySites}, frontier ${stats.frontierSites}, sweep ${stats.sweepSites}); compiled ${stats.compiled} (${stats.regions} regions / ${stats.plainTraces} traces, ${stats.blocks} blocks, ${stats.instructions} instr, ${stats.codeBytes} x86 bytes) cached ${stats.cached} attached ${stats.attached} rejected ${JSON.stringify(stats.rejected)}; wasm ${(stats.wasmBytes / 1e6).toFixed(1)} MB in ${stats.batches} batches; coverage: full ${stats.fnFullyCovered} partial ${stats.fnPartial} none ${stats.fnNothing}; ${stats.seconds} s`);
  return stats;
}
function hex(b) { return "0x" + BigInt(b).toString(16); }

// ---- CLI: spawn the harness with this file as --aot-script -------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") { console.error("usage: node tools/aot-precompile.mjs kernel|codex|agy|all [--engine E] [--outdir D] [--out F] [--elf F] [--base 0x..] [--sysmap F] [--limit N] [--first N] [--no-sweep] [--report F] [--timeout SEC] [--image IMG]"); process.exit(2); }
  const what = argv[0]; const o = {};
  for (let i = 1; i < argv.length; i++) { const a = argv[i]; if (a === "--no-sweep") o.sweep = false; else o[a.replace(/^--/, "")] = argv[++i]; }
  const engine = path.resolve(o.engine || path.join(ROOT, "build/aotpre/out.wasm"));
  const outdir = path.resolve(o.outdir || path.join(path.dirname(engine), "jit"));
  fs.mkdirSync(outdir, { recursive: true });
  const targets = what === "all" ? ["kernel", "codex", "agy"] : [what];
  const results = {};
  for (const t of targets) {
    const args = { kind: t === "kernel" ? "kernel" : "user", limit: o.limit ? Number(o.limit) : 0, first: o.first ? Number(o.first) : 0, sweep: o.sweep !== false };
    if (t === "kernel") args.sysmap = o.sysmap ? path.resolve(o.sysmap) : path.join(ROOT, "work/pack-out-nb/symbols/System.map");
    else {
      args.elf = path.resolve(o.elf || path.join(ROOT, `work/aot/${t}.bin`));
      const baseFile = path.join(ROOT, `work/aot/${t}.base`);
      args.base = o.base || (fs.existsSync(baseFile) ? fs.readFileSync(baseFile, "utf8").trim() : "0");
    }
    const out = targets.length === 1 && o.out ? path.resolve(o.out) : path.join(outdir, `aot-${t}.nbjb`);
    const image = o.image || "codex";
    const harnessArgs = [path.join(ROOT, "harness/run.mjs"), engine,
      "--oci", `http://localhost:8093/c2w/images/${image}/`, "--spec", path.join(ROOT, `web/images/${image}/config.json`), "--oci-cache", path.join(ROOT, "work/oci-cache"),
      // The BOOT must not compile: with threshold 1 the boot alone installed 38 k modules / 575 MB and
      // every AOT site then reported "already pending" (that is what made the first smoke read
      // 284/300 functions uncovered). A huge threshold leaves the JIT enabled -- the session needs
      // level 2 -- while nothing compiles until the session drives it, so the bundle holds the
      // precompiled translations and nothing else. Override with --jit for an A/B.
      "--quiet", "--no-hash", "--jit", o.jit || "2:1000000000", "--jit-bundle-out", out,
      "--cmd", `/bin/sh -c "echo @@NANOBOX-DUMP:aot@@; sleep 600"`,
      "--aot-script", fileURLToPath(import.meta.url), "--aot-args", JSON.stringify(args), "--aot-at", "aot",
      "--timeout", String(o.timeout || 3600)];
    console.error(`[aot-precompile] ${t}: node ${harnessArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    const t0 = Date.now();
    const summary = await new Promise((resolve) => {
      const child = spawn("node", harnessArgs, { cwd: path.join(ROOT, "harness"), env: Object.assign({}, process.env, { NANOBOX_AOT: "1" }), stdio: ["ignore", "inherit", "pipe"] });
      let tail = "", sum = null;
      child.stderr.on("data", (d) => { const s = d.toString(); process.stderr.write(s); tail = (tail + s).slice(-200000); const m = /\[harness\] SUMMARY (\{.*\})/.exec(tail); if (m) sum = m[1]; });
      child.on("close", (code) => { let js = null; try { js = sum ? JSON.parse(sum) : null; } catch (e) {} resolve({ code, summary: js }); });
    });
    const st = summary.summary && summary.summary.aotSession;
    const bundle = fs.existsSync(out) ? fs.statSync(out).size : 0;
    results[t] = { exit: summary.code, bundle: out, bundleBytes: bundle, wallSec: +((Date.now() - t0) / 1000).toFixed(1), session: st, jit: summary.summary && summary.summary.jit };
    console.error(`[aot-precompile] ${t}: exit ${summary.code}, bundle ${out} (${(bundle / 1e6).toFixed(1)} MB), ${results[t].wallSec} s`);
    if (st) console.error(`[aot-precompile] ${t}: functions ${st.functions} sites ${st.sitesTried} compiled ${st.compiled} (regions ${st.regions}, traces ${st.plainTraces}) cached ${st.cached} attached ${st.attached} rejected ${JSON.stringify(st.rejected)} full/partial/none ${st.fnFullyCovered}/${st.fnPartial}/${st.fnNothing} wasm ${((st.wasmBytes || 0) / 1e6).toFixed(1)} MB`);
  }
  if (o.report) fs.writeFileSync(path.resolve(o.report), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
