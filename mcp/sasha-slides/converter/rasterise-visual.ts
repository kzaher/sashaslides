/**
 * rasterise-visual.ts — pictures of the `visual` elements, drawn from the live staged document.
 *
 * The extractor marks what no native Slides element can express as `visual` (extract-dom.ts):
 * `<svg>`, `<canvas>`, conic-gradient and clip-path hosts (`css-effect`), rounded clipping
 * containers (`clipped-container`) and glowing text (`text-glow`). Only a bitmap carries those, so
 * after extraction, while the staged iframe is still alive, each one is drawn into a PNG at
 * `RASTER_SCALE` times its box and handed to the pure emitter (emit-shape.ts `emitVisual`), which
 * places it like any `<img>`.
 *
 * HOW EACH IS DRAWN (ported from renderer/html2slides/browser/convert-core.ts rasterizeElement):
 *   - `<canvas>`: its own pixels, `toDataURL`.
 *   - `<svg>`: serialised standalone, with the presentation properties the page's style sheets
 *     gave it inlined (a standalone SVG has no style sheet), re-sized to the oversampled box so
 *     the vector is drawn crisp rather than up-scaled, then drawn through an `<img>` onto a canvas.
 *   - the CSS hosts: the element is cloned with every computed property inlined (and its
 *     `::before`/`::after` made real), wrapped in an SVG `<foreignObject>`, and drawn the same way.
 *     The old browser core skipped these; the command line took screenshots, which a page cannot.
 *
 * MEASURED (headless Chrome 155, 2026-10-17): an SVG `<img>` holding a `<foreignObject>` TAINTS the
 * canvas when loaded from a `blob:` address (`toDataURL` throws "Tainted canvases may not be
 * exported") and does NOT when loaded from a `data:` address. Plain SVG is clean either way. So
 * every picture here travels as a `data:` address.
 *
 * What a picture loses: an SVG drawn as an image cannot load anything external, so a remote
 * `<img>`/`<image>`/`url()` inside a visual and web fonts are not drawn (local fonts are).
 */
import type { BoundsPx, ParsedExtraction, SlideElement, VisualElement } from "./extraction.js";
import type { VisualRaster } from "./emit-shape.js";
import { SLIDES_MAX_IMAGE_BYTES } from "./slide-image.js";
import { assertNever } from "../engine/src/contracts/assert-never.js";

/** Oversampling: Slides scales a picture up on a large screen, and 1x is visibly soft there. */
export const RASTER_SCALE = 2;

/** Every visual on the slide, drawn; keyed by `paintIndex` as `emitSlideRequests` expects. */
export async function rasteriseVisuals(
  options: Readonly<{
    /** The staged slide document the extraction was taken from. */
    stagedDocument: Document;
    /** Where the drawing canvases and images are created (the host page). */
    hostDocument: Document;
    extraction: ParsedExtraction;
    /** Per-picture load budget; a data address decodes in milliseconds, so this is a stall guard. */
    budgetMs: number;
  }>,
): Promise<ReadonlyMap<number, VisualRaster>> {
  const rasters = new Map<number, VisualRaster>();
  for (const candidate of options.extraction.elements) {
    const element = visualOf(candidate);
    if (element === null) continue;
    rasters.set(element.paintIndex, await rasteriseVisual({ ...options, element }));
  }
  return rasters;
}

function visualOf(element: SlideElement): VisualElement | null {
  switch (element.kind) {
    case "visual":
      return element;
    case "rect":
    case "text":
    case "list":
    case "table":
    case "image":
    case "line":
    case "triangle":
    case "poly":
    case "ignored":
      return null;
    default:
      return assertNever(element);
  }
}

