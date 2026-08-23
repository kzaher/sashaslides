// sysnorm.mjs -- the tick-INSENSITIVE syscall-trace comparison (plan item 10 of
// docs/aot-size-and-coverage.md). Off by default: compare-heap.mjs still compares the two traces
// literally unless it is given --normalise-addresses.
//
// WHY IT EXISTS. The literal comparison is exact and it is what gates every non-AOT change, because
// two engines with the same tick stream emit byte-identical traces (measured: ref vs opt vs the
// deliberately broken engine are all byte-identical on codex, and ref vs opt on agy). It stops
// working the moment the tick count legitimately differs -- i.e. for every AOT-mode engine -- not
// because the guest misbehaves but because the guest DERIVES ADDRESSES FROM TIME: codex's Go runtime
// picks its arena hint from a clock-seeded PRNG, so trace line 77 is
//     A: S 40 9 2e286c000000 4000000 ...        B: S 40 9 1e26b0000000 4000000 ...
// and from there every pointer into that arena differs. That is a renaming, not a defect.
//
// WHAT IT DOES. Compare the two traces up to a CONSISTENT RENAMING OF RUN-DERIVED ADDRESSES:
//
//  * Structure is literal and never renamed: the line kind (S / R / W), the sequence number, the
//    syscall NUMBER, the ordering, the W line's buffer index, its length, its `got` and its FNV-1a.
//  * A RENAMED REGION is created only where the guest can legitimately invent an address: the `addr`
//    hint of mmap/mremap, and the return value of mmap/brk/mremap/shmat. Nothing else may introduce
//    one. A region carries the length the guest asked for, so it maps a bounded window, not the
//    whole address space.
//  * Every other differing value -- any argument, any return, the RIP -- is a violation unless an
//    ALREADY-ESTABLISHED region explains it. In `delta` mode (the default, and the sharp one) it is
//    explained only when vA - baseA == vB - baseB inside one region: the same offset in the same
//    renamed window. In `bij` mode a pair of values inside the same region pair may also bind 1:1 on
//    first sight and must agree ever after -- injective in both directions, so a value that has been
//    bound to one partner can never agree with a second one.
//  * Arguments BEYOND THE SYSCALL'S ARITY are not compared (counted and reported instead). The trace
//    always prints six registers; for a 2-argument call like sigaltstack the last four are whatever
//    happened to be in r10/r8/r9, which the kernel never reads. This is the one relaxation here that
//    is not a renaming, and it is a static per-number fact, not a guess about a value. Unknown
//    syscall numbers default to arity 6, i.e. to the strict behaviour.
//  * WRITE PAYLOADS stay literal. If the FNV-1a differs, the only escape is that the first 48
//    recorded bytes differ ONLY in aligned 8-byte little-endian words that are themselves explained
//    by a region -- a pointer inside the buffer. That is counted and reported separately, never
//    silently accepted, and a payload whose hash differs while its snippet is IDENTICAL is always a
//    violation (the difference is past the snippet and cannot be explained).
//
// THE PROPERTY THAT MAKES IT SAFE: on a pair of engines with the same tick stream nothing ever
// differs at a binding site, so ZERO regions are created and the comparison degenerates EXACTLY to
// the literal one. Normalisation cannot cost sharpness on the path that gates today.

// x86-64 syscall arity. Only used to ignore the registers past a call's argument count; a number
// missing here is treated as taking all six (strict).
export const SYS_ARITY = new Map(Object.entries({
  0: 3, 1: 3, 2: 3, 3: 1, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3, 9: 6, 10: 3, 11: 2, 12: 1, 13: 4, 14: 4,
  15: 0, 16: 3, 17: 4, 18: 4, 19: 3, 20: 3, 21: 2, 22: 1, 23: 5, 24: 0, 25: 5, 26: 3, 27: 3, 28: 3,
  32: 1, 33: 2, 34: 0, 35: 2, 37: 1, 38: 3, 39: 0, 41: 3, 42: 3, 43: 3, 44: 6, 45: 6, 46: 3, 47: 3,
  48: 2, 49: 3, 50: 2, 51: 3, 52: 3, 53: 4, 54: 5, 55: 5, 56: 5, 57: 0, 58: 0, 59: 3, 60: 1, 61: 4,
  62: 2, 63: 1, 72: 3, 73: 2, 74: 1, 75: 1, 77: 2, 79: 2, 80: 1, 81: 1, 82: 2, 83: 2, 87: 1, 88: 2,
  89: 3, 90: 2, 91: 2, 93: 3, 95: 1, 96: 2, 97: 2, 99: 1, 102: 0, 104: 0, 105: 1, 106: 1, 107: 0,
  108: 0, 109: 2, 110: 0, 111: 0, 112: 0, 115: 2, 116: 2, 125: 2, 126: 2, 128: 4, 131: 2, 137: 2,
  138: 2, 155: 2, 157: 5, 158: 2, 165: 5, 166: 2, 186: 0, 202: 6, 204: 3, 217: 3, 218: 1, 227: 2,
  228: 2, 230: 4, 231: 1, 232: 4, 233: 4, 234: 3, 247: 5, 250: 5, 254: 3, 255: 2, 257: 4, 258: 3,
  259: 4, 260: 5, 262: 4, 263: 3, 264: 4, 266: 3, 267: 4, 268: 3, 269: 3, 272: 1, 273: 2, 280: 4,
  281: 6, 288: 4, 290: 2, 291: 1, 292: 3, 293: 2, 294: 1, 302: 4, 308: 2, 309: 3, 318: 3, 321: 3,
  324: 3, 332: 5, 334: 4, 424: 4, 428: 3, 430: 2, 431: 5, 432: 3, 434: 2, 435: 2, 436: 3, 437: 4,
  439: 4,
}).map(([k, v]) => [Number(k), v]));

