/**
 * Shared browser-side HTML→pptx conversion core.
 *
 * Used by BOTH front-ends:
 *   - main.ts          — standalone html2slides page (download flow)
 *   - addon-main.ts    — Google Slides add-on sidebar (insert-into-deck flow)
 *
 * Everything here is pure browser code: it renders the input HTML into an
 * offscreen 1280×720 iframe, injects the precompiled extract-dom blob, walks
 * the DOM, rasterizes visual elements, and hands the result to
 * buildPptxInMemory. No network, no Node APIs.
 *
 * The only behavioural seam vs. the original main.ts is logging: the functions
 * take an explicit `LogFn` so each front-end can route lines to its own log
 * surface (the page's #log, the sidebar's #log, or the RPC bridge mirror).
 */
import { buildPptxInMemory, type Extraction, type ExtractedElement, type SlideInput } from "../convert-pptx-lib";

// Build-time string substitution. Both build.ts and build-addon.ts replace
// __EXTRACT_JS_LITERAL__ with the compiled extract-dom.ts source via esbuild
// `define`. The browser path runs the compiled blob via
// `win.eval(__EXTRACT_JS_LITERAL__)` inside the iframe.
declare const __EXTRACT_JS_LITERAL__: string;

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export type Slide = { extraction: Extraction; visualPngs: Map<number, Uint8Array>; name: string };
export type LogFn = (msg: string, kind?: "info" | "warn" | "error") => void;

// Re-export so front-ends import the whole conversion surface from one module.
export { buildPptxInMemory };
export type { SlideInput };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Rasterisation oversampling factor (per-element capture scale). Clamp to
// [1,8]; default 2 (retina) so unchanged callers / the default UI value render
// byte-identically. A non-finite/missing value falls back to 2.
export function clampOversampling(n: number | undefined | null): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 2;
  return Math.min(8, Math.max(1, v));
}

export async function loadIntoIframe(html: string): Promise<HTMLIFrameElement> {
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

/**
 * Run the precompiled extract-dom blob inside the iframe and return its
 * Extraction. extract-dom is an IIFE that (a) returns the JSON string and
 * (b) stashes it on `window.__H2S_EXTRACT__` as a side effect.
 *
 * Primary path: `iframe.contentWindow.eval(blob)` — the completion value is the
 * JSON. This works on the standalone page and any normal browser.
 *
 * Fallback path: when the host CSP blocks `eval` (the Google Slides add-on
 * serves the sidebar from a sandboxed googleusercontent iframe), we inject the
 * blob as an inline <script> into the iframe's document — inline scripts run
 * synchronously on append and don't trip `unsafe-eval` — then read the global
 * the extractor set. Whichever mechanism the host permits, one of them fires.
 */
function runExtractInIframe(iframe: HTMLIFrameElement): Extraction {
  const win = iframe.contentWindow as (Window & { eval(s: string): unknown; __H2S_EXTRACT__?: string }) | null;
  const idoc = iframe.contentDocument;
  if (!win || !idoc) throw new Error("iframe contentWindow not available");

  let raw: unknown;
  try {
    raw = win.eval(__EXTRACT_JS_LITERAL__);
  } catch (evalErr) {
    // eval blocked (CSP) — inject as an inline <script> instead.
    const script = idoc.createElement("script");
    script.textContent = __EXTRACT_JS_LITERAL__;
    win.__H2S_EXTRACT__ = undefined;
    (idoc.head || idoc.documentElement).appendChild(script);
    script.remove();
    raw = win.__H2S_EXTRACT__;
    if (raw === undefined) {
      throw new Error(
        `extract-dom did not run: eval blocked (${(evalErr as Error).message}) and ` +
        `script injection produced no result (host CSP may forbid inline scripts too)`,
      );
    }
  }

  const json = typeof raw === "string" ? JSON.parse(raw) : raw;
  return json as Extraction;
}

/**
 * Rasterize visual/image elements. Walks the iframe DOM to find nodes at the
 * extracted bounds, then renders them to a PNG via canvas. Supports <img>,
 * <canvas>, <svg>. Other tags log a warning and are skipped (renders as a
 * gap in the .pptx). `scale`× capture (default 2) to match the Node CDP path.
 */
async function rasterizeVisuals(iframe: HTMLIFrameElement, extraction: Extraction, log: LogFn, scale: number): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  const idoc = iframe.contentDocument!;
  const iwin = iframe.contentWindow!;
  for (let i = 0; i < extraction.elements.length; i++) {
    const el = extraction.elements[i];
    if (el.type !== "visual" && el.type !== "image") continue;
    if (el.bounds.w <= 5 || el.bounds.h <= 5) continue;
    const tag = (el.tag || "").toLowerCase();
    try {
      const png = await rasterizeElement(idoc, iwin, el, tag, log, scale);
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
  log: LogFn,
  scale: number,
): Promise<Uint8Array | null> {
  const b = el.bounds;
  const node = findNodeAt(idoc, b, tag);
  if (!node) {
    log(`  no DOM node for visual [<${tag}> at ${b.x},${b.y} ${b.w}x${b.h}]`, "warn");
    return null;
  }

  const W = Math.max(1, Math.round(b.w * scale));
  const H = Math.max(1, Math.round(b.h * scale));
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

export async function processFile(file: File, log: LogFn, oversampling: number = 2): Promise<Slide> {
  const scale = clampOversampling(oversampling);
  const html = await file.text();
  const iframe = await loadIntoIframe(html);
  try {
    const extraction = runExtractInIframe(iframe);
    if (!extraction || !extraction.elements) {
      throw new Error("extraction returned no elements");
    }
    log(`  ${file.name}: ${extraction.elements.length} elements`);
    const visualPngs = await rasterizeVisuals(iframe, extraction, log, scale);
    log(`  ${file.name}: rasterized ${visualPngs.size} visuals`);
    return { extraction, visualPngs, name: file.name };
  } finally {
    iframe.remove();
  }
}
