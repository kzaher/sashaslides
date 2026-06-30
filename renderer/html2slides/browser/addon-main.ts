/**
 * Google Slides add-on sidebar client.
 *
 * Same UX as the standalone html2slides page (paste HTML with Ctrl+V or pick
 * .html files), but instead of downloading a .pptx it:
 *   1. builds the .pptx bytes locally via the shared convert-core pipeline,
 *   2. base64-encodes them,
 *   3. hands them to the bound Apps Script via google.script.run, which converts
 *      them to native Google Slides and inserts them AFTER the current slide.
 *
 * All HTML rendering / extraction still happens locally in this sandboxed
 * sidebar page — only the finished pptx bytes cross to the server.
 */
import { processFile, buildPptxInMemory, type Slide, type SlideInput, type LogFn } from "./convert-core";

// --- google.script.run bridge (injected by HtmlService into the sidebar) ---
interface GsRunner {
  withSuccessHandler<T>(cb: (r: T) => void): GsRunner;
  withFailureHandler(cb: (e: Error) => void): GsRunner;
  insertPptxAfterCurrent(base64: string, title: string): void;
  getAuthInfo(): void;
  testDriveAccess(): void;
}
declare const google: {
  script: {
    run: GsRunner;
    host: { close(): void; setHeight(h: number): void; editor: { focus(): void } };
  };
};

// The shared app.js shell (shell.html) exposes the oversampling slider via
// `window.h2s.bridge.oversampling()` (1-8, default 2). When the sidebar runs
// inside that shell we honour the slider; standalone we fall back to 2.
// The `window.h2s` / H2sBridge shape is declared ambiently in ./h2s-host.d.ts
// (shared with insert-feature.ts).

/** Read the UI oversampling value (clamped [1,8]); default 2 when absent. */
function uiOversampling(): number {
  let v = 2;
  try { const b = window.h2s?.bridge?.oversampling; if (b) v = Number(b()); } catch { /* ignore */ }
  if (!Number.isFinite(v)) return 2;
  return Math.min(8, Math.max(1, v));
}
type InsertResult = { inserted: number; at: number; title: string };
type AuthInfo = { status: string; url: string };
type TestResult = { ok: boolean; user?: string };

/** Promise wrapper around a google.script.run server call. */
function gsCall<T>(invoke: (r: GsRunner) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke(google.script.run.withSuccessHandler<T>((v) => resolve(v)).withFailureHandler((e) => reject(e)));
  });
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

const log: LogFn = (msg, kind = "info") => {
  const logEl = $("#log") as HTMLDivElement;
  const line = document.createElement("div");
  line.className = kind;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // eslint-disable-next-line no-console
  console[kind === "error" ? "error" : kind === "warn" ? "warn" : "log"](msg);
};

function setProgress(done: number, total: number, label = "") {
  const bar = $("#progress-bar") as HTMLDivElement;
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  ($("#progress-label") as HTMLDivElement).textContent = total ? `${done}/${total} ${label}` : "";
}

/** Chunked base64 of the pptx bytes — avoids the arg-count blowup of
 * `String.fromCharCode(...wholeArray)` on multi-hundred-KB decks. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function insertOnServer(base64: string, title: string): Promise<InsertResult> {
  return gsCall<InsertResult>((r) => r.insertPptxAfterCurrent(base64, title));
}

/** Show a coloured notice box with optional inline HTML (e.g. a re-auth link). */
function notice(html: string, kind: "warn" | "ok"): void {
  ($("#notice") as HTMLDivElement).innerHTML = `<div class="box ${kind}">${html}</div>`;
}

/** Surface the consent URL as a clickable link (and try to pop it open). The
 * sandboxed iframe may block programmatic window.open, so the link is primary. */
function offerReauth(url: string): void {
  ($("#trouble") as HTMLDetailsElement).open = true;
  notice(
    `Drive permission looks stale. <a href="${url}" target="_blank" rel="noopener">Re-authorize html2slides ↗</a>, grant access (tick <b>Drive</b>), then click Insert again.`,
    "warn",
  );
  try { window.open(url, "_blank", "noopener"); } catch { /* popup blocked — the link covers it */ }
}

