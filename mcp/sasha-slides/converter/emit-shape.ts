/**
 * emit-shape.ts — the box family: rectangles, triangles, images, lines,
 * polygons and bitmap-only visuals.
 *
 * Also home to `shapePropertiesFor` and `reportBoxDecoration`, because
 * `extract-dom.ts:358-368` shares its fill/border/radius/shadow fields between
 * `rect` and `text` elements, so the text emitter needs the same two functions.
 */
import type {
  Border,
  BorderSideName,
  BoundsPx,
  BoxDecoration,
  ImageElement,
  LineElement,
  Paint,
  PolyElement,
  RectElement,
  SizePx,
  TriangleElement,
  VisualElement,
} from "./extraction.js";
import { emu, emuSize, placeBox, placeRotatedBox } from "./geometry.js";
import type { PageScale } from "./geometry.js";
import type {
  ContentAlignment,
  PageElementProperties,
  ShapeProperties,
  ShapeType,
  SlidesApiRequest,
} from "./slides-api.js";
import { dashStyleFromCss, flattenGradient, solidFillFromPaint } from "./slides-paint.js";
import type { ElementEmission, EmitContext } from "./emit-context.js";
import { EMPTY_EMISSION, featureSite } from "./emit-context.js";
import { STAGED_IMAGE_FIELD, slideImageSourceFor } from "./slide-image.js";
import type { UnsupportedFeature } from "./unsupported-feature.js";

export function emitRect(
  options: Readonly<{ element: RectElement; context: EmitContext; viewportPx: SizePx }>,
): ElementEmission {
  const { element, context, viewportPx } = options;
  const { decoration, bounds } = element;

  // A box with neither a fill nor a border paints nothing; emitting it would
  // add an invisible, selectable shape over the slide for the user to trip on.
  if (!decorationPaintsSomething(decoration)) {
    return { requests: [], unsupported: reportBoxDecoration({ element, viewportPx }) };
  }

  const objectId = context.ids.next("rect");
  const shapeType = shapeTypeForRect(decoration, bounds);
  const borderAsLines = decoration.border !== null && !decoration.border.uniform;
  const properties = shapePropertiesFor({
    decoration,
    // A non-uniform border is drawn as separate lines instead, so the shape
    // itself must not also carry a (wrong, uniform) outline.
    suppressOutline: borderAsLines,
    contentAlignment: null,
    includeAutofit: false,
  });

  const requests: SlidesApiRequest[] = [
    { createShape: { objectId, shapeType, elementProperties: placeElement({ element, context }) } },
  ];
  const update = updateShapePropertiesRequest({ objectId, built: properties });
  if (update !== null) requests.push(update);
  if (borderAsLines && decoration.border !== null) {
    requests.push(...emitBorderEdgeLines({ bounds, border: decoration.border, context }));
  }
  return { requests, unsupported: reportBoxDecoration({ element, viewportPx }) };
}

export function emitTriangle(
  options: Readonly<{ element: TriangleElement; context: EmitContext; viewportPx: SizePx }>,
): ElementEmission {
  const { element, context, viewportPx } = options;
  const objectId = context.ids.next("tri");
  const properties = shapePropertiesFor({
    decoration: element.decoration,
    suppressOutline: false,
    contentAlignment: null,
    includeAutofit: false,
  });
  const update = updateShapePropertiesRequest({ objectId, built: properties });
  return {
    requests: [
      {
        createShape: {
          objectId,
          shapeType: "TRIANGLE",
          elementProperties: placeElement({ element, context }),
        },
      },
      ...(update === null ? [] : [update]),
    ],
    unsupported: reportBoxDecoration({ element, viewportPx }),
  };
}

/**
 * Images are placed by URL, and Slides fetches that URL from its own servers.
 * A candidate slide is self-contained, so its pictures are `data:` URIs with
 * nothing to fetch — `slide-image.ts` decides how each one travels (inline
 * inside the URL, staged on Drive by the host, or reported as a loss) and this
 * function only turns that decision into requests.
 */
