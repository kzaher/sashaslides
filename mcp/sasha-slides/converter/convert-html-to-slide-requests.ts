/**
 * convert-html-to-slide-requests.ts — the public entry point.
 *
 * Runs in a browser content-script context: no Node builtins, no filesystem, no
 * network. One slide HTML document in, one `presentations.batchUpdate` body
 * out, plus the list of things the HTML asked for that Slides cannot express.
 *
 * Why this is fast enough to replace the pptx path. The old route was
 * HTML -> pptx -> Drive upload -> `File > Import slides`, about 20 s, dominated
 * by two network round-trips and Google's own pptx import. Here the only
 * network call is the single `batchUpdate` the caller makes with the result;
 * everything in this module is local DOM work.
 *
 * The staging iframe is the one piece of machinery worth explaining. A content
 * script cannot write the slide HTML into the host page (it would wreck the
 * Slides editor), and the extractor needs real layout — `getComputedStyle` and
 * `getBoundingClientRect` — so the HTML is laid out in an offscreen 1280x720
 * same-origin iframe, measured, and thrown away.
 *
 * Two things happen in that iframe besides measuring. BEFORE it, a pending draw.io placeholder
 * (drawio-diagram.ts drawioCandidateHtml) is drawn by the host's `renderDrawio` and its picture put
 * in place, so the extractor pairs it with the page's `#drawio-source`. AFTER it, every `visual`
 * the extractor found (`<svg>`, `<canvas>`, CSS effects) is drawn into a PNG from the live DOM
 * (rasterise-visual.ts), and the pure emitter places those pictures.
 */
import { parseExtraction } from "./extraction.js";
import type { BoundsPx, ParsedExtraction, SizePx } from "./extraction.js";
import type { SlidePageSizeEmu, TextInsetEmu } from "./geometry.js";
import { emitSlideRequests } from "./emit-requests.js";
import type { ConversionResult, ConvertedDiagram } from "./emit-requests.js";
import type { DrawioRender } from "./drawio-embed.js";
import { DRAWIO_RENDER_TIMEOUT_MILLISECONDS } from "./drawio-embed.js";
import {
  DRAWIO_PENDING_ATTRIBUTE,
  DRAWIO_PENDING_VALUE,
  DRAWIO_RENDER_ATTRIBUTE,
  DRAWIO_SOURCE_ELEMENT_ID,
  DRAWIO_SOURCE_SCRIPT_TYPE,
  parseDrawioSource,
} from "./drawio-diagram.js";
import { featureSite } from "./emit-context.js";
import { loadImage, rasteriseVisuals } from "./rasterise-visual.js";
import type { UnsupportedFeature } from "./unsupported-feature.js";
import { assertNever } from "../engine/src/contracts/assert-never.js";

export type ConvertHtmlOptions = Readonly<{
  /** A full self-contained 1280x720 slide document, per PROTOCOL.md. */
  html: string;
  /** Echoed back on the result so the caller can call batchUpdate directly. */
  presentationId: string;
  /** The slide to add elements to. */
  pageObjectId: string;
  /**
   * The compiled `renderer/html2slides/extract-dom.ts` blob — an IIFE that
   * returns its JSON and also stashes it on `window.__H2S_EXTRACT__`.
   *
   * Injected rather than imported for two reasons: the extractor is a script,
   * not a module (it has no `export`, see extract-dom.ts:448), and the
   * extension's bundler is the thing that knows how to inline it. Keeping it a
   * parameter is also what lets the tests feed a freshly compiled copy.
   */
  extractorScript: string;
  /** Where to park the staging iframe; normally `document.body`. */
  container: HTMLElement;
  /** Unique per conversion within the presentation; the proposal id suits. */
  objectIdPrefix: string;
  pageSizeEmu?: SlidePageSizeEmu;
  textInsetEmu?: TextInsetEmu;
  /** Defaults to the 1280x720 of PROTOCOL.md. */
  slidePx?: SizePx;
  /**
   * How long to wait for fonts and images before measuring anyway. Short on
   * purpose: a slide that has not settled in a second is better extracted
   * imperfectly (and reported) than blocking the picker.
   */
  settleBudgetMs?: number;
  /**
   * Draws a draw.io source that has no picture yet (a `[data-drawio-render="pending"]` placeholder,
   * drawio-diagram.ts drawioCandidateHtml) before the page is measured. Hosts pass
   * `({ xml }) => renderDrawioPicture({ document, editorOrigin, xml })` (drawio-embed.ts); without
   * it a pending placeholder is reported and left empty.
   */
  renderDrawio?: (options: Readonly<{ xml: string }>) => Promise<DrawioRender>;
}>;

