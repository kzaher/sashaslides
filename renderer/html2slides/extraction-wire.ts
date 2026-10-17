/**
 * extraction-wire.ts — the extraction wire format: the JSON `extract-dom.ts` emits and every
 * converter reads. TYPES ONLY, declared once.
 *
 * `extract-dom.ts` is injected into Chrome as a bare script and cannot import at runtime, but it
 * `import type`s these declarations: esbuild's transformSync erases type-only imports, so the
 * injected script is unchanged. This is the PRODUCER's view (mutable, one permissive element
 * shape); `convert-pptx-lib.ts` keeps its narrowed, readonly consumer view and proves at compile
 * time that every field it reads is declared here (its "wire drift guards"), so a field read by
 * the converter but never emitted by the extractor fails the type check instead of silently
 * reading `undefined`.
 */

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Per-corner border radius values [top-left, top-right, bottom-right, bottom-left]
export interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

// Per-side border info
export interface BorderSides {
  top: { width: number; color: string | null; style: string };
  right: { width: number; color: string | null; style: string };
  bottom: { width: number; color: string | null; style: string };
  left: { width: number; color: string | null; style: string };
}

// Active clipping region propagated from an ancestor with
// `overflow:hidden|clip|auto|scroll` and any non-zero border-radius.
// `bounds` is the inner content rect that the ancestor visually clips at.
// `cornerRadii` are the rounded-corner radii in CSS px, capped to half-edge.
// The emitter compares each emitted element's bounds to this mask: when the
// intersection differs (epsilon-aware), it adds an underlay patch shape and
// groups it with the element so re-size in Slides keeps them together.
export interface ClipMask {
  bounds: Bounds;
  cornerRadii: CornerRadii;
  // True when the clipping ancestor itself is rasterised to a 2× PNG (the
  // large-radius `clipped-container` device-mockup branch below). Children
  // whose clipped region needs a corner radius > 50% of its own dimension
  // can't be reproduced by a native roundRect (the OOXML `adj` maxes at 50%);
  // because a correctly-rounded backing image already exists, the emitter
  // skips the clamped native overlay for those corners instead of poking a
  // squared-off shape past the device's true rounded edge.
  rasterizedHost?: boolean;
  // Absolute y (extraction px) where the rasterised top strip ends. Only the
  // dark top region (status bar + notch + rounded top corners) is rasterised;
  // child fills fully above this line are painted by the PNG and skipped, while
  // everything below renders as native shapes. Undefined when the whole
  // container is rasterised (no distinct bottom region).
  rasterBottomY?: number;
}

