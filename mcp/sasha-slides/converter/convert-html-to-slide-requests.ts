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
 */
import { parseExtraction } from "./extraction.js";
import type { ParsedExtraction, SizePx } from "./extraction.js";
import type { SlidePageSizeEmu, TextInsetEmu } from "./geometry.js";
import { emitSlideRequests } from "./emit-requests.js";
import type { ConversionResult } from "./emit-requests.js";

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
}>;

export type HtmlConversionResult = ConversionResult &
  Readonly<{
    presentationId: string;
    pageObjectId: string;
    /** Extractor entries with unusable geometry; non-zero means investigate. */
    malformedCount: number;
  }>;

export async function convertHtmlToSlideRequests(
  options: ConvertHtmlOptions,
): Promise<HtmlConversionResult> {
  const extraction = await extractSlideLayout(options);
  const emitted = emitSlideRequests({
    extraction,
    pageObjectId: options.pageObjectId,
    objectIdPrefix: options.objectIdPrefix,
    ...(options.pageSizeEmu === undefined ? {} : { pageSizeEmu: options.pageSizeEmu }),
    ...(options.textInsetEmu === undefined ? {} : { textInsetEmu: options.textInsetEmu }),
  });
  return {
    ...emitted,
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

    return parseExtraction(runExtractor({ iframe, extractorScript: options.extractorScript }));
  } finally {
    iframe.remove();
  }
}

const DEFAULT_SLIDE_PX: SizePx = { w: 1280, h: 720 };

/**
 * A slide that has not settled in this long is measured as-is. CLAUDE.md's rule
 * applies: poll for the observable condition and fail fast, rather than sleep a
 * fixed amount and hope.
 */
const DEFAULT_SETTLE_BUDGET_MS = 1200;

const SETTLE_POLL_MS = 25;

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
  await nextFrame(iframe);
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

function nextFrame(iframe: HTMLIFrameElement): Promise<void> {
  const view = iframe.contentWindow;
  if (view === null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    view.requestAnimationFrame(() => resolve());
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
