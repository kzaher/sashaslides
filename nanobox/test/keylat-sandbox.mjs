// Per-keystroke cost for a sandbox.html CLI, measured where the user feels it (browser input ->
// browser paint) together with the two numbers that say WHY: the guest's instruction counter and the
// JIT's installed/cleared counts.
//
//   node test/keylat-sandbox.mjs --phase boot  [--cli claude-bin] [--budget 24] [--q "..."]
//   node test/keylat-sandbox.mjs --phase keys  [--keys 2] [--budget 24] [--keychar x]
//   node test/keylat-sandbox.mjs --phase export --name claude-bin-slim.nbjb [--budget 24]
//   node test/keylat-sandbox.mjs --phase report
//
// work/prof/keylat.sh cannot answer this: it drives harness/run.mjs against the codex image, has no
// sandbox/claude-bin path, and its default run is ~90-200 s. This attaches to the Chrome that is
// already on CDP :9222 and NEVER closes the tab, so `boot` and `keys` are two independent bounded
// measurements against one live session rather than one long job.
//
// Every wait names its four signals (watchdog skill): done = the thing we want appeared, progress =
// the screen changed or the guest retired instructions, stall = neither for --stall seconds, deadline
// = --budget seconds. A timeout prints the last observed state, never a bare "timed out".
//
// The keystroke loop runs INSIDE the page (one Runtime.evaluate) so a 10 s keystroke is not measured
// through a CDP round trip. Per key it reports:
//   firstMs  key -> first byte painted back   (window.nanobox.typing.firstSamples, the page's own hook)
//   settleMs key -> the paint burst going quiet for 60 ms
//   dIcount  guest instructions retired across a window that brackets the key (1 Hz stats beats)
//   dInstall JIT modules installed in that window   -- >0 every key = re-translation (thrash)
//   dClears  engine content-cache clears in that window
// An idle window of the same shape is measured first, so dIcount can be read net of the TUI's own
// background work.
import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CDP_PORT = Number(opt("--cdp", 9222));
const PORT = Number(opt("--port", 3500));
const CLI = opt("--cli", "claude-bin");
const PHASE = opt("--phase", "report");
const BUDGET_S = Number(opt("--budget", 24));
const STALL_S = Number(opt("--stall", 12));
const KEYS = Number(opt("--keys", 2));
const KEYCHAR = opt("--keychar", "x");          // never a cycle containing q (quits codex)
const OUT = opt("--out", join(ROOT, "work/prof"));
const TAG = opt("--tag", `keylat-${CLI}`);
const EXTRA = opt("--q", "");
const URL_WANT = `/sandbox.html?cli=${CLI}` + (EXTRA ? "&" + EXTRA : "");
const url = `http://localhost:${PORT}${URL_WANT}`;
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- attach to the live Chrome ---------------------------------------------------------------------
const targets = await CDP.List({ port: CDP_PORT });
let tab = targets.find((t) => t.type === "page" && t.url.includes(URL_WANT));
const fresh = !tab;
if (fresh) {
  if (PHASE !== "boot") {
    console.log(`NO LIVE TAB for ${URL_WANT} — run --phase boot first. Open pages: ${targets.filter((t) => t.type === "page").map((t) => t.url).join(", ") || "none"}`);
    process.exit(2);
  }
  tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
}
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime } = client;
await Promise.all([Page.enable(), Runtime.enable()]);
const consoleLines = [];
Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" ")));
Runtime.exceptionThrown(({ exceptionDetails }) => consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text)));
const ev = async (expression, awaitPromise = true) => {
  const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise, timeout: (BUDGET_S + 5) * 1000 });
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
if (fresh) {
  console.log(`-> ${url}  (new tab; it is LEFT OPEN for --phase keys)`);
  await Page.navigate({ url });
  await Page.loadEventFired();
} else {
  console.log(`-> attached to the live tab ${tab.url}`);
}