async function reauthorize(): Promise<void> {
  try {
    const info = await gsCall<AuthInfo>((r) => r.getAuthInfo());
    log(`auth status: ${info.status}`);
    offerReauth(info.url);
  } catch (e) {
    log("could not fetch auth URL: " + (e as Error).message, "error");
  }
}

async function convertAndInsert(files: File[]): Promise<void> {
  // Sort by name so slide_01.html precedes slide_02.html (matches the page/CLI).
  files.sort((a, b) => a.name.localeCompare(b.name));
  ($("#insert-btn") as HTMLButtonElement).disabled = true;
  ($("#log") as HTMLDivElement).innerHTML = "";
  log(`Converting ${files.length} slide(s)…`);

  const oversampling = uiOversampling();
  if (oversampling !== 2) log(`oversampling: ${oversampling}×`);

  const slides: Slide[] = [];
  setProgress(0, files.length, "extracting");
  for (let i = 0; i < files.length; i++) {
    log(`[${i + 1}/${files.length}] ${files[i].name}`);
    try {
      slides.push(await processFile(files[i], log, oversampling));
    } catch (e) {
      log(`  ${files[i].name}: extraction failed: ${(e as Error).message}`, "error");
    }
    setProgress(i + 1, files.length, "extracting");
  }

  if (slides.length === 0) {
    log("nothing to assemble — aborting", "error");
    ($("#insert-btn") as HTMLButtonElement).disabled = false;
    return;
  }

  log(`Assembling .pptx (${slides.length} slide(s))…`);
  setProgress(0, 1, "building pptx");
  const title = files[0].name.replace(/\.html?$/i, "") + (files.length > 1 ? "-deck" : "");
  const bytes = await buildPptxInMemory(slides as readonly SlideInput[], title);
  setProgress(1, 1, "inserting");
  log(`pptx built: ${bytes.byteLength.toLocaleString()} bytes — inserting into deck…`);

  try {
    const r = await insertOnServer(bytesToBase64(bytes), title);
    log(`✓ inserted ${r.inserted} slide(s) after the current slide (now at position ${r.at}).`);
    notice(`✓ inserted ${r.inserted} slide(s).`, "ok");
    // Clear the queue so the next paste starts fresh.
    filesState.length = 0;
    renderFileList();
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log(`insert failed: ${msg}`, "error");
    // A permission/storage error almost always means a stale or partial Drive
    // grant — fetch the consent URL and offer the re-authorize link inline.
    if (/PERMISSION_DENIED|permission|authoriz|storage/i.test(msg)) {
      await reauthorize();
    }
  } finally {
    ($("#insert-btn") as HTMLButtonElement).disabled = filesState.length === 0;
  }
}

// --- UI wiring (mirrors main.ts) ---
const filesState: File[] = [];
let pasteCounter = 0;

function renderFileList() {
  const list = $("#file-list") as HTMLUListElement;
  list.innerHTML = "";
  for (const f of filesState) {
    const li = document.createElement("li");
    li.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
    list.appendChild(li);
  }
  ($("#insert-btn") as HTMLButtonElement).disabled = filesState.length === 0;
  ($("#file-count") as HTMLSpanElement).textContent = String(filesState.length);
}

function addFiles(files: FileList | File[]) {
  let added = 0;
  for (const f of Array.from(files)) {
    if (!/\.html?$/i.test(f.name)) continue;
    if (filesState.some((g) => g.name === f.name && g.size === f.size)) continue;
    filesState.push(f);
    added++;
  }
  renderFileList();
  return added;
}

/** Turn pasted HTML/plain-text into a queued `pasted_NN.html` file. */
function addPastedHtml(content: string): void {
  const trimmed = (content || "").trim();
  if (!trimmed) return;
  const name = `pasted_${String(++pasteCounter).padStart(2, "0")}.html`;
  addFiles([new File([content], name, { type: "text/html" })]);
  log(`pasted content as ${name} (${trimmed.length} chars)`);
}

/** Read the clipboard via the async Clipboard API (gesture-triggered by the
 * Paste button). The sidebar iframe is granted clipboard-read, so this works
 * even when keyboard paste doesn't reach the focused iframe. */
