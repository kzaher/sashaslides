#!/usr/bin/env node
// Analyse an instruction-address profile written by `run.mjs --pages FILE`.
//   node pages.mjs FILE [--top 25] [--json OUT]
// Reports how the retired guest instructions are spread over 4 KiB pages of the guest's linear
// address space: kernel (upper half) vs user (lower half), how many pages carry 50/90/99 % of all
// instructions, the hottest pages / 64 KiB / 2 MiB regions, and average trace length per page.
import fs from "node:fs";
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TOP = Number(opt("--top", 25));
const rows = [];
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [lp, c, pp, fl, tr] = line.split(" ").map(Number);
  rows.push({ lp, c, pp, fl, tr });
}
const KERNEL_LP = 0xffff800000000000 / 4096; // canonical upper half
const isK = (r) => r.lp >= KERNEL_LP;
const total = rows.reduce((a, r) => a + r.c, 0);
const hex = (lp) => "0x" + (BigInt(lp) * 4096n).toString(16).padStart(16, "0");
const pct = (x) => (100 * x / total).toFixed(2).padStart(6) + "%";
function summarize(name, rs) {
  const sum = rs.reduce((a, r) => a + r.c, 0), traces = rs.reduce((a, r) => a + r.tr, 0);
  const sorted = rs.slice().sort((a, b) => b.c - a.c);
  const need = (frac) => { let acc = 0, n = 0; for (const r of sorted) { acc += r.c; n++; if (acc >= frac * sum) break; } return n; };
  console.log(`${name}: ${sum.toLocaleString()} instructions (${(100 * sum / total).toFixed(1)}% of all), ${rs.length.toLocaleString()} distinct pages, ${traces.toLocaleString()} traces (avg ${(sum / Math.max(1, traces)).toFixed(1)} instr/trace)`);
  if (rs.length) console.log(`  pages holding 50% / 90% / 99% / 100% of ${name} instructions: ${need(0.5)} / ${need(0.9)} / ${need(0.99)} / ${rs.length}` +
    `   (${(4 * need(0.9)).toLocaleString()} KiB of code for 90%)`);
  return { sum, pages: rs.length, traces, need50: need(0.5), need90: need(0.9), need99: need(0.99), top: sorted.slice(0, TOP) };
}
function regions(rs, shift, label) {
  const m = new Map();
  for (const r of rs) { const k = Math.floor(r.lp / (1 << shift)); m.set(k, (m.get(k) || 0) + r.c); }
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const need = (frac) => { let acc = 0, n = 0; for (const [, c] of sorted) { acc += c; n++; if (acc >= frac * total) break; } return n; };
  console.log(`${label} regions: ${m.size} touched; ${need(0.5)} / ${need(0.9)} / ${need(0.99)} hold 50/90/99% of ALL instructions. Hottest:`);
  for (const [k, c] of sorted.slice(0, 8)) console.log(`   ${hex(k * (1 << shift))}  ${pct(c)}  ${k * (1 << shift) >= KERNEL_LP ? "kernel" : "user"}`);
}
console.log(`profile ${file}: ${total.toLocaleString()} instructions over ${rows.length.toLocaleString()} pages`);
const K = rows.filter(isK), U = rows.filter((r) => !isK(r));
const kk = summarize("kernel", K), uu = summarize("user", U);
const remapped = rows.filter((r) => r.fl & 4).length, mixed = rows.filter((r) => (r.fl & 3) === 3).length;
console.log(`pages whose physical backing changed during the run: ${remapped}; pages executed at both CPL0 and CPL3: ${mixed}`);
console.log(`\nhottest pages (linear address, share, cumulative, phys page, instr/trace):`);
let acc = 0;
for (const r of rows.slice().sort((a, b) => b.c - a.c).slice(0, TOP)) {
  acc += r.c;
  console.log(`  ${hex(r.lp)}  ${pct(r.c)}  cum ${pct(acc)}  phys 0x${(r.pp * 4096).toString(16).padStart(9, "0")}  ${isK(r) ? "kernel" : "user  "}  ${(r.c / Math.max(1, r.tr)).toFixed(1)}`);
}
console.log("");
regions(rows, 4, "64 KiB");
regions(rows, 9, "2 MiB");
if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify({ total, kernel: kk, user: uu, remapped, mixed }, null, 1));