// ---- the page-side helpers (installed once per attach) ---------------------------------------------
const HELPERS = `(() => {
  const n = window.nanobox; if (!n) return "no-nanobox";
  if (n.__keylat && n.__keylat.v === 4) return "ok";   // bump v when HELPERS changes, or a live tab keeps the old one
  const screen = () => n.screen();
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };
  const snap = () => { const st = n.stats || {}; const c = st.cache || {};
    return { t: Math.round(st.t || 0), icount: Number(st.icount || 0), installed: st.installed || 0, released: st.released || 0,
             liveFns: st.live || 0, compileMs: st.compileMs || 0, cacheLive: c.live ?? null, cacheHits: Number(c.hits ?? 0),
             clears: Number(c.clears ?? 0), clearFull: Number(c.clearFull ?? 0), clearPool: Number(c.clearPool ?? 0) }; };
  // DONE = a stats beat newer than the one we started from. PROGRESS/STALL/DEADLINE are the caller's.
  const nextBeat = async (budgetMs) => { const n0 = n.samples.length; const dl = performance.now() + budgetMs;
    while (n.samples.length === n0) { if (performance.now() > dl) return null; await new Promise((r) => setTimeout(r, 50)); } return snap(); };
  // one measurement window: optionally send a key, wait for paint + settle, close on a fresh beat
  const window1 = async (ch, budgetMs, stallMs) => {
    const before = await nextBeat(budgetMs); if (!before) return { err: "no stats beat; the engine is not reporting" };
    const h0 = hash(screen()), nFirst = n.typing.firstSamples.length;
    const tSend = performance.now();
    // the IDLE window sends nothing, so there is no paint to wait for: it closes on the next beat
    // after a fixed span, and its dIcount is the TUI's own background work for that long
    if (!ch) {
      while (performance.now() - tSend < 1500) await new Promise((r) => setTimeout(r, 50));
      const a0 = await nextBeat(budgetMs) || snap();
      return { ch: null, paintMs: null, settleWall: Math.round(performance.now() - tSend), firstMs: null, settleMs: null,
        windowMs: a0.t - before.t, dIcount: a0.icount - before.icount, dInstall: a0.installed - before.installed,
        dReleased: a0.released - before.released, dClears: a0.clears - before.clears, dHits: a0.cacheHits - before.cacheHits,
        dCompileMs: a0.compileMs - before.compileMs, cacheLive: a0.cacheLive, liveFns: a0.liveFns };
    }
    n.send(ch);
    // DONE = the page's own paint hook closed the burst (xterm.write seen, then 60 ms of quiet), which
    // is the user-felt number and the only reliable signal: an Ink re-render often repaints IDENTICAL
    // text, so a screen-text hash misses the paint entirely.
    // PROGRESS = a new paint, a screen-text change, or the guest retiring instructions.
    let paintMs = null, lastChange = tSend, h = h0, iLast = before.icount;
    const dl = tSend + budgetMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 20));
      const now = performance.now();
      if (n.typing.first && paintMs === null) { paintMs = Math.round((n.typing.first - tSend) * 10) / 10; lastChange = now; }
      const hn = hash(screen()); if (hn !== h) { h = hn; lastChange = now; }
      const iNow = Number((n.stats || {}).icount || 0); if (iNow > iLast) { iLast = iNow; lastChange = now; }
      if (n.typing.firstSamples.length > nFirst) break;                                  // DONE
      if (now - lastChange > stallMs) return { err: "STALL: no paint, no screen change and no instructions for " + Math.round(stallMs) + " ms", paintMs, ch };
      if (now > dl) { const a1 = snap();
        return { err: "DEADLINE: " + Math.round(budgetMs) + " ms, paintMs=" + paintMs, ch, paintMs, windowMs: a1.t - before.t,
          dIcount: a1.icount - before.icount, dInstall: a1.installed - before.installed, dReleased: a1.released - before.released,
          dClears: a1.clears - before.clears, dHits: a1.cacheHits - before.cacheHits, dCompileMs: a1.compileMs - before.compileMs,
          cacheLive: a1.cacheLive, liveFns: a1.liveFns }; }
    }
    const settleWall = Math.round(performance.now() - tSend);
    const after = await nextBeat(budgetMs) || snap();
    const fs = n.typing.firstSamples, ss = n.typing.settleSamples;
    return { ch, paintMs, settleWall,
      firstMs: fs[fs.length - 1], settleMs: ss[ss.length - 1],
      windowMs: after.t - before.t, dIcount: after.icount - before.icount, dInstall: after.installed - before.installed,
      dReleased: after.released - before.released, dClears: after.clears - before.clears, dHits: after.cacheHits - before.cacheHits,
      dCompileMs: after.compileMs - before.compileMs, cacheLive: after.cacheLive, liveFns: after.liveFns };
  };
  n.__keylat = { v: 4, snap, screen, window1, hash,
    // DONE = the regex matched. PROGRESS = the screen changed. STALL/DEADLINE = the caller's.
    waitScreen: async (reSrc, budgetMs, stallMs) => {
      const re = new RegExp(reSrc, "i"); const dl = performance.now() + budgetMs;
      let h = hash(screen()), lastChange = performance.now(), i0 = Number((n.stats || {}).icount || 0), lastI = i0;
      for (;;) {
        const s = screen();
        if (re.test(s)) return { ok: true, ms: Math.round(performance.now() - (dl - budgetMs)) };
        const hn = hash(s); if (hn !== h) { h = hn; lastChange = performance.now(); }
        const iNow = Number((n.stats || {}).icount || 0); if (iNow > lastI) { lastI = iNow; }
        const now = performance.now();
        if (now > dl) return { ok: false, why: "DEADLINE", ms: Math.round(budgetMs), icountAdvanced: lastI - i0, sinceChangeMs: Math.round(now - lastChange), tail: s.trim().split("\\n").slice(-6).join(" | ") };
        if (now - lastChange > stallMs && lastI === i0) return { ok: false, why: "STALL", ms: Math.round(now - (dl - budgetMs)), sinceChangeMs: Math.round(now - lastChange), tail: s.trim().split("\\n").slice(-6).join(" | ") };
        await new Promise((r) => setTimeout(r, 100));
      }
    } };
  return "ok";
})()`;