export interface ElementStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: "bold" | "normal";
  fontStyle: "italic" | "normal";
  color: string | null;
  bgColor: string | null;
  bgAlpha: number;
  textAlign: string;
  lineHeight: number;
  // True when lineHeight is the MEASURED median line pitch (inline children
  // inflated the line boxes beyond the CSS spec) rather than the CSS value —
  // the converter emits absolute <a:spcPts> line spacing for measured pitches.
  lineHeightMeasured?: boolean;
  // Chrome's FIRST-LINE BASELINE (client y) and the largest baseline-aligned font size on that line.
  // Google Slides places a top-anchored line by its own fixed offset, not the CSS half-leading or
  // the family's ascent, so the converter turns these into the inset that lands Google's baseline
  // here (slides-first-baseline.ts).
  firstBaselineY?: number;
  firstLineFontSize?: number;
  textDecoration: string | null;
  textTransform: string | null;
  letterSpacing: number;
  writingMode: string | null;
  // Uniform border (convenience — max of all sides)
  borderColor: string | null;
  borderWidth: number;
  borderRadius: number;
  borderStyle: string;
  // Per-side borders
  borderTop: number;
  borderTopColor: string | null;
  borderBottom: number;
  borderBottomColor: string | null;
  borderLeft: number;
  borderLeftColor: string | null;
  borderRight: number;
  borderRightColor: string | null;
  // Per-corner radii
  cornerRadii: CornerRadii;
  // Border uniformity flags (for choosing rendering strategy)
  borderUniform: boolean; // true if all 4 sides have same width & color
  borderSides: BorderSides;
  opacity: number;
  // Nearest ancestor solid background, sampled only for a semi-transparent text element: Google
  // Slides drops <a:alpha> on text fills, so the converter blends the colour against this instead.
  bgColorBehind?: string;
  display: string;
  overflow: string;
  justifyContent: string;
  alignItems: string;
  backgroundImage: string | null;
  clipPath: string | null;
  // null means CSS `z-index: auto` (inherit stacking context) — distinct from
  // an explicit `0`. See the extraction comment in getStyle.
  zIndex: number | null;
  // Padding carried onto text/shape style carriers (baseStyle, pill spans).
  // Optional because most style objects fold padding into bounds instead.
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  position: string;
  // Box shadow parsed components (null if no shadow). `boxShadow` is the
  // FIRST non-ring layer (used as an OOXML drop-shadow in convert-pptx).
  // `shadowRings` enumerates every spread-only layer (`0 0 0 Npx color` or
  // `0 0 Bpx Spx color` with spread > 0) — these can't be expressed as an
  // OOXML shadow effect, so they're materialized as concentric halo rects
  // painted behind the element in emitRect.
  boxShadow: { offsetX: number; offsetY: number; blur: number; spread: number; color: string | null; alpha: number } | null;
  shadowRings: { spread: number; blur: number; color: string; alpha: number }[];
  // CSS transform rotation in degrees clockwise. 0 when no rotation. Extracted
  // from the computed `transform` matrix via atan2(b,a); ignores translation
  // and scale. Paired with `naturalWidth`/`naturalHeight` (pre-transform layout
  // box) so the converter can place a rotated text box and rotate it around
  // the right center.
  rotate: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface TextRun {
  text: string;
  // Optional so a run emitted via conditional spread (`...(r.style ? {…} : {})`)
  // — which omits the key entirely for unstyled runs — still satisfies the type.
  style?: {
    color: string | null;
    fontWeight: "bold" | "normal";
    fontStyle: "italic" | "normal";
    fontFamily: string;
    fontSize: number;
    textDecoration: string | null;
    letterSpacing?: number;
    // Inline backgrounds (e.g. `<span class="code">`, `<span class="highlight">`)
    // — captured so the converter can apply pptxgenjs `highlight` per run.
    bgColor?: string | null;
    // `vertical-align: sub` / `super` on a span → pptxgenjs subscript/superscript.
    verticalAlign?: "baseline" | "sub" | "super";
  } | null;
}

// Per-CSS-property additions extract-dom carries past getComputedStyle.
// `bgAlpha` and `shadowRings` are computed locally during style extraction
// and stored on the same `cs`/`liStyle`/`style` object that downstream code
// reads back, so the typed access does not need `as any`. Vendor-prefixed
// CSS (webkit*, etc.) goes through `vendorCss()` below.
export interface ListItem {
  text: string;
  runs?: TextRun[];
  bounds?: Bounds;
  level?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "bold" | "normal";
  fontStyle?: "italic" | "normal";
  color?: string | null;
  textAlign?: string;
  spacingAfter?: number;
  marginTop?: number;
  bulletColor?: string | null;
  // True only when the ::before marker is a CSS-drawn filled DOT
  // (empty content + a non-transparent background, e.g. slide_30 Key
  // Priorities), as opposed to a literal glyph like content:'•' coloured
  // via `color` (slide_11 SWOT). Lets the converter revive a dropped dot on
  // a `list-style:none` list without touching glyph-marker lists.
  bulletIsDot?: boolean;
  lineHeight?: number;
  marginBottom?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  bgColor?: string | null;
  bgAlpha?: number;
  // border-bottom carries the bottom border COLOUR (or null) — used to detect
  // row-separator list items.
  borderBottom?: string | null;
  borderColor?: string | null;
  borderWidth?: number;
  borderStyle?: string;
  borderRadius?: number;
  borderSides?: BorderSides;
  cornerRadii?: CornerRadii;
}

export interface TableCell {
  text?: string;
  runs?: TextRun[];
  isHeader?: boolean;
  colspan?: number;
  rowspan?: number;
  bounds?: Bounds;
  padding?: { top: number; right: number; bottom: number; left: number };
  style?: Partial<ElementStyle>;
  bgColor?: string | null;
}
export type TableRow = TableCell[];

export interface BoxShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string | null;
  alpha: number;
}
export interface ShadowRing {
  spread: number;
  blur: number;
  color: string;
  alpha: number;
}

export interface GradientStop { color: string; position: number; alpha?: number }
export interface Gradient {
  type?: "linear" | "radial";
  angle?: number;
  stops: GradientStop[];
}

/** Single permissive element shape. Each `type` variant uses only a subset
 * of the optional fields; consumers narrow via the `type` discriminator.
 * Kept as ONE interface (not a discriminated union) to keep the many
 * `elements.push({...})` literals in this file legible — each emit site
 * sets just the fields its variant needs and TypeScript verifies the
 * shape without forcing one push per branch. */
