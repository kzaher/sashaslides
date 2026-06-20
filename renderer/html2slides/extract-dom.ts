/**
 * extract-dom.ts — Injected into Chrome via Runtime.evaluate (compiled to JS first)
 * Walks the DOM, extracts every visible element as a flat array of positioned rectangles.
 *
 * == SOURCE OF TRUTH: Border & Corner Radius Rendering Rules ==
 *
 * These rules define how CSS borders and border-radius map to OOXML shapes
 * emitted by pptxgenjs. The converter (convert-pptx.ts) implements these;
 * this file extracts the data needed.
 *
 * --- CORNER RADIUS RULES ---
 *
 * Google Slides shape types for rounded corners:
 *   ROUND_RECTANGLE           — all 4 corners same radius
 *   ROUND_2_SAME_RECTANGLE    — 2 adjacent corners rounded (same side), other 2 square
 *   ROUND_2_DIAGONAL_RECTANGLE — 2 diagonal corners rounded
 *   ROUND_1_RECTANGLE         — 1 corner rounded
 *   ELLIPSE                   — for fully circular elements (border-radius >= 50% of min dim)
 *
 * Detection logic for per-corner radii [TL, TR, BR, BL]:
 *   1. All 4 same → ROUND_RECTANGLE
 *   2. TL==TR && BL==BR (top pair == bottom pair) → if bottom==0: ROUND_2_SAME_RECTANGLE (no rotation)
 *      if top==0: ROUND_2_SAME_RECTANGLE rotated 180°
 *   3. TL==BL && TR==BR (left pair == right pair) → ROUND_2_SAME_RECTANGLE rotated 90°/270°
 *   4. TL==BR && TR==BL (diagonal) → ROUND_2_DIAGONAL_RECTANGLE
 *   5. Arbitrary: approximate with ROUND_2_SAME_RECTANGLE using the pair with largest radii
 *
 * --- BORDER RULES ---
 *
 * Case 1: Uniform border (all sides same width & color) + border-radius:
 *   → Use shape with outline (border color, weight, dashStyle) + appropriate rounded shape type.
 *
 * Case 2: Partial borders (not all sides) or different widths per side:
 *   → Emit the element content as a shape (fill only, no outline).
 *   → For each visible border side, emit a separate rect "border shape" that extends from the
 *     element edge outward by the border width in that direction:
 *       Left border:   position.x -= borderLeft,  width += borderLeft
 *       Right border:  width += borderRight
 *       Top border:    position.y -= borderTop,    height += borderTop
 *       Bottom border: height += borderBottom
 *     The border shape uses the border color as fill, same corner radius as the element,
 *     and sits BEHIND the content element (lower z-order).
 *     This assumes the element is opaque — the content shape covers the inner portion of the
 *     border shape, leaving only the border-width strip visible.
 *
 * Case 3: Transparent element with border:
 *   → If the element has no bgColor (transparent), detect the background color at the element's
 *     center by walking up the DOM tree until we find an ancestor with a bgColor, or use white.
 *     Use this as a fallback fill so the border-shape trick from Case 2 works.
 *
 * --- GRADIENT BACKGROUND RULES ---
 *
 * Google Slides API supports linear gradient fills on shapes:
 *   linearGradientFill: { angle, colorStops: [{color, alpha, position}] }
 * When an element has background-image: linear-gradient(...):
 *   → Parse the gradient direction and color stops from the computed CSS.
 *   → Map to Slides linearGradientFill with angle and color stops.
 *   → For radial-gradient: approximate as solid using the first color (no Slides equivalent).
 *   → For conic-gradient: screenshot as visual (donut charts etc.).
 * The extraction emits a `gradient` field on rect elements when detected.
 * The converter uses linearGradientFill when available, falls back to solid first-color otherwise.
 *
 * --- TABLE BORDER RULES ---
 *
 * Tables without rounded corners:
 *   → Use native Slides table borders (per-cell border control).
 *
 * Tables with rounded corners (most generic approach — handle each corner independently):
 *   → Use a native Slides table for the content (text, cell backgrounds, inner borders).
 *   → For EACH rounded corner of the table, emit a separate ROUND_1_RECTANGLE shape:
 *       - Sized to cover that corner cell area (one cell width × one cell height).
 *       - Positioned at the corner cell's bounds.
 *       - The single rounded corner faces outward (use rotation to orient ROUND_1_RECTANGLE).
 *       - Fill color = that corner cell's background color.
 *       - If the corner cell has a border on the outer edges, use the shape's outline for those.
 *   → For borders on the straight (non-corner) outer edges of the table:
 *       - Use the native table border if possible.
 *       - Or emit line elements along the edge.
 *   → The ROUND_1_RECTANGLE corner shapes sit BEHIND the table content.
 *   → If the table has a border on outer edges but NOT between the corner shape and the
 *     adjacent cell, use the "coloring trick": fill the corner shape with the cell's
 *     background color so the missing border is hidden. Detect the background color under
 *     the table in the HTML and use it if the cell is transparent.
 *   → This approach generalizes to any combination of per-corner radii on any table.
 *
 * --- BOX SHADOW RULES ---
 *
 * Google Slides does not support box-shadow natively, but we can fake it:
 *   → Emit a transparent bottom-most shape (same bounds + shadow offset, slightly larger)
 *     that acts as a shadow layer. This shape should use the Slides "shadow" property
 *     (DropShadow on ShapeProperties).
 *   → The visible content shape sits on top.
 *   → Border-shape hacks (from Case 2) go between the shadow layer and the content shape.
 *   → All these shapes should be grouped so they move together.
 *   Note: Slides API supports shadow via updateShapeProperties with shadow field:
 *     shadow: { type: "OUTER", transform: {scaleX, scaleY, translateX, translateY}, color, alpha, blurRadius }
 *
 * --- SCREENSHOT RULES ---
 *
 * Only screenshot elements that truly cannot be represented as Slides shapes:
 *   - <svg>, <canvas> elements
 *   - <img> elements
 *   - CSS conic-gradient (donut charts)
 *   - CSS clip-path (custom shapes like trapezoids)
 * NEVER screenshot: circles, rounded rects, gradient backgrounds (use solid fallback),
 * elements with box-shadow, buttons, badges, icons.
 * Screenshots require explicit user permission for any new category.
 *
 * RECURSIVE ELEMENTS (preserve structure):
 *   - <table> → { type: "table", rows: [[cell, cell], ...] }
 *   - <ul>/<ol> → { type: "list", items: [{text, level}] }
 *
 * FLAT ELEMENTS (absolute positioned):
 *   - text nodes → { type: "text", bounds, text, style }
 *   - <img> → { type: "image", bounds, src }
 *   - <svg>/<canvas> → { type: "visual", bounds } (screenshot separately)
 *   - colored rectangles (divs with bg) → { type: "rect", bounds, fill, border }
 */

// Types for the extraction output
interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Per-corner border radius values [top-left, top-right, bottom-right, bottom-left]
interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

