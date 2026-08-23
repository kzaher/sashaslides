#!/usr/bin/env node
// compare-heap.mjs -- the "heap + syscalls" correctness oracle.
//
//   node compare-heap.mjs --a <prefixA> --b <prefixB> [--mask a|union|b|none] [--window F]
//                         [--no-syscalls] [--max-list N] [--json OUT]
//                         [--normalise-addresses [delta|bij]] [--no-arity]
//
// where <prefix>.ph / <prefix>.smap / <prefix>.sys are what `run.mjs --page-hash / --stack-map /
// --syscall-trace` wrote for that engine.
//
// WHAT IT ASSERTS, and why it is a weaker criterion than test/identity.sh in exactly one respect:
//
//  * HEAP: every guest-physical 4 KiB page that is NOT a call-stack page must have the same content
//    on both engines, at the same marker. "Call-stack page" is not an address range -- it is the set
//    of physical pages the CPU itself resolved its stack window to during the run (Bochs'
//    stackPrefetch: push/pop/call/ret/enter/leave, interrupt and exception frames, iret and task
//    switches -- NOT the decoder's SS-segment MOV forms, which this comment used to claim: only
//    BX_IA_MOV_Op32_{GdEd,EdGd} are redirected there, and the 64-bit MOV64S_* handlers are dead code
//    no opcode assigns, so `mov ...(%rsp)` in 64-bit code takes the ordinary path), so
//    it covers kernel per-task stacks, IRQ/exception stacks and every user thread stack uniformly,
//    without knowing a single guest address.
//    The default mask is side A's -- the REFERENCE engine's -- set, never the union: a mask taken
//    from the engine under test would let that engine excuse a difference by claiming a page is
//    stack. Under-masking only makes the oracle stricter; over-masking is what would make it
//    useless, so the mask is deliberately taken from the side that is not being judged.
//
//  * SYSCALLS: the ordered trace of every guest syscall -- number, six arguments, RIP, the return
//    value, and for write-like calls the length + FNV-1a of the bytes and their first N bytes
//    verbatim -- must match line for line. This is what pins behaviour once stack bytes are free to
//    differ: a wrong register, a wrong branch or a wrong memory read shows up in an argument, a
//    return value or a payload long before the guest's heap settles.
//
//  * --normalise-addresses (OFF by default, nothing that gates today changes) replaces the literal
//    syscall comparison with a comparison up to a CONSISTENT RENAMING of the addresses the guest
//    derived from its own clock -- an mmap hint, an ASLR base, a brk result -- so that an AOT-mode
//    engine, whose tick count legitimately differs, can be compared at all. Structure (kind, order,
//    sequence, syscall number, payload length and hash) stays literal; a differing value is a
//    violation unless a region established at an mmap/brk/mremap/shmat result explains it. On a pair
//    of engines with the same tick stream no region is ever created and the comparison is exactly
//    the literal one. See harness/sysnorm.mjs for the full rules and TASKS.md V.9 for the proof.
//
// Exit code 0 = both identical, 1 = a difference (also printed).
import fs from "node:fs";
import crypto from "node:crypto";
import { compareSysNormalised } from "./sysnorm.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const A = opt("--a"), B = opt("--b");
if (!A || !B) { console.error("usage: compare-heap.mjs --a <prefixA> --b <prefixB> [--mask a|union|b|none] [--window F] [--no-syscalls]"); process.exit(2); }
const MASK = opt("--mask", "a"), WINDOW = Number(opt("--window", 1)), MAXLIST = Number(opt("--max-list", 12));
const DO_SYS = !argv.includes("--no-syscalls");
// --normalise-addresses [delta|bij]: tick-insensitive syscall comparison (default OFF = literal).
const NORM = argv.includes("--normalise-addresses");
const NORM_MODE = (() => { const i = argv.indexOf("--normalise-addresses"); const v = i >= 0 ? argv[i + 1] : null; return v === "bij" || v === "delta" ? v : "delta"; })();
const NORM_ARITY = !argv.includes("--no-arity");