async function pasteFromClipboard(): Promise<void> {
  const nav = navigator as Navigator & { clipboard?: { read?: () => Promise<ClipboardItem[]>; readText?: () => Promise<string> } };
  try {
    if (nav.clipboard?.read) {
      const items = await nav.clipboard.read();
      let got = false;
      for (const it of items) {
        const type = it.types.includes("text/html") ? "text/html" : it.types.includes("text/plain") ? "text/plain" : null;
        if (!type) continue;
        const blob = await it.getType(type);
        const txt = await blob.text();
        if (txt.trim()) { addPastedHtml(txt); got = true; }
      }
      if (got) return;
    }
    if (nav.clipboard?.readText) {
      const txt = await nav.clipboard.readText();
      if (txt.trim()) { addPastedHtml(txt); return; }
    }
    log("clipboard had no HTML/text — click the paste box and press ⌘V / Ctrl+V", "warn");
    ($("#paste-box") as HTMLTextAreaElement).focus();
  } catch {
    log("clipboard read was blocked — click the paste box and press ⌘V / Ctrl+V instead", "warn");
    ($("#paste-box") as HTMLTextAreaElement).focus();
  }
}

function extractPaste(dt: DataTransfer): boolean {
  const pastedFiles = Array.from(dt.files || []).filter((f) => /\.html?$/i.test(f.name));
  if (pastedFiles.length) {
    addFiles(pastedFiles);
    log(`pasted ${pastedFiles.length} file(s): ${pastedFiles.map((f) => f.name).join(", ")}`);
    return true;
  }
  const html = dt.getData("text/html");
  const text = dt.getData("text/plain");
  const content = html || text;
  if (content.trim()) { addPastedHtml(content); return true; }
  return false;
}

function init() {
  const drop = $("#dropzone") as HTMLDivElement;
  const picker = $("#picker") as HTMLInputElement;
  const pasteBox = $("#paste-box") as HTMLTextAreaElement;

  // Make the ENTIRE sidebar a drop target. Without a document-level
  // dragover/drop that preventDefault()s, a file dropped anywhere outside the
  // dropzone makes the browser NAVIGATE to the file (the "file loaded in the
  // browser" bug). Capturing at the document keeps every drop in-app.
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  document.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  document.addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    if (e.dataTransfer?.files?.length) {
      const n = addFiles(e.dataTransfer.files);
      log(n ? `added ${n} file(s) by drop` : "dropped item(s) had no .html files", n ? "info" : "warn");
    }
  });

  // The dropzone and "Browse slide files…" are <label for="picker"> elements, so
  // a real click opens the OS dialog natively (a programmatic picker.click() is
  // blocked inside the Apps Script sandbox). We only wire the input's events.
  void drop;
  picker.addEventListener("click", () => { picker.value = ""; }); // re-pick same file works
  picker.addEventListener("change", () => { if (picker.files) addFiles(picker.files); });

  // Paste button → async Clipboard API (works even when ⌘V doesn't reach the iframe).
  ($("#paste-btn") as HTMLButtonElement).addEventListener("click", () => { pasteFromClipboard(); });

  // Paste box: a real focusable textarea so keyboard paste is captured reliably
  // inside the sandboxed iframe. Pasting here queues the content and clears the box.
  pasteBox.addEventListener("paste", (e) => {
    const dt = e.clipboardData;
    if (dt && extractPaste(dt)) { e.preventDefault(); pasteBox.value = ""; }
  });

  // Document-level keyboard paste as a fallback (when focus is on the body, not a field).
  document.addEventListener("paste", (e) => {
    const t = e.target as HTMLElement | null;
    if (t === pasteBox) return; // handled above
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (e.clipboardData && extractPaste(e.clipboardData)) e.preventDefault();
  });

  ($("#insert-btn") as HTMLButtonElement).addEventListener("click", () => {
    convertAndInsert(filesState.slice()).catch((e) => {
      log("conversion crashed: " + (e as Error).message, "error");
      ($("#insert-btn") as HTMLButtonElement).disabled = false;
    });
  });
  ($("#clear-btn") as HTMLButtonElement).addEventListener("click", () => {
    filesState.length = 0;
    renderFileList();
    ($("#log") as HTMLDivElement).innerHTML = "";
    ($("#notice") as HTMLDivElement).innerHTML = "";
    setProgress(0, 0);
  });

  // Re-authorize: Apps Script won't re-prompt once scopes are granted, so this
  // surfaces the consent URL directly for a manual re-grant.
  ($("#reauth-btn") as HTMLButtonElement).addEventListener("click", () => { reauthorize(); });

  // Test permissions: hit Drive with the user's auth and report the result, so
  // we can tell an auth problem (fixable by re-auth) from a transient backend one.
  ($("#testperm-btn") as HTMLButtonElement).addEventListener("click", async () => {
    notice("Testing Drive access…", "warn");
    try {
      const r = await gsCall<TestResult>((rr) => rr.testDriveAccess());
      notice(`✓ Drive access works (as ${r.user || "your account"}). If Insert still fails it's likely a transient Google error — try Insert again.`, "ok");
      log("Drive permission test: OK");
    } catch (e) {
      const msg = (e as Error).message || String(e);
      log("Drive permission test failed: " + msg, "error");
      await reauthorize();
    }
  });

  renderFileList();
  // Grab focus so the very first ⌘V / Ctrl+V lands in the paste box without a
  // click (Apps Script keeps focus in the Slides editor otherwise).
  try { pasteBox.focus(); } catch { /* ignore */ }
  log("ready. Upload / drop / paste slide HTML, then Insert.");
  if (typeof google !== "undefined" && !(window as Window & { PptxGenJS?: unknown }).PptxGenJS) {
    log("loading converter libraries…", "info");
  }
  detectAccountAndWarn();
}

