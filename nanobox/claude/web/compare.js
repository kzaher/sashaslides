// Side-by-side boot: the original engine on top, nanobox/claude's optimized engine below, both
// started at the same moment; a timer under each stops when that VM shows the CLI's sign-in screen.
(function () {
  const image = document.body.dataset.image;
  const qs = new URLSearchParams(location.search);
  const jit = qs.get("jit") || "2:2000";
  const cmd = qs.get("cmd");
  const mk = (engine) => {
    const p = new URLSearchParams({ engine, image });
    if (cmd) p.set("cmd", cmd);
    if (engine === "opt") p.set("jit", jit);
    if (qs.get("auto")) p.set("auto", qs.get("auto"));
    return "vm.html?" + p.toString();
  };
  const el = (id) => document.getElementById(id);
  const T0 = performance.now();
  const res = { image, orig: null, opt: null, events: [] };
  window.nanoboxCompare = res;
  const timers = { orig: el("t-orig"), opt: el("t-opt") };
  const fmt = (ms) => (ms / 1000).toFixed(1) + " s";
  setInterval(() => {
    for (const k of ["orig", "opt"]) if (res[k] == null) timers[k].textContent = fmt(performance.now() - T0);
    if (res.orig != null && res.opt != null) el("verdict").textContent = `speedup ${(res.orig / res.opt).toFixed(2)}× (original ${fmt(res.orig)} → optimized ${fmt(res.opt)})`;
  }, 100);
  addEventListener("message", (m) => {
    const d = m.data;
    if (!d || d.type !== "nanobox") return;
    res.events.push(Object.assign({ at: Math.round(performance.now() - T0) }, d));
    if (d.event === "signin") {
      // measured from the moment this page created both frames, so both timers share one t0
      res[d.engine] = performance.now() - T0;
      timers[d.engine].textContent = fmt(res[d.engine]);
      timers[d.engine].classList.add("done");
    }
    if (d.event === "error") timers[d.engine].classList.add("err");
  });
  // orig=recorded: don't boot the original (it takes 1–5 minutes); show its recorded sign-in time
  // (results/<image>-orig.json, written by `node test/e2e.mjs <image> --engine orig --record`) in the
  // top panel and use it for the verdict. Default: recorded when a recording exists (the original
  // engine's time is memoized per image — only the optimized engine, the thing under test, boots);
  // ?orig=live boots the original next to it as before; ?orig=recorded insists on the recording.
  const origMode = qs.get("orig") || "auto";
  document.title = `nanobox/claude · ${image}`;
  const startLive = () => { el("f-orig").src = mk("orig"); };
  if (origMode !== "live") {
    fetch("results/" + image + "-orig.json", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((rec) => {
      if (!rec || rec.signinMs == null) {
        if (origMode === "auto") { startLive(); return; }
        timers.orig.textContent = "no recording"; timers.orig.classList.add("err"); res.origRecorded = false; return;
      }
      res.orig = rec.signinMs; res.origRecorded = rec;
      timers.orig.textContent = fmt(rec.signinMs) + " (recorded)"; timers.orig.classList.add("done");
      const f = el("f-orig");
      const note = document.createElement("div");
      note.className = "recorded";
      note.textContent = `Original engine not booted on this page (add ?orig=live to run it). Recorded sign-in: ${fmt(rec.signinMs)} on ${rec.date || "?"} — ${rec.browser || ""}${rec.engineBytes ? ", engine " + rec.engineBytes + " bytes" : ""}.`;
      f.replaceWith(note);
      res.events.push({ at: Math.round(performance.now() - T0), engine: "orig", event: "signin", ms: rec.signinMs, recorded: true });
    });
    el("f-opt").src = mk("opt");
    return;
  }
  // ?orig=live: start both at the same time
  startLive();
  el("f-opt").src = mk("opt");
})();