export function emitImage(
  options: Readonly<{ element: ImageElement; context: EmitContext; viewportPx: SizePx }>,
): ElementEmission {
  const { element, context, viewportPx } = options;
  const site = featureSite({
    bounds: element.bounds,
    viewportPx,
    elementType: "image",
    domIndex: element.domIndex,
  });
  // Allocated before the decision, not after, so that an image which cannot be
  // carried still consumes its id: the ids of everything after it then do not
  // depend on whether a picture happened to be loadable.
  const objectId = context.ids.next("img");
  const source = slideImageSourceFor({ src: element.src, objectId });

  switch (source.kind) {
    case "unusable":
      return {
        requests: [],
        unsupported: [
          { ...site, kind: "image-source-not-fetchable", fallback: "omitted", scheme: source.scheme },
        ],
      };
    case "too-large":
      return {
        requests: [],
        unsupported: [
          {
            ...site,
            kind: "image-too-large",
            fallback: "omitted",
            bytes: source.bytes,
            limitBytes: source.limitBytes,
          },
        ],
      };
    case "fetchable":
    case "inline":
      return {
        requests: [
          {
            createImage: {
              objectId,
              url: source.url,
              elementProperties: placeElement({ element, context }),
            },
          },
          ...imageOutlineRequests({ objectId, border: element.border }),
        ],
        unsupported: cornerRadiusReport({ element, site }),
      };
    case "staged":
      return {
        requests: [
          {
            createImage: {
              objectId,
              url: source.url,
              elementProperties: placeElement({ element, context }),
            },
            [STAGED_IMAGE_FIELD]: source.upload,
          },
          ...imageOutlineRequests({ objectId, border: element.border }),
        ],
        unsupported: cornerRadiusReport({ element, site }),
      };
    default:
      return assertNeverImageSource(source);
  }
}

export function emitLine(
  options: Readonly<{ element: LineElement; context: EmitContext }>,
): ElementEmission {
  const { element, context } = options;
  const objectId = context.ids.next("line");
  return {
    requests: [
      {
        createLine: {
          objectId,
          lineCategory: "STRAIGHT",
          elementProperties: placeLine({
            x1: element.x1,
            y1: element.y1,
            x2: element.x2,
            y2: element.y2,
            context,
          }),
        },
      },
      {
        updateLineProperties: {
          objectId,
          lineProperties: {
            ...(element.hex === null
              ? {}
              : { lineFill: { solidFill: solidFillFromPaint({ hex: element.hex, alpha: 1 }) } }),
            weight: { magnitude: Math.max(1, emu(element.strokeWidthPx, context.scale)), unit: "EMU" },
            dashStyle: dashStyleFromCss(element.dashType),
          },
          fields:
            element.hex === null
              ? "weight,dashStyle"
              : "lineFill.solidFill.color,weight,dashStyle",
        },
      },
    ],
    unsupported: [],
  };
}

/**
 * A `clip-path: polygon(...)` host. The pptx path emitted OOXML `custGeom` for
 * these; `batchUpdate` has no custom-geometry request at all, and no preset is
 * close enough to be worth a wrong shape, so it is reported and skipped.
 */
export function emitPoly(
  options: Readonly<{ element: PolyElement; viewportPx: SizePx }>,
): ElementEmission {
  const { element, viewportPx } = options;
  return {
    requests: [],
    unsupported: [
      {
        ...featureSite({
          bounds: element.bounds,
          viewportPx,
          elementType: "poly",
          domIndex: element.domIndex,
        }),
        kind: "clip-path-polygon",
        fallback: "omitted",
        pointCount: element.points.length,
      },
    ],
  };
}

/** `<svg>`, `<canvas>`, conic gradients: only a bitmap can carry these. */
export function emitVisual(
  options: Readonly<{ element: VisualElement; viewportPx: SizePx }>,
): ElementEmission {
  const { element, viewportPx } = options;
  return {
    requests: [],
    unsupported: [
      {
        ...featureSite({
          bounds: element.bounds,
          viewportPx,
          elementType: "visual",
          domIndex: element.domIndex,
        }),
        kind: "rasterised-visual",
        fallback: "needs-raster",
        tag: element.tag,
      },
    ],
  };
}

/**
 * Fill, outline and text behaviour for one box, with the matching field mask.
 *
 * Shared with the text emitter. `suppressOutline` exists because a non-uniform
 * CSS border is drawn as four independent lines, and the shape must then not
 * also draw a uniform outline of its own.
 */