/** One visual; never throws, a failure is a `failed` raster with the reason. */
export async function rasteriseVisual(
  options: Readonly<{ stagedDocument: Document; hostDocument: Document; element: VisualElement; budgetMs: number }>,
): Promise<VisualRaster> {
  const { element } = options;
  const node = findVisualNode({ document: options.stagedDocument, element });
  if (node === null) return { kind: "failed", reason: `the <${element.tag}> was not found in the page` };
  try {
    return await drawWithinBudget({ ...options, node });
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The DOM node the extractor turned into this visual. The extraction carries no node reference,
 * so the node is found again by what the extractor left on it: its tag and box, the
 * `data-h2s-hide-text` mark on a CSS host, or the `data-h2s-glow` stamp on glowing text.
 */
export function findVisualNode(options: Readonly<{ document: Document; element: VisualElement }>): Element | null {
  const { document, element } = options;
  const source = visualSourceOf(element.tag);
  switch (source) {
    case "svg":
      return closestByBox({ candidates: document.querySelectorAll("svg"), bounds: element.bounds, partialHeight: false });
    case "canvas":
      return closestByBox({ candidates: document.querySelectorAll("canvas"), bounds: element.bounds, partialHeight: false });
    case "css-host":
      return closestByBox({ candidates: document.querySelectorAll("[data-h2s-hide-text]"), bounds: element.bounds, partialHeight: false });
    case "clipped-host":
      // The extractor may capture only the top strip of the container (extract-dom.ts
      // "Rasterise ONLY the top black area"): same left, top and width, a shorter height.
      return closestByBox({ candidates: document.querySelectorAll("[data-h2s-hide-text]"), bounds: element.bounds, partialHeight: true });
    case "glow":
      return element.glowId === null ? null : document.querySelector(`[data-h2s-glow="${element.glowId}"]`);
    case "unknown":
      return null;
    default:
      return assertNever(source);
  }
}

/** Resolves on load, rejects on an error or at the budget (the picture never decoded). */
export function loadImage(options: Readonly<{ image: HTMLImageElement; src: string; budgetMs: number }>): Promise<void> {
  const { image, src, budgetMs } = options;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error(`the picture did not decode within ${budgetMs} ms`));
    }, budgetMs);
    const cleanUp = (): void => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
    };
    image.onload = (): void => {
      cleanUp();
      resolve();
    };
    image.onerror = (): void => {
      cleanUp();
      reject(new Error("the browser could not decode the drawing"));
    };
    image.src = src;
  });
}

type VisualSource = "svg" | "canvas" | "css-host" | "clipped-host" | "glow" | "unknown";

/** The extractor's tag vocabulary is an open string; anything new is `unknown` and reported. */
function visualSourceOf(tag: string): VisualSource {
  switch (tag) {
    case "svg":
      return "svg";
    case "canvas":
      return "canvas";
    case "css-effect":
      return "css-host";
    case "clipped-container":
      return "clipped-host";
    case "text-glow":
      return "glow";
    default:
      return "unknown";
  }
}

/** Pixels of slack between the extractor's rounded box and the live one (convert-core.ts findNodeAt). */
const BOX_TOLERANCE_PX = 2;

