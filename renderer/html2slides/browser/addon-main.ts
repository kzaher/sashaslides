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
  withSuccessHandler(cb: (r: InsertResult) => void): GsRunner;
  withFailureHandler(cb: (e: Error) => void): GsRunner;
  insertPptxAfterCurrent(base64: string, title: string): void;
}
declare const google: {
  script: {
    run: GsRunner;
    host: { close(): void; setHeight(h: number): void; editor: { focus(): void } };
  };
};
type InsertResult = { inserted: number; at: number; title: string };

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
  return new Promise<InsertResult>((resolve, reject) => {
    google.script.run
      .withSuccessHandler((r) => resolve(r))
      .withFailureHandler((e) => reject(e))
      .insertPptxAfterCurrent(base64, title);
  });
}

async function convertAndInsert(files: File[]): Promise<void> {
  // Sort by name so slide_01.html precedes slide_02.html (matches the page/CLI).
  files.sort((a, b) => a.name.localeCompare(b.name));
  ($("#insert-btn") as HTMLButtonElement).disabled = true;
  ($("#log") as HTMLDivElement).innerHTML = "";
  log(`Converting ${files.length} slide(s)…`);

  const slides: Slide[] = [];
  setProgress(0, files.length, "extracting");
  for (let i = 0; i < files.length; i++) {
    log(`[${i + 1}/${files.length}] ${files[i].name}`);
    try {
      slides.push(await processFile(files[i], log));
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
    // Clear the queue so the next paste starts fresh.
    filesState.length = 0;
    renderFileList();
  } catch (e) {
    log(`insert failed: ${(e as Error).message}`, "error");
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
  for (const f of Array.from(files)) {
    if (!/\.html?$/i.test(f.name)) continue;
    if (filesState.some((g) => g.name === f.name && g.size === f.size)) continue;
    filesState.push(f);
  }
  renderFileList();
}

function init() {
  const drop = $("#dropzone") as HTMLDivElement;
  const picker = $("#picker") as HTMLInputElement;

  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("hover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("hover");
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  });
  drop.addEventListener("click", () => picker.click());
  // Reset value on open (not after change) so re-picking the same file works
  // and you never have to open the dialog twice (see main.ts for the why).
  picker.addEventListener("click", () => { picker.value = ""; });
  picker.addEventListener("change", () => {
    if (picker.files) addFiles(picker.files);
  });

  // Ctrl+V / Cmd+V: paste HTML (or an .html file) straight into the queue.
  document.addEventListener("paste", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    const dt = e.clipboardData;
    if (!dt) return;

    const pastedFiles = Array.from(dt.files || []).filter((f) => /\.html?$/i.test(f.name));
    if (pastedFiles.length) {
      e.preventDefault();
      addFiles(pastedFiles);
      log(`pasted ${pastedFiles.length} file(s): ${pastedFiles.map((f) => f.name).join(", ")}`);
      return;
    }

    const html = dt.getData("text/html");
    const text = dt.getData("text/plain");
    const content = (html || text || "").trim();
    if (!content) return;
    e.preventDefault();
    const name = `pasted_${String(++pasteCounter).padStart(2, "0")}.html`;
    addFiles([new File([html || text], name, { type: "text/html" })]);
    log(`pasted ${html ? "HTML" : "text"} content as ${name} (${content.length} chars)`);
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
    setProgress(0, 0);
  });

  renderFileList();
  log("ready. paste HTML (Ctrl+V) or drop/pick .html files, then Insert.");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