/** Declared with the emitter, which produces it; re-exported here where the result is. */
export type { ConvertedDiagram };

export type HtmlConversionResult = ConversionResult &
  Readonly<{
    presentationId: string;
    pageObjectId: string;
    /** Extractor entries with unusable geometry; non-zero means investigate. */
    malformedCount: number;
    /** Empty for every slide without a draw.io source. */
    drawioDiagrams: readonly ConvertedDiagram[];
  }>;

export async function convertHtmlToSlideRequests(
  options: ConvertHtmlOptions,
): Promise<HtmlConversionResult> {
  const staged = await withStagedSlide({
    ...options,
    work: async (iframe) => {
      const stagedDocument = stagedDocumentOf(iframe);
      const undrawnDiagrams = await drawPendingDiagrams({
        document: stagedDocument,
        renderDrawio: options.renderDrawio ?? null,
        budgetMs: options.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS,
      });
      if (undrawnDiagrams.drewPicture) await settle({ iframe, budgetMs: options.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS });
      const extraction = parseExtraction(runExtractor({ iframe, extractorScript: options.extractorScript }));
      const visualRasters = await rasteriseVisuals({
        stagedDocument,
        hostDocument: options.container.ownerDocument,
        extraction,
        budgetMs: RASTER_LOAD_BUDGET_MS,
      });
      return { extraction, visualRasters, undrawn: undrawnDiagrams.undrawn };
    },
  });
  const { extraction } = staged;
  const emitted = emitSlideRequests({
    extraction,
    pageObjectId: options.pageObjectId,
    objectIdPrefix: options.objectIdPrefix,
    ...(options.pageSizeEmu === undefined ? {} : { pageSizeEmu: options.pageSizeEmu }),
    ...(options.textInsetEmu === undefined ? {} : { textInsetEmu: options.textInsetEmu }),
    visualRasters: staged.visualRasters,
  });
  const undrawnReports: readonly UnsupportedFeature[] = staged.undrawn.map((undrawn) => ({
    ...featureSite({ bounds: undrawn.bounds, viewportPx: extraction.viewportPx, elementType: "drawio", domIndex: null }),
    kind: "drawio-not-rendered",
    fallback: "omitted",
    reason: undrawn.reason,
  }));
  return {
    ...emitted,
    unsupported: [...emitted.unsupported, ...undrawnReports],
    presentationId: options.presentationId,
    pageObjectId: options.pageObjectId,
    malformedCount: extraction.malformedCount,
  };
}

/**
 * Lay the HTML out offscreen and measure it. Separate from the emission stage
 * so a caller that already has an extraction (a test, or a batch converting
 * several slides from one staged iframe) can skip straight to
 * `emitSlideRequests`.
 */
export async function extractSlideLayout(
  options: Readonly<{
    html: string;
    extractorScript: string;
    container: HTMLElement;
    slidePx?: SizePx;
    settleBudgetMs?: number;
  }>,
): Promise<ParsedExtraction> {
  return await withStagedSlide({
    ...options,
    work: (iframe) => Promise.resolve(parseExtraction(runExtractor({ iframe, extractorScript: options.extractorScript }))),
  });
}

const DEFAULT_SLIDE_PX: SizePx = { w: 1280, h: 720 };

/** A picture drawn from a `data:` address decodes in milliseconds; past this it is stuck. */
const RASTER_LOAD_BUDGET_MS = 3000;

/** The draw.io renderer has its own deadline; this only guards a host renderer that never settles. */
const DRAWIO_RENDER_GUARD_MS = DRAWIO_RENDER_TIMEOUT_MILLISECONDS + 2000;

/**
 * Lay the HTML out offscreen, settle it, run `work` against the staged iframe, and remove the
 * iframe on every path.
 */
