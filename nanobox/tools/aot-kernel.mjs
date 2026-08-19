#!/usr/bin/env node
// tools/aot-kernel.mjs — precompile the whole guest KERNEL ahead of time (TASKS.md R).
//
// The translator is the engine itself: this file is handed to harness/run.mjs as --aot-script, so
// session() runs INSIDE the engine's poll hook (between traces) once the guest printed the marker.
// It walks every text symbol of System.map and calls the engine's own
// nanobox_aot_compile_function(linLo, linHi, len, cpl, flags) — the same former the runtime uses at
// first touch — so every module lands under exactly the content key a later boot computes for that
// site, and --jit-bundle-out writes them as a normal .nbjb bundle.
//
// The kernel is the case where a precompiled key is stable by construction: the image boots with
// nokaslr, so a kernel VA maps to a fixed physical address (lin - 0xffffffff80000000) and the region
// key (entry pAddr + block contents) is the same in every boot.
//
//   node tools/aot-kernel.mjs [--engine build/aot/out.wasm] [--out build/aot/jit/aot-kernel.nbjb]
//                             [--sysmap work/pack-out-nb/symbols/System.map] [--limit N] [--first N]
//                             [--no-sweep] [--jit 2:1000000000] [--report F]
//
// The boot deliberately runs with a huge JIT threshold: the JIT stays enabled (the session needs
// level 2) but nothing compiles until the session drives it, so the bundle holds the precompiled
// translations and not a recording of one boot.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSystemMap } from "./guest-symbolize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// ---- the session: runs inside harness/run.mjs, between traces --------------------------------
export function session(ctx) {
  const { exports: ex, args, jitState, log } = ctx;
  for (const n of ["nanobox_aot_compile_function", "nanobox_aot_stat", "nanobox_jit_flush_batch"])
    if (typeof ex[n] !== "function") return { error: `engine has no export ${n} (build from work/j/aot)` };
  const t0 = performance.now();
  const sysmap = args.sysmap || path.join(ROOT, "work/pack-out-nb/symbols/System.map");
  const text = fs.readFileSync(sysmap, "utf8");
  const symAt = (name) => { const m = new RegExp("^([0-9a-f]{16}) [A-Za-z] " + name + "$", "m").exec(text); return m ? BigInt("0x" + m[1]) : null; };
  const stext = symAt("_stext") || symAt("_text"), etext = symAt("_etext");
  if (!stext || !etext) return { error: "System.map: no _stext/_etext" };
  const syms = loadSystemMap({ path: sysmap });
  // one entry per distinct address inside [_stext, _etext); size = distance to the next address
  const fns = [];
  const seen = new Set();
  for (let i = 0; i < syms.length; i++) {
    const a = syms[i].addr;
    if (a < stext || a >= etext || seen.has(a)) continue;
    seen.add(a);
    let j = i + 1; while (j < syms.length && syms[j].addr === a) j++;
    const end = j < syms.length && syms[j].addr < etext ? syms[j].addr : etext;
    fns.push({ addr: a, len: Number(end - a), name: syms[i].name });
  }
  fns.sort((x, y) => (x.addr < y.addr ? -1 : x.addr > y.addr ? 1 : 0));
  const first = args.first || 0, limit = args.limit || 0;
  const list = fns.slice(first, limit ? first + limit : undefined);
  const flags = args.sweep === false ? 0 : 1;
  log(`[aot] kernel: ${list.length} of ${fns.length} functions from ${path.basename(sysmap)} (text ${hex(stext)}..${hex(etext)}), sweep ${flags & 1 ? "on" : "off"}`);

  const stats = { kind: "kernel", functions: list.length, textRange: [hex(stext), hex(etext)], sysmap,
    compiled: 0, notMapped: 0, notLong: 0, off: 0, biggest: [], wasmBytes0: jitState.bytes, installed0: jitState.installed };
  let lastLog = performance.now();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const lo = Number(f.addr & 0xffffffffn) >>> 0, hi = Number(f.addr >> 32n) >>> 0;
    const r = ex.nanobox_aot_compile_function(lo, hi, f.len, 0, flags);
    if (r >= 0) { stats.compiled += r; if (r > 8) stats.biggest.push([f.name, r]); }
    else if (r === -2) stats.notMapped++;
    else if (r === -3) { stats.notLong++; break; }
    else { stats.off++; break; }
    if (performance.now() - lastLog > 5000) {
      lastLog = performance.now();
      log(`[aot] ${i + 1}/${list.length} functions, ${stats.compiled} translations, ${((jitState.bytes - stats.wasmBytes0) / 1e6).toFixed(1)} MB wasm, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
  }
  ex.nanobox_jit_flush_batch();
  stats.census = Array.from({ length: 8 }, (_, i) => ex.nanobox_aot_stat(i));   // 0 functions, 1 compiled, 2 sites, 3 not mapped, 4 gap starts, 5 already, 6 pending, 7 failed
  stats.wasmBytes = jitState.bytes - stats.wasmBytes0;
  stats.installedFns = jitState.installed - stats.installed0;
  stats.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  stats.biggest = stats.biggest.sort((a, b) => b[1] - a[1]).slice(0, 15);
  log(`[aot] DONE kernel: ${stats.functions} functions -> ${stats.compiled} translations, ${stats.installedFns} modules, ${(stats.wasmBytes / 1e6).toFixed(1)} MB wasm, not-mapped ${stats.notMapped}, ${stats.seconds} s`);
  return stats;
}
const hex = (b) => "0x" + BigInt(b).toString(16);

// ---- CLI: spawn the harness with this file as the AOT script -----------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === "--no-sweep") o.sweep = false; else if (a.startsWith("--")) o[a.slice(2)] = argv[++i]; }
  const engine = path.resolve(o.engine || path.join(ROOT, "build/aot/out.wasm"));
  const out = path.resolve(o.out || path.join(path.dirname(engine), "jit/aot-kernel.nbjb"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = { sysmap: o.sysmap ? path.resolve(o.sysmap) : undefined, limit: o.limit ? Number(o.limit) : 0, first: o.first ? Number(o.first) : 0, sweep: o.sweep !== false };
  const image = o.image || "codex";
  const harnessArgs = [path.join(ROOT, "harness/run.mjs"), engine,
    "--oci", `http://localhost:8093/c2w/images/${image}/`, "--spec", path.join(ROOT, `web/images/${image}/config.json`),
    "--oci-cache", path.join(ROOT, "work/oci-cache"), "--quiet", "--no-hash",
    "--jit", o.jit || "2:1000000000", "--jit-bundle-out", out,
    // the function map the RUNTIME gets, so both sides run the same retarget path: a site inside an
    // already-translated function must behave here exactly as it does in a boot (TASKS.md S.4)
    ...(o.fnmap === "off" ? [] : ["--aot-fnmap", path.resolve(o.fnmap || args.sysmap || path.join(ROOT, "work/pack-out-nb/symbols/System.map"))]),
    ...(o.keys ? ["--aot-keys", path.resolve(o.keys)] : []),
    "--cmd", `/bin/sh -c "echo @@NANOBOX-DUMP:aot@@; sleep 600"`,
    "--aot-script", fileURLToPath(import.meta.url), "--aot-args", JSON.stringify(args), "--aot-at", "aot",
    "--timeout", String(o.timeout || 3600)];
  console.error(`[aot-kernel] node ${harnessArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const child = spawn("node", harnessArgs, { cwd: path.join(ROOT, "harness"), env: Object.assign({}, process.env, { NANOBOX_AOT: "1", NANOBOX_THRESHOLD: o.threshold || "1000000000" }), stdio: ["ignore", "inherit", "pipe"] });
    let tail = "", sum = null;
    child.stderr.on("data", (d) => { const s = d.toString(); process.stderr.write(s); tail = (tail + s).slice(-200000); const m = /\[harness\] SUMMARY (\{.*\})/.exec(tail); if (m) sum = m[1]; });
    child.on("close", (code) => { let js = null; try { js = sum ? JSON.parse(sum) : null; } catch {} resolve({ code, summary: js }); });
  });
  const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
  const result = { exit: res.code, bundle: out, bundleBytes: bytes, wallSec: +((Date.now() - t0) / 1000).toFixed(1), session: res.summary && res.summary.aotSession, jit: res.summary && res.summary.jit };
  console.error(`[aot-kernel] exit ${res.code}, bundle ${out} (${(bytes / 1e6).toFixed(1)} MB), ${result.wallSec} s`);
  if (o.report) fs.writeFileSync(path.resolve(o.report), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
