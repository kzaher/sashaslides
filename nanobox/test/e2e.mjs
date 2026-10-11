#!/usr/bin/env node
// Drive the browser artifact in a real Chrome (CDP on :9222) and report the sign-in timers.
//
//   node test/e2e.mjs codex                 # compare page: original (top) vs optimized (bottom)
//   node test/e2e.mjs codex --engine opt    # single VM page (vm.html), one engine
//   node test/e2e.mjs codex --engine orig --record   # boot the original once, memoize its sign-in time in web/results/<image>-orig.json
//   node test/e2e.mjs codex --orig recorded|live     # compare page: use the recording (default when it exists) or boot the original
//   options: --port 8093  --timeout 600  --jit 2:2000  --out /tmp/nanobox-claude-e2e  --cmd "..."
//
// Prints a timeline of the events each VM page reports (boot, runtime-ready, worker events, prompts,
// sign-in) and, for the compare page, the two timers + speedup. Screenshots + JSON land in --out.
import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const IMAGE = argv.find((a) => !a.startsWith("--")) || "codex";
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const TIMEOUT_S = Number(opt("--timeout", 600));
const ENGINE = opt("--engine", null);
const JIT = opt("--jit", null);
const CMD = opt("--cmd", null);
const OUT = opt("--out", `/tmp/nanobox-claude-e2e/${IMAGE}-${ENGINE || "compare"}`);
const RECORD = argv.includes("--record");             // with --engine orig: write web/results/<image>-orig.json (the recorded original sign-in time)
const ORIG = opt("--orig", null);                     // compare page: "recorded" (use web/results/<image>-orig.json, don't boot the original) | "live"
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chromeUp() {
  try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return; } catch {}
  const bin = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  if (!bin) throw new Error("no chrome");
  const child = spawn(bin, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-allow-origins=*", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--user-data-dir=/tmp/nanobox-claude-chrome", "--window-size=1280,900", "about:blank"], { stdio: "ignore", detached: true });
  child.unref();
  for (let i = 0; i < 60; i++) { await sleep(500); try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return; } catch {} }
  throw new Error("chrome did not come up");
}

