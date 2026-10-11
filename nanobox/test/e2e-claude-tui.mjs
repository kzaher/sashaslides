// Drive Claude Code in the browser and check that it really works — not just that a screen appeared.
//
//   node test/e2e-claude-tui.mjs [--cli claude|claude-native|both] [--timeout 240] [--keep] [--out web/results]
//
// For each build it runs the sandbox page (`sandbox.html?cli=…`: Linux-only image in the emulated VM,
// node + the CLI installed from the vendors, the CLI's JS executed on this browser's V8 with every
// syscall performed inside the guest) and asserts, in order:
//
//   1. the sign-in screen renders (the CLI's own TUI, drawn through our tty into xterm),
//   2. the runtime plumbing the CLI depends on works against the REAL guest — a file written from the
//      runtime is readable back through the guest, a child process runs there and its output comes
//      back, a pseudo-terminal round trips (Bun.Terminal / the pty path), Bun's text metrics answer,
//   3. the CLI reacts to real keystrokes: pressing Enter on the sign-in screen starts the vendor's
//      OAuth flow, which only completes if the input path, the Ink render loop, the CLI's own state
//      machine and the network (through the relay/extension) all work — we assert the auth URL and
//      the "paste code" prompt it prints, then leave the flow,
//   4. the CLI left its state in the guest filesystem (~/.claude*),
//   5. no NEW compatibility gap appeared: the recorded missing-API list must stay inside ALLOWED_MISSING.
//
// Exit code 0 only if every assertion of every build passed; a summary table and per-build JSON +
// screenshots land in web/results/claude-tui-<cli>.{json,png}.
import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const TIMEOUT_S = Number(opt("--timeout", 240));
const OUT = opt("--out", join(HERE, "../web/results"));
const CLIS = opt("--cli", "both") === "both" ? ["claude", "claude-native"] : [opt("--cli", "claude")];

// Gaps we know about and accept (see docs/claude-native.md); anything else fails the run.
const ALLOWED_MISSING = [
  /^fs\.glob(Sync)?$/,                             // the CLI has a JS fallback
  /^net\.Server\.listen/,                         // the OAuth callback listener: the redirect would land on the
                                                  // user's own localhost, not in the guest — hence the paste-code path
  /^Bun\.(JSONL|password|Glob)$/,                  // optional-chained / feature-gated in the bundle
  /^process\.getBuiltinModule$/,
];
const allowed = (key) => ALLOWED_MISSING.some((re) => re.test(key));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
mkdirSync(OUT, { recursive: true });

for (const cli of CLIS) results.push(await runOne(cli));