/** Parse a Google `authuser` account index out of any URL-ish string. The most
 * reliable source in a sidebar is the iframe host itself: Apps Script serves it
 * from `n-<hash>-<N>lu-script.googleusercontent.com`, where <N> is the authuser. */
function parseAuthUser(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-(\d+)lu-script\.googleusercontent/)   // sidebar host: -<N>lu-
    || s.match(/[?&]authuser=(\d+)/)
    || s.match(/\/u\/(\d+)(?:\/|\b)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Show the non-default-account warning banner. */
function warnNonDefaultAccount(idx: number | null): void {
  try { ($("#trouble") as HTMLDetailsElement).open = true; } catch { /* no-op */ }
  const who = idx != null && idx !== 0 ? `a non-default account (authuser=${idx})` : "a non-default Google account";
  notice(
    `⚠ <b>html2slides can't reach its server</b> — you're on ${who}. Google's add-on `
    + `multi-login bug blocks server calls (PERMISSION_DENIED) on every account except your `
    + `<b>default (u/0)</b>. Open this deck under your default Google account (or install the `
    + `add-on), then reopen html2slides.`,
    "warn",
  );
  log(`⚠ non-default account detected (authuser=${idx == null ? "?" : idx}) — server calls will fail`, "warn");
}

/** On load: parse the account index from client-side signals, and run a server
 * health-check (the call that fails under the multi-login bug). Warn up front. */
function detectAccountAndWarn(): void {
  const signals: Record<string, string> = {
    href: location.href,
    referrer: document.referrer || "",
    ancestors: (() => { try { return Array.from((location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins || []).join(" "); } catch { return ""; } })(),
    name: window.name || "",
  };
  let idx: number | null = null;
  for (const v of Object.values(signals)) { const p = parseAuthUser(v); if (p != null) { idx = p; break; } }
  log(`authuser detect: index=${idx == null ? "?" : idx}`, "info");
  // Non-default account index → warn IMMEDIATELY (no server round-trip needed).
  if (idx != null && idx !== 0) { warnNonDefaultAccount(idx); return; }
  // Index unknown → fall back to a tiny server round-trip that fails with
  // PERMISSION_DENIED under the multi-login bug.
  if (idx == null) {
    gsCall<AuthInfo>((r) => r.getAuthInfo())
      .catch((e: Error) => {
        const msg = e?.message || String(e);
        if (/PERMISSION_DENIED|storage|permission|authoriz/i.test(msg)) warnNonDefaultAccount(null);
      });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