// Per-side border info
interface BorderSides {
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
interface ClipMask {
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

interface ElementStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: "bold" | "normal";
  fontStyle: "italic" | "normal";
  color: string | null;
  bgColor: string | null;
  bgAlpha: number;
  textAlign: string;
  lineHeight: number;
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
  display: string;
  overflow: string;
  justifyContent: string;
  alignItems: string;
  backgroundImage: string | null;
  clipPath: string | null;
  zIndex: number;
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

interface TextRun {
  text: string;
  style: {
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
interface ListItem {
  text: string;
  runs?: TextRun[];
  bounds?: Bounds;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "bold" | "normal";
  fontStyle?: "italic" | "normal";
  color?: string | null;
  bulletColor?: string;
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
  borderRadius?: number;
  borderSides?: BorderSides;
}

interface TableCell {
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
type TableRow = TableCell[];

interface BoxShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string | null;
  alpha: number;
}
interface ShadowRing {
  spread: number;
  blur: number;
  color: string;
  alpha: number;
}

interface GradientStop { color: string; position: number; alpha?: number }
interface Gradient {
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
interface ExtractedElement {
  type:
    | "rect" | "text" | "list" | "table" | "visual" | "image"
    | "triangle" | "line" | "br" | "_skip";
  bounds: Bounds;
  // Common
  _domIdx?: number;
  _wasEmojiText?: boolean;
  zIndex?: number;
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
  // table
  rows?: TableRow[];
  // visual / image
  tag?: string;
  cornerRadius?: number;
  // Generic clipping context inherited from an `overflow:hidden|clip` ancestor
  // with rounded corners. Stamped onto every pushed element by the walker —
  // the emitter then decides per-element whether the element's bounds need
  // an underlay-patch + group (see convert-pptx-lib emitClippedPatch).
  clipMask?: ClipMask | null;
  // Internal group identifier shared by an underlay patch and the element it
  // shields. Post-processed into a `<p:grpSp>` wrapper in the slide XML so
  // that resize/move in Slides keeps the pair together.
  _groupId?: string;
}

/** Vendor-prefixed CSS not in TypeScript's CSSStyleDeclaration. Cast a
 * CSSStyleDeclaration through this when reading webkit* / -webkit-* etc. */
type VendorCssDecl = CSSStyleDeclaration & {
  webkitTextFillColor?: string;
  webkitBackgroundClip?: string;
  backgroundClip?: string;
};
function vendorCss(cs: CSSStyleDeclaration): VendorCssDecl { return cs as VendorCssDecl }

// The entire extraction runs as an IIFE that returns JSON
(() => {
  const W: number = document.body.offsetWidth || 1280;
  const H: number = document.body.offsetHeight || 720;
  const elements: ExtractedElement[] = [];
  const seen = new Set<Element>();
  let _domCounter = 0;
  // Active clip mask for the element currently being emitted. walk() pushes
  // a new mask on entry to any `overflow:hidden|clip` + rounded ancestor and
  // pops on exit. Every elements.push() stamps this mask so downstream emit
  // can decide whether to draw an underlay patch.
  let _currentClipMask: ClipMask | null = null;
  // Elements emitted during the walk but appended only AFTER it completes, so
  // they land at the end of the array (highest _domIdx → painted last, and no
  // shifting of existing shape indices). Used for decorative overlays like the
  // slide_33 `.road::before` centerline.
  const _deferredEls: ExtractedElement[] = [];
  const _origPush = elements.push.bind(elements);
  elements.push = (...items: ExtractedElement[]) => {
    for (const it of items) {
      if (!it) continue;
      if (it._domIdx === undefined) it._domIdx = _domCounter++;
      if (it.clipMask === undefined) it.clipMask = _currentClipMask;
    }
    return _origPush(...items);
  };

  /** True when (a, b) overlap with epsilon tolerance. */
  function rectsIntersect(a: Bounds, b: Bounds, eps = 0.5): boolean {
    return !(a.x + a.w <= b.x + eps || b.x + b.w <= a.x + eps ||
             a.y + a.h <= b.y + eps || b.y + b.h <= a.y + eps);
  }
  /** Geometric intersection of two axis-aligned rects (no clipping happens
   * for cornerRadii here — that's resolved at emit time). Returns null if
   * the rects don't overlap. */
  function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const btm = Math.min(a.y + a.h, b.y + b.h);
    if (r <= x || btm <= y) return null;
    return { x, y, w: r - x, h: btm - y };
  }
  /** Combine parent clip and a freshly-established local clip. The result
   * inherits the local cornerRadii (those are the corners that will paint),
   * and the bounds are the rect-intersection so children outside the parent
   * window aren't reintroduced. */
  function refineClipMask(parent: ClipMask | null, local: ClipMask): ClipMask {
    if (!parent) return local;
    const inter = intersectBounds(parent.bounds, local.bounds);
    return inter
      ? { bounds: inter, cornerRadii: local.cornerRadii }
      : { bounds: { x: 0, y: 0, w: 0, h: 0 }, cornerRadii: local.cornerRadii };
  }

  // Build a map of available font weights per family from document.fonts.
  // CSS font matching uses the closest available weight when the exact one
  // isn't loaded (e.g. Playfair Display loaded at 700 only → computed
  // font-weight 400 actually renders as 700). We replicate Chrome's weight
  // matching: for requested weight ≤ 500, prefer lighter then heavier; for
  // > 500, prefer heavier then lighter.
  const _fontWeightMap: Record<string, number[]> = {};
  try {
    for (const f of document.fonts) {
      const fam = f.family.replace(/['"]/g, "").trim();
      const w = parseInt(f.weight) || 400;
      if (!_fontWeightMap[fam]) _fontWeightMap[fam] = [];
      if (!_fontWeightMap[fam].includes(w)) _fontWeightMap[fam].push(w);
    }
    for (const fam of Object.keys(_fontWeightMap)) _fontWeightMap[fam].sort((a, b) => a - b);
  } catch (_) {}

  function resolveRenderedWeight(family: string, computedWeight: number): "bold" | "normal" {
    const available = _fontWeightMap[family];
    if (!available || available.length === 0) {
      return computedWeight >= 600 ? "bold" : "normal";
    }
    // If the exact weight is available, use it as-is
    if (available.includes(computedWeight)) {
      return computedWeight >= 600 ? "bold" : "normal";
    }
    // CSS font matching algorithm (simplified):
    // If desired ≤ 500: try lighter weights first, then heavier
    // If desired > 500: try heavier weights first, then lighter
    let matched = available[0];
    if (computedWeight <= 500) {
      const lighter = available.filter(w => w <= computedWeight);
      matched = lighter.length > 0 ? lighter[lighter.length - 1] : available[0];
    } else {
      const heavier = available.filter(w => w >= computedWeight);
      matched = heavier.length > 0 ? heavier[0] : available[available.length - 1];
    }
    return matched >= 600 ? "bold" : "normal";
  }

  function rgb2hex(rgb: string): string | null {
    if (!rgb || rgb === "transparent" || rgb === "rgba(0, 0, 0, 0)") return null;
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return rgb.startsWith("#") ? rgb : null;
    return "#" + [m[1], m[2], m[3]].map(x => parseInt(x).toString(16).padStart(2, "0")).join("");
  }

  /** Extract alpha (0-1) from a CSS color string; 1 if fully opaque or unparseable */
  function rgbAlpha(rgb: string): number {
    if (!rgb) return 1;
    if (rgb === "transparent" || rgb === "rgba(0, 0, 0, 0)") return 0;
    const m = rgb.match(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)/);
    return m ? parseFloat(m[1]) : 1;
  }

  /** Pre-blend an rgba() color against a solid hex bg so the result is opaque.
   * Slides drops per-run <a:alpha>, so a translucent chip border like
   * `rgba(255,255,255,0.1)` over a navy card would otherwise be emitted as
   * opaque `#FFFFFF` and paint a bright white outline. Returns null for a
   * fully transparent input. */
  function rgbaToBlendedHex(rgba: string, bgHex: string): string | null {
    if (!rgba || rgba === "transparent" || rgba === "rgba(0, 0, 0, 0)") return null;
    const m = rgba.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
    if (!m) return rgb2hex(rgba);
    const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    const toHex = (v: number) => v.toString(16).padStart(2, "0");
    if (a >= 1) return "#" + [r, g, b].map(toHex).join("");
    const bm = (bgHex || "").replace("#", "").match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    const br = bm ? parseInt(bm[1], 16) : 255;
    const bg = bm ? parseInt(bm[2], 16) : 255;
    const bb = bm ? parseInt(bm[3], 16) : 255;
    return "#" + [
      Math.round(r * a + br * (1 - a)),
      Math.round(g * a + bg * (1 - a)),
      Math.round(b * a + bb * (1 - a)),
    ].map(toHex).join("");
  }

  /** Arithmetic mean of all hex/rgb stops found in a CSS background-image
   * declaration. Slides can't render a gradient as a glyph fill, so we
   * collapse to the mean — palette-preserving and never more than halfway
   * off any individual stop. */
  function meanGradientStops(bgImg: string): string | null {
    if (!bgImg || bgImg === "none") return null;
    const hexes = Array.from(bgImg.matchAll(/(#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\))/g))
      .map(m => rgb2hex(m[1])).filter(Boolean) as string[];
    if (hexes.length === 0) return null;
    let r = 0, g = 0, b = 0;
    for (const s of hexes) {
      const h = s.replace("#", "");
      r += parseInt(h.slice(0, 2), 16);
      g += parseInt(h.slice(2, 4), 16);
      b += parseInt(h.slice(4, 6), 16);
    }
    r = Math.round(r / hexes.length);
    g = Math.round(g / hexes.length);
    b = Math.round(b / hexes.length);
    return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
  }

  /** Effective solid colour for glyphs when the run uses
   * `-webkit-text-fill-color: transparent` (or `color: transparent`) over a
   * `background-image` gradient. Returns null when the text is not
   * gradient-clipped — caller falls back to `rgb2hex(cs.color)`. */
  function resolveGradientTextColor(cs: CSSStyleDeclaration): string | null {
    const fillCss = vendorCss(cs).webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color") || "";
    const fillTransparent = fillCss && rgbAlpha(fillCss) < 0.1;
    const colorTransparent = rgbAlpha(cs.color) < 0.1;
    if (!fillTransparent && !colorTransparent) return null;
    return meanGradientStops(cs.backgroundImage || "");
  }

  /** Detect background color at the center of an element by walking up the
   * DOM tree. An ancestor with a gradient `background-image` (and no solid
   * backgroundColor) contributes the arithmetic mean of its stops — so a
   * semi-transparent glyph sitting on a gradient card blends against the
   * gradient's midtone instead of whichever solid sits beneath the card. */
  function detectBgColorBelow(el: Element): string {
    let node: Element | null = el.parentElement;
    while (node) {
      const ncs = getComputedStyle(node);
      const bg = rgb2hex(ncs.backgroundColor);
      if (bg) return bg;
      const gradMean = meanGradientStops(ncs.backgroundImage || "");
      if (gradMean) return gradMean;
      node = node.parentElement;
    }
    return "#ffffff"; // fallback: white
  }

  function getStyle(el: Element): ElementStyle {
    const cs = getComputedStyle(el);

    // Per-side border info
    const bTop = parseFloat(cs.borderTopWidth) || 0;
    const bRight = parseFloat(cs.borderRightWidth) || 0;
    const bBottom = parseFloat(cs.borderBottomWidth) || 0;
    const bLeft = parseFloat(cs.borderLeftWidth) || 0;
    // Border colours can be `rgba(…, <1)`. Pre-blend against the element's
    // own bg (or the nearest ancestor bg, including a gradient mean) so the
    // emitted hex already includes the alpha — Slides drops per-run
    // <a:alpha>, and an rgba(255,255,255,0.1) border would otherwise
    // render as opaque white (slide_17 chip outlines).
    let _elBgCache: string | null = null;
    // The border pre-blend base must match what the HTML paints UNDER the
    // border stroke — that is, the element's own bg composited on top of the
    // ancestor bg. For a `.investor-card` with `rgba(255,255,255,0.05)` fill
    // and `1px rgba(255,255,255,0.1)` border, a naïve blend against the body
    // gradient alone underestimates the rendered border colour (it lands near
    // #2B vs the HTML ~#36), so in Slides the outline fades into the body
    // ("outer borders on cards missing", slide_17). Pre-blend the translucent
    // own bg against the ancestor first, then use that opaque hex as the
    // border's underlay.
    const getElBg = (): string => {
      if (_elBgCache) return _elBgCache;
      const ownRgba = cs.backgroundColor;
      const ownA = rgbAlpha(ownRgba);
      if (ownA >= 1) return _elBgCache = rgb2hex(ownRgba) || detectBgColorBelow(el);
      const ancestor = detectBgColorBelow(el);
      if (ownA <= 0) return _elBgCache = ancestor;
      return _elBgCache = rgbaToBlendedHex(ownRgba, ancestor) || ancestor;
    };
    const blendBorder = (c: string): string | null => {
      if (!c || c === "transparent" || c === "rgba(0, 0, 0, 0)") return null;
      return rgbAlpha(c) < 1 ? rgbaToBlendedHex(c, getElBg()) : rgb2hex(c);
    };
    const bTopColor = blendBorder(cs.borderTopColor);
    const bRightColor = blendBorder(cs.borderRightColor);
    const bBottomColor = blendBorder(cs.borderBottomColor);
    const bLeftColor = blendBorder(cs.borderLeftColor);
    const bTopStyle = cs.borderTopStyle || "none";
    const bRightStyle = cs.borderRightStyle || "none";
    const bBottomStyle = cs.borderBottomStyle || "none";
    const bLeftStyle = cs.borderLeftStyle || "none";

    // Check if border is uniform (all sides same width, color, style)
    const borderUniform =
      bTop === bRight && bRight === bBottom && bBottom === bLeft &&
      bTopColor === bRightColor && bRightColor === bBottomColor && bBottomColor === bLeftColor &&
      bTopStyle === bRightStyle && bRightStyle === bBottomStyle && bBottomStyle === bLeftStyle;

    // Per-corner border radii — Chrome may return "50%" instead of px, so convert
    const elBounds = el.getBoundingClientRect();
    function parseRadius(val: string, w: number, h: number): number {
      if (val.endsWith("%")) {
        const pct = parseFloat(val) / 100;
        return pct * Math.min(w, h); // percentage of smaller dimension
      }
      return parseFloat(val) || 0;
    }
    const tl = parseRadius(cs.borderTopLeftRadius, elBounds.width, elBounds.height);
    const tr = parseRadius(cs.borderTopRightRadius, elBounds.width, elBounds.height);
    const br = parseRadius(cs.borderBottomRightRadius, elBounds.width, elBounds.height);
    const bl = parseRadius(cs.borderBottomLeftRadius, elBounds.width, elBounds.height);

    return {
      fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
      fontSize: parseFloat(cs.fontSize),
      fontWeight: resolveRenderedWeight(
        cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
        cs.fontWeight === "bold" ? 700 : parseInt(cs.fontWeight) || 400,
      ),
      fontStyle: cs.fontStyle === "italic" ? "italic" : "normal",
      // text-clip gradient fallback: when the effective glyph fill is
      // transparent (`color: transparent` OR `-webkit-text-fill-color: transparent`),
      // collapse the gradient stops to their arithmetic mean. The user's
      // guidance for slide_17: "if PPT can't show gradient letters, at least
      // set them to mean between colors" — a single stop picked by contrast
      // drifts too far from the rendered look on visually-balanced gradients.
      color: resolveGradientTextColor(cs) || rgb2hex(cs.color),
      bgColor: rgb2hex(cs.backgroundColor),
      bgAlpha: rgbAlpha(cs.backgroundColor),
      textAlign: cs.textAlign,
      lineHeight: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2,
      textDecoration: cs.textDecorationLine !== "none" ? cs.textDecorationLine : null,
      textTransform: cs.textTransform !== "none" ? cs.textTransform : null,
      letterSpacing: parseFloat(cs.letterSpacing) || 0,
      // CSS writing-mode: vertical-rl/-lr text must map to a pptxgenjs `vert`
      // body rotation, not a 180° box rotation (which yields upside-down
      // horizontal text — slide_32 .axis). Captured here; consumed in
      // convert-pptx-lib.ts emitStyledText.
      writingMode: cs.writingMode && cs.writingMode !== "horizontal-tb" ? cs.writingMode : null,
      // Uniform border (convenience: use max width, first color)
      borderColor: bTopColor || bRightColor || bBottomColor || bLeftColor,
      borderWidth: Math.max(bTop, bRight, bBottom, bLeft),
      borderRadius: Math.max(tl, tr, br, bl),
      borderStyle: bTopStyle !== "none" ? bTopStyle : bRightStyle !== "none" ? bRightStyle : bBottomStyle !== "none" ? bBottomStyle : bLeftStyle,
      // Per-side
      borderTop: bTop, borderTopColor: bTopColor,
      borderBottom: bBottom, borderBottomColor: bBottomColor,
      borderLeft: bLeft, borderLeftColor: bLeftColor,
      borderRight: bRight, borderRightColor: bRightColor,
      // Per-corner radii
      cornerRadii: { tl, tr, br, bl },
      borderUniform,
      borderSides: {
        top: { width: bTop, color: bTopColor, style: bTopStyle },
        right: { width: bRight, color: bRightColor, style: bRightStyle },
        bottom: { width: bBottom, color: bBottomColor, style: bBottomStyle },
        left: { width: bLeft, color: bLeftColor, style: bLeftStyle },
      },
      opacity: parseFloat(cs.opacity),
      display: cs.display,
      overflow: cs.overflow,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      backgroundImage: cs.backgroundImage !== "none" ? cs.backgroundImage : null,
      clipPath: cs.clipPath !== "none" ? cs.clipPath : null,
      // zIndex: null means `auto` (inherit from parent stacking context) — keep
      // that distinct from an explicit `0`, because paint order treats them
      // differently: explicit 0 promotes the element into group 6 of its
      // stacking context, auto keeps it in groups 3–5 when non-positioned.
      zIndex: cs.zIndex === "auto" ? null : parseInt(cs.zIndex),
      position: cs.position,
      // Parse `transform` matrix → rotation in degrees CW.
      // `matrix(a, b, c, d, tx, ty)` = [[a,c,tx],[b,d,ty]]; rotation angle =
      // atan2(b, a). Non-rotation transforms (pure translate/scale) yield ~0°.
      // We only keep the rotation because pptxgenjs shapes can rotate but
      // can't skew or non-uniformly scale.
      rotate: (() => {
        const tr = cs.transform;
        if (!tr || tr === "none") return 0;
        const m = tr.match(/matrix\(([^)]+)\)/);
        if (!m) return 0;
        const n = m[1].split(",").map(x => parseFloat(x));
        if (n.length < 4) return 0;
        const [a, b] = n;
        const rad = Math.atan2(b, a);
        const deg = rad * 180 / Math.PI;
        // Snap near-zero to 0 so unrotated elements don't get 0.0001° jitter.
        return Math.abs(deg) < 0.1 ? 0 : deg;
      })(),
      naturalWidth: (el as HTMLElement).offsetWidth || elBounds.width,
      naturalHeight: (el as HTMLElement).offsetHeight || elBounds.height,
      // Parse box-shadow — may be a comma-separated list of layers. `boxShadow`
      // returns the FIRST non-ring (drop-shadow-style) layer; `shadowRings`
      // returns every spread-only layer, which emitRect materializes as
      // concentric halo rects (OOXML has no equivalent shadow effect).
      ...(() => {
        const sh = cs.boxShadow;
        if (!sh || sh === "none") return { boxShadow: null, shadowRings: [] as ShadowRing[] };
        // Split on top-level commas (never inside rgba()).
        const parts: string[] = [];
        let depth = 0, buf = "";
        for (const ch of sh) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch === "," && depth === 0) { parts.push(buf.trim()); buf = ""; }
          else buf += ch;
        }
        if (buf.trim()) parts.push(buf.trim());
        const layers = parts.map(p => {
          const nums = p.match(/(-?\d+(?:\.\d+)?)px/g);
          if (!nums || nums.length < 2) return null;
          const vals = nums.map(n => parseFloat(n));
          const rgbaMatch = p.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          const alpha = rgbaMatch && rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
          return {
            offsetX: vals[0], offsetY: vals[1],
            blur: vals[2] || 0, spread: vals[3] || 0,
            color: rgb2hex(p) || "#000000",
            alpha,
          };
        }).filter(Boolean);
        // Ring = offset=0 and spread>0. These can't be expressed as a PPTX
        // shadow effect; emit as concentric halo rects instead.
        const rings = layers
          .filter(l => l.offsetX === 0 && l.offsetY === 0 && l.spread > 0)
          .map(l => ({ spread: l.spread, blur: l.blur, color: l.color, alpha: l.alpha }));
        const drop = layers.find(l => !(l.offsetX === 0 && l.offsetY === 0 && l.spread > 0)) || null;
        return { boxShadow: drop, shadowRings: rings };
      })(),
    };
  }

  function getBounds(el: Element): Bounds {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left * 100) / 100,
      y: Math.round(r.top * 100) / 100,
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
    };
  }

  function isVisible(el: Element, bounds: Bounds): boolean {
    if (bounds.w < 1 || bounds.h < 1) return false;
    if (bounds.x + bounds.w < 0 || bounds.y + bounds.h < 0) return false;
    if (bounds.x > W || bounds.y > H) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  // --- TABLE EXTRACTION ---
  function extractTable(table: HTMLTableElement): ExtractedElement {
    let bounds = getBounds(table);
    const style = getStyle(table);
    const tableCs = getComputedStyle(table);
    const borderCollapse = tableCs.borderCollapse; // "collapse" | "separate"
    // Detect a clipping wrapper ancestor — e.g. `.table-wrap { overflow:hidden;
    // border-radius:12px }` around a <table>. CSS clips the table to the
    // wrapper's rounded-rect; we must emulate that by (a) clipping the table's
    // reported height to the wrapper's content box so subsequent siblings
    // (legends, etc.) don't overlap, and (b) adopting the wrapper's corner
    // radii so the outer corner cells render rounded.
    let wrapperClip: { borderRadius: number; cornerRadii: CornerRadii; bounds: Bounds } | null = null;
    {
      let anc: Element | null = table.parentElement;
      while (anc && anc !== document.body) {
        const acs = getComputedStyle(anc);
        const ov = acs.overflow;
        const clipsOverflow = ov === "hidden" || ov === "clip" || ov === "auto" || ov === "scroll";
        const tl = parseFloat(acs.borderTopLeftRadius) || 0;
        const tr = parseFloat(acs.borderTopRightRadius) || 0;
        const br = parseFloat(acs.borderBottomRightRadius) || 0;
        const bl = parseFloat(acs.borderBottomLeftRadius) || 0;
        const maxR = Math.max(tl, tr, br, bl);
        if (clipsOverflow && maxR > 0) {
          wrapperClip = {
            borderRadius: maxR,
            cornerRadii: { tl, tr, br, bl },
            bounds: getBounds(anc),
          };
          break;
        }
        anc = anc.parentElement;
      }
    }
    const rows: TableRow[] = [];
    const trs = table.querySelectorAll("tr");
    for (const tr of trs) {
      const cells: TableCell[] = [];
      const tds = tr.querySelectorAll("td, th");
      for (const td of tds) {
        const cs = getStyle(td);
        const cb = getBounds(td);
        const cCs = getComputedStyle(td);
        // Suppress the cell's text when its visible content is entirely
        // pill-style spans (inline-block + background + border-radius) —
        // otherwise the cell text and the post-table `emitPillSpan`
        // overlay both render the same string twice (wave-15 slide_05
        // ".partial Partial"). The pill carries its own text via
        // `emitPillSpan`, drawn on top.
        const tdText = (td as HTMLElement).innerText.trim();
        let cellTextForRender = tdText;
        if (tdText) {
          const pillSpans = Array.from(td.querySelectorAll(":scope > span")).filter(sp => {
            const sCs = getComputedStyle(sp);
            const sBg = rgb2hex(sCs.backgroundColor);
            const sBR = parseFloat(sCs.borderTopLeftRadius) || 0;
            return !!sBg && sBR > 0;
          });
          if (pillSpans.length > 0) {
            const pillsText = pillSpans
              .map(sp => (sp.textContent || "").replace(/\s+/g, " ").trim())
              .filter(t => t.length > 0)
              .join(" ");
            if (pillsText && pillsText === tdText) cellTextForRender = "";
          }
        }
        cells.push({
          text: cellTextForRender,
          runs: getTextRuns(td, cs),
          isHeader: td.tagName === "TH",
          colspan: (td as HTMLTableCellElement).colSpan || 1,
          rowspan: (td as HTMLTableCellElement).rowSpan || 1,
          bounds: cb,
          padding: {
            top: parseFloat(cCs.paddingTop) || 0,
            right: parseFloat(cCs.paddingRight) || 0,
            bottom: parseFloat(cCs.paddingBottom) || 0,
            left: parseFloat(cCs.paddingLeft) || 0,
          },
          style: {
            fontFamily: cs.fontFamily,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle,
            color: cs.color,
            bgColor: cs.bgColor,
            bgAlpha: cs.bgAlpha,
            textAlign: cs.textAlign,
            borderColor: cs.borderColor,
            borderWidth: cs.borderWidth,
            borderStyle: cs.borderStyle,
            borderSides: cs.borderSides,
            borderRadius: cs.borderRadius,
            cornerRadii: cs.cornerRadii,
          },
        });
      }
      rows.push(cells);
    }
    // Apply the clipping-wrapper adjustment: clip table height to wrapper's
    // visible area, and adopt its corner radii (only when the table has none
    // of its own).
    let effectiveBorderRadius = style.borderRadius || 0;
    let effectiveCornerRadii = style.cornerRadii;
    if (wrapperClip) {
      const wb = wrapperClip.bounds;
      const clippedBottom = Math.min(bounds.y + bounds.h, wb.y + wb.h);
      const clippedRight = Math.min(bounds.x + bounds.w, wb.x + wb.w);
      const clippedTop = Math.max(bounds.y, wb.y);
      const clippedLeft = Math.max(bounds.x, wb.x);
      bounds = {
        x: clippedLeft,
        y: clippedTop,
        w: Math.max(0, clippedRight - clippedLeft),
        h: Math.max(0, clippedBottom - clippedTop),
      };
      // Also clip each row's/cell's bounds so per-cell rendering (fill, text)
      // doesn't poke past the wrapper's rounded frame.
      for (const row of rows) {
        for (const cell of row) {
          const cb = cell.bounds;
          if (!cb) continue;
          const cx = Math.max(cb.x, wb.x);
          const cy = Math.max(cb.y, wb.y);
          const cr = Math.min(cb.x + cb.w, wb.x + wb.w);
          const cbot = Math.min(cb.y + cb.h, wb.y + wb.h);
          cell.bounds = { x: cx, y: cy, w: Math.max(0, cr - cx), h: Math.max(0, cbot - cy) };
        }
      }
      if (!(effectiveBorderRadius > 0)) {
        effectiveBorderRadius = wrapperClip.borderRadius;
        effectiveCornerRadii = wrapperClip.cornerRadii;
      }
    }
    // Debug marker: when `<table data-shape-render="true">` or
    // `data-shape-render="empty">` is set, the converter renders the
    // entire table via shape-only emission (no native <a:tbl>). Use
    // "empty" to also blank the cell text. Two values:
    //   - "true"  → shape-render, keep content
    //   - "empty" → shape-render, no content
    const shapeRenderAttr = table.getAttribute("data-shape-render");
    const renderAsShapes = shapeRenderAttr === "true" || shapeRenderAttr === "empty";
    const shapeRenderEmpty = shapeRenderAttr === "empty";
    return {
      type: "table", bounds, rows,
      bgColor: style.bgColor,
      borderColor: style.borderColor,
      borderRadius: effectiveBorderRadius,
      cornerRadii: effectiveCornerRadii,
      borderSides: style.borderSides,
      borderCollapse,
      renderAsShapes,
      shapeRenderEmpty,
    };
  }

  // --- LIST EXTRACTION ---
  function extractList(list: HTMLElement): ExtractedElement {
    const bounds = getBounds(list);
    const style = getStyle(list);
    const ordered = list.tagName === "OL";
    const items: ListItem[] = [];

    const listCs = getComputedStyle(list);
    const columnCount = parseInt(listCs.columnCount) || 1;
    const listStyleType = listCs.listStyleType || "disc";

    // Detect ::before pseudo-element markers
    let hasPseudoBullet = false;
    let pseudoBulletChar: string | null = null;
    let pseudoBulletColor: string | null = null;
    const firstLi = list.querySelector("li");
    if (firstLi) {
      const beforeCs = getComputedStyle(firstLi, "::before");
      const beforeContent = beforeCs.content;
      if (beforeContent && beforeContent !== "none" && beforeContent !== "normal") {
        hasPseudoBullet = true;
        const cleaned = beforeContent.replace(/^['"]|['"]$/g, "");
        if (cleaned.length > 0) {
          pseudoBulletChar = cleaned;
          pseudoBulletColor = rgb2hex(beforeCs.color);
        } else {
          pseudoBulletChar = "•";
          pseudoBulletColor = rgb2hex(beforeCs.backgroundColor) || rgb2hex(beforeCs.color);
        }
      }
      if (!hasPseudoBullet && (beforeContent === '""' || beforeContent === "''")) {
        const bw = parseFloat(beforeCs.width) || 0;
        const bh = parseFloat(beforeCs.height) || 0;
        if (bw > 0 && bh > 0) {
          hasPseudoBullet = true;
          pseudoBulletChar = "•";
          pseudoBulletColor = rgb2hex(beforeCs.backgroundColor) || rgb2hex(beforeCs.color);
        }
      }
    }

    function walkItems(parent: Element, level: number): void {
      for (const li of parent.children) {
        if (li.tagName !== "LI") continue;
        let text = "";
        for (const node of li.childNodes) {
          if (node.nodeType === 3) text += node.textContent;
          else if ((node as Element).tagName !== "UL" && (node as Element).tagName !== "OL") text += node.textContent;
        }
        const liStyle = getStyle(li);
        const liCs = getComputedStyle(li);
        const marginBottom = parseFloat(liCs.marginBottom) || 0;
        const marginTop = parseFloat(liCs.marginTop) || 0;
        const spacingBottom = marginBottom + (parseFloat(liCs.paddingBottom) || 0);
        const spacingTop = marginTop + (parseFloat(liCs.paddingTop) || 0);
        // Preserve styled inline child runs (e.g. <span class="check">✓</span>) so
        // colors on ✓/✗ prefixes survive into the rendered slide.
        const runs = getTextRuns(li, liStyle);
        // Per-item ::before colour: lists like slide_30 give each <li> its own
        // coloured 8×8 dot via `li.red::before { background: #e53e3e }`. The
        // top-level `pseudoBulletColor` only carries the FIRST item's colour,
        // so per-item colour must be captured here for the converter to emit
        // a coloured marker run per row. We gate both on `hasPseudoBullet`
        // (cheap early-out, set when the list has any pseudo-bullet) AND on
        // the individual ::before having `content` set (inside try/catch so
        // browsers that throw on content-less pseudos don't explode).
        let bulletColor: string | null = null;
        let bulletIsDot = false;
        if (hasPseudoBullet) {
          try {
            const liBeforeCs = getComputedStyle(li, "::before");
            const beforeContent = liBeforeCs.content;
            if (beforeContent && beforeContent !== "none" && beforeContent !== "normal") {
              const bgHex = rgb2hex(liBeforeCs.backgroundColor);
              bulletColor = bgHex || rgb2hex(liBeforeCs.color) || pseudoBulletColor;
              // A non-transparent background with EMPTY content is a CSS-drawn
              // dot (the marker IS the box), distinct from a literal-glyph
              // ::before (content:'•') coloured via `color`.
              const emptyContent = beforeContent === '""' || beforeContent === "''";
              bulletIsDot = !!bgHex && emptyContent;
            }
          } catch (_) {}
        }
        items.push({
          text: text.trim(),
          runs,
          level,
          fontFamily: liStyle.fontFamily,
          fontSize: liStyle.fontSize,
          fontWeight: liStyle.fontWeight,
          fontStyle: liStyle.fontStyle,
          color: liStyle.color,
          lineHeight: liStyle.lineHeight,
          textAlign: liStyle.textAlign,
          spacingAfter: Math.round(spacingBottom + spacingTop),
          marginBottom,
          marginTop,
          borderBottom: liStyle.borderBottom > 0 ? liStyle.borderBottomColor : null,
          bgColor: liStyle.bgColor,
          bgAlpha: liStyle.bgAlpha,
          borderColor: liStyle.borderColor,
          borderWidth: liStyle.borderWidth,
          borderStyle: liStyle.borderStyle,
          borderSides: liStyle.borderSides,
          borderRadius: liStyle.borderRadius,
          cornerRadii: liStyle.cornerRadii,
          bulletColor,
          bulletIsDot,
          padding: {
            top: parseFloat(liCs.paddingTop) || 0,
            right: parseFloat(liCs.paddingRight) || 0,
            bottom: parseFloat(liCs.paddingBottom) || 0,
            left: parseFloat(liCs.paddingLeft) || 0,
          },
          bounds: getBounds(li),
        });
        const nested = li.querySelector("ul, ol");
        if (nested) walkItems(nested, level + 1);
      }
    }
    walkItems(list, 0);
    // Per-item decoration detection: if ANY item has borderBottom / bgColor /
    // any side border / non-default borderRadius, the list is "styled" and
    // must be rendered per-item (so we can paint boxes). If all items are
    // pure text, the caller can render as a native bulleted/numbered list.
    const anyStyledItem = items.some(it =>
      it.borderBottom ||
      (it.bgColor && it.bgColor !== null) ||
      (it.borderWidth && it.borderWidth > 0) ||
      (it.borderRadius && it.borderRadius > 0)
    );
    // "Container list" = a card/panel that WRAPS a row of items.
    // Triggered either by the <ul>/<ol> having its own bg/border/radius, or
    // by a majority of items using border-bottom as row separator. In that
    // case the container itself is the visual affordance and the rows inside
    // SHOULD NOT get per-row bullet/number markers — the user reads them as
    // card rows, not list entries.
    const containerHasBox = !!style.bgColor || (style.borderWidth || 0) > 0 || (style.borderRadius || 0) > 0;
    // A row-separator <li> has a border-BOTTOM only (no full-box border, no
    // bg, no radius). `it.borderWidth = max(all sides)`, so a bottom-only
    // border registers as borderWidth>0 — we detect "full box" via bgColor or
    // borderRadius instead. If an <li> has borderBottom AND no other
    // decoration, it reads as a divider between rows, not a card.
    const rowSeparatorCount = items.filter(it =>
      !!it.borderBottom && !it.bgColor && !(it.borderRadius > 0)
    ).length;
    const isContainerList = containerHasBox || rowSeparatorCount >= Math.max(1, Math.ceil(items.length / 2));
    return {
      type: "list", bounds, ordered, items, columnCount, listStyleType,
      hasPseudoBullet, pseudoBulletChar, pseudoBulletColor,
      anyStyledItem,
      isContainerList,
      // List container's own box — so convert-pptx can paint the background
      // rounded rect / border around the bulleted list (e.g. features card).
      containerStyle: {
        bgColor: style.bgColor,
        fillAlpha: style.bgAlpha,
        borderWidth: style.borderWidth,
        borderColor: style.borderColor,
        borderStyle: style.borderStyle,
        borderSides: style.borderSides,
        borderRadius: style.borderRadius,
        cornerRadii: style.cornerRadii,
        padding: (() => {
          const lcs = getComputedStyle(list);
          return {
            top: parseFloat(lcs.paddingTop) || 0,
            right: parseFloat(lcs.paddingRight) || 0,
            bottom: parseFloat(lcs.paddingBottom) || 0,
            left: parseFloat(lcs.paddingLeft) || 0,
          };
        })(),
      },
      style: { fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color },
    };
  }

  // --- HELPERS ---
  const INLINE_TAGS = ["SPAN", "STRONG", "B", "EM", "I", "A", "CODE", "MARK", "SMALL", "SUB", "SUP", "U"];

  function applyTextTransform(text: string, transform: string): string {
    if (transform === "uppercase") return text.toUpperCase();
    if (transform === "lowercase") return text.toLowerCase();
    return text;
  }

  function getDirectText(el: Element): string {
    const parts: { type: string; value?: string }[] = [];
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        parts.push({ type: "text", value: node.textContent!.replace(/[ \t\n\r\f]+/g, " ") });
      } else if (node.nodeType === 1) {
        const tag = ((node as Element).tagName || "").toUpperCase();
        if (tag === "BR") {
          parts.push({ type: "br" });
        } else if (INLINE_TAGS.includes(tag)) {
          const childCs = getComputedStyle(node as Element);
          if (childCs.position === "absolute" || childCs.position === "fixed") continue;
          // Adjacent inline siblings separated only by `margin-left` (no
          // whitespace text node between them, e.g. <span>April</span><span
          // style="margin-left:6px">2026</span>) collapse into one token if
          // we just concatenate. Insert a single space when the previous
          // emitted text doesn't already end with whitespace and the new
          // text doesn't already start with whitespace — prevents double
          // spaces while still fixing slide_18's "April2026" collision.
          const ml = parseFloat(childCs.marginLeft) || 0;
          const text = node.textContent!.replace(/[ \t\n\r\f]+/g, " ");
          if (ml > 2 && parts.length > 0) {
            const prev = parts[parts.length - 1];
            const prevVal = prev.type === "text" ? (prev.value || "") : "";
            if (prevVal && !/\s$/.test(prevVal) && !/^\s/.test(text)) {
              parts.push({ type: "text", value: " " });
            }
          }
          parts.push({ type: "text", value: text });
        }
      }
    }
    let text = "";
    for (const p of parts) {
      if (p.type === "br") text += "\n";
      else text += p.value;
    }
    text = text.replace(/ {2,}/g, " ");
    return text;
  }

  function getTextRuns(el: Element, parentStyle: ElementStyle): TextRun[] {
    const runs: TextRun[] = [];
    // Flex/grid containers blockify inline-level children: an in-flow <span>
    // inside `display:flex` reports computed `display:block` even though it
    // lays out as an inline-row flex item with NO visual line break before
    // it. The original isBlock-injects-\n logic was written for genuine
    // `<span style="display:block">` patterns; honouring it for flex/grid
    // items wedges a literal "\n" between every styled span on slide_15
    // .line code rows (verified: 21 lines × ≥1 \n each in slide1.xml).
    // pptxgenjs writes the \n into <a:t> and Slides renders each span on
    // its own visual line. Detecting the parent display once disables the
    // blockification-derived \n for flex/grid children while preserving it
    // for real block spans.
    const parentCs = getComputedStyle(el);
    const parentIsFlexOrGrid =
      parentCs.display === "flex" || parentCs.display === "inline-flex" ||
      parentCs.display === "grid" || parentCs.display === "inline-grid";
    const parentColumnGapPx = parentIsFlexOrGrid
      ? (parseFloat(parentCs.columnGap) || parseFloat(parentCs.gap) || 0)
      : 0;
    let inlineFlowChildCount = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const t = node.textContent!.replace(/[ \t\n\r\f]+/g, " ");
        if (t) runs.push({ text: t, style: null });
      } else if (node.nodeType === 1) {
        const tag = ((node as Element).tagName || "").toUpperCase();
        if (tag === "BR") {
          runs.push({ text: "\n", style: null });
        } else if (INLINE_TAGS.includes(tag)) {
          const cs = getComputedStyle(node as Element);
          if (cs.position === "absolute" || cs.position === "fixed") continue;
          // A span (or other inline tag) with `display: block` acts as a
          // block-level element — insert a line break before its content so
          // text doesn't concatenate on the same line.
          const isBlock = cs.display === "block" || cs.display === "flex" ||
            cs.display === "grid" || cs.display === "table";
          // Don't emit \n for inline tags that only appear "block" because
          // they are flex items inside a <li> (flex children get computed
          // display:block).  The list extractor already handles line breaks
          // between list items.
          const inListItem = !!(node as Element).closest?.("li");
          if (isBlock && !inListItem && !parentIsFlexOrGrid && runs.length > 0) {
            runs.push({ text: "\n", style: null });
          }
          const rawRunText = node.textContent!.replace(/[ \t\n\r\f]+/g, " ");
          const runText = applyTextTransform(rawRunText, cs.textTransform);
          if (parentColumnGapPx > 2 && inlineFlowChildCount > 0 && runText && !/^\s/.test(runText)) {
            const gapFontSize = parseFloat(cs.fontSize) || parentStyle.fontSize || 16;
            runs.push({
              text: " ".repeat(Math.max(1, Math.round(parentColumnGapPx / gapFontSize))),
              style: null,
            });
          }
          if (runText) inlineFlowChildCount++;
          // Mirror getDirectText: a margin-left on the inline child
          // introduces a visual gap between sibling spans that otherwise
          // would concatenate (slide_18 "April 2026").
          const mL = parseFloat(cs.marginLeft) || 0;
          if (mL > 2 && runs.length > 0) {
            const prev = runs[runs.length - 1];
            if (prev.text && !/\s$/.test(prev.text) && prev.text !== "\n") {
              runs.push({ text: " ", style: null });
            }
          }
          // Inline backgrounds on span runs (`.code { background: #f0f4f8 }`,
          // `.highlight { background: #fefcbf }`) — the rect emitter skips
          // these because they sit *inside* a text flow (no layout box of its
          // own on wrapped lines). Capture on the run so pptxgenjs can paint
          // the highlight per-run via the `highlight` option.
          const csBg = rgb2hex(cs.backgroundColor);
          const parentBg = parentStyle.bgColor || null;
          // vertical-align: sub / super → pptxgenjs subscript/superscript.
          const va = cs.verticalAlign;
          const verticalAlign: "sub" | "super" | "baseline" =
            va === "sub" ? "sub" : va === "super" ? "super" : "baseline";
          const childStyle = {
            // Inline gradient-text spans (`<span class="gradient-text">` with
            // `-webkit-background-clip: text`) use `resolveGradientTextColor`
            // first so slide_25's accent span resolves to the mean of its
            // own stops instead of inheriting the paragraph colour.
            color: resolveGradientTextColor(cs) || rgb2hex(cs.color),
            fontWeight: resolveRenderedWeight(
              cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
              cs.fontWeight === "bold" ? 700 : parseInt(cs.fontWeight) || 400,
            ),
            fontStyle: (cs.fontStyle === "italic" ? "italic" : "normal") as "italic" | "normal",
            fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
            fontSize: parseFloat(cs.fontSize),
            textDecoration: cs.textDecorationLine !== "none" ? cs.textDecorationLine : null,
            letterSpacing: parseFloat(cs.letterSpacing) || 0,
            bgColor: csBg && csBg !== parentBg ? csBg : null,
            verticalAlign,
          };
          const differs = childStyle.color !== parentStyle.color ||
            childStyle.fontWeight !== parentStyle.fontWeight ||
            childStyle.fontStyle !== parentStyle.fontStyle ||
            childStyle.fontSize !== parentStyle.fontSize ||
            childStyle.textDecoration !== parentStyle.textDecoration ||
            childStyle.letterSpacing !== parentStyle.letterSpacing ||
            !!childStyle.bgColor ||
            childStyle.verticalAlign !== "baseline";
          // Insert a separator space when this inline span starts with a
          // CSS `margin-left` gap and the previous run doesn't already end
          // with whitespace (mirrors getDirectText). Without this, adjacent
          // styled spans like <span>April</span><span style="margin-left:6px">2026</span>
          // collapse into "April2026".
          const ml = parseFloat(cs.marginLeft) || 0;
          if (ml > 2 && runs.length > 0 && runText && !/^\s/.test(runText)) {
            const prev = runs[runs.length - 1];
            if (prev.text && !/\s$/.test(prev.text)) {
              runs.push({ text: " ", style: null });
            }
          }
          runs.push({ text: runText, style: differs ? childStyle : null });
          const mr = parseFloat(cs.marginRight) || 0;
          if (mr > 2 && runText) {
            const gapFontSize = parseFloat(cs.fontSize) || parentStyle.fontSize || 16;
            runs.push({
              text: " ".repeat(Math.max(1, Math.round(mr / gapFontSize))),
              style: null,
            });
          }
        } else {
          // Block-level children (div, p, etc.) — recurse so nested text
          // content (e.g. `<div class="price">$29<span>/mo</span></div>`
          // inside a <td>) produces styled runs instead of being lost.
          const childCs = getComputedStyle(node as Element);
          if (childCs.position === "absolute" || childCs.position === "fixed") continue;
          if (childCs.display === "none") continue;
          if (runs.length > 0) runs.push({ text: "\n", style: null });
          const childStyle = getStyle(node as Element);
          const childRuns = getTextRuns(node as Element, childStyle);
          runs.push(...childRuns);
        }
      }
    }
    return runs;
  }

  // --- Emit helpers ---
  function emitBorderLines(s: ElementStyle, b: Bounds): void {
    if (s.borderBottom > 0 && s.borderBottomColor && b.w > 10) {
      elements.push({ type: "line", bounds: { x: b.x, y: b.y + b.h, w: b.w, h: s.borderBottom }, color: s.borderBottomColor });
    }
    if (s.borderTop > 0 && s.borderTopColor && b.w > 10) {
      elements.push({ type: "line", bounds: { x: b.x, y: b.y, w: b.w, h: s.borderTop }, color: s.borderTopColor });
    }
    if (s.borderLeft > 0 && s.borderLeftColor && b.h > 10) {
      elements.push({ type: "line", bounds: { x: b.x, y: b.y, w: s.borderLeft, h: b.h }, color: s.borderLeftColor });
    }
    if (s.borderRight > 0 && s.borderRightColor && b.h > 10) {
      elements.push({ type: "line", bounds: { x: b.x + b.w, y: b.y, w: s.borderRight, h: b.h }, color: s.borderRightColor });
    }
  }

  /**
   * Emit a rect element for the converter.
   * Includes per-corner radii, per-side borders, and border uniformity for the converter
   * to choose the right Slides shape type and border rendering strategy.
   * See "Border & Corner Radius Rendering Rules" at the top of this file.
   */
  /** Parse CSS linear-gradient into angle + color stops for Slides API */
  function parseLinearGradient(bgImg: string): { angle: number; stops: { color: string; position: number }[] } | null {
    if (!bgImg || !bgImg.includes("linear-gradient")) return null;
    // Extract everything between "linear-gradient(" and the final ")"
    // Can't use [^)]+ because rgb() has nested parens
    const startIdx = bgImg.indexOf("linear-gradient(") + "linear-gradient(".length;
    const endIdx = bgImg.lastIndexOf(")");
    if (startIdx < 0 || endIdx < startIdx) return null;
    const parts = bgImg.substring(startIdx, endIdx);
    // Extract angle
    let angle = 180; // default: top to bottom
    const angleMatch = parts.match(/(\d+)deg/);
    if (angleMatch) angle = parseInt(angleMatch[1]);
    else if (parts.startsWith("to right")) angle = 90;
    else if (parts.startsWith("to left")) angle = 270;
    else if (parts.startsWith("to bottom")) angle = 180;
    else if (parts.startsWith("to top")) angle = 0;
    // Extract color stops — two-pass so we can interpolate default positions
    // evenly across all stops when only some (or none) specify explicit %.
    const raw: { color: string; position: number | null }[] = [];
    const colorRegex = /(#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\))\s*(\d+%)?/g;
    let cm;
    while ((cm = colorRegex.exec(parts)) !== null) {
      const hex = rgb2hex(cm[1]) || cm[1];
      if (hex) raw.push({ color: hex, position: cm[2] ? parseInt(cm[2]) / 100 : null });
    }
    if (raw.length < 2) return null;
    // First and last default to 0 and 1; middles interpolate evenly.
    if (raw[0].position === null) raw[0].position = 0;
    if (raw[raw.length - 1].position === null) raw[raw.length - 1].position = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      if (raw[i].position === null) raw[i].position = i / (raw.length - 1);
    }
    const stops = raw.map(s => ({ color: s.color, position: s.position as number }));
    return { angle, stops };
  }

  // Parse CSS radial-gradient into stops with per-stop alpha so the gradFill
  // injector can emit an OOXML radial `<a:gradFill><a:path path="circle">` fill.
  // `transparent` stops keep alpha=0; their color inherits the adjacent real
  // stop's hex so OOXML's alpha interpolation doesn't bleed a stray dark tint.
  function parseRadialGradient(bgImg: string): { type: "radial"; stops: { color: string; alpha: number; position: number }[] } | null {
    if (!bgImg || !bgImg.includes("radial-gradient")) return null;
    const startIdx = bgImg.indexOf("radial-gradient(") + "radial-gradient(".length;
    const endIdx = bgImg.lastIndexOf(")");
    if (startIdx < 0 || endIdx < startIdx) return null;
    const parts = bgImg.substring(startIdx, endIdx);
    const raw: { color: string; alpha: number; position: number | null }[] = [];
    const tokenRegex = /(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|transparent)\s*(\d+%)?/gi;
    let cm;
    while ((cm = tokenRegex.exec(parts)) !== null) {
      const tok = cm[1];
      const pos = cm[2] ? parseInt(cm[2]) / 100 : null;
      const a = rgbAlpha(tok);
      if (/^transparent$/i.test(tok) || a === 0) {
        raw.push({ color: "#000000", alpha: 0, position: pos });
      } else {
        const hex = rgb2hex(tok);
        if (hex) raw.push({ color: hex, alpha: a, position: pos });
      }
    }
    if (raw.length < 2) return null;
    if (raw[0].position === null) raw[0].position = 0;
    if (raw[raw.length - 1].position === null) raw[raw.length - 1].position = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      if (raw[i].position === null) raw[i].position = i / (raw.length - 1);
    }
    let lastReal = raw.find(s => s.alpha > 0)?.color;
    if (lastReal) {
      for (const s of raw) {
        if (s.alpha === 0) s.color = lastReal!;
        else lastReal = s.color;
      }
    }
    return {
      type: "radial",
      stops: raw.map(s => ({ color: s.color, alpha: s.alpha, position: s.position as number })),
    };
  }

