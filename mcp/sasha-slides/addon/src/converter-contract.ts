// The HTML -> Slides converter, as the picker consumes it.
//
// VERIFIED AGAINST THE REAL MODULE, no longer assumed. The extension's version of this file was
// written before `mcp/sasha-slides/converter/` existed, so it guessed: it declared
// `convertHtmlToSlideRequests` synchronous, invented an `UnsupportedFeature` of
// `{ feature, note, region }`, and had `normalizeUnsupported` sniff four plausible spellings for
// each field ("feature"/"kind"/"name"/"property", "region"/"bounds"/"box"/"rect", ...). The real
// module is imported below and three of those guesses were wrong:
//
//   * it is ASYNC -- it stages an offscreen 1280x720 iframe and waits for fonts and images
//   * it needs `extractorScript` (the compiled extract-dom blob), a `container` to park the iframe
//     in, and an `objectIdPrefix`
//   * an unsupported entry is a discriminated union tagged `kind` (never `feature`) carrying
//     `region` (never `bounds`), plus `elementType`, `domIndex` and `fallback`, and its human
//     sentence comes from `describeUnsupportedFeature` rather than from a `note` field at all
//
// So `normalizeUnsupported` is now a total mapping with no sniffing. The one piece of defensiveness
// that stays is the REGION, and for a concrete reason: `serializePick` refuses a PICK whose anomaly
// region is not a strictly positive 0-1 box, and the converter can legitimately report a
// zero-height region for e.g. a collapsed element. A converter-seeded anomaly must never be able to
// make the user's whole decision unwritable, so a degenerate box falls back to the whole slide.

import {
  convertHtmlToSlideRequests as convertWithRealConverter,
  describeUnsupportedFeature,
  type FractionalRegion,
  type UnsupportedFeature as ConverterUnsupportedFeature,
} from "../../converter/index.ts";
import type { ConversionSummary, ConvertForReport } from "./anonymise/index.ts";
import { WHOLE_SLIDE, isFractionalRegion, type Region } from "./protocol.ts";

/**
 * A Google Slides API request object, as the picker handles it. DELIBERATELY LOOSER than the
 * converter's own `SlidesApiRequest`, which is a fully typed discriminated union: the picker's
 * preview reads `request["insertText"]` reflectively (rendered-preview.ts) and `slide-insert.ts`
 * prepends a `createSlide` of its own, neither of which belongs in the converter's repertoire. The
 * narrowing goes the useful way -- a converter request is assignable to this, so nothing is lost
 * crossing the boundary, and the converter stays the only thing that knows the exact union.
 */
export type SlidesApiRequest = Readonly<Record<string, unknown>>;

/** Something the converter could not express in Slides, flattened for the picker and for PICK. */
export type UnsupportedFeature = Readonly<{
  /** The converter's `kind`. */
  feature: string;
  /** `describeUnsupportedFeature`'s sentence. */
  note: string;
  region: Region;
}>;

export type ConversionResult = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
}>;

/**
 * What the picker's composition root is given. Async, because the real converter is; the extra
 * machinery the converter needs (the extractor blob, the staging container) is closed over by
 * `browserSlideConverter` so nothing above this file has to know about it.
 */
export type ConvertSlideHtml = (
  spec: Readonly<{ html: string; presentationId: string; pageObjectId: string; objectIdPrefix: string }>,
) => Promise<ConversionResult>;

/**
 * The real converter, bound to one extractor blob and one staging container.
 *
 * `extractorScript` is the compiled `renderer/html2slides/extract-dom.ts` IIFE; the build inlines
 * it (see build-addon.ts) because it is a script, not a module. The converter runs it inside the
 * staging iframe with an eval-then-inline-`<script>` fallback, which is what makes it work under
 * the Slides sandbox's `unsafe-eval` ban (converter/convert-html-to-slide-requests.ts, lifted from
 * renderer/html2slides/browser/convert-core.ts:89-113).
 */
export function browserSlideConverter({
  extractorScript,
  container,
}: {
  extractorScript: string;
  container: HTMLElement;
}): ConvertSlideHtml {
  return async ({ html, presentationId, pageObjectId, objectIdPrefix }) => {
    const converted = await convertWithRealConverter({
      html,
      presentationId,
      pageObjectId,
      objectIdPrefix,
      extractorScript,
      container,
    });
    return { requests: converted.requests, unsupported: normalizeUnsupported(converted.unsupported) };
  };
}

/**
 * THE SAME CONVERTER, UNNARROWED, for the defect report.
 *
 * `previewDefectReport` takes a `convert` FUNCTION and calls it with the anonymised HTML itself --
 * that is what makes the payload's conversion provably the conversion of what the user approved --
 * and it wants the converter's OWN `ConversionSummary`, not the picker's flattened
 * `{ feature, note, region }`. So this factory hands back the raw result and nothing is normalised
 * away: a report is read by whoever maintains the converter, and `kind`, `elementType`, `domIndex`
 * and `fallback` are exactly what they need.
 *
 * It stays in THIS file so `mcp/sasha-slides/converter/` keeps exactly one import site in the
 * add-on, which is the reason this file exists at all (see the header).
 */
export function browserReportConverter({
  extractorScript,
  container,
  presentationId,
  pageObjectId,
  objectIdPrefix,
}: {
  extractorScript: string;
  container: HTMLElement;
  presentationId: string;
  pageObjectId: string;
  objectIdPrefix: string;
}): ConvertForReport {
  return async ({ html }): Promise<ConversionSummary> => {
    const converted = await convertWithRealConverter({
      html,
      presentationId,
      pageObjectId,
      objectIdPrefix,
      extractorScript,
      container,
    });
    return { requests: converted.requests, unsupported: converted.unsupported };
  };
}

/** The converter's losses as the picker's shape. Total: every variant maps, nothing is sniffed. */
export function normalizeUnsupported(
  raw: readonly ConverterUnsupportedFeature[],
): readonly UnsupportedFeature[] {
  return raw.map((feature) => ({
    feature: feature.kind,
    note: describeUnsupportedFeature(feature),
    region: pickerRegionOf(feature.region),
  }));
}

/**
 * A converter region as a region PICK will accept. See the header: a degenerate box would make
 * `serializePick` refuse the user's entire decision, so it widens to the whole slide instead.
 */
export function pickerRegionOf(region: FractionalRegion): Region {
  const candidate: Region = { x: region.x, y: region.y, w: region.w, h: region.h };
  return isFractionalRegion(candidate) ? candidate : WHOLE_SLIDE;
}

/** A synchronous converter, for the picker-state tests. Never wired into the sidebar. */
export type SyncSlideConverter = (
  spec: Readonly<{ html: string; presentationId: string; pageObjectId: string }>,
) => ConversionResult;

/**
 * TEST FIXTURE. It produces ONE full-slide text box plus one unsupported entry, which is what lets
 * the reducer tests assert "a converter loss becomes an anomaly the user can comment on" and "the
 * converted view draws one box per request" without staging an iframe. The real converter is async
 * and needs a DOM, so it cannot stand in here.
 */
export function stubConvertHtmlToSlideRequests(): SyncSlideConverter {
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
          note: "a test fixture stood in for mcp/sasha-slides/converter/; nothing was really converted.",
          region: WHOLE_SLIDE,
        },
      ],
    };
  };
}
