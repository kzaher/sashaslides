/**
 * convert-pptx-lib.ts — Pure HTML-extraction → .pptx-bytes core.
 *
 * No filesystem, no Chrome DevTools Protocol, no network. Inputs are
 * already-extracted slide data (the `{ extraction, visualPngs }` shape
 * produced by extract-dom.ts inside any DOM environment — Node-CDP or
 * a browser iframe) and the output is either a pptxgenjs Presentation
 * object or a finished Uint8Array of bytes.
 *
 * Side-effectful counterparts (CDP-driven extraction, OAuth, file I/O,
 * Google Drive upload) live in convert-pptx-io.ts.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  LAYOUT CONVERSION RULES  —  the contract every change must respect
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. COORDINATE SPACE
 *
 *    HTML viewport  : 1280 × 720 CSS px (Chrome)
 *    pptx slide     : 10 × 5.625 inches (16:9 custom layout)
 *
 *    Two constants:
 *      PX2IN = 10 / 1280       = 0.0078125    (positioning, in inches)
 *      PX2PT = 10 / 1280 × 72  = 0.5625       (font + paragraph spacing, points)
 *
 *    extract-dom.ts emits every element with a final border-box bound
 *    in CSS px: { x, y, w, h }. convert-pptx-lib performs ONE px2in()
 *    conversion per shape and never adjusts coordinates again. Off-
 *    position bugs live in extract-dom.ts, not here.
 *
 *
 * 2. TEXT
 *
 *    Each text-bearing element becomes a pptxgenjs textbox via
 *    slide.addText(...). Two callers:
 *
 *      • standalone text element  → emitStyledText(slide, el, …)
 *      • text-inside-rect (merged)→ emitStyledText(slide, el, …)
 *
 *    Both paths share emitStyledText() — the single source of truth
 *    for rotation, slack, valign, padding folding, and run mapping.
 *
 *    Inline runs (<span>, <strong>, <em>, …) become a TextProps[] array
 *    via mapRunOptions: per-run color, bold, italic, underline, strike,
 *    sub/superscript, highlight (CSS span background).
 *
 *    Font mapping  — CSS family → closest Slides font via FONT_MAP
 *      Helvetica / Helvetica Neue → Arial
 *      -apple-system / Segoe UI   → Roboto
 *      monospace                   → Courier New
 *
 *    Opacity       — CSS `opacity` is BAKED INTO the color via
 *    blendOpacity() against the ancestor background (`bgColorBehind`,
 *    sampled by the extractor). Reason: Slides drops `<a:alpha>` on
 *    text runs on PPTX import, so native pptxgenjs `transparency`
 *    silently fails. Blending against the bg is renderer-agnostic.
 *
 *
 * 3. PADDING  — horizontal vs vertical, handled differently
 *
 *    HORIZONTAL  (padding-left / padding-right):
 *      NOT applied here. extract-dom.ts runs a Range probe that
 *      shrinks text bounds to the actual glyph extent. Re-applying a
 *      padding inset in convert-pptx-lib doubles the inset — caused
 *      real bugs on .touchpoint (slide_19), .code-block (slide_30),
 *      .api-badge (slide_15), .btn (slide_21).
 *
 *    VERTICAL padding-top:
 *      Folded into pptxgenjs `margin: [lIns, rIns, bIns, tIns]` as
 *      tIns = paddingTop × PX2PT — but ONLY when valign === "top"
 *      (anchor=t). Pushes the glyph down so siblings positioned
 *      relative to the same border-box (e.g. .touchpoint::before
 *      bullets at `top: 9px`) align with the text mid-line.
 *      valign === "middle" needs no inset — Slides centres in the
 *      full box.
 *
 *    VERTICAL padding-bottom:
 *      Already baked into the bound's height by extract-dom; no
 *      separate handling.
 *
 *
 * 4. MARGINS
 *
 *    General rule: extract-dom's walk order bakes sibling spacing
 *    into the final (x, y, w, h). convert-pptx-lib does not read a
 *    `margin` field on most elements.
 *
 *    EXCEPTION — list items <li>:
 *      paraSpaceAfter = (marginBottom + paddingTop + paddingBottom)
 *                       × PX2PT
 *      OOXML has no padding concept inside paragraphs. CSS
 *      `li { padding: 4px 0 }` adds 8 px of inter-line air in the
 *      browser; paraSpaceAfter is the only knob to spend that air.
 *
 *
 * 5. ALIGNMENT
 *
 *    Horizontal:
 *      textAlign === "center"           → align: "center"
 *      textAlign === "right" | "end"    → align: "right"
 *      default                          → align: "left"
 *
 *    Vertical:
 *      el.verticallyCentered === true   → valign: "middle"
 *      default                          → valign: "top"
 *
 *      verticallyCentered is set by extract-dom when CSS resolves to
 *      flex / grid centering on short single-line text (the wave-10B
 *      `flexCenteredShapeVC` clause) or a circle/pill with
 *      line-height === height. NEVER set on .text-block, .code-block,
 *      list items, or multi-line body text — those keep anchor=top.
 *
 *    Rotation (`transform: rotate(Xdeg)`):
 *      Forwarded as pptxgenjs `rotate`. extract-dom gives a post-
 *      transform axis-aligned bound, so we re-center on the natural
 *      pre-transform dimensions to keep glyphs from wrap-squeezing.
 *
 *
 * 6. SLACK  — preventing spurious wrap
 *
 *    Slides measures glyphs about 1–3 % wider than Chrome. A textbox
 *    sized to the exact DOM bound wraps the last word. applySlack
 *    inflates by SLACK_PX = 12 on the side opposite alignment:
 *
 *      align=left   → inflate right
 *      align=right  → inflate left
 *      align=center → inflate both sides by SLACK_PX/2
 *
 *    Capped by neighborSlackBudget: never overshoot the gap to the
 *    nearest vertically-overlapping sibling (slide_16 API-latency
 *    tables forced this cap).
 *
 *    Pill-overlay exception — centered single-line text inside a
 *    chip/pill/button gets a budget of max(SLACK_PX, 20 % × width)
 *    bypassing the SLACK_PX/2 cap, because the merged-rect path hands
 *    us the full border-box width.
 *
 *
 * 7. LINE SPACING  — three branches (this is the bug-prone zone)
 *
 *      if (lineHeight && fontSize) {
 *        if (valign === "middle" && verticallyCentered) {
 *          // BRANCH 1 — single-line centered shape text
 *          lineSpacingMultiple = 1.2;
 *        } else if (lineHeightMeasured === true) {
 *          // BRANCH 2 — content-driven measured pitch (.text-block)
 *          lineSpacing = lineHeight × PX2PT;     // absolute pts
 *        } else {
 *          // BRANCH 3 — default
 *          lineSpacingMultiple = (lineHeight / fontSize) / 1.2;
 *        }
 *      }
 *
 *    BRANCH 1 (wave-1a): with anchor="ctr", Slides positions visible
 *      glyphs at the shape center exactly when spcPct = 120000
 *      (multiplier 1.2). Pin explicitly — skipping lnSpc lets Slides
 *      infer a per-slide default that drifts when other shapes land.
 *
 *    BRANCH 2 (wave-10A): when extract-dom flags `lineHeightMeasured`
 *      (.text-block on slide_25 with inline .code chips, .big,
 *      .highlight inflating the line box past the CSS spec), use an
 *      ABSOLUTE point value. spcPct can't represent content-driven
 *      inflation because it's not a percentage of font leading.
 *      Wave-9 emitted absolute pts unconditionally and broke every
 *      plain paragraph; the flag re-narrows the gate.
 *
 *    BRANCH 3: default. Slides treats spcPct as a percentage of its
 *      inferred font-default leading (≈ 1.2 × fontSize for the deck's
 *      fonts), so dividing by 1.2 lands the rendered pitch on CSS
 *      line-height.
 *
 *
 * 8. WHY THIS DESIGN
 *
 *    a. One source of truth for coordinates. extract-dom emits final
 *       border-box bounds; this module converts them once. "Fudge by
 *       a couple of px" fixes belong in extract-dom, not here.
 *
 *    b. One source of truth for text emission. Standalone + merged-
 *       rect text both flow through emitStyledText. Slack, rotation,
 *       valign, padding folding live in exactly one function — a fix
 *       on one path can't silently regress the other.
 *
 *    c. Slides ≠ PowerPoint. <a:alpha> on text, gradient stops, per-
 *       bullet colours — Slides ignores or rewrites them on import.
 *       We work around each at build time (blendOpacity) or via XML
 *       post-process (injectGradientsIntoZip, injectStrokeAlignmentInZip).
 *
 *    d. Conservative gates. Every layout rule above is narrowed by an
 *       extract-dom predicate (`lineHeightMeasured`, `verticallyCentered`,
 *       `singleLine`). Blanket rules always broke another slide; every
 *       wave has tightened — never widened — these gates.
 */

import * as pptxgenModule from "pptxgenjs";
import type PptxGenJS from "pptxgenjs";
import JSZip from "jszip";

// pptxgenjs Slide / option types we reuse below. Keeping a single set of
// aliases here means the body of buildPptx talks about typed objects
// instead of sprinkling `any` on every `slide.addX(...)` call site.
type Slide = PptxGenJS.Slide;
type ShapeProps = PptxGenJS.ShapeProps;
type TextProps = PptxGenJS.TextProps;
type TextPropsOptions = PptxGenJS.TextPropsOptions;

// Slide geometry — shared with the IO layer.
export const SLIDE_W_PX = 1280;
export const SLIDE_H_PX = 720;

// pptxgenjs slide dimensions in inches (widescreen 16:9)
const SLIDE_W_IN = 10;
const SLIDE_H_IN = 5.625;
const PX2IN = SLIDE_W_IN / SLIDE_W_PX; // 0.0078125

// Font scale: CSS px to PowerPoint pt
// At 96dpi CSS, 1px = 0.75pt. But our slide is 10" for 1280px, so effective:
const PX2PT = SLIDE_W_IN / SLIDE_W_PX * 72; // 10/1280*72 = 0.5625

function px2in(px: number): number { return px * PX2IN; }

function hexToRgb(hex: string): string {
  // pptxgenjs wants hex without # prefix
  return hex.replace("#", "").toUpperCase();
}

// Portable byte→base64. Buffer in Node; chunked btoa in browser (avoids
// String.fromCharCode stack-overflow on large payloads).
function bytesToBase64(bytes: Uint8Array | Buffer): string {
  if (typeof Buffer !== "undefined" && bytes instanceof Buffer) {
    return bytes.toString("base64");
  }
  let bin = "";
  const u8 = bytes as Uint8Array;
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    // `String.fromCharCode(...numbers)` typed cleanly; chunked so spread stays
    // under the JS engine's call-arity limit (~64 K on V8) for big PNG payloads.
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Map web fonts to their closest Google Slides equivalents
const FONT_MAP: Record<string, string> = {
  "Helvetica Neue": "Arial",
  "Helvetica": "Arial",
  "-apple-system": "Roboto",
  "BlinkMacSystemFont": "Roboto",
  "Segoe UI": "Roboto",
  "system-ui": "Roboto",
  "monospace": "Courier New",
};
function mapFont(font: string): string { return FONT_MAP[font] || font; }

// Approximate CSS opacity by blending the foreground toward a background
// color. Google Slides silently drops <a:alpha> inside text <a:solidFill>
// on PPTX import, so native `transparency` (which does work in PowerPoint)
// leaves Slides-targeted renders fully opaque — the regression on slide_06
// `.quote-mark` (faint indigo watermark behind italic quote). Blending
// against the nearest ancestor bg (captured by the extractor as
// `bgColorBehind`) works on any renderer and handles both light cards and
// dark HERO watermarks correctly.
function blendOpacity(hexColor: string, op: number, bgHex: string = "#ffffff"): string {
  const parse = (h: string) => {
    const m = h.replace("#", "").match(/.{2}/g);
    if (!m || m.length < 3) return null;
    return m.map(x => parseInt(x, 16));
  };
  const fg = parse(hexColor);
  const bg = parse(bgHex) || [255, 255, 255];
  if (!fg) return hexColor;
  const mix = (f: number, b: number) => Math.round(f * op + b * (1 - op));
  return "#" + [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])]
    .map(v => v.toString(16).padStart(2, "0")).join("");
}

// Slack constant: Slides measures fonts a hair wider than Chrome, so a text
// box sized to the exact DOM bound wraps a single line character-by-character.
// Every text-emit path inflates the box by SLACK_PX in the direction opposite
// alignment (or symmetrically for centered). Iter 8 Agent A6 introduced the
// neighborSlackBudget cap to prevent overflow into adjacent text columns.
const SLACK_PX = 12;

// Map a single inline run to a pptxgenjs text-run options object. Honors the
// standard cascade rs.X || parent.X plus highlight (CSS span background),
// subscript/superscript, underline, strike, and uppercase transform.
// `opacityBlend` folds CSS opacity into the run color by blending toward
// the detected ancestor background (Google Slides drops <a:alpha> on text
// solidFill, so native transparency can't be used).
function mapRunOptions(
  run: TextRun,
  parentStyle: ElementStyle | RunStyle | undefined,
  uppercase: boolean,
  defaults: { readonly color: string; readonly fontSize: number },
  opacityBlend?: { readonly op: number; readonly bg: string } | null,
): TextProps {
  const rs: RunStyle = run.style || {};
  const ps: ElementStyle | RunStyle = parentStyle || {};
  const rawColor = rs.color || ps.color || defaults.color;
  const blendedColor = opacityBlend ? blendOpacity(rawColor, opacityBlend.op, opacityBlend.bg) : rawColor;
  const opts: TextPropsOptions = {
    fontFace: mapFont(rs.fontFamily || ps.fontFamily || "Arial"),
    fontSize: (rs.fontSize || ps.fontSize || defaults.fontSize) * PX2PT,
    color: hexToRgb(blendedColor),
    bold: rs.fontWeight === "bold" || (!rs.fontWeight && ps.fontWeight === "bold"),
    italic: rs.fontStyle === "italic" || (!rs.fontStyle && ps.fontStyle === "italic"),
    underline: { style: (rs.textDecoration === "underline" || (!rs.textDecoration && ps.textDecoration === "underline")) ? "sng" : "none" },
    strike: (rs.textDecoration === "line-through" || (!rs.textDecoration && ps.textDecoration === "line-through")) ? "sngStrike" : undefined,
  };
  if (rs.bgColor) opts.highlight = hexToRgb(rs.bgColor);
  if (rs.verticalAlign === "sub") opts.subscript = true;
  else if (rs.verticalAlign === "super") opts.superscript = true;
  return { text: uppercase ? run.text.toUpperCase() : run.text, options: opts };
}

// Apply slack to a text bound: inflate opposite to alignment so single-line
// text doesn't wrap. Caller supplies the per-side budget from
// neighborSlackBudget so we don't overflow into adjacent columns.
function applySlack(
  b: { x: number; y: number; w: number; h: number },
  align: "left" | "center" | "right",
  budget: { left: number; right: number },
): { x: number; y: number; w: number; h: number } {
  if (align === "left")  return { x: b.x, y: b.y, w: b.w + budget.right, h: b.h };
  if (align === "right") return { x: b.x - budget.left, y: b.y, w: b.w + budget.left, h: b.h };
  const half = Math.min(budget.left, budget.right, SLACK_PX / 2);
  return { x: b.x - half, y: b.y, w: b.w + half * 2, h: b.h };
}

// Unified text emitter: handles slack budgeting, rotation, valign, and per-run
// mapping (with highlight/sub/super). Used by both the standalone "text"
// element case and the rect-merged-text path (which shares all the same
// styling concerns despite being lexically different sites).
//
// `opts.valign`: "top" | "middle" — caller picks (merged-into-rect always
// centers vertically; standalone respects el.verticallyCentered).
// `opts.applyOpacityBlend`: when true, apply style.opacity as pptxgenjs transparency
// (standalone path only — merged-rect path historically didn't do this).
// `opts.selfIndex`: index in `elements` for neighborSlackBudget self-skip.
/** Text-like element argument accepted by emitStyledText. Covers both the
 * standalone TextElement case and a "rect-merged-text" synthesised object
 * that carries the same fields. */
type TextLike = {
  readonly bounds: Bounds;
  readonly style?: ElementStyle;
  readonly text?: string;
  readonly runs?: readonly TextRun[];
  readonly rotate?: number;
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly singleLine?: boolean;
  readonly verticallyCentered?: boolean;
};

