/**
 * emit-context.ts — the vocabulary every per-element emitter shares.
 *
 * An emitter is a pure function `(element, context) => ElementEmission`. It
 * never appends to a shared array, so one element's output can be inspected in
 * isolation in a test and the orchestrator's only job is concatenation. The one
 * piece of state in the whole emission stage is the object-id counter, which is
 * injected as a capability rather than reached for.
 */
import type { BoundsPx, SizePx, TypeStyle } from "./extraction.js";
import type { PageScale, TextInsetEmu } from "./geometry.js";
import { fractionalRegion, lineSpacingPercent, pxToPoints } from "./geometry.js";
import { optionalColorFromHex } from "./slides-paint.js";
import { resolveFontFamily } from "./slides-font.js";
import type {
  Alignment,
  ContentAlignment,
  SlidesApiRequest,
  TextStyle,
} from "./slides-api.js";
import type { FractionalRegion, UnsupportedFeature } from "./unsupported-feature.js";

export type ElementEmission = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
}>;

export const EMPTY_EMISSION: ElementEmission = { requests: [], unsupported: [] };

export function mergeEmissions(parts: readonly ElementEmission[]): ElementEmission {
  const requests: SlidesApiRequest[] = [];
  const unsupported: UnsupportedFeature[] = [];
  for (const part of parts) {
    requests.push(...part.requests);
    unsupported.push(...part.unsupported);
  }
  return { requests, unsupported };
}

/**
 * Hands out Slides object ids. The API requires 5–50 characters from
 * `[a-zA-Z0-9_-]` and global uniqueness within the presentation, so the caller
 * supplies a per-conversion prefix (the proposal id is the natural choice) and
 * this allocator guarantees uniqueness within the conversion.
 */
export type ObjectIdAllocator = Readonly<{ next: (role: string) => string }>;

export function createObjectIdAllocator(prefix: string): ObjectIdAllocator {
  const safePrefix = sanitiseIdPart(prefix).slice(0, 24) || "ss";
  let counter = 0;
  return {
    next: (role: string): string => {
      counter++;
      const id = `${safePrefix}_${sanitiseIdPart(role).slice(0, 12)}${counter}`;
      // The 5-character floor is the only way an id can be invalid once the
      // charset is sanitised, and only a degenerate prefix+role can hit it.
      return id.length >= 5 ? id.slice(0, 50) : `${id}_____`.slice(0, 50);
    },
  };
}

export type EmitContext = Readonly<{
  pageObjectId: string;
  scale: PageScale;
  ids: ObjectIdAllocator;
  textInsetEmu: TextInsetEmu;
}>;

/** The locating half of an `UnsupportedFeature`, built once per report. */
export function featureSite(
  options: Readonly<{
    bounds: BoundsPx;
    viewportPx: SizePx;
    elementType: string;
    domIndex: number | null;
  }>,
): Readonly<{ region: FractionalRegion; elementType: string; domIndex: number | null }> {
  const { bounds, viewportPx, elementType, domIndex } = options;
  return {
    region: fractionalRegion({ bounds, viewportPx }),
    elementType,
    domIndex,
  };
}

/**
 * One `TypeStyle` as a Slides `TextStyle` plus the matching field mask.
 *
 * The mask is assembled alongside the object rather than derived from it: a
 * generic walker would emit leaf-deep paths like
 * `foregroundColor.opaqueColor.rgbColor.red`, and Slides wants masks at the
 * level its own documentation uses.
 */
export function textStyleFor(
  style: TypeStyle,
): Readonly<{ style: TextStyle; fields: string; fontSubstitutedFrom: string | null }> {
  const font = resolveFontFamily(style.fontFamily);
  const fields = [
    "fontFamily",
    "fontSize",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "baselineOffset",
  ];
  const base = {
    fontFamily: font.family,
    fontSize: { magnitude: pxToPoints(style.fontSizePx), unit: "PT" as const },
    bold: style.bold,
    italic: style.italic,
    underline: style.decoration.underline,
    strikethrough: style.decoration.strikethrough,
    baselineOffset: baselineOffsetFor(style.baseline),
  };
  const withColour =
    style.hex === null
      ? base
      : { ...base, foregroundColor: optionalColorFromHex(style.hex) };
  if (style.hex !== null) fields.push("foregroundColor");

  const withHighlight =
    style.highlightHex === null
      ? withColour
      : { ...withColour, backgroundColor: optionalColorFromHex(style.highlightHex) };
  if (style.highlightHex !== null) fields.push("backgroundColor");

  return {
    style: withHighlight,
    fields: fields.join(","),
    fontSubstitutedFrom: font.substituted ? font.requested : null,
  };
}

/**
 * Paragraph alignment and line pitch for a text run of this style.
 *
 * CSS `start`/`end` are direction-relative and map onto Slides' own
 * direction-relative `START`/`END`, so no left/right assumption is baked in.
 */
export function paragraphStyleFor(
  style: TypeStyle,
): Readonly<{
  style: Readonly<{ alignment: Alignment; lineSpacing: number }>;
  fields: string;
}> {
  return {
    style: {
      alignment: alignmentFromCss(style.textAlign),
      lineSpacing: lineSpacingPercent({
        lineHeightPx: style.lineHeightPx,
        fontSizePx: style.fontSizePx,
      }),
    },
    fields: "alignment,lineSpacing",
  };
}

export function contentAlignmentFor(verticallyCentered: boolean): ContentAlignment {
  return verticallyCentered ? "MIDDLE" : "TOP";
}

/**
 * Length of a text insert in the units Slides' text ranges count.
 *
 * Google's text-bearing APIs index in UTF-16 code units, which is exactly
 * `String.prototype.length`, so this is a one-liner today. It exists as a named
 * function because it is the ONE place to change if a credentialed round-trip
 * shows ranges are code-point indexed instead — an astral character (emoji,
 * which `extract-dom.ts` flags via `_wasEmojiText`) is the only input where the
 * two differ.
 */
export function textRangeLength(text: string): number {
  return text.length;
}

function alignmentFromCss(textAlign: string): Alignment {
  switch (textAlign.trim().toLowerCase()) {
    case "center":
      return "CENTER";
    case "right":
    case "end":
      return "END";
    case "justify":
      return "JUSTIFIED";
    default:
      return "START";
  }
}

function baselineOffsetFor(
  baseline: TypeStyle["baseline"],
): "NONE" | "SUPERSCRIPT" | "SUBSCRIPT" {
  switch (baseline) {
    case "sub":
      return "SUBSCRIPT";
    case "super":
      return "SUPERSCRIPT";
    case "baseline":
      return "NONE";
    default:
      return assertNever(baseline);
  }
}

function sanitiseIdPart(text: string): string {
  return text.replace(/[^a-zA-Z0-9_-]/g, "");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled baseline: ${String(value)}`);
}
