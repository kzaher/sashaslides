// profwindow.mjs FILE.cpuprofile [--last SEC | --first SEC | --from SEC --to SEC] [--top N]
//   Self-time summary of a V8 CPU profile restricted to a time window, expressed in seconds from the
//   START of the profile. The nanobox harness runs boot and then a steady state (e.g. a TUI redraw
//   loop); "--last 5" isolates the steady state without needing to correlate two clocks.
import fs from "node:fs";
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const prof = JSON.parse(fs.readFileSync(argv[0], "utf8"));
const topN = arg("--top", 40);
const dt = prof.timeDeltas, samples = prof.samples;
const times = new Array(samples.length);
let t = prof.startTime;
for (let i = 0; i < samples.length; i++) { t += dt[i] || 0; times[i] = t; }
const spanUs = times[times.length - 1] - prof.startTime;
const last = arg("--last", NaN), first = arg("--first", NaN);
let fromUs = prof.startTime, toUs = times[times.length - 1];
if (!Number.isNaN(last)) fromUs = toUs - last * 1e6;
else if (!Number.isNaN(first)) toUs = fromUs + first * 1e6;
else { fromUs = prof.startTime + arg("--from", 0) * 1e6; toUs = prof.startTime + arg("--to", spanUs / 1e6) * 1e6; }
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
// The engine is one wasm module with thousands of functions; every JIT batch is its own small module.
const functionsPerModule = new Map();
for (const node of prof.nodes) { const url = node.callFrame.url || ""; if (!url.startsWith("wasm://")) continue;
  const key = url.split("/").slice(0, 4).join("/"); if (!functionsPerModule.has(key)) functionsPerModule.set(key, new Set()); functionsPerModule.get(key).add(node.callFrame.functionName); }
const engineModule = [...functionsPerModule.entries()].sort((a, b) => b[1].size - a[1].size).map(([key]) => key)[0];
const self = new Map();
const categories = new Map();
let sum = 0;
for (let i = 0; i < samples.length; i++) {
  if (times[i] < fromUs || times[i] > toUs) continue;
  const node = byId.get(samples[i]); const frame = node.callFrame;
  const module = (frame.url || "").startsWith("wasm://") ? (frame.url.split("/").slice(0, 4).join("/") === engineModule ? "engine" : "jit") : null;
  const name = (frame.functionName || "(anon)") + (module ? " [" + module + "]" : frame.url ? " [" + frame.url.split("/").pop() + "]" : "");
  const d = dt[i] || 0;
  self.set(name, (self.get(name) || 0) + d); sum += d;
  const bucket = module || (/^\(garbage|^\(program|^\(idle|^\(root/.test(frame.functionName || "") ? frame.functionName : "js");
  categories.set(bucket, (categories.get(bucket) || 0) + d);
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
console.log(`profile span ${(spanUs / 1e6).toFixed(2)}s; window [${((fromUs - prof.startTime) / 1e6).toFixed(2)}, ${((toUs - prof.startTime) / 1e6).toFixed(2)}]s = ${(sum / 1e6).toFixed(2)}s sampled`);
for (const [name, us] of rows.slice(0, topN)) console.log(`${(100 * us / sum).toFixed(2).padStart(6)}%  ${(us / 1e6).toFixed(3).padStart(8)}s  ${name}`);
console.log("--- categories");
for (const [name, us] of [...categories].sort((a, b) => b[1] - a[1])) console.log(`${(100 * us / sum).toFixed(2).padStart(6)}%  ${(us / 1e6).toFixed(3).padStart(8)}s  ${name}`);
