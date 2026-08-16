#!/usr/bin/env node
// Merge web/results/sandbox-<cli>-{cold,warm}.json into web/results/sandbox-<cli>.json and print the
// markdown tables for docs/sandbox.md (timings + data accounting: our origin vs the vendors).
//   node tools/sandbox-report.mjs [claude codex agy]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../web/results");
const clis = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex", "agy"];
const s = (ms) => (ms == null ? "–" : (ms / 1000).toFixed(1) + " s");
const mb = (b) => (b == null ? "–" : (b / 1e6).toFixed(1));
const rows = [], bytesRows = [];
for (const cli of clis) {
  const rec = { cli };
  for (const mode of ["cold", "warm"]) {
    const f = join(OUT, `sandbox-${cli}-${mode}.json`);
    if (!existsSync(f)) continue;
    const r = JSON.parse(readFileSync(f, "utf8"));
    rec[mode] = { date: r.date, verdict: r.verdict, accounting: r.accounting, install: r.install && { ms: r.install.ms, packages: r.install.packages, fromCache: r.install.fromCache, downloadBytes: r.install.downloadBytes, store: r.install.store, list: r.install.list, journals: r.install.journals } };
    const v = r.verdict || {}, a = r.accounting || {}, i = r.install || {};
    rows.push(`| ${cli} | ${mode} | ${v.failed ? "FAILED" : "**" + s(v.signinMs) + "**"} | ${s(v.engineMs)} / ${s(v.imageMs)} / ${s(v.installMs)} | ${s(v.loadMs)} | ${s(v.bootMs)} | ${s(v.runMs)} | ${i.fromCache === i.packages ? "all from the store" : mb(i.downloadBytes) + " MB in " + s(i.ms)} |`);
    const ours = a.ours || {}, vd = a.vendorDirect || {}, vr = a.vendorRelay || {};
    bytesRows.push(`| ${cli} | ${mode} | **${mb(a.oursTotal)}** | ${Object.entries(ours).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${mb(v)}`).join(", ") || "–"} | ${mb(a.oursCachedTotal)} | **${mb(a.vendorDirectTotal)}** | ${Object.entries(vd).map(([k, v]) => `${k} ${mb(v)}`).join(", ") || "–"} | **${mb(a.vendorRelayTotal)}** | ${Object.entries(vr).map(([k, v]) => `${k} ${mb(v)}`).join(", ") || "–"} |`);
  }
  writeFileSync(join(OUT, `sandbox-${cli}.json`), JSON.stringify(rec, null, 2));
}
console.log("| CLI | run | page load → sign-in | engine / image / install ready | VM start (load) | guest boot | run → sign-in | installer |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
console.log("\n| CLI | run | our origin MB (wire) | of which | ours from browser caches MB | vendors direct MB | of which | vendors relayed MB | of which |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of bytesRows) console.log(r);
