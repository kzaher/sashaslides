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

  // localStorage-backed <select>: restore the saved choice, persist on change,
  // and run onApply(value) to show/hide the matching block. Wrapped in try/catch
  // because storage can be blocked in the cross-origin Apps Script iframe.
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  function bindSelect(sel, key, onApply) {
    if (!sel) return;
    const saved = lsGet(key);
    if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
    const apply = () => { lsSet(key, sel.value); onApply(sel.value); };
    sel.addEventListener("change", apply);
    apply();
  }

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

  // Authorization status (add-on only). insert/screenshot need Drive + Slides;
  // Apps Script never re-prompts once scopes are granted, so a stale/partial grant
  // (the usual cause of PERMISSION_DENIED on insert) needs a MANUAL re-auth.
  // Apps Script can't show its OAuth consent prompt inside our cross-origin
  // thin-shell sidebar, so authorization must be completed ONCE from the editor.
  var EDITOR_STEPS = "Open <b>Extensions → Apps Script</b>, pick a function " +
    "(e.g. <code>getDeckState</code>) and click <b>Run</b> once to approve all " +
    "permissions, then reload this presentation.";
  async function checkAuth() {
    const banner = $("#auth-banner"), msg = $("#auth-msg"), link = $("#auth-link");
    if (!banner) return;
    if (!inAddon) { banner.hidden = true; return; }
    banner.hidden = false; banner.className = "auth"; msg.textContent = "checking authorization…";

    // Try to get the consent URL. If THIS fails too, the script has no working
    // authorization at all and the prompt can't be shown from here.
    let authUrl = null;
    try { const info = await gsCall("getAuthInfo"); authUrl = info && info.url; } catch (_) {}

    if (link) {
      link.hidden = false;
      if (authUrl) link.href = authUrl;
      link.onclick = (ev) => {
        if (link.getAttribute("href")) return;            // normal anchor → new tab
        ev.preventDefault();                               // no URL → guide instead
        banner.className = "auth warn"; msg.innerHTML = "Authorization can't be started here. " + EDITOR_STEPS;
      };
    }

    try {
      const r = await gsCall("testDriveAccess");
      banner.className = "auth ok";
      msg.textContent = "✓ Authorized for Drive & Slides" + (r && r.user ? " — " + r.user : "");
      if (link) link.hidden = true;
    } catch (e) {
      banner.className = "auth warn";
      if (authUrl) {
        msg.textContent = "⚠ Not authorized for Drive/Slides — click Reauthorize, approve, then reload.";
      } else {
        // getAuthInfo failed too → every Apps Script call is denied. By far the
        // most common cause is multi-login (wrong Google account active); else the
        // add-on was never authorized and our sidebar can't show the prompt.
        msg.innerHTML = "⚠ Every Apps Script call returns PERMISSION_DENIED. Usually this means " +
          "you're signed into <b>multiple Google accounts</b> — open this deck in the account that " +
          "installed the add-on (a window/profile with only that account, or the right " +
          "<code>/u/N/</code> in the URL). Otherwise: " + EDITOR_STEPS;
        if (link) link.hidden = true;
      }
      log("authorization check failed: " + ((e && e.message) || e));
    }
  }

  // ── Automatic tab: pair with the local bridge over WebRTC (copy-paste signalling,
  //    so the https sidebar never has to reach the http bridge), then insert the
  //    slides Claude sends straight into THIS deck via the existing converter.
  function setupClaudeBridge() {
    const statusEl = $("#rtc-status");
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

    // Connection method dropdown (persisted): WebRTC | Local device.
    bindSelect($("#connect-method"), "sasha.connectMethod", (v) => {
      ["webrtc", "local"].forEach((m) => { const el = $("#cmethod-" + m); if (el) el.hidden = (m !== v); });
    });

    // Shared: turn an incoming command into a deck action and a reply. Used by
    // both transports (WebRTC data channel and the Local-device WebSocket).
    async function handleCommand(cmd) {
      const reply = { id: cmd.id, ok: true };
      try {
        if (cmd.op === "add_slide") {
          if (!bridge.insert) throw new Error("converter still loading — retry in a moment");
          bridge.queue.length = 0;
          bridge.queue.push({ name: "agent.html", html: cmd.html || "" });
          await bridge.insert(cmd.position === "before" ? "before" : "after");
          reply.inserted = true;
          log("inserted a slide from the agent");
        } else if (cmd.op === "get_state") {
          reply.target = "google-slides";
          if (inAddon) Object.assign(reply, await bridge.gsCall("getDeckState"));
        } else if (cmd.op === "screenshot") {
          if (!inAddon) throw new Error("screenshot needs the Slides add-on");
          const res = await bridge.gsCall("screenshotSlides", {
            range: cmd.range || null, indices: cmd.indices || null, includeXml: cmd.xml === true });
          reply.slides = res.slides;
          // also list editable drawio diagrams per slide so the agent can edit them
          if (bridge.drawio && Array.isArray(reply.slides)) {
            try {
              const bySlide = {};
              for (const d of await bridge.drawio.list())
                (bySlide[d.slide] = bySlide[d.slide] || []).push({ id: d.id, name: d.name });
              for (const s of reply.slides) s.diagrams = bySlide[s.index] || [];
            } catch (e) { log("diagram list (screenshot): " + e.message); }
          }
          log("screenshot: " + (res.slides ? res.slides.length : 0) + " slide(s)");
        } else if (cmd.op === "list_diagrams") {
          if (!inAddon) throw new Error("diagrams need the Slides add-on");
          if (!bridge.drawio) throw new Error("diagrams feature still loading — retry in a moment");
          reply.diagrams = await bridge.drawio.list();
          log("list_diagrams: " + reply.diagrams.length + " diagram(s)");
        } else if (cmd.op === "get_diagram") {
          if (!bridge.drawio) throw new Error("diagrams feature still loading — retry in a moment");
          // NOTE: the diagram id travels as `diagram_id`, never `id` — the bridge
          // reserves `id` for request correlation (server.py Display.command).
          reply.xml = await bridge.drawio.get(cmd.diagram_id);
          if (reply.xml == null) { reply.ok = false; reply.error = "diagram not found: " + cmd.diagram_id; }
        } else if (cmd.op === "edit_diagram") {
          if (!inAddon) throw new Error("diagrams need the Slides add-on");
          if (!bridge.drawio) throw new Error("diagrams feature still loading — retry in a moment");
          const opts = {};
          ["slide", "x", "y", "w", "h", "scale"].forEach((k) => { if (cmd[k] != null) opts[k] = cmd[k]; });
          const r = await bridge.drawio.set(cmd.diagram_id || "", cmd.xml || "", opts);
          reply.diagram_id = (r && r.id) || null; if (r && r.slide) reply.slide = r.slide;  // NOT reply.id (correlation)
          log("edit_diagram: " + (cmd.diagram_id ? "updated " + cmd.diagram_id : "created new diagram") + (r && r.slide ? " on slide " + r.slide : ""));
        } else {
          reply.ok = false; reply.error = "op not supported in Slides mode: " + cmd.op;
        }
      } catch (e) {
        reply.ok = false; reply.error = String((e && e.message) || e);
        // surface the auth banner if the deck op was denied (stale Drive grant)
        if (/PERMISSION_DENIED|not authoriz|authoriz/i.test(reply.error)) checkAuth();
      }
      return reply;
    }

    // ── WebRTC (this sidebar is the offerer) ──
    const offerEl = $("#rtc-offer"), answerEl = $("#rtc-answer");
    const connectBtn = $("#rtc-connect"), copyBtn = $("#rtc-copy"), turnChk = $("#rtc-turn");
    if (offerEl && connectBtn) {
      const cands = (sdp) => (sdp || "").split(/\r?\n/).filter((l) => l.indexOf("candidate:") >= 0);
      let pc = null, iceTimer = null;

      // (Re)build the peer + offer. With TURN on, force relay-only through the local
      // coturn (turn:localhost:3478/tcp) so it works through Docker Desktop's NAT.
      function buildPeer() {
        if (pc) { try { pc.close(); } catch (_) {} }
        const useTurn = !!(turnChk && turnChk.checked);
        pc = new RTCPeerConnection(useTurn
          ? { iceServers: [{ urls: "turn:localhost:3478?transport=tcp", username: "sasha", credential: "sasha-bridge" }], iceTransportPolicy: "relay" }
          : { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        if (useTurn) log("WebRTC: relaying through TURN (turn:localhost:3478?transport=tcp)");

        pc.oniceconnectionstatechange = () => {
          log("ICE: " + pc.iceConnectionState);
          if (pc.iceConnectionState === "failed")
            log(useTurn
              ? "✗ ICE FAILED with TURN — is coturn running in the bridge container (SASHA_TURN=1) and :3478/tcp published?"
              : "✗ ICE FAILED — browser can't reach the bridge's address (Docker UDP). Try the TURN checkbox, or use Local device.");
        };
        pc.onconnectionstatechange = () => log("conn: " + pc.connectionState);
        pc.onicegatheringstatechange = () => log("ICE gathering: " + pc.iceGatheringState);
        pc.onicecandidateerror = (e) =>
          log("ICE candidate error: " + (e.errorText || ("code " + e.errorCode)) + (e.url ? " [" + e.url + "]" : ""));

        const ch = pc.createDataChannel("cmds");
        ch.onopen = () => { if (iceTimer) clearTimeout(iceTimer); setStatus("connected ✓"); log("✓ data channel open — agent connected (webrtc)"); };
        ch.onclose = () => { setStatus("disconnected"); log("data channel closed"); };
        ch.onerror = (e) => log("data channel error: " + ((e && e.message) || e));
        // WebRTC data channels cap message size (~64KB), so chunk big replies
        // (screenshot ranges) into {__chunk} frames; reassemble incoming chunks.
        const DC_CHUNK = 16000, rx = {};
        const dcSend = (str) => {
          if (str.length <= DC_CHUNK) { ch.send(str); return; }
          const id = Math.random().toString(36).slice(2, 10), n = Math.ceil(str.length / DC_CHUNK);
          for (let i = 0; i < n; i++)
            ch.send(JSON.stringify({ __chunk: 1, id, i, n, d: str.slice(i * DC_CHUNK, (i + 1) * DC_CHUNK) }));
        };
        ch.onmessage = async (ev) => {
          let cmd; try { cmd = JSON.parse(ev.data); } catch { return; }
          if (cmd && cmd.__chunk) {
            const b = rx[cmd.id] || (rx[cmd.id] = { n: cmd.n, parts: {} });
            b.parts[cmd.i] = cmd.d;
            if (Object.keys(b.parts).length < b.n) return;
            let full = ""; for (let i = 0; i < b.n; i++) full += b.parts[i];
            delete rx[cmd.id];
            try { cmd = JSON.parse(full); } catch { return; }
          }
          const r = await handleCommand(cmd);
          try { dcSend(JSON.stringify(r)); } catch (_) {}
        };

        const mine = pc;
        (async () => {
          try {
            await mine.setLocalDescription(await mine.createOffer());
            // Wait for ICE gathering, but DON'T hang forever: with relay-only policy
            // and an unreachable TURN server the gather never completes, which would
            // leave the offer stuck on "generating…". Time-box it and warn.
            await new Promise((r) => {
              if (mine.iceGatheringState === "complete") return r();
              let done = false;
              const fin = (timedOut) => {
                if (done) return; done = true;
                mine.removeEventListener("icegatheringstatechange", onch); clearTimeout(tm);
                if (timedOut) log("offer: ICE gathering didn't finish in 6s — TURN may be unreachable " +
                                  "(start the Docker (TURN) container, publish :3478/tcp). Sending offer as-is.");
                r();
              };
              const onch = () => { if (mine.iceGatheringState === "complete") fin(false); };
              mine.addEventListener("icegatheringstatechange", onch);
              const tm = setTimeout(() => fin(true), 6000);
            });
            if (mine !== pc) return; // a newer peer superseded this one
            offerEl.value = btoa(JSON.stringify(mine.localDescription));
            cands(mine.localDescription.sdp).forEach((l) => log("local " + l.replace(/^a=/, "")));
          } catch (e) { setStatus("error"); log("offer error: " + e.message); }
        })();
      }

      if (turnChk) {
        if (lsGet("sasha.useTurn") === "1") turnChk.checked = true;
        turnChk.onchange = () => { lsSet("sasha.useTurn", turnChk.checked ? "1" : "0"); setStatus("not connected"); buildPeer(); };
      }
      buildPeer();

      const copy = () => {
        offerEl.select();
        if (navigator.clipboard) navigator.clipboard.writeText(offerEl.value).catch(() => {});
        else { try { document.execCommand("copy"); } catch (_) {} }
      };
      if (copyBtn) copyBtn.onclick = copy;

      connectBtn.onclick = async () => {
        const a = (answerEl.value || "").trim();
        if (!a) { setStatus("paste the answer first"); return; }
        let ans; try { ans = JSON.parse(atob(a)); }
        catch (e) { setStatus("bad answer"); log("answer decode failed: " + e.message); return; }
        const rc = cands(ans.sdp);
        rc.forEach((l) => log("remote " + l.replace(/^a=/, "")));
        if (!rc.length && !(turnChk && turnChk.checked)) log("⚠ the answer has NO ICE candidate — the bridge gathered none (Docker VM?). Try the TURN checkbox.");
        try {
          await pc.setRemoteDescription(ans);
          setStatus("connecting…"); log("answer applied — running ICE checks…");
          if (iceTimer) clearTimeout(iceTimer);
          iceTimer = setTimeout(() => {
            const st = pc.iceConnectionState;
            if (st !== "connected" && st !== "completed")
              log("⏱ still not connected after 20s (ICE=" + st + "). " +
                  ((turnChk && turnChk.checked) ? "Check coturn is running in the bridge + :3478/tcp published." : "Docker NAT — try the TURN checkbox, or use Local device."));
          }, 20000);
        } catch (e) { setStatus("bad answer"); log("setRemoteDescription failed: " + e.message); }
      };
    }

    // ── Local device: direct WebSocket to the bridge on this machine ──
    let localWs = null;
    function connectLocal() {
      if (localWs && localWs.readyState <= 1) return;  // already connecting/open
      setStatus("connecting…");
      try { localWs = new WebSocket("ws://localhost:8787/ws"); }
      catch (e) { setStatus("blocked — use WebRTC"); log("local connect failed: " + e.message); return; }
      localWs.onopen = () => { setStatus("connected ✓ (local)"); log("agent connected (local)"); };
      localWs.onmessage = async (ev) => {
        let cmd; try { cmd = JSON.parse(ev.data); } catch { return; }
        const r = await handleCommand(cmd);
        try { localWs.send(JSON.stringify(r)); } catch (_) {}
      };
      localWs.onerror = () => { setStatus("blocked — use WebRTC"); log("local WS blocked (https→http localhost) or bridge not running on :8787"); };
      localWs.onclose = () => { if (statusEl && /local/.test(statusEl.textContent)) setStatus("disconnected"); };
    }
    const localBtn = $("#local-connect");
    if (localBtn) localBtn.onclick = connectLocal;

    // Auto-reconnect on load when Local device was the last-used method, so
    // reopening the sidebar silently re-establishes the link (no re-clicking).
    if (($("#connect-method") || {}).value === "local") connectLocal();
  }

  // ── shared UI: env badge, oversampling, HTML queue (insert) ──────────────────
  async function init() {
    // tabs: Automatic (Claude bridge) | Manual (this UI) — wired first so a later
    // Manual-panel init error can't disable tab switching.
    document.querySelectorAll(".tab").forEach((t) => {
      t.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
        document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.id !== "panel-" + t.dataset.tab; });
      });
    });
    setupClaudeBridge(); // Automatic tab: WebRTC pairing + insert into this deck
    checkAuth();         // verify Drive/Slides authorization on startup

    // Automatic tab step 1: render the Script / Docker / Manual commands with THIS
    // server's origin (the sidebar is injected cross-origin, so use <base href> via
    // document.baseURI, NOT location), and wire the method dropdown + copy buttons.
    (() => {
      let origin; try { origin = new URL(document.baseURI).origin; } catch (_) { origin = location.origin; }
      const set = (id, text) => { const el = $("#" + id); if (el) el.textContent = text; };
      const copy = (btn, src) => {
        const b = $("#" + btn), s = $("#" + src);
        if (b && s) b.onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(s.textContent).catch(() => {}); };
      };

      set("install-cmd", `curl -fsSL ${origin}/install.sh | sh`);
      const dockerRun =
        'docker run --rm --name sasha-slides-bridge \\\n' +
        '  -p 8787:8787 -p 50000:50000/udp \\\n' +
        '  -e SASHA_RTC_PORT=50000 -e SASHA_RTC_HOST_IP=127.0.0.1 -e SASHA_DIR=/opt \\\n' +
        `  python:3.14 bash -c "curl -fsSL ${origin}/install.sh | sh"`;
      set("docker-cmd", dockerRun);
      // refresh: remove the existing named container first, then re-run (install.sh
      // re-pulls the server and overwrites the skill).
      set("docker-refresh-cmd", "docker rm -f sasha-slides-bridge 2>/dev/null; " + dockerRun);
      // TURN variant (Docker Desktop): coturn relay over TCP, no UDP port needed.
      set("docker-turn-cmd",
        'docker rm -f sasha-slides-bridge 2>/dev/null; docker run --rm --name sasha-slides-bridge \\\n' +
        '  -p 8787:8787 -p 3478:3478/tcp \\\n' +
        '  -e SASHA_TURN=1 -e SASHA_DIR=/opt \\\n' +
        `  python:3.14 bash -c "apt-get update -qq && apt-get install -y -qq coturn && curl -fsSL ${origin}/install.sh | sh"`);
      set("manual-cmd",
        `curl -fsSL ${origin}/sasha-bridge.zip -o sasha-bridge.zip\n` +
        'unzip sasha-bridge.zip && cd sasha-bridge\n' +
        'python3 -m venv .venv\n' +
        '.venv/bin/pip install -r requirements.txt\n' +
        '.venv/bin/python wrapper.py serve');

      copy("install-copy", "install-cmd");
      copy("docker-copy", "docker-cmd");
      copy("docker-refresh-copy", "docker-refresh-cmd");
      copy("docker-turn-copy", "docker-turn-cmd");
      copy("docker-turn-verify-copy", "docker-turn-verify");
      copy("manual-copy", "manual-cmd");

      bindSelect($("#install-method"), "sasha.installMethod", (v) => {
        ["script", "docker", "docker-turn", "manual"].forEach((m) => {
          const el = $("#method-" + m); if (el) el.hidden = (m !== v);
        });
      });
    })();

    const envBadge = $("#env-badge"); if (envBadge) envBadge.textContent = inAddon ? "add-on" : "dev (localhost)";
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
