/**
 * unsupported-feature.ts — the anomaly vocabulary.
 *
 * PROTOCOL.md's rule is "the HTML is authoritative, the rendered slide is a
 * lossy projection of it". This file enumerates the losses. Every one carries a
 * fractional region so the toggle UI can point at the exact spot on the slide
 * without knowing anything about pixels or EMU, matching the `region` shape of
 * a `PICK` anomaly (PROTOCOL.md: `{ x, y, w, h }`, 0–1 over 1280x720).
 *
 * The union is tagged on `kind` and consumed through an exhaustive switch in
 * `describeUnsupportedFeature`, so adding a loss is a compile error until it
 * has a human-readable sentence for the UI.
 */

/** 0–1 relative to the slide box, so it survives any scaling. */
export type FractionalRegion = Readonly<{
  x: number;
  y: number;
  w: number;
  h: number;
}>;

/**
 * What the emitter did instead. `omitted` is the only value that means nothing
 * at all reached the slide; everything else means a visible-but-different
 * element exists, which the UI should outline rather than flag as missing.
 */
export type UnsupportedFallback =
  | "omitted"
  | "solid-approximation"
  | "preset-approximation"
  | "edge-lines"
  | "geometry-floor"
  | "font-substituted"
  | "needs-raster";

type FeatureSite = Readonly<{
  /** Where on the slide, for the anomaly overlay. */
  region: FractionalRegion;
  /** `ExtractedElement.type` that produced the loss, for debugging. */
  elementType: string;
  /** `_domIdx` from the extractor when present — lets the UI cross-link to the HTML. */
  domIndex: number | null;
}>;

export type UnsupportedFeature =
  /** CSS gradient background; Slides shape fill is solid-only. */
  | (FeatureSite &
      Readonly<{
        kind: "gradient-fill";
        fallback: "solid-approximation";
        gradientType: "linear" | "radial";
        /** The flat colour emitted in its place, as `#rrggbb`. */
        approximatedAs: string;
        stopCount: number;
      }>)
  /** `ShapeProperties.shadow` is documented read-only, so no shadow can be written. */
  | (FeatureSite &
      Readonly<{
        kind: "box-shadow";
        fallback: "omitted";
        /** Extra spread-only halo layers the renderer would have had to fake. */
        ringCount: number;
      }>)
  /** `ROUND_RECTANGLE` has a fixed preset radius; the API exposes no adjust handle. */
  | (FeatureSite &
      Readonly<{
        kind: "corner-radius-approximated";
        fallback: "preset-approximation";
        /** Requested radii in CSS px, clockwise from top-left. */
        requestedRadiiPx: readonly [number, number, number, number];
      }>)
  /** `Outline` is one weight/colour for the whole shape. */
  | (FeatureSite &
      Readonly<{
        kind: "non-uniform-border";
        fallback: "edge-lines";
        /** Which sides became standalone LINE elements. */
        sides: readonly ("top" | "right" | "bottom" | "left")[];
      }>)
  /** `background-image` on a box: no picture fill exists in ShapeBackgroundFill. */
  | (FeatureSite &
      Readonly<{
        kind: "css-background-image";
        fallback: "omitted";
        cssValue: string;
      }>)
  /** `clip-path: polygon(...)`: the API has no custom geometry request. */
  | (FeatureSite &
      Readonly<{
        kind: "clip-path-polygon";
        fallback: "omitted";
        pointCount: number;
      }>)
  /** `<svg>`, `<canvas>`, conic gradients — only a bitmap can carry these. */
  | (FeatureSite &
      Readonly<{
        kind: "rasterised-visual";
        fallback: "needs-raster";
        tag: string;
      }>)
  /**
   * `createImage.url` is fetched server-side, so a source whose bytes are not
   * in the document and not on the public web has nothing to fetch: `blob:`, a
   * relative path, an empty `src`. A `data:` source reaches here only when it
   * is not a base64 PNG/JPEG/GIF — slide-image.ts stages the ones that are.
   */
  | (FeatureSite &
      Readonly<{
        kind: "image-source-not-fetchable";
        fallback: "omitted";
        scheme: string;
      }>)
  /** Past `createImage`'s own documented ceiling, so no delivery route exists. */
  | (FeatureSite &
      Readonly<{
        kind: "image-too-large";
        fallback: "omitted";
        bytes: number;
        limitBytes: number;
      }>)
  /** An image cannot be given rounded corners through the API. */
  | (FeatureSite &
      Readonly<{
        kind: "image-corner-radius";
        fallback: "geometry-floor";
        radiusPx: number;
      }>)
  /** The CSS stack named nothing Slides can resolve server-side. */
  | (FeatureSite &
      Readonly<{
        kind: "font-unavailable";
        fallback: "font-substituted";
        requested: string;
        substituted: string;
      }>)
  /** `TextStyle` has no letter-spacing field. */
  | (FeatureSite &
      Readonly<{
        kind: "letter-spacing";
        fallback: "omitted";
        trackingPx: number;
      }>)
  /** Vertical/sideways text has no Slides equivalent. */
  | (FeatureSite &
      Readonly<{
        kind: "vertical-writing-mode";
        fallback: "omitted";
        cssValue: string;
      }>)
  /** A CSS-drawn or `content:`-supplied marker, replaced by the nearest preset. */
  | (FeatureSite &
      Readonly<{
        kind: "list-marker-approximated";
        fallback: "preset-approximation";
        requestedMarker: string;
        preset: string;
      }>)
  /**
   * The measured row-height law (CLAUDE.md) says Slides will render this row
   * TALLER than the HTML measured it, because the font/padding floor exceeds
   * the specified height. `minRowHeight` cannot shrink a row below that floor.
   */
  | (FeatureSite &
      Readonly<{
        kind: "table-row-height-floor";
        fallback: "geometry-floor";
        rowIndex: number;
        measuredPx: number;
        predictedPx: number;
      }>)
  /** Rotation is expressible in the affine transform; shear and 3-D are not. */
  | (FeatureSite &
      Readonly<{
        kind: "unsupported-transform";
        fallback: "omitted";
        cssValue: string;
      }>)
  /** An element type the emitter has no mapping for at all. */
  | (FeatureSite &
      Readonly<{
        kind: "unmapped-element";
        fallback: "omitted";
      }>);