export interface ExtractedElement {
  type:
    | "rect" | "text" | "list" | "table" | "visual" | "image"
    | "triangle" | "line" | "br" | "poly" | "_skip";
  bounds: Bounds;
  // Common
  _domIdx?: number;
  _wasEmojiText?: boolean;
  zIndex?: number | null;
  /**
   * The z-index of the OUTERMOST box this element sits inside that sets one, i.e. its stacking
   * position in the ROOT stacking context; null when no ancestor-or-self sets one (`auto`). A
   * merge candidate (mcp/sasha-slides PROTOCOL.md "Merge proposals") orders its new elements
   * against the slide's existing content by this number, so it is the top-level box's z-index and
   * never a nested child's, which only orders things inside that box.
   */
  stackZ?: number | null;
  position?: string;
  rotate?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  style?: Partial<ElementStyle> | null;
  // rect / text shared
  fill?: string | null;
  fillAlpha?: number;
  gradient?: Gradient | null;
  borderWidth?: number;
  borderColor?: string | null;
  borderStyle?: string;
  borderRadius?: number;
  cornerRadii?: CornerRadii;
  borderUniform?: boolean;
  borderSides?: BorderSides | null;
  boxShadow?: BoxShadow | null;
  // poly (clip-path: polygon(...) host rendered as a native custGeom shape)
  // Points are px offsets relative to `bounds` top-left, in path order.
  points?: { x: number; y: number }[];
  // line
  color?: string | null;
  dashType?: string;
  strokeWidth?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  // text
  text?: string;
  runs?: TextRun[];
  singleLine?: boolean;
  verticallyCentered?: boolean;
  padding?: { top: number; right: number; bottom: number; left: number };
  // list
  items?: ListItem[];
  ordered?: boolean;
  anyStyledItem?: boolean;
  isContainerList?: boolean;
  // A list's first-line baseline (client y) and that line's largest font size: see measureFirstLine.
  firstBaselineY?: number;
  firstLineFontSize?: number;
  columnCount?: number;
  listStyleType?: string;
  hasPseudoBullet?: boolean;
  pseudoBulletChar?: string | null;
  pseudoBulletColor?: string | null;
  // The list container's own box (background / border / radius) so the
  // converter can paint the wrapping card behind the bulleted rows.
  containerStyle?: {
    bgColor: string | null;
    fillAlpha: number;
    borderWidth: number;
    borderColor: string | null;
    borderStyle: string;
    borderSides: BorderSides;
    borderRadius: number;
    cornerRadii: CornerRadii;
    padding: { top: number; right: number; bottom: number; left: number };
  };
  // table
  rows?: TableRow[];
  bgColor?: string | null;
  borderCollapse?: string;
  renderAsShapes?: boolean;
  shapeRenderEmpty?: boolean;
  // visual / image
  tag?: string;
  // `text-glow` visual: matches the source element's `data-h2s-glow` attribute.
  glowId?: number;
  src?: string;
  cornerRadius?: number;
  // Generic clipping context inherited from an `overflow:hidden|clip` ancestor
  // with rounded corners. Stamped onto every pushed element by the walker —
  // the emitter then decides per-element whether the element's bounds need
  // an underlay-patch + group (see convert-pptx-lib emitClippedPatch).
  clipMask?: ClipMask | null;
  // Workstream E (drawio round-trip): set true on the SINGLE rendered diagram
  // element (the <svg>/<img> that visualises a `<script
  // type="application/vnd.drawio+xml" id="drawio-source">`). The converter
  // tags this element's image `objectName = DRAWIO_IMG_<n>` and emits a paired
  // off-canvas `DRAWIO_SRC_<n>` text box (fill #FF00FF) carrying the editable
  // mxGraph XML, so the add-on can rediscover + re-open the diagram. Undefined
  // (and thus byte-irrelevant) on every slide that has no drawio source.
  _drawioPaired?: boolean;
}

/** The whole payload: what the injected script returns as a JSON string. */
export interface Extraction {
  viewport: { w: number; h: number };
  elementCount: number;
  elements: ExtractedElement[];
  // Editable drawio XML behind the slide's diagram; present only when the page carries one.
  drawioSource?: string;
  // outerHTML of the paired inline <svg>; present only for an inline-svg drawio diagram.
  drawioBaseSvg?: string;
}