// ---- page hashes -------------------------------------------------------------------------------
// A .ph file is a sequence of (header JSON line, base64 of a Uint32Array[2*npages]) pairs, one pair
// per marker. Page hash 0 means "inside a block Bochs never allocated" = an all-zero page.
function readPh(f) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const recs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (!lines[i]) break;
    const hdr = JSON.parse(lines[i]);
    const buf = Buffer.from(lines[i + 1], "base64");
    recs.push({ hdr, words: new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4) });
  }
  return recs;
}
// ---- stack-page map ----------------------------------------------------------------------------
function readSmap(f) {
  const txt = fs.readFileSync(f, "utf8").split("\n");
  const m = /pages=(\d+) marked=(\d+) events=(\d+) seq=(\d+)/.exec(txt[0]) || [];
  const seqOf = new Map();
  for (let i = 1; i < txt.length; i++) { if (!txt[i]) continue; const [p, s] = txt[i].split(" "); seqOf.set(Number(p), Number(s)); }
  return { pages: Number(m[1] || 0), marked: Number(m[2] || 0), events: Number(m[3] || 0), seq: Number(m[4] || 0), seqOf };
}
// A page is masked when it was a stack page inside the last `WINDOW` fraction of the run's stack
// activity. WINDOW=1 is the sticky set (ever a stack); a smaller window drops pages that were a
// stack early and were then freed and recycled -- those must be compared, not excused.
function maskFrom(sm) {
  const cut = sm.seq * (1 - WINDOW);
  const out = new Set();
  for (const [p, s] of sm.seqOf) if (s >= cut) out.add(p);
  return out;
}

const pa = readPh(A + ".ph"), pb = readPh(B + ".ph");
const sa = fs.existsSync(A + ".smap") ? readSmap(A + ".smap") : null;
const sb = fs.existsSync(B + ".smap") ? readSmap(B + ".smap") : null;
let mask = new Set();
if (MASK !== "none") {
  if (MASK === "a" || MASK === "union") { if (!sa) { console.error(`missing ${A}.smap`); process.exit(2); } for (const p of maskFrom(sa)) mask.add(p); }
  if (MASK === "b" || MASK === "union") { if (!sb) { console.error(`missing ${B}.smap`); process.exit(2); } for (const p of maskFrom(sb)) mask.add(p); }
}
console.log(`mask: ${MASK} (window ${WINDOW}) -> ${mask.size} guest-physical pages excluded as call stacks` +
  (sa ? `; A marked ${sa.marked} (${sa.events} stack-window resolutions)` : "") + (sb ? `, B marked ${sb.marked}` : "") +
  (sa && sb ? `; A\\B ${[...maskFrom(sa)].filter((p) => !maskFrom(sb).has(p)).length}, B\\A ${[...maskFrom(sb)].filter((p) => !maskFrom(sa).has(p)).length}` : ""));

let ok = true;
const report = { mask: { kind: MASK, window: WINDOW, pages: mask.size }, markers: [] };
const n = Math.max(pa.length, pb.length);
if (pa.length !== pb.length) { console.log(`markers: A has ${pa.length}, B has ${pb.length}`); ok = false; }
for (let i = 0; i < n; i++) {
  const x = pa[i], y = pb[i];
  if (!x || !y) { console.log(`#${i}: only in ${x ? "A" : "B"}`); ok = false; continue; }
  if (x.hdr.label !== y.hdr.label) { console.log(`#${i}: label ${x.hdr.label} != ${y.hdr.label}`); ok = false; continue; }
  const np = Math.min(x.hdr.npages, y.hdr.npages);
  const diffHeap = [], diffStack = [];
  const keep = crypto.createHash("sha256");
  const w = new Uint32Array(2);
  for (let p = 0; p < np; p++) {
    const a0 = x.words[p * 2], a1 = x.words[p * 2 + 1], b0 = y.words[p * 2], b1 = y.words[p * 2 + 1];
    if (mask.has(p)) { if (a0 !== b0 || a1 !== b1) diffStack.push(p); continue; }
    if (a0 !== b0 || a1 !== b1) { if (diffHeap.length < 1e6) diffHeap.push(p); }
    w[0] = a0; w[1] = a1; keep.update(Buffer.from(w.buffer));
  }
  const digest = keep.digest("hex").slice(0, 16);
  const ticksSame = x.hdr.ticks === y.hdr.ticks, ripSame = x.hdr.rip === y.hdr.rip;
  const m = { label: x.hdr.label, pages: np, compared: np - mask.size, heapDiff: diffHeap.length, stackDiff: diffStack.length,
              digest, ticks: [x.hdr.ticks, y.hdr.ticks], rip: [x.hdr.rip, y.hdr.rip] };
  report.markers.push(m);
  if (diffHeap.length === 0) {
    console.log(`#${i} ${x.hdr.label}: HEAP IDENTICAL over ${np - mask.size} non-stack pages (digest ${digest}); ${diffStack.length} of the ${mask.size} masked stack pages differ` +
      `; ticks ${ticksSame ? "same" : `${x.hdr.ticks} != ${y.hdr.ticks}`}, rip ${ripSame ? "same" : `${x.hdr.rip} != ${y.hdr.rip}`}`);
  } else {
    ok = false;
    console.log(`#${i} ${x.hdr.label}: HEAP DIFFERENT — ${diffHeap.length} non-stack pages differ (first ${Math.min(MAXLIST, diffHeap.length)}: ` +
      diffHeap.slice(0, MAXLIST).map((p) => "0x" + (p * 4096).toString(16)).join(" ") + `); ${diffStack.length} masked stack pages also differ` +
      `; ticks ${ticksSame ? "same" : `${x.hdr.ticks} != ${y.hdr.ticks}`}, rip ${ripSame ? "same" : `${x.hdr.rip} != ${y.hdr.rip}`}`);
  }
  if (!ticksSame || !ripSame) console.log(`    note: ticks/rip are reported, not part of the heap criterion (they ARE part of test/identity.sh)`);
}