function emitStyledText(
  slide: Slide,
  el: TextLike,
  bounds: Bounds,
  elements: readonly ExtractedElement[],
  selfIndex: number,
  valign: "top" | "middle",
  applyOpacityBlend: boolean,
  defaults: { readonly color: string; readonly fontSize: number },
): void {
  const s: ElementStyle = el.style || {};
  const xfm = s.textTransform === "uppercase";
  const align: "left" | "center" | "right" =
    s.textAlign === "center" ? "center" :
    s.textAlign === "right" || s.textAlign === "end" ? "right" : "left";

  // Rotation: a CSS `transform: rotate(Xdeg)` element's bbox is the
  // post-transform axis-aligned box. Drawing that box as-is would squeeze
  // rotated text (e.g. -90° y-axis title) into a narrow strip and wrap it
  // letter-by-letter. Re-center on natural (pre-transform) dimensions and
  // let pptxgenjs rotate.
  const rot = typeof el.rotate === "number" ? el.rotate : 0;
  let rotateDeg = 0;
  let bx = bounds.x, by = bounds.y, bw = bounds.w, bh = bounds.h;
  if (Math.abs(rot) > 0.5 && el.naturalWidth && el.naturalHeight) {
    // Symmetric slack on the natural box so the last glyph survives Slides'
    // wider measurement after rotation.
    const natW = el.naturalWidth + SLACK_PX;
    const natH = el.naturalHeight;
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    bx = cx - natW / 2; by = cy - natH / 2;
    bw = natW; bh = natH;
    rotateDeg = ((rot % 360) + 360) % 360;
  } else {
    // Horizontal padding is now fully owned by extract-dom.ts' unified
    // Range-probe gate (see the padding-inset block in getElements).
    // baseStyle.paddingLeft/paddingRight are always 0, so re-applying an
    // inset here would have nothing to shrink — and historically doubled
    // the extract-dom inset for `.touchpoint` (slide_19, 12 px off),
    // `.code-block` (slide_30, 32 px off), and forced wraps on
    // `.api-badge`/`.status-badge` (slide_15) and `.btn` (slide_21) by
    // dropping tight pills below the glyph-run budget. This site is kept
    // empty deliberately so a future reviewer does not re-add the compound
    // inset.
    // Single-line guard: slack only helps when the text is one line (last
    // glyph gets breathing room against Slides' wider measurement). For
    // multi-line text, Chrome's wrap is already baked into `bounds`; widening
    // only shifts wrap points without benefit and can re-wrap unexpectedly
    // (slide_10_mixed basics regression). Threshold 1.5× lineHeight = 1 line
    // with anti-alias slop. `el.singleLine` overrides the height-based
    // heuristic when the extractor's Range probe confirmed a single line —
    // necessary for pill buttons (slide_21 .btn) where the border-box height
    // (padding + line) trips the threshold despite single-line text.
    const lineH = (s.lineHeight && s.fontSize) ? s.lineHeight : (s.fontSize || 16) * 1.2;
    const isSingleLine = el.singleLine === true || bh <= lineH * 1.5;
    if (isSingleLine) {
      // Pill text overlay (vertically-padded chip/button) needs a bigger
      // slack budget than non-padded single-line text — the merged-rect path
      // hands us the full border-box bounds, so the text is centered inside
      // a box whose width already factors in horizontal padding. Without
      // extra room the last word wraps under Slides' wider glyph metric.
      // ~20% of bw matches the user's "width hack" hint and gives ≈ 26 px on
      // a 130 px button. Still bounded by neighborSlackBudget so we don't
      // overflow into siblings (e.g. tags in a flex row with an 8 px gap
      // shrink the half to a couple of px).
      const isPillOverlay = el.verticallyCentered === true && el.singleLine === true;
      const requestedSlack = isPillOverlay
        ? Math.max(SLACK_PX, Math.round(bw * 0.2))
        : SLACK_PX;
      const budget = neighborSlackBudget({ x: bx, y: by, w: bw, h: bh }, elements, selfIndex, requestedSlack);
      if (isPillOverlay && align === "center") {
        // Bypass applySlack's hard cap of SLACK_PX/2 per side — we want the
        // full requested budget on each side (capped only by neighbor gaps).
        const half = Math.min(budget.left, budget.right);
        bx -= half;
        bw += half * 2;
      } else {
        const slacked = applySlack({ x: bx, y: by, w: bw, h: bh }, align, budget);
        bx = slacked.x; by = slacked.y; bw = slacked.w; bh = slacked.h;
      }
    }
  }

  // Fold CSS opacity into the text color by blending it against the detected
  // ancestor background (`bgColorBehind`, sampled by the extractor). Native
  // pptxgenjs `transparency` would emit <a:alpha> on the run's <a:solidFill>,
  // but Google Slides drops that on PPTX import and leaves the glyph fully
  // opaque — the slide_06 `.quote-mark` regression. Blending handles both
  // light cards (slide_06 → faint lavender on white) and dark-bg watermarks
  // (slide_09 HERO → faint dark on dark) uniformly, on any renderer.
  const opacityBlend: { op: number; bg: string } | null =
    applyOpacityBlend && typeof s.opacity === "number" && s.opacity < 1
      ? { op: s.opacity, bg: s.bgColorBehind || "#ffffff" }
      : null;

  // When valign="top" (anchor="t") and the source had CSS padding-top, fold
  // it into the textbox's top inset (tIns). Without this, glyphs anchored to
  // the textbox top sit at the box's true top edge, while siblings positioned
  // relative to the same border-box (e.g. slide_19 `.touchpoint::before`
  // bullets at `top:9px`) anchor to the box's CSS-correct origin — leaving
  // the bullet visibly below the text's vertical center. Pushing the glyph
  // down by `paddingTop * PX2PT` realigns the bullet with the text mid-line
  // exactly as Chrome lays it out. valign="middle" (anchor="ctr") cases need
  // no inset — Slides centers the glyph in the full box height.
  // pptxgenjs `margin` array is [lIns, rIns, bIns, tIns] in points.
  const padTopPt = (valign === "top" && typeof s.paddingTop === "number" && s.paddingTop > 0)
    ? s.paddingTop * PX2PT
    : 0;
  const commonOpts: TextPropsOptions = {
    x: px2in(bx), y: px2in(by), w: px2in(bw), h: px2in(bh),
    valign,
    align,
    fill: { type: "none" },
    line: { type: "none" },
    margin: padTopPt > 0 ? [0, 0, 0, padTopPt] : 0,
  };
  // Two independent line-spacing rules combined:
  //
  // 1. (wave1a / wave1a-v2) Single-line vertically-centered text (e.g. CTA
  //    pill "Get Started") — we want Slides to position the visible glyphs
  //    at the shape's geometric center when anchor="ctr". Empirically that
  //    happens at spcPct=120000 (lineSpacingMultiple=1.2). Earlier we tried
  //    SKIPPING lnSpc entirely so Slides would use its default, but that
  //    default is UNSTABLE — Slides appears to infer a per-slide default
  //    from other shapes' spcPct values. When wave1b landed and pushed all
  //    non-centered text from 120000 → 100000, the inferred default moved
  //    too, dropping CTA glyphs visibly below center (~7 slide-px). Pin the
  //    rendering by emitting 1.2 explicitly.
  //
  // 2. Multi-line / non-centered text: by default emit
  //    `lineSpacingMultiple = (lineHeight/fontSize) / 1.2` (`<a:spcPct/>`).
  //    Slides treats spcPct as a percentage of its inferred font-default
  //    leading (empirically ≈ 1.2 × fontSize for the fonts in this deck),
  //    so dividing the CSS ratio by 1.2 lands the rendered pitch on the
  //    CSS line-height. This is the wave-1b formula and matches Chrome on
  //    every plain-line-height paragraph (slide_04 cards, slide_06 quote,
  //    slide_08 step bodies, slide_24 .innermost, slide_30 .code-block).
  //
  //    Exception (wave-10A gate): when extract-dom flagged the lineHeight
  //    as MEASURED — i.e. inline children inflated line boxes beyond the
  //    CSS spec, so `effectiveLineHeight` is the median measured pitch
  //    rather than `cssLH` (slide_25 .text-block: .code padded chips,
  //    .big 24 px, .highlight) — fall through to absolute `lineSpacing`
  //    in points (`<a:spcPts/>`). spcPct can't represent that pitch
  //    because the inflation is content-driven, not a percentage of font
  //    leading. wave-9 used absolute pts unconditionally and broke every
  //    other line-height-bearing paragraph; the flag re-narrows the gate
  //    to the .text-block pattern that actually needs it.
  if (s.lineHeight && s.fontSize) {
    const isSingleLineCentered = valign === "middle" && el.verticallyCentered === true;
    if (isSingleLineCentered) {
      commonOpts.lineSpacingMultiple = 1.2;
    } else if (s.lineHeightMeasured === true) {
      commonOpts.lineSpacing = s.lineHeight * PX2PT;
    } else {
      commonOpts.lineSpacingMultiple = (s.lineHeight / s.fontSize) / 1.2;
    }
  }
  if (typeof el.text === "string" && el.text.startsWith("The quick brown")) {
    console.log("DEBUG textblock opts:", JSON.stringify({ lineSpacing: commonOpts.lineSpacing, lineSpacingMultiple: commonOpts.lineSpacingMultiple, lineHeight: s.lineHeight, fontSize: s.fontSize, valign }));
  }
  if (rotateDeg) commonOpts.rotate = rotateDeg;

  if (el.runs && el.runs.length > 0) {
    const textRuns: TextProps[] = el.runs
      .filter((r) => r.text.length > 0)
      .map((run) => mapRunOptions(run, s, xfm, defaults, opacityBlend));
    slide.addText(textRuns, commonOpts);
  } else {
    let text = el.text || "";
    if (xfm) text = text.toUpperCase();
    const rawColor = s.color || defaults.color;
    const blendedColor = opacityBlend ? blendOpacity(rawColor, opacityBlend.op, opacityBlend.bg) : rawColor;
    const textOpts: TextPropsOptions = {
      ...commonOpts,
      fontSize: (s.fontSize || defaults.fontSize) * PX2PT,
      fontFace: mapFont(s.fontFamily || "Arial"),
      color: hexToRgb(blendedColor),
      bold: s.fontWeight === "bold",
      italic: s.fontStyle === "italic",
      underline: s.textDecoration === "underline" ? { style: "sng" } : undefined,
      strike: s.textDecoration === "line-through" ? "sngStrike" : undefined,
    };
    slide.addText(text, textOpts);
  }
}

// Map per-corner radii to OOXML preset + flip flags. Centralised so the
// outer/inner sandwich rects (rounded + partial border) and the table
// outline pick the SAME preset — otherwise the bottom edge of a top-only
// rounded card draws a curve from the outer rect even though the inner
// fill is flat (slide_01 Professional pricing card).
function cornerPresetFromRadii(cr: { tl: number; tr: number; br: number; bl: number }):
  { preset: string; flipH: boolean; flipV: boolean } {
  const mask =
    (cr.tl > 2 ? 1 : 0) |
    (cr.tr > 2 ? 2 : 0) |
    (cr.br > 2 ? 4 : 0) |
    (cr.bl > 2 ? 8 : 0);
  switch (mask) {
    case 0b0000: return { preset: "rect", flipH: false, flipV: false };
    case 0b1111: return { preset: "roundRect", flipH: false, flipV: false };
    case 0b0011: return { preset: "round2SameRect", flipH: false, flipV: false };  // top
    case 0b1100: return { preset: "round2SameRect", flipH: false, flipV: true };   // bottom
    case 0b0101: return { preset: "round2DiagRect", flipH: false, flipV: false };  // TL+BR
    case 0b1010: return { preset: "round2DiagRect", flipH: true,  flipV: false };  // TR+BL
    case 0b0010: return { preset: "round1Rect",     flipH: false, flipV: false };  // TR
    case 0b0001: return { preset: "round1Rect",     flipH: true,  flipV: false };  // TL
    case 0b0100: return { preset: "round1Rect",     flipH: false, flipV: true };   // BR
    case 0b1000: return { preset: "round1Rect",     flipH: true,  flipV: true };   // BL
    case 0b0110: return { preset: "roundRect",      flipH: false, flipV: false };  // right side fallback
    case 0b1001: return { preset: "roundRect",      flipH: false, flipV: false };  // left side fallback
    default:     return { preset: "roundRect",      flipH: false, flipV: false };
  }
}

/** True when the corner mask is side-rounded (TR+BR or TL+BL). OOXML has no
 * preset for that shape, so the caller emits `roundRect` + squared-off
 * overlays on the flat corner pair. */
function needsFlatCornerOverlay(cr: { tl: number; tr: number; br: number; bl: number }): boolean {
  const mask =
    (cr.tl > 2 ? 1 : 0) |
    (cr.tr > 2 ? 2 : 0) |
    (cr.br > 2 ? 4 : 0) |
    (cr.bl > 2 ? 8 : 0);
  return mask === 0b0110 || mask === 0b1001;
}

/** Paint R×R rect overlays (same fill as the underlying shape) over the
 * corners where `cr.<corner> <= 2`. Used to turn a `roundRect` emitted for
 * a side-rounded mask into a stadium-with-flat-side shape (slide_25's
 * `border-radius: 0 8px 8px 0`). */
function emitFlatCornerOverlays(
  slide: Slide,
  b: Bounds,
  cr: CornerRadii,
  fill: ShapeProps["fill"],
): void {
  const rMax = Math.min(Math.max(cr.tl, cr.tr, cr.br, cr.bl), Math.min(b.w, b.h) / 2);
  if (rMax <= 0 || !fill || (fill as { type?: string }).type === "none") return;
  const paint = (x: number, y: number) => {
    slide.addShape("rect", {
      x: px2in(x), y: px2in(y), w: px2in(rMax), h: px2in(rMax),
      fill, line: { type: "none" },
    });
  };
  if (cr.tl <= 2) paint(b.x, b.y);
  if (cr.tr <= 2) paint(b.x + b.w - rMax, b.y);
  if (cr.br <= 2) paint(b.x + b.w - rMax, b.y + b.h - rMax);
  if (cr.bl <= 2) paint(b.x, b.y + b.h - rMax);
}

// =========================================================================
// Clipping & grouping helpers (rule 3 in the layout doc above)
// =========================================================================
// extract-dom propagates a `clipMask` from any rounded `overflow:hidden|clip`
// ancestor down to every emitted element. The emitter compares each
// element's bounds against the mask (epsilon-aware). When the geometric
// intersection differs from the element's own bounds — i.e., the element
// would be visually clipped — we emit a rounded-rect "underlay patch" beneath
// the element with the element's own fill and matching corner radii inherited
// from the mask, then group the patch + element with a shared `objectName`
// marker. A post-processing pass rewrites those marker pairs into native
// `<p:grpSp>` wrappers so resize/move in Slides keeps them together.

interface PatchGeometry {
  readonly bounds: Bounds;
  readonly cornerRadii: CornerRadii;
}

/** Decide whether an element with `bounds` needs an underlay patch under a
 * given clipMask. Returns the patch geometry (clipped to mask bounds with
 * the corner radii inherited where the element touches the mask edge) or
 * `null` when no clipping happens (element is fully inside the rounded
 * region, or no mask at all). `eps` (default 0.5px) absorbs sub-pixel
 * layout jitter. */
function computeClippedPatch(
  bounds: Bounds,
  mask: ClipMask | null | undefined,
  eps = 0.5,
): PatchGeometry | null {
  if (!mask) return null;
  const m = mask.bounds;
  const cr = mask.cornerRadii;
  const maxR = Math.max(cr.tl, cr.tr, cr.br, cr.bl);
  if (maxR <= eps) return null;

  // Rect-clip the element to mask bounds.
  const x = Math.max(bounds.x, m.x);
  const y = Math.max(bounds.y, m.y);
  const r = Math.min(bounds.x + bounds.w, m.x + m.w);
  const btm = Math.min(bounds.y + bounds.h, m.y + m.h);
  if (r <= x + eps || btm <= y + eps) return null;
  const clipped: Bounds = { x, y, w: r - x, h: btm - y };

  // Does the rect-clip already differ from the element's bounds (epsilon)?
  const boundsChanged =
    Math.abs(clipped.x - bounds.x) > eps ||
    Math.abs(clipped.y - bounds.y) > eps ||
    Math.abs(clipped.w - bounds.w) > eps ||
    Math.abs(clipped.h - bounds.h) > eps;

  // Per-corner: the patch needs that corner's radius IFF the element actually
  // reaches the mask edge at that corner. Equivalent for tables (corner cells
  // hug the table frame) and for non-touching internal children (no radius).
  const touchTL = (clipped.x <= m.x + eps) && (clipped.y <= m.y + eps);
  const touchTR = (clipped.x + clipped.w >= m.x + m.w - eps) && (clipped.y <= m.y + eps);
  const touchBR = (clipped.x + clipped.w >= m.x + m.w - eps) && (clipped.y + clipped.h >= m.y + m.h - eps);
  const touchBL = (clipped.x <= m.x + eps) && (clipped.y + clipped.h >= m.y + m.h - eps);

  // No mask edge touched and no rect change → element sits safely inside.
  if (!boundsChanged && !touchTL && !touchTR && !touchBR && !touchBL) return null;

  // Patch corner radii inherited where the host hugs the mask edge, capped
  // to half the patch's smaller dimension so we don't generate degenerate
  // ellipses on narrow cells.
  const cap = Math.max(0, Math.min(clipped.w, clipped.h) / 2);
  const patchCR: CornerRadii = {
    tl: touchTL ? Math.min(cr.tl, cap) : 0,
    tr: touchTR ? Math.min(cr.tr, cap) : 0,
    br: touchBR ? Math.min(cr.br, cap) : 0,
    bl: touchBL ? Math.min(cr.bl, cap) : 0,
  };
  // If no corner ended up with a radius (e.g. radius was already capped to
  // zero), and bounds didn't actually change, there's nothing to do.
  if (!boundsChanged && patchCR.tl === 0 && patchCR.tr === 0 && patchCR.br === 0 && patchCR.bl === 0) {
    return null;
  }
  return { bounds: clipped, cornerRadii: patchCR };
}

/** Allocate a unique group id. Any block whose `objectName` starts with
 * `<gid>__` participates in the group — the post-pass wraps all such blocks
 * in one native `<p:grpSp>`. Two name flavours coexist:
 *   - `<gid>__patch` + `<gid>__host` — original 2-member pair (rect clip case).
 *   - `<gid>__m<N>`                 — N-member group (table shape-twice case,
 *                                      where multiple per-corner-cell underlays
 *                                      live in the same group as the native
 *                                      `<a:tbl>` host).
 * The post-pass groups by `<gid>` regardless of suffix. */
let _groupCounter = 0;
function nextGroupId(): string { return `h2s-grp-${++_groupCounter}`; }
function patchName(gid: string): string { return `${gid}__patch`; }
function hostName(gid: string): string { return `${gid}__host`; }
function memberName(gid: string, idx: number): string { return `${gid}__m${idx}`; }

/** Emit the underlay patch shape with the same fill as the host element. The
 * caller (host emit path) will tag itself with the matching `hostName`. */
function emitClipUnderlay(
  slide: Slide,
  patch: PatchGeometry,
  fill: ShapeProps["fill"],
  groupId: string,
): void {
  const cr = patch.cornerRadii;
  const cp = cornerPresetFromRadii(cr);
  const b = patch.bounds;
  // Same widening pattern used elsewhere in this file for addShape preset
  // names — pptxgenjs accepts a string but its .d.ts types it as a narrow
  // enum, so existing calls (line ~1335, ~1373) widen at the call site.
  const preset = cp.preset as Parameters<Slide["addShape"]>[0];
  slide.addShape(preset, {
    x: px2in(b.x),
    y: px2in(b.y),
    w: px2in(b.w),
    h: px2in(b.h),
    fill,
    line: { type: "none" },
    flipH: cp.flipH,
    flipV: cp.flipV,
    objectName: patchName(groupId),
  });
  // Side-rounded mask compensation (matches host path so the patch's
  // squared-off corners line up with the rounded host above).
  if (fill && needsFlatCornerOverlay(cr)) {
    emitFlatCornerOverlays(slide, b, cr, fill);
  }
}

// =========================================================================
// Extracted-DOM data types
// =========================================================================
// extract-dom.ts emits a flat array of elements in CSS-paint order. Each
// element is one of the variants below. Fields are mostly optional because
// the extractor only populates what's relevant per variant (e.g. only
// `text`/`runs`/`style` on text, only `fill`/`borderRadius`/`gradient` on
// rect). Read-only at the API boundary (`Extraction.elements` is
// `readonly`); per-element mutation (e.g. io.ts emoji retyping) is
// expressed via copy-on-write rather than in-place edits.

