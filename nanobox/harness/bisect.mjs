#!/usr/bin/env node
// bisect.mjs — find the FIRST guest instruction trace at which two deterministic runs diverge.
//
//   node bisect.mjs A.wasm B.wasm [--a-args "…"] [--b-args "…"] [--every N] [--keep] [--ignore-icount] -- <run.mjs args>
//
// e.g. interpreter vs JIT of the same engine:
//   node bisect.mjs ../build/eh-nb/out.wasm ../build/eh-nb/out.wasm --b-args "--jit 2:2000" \
//        -- --oci http://localhost:8093/c2w/images/codex/ --spec ../web/images/codex/config.json \
//           --cmd /usr/local/bin/codex --expect "Press enter to continue"
// or two engine builds (reference vs optimized): node bisect.mjs ../build/ref-nb/out.wasm ../build/eh-nb/out.wasm -- …
//
// How it works (two levels instead of a log2 binary search — each level costs one run per side):
//   1. Both sides run with the engine's fingerprint logger in CHAIN mode: after every executed
//      trace the CPU state (all GPRs, RIP, prev_rip, lazy flags, eflags, icount, ticks,
//      async_event) is hashed into a running chain, and the chain value is written out every N
//      traces ("C <trace#> <hash>"). That is the "snapshot every N instructions" stream; it costs
//      almost nothing, so N can be small. The first block whose chain hash differs bounds the
//      divergence to a window of N traces [k-N, k) — every earlier block is provably identical.
//   2. Both sides run again with the logger in DETAIL mode restricted to that window: one line per
//      trace with the full register file, RIP, flags, ticks, the trace's physical address and its
//      decoded opcode list. The first line that differs is the diverging trace; the tool prints the
//      last identical trace, the diverging one on both sides, and exactly which registers/flags
//      differ — i.e. which x86 instruction (template) produced the wrong state.
// Determinism is what makes this work: harness/run.mjs freezes the host clock, scripts the console
// and (with --oci) serves the rootfs from memory and the network from netstub.js, so the only
// difference between the runs is the engine.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const own = dd >= 0 ? argv.slice(0, dd) : argv, common = dd >= 0 ? argv.slice(dd + 1) : [];
const pos = own.filter((a, i) => !a.startsWith("--") && !(i > 0 && own[i - 1].startsWith("--") && ["--a-args", "--b-args", "--every"].includes(own[i - 1])));
const opt = (n, d) => { const i = own.indexOf(n); return i >= 0 ? own[i + 1] : d; };
const [A, B] = pos;
if (!A || !B) { console.error("usage: bisect.mjs A.wasm B.wasm [--a-args ..] [--b-args ..] [--every N] -- <run.mjs args>"); process.exit(2); }
const EVERY = Number(opt("--every", 100000));
const aArgs = (opt("--a-args", "") || "").split(/\s+/).filter(Boolean), bArgs = (opt("--b-args", "") || "").split(/\s+/).filter(Boolean);
const keep = own.includes("--keep");
const ignoreIc = own.includes("--ignore-icount"); // icount differs between builds at REP string ops (chunking) without any guest-visible effect
const MODEBIT = ignoreIc ? 4 : 0;
const tmp = fs.mkdtempSync(path.join(process.env.NANOBOX_TMP || os.tmpdir(), "nanobox-bisect-"));
const here = path.dirname(new URL(import.meta.url).pathname);

