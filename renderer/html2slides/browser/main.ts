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
import { buildPptxInMemory, processFile, type Slide, type SlideInput } from "./convert-core";

/** Boundary shim: showDirectoryPicker + FileSystemObserver are recent web
 * APIs that some `lib.dom.d.ts` versions ship without; declare what we use. */
interface FSDirHandlePerm { mode?: "read" | "readwrite" }
interface FSWritable {
  write(input: ArrayBufferLike | ArrayBufferView | Blob | string | { type: "write"; position?: number; data: BufferSource | Blob | string }): Promise<void>;
  close(): Promise<void>;
}
interface FSFileHandle {
  readonly kind: "file";
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

function downloadBytes(bytes: Uint8Array, name: string): void {
  // pptxgenjs/JSZip produce a Uint8Array over a real ArrayBuffer in the
  // browser; narrow the generic buffer param (default ArrayBufferLike includes
  // SharedArrayBuffer, which Blob's BufferSource rejects) at the API boundary.
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
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

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Best-effort: place the generated .pptx onto the clipboard alongside the
 * download. Browsers gate `clipboard.write` behind a secure context + transient
 * user activation, and Chrome rejects arbitrary MIME types from the "sanitized"
 * path — so we try the real MIME first, then fall back to a "web custom format"
 * (always permitted, but only readable by web apps). Any failure is logged and
 * never blocks the download that already happened.
 */
async function copyPptxToClipboard(bytes: Uint8Array, name: string): Promise<void> {
  const clip = navigator.clipboard as Clipboard | undefined;
  if (!clip || typeof ClipboardItem === "undefined") {
    log("clipboard API unavailable — copy skipped (download completed)", "warn");
    return;
  }
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: PPTX_MIME });
  try {
    await clip.write([new ClipboardItem({ [PPTX_MIME]: blob })]);
    log(`copied ${name} to clipboard`);
    return;
  } catch {
    try {
      await clip.write([new ClipboardItem({ ["web " + PPTX_MIME]: blob })]);
      log(`copied ${name} to clipboard (web custom format)`);
    } catch (e) {
      log(`clipboard copy failed (${(e as Error).message}) — download completed`, "warn");
    }
  }
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
      const s = await processFile(files[i], log);
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
  await copyPptxToClipboard(bytes, `${title}.pptx`);
  ($("#convert-btn") as HTMLButtonElement).disabled = false;
}

// --- UI wiring ---
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
  // Reset the value when the dialog is *opened*, not after `change`. Resetting
  // inside the change handler races with the programmatic `picker.click()` and
  // makes Chrome ignore the first selection after a convert+clear — you had to
  // open the file dialog twice for it to register. The input's own `click`
  // fires right before the dialog opens, so re-selecting the same file always
  // emits a fresh `change`.
  picker.addEventListener("click", () => { picker.value = ""; });
  picker.addEventListener("change", () => {
    if (picker.files) addFiles(picker.files);
  });

  // Ctrl+V / Cmd+V: paste HTML straight into the queue (no file needed). Also
  // accepts an .html/.htm file pasted from the OS file manager. Skips when the
  // paste targets a real form field so normal editing still works.
  document.addEventListener("paste", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    const dt = e.clipboardData;
    if (!dt) return;

    // 1. A file copied in the OS (e.g. slide_01.html) lands in clipboardData.files.
    const pastedFiles = Array.from(dt.files || []).filter((f) => /\.html?$/i.test(f.name));
    if (pastedFiles.length) {
      e.preventDefault();
      addFiles(pastedFiles);
      log(`pasted ${pastedFiles.length} file(s): ${pastedFiles.map((f) => f.name).join(", ")}`);
      return;
    }

    // 2. Raw HTML/text content — wrap it as a synthetic .html file.
    const html = dt.getData("text/html");
    const text = dt.getData("text/plain");
    const content = (html || text || "").trim();
    if (!content) return;
    e.preventDefault();
    const name = `pasted_${String(++pasteCounter).padStart(2, "0")}.html`;
    addFiles([new File([html || text], name, { type: "text/html" })]);
    log(`pasted ${html ? "HTML" : "text"} content as ${name} (${content.length} chars)`);
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
      slides.push(await processFile(files[i], log));
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