export interface Bounds { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface BorderSide {
  readonly width: number;
  readonly color: string;
  readonly style?: "solid" | "dashed" | "dotted" | string;
}
export interface BorderSides {
  readonly top: BorderSide;
  readonly right: BorderSide;
  readonly bottom: BorderSide;
  readonly left: BorderSide;
}
export interface CornerRadii { readonly tl: number; readonly tr: number; readonly br: number; readonly bl: number }

export interface GradientStop {
  readonly color: string;
  readonly position: number;
  readonly alpha?: number;
}
export interface Gradient {
  readonly angle?: number;
  readonly type?: "linear" | "radial" | string;
  readonly stops: readonly GradientStop[];
}

export interface BoxShadowLayer {
  readonly color: string;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly blur?: number;
  readonly spread?: number;
  readonly alpha?: number;
  readonly inset?: boolean;
}

/** Style fields shared between block-level elements and list items. */
export interface ElementStyle {
  readonly color?: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: "bold" | "normal" | string;
  readonly fontStyle?: "italic" | "normal" | string;
  readonly lineHeight?: number;
  readonly lineHeightMeasured?: boolean;
  readonly textAlign?: "left" | "center" | "right" | "end" | "justify" | string;
  readonly textTransform?: "uppercase" | "lowercase" | "none" | string;
  readonly textDecoration?: "underline" | "line-through" | "none" | string;
  readonly opacity?: number;
  readonly bgColor?: string;
  readonly bgColorBehind?: string;
  readonly paddingTop?: number;
  readonly paddingRight?: number;
  readonly paddingBottom?: number;
  readonly paddingLeft?: number;
}

/** Per-run inline style override. */
export interface RunStyle {
  readonly color?: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: "bold" | "normal" | string;
  readonly fontStyle?: "italic" | "normal" | string;
  readonly textDecoration?: "underline" | "line-through" | "none" | string;
  readonly bgColor?: string;
  readonly verticalAlign?: "sub" | "super" | "baseline" | string;
}

/** One inline run inside a text/list element. `style: null` means "no
 * per-run override" (use the element-level style); a present style
 * record carries only the overridden fields. */
export interface TextRun {
  readonly text: string;
  readonly style?: RunStyle | null;
}

export interface Padding { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }

/** Generic clip context propagated from a rounded `overflow:hidden|clip`
 * ancestor in extract-dom. The emitter compares each element's bounds against
 * `bounds` (epsilon-aware) and adds a rounded-corner underlay patch when the
 * element would visually be clipped by the mask. */
export interface ClipMask {
  readonly bounds: Bounds;
  readonly cornerRadii: CornerRadii;
}

/** Fields every element shares. */
interface ElementCommon {
  readonly bounds: Bounds;
  readonly style?: ElementStyle;
  readonly zIndex?: number;
  readonly position?: string;
  readonly rotate?: number;
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly _domIdx?: number;
  /** Propagated clip context from a rounded clipping ancestor; null when
   * the element has no clipping context. */
  readonly clipMask?: ClipMask | null;
  /** Pre-assigned group id shared with an underlay patch — currently unused
   * by extract-dom and reserved for future synthetic grouping. */
  readonly _groupId?: string;
}

export interface RectElement extends ElementCommon {
  readonly type: "rect";
  readonly fill?: string | null;
  readonly fillAlpha?: number;
  readonly gradient?: Gradient | null;
  readonly borderWidth?: number;
  readonly borderColor?: string;
  readonly borderStyle?: string;
  readonly borderRadius?: number;
  readonly cornerRadii?: CornerRadii;
  readonly borderUniform?: boolean;
  readonly borderSides?: BorderSides | null;
  readonly boxShadow?: readonly BoxShadowLayer[] | null;
}

export interface TextElement extends ElementCommon {
  readonly type: "text";
  readonly text?: string;
  readonly runs?: readonly TextRun[];
  readonly singleLine?: boolean;
  readonly verticallyCentered?: boolean;
  readonly padding?: Padding;
}

export interface ListItem {
  readonly text?: string;
  readonly runs?: readonly TextRun[];
  readonly bounds?: Bounds;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: string;
  readonly fontStyle?: string;
  readonly color?: string;
  readonly bulletColor?: string;
  readonly lineHeight?: number;
  readonly marginBottom?: number;
  readonly padding?: Padding;
  readonly bgColor?: string;
  readonly bgAlpha?: number;
  readonly borderRadius?: number;
  readonly borderSides?: BorderSides;
}

export interface ListElement extends ElementCommon {
  readonly type: "list";
  readonly items: readonly ListItem[];
  readonly ordered?: boolean;
  readonly anyStyledItem?: boolean;
}

export interface TableCell {
  readonly text?: string;
  readonly runs?: readonly TextRun[];
  readonly bounds?: Bounds;
  readonly bgColor?: string;
  readonly borderSides?: BorderSides;
  readonly colSpan?: number;
  readonly rowSpan?: number;
  readonly style?: ElementStyle;
}
export interface TableRow {
  readonly cells: readonly TableCell[];
  readonly bounds?: Bounds;
}
export interface TableElement extends ElementCommon {
  readonly type: "table";
  readonly rows: readonly TableRow[];
  /** Debug marker — `<table data-shape-render="true|empty">`. When set,
   * the converter renders the table via pure per-cell `addShape` rects
   * + per-edge filled-rect borders (no native `<a:tbl>`). Used to verify
   * the geometry layout in isolation from `<a:tc>` rendering quirks. */
  readonly renderAsShapes?: boolean;
  readonly shapeRenderEmpty?: boolean;
}

export interface VisualElement extends ElementCommon {
  readonly type: "visual";
  readonly tag?: string;
  readonly cornerRadius?: number;
}

export interface ImageElement extends ElementCommon {
  readonly type: "image";
  readonly tag?: string;
  readonly cornerRadius?: number;
  /** Set by io-side when emoji text was retyped to "image". */
  readonly _wasEmojiText?: boolean;
}

export interface SkipElement extends ElementCommon {
  readonly type: "_skip";
}

/** Discriminated union over every variant extract-dom can emit. */
export type ExtractedElement =
  | RectElement
  | TextElement
  | ListElement
  | TableElement
  | VisualElement
  | ImageElement
  | SkipElement;

export interface Extraction {
  readonly viewport: { readonly w: number; readonly h: number };
  readonly elementCount: number;
  readonly elements: readonly ExtractedElement[];
}

/** Convenience for the buildPptx input shape: paired extraction + per-element
 * rasterised PNGs keyed by element index. Buffer in Node, Uint8Array in
 * browser; we accept both. */
export interface SlideInput {
  readonly extraction: Extraction;
  readonly visualPngs: ReadonlyMap<number, Uint8Array | Buffer>;
}

// Bounded slack: extending a text box by SLACK_PX in some direction must not
// overlap a sibling element that sits to the same side with vertical overlap.
// Returns the maximum permissible slack on each side (>=0) capped by the
// requested SLACK_PX. Iter 8 Agent A6 logic — fixes slide_16 API-latency tables
// where uncapped right-slack made `/api/users` text overlap the next column.
//
// Why a budget at all: Slides measures glyphs ~1–3% wider than Chrome's
// layout, so a textbox sized to the exact DOM bound wraps the last word onto
// a phantom second line. Inflating the box by SLACK_PX (currently 12) on the
// "free" side absorbs that drift. But unbounded slack lets a left-aligned
// label punch into the sibling column to its right (table cells, tag rows,
// stat-card pairs). The vertical-overlap test picks only siblings that share
// a Y range, the horizontal-disjoint test rejects siblings that already
// overlap horizontally (they're presumably parents/backgrounds), and the
// remaining gap caps the slack — leaving non-conflicting text to enjoy the
// full SLACK_PX padding. `pad=2` is a tiny extra buffer so adjacent boxes
// don't touch even at integer-pixel grids.
function neighborSlackBudget(
  b: Bounds,
  elements: readonly ExtractedElement[],
  selfIndex: number,
  requested: number,
  pad: number = 2,
): { left: number; right: number } {
  let leftBudget = requested;
  let rightBudget = requested;
  const yTop = b.y;
  const yBot = b.y + b.h;
  for (let i = 0; i < elements.length; i++) {
    if (i === selfIndex) continue;
    const o = elements[i];
    if (!o || o.type === "_skip" || !o.bounds) continue;
    const ob = o.bounds;
    // Vertical overlap?
    if (ob.y + ob.h <= yTop || ob.y >= yBot) continue;
    // Horizontal: must NOT already overlap our box horizontally.
    if (ob.x < b.x + b.w && ob.x + ob.w > b.x) continue;
    // Right neighbor: starts at/after our right edge
    if (ob.x >= b.x + b.w) {
      const gap = ob.x - (b.x + b.w) - pad;
      if (gap < rightBudget) rightBudget = Math.max(0, gap);
    }
    // Left neighbor: ends at/before our left edge
    else if (ob.x + ob.w <= b.x) {
      const gap = b.x - (ob.x + ob.w) - pad;
      if (gap < leftBudget) leftBudget = Math.max(0, gap);
    }
  }
  return { left: leftBudget, right: rightBudget };
}

// --- Build pptx ---
// Per-slide list of rasterized regions we emitted as addImage — surfaced to
// the SxS rating UI so reviewers can see which parts of the output aren't
// native Slides primitives. Coordinates are normalized to 0..1 of slide size.
export interface RenderedRegion { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly kind: string }

/** pptxgenjs Presentation augmented with our side-band registries:
 *   __gradients: parsed CSS gradients, indexed by the GRAD_<n> objectName
 *                tag we set on each gradient-bearing shape. injectGradients*
 *                walks the saved XML and writes <a:gradFill> at the matching
 *                shape. */
export type PresentationWithRegistries = PptxGenJS & {
  __gradients: Gradient[];
};

/**
 * Pure-shape table renderer — debug path for `<table data-shape-render>`.
 *
 * Emits per-cell `addShape("rect")` for cell fills and per-edge filled
 * rect strips for borders, using the geometry validated in
 * `tools/table-twoway/run.ts`. All coordinates are snapped to a 0.01"
 * lattice so the output matches a `<p:sp>`-only path Slides renders
 * deterministically (no `<a:tbl>` rasterisation quirks).
 *
 * Cell coordinates come from the per-cell `bounds` recorded by
 * extract-dom (Chrome's getBoundingClientRect at 1280×720 viewport).
 * That ensures the shape composition lines up with what the user saw
 * in the browser preview.
 */
function renderTableAsShapes(slide: Slide, el: TableElement): void {
  // Geometry — single source of truth, snapped ONCE to the 0.01" lattice
  // (`q01`). This is the grid the Slides UI snaps hand-placed shapes to,
  // so cells, borders, and any rounded-corner masks that consume the
  // SAME prefix sums reference identical edge coordinates → continuations
  // are exact. Mirrors `tools/table-twoway/run.ts:layoutTable`.
  const q01 = (v: number): number => Math.round(v * 100) / 100;
  const rows = el.rows || [];
  if (rows.length === 0 || rows[0].length === 0) return;
  const nRows = rows.length;
  const nCols = rows[0].length;
  const cellSize = (cell: TableCell): { w: number; h: number } => ({
    w: cell.bounds?.w || 0,
    h: cell.bounds?.h || 0,
  });
  // Column/row sizes from RAW px (row 0 for widths, col 0 for heights).
  const colWraw = rows[0].map((c) => px2in(cellSize(c).w));
  const rowHraw = rows.map((r) => px2in(cellSize(r[0]).h));
  const tableX = px2in(el.bounds?.x || 0);
  const tableY = px2in(el.bounds?.y || 0);
  // Quantize CUMULATIVE gridline positions, NOT per-cell sizes. Snapping
  // each tiny size independently (e.g. a 12px row = 0.09375" → 0.09") and
  // summing accumulates drift — 4 such rows land 0.01" short, so the grid
  // stops a couple display-px above the table bottom and the wrapper
  // background shows through as a seam. Snapping the absolute edge instead
  // keeps every gridline on the lattice AND makes cell sizes (edge[i+1] −
  // edge[i]) sum exactly to the table extent — no drift, no seam.
  const colEdges = [q01(tableX)];
  { let acc = 0; for (const w of colWraw) { acc += w; colEdges.push(q01(tableX + acc)); } }
  const rowEdges = [q01(tableY)];
  { let acc = 0; for (const h of rowHraw) { acc += h; rowEdges.push(q01(tableY + acc)); } }
  // Cell sizes as edge differences (already lattice-aligned, drift-free).
  const colW = colWraw.map((_, ci) => q01(colEdges[ci + 1] - colEdges[ci]));
  const rowH = rowHraw.map((_, ri) => q01(rowEdges[ri + 1] - rowEdges[ri]));

  // Does any cell (or the table) carry a border? When borders exist they
  // own the shared boundary pixel, so cell fills must NOT be extended
  // (extension would paint over the border). With no borders, abutting
  // `<p:sp>` rects can leave a 1-display-px gap at the shared edge that
  // exposes whatever sits behind the table (e.g. `.colored-wrap`'s pink);
  // we close it with an inclusive-edge extension below.
  const sideW = (s?: { width?: number }): number => s?.width || 0;
  const hasAnyBorder = rows.some((row) => row.some((c) => {
    const bs = c.style?.borderSides;
    return bs ? (sideW(bs.top) || sideW(bs.right) || sideW(bs.bottom) || sideW(bs.left)) > 0 : false;
  })) || (el.borderSides
    ? (sideW(el.borderSides.top) || sideW(el.borderSides.right) || sideW(el.borderSides.bottom) || sideW(el.borderSides.left)) > 0
    : false);

  // Inclusive-edge extension = exactly ONE display pixel (1/160"). Cells
  // grow by 1px into their right/bottom neighbour (interior edges only —
  // never past the table's outer right/bottom edge into the wrapper).
  // Color-agnostic: the union of all cell rects has no sub-pixel hole, so
  // no background ever shows through. Matches run.ts's `ONE_PX_IN` trick.
  const ONE_PX_IN = 1 / 160;
  const ext = hasAnyBorder ? 0 : ONE_PX_IN;

  // Per-cell fill rects.
  for (let ri = 0; ri < nRows; ri++) {
    const row = rows[ri];
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      const bg = cell.style?.bgColor || el.bgColor;
      if (!bg) continue;
      const extRight  = ci < nCols - 1 ? ext : 0;
      const extBottom = ri < nRows - 1 ? ext : 0;
      slide.addShape("rect", {
        x: colEdges[ci], y: rowEdges[ri], w: colW[ci] + extRight, h: rowH[ri] + extBottom,
        fill: { color: hexToRgb(bg) },
        line: { type: "none" },
      });
    }
  }
  // Text overlay (only when not shapeRenderEmpty). Per-cell, drawn AFTER
  // all fills so glyphs sit on top.
  if (!el.shapeRenderEmpty) {
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      for (let ci = 0; ci < row.length; ci++) {
        const cell = row[ci];
        if (!cell.text) continue;
        const cx = colEdges[ci];
        const cy = rowEdges[ri];
        const cwBase = colW[ci];
        const chBase = rowH[ri];
        slide.addText(cell.text, {
          x: cx, y: cy, w: cwBase, h: chBase,
          align: cell.style?.textAlign === "center" ? "center"
            : cell.style?.textAlign === "right" ? "right" : "left",
          valign: "middle",
          fontFace: mapFont(cell.style?.fontFamily || "Arial"),
          fontSize: (cell.style?.fontSize || 14) * PX2PT,
          color: hexToRgb(cell.style?.color || "#111111"),
          bold: cell.style?.fontWeight === "bold" || cell.isHeader,
          italic: cell.style?.fontStyle === "italic",
          margin: 0,
        });
      }
    }
  }

  // Borders. Each cell carries per-side `borderSides`; pick the dominant
  // side at each gridline. Inter-cell borders straddle the shared edge;
  // outer-perimeter borders are nudged inward (algn="in" semantics) so
  // they sit inside the table bounding box. All coords share the SAME
  // q01 lattice + prefix sums as the cell fills above.
  interface SideBorder { width: number; color: string }
  const pickSide = (a: SideBorder | undefined, b: SideBorder | undefined): SideBorder | null => {
    const aw = a?.width || 0, bw = b?.width || 0;
    if (aw === 0 && bw === 0) return null;
    return aw >= bw ? { width: aw, color: a!.color || "#000000" } : { width: bw, color: b!.color || "#000000" };
  };
  const tableSides = el.borderSides;
  // Vertical gridlines (cols+1)
  for (let ci = 0; ci <= rows[0].length; ci++) {
    let dominant: SideBorder | null = null;
    for (let ri = 0; ri < rows.length; ri++) {
      const cell = rows[ri][ci - 1];
      const cellRight = cell?.style?.borderSides?.right;
      const cellLeft = rows[ri][ci]?.style?.borderSides?.left;
      let side = pickSide(cellRight, cellLeft);
      if (ci === 0 && tableSides?.left) side = pickSide(side ?? undefined, tableSides.left);
      if (ci === rows[0].length && tableSides?.right) side = pickSide(side ?? undefined, tableSides.right);
      if (side && (!dominant || side.width > dominant.width)) dominant = side;
    }
    if (!dominant) continue;
    const bwIn = q01(px2in(dominant.width));
    const gx = colEdges[ci];
    const half = bwIn / 2;
    const lx = ci === 0 ? q01(gx) : ci === nCols ? q01(gx - bwIn) : q01(gx - half);
    slide.addShape("rect", {
      x: lx, y: rowEdges[0], w: bwIn, h: q01(rowEdges[nRows] - rowEdges[0]),
      fill: { color: hexToRgb(dominant.color) },
      line: { type: "none" },
    });
  }
  // Horizontal gridlines (rows+1)
  for (let ri = 0; ri <= rows.length; ri++) {
    let dominant: SideBorder | null = null;
    for (let ci = 0; ci < rows[0].length; ci++) {
      const cellBelow = rows[ri - 1]?.[ci]?.style?.borderSides?.bottom;
      const cellAbove = rows[ri]?.[ci]?.style?.borderSides?.top;
      let side = pickSide(cellBelow, cellAbove);
      if (ri === 0 && tableSides?.top) side = pickSide(side ?? undefined, tableSides.top);
      if (ri === rows.length && tableSides?.bottom) side = pickSide(side ?? undefined, tableSides.bottom);
      if (side && (!dominant || side.width > dominant.width)) dominant = side;
    }
    if (!dominant) continue;
    const bwIn = q01(px2in(dominant.width));
    const gy = rowEdges[ri];
    const half = bwIn / 2;
    const ly = ri === 0 ? q01(gy) : ri === nRows ? q01(gy - bwIn) : q01(gy - half);
    slide.addShape("rect", {
      x: colEdges[0], y: ly, w: q01(colEdges[nCols] - colEdges[0]), h: bwIn,
      fill: { color: hexToRgb(dominant.color) },
      line: { type: "none" },
    });
  }
}

