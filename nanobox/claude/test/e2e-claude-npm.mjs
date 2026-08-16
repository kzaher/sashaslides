#!/usr/bin/env node
// Boot the claude-npm image (Claude Code installed with `npm install -g` on system Node.js — see
// guest/claude-npm/Dockerfile) in the EMULATED optimized engine and time its sign-in screen.
// vm.html knows nothing about this image (no SIGNIN/PROMPTS entry, and vm.html is not to be
// touched), so this driver reads the terminal text itself, answers the onboarding prompts like a
// human would and stops the clock on the same regexp vm.html uses for claude.
//
//   node test/e2e-claude-npm.mjs [--timeout 600] [--jit 2:2000] [--engine opt|orig] [--cmd "..."] [--out DIR]
//   -> web/results/claude-npm-<engine>.{json,png}
import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const TIMEOUT_S = Number(opt("--timeout", 600));
const ENGINE = opt("--engine", "opt");
const JIT = opt("--jit", "2:2000");
const IMAGE = opt("--image", "claude-npm");
// same launch as vm.html's DEFAULT_CMD.claude: node (like Bun) ignores SSL_CERT_FILE, the in-browser
// TLS proxy's CA has to come in through NODE_EXTRA_CA_CERTS
const CMD = opt("--cmd", "/bin/env NODE_EXTRA_CA_CERTS=/.wasmenv/proxy.crt /usr/local/bin/claude");
const OUT = opt("--out", join(HERE, "../web/results"));
mkdirSync(OUT, { recursive: true });
const SIGNIN = /sign in|log in|claude\.ai\/oauth|authenticate|subscription|api key|browser didn't open/i;
const PROMPTS = [
  { name: "claude theme", when: /choose the text style|dark mode|light mode/i, send: "\r" },
  { name: "claude continue", when: /press enter to continue|continue\?/i, send: "\r" },
  { name: "trust folder", when: /do you trust|trust the files/i, send: "\r" },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const p = new URLSearchParams({ engine: ENGINE, image: IMAGE, auto: "0", cmd: CMD });
if (ENGINE === "opt") p.set("jit", JIT);
const url = `http://localhost:${PORT}/vm.html?${p}`;
const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime, Emulation, Network } = client;
await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await Network.setCacheDisabled({ cacheDisabled: true });
const consoleLines = [];
Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" ")));
Runtime.exceptionThrown(({ exceptionDetails }) => consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text)));
console.log(`→ ${url}`);
const t0 = Date.now();
await Page.navigate({ url });
await Page.loadEventFired();
const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true })).result.value;
const answered = new Set(); const events = [];
let verdict = null, seen = 0;
while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
  await sleep(250);
  const st = await ev("window.nanobox ? ({screen: window.nanobox.screen(), events: window.nanobox.events, runStartMs: window.nanobox.runStartMs, failed: window.nanobox.failed, stats: window.nanobox.stats}) : null");
  if (!st) continue;
  for (; seen < st.events.length; seen++) { const e = st.events[seen]; events.push(e); console.log(`  +${(e.t / 1000).toFixed(1).padStart(6)}s ${e.event}${e.message ? " " + e.message : ""}`); }
  const s = st.screen || "";
  let sent = false;
  for (const pr of PROMPTS) if (!answered.has(pr.name) && pr.when.test(s)) { answered.add(pr.name); await ev(`window.nanobox.send(${JSON.stringify(pr.send)})`); console.log(`  +${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s prompt: ${pr.name}`); sent = true; break; }
  if (sent) continue;
  if (SIGNIN.test(s)) {
    // the page's own clock (performance.now since page load), like vm.html's timer
    const now = await ev("performance.now() - (window.nanobox.events[0] ? 0 : 0)");
    const T0 = await ev("(() => { const b = window.nanobox.events.find(e => e.event === 'boot'); return b ? b.t : 0; })()");
    const signinMs = Math.round(now); void T0;
    verdict = { signinMs, loadMs: st.runStartMs != null ? Math.round(st.runStartMs) : null, runMs: st.runStartMs != null ? Math.round(signinMs - st.runStartMs) : null, icount: st.stats?.icount ?? null };
    break;
  }
  if (st.failed) { verdict = { failed: true }; break; }
  if (st.stats && st.stats.icount) process.stdout.write(`\r  t+${Math.round((Date.now() - t0) / 1000)}s icount=${st.stats.icount}   `);
}
const screen = (await ev("window.nanobox ? window.nanobox.screen() : ''")) || "";
try { const { data } = await Page.captureScreenshot({ format: "png" }); writeFileSync(join(OUT, `${IMAGE}-${ENGINE}.png`), Buffer.from(data, "base64")); } catch {}
const rec = { image: IMAGE, engine: ENGINE, jit: ENGINE === "opt" ? JIT : null, cmd: CMD, url, verdict, date: new Date().toISOString(), browser: await ev("navigator.userAgent"), events, screenTail: screen.trim().split("\n").filter((l) => l.trim()).slice(-20) };
writeFileSync(join(OUT, `${IMAGE}-${ENGINE}.json`), JSON.stringify(rec, null, 2));
writeFileSync(join(OUT, `${IMAGE}-${ENGINE}.console.log`), consoleLines.join("\n"));
console.log("\n" + rec.screenTail.join("\n"));
console.log("\nRESULT " + JSON.stringify(verdict) + `  (${OUT}/${IMAGE}-${ENGINE}.{json,png})`);
await CDP.Close({ id: tab.id, port: CDP_PORT });
process.exit(verdict && !verdict.failed ? 0 : 1);
