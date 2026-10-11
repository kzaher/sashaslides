// The HTML -> Slides converter's interface, as this component assumes it.
//
// ASSUMED, NOT VERIFIED. `mcp/sasha-slides/converter/` is built by a parallel stream and did not
// exist when this was written, so the shape below is the one the task statement describes:
//   convertHtmlToSlideRequests({ html, presentationId, pageObjectId })
//     -> { requests: readonly SlidesApiRequest[]; unsupported: readonly UnsupportedFeature[] }
// with each `unsupported` entry carrying a fractional (0-1) bounding box relative to 1280x720.
// The exact FIELD NAMES on an unsupported entry were a guess, so `normalizeUnsupported` accepts the
// plausible spellings at the boundary and everything above it sees one shape. When the real module
// lands, the only edits are this file's normalizer and the single wiring line in content.ts --
// nothing else imports the converter.

import { WHOLE_SLIDE, isFractionalRegion, type Region } from "./protocol.ts";

/** A Google Slides API request object. Untyped on purpose: the converter owns its repertoire. */
export type SlidesApiRequest = Readonly<Record<string, unknown>>;

/** Something the converter could not express in Slides, and where on the slide it was. */
export type UnsupportedFeature = Readonly<{
  feature: string;
  note: string;
  region: Region;
}>;

export type ConversionResult = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
}>;

export type ConvertHtmlToSlideRequests = (
  spec: Readonly<{ html: string; presentationId: string; pageObjectId: string }>,
) => ConversionResult;

/** Whatever the converter returned, as this component's types. Tolerant by design -- see the header. */
export function normalizeUnsupported(raw: readonly unknown[]): readonly UnsupportedFeature[] {
  const features: UnsupportedFeature[] = [];
  for (const candidate of raw) {
    const record = asRecord(candidate);
    if (record === null) continue;
    const feature = firstString({ record, keys: ["feature", "kind", "name", "property"] }) ?? "unsupported";
    const note = firstString({ record, keys: ["note", "detail", "message", "reason"] }) ?? "";
    const region = firstRegion({ record, keys: ["region", "bounds", "box", "rect"] }) ?? WHOLE_SLIDE;
    features.push({ feature, note, region });
  }
  return features;
}

/**
 * Stands in for the real converter until it lands. It produces ONE full-slide text box, so the
 * insert path is end-to-end exercisable, and reports itself as unsupported so the anomaly UI has
 * something real to draw.
 */
export function stubConvertHtmlToSlideRequests(): ConvertHtmlToSlideRequests {
  return ({ html, pageObjectId }) => {
    const textBoxId = `${pageObjectId}_stub`;
    return {
      requests: [
        {
          createShape: {
            objectId: textBoxId,
            shapeType: "TEXT_BOX",
            elementProperties: {
              pageObjectId,
              size: { width: { magnitude: 1280, unit: "PT" }, height: { magnitude: 720, unit: "PT" } },
              transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "PT" },
            },
          },
        },
        {
          insertText: {
            objectId: textBoxId,
            text: `sasha-slides: converter not wired yet (${html.length} bytes of HTML)`,
          },
        },
      ],
      unsupported: [
        {
          feature: "stub-converter",
          note: "mcp/sasha-slides/converter/ was not available at build time; nothing was really converted.",
          region: WHOLE_SLIDE,
        },
      ],
    };
  };
}

function firstString({ record, keys }: { record: Readonly<Record<string, unknown>>; keys: readonly string[] }): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function firstRegion({ record, keys }: { record: Readonly<Record<string, unknown>>; keys: readonly string[] }): Region | null {
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested === null) continue;
    const region = {
      x: numberAt({ record: nested, keys: ["x", "left"] }),
      y: numberAt({ record: nested, keys: ["y", "top"] }),
      w: numberAt({ record: nested, keys: ["w", "width"] }),
      h: numberAt({ record: nested, keys: ["h", "height"] }),
    };
    if (region.x === null || region.y === null || region.w === null || region.h === null) continue;
    const candidate: Region = { x: region.x, y: region.y, w: region.w, h: region.h };
    if (isFractionalRegion(candidate)) return candidate;
  }
  return null;
}

function numberAt({ record, keys }: { record: Readonly<Record<string, unknown>>; keys: readonly string[] }): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
