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
  let pending = null;     // { xml, item } seeded once the editor signals init
  let listener = null;

  function openEditor(seedXml, item) {
    if (!available) { log("drawio editor unavailable (submodule not populated)"); return; }
    pending = { xml: seedXml || "", item: item || null };
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
      post({ action: "load", xml: pending ? pending.xml : "", autosave: 1 });
    } else if (msg.event === "save") {
      // user hit save inside the editor → ask for a PNG with XML embedded
      post({ action: "export", format: "xmlpng", spin: "Exporting…" });
    } else if (msg.event === "export") {
      onExport(msg.data);
    } else if (msg.event === "exit") {
      closeEditor();
    }
  }

  function post(obj) {
    try { frame.contentWindow.postMessage(JSON.stringify(obj), "*"); }
    catch (e) { log("drawio post failed: " + e.message); }
  }

  async function onExport(dataUrl) {
    if (!dataUrl) { log("drawio export: empty payload"); return; }
    const target = pending && pending.item;
    if (inAddon) {
      try {
        // replace the existing image, or insert a new one
        if (target && target.id) await gsCall("replaceImage", target.id, dataUrl);
        else await gsCall("insertImage", dataUrl);
        log("drawio: diagram saved to deck");
      } catch (e) { log("drawio save failed: " + e.message); }
    } else {
      log("drawio (dev): exported PNG (" + dataUrl.length + " bytes data-url); save is stubbed");
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
  // hands its saved result back through the server relay (one-time token); we
  // poll that relay and do the deck write here via saveDiagram. In dev
  // (standalone) we fall back to the inline sidebar iframe.
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
    log("drawio: new diagram");
    if (inAddon) openInTab("", "");
    else openEditor("", null);
  }

  // Option A as an RPC over window.opener — NO server relay. The sidebar opens the
  // editor tab with only a short nonce in the URL hash; the tab then requests its
  // seed (imageId + xml) over postMessage and posts its save back the same way.
  // Pending edits are held here, keyed by nonce (supports concurrent edits).
  const pendingEdits = Object.create(null);
  let nonceSeq = 0;

  function openInTab(xml, imageId) {
    const nonce = "e" + (++nonceSeq) + "-" + Math.random().toString(36).slice(2, 9);
    pendingEdits[nonce] = { xml: xml || "", imageId: imageId || "" };
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
        try { ev.source.postMessage({ type: "drawio-seed", nonce: m.nonce, imageId: pend.imageId, xml: pend.xml }, ev.origin); } catch (e) {}
      } else if (m.type === "drawio-save") {
        log("drawio: received save from the editor tab — writing to the deck…");
        try {
          await gsCall("saveDiagram", { imageId: m.imageId || (pend && pend.imageId) || "", png: m.png, xml: m.xml });
          log("drawio: ✓ diagram updated in the deck.");
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
  // Render drawio XML → xmlpng headlessly via a hidden editor iframe (no UI), the
  // same embed protocol the inline editor uses. Resolves {png, xml}.
  function renderXmlToPng(xml) {
    return new Promise((resolve, reject) => {
      const ifr = document.createElement("iframe");
      ifr.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:720px;border:0";
      let done = false, exportSent = false;
      const post = (o) => { try { ifr.contentWindow.postMessage(JSON.stringify(o), "*"); } catch (e) { /* gone */ } };
      const finish = (err, val) => {
        if (done) return; done = true;
        window.removeEventListener("message", onMsg); clearTimeout(to);
        try { ifr.remove(); } catch (e) { /* already gone */ }
        err ? reject(err) : resolve(val);
      };
      // Ask for the PNG once — drawio doesn't reliably emit a `load` event, so we
      // fire export both on `load` (if it comes) and a short fallback after `init`.
      const requestExport = () => { if (exportSent) return; exportSent = true; post({ action: "export", format: "xmlpng" }); };
      const onMsg = (ev) => {
        if (ev.source !== ifr.contentWindow) return;
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.event === "init") { post({ action: "load", xml: xml || "", autosave: 0 }); setTimeout(requestExport, 600); }
        else if (m.event === "load") requestExport();
        else if (m.event === "export") finish(null, { png: m.data, xml: m.xml || xml });
      };
      const to = setTimeout(() => finish(new Error("drawio render timed out (20s)")), 20000);
      window.addEventListener("message", onMsg);
      ifr.src = "/drawio/?embed=1&proto=json&spin=1&libraries=1";  // self-hosted, same origin
      document.body.appendChild(ifr);
    });
  }
  // pos (optional): { slide, x, y, w, h } — slide is 1-based; x,y,w,h are NORMALIZED
  // [0,1] slide coordinates. Omitted → keep existing frame (edit) or fit+center (new).
  async function apiSet(id, xml, pos) {
    const out = await renderXmlToPng(xml || "");
    const payload = { imageId: id || "", png: out.png, xml: out.xml };
    if (pos) ["slide", "x", "y", "w", "h"].forEach((k) => { if (pos[k] != null) payload[k] = pos[k]; });
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

  render(); // start with the empty-state hint
});
