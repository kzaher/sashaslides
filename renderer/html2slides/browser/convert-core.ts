/**
 * Shared browser-side HTML→pptx conversion core.
 *
 * Used by:
 *   - main.ts           — standalone html2slides page (download flow)
 *   - insert-feature.ts — the developer page's .pptx download
 *
 * Everything here is pure browser code: it renders the input HTML into an
 * offscreen 1280×720 iframe, injects the precompiled extract-dom blob, applies
 * the post-extraction fixes the command line applies (../post-extraction.ts),
 * rasterizes the regions they mark, and hands the result to buildPptxInMemory,
 * whose post-processing is the command line's too. No network, no Node APIs.
 *
 * The only behavioural seam vs. the original main.ts is logging: the functions
 * take an explicit `LogFn` so each front-end can route lines to its own log
 * surface (the page's #log, the sidebar's #log, or the RPC bridge mirror).
 */
import { buildPptxInMemory, type Extraction, type ExtractedElement, type SlideInput } from "../convert-pptx-lib";
import { applyPostExtractionFixes, clampOversampling, rasterJobFor, type RasterJob } from "../post-extraction";

// Build-time string substitution. Every browser-bundle.ts caller replaces
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
 * Rasterize every element `rasterJobFor` marks, as the command line's
 * screenshots do: an element region via its DOM node (<img>, <canvas>, <svg>;
 * other tags log a warning and are skipped, a gap in the .pptx), an emoji glyph
 * and a text-shadow halo by drawing them on a canvas. `scale`× capture
 * (default 2) to match the Node CDP path.
 */
async function rasterizeVisuals(iframe: HTMLIFrameElement, extraction: Extraction, log: LogFn, scale: number): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  const idoc = iframe.contentDocument!;
  // `contentWindow` is typed `Window` (WindowProxy), but a same-origin iframe's
  // window also exposes the global DOM constructors (`HTMLImageElement`, …) that
  // `instanceof` checks need — those live on `typeof globalThis`.
  const iwin = iframe.contentWindow! as Window & typeof globalThis;
  for (let i = 0; i < extraction.elements.length; i++) {
    const el = extraction.elements[i];
    const job = rasterJobFor(el);
    if (job === null) continue;
    try {
      const png = await rasterizeJob(idoc, iwin, el, job, log, scale);
      if (png) out.set(i, png);
    } catch (e) {
      log(`  rasterize fail [#${i}] ${job.kind}: ${(e as Error).message}`, "warn");
    }
  }
  return out;
}

async function rasterizeJob(
  idoc: Document,
  iwin: Window & typeof globalThis,
  el: ExtractedElement,
  job: RasterJob,
  log: LogFn,
  scale: number,
): Promise<Uint8Array | null> {
  switch (job.kind) {
    case "element": {
      const tag = el.type === "visual" || el.type === "image" ? (el.tag || "").toLowerCase() : "";
      return await rasterizeElement(idoc, iwin, el, tag, log, scale);
    }
    case "emoji": return await canvasPng(drawEmoji(idoc, el, job.text, scale));
    case "text-glow": {
      const canvas = drawTextGlow(idoc, iwin, el.bounds, job.glowId, scale);
      if (canvas === null) {
        log(`  no DOM node for text glow #${job.glowId}`, "warn");
        return null;
      }
      return await canvasPng(canvas);
    }
    case "baked-table":
      // The product converts with tablesFormat "native" only; baking a table
      // needs a page screenshot, which only the command line can take.
      log(`  baked tables are not supported in the browser — skipping`, "warn");
      return null;
    default: {
      const unhandled: never = job;
      throw new Error(`unhandled raster job ${JSON.stringify(unhandled)}`);
    }
  }
}

async function rasterizeElement(
  idoc: Document,
  iwin: Window & typeof globalThis,
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
  log(`  raster <${tag}> bounds=${Math.round(b.w)}×${Math.round(b.h)}px scale=${scale}× → canvas ${W}×${H}px`);
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
    const cloned = svgEl.cloneNode(true) as SVGElement;
    // An SVG is VECTOR — rasterise it at the FULL oversampled size (W×H), not its
    // CSS size. If we keep the element's own width/height (e.g. 1280×720) the
    // browser renders the vector at that size and ctx.drawImage(...,W,H) then
    // *bitmap-upscales* it → blurry. So preserve a viewBox (the vector coordinate
    // space) and set width/height to W/H so the <img> renders the vector crisp at
    // the target resolution and drawImage is a 1:1 copy.
    if (!cloned.getAttribute("viewBox")) {
      const iw = parseFloat(cloned.getAttribute("width") || "") || b.w;
      const ih = parseFloat(cloned.getAttribute("height") || "") || b.h;
      cloned.setAttribute("viewBox", `0 0 ${iw} ${ih}`);
    }
    log(`    svg src attrs width=${svgEl.getAttribute("width")} height=${svgEl.getAttribute("height")} viewBox=${svgEl.getAttribute("viewBox")} → re-set to ${W}×${H}`);
    cloned.setAttribute("width", String(W));
    cloned.setAttribute("height", String(H));
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
    // naturalWidth/Height is the resolution the browser actually rasterised the
    // SVG at — if this is NOT W×H, the width/height override didn't take and the
    // image will be blurry (drawImage would upscale).
    log(`    svg <img> natural ${tmp.naturalWidth}×${tmp.naturalHeight} (want ${W}×${H})${tmp.naturalWidth !== W ? " ⚠ MISMATCH — blurry" : " ✓"}`);
    ctx.drawImage(tmp, 0, 0, W, H);
    URL.revokeObjectURL(url);
  } else {
    log(`  unsupported visual tag <${tag}> — skipping`, "warn");
    return null;
  }

  return await canvasPng(canvas);
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * An emoji glyph centred in its glyph box (post-extraction.ts sized the box),
 * on transparency. The canvas belongs to the iframe document so its web fonts
 * apply; the browser falls back to its emoji font per glyph, as the page did.
 */
