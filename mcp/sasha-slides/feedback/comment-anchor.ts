/**
 * The parse boundary for a Drive comment's `anchor`, and the slide a comment belongs to.
 *
 * **Measured against the live deck, not assumed** (`e2e/feedback-live.ts` re-proves it, and
 * PROTOCOL.md records the raw JSON). Two facts shape this file:
 *
 * 1. **Drive validates nothing.** `drive.comments.create` accepted the anchor
 *    `"this-is-not-json-at-all"` and `drive.comments.list` handed it back verbatim. The
 *    anchor is an opaque string as far as Drive is concerned; whatever structure is inside
 *    it was written by the editor app, so it is untrusted input and is parsed here.
 * 2. **Google Slides writes a JSON object that names the slide.** Observed by having the
 *    Slides API (`presentations.batchUpdate` / `insertComment`) author the anchor and then
 *    reading the same comment back through `drive.comments.list`:
 *
 *    ```
 *    page            {"uid":650326478,"pages":["sasha_s0fao02zbr2o"],"type":"page"}
 *    shape           {"uid":211246977,"page":"p","type":"shape","targets":["i0"]}
 *    text in a shape {"uid":1888281314,"subtype":"text","page":"sasha_s0fao02zbr2o",
 *                     "type":"shape","targets":["sasha_s0fao02zbr2o_text2"]}
 *    ```
 *
 *    Note the asymmetry Google chose: `type:"page"` carries **`pages`** (an array) while
 *    `type:"shape"` carries **`page`** (a single string) plus `targets`. `uid` is an opaque
 *    per-anchor integer with no meaning to us.
 *
 * For comparison, the same field on a Google **Docs** file holds a bare opaque token
 * (`"kix.uyz42h4rp0wc"`), which is why nothing here may assume the anchor is JSON at all.
 *
 * The gap this file also has to cover: a comment created through the **Drive** API carries
 * no anchor, and Google's own guide states the editors "treat these comments as unanchored
 * comments". So the agent's own comments can never be anchored this way, and the fallback
 * is an explicit `[slide:…]` marker in the comment text — see `formatSlideMarker`.
 */
import { assertNever } from "../google-auth";
// Type only: one fractional (0-1) region convention across the whole protocol, shared with
// `PICK.anomalies`, with no runtime dependency on the staging protocol.
import type { AnomalyRegion } from "../proposal";

/**
 * A Drive comment's `anchor`, narrowed. `opaque` is a first-class outcome, not a failure:
 * an anchor we cannot interpret is reported with the raw string so a caller can see exactly
 * what Google stored rather than being told the comment has no location.
 */
export type CommentAnchor =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "slides-page"; pageObjectId: string; uid: number | null }>
  | Readonly<{
      kind: "slides-element";
      pageObjectId: string;
      elementObjectIds: readonly string[];
      /** True for `subtype:"text"`: the comment marks a text range inside the element. */
      textRange: boolean;
      uid: number | null;
    }>
  | Readonly<{ kind: "opaque"; raw: string; reason: string }>;

export function parseCommentAnchor(anchor: string | null): CommentAnchor {
  if (anchor === null || anchor.trim() === "") return { kind: "absent" };

  const parsed = parseJsonObject(anchor);
  if (parsed === null) {
    // The Docs case: a bare token such as "kix.uyz42h4rp0wc". Nothing to interpret.
    return { kind: "opaque", raw: anchor, reason: "not a JSON object" };
  }

  const type = parsed["type"];
  if (type === "page") {
    // Slides' page anchors carry `pages`, plural, even for a single slide.
    const pageObjectId = firstString(parsed["pages"]);
    if (pageObjectId === null) {
      return { kind: "opaque", raw: anchor, reason: 'type "page" with no usable "pages" entry' };
    }
    return { kind: "slides-page", pageObjectId, uid: numberOrNull(parsed["uid"]) };
  }

  if (type === "shape") {
    // ...while shape anchors carry `page`, singular, plus the elements they mark.
    const pageObjectId = parsed["page"];
    if (typeof pageObjectId !== "string" || pageObjectId === "") {
      return { kind: "opaque", raw: anchor, reason: 'type "shape" with no usable "page"' };
    }
    return {
      kind: "slides-element",
      pageObjectId,
      elementObjectIds: stringArray(parsed["targets"]),
      textRange: parsed["subtype"] === "text",
      uid: numberOrNull(parsed["uid"]),
    };
  }

  // The legacy `{"r":<revision>,"a":[<classifiers>]}` scheme Google's older guide describes,
  // and anything Slides starts writing in future, land here with the raw string intact.
  return {
    kind: "opaque",
    raw: anchor,
    reason: typeof type === "string" ? `unrecognised anchor type "${type}"` : 'no "type" field',
  };
}

