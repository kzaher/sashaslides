/* Workstream D (UI half) — drawio panel wiring.
 *
 * Lists PNGs in the deck that carry an embedded drawio diagram, and opens the
 * self-hosted drawio editor (iframe → /drawio) to edit/create them.
 *
 * Editor handshake (drawio "embed" protocol, postMessage JSON strings):
 *   ← {event:'init'}                       editor is ready
 *   → {action:'load', xml, autosave:1}     seed the diagram (xml="" = blank)
 *   ← {event:'save'} / {event:'export', data}  user saved / exported a PNG
 *   → {action:'export', format:'xmlpng'}   ask the editor for a PNG+XML blob
 * We load /drawio with ?embed=1&proto=json&spin=1 so it speaks this protocol.
 *
 * Detection: in add-on mode we ask Slides for the deck's images (gsCall) and POST
 * each PNG to /api/drawio/detect; in dev mode (no add-on) we show a small mock so
 * the panel is demonstrable on localhost.
 */
window.h2s.register(async (bridge) => {
  const { $, log, inAddon, gsCall, api } = bridge;

  const listEl = $("#drawio-list");
  const wrap = $("#drawio-editor-wrap");
  const frame = $("#drawio-frame");
  const statusEl = $("#drawio-status");

  // Render-resolution picker — persisted in localStorage, default 4×. Drives every
  // render path (inline editor, editor tab, and agent edits that don't pass --scale).
  const scaleEl = $("#drawio-scale");
  if (scaleEl) {
    try { const sv = localStorage.getItem("sasha.drawioScale"); if (sv) scaleEl.value = sv; } catch (e) { /* private mode */ }
    scaleEl.addEventListener("change", () => { try { localStorage.setItem("sasha.drawioScale", scaleEl.value); } catch (e) {} });
  }
  function currentScale() { const v = scaleEl ? Number(scaleEl.value) : 0; return v > 0 ? v : 4; }

  // 4) reflect server capability in the badge
  const available = !!(bridge.config && bridge.config.drawioAvailable);
  statusEl.textContent = available ? "self-hosted ✓" : "editor unavailable";
  statusEl.title = available
    ? "drawio webapp is served at /drawio"
    : "the drawio submodule is not populated on this host";

  let items = []; // [{ id, name, src }]

  function render() {
    if (!items.length) {
      listEl.innerHTML = `<li><span class="name hint">No drawio diagrams detected. Use “New diagram” to create one.</span></li>`;
      return;
    }
    listEl.innerHTML = items.map((it, i) => `
      <li data-i="${i}">
        <img class="thumb" src="${it.src || ""}" alt="">
        <span class="name">${escapeHtml(it.name)}</span>
        <button class="dw-edit" data-i="${i}">Edit</button>
        <button class="dw-del" data-i="${i}">Delete</button>
      </li>`).join("");
    listEl.querySelectorAll(".dw-edit").forEach((b) => b.onclick = () => edit(items[+b.dataset.i]));
    listEl.querySelectorAll(".dw-del").forEach((b) => b.onclick = () => del(items[+b.dataset.i]));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── detection ────────────────────────────────────────────────────────────
  async function detect() {
    log("drawio: detecting diagrams in deck…");
    items = [];
    if (inAddon) {
      try {
        // Code.gs → listDeckImages() returns [{ id, name, dataUrl, xml }] where
        // `xml` comes from the off-canvas source box the converter wrote.
        const imgs = await gsCall("listDeckImages");
        for (const img of imgs || []) {
          // Preferred: editable XML already recovered from the source box — use it
          // directly (it survives the pptx→Slides import; PNG metadata may not).
          if (img.xml) {
            items.push({ id: img.id, name: img.name || ("diagram-" + img.id), src: img.dataUrl, xml: img.xml });
            continue;
          }
          // Fallback: a PNG that carries an embedded drawio chunk (no source box).
          try {
            const r = await api("/api/drawio/detect", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ png: img.dataUrl }),
            }).then((x) => x.json());
            if (r.isDrawio) items.push({ id: img.id, name: img.name || ("diagram-" + img.id), src: img.dataUrl, xml: r.xml });
          } catch (e) { log("detect skip " + img.id + ": " + e.message); }
        }
        log(`drawio: ${items.length} diagram(s) found in deck`);
      } catch (e) {
        log("drawio detect failed: " + e.message);
      }
    } else {
      // dev mode: no Slides deck → demonstrate the UI with a mock
      items = mockItems();
      log(`drawio (dev): showing ${items.length} mock diagram(s)`);
    }
    render();
  }

  function mockItems() {
    const xml = '<mxfile><diagram name="Page-1"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    // a 1x1 transparent png placeholder thumb
    const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    return [
      { id: "mock-1", name: "architecture.drawio.png", src: px, xml },
      { id: "mock-2", name: "flow.drawio.png", src: px, xml },
    ];
  }

  // ── editor ───────────────────────────────────────────────────────────────
  let pending = null;     // { xml, item, diagramId, png } seeded once the editor signals init
  let listener = null;

  function openEditor(seedXml, item, diagramId) {
    if (!available) { log("drawio editor unavailable (submodule not populated)"); return; }
    pending = { xml: seedXml || "", item: item || null, diagramId: diagramId || "", png: null };
    wrap.hidden = false;
    // (re)attach the message bridge for the editor iframe
    if (listener) window.removeEventListener("message", listener);
    listener = (ev) => onEditorMessage(ev);
    window.addEventListener("message", listener);
    // embed mode + json protocol; spin shows a loader until init.
    // NOTE the TRAILING SLASH on /drawio/ — drawio's index.html uses relative
    // asset paths (js/…, styles/…), so without it they'd resolve to /js/… (404).
    frame.src = "/drawio/?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=0";
  }

  function onEditorMessage(ev) {
    let msg = ev.data;
    if (typeof msg !== "string") return;          // drawio sends JSON strings
    try { msg = JSON.parse(msg); } catch { return; }
    if (msg.event === "init") {
      // Hand drawio the EXACT file (raw .drawio.svg / mxfile, or a PNG data-uri)
      // and let ITS loader extract the diagram — no unwrapping here. A PNG goes
      // via xmlpng; everything else via xml (drawio reads the SVG content= attr).
      post(drawioLoadAction(pending ? pending.xml : ""));
    } else if (msg.event === "save") {
      // user hit save inside the editor → dual export: xmlpng for the deck
      // image, then xmlsvg for the Drive-side editable .drawio.svg.
      if (pending) pending.png = null;
      post({ action: "export", format: "xmlpng", scale: currentScale(), spin: "Exporting…" });
    } else if (msg.event === "export") {
      if (pending && pending.png === null) {
        pending.png = msg.data;
        post({ action: "export", format: "xmlsvg", spin: "Exporting…" });
      } else {
        onExport(pending ? pending.png : msg.data, msg.data, msg.xml || (pending && pending.xml) || "");
      }
    } else if (msg.event === "exit") {
      closeEditor();
    }
  }

  function post(obj) {
    try { frame.contentWindow.postMessage(JSON.stringify(obj), "*"); }
    catch (e) { log("drawio post failed: " + e.message); }
  }

  // Build the official drawio `load` action for a raw seed. A PNG data-uri uses
  // xmlpng (drawio extracts its embedded chunk); a raw .drawio.svg / mxfile uses
  // xml (drawio reads the SVG content= attr / parses the mxfile). We never
  // unwrap the file ourselves — drawio's loader does it.
  function drawioLoadAction(seed, autosave) {
    seed = seed || "";
    const as = autosave === undefined ? 1 : autosave;
    return /^data:image\/png/i.test(seed)
      ? { action: "load", xmlpng: seed, autosave: as }
      : { action: "load", xml: seed, autosave: as };
  }

  async function onExport(png, svg, xml) {
    if (!png) { log("drawio export: empty payload"); return; }
    const target = pending && pending.item;
    const diagramId = (pending && pending.diagramId) || "";
    if (inAddon) {
      try {
        // saveDiagram replaces/inserts the image AND writes the editable SVG
        // back to its Drive file (drawio/<kind>/<id>/<diagramId>.drawio.svg).
        await gsCall("saveDiagram", {
          imageId: (target && target.id) || "",
          diagramId, png, svg, xml,
        });
        log("drawio: diagram saved (image + Drive .drawio.svg)");
      } catch (e) { log("drawio save failed: " + e.message); }
    } else {
      log("drawio (dev): exported PNG (" + png.length + " bytes) + SVG (" + ((svg || "").length) + " bytes); save is stubbed");
    }
    await detect(); // refresh list
  }

  function closeEditor() {
    wrap.hidden = true;
    frame.src = "about:blank";
    if (listener) { window.removeEventListener("message", listener); listener = null; }
    pending = null;
  }

  // In the add-on we open the editor in a real browser TAB (true fullscreen, no
  // Apps Script dialog chrome). The tab can't write to the deck itself, so it
  // hands its saved result back to THIS sidebar over window.opener.postMessage —
  // NO server relay, NO server session, NO polling. The URL hash carries only a
  // client-side Math.random() nonce (never sent to the server) to correlate the
  // tab with its pending edit; the seed (xml/imageId) and the save both travel
  // window.opener ⇄ tab, and the deck write is a gsCall(saveDiagram) to Apps
  // Script. In dev (standalone) we fall back to the inline sidebar iframe.
  async function edit(item) {
    log("drawio: editing " + item.name);
    if (inAddon) {
      // Re-fetch CURRENT xml — the cached `items` copy is pre-edit.
      let xml = item.xml || "";
      try {
        const fresh = (await gsCall("listDeckImages")) || [];
        const match = fresh.find((x) => x.id === item.id);
        if (match && match.xml) xml = match.xml;
      } catch (e) { log("drawio: (using cached xml — refresh failed: " + e.message + ")"); }
      await openInTab(xml, item.id);
    } else {
      openEditor(item.xml || "", item);
    }
  }

  function newDiagram() {
    // A new diagram needs an id — it names the Drive file
    // (drawio/<kind>/<containerId>/<id>.drawio.svg) the image will link to.
    const id = (window.prompt("Diagram id (names the Drive file <id>.drawio.svg):", "") || "").trim();
    if (!id) { log("drawio: new diagram cancelled (no id)"); return; }
    if (!/^[A-Za-z0-9._-]+$/.test(id)) { log("drawio: invalid id (use letters, digits, . _ -)"); return; }
    log("drawio: new diagram " + id);
    if (inAddon) openInTab("", "", id);
    else openEditor("", null, id);
  }

  // ── upload an existing .drawio / .drawio.svg / .drawio.png file ──────────
  // The FILE NAME (minus the drawio extension) becomes the diagram id; the
  // parsed XML is rendered to a PNG, inserted, linked, and the editable SVG is
  // written to Drive — after that the diagram round-trips like any other.
  async function uploadDrawio(file) {
    const m = file.name.match(/^(.*?)\.drawio(\.svg|\.png)?$/i);
    if (!m) { log("drawio: not a drawio file (expect .drawio/.drawio.svg/.drawio.png): " + file.name); return; }
    const diagramId = m[1];
    const ext = (m[2] || "").toLowerCase();
    try {
      let xml = null;
      if (ext === ".png") {
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
        });
        const r = await api("/api/drawio/detect", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ png: dataUrl }),
        }).then((x) => x.json());
        if (!r.isDrawio) throw new Error("no drawio XML embedded in the PNG");
        xml = r.xml;
      } else {
        const text = await file.text();
        xml = ext === ".svg" ? extractSvgContentAttr(text) : text;
        if (!xml) throw new Error("no drawio XML found in the file");
      }
      log("drawio: uploading " + diagramId + "…");
      const out = await renderXmlToPng(xml, currentScale());
      if (inAddon) {
        await gsCall("saveDiagram", { imageId: "", diagramId, png: out.png, svg: out.svg, xml: out.xml });
        log("drawio: ✓ " + diagramId + " inserted + stored on Drive");
        await detect();
      } else {
        log("drawio (dev): parsed " + diagramId + " (" + xml.length + " chars xml); insert is stubbed");
      }
    } catch (e) { log("drawio upload failed: " + e.message); }
  }

  // mxfile XML out of an editable SVG's root content="…" attribute.
  function extractSvgContentAttr(svg) {
    const m2 = String(svg).match(/<svg[^>]*\scontent="([^"]*)"/);
    if (!m2) return null;
    return m2[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }

  // Option A as an RPC over window.opener — NO server relay. The sidebar opens the
  // editor tab with only a short nonce in the URL hash; the tab then requests its
  // seed (imageId + xml) over postMessage and posts its save back the same way.
  // Pending edits are held here, keyed by nonce (supports concurrent edits).
  const pendingEdits = Object.create(null);
  let nonceSeq = 0;

  function openInTab(xml, imageId, diagramId) {
    const nonce = "e" + (++nonceSeq) + "-" + Math.random().toString(36).slice(2, 9);
    pendingEdits[nonce] = { xml: xml || "", imageId: imageId || "", diagramId: diagramId || "", scale: currentScale() };
    const w = window.open("/edit.html#" + nonce, "_blank");
    log(w
      ? "drawio: editor opened in a new tab. Edit → Save & Close; keep THIS sidebar open — the deck updates when you save."
      : "drawio: opened an editor tab (if none appeared, allow pop-ups). Keep this sidebar open.");
  }

  // The sidebar is the RPC "API" for the editor tab: it answers seed requests and
  // receives saves. Both rely on the tab's window.opener pointing back here; the
  // tab fails loudly if the browser severed it.
  if (inAddon) {
    const SERVER_ORIGIN = (() => { try { return new URL(document.baseURI).origin; } catch (e) { return ""; } })();
    window.addEventListener("message", async (ev) => {
      const m = ev.data;
      if (!m || typeof m !== "object" || !m.nonce) return;
      if (SERVER_ORIGIN && ev.origin !== SERVER_ORIGIN) return;   // tab is served from our origin
      const pend = pendingEdits[m.nonce];
      if (m.type === "drawio-edit-ready") {
        if (!pend) return;                                        // unknown / expired nonce
        try { ev.source.postMessage({ type: "drawio-seed", nonce: m.nonce, imageId: pend.imageId, diagramId: pend.diagramId || "", xml: pend.xml, scale: pend.scale }, ev.origin); } catch (e) {}
      } else if (m.type === "drawio-save") {
        log("drawio: received save from the editor tab — writing to the deck + Drive…");
        try {
          await gsCall("saveDiagram", {
            imageId: m.imageId || (pend && pend.imageId) || "",
            diagramId: m.diagramId || (pend && pend.diagramId) || "",
            png: m.png, svg: m.svg, xml: m.xml,
          });
          log("drawio: ✓ diagram updated (deck image + Drive .drawio.svg).");
          delete pendingEdits[m.nonce];
          await detect();
        } catch (e) { log("drawio: deck write failed: " + e.message); }
      }
    });
  }

  async function del(item) {
    if (inAddon) {
      try { await gsCall("deleteImage", item.id); log("drawio: deleted " + item.name); }
      catch (e) { log("drawio delete failed: " + e.message); }
    } else {
      log("drawio (dev): would delete " + item.name + " (id=" + item.id + ")");
    }
    items = items.filter((x) => x !== item);
    render();
  }

  // ── agent/API surface — list, read, and edit deck diagrams programmatically.
  // Exposed on `bridge.drawio` so the command handler (WebRTC / Local device) and
  // thus a remote agent can collaborate on the SAME diagrams you edit in this
  // panel: list them, read their XML, and write new XML back (re-rendered). ──
  async function apiList() {
    if (!inAddon) return mockItems().map((m, i) => ({ id: m.id, slide: i + 1, name: m.name, box: null, xml: m.xml }));
    const imgs = (await gsCall("listDeckImages")) || [];
    return imgs.filter((x) => x.xml).map((x) => ({ id: x.id, slide: x.slideIndex || null, name: x.name, box: x.box || null, xml: x.xml }));
  }
  async function apiGet(id) {
    const m = (await apiList()).find((x) => x.id === id);
    return m ? m.xml : null;
  }
  // Render drawio XML headlessly via a hidden editor iframe (no UI), the same
  // embed protocol the inline editor uses. Exports BOTH an xmlpng (the deck
  // image) and an xmlsvg (the rendered editable SVG stored on Drive).
  // Resolves {png, svg, xml}.
  function renderXmlToPng(xml, scale) {
    scale = scale || 4;  // 1× is blurry; 4× → ~2048px after Google's import cap
    return new Promise((resolve, reject) => {
      const ifr = document.createElement("iframe");
      ifr.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:720px;border:0";
      let done = false, exportSent = false, png = null;
      const post = (o) => { try { ifr.contentWindow.postMessage(JSON.stringify(o), "*"); } catch (e) { /* gone */ } };
      const finish = (err, val) => {
        if (done) return; done = true;
        window.removeEventListener("message", onMsg); clearTimeout(to);
        try { ifr.remove(); } catch (e) { /* already gone */ }
        err ? reject(err) : resolve(val);
      };
      // Ask for the PNG once — drawio doesn't reliably emit a `load` event, so we
      // fire export both on `load` (if it comes) and a short fallback after `init`.
      const requestExport = () => { if (exportSent) return; exportSent = true; post({ action: "export", format: "xmlpng", scale: scale }); };
      const onMsg = (ev) => {
        if (ev.source !== ifr.contentWindow) return;
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.event === "init") { post({ action: "load", xml: xml || "", autosave: 0 }); setTimeout(requestExport, 600); }
        else if (m.event === "load") requestExport();
        else if (m.event === "export") {
          if (png === null) { png = m.data; post({ action: "export", format: "xmlsvg" }); }
          else finish(null, { png, svg: m.data, xml: m.xml || xml });
        }
      };
      const to = setTimeout(() => finish(new Error("drawio render timed out (20s)")), 20000);
      window.addEventListener("message", onMsg);
      ifr.src = "/drawio/?embed=1&proto=json&spin=1&libraries=1";  // self-hosted, same origin
      document.body.appendChild(ifr);
    });
  }
  // opts (optional): { slide, x, y, w, h, scale }. slide is 1-based; x,y,w,h are
  // NORMALIZED [0,1] slide coords (omitted → keep frame on edit / fit+center on new);
  // scale is the drawio render multiplier (default 4× for a crisp PNG).
  async function apiSet(id, xml, opts) {
    opts = opts || {};
    const out = await renderXmlToPng(xml || "", opts.scale || currentScale());
    const payload = { imageId: id || "", diagramId: (opts.diagramId || ""), png: out.png, svg: out.svg, xml: out.xml };
    ["slide", "x", "y", "w", "h"].forEach((k) => { if (opts[k] != null) payload[k] = opts[k]; });
    let res = { id: id || null };
    if (inAddon) res = await gsCall("saveDiagram", payload);  // {ok, id, slide}
    else log("drawio (dev): rendered diagram (" + ((out.png || "").length) + " bytes); deck save stubbed");
    await detect(); // refresh the panel list so a manual editor sees the change
    return res;
  }
  bridge.drawio = { list: apiList, get: apiGet, set: apiSet, render: renderXmlToPng };

  // ── wire panel buttons ────────────────────────────────────────────────────
  $("#drawio-detect-btn").addEventListener("click", detect);
  $("#drawio-new-btn").addEventListener("click", newDiagram);
  const uploadBtn = $("#drawio-upload-btn"), uploadInput = $("#drawio-upload-input");
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener("click", () => uploadInput.click());
    uploadInput.addEventListener("change", async () => {
      const f = uploadInput.files && uploadInput.files[0];
      uploadInput.value = "";           // allow re-selecting the same file
      if (f) await uploadDrawio(f);
    });
  }

  // ── selection-driven editing (Slides): poll the container selection; when
  // the user selects an IMAGE whose link resolves to a *.drawio(.svg|.png)
  // file, load it straight into the editor UI (inline iframe — window.open
  // would be popup-blocked outside a click handler). Docs has no selection
  // API for images, so this stays a Slides affordance; the list covers Docs. ──
  if (inAddon) {
    let lastSelId = null, pollBusy = false;
    setInterval(async () => {
      if (pollBusy || !wrap.hidden) return;   // don't fight an open editor
      pollBusy = true;
      try {
        const sel = await gsCall("getSelectedDrawio");
        if (sel && sel.id && sel.id !== lastSelId) {
          lastSelId = sel.id;
          log("drawio: selected diagram " + (sel.name || sel.id) + " — loading into editor…");
          openEditor(sel.xml || "", { id: sel.id, name: sel.name || sel.id }, "");
        } else if (!sel) {
          lastSelId = null;                   // selection left the diagram → re-arm
        }
      } catch (e) { /* transient gsCall failure — next tick retries */ }
      finally { pollBusy = false; }
    }, 2500);
  }

  render(); // start with the empty-state hint
});
