/**
 * The wire contract between the developer page (`sashaslides.com/dev`) and the connector's two
 * signed-in Google Slides routes it calls with the person's OWN Google grant:
 *
 *   POST /deck-api/google-slides/insert-html   converted slides (product converter output) -> new
 *                                              slides in the person's presentation
 *   POST /deck-api/google-slides/export-png    the person's presentation -> a zip of slide PNGs
 *
 * Both run on the deck session cookie plus the `X-Sasha-Csrf` header from `GET /deck-api/session`,
 * exactly like `/deck-api/google-slides/import`. Without a Google grant they answer 409
 * `googleNotConnected` with a `connectAddress` that returns to `/dev`. The page is UNTRUSTED input:
 * the server re-validates every request (insert-html.ts), never trusts an object id, and caps sizes.
 *
 * Types and constants only: imported by the browser page and by the Node server.
 */
import type { SlidesApiRequest } from "../converter/slides-api.ts";

export const GOOGLE_SLIDES_INSERT_HTML_PATH = "/deck-api/google-slides/insert-html";
export const GOOGLE_SLIDES_EXPORT_PNG_PATH = "/deck-api/google-slides/export-png";
/** Where a person without a Google grant is sent, and where consent returns to. */
export const DEV_PAGE_PATH = "/dev";

/** At most this many slides per insert, requests per slide and bytes per request body. */
export const INSERT_HTML_LIMITS = {
  maximumSlides: 20,
  maximumRequestsPerSlide: 3000,
  maximumBodyBytes: 40 * 1024 * 1024,
  maximumStagedImagesPerSlide: 40,
} as const;

/** At most this many slides per PNG export: each costs one rate-limited thumbnail call (~1 s). */
export const EXPORT_PNG_LIMITS = { maximumSlides: 60 } as const;

export type InsertPosition =
  | Readonly<{ kind: "end" }>
  /** 0-based insertion index, as `createSlide.insertionIndex`. */
  | Readonly<{ kind: "index"; index: number }>;

/** One draw.io diagram the converter found on a slide (convert result `drawioDiagrams`). */
export type InsertedDiagram = Readonly<{ objectId: string; diagramId: string; xml: string }>;

export type InsertHtmlSlide = Readonly<{
  /**
   * The converter's requests for ONE slide, `elementProperties.pageObjectId` set to any placeholder:
   * the server creates the slide and points every request at it. A `createImage` may carry the
   * converter's `sashaStageImage` sidecar; the server uploads those bytes to the person's Drive and
   * substitutes the address.
   */
  requests: readonly SlidesApiRequest[];
  diagrams: readonly InsertedDiagram[];
}>;

export type InsertHtmlRequestBody = Readonly<{
  /** A presentation id or its address. */
  presentation: string;
  position: InsertPosition;
  slides: readonly InsertHtmlSlide[];
}>;

export type InsertHtmlResponseBody = Readonly<{
  presentationId: string;
  presentationAddress: string;
  /** The created slides' page object ids, in order. */
  pageObjectIds: readonly string[];
  /** Every diagram source written to Drive (sasha_slides/slide/<presentationId>/drawio/<id>.drawio). */
  diagrams: readonly Readonly<{ diagramId: string; fileId: string }>[];
  /** Best-effort steps that failed after the slides were in (a diagram file or link); the insert stands. */
  warnings: readonly string[];
}>;

export type ExportPngRequestBody = Readonly<{
  presentation: string;
  /** 1-based, inclusive; null = from the first / to the last. */
  from: number | null;
  to: number | null;
  /** Leave out slides marked "Skip slide". */
  skipHidden: boolean;
}>;

/** The answer is the zip itself (`application/zip`, `slide-01.png`, …); errors are JSON. */
export const EXPORT_PNG_MEDIA_TYPE = "application/zip";
