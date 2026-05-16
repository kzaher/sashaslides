/**
 * html2slides browser app entry. Drag-and-drop HTML files → download .pptx.
 *
 * Per dropped file:
 *   1. Load HTML into a hidden 1280x720 iframe (srcdoc).
 *   2. Wait for load + fonts.ready + small settling delay.
 *   3. Inject the precompiled extract-dom.ts blob via iframe.contentWindow.eval.
 *   4. Walk visual/image elements and rasterize from inside the iframe (canvas
 *      drawImage for <img>/<svg>/<canvas>). Other "visual" tags are skipped
 *      with a warning — they'd need html2canvas in a follow-up.
 *   5. Collect { extraction, visualPngs } per slide.
 *
 * After every file is processed, call buildPptxInMemory and trigger download.
 */
import { buildPptxInMemory, type Extraction, type ExtractedElement, type SlideInput } from "../convert-pptx-lib";

// Build-time string substitution. `build.ts` replaces __EXTRACT_JS_LITERAL__
// with the compiled extract-dom.ts source via esbuild `define`. The browser
// path runs the compiled blob via `win.eval(__EXTRACT_JS_LITERAL__)` inside
// the iframe — no setExtractJs needed (lib.ts no longer exposes one; the
// Node-side extract-dom reader lives in convert-pptx-io.ts).
declare const __EXTRACT_JS_LITERAL__: string;

const SLIDE_W = 1280;
const SLIDE_H = 720;

type Slide = { extraction: Extraction; visualPngs: Map<number, Uint8Array>; name: string };

/** Boundary shim: showDirectoryPicker + FileSystemObserver are recent web
 * APIs that some `lib.dom.d.ts` versions ship without; declare what we use. */
