#!/usr/bin/env node
// E2E: does the nanobox proxy extension carry the LATEST Claude Code — web/sandbox.html?cli=claude-bin,
// the vendor's whole 245.7 MB linux-x64 Bun standalone — including the cold download?
//
//   node test/e2e-proxyext-claude-bin.mjs                     # cold then warm, one Chrome, one profile
//   node test/e2e-proxyext-claude-bin.mjs --only cold|warm
//   options: --port 8093 (serve.mjs)   --cdp-ext 9223 (the Chrome launched here, WITH the extension)
//            --timeout 150     per-case deadline, s — the page's own fail-fast budget
//            --claude-timeout 25   how long to wait for the CLI to draw itself after install, s
//            --keep-profile    do NOT wipe the user-data-dir first (a cold case is then not cold)
//            --chrome <binary> --out /tmp/nanobox-claude-e2e/proxyext-claude-bin
//
// THE HYPOTHESIS. web/netpolicy.js lists downloads.claude.ai as a PROXY_HOST (no CORS), so without the
// extension the whole binary crosses the server relay (POST /net/fetch): 7542 ms, 245_736_718 relayed
// bytes on the recorded baseline (web/results/sandbox-claude-bin-cold.json). WITH the extension the same
// body instead crosses a chrome.runtime port, which is JSON-only — so every byte is base64-framed
// (+33 %, ~327 MB of messages) in 4 MiB chunks behind an 8 MiB unacked-byte backpressure window, with a
// Worker (extension/offscreen-codec.js) doing the encoding. That leg had never been exercised above a
// few MB. This test answers three things, in this order of importance:
//   (a) CORRECTNESS — installer.js's `wholeBinary` compares the delivered bytes against the manifest's
//       sha256 BEFORE installing them (and against manifest.size), so a truncated or mis-framed body
//       must FAIL, not silently install. The install:verified event carries that sha256; it is asserted
//       equal to the relay baseline's, which is what makes "the same bytes arrived" a measurement.
//   (b) ROUTING — relay = 0 and extension > 0, with downloads.claude.ai named explicitly; cross-checked
//       from the browser side via CDP Network events, never from the page's own counter alone.
//   (c) COST — install ms and bytes against the relay baseline, plus the measured throughput of the
//       extension leg (counted in the page from the nanobox-proxy-chunk messages the content script
//       posts, so an unfinished download still yields a bound instead of a shrug).
// And, so this is not merely an install test, the CLI must then draw itself in the guest.
import CDP from "chrome-remote-interface";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromeWithExtension, defaultChrome, waitFor } from "./chrome-extension-harness.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const PORT = Number(opt("--port", 8093)), CDP_EXT = Number(opt("--cdp-ext", 9223));
const TIMEOUT_MS = Number(opt("--timeout", 150)) * 1000;
const CLAUDE_TIMEOUT_MS = Number(opt("--claude-timeout", 25)) * 1000;
const ONLY = opt("--only", null);
const OUT = opt("--out", "/tmp/nanobox-claude-e2e/proxyext-claude-bin");
const HERE = new URL(".", import.meta.url).pathname;
const EXTENSION_DIR = join(HERE, "../extension");
const PROFILE_DIR = opt("--profile", "/tmp/nanobox-proxyext-claude-bin-chrome");

// web/results/sandbox-claude-bin-{cold,warm}.json — the SAME page, the SAME release, over the relay.
const BASELINE = {
  cold: { installMs: 7542, packages: 3, fromCache: 0, downloadBytes: 300351623, direct: 54614905, relayed: 245736718 },
  warm: { installMs: 393, packages: 3, fromCache: 3, downloadBytes: 0, direct: 0, relayed: 0 },
  binary: { url: "https://downloads.claude.ai/claude-code-releases/2.1.288/linux-x64/claude", bytes: 245734584, sha256: "0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c", relayMs: 6193 },
};
// "claude-bin is alive", strongest signal first. The guest is an EMULATED x86-64 and claude-bin is the
// vendor's 245.7 MB Bun standalone, so its first tty paint is minutes away even warm (the relay
// baseline needed a 180 s budget for it too) — that cost is the emulator's, not the bridge's. The
// third signal is therefore the one that fits a test budget: ~/.claude.json and its lock file are
// written by claude-bin and by nothing else in this image, and the installer journals every guest
// write, so a journal tar naming them is proof the guest exec'd the binary and it ran far enough to
// open its config.
const CLI_ALIVE = /Welcome to Claude Code|claude\.ai\/oauth|Sign in|sign in|log in|API key|api key|subscription|browser didn't open|Claude Code v\d/;
const CLI_WROTE_CONFIG = /\.claude\.json/;
const MB = (bytes) => (bytes / 1e6).toFixed(1);