// ---- syscall trace -----------------------------------------------------------------------------
if (DO_SYS && fs.existsSync(A + ".sys") && fs.existsSync(B + ".sys")) {
  const ta = fs.readFileSync(A + ".sys", "utf8").split("\n"), tb = fs.readFileSync(B + ".sys", "utf8").split("\n");
  const count = (t, c) => t.reduce((n, l) => n + (l.startsWith(c) ? 1 : 0), 0);
  console.log(`syscalls: A ${count(ta, "S ")} calls / ${count(ta, "W ")} payloads / ${count(ta, "R ")} returns, B ${count(tb, "S ")} / ${count(tb, "W ")} / ${count(tb, "R ")}`);
  if (NORM) {
    const r = compareSysNormalised(ta, tb, { mode: NORM_MODE, arity: NORM_ARITY });
    const st = r.stats;
    const how = `normalised (${NORM_MODE}${NORM_ARITY ? "" : ", args beyond arity still compared"}): ` +
      `${st.regions} renamed region(s), ${st.byDelta} value(s) explained by a region offset` +
      (NORM_MODE === "bij" ? `, ${st.byBijection} by the within-region bijection (${st.bijBound} bound)` : "") +
      `, ${st.beyondArity} register(s) past the call's arity ignored, ${st.payloadPtr} payload(s) holding a renamed pointer`;
    console.log(`  ${how}`);
    for (const g of r.regions.slice(0, MAXLIST)) console.log(`    region ${g.a.toString(16)} <-> ${g.b.toString(16)} len ${g.len.toString(16)} (${g.origin})`);
    if (r.identical) { console.log(`SYSCALLS: IDENTICAL UP TO RENAMING (${r.lines} trace lines)`); report.syscalls = { identical: true, normalised: NORM_MODE, lines: r.lines, stats: st }; }
    else {
      ok = false;
      console.log(`SYSCALLS: **DIFFER** at trace line ${r.line} (${r.why})` + (r.line > 1 ? `\n  last identical: ${ta[r.line - 2]}` : ""));
      console.log(`  A: ${r.a === undefined ? "(end of trace)" : r.a.slice(0, 300)}`);
      console.log(`  B: ${r.b === undefined ? "(end of trace)" : r.b.slice(0, 300)}`);
      report.syscalls = { identical: false, normalised: NORM_MODE, line: r.line, why: r.why, a: r.a, b: r.b, stats: st };
    }
  } else {
  let d = -1;
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) if (ta[i] !== tb[i]) { d = i; break; }
  if (d < 0 && ta.length !== tb.length) d = Math.min(ta.length, tb.length);
  if (d < 0) { console.log(`SYSCALLS: IDENTICAL (${ta.length - 1} trace lines)`); report.syscalls = { identical: true, lines: ta.length - 1 }; }
  else {
    ok = false;
    console.log(`SYSCALLS: **DIFFER** at trace line ${d + 1}` + (d > 0 ? `\n  last identical: ${ta[d - 1]}` : ""));
    console.log(`  A: ${ta[d] === undefined ? "(end of trace)" : ta[d].slice(0, 300)}`);
    console.log(`  B: ${tb[d] === undefined ? "(end of trace)" : tb[d].slice(0, 300)}`);
    report.syscalls = { identical: false, line: d + 1, a: ta[d], b: tb[d] };
  }
  }
} else if (DO_SYS) console.log("syscalls: no trace files (pass --syscall-trace to both runs)");

console.log(ok ? "RESULT: HEAP+SYSCALLS IDENTICAL" : "RESULT: DIFFERENT");
if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify({ ...report, ok }, null, 1));
process.exit(ok ? 0 : 1);