interface FSDirHandlePerm { mode?: "read" | "readwrite" }
interface FSWritable {
  write(input: ArrayBufferLike | ArrayBufferView | Blob | string | { type: "write"; position?: number; data: BufferSource | Blob | string }): Promise<void>;
  close(): Promise<void>;
}
interface FSFileHandle {
  getFile(): Promise<File>;
  createWritable(opts?: { keepExistingData?: boolean; mode?: "exclusive" | "siloed" }): Promise<FSWritable>;
}
interface FSDirHandle {
  readonly name: string;
  readonly kind: "directory";
  entries(): AsyncIterableIterator<[string, FSFileHandle | FSDirHandle]>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FSFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FSDirHandle>;
  removeEntry(name: string): Promise<void>;
}
type ShowDirectoryPicker = (opts?: FSDirHandlePerm) => Promise<FSDirHandle>;
interface FSObserverRecord {
  type: "appeared" | "disappeared" | "modified" | "moved" | "errored";
  relativePathComponents?: string[];
}
type FSObserverCallback = (records: ReadonlyArray<FSObserverRecord>) => void;
interface FSObserverCtor {
  new(cb: FSObserverCallback): { observe(handle: FSDirHandle, opts?: { recursive?: boolean }): Promise<void> };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

// Extra logger sink — when the JSON-RPC bridge is processing a request, it
// installs one of these to mirror every log() line into the request's
// request.json.log file. Cleared when the request finishes.
let extraLogger: ((msg: string, kind: "info" | "warn" | "error") => void) | null = null;

const log = (msg: string, kind: "info" | "warn" | "error" = "info") => {
  const logEl = $("#log") as HTMLDivElement;
  const line = document.createElement("div");
  line.className = kind;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // eslint-disable-next-line no-console
  console[kind === "error" ? "error" : kind === "warn" ? "warn" : "log"](msg);
  if (extraLogger) try { extraLogger(msg, kind); } catch { /* never break the main log path */ }
};

function setProgress(done: number, total: number, label = "") {
  const bar = $("#progress-bar") as HTMLDivElement;
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  ($("#progress-label") as HTMLDivElement).textContent =
    total ? `${done}/${total} ${label}` : "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadIntoIframe(html: string): Promise<HTMLIFrameElement> {
  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    `position:fixed;left:-99999px;top:0;width:${SLIDE_W}px;height:${SLIDE_H}px;border:0;`;
  iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
  document.body.appendChild(iframe);

  // Prefer srcdoc so the iframe inherits this page's origin (same-origin
  // access to contentWindow/contentDocument is required to inject EXTRACT_JS).
  iframe.srcdoc = html;
  await new Promise<void>((res) => {
    iframe.addEventListener("load", () => res(), { once: true });
  });

  // Settling: matches the Node CDP pipeline's `await sleep(800) ; fonts.ready ; sleep(300)`.
  const idoc = iframe.contentDocument!;
  await sleep(150);
  try {
    // SAFETY: `document.fonts` (FontFaceSet) is in modern TS lib.dom.d.ts as a
    // FontFaceSet, but TS reads it through Document via a getter not present on
    // all targets; the `?.` runtime guard makes the cast safe even when the
    // property is undefined.
    await (idoc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  } catch {/* ignore */}
  await sleep(150);
  return iframe;
}

/** Evaluate the precompiled extract-dom blob inside the iframe. extract-dom
 * ends with `return JSON.stringify(...)` inside an IIFE, so the eval expression
 * returns the JSON string directly. */
function runExtractInIframe(iframe: HTMLIFrameElement): Extraction {
  const win = iframe.contentWindow as (Window & { eval(s: string): unknown }) | null;
  if (!win) throw new Error("iframe contentWindow not available");
  const raw = win.eval(__EXTRACT_JS_LITERAL__);
  const json = typeof raw === "string" ? JSON.parse(raw) : raw;
  return json as Extraction;
}

/**
 * Rasterize visual/image elements. Walks the iframe DOM to find nodes at the
 * extracted bounds, then renders them to a PNG via canvas. Supports <img>,
 * <canvas>, <svg>. Other tags log a warning and are skipped (renders as a
 * gap in the .pptx). 2× scale to match the Node CDP path.
 */
async function rasterizeVisuals(iframe: HTMLIFrameElement, extraction: Extraction): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  const idoc = iframe.contentDocument!;
  const iwin = iframe.contentWindow!;
  for (let i = 0; i < extraction.elements.length; i++) {
    const el = extraction.elements[i];
    if (el.type !== "visual" && el.type !== "image") continue;
    if (el.bounds.w <= 5 || el.bounds.h <= 5) continue;
    const tag = (el.tag || "").toLowerCase();
    try {
      const png = await rasterizeElement(idoc, iwin, el, tag);
      if (png) out.set(i, png);
    } catch (e) {
      log(`  rasterize fail [#${i}] <${tag}>: ${(e as Error).message}`, "warn");
    }
  }
  return out;
}

async function rasterizeElement(
  idoc: Document,
  iwin: Window,
  el: ExtractedElement,
  tag: string,
): Promise<Uint8Array | null> {
  const b = el.bounds;
  const node = findNodeAt(idoc, b, tag);
  if (!node) {
    log(`  no DOM node for visual [<${tag}> at ${b.x},${b.y} ${b.w}x${b.h}]`, "warn");
    return null;
  }

  const W = Math.max(1, Math.round(b.w * 2));
  const H = Math.max(1, Math.round(b.h * 2));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  if (node instanceof iwin.HTMLImageElement || node instanceof HTMLImageElement) {
    const img = node as HTMLImageElement;
    if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    ctx.drawImage(img, 0, 0, W, H);
  } else if (node instanceof iwin.HTMLCanvasElement || node instanceof HTMLCanvasElement) {
    ctx.drawImage(node as HTMLCanvasElement, 0, 0, W, H);
  } else if (tag === "svg" || (typeof iwin.SVGElement !== "undefined" && node instanceof iwin.SVGElement)) {
    const svgEl = node as SVGElement;
    // Ensure intrinsic size in serialization so the rendered img knows w/h.
    const cloned = svgEl.cloneNode(true) as SVGElement;
    if (!cloned.getAttribute("width")) cloned.setAttribute("width", String(b.w));
    if (!cloned.getAttribute("height")) cloned.setAttribute("height", String(b.h));
    const svgStr = new XMLSerializer().serializeToString(cloned);
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const tmp = new Image();
    tmp.crossOrigin = "anonymous";
    await new Promise<void>((res, rej) => {
      tmp.onload = () => res();
      tmp.onerror = () => rej(new Error("svg image load failed"));
      tmp.src = url;
    });
    ctx.drawImage(tmp, 0, 0, W, H);
    URL.revokeObjectURL(url);
  } else {
    log(`  unsupported visual tag <${tag}> — skipping`, "warn");
    return null;
  }

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Find the DOM node corresponding to an extracted element. extract-dom records
 * the element's tag plus its bounding-box; locate by tag+rect within the iframe.
 */
function findNodeAt(idoc: Document, b: { x: number; y: number; w: number; h: number }, tag: string): Element | null {
  const cands = idoc.getElementsByTagName(tag || "*");
  let best: { node: Element; dist: number } | null = null;
  for (let i = 0; i < cands.length; i++) {
    const r = cands[i].getBoundingClientRect();
    if (Math.abs(r.width - b.w) > 2 || Math.abs(r.height - b.h) > 2) continue;
    const dx = r.left - b.x;
    const dy = r.top - b.y;
    const dist = dx * dx + dy * dy;
    if (dist <= 4 && (!best || dist < best.dist)) best = { node: cands[i], dist };
  }
  if (best) return best.node;
  // Fall back to elementsFromPoint inside center.
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const list: Element[] = idoc.elementsFromPoint?.(cx, cy) ?? [];
  for (const n of list) {
    if (n.tagName.toLowerCase() === tag) return n;
  }
  return list[0] || null;
}

async function processFile(file: File): Promise<Slide> {
  const html = await file.text();
  const iframe = await loadIntoIframe(html);
  try {
    const extraction = runExtractInIframe(iframe);
    if (!extraction || !extraction.elements) {
      throw new Error("extraction returned no elements");
    }
    log(`  ${file.name}: ${extraction.elements.length} elements`);
    const visualPngs = await rasterizeVisuals(iframe, extraction);
    log(`  ${file.name}: rasterized ${visualPngs.size} visuals`);
    return { extraction, visualPngs, name: file.name };
  } finally {
    iframe.remove();
  }
}

function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function convertFiles(files: File[]): Promise<void> {
  // Sort by name so slide_01.html comes before slide_02.html, matching the
  // Node pipeline's readdirSync().sort() ordering.
  files.sort((a, b) => a.name.localeCompare(b.name));
  ($("#convert-btn") as HTMLButtonElement).disabled = true;
  ($("#log") as HTMLDivElement).innerHTML = "";
  log(`Converting ${files.length} slide(s)…`);

  const slides: Slide[] = [];
  setProgress(0, files.length, "extracting");
  for (let i = 0; i < files.length; i++) {
    log(`[${i + 1}/${files.length}] ${files[i].name}`);
    try {
      const s = await processFile(files[i]);
      slides.push(s);
    } catch (e) {
      log(`  ${files[i].name}: extraction failed: ${(e as Error).message}`, "error");
    }
    setProgress(i + 1, files.length, "extracting");
  }

  if (slides.length === 0) {
    log("nothing to assemble — aborting", "error");
    ($("#convert-btn") as HTMLButtonElement).disabled = false;
    return;
  }

  log(`Assembling .pptx (${slides.length} slide(s))…`);
  setProgress(0, 1, "building pptx");
  const title = files[0].name.replace(/\.html?$/i, "") + (files.length > 1 ? "-deck" : "");
  const bytes = await buildPptxInMemory(slides as readonly SlideInput[], title);
  setProgress(1, 1, "done");
  log(`pptx built: ${bytes.byteLength.toLocaleString()} bytes — downloading…`);
  downloadBytes(bytes, `${title}.pptx`);
  ($("#convert-btn") as HTMLButtonElement).disabled = false;
}

// --- UI wiring ---
const filesState: File[] = [];
function renderFileList() {
  const list = $("#file-list") as HTMLUListElement;
  list.innerHTML = "";
  for (const f of filesState) {
    const li = document.createElement("li");
    li.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
    list.appendChild(li);
  }
  ($("#convert-btn") as HTMLButtonElement).disabled = filesState.length === 0;
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
  picker.addEventListener("change", () => {
    if (picker.files) addFiles(picker.files);
    picker.value = "";
  });

  ($("#convert-btn") as HTMLButtonElement).addEventListener("click", () => {
    convertFiles(filesState.slice()).catch((e) => {
      log("conversion crashed: " + (e as Error).message, "error");
      ($("#convert-btn") as HTMLButtonElement).disabled = false;
    });
  });
  ($("#clear-btn") as HTMLButtonElement).addEventListener("click", () => {
    filesState.length = 0;
    renderFileList();
    ($("#log") as HTMLDivElement).innerHTML = "";
    setProgress(0, 0);
  });

  renderFileList();
  log("ready. drop .html files above, or click to pick.");

  // JSON-RPC bridge wiring (independent of drop-flow).
  ($("#bridge-pick") as HTMLButtonElement).addEventListener("click", () => {
    pickWatchDirAndStart().catch((e) => log("bridge crashed: " + (e as Error).message, "error"));
  });
}

// ===========================================================================
// JSON-RPC filesystem bridge
// ===========================================================================
// User picks a watch directory. We monitor it for `request.<id>/request.json`
// files. When one appears we:
//   1. Read request.json into memory
//   2. Delete request.json from disk (signals "consumed" to the CLI)
//   3. Open request.json.log for incremental writes (`mode: "exclusive"` so
//      `tail -f` from the CLI sees bytes as they're written)
//   4. Build the .pptx from the input HTML files listed in params.inputs
//      (each must be a sibling file in the same request.<id>/ directory)
//   5. Write result.pptx into request.<id>/
//   6. Write request.json.result.json with `{ exitCode, response: {...} }`
// Requests are processed serially; if more appear during a build, they queue.

declare const FileSystemObserver: FSObserverCtor;

type RpcReq = {
  jsonrpc?: string;
  id?: string;
  method?: string;
  params?: { inputs?: string[]; output?: string; title?: string };
};

const processedReqs = new Set<string>();
let bridgeQueue: Promise<void> = Promise.resolve();

async function pickWatchDirAndStart() {
  // SAFETY: `showDirectoryPicker` is a Chrome-only File System Access API
  // not yet in baseline lib.dom.d.ts. We feature-detect immediately after
  // (`typeof picker !== "function"`) before invoking, so the cast can only
  // produce a function or undefined — never a wrong-shaped value.
  const picker = (window as Window & { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker;
  if (typeof picker !== "function") {
    alert("This browser doesn't support showDirectoryPicker — needs Chrome/Edge.");
    return;
  }
  let dirHandle: FSDirHandle;
  try {
    dirHandle = await picker({ mode: "readwrite" });
  } catch (e) {
    if ((e as Error).name !== "AbortError") log("picker: " + (e as Error).message, "warn");
    return;
  }
  ($("#bridge-label") as HTMLSpanElement).textContent = "→ " + dirHandle.name + " (watching)";
  log("bridge: watching " + dirHandle.name, "info");

  // Initial scan: pick up any pending request.json files left over from
  // earlier CLI invocations / crashes.
  await scanForRequests(dirHandle);

  // Then attach observer (Chrome 129+) or fall back to polling.
  if (typeof FileSystemObserver === "function") {
    try {
      const observer = new FileSystemObserver((records) => {
        for (const r of records) {
          if (r.type === "appeared" || r.type === "modified") {
            const path = r.relativePathComponents || [];
            if (path.length === 2 && /^request\./.test(path[0]) && path[1] === "request.json") {
              enqueueRequest(dirHandle, path[0]);
            }
          }
        }
      });
      await observer.observe(dirHandle, { recursive: true });
      log("bridge: FileSystemObserver attached", "info");
      return;
    } catch (e) {
      log("bridge: observer failed (" + (e as Error).message + ") — polling instead", "warn");
    }
  }
  log("bridge: polling every 500ms (FileSystemObserver unavailable)", "info");
  setInterval(() => { scanForRequests(dirHandle).catch(() => {}); }, 500);
}

async function scanForRequests(dirHandle: FSDirHandle) {
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind !== "directory" || !/^request\./.test(name)) continue;
    try {
      await (h as FSDirHandle).getFileHandle("request.json");  // throws if absent
      enqueueRequest(dirHandle, name);
    } catch { /* no request.json yet */ }
  }
}

function enqueueRequest(rootDir: FSDirHandle, reqId: string) {
  if (processedReqs.has(reqId)) return;
  processedReqs.add(reqId);
  // Serialize: chain onto bridgeQueue so multiple requests run one at a time.
  bridgeQueue = bridgeQueue.then(() => processRequest(rootDir, reqId).catch((e) => {
    log(`bridge: request ${reqId} crashed: ${(e as Error).message}`, "error");
  }));
}

async function processRequest(rootDir: FSDirHandle, reqId: string) {
  log(`bridge: processing ${reqId}`, "info");
  const reqDir = await rootDir.getDirectoryHandle(reqId);

  // 1. Read request.json.
  let req: RpcReq;
  try {
    const fh = await reqDir.getFileHandle("request.json");
    req = JSON.parse(await (await fh.getFile()).text());
  } catch (e) {
    log(`bridge: ${reqId}: missing or invalid request.json (${(e as Error).message}) — skipping`, "warn");
    return;
  }
  const inputs = req.params?.inputs || [];
  const outputName = req.params?.output || "result.pptx";
  const title = req.params?.title || reqId;

  // 2. Open log writer (exclusive mode so tail -f sees writes immediately).
  const logHandle = await reqDir.getFileHandle("request.json.log", { create: true });
  let logWriter: FSWritable;
  try {
    logWriter = await logHandle.createWritable({ keepExistingData: false, mode: "exclusive" });
  } catch {
    logWriter = await logHandle.createWritable({ keepExistingData: false });
  }
  let logBytes = 0;
  const writeLog = async (line: string) => {
    const buf = new TextEncoder().encode(line.endsWith("\n") ? line : line + "\n");
    try { await logWriter.write({ type: "write", position: logBytes, data: buf }); logBytes += buf.byteLength; }
    catch { /* writer may have been closed */ }
  };
  await writeLog(`[bridge] starting request ${reqId} — ${inputs.length} input(s)`);

  // 3. Delete request.json on disk (signals "consumed"; in-memory copy is enough).
  try { await reqDir.removeEntry("request.json"); }
  catch (e) { await writeLog(`[bridge] could not delete request.json: ${(e as Error).message}`); }

  // 4. Install extraLogger so existing log() lines mirror into the log file.
  extraLogger = (msg, kind) => { writeLog(`[${kind}] ${msg}`); };

  type RpcResponse =
    | { jsonrpc: "2.0"; id: string; result: { outputPath: string; bytes: number; slides: number } }
    | { jsonrpc: "2.0"; id: string; error: { code: number; message: string } };
  let exitCode = 0;
  let response: RpcResponse | null = null;
  try {
    // Load each input file from the request directory.
    const files: File[] = [];
    for (const name of inputs) {
      const fh = await reqDir.getFileHandle(name);
      files.push(await fh.getFile());
    }
    const slides: Slide[] = [];
    for (let i = 0; i < files.length; i++) {
      log(`[${i + 1}/${files.length}] ${files[i].name}`);
      slides.push(await processFile(files[i]));
    }
    if (slides.length === 0) throw new Error("no input slides successfully processed");
    log(`Assembling .pptx (${slides.length} slide(s))…`);
    const bytes = await buildPptxInMemory(slides as readonly SlideInput[], title);
    log(`pptx built: ${bytes.byteLength.toLocaleString()} bytes`);

    // Write the .pptx output into the request dir.
    const outHandle = await reqDir.getFileHandle(outputName, { create: true });
    const outWriter = await outHandle.createWritable();
    await outWriter.write(bytes);
    await outWriter.close();
    response = {
      jsonrpc: "2.0",
      id: req.id ?? reqId,
      result: { outputPath: outputName, bytes: bytes.byteLength, slides: slides.length },
    };
  } catch (e) {
    exitCode = 1;
    log(`bridge: ${reqId} failed: ${(e as Error).message}`, "error");
    response = {
      jsonrpc: "2.0",
      id: req.id ?? reqId,
      error: { code: -32000, message: (e as Error).message },
    };
  }

  extraLogger = null;
  try { await logWriter.close(); } catch { /* */ }

  // 5. Write result.json atomically (write to a temp name then rename via FSA).
  const resultHandle = await reqDir.getFileHandle("request.json.result.json", { create: true });
  const resultWriter = await resultHandle.createWritable();
  await resultWriter.write(JSON.stringify({ exitCode, response }, null, 2));
  await resultWriter.close();
  log(`bridge: ${reqId} done (exitCode=${exitCode})`, exitCode === 0 ? "info" : "warn");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