export function describeCommentAnchor(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "absent":
      return "unanchored (no anchor stored; comments created through the Drive API never have one)";
    case "slides-page":
      return `anchored to slide page ${anchor.pageObjectId}`;
    case "slides-element": {
      const elements = anchor.elementObjectIds.join(", ") || "<none>";
      const what = anchor.textRange ? "a text range in" : "page element(s)";
      return `anchored to ${what} ${elements} on slide page ${anchor.pageObjectId}`;
    }
    case "opaque":
      return `anchor present but not interpretable (${anchor.reason})`;
    default:
      return assertNever(anchor);
  }
}

/**
 * Which slide a comment is about.
 *
 * Invariant on `slide`: at least one of `pageObjectId` / `slideNumber` is non-null. A page
 * object id with no `slideNumber` means the deck's page order could not be read; a
 * `slideNumber` with no `pageObjectId` means the marker named a position and we had no deck
 * to resolve it against.
 */
export type SlideLocation =
  | Readonly<{
      kind: "slide";
      pageObjectId: string | null;
      /** 1-based, matching PROTOCOL.md's "slides are 1-based everywhere". */
      slideNumber: number | null;
      elementObjectIds: readonly string[];
      via: SlideLocationSource;
    }>
  | Readonly<{ kind: "unknown"; reason: string }>;

/**
 * `slides-anchor` is Google's own anchor and is authoritative. The other two are fallbacks
 * for comments the Drive API created, which Slides cannot anchor:
 *  - `sidebar-sentinel` is the add-on's `sasha-slides-feedback=` line (PROTOCOL.md);
 *  - `text-marker` is the plain `[slide:…]` prefix a human or the agent can type.
 */
export type SlideLocationSource =
  | "slides-anchor"
  | "sidebar-sentinel"
  | "text-marker"
  /**
   * The comment is on `NN.html` itself, so the candidate's own index IS the slide — nothing
   * is inferred and nothing can contradict it. This is the only source that cannot be wrong,
   * and it is why comments were repointed onto the candidate (PROTOCOL.md "Comments live on
   * the CANDIDATE, not the deck").
   */
  | "candidate-file";

export function resolveSlideLocation(
  options: Readonly<{
    anchor: CommentAnchor;
    text: string;
    /** Page object ids in filmstrip order, or null when the deck could not be read. */
    pageObjectIds: readonly string[] | null;
  }>,
): SlideLocation {
  const { anchor, text, pageObjectIds } = options;

  const anchored = anchoredPage(anchor);
  if (anchored !== null) {
    return {
      kind: "slide",
      pageObjectId: anchored.pageObjectId,
      slideNumber: slideNumberOf({ pageObjectId: anchored.pageObjectId, pageObjectIds }),
      elementObjectIds: anchored.elementObjectIds,
      via: "slides-anchor",
    };
  }

  // The add-on's own notes carry the page in their sentinel, which is richer than the plain
  // marker and is what the sidebar actually writes.
  const sentinel = parseFeedbackSentinel({ text });
  if (sentinel !== null && sentinel.pageObjectId !== null) {
    return {
      kind: "slide",
      pageObjectId: sentinel.pageObjectId,
      slideNumber: slideNumberOf({ pageObjectId: sentinel.pageObjectId, pageObjectIds }),
      elementObjectIds: [],
      via: "sidebar-sentinel",
    };
  }

  const marker = parseSlideMarker({ text, pageObjectIds });
  switch (marker.kind) {
    case "page":
      return {
        kind: "slide",
        pageObjectId: marker.pageObjectId,
        slideNumber: marker.slideNumber,
        elementObjectIds: [],
        via: "text-marker",
      };
    case "unmatched":
      return { kind: "unknown", reason: marker.reason };
    case "absent":
      return { kind: "unknown", reason: `${describeCommentAnchor(anchor)}; no ${SLIDE_MARKER_HINT}` };
    default:
      return assertNever(marker);
  }
}

/**
 * The marker a writer puts at the FRONT of a comment so the slide survives the fact that
 * Drive-created comments are unanchored. Our own sidebar and the agent both use this; the
 * user typing a native Slides comment does not need it, because Slides anchors those.
 */
export function formatSlideMarker(options: Readonly<{ pageObjectId: string }>): string {
  return `[slide:${options.pageObjectId}]`;
}

export const SLIDE_MARKER_HINT = "[slide:<pageObjectId>] or [slide:<1-based number>] marker in the text";

/**
 * The add-on sidebar's own sentinel line, as PROTOCOL.md specifies it:
 *
 *     the chart lost its gridlines
 *
 *     sasha-slides-feedback={"protocolVersion":1,"noteId":"user_k2h9","pageObjectId":"g2d1","region":{"x":0.1,"y":0.2,"w":0.3,"h":0.2},"createdAt":"…"}
 *
 * The writer is `addon/src/feedback.ts` (`feedbackCommentContent`), which is owned by the
 * sidebar half; this is the reader. Both ends are stated once in PROTOCOL.md, which is why
 * the string lives in both packages rather than one importing a browser bundle from the
 * other. It is untrusted input — the sidebar is a different process and the user can type
 * anything — so it is parsed defensively and every field is optional.
 */
