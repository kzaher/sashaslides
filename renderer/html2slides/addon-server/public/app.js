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

    $("#insert-btn").addEventListener("click", () => bridge.insert ? bridge.insert() : log("insert handler not loaded"));

    // let feature modules wire themselves
    for (const f of bridge.features) { try { await f(bridge); } catch (e) { log("feature init error: " + e.message); } }
    log(inAddon ? "ready (add-on mode)" : "ready (dev mode — Slides ops are stubbed)");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