async function withStagedSlide<TResult>(
  options: Readonly<{
    html: string;
    container: HTMLElement;
    slidePx?: SizePx;
    settleBudgetMs?: number;
    work: (iframe: HTMLIFrameElement) => Promise<TResult>;
  }>,
): Promise<TResult> {
  const slidePx = options.slidePx ?? DEFAULT_SLIDE_PX;
  const budgetMs = options.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS;
  const iframe = options.container.ownerDocument.createElement("iframe");

  // try/finally rather than `using`: `Symbol.dispose` is not declared under the
  // `ES2022,DOM` lib this module is compiled against, and adding
  // `esnext.disposable` to the extension's bundle for one iframe is not a
  // trade worth making. The finally still releases on every path.
  try {
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    iframe.style.cssText = [
      "position:fixed",
      "left:-99999px",
      "top:0",
      `width:${slidePx.w}px`,
      `height:${slidePx.h}px`,
      "border:0",
      "margin:0",
      "padding:0",
    ].join(";");
    options.container.appendChild(iframe);

    // `srcdoc` keeps the iframe on this page's origin, which is required to
    // reach `contentWindow` and inject the extractor at all.
    const loaded = onceLoaded(iframe, budgetMs);
    iframe.srcdoc = options.html;
    await loaded;
    await settle({ iframe, budgetMs });

    return await options.work(iframe);
  } finally {
    iframe.remove();
  }
}

function stagedDocumentOf(iframe: HTMLIFrameElement): Document {
  const document_ = iframe.contentDocument;
  if (document_ === null) throw new Error("staging iframe is not same-origin: cannot read contentDocument");
  return document_;
}

/** A pending draw.io placeholder that is left empty, and why. */
type UndrawnDiagram = Readonly<{ bounds: BoundsPx; reason: string }>;

/**
 * Fill the page's pending draw.io placeholder with a picture of its `#drawio-source`, BEFORE the
 * extractor runs, so the extractor pairs the picture with the source (extract-dom.ts pairs the
 * `[data-drawio]` `<img>` with the script by its box) and the emitter stamps it.
 *
 * The picture is draw.io's own PNG, as an `<img data-drawio>` fitted inside the placeholder with
 * its aspect ratio kept: a raster `<img>` is placed by the existing image path (staged on Drive)
 * with no further drawing, and draw.io's own export is the most faithful rendering there is.
 *
 * Never throws: every failure leaves the placeholder empty and is reported over its box. Only
 * the first placeholder is drawn: a page carries one `#drawio-source`, and the extractor pairs
 * one picture with it.
 */
async function drawPendingDiagrams(
  options: Readonly<{
    document: Document;
    renderDrawio: ((options: Readonly<{ xml: string }>) => Promise<DrawioRender>) | null;
    budgetMs: number;
  }>,
): Promise<Readonly<{ drewPicture: boolean; undrawn: readonly UndrawnDiagram[] }>> {
  const { document } = options;
  const placeholders = Array.from(document.querySelectorAll(`[${DRAWIO_PENDING_ATTRIBUTE}="${DRAWIO_PENDING_VALUE}"]`));
  const [first, ...rest] = placeholders;
  if (first === undefined) return { drewPicture: false, undrawn: [] };
  const undrawn: UndrawnDiagram[] = rest.map((placeholder) => ({
    bounds: boundsOf(placeholder),
    reason: "only one draw.io diagram per slide is drawn",
  }));
  const outcome = await drawOneDiagram({ ...options, placeholder: first });
  switch (outcome.kind) {
    case "drawn":
      return { drewPicture: true, undrawn };
    case "undrawn":
      return { drewPicture: false, undrawn: [{ bounds: boundsOf(first), reason: outcome.reason }, ...undrawn] };
    default:
      return assertNever(outcome);
  }
}

type DiagramOutcome = Readonly<{ kind: "drawn" }> | Readonly<{ kind: "undrawn"; reason: string }>;