export const FEEDBACK_SENTINEL = "sasha-slides-feedback=";

export type FeedbackSentinel = Readonly<{
  protocolVersion: number | null;
  noteId: string | null;
  pageObjectId: string | null;
  /** Fractional (0–1) against the slide, the same convention `PICK.anomalies` uses. */
  region: AnomalyRegion | null;
}>;

/** Null when the text carries no sentinel, i.e. it is somebody's own comment on the deck. */
export function parseFeedbackSentinel(options: Readonly<{ text: string }>): FeedbackSentinel | null {
  // Last match wins: the sentinel is specified as the final line, and a user quoting an
  // earlier one in their prose must not shadow it.
  const line = options.text
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith(FEEDBACK_SENTINEL))
    .at(-1);
  if (line === undefined) return null;

  const payload = parseJsonObject(line.slice(FEEDBACK_SENTINEL.length));
  if (payload === null) return null;
  return {
    protocolVersion: numberOrNull(payload["protocolVersion"]),
    noteId: stringOrNull(payload["noteId"]),
    pageObjectId: stringOrNull(payload["pageObjectId"]),
    region: narrowRegion(payload["region"]),
  };
}

/** Anchored to a slide and, for an element anchor, to the elements on it. */
function anchoredPage(
  anchor: CommentAnchor,
): Readonly<{ pageObjectId: string; elementObjectIds: readonly string[] }> | null {
  switch (anchor.kind) {
    case "slides-page":
      return { pageObjectId: anchor.pageObjectId, elementObjectIds: [] };
    case "slides-element":
      return { pageObjectId: anchor.pageObjectId, elementObjectIds: anchor.elementObjectIds };
    case "absent":
    case "opaque":
      return null;
    default:
      return assertNever(anchor);
  }
}

function slideNumberOf(
  options: Readonly<{ pageObjectId: string; pageObjectIds: readonly string[] | null }>,
): number | null {
  const { pageObjectId, pageObjectIds } = options;
  if (pageObjectIds === null) return null;
  const position = pageObjectIds.indexOf(pageObjectId);
  return position < 0 ? null : position + 1;
}

type SlideMarker =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "page"; pageObjectId: string | null; slideNumber: number | null }>
  | Readonly<{ kind: "unmatched"; reason: string }>;

/** Leading `[slide:…]`; the value is either a page object id or a 1-based position. */
const SLIDE_MARKER_PATTERN = /^\s*\[\s*slide\s*:\s*([A-Za-z0-9_.-]+)\s*\]/;

function parseSlideMarker(
  options: Readonly<{ text: string; pageObjectIds: readonly string[] | null }>,
): SlideMarker {
  const { text, pageObjectIds } = options;
  const matched = SLIDE_MARKER_PATTERN.exec(text);
  if (matched === null) return { kind: "absent" };
  const value = matched[1];
  if (value === undefined) return { kind: "absent" };

  if (/^[0-9]+$/.test(value)) {
    const slideNumber = Number.parseInt(value, 10);
    if (slideNumber < 1) return { kind: "unmatched", reason: `marker [slide:${value}] is not 1-based` };
    if (pageObjectIds === null) return { kind: "page", pageObjectId: null, slideNumber };
    const pageObjectId = pageObjectIds[slideNumber - 1];
    if (pageObjectId === undefined) {
      return {
        kind: "unmatched",
        reason: `marker [slide:${value}] is past the end of a ${String(pageObjectIds.length)}-slide deck`,
      };
    }
    return { kind: "page", pageObjectId, slideNumber };
  }

  if (pageObjectIds !== null && !pageObjectIds.includes(value)) {
    return { kind: "unmatched", reason: `marker [slide:${value}] names no page in this deck` };
  }
  return {
    kind: "page",
    pageObjectId: value,
    slideNumber: slideNumberOf({ pageObjectId: value, pageObjectIds }),
  };
}

function parseJsonObject(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return typeof first === "string" && first !== "" ? first : null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const collected: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry === "string" && entry !== "") collected.push(entry);
  }
  return collected;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A region is only honoured when all four coordinates are really there and fractional. */
function narrowRegion(value: unknown): AnomalyRegion | null {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
  if (record === null) return null;
  const x = numberOrNull(record["x"]);
  const y = numberOrNull(record["y"]);
  const w = numberOrNull(record["w"]);
  const h = numberOrNull(record["h"]);
  if (x === null || y === null || w === null || h === null) return null;
  // Fractional by contract (PROTOCOL.md). Out-of-range numbers mean a different convention
  // got in, and silently passing them on would put the agent's attention in the wrong place.
  const inRange = [x, y, w, h].every((coordinate) => coordinate >= 0 && coordinate <= 1);
  return inRange ? { x, y, w, h } : null;
}