  /**
   * Detect CSS border-triangle: `width:0; height:0` (or near-zero) element
   * whose painted area comes entirely from four asymmetric borders — one
   * colored side + opposite-axis transparent sides — producing a triangle.
   *
   * Example (points right):
   *   border-left: 12px solid #cbd5e1;
   *   border-top: 8px solid transparent;
   *   border-bottom: 8px solid transparent;
   *   width: 0; height: 0;
   *
   * Returns { fill, rotate } when the element is a border-triangle, else null.
   * `rotate` is degrees clockwise to apply to pptxgenjs `triangle` preset
   * (apex-up by default): 0=up, 90=right, 180=down, 270=left.
   */
  function detectBorderTriangle(el: Element, s: ElementStyle, b: Bounds): { fill: string; rotate: number } | null {
    // A CSS border-triangle's bounding box equals (borderLeft+borderRight) ×
    // (borderTop+borderBottom) — there's no content inside. Checking the
    // bounds against the border sums works regardless of `box-sizing`
    // (`getComputedStyle(...).width` returns border-box width when
    // `box-sizing: border-box` is inherited, which is misleading here).
    const bT = s.borderTop || 0, bR = s.borderRight || 0, bB = s.borderBottom || 0, bL = s.borderLeft || 0;
    const totalW = bL + bR, totalH = bT + bB;
    // Bounds must match the border sums within 1px — i.e. content area is 0.
    if (Math.abs(b.w - totalW) > 1.5 || Math.abs(b.h - totalH) > 1.5) return null;
    // Avoid matching zero-sized boxes with no borders.
    if (totalW < 2 || totalH < 2) return null;
    const cT = s.borderTopColor, cR = s.borderRightColor, cB = s.borderBottomColor, cL = s.borderLeftColor;
    // A side is "colored" if width > 0 and color is not null/transparent.
    const sides = [
      { dir: "top",    w: bT, c: cT, rotate: 180 }, // color on top → apex points down
      { dir: "right",  w: bR, c: cR, rotate: 270 }, // color on right → apex points left
      { dir: "bottom", w: bB, c: cB, rotate: 0   }, // color on bottom → apex points up
      { dir: "left",   w: bL, c: cL, rotate: 90  }, // color on left → apex points right
    ];
    const colored = sides.filter(x => x.w > 0 && x.c);
    if (colored.length !== 1) return null;
    const only = colored[0];
    // The two perpendicular sides must both exist with non-zero width (they
    // define the triangle base) and be transparent (color null).
    let perp1: { w: number; c: string | null }, perp2: { w: number; c: string | null };
    if (only.dir === "left" || only.dir === "right") {
      perp1 = { w: bT, c: cT }; perp2 = { w: bB, c: cB };
    } else {
      perp1 = { w: bL, c: cL }; perp2 = { w: bR, c: cR };
    }
    if (perp1.w <= 0 || perp2.w <= 0) return null;
    if (perp1.c || perp2.c) return null; // must be transparent
    return { fill: only.c!, rotate: only.rotate };
  }