function closestByBox(
  options: Readonly<{ candidates: ArrayLike<Element>; bounds: BoundsPx; partialHeight: boolean }>,
): Element | null {
  const { bounds } = options;
  let best: Element | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < options.candidates.length; index++) {
    const candidate = options.candidates[index];
    if (candidate === undefined) continue;
    const box = candidate.getBoundingClientRect();
    if (Math.abs(box.width - bounds.w) > BOX_TOLERANCE_PX) continue;
    const heightFits = options.partialHeight
      ? box.height >= bounds.h - BOX_TOLERANCE_PX
      : Math.abs(box.height - bounds.h) <= BOX_TOLERANCE_PX;
    if (!heightFits) continue;
    const distance = Math.hypot(box.left - bounds.x, box.top - bounds.y);
    if (distance > BOX_TOLERANCE_PX * 2 || distance >= bestDistance) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

/**
 * Draw at `RASTER_SCALE`, halving the scale while the PNG is past what `createImage` accepts.
 * A canvas is copied at its own resolution, so its size cannot be traded down this way.
 */
async function drawWithinBudget(
  options: Readonly<{ hostDocument: Document; element: VisualElement; node: Element; budgetMs: number }>,
): Promise<VisualRaster> {
  for (let scale = initialScale(options.element); scale >= MINIMUM_SCALE; scale /= 2) {
    const pngDataUrl = await drawOnce({ ...options, scale });
    if (dataUrlBytes(pngDataUrl) <= SLIDES_MAX_IMAGE_BYTES) return { kind: "drawn", pngDataUrl };
    if (isCanvas(options.node)) break;
  }
  return { kind: "failed", reason: `the picture is larger than the ${Math.round(SLIDES_MAX_IMAGE_BYTES / (1024 * 1024))}MB Slides accepts` };
}

const MINIMUM_SCALE = 0.5;
/** Chrome's canvas limits sit far above this; past it the PNG is slow to encode and to stage. */
const MAXIMUM_EDGE_PX = 8192;
const MAXIMUM_AREA_PX = 32 * 1024 * 1024;

function initialScale(element: VisualElement): number {
  const box = drawnBox(element);
  const edge = Math.max(box.w, box.h, 1);
  const area = Math.max(box.w * box.h, 1);
  return Math.min(RASTER_SCALE, MAXIMUM_EDGE_PX / edge, Math.sqrt(MAXIMUM_AREA_PX / area));
}

/**
 * The box the picture covers, in CSS pixels. A rotated element is drawn UNROTATED at its own
 * layout size and placed with the rotation (emit-shape.ts placeElement does the same choice), so
 * the picture is not its rotated bounding box.
 */
function drawnBox(element: VisualElement): Readonly<{ w: number; h: number }> {
  if (Math.abs(element.rotateDeg) >= 0.01 && element.naturalSizePx !== null) return element.naturalSizePx;
  return { w: element.bounds.w, h: element.bounds.h };
}

function isRotated(element: VisualElement): boolean {
  return Math.abs(element.rotateDeg) >= 0.01 && element.naturalSizePx !== null;
}

async function drawOnce(
  options: Readonly<{ hostDocument: Document; element: VisualElement; node: Element; budgetMs: number; scale: number }>,
): Promise<string> {
  const { node, element, scale } = options;
  if (isCanvas(node)) return copyCanvas(node);
  const box = drawnBox(element);
  const width = Math.max(1, Math.round(box.w * scale));
  const height = Math.max(1, Math.round(box.h * scale));
  const svgText = isOutermostSvg(node)
    ? standaloneSvg({ svg: node, width, height, box })
    : foreignObjectSvg({ node, element, width, height, glow: visualSourceOf(element.tag) === "glow" });
  return await svgToPng({ hostDocument: options.hostDocument, svgText, width, height, budgetMs: options.budgetMs });
}

function isCanvas(node: Element): node is HTMLCanvasElement {
  return node.localName === "canvas" && node.namespaceURI === XHTML_NAMESPACE;
}

function isOutermostSvg(node: Element): node is SVGSVGElement {
  return node.localName === "svg" && node.namespaceURI === SVG_NAMESPACE;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** A canvas that drew cross-origin pixels throws here, which becomes the failure's reason. */
function copyCanvas(canvas: HTMLCanvasElement): string {
  if (canvas.width === 0 || canvas.height === 0) throw new Error("the canvas is empty (0 pixels)");
  return canvas.toDataURL("image/png");
}

/**
 * An inline `<svg>` as a standalone document at the oversampled size. Without a `viewBox` the
 * drawing's coordinates are CSS pixels of its box, so one is added; the size goes on the
 * attributes AND the inline style, because a `style="width:…"` copied from the page would
 * otherwise win and the browser would draw the vector small and scale the bitmap up.
 */
function standaloneSvg(
  options: Readonly<{ svg: SVGSVGElement; width: number; height: number; box: Readonly<{ w: number; h: number }> }>,
): string {
  const { svg, width, height, box } = options;
  // SAFETY: cloneNode(true) of an <svg> element returns an <svg> element.
  const copy = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles({ source: svg, copy, glow: false });
  if (!copy.hasAttribute("viewBox")) {
    const intrinsicWidth = Number.parseFloat(svg.getAttribute("width") ?? "") || box.w;
    const intrinsicHeight = Number.parseFloat(svg.getAttribute("height") ?? "") || box.h;
    copy.setAttribute("viewBox", `0 0 ${intrinsicWidth} ${intrinsicHeight}`);
  }
  copy.setAttribute("xmlns", SVG_NAMESPACE);
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  for (const property of ["width", "height"] as const) copy.style.setProperty(property, `${property === "width" ? width : height}px`);
  for (const property of ["position", "left", "top", "right", "bottom", "margin", "transform"]) copy.style.removeProperty(property);
  return new XMLSerializer().serializeToString(copy);
}

/**
 * Any element, as an SVG whose `<foreignObject>` holds a self-styled clone of it. The region is
 * the visual's own box (which for a clipped container may be only its top strip, and for glowing
 * text extends past the element by the blur); the clone sits at its offset inside it.
 */
function foreignObjectSvg(
  options: Readonly<{ node: Element; element: VisualElement; width: number; height: number; glow: boolean }>,
): string {
  const { node, element, width, height, glow } = options;
  const document = node.ownerDocument;
  const box = drawnBox(element);
  const live = node.getBoundingClientRect();
  const offsetX = isRotated(element) ? 0 : live.left - element.bounds.x;
  const offsetY = isRotated(element) ? 0 : live.top - element.bounds.y;
  // SAFETY: cloneNode(true) of an Element returns an Element of the same kind.
  const copy = node.cloneNode(true) as Element;
  inlineStyles({ source: node, copy, glow });
  const rootStyle = styleOf(copy);
  if (rootStyle !== null) {
    rootStyle.setProperty("position", "absolute");
    rootStyle.setProperty("left", `${offsetX}px`);
    rootStyle.setProperty("top", `${offsetY}px`);
    rootStyle.setProperty("right", "auto");
    rootStyle.setProperty("bottom", "auto");
    rootStyle.setProperty("margin", "0");
    rootStyle.setProperty("transform", "none");
    if (isRotated(element)) {
      rootStyle.setProperty("width", `${box.w}px`);
      rootStyle.setProperty("height", `${box.h}px`);
    }
  }
  const frame = document.createElementNS(XHTML_NAMESPACE, "div");
  frame.setAttribute("style", `position:relative;margin:0;padding:0;border:0;overflow:hidden;width:${box.w}px;height:${box.h}px`);
  frame.appendChild(copy);
  const foreign = document.createElementNS(SVG_NAMESPACE, "foreignObject");
  foreign.setAttribute("x", "0");
  foreign.setAttribute("y", "0");
  foreign.setAttribute("width", String(box.w));
  foreign.setAttribute("height", String(box.h));
  foreign.appendChild(frame);
  const root = document.createElementNS(SVG_NAMESPACE, "svg");
  root.setAttribute("xmlns", SVG_NAMESPACE);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("viewBox", `0 0 ${box.w} ${box.h}`);
  root.appendChild(foreign);
  return new XMLSerializer().serializeToString(root);
}

/**
 * Walk the original and its clone in step and copy what the page's style sheets decided onto the
 * clone, which will be drawn with no style sheet at all. HTML elements get every computed
 * property; SVG elements only their presentation properties, because computed geometry
 * (`width`, `x`, `transform`, …) on SVG shapes would fight their attributes. Scripts are dropped.
 *
 * `glow` draws glowing text's halo alone (the text itself stays a native, editable text box):
 * every glyph, background and border is made transparent and only `text-shadow` is left to paint.
 */
function inlineStyles(options: Readonly<{ source: Element; copy: Element; glow: boolean }>): void {
  const { source, copy, glow } = options;
  const view = source.ownerDocument.defaultView;
  if (view === null) throw new Error("the staged document has no window to compute styles in");
  const pending: { source: Element; copy: Element }[] = [{ source, copy }];
  let visited = 0;
  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) break;
    visited++;
    if (visited > MAXIMUM_STYLED_ELEMENTS) throw new Error(`the visual has more than ${MAXIMUM_STYLED_ELEMENTS} elements`);
    const sourceChildren = Array.from(pair.source.children);
    const copyChildren = Array.from(pair.copy.children);
    for (let index = 0; index < copyChildren.length; index++) {
      const copyChild = copyChildren[index];
      const sourceChild = sourceChildren[index];
      if (copyChild === undefined || sourceChild === undefined) continue;
      if (copyChild.localName === "script") {
        copyChild.remove();
        continue;
      }
      pending.push({ source: sourceChild, copy: copyChild });
    }
    styleOne({ view, source: pair.source, copy: pair.copy, glow });
  }
}

