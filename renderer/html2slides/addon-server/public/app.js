/* html2slides UI — runs inside the Apps Script sidebar (loaded via shell.html)
 * OR standalone for local dev. The `bridge` abstracts the two: in the add-on it
 * calls google.script.run (the user's OAuth does Slides ops); standalone it hits
 * this server's /api/* (dev token) so the UI is testable on localhost.
 *
 * Feature logic (export, drawio detect/list/edit) is split into /static/feature-*.js
 * modules that each call `window.h2s.register(...)`; this file is the shared shell
 * so parallel workstreams add a module + one <script> without merge conflicts. */
(() => {
  const $ = (s) => document.querySelector(s);
  const log = (m) => { const el = $("#log"); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; };
  const inAddon = typeof google !== "undefined" && google.script && google.script.run;

  // google.script.run wrapped as a promise (add-on mode only)
  const gsCall = (fn, ...args) => new Promise((resolve, reject) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn](...args);
  });

  // The shared bridge passed to feature modules.
  const bridge = {
    $, log, inAddon, gsCall,
    api: (path, opts) => fetch(path, opts).then((r) => r.ok ? r : Promise.reject(new Error(`${path} ${r.status}`))),
    config: null,
    queue: [],           // pasted/fetched HTML waiting to insert
    features: [],
  };
  window.h2s = { register: (init) => bridge.features.push(init), bridge };

  // ── shared UI: env badge, oversampling, HTML queue (insert) ──────────────────
  async function init() {
    $("#env-badge").textContent = inAddon ? "add-on" : "dev (localhost)";
    try { bridge.config = await (await fetch("/api/config")).json(); } catch { bridge.config = { oversampling: { default: 2, min: 1, max: 8 } }; }
    const bb = $("#build-badge"); if (bb) bb.textContent = "build " + (bridge.config.buildDate || "?");

    const ov = $("#oversample"), ovOut = $("#oversample-out");
    ov.min = bridge.config.oversampling.min; ov.max = bridge.config.oversampling.max;
    ov.value = bridge.config.oversampling.default; ovOut.textContent = ov.value + "×";
    ov.addEventListener("input", () => { ovOut.textContent = ov.value + "×"; });
    bridge.oversampling = () => Number(ov.value);

    // queue: paste / fetch-url / drop
    const addHtml = (name, html) => { bridge.queue.push({ name, html }); renderQueue(); log(`queued ${name} (${html.length} bytes)`); };
    function renderQueue() {
      $("#file-list").innerHTML = bridge.queue.map((q, i) =>
        `<li><span class="name">${q.name}</span><button data-i="${i}" class="rm">✕</button></li>`).join("");
      document.querySelectorAll(".rm").forEach((b) => b.onclick = () => { bridge.queue.splice(+b.dataset.i, 1); renderQueue(); });
    }
    $("#paste-box").addEventListener("paste", (e) => {
      const t = (e.clipboardData || window.clipboardData).getData("text");
      if (t && /<[a-z!]/i.test(t)) { e.preventDefault(); addHtml(`pasted-${bridge.queue.length + 1}.html`, t); }
    });
    $("#fetch-url-btn").addEventListener("click", async () => {
      const url = $("#url-input").value.trim(); if (!url) return;
      log(`fetching ${url} …`);
      try {
        // CORS: prefer server-side fetch (add-on: UrlFetchApp via Code.gs; dev: this server proxy)
        const html = inAddon ? await gsCall("fetchExternalHtml", url)
                             : await (await fetch("/api/fetch-html?url=" + encodeURIComponent(url))).text();
        addHtml(url.split("/").pop() || "remote.html", html);
      } catch (e) { log("fetch failed: " + e.message); }
    });
    const dz = $("#dropzone");
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", async (e) => {
      e.preventDefault(); dz.classList.remove("over");
      for (const f of e.dataTransfer.files) if (/\.html?$/i.test(f.name)) addHtml(f.name, await f.text());
    });

    // Action buttons. In the add-on: insert before/after the current slide. In
    // standalone (NOT inside Slides — there's no deck): offer a .pptx download
    // instead. withLoading() disables the button + shows a spinner while the
    // (slow) HTML→pptx conversion runs, so you get feedback.
    const beforeBtn = $("#insert-before-btn"), afterBtn = $("#insert-after-btn"), dlBtn = $("#download-btn");
    if (inAddon) { if (dlBtn) dlBtn.hidden = true; }
    else { if (beforeBtn) beforeBtn.hidden = true; if (afterBtn) afterBtn.hidden = true; if (dlBtn) dlBtn.hidden = false; }
    const withLoading = (btn, fn) => async () => {
      const label = btn.textContent;
      btn.disabled = true; btn.classList.add("loading"); btn.textContent = "⏳ working…";
      try { await fn(); } catch (e) { log("error: " + (e && e.message || e), "error"); }
      finally { btn.disabled = false; btn.classList.remove("loading"); btn.textContent = label; }
    };
    const needConverter = (fn) => () => bridge.insert ? fn() : log("converter still loading — try again in a second");
    if (beforeBtn) beforeBtn.addEventListener("click", withLoading(beforeBtn, needConverter(() => bridge.insert("before"))));
    if (afterBtn) afterBtn.addEventListener("click", withLoading(afterBtn, needConverter(() => bridge.insert("after"))));
    if (dlBtn) dlBtn.addEventListener("click", withLoading(dlBtn, needConverter(() => bridge.insert("download"))));
    bridge.withLoading = withLoading; // feature modules (drawio) reuse it

    // Export the deck's slides as a PNG zip (add-on only — uses your OAuth via Code.gs).
    const exportBtn = $("#export-png-btn");
    if (exportBtn) exportBtn.addEventListener("click", withLoading(exportBtn, async () => {
      if (!inAddon) { log("Export needs the Slides add-on (no deck in standalone)."); return; }
      const range = ($("#range-input") || {}).value || "";
      const excludeHidden = !!($("#skip-hidden") || {}).checked;
      log(`exporting slides as PNG${range ? " (range " + range + ")" : ""}…`);
      const r = await gsCall("exportSlidesZip", { range, excludeHidden });
      const a = document.createElement("a");
      a.href = "data:application/zip;base64," + r.base64;
      a.download = r.filename || "slides.zip";
      document.body.appendChild(a); a.click(); a.remove();
      log("✓ downloaded " + (r.filename || "slides.zip"));
    }));

    // Dynamically load the vendors + feature bundles. Inline <script>s don't run
    // when the Apps Script shell injects this markup, so app.js bootstraps them.
    // Order matters: vendors set window.JSZip/window.PptxGenJS that convert-bundle uses.
    const loadScript = (src) => new Promise((res, rej) => {
      const s = document.createElement("script"); s.async = false; s.src = src;
      s.onload = () => res(); s.onerror = () => rej(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js");
      await loadScript("/static/pptxgen.bundle.js");   // OUR fork (gradient/round2/group fixes) — NOT the stock CDN
      await loadScript("/static/convert-bundle.js");   // base href → the server; sets bridge.insert
      await loadScript("/static/feature-drawio.js");
    } catch (e) { log("feature load: " + e.message); }

    // run feature registrations (convert-bundle → bridge.insert, drawio → its panel)
    for (const f of bridge.features) { try { await f(bridge); } catch (e) { log("feature init error: " + e.message); } }
    log(inAddon ? "ready (add-on mode)" : "ready (standalone — Insert needs Slides; use Download .pptx)");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
