#!/usr/bin/env node
// E2E for the nanobox proxy extension (extension/) + web/proxyext.js routing.
//
//   node test/e2e-proxyext.mjs                # both halves
//   node test/e2e-proxyext.mjs --only extension|fallback
//   options: --port 8093 (serve.mjs)  --cdp-ext 9223 (Chrome WITH the extension, launched here)
//            --cdp 9222 (Chrome WITHOUT it, e2e.mjs style)  --timeout 150 (per page, s)  --out /tmp/nanobox-claude-e2e/proxyext
//            --chrome <binary> (default: the google-chrome-stable / chromium found in /usr/bin)
//
// The extension is loaded through CDP `Extensions.loadUnpacked` over --remote-debugging-pipe (Google
// Chrome >= 137 ignores --load-extension; the pipe must stay open, so that Chrome lives exactly as long
// as this process). The optimized engine needs the new wasm-EH (Chrome >= 137) — Chrome for Testing 131
// from ~/.cache/puppeteer loads the extension but never starts the VM.
//
// extension half: vm.html?engine=opt&image=codex in that Chrome: NanoboxProxy.detect()
// must be true, the codex device-code sign-in must route its requests through the extension and the
// server relay (POST /net/fetch) must see ZERO hits — counted from the browser side (CDP Network events)
// and from the page's own counter (window.nanoboxNetRoutes).
// fallback half: the same page in the plain Chrome on :9222: detect() false, route() says relay for the
// netpolicy vendors and direct for auth.openai.com, and the sign-in still works via relay/direct.
import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const PORT = Number(opt("--port", 8093)), CDP_EXT = Number(opt("--cdp-ext", 9223)), CDP_PLAIN = Number(opt("--cdp", 9222));
const TIMEOUT_MS = Number(opt("--timeout", 150)) * 1000;
const ONLY = opt("--only", null);
const OUT = opt("--out", "/tmp/nanobox-claude-e2e/proxyext");
const HERE = new URL(".", import.meta.url).pathname;
const EXTENSION_DIR = join(HERE, "../extension");
const PAGE_URL = `http://localhost:${PORT}/vm.html?engine=opt&image=codex&jit=2:2000`;
mkdirSync(OUT, { recursive: true });

async function main() {
  const results = {};
  if (ONLY !== "fallback") {
    const chrome = await chromeWithExtension({ cdpPort: CDP_EXT, userDataDir: "/tmp/nanobox-claude-chrome-ext", extension: EXTENSION_DIR, binary: opt("--chrome", defaultChrome()) });
    try { results.extension = await runPage({ cdpPort: CDP_EXT, tag: "extension", expectExtension: true }); }
    finally { chrome.close(); }
  }
  if (ONLY !== "extension") {
    await chromeUp({ cdpPort: CDP_PLAIN, userDataDir: "/tmp/nanobox-claude-chrome", binary: opt("--chrome", defaultChrome()) });
    results.fallback = await runPage({ cdpPort: CDP_PLAIN, tag: "fallback", expectExtension: false });
  }
  writeFileSync(join(OUT, "result.json"), JSON.stringify(results, null, 2));
  const failures = Object.entries(results).flatMap(([tag, result]) => result.failures.map((failure) => `${tag}: ${failure}`));
  console.log(failures.length ? `\nFAIL\n  ${failures.join("\n  ")}` : "\nPASS");
  console.log(`details: ${OUT}/result.json`);
  process.exit(failures.length ? 1 : 0);
}

