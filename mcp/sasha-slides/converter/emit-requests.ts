/**
 * emit-requests.ts — the layout model to a `presentations.batchUpdate` body.
 *
 * Pure and synchronous: no DOM, no network, no clock. Everything DOM-shaped
 * happened in the extraction stage, which means this stage can be unit-tested
 * against a recorded extraction and is the half that is cheap to reason about.
 *
 * Elements are emitted in the extractor's CSS paint order. Slides stacks page
 * elements by creation order, so paint order IS z-order and no explicit
 * reordering request is needed.
 */
import type { ParsedExtraction, SlideElement } from "./extraction.js";
import { DEFAULT_PAGE_SIZE_EMU, DEFAULT_TEXT_INSET_EMU, pageScaleFor } from "./geometry.js";
import type { SlidePageSizeEmu, TextInsetEmu } from "./geometry.js";
import type { SlidesApiRequest } from "./slides-api.js";
import type { ElementEmission, EmitContext } from "./emit-context.js";
import { createObjectIdAllocator, featureSite, mergeEmissions } from "./emit-context.js";
import { emitImage, emitLine, emitPoly, emitRect, emitTriangle, emitVisual } from "./emit-shape.js";
import { emitList, emitText } from "./emit-text.js";
import { emitTable } from "./emit-table.js";
import type { UnsupportedFeature } from "./unsupported-feature.js";

export type EmitOptions = Readonly<{
  extraction: ParsedExtraction;
  /** The slide to add elements to — `presentations.get` reports page object ids. */
  pageObjectId: string;
  /**
   * Prefix for every generated object id, unique per conversion within the
   * presentation. The proposal id from PROTOCOL.md is the natural choice.
   */
  objectIdPrefix: string;
  /** Defaults to Google's 16:9 page (10in x 5.625in). */
  pageSizeEmu?: SlidePageSizeEmu;
  /** Override once a credentialed round-trip has measured the real insets. */
  textInsetEmu?: TextInsetEmu;
}>;

export type ConversionResult = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
  /** Elements the extractor produced, including ones that emitted nothing. */
  elementCount: number;
  /**
   * The same `requests`, grouped by the extracted element that emitted them, in paint order, each
   * with its stacking z-index. Concatenating every group's requests gives `requests` exactly.
   * Elements that emitted nothing are left out.
   *
   * What a MERGE needs and an insert does not: a merge adds new elements to an EXISTING slide,
   * and each new element goes behind or in front of what is already there by its top-level box's
   * CSS z-index (mcp/sasha-slides PROTOCOL.md "Merge proposals").
   */
  stackedElements: readonly StackedElement[];
}>;

/** One extracted element's requests and the z-index it stacks at in the root stacking context. */
export type StackedElement = Readonly<{
  /** The top-level box's computed z-index; `auto` (null in the extraction) is 0. */
  zIndex: number;
  requests: readonly SlidesApiRequest[];
}>;

export function emitSlideRequests(options: EmitOptions): ConversionResult {
  const { extraction, pageObjectId, objectIdPrefix } = options;
  const pageSizeEmu = options.pageSizeEmu ?? DEFAULT_PAGE_SIZE_EMU;
  const context: EmitContext = {
    pageObjectId,
    scale: pageScaleFor({ viewportPx: extraction.viewportPx, pageSizeEmu }),
    ids: createObjectIdAllocator(objectIdPrefix),
    textInsetEmu: options.textInsetEmu ?? DEFAULT_TEXT_INSET_EMU,
  };

  const parts: ElementEmission[] = [];
  const stackedElements: StackedElement[] = [];
  for (const element of extraction.elements) {
    const emission = emitElement({ element, context, viewportPx: extraction.viewportPx });
    parts.push(emission);
    if (emission.requests.length > 0) {
      stackedElements.push({ zIndex: element.stackZ ?? 0, requests: emission.requests });
    }
  }
  const merged = mergeEmissions(parts);
  return {
    requests: merged.requests,
    unsupported: merged.unsupported,
    elementCount: extraction.elements.length,
    stackedElements,
  };
}

/**
 * The single dispatch point. The `default` arm calls `assertNever`, so adding a
 * variant to `SlideElement` is a compile error here until it has a mapping —
 * which is the property that keeps `unsupported` honest as the extractor grows.
 */
function emitElement(
  options: Readonly<{
    element: SlideElement;
    context: EmitContext;
    viewportPx: ParsedExtraction["viewportPx"];
  }>,
): ElementEmission {
  const { element, context, viewportPx } = options;
  switch (element.kind) {
    case "rect":
      return emitRect({ element, context, viewportPx });
    case "text":
      return emitText({ element, context, viewportPx });
    case "list":
      return emitList({ element, context, viewportPx });
    case "table":
      return emitTable({ element, context, viewportPx });
    case "image":
      return emitImage({ element, context, viewportPx });
    case "visual":
      return emitVisual({ element, viewportPx });
    case "line":
      return emitLine({ element, context });
    case "triangle":
      return emitTriangle({ element, context, viewportPx });
    case "poly":
      return emitPoly({ element, viewportPx });
    case "ignored":
      return emitIgnored({ element, viewportPx });
    default:
      return assertNever(element);
  }
}

/**
 * `br` and `_skip` are the extractor's own sentinels and are expected to
 * produce nothing. An `unknown` type means the extractor grew a variant this
 * emitter has not mapped, which must reach the user rather than vanish.
 */
function emitIgnored(
  options: Readonly<{
    element: Extract<SlideElement, { kind: "ignored" }>;
    viewportPx: ParsedExtraction["viewportPx"];
  }>,
): ElementEmission {
  const { element, viewportPx } = options;
  switch (element.reason) {
    case "br":
    case "skip":
      return { requests: [], unsupported: [] };
    case "unknown":
      return {
        requests: [],
        unsupported: [
          {
            ...featureSite({
              bounds: element.bounds,
              viewportPx,
              elementType: element.originalType,
              domIndex: element.domIndex,
            }),
            kind: "unmapped-element",
            fallback: "omitted",
          },
        ],
      };
    default:
      return assertNever(element.reason);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled element: ${JSON.stringify(value)}`);
}