export function buildPptx(
  slides: readonly SlideInput[],
  title: string,
): { pres: PresentationWithRegistries; renderedRegions: RenderedRegion[][] } {
  // ESM/CJS interop — `import * as pptxgenModule from "pptxgenjs"` lands a
  // module-namespace wrapper whose shape varies by loader:
  //   - Plain Node ESM:   M.default = <ctor>                    (1-level wrap)
  //   - tsx from .mts:    M.default = { default: <ctor>, ... }  (2-level wrap)
  //   - Browser stub:     M.default = <ctor>                    (1-level)
  // Unwrap `.default` until we land on the actual constructor (a function).
  const resolveCtor = (m: unknown): new () => PptxGenJS => {
    let v: unknown = m;
    while (typeof v !== "function" && v != null && typeof (v as { default?: unknown }).default !== "undefined") {
      v = (v as { default: unknown }).default;
    }
    return v as new () => PptxGenJS;
  };
  const PptxGenJSCtor = resolveCtor(pptxgenModule);
  const pres = new PptxGenJSCtor() as PresentationWithRegistries;
  const gradientRegistry: Gradient[] = [];
  pres.__gradients = gradientRegistry;
  pres.title = title;
  pres.layout = "LAYOUT_WIDE"; // 13.333" x 7.5" — wait, we want 10" x 5.625"

  // Actually define custom layout matching our slide dimensions
  pres.defineLayout({ name: "CUSTOM", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pres.layout = "CUSTOM";

  const renderedRegions: RenderedRegion[][] = [];

  for (let si = 0; si < slides.length; si++) {
    const { extraction, visualPngs } = slides[si];
    const slide = pres.addSlide();
    const slideRegions: RenderedRegion[] = [];
    renderedRegions.push(slideRegions);

    for (let ei = 0; ei < extraction.elements.length; ei++) {
      const el = extraction.elements[ei];
      if (el.type === "_skip") continue;
      const b = el.bounds;

      // Rule 1: a fully-transparent element with no content contributes
      // nothing to the slide. Don't emit a phantom shape — it pollutes the
      // outline pane in Slides and confuses post-pass element counting.
      // Element types that may carry visible content even with a transparent
      // background (text, list, table, image, visual) are left untouched.
      if (el.type === "rect") {
        const r = el as RectElement;
        const hasFill = r.fill && r.fill !== "transparent" && (r.fillAlpha === undefined || r.fillAlpha > 0);
        const hasBorder = (r.borderWidth || 0) > 0 && r.borderColor;
        const hasSideBorder = r.borderSides
          ? [r.borderSides.top, r.borderSides.right, r.borderSides.bottom, r.borderSides.left].some((s) => (s?.width || 0) > 0)
          : false;
        const hasShadow = !!r.boxShadow && (Array.isArray(r.boxShadow) ? r.boxShadow.length > 0 : true);
        const hasGradient = !!r.gradient && !!r.gradient.stops && r.gradient.stops.length > 0;
        if (!hasFill && !hasBorder && !hasSideBorder && !hasShadow && !hasGradient) continue;
      }

      switch (el.type) {
        case "rect": {
          // Full-slide background
          if (b.w > SLIDE_W_PX * 0.9 && b.h > SLIDE_H_PX * 0.9) {
            // pptxgenjs `slide.background` can only carry a solid fill, so
            // skip this shortcut when the element owns a multi-stop gradient.
            // The rect drops through to the regular shape path, and the
            // post-processing gradFill injector rewrites <a:solidFill> →
            // <a:gradFill> (slide_17 navy→purple body wash).
            if (el.gradient && el.gradient.stops && el.gradient.stops.length >= 2) {
              // fall through to shape path below
            } else {
              if (el.fill) {
                slide.background = { fill: hexToRgb(el.fill) };
              }
              break;
            }
          }

          // Determine shape type
          const cr = el.cornerRadii || { tl: el.borderRadius || 0, tr: el.borderRadius || 0, br: el.borderRadius || 0, bl: el.borderRadius || 0 };
          const minDim = Math.min(b.w, b.h);
          const isCircle = cr.tl >= minDim * 0.4 && cr.tr >= minDim * 0.4 && cr.br >= minDim * 0.4 && cr.bl >= minDim * 0.4
            && Math.abs(b.w - b.h) < b.w * 0.3;
          const anyRounded = cr.tl > 2 || cr.tr > 2 || cr.br > 2 || cr.bl > 2;

          // Per-corner mask → OOXML preset + flips so asymmetric border-radius
          // (e.g. top-only round on a card header) renders correctly rather
          // than getting collapsed into an all-corners roundRect.
          let cornerPreset: string;
          let cornerFlipH = false;
          let cornerFlipV = false;
          if (isCircle) {
            cornerPreset = "ellipse";
          } else if (anyRounded) {
            const cp = cornerPresetFromRadii(cr);
            cornerPreset = cp.preset;
            cornerFlipH = cp.flipH;
            cornerFlipV = cp.flipV;
          } else {
            cornerPreset = "rect";
          }
          const shapeName = cornerPreset;

          // Scan for text to merge into this shape. IMPORTANT: only merge if
          // this rect is the *innermost* ancestor that fits the text. Otherwise
          // a deeper-nested rect (with its own bg) will paint over the merged
          // text and bury it (slide_24: text inside 5 nested cards was merged
          // into level-3, then hidden by level-4's solid fill).
          //
          // Also count how many text elements are wholly inside this rect's
          // vertical range (before the next same-depth sibling paints). A
          // pull-quote (`.pull-quote { bg + border-left } > <p> + .attr`) hosts
          // TWO block texts — merging just the first would center it vertically
          // and push the `.attr` caption off the decorated box. When multiple
          // texts live inside, skip merging and let each text emit at its own
          // bounds so the rect acts as a pure background + accent stripe.
          let insideTextCount = 0;
          for (let ti = ei + 1; ti < extraction.elements.length; ti++) {
            const next = extraction.elements[ti];
            if (next.type !== "text" || !next.bounds) continue;
            const nb = next.bounds;
            const tcx = nb.x + nb.w / 2, tcy = nb.y + nb.h / 2;
            if (tcx >= b.x && tcx <= b.x + b.w && tcy >= b.y && tcy <= b.y + b.h) {
              insideTextCount++;
              if (insideTextCount > 1) break;
            }
            // Stop scanning past this rect's vertical extent — avoids counting
            // unrelated texts from sibling sections that sit below.
            if (nb.y > b.y + b.h) break;
          }
          const skipMergeMultiText = insideTextCount > 1;

          let mergedTextEl: TextElement | null = null;
          let mergedTextIndex = -1;
          for (let ti = ei + 1; ti < extraction.elements.length && !skipMergeMultiText; ti++) {
            const next = extraction.elements[ti];
            if (next.type !== "text" || !next.bounds) continue;
            const nb = next.bounds;
            const sameBounds = Math.abs(nb.x - b.x) < 5 && Math.abs(nb.y - b.y) < 5 &&
                               Math.abs(nb.w - b.w) < 5 && Math.abs(nb.h - b.h) < 5;
            const tcx = nb.x + nb.w / 2, tcy = nb.y + nb.h / 2;
            const insideBounds = tcx >= b.x && tcx <= b.x + b.w && tcy >= b.y && tcy <= b.y + b.h;
            const textDominates = nb.h >= b.h * 0.5 && nb.w <= b.w + 4;
            if (sameBounds || (insideBounds && (isCircle || textDominates))) {
              // Check if a rect *after* this one also contains the text and
              // would paint over it. If so, defer the merge — the text will
              // ride on that deeper rect (or be emitted standalone as a text
              // element after all the nested fills).
              let deeperFillsOver = false;
              for (let di = ei + 1; di < ti; di++) {
                const mid = extraction.elements[di];
                if (mid.type !== "rect" || !mid.bounds || (!mid.fill && !mid.gradient)) continue;
                const mb = mid.bounds;
                const textInsideMid = tcx >= mb.x && tcx <= mb.x + mb.w && tcy >= mb.y && tcy <= mb.y + mb.h;
                if (textInsideMid) { deeperFillsOver = true; break; }
              }
              if (deeperFillsOver) break; // don't merge — let text render on its own
              mergedTextEl = next;
              mergedTextIndex = ti;
              extraction.elements[ti] = { type: "_skip", bounds: nb };
              break;
            }
          }

          // Non-uniform border info — computed now, painted AFTER content.
          const bs = el.borderSides;
          const uniform = el.borderUniform;
          const hasNonUniformBorder = bs && !uniform &&
            ((bs.top?.width > 0 && bs.top?.color) || (bs.right?.width > 0 && bs.right?.color) ||
             (bs.bottom?.width > 0 && bs.bottom?.color) || (bs.left?.width > 0 && bs.left?.color));

          // Content shape
          const opts: ShapeProps = {
            x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
            line: { type: "none" },
          };

          // Fill (gradient tagged via objectName for post-processing — pptxgenjs has no gradient API)
          if (el.gradient && el.gradient.stops && el.gradient.stops.length >= 2) {
            // Solid-fill fallback carries the first-stop alpha (important for
            // radial gradients like `.bg-glow` whose first stop is 15% indigo
            // — an opaque solid would paint a visible disc if the gradFill
            // injection ever misses this shape).
            const fallbackFill: NonNullable<ShapeProps["fill"]> = { color: hexToRgb(el.gradient.stops[0].color) };
            if (typeof el.fillAlpha === "number" && el.fillAlpha < 1) {
              fallbackFill.transparency = Math.round((1 - el.fillAlpha) * 100);
            }
            opts.fill = fallbackFill;
            const gid = gradientRegistry.length;
            gradientRegistry.push(el.gradient);
            opts.objectName = `GRAD_${gid}`;
          } else if (el.fill) {
            const fillOpts: NonNullable<ShapeProps["fill"]> = { color: hexToRgb(el.fill) };
            if (typeof el.fillAlpha === "number" && el.fillAlpha < 1) {
              // pptxgenjs `transparency` is percent-transparent: 0 = opaque, 100 = invisible.
              fillOpts.transparency = Math.round((1 - el.fillAlpha) * 100);
            }
            opts.fill = fillOpts;
          }

          // Corner radius (pptxgenjs rectRadius is in inches).
          // Clamp to half the shorter dimension — CSS `border-radius: 50px` on
          // a 18px-tall pill gives radius > h/2, which produces an invalid
          // OOXML `adj` value; Google Slides then renders the shape as empty
          // (no fill, no outline), leaving the tag's text floating on the slide
          // background. Clamping yields a proper stadium/pill shape.
          if (anyRounded && !isCircle) {
            const maxR = Math.min(b.w, b.h) / 2;
            const maxRadiusPx = Math.max(cr.tl, cr.tr, cr.br, cr.bl);
            opts.rectRadius = px2in(Math.min(maxRadiusPx, maxR));
            if (cornerFlipH) opts.flipH = true;
            if (cornerFlipV) opts.flipV = true;
          }

          // Border outline (uniform)
          if (!hasNonUniformBorder && uniform && el.borderWidth > 0 && el.borderColor) {
            opts.line = {
              color: hexToRgb(el.borderColor),
              width: Math.min(el.borderWidth * PX2PT, 6),
              dashType: el.borderStyle === "dashed" ? "dash" : el.borderStyle === "dotted" ? "dot" : "solid",
            };
          }

          // Box shadow
          if (el.boxShadow && (el.boxShadow.blur > 0 || el.boxShadow.offsetX !== 0 || el.boxShadow.offsetY !== 0)) {
            const dx = el.boxShadow.offsetX || 0;
            const dy = el.boxShadow.offsetY || 0;
            // OOXML shadow dir: 0°=east, 90°=south — matches CSS offsetY>0=down
            let angle = Math.atan2(dy, dx) * 180 / Math.PI;
            if (dx === 0 && dy === 0) angle = 90;
            if (angle < 0) angle += 360;
            opts.shadow = {
              type: "outer",
              blur: Math.min(el.boxShadow.blur * PX2PT, 30),
              offset: Math.sqrt(dx * dx + dy * dy) * PX2PT,
              color: hexToRgb(el.boxShadow.color || "#000000"),
              opacity: el.boxShadow.alpha ?? 0.25,
              angle: Math.round(angle),
            };
          }

          // Rotation: a CSS `transform: rotate(Xdeg)` element's bbox is the
          // post-transform axis-aligned box. Drawing that box as-is turns a
          // thin slanted line (e.g. `.profit-line { height:2px; rotate(-8deg) }`)
          // into a fat filled rectangle. Re-center the shape on the bbox center
          // at its natural (pre-transform) size and apply pptxgenjs rotate.
          const rectRot = typeof el.rotate === "number" ? el.rotate : 0;
          if (Math.abs(rectRot) > 0.5 && el.naturalWidth && el.naturalHeight) {
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h / 2;
            const nw = el.naturalWidth;
            const nh = el.naturalHeight;
            opts.x = px2in(cx - nw / 2);
            opts.y = px2in(cy - nh / 2);
            opts.w = px2in(nw);
            opts.h = px2in(nh);
            opts.rotate = ((rectRot % 360) + 360) % 360;
          }

          // Rule 3: rounded clipping mask from any `overflow:hidden` ancestor.
          // When the host rect would visually be clipped by a parent's
          // rounded corners, draw an underlay patch in the same fill with
          // the rounded outline, then the host on top (sharp shape covered
          // by the rounded patch above is invisible). Both shapes are tagged
          // with the same group id; the JSZip post-process groups them so
          // resize/move in Slides keeps them together.
          const patch = computeClippedPatch(b, el.clipMask);
          if (patch && opts.fill) {
            const gid = nextGroupId();
            emitClipUnderlay(slide, patch, opts.fill, gid);
            opts.objectName = hostName(gid);
          }

          slide.addShape(shapeName, opts);

          // Side-rounded masks (0b0110 = right side, 0b1001 = left side) emit
          // as `roundRect` above with all-4 curves; square off the CSS-flat
          // corner pair by painting R×R overlays in the same fill. Skipped
          // for gradient rects so the GRAD_N tag on the parent shape keeps
          // its solitary solidFill match for the injector.
          if (anyRounded && !isCircle && !el.gradient && needsFlatCornerOverlay(cr) && opts.fill) {
            emitFlatCornerOverlays(slide, b, cr, opts.fill);
          }

          // Paint non-uniform border strips OVER the content shape so they
          // survive the bg fill (otherwise a 4px bottom-border on a white
          // card disappears under the white fill rect).
          //
          // When the element has a border-radius, a flat strip along the edge
          // would cut straight across the rounded corners (slide_09: a top
          // border on a rounded card that visibly ignores the radius). In
          // that case we paint the entire rounded outline in the border
          // color, then draw background-colored strips over the sides that
          // don't have a border — which "erases" those segments, leaving only
          // the bordered side rounded along the corners.
          // Rounded + partial borders: paint them so the bordered sides
          // follow the curve. Strategy — two-rect sandwich:
          //   1. Outer rounded rect filled with the border color.
          //   2. Inner rounded rect filled with the card's own background,
          //      inset by (borderWidth) on each bordered side and 0 on the
          //      non-bordered sides.
          // Only the bordered sides' strips remain visible, and they curve
          // along the shared border-radius. Works for any single side, any
          // combination, any radius. Skipped when any bordered side has a
          // dashed/dotted style (the inner-fill trick would blur the dashes)
          // or when the bordered sides disagree on color.
          let borderHandledRounded = false;
          if (hasNonUniformBorder && anyRounded && el.fill) {
            const hasTop = (bs.top?.width || 0) > 0 && bs.top?.color;
            const hasBottom = (bs.bottom?.width || 0) > 0 && bs.bottom?.color;
            const hasLeft = (bs.left?.width || 0) > 0 && bs.left?.color;
            const hasRight = (bs.right?.width || 0) > 0 && bs.right?.color;
            const borderColors = [hasTop && bs.top.color, hasBottom && bs.bottom.color, hasLeft && bs.left.color, hasRight && bs.right.color].filter(Boolean) as string[];
            const sameColor = borderColors.every((c: string) => c === borderColors[0]);
            const allSolid = [hasTop && bs.top, hasBottom && bs.bottom, hasLeft && bs.left, hasRight && bs.right]
              .filter(Boolean)
              .every((s) => (s as BorderSide).style !== "dashed" && (s as BorderSide).style !== "dotted");
            // Only run the sandwich when at least one bordered side actually
            // touches a rounded corner. slide_25's `border-left: 4px; border-radius: 0 8px 8px 0`
            // has its single bordered side (left) on two flat corners (TL,BL);
            // the sandwich would then paint a full-footprint border-coloured
            // roundRect behind an inner fill that's inset only on the left,
            // leaving a visible blue crescent at TR/BR where the outer's
            // radius-8 curve extends past the inner's shrunk radius. In that
            // geometry the flat-strip emitter does the right thing.
            const roundedCornerOnBorderedSide =
              (hasTop && (cr.tl > 2 || cr.tr > 2)) ||
              (hasBottom && (cr.bl > 2 || cr.br > 2)) ||
              (hasLeft && (cr.tl > 2 || cr.bl > 2)) ||
              (hasRight && (cr.tr > 2 || cr.br > 2));
            if (sameColor && allSolid && borderColors.length > 0 && roundedCornerOnBorderedSide) {
              // Both outer and inner sandwich rects MUST honor the same
              // per-corner preset as the content shape — otherwise the
              // outer's `roundRect` (all-4-corners) draws a curved bottom
              // edge under a top-only-rounded card header (slide_01
              // Professional pricing card).
              const sandwichCp = cornerPresetFromRadii(cr);
              const sandwichOuterOpts: ShapeProps = {
                x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
                fill: { color: hexToRgb(borderColors[0]) },
                line: { type: "none" },
              };
              if (sandwichCp.preset !== "rect") {
                sandwichOuterOpts.rectRadius = px2in(el.borderRadius);
                if (sandwichCp.flipH) sandwichOuterOpts.flipH = true;
                if (sandwichCp.flipV) sandwichOuterOpts.flipV = true;
              }
              // 1. Outer = border color across the full footprint, same corner mask.
              slide.addShape(sandwichCp.preset, sandwichOuterOpts);
              if (needsFlatCornerOverlay(cr)) {
                emitFlatCornerOverlays(slide, b, cr, sandwichOuterOpts.fill);
              }
              // 2. Inner = card fill, inset by border widths on bordered sides only.
              const iTop = hasTop ? (bs.top.width || 0) : 0;
              const iBottom = hasBottom ? (bs.bottom.width || 0) : 0;
              const iLeft = hasLeft ? (bs.left.width || 0) : 0;
              const iRight = hasRight ? (bs.right.width || 0) : 0;
              const ix = b.x + iLeft;
              const iy = b.y + iTop;
              const iw = Math.max(0, b.w - iLeft - iRight);
              const ih = Math.max(0, b.h - iTop - iBottom);
              // Inner per-corner radii: shrink each rounded corner by the MIN
              // of its two adjacent-side insets. Using `max(insets)` across
              // all sides caused a blue crescent at TR/BR on a left-only
              // bordered card because a 4 px left-inset was subtracted from
              // a radius whose adjacent sides (top, right) had 0 inset — the
              // inner's curve pulled away from the outer's curve and the
              // border-coloured ring leaked through on the non-bordered side.
              const innerCr = {
                tl: cr.tl > 2 ? Math.max(0, cr.tl - Math.min(iTop, iLeft)) : 0,
                tr: cr.tr > 2 ? Math.max(0, cr.tr - Math.min(iTop, iRight)) : 0,
                br: cr.br > 2 ? Math.max(0, cr.br - Math.min(iBottom, iRight)) : 0,
                bl: cr.bl > 2 ? Math.max(0, cr.bl - Math.min(iBottom, iLeft)) : 0,
              };
              const innerCp = cornerPresetFromRadii(innerCr);
              const innerR = Math.max(innerCr.tl, innerCr.tr, innerCr.br, innerCr.bl);
              const innerOpts: ShapeProps = {
                x: px2in(ix), y: px2in(iy), w: px2in(iw), h: px2in(ih),
                fill: { color: hexToRgb(el.fill) },
                line: { type: "none" },
              };
              if (innerR > 0 && innerCp.preset !== "rect") {
                innerOpts.rectRadius = px2in(innerR);
                if (innerCp.flipH) innerOpts.flipH = true;
                if (innerCp.flipV) innerOpts.flipV = true;
              }
              slide.addShape(innerR > 0 ? innerCp.preset : "rect", innerOpts);
              if (innerR > 0 && needsFlatCornerOverlay(innerCr)) {
                emitFlatCornerOverlays(slide, { x: ix, y: iy, w: iw, h: ih }, innerCr, innerOpts.fill);
              }
              borderHandledRounded = true;
            }
          }
          if (hasNonUniformBorder && !borderHandledRounded) {
            const sides = [
              bs.top?.width > 0 && bs.top?.color ? { x: b.x, y: b.y, w: b.w, h: bs.top.width, color: bs.top.color, style: bs.top.style } : null,
              bs.bottom?.width > 0 && bs.bottom?.color ? { x: b.x, y: b.y + b.h - bs.bottom.width, w: b.w, h: bs.bottom.width, color: bs.bottom.color, style: bs.bottom.style } : null,
              bs.left?.width > 0 && bs.left?.color ? { x: b.x, y: b.y, w: bs.left.width, h: b.h, color: bs.left.color, style: bs.left.style } : null,
              bs.right?.width > 0 && bs.right?.color ? { x: b.x + b.w - bs.right.width, y: b.y, w: bs.right.width, h: b.h, color: bs.right.color, style: bs.right.style } : null,
            ].filter(Boolean) as { x: number; y: number; w: number; h: number; color: string; style?: string }[];
            for (const side of sides) {
              if (side.style === "dashed" || side.style === "dotted") {
                const isHoriz = side.w > side.h;
                // Minimum 1pt stroke for dashed/dotted — Google Slides renders
                // sub-pt dashed strokes as a single thin solid line (or drops
                // them entirely), erasing `.stat-row { border-bottom: 1px
                // dotted }`-style dividers. 1pt is barely visible but keeps
                // the dash pattern intact.
                slide.addShape("line", {
                  x: px2in(side.x), y: px2in(side.y),
                  w: isHoriz ? px2in(side.w) : 0,
                  h: isHoriz ? 0 : px2in(side.h),
                  line: {
                    color: hexToRgb(side.color),
                    width: Math.max((isHoriz ? side.h : side.w) * PX2PT, 1),
                    dashType: side.style === "dashed" ? "dash" : "sysDot",
                  },
                });
              } else {
                slide.addShape("rect", {
                  x: px2in(side.x), y: px2in(side.y), w: px2in(side.w), h: px2in(side.h),
                  fill: { color: hexToRgb(side.color) },
                  line: { type: "none" },
                });
              }
            }
          }

          // Overlay native editable text on merged text elements.
          // Preserve per-run styling (font-size, color, weight) when the merged
          // text has styled inline children — e.g. `$19<span>/mo</span>` must
          // keep /mo at its smaller size after being absorbed into a card-header.
          //
          // Two-bug fix (slide_24 — deep-nest innermost text):
          //   1. Alignment — hardcoding `align: "center"` forced every merged
          //      text to center. `.innermost` inherits `text-align: start`
          //      (left) and must stay left when absorbed into the parent rect.
          //   2. Bounds — using the rect's `b` (level-4 at 837×164) makes the
          //      text box wider than the source innermost div (769×96), so
          //      wrap points shift. Fall back to `mergedTextEl.bounds` so
          //      Chrome's wrap survives the merge; valign:"middle" still
          //      centers vertically within the rect because the DOM y/h is
          //      the flex-centered position Chrome already computed.
          if (mergedTextEl) {
            const mb = mergedTextEl.bounds || b;
            // Honour the extractor's verticallyCentered flag instead of
            // hardcoding "middle". Single-line absorbed text (chip labels,
            // card headers, flex-centered content) keeps verticallyCentered=
            // true and stays centered; multi-line absorbed text (slide_30
            // .code-block, padding:14px, multiple <br>s) gets verticallyCentered=
            // false and is emitted "top" so emitStyledText folds the CSS
            // padding-top into the textbox's tIns — first line sits at the
            // padding distance, matching Chrome's top-flowed layout.
            const mergedValign: "top" | "middle" =
              mergedTextEl.verticallyCentered === false ? "top" : "middle";
            emitStyledText(
              slide, mergedTextEl, mb,
              extraction.elements, mergedTextIndex,
              mergedValign,
              false, // merged-rect path historically didn't fold opacity into color
              { color: "#333333", fontSize: 14 },
            );
          }

          break;
        }

        case "triangle": {
          // CSS border-triangle arrow → pptxgenjs `triangle` preset (apex-up
          // by default). `rotate` selects which way the apex points:
          //   0=up, 90=right, 180=down, 270=left.
          //
          // OOXML rotation rotates the shape about the bbox center but keeps
          // the bbox axis-aligned and fixed in size. A 12×16 triangle rotated
          // 90° would render inside a 12×16 slot, clipping apex/base. For 90°
          // and 270° rotations we swap w and h around the center so the
          // post-rotation shape fits its visual extent.
          const rot = typeof el.rotate === "number" ? el.rotate : 0;
          let rx = b.x, ry = b.y, rw = b.w, rh = b.h;
          if (rot === 90 || rot === 270) {
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            rw = b.h; rh = b.w;
            rx = cx - rw / 2; ry = cy - rh / 2;
          }
          const triOpts: ShapeProps = {
            x: px2in(rx), y: px2in(ry), w: px2in(rw), h: px2in(rh),
            fill: { color: hexToRgb(el.fill || "#000000") },
            line: { type: "none" },
          };
          if (rot !== 0) triOpts.rotate = rot;
          slide.addShape("triangle", triOpts);
          break;
        }

        case "line": {
          const isVertical = b.h > b.w * 2;
          slide.addShape("line", {
            x: px2in(b.x), y: px2in(b.y),
            w: isVertical ? 0 : px2in(b.w),
            h: isVertical ? px2in(b.h) : 0,
            line: {
              color: hexToRgb(el.color || "#000000"),
              width: Math.max(0.5, isVertical ? b.w * PX2PT : b.h * PX2PT),
            },
          });
          break;
        }

        case "text": {
          // All slack/rotation/run-mapping logic lives in emitStyledText so
          // this site stays a single dispatch. Standalone-text defaults are
          // 16px / #000 (vs. the merged-into-rect path's 14px / #333 — those
          // texts are absorbed into a card and inherit a card-text vibe).
          emitStyledText(
            slide, el, b,
            extraction.elements, ei,
            el.verticallyCentered ? "middle" : "top",
            true, // standalone text honors style.opacity via pptxgenjs transparency
            { color: "#000000", fontSize: 16 },
          );
          break;
        }

        case "list": {
          // Lists come in two flavors:
          //   1. Pure-text lists → render natively with pptxgenjs bullet/number
          //      so the user sees real disc/decimal markers (Google Slides
          //      keeps them editable as a real bulleted list).
          //   2. Styled lists (any <li> has borderBottom, bg, or its own
          //      border/radius) → render item-by-item so we can paint per-row
          //      boxes, separators, and mixed backgrounds.
          // The list's container background (bg+border+radius on the <ul>/<ol>
          // itself) is emitted as a separate "rect" element upstream in walk().
          const items: readonly ListItem[] = (el.items || []).filter((it) => (it.text || "").trim().length > 0);
          if (items.length === 0) break;
          const listStyle = el.style || {};
          const ordered = !!el.ordered;
          const styled = !!el.anyStyledItem;

          if (!styled) {
            // Pure text — bulleted/numbered list in a single textbox.
            //
            // Native pptxgenjs `bullet` (→ `<a:buAutoNum>`/`<a:buChar>`) works
            // only when the paragraph is a single run. As soon as an item
            // has multiple runs, pptxgenjs writes a second <a:pPr> with
            // <a:buNone/> between runs, and Google Slides reads that and
            // drops the marker. Workaround: when ANY item has styled runs,
            // prepend the marker as a plain text run and skip `bullet`.
            const anyItemHasStyledRuns = items.some((it) =>
              (it.runs || []).length > 0 && (it.runs || []).some((r) => r.style !== null)
            );
            // Per-item ::before bullet colours (e.g. slide_30 Key Priorities,
            // where each <li.red>/<li.green>/etc gets its own coloured 8×8
            // dot). pptxgenjs' native `bullet:` paints every marker in the
            // paragraph's text colour, so per-item bullet colour cannot be
            // honoured through the native path.
            //
            // wave-12D decision: we always prefer native pptxgenjs bullets
            // (<a:buChar>) over the literal "•  " text-prefix fallback —
            // the user explicitly accepted monochrome bullets in exchange
            // for a real bulleted list (proper hanging-indent, real wrap,
            // editable list in Slides). The OLD gate `&& !anyPerItemBulletColor`
            // forced the text-prefix path on slide_11 SWOT and slide_30 Key
            // Priorities, breaking word-wrap.
            const anyPerItemBulletColor = !ordered && items.some((it) => !!it.bulletColor);
            const useNativeBullet = !anyItemHasStyledRuns;
            const paragraphs = items.map((it: ListItem, ii: number) => {
              const marker = ordered ? `${ii + 1}.  ` : "•  ";
              const markerColor = it.bulletColor || it.color || listStyle.color || "#333333";
              const rs: readonly TextRun[] | null = (it.runs && it.runs.length > 0) ? it.runs.filter((r) => r.text.length > 0) : null;
              if (rs && rs.length > 0 && rs.some((r) => r.style !== null)) {
                const out: TextProps[] = [];
                if (!useNativeBullet) {
                  // Plain marker prefix coloured per-item (falls back to the
                  // item's text colour when there is no per-item bullet).
                  out.push({
                    text: marker,
                    options: {
                      fontFace: mapFont(it.fontFamily || listStyle.fontFamily || "Arial"),
                      fontSize: (it.fontSize || listStyle.fontSize || 14) * PX2PT,
                      color: hexToRgb(markerColor),
                    },
                  });
                }
                rs.forEach((run: TextRun, ri: number) => {
                  const s: RunStyle = run.style || {};
                  const opts: TextPropsOptions = {
                    fontFace: mapFont(s.fontFamily || it.fontFamily || listStyle.fontFamily || "Arial"),
                    fontSize: (s.fontSize || it.fontSize || listStyle.fontSize || 14) * PX2PT,
                    color: hexToRgb(s.color || it.color || listStyle.color || "#333333"),
                    bold: s.fontWeight === "bold" || (!s.fontWeight && it.fontWeight === "bold"),
                    italic: s.fontStyle === "italic" || (!s.fontStyle && it.fontStyle === "italic"),
                  };
                  if (useNativeBullet && ri === 0 && out.length === 0) {
                    opts.bullet = ordered ? { type: "number", indent: 12 } : { indent: 12 };
                  }
                  if (ri === rs.length - 1) opts.breakLine = true;
                  out.push({ text: run.text, options: opts });
                });
                return out;
              }
              const baseOpts: TextPropsOptions = {
                fontFace: mapFont(it.fontFamily || listStyle.fontFamily || "Arial"),
                fontSize: (it.fontSize || listStyle.fontSize || 14) * PX2PT,
                color: hexToRgb(it.color || listStyle.color || "#333333"),
                bold: it.fontWeight === "bold",
                italic: it.fontStyle === "italic",
                breakLine: true,
              };
              if (useNativeBullet) {
                baseOpts.bullet = ordered ? { type: "number", indent: 12 } : { indent: 12 };
                return [{ text: it.text, options: baseOpts }];
              }
              // Colored marker prefix when the list carries per-item bullet
              // colours (e.g. slide_30 Key Priorities). Split into a
              // coloured marker run + the item-coloured text run so each
              // row's "●" matches its CSS ::before background while body
              // text keeps the item colour.
              if (!ordered && anyPerItemBulletColor) {
                return [
                  {
                    text: marker,
                    options: {
                      fontFace: mapFont(it.fontFamily || listStyle.fontFamily || "Arial"),
                      fontSize: (it.fontSize || listStyle.fontSize || 14) * PX2PT,
                      color: hexToRgb(markerColor),
                    },
                  },
                  { text: it.text, options: { ...baseOpts } },
                ];
              }
              return [{ text: marker + it.text, options: baseOpts }];
            }).flat();

            // Honor CSS line-height when explicitly set. Emit
            // `lineSpacingMultiple` → `<a:lnSpc><a:spcPct/></a:lnSpc>`
            // pre-divided by 1.2 (Slides' inferred font-default leading)
            // so the rendered multiplier matches the CSS ratio. List items
            // never go through extract-dom's measured-pitch override
            // (no inline-inflated boxes), so the absolute-pts path used by
            // .text-block is wrong here — wave-9 emitted absolute pts
            // unconditionally and rendered slide_11 SWOT bullets too loose
            // ("line height is wrong"). Skip the override when ratio is at
            // (or near) the 1.2 default — Slides' built-in default already
            // matches.
            const firstIt = items[0] || {};
            // CSS `li { padding: 4px 0 }` adds 8 px of inter-line spacing in the
            // browser; OOXML paragraph spacing has no padding concept, so fold
            // li padding-top + padding-bottom into paraSpaceAfter alongside
            // marginBottom (slide_11 SWOT bullets render too tight without this).
            const liPadV = ((firstIt.padding && firstIt.padding.top) || 0)
              + ((firstIt.padding && firstIt.padding.bottom) || 0);
            const paraSpaceAfterPt = ((firstIt.marginBottom || 0) + liPadV) * PX2PT;
            const liRatio = firstIt.lineHeight && firstIt.fontSize
              ? firstIt.lineHeight / firstIt.fontSize
              : 0;
            const liUseRatio = liRatio >= 1.05 && liRatio <= 3.0 && Math.abs(liRatio - 1.2) > 0.08;
            const liEmittedRatio = liRatio / 1.2;
            slide.addText(paragraphs, {
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
              valign: "top",
              align: "left",
              fill: { type: "none" },
              line: { type: "none" },
              margin: 0,
              paraSpaceAfter: paraSpaceAfterPt > 0 ? paraSpaceAfterPt : undefined,
              lineSpacingMultiple: liUseRatio ? liEmittedRatio : undefined,
            });
            break;
          }

          // Styled list — per-item rendering with optional per-row box.
          // Semantically still a list: prepend the bullet/number marker to
          // each item's text so disc/decimal markers survive the split.
          // Suppress markers only when the item is pill-like (large radius,
          // content-fit width) — in that case the visual is the pill chip,
          // not a list row.
          const rowH = b.h / items.length;
          for (let ii = 0; ii < items.length; ii++) {
            const it = items[ii];
            const text = it.text || "";
            const ib = it.bounds || { x: b.x, y: b.y + ii * rowH, w: b.w, h: rowH };

            // Per-item background / border / radius. Uniform borders ride on
            // the shape's `line`; non-uniform borders (e.g. a row with only
            // borderBottom, or a highlighted row with only borderLeft accent)
            // are painted as per-side strips so we don't draw a full outline.
            const bs: BorderSides = it.borderSides || { top: { width: 0, color: "" }, right: { width: 0, color: "" }, bottom: { width: 0, color: "" }, left: { width: 0, color: "" } };
            const sides: readonly BorderSide[] = [bs.top, bs.right, bs.bottom, bs.left];
            const uniformItemBorder = sides.every((s) =>
              s && s.width === bs.top.width && s.color === bs.top.color && s.style === bs.top.style,
            ) && (bs.top.width || 0) > 0;
            const hasItemBg = !!it.bgColor;
            const hasAnyItemBorder = sides.some((s) => s && (s.width || 0) > 0 && s.color);

            if (hasItemBg || uniformItemBorder) {
              const rectOpts: ShapeProps = {
                x: px2in(ib.x), y: px2in(ib.y), w: px2in(ib.w), h: px2in(ib.h),
                line: { type: "none" },
              };
              if (hasItemBg) {
                rectOpts.fill = { color: hexToRgb(it.bgColor) };
                if (typeof it.bgAlpha === "number" && it.bgAlpha < 1) {
                  rectOpts.fill.transparency = Math.round((1 - it.bgAlpha) * 100);
                }
              } else {
                rectOpts.fill = { type: "none" };
              }
              if (uniformItemBorder) {
                rectOpts.line = {
                  color: hexToRgb(bs.top.color),
                  width: Math.min((bs.top.width || 0) * PX2PT, 6),
                  dashType: bs.top.style === "dashed" ? "dash" : bs.top.style === "dotted" ? "dot" : "solid",
                };
              }
              const rounded = it.borderRadius && it.borderRadius > 0;
              if (rounded) rectOpts.rectRadius = px2in(it.borderRadius);
              slide.addShape(rounded ? "roundRect" : "rect", rectOpts);
            }
            if (!uniformItemBorder && hasAnyItemBorder) {
              const strips = [
                bs.top?.width > 0 && bs.top?.color ? { x: ib.x, y: ib.y, w: ib.w, h: bs.top.width, color: bs.top.color } : null,
                bs.bottom?.width > 0 && bs.bottom?.color ? { x: ib.x, y: ib.y + ib.h - bs.bottom.width, w: ib.w, h: bs.bottom.width, color: bs.bottom.color } : null,
                bs.left?.width > 0 && bs.left?.color ? { x: ib.x, y: ib.y, w: bs.left.width, h: ib.h, color: bs.left.color } : null,
                bs.right?.width > 0 && bs.right?.color ? { x: ib.x + ib.w - bs.right.width, y: ib.y, w: bs.right.width, h: ib.h, color: bs.right.color } : null,
              ].filter((s): s is { x: number; y: number; w: number; h: number; color: string } => s !== null);
              for (const s of strips) {
                slide.addShape("rect", {
                  x: px2in(s.x), y: px2in(s.y), w: px2in(s.w), h: px2in(s.h),
                  fill: { color: hexToRgb(s.color) }, line: { type: "none" },
                });
              }
            }

            // Respect <li> *horizontal* padding so text inside rounded pills
            // doesn't collide with curved edges. Vertically we use the full
            // item bounds and let `valign: "middle"` center the text —
            // subtracting top/bottom padding makes the text sit with extra
            // top-gap because padded middle ≠ full-box middle for asymmetric
            // CSS padding (slide_13: 12px top padding on features li with
            // an 8px ul padding-top).
            const ipad = it.padding || { top: 0, right: 0, bottom: 0, left: 0 };
            const isPillLike = (it.borderRadius || 0) >= Math.min(ib.w, ib.h) * 0.4 && ib.w < 400;
            const tx = ib.x + ipad.left;
            const ty = ib.y;
            const tw = Math.max(1, ib.w - ipad.left - ipad.right);
            const th = ib.h;
            const textOpts: TextPropsOptions = {
              x: px2in(tx), y: px2in(ty), w: px2in(tw), h: px2in(th),
              valign: "middle",
              align: isPillLike ? "center" : it.textAlign === "center" ? "center" : it.textAlign === "right" ? "right" : "left",
              fontSize: (it.fontSize || listStyle.fontSize || 14) * PX2PT,
              fontFace: mapFont(it.fontFamily || listStyle.fontFamily || "Arial"),
              color: hexToRgb(it.color || listStyle.color || "#333333"),
              bold: it.fontWeight === "bold",
              italic: it.fontStyle === "italic",
              fill: { type: "none" },
              line: { type: "none" },
              margin: 0,
            };

            // Marker decision is per-LIST, not per-item. See
            // /tmp/list_line_height_analysis.md — the per-item rule was
            // wrong because (a) :last-child losing its border-bottom
            // regressed into "marker added", and (b) a highlighted row with
            // `background` inside a card container wrongly flipped into a
            // marker row.
            //
            // `el.isContainerList` is true when the <ul>/<ol> has its own
            // bg/border/radius OR a majority of items use border-bottom as
            // row separator. In both cases the container is the visual,
            // rows inside never get markers.
            const showMarker = !el.isContainerList && !isPillLike;
            const marker = ordered ? `${ii + 1}.  ` : "•  ";

            if (it.runs && it.runs.length > 0 && it.runs.some((r) => r.style !== null)) {
              const textRuns: TextProps[] = [];
              if (showMarker) {
                textRuns.push({
                  text: marker,
                  options: {
                    fontFace: mapFont(it.fontFamily || listStyle.fontFamily || "Arial"),
                    fontSize: (it.fontSize || listStyle.fontSize || 14) * PX2PT,
                    color: hexToRgb(it.color || listStyle.color || "#333333"),
                  },
                });
              }
              for (const run of it.runs.filter((r) => r.text.length > 0)) {
                const rs = run.style || {};
                textRuns.push({
                  text: run.text,
                  options: {
                    fontFace: mapFont(rs.fontFamily || it.fontFamily || listStyle.fontFamily || "Arial"),
                    fontSize: (rs.fontSize || it.fontSize || listStyle.fontSize || 14) * PX2PT,
                    color: hexToRgb(rs.color || it.color || listStyle.color || "#333333"),
                    bold: rs.fontWeight === "bold" || (!rs.fontWeight && it.fontWeight === "bold"),
                    italic: rs.fontStyle === "italic" || (!rs.fontStyle && it.fontStyle === "italic"),
                  },
                });
              }
              slide.addText(textRuns, textOpts);
            } else {
              slide.addText(showMarker ? marker + text : text, textOpts);
            }

            if (it.borderBottom) {
              slide.addShape("line", {
                x: px2in(ib.x), y: px2in(ib.y + ib.h),
                w: px2in(ib.w), h: 0,
                line: { color: hexToRgb(it.borderBottom), width: 0.5 },
              });
            }
          }
          break;
        }

        case "table": {
          // DEBUG path — `<table data-shape-render="true|empty">`. Render
          // the entire table via per-cell addShape rects + per-edge filled
          // rect borders, using the layoutTable approach validated in
          // tools/table-twoway/. Bypasses native `<a:tbl>` so we can
          // isolate geometry issues from `<a:tc>` rasterisation quirks.
          if (el.renderAsShapes) {
            renderTableAsShapes(slide, el);
            break;
          }
          // Two rendering paths:
          //   1. `addTable` (native, editable in Google Slides) when every
          //      cell shares the same uniform border (or has no border) and
          //      the table has no border-radius. This keeps the output a
          //      real `<a:tbl>` that users can edit as a table.
          //   2. Per-cell rect rendering for mixed/collapsed/dashed/rounded
          //      tables where `addTable` can't express the geometry.
          const rows = el.rows || [];
          const tableCornerRadii = el.cornerRadii || { tl: 0, tr: 0, br: 0, bl: 0 };
          const tableHasRadius = (el.borderRadius || 0) > 0;
          const rowCount = rows.length;
          // CSS layers the `<table>`'s own background BEHIND every cell:
          // a transparent `<td>` shows the table bg, not the slide bg. Our
          // per-cell extraction captures `cs.bgColor` faithfully but never
          // emitted the table-level fill, so cells with no own bg rendered
          // transparent in pptx and exposed whatever sat behind the table
          // (slide_17's pink `.table-wrap` made this obvious — odd-row
          // cells leaked pink instead of showing `#fff`). Plumb the table
          // bg in as a fallback so the layered semantics survive.
          const tableBgHex: string | undefined = (el as { bgColor?: string }).bgColor || undefined;

          // Rule 3 (table case): synthMask captures the rounded-clip
          // context — either inherited from a wrapping `overflow:hidden`
          // ancestor (el.clipMask) or established by the table's own
          // border-radius. The shape-twice algorithm below consumes it
          // only inside the native-addTable branch.
          const _synthMask: ClipMask | null = el.clipMask
            ? el.clipMask
            : (tableHasRadius
                ? { bounds: b, cornerRadii: tableCornerRadii }
                : null);
          let _tableGid: string | null = null;

          // Decide path: a table is "native-eligible" when every cell can
          // describe its border with a single (width, color, style) triple.
          // CSS allows per-side borders (e.g. a left-only green accent),
          // but pptxgenjs cell borders here are one-spec-per-cell, so
          // falling out of native means the table goes into a shape-stack
          // fallback that LOSES rule 2 ("every <table> must be a native
          // <a:tbl>"). Rather than refuse for non-uniform cells, we
          // COERCE them: pick the side with the largest width as the
          // dominant border and emit a console warning. The cell visually
          // loses its per-side accent (a 3px green LEFT-only bar collapses
          // into a 3px green frame on all 4 sides), but the table stays
          // native — strict win on rule 2 vs the alternative.
          const cellUniformBorder = (
            cs: { readonly borderSides?: BorderSides } | undefined,
          ): { width: number; color: string; style: string } => {
            const bs = cs?.borderSides;
            if (!bs) return { width: 0, color: "", style: "none" };
            const sides: readonly BorderSide[] = [bs.top, bs.right, bs.bottom, bs.left];
            const widths = sides.map((s) => s?.width || 0);
            const hasAny = widths.some((w: number) => w > 0);
            if (!hasAny) return { width: 0, color: "", style: "none" };
            const same = sides.every((s) =>
              s && s.width === bs.top.width && s.color === bs.top.color && s.style === bs.top.style,
            );
            if (same) {
              return { width: bs.top.width, color: bs.top.color, style: bs.top.style ?? "solid" };
            }
            // Non-uniform: report the widest side so the corner-underlay's
            // shape-twice has a sensible single border to draw against. Per-
            // side rendering inside the table cell is handled by the 4-tuple
            // `cellBorderTuple` below (pptxgenjs supports per-side cell
            // borders via `border: [t, r, b, l]`).
            let dominantIdx = 0;
            for (let i = 1; i < 4; i++) {
              if ((sides[i]?.width || 0) > (sides[dominantIdx]?.width || 0)) dominantIdx = i;
            }
            const dom = sides[dominantIdx];
            return { width: dom.width, color: dom.color, style: dom.style ?? "solid" };
          };
          // Per-side border tuple for native pptxgenjs cells. The user's
          // slide_15 complaint ("not a table in sides") flagged that
          // coercing a 3px green LEFT-only accent into a 3px green frame
          // around the whole cell loses the per-side styling. pptxgenjs's
          // table cell `border` option accepts a `[t, r, b, l]` array of
          // `{type, pt, color}` (verified at pptxgen.es.js:5341-5358) which
          // emits `<a:lnT/lnR/lnB/lnL>` per cell — exactly what CSS encodes.
          type BorderOpt = { type: "solid" | "dash" | "sysDot" | "none"; pt: number; color: string };
          const sideToBorderOpt = (side: BorderSide | undefined): BorderOpt => {
            if (!side || !side.width || side.width <= 0) return { type: "none", pt: 0, color: "000000" };
            const dashType: BorderOpt["type"] = side.style === "dashed" ? "dash" : side.style === "dotted" ? "sysDot" : "solid";
            return { type: dashType, pt: Math.max(0.5, side.width * PX2PT), color: hexToRgb(side.color || "#000000") };
          };
          // Compute the table-level border (declared on the `<table>`
          // element itself, e.g. `table.rounded { border:1px solid #d1d5db }`).
          // CSS does NOT bubble this into per-cell `getComputedStyle()`, so
          // we read it from `el.borderSides` and graft it onto the outer-
          // edge cells' tuples so the native <a:tbl> reproduces the visible
          // outer frame.
          const tableBorderSides = (el as { borderSides?: BorderSides | null }).borderSides;
          const tableSideOpt = (key: "top" | "right" | "bottom" | "left"): BorderOpt =>
            sideToBorderOpt(tableBorderSides ? tableBorderSides[key] : undefined);
          // True when a rounded post-table outline ring will be drawn on top
          // of the native <a:tbl> (see ~L2557). When it WILL draw, folding
          // `tableSideOpt` into native edge cells double-inks the perimeter:
          // the outline's `algn="in"` 1 px stroke sits at the rect's inner
          // edge, but native cell borders use `algn="ctr"` and straddle the
          // cell edge — the two paint at DIFFERENT pixels and combine to a
          // ~1.5 px gray bar (slide_17 L1 "double border on right side").
          // Suppress the fold in that case; the outline alone carries the
          // perimeter. Flat tables (no outline) keep the fold so they still
          // have an outer frame.
          const willDrawTableOutline = tableHasRadius
            && !!tableBorderSides
            && (tableBorderSides.top?.width || 0) > 0
            && !!tableBorderSides.top?.color;
          const cellBorderTuple = (
            cs: { readonly borderSides?: BorderSides } | undefined,
            ri: number,
            ci: number,
            colCount: number,
            rowCnt: number,
          ): [BorderOpt, BorderOpt, BorderOpt, BorderOpt] => {
            const bs = cs?.borderSides;
            const t = sideToBorderOpt(bs?.top);
            const r = sideToBorderOpt(bs?.right);
            const bm = sideToBorderOpt(bs?.bottom);
            const l = sideToBorderOpt(bs?.left);
            // Fold table-level border onto outer-edge cells whose own side
            // has no width. (Does not override an explicit per-cell border.)
            const out: [BorderOpt, BorderOpt, BorderOpt, BorderOpt] = [t, r, bm, l];
            if (!willDrawTableOutline) {
              if (ri === 0 && out[0].type === "none") out[0] = tableSideOpt("top");
              if (ri === rowCnt - 1 && out[2].type === "none") out[2] = tableSideOpt("bottom");
              if (ci === 0 && out[3].type === "none") out[3] = tableSideOpt("left");
              if (ci === colCount - 1 && out[1].type === "none") out[1] = tableSideOpt("right");
            }
            return out;
          };
          // Rule 2: every HTML table emits as a native pptx <a:tbl>. With
          // cellUniformBorder now coercing non-uniform borders to their
          // dominant side (see helper above), ALL cells return a valid
          // (width, color, style) triple — so `allCellsUniform` is always
          // true, and the native path always fires. The per-cell shape
          // fallback below is dead code for rule-2 compliance and remains
          // only as a defensive backstop.
          let allCellsUniform = true;
          let tableBorder: { width: number; color: string; style: string } | null = null;
          for (const row of rows) for (const cell of row) {
            const ub = cellUniformBorder(cell.style || {});
            if (!tableBorder && ub.width > 0) tableBorder = ub;
            else if (tableBorder && ub.width > 0 &&
              (tableBorder.width !== ub.width || tableBorder.color !== ub.color || tableBorder.style !== ub.style)) {
              // Mixed border widths across cells (different borders per
              // header/body row) — still native-eligible, pptxgenjs accepts
              // per-cell border specs via the `border` option.
              tableBorder = null;
              break;
            }
          }

          if (allCellsUniform && rows.length > 0) {
            // Rule 3 (table case — "shape twice" per corner cell).
            //
            // The whole-table underlay patch the v1 code emitted couldn't
            // satisfy all four corners: a single dominant fill bleeds
            // through transparent body rows when the header is coloured,
            // and the patch's CSS bounds don't match the native <a:tbl>'s
            // rendered height so it overshoots vertically. The user's
            // prescription: for each clipped corner cell, render TWO
            // stacked rounded shapes underneath the table (bottom = cell
            // border colour, top = cell fill, inset by the border width)
            // and mark the cell itself transparent in the native <a:tbl>.
            // Centre / non-corner cells stay normal.
            //
            // The 4 corner cells are identified positionally: first row
            // first/last cell for the top corners, last row first/last
            // cell for the bottom corners. colspan/rowspan edge cases
            // are deferred to a follow-up — every fixture we test has
            // rectangular row/col layout.
            type CornerKind = "tl" | "tr" | "br" | "bl";
            interface CornerSpec {
              kind: CornerKind;
              rowIdx: number;
              cellIdx: number;
              cell: TableCell;
            }
            const transparentCellKeys = new Set<string>();
            const cornerSpecs: CornerSpec[] = [];
            if (_synthMask) {
              const cr = _synthMask.cornerRadii;
              const lastRow = rows[rowCount - 1];
              const r0last = (rows[0].length || 0) - 1;
              const rLlast = (lastRow.length || 0) - 1;
              if (cr.tl > 0 && rows[0][0])           cornerSpecs.push({ kind: "tl", rowIdx: 0,           cellIdx: 0,     cell: rows[0][0] });
              if (cr.tr > 0 && rows[0][r0last])      cornerSpecs.push({ kind: "tr", rowIdx: 0,           cellIdx: r0last, cell: rows[0][r0last] });
              if (cr.br > 0 && lastRow[rLlast])      cornerSpecs.push({ kind: "br", rowIdx: rowCount-1,  cellIdx: rLlast, cell: lastRow[rLlast] });
              if (cr.bl > 0 && lastRow[0])           cornerSpecs.push({ kind: "bl", rowIdx: rowCount-1,  cellIdx: 0,     cell: lastRow[0] });
              if (cornerSpecs.length > 0) {
                _tableGid = nextGroupId();
                for (const c of cornerSpecs) {
                  transparentCellKeys.add(`${c.rowIdx}:${c.cellIdx}`);
                }
              }
            }

            // Quantize all rounded-table geometry to 1/100" so the
            // underlay rect, the per-corner shape-twice rects, the native
            // <a:tbl> graphicFrame and the outline stroke all land on the
            // SAME source-inch lattice. Without quantization each shape's
            // edges sit at arbitrary fractional inches (the px → inch
            // conversion is `* 10/1280 = * 0.0078125` per CSS pixel), and
            // Slides rasterises shapes vs <a:graphicFrame> cells onto
            // display pixels independently → 1-2 display-px seams at every
            // corner/cell boundary (the entire "missing white border"
            // family of complaints). Snapping all coords to 0.01"
            // eliminates the per-shape fractional offset.
            const q = (v: number): number => Math.round(v * 100) / 100;
            // Content extent = table bounds minus the outer border (the
            // per-`<td>` bounds exclude the table's CSS border). The native
            // cells and the corner masks must span EXACTLY this, edge to
            // edge — the underlay is painted at this same extent, so any
            // shortfall exposes it as a white strip at the right/bottom.
            const twL0 = px2in(tableBorderSides?.left?.width || 0);
            const twR0 = px2in(tableBorderSides?.right?.width || 0);
            const twT0 = px2in(tableBorderSides?.top?.width || 0);
            const twB0 = px2in(tableBorderSides?.bottom?.width || 0);
            const contentW = px2in(b.w) - twL0 - twR0;
            const contentH = px2in(b.h) - twT0 - twB0;
            // Column geometry — DRIFT-FREE and edge-anchored. Per-`<td>`
            // bounds sum to ~1 px less than `contentW` (extraction floors
            // each width), so scale the raw widths to fill `contentW`
            // exactly, accumulate, and quantize each cumulative gridline to
            // the 0.01" lattice; per-column widths are the differences.
            // Quantizing each width independently then summing (the old
            // approach) drifts short of the edge — that left the white
            // underlay exposed as a strip at the TR/BR corners. Scaling +
            // cumulative-then-difference makes the columns span exactly
            // [0, contentW] with every gridline on the lattice.
            const firstRow = rows[0];
            const colCnt = firstRow.length;
            const colWraw = firstRow.map((c: TableCell) => px2in(c.bounds?.w || b.w / firstRow.length));
            const colRawTotal = colWraw.reduce((a, w) => a + w, 0);
            const colScale = colRawTotal > 0 ? contentW / colRawTotal : 1;
            const colXPrefix: number[] = [0];
            { let acc = 0; for (const w of colWraw) { acc += w * colScale; colXPrefix.push(q(acc)); } }
            const colW = colWraw.map((_, i) => q(colXPrefix[i + 1] - colXPrefix[i]));
            const cornerKindByKey = new Map<string, CornerKind>();
            for (const c of cornerSpecs) cornerKindByKey.set(`${c.rowIdx}:${c.cellIdx}`, c.kind);
            const tableRows = rows.map((row: readonly TableCell[], ri: number) => row.map((cell: TableCell, ci: number) => {
              const cs = cell.style || {};
              const transparent = transparentCellKeys.has(`${ri}:${ci}`);
              // Per-side border tuple. For corner cells the OUTER-facing
              // sides (e.g. top + left for TL) are owned by the shape-
              // twice underlay; the INNER-facing sides keep the cell's
              // CSS-resolved border so the table's inter-cell grid (the
              // #fff lines in `.colored`, the #e5e7eb under-header line
              // in `.rounded`) still draws across the corner cell.
              let border: [BorderOpt, BorderOpt, BorderOpt, BorderOpt];
              if (transparent) {
                const cornerKind = cornerKindByKey.get(`${ri}:${ci}`)!;
                const full = cellBorderTuple(cs, ri, ci, colCnt, rowCount);
                const none: BorderOpt = { type: "none", pt: 0, color: "000000" };
                const zeroTop    = cornerKind === "tl" || cornerKind === "tr";
                const zeroRight  = cornerKind === "tr" || cornerKind === "br";
                const zeroBottom = cornerKind === "bl" || cornerKind === "br";
                const zeroLeft   = cornerKind === "tl" || cornerKind === "bl";
                border = [
                  zeroTop    ? none : full[0],
                  zeroRight  ? none : full[1],
                  zeroBottom ? none : full[2],
                  zeroLeft   ? none : full[3],
                ];
              } else {
                border = cellBorderTuple(cs, ri, ci, colCnt, rowCount);
              }
              const cellOpts: TextPropsOptions = {
                align: cs.textAlign === "center" ? "center" : cs.textAlign === "right" ? "right" : "left",
                valign: "middle",
                fontFace: mapFont(cs.fontFamily || "Arial"),
                fontSize: (cs.fontSize || 14) * PX2PT,
                color: hexToRgb(cs.color || "#111111"),
                bold: cs.fontWeight === "bold" || cell.isHeader,
                italic: cs.fontStyle === "italic",
                border: border as unknown as TextPropsOptions["border"],
              };
              const effectiveBg = cs.bgColor || tableBgHex;
              if (!transparent && effectiveBg) cellOpts.fill = { color: hexToRgb(effectiveBg) };
              if (cell.colspan && cell.colspan > 1) cellOpts.colspan = cell.colspan;
              if (cell.rowspan && cell.rowspan > 1) cellOpts.rowspan = cell.rowspan;
              // Cell padding → pptxgenjs cell margin (inches). pptxgenjs
              // defaults to `[0.05, 0.1, 0.05, 0.1]` which is much narrower
              // than typical CSS table padding (e.g. `14px 20px` in
              // complex_slide_05). Without this, the left column reads as
              // missing left padding compared to the Chrome baseline.
              //
              // Wide left-aligned col-0 cells get an extra leading-bump:
              // feature-comparison tables in Chrome ride inside a
              // `box-shadow`-haloed wrapper (e.g. `.table-wrap`), which
              // pptx can't replicate, so the cell-edge sits flush against
              // slide-bg with no transition. Visually this reads as "text
              // hugs the border" even when CSS padding is honoured.
              // Floor col-0's marL to ~0.5″ on wide cells to recover the
              // perceived breathing room.
              if (cell.padding) {
                const p = cell.padding;
                let leftPx = p.left;
                const cellWidthPx = cell.bounds?.w || 0;
                const isLeftAligned = cs.textAlign !== "center" && cs.textAlign !== "right";
                if (ci === 0 && isLeftAligned && cellWidthPx > 200) {
                  leftPx = Math.max(leftPx, 48);
                }
                cellOpts.margin = [px2in(p.top), px2in(p.right), px2in(p.bottom), px2in(leftPx)];
              }
              // Styled runs (e.g. `<span class="feature-desc">` rendered
              // as a smaller grey secondary line below the main cell text)
              // can't survive the plain-string `cell.text` path: pptxgenjs
              // would render them concatenated at the parent style. Build
              // a pptxgenjs `TableCell[]` array with per-paragraph styling
              // when runs contain a `\n` separator or any per-run style.
              const runs = cell.runs || [];
              const hasNewline = runs.some((r) => r.text === "\n");
              const hasStyledRun = runs.some((r) => r.style != null);
              if (runs.length > 0 && (hasNewline || hasStyledRun)) {
                interface RunOpts {
                  fontFace: string;
                  fontSize: number;
                  color: string;
                  bold: boolean;
                  italic: boolean;
                  breakLine?: boolean;
                }
                const entries: Array<{ text: string; options: RunOpts }> = [];
                for (const r of runs) {
                  if (r.text === "\n") {
                    if (entries.length > 0) entries[entries.length - 1].options.breakLine = true;
                    continue;
                  }
                  if (!r.text) continue;
                  const rs = r.style || {};
                  entries.push({
                    text: r.text,
                    options: {
                      fontFace: mapFont(rs.fontFamily || cs.fontFamily || "Arial"),
                      fontSize: (rs.fontSize || cs.fontSize || 14) * PX2PT,
                      color: hexToRgb(rs.color || cs.color || "#111111"),
                      bold: rs.fontWeight === "bold" || (!rs.fontWeight && (cs.fontWeight === "bold" || !!cell.isHeader)),
                      italic: rs.fontStyle === "italic" || (!rs.fontStyle && cs.fontStyle === "italic"),
                    },
                  });
                }
                if (entries.length > 0) {
                  return { text: entries as unknown as string, options: cellOpts };
                }
              }
              return { text: cell.text || "", options: cellOpts };
            }));
            // Compute the row heights (in inches) early so corner-shape
            // positions can be derived from the native <a:tbl> layout, not
            // from DOM cell bounds. The DOM cell rects are inset by the
            // table's outer border (border-top/left/right/bottom of
            // `<table>`), but the native pptx table's rows start exactly at
            // its xfrm `b.y` (no implicit border padding), and columns at
            // `b.x`. Positioning corner shapes from `cb.x/y` therefore
            // mis-renders the corners by ~1 px (border-width) in each
            // direction: top corners sit 1 px below row 0, bottom corners
            // overhang the table by 1 px (the "phantom 5th row" the user
            // flagged on slide_17 and complex_slide_05).
            // Row geometry — DRIFT-FREE, same cumulative-quantize model as
            // the columns above (so the bottom corners reach the table's
            // bottom edge with no exposed underlay strip). Prefix sums give
            // the native cell origin for any (ri, ci):
            //   x = px2in(b.x) + colXPrefix[ci]   width  = colW[ci]
            //   y = px2in(b.y) + rowYPrefix[ri]   height = rowH[ri]
            const rowHraw = rows.map((row) => row[0]?.bounds ? px2in(row[0].bounds.h) : px2in(b.h / Math.max(1, rowCount)));
            const rowRawTotal = rowHraw.reduce((a, h) => a + h, 0);
            const rowScale = rowRawTotal > 0 ? contentH / rowRawTotal : 1;
            const rowYPrefix: number[] = [0];
            { let acc = 0; for (const h of rowHraw) { acc += h * rowScale; rowYPrefix.push(q(acc)); } }
            const rowH = rowHraw.map((_, i) => q(rowYPrefix[i + 1] - rowYPrefix[i]));

            // Emit per-corner shape-twice underlays BEFORE the addTable
            // call so they paint behind it (the addShape z-order is the
            // call order; native <a:tbl> renders last when added later).
            //
            // Pair-merge: when TL+TR (or BL+BR) share the same effective
            // bg and ring (width + colour), emit ONE round2SameRect shape
            // spanning the FULL table width instead of two round1Rects.
            // This is the user's explicit prescription ("If the bottom
            // corner cells have the same background border, make sure
            // they are a single shape. The same is valid for top cells.")
            // and structurally eliminates any inter-corner seam between
            // the two merged shapes' inner rects.
            if (_tableGid && cornerSpecs.length > 0) {
              let memberIdx = 0;
              // Pick the border colour the corner ring should display.
              // Per-corner, look at the cell's two OUTER-facing sides
              // (TL → top+left, TR → top+right, etc.) AND the table's
              // outer borderSides on those same keys. Take the wider
              // side's {width, color}. If both sides are 0, return 0
              // (no ring) so the else-branch paints a single fill rect.
              // The outer ring on a clipped rounded corner = the border that
              // survives the clip: the WIDER of the corner cell's own
              // outer-facing border and the table's outer border on that
              // side. For `.colored` (every cell has `border:1px #fff`, the
              // table itself has none) this is the cell's 1px white border —
              // which Chrome shows curving around each corner. Dropping it
              // (the prior "table-border-only" attempt) is what left all
              // four corner cells with NO outer border. For `.rounded`
              // (table `border:1px #d1d5db`) the table border wins. Both 0
              // ⇒ ring 0 ⇒ the corner is a single cell-coloured rounded fill
              // (correct for `.colored-nb` / `.rounded-nb`, which have no
              // cell borders).
              const pickRingBorder = (
                cs: { readonly borderSides?: BorderSides } | undefined,
                kind: CornerKind,
              ): { width: number; color: string } => {
                const bsCell = cs?.borderSides;
                const tBS = tableBorderSides || undefined;
                const sidePick = (
                  cellSide: BorderSide | undefined,
                  tblSide: BorderSide | undefined,
                ): { w: number; c: string } => {
                  const cw = cellSide?.width || 0;
                  const tw = tblSide?.width || 0;
                  if (tw === 0 && cw === 0) return { w: 0, c: "" };
                  if (tw >= cw) return { w: tw, c: tblSide?.color || "#000000" };
                  return { w: cw, c: cellSide?.color || "#000000" };
                };
                let s1: { w: number; c: string };
                let s2: { w: number; c: string };
                switch (kind) {
                  case "tl": s1 = sidePick(bsCell?.top,    tBS?.top);    s2 = sidePick(bsCell?.left,  tBS?.left);  break;
                  case "tr": s1 = sidePick(bsCell?.top,    tBS?.top);    s2 = sidePick(bsCell?.right, tBS?.right); break;
                  case "bl": s1 = sidePick(bsCell?.bottom, tBS?.bottom); s2 = sidePick(bsCell?.left,  tBS?.left);  break;
                  case "br": s1 = sidePick(bsCell?.bottom, tBS?.bottom); s2 = sidePick(bsCell?.right, tBS?.right); break;
                }
                if (s1.w === 0 && s2.w === 0) return { width: 0, color: "" };
                const max = s1.w >= s2.w ? s1 : s2;
                return { width: max.w, color: max.c };
              };
              // Table-border width (inches) per side. For tables with a
              // CSS outer border (e.g. `.rounded { border:1px solid #d1d5db }`)
              // the per-`<td>` bounds we use to build `colW`/`rowH` are
              // INSET by `tw` on each side, so `sum(colW) = b.w - twLeft -
              // twRight`. The native <a:tbl> graphicFrame is shifted
              // inward by `twLeft/twTop` below to align cells with the
              // CSS content area, and the corner shapes' outer-side
              // extensions push out by `tw` to reach the CSS outer
              // perimeter where the post-table outline stroke lives.
              const outerExtIn = (side: "top" | "right" | "bottom" | "left"): number =>
                px2in(tableBorderSides?.[side]?.width || 0);
              const twLeft   = outerExtIn("left");
              const twRight  = outerExtIn("right");
              const twTop    = outerExtIn("top");
              const twBottom = outerExtIn("bottom");
              // Inner overlap: outward extension on the corner shape's
              // inner-facing sides. Small non-zero value covers the
              // sub-pixel AA seam where the corner shape abuts the
              // adjacent native cell (without it, the underlay leaks
              // through as a hairline — the "white line below Week/Q4"
              // defect on `.colored-nb`'s TL/TR corners). 2 px is well
              // below the 6 px that previously regressed `.rounded`'s
              // E5E7EB row-divider — at 2 px the native cell's lnT/lnB
              // still paints fully on top of the corner shape's tail.
              const innerOverlap = px2in(2);
              // Outer-bottom overshoot: a legacy nudge added back when the
              // row geometry drifted short and the corner shape's bottom
              // fell ABOVE where the native middle cells painted, leaving a
              // gap. Now that row edges are drift-free + edge-anchored to
              // the exact content height, the corner bottom already lands on
              // `tableBottom`; the old 3 px overshoot instead makes BL/BR
              // poke out BELOW the table (user: "bottom side is sticking
              // out / too low"). Zero it so the corner bottom aligns exactly
              // with the table's bottom edge.
              const outerOvershootBottom = px2in(0);

              // Full-table BG underlay — paints (b.x, b.y, b.w, b.h) in
              // the table's own outer-border colour (or the table bg
              // colour when there's no outer border) BEFORE any corner /
              // band shape, the native <a:tbl>, or the post-table outline
              // stroke is drawn. Sits at the BOTTOM of this table's
              // z-order. With the wrapper (slide_17's `.table-wrap`)
              // painted PINK behind the table, every sub-pixel seam
              // between the merged band, native cells, the outline
              // stroke, and the rounded-corner curves used to leak pink
              // (L1: faint 2 px parallel sliver inside the right edge;
              // L3: pink hairline at the bottom of the blue header).
              // Painting the underlay in the same colour the merged
              // band's outer ring AND the outline stroke use means any
              // residual leak shows the table's own border colour, not
              // the wrapper — exactly what the user prescribed: "all
              // borders should be coloured in the actual table as
              // border". For the no-outer-border companions
              // (`.rounded-nb`, `.colored-nb`) the underlay falls back
              // to the table's bg colour, so the perimeter strip reads
              // as table background (white) instead of wrapper pink.
              {
                const underlayCp = cornerPresetFromRadii(tableCornerRadii);
                const tblTopBorder = tableBorderSides?.top;
                const underlayHex =
                  (tblTopBorder && tblTopBorder.width > 0 && tblTopBorder.color)
                    ? hexToRgb(tblTopBorder.color)
                    : (tableBgHex ? hexToRgb(tableBgHex) : "ffffff");
                const underlayOpts: ShapeProps = {
                  x: q(px2in(b.x)), y: q(px2in(b.y)), w: q(px2in(b.w)), h: q(px2in(b.h)),
                  fill: { color: underlayHex },
                  line: { type: "none" },
                  objectName: memberName(_tableGid!, memberIdx++),
                };
                if (underlayCp.preset !== "rect") {
                  underlayOpts.rectRadius = q(px2in(el.borderRadius));
                  if (underlayCp.flipH) underlayOpts.flipH = true;
                  if (underlayCp.flipV) underlayOpts.flipV = true;
                }
                slide.addShape(
                  underlayCp.preset as Parameters<Slide["addShape"]>[0],
                  underlayOpts,
                );
              }

              // Build per-corner records once for both merge-eligibility
              // and individual emission.
              interface CornerInfo {
                kind: CornerKind;
                rowIdx: number;
                cellIdx: number;
                cell: TableCell;
                bgHex: string;                          // resolved fill (hex, no '#')
                ring: { width: number; color: string }; // ring.color may be ''
                cornerR: number;
              }
              const infoByKind: Partial<Record<CornerKind, CornerInfo>> = {};
              for (const corner of cornerSpecs) {
                if (!corner.cell.bounds) continue;
                const cs = corner.cell.style || {};
                const bgSrc = cs.bgColor || tableBgHex;
                infoByKind[corner.kind] = {
                  kind: corner.kind,
                  rowIdx: corner.rowIdx,
                  cellIdx: corner.cellIdx,
                  cell: corner.cell,
                  bgHex: bgSrc ? hexToRgb(bgSrc) : "ffffff",
                  ring: pickRingBorder(cs as { borderSides?: BorderSides } | undefined, corner.kind),
                  cornerR: _synthMask!.cornerRadii[corner.kind],
                };
              }

              const ringsEqual = (
                a: { width: number; color: string },
                bv: { width: number; color: string },
              ): boolean =>
                a.width === bv.width && (a.width === 0 || a.color === bv.color);

              const canMergePair = (
                a: CornerInfo | undefined,
                bv: CornerInfo | undefined,
              ): boolean =>
                !!a && !!bv && a.bgHex === bv.bgHex
                  && ringsEqual(a.ring, bv.ring)
                  && a.cornerR === bv.cornerR;

              // Emit a single-corner sandwich (the per-cell shape-twice
              // overlay for one isolated corner).
              const emitSingleCorner = (info: CornerInfo): void => {
                const cellCR: CornerRadii = {
                  tl: info.kind === "tl" ? info.cornerR : 0,
                  tr: info.kind === "tr" ? info.cornerR : 0,
                  br: info.kind === "br" ? info.cornerR : 0,
                  bl: info.kind === "bl" ? info.cornerR : 0,
                };
                const bw = info.ring.width;
                const bwIn = px2in(bw);
                const cpOuter = cornerPresetFromRadii(cellCR);
                // Base on q(px2in(b.x/y)) — the SAME quantized origin the
                // underlay and native <a:tbl> use — so the mask, the native
                // cells, and the underlay share identical edge coordinates.
                const cellX = q(px2in(b.x)) + twLeft + colXPrefix[info.cellIdx];
                const cellY = q(px2in(b.y)) + twTop  + rowYPrefix[info.rowIdx];
                const cellW = colW[info.cellIdx];
                const cellH = rowH[info.rowIdx];
                const isOuterTop    = info.kind === "tl" || info.kind === "tr";
                const isOuterRight  = info.kind === "tr" || info.kind === "br";
                const isOuterBottom = info.kind === "bl" || info.kind === "br";
                const isOuterLeft   = info.kind === "tl" || info.kind === "bl";
                const extTop    = isOuterTop    ? twTop    : 0;
                const extRight  = isOuterRight  ? twRight  : 0;
                const extBottom = isOuterBottom ? twBottom : 0;
                const extLeft   = isOuterLeft   ? twLeft   : 0;
                // When there's no CSS outer border on the bottom side
                // (`.colored-nb`, `.rounded-nb`, `.colored`), the corner
                // shape's bottom edge would sit exactly at `tableBottomIn`.
                // Slides' native middle cells autogrow 1–2 px past that,
                // leaving a visible white/pink sliver below the corner
                // cells. Push the corner-shape bottom `outerOvershootBottom`
                // px past `tableBottomIn` so it lines up with where the
                // middle cells actually paint. User explicitly sanctioned:
                // "it's possible to go lower than needed".
                const oversBottomExt =
                  (isOuterBottom && twBottom === 0) ? outerOvershootBottom : 0;
                if (bw > 0 && cellW > bwIn && cellH > bwIn) {
                  const borderHex = hexToRgb(info.ring.color || "#000000");
                  const outerOverLeft   = isOuterLeft   ? extLeft   : innerOverlap;
                  const outerOverRight  = isOuterRight  ? extRight  : innerOverlap;
                  const outerOverTop    = isOuterTop    ? extTop    : innerOverlap;
                  const outerOverBottom = isOuterBottom ? (extBottom + oversBottomExt) : innerOverlap;
                  slide.addShape(cpOuter.preset as Parameters<Slide["addShape"]>[0], {
                    x: q(cellX - outerOverLeft),
                    y: q(cellY - outerOverTop),
                    w: q(cellW + outerOverLeft + outerOverRight),
                    h: q(cellH + outerOverTop  + outerOverBottom),
                    fill: { color: borderHex },
                    line: { type: "none" },
                    flipH: cpOuter.flipH, flipV: cpOuter.flipV,
                    rectRadius: q(px2in(info.cornerR)),
                    objectName: memberName(_tableGid!, memberIdx++),
                  });
                  const innerCR: CornerRadii = {
                    tl: Math.max(0, cellCR.tl - bw),
                    tr: Math.max(0, cellCR.tr - bw),
                    br: Math.max(0, cellCR.br - bw),
                    bl: Math.max(0, cellCR.bl - bw),
                  };
                  const cpInner = cornerPresetFromRadii(innerCR);
                  const innerInsetLeft   = isOuterLeft   ? bwIn : 0;
                  const innerInsetRight  = isOuterRight  ? bwIn : 0;
                  const innerInsetTop    = isOuterTop    ? bwIn : 0;
                  const innerInsetBottom = isOuterBottom ? bwIn : 0;
                  const innerOverLeft   = isOuterLeft   ? 0 : innerOverlap;
                  const innerOverRight  = isOuterRight  ? 0 : innerOverlap;
                  const innerOverTop    = isOuterTop    ? 0 : innerOverlap;
                  const innerOverBottom = isOuterBottom ? oversBottomExt : innerOverlap;
                  slide.addShape(cpInner.preset as Parameters<Slide["addShape"]>[0], {
                    x: q(cellX + innerInsetLeft - innerOverLeft),
                    y: q(cellY + innerInsetTop  - innerOverTop),
                    w: q(cellW - innerInsetLeft - innerInsetRight + innerOverLeft + innerOverRight),
                    h: q(cellH - innerInsetTop  - innerInsetBottom + innerOverTop  + innerOverBottom),
                    fill: { color: info.bgHex },
                    line: { type: "none" },
                    flipH: cpInner.flipH, flipV: cpInner.flipV,
                    rectRadius: q(Math.max(0, px2in(info.cornerR - bw))),
                    objectName: memberName(_tableGid!, memberIdx++),
                  });
                } else {
                  const innerOverLeft   = isOuterLeft   ? 0 : innerOverlap;
                  const innerOverRight  = isOuterRight  ? 0 : innerOverlap;
                  const innerOverTop    = isOuterTop    ? 0 : innerOverlap;
                  const innerOverBottom = isOuterBottom ? oversBottomExt : innerOverlap;
                  slide.addShape(cpOuter.preset as Parameters<Slide["addShape"]>[0], {
                    x: q(cellX - extLeft - innerOverLeft),
                    y: q(cellY - extTop  - innerOverTop),
                    w: q(cellW + extLeft + extRight + innerOverLeft + innerOverRight),
                    h: q(cellH + extTop  + extBottom + innerOverTop  + innerOverBottom),
                    fill: { color: info.bgHex },
                    line: { type: "none" },
                    flipH: cpOuter.flipH, flipV: cpOuter.flipV,
                    rectRadius: q(px2in(info.cornerR)),
                    objectName: memberName(_tableGid!, memberIdx++),
                  });
                }
              };

              // Emit a merged top or bottom band shape (spans full table
              // width = px2in(b.w)). The outer rect carries the ring
              // colour (or the bg when ring.width === 0); the inner rect
              // (when ring.width > 0) carries the bg and is inset by
              // `bwIn` on its three outer-facing sides.
              const emitMergedBand = (
                band: "top" | "bottom",
                left: CornerInfo,
              ): void => {
                const cornerR = left.cornerR;
                const bw = left.ring.width;
                const bwIn = px2in(bw);
                const isTop = band === "top";
                const rowIdx = isTop ? 0 : rowCount - 1;
                const cellH = rowH[rowIdx];
                const bandCR: CornerRadii = isTop
                  ? { tl: cornerR, tr: cornerR, br: 0, bl: 0 }
                  : { tl: 0, tr: 0, br: cornerR, bl: cornerR };
                const cpOuter = cornerPresetFromRadii(bandCR);
                const outerX = q(px2in(b.x));
                const outerW = q(px2in(b.w));
                const outerY = q(isTop
                  ? px2in(b.y)
                  : (px2in(b.y) + twTop + rowYPrefix[rowIdx] - innerOverlap));
                const extOuterV = isTop ? twTop : twBottom;
                const outerH = q(cellH + extOuterV + innerOverlap);
                const outerFillHex = (bw > 0 && left.ring.color)
                  ? hexToRgb(left.ring.color)
                  : left.bgHex;
                slide.addShape(cpOuter.preset as Parameters<Slide["addShape"]>[0], {
                  x: outerX, y: outerY, w: outerW, h: outerH,
                  fill: { color: outerFillHex },
                  line: { type: "none" },
                  flipH: cpOuter.flipH, flipV: cpOuter.flipV,
                  rectRadius: q(px2in(cornerR)),
                  objectName: memberName(_tableGid!, memberIdx++),
                });
                if (bw > 0 && cellH > bwIn && outerW > 2 * bwIn) {
                  const innerCR: CornerRadii = isTop
                    ? { tl: Math.max(0, cornerR - bw), tr: Math.max(0, cornerR - bw), br: 0, bl: 0 }
                    : { tl: 0, tr: 0, br: Math.max(0, cornerR - bw), bl: Math.max(0, cornerR - bw) };
                  const cpInner = cornerPresetFromRadii(innerCR);
                  // Inset bwIn on the three outer-facing sides
                  // (top: left+right+top; bottom: left+right+bottom).
                  // The inner-facing side keeps the outer rect's
                  // innerOverlap extension into the adjacent row.
                  const innerX = q(outerX + bwIn);
                  const innerW = q(outerW - 2 * bwIn);
                  const innerY = q(isTop ? (outerY + bwIn) : outerY);
                  const innerH = q(outerH - bwIn);
                  slide.addShape(cpInner.preset as Parameters<Slide["addShape"]>[0], {
                    x: innerX, y: innerY, w: innerW, h: innerH,
                    fill: { color: left.bgHex },
                    line: { type: "none" },
                    flipH: cpInner.flipH, flipV: cpInner.flipV,
                    rectRadius: q(Math.max(0, px2in(cornerR - bw))),
                    objectName: memberName(_tableGid!, memberIdx++),
                  });
                }
              };

              const tlInfo = infoByKind.tl;
              const trInfo = infoByKind.tr;
              const blInfo = infoByKind.bl;
              const brInfo = infoByKind.br;
              // Always emit per-corner shapes (round1Rect). The merged
              // band path uses round2SameRect, whose OOXML preset
              // declares adj1/adj2 — pptxgenjs writes a single `name="adj"`
              // guide which Slides interprets against `max(W,H)` instead
              // of `min(W,H)`, producing a wildly over-sized radius that
              // cuts arcs into the band's BOTTOM corners (the TL/TR
              // "white seam below Week/Q4" defect). round1Rect's preset
              // declares `adj` (no suffix) and renders correctly.
              // canMergePair / emitMergedBand are kept defined for now in
              // case a future fix swaps the OOXML preset for the merged
              // band, but are intentionally unused.
              void canMergePair; void emitMergedBand;
              if (tlInfo) emitSingleCorner(tlInfo);
              if (trInfo) emitSingleCorner(trInfo);
              if (blInfo) emitSingleCorner(blInfo);
              if (brInfo) emitSingleCorner(brInfo);
            }
            // (rowH computed earlier so corner shapes can prefix-sum it.)
            // Pin each row's height to its CSS height so Google Slides
            // doesn't re-flow rows under the per-cell border tuples or
            // shape-twice corner underlays — without an explicit `rowH`,
            // pptxgenjs writes `<a:tr h="0">` and Slides auto-sizes,
            // making the corner underlays float below the rendered table
            // and producing a phantom blank row (slide_17, slide_05).
            // Pin the graphicFrame's `<a:ext cy>` to sum(rowH). Without
            // `h`, pptxgenjs falls back to a hard-coded 1 inch
            // (pptxgen.es.js:5187 `cy || EMU`), and Google Slides
            // compresses the rows to fit — leaving the shape-twice
            // bottom-corner underlays floating below the rendered table
            // (the "phantom row" bug, slide_17 / slide_05).
            const tableH = rowH.reduce((a, b) => a + b, 0);
            // Shift the native <a:tbl> graphicFrame inward by the CSS
            // outer table border width. Per-`<td>` bounds (the basis for
            // `colW` / `rowH`) are INSET by `tw` on each side, so
            // `sum(colW) = px2in(b.w) - twLeft - twRight`. Placing the
            // graphicFrame at `(b.x, b.y, b.w, tableH)` leaves a
            // `tw`-wide unpainted gap on the right + bottom of the table
            // area — which `.table-wrap`'s pink shows through, reading
            // as the "double border on right" and the "bottom border
            // too high" the user reported on slide_17. Shifting the
            // frame to `(b.x + twLeft, b.y + twTop, sumColW, sumRowH)`
            // makes native cells fill the CSS content area exactly, so
            // the post-table outline stroke (algn="in", 1 px) abuts the
            // cell edges with zero gap.
            const tableTw = (el as { borderSides?: BorderSides | null }).borderSides;
            const tblTwLeft   = q(px2in(tableTw?.left?.width   || 0));
            const tblTwTop    = q(px2in(tableTw?.top?.width    || 0));
            const tableColSum = q(colW.reduce((acc: number, w: number) => acc + w, 0));
            const tableOpts: Parameters<Slide["addTable"]>[1] = {
              x: q(px2in(b.x) + tblTwLeft),
              y: q(px2in(b.y) + tblTwTop),
              w: tableColSum,
              h: q(tableH),
              colW,
              rowH,
              autoPage: false,
              fontFace: "Arial",
            };
            if (_tableGid) {
              // pptxgenjs TableProps accepts objectName; the JSZip post-pass
              // matches this against the underlay patch's objectName and
              // wraps the pair in a <p:grpSp>.
              (tableOpts as { objectName?: string }).objectName = hostName(_tableGid);
            }
            slide.addTable(tableRows, tableOpts);
            // Rounded-table outer outline. The per-corner shape-twice
            // sandwich leaves a 1×bw px notch at each corner cell's
            // inner-side corner where neither outer nor inner rect
            // reaches; on a wrapper-with-non-slide-bg fixture
            // (slide_17's pink `.table-wrap`) that notch leaks the
            // wrapper colour, plus there is no table-level top/left
            // border drawn at all in the native-addTable branch (the
            // outline below was only reachable from the per-cell
            // branch). Emit it here so the stroke covers the perimeter
            // notches AND draws the table's own border on top of the
            // native cells (`injectStrokeAlignment` later adds
            // algn="in" so the stroke lives inside the geometry —
            // pixel-aligned with the corner-shape outer ring).
            // (Earlier versions of this code emitted a "post-table outline
            // stroke" `addShape` here for the perimeter. With the
            // full-table underlay + corner shape-twice combination the
            // outline produced a visible double-border, and when I gated
            // it out for the outer-border case I left an `addShape` with
            // both fill+line set to none — an invisible shape stacked
            // over every rounded table. Removed entirely.)
            break;
          }

          // Corner-cell shape resolver: when the table has a border-radius,
          // each corner cell is rendered as `round1Rect` with flipH/flipV so
          // that only its OUTER corner is rounded; adjacent cells paint flat
          // against the cell's 3 square corners, matching CSS's overflow:hidden
          // clipping on tables. The table outline is drawn last.
          // OOXML `round1Rect` rounds the TOP-RIGHT corner (ECMA-376 preset
          // geometry). To orient the rounded corner toward each of the four
          // table corners:
          //   TL cell  → flipH (TR→TL)
          //   TR cell  → no flip (stays TR)
          //   BL cell  → flipH + flipV (TR→BL)
          //   BR cell  → flipV (TR→BR)
          const cornerOf = (ri: number, ci: number, colCount: number): { shape: string; flipH?: boolean; flipV?: boolean } | null => {
            if (!tableHasRadius) return null;
            if (ri === 0 && ci === 0 && tableCornerRadii.tl > 0) return { shape: "round1Rect", flipH: true };
            if (ri === 0 && ci === colCount - 1 && tableCornerRadii.tr > 0) return { shape: "round1Rect" };
            if (ri === rowCount - 1 && ci === 0 && tableCornerRadii.bl > 0) return { shape: "round1Rect", flipH: true, flipV: true };
            if (ri === rowCount - 1 && ci === colCount - 1 && tableCornerRadii.br > 0) return { shape: "round1Rect", flipV: true };
            return null;
          };

          for (let ri = 0; ri < rows.length; ri++) {
            const row = rows[ri];
            for (let ci = 0; ci < row.length; ci++) {
              const cell = row[ci];
              const cb = cell.bounds || b;
              const cs = cell.style || {};
              // Cell-level radius (rare; only use for cells that explicitly
              // declare their own border-radius). Table-level radius is now
              // rendered as a single outer rounded frame after the loop so
              // individual corner cells stay square — avoids pill-shaped
              // header cells from per-cell rectRadius clipping.
              const cellR = (cs.borderRadius || 0) > 0 ? cs.borderRadius : 0;

              // Cell background + outer line (pptxgenjs line is uniform; per-side
              // borders are painted as strips below).
              const rectOpts: ShapeProps = {
                x: px2in(cb.x), y: px2in(cb.y), w: px2in(cb.w), h: px2in(cb.h),
                line: { type: "none" },
              };
              if (cs.bgColor) {
                rectOpts.fill = { color: hexToRgb(cs.bgColor) };
                if (typeof cs.bgAlpha === "number" && cs.bgAlpha < 1) {
                  rectOpts.fill.transparency = Math.round((1 - cs.bgAlpha) * 100);
                }
              } else {
                rectOpts.fill = { type: "none" };
              }

              // Uniform border via shape line when all 4 sides match (common case).
              const bs: BorderSides = cs.borderSides || { top: { width: 0, color: "" }, bottom: { width: 0, color: "" }, left: { width: 0, color: "" }, right: { width: 0, color: "" } };
              const sides: readonly BorderSide[] = [bs.top, bs.right, bs.bottom, bs.left];
              const uniform = sides.every((s) =>
                s && s.width === bs.top.width && s.color === bs.top.color && s.style === bs.top.style,
              ) && (bs.top.width || 0) > 0;

              const corner = cornerOf(ri, ci, row.length);
              const rounded = cellR > 0;
              if (rounded) rectOpts.rectRadius = px2in(cellR);
              if (corner) {
                rectOpts.rectRadius = px2in(el.borderRadius);
                if (corner.flipH) rectOpts.flipH = true;
                if (corner.flipV) rectOpts.flipV = true;
              }

              if (uniform) {
                rectOpts.line = {
                  color: hexToRgb(bs.top.color),
                  width: Math.min((bs.top.width || 0) * PX2PT, 6),
                  dashType: bs.top.style === "dashed" ? "dash" : bs.top.style === "dotted" ? "dot" : "solid",
                };
              }
              const shapeToDraw = corner ? corner.shape : (rounded ? "roundRect" : "rect");
              slide.addShape(shapeToDraw, rectOpts);

              // Non-uniform per-side border strips
              if (!uniform) {
                const strips = [
                  bs.top?.width > 0 && bs.top?.color ? { x: cb.x, y: cb.y, w: cb.w, h: bs.top.width, color: bs.top.color, style: bs.top.style } : null,
                  bs.bottom?.width > 0 && bs.bottom?.color ? { x: cb.x, y: cb.y + cb.h - bs.bottom.width, w: cb.w, h: bs.bottom.width, color: bs.bottom.color, style: bs.bottom.style } : null,
                  bs.left?.width > 0 && bs.left?.color ? { x: cb.x, y: cb.y, w: bs.left.width, h: cb.h, color: bs.left.color, style: bs.left.style } : null,
                  bs.right?.width > 0 && bs.right?.color ? { x: cb.x + cb.w - bs.right.width, y: cb.y, w: bs.right.width, h: cb.h, color: bs.right.color, style: bs.right.style } : null,
                ].filter((s): s is { x: number; y: number; w: number; h: number; color: string; style?: string } => s !== null);
                for (const s of strips) {
                  if (s.style === "dashed" || s.style === "dotted") {
                    // Render dashed/dotted as a line so dashType applies.
                    const isHoriz = s.w > s.h;
                    slide.addShape("line", {
                      x: px2in(s.x), y: px2in(s.y),
                      w: isHoriz ? px2in(s.w) : 0,
                      h: isHoriz ? 0 : px2in(s.h),
                      line: {
                        color: hexToRgb(s.color),
                        width: Math.max((isHoriz ? s.h : s.w) * PX2PT, 1),
                        dashType: s.style === "dashed" ? "dash" : "sysDot",
                      },
                    });
                  } else {
                    slide.addShape("rect", {
                      x: px2in(s.x), y: px2in(s.y), w: px2in(s.w), h: px2in(s.h),
                      fill: { color: hexToRgb(s.color) }, line: { type: "none" },
                    });
                  }
                }
              }

              // Cell text (with padding + alignment).
              // When a cell is clipped (e.g. wrapper overflow:hidden with a
              // rounded corner) padding can exceed the available height or
              // width, yielding a 0-sized text box and invisible text. Clamp
              // each axis independently so a clipped-height cell still keeps
              // its horizontal padding (slide_05 summary row: rounded-wrapper
              // clip shortens the last row's height, but the 20-px left/right
              // padding still fits comfortably inside the cell's width).
              const pad = cell.padding || { top: 0, right: 0, bottom: 0, left: 0 };
              const padW = pad.left + pad.right;
              const padH = pad.top + pad.bottom;
              const useH = padW < cb.w;
              const useV = padH < cb.h;
              const tb = {
                x: useH ? cb.x + pad.left : cb.x,
                y: useV ? cb.y + pad.top : cb.y,
                w: useH ? cb.w - padW : cb.w,
                h: useV ? cb.h - padH : cb.h,
              };
              const text = cell.text || "";
              if (text.trim().length > 0) {
                const align = cs.textAlign === "center" ? "center" : cs.textAlign === "right" ? "right" : "left";
                const textOpts: TextPropsOptions = {
                  x: px2in(tb.x), y: px2in(tb.y), w: px2in(tb.w), h: px2in(tb.h),
                  valign: "middle",
                  align,
                  fontSize: (cs.fontSize || 14) * PX2PT,
                  fontFace: mapFont(cs.fontFamily || "Arial"),
                  color: hexToRgb(cs.color || "#111111"),
                  bold: cs.fontWeight === "bold" || cell.isHeader,
                  italic: cs.fontStyle === "italic",
                  fill: { type: "none" }, line: { type: "none" }, margin: 0,
                };
                if (cell.runs && cell.runs.length > 0 && cell.runs.some((r) => r.style !== null)) {
                  const textRuns = cell.runs.filter((r) => r.text.length > 0).map((run: TextRun) => {
                    const rs: RunStyle = run.style || {};
                    return {
                      text: run.text,
                      options: {
                        fontFace: mapFont(rs.fontFamily || cs.fontFamily || "Arial"),
                        fontSize: (rs.fontSize || cs.fontSize || 14) * PX2PT,
                        color: hexToRgb(rs.color || cs.color || "#111111"),
                        bold: rs.fontWeight === "bold" || (!rs.fontWeight && (cs.fontWeight === "bold" || cell.isHeader)),
                        italic: rs.fontStyle === "italic" || (!rs.fontStyle && cs.fontStyle === "italic"),
                      },
                    };
                  });
                  slide.addText(textRuns, textOpts);
                } else {
                  slide.addText(text, textOpts);
                }
              }
            }
          }
          // Outer rounded frame on the table itself — drawn on top with no
          // fill so it acts as a mask outline. Cells under the corners still
          // render square, but the combined visual reads as a rounded table.
          if (tableHasRadius) {
            // Honor per-corner table radii — a table with `border-radius:
            // 10px 10px 0 0` should outline only the top corners, not all 4.
            const tableCp = cornerPresetFromRadii(tableCornerRadii);
            const outlineOpts: ShapeProps = {
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
              fill: { type: "none" },
            };
            if (tableCp.preset !== "rect") {
              outlineOpts.rectRadius = px2in(el.borderRadius);
              if (tableCp.flipH) outlineOpts.flipH = true;
              if (tableCp.flipV) outlineOpts.flipV = true;
            }
            if (el.borderSides && (el.borderSides.top?.width || 0) > 0 && el.borderSides.top?.color) {
              outlineOpts.line = {
                color: hexToRgb(el.borderSides.top.color),
                width: Math.min((el.borderSides.top.width || 1) * PX2PT, 6),
              };
            } else {
              outlineOpts.line = { type: "none" };
            }
            slide.addShape(tableCp.preset, outlineOpts);
          }
          break;
        }

        case "visual":
        case "image": {
          const buf = visualPngs.get(ei);
          if (buf) {
            const imgOpts: NonNullable<Parameters<Slide["addImage"]>[0]> = {
              data: `image/png;base64,${bytesToBase64(buf)}`,
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
            };
            // Drop-shadow plumbed through from extract-dom.ts's clipped-
            // container branch (e.g. slide_12 .device's `box-shadow: 0 0 0
            // 2px #333`). Rendering the shadow natively via pptxgenjs lets
            // it follow the image's rect cleanly — without this, the
            // captured PNG bleeds halo pixels past its rounded corners
            // ("gray leftovers" — wave-12B target).
            // SAFETY: `boxShadow` is attached only on clipped-container visual
            // elements by extract-dom (wave-12B); not on the generic
            // VisualElement / ImageElement variant. We probe optionally and
            // null-guard before reading any sub-field below.
            const sh = (el as unknown as { boxShadow?: { blur?: number; offsetX?: number; offsetY?: number; color?: string; alpha?: number } }).boxShadow;
            if (sh && ((sh.blur || 0) > 0 || (sh.offsetX || 0) !== 0 || (sh.offsetY || 0) !== 0)) {
              const dx = sh.offsetX || 0;
              const dy = sh.offsetY || 0;
              let angle = Math.atan2(dy, dx) * 180 / Math.PI;
              if (dx === 0 && dy === 0) angle = 90;
              if (angle < 0) angle += 360;
              imgOpts.shadow = {
                type: "outer",
                blur: Math.min((sh.blur || 0) * PX2PT, 30),
                offset: Math.sqrt(dx * dx + dy * dy) * PX2PT,
                color: hexToRgb(sh.color || "#000000"),
                opacity: sh.alpha ?? 0.25,
                angle: Math.round(angle),
              };
            }
            slide.addImage(imgOpts);
            slideRegions.push({
              x: b.x / SLIDE_W_PX, y: b.y / SLIDE_H_PX,
              w: b.w / SLIDE_W_PX, h: b.h / SLIDE_H_PX,
              kind: (el.type === "image" && el._wasEmojiText) ? "emoji" : el.type,
            });
          }
          break;
        }
      }
    }
  }

  return { pres, renderedRegions };
}

// --- Gradient post-processing ---
// pptxgenjs has no gradFill API. We mark gradient shapes with descr="GRAD:{json}" via altText,
// then rewrite the saved .pptx XML to replace those shapes' <a:solidFill> with <a:gradFill>.

export function cssAngleToOoxml(cssDeg: number): number {
  // CSS: 0deg=up (to top), clockwise. OOXML <a:lin ang=>: 0=east, clockwise, units of 60000ths deg.
  // CSS direction = OOXML direction rotated 90° CCW: ooxml = (css - 90 + 360) % 360.
  const ooxml = ((cssDeg - 90) % 360 + 360) % 360;
  return Math.round(ooxml * 60000);
}

function buildGradFillXml(gradient: { angle?: number; type?: string; stops: { color: string; position: number; alpha?: number }[] }): string {
  const gsItems = gradient.stops.map(s => {
    const pos = Math.round(Math.max(0, Math.min(1, s.position)) * 100000);
    const clr = hexToRgb(s.color);
    const alphaXml = typeof s.alpha === "number" && s.alpha < 1
      ? `<a:alpha val="${Math.round(s.alpha * 100000)}"/>`
      : "";
    return `<a:gs pos="${pos}"><a:srgbClr val="${clr}">${alphaXml}</a:srgbClr></a:gs>`;
  }).join("");
  if (gradient.type === "radial") {
    // All-50% fillToRect = gradient converges to shape center (matches
    // CSS `radial-gradient(circle, …)`). `path="circle"` gives the concentric
    // falloff; `path="rect"` would make the gradient square off at the bounds.
    return `<a:gradFill rotWithShape="1"><a:gsLst>${gsItems}</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`;
  }
  const ang = cssAngleToOoxml(gradient.angle ?? 180);
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gsItems}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`;
}

/**
 * Inject `<a:gradFill>` into every shape tagged `name="GRAD_<n>"` in the
 * pptx zip. Pure — mutates the supplied JSZip instance in place; the caller
 * is responsible for serialising back to bytes / a file. Returns the number
 * of shapes patched (0 means nothing to do — caller can skip generateAsync).
 */
export async function injectGradientsIntoZip(zip: JSZip, registry: readonly Gradient[]): Promise<number> {
  if (registry.length === 0) return 0;
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let patchedShapes = 0;
  for (const name of slideFiles) {
    let xml = await zip.file(name)!.async("string");
    let slidePatched = 0;
    xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (spBlock: string) => {
      const m = spBlock.match(/name="GRAD_(\d+)"/);
      if (!m) return spBlock;
      const gradient = registry[parseInt(m[1])];
      if (!gradient) return spBlock;
      slidePatched++;
      return spBlock.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/, buildGradFillXml(gradient));
    });
    if (slidePatched > 0) { zip.file(name, xml); patchedShapes += slidePatched; }
  }
  return patchedShapes;
}

/**
 * Rewrite every `<a:ln w="…">` in every slide XML to also carry
 * `algn="in"`. pptxgenjs emits no `algn=` attribute, which OOXML treats
 * as `algn="ctr"` (stroke straddles the geometry path). On small-radius
 * roundRects (slide_11 SWOT cards) the outside-half of the stroke gets
 * sub-pixel quantised differently on the curved corners than on the
 * straight edges, making bottom borders look thicker than the corner
 * curves. CSS borders draw fully INSIDE the border-box, so `algn="in"`
 * matches the original. Idempotent — skips `<a:ln>` elements that
 * already have an algn attribute. Pure (mutates zip in place; returns
 * the count).
 */
export async function injectStrokeAlignmentIntoZip(zip: JSZip): Promise<number> {
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let patched = 0;
  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async("string");
    let slidePatched = 0;
    const next = xml.replace(/<a:ln\b([^>]*?)(\/?)>/g, (match: string, attrs: string, selfClose: string) => {
      if (/\balgn\s*=/.test(attrs)) return match;          // already has algn
      if (!/\bw\s*=/.test(attrs)) return match;            // no w=, leave alone
      slidePatched++;
      return `<a:ln${attrs} algn="in"${selfClose}>`;
    });
    if (slidePatched > 0) { zip.file(name, next); patched += slidePatched; }
  }
  return patched;
}

/**
 * Rewrite empty `<a:ln></a:ln>` elements on shapes to `<a:ln><a:noFill/></a:ln>`.
 * pptxgenjs `line: { type: "none" }` on `addShape()` emits a bare `<a:ln>`
 * with no width, no fill, and no children. PowerPoint reads this as
 * "inherit from theme", but Google Slides imports it as a default ~1pt
 * stroke — which paints a hairline around shapes that explicitly asked for
 * NO stroke. On the shape-twice corner-cell underlays for slide_17, the
 * inner-fill rect's empty `<a:ln>` rendered as a thin line on its right
 * and bottom edges, showing up as "border on the inner sides" of every
 * corner cell. Forcing `<a:noFill/>` inside `<a:ln>` is the OOXML-correct
 * way to say "stroke explicitly disabled" and both PowerPoint and Slides
 * agree on that. Idempotent — only matches the literal empty form.
 */
export async function injectShapeNoLineIntoZip(zip: JSZip): Promise<number> {
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let patched = 0;
  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async("string");
    let slidePatched = 0;
    const next = xml.replace(/<a:ln><\/a:ln>/g, () => {
      slidePatched++;
      return "<a:ln><a:noFill/></a:ln>";
    });
    if (slidePatched > 0) { zip.file(name, next); patched += slidePatched; }
  }
  return patched;
}

/**
 * Strip the attribute-heavy form of a "no border" table-cell line so Google
 * Slides actually honours the noFill. pptxgenjs (pptxgen.es.js:5341-5358)
 * emits every cell side as one of two forms — solid path, or, when our
 * BorderOpt is `type:"none"`, the literal:
 *   <a:lnL w="0" cap="flat" cmpd="sng" algn="ctr"><a:noFill/></a:lnL>
 * PowerPoint reads `w="0"` + `<a:noFill/>` as "explicitly disabled". Google
 * Slides reads the same XML as "explicit line, fall back to ~1pt default"
 * and paints a hairline anyway, producing visible column dividers between
 * cells that the CSS doesn't specify — the slide_17 rounded table flagged
 * in wave-21 ("the bottom left cell has border also on top and right…").
 * Same class of bug as the shape-line `<a:ln></a:ln>` rewrite above; same
 * fix shape, just for the lnL/lnR/lnT/lnB cell variants. Idempotent.
 */
export async function injectCellNoBorderIntoZip(zip: JSZip): Promise<number> {
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let patched = 0;
  const re = /<a:(lnL|lnR|lnT|lnB) w="0" cap="flat" cmpd="sng" algn="ctr"><a:noFill\/><\/a:\1>/g;
  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async("string");
    let slidePatched = 0;
    const next = xml.replace(re, (_m: string, side: string) => {
      slidePatched++;
      return `<a:${side}><a:noFill/></a:${side}>`;
    });
    if (slidePatched > 0) { zip.file(name, next); patched += slidePatched; }
  }
  return patched;
}

/**
 * Wrap every cluster of shapes that share a `<gid>__` prefix in their
 * pptxgenjs `objectName` into a single native `<p:grpSp>`. The previous
 * pair-only design (gid__patch + gid__host) is a special case of the
 * generalised N-member algorithm below.
 *
 * Algorithm per slide XML:
 *   1. Scan top-level `<p:sp>` and `<p:graphicFrame>` blocks.
 *   2. Read each block's objectName from `<p:cNvPr name="..."/>`. A name
 *      matching `h2s-grp-<N>__<anything>` enrols the block in group N.
 *   3. For each group with ≥ 2 members, compute the union bbox and emit
 *      a `<p:grpSp>` containing all members in their original spTree
 *      order. Members are rewritten in place at the EARLIEST member's
 *      position; the others are removed from their later positions.
 *      Children keep their absolute coordinates; grpSp's `chOff`/`chExt`
 *      mirror `off`/`ext` so the descendant coordinate system matches.
 *
 * Pure: mutates the JSZip in place, returns the number of groups created.
 */
export async function injectClipGroupsIntoZip(zip: JSZip): Promise<number> {
  const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let groupCount = 0;

  const blockRe = /<p:(sp|graphicFrame)>[\s\S]*?<\/p:\1>/g;
  // Capture the gid prefix (h2s-grp-<N>) regardless of the role suffix
  // after `__` (patch, host, m0, m1, …). Anything else is ignored.
  const nameRe = /<p:cNvPr\b[^>]*\bname="(h2s-grp-\d+)__[^"]+"/;
  const offRe = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>/;
  const extRe = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/;

  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async("string");
    interface Block { start: number; end: number; raw: string; off: { x: number; y: number }; ext: { cx: number; cy: number } }
    // gid → ordered list of member blocks (spTree order).
    const groups = new Map<string, Block[]>();
    blockRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(xml)) !== null) {
      const raw = match[0];
      const nm = raw.match(nameRe);
      if (!nm) continue;
      const gid = nm[1];
      const off = raw.match(offRe);
      const ext = raw.match(extRe);
      if (!off || !ext) continue;
      const block: Block = {
        start: match.index,
        end: match.index + raw.length,
        raw,
        off: { x: parseInt(off[1]), y: parseInt(off[2]) },
        ext: { cx: parseInt(ext[1]), cy: parseInt(ext[2]) },
      };
      const list = groups.get(gid) ?? [];
      list.push(block);
      groups.set(gid, list);
    }

    if (groups.size === 0) continue;

    interface GroupPlan { gid: string; anchor: Block; rest: Block[]; bbox: { x: number; y: number; cx: number; cy: number } }
    const plans: GroupPlan[] = [];
    const skipRanges: Array<{ start: number; end: number }> = [];
    for (const [gid, blocks] of groups) {
      if (blocks.length < 2) continue;
      blocks.sort((a, b) => a.start - b.start);
      const anchor = blocks[0];
      const rest = blocks.slice(1);
      const x = Math.min(...blocks.map((b) => b.off.x));
      const y = Math.min(...blocks.map((b) => b.off.y));
      const r = Math.max(...blocks.map((b) => b.off.x + b.ext.cx));
      const btm = Math.max(...blocks.map((b) => b.off.y + b.ext.cy));
      plans.push({ gid, anchor, rest, bbox: { x, y, cx: r - x, cy: btm - y } });
      for (const b of rest) skipRanges.push({ start: b.start, end: b.end });
    }

    if (plans.length === 0) continue;

    // Stitch the final XML: at each anchor's position we emit a `<p:grpSp>`
    // containing the anchor + the rest of its group's members raw. Later
    // positions of the non-anchor members are dropped via skipRanges.
    plans.sort((p1, p2) => p1.anchor.start - p2.anchor.start);
    skipRanges.sort((s1, s2) => s1.start - s2.start);

    let out = "";
    let cursor = 0;
    let planIdx = 0;
    let skipIdx = 0;
    while (cursor < xml.length) {
      const nextPlan = planIdx < plans.length ? plans[planIdx].anchor.start : Infinity;
      const nextSkip = skipIdx < skipRanges.length ? skipRanges[skipIdx].start : Infinity;
      const next = Math.min(nextPlan, nextSkip);
      if (next === Infinity) {
        out += xml.slice(cursor);
        break;
      }
      out += xml.slice(cursor, next);
      if (nextPlan <= nextSkip) {
        const p = plans[planIdx++];
        const groupName = `${p.gid}__grp`;
        const childrenRaw = [p.anchor.raw, ...p.rest.map((b) => b.raw)].join("");
        out += `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="0" name="${groupName}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
               `<p:grpSpPr><a:xfrm><a:off x="${p.bbox.x}" y="${p.bbox.y}"/><a:ext cx="${p.bbox.cx}" cy="${p.bbox.cy}"/>` +
               `<a:chOff x="${p.bbox.x}" y="${p.bbox.y}"/><a:chExt cx="${p.bbox.cx}" cy="${p.bbox.cy}"/></a:xfrm></p:grpSpPr>` +
               childrenRaw +
               `</p:grpSp>`;
        cursor = p.anchor.end;
        groupCount++;
      } else {
        const s = skipRanges[skipIdx++];
        cursor = s.end;
      }
    }

    zip.file(name, out);
  }

  return groupCount;
}