function run(tag, wasm, extra, dbg) {
  const out = path.join(tmp, tag + ".log");
  const args = [path.join(here, "run.mjs"), wasm, ...common, "--quiet", "--no-hash", ...extra, "--dbg", dbg, "--dbg-out", out];
  if (!common.includes("--timeout")) args.push("--timeout", String(opt("--run-timeout", 30))); // a diverging run may never reach --expect
  const t0 = Date.now();
  const r = spawnSync("node", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const dump = (r.stderr.match(/\[harness\] DUMP .*/g) || []).map((l) => l.slice(l.indexOf("{")));
  console.error(`  ${tag}: ${((Date.now() - t0) / 1000).toFixed(1)} s, exit ${r.status}${dump.length ? ", dumps: " + dump.map((d) => { const j = JSON.parse(d); return `${j.label}@ticks=${j.ticks}`; }).join(",") : ""}`);
  if (r.status !== 0 && !fs.existsSync(out)) { console.error(r.stderr.slice(-2000)); process.exit(1); }
  return { out, dumps: dump };
}

console.error(`bisect: A=${A} ${aArgs.join(" ")} | B=${B} ${bArgs.join(" ")} | every ${EVERY} traces\nlevel 1: chained fingerprints`);
const a1 = run("A-chain", A, aArgs, `${1 | MODEBIT}:${EVERY}`), b1 = run("B-chain", B, bArgs, `${1 | MODEBIT}:${EVERY}`);
const chain = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("C ")).map((l) => { const [, idx, h] = l.split(" "); return { idx: Number(idx), h }; });
const ca = chain(a1.out), cb = chain(b1.out);
let k = -1;
for (let i = 0; i < Math.min(ca.length, cb.length); i++) if (ca[i].h !== cb[i].h) { k = i; break; }
if (k < 0) {
  if (ca.length !== cb.length) console.log(`no divergence within the ${Math.min(ca.length, cb.length)} common blocks, but the runs have different lengths (${ca.length} vs ${cb.length} blocks of ${EVERY} traces) — one side ran longer; compare the final DUMPs.`);
  else console.log(`no divergence: ${ca.length} blocks × ${EVERY} traces have identical chained state hashes` + (a1.dumps.length ? `; final dumps A=${a1.dumps.join("|")} B=${b1.dumps.join("|")}` : ""));
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
const TO = ca[k].idx, FROM = k > 0 ? ca[k - 1].idx : 0;
console.error(`level 1: first differing block #${k}: traces [${FROM}, ${TO}) (chain ${ca[k].h} vs ${cb[k].h}); ${k} earlier blocks identical\nlevel 2: per-trace detail in that window`);
const a2 = run("A-detail", A, aArgs, `${2 | MODEBIT}:0:${FROM}:${TO}`), b2 = run("B-detail", B, bArgs, `${2 | MODEBIT}:0:${FROM}:${TO}`);
const detail = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("T "));
const ta = detail(a2.out), tb = detail(b2.out);
// normalise: drop the "jitted" flag (field 3) — it legitimately differs between interpreter and JIT
// compare STATE only (registers, RIP, flags, ticks, icount, async): the trace annotation (pa/tlen/ops)
// can legitimately differ at interrupt/exception boundaries and for in-region blocks
const norm = (l) => {
  const [head, regs] = l.split(" | ");
  const t = head.split(" ");
  const p = [t[1], ...t.slice(3).filter((x) => x.includes("=") && !/^(pa=|tlen=)/.test(x))]; // index + state fields; drops the jitted flag and the trace annotation
  if (ignoreIc) { const i = p.findIndex((x) => x.startsWith("ic=")); if (i >= 0) p.splice(i, 1); }
  return p.join(" ") + " | " + (regs || "");
};
let d = -1;
for (let i = 0; i < Math.min(ta.length, tb.length); i++) if (norm(ta[i]) !== norm(tb[i])) { d = i; break; }
if (d < 0) { console.log(`level 2 found no differing trace line in [${FROM},${TO}) (lengths ${ta.length}/${tb.length}) — the chain differs but the logged fields don't: state outside the fingerprint (memory?) or a length mismatch.`); process.exit(1); }
const REGS = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
function parse(l) {
  const [head, regs] = l.split(" | ");
  const m = /^T (\d+) (\d) fp=(\w+) rip=(\w+) prev=(\w+) ic=(\d+) tk=(\d+) ae=(\w+) lf=(\w+)\/(\w+) pa=(\w+) tlen=(\d+):(.*)$/.exec(head);
  if (!m) return null;
  return { idx: m[1], jitted: m[2], rip: m[4], prev: m[5], ic: m[6], tk: m[7], ae: m[8], lfres: m[9], lfaux: m[10], pa: m[11], tlen: m[12], ops: m[13].trim(), regs: (regs || "").trim().split(" ") };
}
const pa = parse(ta[d]), pb = parse(tb[d]);
console.log(`\nDIVERGENCE at trace #${pa ? pa.idx : "?"} (window [${FROM},${TO}), ${d} identical traces before it in the window)`);
if (d > 0) console.log(`last identical trace:\n  ${ta[d - 1]}`);
console.log(`A: ${ta[d]}\nB: ${tb[d]}`);
if (pa && pb) {
  const diffs = [];
  for (const f of ["rip", "prev", "ic", "tk", "ae", "lfres", "lfaux"]) if (pa[f] !== pb[f]) diffs.push(`${f}: ${pa[f]} vs ${pb[f]}`);
  for (let r = 0; r < 16; r++) if (pa.regs[r] !== pb.regs[r]) diffs.push(`${REGS[r]}: ${pa.regs[r]} vs ${pb.regs[r]}`);
  console.log(`differs in: ${diffs.join("; ") || "(only in unlogged state)"}`);
  console.log(`the trace that produced this state (A: pa=${pa.pa}, ${pa.tlen} instr${pa.jitted === "1" ? ", JIT-compiled" : ", interpreted"}): ${pa.ops}`);
  if (pa.ops === pb.ops && pa.pa === pb.pa) console.log(`same code on both sides -> the culprit is one of these ${pa.tlen} instructions (or an interrupt/exception taken at a different point if rip/tk differ)`);
  else console.log(`different code executed -> control flow already diverged in the previous trace's outcome; look at the last identical trace's opcode list`);
}
console.log(`\nlogs: ${tmp}${keep ? "" : " (deleted; pass --keep to retain)"}`);
if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
process.exit(3);