async function main() {
  mkdirSync(OUT, { recursive: true });
  // A cold case means an EMPTY persistent tree, and the tree lives in this profile's OPFS: ?reset=1
  // wipes it from inside the page, but only a fresh profile also empties Chrome's HTTP cache and the
  // extension's own storage. The warm case then deliberately reuses what the cold case installed.
  if (!argv.includes("--keep-profile")) rmSync(PROFILE_DIR, { recursive: true, force: true });
  const results = {};
  const chrome = await chromeWithExtension({ cdpPort: CDP_EXT, userDataDir: PROFILE_DIR, extension: EXTENSION_DIR, binary: opt("--chrome", defaultChrome()) });
  try {
    if (ONLY !== "warm") results.cold = await runCase({ cold: true });
    if (ONLY !== "cold") results.warm = await runCase({ cold: false });
  } finally { chrome.close(); }
  writeFileSync(join(OUT, "result.json"), JSON.stringify({ baseline: BASELINE, results }, null, 2));
  report(results);
  const failures = Object.entries(results).flatMap(([tag, result]) => result.failures.map((failure) => `${tag}: ${failure}`));
  console.log(failures.length ? `\nFAIL\n  ${failures.join("\n  ")}` : "\nPASS");
  console.log(`details: ${OUT}/result.json`);
  process.exit(failures.length ? 1 : 0);
}

