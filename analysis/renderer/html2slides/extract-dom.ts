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
  // Box shadow parsed components (null if no shadow)
  boxShadow: { offsetX: number; offsetY: number; blur: number; spread: number; color: string | null; alpha: number } | null;
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

  /** Detect background color at the center of an element by walking up the DOM tree */
  function detectBgColorBelow(el: Element): string {
    let node: Element | null = el.parentElement;
    while (node) {
      const bg = rgb2hex(getComputedStyle(node).backgroundColor);
      if (bg) return bg;
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
    const bTopColor = rgb2hex(cs.borderTopColor);
    const bRightColor = rgb2hex(cs.borderRightColor);
    const bBottomColor = rgb2hex(cs.borderBottomColor);
    const bLeftColor = rgb2hex(cs.borderLeftColor);
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
      fontWeight: cs.fontWeight === "bold" || parseInt(cs.fontWeight) >= 600 ? "bold" : "normal",
      fontStyle: cs.fontStyle === "italic" ? "italic" : "normal",
      color: (() => {
        // text-clip gradient fallback: when color is transparent because of
        // `-webkit-text-fill-color: transparent`, use the first gradient stop
        // from `background-image` so the glyphs remain visible instead of
        // disappearing along with the suppressed rect fill.
        const rawColor = rgb2hex(cs.color);
        if (rgbAlpha(cs.color) < 0.1) {
          const bgImg = cs.backgroundImage || "";
          const m = bgImg.match(/(#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\))/);
          if (m) return rgb2hex(m[1]) || rawColor;
        }
        return rawColor;
      })(),
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
      // Parse box-shadow: offsetX offsetY blur spread color
      boxShadow: (() => {
        const sh = cs.boxShadow;
        if (!sh || sh === "none") return null;
        const nums = sh.match(/(-?\d+(?:\.\d+)?)px/g);
        if (!nums || nums.length < 2) return null;
        const vals = nums.map(n => parseFloat(n));
        const rgbaMatch = sh.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        const alpha = rgbaMatch && rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
        return {
          offsetX: vals[0], offsetY: vals[1],
          blur: vals[2] || 0, spread: vals[3] || 0,
          color: rgb2hex(sh) || "#000000",
          alpha,
        };
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
    const bounds = getBounds(table);
    const style = getStyle(table);
    const tableCs = getComputedStyle(table);
    const borderCollapse = tableCs.borderCollapse; // "collapse" | "separate"
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
    return {
      type: "table", bounds, rows,
      bgColor: style.bgColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      cornerRadii: style.cornerRadii,
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
          const pos = getComputedStyle(node as Element).position;
          if (pos === "absolute" || pos === "fixed") continue;
          parts.push({ type: "text", value: node.textContent!.replace(/[ \t\n\r\f]+/g, " ") });
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
          const childStyle = {
            color: rgb2hex(cs.color),
            fontWeight: (cs.fontWeight === "bold" || parseInt(cs.fontWeight) >= 600 ? "bold" : "normal") as "bold" | "normal",
            fontStyle: (cs.fontStyle === "italic" ? "italic" : "normal") as "italic" | "normal",
            fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
            fontSize: parseFloat(cs.fontSize),
            textDecoration: cs.textDecorationLine !== "none" ? cs.textDecorationLine : null,
          };
          const differs = childStyle.color !== parentStyle.color ||
            childStyle.fontWeight !== parentStyle.fontWeight ||
            childStyle.fontStyle !== parentStyle.fontStyle ||
            childStyle.fontSize !== parentStyle.fontSize ||
            childStyle.textDecoration !== parentStyle.textDecoration;
          const runText = node.textContent!.replace(/[ \t\n\r\f]+/g, " ");
          runs.push({ text: runText, style: differs ? childStyle : null });
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

  function emitRect(el: Element, s: ElementStyle, b: Bounds): void {
    // No size filter: if CSS paints a box, we extract it. Filtering by dimension
    // previously dropped 2px connector/divider divs. Zero-area elements are
    // rejected upstream by isVisible().
    const hasBg = !!s.bgColor;
    const hasGradient = s.backgroundImage && s.backgroundImage.includes("linear-gradient");
    const hasBorder = s.borderWidth >= 1 && !!s.borderColor;
    if (!hasBg && !hasGradient && !hasBorder) return;
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
    let gradient = hasGradient ? parseLinearGradient(s.backgroundImage!) : null;
    if (gradient && !fill) {
      fill = gradient.stops[0].color; // solid fallback
    }

    // Combine CSS `opacity` with rgba alpha so semi-transparent elements
     // (e.g. slide_28's `.badge.opacity-50 { opacity: 0.5 }`) render faded.
    const bgA = (s as any).bgAlpha ?? 1;
    const opA = typeof s.opacity === "number" && s.opacity < 1 ? s.opacity : 1;
    elements.push({
      type: "rect", bounds: b, fill,
      fillAlpha: bgA * opA,
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
      el.querySelectorAll("td span, th span").forEach(sp => {
        const scs = getComputedStyle(sp as Element);
        const sBg = rgb2hex(scs.backgroundColor);
        const sBW = parseFloat(scs.borderTopWidth) || 0;
        const sBR = parseFloat(scs.borderTopLeftRadius) || 0;
        if (!sBg && sBW === 0 && sBR === 0) return;
        const sBounds = getBounds(sp as Element);
        if (sBounds.w < 4 || sBounds.h < 4) return;
        const sPad = {
          top: parseFloat(scs.paddingTop) || 0,
          right: parseFloat(scs.paddingRight) || 0,
          bottom: parseFloat(scs.paddingBottom) || 0,
          left: parseFloat(scs.paddingLeft) || 0,
        };
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
              fontWeight: (scs.fontWeight === "bold" || parseInt(scs.fontWeight) >= 600) ? "bold" : "normal",
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
      });
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

    const style = getStyle(el);

    // Pseudo-element text (::before / ::after) — e.g. checkmark glyphs inside
    // step dots, chevron separators between cards. These have CSS `content: '✓'`
    // and would otherwise be silently dropped. Emit as a centered text overlay
    // at the parent element's bounds.
    // Compute pseudo-element bounds by interpreting its CSS box relative to
    // its host element. `inset: 0` → fills parent; `top: 0; height: 3px` →
    // thin top strip. Works for `position: absolute` pseudos only — static
    // pseudos live inline and we don't try to place those geometrically.
    const pseudoBounds = (pcs: CSSStyleDeclaration): Bounds | null => {
      if (pcs.position !== "absolute") return null;
      const parseLen = (v: string, ref: number): number | null => {
        if (!v || v === "auto") return null;
        if (v.endsWith("%")) return (parseFloat(v) / 100) * ref;
        return parseFloat(v);
      };
      const top = parseLen(pcs.top, bounds.h);
      const bottom = parseLen(pcs.bottom, bounds.h);
      const left = parseLen(pcs.left, bounds.w);
      const right = parseLen(pcs.right, bounds.w);
      const w = parseLen(pcs.width, bounds.w);
      const h = parseLen(pcs.height, bounds.h);
      let x = bounds.x + (left ?? 0);
      let y = bounds.y + (top ?? 0);
      let ww = w ?? (right != null ? bounds.w - (left ?? 0) - right : bounds.w - (left ?? 0));
      let hh = h ?? (bottom != null ? bounds.h - (top ?? 0) - bottom : bounds.h - (top ?? 0));
      // Translate per `transform: translate(...)`
      const tm = (pcs.transform || "").match(/matrix\(([^)]+)\)/);
      if (tm) {
        const nums = tm[1].split(",").map(n => parseFloat(n));
        if (nums.length === 6) { x += nums[4]; y += nums[5]; }
      }
      return { x, y, w: Math.max(0, ww), h: Math.max(0, hh) };
    };

    // Pseudo-element visual box (::before / ::after with bg/border/radius) —
    // e.g. `.logo-card::before` accent stripes, CSS border-triangle arrows.
    // Only emitted when the pseudo is absolutely positioned so we can compute
    // its bounds from CSS. Inline pseudos are handled by text emission below.
    const emitPseudoRect = () => {
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
        const pb = pseudoBounds(pcs);
        if (!pb || pb.w < 1 || pb.h < 1) continue;
        // CSS border-triangle: 0×0 box with transparent top/bottom and a
        // colored side — skip as rect; downstream renderers can't reproduce
        // it cleanly. (Leave for a future targeted fix.)
        elements.push({
          type: "rect", bounds: pb, fill: bg || null, fillAlpha: 1,
          gradient: null, borderRadius: br,
          cornerRadii: { tl: br, tr: br, br, bl: br },
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
    };

    const emitPseudoText = () => {
      for (const which of ["::before", "::after"] as const) {
        const pcs = getComputedStyle(el, which);
        let content = pcs.content || "";
        if (!content || content === "none" || content === "normal") continue;
        content = content.replace(/^['"]|['"]$/g, "").trim();
        if (!content || content === "" || content === '""') continue;
        const fontSize = parseFloat(pcs.fontSize) || 14;
        if (bounds.w < 4 || bounds.h < 4) continue;
        elements.push({
          type: "text",
          bounds,
          text: content,
          style: {
            fontFamily: pcs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
            fontSize,
            fontWeight: (pcs.fontWeight === "bold" || parseInt(pcs.fontWeight) >= 600) ? "bold" : "normal",
            fontStyle: pcs.fontStyle === "italic" ? "italic" : "normal",
            color: rgb2hex(pcs.color) || "#000000",
            textAlign: "center",
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
    };

    // Flex/grid containers
    if ((style.display === "flex" || style.display === "inline-flex" || style.display === "grid" || style.display === "inline-grid") && (el as HTMLElement).children.length > 0) {
      emitRect(el, style, bounds);
      emitPseudoRect();
      emitPseudoText();
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

    emitRect(el, style, bounds);
    emitPseudoRect();
    emitPseudoText();
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
    if (effectiveAlign === "start" && padL > 5 && Math.abs(padL - padR) < 3) {
      effectiveAlign = "center";
    }

    // Text content
    if (directText && directText.trim()) {
      seen.add(el);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padTop = parseFloat(cs.paddingTop) || 0;
      const baseStyle = {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        color: style.color,
        textAlign: effectiveAlign,
        lineHeight: style.lineHeight,
        textDecoration: style.textDecoration,
        textTransform: style.textTransform,
        letterSpacing: style.letterSpacing,
        paddingLeft: padLeft > 2 ? padLeft : 0,
        paddingTop: padTop > 2 ? padTop : 0,
        opacity: style.opacity !== undefined && style.opacity < 1 ? style.opacity : undefined,
      };
      const runs = getTextRuns(el, style);
      const hasStyledRuns = runs.some(r => r.style !== null);
      const textEl: any = {
        type: "text",
        bounds,
        text: directText.trim(),
        style: baseStyle,
        zIndex: style.zIndex,
        position: style.position,
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
  const bodyGradColor = extractGradientColor(bodyCs.backgroundImage) || extractGradientColor(htmlCs.backgroundImage);
  if ((!bodyBg || bodyBg === "#000000") && bodyGradColor) {
    elements.unshift({ type: "rect", bounds: { x: 0, y: 0, w: W, h: H }, fill: bodyGradColor, borderWidth: 0, borderRadius: 0 });
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
