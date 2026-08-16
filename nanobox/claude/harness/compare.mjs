#!/usr/bin/env node
// compare.mjs — compare the DUMP lines of two harness runs (as captured on stderr).
// Identity criteria: label, ticks, rip, sha256 of guest RAM, block map. icount is reported but not
// part of the criteria (Bochs' fast-string chunking makes it host-clock dependent, see README).
import fs from "node:fs";
const [a, b] = process.argv.slice(2);
const load = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes("[harness] DUMP ")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
const A = load(a), B = load(b);
let ok = true;
const n = Math.max(A.length, B.length);
for (let i = 0; i < n; i++) {
  const x = A[i], y = B[i];
  if (!x || !y) { console.log(`#${i}: only in ${x ? "A" : "B"}: ${(x || y).label}`); ok = false; continue; }
  const diffs = [];
  for (const k of ["label", "ticks", "rip", "sha256"]) if (x[k] !== y[k]) diffs.push(`${k}: ${x[k]} != ${y[k]}`);
  if (JSON.stringify(x.blocks) !== JSON.stringify(y.blocks)) diffs.push(`blocks: ${JSON.stringify(x.blocks)} != ${JSON.stringify(y.blocks)}`);
  const ic = x.icount === y.icount ? "" : ` (icount ${x.icount} vs ${y.icount})`;
  if (diffs.length) { ok = false; console.log(`#${i} ${x.label}: DIFF ${diffs.join("; ")}${ic}`); }
  else console.log(`#${i} ${x.label}: identical ticks=${x.ticks} sha=${x.sha256.slice(0, 12)}${ic}`);
}
console.log(ok ? "RESULT: IDENTICAL" : "RESULT: DIFFERENT");
process.exit(ok ? 0 : 1);