async function helpers() {
  const deadline = Date.now() + 10000;
  for (;;) {
    const r = await ev(HELPERS, false);
    if (r === "ok") return;
    if (Date.now() > deadline) throw new Error(`window.nanobox never appeared (${r}); console: ${consoleLines.slice(-3).join(" / ")}`);
    await sleep(250);
  }
}

const phasesOf = () => ev(`(() => { const n = window.nanobox; return JSON.stringify({ phases: n.phases, install: n.installInfo && { ms: n.installInfo.ms, packages: n.installInfo.packages, fromCache: n.installInfo.fromCache, downloadBytes: n.installInfo.downloadBytes },
  jitBundles: n.events.filter(e => e.event === "vm:jit-bundles"), stats: n.stats, samples: n.samples, events: n.events.map(e => ({ event: e.event, t: e.t, ms: e.ms, files: e.files, bytes: e.bytes })),
  screenTail: n.screen().trim().split("\\n").filter(l => l.trim()).slice(-8), typing: n.typing && { median: n.typing.median, settle: n.typing.settle, worst: n.typing.worst, firstSamples: n.typing.firstSamples, settleSamples: n.typing.settleSamples } }) })()`, false).then(JSON.parse);

const fmt = (v, n = 1) => (v == null ? "-" : Number(v).toFixed(n));
function printBoot(d) {
  const p = d.phases;
  console.log(`\n--- boot phases (ms from page load) ---`);
  for (const k of ["engineMs", "imageMs", "installMs", "persistMs", "vmStartMs", "bootMs", "helloMs", "bundleMs", "transformMs", "runStartMs", "signinMs"])
    console.log(`  ${k.padEnd(12)} ${p[k] == null ? "-" : Math.round(p[k])}`);
  const jb = d.jitBundles[0];
  console.log(`  jit-bundles  ${jb ? `files=${jb.files} ${jb.ms} ms ${JSON.stringify({ hits: jb.bundleHits, misses: jb.bundleMisses, modules: jb.bundleModules, tag: jb.tag, autoCached: jb.autoCached }).slice(0, 180)}` : "-"}`);
  if (d.install) console.log(`  install      ${d.install.ms} ms, ${d.install.packages} packages, ${d.install.fromCache} cached, ${(d.install.downloadBytes / 1e6).toFixed(1)} MB downloaded`);
  const s = d.stats || {};
  console.log(`  jit now      installed=${s.installed} live=${s.live} released=${s.released} bytes=${((s.bytes || 0) / 1e6).toFixed(1)}M compileMs=${s.compileMs} bundleHits=${s.bundleHits ?? "-"}/${s.bundleMisses ?? "-"} cache=${JSON.stringify(s.cache || null)}`);
  console.log(`  icount       ${s.icount ? (Number(s.icount) / 1e9).toFixed(2) + "G" : "-"}`);
  console.log(`\n--- screen tail ---\n${(d.screenTail || []).join("\n")}`);
}