/** A visual is a picture, not a page: past this many elements it is refused rather than slow. */
const MAXIMUM_STYLED_ELEMENTS = 5000;

function styleOne(options: Readonly<{ view: Window; source: Element; copy: Element; glow: boolean }>): void {
  const { view, source, copy, glow } = options;
  const target = styleOf(copy);
  if (target === null) return;
  const computed = view.getComputedStyle(source);
  if (source.namespaceURI === SVG_NAMESPACE) {
    for (const property of SVG_PRESENTATION_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value.length > 0) target.setProperty(property, value);
    }
  } else {
    copyAllProperties({ from: computed, to: target });
    materialisePseudoElements({ view, source, copy });
  }
  if (glow) hideAllButTextShadow(target);
}

function copyAllProperties(options: Readonly<{ from: CSSStyleDeclaration; to: CSSStyleDeclaration }>): void {
  const { from, to } = options;
  for (let index = 0; index < from.length; index++) {
    const property = from.item(index);
    // `content` on a real element would replace its children in Chrome; it only means something
    // on the pseudo-elements, which are materialised separately.
    if (property === "content") continue;
    to.setProperty(property, from.getPropertyValue(property));
  }
}

/** `::before` / `::after` do not survive cloning; each becomes a real `<span>` with its style. */
function materialisePseudoElements(options: Readonly<{ view: Window; source: Element; copy: Element }>): void {
  const { view, source, copy } = options;
  for (const pseudo of ["::before", "::after"] as const) {
    const computed = view.getComputedStyle(source, pseudo);
    const content = computed.getPropertyValue("content");
    if (content === "none" || content === "normal" || content.length === 0) continue;
    const span = copy.ownerDocument.createElementNS(XHTML_NAMESPACE, "span");
    // SAFETY: an element created in the XHTML namespace is an HTMLElement.
    copyAllProperties({ from: computed, to: (span as HTMLElement).style });
    span.textContent = pseudoText(content);
    if (pseudo === "::before") copy.insertBefore(span, copy.firstChild);
    else copy.appendChild(span);
  }
}

