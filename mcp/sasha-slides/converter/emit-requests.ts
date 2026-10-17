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
 *
 * Pictures of visuals (`visualRasters`) are drawn by the caller that owns the
 * DOM and handed in finished, so this stage stays DOM-free.
 */
import type { DrawioExtraction, ParsedExtraction, SlideElement } from "./extraction.js";
import { DEFAULT_PAGE_SIZE_EMU, DEFAULT_TEXT_INSET_EMU, pageScaleFor } from "./geometry.js";
import type { SlidePageSizeEmu, TextInsetEmu } from "./geometry.js";
import type { SlidesApiRequest } from "./slides-api.js";
import type { ElementEmission, EmitContext } from "./emit-context.js";
import { createObjectIdAllocator, featureSite, mergeEmissions } from "./emit-context.js";
import { emitImage, emitLine, emitPoly, emitRect, emitTriangle, emitVisual } from "./emit-shape.js";
import type { VisualRaster } from "./emit-shape.js";
import { diagramIdForSource, diagramVersionOf, drawioAltText } from "./drawio-diagram.js";
import { emitList, emitText } from "./emit-text.js";
import { emitTable } from "./emit-table.js";
import type { UnsupportedFeature } from "./unsupported-feature.js";
import { assertNever } from "../engine/src/contracts/assert-never.js";

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
  /**
   * Pictures of the `visual` elements, by `paintIndex`. A visual missing from the map emits
   * nothing and is reported `omitted`, as it was before rasterising existed.
   */
  visualRasters?: ReadonlyMap<number, VisualRaster>;
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
  /** The slide's draw.io diagram, once its picture was placed and stamped; empty otherwise. */
  drawioDiagrams: readonly ConvertedDiagram[];
}>;

/**
 * A draw.io diagram on the converted slide: the picture's object id (as emitted, before any host
 * renames ids), its stamp and its source. The host writes the source to Drive after the insert
 * (sasha_slides/slide/<presentationId>/drawio/<diagramId>.drawio) and links the picture to it
 * (drawio-save-plan.ts diagramLinkRequests).
 */
export type ConvertedDiagram = Readonly<{ objectId: string; diagramId: string; version: string; xml: string }>;

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
  const drawioDiagrams: ConvertedDiagram[] = [];
  const rasters = options.visualRasters ?? NO_RASTERS;
  for (const element of extraction.elements) {
    const plain = emitElement({ element, context, viewportPx: extraction.viewportPx, rasters });
    const drawio = extraction.drawio ?? null;
    const paired = drawio !== null && drawio.pairedPaintIndex === element.paintIndex ? drawio : null;
    const diagram = paired === null ? null : diagramEmission({ emission: plain, drawio: paired, element, viewportPx: extraction.viewportPx });
    const emission = diagram === null ? plain : diagram.emission;
    if (diagram !== null && diagram.diagram !== null) drawioDiagrams.push(diagram.diagram);
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
    drawioDiagrams,
  };
}

const NO_RASTERS: ReadonlyMap<number, VisualRaster> = new Map();

/**
 * The paired element's emission with the draw.io outcome folded in: a valid source stamps the
 * picture; an invalid one leaves the picture as a plain picture and reports why, over it.
 */
function diagramEmission(
  options: Readonly<{
    emission: ElementEmission;
    drawio: DrawioExtraction;
    element: SlideElement;
    viewportPx: ParsedExtraction["viewportPx"];
  }>,
): Readonly<{ emission: ElementEmission; diagram: ConvertedDiagram | null }> | null {
  const { emission, drawio, element, viewportPx } = options;
  switch (drawio.kind) {
    case "valid":
      return stampDiagram({ emission, xml: drawio.xml });
    case "invalid":
      return {
        emission: {
          requests: emission.requests,
          unsupported: [
            ...emission.unsupported,
            {
              ...featureSite({ bounds: element.bounds, viewportPx, elementType: "drawio", domIndex: element.domIndex }),
              kind: "drawio-source-invalid",
              fallback: "rasterised",
              reason: drawio.reason,
            },
          ],
        },
        diagram: null,
      };
    default:
      return assertNever(drawio);
  }
}

/**
 * The diagram's picture gets the `drawio:<id>;v=<version>` alternative text right after its
 * `createImage`, in the same element group so a merge stacks it with the picture. Null when the
 * paired element placed no picture (its raster failed, or its source was unusable): there is then
 * nothing to stamp, and the loss is already reported by that element.
 */
function stampDiagram(
  options: Readonly<{ emission: ElementEmission; xml: string }>,
): Readonly<{ emission: ElementEmission; diagram: ConvertedDiagram }> | null {
  const { emission, xml } = options;
  const at = emission.requests.findIndex((request) => "createImage" in request);
  const create = emission.requests[at];
  if (create === undefined || !("createImage" in create)) return null;
  const objectId = create.createImage.objectId;
  const diagram: ConvertedDiagram = { objectId, diagramId: diagramIdForSource(xml), version: diagramVersionOf(xml), xml };
  const stamp: SlidesApiRequest = {
    updatePageElementAltText: {
      objectId,
      description: drawioAltText({ diagramId: diagram.diagramId, version: diagram.version }),
    },
  };
  return {
    emission: {
      requests: [...emission.requests.slice(0, at + 1), stamp, ...emission.requests.slice(at + 1)],
      unsupported: emission.unsupported,
    },
    diagram,
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
    rasters: ReadonlyMap<number, VisualRaster>;
  }>,
): ElementEmission {
  const { element, context, viewportPx, rasters } = options;
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
      return emitVisual({ element, context, viewportPx, raster: rasters.get(element.paintIndex) ?? null });
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
