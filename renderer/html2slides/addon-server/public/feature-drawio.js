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

  // In the add-on we open the editor BIG in a modal dialog (Code.gs →
  // showDrawioDialog); the sidebar is too narrow. The dialog itself does the
  // save-back to the deck, so the sidebar just re-detects afterwards. In dev
  // (standalone) we fall back to the inline sidebar iframe.
  async function edit(item) {
    log("drawio: editing " + item.name);
    if (inAddon) {
      try {
        // Re-fetch the CURRENT XML from the deck — the cached `items` copy is
        // pre-edit, so reopening from it would show the old state even though the
        // last Save updated the source box.
        let xml = item.xml || "";
        try {
          const fresh = (await gsCall("listDeckImages")) || [];
          const match = fresh.find((x) => x.id === item.id);
          if (match && match.xml) xml = match.xml;
        } catch (e) { log("drawio: (using cached xml — refresh failed: " + e.message + ")"); }
        await gsCall("showDrawioDialog", { xml, imageId: item.id });
        log("drawio: editor opened — Save & Close writes back; reopen reflects your latest save.");
      } catch (e) { log("drawio: open failed: " + e.message); }
    } else {
      openEditor(item.xml || "", item);
    }
  }

  function newDiagram() {
    log("drawio: new diagram");
    if (inAddon) {
      gsCall("showDrawioDialog", { xml: "", imageId: "" })
        .then(() => log("drawio: editor opened — Save inserts a new diagram, then click Detect to refresh."))
        .catch((e) => log("drawio: open failed: " + e.message));
    } else {
      openEditor("", null);
    }
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

  // ── wire panel buttons ────────────────────────────────────────────────────
  $("#drawio-detect-btn").addEventListener("click", detect);
  $("#drawio-new-btn").addEventListener("click", newDiagram);

  render(); // start with the empty-state hint
});