if (PHASE === "boot") {
  await helpers();
  const want = opt("--until", "Welcome to Claude Code|Press enter|sign in|api key|\\$ $|# $");
  const r = await ev(`window.nanobox.__keylat.waitScreen(${JSON.stringify(want)}, ${BUDGET_S * 1000}, ${STALL_S * 1000}).then(JSON.stringify)`).then(JSON.parse);
  console.log(`\nwaitScreen(${want}) -> ${JSON.stringify(r)}`);
  const d = await phasesOf();
  printBoot(d);
  writeFileSync(join(OUT, `${TAG}-boot.json`), JSON.stringify({ url, at: new Date().toISOString(), wait: r, ...d }, null, 1));
  console.log(`\n(${elapsed()}s) wrote ${join(OUT, `${TAG}-boot.json`)}; tab LEFT OPEN`);
} else if (PHASE === "keys") {
  await helpers();
  const PRE = opt("--pre", "");
  if (PRE) {
    const r = await ev(`(async () => { const k = window.nanobox.__keylat; const h = k.hash(k.screen()); window.nanobox.send(${JSON.stringify(PRE)});
      const dl = performance.now() + 8000; while (k.hash(k.screen()) === h) { if (performance.now() > dl) return JSON.stringify({ ok: false, why: "no paint in 8000 ms" }); await new Promise((r) => setTimeout(r, 25)); }
      await new Promise((r) => setTimeout(r, 600)); return JSON.stringify({ ok: true, tail: k.screen().trim().split("\\n").filter(l => l.trim()).slice(-6) }); })()`).then(JSON.parse);
    console.log(`  --pre ${JSON.stringify(PRE)} -> ${JSON.stringify(r)}`);
  }
  const perKey = Math.floor((BUDGET_S * 1000) / (KEYS + 1));
  console.log(`\n--- ${KEYS} keys '${KEYCHAR}' + 1 idle window, ${perKey} ms budget each, stall ${STALL_S}s ---`);
  const rows = await ev(`(async () => { const k = window.nanobox.__keylat; const out = [];
    out.push(Object.assign({ kind: "idle" }, await k.window1(null, ${perKey}, ${STALL_S * 1000})));
    for (let i = 0; i < ${KEYS}; i++) out.push(Object.assign({ kind: "key" + i }, await k.window1(${JSON.stringify(KEYCHAR)}, ${perKey}, ${STALL_S * 1000})));
    return JSON.stringify(out); })()`).then(JSON.parse);
  console.log(`  ${"win".padEnd(6)} ${"firstMs".padStart(8)} ${"settleMs".padStart(9)} ${"winMs".padStart(7)} ${"dIcount(M)".padStart(11)} ${"dInstall".padStart(9)} ${"dClears".padStart(8)} ${"dHits".padStart(9)} ${"dComp(ms)".padStart(9)} ${"cacheLive".padStart(9)}`);
  for (const r of rows) {
    if (r.err) { console.log(`  ${r.kind.padEnd(6)} ERR ${r.err}` + (r.dIcount != null ? `  winMs=${r.windowMs} dIcount=${fmt(r.dIcount / 1e6, 2)}M dInstall=${r.dInstall} dClears=${r.dClears} dComp=${r.dCompileMs}ms cacheLive=${r.cacheLive}` : "")); continue; }
    console.log(`  ${r.kind.padEnd(6)} ${fmt(r.firstMs).padStart(8)} ${fmt(r.settleMs).padStart(9)} ${String(r.windowMs).padStart(7)} ${fmt(r.dIcount / 1e6, 2).padStart(11)} ${String(r.dInstall).padStart(9)} ${String(r.dClears).padStart(8)} ${String(r.dHits).padStart(9)} ${String(r.dCompileMs).padStart(9)} ${String(r.cacheLive).padStart(9)}`);
  }
  const keyRows = rows.filter((r) => r.kind.startsWith("key") && !r.err);
  const idle = rows.find((r) => r.kind === "idle" && !r.err);
  if (keyRows.length) {
    const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
    const netI = keyRows.map((r) => r.dIcount - (idle ? idle.dIcount * (r.windowMs / Math.max(1, idle.windowMs)) : 0));
    console.log(`\n  VERDICT INPUTS: median settleMs=${fmt(med(keyRows.map((r) => r.settleMs ?? r.settleWall)))}  median dIcount=${fmt(med(keyRows.map((r) => r.dIcount)) / 1e6, 1)}M  median dIcount net of idle=${fmt(med(netI) / 1e6, 1)}M`);
    console.log(`  dInstall per key: ${keyRows.map((r) => r.dInstall).join(", ")}   dClears per key: ${keyRows.map((r) => r.dClears).join(", ")}`);
    // dInstall > 0 alone does NOT mean re-translation: a cold 246 MB binary keeps REACHING new code.
    // Re-translation requires that something was thrown away first, which only the engine's own
    // counters can say -- dReleased (function indices handed back) and dClears (content-cache wipes).
    const thrash = keyRows.some((r) => r.dReleased > 0 || r.dClears > 0);
    const installing = keyRows.filter((r) => r.dInstall > 0).length;
    console.log(`  => ${thrash
      ? `RE-TRANSLATION (thrash): released=${keyRows.map((r) => r.dReleased).join("/")} clears=${keyRows.map((r) => r.dClears).join("/")} -- code already translated was discarded and compiled again`
      : installing
        ? `FIRST-TIME TRANSLATION only: ${installing}/${keyRows.length} keys installed new code but nothing was released or cleared, so none of it was a re-translation -- the binary is still reaching code it has never run`
        : `STEADY STATE: no new code installed, nothing released -- the guest is simply executing this many instructions per key`}`);
  }
  const d = await phasesOf();
  writeFileSync(join(OUT, `${TAG}-keys.json`), JSON.stringify({ url, at: new Date().toISOString(), keychar: KEYCHAR, rows, stats: d.stats, typing: d.typing, phases: d.phases, screenTail: d.screenTail }, null, 1));
  console.log(`\n(${elapsed()}s) wrote ${join(OUT, `${TAG}-keys.json`)}; tab LEFT OPEN`);
} else if (PHASE === "export") {
  await helpers();
  const name = opt("--name", `${CLI}-slim.nbjb`);
  const r = await ev(`window.nanobox.exportJit(${JSON.stringify(name)}).then(JSON.stringify)`).then(JSON.parse);
  console.log(`exportJit(${name}) -> ${JSON.stringify(r)}`);
  console.log(`(${elapsed()}s) tab LEFT OPEN`);
} else {
  await helpers();
  const d = await phasesOf();
  printBoot(d);
  if (d.typing) console.log(`\n  typing: median first ${d.typing.median} ms, settle ${d.typing.settle} ms, worst ${d.typing.worst} ms, n=${d.typing.firstSamples.length}`);
  writeFileSync(join(OUT, `${TAG}-report.json`), JSON.stringify({ url, at: new Date().toISOString(), ...d }, null, 1));
  console.log(`\n(${elapsed()}s) wrote ${join(OUT, `${TAG}-report.json`)}`);
}
if (consoleLines.length) writeFileSync(join(OUT, `${TAG}.console.log`), consoleLines.join("\n"));
await client.close().catch(() => {});
process.exit(0);