async function runCase({ cold }) {
  const tag = cold ? "cold" : "warm";
  const pageUrl = `http://localhost:${PORT}/sandbox.html?cli=claude-bin${cold ? "&reset=1" : ""}`;
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`); };
  console.log(`\n=== ${tag}: Chrome :${CDP_EXT} with the extension → ${pageUrl}`);
  const started = Date.now();
  const tab = await CDP.New({ port: CDP_EXT, url: "about:blank" });
  const client = await CDP({ target: tab, port: CDP_EXT });
  const { Page, Runtime, Network, Log } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Network.enable(), Log.enable()]);
  if (cold) await Network.setCacheDisabled({ cacheDisabled: true });
  const consoleLines = [];
  Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((argument) => argument.value ?? argument.description ?? "").join(" ")));
  Runtime.exceptionThrown(({ exceptionDetails }) => consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text)));
  Log.entryAdded(({ entry }) => consoleLines.push(`[${entry.level}] ${entry.text}`));
  // Browser-side truth for "the server relay was never used", independent of the page's own counter.
  const relayHits = [];
  Network.requestWillBeSent(({ request }) => { if (/\/net\/fetch$/.test(request.url)) relayHits.push(request.method + " " + request.url); });
  // The extension leg, observed and not asked about: the content script window.postMessage()s every
  // decoded chunk to the page, so a capture-phase listener installed before the page's own scripts run
  // counts exactly what crossed chrome.runtime — the only progress signal the big download has, since
  // the installer worker reports a fetch only once it is complete.
  await Page.addScriptToEvaluateOnNewDocument({ source: `
    window.__proxyLeg = { chunks: 0, bytes: 0, heads: 0, dones: 0, errors: [], firstAt: null, lastAt: null };
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message.type !== "string" || !message.type.startsWith("nanobox-proxy-")) return;
      const leg = window.__proxyLeg;
      if (message.type === "nanobox-proxy-head") leg.heads++;
      else if (message.type === "nanobox-proxy-done") leg.dones++;
      else if (message.type === "nanobox-proxy-result" && message.error) leg.errors.push(String(message.error).slice(0, 200));
      else if (message.type === "nanobox-proxy-chunk" && message.body) {
        leg.chunks++; leg.bytes += message.body.byteLength;
        if (leg.firstAt === null) leg.firstAt = performance.now();
        leg.lastAt = performance.now();
      }
    }, true);
  ` });
  const evaluate = async (expression) => { const { result, exceptionDetails } = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
  const screenshot = async (name) => { try { const { data } = await Page.captureScreenshot({ format: "png" }); writeFileSync(join(OUT, `${tag}-${name}.png`), Buffer.from(data, "base64")); } catch {} };
  const summary = { tag, pageUrl, failures };
  try {
    await Page.navigate({ url: pageUrl });
    await Page.loadEventFired();

    // --- 2. the extension is there, and the page itself decided so (that is what the worker is told)
    const detected = await evaluate("NanoboxProxy.detect(2000)");
    check(detected === true, `NanoboxProxy.detect() === true (got ${detected})`);
    const pageSawExtension = await waitFor({ what: "the page's own detect() result", deadlineMs: 5000, stallMs: 5000, pollMs: 100, read: () => evaluate("window.nanoboxNet ? window.nanoboxNet.extension : null"), done: (value) => value !== null });
    check(pageSawExtension.state === true, `the page passed proxyExtension=true to the installer worker (got ${pageSawExtension.state})`);
    const routes = JSON.parse(await evaluate(`JSON.stringify({ binary: NanoboxProxy.route(${JSON.stringify(BASELINE.binary.url)}), anthropic: NanoboxProxy.route("https://api.anthropic.com/api/hello"), registry: NanoboxProxy.route("https://registry.npmjs.org/npm/10.9.8") })`));
    check(routes.binary === "extension", `route(downloads.claude.ai/…/claude) === extension (got ${routes.binary})`);
    check(routes.anthropic === "extension", `route(api.anthropic.com) === extension (got ${routes.anthropic})`);
    check(routes.registry === "extension", `route(registry.npmjs.org) === extension (got ${routes.registry})`);

    // --- 3. install, with the extension leg's own byte counter as the progress signal
    const expected = cold ? BASELINE.binary.bytes : 0;
    const install = await waitFor({
      what: `claude-bin install (${cold ? MB(expected) + " MB expected over the extension leg" : "everything from the store"})`,
      deadlineMs: Math.max(5000, TIMEOUT_MS - (Date.now() - started)), stallMs: Math.max(5000, TIMEOUT_MS - (Date.now() - started)), pollMs: 500,
      read: () => evaluate("JSON.stringify({ install: window.nanobox && window.nanobox.installInfo, failed: !!(window.nanobox && window.nanobox.failed), events: window.nanobox ? window.nanobox.events.length : 0, icount: String((window.nanobox && window.nanobox.stats && window.nanobox.stats.icount) || 0), leg: window.__proxyLeg })"),
      done: (state) => { const parsed = state && JSON.parse(state); return !!(parsed && (parsed.install || parsed.failed)); },
    });
    const state = install.state ? JSON.parse(install.state) : null;
    const leg = state && state.leg;
    summary.extensionLeg = leg;
    summary.installMs = state && state.install ? state.install.ms : null;
    if (leg) {
      const seconds = leg.firstAt != null && leg.lastAt != null ? (leg.lastAt - leg.firstAt) / 1000 : null;
      summary.legThroughputMBs = seconds && seconds > 0.2 ? Number((leg.bytes / 1e6 / seconds).toFixed(1)) : null;
      console.log(`  extension leg: ${leg.chunks} chunks, ${MB(leg.bytes)} MB decoded to the page, ${leg.heads} heads, ${leg.dones} completed${summary.legThroughputMBs ? `, ${summary.legThroughputMBs} MB/s` : ""}${leg.errors.length ? `, errors: ${leg.errors.join(" | ")}` : ""}`);
    }
    check(install.ok && state && state.install && !state.failed, `install finished (${install.ok ? state.install.ms + " ms" : install.reason})`);
    if (!install.ok && cold && leg && leg.bytes > 0 && summary.legThroughputMBs) {
      // The measured bound the task asks for when the cold case does not fit: not "timed out" but
      // "this leg moves N MB/s, so the 245.7 MB body needs about M s".
      summary.coldBoundSeconds = Math.round(expected / 1e6 / summary.legThroughputMBs);
      console.log(`  BOUND: the extension leg delivered ${MB(leg.bytes)} MB at ${summary.legThroughputMBs} MB/s → the ${MB(expected)} MB binary needs ≈ ${summary.coldBoundSeconds}s on this leg (relay baseline: ${BASELINE.binary.relayMs} ms)`);
    }
    if (!install.ok) { await screenshot("install-timeout"); return finishCase(); }
    const info = state.install;
    summary.install = { ms: info.ms, packages: info.packages, fromCache: info.fromCache, downloadBytes: info.downloadBytes, direct: info.direct, relayed: info.relayed };
    const byRoute = {};
    for (const download of info.downloads || []) byRoute[download.route] = (byRoute[download.route] || 0) + 1;
    summary.downloadRoutes = byRoute;
    check(info.packages === BASELINE[tag].packages, `${BASELINE[tag].packages} packages installed (got ${info.packages})`);
    check(info.fromCache === BASELINE[tag].fromCache, `${BASELINE[tag].fromCache} packages came from the store (got ${info.fromCache})`);

    // --- 3b. routing: relay = 0, extension > 0, and downloads.claude.ai named explicitly
    const pageRoutes = await evaluate("JSON.stringify(window.nanoboxNet.routes)");
    const pageCounters = JSON.parse(pageRoutes);
    summary.pageRoutes = pageCounters;
    console.log(`  routes — installer downloads: ${JSON.stringify(byRoute)} · page fetches: ${pageRoutes} · CDP /net/fetch hits: ${relayHits.length}`);
    for (const download of info.downloads || []) console.log(`    ${String(download.route).padEnd(9)} ${String(download.bytes).padStart(10)} B  ${download.ms} ms  ${download.url}`);
    if (cold) {
      check((byRoute.extension || 0) > 0, `at least one install download took the extension route (${byRoute.extension || 0})`);
      const binary = (info.downloads || []).find((download) => download.url === BASELINE.binary.url);
      check(!!binary, `the vendor binary was downloaded (${BASELINE.binary.url})`);
      check(!!binary && binary.route === "extension", `downloads.claude.ai took the extension route (got ${binary && binary.route})`);
      check(!!binary && binary.bytes === BASELINE.binary.bytes, `the whole binary arrived: ${BASELINE.binary.bytes} bytes (got ${binary && binary.bytes})`);
    }
    check((byRoute.relay || 0) === 0, `no install download took the relay route (${byRoute.relay || 0})`);
    check((pageCounters.relay || 0) === 0, `no page fetch took the relay route (${pageCounters.relay || 0})`);
    check(relayHits.length === 0, `server relay hits observed by CDP: ${relayHits.length}${relayHits.length ? " — " + relayHits.slice(0, 3).join(", ") : ""}`);

    // --- 3c. the correctness check that matters: installer.js hashed what it was handed
    const verified = JSON.parse(await evaluate(`JSON.stringify(window.nanobox.events.filter((event) => event.event === "install:verified" && String(event.key).startsWith("pkg-claude-bin")))`));
    summary.verified = verified;
    if (cold) {
      const entry = verified[0];
      check(!!entry, "installer.js reached its sha256 verification step for pkg-claude-bin (install:verified)");
      check(!!entry && entry.integrity === "sha256 (whole binary)", `verified against the vendor's whole-file sha256 (got ${entry && entry.integrity})`);
      check(!!entry && entry.sha256 === BASELINE.binary.sha256, `the delivered bytes hash to the relay baseline's sha256 ${BASELINE.binary.sha256.slice(0, 16)}… (got ${entry && String(entry.sha256).slice(0, 16)}…)`);
    } else {
      // Nothing is downloaded on a warm run, so nothing is re-hashed: the provenance recorded on the
      // cold run is what the store replays. Stated rather than asserted.
      check(verified.length === 0, `warm run re-verified nothing, as expected (${verified.length} install:verified events)`);
    }

    // --- 4. not merely an install test: the CLI itself must come up in the guest
    const claude = await waitFor({
      what: "claude-bin drawing itself in the guest terminal",
      deadlineMs: Math.min(CLAUDE_TIMEOUT_MS, Math.max(3000, TIMEOUT_MS - (Date.now() - started))), stallMs: CLAUDE_TIMEOUT_MS, pollMs: 500,
      read: () => evaluate(`JSON.stringify({ screen: window.nanobox.screen().split("\\n").filter((line) => line.trim()).slice(-6).join(" | ").slice(-400), anthropic: window.nanoboxNet.requests.filter((request) => request.host === "api.anthropic.com").map((request) => request.via + " " + request.status).slice(0, 4), journaled: window.nanobox.persistLog.flatMap((record) => (record.entries || []).map((entry) => entry.path)) })`),
      done: (value) => { if (!value) return false; const parsed = JSON.parse(value); return signalOf(parsed) !== null; },
    });
    const claudeState = claude.state ? JSON.parse(claude.state) : null;
    const signal = claudeState && signalOf(claudeState);
    summary.claude = { ok: claude.ok, ms: claude.ms, signal, screen: claudeState && claudeState.screen, anthropic: claudeState && claudeState.anthropic, journaled: claudeState && claudeState.journaled };
    check(claude.ok, `claude-bin started (${claude.ok ? `${signal} after ${claude.ms} ms` : claude.reason})`);
    if (claudeState && claudeState.anthropic.length) check(claudeState.anthropic.every((record) => record.startsWith("extension")), `api.anthropic.com calls took the extension route (${claudeState.anthropic.join(", ")})`);
    await screenshot("claude");
  } catch (error) {
    failures.push(`exception: ${error && error.message || error}`);
    console.log(`  EXCEPTION ${error && error.stack || error}`);
  }
  return finishCase();

  async function finishCase() {
    summary.wallMs = Date.now() - started;
    await screenshot("final");
    writeFileSync(join(OUT, `${tag}-console.log`), consoleLines.join("\n"));
    try { await CDP.Close({ id: tab.id, port: CDP_EXT }); } catch {}
    return summary;
  }
}

