/**
 * rating-wire.ts — the shapes that cross between rating-server.ts and its browser
 * client (rating-ui.ts): the page configuration embedded as JSON in the served HTML,
 * the /api/comparisons rows, and the /api/summary and /api/rate replies.
 *
 * Both sides import these types, so a field renamed on the server is a compile error
 * in the client. The only value here is parseRatingPageConfig, the client's check of
 * the embedded configuration.
 */
import type { RatingDirection, ReverseSlide } from "./reverse-rating.ts";

/** Server settings the client needs, embedded once as `<script type="application/json" id="ratingConfig">`. */
export type RatingPageConfig = Readonly<{
  /** 'forward' (HTML -> Google Slides) or 'reverse' (Google Slides -> Sasha HTML). */
  direction: RatingDirection;
  /** Verdict-only UI (--read-only): no drawing tools, no comment box, rate() sends only { id, status }. */
  readOnly: boolean;
  /** --task-analysis / --task-diffs were given: show the two task reveal buttons. */
  taskScoped: boolean;
  /** --show-all: start with every slide visible, not only the ones that differ. */
  showAllDefault: boolean;
  /** Zoom-crop sides and their captions; reverse adds the round trip's fixture side. */
  zoomCropLabels: readonly ZoomCropLabel[];
  zoomCropTitle: string;
}>;

/** One side of a per-annotation zoom-crop: the file-name side and the caption shown above it. */
export type ZoomCropLabel = Readonly<{ side: string; caption: string }>;

/** A rasterised region the converter emitted as an image (fractions of the slide). */
export type RenderedRegion = Readonly<{ x: number; y: number; w: number; h: number; kind: string }>;

export type RatingStatus = "pending" | "good" | "bad";

/** One /api/comparisons row. The server fills it field by field, so it is not Readonly. */
export interface SlideComparison {
  id: string;
  originalPng: string;
  slidesPng: string;
  status: RatingStatus;
  comment?: string;
  analysis?: string;
  htmlFile?: string;
  slidesUrl?: string;
  // Round-1 provenance, populated from sxs-meta.json (written by the
  // bug_solving harness). These are what the USER originally saw/typed when
  // they rated the slide bad, surfaced per-card so a reviewer can always reach
  // the source HTML, the live presentation, the annotation they drew, and the
  // comment they wrote. All optional → older runs degrade gracefully.
  origComment?: string;        // the original user comment from round-1 rating
  origAnnotationPng?: string;  // absolute path (served via /img) to the round-1 annotation PNG
  /** The annotation saved with this round's rating (ratings.json `annotation`). */
  annotationPng?: string;
  diffPng?: string;        // /tmp/.../diffs/diff_slide_NN.png (pixelmatch output)
  diffStatus?: string;     // "ok" | "regressed" | "new" | "missing-current"
  diffPixels?: number;
  // Rasterized regions the converter emitted as addImage instead of native
  // primitives (visuals, images, emoji fallbacks). Surface these to the user
  // because any region in this list represents a fidelity compromise.
  renderedRegions?: RenderedRegion[];
  // Per-annotation zoom-crops: focused, nearest-neighbour-upscaled crops of
  // each marked region, one per side (original + test/slides), shown below the
  // slide so you can compare the exact spot you flagged at high zoom.
  zoomCrops?: string[];
  // REVERSE mode only: every file and metric of the slide (round-trip pair, Sasha
  // HTML, fixture HTML, metrics.json row), read by rating-ui-reverse.ts.
  reverse?: ReverseSlide;
}

/** Forward /api/summary: goldens health plus the freshness of the current render. */
export type ForwardSummary = Readonly<{
  matching: number;
  regressed: number;
  new: number;
  total: number;
  goldenTotal: number;
  oldestRenderMs: number | null;
  nowMs: number;
}>;

/** A committed annotation shape in draw-canvas coordinates, sent with a rating for zoom-crops. */
export type DrawShape = Readonly<{ kind: "rect" | "pencil"; x: number; y: number; w: number; h: number }>;

/** Editable /api/rate reply. */
export type RateReply = Readonly<{ ok: boolean; annotationPath?: string | null; zoomCrops?: readonly string[] }>;

/** Read the embedded configuration; throws when the server and client disagree on its shape. */
export function parseRatingPageConfig(raw: unknown): RatingPageConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("rating config: not an object");
  const record = raw as Record<string, unknown>;
  const direction = record.direction;
  if (direction !== "forward" && direction !== "reverse") throw new Error(`rating config: bad direction ${String(direction)}`);
  const labels = record.zoomCropLabels;
  if (!Array.isArray(labels)) throw new Error("rating config: zoomCropLabels is not an array");
  return {
    direction,
    readOnly: booleanField(record, "readOnly"),
    taskScoped: booleanField(record, "taskScoped"),
    showAllDefault: booleanField(record, "showAllDefault"),
    zoomCropLabels: labels.map(parseZoomCropLabel),
    zoomCropTitle: stringField(record, "zoomCropTitle"),
  };
}

function booleanField(record: Readonly<Record<string, unknown>>, name: string): boolean {
  const value = record[name];
  if (typeof value !== "boolean") throw new Error(`rating config: ${name} is not a boolean`);
  return value;
}

function stringField(record: Readonly<Record<string, unknown>>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") throw new Error(`rating config: ${name} is not a string`);
  return value;
}

function parseZoomCropLabel(raw: unknown): ZoomCropLabel {
  if (typeof raw !== "object" || raw === null) throw new Error("rating config: zoom-crop label is not an object");
  const record = raw as Record<string, unknown>;
  return { side: stringField(record, "side"), caption: stringField(record, "caption") };
}