async function runPage({ cdpPort, tag, expectExtension }) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`); };
  console.log(`\n=== ${tag}: Chrome on :${cdpPort} ${expectExtension ? "with" : "without"} the extension → ${PAGE_URL}`);
  const tab = await CDP.New({ port: cdpPort, url: "about:blank" });
  const client = await CDP({ target: tab, port: cdpPort });
  const { Page, Runtime, Network } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
  const consoleLines = [];
  Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((argument) => argument.value ?? argument.description ?? "").join(" ")));
  Runtime.exceptionThrown(({ exceptionDetails }) => consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text)));
  // browser-side truth for "no relay hits": every request the page makes to our gateway
  const relayHits = [];
  Network.requestWillBeSent(({ request }) => { if (/\/net\/fetch$/.test(request.url)) relayHits.push(request.url); });
  const evaluate = async (expression) => { const { result, exceptionDetails } = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
  const screenshot = async (name) => { try { const { data } = await Page.captureScreenshot({ format: "png" }); writeFileSync(join(OUT, `${tag}-${name}.png`), Buffer.from(data, "base64")); } catch {} };
  try {
    await Page.navigate({ url: PAGE_URL });
    await Page.loadEventFired();
    const detected = await evaluate("NanoboxProxy.detect(1000)");
    check(detected === expectExtension, `NanoboxProxy.detect() === ${expectExtension} (got ${detected})`);
    const routes = await evaluate(`JSON.stringify({ anthropic: NanoboxProxy.route("https://api.anthropic.com/api/hello"), openai: NanoboxProxy.route("https://auth.openai.com/oauth/token"), same: NanoboxProxy.route(location.origin + "/x"), metadata: NanoboxProxy.route("http://169.254.169.254/latest") })`);
    const routing = JSON.parse(routes);
    check(routing.anthropic === (expectExtension ? "extension" : "relay"), `route(api.anthropic.com) === ${expectExtension ? "extension" : "relay"} (got ${routing.anthropic})`);
    check(routing.openai === (expectExtension ? "extension" : "direct"), `route(auth.openai.com) === ${expectExtension ? "extension" : "direct"} (got ${routing.openai})`);
    check(routing.same === "direct", `route(same-origin) === direct (got ${routing.same})`);
    check(routing.metadata === "blocked", `route(169.254.169.254) === blocked (got ${routing.metadata})`);
    // boot until the codex sign-in menu; progress = the page's event count / icount still moving
    const boot = await waitFor({
      what: "codex sign-in screen",
      deadlineMs: TIMEOUT_MS, stallMs: 45000, pollMs: 1000,
      read: () => evaluate("window.nanobox ? JSON.stringify({ signin: window.nanobox.signinMs, failed: window.nanobox.failed, events: window.nanobox.events.length, icount: String(window.nanobox.stats && window.nanobox.stats.icount || 0) }) : null"),
      done: (state) => state && (JSON.parse(state).signin != null || JSON.parse(state).failed),
    });
    const bootState = boot.state ? JSON.parse(boot.state) : null;
    check(boot.ok && bootState && bootState.signin != null && !bootState.failed, `VM reached the sign-in screen (${boot.ok ? Math.round(bootState.signin) + " ms" : boot.reason})`);
    await screenshot("signin");
    if (boot.ok && bootState.signin != null) {
      // device-code sign-in: menu item 2 (down arrow + enter), then the CLI talks to auth.openai.com
      await evaluate(`window.nanobox.send("\\x1b[B")`);
      const moved = await waitFor({ what: "menu cursor on item 2", deadlineMs: 3000, stallMs: 3000, pollMs: 100, read: () => evaluate("window.nanobox.screen()"), done: (screen) => /> 2\. Sign in with Device Code/.test(String(screen)) });
      check(moved.ok, `menu cursor moved to "Sign in with Device Code" (${moved.ok ? moved.ms + " ms" : moved.reason})`);
      await evaluate(`window.nanobox.send("\\r")`);
      const login = await waitFor({
        what: "device-code prompt (the menu is replaced by a URL + one-time code, or an error)",
        deadlineMs: 40000, stallMs: 40000, pollMs: 1000,
        read: () => evaluate("window.nanobox.screen()"),
        done: (screen) => !/Press enter to continue/.test(String(screen)) && /https?:\/\/\S+|[A-Z0-9]{4,}-[A-Z0-9]{4,}|error|failed/i.test(String(screen)),
      });
      console.log("  --- terminal:\n" + String(login.state || "").trim().split("\n").filter((line) => line.trim()).slice(-8).map((line) => "    " + line).join("\n"));
      check(login.ok, `codex reacted to the device-code choice (${login.ok ? "prompt on screen" : login.reason})`);
      await screenshot("device-code");
    }
    const netRoutes = await evaluate("JSON.stringify(window.nanoboxNetRoutes)");
    const counters = JSON.parse(netRoutes);
    console.log(`  routes taken: extension=${counters.extension} relay=${counters.relay} direct=${counters.direct} blocked=${counters.blocked}`);
    for (const record of counters.log.slice(-12)) console.log(`    ${record.route.padEnd(9)} ${record.method} ${record.url}`);
    if (expectExtension) {
      check(counters.extension > 0, `at least one cross-origin request went through the extension (${counters.extension})`);
      check(counters.relay === 0 && counters.direct === 0, `no request took the relay/direct route (relay=${counters.relay}, direct=${counters.direct})`);
      check(relayHits.length === 0, `server relay hits observed by CDP: ${relayHits.length}`);
    } else {
      check(counters.extension === 0, `no request claimed the extension route (${counters.extension})`);
      check(counters.relay + counters.direct > 0, `cross-origin requests took relay/direct (relay=${counters.relay}, direct=${counters.direct})`);
      check(relayHits.length === counters.relay, `server relay hits observed by CDP (${relayHits.length}) match the page's relay counter (${counters.relay})`);
    }
  } catch (error) {
    failures.push(`exception: ${error && error.message || error}`);
    console.log(`  EXCEPTION ${error && error.stack || error}`);
  } finally {
    await screenshot("final");
    writeFileSync(join(OUT, `${tag}-console.log`), consoleLines.join("\n"));
    try { await CDP.Close({ id: tab.id, port: cdpPort }); } catch {}
  }
  return { failures, relayHits: relayHits.length };
}