export function shapePropertiesFor(
  options: Readonly<{
    decoration: BoxDecoration;
    suppressOutline: boolean;
    contentAlignment: ContentAlignment | null;
    includeAutofit: boolean;
  }>,
): Readonly<{ properties: ShapeProperties; fields: string }> {
  const { decoration, suppressOutline, contentAlignment, includeAutofit } = options;
  const fields: string[] = [];
  let properties: ShapeProperties = {};

  const fillPaint = resolveFillPaint(decoration);
  if (fillPaint !== null) {
    properties = { ...properties, shapeBackgroundFill: { solidFill: solidFillFromPaint(fillPaint) } };
    fields.push("shapeBackgroundFill.solidFill.color", "shapeBackgroundFill.solidFill.alpha");
  }

  const border = suppressOutline ? null : decoration.border;
  if (border !== null && border.widthPx > 0) {
    properties = {
      ...properties,
      outline: {
        ...(border.hex === null
          ? {}
          : { outlineFill: { solidFill: solidFillFromPaint({ hex: border.hex, alpha: 1 }) } }),
        weight: { magnitude: Math.max(1, Math.round(border.widthPx * 9525)), unit: "EMU" },
        dashStyle: dashStyleFromCss(border.style),
      },
    };
    if (border.hex !== null) fields.push("outline.outlineFill.solidFill.color");
    fields.push("outline.weight", "outline.dashStyle");
  } else if (border === null && fillPaint !== null) {
    // A shape created from a preset inherits a theme outline; an HTML box with
    // no border must say so explicitly or it gains a stroke nothing asked for.
    properties = { ...properties, outline: { propertyState: "NOT_RENDERED" } };
    fields.push("outline.propertyState");
  }

  if (contentAlignment !== null) {
    properties = { ...properties, contentAlignment };
    fields.push("contentAlignment");
  }
  if (includeAutofit) {
    // Without this Slides rescales text to fit the box, silently discarding the
    // font sizes the HTML specified and the geometry the extractor measured.
    properties = { ...properties, autofit: { autofitType: "NONE" } };
    fields.push("autofit.autofitType");
  }
  return { properties, fields: fields.join(",") };
}

/**
 * `updateShapeProperties` for a built property set, or null when there is
 * nothing to set.
 *
 * An empty `fields` mask is not a harmless no-op: a field mask is what tells
 * Slides which properties to take from the payload, and sending an empty one
 * with an empty payload is at best rejected and at worst read as "reset". The
 * only way to never send one is to make the request itself optional, so every
 * call site goes through here rather than pushing the request directly.
 */
export function updateShapePropertiesRequest(
  options: Readonly<{ objectId: string; built: ReturnType<typeof shapePropertiesFor> }>,
): SlidesApiRequest | null {
  const { objectId, built } = options;
  if (built.fields.length === 0) return null;
  return {
    updateShapeProperties: { objectId, shapeProperties: built.properties, fields: built.fields },
  };
}

/** True when a box would paint something; an invisible box is not emitted. */
export function decorationPaintsSomething(decoration: BoxDecoration): boolean {
  return (
    decoration.fill !== null ||
    decoration.gradient !== null ||
    (decoration.border !== null && decoration.border.widthPx > 0)
  );
}

/**
 * Every loss carried by one box's decoration. Shared with the text emitter for
 * the same reason `shapePropertiesFor` is.
 */
export function reportBoxDecoration(
  options: Readonly<{
    element: Readonly<{
      kind: string;
      bounds: BoundsPx;
      domIndex: number | null;
      rotateDeg: number;
      naturalSizePx: SizePx | null;
      decoration: BoxDecoration;
    }>;
    viewportPx: SizePx;
  }>,
): readonly UnsupportedFeature[] {
  const { element, viewportPx } = options;
  const { decoration } = element;
  const site = featureSite({
    bounds: element.bounds,
    viewportPx,
    elementType: element.kind,
    domIndex: element.domIndex,
  });
  const reports: UnsupportedFeature[] = [];

  if (decoration.gradient !== null) {
    reports.push({
      ...site,
      kind: "gradient-fill",
      fallback: "solid-approximation",
      gradientType: decoration.gradient.type,
      approximatedAs: flattenGradient(decoration.gradient),
      stopCount: decoration.gradient.stops.length,
    });
  }
  if (decoration.shadow !== null) {
    reports.push({
      ...site,
      kind: "box-shadow",
      fallback: "omitted",
      ringCount: decoration.shadow.ringCount,
    });
  }
  const radii = decoration.cornerRadiiPx;
  if (radii.some((radius) => radius > 0) && shapeTypeForRect(decoration, element.bounds) !== "ELLIPSE") {
    reports.push({
      ...site,
      kind: "corner-radius-approximated",
      fallback: "preset-approximation",
      requestedRadiiPx: radii,
    });
  }
  if (decoration.border !== null && !decoration.border.uniform) {
    reports.push({
      ...site,
      kind: "non-uniform-border",
      fallback: "edge-lines",
      sides: paintedSides(decoration.border.sides),
    });
  }
  if (decoration.backgroundImage !== null) {
    reports.push({
      ...site,
      kind: "css-background-image",
      fallback: "omitted",
      cssValue: decoration.backgroundImage,
    });
  }
  return reports;
}