  function borderChevronFromStyle(s: ElementStyle, b: Bounds): { color: string; width: number; rotate: number; bars: { x: number; y: number; w: number; h: number }[] } | null {
    const width = s.naturalWidth || b.w;
    const height = s.naturalHeight || b.h;
    if (width < 2 || height < 2) return null;
    if (Math.abs(width - height) > Math.max(2, Math.min(width, height) * 0.25)) return null;

    const sides = [
      { dir: "top", w: s.borderTop || 0, c: s.borderTopColor },
      { dir: "right", w: s.borderRight || 0, c: s.borderRightColor },
      { dir: "bottom", w: s.borderBottom || 0, c: s.borderBottomColor },
      { dir: "left", w: s.borderLeft || 0, c: s.borderLeftColor },
    ];
    const colored = sides.filter(side => side.w > 0 && side.c);
    if (colored.length !== 2) return null;
    if (colored[0].c !== colored[1].c || Math.abs(colored[0].w - colored[1].w) > 0.5) return null;
    const dirs = colored.map(side => side.dir).sort().join(",");
    const adjacent = dirs === "left,top" || dirs === "bottom,left" || dirs === "bottom,right" || dirs === "right,top";
    if (!adjacent) return null;
    if (sides.some(side => !colored.includes(side) && side.w > 0 && side.c)) return null;

    const bw = colored[0].w;
    const bars = colored.map(side => {
      if (side.dir === "top") return { x: 0, y: 0, w: width, h: bw };
      if (side.dir === "right") return { x: width - bw, y: 0, w: bw, h: height };
      if (side.dir === "bottom") return { x: 0, y: height - bw, w: width, h: bw };
      return { x: 0, y: 0, w: bw, h: height };
    });
    return {
      color: colored[0].c!,
      width: bw,
      rotate: s.rotate || 0,
      bars,
    };
  }

  function detectBorderChevron(el: Element, s: ElementStyle, b: Bounds): { color: string; width: number; rotate: number; sourceBounds: Bounds; sourceWidth: number; sourceHeight: number; bars: { x: number; y: number; w: number; h: number }[] } | null {
    const ch = borderChevronFromStyle(s, b);
    if (!ch) return null;
    return {
      ...ch,
      sourceBounds: b,
      sourceWidth: s.naturalWidth || b.w,
      sourceHeight: s.naturalHeight || b.h,
    };
  }

  function emitTriangle(b: Bounds, fill: string, rotate: number, s: ElementStyle): void {
    elements.push({
      type: "triangle",
      bounds: b,
      fill,
      rotate,
      zIndex: s.zIndex,
      position: s.position,
    });
  }

  function emitChevron(ch: { color: string; rotate: number; sourceBounds: Bounds; sourceWidth: number; sourceHeight: number; bars: { x: number; y: number; w: number; h: number }[] }, s: ElementStyle): void {
    const cx = ch.sourceBounds.x + ch.sourceBounds.w / 2;
    const cy = ch.sourceBounds.y + ch.sourceBounds.h / 2;
    const localCx = ch.sourceWidth / 2;
    const localCy = ch.sourceHeight / 2;
    const rad = ch.rotate * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const project = (x: number, y: number): { x: number; y: number } => {
      const dx = x - localCx;
      const dy = y - localCy;
      return {
        x: cx + dx * cos - dy * sin,
        y: cy + dx * sin + dy * cos,
      };
    };
    for (const bar of ch.bars) {
      const horizontal = bar.w >= bar.h;
      const p1 = horizontal
        ? project(bar.x, bar.y + bar.h / 2)
        : project(bar.x + bar.w / 2, bar.y);
      const p2 = horizontal
        ? project(bar.x + bar.w, bar.y + bar.h / 2)
        : project(bar.x + bar.w / 2, bar.y + bar.h);
      elements.push({
        type: "line",
        bounds: {
          x: Math.min(p1.x, p2.x),
          y: Math.min(p1.y, p2.y),
          w: Math.abs(p2.x - p1.x),
          h: Math.abs(p2.y - p1.y),
        },
        color: ch.color,
        strokeWidth: horizontal ? bar.h : bar.w,
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        zIndex: s.zIndex,
        position: s.position,
      });
    }
  }

  function emitAbsoluteChildChevrons(host: Element): void {
    for (const child of Array.from((host as HTMLElement).children)) {
      if (seen.has(child)) continue;
      const cs = getComputedStyle(child);
      if (cs.position !== "absolute" && cs.position !== "fixed") continue;
      const childBounds = getBounds(child);
      if (!isVisible(child, childBounds)) continue;
      const childStyle = getStyle(child);
      const chev = detectBorderChevron(child, childStyle, childBounds);
      if (!chev) continue;
      seen.add(child);
      emitChevron(chev, childStyle);
    }
  }

  function emitRect(el: Element, s: ElementStyle, b: Bounds): void {
    // No size filter: if CSS paints a box, we extract it. Filtering by dimension
    // previously dropped 2px connector/divider divs. Zero-area elements are
    // rejected upstream by isVisible().
    const hasBg = !!s.bgColor;
    const hasLinearGradient = !!(s.backgroundImage && s.backgroundImage.includes("linear-gradient"));
    // Radial gradients can't be expressed in OOXML but we approximate with first-stop solid.
    const hasRadialGradient = !!(s.backgroundImage && s.backgroundImage.includes("radial-gradient") && !hasLinearGradient);
    const hasGradient = hasLinearGradient;
    const hasBorder = s.borderWidth >= 1 && !!s.borderColor;
    if (!hasBg && !hasGradient && !hasRadialGradient && !hasBorder) return;
    // CSS text-clip gradient trick: `background: linear-gradient(...);
    // -webkit-background-clip: text; -webkit-text-fill-color: transparent`
    // fills only the text glyphs with the gradient. Emitting the gradient as
    // the element's box fill produces a solid-colored rectangle over the
    // transparent text — worse than just rendering the text in the gradient's
    // dominant color. Skip the rect and let the text path paint it normally.
    const elCs2 = getComputedStyle(el);
    const clip = vendorCss(elCs2).backgroundClip || vendorCss(elCs2).webkitBackgroundClip;
    if (clip === "text") return;

    // For transparent elements with borders, detect background color underneath
    let fill = s.bgColor || null;
    if (!fill && !hasGradient && hasBorder) {
      fill = detectBgColorBelow(el);
    }

    // Parse gradient if present (use first color as solid fallback too)
    let gradient = hasLinearGradient ? parseLinearGradient(s.backgroundImage!) : null;
    if (gradient && !fill) {
      fill = gradient.stops[0].color; // solid fallback
    }

    // Radial-gradient: emit an OOXML radial `<a:gradFill><a:path path="circle">`
    // via the injector so `.bg-glow` fades from its center stop out to the
    // transparent edge stop instead of painting a hard-edged disc. Also compute
    // a solid-color fallback (first non-transparent stop) so if the injector
    // fails to patch the shape, the glow degrades to a visible ellipse rather
    // than an invisible one.
    let radialFillAlpha: number | null = null;
    if (hasRadialGradient && !gradient) {
      const radial = parseRadialGradient(s.backgroundImage!);
      if (radial && radial.stops.length >= 2) {
        gradient = radial;
        if (!fill) {
          const firstReal = radial.stops.find(st => st.alpha > 0) || radial.stops[0];
          fill = firstReal.color;
          if (firstReal.alpha < 1) radialFillAlpha = firstReal.alpha;
        }
      }
    }

    // Combine CSS `opacity` with rgba alpha so semi-transparent elements
     // (e.g. slide_28's `.badge.opacity-50 { opacity: 0.5 }`) render faded.
    let bgA = s.bgAlpha ?? 1;
    const opA = typeof s.opacity === "number" && s.opacity < 1 ? s.opacity : 1;

    // Pre-blend a translucent solid fill into an opaque hex when the element
    // has a visible border AND the fill alpha is very low (≤10%). Google
    // Slides composes a 1px translucent border over an alpha-ed solidFill
    // unreliably at thumbnail scale — the card edge vanishes into the body
    // (slide_17: "outer borders on cards (e.g. Green Capital) missing").
    // Compositing upfront gives the shape a distinct opaque base tone so the
    // border registers against it, and drops the `<a:alpha>` from the emitted
    // fill XML. Scoped to bgA<0.1 so substantial translucent chips (e.g.
    // `.label-badge` with 20% indigo fill — already visible at thumbnail
    // scale) are left alone; only nearly-invisible fills (5% white over navy)
    // get flattened. Skipped for gradient fills (handled by the gradFill
    // injector) and for 0-alpha fills (fully transparent — user's intent).
    if (fill && hasBorder && !gradient && bgA > 0 && bgA < 0.1) {
      const ancestor = detectBgColorBelow(el);
      const fm = fill.replace("#", "").match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
      const am = (ancestor || "").replace("#", "").match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
      if (fm && am) {
        const fr = parseInt(fm[1], 16), fg = parseInt(fm[2], 16), fb = parseInt(fm[3], 16);
        const ar = parseInt(am[1], 16), ag = parseInt(am[2], 16), ab = parseInt(am[3], 16);
        const toHex2 = (v: number) => v.toString(16).padStart(2, "0");
        fill = "#" + [
          Math.round(fr * bgA + ar * (1 - bgA)),
          Math.round(fg * bgA + ag * (1 - bgA)),
          Math.round(fb * bgA + ab * (1 - bgA)),
        ].map(toHex2).join("");
        bgA = 1;
      }
    }
    // Spread-only box-shadow layers (`0 0 0 Npx color`) are concentric halo
    // rings that OOXML's shadow effect can't express — materialize them as
    // solid concentric rects painted BEHIND the element. CSS paints later
    // layers first, so emit in reverse: the outermost ring goes down first,
    // then inner rings on top, then the element last.
    const rings: ShadowRing[] | undefined = s.shadowRings;
    if (rings && rings.length) {
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        const sp = ring.spread;
        const hb: Bounds = { x: b.x - sp, y: b.y - sp, w: b.w + 2 * sp, h: b.h + 2 * sp };
        const haloR = s.borderRadius + sp;
        elements.push({
          type: "rect", bounds: hb, fill: ring.color,
          fillAlpha: ring.alpha * opA,
          gradient: null,
          borderRadius: haloR,
          cornerRadii: { tl: haloR, tr: haloR, br: haloR, bl: haloR },
          borderUniform: true, borderSides: null,
          borderColor: null, borderWidth: 0, borderStyle: "solid",
          zIndex: s.zIndex, position: s.position, boxShadow: null,
        });
      }
    }
    elements.push({
      type: "rect", bounds: b, fill,
      fillAlpha: (radialFillAlpha ?? bgA) * opA,
      gradient, // null or { angle, stops: [{color, position}] }
      borderRadius: s.borderRadius,
      cornerRadii: s.cornerRadii,
      borderUniform: s.borderUniform,
      borderSides: s.borderSides,
      borderColor: hasBorder ? s.borderColor : null,
      borderWidth: hasBorder ? s.borderWidth : 0,
      borderStyle: s.borderStyle,
      zIndex: s.zIndex,
      position: s.position,
      boxShadow: s.boxShadow,
      // Rotation: CSS transform: rotate(Xdeg). `bounds` is the post-transform
      // axis-aligned bbox; naturalWidth/Height is the pre-transform layout box.
      // Converter uses these to place the rotated rect at bbox center and
      // apply pptxgenjs rotate. Without this, a rotated thin bar (e.g. a 2px
      // line at -8°) extracts as a fat axis-aligned rect and paints as an
      // ugly filled block instead of a thin slanted line.
      rotate: s.rotate || 0,
      naturalWidth: s.naturalWidth,
      naturalHeight: s.naturalHeight,
    });
  }

  // --- PSEUDO-ELEMENT HELPERS ---
  // Compute a pseudo-element's bounds by interpreting its CSS box relative to
  // its host element. `inset: 0` → fills parent; `top: 0; height: 3px` → thin
  // top strip. Works for `position: absolute` pseudos only — static pseudos
  // live inline and we don't try to place those geometrically.
  function pseudoBounds(pcs: CSSStyleDeclaration, hostBounds: Bounds): Bounds | null {
    if (pcs.position !== "absolute") return null;
    const parseLen = (v: string, ref: number): number | null => {
      if (!v || v === "auto") return null;
      if (v.endsWith("%")) return (parseFloat(v) / 100) * ref;
      return parseFloat(v);
    };
    const top = parseLen(pcs.top, hostBounds.h);
    const bottom = parseLen(pcs.bottom, hostBounds.h);
    const left = parseLen(pcs.left, hostBounds.w);
    const right = parseLen(pcs.right, hostBounds.w);
    const w = parseLen(pcs.width, hostBounds.w);
    const h = parseLen(pcs.height, hostBounds.h);
    let x = hostBounds.x + (left ?? 0);
    let y = hostBounds.y + (top ?? 0);
    let ww = w ?? (right != null ? hostBounds.w - (left ?? 0) - right : hostBounds.w - (left ?? 0));
    let hh = h ?? (bottom != null ? hostBounds.h - (top ?? 0) - bottom : hostBounds.h - (top ?? 0));
    // Translate per `transform: translate(...)`
    const tm = (pcs.transform || "").match(/matrix\(([^)]+)\)/);
    if (tm) {
      const nums = tm[1].split(",").map(n => parseFloat(n));
      if (nums.length === 6) { x += nums[4]; y += nums[5]; }
    }
    return { x, y, w: Math.max(0, ww), h: Math.max(0, hh) };
  }