async function main() {
  await chromeUp();
  const p = new URLSearchParams();
  if (ENGINE) { p.set("engine", ENGINE); p.set("image", IMAGE); }
  if (JIT) p.set("jit", JIT);
  if (CMD) p.set("cmd", CMD);
  if (opt("--worker", null)) p.set("worker", opt("--worker", null));
  if (opt("--beat", null)) p.set("beat", opt("--beat", null));
  if (opt("--wmode", null)) p.set("wmode", opt("--wmode", null));
  if (opt("--trace", null)) p.set("trace", opt("--trace", null));
  if (!ENGINE) { const origMode = ORIG || (existsSync(join(new URL(".", import.meta.url).pathname, "../web/results", `${IMAGE}-orig.json`)) ? "recorded" : "live"); p.set("orig", origMode); }
  const url = ENGINE ? `http://localhost:${PORT}/vm.html?${p}` : `http://localhost:${PORT}/${IMAGE}.html${p.toString() ? "?" + p : ""}`;
  const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Log, Network, Emulation } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Log.enable(), Network.enable()]);
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await Network.setCacheDisabled({ cacheDisabled: true });
  const consoleLines = [];
  Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" ")));
  Runtime.exceptionThrown(({ exceptionDetails }) => consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text)));
  Log.entryAdded(({ entry }) => consoleLines.push(`[${entry.level}] ${entry.text}`));
  console.log(`→ ${url}`);
  const t0 = Date.now();
  await Page.navigate({ url });
  await Page.loadEventFired();
  const evalJson = async (expr) => { const { result } = await Runtime.evaluate({ expression: expr, returnByValue: true }); return result.value; };
  const shot = async (tag) => { try { const { data } = await Page.captureScreenshot({ format: "png" }); writeFileSync(join(OUT, `${tag}.png`), Buffer.from(data, "base64")); } catch {} };
  let seen = 0, verdict = null, lastShot = 0;
  while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
    await sleep(1000);
    const st = ENGINE
      ? await evalJson("window.nanobox ? ({events: window.nanobox.events, signinMs: window.nanobox.signinMs, runStartMs: window.nanobox.runStartMs, failed: window.nanobox.failed, stats: window.nanobox.stats}) : null")
      : await evalJson("window.nanoboxCompare ? ({events: window.nanoboxCompare.events, orig: window.nanoboxCompare.orig, opt: window.nanoboxCompare.opt, optLoad: window.nanoboxCompare.optLoad, optRun: window.nanoboxCompare.optRun}) : null");
    if (!st) continue;
    for (; seen < st.events.length; seen++) {
      const e = st.events[seen];
      const who = e.engine ? `${e.engine}` : "";
      console.log(`  +${((e.at ?? e.t) / 1000).toFixed(1).padStart(6)}s ${who.padEnd(5)} ${e.event}${e.event === "signin" ? " ✅" : ""}` +
        (e.compileMs != null ? ` (instantiate ${e.compileMs} ms)` : "") + (e.name ? ` ${e.name}` : "") + (e.message ? ` ${e.message}` : "") + (e.data != null ? ` ${e.n != null ? "n=" + e.n + " " : ""}${e.data}` : "") + (e.kinds ? ` ${e.kinds}` : ""));
    }
    if (Date.now() - lastShot > 15000) { lastShot = Date.now(); await shot("progress"); }
    if (ENGINE) {
      if (st.stats && st.stats.icount) process.stdout.write(`\r  t+${Math.round((Date.now() - t0) / 1000)}s icount=${st.stats.icount} jit=${st.stats.installed ?? "-"}   `);
      if (st.signinMs != null) { verdict = { signinMs: st.signinMs, loadMs: st.runStartMs ?? null, runMs: st.runStartMs != null ? st.signinMs - st.runStartMs : null }; break; }
      if (st.failed) { verdict = { failed: true }; break; }
    } else if (st.orig != null && st.opt != null) { verdict = { orig: st.orig, opt: st.opt, speedup: st.orig / st.opt, optLoad: st.optLoad ?? null, optRun: st.optRun ?? null }; break; }
  }
  await shot("final");
  const finalState = ENGINE ? await evalJson("window.nanobox ? window.nanobox.screen() : ''") : null;
  const samples = ENGINE ? await evalJson("window.nanobox ? window.nanobox.samples : null") : null;
  if (samples) {
    writeFileSync(join(OUT, "samples.json"), JSON.stringify(samples));
    // activity profile: every ~5 s, deltas of icount and of the wall time spent inside each WASI call
    let prev = null; const rows = [];
    for (const smp of samples) {
      if (prev && smp.t - prev.t < 5000) continue;
      if (prev) {
        const dt = (smp.t - prev.t) / 1000, io = smp.io, pio = prev.io;
        const d = (k) => ((io[k] - pio[k]) / dt);
        rows.push(`  t=${(smp.t / 1000).toFixed(0).padStart(4)}s  ${smp.icount ? ((Number(smp.icount) - Number(prev.icount)) / 1e6 / dt).toFixed(1).padStart(6) + " MIPS" : "           "}` +
          `  poll ${d("pollN").toFixed(0).padStart(6)}/s ${(100 * d("pollMs") / 1000).toFixed(0).padStart(3)}%wall  clock ${d("clockN").toFixed(0).padStart(7)}/s` +
          `  send ${d("sendN").toFixed(0).padStart(5)}/s recv ${d("recvN").toFixed(0).padStart(5)}/s ${(100 * d("recvMs") / 1000).toFixed(0).padStart(3)}%  read ${d("readN").toFixed(0).padStart(4)}/s write ${d("writeN").toFixed(0).padStart(4)}/s` + (smp.jit != null ? `  jit ${smp.jit}` : ""));
      }
      prev = smp;
    }
    console.log("\nactivity profile:\n" + rows.join("\n"));
  }
  writeFileSync(join(OUT, "console.log"), consoleLines.join("\n"));
  writeFileSync(join(OUT, "result.json"), JSON.stringify({ url, verdict, elapsedS: (Date.now() - t0) / 1000 }, null, 2));
  if (finalState) writeFileSync(join(OUT, "screen.txt"), finalState);
  if (RECORD && ENGINE === "orig" && verdict && verdict.signinMs != null) {
    // memoize the original engine's sign-in time for the compare pages (?orig=recorded)
    const ver = await evalJson("navigator.userAgent");
    let engineBytes = null; try { engineBytes = (await import("node:fs")).statSync(join(new URL(".", import.meta.url).pathname, "../public/c2w/wasi/out.wasm.gzip")).size; } catch {}
    const rec = { image: IMAGE, signinMs: Math.round(verdict.signinMs), date: new Date().toISOString(), browser: ver, engineBytes, cmd: CMD || null };
    const outp = join(new URL(".", import.meta.url).pathname, "../web/results", `${IMAGE}-orig.json`);
    writeFileSync(outp, JSON.stringify(rec, null, 2));
    console.log("recorded original sign-in -> " + outp);
  }
  console.log("\nRESULT " + JSON.stringify(verdict) + `  (artifacts: ${OUT})`);
  await CDP.Close({ id: tab.id, port: CDP_PORT });
  process.exit(verdict && !verdict.failed ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
