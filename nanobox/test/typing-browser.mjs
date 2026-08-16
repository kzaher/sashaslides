#!/usr/bin/env node
// typing-browser.mjs — measure keystroke → screen-update latency of the browser sandbox/VM page.
//
//   node test/typing-browser.mjs [--image codex] [--engine opt] [--jit 2:2000] [--keys 6] [--page vm|sandbox]
//
// Boots web/vm.html in the shared Chrome (CDP :9222), waits for the sign-in screen, then (all inside
// the page, so no round-trip is counted twice) sends a key and timestamps the first xterm.write that
// follows. It also samples the worker's WASI counters (window.nanobox.stats.io: poll/read/write calls
// and ms) before and after, so the emulator-side and browser-side halves can be told apart, and the
// guest's own instruction counter (icount) so a browser keystroke can be compared with the harness'.
//
// Nothing is modified permanently: the probes are installed by Runtime.evaluate and die with the tab.
import CDP from "chrome-remote-interface";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const IMAGE = opt("--image", "codex"), ENGINE = opt("--engine", "opt"), JIT = opt("--jit", "2:2000");
const KEYS = Number(opt("--keys", 6)), GAP_MS = Number(opt("--gap", 700)), BOOT_TIMEOUT_S = Number(opt("--boot-timeout", 180));
const KEY = JSON.parse('"' + opt("--key", "\\u001b[B") + '"');
const CMD = opt("--cmd", null);                       // run something else than the image's default (e.g. "/bin/sh -i")
const READY = new RegExp(opt("--ready-re", null) || (CMD ? "[#$] $" : "$^"));   // with --cmd: screen text that means "prompt is up"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const url = `http://localhost:${PORT}/vm.html?engine=${ENGINE}&image=${IMAGE}&jit=${JIT}` + (CMD ? "&cmd=" + encodeURIComponent(CMD) : "");
const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime } = client;
await Promise.all([Page.enable(), Runtime.enable()]);
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text + " " + (exceptionDetails.exception && exceptionDetails.exception.description || ""));
  return result.value;
};
await Page.navigate({ url });
await Page.loadEventFired();

const bootStart = Date.now();
while (Date.now() - bootStart < BOOT_TIMEOUT_S * 1000) {
  await sleep(1000);
  if (CMD) { if (READY.test(await evaluate("window.nanobox ? window.nanobox.screen() : ''"))) break; }
  else if (await evaluate("!!(window.nanobox && window.nanobox.signinMs != null)")) break;
}
const ready = CMD ? READY.test(await evaluate("window.nanobox ? window.nanobox.screen() : ''")) : await evaluate("!!(window.nanobox && window.nanobox.signinMs != null)");
if (!ready) { console.log("FAIL: the guest never reached the expected screen"); await CDP.Close({ id: tab.id, port: CDP_PORT }); process.exit(1); }
console.log(`sign-in after ${((Date.now() - bootStart) / 1000).toFixed(1)} s`);

// probe: wrap xterm.write, remember every chunk with its timestamp
await evaluate(`(() => {
  const probe = window.__typingProbe = { writes: [], keys: [], statsAt: [] };
  const term = window.nanobox.xterm;
  const original = term.write.bind(term);
  term.write = (data, callback) => { probe.writes.push({ t: performance.now(), n: data.length }); return original(data, callback); };
  probe.sendKey = (text) => { const t = performance.now(); probe.keys.push({ t, text }); window.nanobox.send(text); return t; };
  probe.frames = []; probe.longTasks = [];
  const tick = (t) => { probe.frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) probe.longTasks.push({ t: entry.startTime, ms: entry.duration }); }).observe({ entryTypes: ["longtask"] }); } catch (error) {}
  probe.snapshot = () => { const s = window.nanobox.stats || {}; probe.statsAt.push({ t: performance.now(), icount: s.icount != null ? Number(s.icount) : null, io: s.io ? Object.assign({}, s.io) : null }); };
  return true;
})()`);

// 2 s of the pre-key idle baseline: how much does the page redraw when nobody is typing?
await evaluate("window.__typingProbe.snapshot()");
await sleep(2000);
const idle = await evaluate(`(() => { const p = window.__typingProbe; p.snapshot(); const from = p.statsAt[p.statsAt.length - 2], to = p.statsAt[p.statsAt.length - 1];
  const writes = p.writes.filter((w) => w.t >= from.t && w.t <= to.t);
  return { ms: to.t - from.t, writes: writes.length, bytes: writes.reduce((a, w) => a + w.n, 0), dIcount: to.icount - from.icount,
           dIo: from.io && to.io ? Object.fromEntries(Object.keys(to.io).map((k) => [k, +(to.io[k] - from.io[k]).toFixed(1)])) : null }; })()`);
console.log("idle 2 s:", JSON.stringify(idle));
const paint = await evaluate(`(() => { const p = window.__typingProbe; const f = p.frames.slice(-120);
  const gaps = []; for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1]);
  gaps.sort((a, b) => a - b);
  const tasks = p.longTasks.slice(-40);
  return { rafFrames: f.length, rafMedianGapMs: gaps.length ? +gaps[Math.floor(gaps.length / 2)].toFixed(2) : null, rafMaxGapMs: gaps.length ? +gaps[gaps.length - 1].toFixed(2) : null,
           longTasks: tasks.length, longTaskMs: +tasks.reduce((a, t) => a + t.ms, 0).toFixed(1) }; })()`);
console.log("page paint while idle:", JSON.stringify(paint));

const samples = [];
for (let i = 0; i < KEYS; i++) {
  await evaluate(`(() => { const p = window.__typingProbe; p.snapshot(); p.mark = p.writes.length; p.sendKey(${JSON.stringify(KEY)}); })()`);
  await sleep(GAP_MS);
  const sample = await evaluate(`(() => { const p = window.__typingProbe; p.snapshot();
    const key = p.keys[p.keys.length - 1];
    const after = p.writes.slice(p.mark);
    const from = p.statsAt[p.statsAt.length - 2], to = p.statsAt[p.statsAt.length - 1];
    return { firstWriteMs: after.length ? +(after[0].t - key.t).toFixed(2) : null, firstWriteBytes: after.length ? after[0].n : null,
             writes: after.length, bytes: after.reduce((a, w) => a + w.n, 0), windowMs: +(to.t - from.t).toFixed(1),
             dIcount: to.icount - from.icount,
             dIo: from.io && to.io ? Object.fromEntries(Object.keys(to.io).map((k) => [k, +(to.io[k] - from.io[k]).toFixed(1)])) : null }; })()`);
  samples.push(sample);
  console.log(`key ${i + 1}: ${JSON.stringify(sample)}`);
}
const latencies = samples.map((s) => s.firstWriteMs).filter((value) => value != null).sort((a, b) => a - b);
if (latencies.length) console.log(`key -> first xterm.write: min ${latencies[0]} ms, median ${latencies[Math.floor(latencies.length / 2)]} ms, max ${latencies[latencies.length - 1]} ms (n=${latencies.length})`);
const busy = await evaluate(`(() => { const p = window.__typingProbe; p.snapshot(); const from = p.statsAt[0], to = p.statsAt[p.statsAt.length - 1];
  return { totalMs: +(to.t - from.t).toFixed(0), totalWrites: p.writes.length, totalBytes: p.writes.reduce((a, w) => a + w.n, 0) }; })()`);
console.log("session:", JSON.stringify(busy));
await CDP.Close({ id: tab.id, port: CDP_PORT });
process.exit(0);