  // Pseudo-element visual box (::before / ::after with bg/border/radius) —
  // e.g. `.logo-card::before` accent stripes, CSS border-triangle arrows.
  // Only emitted when the pseudo is absolutely positioned so we can compute
  // its bounds from CSS. Inline pseudos are handled by emitPseudoText below.
  function emitPseudoRect(el: Element, bounds: Bounds): void {
    for (const which of ["::before", "::after"] as const) {
      const pcs = getComputedStyle(el, which);
      const content = pcs.content || "";
      // `content: none` → pseudo doesn't exist. Empty string (`content: ''`)
      // is VALID and renders — commonly used for visual-only decorative
      // pseudos like the nested white+blue inset rings in slide_04's current
      // dot (`.dot.current::after/::before { content: ''; inset: 4px; … }`).
      if (content === "none") continue;
      const bg = rgb2hex(pcs.backgroundColor);
      const bwT = parseFloat(pcs.borderTopWidth) || 0;
      const bwR = parseFloat(pcs.borderRightWidth) || 0;
      const bwB = parseFloat(pcs.borderBottomWidth) || 0;
      const bwL = parseFloat(pcs.borderLeftWidth) || 0;
      const borderMax = Math.max(bwT, bwR, bwB, bwL);
      const br = parseFloat(pcs.borderTopLeftRadius) || 0;
      // Pseudo with ONLY a background-IMAGE (gradient strip) — no solid
      // fill/border/radius — is skipped by the solid-fill path below. Emit it
      // as a thin line so decorative strips aren't dropped. slide_33
      // `.road::before` is a repeating white→transparent gradient (a dashed
      // centerline); a fixed `background-size` + a transparent stop marks the
      // dash pattern → sysDash, otherwise a solid strip.
      const pbgImg = pcs.backgroundImage || "";
      if (!bg && borderMax === 0 && br === 0) {
        if (pbgImg.includes("gradient")) {
          const lpb = pseudoBounds(pcs, bounds);
          if (lpb && lpb.w >= 1 && lpb.h >= 1 && (lpb.h <= 8 || lpb.w <= 8)) {
            const bsize = pcs.backgroundSize || "";
            const repeating = !!bsize && !/auto|cover|contain/.test(bsize);
            const hasTransparentStop = /transparent|rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(pbgImg);
            // First gradient stop with non-trivial alpha = the visible dash color.
            let stripColor = "#ffffff";
            for (const tok of pbgImg.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g) || []) {
              const am = tok.match(/,\s*([\d.]+)\s*\)$/);
              if (!am || parseFloat(am[1]) > 0.1) { stripColor = rgb2hex(tok) || "#ffffff"; break; }
            }
            // Deferred so it appends at the end of the array (paints on top of
            // the road, and keeps existing shape indices stable for a clean diff).
            _deferredEls.push({
              type: "line",
              bounds: lpb,
              color: stripColor,
              dashType: repeating && hasTransparentStop ? "sysDash" : "solid",
              zIndex: 999,
              position: "absolute",
            });
          }
        }
        continue;
      }
      const pb = pseudoBounds(pcs, bounds);
      if (!pb) continue;
      // CSS border-triangle emitted as a ::before/::after — `width:0; height:0`
      // with exactly one coloured border side and transparent perpendiculars
      // (slide_34 `.popup::before` speech-bubble tail). pseudoBounds returns a
      // 0×0 box for `width:0/height:0`, so the rect path below would drop it via
      // the `pb.w < 1` guard (rendering as nothing → "missing triangle"). Build
      // the triangle's real bounding box from the border widths and reuse the
      // host-path detectBorderTriangle/emitTriangle so the converter draws a
      // preset triangle. detectBorderTriangle's own guard (exactly one coloured
      // side, transparent perpendiculars, zero content box) leaves ordinary
      // accent stripes/rings untouched.
      {
        const triStyle = {
          borderTop: bwT, borderTopColor: rgb2hex(pcs.borderTopColor),
          borderRight: bwR, borderRightColor: rgb2hex(pcs.borderRightColor),
          borderBottom: bwB, borderBottomColor: rgb2hex(pcs.borderBottomColor),
          borderLeft: bwL, borderLeftColor: rgb2hex(pcs.borderLeftColor),
          rotate: (() => {
            const tm = (pcs.transform || "").match(/matrix\(([^)]+)\)/);
            if (!tm) return 0;
            const nums = tm[1].split(",").map(n => parseFloat(n));
            if (nums.length < 4) return 0;
            const deg = Math.atan2(nums[1], nums[0]) * 180 / Math.PI;
            return Math.abs(deg) < 0.1 ? 0 : deg;
          })(),
          naturalWidth: parseFloat(pcs.width) || pb.w || bwL + bwR,
          naturalHeight: parseFloat(pcs.height) || pb.h || bwT + bwB,
        } as unknown as ElementStyle;
        const triBounds: Bounds = { x: pb.x, y: pb.y, w: bwL + bwR, h: bwT + bwB };
        const chev = detectBorderChevron(el, triStyle, pb);
        if (chev) {
          emitChevron(chev, {
            zIndex: parseInt(pcs.zIndex) || 999,
            position: pcs.position,
          } as unknown as ElementStyle);
          continue;
        }
        const tri = detectBorderTriangle(el, triStyle, triBounds);
        if (tri) {
          emitTriangle(triBounds, tri.fill, tri.rotate, {
            zIndex: parseInt(pcs.zIndex) || 999,
            position: pcs.position,
          } as unknown as ElementStyle);
          continue;
        }
      }
      if (pb.w < 1 || pb.h < 1) continue;
      const parentCs2 = getComputedStyle(el);
      const parentBT = parseFloat(parentCs2.borderTopWidth) || 0;
      const parentBL_w = parseFloat(parentCs2.borderLeftWidth) || 0;
      const parentBR_w = parseFloat(parentCs2.borderRightWidth) || 0;
      const parentBB_w = parseFloat(parentCs2.borderBottomWidth) || 0;
      // pseudoBounds places the pseudo at bounds.x/y (border-box origin), but
      // CSS `position:absolute` children are offset from the parent's PADDING
      // edge (inside the border). Shift pb to the padding-box position so the
      // corner flush-checks below work when the parent has a border.
      //
      // Full shift. `injectStrokeAlignment` (convert-pptx.ts) rewrites every
      // `<a:ln w=…>` to `algn="in"`, so OOXML strokes are drawn fully INSIDE
      // the border-box — matching CSS. The pseudo with `top:0` belongs at the
      // padding-box top edge (parentBT below the border-box top), so the
      // parent's full top-border row stays visible above a flush top-accent
      // stripe like slide_14 `.logo-card::before` and slide_11 `.card::before`.
      pb.x += parentBL_w;
      pb.y += parentBT;
      // CSS border-triangle: 0×0 box with transparent top/bottom and a
      // colored side — skip as rect; downstream renderers can't reproduce
      // it cleanly. (Leave for a future targeted fix.)
      const pseudoBgAlpha = rgbAlpha(pcs.backgroundColor);
      const pseudoOpacity = parseFloat(pcs.opacity) || 1;
      // Pre-blend transparent pseudo fills against the parent background so
      // Google Slides (which drops <a:alpha> from shape solidFill on import)
      // renders the overlay at the correct opacity rather than 100%.
      let pseudoFill = bg || null;
      let pseudoFillAlpha = pseudoBgAlpha * pseudoOpacity;
      if (pseudoFill && pseudoFillAlpha < 1) {
        const parentBg = rgb2hex(parentCs2.backgroundColor) || detectBgColorBelow(el);
        const blended = rgbaToBlendedHex(pcs.backgroundColor, parentBg);
        if (blended) { pseudoFill = blended; pseudoFillAlpha = 1; }
      }
      // Inherit parent's corner radii for corners of the pseudo that are flush
      // with the parent's corners. Comparison uses the INNER (padding-box) edge
      // of the parent — pb has already been shifted to padding-box coordinates.
      const pseudoCornerRadii = { tl: br, tr: br, br, bl: br };
      const parentOv = parentCs2.overflow;
      const pTL = parseFloat(parentCs2.borderTopLeftRadius) || 0;
      const pTR = parseFloat(parentCs2.borderTopRightRadius) || 0;
      const pBR = parseFloat(parentCs2.borderBottomRightRadius) || 0;
      const pBL = parseFloat(parentCs2.borderBottomLeftRadius) || 0;
      const innerX = bounds.x + parentBL_w;
      const innerY = bounds.y + parentBT;
      const innerRight = bounds.x + bounds.w - parentBR_w;
      const innerBottom = bounds.y + bounds.h - parentBB_w;
      const TOL = 2;
      const flushTopLeft = Math.abs(pb.x - innerX) < TOL && Math.abs(pb.y - innerY) < TOL;
      const flushTopRight = Math.abs((pb.x + pb.w) - innerRight) < TOL && Math.abs(pb.y - innerY) < TOL;
      if (parentOv === "hidden" || parentOv === "clip") {
        if (flushTopLeft) pseudoCornerRadii.tl = Math.max(br, pTL);
        if (flushTopRight) pseudoCornerRadii.tr = Math.max(br, pTR);
        if (Math.abs((pb.x + pb.w) - innerRight) < TOL && Math.abs((pb.y + pb.h) - innerBottom) < TOL)
          pseudoCornerRadii.br = Math.max(br, pBR);
        if (Math.abs(pb.x - innerX) < TOL && Math.abs((pb.y + pb.h) - innerBottom) < TOL)
          pseudoCornerRadii.bl = Math.max(br, pBL);
      }
      // Thin top accent stripe on a rounded overflow:hidden parent
      // (slide_11 SWOT `.card::before { height:4px }`, slide_14 logo
      // `.logo-card::before { height:3px }`). A single `round2SameRect`
      // can't follow the parent's 12 px curve: the OOXML rectRadius is
      // clamped to `min(w,h)/2 ≈ 2 px` because the stripe is only a few px
      // tall, so its corners go almost flat and overshoot the card's curve.
      //
      // Replace the standalone stripe with a sandwich emitted at the parent's
      // FULL bounds — pptxgenjs can then draw a real 12 px corner on the
      // outer shape:
      //   1. OUTER overlay: full parent bounds, stripe color, parent's
      //      per-corner radii.
      //   2. INNER overlay: parent's background color, inset by stripeH +
      //      parentBT on top and parent border widths elsewhere, corners
      //      shrunk by `min(adjacent insets)` (matches the existing rounded-
      //      non-uniform-border sandwich in convert-pptx-lib.ts).
      //   3. (slide_14) STROKE overlay: when the stripe color differs from
      //      the parent's border color, paint the parent's border ring on
      //      top so the side/bottom strips of the outer overlay (still in
      //      stripe color) get repainted to the parent's border color.
      const parentFillHex = rgb2hex(parentCs2.backgroundColor);
      const isThinTopStripe =
        flushTopLeft && flushTopRight &&
        !!pseudoFill && pseudoFillAlpha === 1 &&
        (parentOv === "hidden" || parentOv === "clip") &&
        (pTL > 2 || pTR > 2) &&
        pb.h > 0 &&
        pb.h + parentBT < bounds.h - parentBB_w &&
        !!parentFillHex;
      if (isThinTopStripe) {
        // A thin (few-px) top-accent stripe clipped by the parent's rounded
        // `overflow:hidden` corners is NOT reproducible by composing built-in
        // shapes: a single `round2SameRect` at the stripe's own bounds clamps
        // its rectRadius to `min(w,h)/2 ≈ 2px` (the stripe is only 3-4px tall),
        // so the corners go flat and overshoot the card's ~12px curve. The
        // previous fix synthesised an OUTER full-height rounded overlay + an
        // INNER fill overlay to fake the cut, but the two same-radius arcs
        // compete at the corners and leave white slivers / a wrongly-curved
        // colored border poking past the card top.
        //
        // Per the user's guidance (slide_11 / slide_14): do NOT auto-convert a
        // flat `::before` into a curved border — when the clipped stripe can't
        // be drawn correctly with native shapes, omit it and warn. The parent's
        // own roundRect still paints its perimeter; the accent is cleanly absent
        // rather than artifacted.
        try {
          console.warn(
            "[h2s] dropping clipped thin top-accent stripe (::before) — not " +
            "representable by built-in shapes without artifacts; omitting it.",
          );
        } catch (_) {}
        continue;
      }
      elements.push({
        type: "rect", bounds: pb, fill: pseudoFill, fillAlpha: pseudoFillAlpha,
        gradient: null, borderRadius: Math.max(br, pseudoCornerRadii.tl, pseudoCornerRadii.tr, pseudoCornerRadii.br, pseudoCornerRadii.bl),
        cornerRadii: pseudoCornerRadii,
        borderUniform: bwT === bwR && bwR === bwB && bwB === bwL,
        borderSides: {
          top: { width: bwT, color: rgb2hex(pcs.borderTopColor), style: pcs.borderTopStyle },
          right: { width: bwR, color: rgb2hex(pcs.borderRightColor), style: pcs.borderRightStyle },
          bottom: { width: bwB, color: rgb2hex(pcs.borderBottomColor), style: pcs.borderBottomStyle },
          left: { width: bwL, color: rgb2hex(pcs.borderLeftColor), style: pcs.borderLeftStyle },
        },
        borderColor: rgb2hex(pcs.borderTopColor),
        borderWidth: borderMax,
        borderStyle: pcs.borderTopStyle,
        zIndex: 999, position: "absolute", boxShadow: null,
      });
    }
  }

  // Pseudo-element text (::before / ::after) — e.g. checkmark glyphs inside
  // step dots, chevron separators between cards. These have CSS `content: '✓'`
  // and would otherwise be silently dropped. Emit as a centered text overlay
  // at the host element's bounds.
  function emitPseudoText(el: Element, bounds: Bounds, style: ElementStyle): void {
    for (const which of ["::before", "::after"] as const) {
      const pcs = getComputedStyle(el, which);
      let content = pcs.content || "";
      if (!content || content === "none" || content === "normal") continue;
      content = content.replace(/^['"]|['"]$/g, "").trim();
      if (!content || content === "" || content === '""') continue;
      const fontSize = parseFloat(pcs.fontSize) || 14;
      if (bounds.w < 4 || bounds.h < 4) continue;
      // Absolutely-positioned pseudos with explicit left/right land at their
      // CSS offset, left-aligned — so `.pain::before { content:'!'; left:0 }`
      // sits at the row start, not centred across the whole host.
      let textBounds: Bounds = bounds;
      let textAlign: "left" | "center" = "center";
      if (pcs.position === "absolute") {
        const hasExplicitLeft = pcs.left && pcs.left !== "auto";
        const hasExplicitRight = pcs.right && pcs.right !== "auto";
        if (hasExplicitLeft || hasExplicitRight) {
          const pb = pseudoBounds(pcs, bounds);
          if (pb) {
            const minGlyphW = fontSize * 1.5;
            textBounds = {
              x: pb.x,
              y: pb.y,
              w: Math.max(pb.w, minGlyphW),
              h: Math.max(pb.h, fontSize * 1.4),
            };
            textAlign = "left";
          }
        }
      } else if (which === "::before" && getDirectText(el).trim() !== "") {
        // In-flow (non-absolute) ::before on a text-bearing host is a LEADING
        // glyph PREFIX — slide_13 `.conversion-badge::before{content:'▼'}` is
        // flex-item-1 sitting at the badge's left padding, ahead of the label.
        // The default centers it over the FULL badge box (algn=ctr, cx=full
        // width) so the glyph floats mid-badge to the RIGHT of the left-aligned
        // label (the user's "arrow should be on the left" bug). Anchor it LEFT
        // at the host's padding-left with a narrow glyph-width box and let the
        // leaf text path inset the label past it. Decoupling the glyph's x from
        // the label means it leads at the far left even when the label wraps.
        const hostCs = getComputedStyle(el);
        const hostPadL = parseFloat(hostCs.paddingLeft) || 0;
        const glyphW = Math.max(fontSize * 2, 12);
        textBounds = { x: bounds.x + hostPadL, y: bounds.y, w: glyphW, h: bounds.h };
        textAlign = "left";
      }
      elements.push({
        type: "text",
        bounds: textBounds,
        text: content,
        style: {
          fontFamily: pcs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
          fontSize,
          fontWeight: resolveRenderedWeight(
            pcs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
            pcs.fontWeight === "bold" ? 700 : parseInt(pcs.fontWeight) || 400,
          ),
          fontStyle: pcs.fontStyle === "italic" ? "italic" : "normal",
          color: rgb2hex(pcs.color) || "#000000",
          textAlign,
          lineHeight: parseFloat(pcs.lineHeight) || fontSize * 1.2,
          textDecoration: null,
          textTransform: "none",
          letterSpacing: 0,
          paddingLeft: 0,
          paddingTop: 0,
        },
        runs: [{ text: content, style: null }],
        zIndex: style.zIndex,
        position: style.position,
        verticallyCentered: true,
      });
    }
  }

  // Inline "pill" span (a span with bg/border/radius nested inside a block
  // container) — emit as rect + centered text overlay. Used by the TABLE
  // branch to redraw `<span class="partial">Partial</span>` style pills on
  // top of native cell text. Designed to be reusable by future block-level
  // inline-pill scanners (e.g. list items, cards).
  function emitPillSpan(sp: Element): void {
    const scs = getComputedStyle(sp);
    const sBg = rgb2hex(scs.backgroundColor);
    const sBW = parseFloat(scs.borderTopWidth) || 0;
    const sBR = parseFloat(scs.borderTopLeftRadius) || 0;
    if (!sBg && sBW === 0 && sBR === 0) return;
    const sBounds = getBounds(sp);
    if (sBounds.w < 4 || sBounds.h < 4) return;
    const sBorderColor = rgb2hex(scs.borderTopColor);
    elements.push({
      type: "rect", bounds: sBounds, fill: sBg || null, fillAlpha: 1,
      gradient: null, borderRadius: sBR,
      cornerRadii: { tl: sBR, tr: sBR, br: sBR, bl: sBR },
      borderUniform: true, borderSides: null,
      borderColor: sBW > 0 ? sBorderColor : null,
      borderWidth: sBW, borderStyle: scs.borderTopStyle,
      zIndex: 999, position: "relative", boxShadow: null,
    });
    const spText = (sp.textContent || "").replace(/\s+/g, " ").trim();
    if (spText) {
      elements.push({
        type: "text",
        bounds: sBounds,
        text: spText,
        style: {
          fontFamily: scs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
          fontSize: parseFloat(scs.fontSize),
          fontWeight: resolveRenderedWeight(
            scs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
            scs.fontWeight === "bold" ? 700 : parseInt(scs.fontWeight) || 400,
          ),
          fontStyle: scs.fontStyle === "italic" ? "italic" : "normal",
          color: rgb2hex(scs.color) || "#000000",
          textAlign: "center",
          lineHeight: parseFloat(scs.lineHeight) || parseFloat(scs.fontSize) * 1.2,
          textDecoration: null, textTransform: "none", letterSpacing: 0,
          paddingLeft: 0, paddingTop: 0,
        },
        runs: [{ text: spText, style: null }],
        zIndex: 999, position: "relative",
        verticallyCentered: true,
      });
    }
  }

  // Promote styled inline-block pill chips that were folded into a parent's
  // merged text block. A chip with its OWN non-transparent background and a
  // rounded corner (e.g. slide_31 `.chip` { display:inline-block; background:
  // #ede9fe; border-radius:999px }) collapses to a flat highlighted run in the
  // merge, losing its pill shape/colour/padding. Re-draw each as a standalone
  // rect + centered text ON TOP of the merged text (later push → higher
  // _domIdx → painted last). Gated on inline-block + own bg + radius ≥ 4 so
  // plain inline highlight spans (slide_15/25 `.code` { display:inline }, no
  // radius) keep their existing highlight-run behaviour and are NOT promoted.
  // Chips are DEFERRED (collected here, flushed after the main walk) rather
  // than emitted inline: appending them at the END of the element array gives
  // them the highest _domIdx, so they (a) paint LAST — on top of the merged
  // card text they replace — and (b) don't shift the indices of any existing
  // shape, keeping the structural diff clean (chips show as pure ADDED shapes).
  const _deferredChipSpans: Element[] = [];
  function emitMergedChips(host: Element): void {
    const cands = host.querySelectorAll("span, a, small, strong, b, em, i, label");
    cands.forEach((sp) => {
      const scs = getComputedStyle(sp);
      if (scs.display !== "inline-block") return;
      if (scs.position === "absolute" || scs.position === "fixed") return;
      const sBg = rgb2hex(scs.backgroundColor);
      const sBR = parseFloat(scs.borderTopLeftRadius) || 0;
      if (!sBg || sBR < 4) return;
      const sB = getBounds(sp);
      // Single-line chip only (avoid promoting large inline-block blocks).
      const lh = parseFloat(scs.lineHeight) || parseFloat(scs.fontSize) * 1.2 || 16;
      if (sB.h > lh * 2.2) return;
      _deferredChipSpans.push(sp);
    });
  }

  // --- MAIN WALK ---
  function walk(el: Element): void {
    if (seen.has(el)) return;

    const tag = (el.tagName || "").toUpperCase();
    if (!tag) return;
    if (["SCRIPT", "STYLE", "LINK", "META", "HEAD", "BR", "HR"].includes(tag)) return;

    const bounds = getBounds(el);
    if (!isVisible(el, bounds)) return;

    // Establish a clip mask for this element's DESCENDANTS when the element
    // itself clips overflow with rounded corners. The mask the element
    // *itself* renders under is the OUTER `_currentClipMask` (set by an
    // ancestor); we restore it in `finally` so siblings see the correct
    // ambient. The local clip is recorded into _walkLocalClip so we can
    // re-enter children with it set without recomputing.
    const _outerClipMask = _currentClipMask;
    const _localClipCs = getComputedStyle(el);
    const _localOv = _localClipCs.overflow;
    const _localClips = _localOv === "hidden" || _localOv === "clip"
                     || _localOv === "auto" || _localOv === "scroll";
    const _ltl = parseFloat(_localClipCs.borderTopLeftRadius) || 0;
    const _ltr = parseFloat(_localClipCs.borderTopRightRadius) || 0;
    const _lbr = parseFloat(_localClipCs.borderBottomRightRadius) || 0;
    const _lbl = parseFloat(_localClipCs.borderBottomLeftRadius) || 0;
    const _localMaxR = Math.max(_ltl, _ltr, _lbr, _lbl);
    const _hasLocalClip = _localClips && _localMaxR > 0;
    // Mask propagated to children. Computed eagerly so each branch below can
    // assign it before recursing (e.g. flex/grid loop, generic child loop).
    const _childClipMask: ClipMask | null = _hasLocalClip
      ? refineClipMask(_outerClipMask, {
          bounds: { ...bounds },
          cornerRadii: { tl: _ltl, tr: _ltr, br: _lbr, bl: _lbl },
        })
      : _outerClipMask;

    // TABLE
    if (tag === "TABLE") {
      seen.add(el);
      el.querySelectorAll("tr, td, th, thead, tbody, tfoot").forEach(c => seen.add(c));
      elements.push(extractTable(el as HTMLTableElement));
      // After the table, emit inline "pill" spans (span with bg/border/radius)
      // as rect + centered text overlays. The table's cell-text already
      // contains the same string, but it sits below the pill. We re-draw the
      // text so the `<span class="partial">Partial</span>` amber-on-cream
      // pill effect is reconstructed on top.
      el.querySelectorAll("td span, th span").forEach(sp => emitPillSpan(sp as Element));
      return;
    }

    // LIST
    if (tag === "UL" || tag === "OL") {
      if (!el.parentElement || el.parentElement.tagName.toUpperCase() !== "LI") {
        seen.add(el);
        el.querySelectorAll("li, ul, ol").forEach(c => seen.add(c));
        // Emit the list's own background/border/radius rect BEFORE the list
        // items so the card-style background (e.g. features pricing list with
        // border + radius + bg) gets painted under the bullets.
        const listStyle = getStyle(el);
        emitRect(el, listStyle, bounds);
        elements.push(extractList(el as HTMLElement));
        return;
      }
    }

    // IMG
    if (tag === "IMG") {
      seen.add(el);
      elements.push({ type: "image", bounds, src: (el as HTMLImageElement).src || (el as HTMLImageElement).currentSrc || "" });
      return;
    }

    // SVG / CANVAS
    if (tag === "SVG" || tag === "CANVAS") {
      seen.add(el);
      elements.push({ type: "visual", bounds, tag: tag.toLowerCase() });
      return;
    }

    // CSS effects that truly can't be shapes: conic-gradient, clip-path
    const elCs = getComputedStyle(el);
    const bgImg = elCs.backgroundImage || "";
    const clipP = elCs.clipPath || "";
    const hasCssVisual =
      (bgImg !== "none" && bgImg.includes("conic-gradient")) ||
      (clipP !== "none" && clipP !== "inset(0px)" && clipP.length > 0);
    if (hasCssVisual && bounds.w > 10 && bounds.h > 10) {
      seen.add(el);
      // Mark the host so the screenshot loop can hide descendant text via
      // injected CSS before capture. Children are NOT seen-marked: walk()
      // recurses through them so their native text/rect content emits as
      // editable overlays on top of the captured gradient/clip-path PNG.
      // User feedback (slide_07 donuts, slide_13 funnel stages): "text should
      // never be rendered, … put text as children so it's editable."
      (el as HTMLElement).setAttribute("data-h2s-hide-text", "1");
      elements.push({ type: "visual", bounds, tag: "css-effect" });
      const childArrCss = Array.from((el as HTMLElement).children);
      _currentClipMask = _childClipMask;
      try { for (const c of childArrCss) walk(c); }
      finally { _currentClipMask = _outerClipMask; }
      return;
    }

    // Large-radius overflow:hidden containers (e.g. phone device mockups with
    // border-radius ≥ 20px) clip ALL children at the rounded boundary. PPTX
    // shapes don't inherit parent clipping, so child rects and screenshots
    // protrude past the rounded corners. Screenshot the whole container as a
    // single visual — the browser handles the clipping naturally.
    const elOv = elCs.overflow;
    const elBR = parseFloat(elCs.borderTopLeftRadius) || 0;
    const elBR_tl = parseFloat(elCs.borderTopLeftRadius) || 0;
    const elBR_tr = parseFloat(elCs.borderTopRightRadius) || 0;
    const elBR_br = parseFloat(elCs.borderBottomRightRadius) || 0;
    const elBR_bl = parseFloat(elCs.borderBottomLeftRadius) || 0;
    // Per-corner radii for the captured PNG so the downstream alpha-mask pass
    // can punch the corner pixels transparent — without this, the rectangular
    // screenshot bleeds ancestor-background pixels (light-blue on slide_12's
    // .device inside .left) into the four corner cut-outs.
    const containerCornerRadii = { tl: elBR_tl, tr: elBR_tr, br: elBR_br, bl: elBR_bl };
    if ((elOv === "hidden" || elOv === "clip") && elBR >= 20
        && bounds.w >= 100 && bounds.h >= 100 && (el as HTMLElement).children.length > 0) {
      seen.add(el);
      // Mirror Path A (the conic-gradient / clip-path host above): do NOT
      // seen-mark every descendant. Instead hide their TEXT in the captured
      // PNG via injected CSS (`data-h2s-hide-text`) and re-walk the children
      // below so their text + own-background rects re-emit as EDITABLE
      // overlays, clipped to the device's rounded boundary via _childClipMask.
      // The host PNG stays as background/chrome only (notch, bezel, screen
      // gradient). User feedback (slide_12): "the entire center area is
      // rendered as one picture instead of divided into elements … achievable
      // with shapes … all the shapes are rounded rectangles with some
      // clipping." Without hiding text first we'd get DOUBLED glyphs (baked +
      // overlay); without the child walk the text is baked + uneditable.
      (el as HTMLElement).setAttribute("data-h2s-hide-text", "1");
      // Rasterise ONLY the "top black area", not the entire device. The device
      // body decomposes into a short dark strip hugging the top (status bar +
      // notch) and a tall content region below (the gradient screen). The top
      // strip is the ONLY part a native roundRect can't reproduce: its corner
      // radius (≥20px) exceeds 50% of the strip's small height, so the OOXML
      // `adj` clamps ("only goes halfway"). The bottom region's radius is well
      // under 50% of its height, so the gradient screen rounds its own bottom
      // corners natively — and with NO full-device image behind it, there is no
      // corner double-render / colour bleed (the pink crescent the user saw).
      // topRegionH = the bottom of the children that hug the device top edge,
      // floored to the corner radius so the curve is fully captured. When a
      // child instead spans the full height (no distinct bottom region) this
      // degrades to the original full-device capture.
      let topRegionH = Math.max(elBR_tl, elBR_tr);
      for (const c of Array.from((el as HTMLElement).children)) {
        const cb = getBounds(c);
        if (cb.h > 0 && cb.y <= bounds.y + 2) {
          topRegionH = Math.max(topRegionH, cb.y + cb.h - bounds.y);
        }
      }
      topRegionH = Math.min(topRegionH, bounds.h);
      const hasDistinctBottom = topRegionH < bounds.h - 4;
      const visualBounds = hasDistinctBottom
        ? { x: bounds.x, y: bounds.y, w: bounds.w, h: topRegionH }
        : bounds;
      // Top strip is square along its bottom edge (it meets the native screen);
      // only the device's true top corners get rounded in the image.
      const visualCorners = hasDistinctBottom
        ? { tl: elBR_tl, tr: elBR_tr, br: 0, bl: 0 }
        : containerCornerRadii;
      // Absolute y where the rasterised strip ends — child overlays fully above
      // it are painted by the PNG and skipped by the emitter (see rasterizedHost).
      const rasterBottomY = hasDistinctBottom ? bounds.y + topRegionH : undefined;
      // Spread-only box-shadow layers (`0 0 0 Npx color`) paint a concentric
      // halo ring OUTSIDE the element's bbox — the screenshot capture clips at
      // the element bounds and never sees these rings. Emit halo rects BEFORE
      // the visual so the device's `box-shadow: ..., 0 0 0 2px #333` (slide_12)
      // renders as a 2-px frame around the captured phone-mockup image.
      // Mirrors the ring loop in emitRect (lines ~1262–1279).
      const sh = elCs.boxShadow;
      if (sh && sh !== "none") {
        const parts: string[] = [];
        let depth = 0, buf = "";
        for (const ch of sh) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch === "," && depth === 0) { parts.push(buf.trim()); buf = ""; }
          else buf += ch;
        }
        if (buf.trim()) parts.push(buf.trim());
        const rings: { spread: number; color: string; alpha: number }[] = [];
        let dropShadow: { offsetX: number; offsetY: number; blur: number; spread: number; color: string; alpha: number } | null = null;
        for (const p of parts) {
          const nums = p.match(/(-?\d+(?:\.\d+)?)px/g);
          if (!nums || nums.length < 2) continue;
          const vals = nums.map(n => parseFloat(n));
          const offsetX = vals[0], offsetY = vals[1], blur = vals[2] || 0, spread = vals[3] || 0;
          const rgbaMatch = p.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          const alpha = rgbaMatch && rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
          const color = rgb2hex(p) || "#000000";
          if (offsetX === 0 && offsetY === 0 && spread > 0) {
            rings.push({ spread, color, alpha });
          } else if ((offsetX !== 0 || offsetY !== 0 || blur > 0) && !dropShadow) {
            // First drop-shadow layer (offset and/or blur, ignoring spread).
            // `addImage` only supports a single shadow — first wins.
            dropShadow = { offsetX, offsetY, blur, spread: 0, color, alpha };
          }
        }
        // When only the top strip is rasterised, the device drop-shadow can't
        // ride on that small PNG (it would float mid-device); hang it on the
        // outermost full-device ring instead so it follows the whole frame.
        const outerRingIdx = rings.reduce((bi, r, i, a) => (r.spread > a[bi].spread ? i : bi), 0);
        // Outermost ring first so it paints behind inner rings + visual.
        for (let i = rings.length - 1; i >= 0; i--) {
          const ring = rings[i];
          const sp = ring.spread;
          const haloR = elBR + sp;
          elements.push({
            type: "rect",
            bounds: { x: bounds.x - sp, y: bounds.y - sp, w: bounds.w + 2 * sp, h: bounds.h + 2 * sp },
            fill: ring.color,
            fillAlpha: ring.alpha,
            gradient: null,
            borderRadius: haloR,
            cornerRadii: { tl: haloR, tr: haloR, br: haloR, bl: haloR },
            borderUniform: true,
            borderSides: null,
            borderColor: null,
            borderWidth: 0,
            borderStyle: "solid",
            zIndex: 0,
            position: "static",
            boxShadow: (hasDistinctBottom && i === outerRingIdx) ? dropShadow : null,
          });
        }
        elements.push({ type: "visual", bounds: visualBounds, tag: "clipped-container", cornerRadii: visualCorners, boxShadow: hasDistinctBottom ? null : dropShadow });
        // Stroke-only roundRect FRAME on top of the visual, matching the
        // captured device's border-radius. pptxgenjs `addImage` only writes
        // <p:pic prstGeom prst="rect">, so the captured PNG's RECTANGULAR
        // corners cover the underlying halo's curved gray corners with the
        // page background — making the spread shadow invisible at the corners
        // (slide_12 ".device {box-shadow: 0 0 0 2px #333}"). The frame paints
        // the ring colour over the outermost spread*2 px of the image (drawn
        // INSIDE because `injectStrokeAlignment` forces algn="in"), so the
        // ring follows the device's rounded corners. Use the OPAQUE outermost
        // ring (highest spread) — translucent inner rings can't usefully
        // over-paint a captured image. Frame zIndex high so it paints last.
        const opaqueOuter = rings.find(r => r.alpha >= 0.95);
        if (opaqueOuter) {
          elements.push({
            type: "rect",
            bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
            fill: null,
            fillAlpha: 1,
            gradient: null,
            borderRadius: elBR,
            cornerRadii: { tl: elBR, tr: elBR, br: elBR, bl: elBR },
            borderUniform: true,
            borderSides: null,
            borderColor: opaqueOuter.color,
            borderWidth: opaqueOuter.spread * 2,
            borderStyle: "solid",
            zIndex: 1000,
            position: "static",
            boxShadow: null,
          });
        }
      } else {
        elements.push({ type: "visual", bounds: visualBounds, tag: "clipped-container", cornerRadii: visualCorners });
      }
      // Re-walk children as editable overlays ON TOP of the captured PNG,
      // clipped to the device's rounded boundary (so child rects/text can't
      // protrude past the rounded corners — that was Path C's original reason
      // to seen-mark everything). The visual above already captured the
      // chrome/background WITHOUT text (data-h2s-hide-text), so this produces
      // no doubled glyphs. Mirrors Path A's recurse-under-_childClipMask.
      const childArrDev = Array.from((el as HTMLElement).children);
      // Flag the child mask as rasterised-host so the emitter knows a 2×
      // device PNG already paints the rounded chrome: child overlays whose
      // clipped corner radius exceeds 50% of their dimension (un-representable
      // as a native roundRect — e.g. the navy status-bar strip / notch at the
      // device top) are skipped and the backing image shows through instead.
      _currentClipMask = _childClipMask
        ? { ..._childClipMask, rasterizedHost: true, rasterBottomY }
        : _childClipMask;
      try { for (const c of childArrDev) walk(c); }
      finally { _currentClipMask = _outerClipMask; }
      return;
    }

    const style = getStyle(el);

    // Flex/grid containers
    if ((style.display === "flex" || style.display === "inline-flex" || style.display === "grid" || style.display === "inline-grid") && (el as HTMLElement).children.length > 0) {
      // Skip the flex/grid walk when every child is a chromeless inline tag
      // (SPAN/A/etc. with no background, no border, not positioned). Such
      // containers are pure rich-text rows — slide_15 .line wraps line-num /
      // keyword / string / comment / punct spans, each colour-only. Falling
      // through to the regular text-emit path runs getTextRuns() once on the
      // container and produces ONE editable text element per row with one
      // styled run per span, instead of the previous one-text-element-per-span
      // fragmentation. Real flex layouts (rows of cards, legend dots, etc.)
      // contain at least one widget child and continue down the existing
      // branch unchanged.
      const flexKids0 = Array.from((el as HTMLElement).children);
      // Distributed-justify rows (space-between / -around / -evenly) intentionally
      // push their children apart along the main axis — e.g. slide_27
      // `.stat-row { justify-content: space-between }` with `<span>label</span>
      // <span class="val">+14.3%</span>`. Collapsing those into ONE text element
      // (below) flattens them to a single left-aligned line and the trailing
      // value never reaches the right edge. Excluding distributed rows here lets
      // them fall through to the normal flex branch, which walks each span as its
      // own text element at its real (already right-pushed) bounds — so the value
      // renders flush right. Centered/left rows still collapse for clean rich text.
      const _jc0 = style.justifyContent;
      const isDistributedRow = _jc0 === "space-between" || _jc0 === "space-around" || _jc0 === "space-evenly";
      const hasInlineSpacingChild = flexKids0.some(c => {
        const ccs = getComputedStyle(c);
        return (parseFloat(ccs.letterSpacing) || 0) !== 0 || (parseFloat(ccs.marginRight) || 0) > 2;
      });
      const allInlineChromeless = !isDistributedRow && !hasInlineSpacingChild && flexKids0.length > 0 && flexKids0.every(c => {
        const ctag = (c.tagName || "").toUpperCase();
        if (!INLINE_TAGS.includes(ctag)) return false;
        const ccs = getComputedStyle(c);
        if (ccs.position === "absolute" || ccs.position === "fixed") return false;
        if (rgb2hex(ccs.backgroundColor)) return false;
        const bw = (parseFloat(ccs.borderTopWidth) || 0) +
                   (parseFloat(ccs.borderRightWidth) || 0) +
                   (parseFloat(ccs.borderBottomWidth) || 0) +
                   (parseFloat(ccs.borderLeftWidth) || 0);
        if (bw > 0) return false;
        return true;
      });
      if (allInlineChromeless) {
        // Fall through to the post-flex code path which uses getTextRuns
        // and emits a single text element with styled runs.
      } else {
      emitRect(el, style, bounds);
      emitPseudoRect(el, bounds);
      emitPseudoText(el, bounds, style);
      // Mixed content: a flex container may have a text node sibling next to
      // element children (e.g. <div class="legend-item"><div class="dot"/>Revenue</div>).
      // Walk children normally, but if any direct text node has non-empty
      // content, emit a text element at the container's bounds so the label
      // survives. Without this, "Revenue"/"Expenses" legend text vanishes.
      let directFlexText = "";
      for (const node of el.childNodes) {
        if (node.nodeType === 3) {
          const t = (node.textContent || "").replace(/[ \t\n\r\f]+/g, " ").trim();
          if (t) directFlexText += (directFlexText ? " " : "") + t;
        }
      }
      if (directFlexText) {
        const cs = getComputedStyle(el);
        // Offset the text past the rightmost child's visual extent so a flex
        // label like `<div class="dot"/>Revenue` doesn't render with "R"
        // sitting under the dot. The legend-dot renders first as a sibling
        // rect; the text starts after it plus CSS `gap`.
        const gap = parseFloat(cs.gap) || parseFloat(cs.columnGap) || 0;
        let textX = bounds.x;
        let textW = bounds.w;
        const kids = Array.from((el as HTMLElement).children).filter(c => {
          const ccs = getComputedStyle(c);
          return ccs.position !== "absolute" && ccs.position !== "fixed";
        });
        if (kids.length > 0) {
          const last = kids[kids.length - 1] as HTMLElement;
          const lb = getBounds(last);
          const lcs = getComputedStyle(last);
          const marginRight = parseFloat(lcs.marginRight) || 0;
          textX = Math.max(bounds.x, lb.x + lb.w + marginRight + gap);
          textW = Math.max(20, bounds.w - (textX - bounds.x));
        }
        elements.push({
          type: "text",
          bounds: { x: textX, y: bounds.y, w: textW, h: bounds.h },
          text: directFlexText,
          style: {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            color: style.color,
            textAlign: style.justifyContent === "center" ? "center" : style.justifyContent === "flex-end" ? "right" : "left",
            lineHeight: style.lineHeight,
            textDecoration: style.textDecoration,
            textTransform: style.textTransform,
            letterSpacing: style.letterSpacing,
            paddingLeft: 0,
            paddingTop: 0,
          },
          runs: [{ text: directFlexText, style: null }],
          zIndex: style.zIndex,
          position: style.position,
          verticallyCentered: true,
        });
      }
      // Sort children by CSS paint order so absolutely-positioned siblings
      // (e.g. `.badge{position:absolute;top:-14px}` on a pricing card) paint
       // AFTER static siblings, matching browser rendering. Without this the
      // flex branch walked DOM order and the badge ended up beneath the
      // card header instead of overhanging on top of it.
      const flexChildren = Array.from((el as HTMLElement).children);
      const flexPaintBucket = (c: Element): number => {
        const ccs = getComputedStyle(c);
        const zStr = ccs.zIndex;
        const positioned = ccs.position !== "static";
        if (!positioned) return 0;
        if (zStr === "auto") return 1;
        const z = parseInt(zStr);
        if (isNaN(z)) return 1;
        if (z < 0) return -1;
        if (z > 0) return 2;
        return 1;
      };
      const flexIndexed = flexChildren.map((c, i) => ({ c, i, b: flexPaintBucket(c) }));
      flexIndexed.sort((a, b) => a.b - b.b || a.i - b.i);
      _currentClipMask = _childClipMask;
      try { for (const { c } of flexIndexed) walk(c); }
      finally { _currentClipMask = _outerClipMask; }
      return;
      } // end of !allInlineChromeless branch
    }

    const directText = getDirectText(el);

    // CSS border-triangle arrows: width:0; height:0 with one colored border
    // side + transparent perpendicular sides. Emit as a preset triangle shape
    // instead of a rect (which would render as a thin colored strip).
    const chev = detectBorderChevron(el, style, bounds);
    if (chev) {
      seen.add(el);
      emitChevron(chev, style);
      return;
    }

    const tri = detectBorderTriangle(el, style, bounds);
    if (tri) {
      seen.add(el);
      emitTriangle(bounds, tri.fill, tri.rotate, style);
      return;
    }

    emitRect(el, style, bounds);
    emitPseudoRect(el, bounds);
    emitPseudoText(el, bounds, style);
    // Borders are handled by emitRect's borderSides data — no separate border lines

    // Horizontal rules / lines
    if (tag === "HR" || (bounds.h <= 4 && bounds.w > 20 && style.bgColor)) {
      elements.push({ type: "line", bounds, color: style.bgColor || style.borderColor || style.color });
    }

    // Effective text-align
    let effectiveAlign = style.textAlign;
    if (style.display === "flex" || style.display === "inline-flex") {
      if (style.justifyContent === "center") effectiveAlign = "center";
      else if (style.justifyContent === "flex-end" || style.justifyContent === "end") effectiveAlign = "right";
    }
    const cs = getComputedStyle(el);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    // In-flow textual ::before leading marker (slide_13 `.conversion-badge`'s
    // ▼). emitPseudoText emits the glyph as a separate LEFT-anchored element at
    // the host's left padding; here we (a) keep the label LEFT-aligned (the
    // chip-center heuristic would otherwise center it) and (b) inset the label
    // past the glyph (`leadingMarkerInset`) so the two don't overlap.
    let hasLeadingPseudoMarker = false;
    let leadingMarkerInset = 0;
    try {
      const bcs = getComputedStyle(el, "::before");
      const bRaw = bcs.content;
      if (bRaw && bRaw !== "none" && bRaw !== "normal" &&
          bcs.position !== "absolute" && bcs.position !== "fixed") {
        const bGlyph = bRaw.replace(/^['"]|['"]$/g, "").trim();
        if (bGlyph && bGlyph !== '""' && bGlyph !== "''") {
          hasLeadingPseudoMarker = true;
          const bSize = parseFloat(bcs.fontSize) || style.fontSize || 12;
          const bGap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0;
          leadingMarkerInset = bSize + (bGap > 0 ? bGap : 4);
        }
      }
    } catch { /* ignore pseudo read errors */ }
    // "Pill button" centering heuristic: CSS default text-align:start renders
    // visually centered inside pill chips because the text line box is tight
    // on width. Qualify as a pill when:
    //   (1) horizontal padding is symmetric and > 5, AND
    //   (2) EITHER vertical padding is symmetric and > 5 (a real padded chip)
    //       OR border-radius >= h/2 (truly pill-round tag), AND
    //   (3) bounds.h is under 2 lines tall (single-line content), AND
    //   (4) the element isn't a clipped-overflow "fitted" container
    //       (white-space:nowrap + overflow:hidden, like calendar event pills
    //       on slide_18) and doesn't contain a <br> (multi-line blocks like
    //       slide_30 .code-block). Both visually staircase when centered.
    // This preserves slide_10 `.period { padding:6px 14px; radius:8 }`,
    // slide_30 `.tag { padding:3px 10px; radius:50 }` (radius >= h/2).
    const padT2 = parseFloat(cs.paddingTop) || 0;
    const padB2 = parseFloat(cs.paddingBottom) || 0;
    const lineH2 = style.lineHeight || (style.fontSize || 14) * 1.2;
    const padVSymmetric = padT2 > 5 && Math.abs(padT2 - padB2) < 3;
    const fullyRoundedPill = (style.borderRadius || 0) >= bounds.h / 2;
    // Tight chip-with-own-bg: small symmetric padding (vertical ≤ 5) doesn't
    // qualify as `padVSymmetric` and a small border-radius doesn't qualify as
    // `fullyRoundedPill`, but if the element paints its OWN background color
    // it's still a chip/badge — Chrome centers the text inside the tight box.
    // slide_15 `.status-badge { padding:3px 10px; border-radius:4px;
    // background:#1a4731 }` ("200 OK"): padT=3 fails `>5`, radius 4 < h/2=10,
    // so neither existing clause fired and "200 OK" emitted left-top-anchored
    // inside its green pill (wave-7 user feedback). The element's OWN bgColor
    // is the discriminator: plain inline text without a styled bg never
    // matches; padded cards/sections with bg + symmetric padding > 5 already
    // hit `padVSymmetric` so behavior there is unchanged.
    const chipWithOwnBg = !!style.bgColor && padT2 > 0 && Math.abs(padT2 - padB2) < 3;
    const isClippedFitted = cs.whiteSpace === "nowrap"
      && (cs.overflow === "hidden" || cs.overflowX === "hidden");
    const hasLineBreaks = el.querySelector ? el.querySelector("br") !== null : false;
    // Single-line check uses CONTENT height (bounds minus vertical padding) so
    // tight pills with thin borders still qualify. The earlier `bounds.h <
    // 2 * lineH2` test misfired on slide_17 `.label-badge` (padding 6 16, 1px
    // border, lineH 14.4): bbox h ≈ 29 vs threshold 28.8 → gate skipped, label
    // emitted with algn="l".
    const contentH = bounds.h - padT2 - padB2;
    const isSingleLineH = contentH < lineH2 * 1.5;
    if (effectiveAlign === "start" && padL > 5 && Math.abs(padL - padR) < 3 &&
        isSingleLineH && (padVSymmetric || fullyRoundedPill || chipWithOwnBg) &&
        !isClippedFitted && !hasLineBreaks && !hasLeadingPseudoMarker) {
      // TIGHT-vs-WIDE discriminator. The chip force-center is only valid when
      // the box HUGS its content (shrink-to-fit pill): there the content FILLS
      // the box, so start≈center visually and centering matches the render. A
      // WIDE/STRETCHED box whose content occupies only a fraction of the width
      // is NOT a chip — `text-align:start` there is a genuinely visible LEFT
      // alignment that must be preserved.
      //
      // Measure the UNION horizontal extent of the content — all text-line
      // rects PLUS direct child element rects — and compare to the content-box
      // width. The UNION (not the widest single line) is essential for
      // multi-child flex rows where each item is a separate box:
      //   • slide_19 `.sentiment` (block flex stretched to full stage-card
      //     width): emoji+short-label union ≈ 0.3–0.5 of the box → LEFT.
      //   • slide_19 `.metric-pill` (flex, value + LONG label, shrink-to-fit in
      //     a space-between row): union ≈ 1.0 → CENTER. (Its widest SINGLE span
      //     is only ~0.6, so a max-line test wrongly left-aligned it — the bug
      //     this union measurement fixes.)
      //   • slide_21 `.inner-card-header` (full-width block banner): union ≈
      //     0.34 → LEFT.
      //   • slide_03 `.kpi-change`, slide_10 `.period`, slide_15 `.status-badge`,
      //     slide_17 `.label-badge`, slide_21 `.tag`/`.btn`, slide_30 `.tag`:
      //     union ≈ 0.95–1.0 → CENTER (unchanged from baseline).
      // This covers flex and non-flex uniformly with no blanket flex rule (a
      // blanket `!isFlex` wrongly left-aligned the tight inline-flex
      // `.kpi-change` "▲ 12.5%").
      let chipTextTight = true;
      try {
        const cr = document.createRange();
        cr.selectNodeContents(el);
        let lo = Infinity, hi = -Infinity;
        for (const rc of Array.from(cr.getClientRects())) {
          if (rc.width > 0) { lo = Math.min(lo, rc.left); hi = Math.max(hi, rc.right); }
        }
        for (const ch of Array.from((el as HTMLElement).children)) {
          const cb = ch.getBoundingClientRect();
          if (cb.width > 0) { lo = Math.min(lo, cb.left); hi = Math.max(hi, cb.right); }
        }
        const unionW = hi > lo ? hi - lo : 0;
        const contentBoxW = bounds.w - padL - padR;
        chipTextTight = contentBoxW <= 0 || unionW >= contentBoxW * 0.7;
      } catch { chipTextTight = true; }
      if (chipTextTight) effectiveAlign = "center";
    }

    // "Pill-card" shape (slide_31 `.step`): a block container whose ONLY
    // direct/inline text comes from an inline-block pill chip (`.chip`), while
    // the real content lives in block children (<h3>, <p>) that each carry
    // their own font-size/weight and margins. getDirectText() returns just the
    // chip text, so without this guard the element takes the leaf merge path
    // below and `getTextRuns` flattens chip+h3+p into ONE box: the chip
    // duplicates (re-drawn by emitMergedChips), the <h3> loses its bold/large
    // style (block text runs are pushed style:null at ~1147), and the inter-
    // block margins collapse to a bare "\n" (~1242). Detect the shape — a
    // promotable pill chip child (own bg + radius >= 4, the same set
    // emitMergedChips promotes) alongside a block child with real text — and
    // fall through to normal child recursion so each block becomes its own
    // styled, margin-positioned text element and the chip is walked as a
    // native pill (single drawer). The card's own bg rect was already emitted
    // by emitRect above.
    const _pillCardKids = Array.from((el as HTMLElement).children);
    const _hasPillChipChild = _pillCardKids.some(c => {
      const ccs = getComputedStyle(c);
      if (ccs.display !== "inline-block") return false;
      if (ccs.position === "absolute" || ccs.position === "fixed") return false;
      const cbg = rgb2hex(ccs.backgroundColor);
      const cbr = parseFloat(ccs.borderTopLeftRadius) || 0;
      return !!cbg && cbr >= 4;
    });
    const _hasBlockTextChild = _pillCardKids.some(c => {
      const ctag = (c.tagName || "").toUpperCase();
      if (INLINE_TAGS.includes(ctag)) return false;
      const ccs = getComputedStyle(c);
      if (ccs.position === "absolute" || ccs.position === "fixed") return false;
      if (ccs.display === "none") return false;
      return !!(c.textContent && c.textContent.trim());
    });
    const isPillCard = _hasPillChipChild && _hasBlockTextChild;

    // Text content
    if (directText && directText.trim() && !isPillCard) {
      seen.add(el);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      const padTop = parseFloat(cs.paddingTop) || 0;
      // Border-bottom on inline text elements (e.g. active nav-link underline)
      // inflates getBoundingClientRect height. Subtract it so the text box
      // matches the text content area. When the element has ONLY border-bottom
      // (no top/left/right borders) and no background, the border is purely
      // decorative — convert it to textDecoration:'underline' so the converter
      // emits a native underline instead of a separate line element.
      //
      // IMPORTANT: this height reduction must ONLY fire for the inline-
      // underline pattern. For full-border boxes like a pill button
      // (`border: 1px solid X; padding: 10px 16px`), shrinking the text
      // box by (bBot + padBot) makes the text container shorter than the
      // rect, so even with `valign: middle` the text centers at (y + h/2)
      // of the shrunken box — visibly above the pill's true center
      // (slide_11 bug: 11 px upward offset).
      const bBot = style.borderBottom || 0;
      const padBot = parseFloat(cs.paddingBottom) || 0;
      const disp = style.display || "";
      const isInlineTag = disp === "inline" || disp === "inline-block" || tag === "SPAN" || tag === "A";
      const inlineBorderUnderline =
        bBot > 0 && isInlineTag &&
        !style.borderTop && !style.borderLeft && !style.borderRight && !style.bgColor;
      const borderAdjust = inlineBorderUnderline ? (bBot + padBot) : 0;
      let textBounds = bounds;
      if (borderAdjust > 0) {
        textBounds = { ...bounds, h: Math.max(bounds.h - borderAdjust, style.fontSize || 10) };
      }
      // Unified horizontal-padding gate. Owns ALL inset decisions — applies to
      // inline (span / a / inline-block) and non-inline tags alike. Previously
      // the gate was scoped to non-inline, leaving inline chips like slide_15
      // `.status-badge` (span, padding:3px 10px) to pass paddingLeft=10 down
      // to convert-pptx, which then shrank the textbox 20 px and wrapped the
      // pill. By running the Range probe here for every padded element and
      // emitting paddingLeft=0 below, convert-pptx is a pure consumer (its
      // inset site has been removed) and the double-shrink bug can't recur.
      //
      // Gate logic:
      //   * Multi-line Chrome wrap  → inset (text already wrapped inside
      //     content-box; insetting just shifts x).
      //   * Single-line with slack  → inset (available ≥ maxLineW + SLACK so
      //     Slides' wider measurement still fits).
      //   * Single-line tight       → keep border-box width (no inset). The
      //     padded element's bounds already include the padding, so centering
      //     over the border-box visually matches centering over the content-
      //     box for symmetric padding. For left/right alignment with
      //     asymmetric padding, full-width renders fine because text-anchor
      //     lands on the border edge but the padding keeps it inside.
      let probedSingleLine: boolean | undefined;
      if (padL > 2 || padR > 2) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lineRects = [...range.getClientRects()].filter(r => r.width > 0);
        const maxLineW = lineRects.length ? Math.max(...lineRects.map(r => r.width)) : 0;
        const isMultiLine = lineRects.length > 1;
        probedSingleLine = lineRects.length === 1;
        const available = textBounds.w - padL - padR;
        const SLIDES_WIDTH_SLACK = 6;  // Slides glyph-measurement headroom
        // A leading-marker badge keeps its label LEFT-aligned and must inset it
        // BOTH by the left padding AND past the leading glyph so the label
        // doesn't sit under the ▼. Force the inset (the tight shrink-to-fit
        // badge would otherwise skip it) and keep the right edge at the border
        // so the right padding is wrap slack.
        const safeToInset = isMultiLine || available >= maxLineW + SLIDES_WIDTH_SLACK || hasLeadingPseudoMarker;
        if (safeToInset) {
          const minW = Math.max(style.fontSize || 10, 10);
          const extraInset = hasLeadingPseudoMarker ? leadingMarkerInset : 0;
          const insetW = hasLeadingPseudoMarker
            ? Math.max(textBounds.w - padL - extraInset, minW)
            : Math.max(available, minW);
          textBounds = { ...textBounds, x: textBounds.x + padL + extraInset, w: insetW };
        }
      }
      // Probe ACTUAL rendered line pitch via Range.getClientRects(). CSS
      // `line-height` × font-size gives the spec leading (39.6 px for
      // slide_25 .text-block: 18 × 2.2), but inline children with their
      // own padding/border/font-size inflate individual line boxes —
      // .code (1px border + 2px padding ≈ +6 px), .highlight (+2 px),
      // .big (font-size 24 px). Chrome paints each line at its inflated
      // box height; the average rendered pitch in the .text-block is
      // ~43 px, not 39.6. Emitting the CSS-spec value as `spcPts`
      // (convert-pptx.ts:299) makes Slides render uniformly tighter,
      // pulling lines upward and leaving an apparent gap above the
      // following block — the user's "entire main text is somehow moved
      // up" report on slide_25. Use the median per-line pitch when it
      // exceeds CSS line-height by ≥5 %; otherwise leave style.lineHeight
      // (single-line text and plain paragraphs are unchanged).
      // Range.getClientRects() on a paragraph with inline children (.code,
      // .highlight, .big, .small/.sub super-/subscripts) returns ONE rect
      // per inline box, not per line. On slide_25 .text-block, the first
      // line yields 16 rects all at top=131 — for the bare text and each
      // styled span — and subsequent lines have rects at slightly different
      // tops (172.59, 176.59, 178.59) because vertical-aligned glyphs
      // (super/sub) and inflated-line-box children (.code with padding,
      // .big at 24px) sit at different y-offsets within the same line.
      // A naïve consecutive-top diff produces noise pitches like 2, 4,
      // 7.59 from same-line offsets, which pull the median below cssLH so
      // the override never fires (the failure mode of the previous
      // attempt: median came out 34.2, threshold 41.58, no override).
      // Cluster tops within cssLH/2 first → one entry per visual line →
      // then take consecutive-line pitches → median.
      let measuredLinePitch: number | null = null;
      const cssLH = style.lineHeight || (style.fontSize || 14) * 1.2;
      try {
        const lpRange = document.createRange();
        lpRange.selectNodeContents(el);
        const lpRects = [...lpRange.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        if (lpRects.length >= 2) {
          const sortedTops = lpRects.map(r => r.top).sort((a, b) => a - b);
          const clusterTol = cssLH * 0.5;
          const lineTops: number[] = [];
          for (const t of sortedTops) {
            if (lineTops.length === 0 || (t - lineTops[lineTops.length - 1]) > clusterTol) {
              lineTops.push(t);
            }
          }
          if (lineTops.length >= 2) {
            const pitches: number[] = [];
            for (let i = 1; i < lineTops.length; i++) {
              pitches.push(lineTops[i] - lineTops[i - 1]);
            }
            pitches.sort((a, b) => a - b);
            // Drop trailing paragraph-break outliers (e.g. <br><br> in
            // slide_24 .innermost): a pitch ≥ 1.5× the next-smaller is a
            // paragraph gap, not a line pitch. Without this, sorted [24, 48]
            // medians to 48 (Math.floor(2/2)=1) and the override fires
            // wrongly, locking spcPts ≈ 27pt on bodies the user wants at
            // their ratio line-height.
            while (
              pitches.length >= 2 &&
              pitches[pitches.length - 1] >= pitches[pitches.length - 2] * 1.5
            ) {
              pitches.pop();
            }
            if (pitches.length >= 1) {
              measuredLinePitch = pitches[Math.floor(pitches.length / 2)];
            }
          }
        }
      } catch { /* ignore */ }
      const lineHeightMeasured =
        measuredLinePitch != null && measuredLinePitch > cssLH * 1.05;
      const effectiveLineHeight = lineHeightMeasured
        ? (measuredLinePitch as number)
        : style.lineHeight;
      // bgColorBehind: nearest ancestor solid bg, sampled only when the
      // element is semi-transparent. Google Slides drops <a:alpha> on text
      // <a:solidFill> at PPTX import, so the converter folds opacity into
      // the color by blending it against this bg instead of emitting alpha.
      // Restored for slide_06 decorative quote watermark after commit 1be0daa
      // broke it by switching to pptxgenjs native transparency.
      const baseStyle = {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        color: style.color,
        textAlign: effectiveAlign,
        lineHeight: effectiveLineHeight,
        lineHeightMeasured,
        textDecoration: inlineBorderUnderline ? "underline" : style.textDecoration,
        textTransform: style.textTransform,
        letterSpacing: style.letterSpacing,
        // CSS writing-mode: vertical-* — carry it onto the text element so
        // convert-pptx emits a pptxgenjs `vert` body rotation instead of a
        // 180° box rotation (slide_32 .axis). baseStyle is a hand-built
        // carrier, so this field must be copied explicitly from getStyle.
        writingMode: style.writingMode,
        // Horizontal padding is owned by the Range-probe inset above — it
        // either folds padL/padR into textBounds or keeps the full border-
        // box width for tight pills. Re-emitting paddingLeft/paddingRight
        // here would compound with convert-pptx's inset pass, causing the
        // double-shrink wraps documented in the probe comment. Setting both
        // to 0 makes baseStyle a pure text-style carrier and convert-pptx a
        // pure consumer of the bounds.
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: padTop > 2 ? padTop : 0,
        opacity: style.opacity !== undefined && style.opacity < 1 ? style.opacity : undefined,
        bgColorBehind: style.opacity !== undefined && style.opacity < 1 ? detectBgColorBelow(el) : undefined,
      };
      const runs = getTextRuns(el, style);
      const hasStyledRuns = runs.some(r => r.style !== null);
      // Symmetric vertical padding (e.g. `padding: 10px 16px` on a pill
      // button) makes Chrome render the single-line text at the visual
      // vertical center of the border box, because the text line box is
      // exactly `fontSize * lineHeight` tall and floats on the content area.
      // pptxgenjs defaults to `valign: "top"` for text; without this hint the
      // letters snap to the top of the box and look too high inside the
      // pill. Mirror Chrome's behavior whenever top/bottom padding agree.
      //
      // Threshold is padTop >= 5, not > 2: small symmetric paddings like
      // `.touchpoint { padding: 3px 0 }` (slide_19 bullet rows) create <1px of
      // visual centering shift in Chrome but, once we emit anchor="ctr",
      // Slides adds a noticeable implicit left inset to a pptx textbox whose
      // bounds.x was already shifted by the Range-probe inset for the same
      // element's padding-left — producing a doubled horizontal gap between
      // the ::before bullet and the text. Genuine pill buttons (padding: 6px+
      // vertically) still clear the threshold and keep vertical centering.
      //
      // Multi-line content (e.g. slide_30 .code-block with multiple <br>s and
      // padding:14px) must NOT be marked vertically centered — Chrome flows
      // multi-line block text from the content-box top, not the geometric
      // center. The convert-pptx merged-rect path used to hardcode "middle"
      // for absorbed text, masking this; once that site honours
      // verticallyCentered, multi-line code blocks must opt out so the first
      // line sits at the requested padding-top instead of mid-box.
      //
      // Fully-rounded pill chips (border-radius >= h/2) with any symmetric
      // vertical padding > 0 also qualify, even if padTop < 5: the chip is
      // narrow enough that Chrome's centered glyph baseline visibly diverges
      // from a top-anchored emit. This covers slide_30 `.tag` (padding:3px
      // 10px, radius:50) which previously relied on the merged-rect path's
      // hardcoded "middle" for centering.
      const fullyRoundedPillVC =
        (style.borderRadius || 0) >= bounds.h / 2 && padTop > 0;
      // Same chip-with-own-bg rule as the alignment gate above: an element
      // that paints its own bgColor with any symmetric vertical padding is a
      // styled chip and Chrome centers the glyph baseline inside it. slide_15
      // `.status-badge` (padding:3px 10px, radius:4, bg:#1a4731) takes this
      // branch — without it the green pill emits anchor="t" and "200 OK"
      // hugs the top edge of the badge instead of riding mid-line.
      const chipWithOwnBgVC = !!style.bgColor && padTop > 0;
      // Flex/grid container whose CSS already centers the glyph baseline.
      // The chip/pill gates above both require padTop>0 (their job is to
      // detect padded chips); they miss the very common pattern of a 0-padding
      // shape (circle, square chip, mini-button) using flex/grid to center.
      // Affected on wave-10B: slide_02 `.avatar`, slide_17 `.investor-icon`,
      // slide_18 `.nav-btn` + today-day `.day-num`, slide_22 `.badge-overlap`,
      // slide_28 `.opacity-badge`, slide_29 `.icon-circle` — all 0-padding,
      // some with gradient bg (no bgColor) and some with solid bg, all of which
      // previously emitted anchor="t" and so showed the letter glued to the
      // top of the disc. Cross-axis direction matters: for `flex-direction:
      // row` (default), vertical centering is `align-items: center`. For
      // `column`, vertical centering moves to `justify-content: center`.
      const flexDir = cs.flexDirection || "row";
      const isFlexVC =
        (style.display === "flex" || style.display === "inline-flex") &&
        (flexDir === "column" || flexDir === "column-reverse"
          ? style.justifyContent === "center"
          : style.alignItems === "center");
      const isGridVC =
        (style.display === "grid" || style.display === "inline-grid") &&
        style.alignItems === "center";
      const flexCenteredShapeVC = isFlexVC || isGridVC;
      const verticallyCentered =
        !hasLineBreaks &&
        Math.abs(padTop - padBot) < 3 &&
        (padTop >= 5 || fullyRoundedPillVC || chipWithOwnBgVC || flexCenteredShapeVC);
      // Use a regex that excludes \u00a0 so leading/trailing nbsp (used as
      // visual indentation in code blocks like slide_15) survive. JS
      // String.trim() strips Unicode whitespace including nbsp.
      const textEl: ExtractedElement = {
        type: "text",
        bounds: textBounds,
        text: directText.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, ""),
        style: baseStyle,
        zIndex: style.zIndex,
        position: style.position,
        verticallyCentered,
        // True only when the Range probe confirmed the text laid out on a
        // single line in Chrome. The converter uses this to enable slack
        // widening for vertically-padded pill buttons whose border-box
        // height (padding + line) exceeds the lineH×1.5 single-line
        // heuristic — without this hint the slack is skipped and Slides'
        // wider glyph metric wraps the label (slide_21 .btn "View Details").
        singleLine: probedSingleLine,
        // Rotation info: non-zero `rotate` means CSS `transform: rotate(...)`
        // is on this element. getBoundingClientRect returns the post-transform
        // axis-aligned bbox; `naturalWidth/Height` is the pre-transform layout
        // box. The converter repositions the text box around the bbox center
        // at its natural size and applies pptxgenjs `rotate`.
        rotate: style.rotate || 0,
        naturalWidth: style.naturalWidth,
        naturalHeight: style.naturalHeight,
      };
      if (hasStyledRuns) {
        const allRuns = runs.filter(r => r.text.length > 0).map(r => ({
          text: r.text,
          ...(r.style ? { style: r.style } : {}),
        }));
        while (allRuns.length > 0) {
          const trimmed = allRuns[0].text.replace(/^[ \t\n\r\f]+/, "");
          if (trimmed.length === 0) { allRuns.shift(); continue; }
          allRuns[0] = { ...allRuns[0], text: trimmed };
          break;
        }
        while (allRuns.length > 0) {
          const last = allRuns[allRuns.length - 1];
          const trimmed = last.text.replace(/[ \t\n\r\f]+$/, "");
          if (trimmed.length === 0) { allRuns.pop(); continue; }
          allRuns[allRuns.length - 1] = { ...last, text: trimmed };
          break;
        }
        textEl.runs = allRuns;
        textEl.text = allRuns.map(r => r.text).join("");
      }
      elements.push(textEl);
      // Direct-text containers return here and do not recurse children. Preserve
      // absolutely-positioned decorative border chevrons such as slide_34
      // `.r > .chev` before taking that fast path.
      emitAbsoluteChildChevrons(el);
      // Re-draw rounded inline-block pill chips that this merge flattened
      // (slide_31 `.chip`) as standalone pills on top of the merged text.
      if (hasStyledRuns) emitMergedChips(el);
      return;
    }

    // Recurse children in CSS paint order:
    //   bucket -1 : negative z-index positioned   (group 2)
    //   bucket  0 : in-flow non-positioned        (groups 3–5)
    //   bucket  1 : positioned with z:auto or 0   (group 6)
    //   bucket  2 : positive z-index positioned   (group 7)
    // Stable sort preserves document order inside each bucket. This scopes paint
    // order per-subtree, so a parent's own rect (emitted above before recursion)
    // paints first, and positioned siblings paint above static siblings within
    // the same parent — matching CSS 2.1 Appendix E.
    const childArr = Array.from((el as HTMLElement).children);
    const paintBucket = (c: Element): number => {
      const ccs = getComputedStyle(c);
      const zStr = ccs.zIndex;
      const positioned = ccs.position !== "static";
      if (!positioned) return 0;
      if (zStr === "auto") return 1;
      const z = parseInt(zStr);
      if (isNaN(z)) return 1;
      if (z < 0) return -1;
      if (z > 0) return 2;
      return 1;
    };
    const indexed = childArr.map((c, i) => ({ c, i, b: paintBucket(c) }));
    indexed.sort((a, b) => a.b - b.b || a.i - b.i);
    _currentClipMask = _childClipMask;
    try { for (const { c } of indexed) walk(c); }
    finally { _currentClipMask = _outerClipMask; }
  }

  walk(document.body);

  // Flush deferred pill chips + decorative overlays at the very end so they
  // paint on top of the content they augment and don't disturb existing shape
  // indices (keeps the structural diff clean — they show as pure ADDED shapes).
  for (const sp of _deferredChipSpans) emitPillSpan(sp);
  for (const de of _deferredEls) elements.push(de);

  // Detect gradient backgrounds on body/html
  const bodyCs = getComputedStyle(document.body);
  const htmlCs = getComputedStyle(document.documentElement);
  function extractGradientColor(bgImg: string): string | null {
    if (!bgImg || bgImg === "none") return null;
    const hexMatch = bgImg.match(/#([0-9a-fA-F]{3,8})/);
    if (hexMatch) return "#" + hexMatch[1];
    const rgbMatch = bgImg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) return "#" + [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map(x => parseInt(x).toString(16).padStart(2, "0")).join("");
    return null;
  }
  const bodyBg = rgb2hex(bodyCs.backgroundColor);
  const bodyGrad = parseLinearGradient(bodyCs.backgroundImage) || parseLinearGradient(htmlCs.backgroundImage);
  const bodyGradColor = extractGradientColor(bodyCs.backgroundImage) || extractGradientColor(htmlCs.backgroundImage);
  if ((!bodyBg || bodyBg === "#000000") && (bodyGrad || bodyGradColor)) {
    // Attach the parsed gradient alongside the first-stop solid fallback so
    // the converter's gradFill injector rewrites <a:solidFill> into a real
    // <a:gradFill> (slide_17 navy→purple body wash).
    elements.unshift({
      type: "rect",
      bounds: { x: 0, y: 0, w: W, h: H },
      fill: bodyGrad ? bodyGrad.stops[0].color : bodyGradColor,
      gradient: bodyGrad,
      borderWidth: 0,
      borderRadius: 0,
    });
  }

  // Paint order is already baked in by walk() (children visited in CSS paint
  // bucket order, parent rects pushed before descendants). A stable sort by
  // _domIdx alone preserves that emission sequence. No type/y/z tiebreaking
  // needed — the walk itself is the ordering.
  elements.sort((a, b) => (a._domIdx ?? 0) - (b._domIdx ?? 0));

  // Hide text inside CSS-effect visual hosts (conic-gradient / clip-path
  // containers) before the screenshot loop runs. The walk above already
  // emitted native text overlays for descendants of these hosts; without
  // hiding the same text in the captured PNG, the user would see doubled
  // glyphs (one baked into the bitmap, one editable on top). `color:
  // transparent` + `-webkit-text-fill-color: transparent` covers both
  // standard fills and gradient-text spans; `text-shadow:none` strips any
  // remaining text decoration. Pseudo content is hidden too because the
  // walk emits pseudo text natively as well.
  const hideStyle = document.createElement("style");
  hideStyle.id = "h2s-hide-visual-text";
  hideStyle.textContent =
    "[data-h2s-hide-text], [data-h2s-hide-text] *," +
    "[data-h2s-hide-text]::before, [data-h2s-hide-text]::after," +
    "[data-h2s-hide-text] *::before, [data-h2s-hide-text] *::after" +
    "{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;}";
  document.head.appendChild(hideStyle);

  const __h2sJson = JSON.stringify({
    viewport: { w: W, h: H },
    elementCount: elements.length,
    elements,
  });
  // Stash the result on a global as a side effect, in addition to returning it.
  // The Node CDP path (Runtime.evaluate) and the browser eval() path both read
  // the IIFE's return value (completion value) — unchanged. The add-on sidebar's
  // no-eval fallback (script-tag injection, when Apps Script's CSP forbids eval)
  // can't capture a completion value, so it reads window.__H2S_EXTRACT__ instead.
  if (typeof window !== "undefined") {
    (window as unknown as { __H2S_EXTRACT__?: string }).__H2S_EXTRACT__ = __h2sJson;
  }
  return __h2sJson;
})();