async function drawOneDiagram(
  options: Readonly<{
    document: Document;
    placeholder: Element;
    renderDrawio: ((options: Readonly<{ xml: string }>) => Promise<DrawioRender>) | null;
    budgetMs: number;
  }>,
): Promise<DiagramOutcome> {
  const { document, placeholder } = options;
  const script = document.getElementById(DRAWIO_SOURCE_ELEMENT_ID);
  if (script === null || script.getAttribute("type") !== DRAWIO_SOURCE_SCRIPT_TYPE) {
    return { kind: "undrawn", reason: "the slide has no draw.io source script" };
  }
  const source = parseDrawioSource(script.textContent ?? "");
  switch (source.kind) {
    case "invalid":
      return { kind: "undrawn", reason: source.reason };
    case "ok":
      break;
    default:
      return assertNever(source);
  }
  if (options.renderDrawio === null) return { kind: "undrawn", reason: "no draw.io renderer is available here" };
  const render = await guardedRender({ renderDrawio: options.renderDrawio, xml: source.xml });
  switch (render.kind) {
    case "failed":
      return { kind: "undrawn", reason: render.reason };
    case "rendered":
      break;
    default:
      return assertNever(render);
  }
  const pngDataUrl = render.picture.pngDataUrl;
  if (!/^data:image\/png;base64,/i.test(pngDataUrl)) return { kind: "undrawn", reason: "the draw.io renderer returned no PNG" };
  const picture = document.createElement("img");
  try {
    await loadImage({ image: picture, src: pngDataUrl, budgetMs: options.budgetMs });
  } catch (error) {
    return { kind: "undrawn", reason: error instanceof Error ? error.message : String(error) };
  }
  placePicture({ placeholder, picture });
  return { kind: "drawn" };
}

/** The host's renderer, raced against a deadline and with a throw turned into a failure. */
async function guardedRender(
  options: Readonly<{ renderDrawio: (options: Readonly<{ xml: string }>) => Promise<DrawioRender>; xml: string }>,
): Promise<DrawioRender> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DrawioRender>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "failed", reason: `the draw.io renderer did not answer within ${Math.round(DRAWIO_RENDER_GUARD_MS / 1000)} s` }),
      DRAWIO_RENDER_GUARD_MS,
    );
  });
  try {
    return await Promise.race([options.renderDrawio({ xml: options.xml }), deadline]);
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The picture, centred in the placeholder at the largest size that keeps its aspect ratio. */
function placePicture(options: Readonly<{ placeholder: Element; picture: HTMLImageElement }>): void {
  const { placeholder, picture } = options;
  const view = placeholder.ownerDocument.defaultView;
  const box = placeholder.getBoundingClientRect();
  const naturalWidth = Math.max(1, picture.naturalWidth);
  const naturalHeight = Math.max(1, picture.naturalHeight);
  const fit = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * fit;
  const height = naturalHeight * fit;
  picture.setAttribute(DRAWIO_RENDER_ATTRIBUTE, "");
  picture.alt = "";
  picture.setAttribute(
    "style",
    `position:absolute;display:block;margin:0;padding:0;border:0;left:${(box.width - width) / 2}px;top:${(box.height - height) / 2}px;width:${width}px;height:${height}px`,
  );
  // The picture is positioned inside the placeholder; a static one would place it against the page.
  if (view !== null && view.getComputedStyle(placeholder).position === "static") {
    placeholder.setAttribute("style", `${placeholder.getAttribute("style") ?? ""};position:relative`);
  }
  placeholder.setAttribute(DRAWIO_PENDING_ATTRIBUTE, "rendered");
  placeholder.appendChild(picture);
}

function boundsOf(element: Element): BoundsPx {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height };
}

/**
 * A slide that has not settled in this long is measured as-is. CLAUDE.md's rule
 * applies: poll for the observable condition and fail fast, rather than sleep a
 * fixed amount and hope.
 */
const DEFAULT_SETTLE_BUDGET_MS = 1200;

const SETTLE_POLL_MS = 25;

/**
 * How long to wait for the single post-layout frame. It is a FLUSH, not a load: one frame is
 * ~16ms, so this is generous, and it is deliberately far below the settle budget. A frame the
 * browser never paints must cost a blink, not a second -- with four candidates converting one at
 * a time, the settle budget here would have added ~5s to the grid for nothing.
 */
const FRAME_FLUSH_BUDGET_MS = 150;

function onceLoaded(iframe: HTMLIFrameElement, budgetMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      iframe.removeEventListener("load", finish);
      resolve();
    };
    // A `srcdoc` iframe that never fires `load` must not hang the picker; the
    // readiness poll below will still find a laid-out document in practice.
    const timer = setTimeout(finish, budgetMs);
    iframe.addEventListener("load", finish, { once: true });
  });
}

/**
 * Wait for the things that actually move geometry: web fonts (a fallback font
 * changes every text box's width) and images (a missing intrinsic size changes
 * layout). Resolves as soon as both are done, or at the budget.
 */
