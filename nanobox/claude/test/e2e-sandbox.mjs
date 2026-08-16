#!/usr/bin/env node
// Drive web/sandbox.html in headless Chrome (CDP :9222): the linux-base image boots in the VM while the
// first-run installer fetches node + the CLI from the vendors into the persistent tree; wait for the
// CLI's sign-in screen; report the phase timings and the byte accounting (our origin vs vendors).
//   node test/e2e-sandbox.mjs --cli claude|codex|agy [--cold] [--timeout 180] [--q "extra=query"] [--out web/results]
//   --cold   a true first run: the page wipes the persistent tree + caches (?reset=1) and Chrome's HTTP
//            cache is disabled for the run; without it a warm run (everything cached, nothing downloaded)
//   -> web/results/sandbox-<cli>-<cold|warm>.{json,png,console.log}
import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const TIMEOUT_S = Number(opt("--timeout", 180));
const CLI = opt("--cli", "claude");
const COLD = argv.includes("--cold");
const OUT = opt("--out", join(HERE, "../web/results"));
const TAG = opt("--tag", `sandbox-${CLI}-${COLD ? "cold" : "warm"}`);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `http://localhost:${PORT}/sandbox.html?cli=${CLI}${COLD ? "&reset=1" : ""}${opt("--q", "") ? "&" + opt("--q", "") : ""}`;
const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime, Emulation, Network, Log } = client;
await Promise.all([Page.enable(), Runtime.enable(), Network.enable(), Log.enable()]);
await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
if (COLD || argv.includes("--no-http-cache")) await Network.setCacheDisabled({ cacheDisabled: true });
const consoleLines = [];
Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" ")));
Runtime.exceptionThrown(({ exceptionDetails }) => consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text)));
Log.entryAdded(({ entry }) => consoleLines.push(`[${entry.level}] ${entry.text}`));
console.log(`→ ${url}${COLD ? "  (COLD: persistent tree wiped, HTTP cache off)" : "  (WARM)"}`);
const t0 = Date.now();
await Page.navigate({ url });
await Page.loadEventFired();
const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: true })).result.value;
let seen = 0, verdict = null;
while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
  await sleep(250);
  const st = await ev("window.nanobox ? ({events: window.nanobox.events, phases: window.nanobox.phases, failed: window.nanobox.failed, exitCode: window.nanobox.exitCode, icount: window.nanobox.stats && window.nanobox.stats.icount}) : null");
  if (!st) continue;
  for (; seen < st.events.length; seen++) { const e = st.events[seen]; if (e.event === "worker:missing" || e.event === "vm:image" || e.event === "vm:jit-bundles") continue; console.log(`  +${(e.t / 1000).toFixed(1).padStart(6)}s ${e.event}${e.name ? " " + e.name : ""}${e.stage ? "" : ""}${e.key ? " " + e.key : ""}${e.message ? " " + String(e.message).slice(0, 300) : ""}${e.text ? " " + String(e.text).slice(0, 200) : ""}${e.bytes != null ? " " + (e.bytes / 1e6).toFixed(1) + " MB" : ""}${e.ms != null && e.event !== "signin" ? " " + e.ms + " ms" : ""}${e.url ? " " + (e.method || "") + " " + e.url : ""}${e.waitMs != null ? " wait " + e.waitMs + " ms" : ""}${e.files != null ? " files " + e.files : ""}`); }
  if (st.phases.signinMs != null) { const p = st.phases; const boot = p.bootMs != null ? p.bootMs : p.helloMs; verdict = { signinMs: Math.round(p.signinMs), loadMs: p.vmStartMs != null ? Math.round(p.vmStartMs) : null, bootMs: boot != null && p.vmStartMs != null ? Math.round(boot - p.vmStartMs) : null, runMs: boot != null ? Math.round(p.signinMs - boot) : null, engineMs: p.engineMs != null ? Math.round(p.engineMs) : null, imageMs: p.imageMs != null ? Math.round(p.imageMs) : null, installMs: p.installMs != null ? Math.round(p.installMs) : null, persistMs: p.persistMs != null ? Math.round(p.persistMs) : null, helloMs: p.helloMs != null ? Math.round(p.helloMs) : null, bundleMs: p.bundleMs, transformMs: p.transformMs, icount: st.icount || undefined }; break; }
  if (st.failed) { verdict = { failed: true, exitCode: st.exitCode }; break; }
}
// ---- byte accounting -------------------------------------------------------------------------------
await sleep(500);
const dump = CLI === "claude" ? await ev("window.nanobox.dump().catch(() => null)") : null;
const acct = await ev(`(() => { const n = window.nanobox; return { pageResources: n.pageResources(), pageNet: n.pageNet.requests, perf: n.perf, install: n.installInfo, persistLog: n.persistLog }; })()`);
const origin = `http://localhost:${PORT}`;
const rows = new Map(); // url -> {bytes, via, kind}
const add = (u, bytes, via, kind) => { const cur = rows.get(u); if (cur) { cur.bytes = Math.max(cur.bytes, bytes); if (kind) cur.kind = kind; } else rows.set(u, { bytes, via, kind }); };
const kindOf = (u) => { try { const p = new URL(u).pathname; if (p.includes("/engine/opt/") && p.endsWith("out.wasm.gzip")) return "engine"; if (p.includes("imagemounter")) return "imagemounter"; if (p.startsWith("/c2w/images/")) return "image"; if (p.startsWith("/engine/opt/jit/")) return "jit-bundles"; if (p === "/net/fetch") return "relay"; if (p.startsWith("/images/")) return "spec"; if (p.endsWith("nbnode")) return "shim"; if (/\.(js|css|html)$/.test(p) || p === "/sandbox.html") return "runtime/pages"; return "other"; } catch { return "other"; } };
for (const r of acct.pageResources || []) if (r.name.startsWith(origin)) add(r.name, r.transferSize || 0, "origin", kindOf(r.name));
for (const src of [acct.perf && acct.perf.vm, acct.perf && acct.perf.installer]) for (const r of (src && src.resources) || []) if (r.name.startsWith(origin)) add(r.name, r.transferSize || 0, "origin", kindOf(r.name));
for (const r of (acct.perf && acct.perf.vm && acct.perf.vm.requests) || []) if (r.method !== "HEAD") add(r.url + (r.method === "POST" ? "#" + Math.random() : ""), r.bytes || 0, "origin", kindOf(r.url));
for (const r of acct.pageNet || []) { if (r.via === "origin") add(r.url, r.bytes || 0, "origin", kindOf(r.url)); else add(r.url + "#" + Math.random(), r.bytes || 0, r.via, r.host); }
const vendorDirect = {}, vendorRelay = {};
for (const d of (acct.install && acct.install.downloads) || []) { const t = d.via === "relay" ? vendorRelay : vendorDirect; t[d.host] = (t[d.host] || 0) + d.bytes; }
if (dump && dump.netBytes) for (const [h, rec] of Object.entries(dump.netBytes.hosts || {})) { const t = rec.path === "relayed" ? vendorRelay : rec.path === "direct" ? vendorDirect : null; if (t) t[h] = (t[h] || 0) + rec.bytes; }
for (const [u, r] of rows) if (r.via === "direct") vendorDirect[r.kind] = (vendorDirect[r.kind] || 0) + r.bytes; else if (r.via === "relay") vendorRelay[r.kind] = (vendorRelay[r.kind] || 0) + r.bytes;
const ours = {}; let oursTotal = 0;
for (const [u, r] of rows) if (r.via === "origin" && r.kind !== "relay") { ours[r.kind] = (ours[r.kind] || 0) + r.bytes; oursTotal += r.bytes; }
const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);
const accounting = { ours, oursTotal, vendorDirect, vendorDirectTotal: sum(vendorDirect), vendorRelay, vendorRelayTotal: sum(vendorRelay) };
const screen = (await ev("window.nanobox ? window.nanobox.screen() : ''")) || "";
try { const { data } = await Page.captureScreenshot({ format: "png" }); writeFileSync(join(OUT, `${TAG}.png`), Buffer.from(data, "base64")); } catch {}
const rec = { cli: CLI, cold: COLD, url, verdict, date: new Date().toISOString(), browser: await ev("navigator.userAgent"), install: acct.install, accounting, events: (await ev("window.nanobox.events")).filter((e) => e.event !== "worker:missing" && e.event !== "vm:image"), persistLog: acct.persistLog, missing: dump ? dump.missing : null, spawns: dump ? dump.spawns : null, net: dump ? dump.net : null, netBytes: dump ? dump.netBytes : null, backendOps: dump ? dump.backendOps : null, backendStats: dump ? dump.backendStats : null, screenTail: screen.trim().split("\n").filter((l) => l.trim()).slice(-25) };
writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(rec, null, 2));
writeFileSync(join(OUT, `${TAG}.console.log`), consoleLines.join("\n"));
console.log("\n--- screen ---\n" + rec.screenTail.join("\n"));
const mb = (b) => (b / 1e6).toFixed(1).padStart(7) + " MB";
console.log(`\n--- bytes (${COLD ? "cold" : "warm"}) ---`);
console.log(`  our origin      ${mb(oursTotal)}   ` + Object.entries(ours).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)}`).join(", "));
console.log(`  vendors direct  ${mb(accounting.vendorDirectTotal)}   ` + Object.entries(vendorDirect).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)}`).join(", "));
console.log(`  vendors relayed ${mb(accounting.vendorRelayTotal)}   ` + Object.entries(vendorRelay).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)}`).join(", "));
if (acct.install) console.log(`  install: ${acct.install.packages} packages, ${acct.install.fromCache} from the store (${acct.install.store}), downloaded ${(acct.install.downloadBytes / 1e6).toFixed(1)} MB in ${acct.install.ms} ms; journals ${JSON.stringify(acct.install.journals)}`);
console.log("\nRESULT " + JSON.stringify(verdict) + `  (${OUT}/${TAG}.{json,png})`);
await CDP.Close({ id: tab.id, port: CDP_PORT });
process.exit(verdict && !verdict.failed ? 0 : 1);
