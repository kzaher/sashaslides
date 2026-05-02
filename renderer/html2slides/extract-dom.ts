/**
 * extract-dom.ts — Injected into Chrome via Runtime.evaluate (compiled to JS first)
 * Walks the DOM, extracts every visible element as a flat array of positioned rectangles.
 *
 * == SOURCE OF TRUTH: Border & Corner Radius Rendering Rules ==
 *
 * These rules define how CSS borders and border-radius map to Google Slides API shapes.
 * The converter (convert-slides-api.ts) implements these; this file extracts the data needed.
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
    // Inline backgrounds (e.g. `<span class="code">`, `<span class="highlight">`)
    // — captured so the converter can apply pptxgenjs `highlight` per run.
    bgColor?: string | null;
    // `vertical-align: sub` / `super` on a span → pptxgenjs subscript/superscript.
    verticalAlign?: "baseline" | "sub" | "super";
  } | null;
}

interface ExtractedElement {
  type: string;
  bounds: Bounds;
  [key: string]: any;
}

// The entire extraction runs as an IIFE that returns JSON
(() => {
  const W: number = document.body.offsetWidth || 1280;
  const H: number = document.body.offsetHeight || 720;
  const elements: ExtractedElement[] = [];
  const seen = new Set<Element>();
  let _domCounter = 0;
  const _origPush = elements.push.bind(elements);
  (elements as any).push = (...items: ExtractedElement[]) => {
    for (const it of items) if (it && it._domIdx === undefined) it._domIdx = _domCounter++;
    return _origPush(...items);
  };

  // Build a map of available font weights per family from document.fonts.
  // CSS font matching uses the closest available weight when the exact one
  // isn't loaded (e.g. Playfair Display loaded at 700 only → computed
  // font-weight 400 actually renders as 700). We replicate Chrome's weight
  // matching: for requested weight ≤ 500, prefer lighter then heavier; for
  // > 500, prefer heavier then lighter.
  const _fontWeightMap: Record<string, number[]> = {};
  try {
    for (const f of (document as any).fonts) {
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
    const fillCss = (cs as any).webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color") || "";
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
        if (!sh || sh === "none") return { boxShadow: null, shadowRings: [] as any[] };
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
        }).filter(Boolean) as any[];
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
    let wrapperClip: { borderRadius: number; cornerRadii: any; bounds: Bounds } | null = null;
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
    const rows: any[][] = [];
    const trs = table.querySelectorAll("tr");
    for (const tr of trs) {
      const cells: any[] = [];
      const tds = tr.querySelectorAll("td, th");
      for (const td of tds) {
        const cs = getStyle(td);
        const cb = getBounds(td);
        const cCs = getComputedStyle(td);
        cells.push({
          text: (td as HTMLElement).innerText.trim(),
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
            bgAlpha: (cs as any).bgAlpha,
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
    return {
      type: "table", bounds, rows,
      bgColor: style.bgColor,
      borderColor: style.borderColor,
      borderRadius: effectiveBorderRadius,
      cornerRadii: effectiveCornerRadii,
      borderSides: style.borderSides,
      borderCollapse,
    };
  }

  // --- LIST EXTRACTION ---
  function extractList(list: HTMLElement): ExtractedElement {
    const bounds = getBounds(list);
    const style = getStyle(list);
    const ordered = list.tagName === "OL";
    const items: any[] = [];

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
        if (hasPseudoBullet) {
          try {
            const liBeforeCs = getComputedStyle(li, "::before");
            const beforeContent = liBeforeCs.content;
            if (beforeContent && beforeContent !== "none" && beforeContent !== "normal") {
              bulletColor = rgb2hex(liBeforeCs.backgroundColor) || rgb2hex(liBeforeCs.color) || pseudoBulletColor;
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
          bgAlpha: (liStyle as any).bgAlpha,
          borderColor: liStyle.borderColor,
          borderWidth: liStyle.borderWidth,
          borderStyle: liStyle.borderStyle,
          borderSides: liStyle.borderSides,
          borderRadius: liStyle.borderRadius,
          cornerRadii: liStyle.cornerRadii,
          bulletColor,
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
        fillAlpha: (style as any).bgAlpha,
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
          if (isBlock && !inListItem && runs.length > 0) {
            runs.push({ text: "\n", style: null });
          }
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
            bgColor: csBg && csBg !== parentBg ? csBg : null,
            verticalAlign,
          };
          const differs = childStyle.color !== parentStyle.color ||
            childStyle.fontWeight !== parentStyle.fontWeight ||
            childStyle.fontStyle !== parentStyle.fontStyle ||
            childStyle.fontSize !== parentStyle.fontSize ||
            childStyle.textDecoration !== parentStyle.textDecoration ||
            !!childStyle.bgColor ||
            childStyle.verticalAlign !== "baseline";
          const runText = node.textContent!.replace(/[ \t\n\r\f]+/g, " ");
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
    const bT = s.borderTop || 0, bR = (s as any).borderRight || 0, bB = s.borderBottom || 0, bL = (s as any).borderLeft || 0;
    const totalW = bL + bR, totalH = bT + bB;
    // Bounds must match the border sums within 1px — i.e. content area is 0.
    if (Math.abs(b.w - totalW) > 1.5 || Math.abs(b.h - totalH) > 1.5) return null;
    // Avoid matching zero-sized boxes with no borders.
    if (totalW < 2 || totalH < 2) return null;
    const cT = s.borderTopColor, cR = (s as any).borderRightColor, cB = s.borderBottomColor, cL = (s as any).borderLeftColor;
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

  function emitTriangle(b: Bounds, fill: string, rotate: number, s: ElementStyle): void {
    elements.push({
      type: "triangle",
      bounds: b,
      fill,
      rotate,
      zIndex: s.zIndex,
      position: s.position,
    } as any);
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
    const clip = (elCs2 as any).backgroundClip || (elCs2 as any).webkitBackgroundClip;
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
        gradient = radial as any;
        if (!fill) {
          const firstReal = radial.stops.find(st => st.alpha > 0) || radial.stops[0];
          fill = firstReal.color;
          if (firstReal.alpha < 1) radialFillAlpha = firstReal.alpha;
        }
      }
    }

    // Combine CSS `opacity` with rgba alpha so semi-transparent elements
     // (e.g. slide_28's `.badge.opacity-50 { opacity: 0.5 }`) render faded.
    let bgA = (s as any).bgAlpha ?? 1;
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
    const rings = (s as any).shadowRings as { spread: number; blur: number; color: string; alpha: number }[] | undefined;
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
        } as any);
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
      if (!bg && borderMax === 0 && br === 0) continue;
      const pb = pseudoBounds(pcs, bounds);
      if (!pb || pb.w < 1 || pb.h < 1) continue;
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
      // Half-shift, not full shift. OOXML `a:ln` is drawn CENTERED on the shape
      // edge (algn="ctr" default, half outside / half inside), whereas CSS draws
      // the border fully INSIDE the border-box. A full `parentBT` shift places
      // the pseudo 1 CSS px below the border-box top, which overlaps the
      // centered stroke's inner half and — combined with the stripe's own
      // anti-aliased top edge — wipes out the parent's top-border row at sub-
      // pixel render scales. Landing the pseudo at the border's INNER EDGE
      // (half of parentBT) keeps the border's outer half visible above a flush
      // top-accent stripe (slide_14 .logo-card::before) while leaving
      // fill-parent pseudos (top/left/right/bottom all 0) essentially unchanged.
      pb.x += parentBL_w / 2;
      pb.y += parentBT / 2;
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
      if (parentOv === "hidden" || parentOv === "clip") {
        const pTL = parseFloat(parentCs2.borderTopLeftRadius) || 0;
        const pTR = parseFloat(parentCs2.borderTopRightRadius) || 0;
        const pBR = parseFloat(parentCs2.borderBottomRightRadius) || 0;
        const pBL = parseFloat(parentCs2.borderBottomLeftRadius) || 0;
        const innerX = bounds.x + parentBL_w;
        const innerY = bounds.y + parentBT;
        const innerRight = bounds.x + bounds.w - parentBR_w;
        const innerBottom = bounds.y + bounds.h - parentBB_w;
        const TOL = 2;
        if (Math.abs(pb.x - innerX) < TOL && Math.abs(pb.y - innerY) < TOL)
          pseudoCornerRadii.tl = Math.max(br, pTL);
        if (Math.abs((pb.x + pb.w) - innerRight) < TOL && Math.abs(pb.y - innerY) < TOL)
          pseudoCornerRadii.tr = Math.max(br, pTR);
        if (Math.abs((pb.x + pb.w) - innerRight) < TOL && Math.abs((pb.y + pb.h) - innerBottom) < TOL)
          pseudoCornerRadii.br = Math.max(br, pBR);
        if (Math.abs(pb.x - innerX) < TOL && Math.abs((pb.y + pb.h) - innerBottom) < TOL)
          pseudoCornerRadii.bl = Math.max(br, pBL);
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
      } as any);
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
      } as any);
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
    } as any);
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
      } as any);
    }
  }

  // --- MAIN WALK ---
  function walk(el: Element): void {
    if (seen.has(el)) return;

    const tag = (el.tagName || "").toUpperCase();
    if (!tag) return;
    if (["SCRIPT", "STYLE", "LINK", "META", "HEAD", "BR", "HR"].includes(tag)) return;

    const bounds = getBounds(el);
    if (!isVisible(el, bounds)) return;

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
      el.querySelectorAll("*").forEach(c => seen.add(c));
      elements.push({ type: "visual", bounds, tag: "css-effect" });
      return;
    }

    // Large-radius overflow:hidden containers (e.g. phone device mockups with
    // border-radius ≥ 20px) clip ALL children at the rounded boundary. PPTX
    // shapes don't inherit parent clipping, so child rects and screenshots
    // protrude past the rounded corners. Screenshot the whole container as a
    // single visual — the browser handles the clipping naturally.
    const elOv = elCs.overflow;
    const elBR = parseFloat(elCs.borderTopLeftRadius) || 0;
    if ((elOv === "hidden" || elOv === "clip") && elBR >= 20
        && bounds.w >= 100 && bounds.h >= 100 && (el as HTMLElement).children.length > 0) {
      seen.add(el);
      el.querySelectorAll("*").forEach(c => seen.add(c));
      elements.push({ type: "visual", bounds, tag: "clipped-container" });
      return;
    }

    const style = getStyle(el);

    // Flex/grid containers
    if ((style.display === "flex" || style.display === "inline-flex" || style.display === "grid" || style.display === "inline-grid") && (el as HTMLElement).children.length > 0) {
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
          textX = Math.max(bounds.x, lb.x + lb.w + gap);
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
        } as any);
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
      for (const { c } of flexIndexed) walk(c);
      return;
    }

    const directText = getDirectText(el);

    // CSS border-triangle arrows: width:0; height:0 with one colored border
    // side + transparent perpendicular sides. Emit as a preset triangle shape
    // instead of a rect (which would render as a thin colored strip).
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
        !isClippedFitted && !hasLineBreaks) {
      effectiveAlign = "center";
    }

    // Text content
    if (directText && directText.trim()) {
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
        const safeToInset = isMultiLine || available >= maxLineW + SLIDES_WIDTH_SLACK;
        if (safeToInset) {
          const minW = Math.max(style.fontSize || 10, 10);
          const insetW = Math.max(available, minW);
          textBounds = { ...textBounds, x: textBounds.x + padL, w: insetW };
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
            measuredLinePitch = pitches[Math.floor(pitches.length / 2)];
          }
        }
      } catch { /* ignore */ }
      const effectiveLineHeight =
        measuredLinePitch && measuredLinePitch > cssLH * 1.05
          ? measuredLinePitch
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
        textDecoration: inlineBorderUnderline ? "underline" : style.textDecoration,
        textTransform: style.textTransform,
        letterSpacing: style.letterSpacing,
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
      const verticallyCentered =
        !hasLineBreaks &&
        Math.abs(padTop - padBot) < 3 &&
        (padTop >= 5 || fullyRoundedPillVC || chipWithOwnBgVC);
      // Use a regex that excludes \u00a0 so leading/trailing nbsp (used as
      // visual indentation in code blocks like slide_15) survive. JS
      // String.trim() strips Unicode whitespace including nbsp.
      const textEl: any = {
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
    for (const { c } of indexed) walk(c);
  }

  walk(document.body);

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
  elements.sort((a, b) => ((a as any)._domIdx ?? 0) - ((b as any)._domIdx ?? 0));

  return JSON.stringify({
    viewport: { w: W, h: H },
    elementCount: elements.length,
    elements,
  });
})();