const SYS_MMAP = 9, SYS_BRK = 12, SYS_MREMAP = 25, SYS_SHMAT = 30;
const ADDR_MIN = 0x10000n;              // below mmap_min_addr nothing is a legal user mapping
const ADDR_MAX = 1n << 48n;             // 48-bit user VA
const PAGE = 0x1000n;

const shaped = (v) => v >= ADDR_MIN && v < ADDR_MAX;

// `S seq nr a0 a1 a2 a3 a4 a5 rip=RIP` / `R seq rax` / `W seq which len=.. got=.. h=.. b=hex`
export function parseSysLine(l) {
  const p = l.split(" ");
  if (p[0] === "S") return { k: "S", seq: p[1], nr: Number(p[2]), a: p.slice(3, 9).map((x) => BigInt("0x" + x)), rip: BigInt("0x" + p[9].slice(4)) };
  if (p[0] === "R") return { k: "R", seq: p[1], rax: BigInt("0x" + p[2]) };
  if (p[0] === "W") return { k: "W", seq: p[1], which: p[2], len: p[3], got: p[4], h: p[5], b: (p[6] || "b=").slice(2) };
  return { k: "?", raw: l };
}

class Renaming {
  constructor(mode) {
    this.mode = mode;                   // "delta" | "bij"
    this.regions = [];                  // { a, b, len, origin }
    this.pairA = new Map(); this.pairB = new Map();
    this.stats = { regions: 0, byDelta: 0, byBijection: 0, bijBound: 0, beyondArity: 0, payloadPtr: 0 };
  }
  region(va, vb) {
    for (const r of this.regions) if (va >= r.a && va - r.a < r.len && vb >= r.b && vb - r.b < r.len) return r;
    return null;
  }
  // An EQUAL pair is a violation when the value lies inside a region that has been renamed: the
  // region says the two sides hold that window at different addresses, so a value that is the same
  // on both sides cannot be a pointer into it. This is what closes the binder sites: mutate an mmap
  // hint and the mapping it invents immediately contradicts the (unmutated) result that follows.
  conflictsWhenEqual(v) {
    for (const r of this.regions) if ((v >= r.a && v - r.a < r.len) || (v >= r.b && v - r.b < r.len)) return true;
    return false;
  }
  // Can this differing pair be excused by a renaming already established?  Never creates a region.
  explains(va, vb) {
    if (va === vb) return !this.conflictsWhenEqual(va);
    for (const r of this.regions) if (va >= r.a && va - r.a < r.len && va - r.a === vb - r.b) { this.stats.byDelta++; return true; }
    if (this.mode !== "bij") return false;
    if (!this.region(va, vb)) return false;
    const known = this.pairA.get(va);
    if (known !== undefined) { if (known !== vb) return false; this.stats.byBijection++; return true; }
    if (this.pairB.has(vb)) return false;            // not injective the other way -> a real conflict
    this.pairA.set(va, vb); this.pairB.set(vb, va);
    this.stats.bijBound++; this.stats.byBijection++;
    return true;
  }
  // A new region may only be created for an address that is not already inside one. A guest that
  // asks for a fresh mapping asks outside what it already owns; a "hint" that points into a region
  // already bound is an address the guest COMPUTED, so it has to be explained by that region, not
  // allowed to invent a second one. This is what stops the binder sites from being a hole: without
  // it, mutating an mmap hint (or an mmap return) to another address inside a live arena is excused.
  bind(va, vb, len, origin) {
    if (va === vb || !shaped(va) || !shaped(vb)) return false;
    for (const r of this.regions) if ((va >= r.a && va - r.a < r.len) || (vb >= r.b && vb - r.b < r.len)) return false;
    this.regions.push({ a: va, b: vb, len: len > PAGE ? len : PAGE, origin });
    this.stats.regions++;
    return true;
  }
}