/**
 * Where the element goes, rotation included. Rotation needs the pre-transform
 * box, so an element reporting a rotation without one falls back to the
 * axis-aligned placement rather than guessing an extent.
 */
export function placeElement(
  options: Readonly<{
    element: Readonly<{
      bounds: BoundsPx;
      rotateDeg: number;
      naturalSizePx: SizePx | null;
    }>;
    context: EmitContext;
  }>,
): PageElementProperties {
  const { element, context } = options;
  const { rotateDeg, naturalSizePx, bounds } = element;
  if (Math.abs(rotateDeg) < 0.01 || naturalSizePx === null) {
    return placeBox({ bounds, pageObjectId: context.pageObjectId, scale: context.scale });
  }
  return placeRotatedBox({
    bounds,
    naturalSizePx,
    rotateDeg,
    pageObjectId: context.pageObjectId,
    scale: context.scale,
  });
}

/** Which preset a CSS box becomes, given its corner radii. */
export function shapeTypeForRect(decoration: BoxDecoration, bounds: BoundsPx): ShapeType {
  const radii = decoration.cornerRadiiPx;
  if (radii.every((radius) => radius <= 0)) return "RECTANGLE";
  // A radius at or past half the shorter edge on all four corners is a pill or
  // a circle; ELLIPSE reproduces the circle case exactly, which ROUND_RECTANGLE
  // cannot, and the circle case is common (avatars, step bullets, icon discs).
  const halfShortEdge = Math.min(bounds.w, bounds.h) / 2;
  const isCircle =
    Math.abs(bounds.w - bounds.h) <= 1 &&
    radii.every((radius) => radius >= halfShortEdge - 0.5);
  return isCircle ? "ELLIPSE" : "ROUND_RECTANGLE";
}

/**
 * The four sides of a non-uniform border as standalone LINE elements. This is
 * the same strategy `extract-dom.ts:1367` (`emitBorderLines`) uses for the pptx
 * path, moved to the emission side because a Slides outline has no per-side
 * form at all.
 */
function emitBorderEdgeLines(
  options: Readonly<{ bounds: BoundsPx; border: Border; context: EmitContext }>,
): readonly SlidesApiRequest[] {
  const { bounds, border, context } = options;
  const requests: SlidesApiRequest[] = [];
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  const edges: readonly Readonly<{
    name: BorderSideName;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }>[] = [
    { name: "top", x1: bounds.x, y1: bounds.y, x2: right, y2: bounds.y },
    { name: "right", x1: right, y1: bounds.y, x2: right, y2: bottom },
    { name: "bottom", x1: bounds.x, y1: bottom, x2: right, y2: bottom },
    { name: "left", x1: bounds.x, y1: bounds.y, x2: bounds.x, y2: bottom },
  ];

  for (const edge of edges) {
    const side = border.sides[edge.name];
    if (side.widthPx <= 0 || side.hex === null) continue;
    const objectId = context.ids.next(`edge${edge.name}`);
    requests.push({
      createLine: {
        objectId,
        lineCategory: "STRAIGHT",
        elementProperties: placeLine({ x1: edge.x1, y1: edge.y1, x2: edge.x2, y2: edge.y2, context }),
      },
    });
    requests.push({
      updateLineProperties: {
        objectId,
        lineProperties: {
          lineFill: { solidFill: solidFillFromPaint({ hex: side.hex, alpha: 1 }) },
          weight: { magnitude: Math.max(1, emu(side.widthPx, context.scale)), unit: "EMU" },
          dashStyle: dashStyleFromCss(side.style),
        },
        fields: "lineFill.solidFill.color,weight,dashStyle",
      },
    });
  }
  return requests;
}