/** One sentence per loss, for the anomaly list in the picker. */
export function describeUnsupportedFeature(feature: UnsupportedFeature): string {
  switch (feature.kind) {
    case "gradient-fill":
      return `${feature.gradientType} gradient (${feature.stopCount} stops) flattened to ${feature.approximatedAs} — Slides shape fills are solid only`;
    case "box-shadow":
      return feature.ringCount > 0
        ? `drop shadow and ${feature.ringCount} halo ring(s) dropped — the Slides API exposes shadows as read-only`
        : "drop shadow dropped — the Slides API exposes shadows as read-only";
    case "corner-radius-approximated":
      return `corner radii ${feature.requestedRadiiPx.join("/")}px replaced by the fixed ROUND_RECTANGLE preset — the API has no radius control`;
    case "non-uniform-border":
      return `per-side border (${feature.sides.join(", ")}) drawn as separate lines — a Slides outline is uniform on all four sides`;
    case "css-background-image":
      return `background-image dropped (${feature.cssValue}) — a shape fill cannot hold a picture`;
    case "clip-path-polygon":
      return `clip-path polygon with ${feature.pointCount} points dropped — the API has no custom geometry`;
    case "rasterised-visual":
      return `<${feature.tag}> needs a bitmap: no native Slides element can express it`;
    case "image-source-not-fetchable":
      return `image skipped: Slides fetches image URLs server-side and cannot read a "${feature.scheme}" source`;
    case "image-too-large":
      return `image skipped: ${Math.round(feature.bytes / (1024 * 1024))}MB is past the ${Math.round(feature.limitBytes / (1024 * 1024))}MB Slides accepts for one picture`;
    case "image-corner-radius":
      return `image corner radius ${feature.radiusPx}px lost — images are placed as rectangles`;
    case "font-unavailable":
      return `font "${feature.requested}" is not resolvable in Slides; substituted "${feature.substituted}"`;
    case "letter-spacing":
      return `letter-spacing ${feature.trackingPx}px dropped — Slides text style has no tracking field`;
    case "vertical-writing-mode":
      return `vertical text (${feature.cssValue}) dropped — Slides has no writing-mode equivalent`;
    case "list-marker-approximated":
      return `list marker "${feature.requestedMarker}" replaced by the ${feature.preset} preset — custom glyphs are not settable`;
    case "table-row-height-floor":
      return `table row ${feature.rowIndex + 1} will render ~${Math.round(feature.predictedPx - feature.measuredPx)}px taller than the HTML (${Math.round(feature.measuredPx)}px): its font and padding set a ${Math.round(feature.predictedPx)}px floor`;
    case "unsupported-transform":
      return `transform "${feature.cssValue}" dropped — only rotation survives the affine transform`;
    case "unmapped-element":
      return `${feature.elementType} element has no Slides mapping and was skipped`;
    default:
      return assertNever(feature);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled unsupported-feature kind: ${JSON.stringify(value)}`);
}