// --- Re-exports of internal helpers callers may want to reuse ---
export { buildGradFillXml };

// --- In-memory build (browser-friendly) ---
// Returns a fully-patched .pptx as bytes. No fs, no Drive. Same buildPptx core
// + same gradient/stroke post-processing as runConvertPptx, applied to the
// JSZip in-memory instead of round-tripping through a file.
export async function buildPptxInMemory(
  slides: readonly SlideInput[],
  title: string,
): Promise<Uint8Array> {
  const { pres } = buildPptx(slides, title);
  const ab = (await pres.write({ outputType: "arraybuffer" })) as ArrayBuffer;
  const zip = await JSZip.loadAsync(ab);

  const gradPatched = await injectGradientsIntoZip(zip, pres.__gradients || []);
  const strokePatched = await injectStrokeAlignmentIntoZip(zip);
  const noLinePatched = await injectShapeNoLineIntoZip(zip);
  const cellNoBorderPatched = await injectCellNoBorderIntoZip(zip);
  const groupsCreated = await injectClipGroupsIntoZip(zip);
  if (gradPatched > 0) console.log(`  Gradient injection: ${gradPatched} shape(s) patched`);
  if (strokePatched > 0) console.log(`  Stroke alignment: ${strokePatched} <a:ln> rewrite(s) to algn="in"`);
  if (noLinePatched > 0) console.log(`  Shape no-line: ${noLinePatched} empty <a:ln> rewrite(s) to <a:noFill/>`);
  if (cellNoBorderPatched > 0) console.log(`  Cell no-border: ${cellNoBorderPatched} <a:ln[LRTB] w=0> rewrite(s) to <a:noFill/>`);
  if (groupsCreated > 0) console.log(`  Clip groups: ${groupsCreated} <p:grpSp>(s) wrapping patch+host pairs`);

  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