/**
 * A LINE element is its bounding box's main diagonal. The anti-diagonal is
 * expressed by flipping the box horizontally (negative `scaleX` with the
 * translate moved to the box's right edge), which is why this cannot just use
 * `placeBox`.
 */
function placeLine(
  options: Readonly<{ x1: number; y1: number; x2: number; y2: number; context: EmitContext }>,
): PageElementProperties {
  const { x1, y1, x2, y2, context } = options;
  const scale: PageScale = context.scale;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const descending = (x2 - x1) * (y2 - y1) >= 0;
  const size = emuSize({ w: width, h: height }, scale);
  return {
    pageObjectId: context.pageObjectId,
    size,
    transform: {
      scaleX: descending ? 1 : -1,
      scaleY: 1,
      translateX: descending ? emu(left, scale) : emu(left, scale) + size.width.magnitude,
      translateY: emu(top, scale),
      unit: "EMU",
    },
  };
}

/**
 * The colour a shape fill gets: the solid fill when there is one, otherwise the
 * gradient flattened to a single colour. Reported as an anomaly either way by
 * `reportBoxDecoration`.
 */
function resolveFillPaint(decoration: BoxDecoration): Paint | null {
  if (decoration.fill !== null) return decoration.fill;
  if (decoration.gradient !== null) {
    const stops = decoration.gradient.stops;
    // SAFETY: parseGradient returns null for an empty stop list.
    const alpha = stops.reduce((total, stop) => total + stop.alpha, 0) / stops.length;
    return { hex: flattenGradient(decoration.gradient), alpha };
  }
  return null;
}

function paintedSides(sides: Border["sides"]): readonly BorderSideName[] {
  const names: readonly BorderSideName[] = ["top", "right", "bottom", "left"];
  return names.filter((name) => sides[name].widthPx > 0);
}

/**
 * An image's rounded corners, which no delivery route recovers: `createImage`
 * places a rectangle and there is no crop or mask request to follow it with.
 * The same report whether the bytes travelled inline or through Drive.
 */
function cornerRadiusReport(
  options: Readonly<{ element: ImageElement; site: ReturnType<typeof featureSite> }>,
): readonly UnsupportedFeature[] {
  const { element, site } = options;
  if (element.cornerRadiusPx <= 0) return [];
  return [
    {
      ...site,
      kind: "image-corner-radius",
      fallback: "geometry-floor",
      radiusPx: element.cornerRadiusPx,
    },
  ];
}

function assertNeverImageSource(source: never): never {
  throw new Error(`Unhandled image source: ${JSON.stringify(source)}`);
}

/** Re-exported so the orchestrator can skip elements with nothing to emit. */
export { EMPTY_EMISSION };

/**
 * An image's CSS border, as a Slides image OUTLINE.
 *
 * `ImageProperties.outline` is the same shape a shape's outline is, so a plain border carries
 * across exactly. It was not emitted at all: the picture arrived with no edge, which on a dark
 * slide reads as the image bleeding into the background.
 *
 * ONLY A UNIFORM BORDER. An outline is one stroke around the whole picture, so per-side widths
 * or colours cannot be expressed; a non-uniform border is left to `cornerRadiusReport`'s
 * neighbour, `nonUniformBorderReport`, rather than silently rendered as the wrong thing.
 */
function imageOutlineRequests(
  options: Readonly<{ objectId: string; border: Border | null }>,
): readonly SlidesApiRequest[] {
  const { objectId, border } = options;
  if (border === null || border.widthPx <= 0 || !border.uniform) return [];
  return [
    {
      updateImageProperties: {
        objectId,
        imageProperties: {
          outline: {
            ...(border.hex === null
              ? {}
              : { outlineFill: { solidFill: solidFillFromPaint({ hex: border.hex, alpha: 1 }) } }),
            weight: { magnitude: Math.max(1, Math.round(border.widthPx * 9525)), unit: "EMU" as const },
            dashStyle: dashStyleFromCss(border.style),
          },
        },
        fields:
          border.hex === null
            ? "outline.weight,outline.dashStyle"
            : "outline.outlineFill.solidFill.color,outline.weight,outline.dashStyle",
      },
    },
  ];
}
