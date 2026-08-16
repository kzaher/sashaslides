// Summarise a V8 .cpuprofile: self time per function (top N), plus a few aggregates.
import fs from "node:fs";
const prof = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const topN = Number(process.argv[3] || 40);
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const total = prof.samples.length;
// timeDeltas give per-sample durations
const dt = prof.timeDeltas;
const counts = new Map();
for (let i = 0; i < prof.samples.length; i++) { const id = prof.samples[i]; counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)); }
let sum = 0;
for (const [id, t] of counts) {
  const n = byId.get(id); const cf = n.callFrame;
  const name = (cf.functionName || "(anon)") + (cf.url && !cf.url.startsWith("wasm") ? " [" + cf.url.split("/").pop() + "]" : "");
  self.set(name, (self.get(name) || 0) + t); sum += t;
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
console.log(`total sampled: ${(sum / 1e6).toFixed(2)}s`);
for (const [name, t] of rows.slice(0, topN)) console.log(`${(100 * t / sum).toFixed(2).padStart(6)}%  ${(t / 1e6).toFixed(3).padStart(8)}s  ${name}`);
// group by category
const cat = (n) => /^\(garbage|^\(program|^\(idle|^\(root/.test(n) ? n : n.includes("[") ? "js:" + n.split("[")[1] : "wasm";
const groups = new Map(); for (const [n, t] of rows) groups.set(cat(n), (groups.get(cat(n)) || 0) + t);
console.log("--- groups"); for (const [g, t] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`${(100 * t / sum).toFixed(2).padStart(6)}%  ${g}`);