// Explain a differing write payload snippet as "the buffer holds a renamed pointer": same byte
// length, and every differing byte lies in an aligned 8-byte little-endian word whose two values a
// region explains. Returns false for anything else.
function payloadExplained(ren, ha, hb) {
  if (ha.length !== hb.length || ha.length % 2) return false;
  const ba = Buffer.from(ha, "hex"), bb = Buffer.from(hb, "hex");
  if (ba.length !== bb.length) return false;
  const bad = new Set();
  for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) bad.add(i >> 3);
  if (!bad.size) return false;                        // hash differs but the snippet does not: unexplainable
  for (const w of bad) {
    if ((w + 1) * 8 > ba.length) return false;        // a partial word at the end: cannot read a pointer
    if (!ren.explains(ba.readBigUInt64LE(w * 8), bb.readBigUInt64LE(w * 8))) return false;
  }
  ren.stats.payloadPtr++;
  return true;
}

// Compare two traces up to a consistent renaming. Returns
//   { identical, line, a, b, why, lines, stats }
export function compareSysNormalised(ta, tb, opt = {}) {
  const ren = new Renaming(opt.mode === "bij" ? "bij" : "delta");
  const useArity = opt.arity !== false;
  const n = Math.min(ta.length, tb.length);
  let pend = null;                                    // the S line whose R has not been seen yet
  const fail = (i, why) => ({ identical: false, line: i + 1, a: ta[i], b: tb[i], why, lines: i, stats: ren.stats, regions: ren.regions });
  for (let i = 0; i < n; i++) {
    const la = ta[i], lb = tb[i];
    if (!la || !lb) { if (la !== lb) return fail(i, "end of trace on one side"); break; }
    const x = parseSysLine(la), y = parseSysLine(lb);
    if (x.k !== y.k) return fail(i, `line kind ${x.k} vs ${y.k}`);
    if (x.seq !== y.seq) return fail(i, `sequence number ${x.seq} vs ${y.seq}`);
    if (x.k === "S") {
      if (x.nr !== y.nr) return fail(i, `syscall number ${x.nr} vs ${y.nr}`);
      const regionsBefore = ren.stats.regions;
      const ar = useArity ? (SYS_ARITY.get(x.nr) ?? 6) : 6;
      for (let j = 0; j < 6; j++) {
        if (x.a[j] === y.a[j]) { if (ren.conflictsWhenEqual(x.a[j])) return fail(i, `arg${j} of syscall ${x.nr} is equal but lies in a renamed region`); continue; }
        if (j >= ar) { ren.stats.beyondArity++; continue; }   // register the kernel never reads
        if (ren.explains(x.a[j], y.a[j])) continue;
        // the two binding sites: an mmap/mremap address hint the guest invented for itself
        if ((x.nr === SYS_MMAP || x.nr === SYS_MREMAP) && j === 0 &&
            ren.bind(x.a[0], y.a[0], x.nr === SYS_MMAP ? x.a[1] : x.a[2], `${x.nr === SYS_MMAP ? "mmap" : "mremap"} hint @${i + 1}`)) continue;
        return fail(i, `arg${j} of syscall ${x.nr}`);
      }
      if (!ren.explains(x.rip, y.rip)) return fail(i, x.rip === y.rip ? "rip is equal but lies in a renamed region" : "rip");
      pend = { nr: x.nr, len: x.nr === SYS_MMAP ? x.a[1] : x.nr === SYS_MREMAP ? x.a[2] : PAGE, boundAtHint: ren.stats.regions !== regionsBefore };
    } else if (x.k === "R") {
      {
        if (!ren.explains(x.rax, y.rax)) {
          // ...and a call that already bound a region for its hint may not bind a SECOND one for its
          // result: the result has to agree with the mapping the hint just established.
          const producer = pend && !pend.boundAtHint && (pend.nr === SYS_MMAP || pend.nr === SYS_BRK || pend.nr === SYS_MREMAP || pend.nr === SYS_SHMAT);
          if (!(producer && ren.bind(x.rax, y.rax, pend.len, `${pend.nr} return @${i + 1}`)))
            return fail(i, x.rax === y.rax ? "return value is equal but lies in a renamed region" : "return value");
        }
      }
    } else if (x.k === "W") {
      if (x.which !== y.which || x.len !== y.len || x.got !== y.got) return fail(i, "payload length");
      if (x.h !== y.h && !payloadExplained(ren, x.b, y.b)) return fail(i, "payload bytes");
      if (x.h === y.h && x.b !== y.b) return fail(i, "payload snippet");
    } else if (la !== lb) return fail(i, "unparsed line");
  }
  if (ta.length !== tb.length) {
    const i = n;
    return { identical: false, line: i + 1, a: ta[i], b: tb[i], why: `trace length ${ta.length} vs ${tb.length}`, lines: n, stats: ren.stats, regions: ren.regions };
  }
  return { identical: true, lines: n, stats: ren.stats, regions: ren.regions };
}