async function settle(options: Readonly<{ iframe: HTMLIFrameElement; budgetMs: number }>): Promise<void> {
  const { iframe, budgetMs } = options;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (isSettled(iframe)) break;
    await delay(SETTLE_POLL_MS);
  }
  // One frame so the final style recalculation has flushed before measuring.
  await nextFrame(iframe, FRAME_FLUSH_BUDGET_MS);
}

function isSettled(iframe: HTMLIFrameElement): boolean {
  const document_ = iframe.contentDocument;
  if (document_ === null) return false;
  if (document_.readyState !== "complete") return false;
  // SAFETY: `FontFaceSet.status` is standard but reached through a Document
  // getter that the DOM lib does not expose on every target; the `?.` guard
  // makes the widened read safe when the property is absent.
  const fonts = (document_ as Document & { fonts?: { status?: string } }).fonts;
  if (fonts !== undefined && fonts.status !== undefined && fonts.status !== "loaded") return false;
  const images = Array.from(document_.images);
  return images.every((image) => image.complete);
}

function nextFrame(iframe: HTMLIFrameElement, budgetMs: number): Promise<void> {
  const view = iframe.contentWindow;
  if (view === null) return Promise.resolve();
  return afterNextFrame({ view, budgetMs });
}

/**
 * One painted frame, OR the budget -- whichever comes first.
 *
 * THE BUG THIS EXISTS FOR. Every other wait in this path is bounded: `onceLoaded` has a timer,
 * `settle` has a deadline, `delay` is a timeout. This one awaited `requestAnimationFrame` with
 * nothing racing it, and a browser does not service rAF for a frame it is not rendering -- a
 * backgrounded tab, an occluded or throttled frame, or the nested sandbox an Apps Script
 * `showModelessDialog` puts this code in. When that happened the promise NEVER settled: no
 * throw, no rejection, so the picker showed "converting..." on every candidate forever and the
 * one-at-a-time pump never advanced past the first slide, because a conversion in flight blocks
 * the next (dialog.tsx `pump`).
 *
 * A frame that never paints is not an error -- the layout is already final, since `settle` has
 * confirmed `readyState: complete`, fonts loaded and images complete. The frame is only a flush,
 * so timing out and measuring is strictly better than hanging.
 */
export function afterNextFrame(
  options: Readonly<{ view: Readonly<{ requestAnimationFrame: (callback: () => void) => unknown }>; budgetMs: number }>,
): Promise<void> {
  const { view, budgetMs } = options;
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, budgetMs);
    view.requestAnimationFrame(finish);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Evaluate the extractor inside the staged iframe.
 *
 * Primary path is `contentWindow.eval`, whose completion value is the JSON the
 * extractor's IIFE returns. On a host whose CSP forbids `unsafe-eval` — which
 * includes the Google Slides editor — that throws, so the blob is appended as
 * an inline `<script>` instead (inline scripts run synchronously on append)
 * and the global the extractor sets is read back. This dual path is lifted from
 * `renderer/html2slides/browser/convert-core.ts:89-113`, where it was already
 * proven against the Slides add-on sandbox.
 */
function runExtractor(
  options: Readonly<{ iframe: HTMLIFrameElement; extractorScript: string }>,
): unknown {
  const { iframe, extractorScript } = options;
  const view = iframe.contentWindow as ExtractorWindow | null;
  const document_ = iframe.contentDocument;
  if (view === null || document_ === null) {
    throw new Error("staging iframe is not same-origin: cannot read contentWindow");
  }

  let raw: unknown;
  try {
    raw = view.eval(extractorScript);
  } catch (evalError) {
    const script = document_.createElement("script");
    script.textContent = extractorScript;
    view.__H2S_EXTRACT__ = undefined;
    (document_.head ?? document_.documentElement).appendChild(script);
    script.remove();
    raw = view.__H2S_EXTRACT__;
    if (raw === undefined) {
      const reason = evalError instanceof Error ? evalError.message : String(evalError);
      throw new Error(
        `extractor did not run: eval was blocked (${reason}) and inline-script ` +
          "injection produced no result — the host CSP forbids both",
      );
    }
  }
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * The two globals the extractor contract depends on. `eval` is on `Window` at
 * runtime but not on the `WindowProxy` type a cross-document `contentWindow`
 * is typed as, and `__H2S_EXTRACT__` is the extractor's own CSP escape hatch
 * (set at extract-dom.ts:3469).
 */
type ExtractorWindow = Window & {
  eval(source: string): unknown;
  __H2S_EXTRACT__?: string | undefined;
};
