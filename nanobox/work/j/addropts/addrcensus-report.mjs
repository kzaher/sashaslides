// Address census report (work/j/addropts). Reads the level-3 counters an engine built from
// work/j/addropts/bochs exports and prints where the guest's compiled data accesses land.
//
// Run it with:  NANOBOX_ADDRCENSUS=1 node harness/run.mjs <engine> ... --jit 3:<thr>
//
// The headline is the DIRECT-MAP share: Linux's contiguous map of all physical memory is an affine
// window (host = base + (la - PAGE_OFFSET)), so an access inside it needs a range check and an add
// instead of the 2048-entry DTLB probe every compiled access does today.
const CLASSES = ["user", "direct-map", "vmalloc", "vmemmap", "ktext", "kmodule", "kfixmap", "kother", "non-canonical"];
const M = { TOTAL: 0, FIRST: 1, SAMEPREV: 2, REVISIT: 3, NEWPAGE: 4, PEAK2M: 5, CR3N: 6, CR3OVF: 7,
            PG4: 8, PG2M: 9, H4FULL: 10, UNITS: 11, WINDOWS: 12,
            PFIRST: 13, PSAMEPREV: 14, PREVISIT: 15, PNEWPAGE: 16, ROOTN: 17, ROOTOVF: 18,
            KERN_CPL3: 19, DIRECT_CPL3: 20, N: 21 };

export function addrCensusReport(ex) {
  const stat = (sel, i) => ex.nanobox_jit_addrstat(sel, i);
  const u64 = (loSel, hiSel, i) => (BigInt(stat(hiSel, i) >>> 0) << 32n) | BigInt(stat(loSel, i) >>> 0);
  const hex = (v) => "0x" + v.toString(16).padStart(16, "0");
  const misc = Array.from({ length: M.N }, (_, i) => stat(12, i));
  const total = misc[M.TOTAL];
  if (!total) return "[addrcensus] no accesses recorded (engine built without the census, or level < 3)";
  const out = [];
  const pct = (a) => (100 * a / total).toFixed(2) + "%";

  // Stack-window accesses (PUSH/POP/CALL/RET and 8-byte SS operands under NANOBOX_STACKTAG) never
  // touch the DTLB, so they are not part of the population any table-probe change could serve.
  // "probed" below is the accesses that DO run dtlbLookup -- the denominator that matters.
  const probed = CLASSES.reduce((s, _, i) => s + stat(0, i) + stat(1, i), 0);
  out.push(`[addrcensus] compiled data accesses: ${total.toLocaleString()} of which ${probed.toLocaleString()} (${(100 * probed / total).toFixed(2)}%) run the DTLB probe; the rest take the stack window`);
  out.push("[addrcensus] by region -- share of ALL accesses, then of the DTLB-PROBED accesses:");
  const rows = CLASSES.map((name, i) => ({
    name, rd: stat(0, i), wr: stat(1, i), stk: stat(2, i), pg4: stat(3, i), pg2m: stat(4, i),
    lo: u64(5, 6, i), hi: u64(7, 8, i),
  }));
  for (const r of rows) {
    const n = r.rd + r.wr + r.stk;
    if (!n) continue;
    const p = r.rd + r.wr;
    out.push(`  ${r.name.padEnd(14)} ${String(n).padStart(13)} ${pct(n).padStart(7)} of all | probed ${String(p).padStart(12)} ${(100 * p / probed).toFixed(2).padStart(6)}%` +
             `  rd ${(100 * r.rd / probed).toFixed(2).padStart(6)}% wr ${(100 * r.wr / probed).toFixed(2).padStart(6)}% | stk ${String(r.stk).padStart(12)}` +
             `  pages4K ${String(r.pg4).padStart(6)} 2M ${String(r.pg2m).padStart(4)}  [${hex(r.lo)} .. ${hex(r.hi)}] span ${((Number(r.hi - r.lo)) / (1 << 20)).toFixed(1)} MB`);
  }

  out.push("[addrcensus] kernel PGD histogram (index = (la>>39)&0x1ff, base = index<<39 | sign-extension):");
  for (let i = 0; i < 512; i++) {
    const v = stat(9, i);
    if (!v) continue;
    const base = BigInt.asUintN(64, (BigInt(i) << 39n) | 0xffff800000000000n);
    out.push(`  pgd ${String(i).padStart(3)}  ${hex(base)}  ${String(v).padStart(13)}  ${pct(v).padStart(7)}`);
  }
  const uh = [];
  for (let i = 0; i < 512; i++) { const v = stat(10, i); if (v) uh.push(`${i}(${hex(BigInt(i) << 39n)}):${pct(v)}`); }
  if (uh.length) out.push("[addrcensus] user PGD histogram: " + uh.join(" "));

  const top = [];
  for (let i = 0; i < 512; i++) { const v = stat(11, i); if (v) top.push(`${hex(0xffffffff80000000n + (BigInt(i) << 22n))}:${pct(v)}`); }
  if (top.length) out.push("[addrcensus] top-2GB 4 MB buckets: " + top.join(" "));

  const loc = (f, s, r, nw, den) => `first ${(100 * misc[f] / den).toFixed(2)}%  same-page-as-previous ${(100 * misc[s] / den).toFixed(2)}%` +
    `  earlier-page-in-unit ${(100 * misc[r] / den).toFixed(2)}%  new-page ${(100 * misc[nw] / den).toFixed(2)}%` +
    `  => reusable ${(100 * (misc[s] + misc[r]) / den).toFixed(2)}%`;
  out.push(`[addrcensus] locality inside one compiled-unit invocation (${misc[M.UNITS].toLocaleString()} unit entries, ${(total / Math.max(1, misc[M.UNITS])).toFixed(2)} accesses/entry)`);
  out.push("  all accesses:   " + loc(M.FIRST, M.SAMEPREV, M.REVISIT, M.NEWPAGE, total));
  out.push("  DTLB-probed:    " + loc(M.PFIRST, M.PSAMEPREV, M.PREVISIT, M.PNEWPAGE, probed));
  out.push(`[addrcensus] distinct pages: ${misc[M.PG4].toLocaleString()} x 4 KB, ${misc[M.PG2M].toLocaleString()} x 2 MB; ` +
    `peak 2 MB regions live in a 1M-access window: ${misc[M.PEAK2M]} (over ${misc[M.WINDOWS]} windows); 4K-table-full events ${misc[M.H4FULL]}`);
  out.push(`[addrcensus] kernel addresses reached at CPL 3: ${misc[M.KERN_CPL3]} (direct map: ${misc[M.DIRECT_CPL3]}) -- ` +
    "0 means a window fast path may drop the permission test entirely");

  const cr3 = [];
  for (let i = 0, n = ex.nanobox_jit_addrstat_n(13); i < n; i++) { const c = stat(15, i); if (c) cr3.push([u64(13, 14, i), c]); }
  cr3.sort((a, b) => b[1] - a[1]);
  out.push(`[addrcensus] address spaces: ${misc[M.CR3N]} distinct CR3 values over ${misc[M.ROOTN]} distinct page-table roots ` +
    `(overflow ${misc[M.CR3OVF]}/${misc[M.ROOTOVF]}); top: ` + cr3.slice(0, 10).map(([v, n]) => `${hex(v)}:${pct(n)}`).join(" "));
  return out.join("\n");
}