// Poll `read` until `done(state)`; a state that stops changing for stallMs aborts early with evidence.
async function waitFor({ what, read, done, deadlineMs, stallMs, pollMs }) {
  const start = Date.now();
  let last = null, lastChangeAt = start;
  for (;;) {
    let state = null;
    try { state = await read(); } catch (error) { state = "read error: " + (error && error.message || error); }
    if (done(state)) return { ok: true, state, ms: Date.now() - start };
    const serialized = JSON.stringify(state);
    if (serialized !== last) { last = serialized; lastChangeAt = Date.now(); }
    const now = Date.now();
    if (now - start >= deadlineMs) return { ok: false, state, reason: `${what}: deadline ${deadlineMs / 1000}s passed, last state ${String(serialized).slice(0, 160)}` };
    if (now - lastChangeAt >= stallMs) return { ok: false, state, reason: `${what}: no progress for ${stallMs / 1000}s (waited ${Math.round((now - start) / 1000)}s), last state ${String(serialized).slice(0, 160)}` };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function defaultChrome() {
  const binary = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
  if (!binary) throw new Error("no chrome binary found");
  return binary;
}

// A fresh Chrome that owns the extension: fds 3/4 carry the CDP pipe (Extensions.loadUnpacked needs it,
// and Chrome exits when it closes), the port serves chrome-remote-interface as usual.
async function chromeWithExtension({ cdpPort, userDataDir, extension, binary }) {
  const args = ["--headless=new", "--remote-debugging-pipe", `--remote-debugging-port=${cdpPort}`, "--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${userDataDir}`, "--window-size=1280,900", "about:blank"];
  console.log(`starting ${binary} on :${cdpPort} (pipe) and loading ${extension}`);
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pipeOut = child.stdio[3], pipeIn = child.stdio[4];
  const replies = new Map();
  let buffered = "";
  pipeIn.on("data", (chunk) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0")) {
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      const waiter = replies.get(message.id); if (waiter) { replies.delete(message.id); waiter(message); }
    }
  });
  let nextId = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; replies.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
    pipeOut.write(JSON.stringify({ id, method, params }) + "\0");
    setTimeout(() => { if (replies.delete(id)) reject(new Error(`${method}: no reply in 10s`)); }, 10000);
  });
  const close = () => { try { pipeOut.end(); } catch {} try { child.kill(); } catch {} };
  try {
    const loaded = await call("Extensions.loadUnpacked", { path: extension });
    console.log(`  extension id ${loaded.id}`);
    const alive = async () => { try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; } };
    const up = await waitFor({ what: `chrome on :${cdpPort}`, deadlineMs: 30000, stallMs: 30000, pollMs: 250, read: alive, done: (ok) => ok === true });
    if (!up.ok) throw new Error(up.reason);
  } catch (error) { close(); throw error; }
  return { close };
}

// The plain Chrome (no extension), started exactly like test/e2e.mjs does; reused when already up.
async function chromeUp({ cdpPort, userDataDir, binary }) {
  const alive = async () => { try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; } };
  if (await alive()) { console.log(`Chrome already listening on :${cdpPort} (reusing it)`); return; }
  const args = ["--headless=new", `--remote-debugging-port=${cdpPort}`, "--remote-allow-origins=*", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${userDataDir}`, "--window-size=1280,900", "about:blank"];
  console.log(`starting ${binary} on :${cdpPort}`);
  const child = spawn(binary, args, { stdio: "ignore", detached: true });
  child.unref();
  const up = await waitFor({ what: `chrome on :${cdpPort}`, deadlineMs: 30000, stallMs: 30000, pollMs: 250, read: alive, done: (ok) => ok === true });
  if (!up.ok) throw new Error(up.reason);
}

main().catch((error) => { console.error(error); process.exit(1); });