console.log("\n=== summary ===");
for (const r of results) {
  console.log(`${r.cli.padEnd(14)} ${r.ok ? "PASS" : "FAIL"}  sign-in ${r.signinMs ? (r.signinMs / 1000).toFixed(1) + " s" : "-"}  ` +
    Object.entries(r.checks).map(([k, v]) => `${k}:${v === true ? "ok" : "FAIL"}`).join(" "));
  for (const f of r.failures) console.log(`   ${r.cli}: ${f}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);

async function runOne(cli) {
  const url = `http://localhost:${PORT}/sandbox.html?cli=${cli}`;
  console.log(`\n=== ${cli} — ${url}`);
  const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Emulation } = client;
  const failures = [], checks = {};
  const fail = (what, detail) => { failures.push(`${what}: ${detail}`); checks[what] = false; };
  const pass = (what) => { checks[what] = true; };
  let signinMs = null, missing = [], spawns = [];
  try {
    await Promise.all([Page.enable(), Runtime.enable()]);
    await Emulation.setDeviceMetricsOverride({ width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    await Page.navigate({ url });
    await Page.loadEventFired();

    const evalIn = async (expr, awaitPromise = false) => (await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise })).result.value;
    const inWorker = async (code) => JSON.parse(await evalIn(`window.nanobox.eval(${JSON.stringify(code)})`, true));
    const screen = async () => String(await evalIn(`window.nanobox.screen ? window.nanobox.screen() : ""`) || "");
    const type = async (text) => { await evalIn(`window.nanobox.send(${JSON.stringify(text)})`); await sleep(400); };

    // 1. the CLI's own sign-in screen
    signinMs = await waitFor(async () => await evalIn("window.nanobox && (window.nanobox.signinMs || (window.nanobox.failed ? -1 : null))"), TIMEOUT_S, "sign-in screen");
    if (!signinMs || signinMs < 0) fail("signin", `not reached (status: ${await evalIn(`document.getElementById("status").textContent`)})`);
    else pass("signin");
    const first = await screen();
    if (/Claude Code|Welcome/.test(first)) pass("tui"); else fail("tui", `unexpected first screen: ${JSON.stringify(first.slice(-200))}`);

    // 2. the plumbing the CLI runs on, exercised against the real guest
    const plumbing = await inWorker(`(async () => {
      const fs = require("fs"), out = {};
      const stamp = "nanobox-e2e-" + Date.now();
      fs.writeFileSync("/root/.nanobox-e2e.txt", stamp);
      out.fileRoundTrip = fs.readFileSync("/root/.nanobox-e2e.txt", "utf8") === stamp;
      const cp = require("child_process");
      out.spawnOut = String(cp.execSync("echo " + stamp + "; uname -s")).trim();
      if (typeof Bun !== "undefined") {
        out.bunWhich = Bun.which("sh");
        out.bunWidth = Bun.stringWidth("héllo 世界");
        const sub = Bun.spawn(["/bin/echo", stamp], { stdout: "pipe" });
        out.bunSpawn = (await new Response(sub.stdout).text()).trim() === stamp;
        out.bunPty = await new Promise((res) => {          // Bun's API: the terminal is given to spawn
          let seen = "";
          const t = new Bun.Terminal({ cols: 40, rows: 10, data(_t, chunk) { seen += new TextDecoder().decode(chunk); } });
          Bun.spawn(["/bin/sh", "-i"], { terminal: t });
          setTimeout(() => { t.write("echo " + stamp + "\\r"); }, 600);
          setTimeout(() => { try { t.close(); } catch {} out.ptyTail = seen.slice(-120); res(seen.includes(stamp)); }, 3000);
        });
      }
      return JSON.stringify(out);
    })()`);
    if (plumbing.fileRoundTrip) pass("file"); else fail("file", "a file written by the runtime did not read back through the guest");
    if (/Linux/.test(plumbing.spawnOut || "")) pass("spawn"); else fail("spawn", `guest child process output was ${JSON.stringify(plumbing.spawnOut)}`);
    if (cli === "claude-native") {
      if (plumbing.bunWhich && plumbing.bunSpawn) pass("bun"); else fail("bun", `Bun.which=${plumbing.bunWhich} Bun.spawn=${plumbing.bunSpawn} width=${plumbing.bunWidth}`);
      if (plumbing.bunPty) pass("pty"); else fail("pty", "Bun.Terminal did not echo through a guest pty");
    }

    // 3. real keystrokes: start the vendor's OAuth flow from the sign-in screen and read what it prints
    const before = await screen();
    await type("\r");
    const auth = await waitForScreen(screen, /claude\.ai\/oauth|Paste code here|code_challenge/i, 45, "the OAuth prompt");
    if (auth) pass("auth"); else fail("auth", `Enter on the sign-in screen produced nothing: ${JSON.stringify((await screen()).slice(-300))}`);
    if ((await screen()) !== before) pass("render"); else fail("render", "the screen never changed after a keystroke");
    await type("\x1b");                                     // back out of the flow

    // 4. the CLI's own state landed in the guest filesystem
    const state = await inWorker(`(() => { const fs = require("fs"); const out = {};
      out.entries = fs.readdirSync("/root").filter((n) => n.startsWith(".claude"));
      out.configBytes = out.entries.includes(".claude.json") ? fs.statSync("/root/.claude.json").size : 0;
      return JSON.stringify(out); })()`);
    if (state.entries.length) pass("state"); else fail("state", "no ~/.claude* in the guest after the run");

    // 5. no new compatibility gap
    const dump = await evalIn(`new Promise(r => window.nanobox.dump().then(d => r(JSON.stringify({ missing: (d.missing||[]).map(m => m.key), spawns: (d.spawns||[]).map(s => s.file || s) }))))`, true);
    ({ missing, spawns } = JSON.parse(dump || '{"missing":[],"spawns":[]}'));
    const unexpected = missing.filter((k) => !allowed(k));
    if (unexpected.length === 0) pass("apis"); else fail("apis", `unexpected missing APIs: ${unexpected.join(", ")}`);

    const shot = await Page.captureScreenshot({ format: "png" });
    writeFileSync(join(OUT, `claude-tui-${cli}.png`), Buffer.from(shot.data, "base64"));
  } catch (e) {
    fail("run", String(e && e.message || e));
  } finally {
    if (!argv.includes("--keep")) await CDP.Close({ id: tab.id, port: CDP_PORT }).catch(() => {});
    await client.close().catch(() => {});
  }
  const ok = failures.length === 0;
  const record = { cli, ok, signinMs, checks, failures, missing, spawns, at: new Date().toISOString() };
  writeFileSync(join(OUT, `claude-tui-${cli}.json`), JSON.stringify(record, null, 1));
  console.log(`  ${ok ? "PASS" : "FAIL"} ${cli}: ${Object.entries(checks).map(([k, v]) => k + (v ? "" : "!")).join(" ")}${failures.length ? "\n   " + failures.join("\n   ") : ""}`);
  return record;
}

// poll a page value until it is truthy; the deadline is the safety net, the value is the signal
async function waitFor(read, seconds, what) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) { console.log(`  timed out waiting for ${what} (${seconds}s)`); return null; }
    await sleep(500);
  }
}
async function waitForScreen(screen, re, seconds, what) {
  return waitFor(async () => re.test(await screen()) || null, seconds, what);
}