/** The text of a quoted `content` value; counters, `attr()` and images draw nothing here. */
function pseudoText(content: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(content.trim());
  if (quoted === null || quoted[1] === undefined) return "";
  return quoted[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/\\(.)/g, "$1");
}

function hideAllButTextShadow(style: CSSStyleDeclaration): void {
  style.setProperty("color", "transparent");
  style.setProperty("-webkit-text-fill-color", "transparent");
  style.setProperty("text-decoration-color", "transparent");
  style.setProperty("background", "transparent");
  style.setProperty("border-color", "transparent");
  style.setProperty("box-shadow", "none");
  style.setProperty("outline", "none");
}

/** The style declaration of an HTML or SVG element; null for anything else (MathML, unknown). */
function styleOf(element: Element): CSSStyleDeclaration | null {
  const candidate = (element as Element & { style?: unknown }).style;
  // SAFETY: HTMLElement and SVGElement both expose `style` as a CSSStyleDeclaration; the guard
  // above leaves only those (an element without a style object reads undefined).
  return typeof candidate === "object" && candidate !== null ? (candidate as CSSStyleDeclaration) : null;
}

/**
 * The SVG properties a style sheet commonly sets (SVG 2 "presentation attributes" plus text and
 * paint order). Copied as computed, so a value inherited from the page (a font on `<body>`) is
 * kept when the `<svg>` is drawn alone.
 */
const SVG_PRESENTATION_PROPERTIES: readonly string[] = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "color",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "text-decoration",
  "white-space",
  "stop-color",
  "stop-opacity",
  "flood-color",
  "flood-opacity",
  "lighting-color",
  "marker-start",
  "marker-mid",
  "marker-end",
  "paint-order",
  "vector-effect",
  "shape-rendering",
  "mix-blend-mode",
];

/**
 * Draw an SVG document onto a canvas and read the PNG back. A `data:` address, never `blob:`:
 * measured, a `<foreignObject>` from a `blob:` address taints the canvas (see the header).
 */
async function svgToPng(
  options: Readonly<{ hostDocument: Document; svgText: string; width: number; height: number; budgetMs: number }>,
): Promise<string> {
  const { hostDocument, width, height } = options;
  const image = hostDocument.createElement("img");
  await loadImage({ image, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(options.svgText)}`, budgetMs: options.budgetMs });
  const canvas = hostDocument.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("the browser gave no 2D canvas context");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

/** Decoded size of a base64 `data:` address, from its length (no decode). */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma < 0 ? dataUrl : dataUrl.slice(comma + 1);
  return Math.floor((payload.length * 3) / 4);
}
