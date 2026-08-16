#!/usr/bin/env node
// Drive web/claude-native.html (Claude Code's JS on the browser's V8, no emulation) in headless
// Chrome (CDP :9222): wait for the sign-in screen, print the time and the recorded missing-API list.
//   node test/e2e-native.mjs [--timeout 120] [--image claude-npm] [--out web/results] [--q "extra=query"]
//   -> web/results/claude-native.{json,png}
import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const TIMEOUT_S = Number(opt("--timeout", 120));
const IMAGE = opt("--image", "claude-npm");
const OUT = opt("--out", join(HERE, "../web/results"));
const TAG = opt("--tag", "claude-native");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `http://localhost:${PORT}/claude-native.html?image=${IMAGE}${opt("--q", "") ? "&" + opt("--q", "") : ""}`;
const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime, Emulation, Network, Log } = client;
await Promise.all([Page.enable(), Runtime.enable(), Network.enable(), Log.enable()]);
await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
if (argv.includes("--no-http-cache")) await Network.setCacheDisabled({ cacheDisabled: true });
const consoleLines = [];
Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" ")));
Runtime.exceptionThrown(({ exceptionDetails }) => consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text)));
Log.entryAdded(({ entry }) => consoleLines.push(`[${entry.level}] ${entry.text}`));
console.log(`→ ${url}`);
const t0 = Date.now();
await Page.navigate({ url });
await Page.loadEventFired();
const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: true })).result.value;
let seen = 0, verdict = null;
while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
  await sleep(250);
  const st = await ev("window.nanobox ? ({events: window.nanobox.events, signinMs: window.nanobox.signinMs, runStartMs: window.nanobox.runStartMs, bundleMs: window.nanobox.bundleMs, failed: window.nanobox.failed, exitCode: window.nanobox.exitCode}) : null");
  if (!st) continue;
  for (; seen < st.events.length; seen++) { const e = st.events[seen]; if (e.event === "worker:missing") continue; console.log(`  +${(e.t / 1000).toFixed(1).padStart(6)}s ${e.event}${e.name ? " " + e.name : ""}${e.message ? " " + String(e.message).slice(0, 300) : ""}${e.ms != null && e.event !== "signin" ? " " + e.ms + " ms" : ""}${e.url ? " " + e.method + " " + e.url : ""}`); }
  if (st.signinMs != null) { verdict = { signinMs: Math.round(st.signinMs), loadMs: Math.round(st.runStartMs), runMs: Math.round(st.signinMs - st.runStartMs), bundleMs: st.bundleMs }; break; }
  if (st.failed) { verdict = { failed: true, exitCode: st.exitCode }; break; }
}
const dump = await ev("window.nanobox.dump().catch(() => null)");
const screen = (await ev("window.nanobox ? window.nanobox.screen() : ''")) || "";
try { const { data } = await Page.captureScreenshot({ format: "png" }); writeFileSync(join(OUT, `${TAG}.png`), Buffer.from(data, "base64")); } catch {}
const rec = { image: IMAGE, url, verdict, date: new Date().toISOString(), browser: await ev("navigator.userAgent"), events: (await ev("window.nanobox.events")).filter((e) => e.event !== "worker:missing"), missing: dump ? dump.missing : null, stubCalls: dump ? dump.calls : null, spawns: dump ? dump.spawns : null, net: dump ? dump.net : null, backendOps: dump ? dump.backendOps : null, screenTail: screen.trim().split("\n").filter((l) => l.trim()).slice(-25) };
writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(rec, null, 2));
writeFileSync(join(OUT, `${TAG}.console.log`), consoleLines.join("\n"));
console.log("\n--- screen ---\n" + rec.screenTail.join("\n"));
if (rec.missing) { console.log(`\n--- missing APIs (${rec.missing.length}) ---`); for (const m of rec.missing.slice(0, 80)) console.log(`  ${String(m.count).padStart(5)}  ${m.key}   ${m.stack || ""}`); }
if (rec.spawns && rec.spawns.length) { console.log(`\n--- spawn attempts (${rec.spawns.length}) ---`); for (const s of rec.spawns.slice(0, 30)) console.log(`  ${s.sync ? "sync " : ""}${s.file} ${(s.args || []).join(" ")}`); }
if (rec.net && rec.net.length) { console.log(`\n--- network (${rec.net.length}) ---`); for (const n of rec.net.slice(0, 30)) console.log(`  +${(n.t / 1000).toFixed(1)}s ${n.method} ${n.url}`); }
console.log("\nRESULT " + JSON.stringify(verdict) + `  (${OUT}/${TAG}.{json,png})`);
await CDP.Close({ id: tab.id, port: CDP_PORT });
process.exit(verdict && !verdict.failed ? 0 : 1);