// Which of the three aliveness signals fired, named so the report says WHAT was observed.
function signalOf({ screen, anthropic, journaled }) {
  if (CLI_ALIVE.test(screen)) return `drew its UI: "${String(screen).slice(-110)}"`;
  if (anthropic.length > 0) return `called api.anthropic.com (${anthropic.join(", ")})`;
  const config = journaled.filter((path) => CLI_WROTE_CONFIG.test(path));
  if (config.length > 0) return `wrote its config in the guest (${[...new Set(config)].join(", ")})`;
  return null;
}

function report(results) {
  console.log("\n--- extension vs the recorded relay baseline (web/results/sandbox-claude-bin-*.json) ---");
  for (const [tag, result] of Object.entries(results)) {
    const base = BASELINE[tag];
    const installMs = result.install ? result.install.ms : null;
    const bytes = result.install ? result.install.downloadBytes : null;
    console.log(`  ${tag.padEnd(5)} install ${installMs === null ? "DID NOT FINISH" : installMs + " ms"} vs relay ${base.installMs} ms` +
      (installMs === null ? "" : ` (${(installMs / base.installMs).toFixed(1)}×)`) +
      `   bytes ${bytes === null ? "n/a" : MB(bytes) + " MB"} vs ${MB(base.downloadBytes)} MB` +
      (result.extensionLeg ? `   extension leg ${MB(result.extensionLeg.bytes)} MB in ${result.extensionLeg.chunks} chunks${result.legThroughputMBs ? ` @ ${result.legThroughputMBs} MB/s` : ""}` : "") +
      (result.coldBoundSeconds ? `   → needs ≈${result.coldBoundSeconds}s` : "") +
      `   wall ${(result.wallMs / 1000).toFixed(1)}s`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