function drawEmoji(idoc: Document, el: ExtractedElement, text: string, scale: number): HTMLCanvasElement {
  const b = el.bounds;
  const canvas = scaledCanvas(idoc, b, scale);
  const ctx = canvas.getContext("2d")!; // a fresh canvas always has a 2d context
  const style = el.style;
  const family = style?.fontFamily ? `${JSON.stringify(style.fontFamily)}, sans-serif` : "sans-serif";
  ctx.font = `${style?.fontStyle === "italic" ? "italic " : ""}${style?.fontWeight || "normal"} ${style?.fontSize || 20}px ${family}`;
  ctx.fillStyle = style?.color || "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.trim(), b.w / 2, b.h / 2);
  return canvas;
}

/**
 * The halo of a glowing text-shadow ALONE, as the command line captures it:
 * every glyph of the `data-h2s-glow` element and its descendants is drawn far
 * outside the canvas and only its shadow, offset back over the glyph's real
 * position, lands on the transparent canvas. Every text-shadow layer is drawn
 * (back to front, as CSS paints them); the native text paints on top in Slides.
 * Null when the tagged node is gone.
 */
function drawTextGlow(
  idoc: Document,
  iwin: Window & typeof globalThis,
  b: { x: number; y: number; w: number; h: number },
  glowId: number,
  scale: number,
): HTMLCanvasElement | null {
  const host = idoc.querySelector(`[data-h2s-glow="${glowId}"]`);
  if (!host) return null;
  const canvas = scaledCanvas(idoc, b, scale);
  const ctx = canvas.getContext("2d")!; // a fresh canvas always has a 2d context
  // Glyphs sit this far to the left of their halo, so none of them is on the canvas.
  const away = b.x + b.w + 1000;
  const walker = idoc.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const range = idoc.createRange();
  for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
    const parent = t.parentElement;
    const data = t.textContent ?? "";
    if (parent === null || data.trim() === "") continue;
    const cs = iwin.getComputedStyle(parent);
    const layers = textShadowLayers(cs.textShadow);
    if (layers.length === 0) continue;
    ctx.font = cs.font;
    let offset = 0;
    for (const ch of data) {
      const start = offset;
      offset += ch.length;
      if (ch.trim() === "") continue;
      range.setStart(t, start);
      range.setEnd(t, offset);
      const r = range.getClientRects()[0];
      if (r === undefined || r.width === 0) continue;
      const glyph = cs.textTransform === "uppercase" ? ch.toUpperCase()
        : cs.textTransform === "lowercase" ? ch.toLowerCase() : ch;
      const baseline = r.top + ctx.measureText(glyph).fontBoundingBoxAscent;
      for (let li = layers.length - 1; li >= 0; li--) {
        const layer = layers[li];
        ctx.shadowColor = layer.color;
        // Canvas shadow offsets and blur are in device pixels, outside the transform.
        ctx.shadowBlur = layer.blur * scale;
        ctx.shadowOffsetX = (away + layer.x) * scale;
        ctx.shadowOffsetY = layer.y * scale;
        ctx.fillStyle = "#000";
        ctx.fillText(glyph, r.left - away - b.x, baseline - b.y);
      }
    }
  }
  return canvas;
}

/** A transparent canvas covering `b` at `scale`×, in CSS-pixel coordinates relative to `b`. */
function scaledCanvas(idoc: Document, b: { w: number; h: number }, scale: number): HTMLCanvasElement {
  const canvas = idoc.createElement("canvas");
  canvas.width = Math.max(1, Math.round(b.w * scale));
  canvas.height = Math.max(1, Math.round(b.h * scale));
  canvas.getContext("2d")!.scale(scale, scale); // a fresh canvas always has a 2d context
  return canvas;
}

/** The layers of a computed `text-shadow` ("rgba(…) 0px 0px 20px, …"); empty for "none". */
function textShadowLayers(textShadow: string): readonly Readonly<{ color: string; x: number; y: number; blur: number }>[] {
  if (!textShadow || textShadow === "none") return [];
  const colorRe = /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/;
  return textShadow.split(/,(?![^(]*\))/).flatMap((layer) => {
    const color = layer.match(colorRe)?.[0];
    if (color === undefined) return [];
    const [x = 0, y = 0, blur = 0] = layer.replace(colorRe, "").trim().split(/\s+/).map((v) => parseFloat(v) || 0);
    return [{ color, x, y, blur }];
  });
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
  log(`  oversampling requested=${oversampling} → clamped scale=${scale}× (slide canvas ${SLIDE_W}×${SLIDE_H}, full-slide visual would be ${SLIDE_W * scale}×${SLIDE_H * scale}px)`);
  const html = await file.text();
  const iframe = await loadIntoIframe(html);
  try {
    const raw = runExtractInIframe(iframe);
    if (!raw || !raw.elements) {
      throw new Error("extraction returned no elements");
    }
    // The command line's post-extraction fixes; the product always emits native tables.
    const extraction = applyPostExtractionFixes(raw, { tablesFormat: "native" });
    log(`  ${file.name}: ${extraction.elements.length} elements`);
    const visualPngs = await rasterizeVisuals(iframe, extraction, log, scale);
    log(`  ${file.name}: rasterized ${visualPngs.size} visuals`);
    return { extraction, visualPngs, name: file.name };
  } finally {
    iframe.remove();
  }
}
