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
 * 7. LINE SPACING AND THE FIRST LINE  (this is the bug-prone zone)
 *
 *    Google's line model (measured for the Sasha engine, see
 *    slides-first-baseline.ts): a line is spcPct x 1.2 x its largest
 *    font size tall, extra spacing goes BELOW the glyphs, and the
 *    baseline sits 0.9465 x size below the line top for every family.
 *
 *      if (lineHeight && fontSize) {
 *        if (valign === "middle" && verticallyCentered) {
 *          lineSpacingMultiple = 1.2;                 // BRANCH 1
 *        } else if (lineHeightMeasured) {
 *          lineSpacing = lineHeight × PX2PT;          // BRANCH 2
 *        } else {
 *          lineSpacingMultiple = (lineHeight / fontSize) / 1.2;  // BRANCH 3
 *        }
 *      }
 *
 *    BRANCH 1 (wave-1a): with anchor="ctr", Slides positions visible
 *      glyphs at the shape center exactly when spcPct = 120000
 *      (multiplier 1.2). Pin explicitly — skipping lnSpc lets Slides
 *      infer a per-slide default that drifts when other shapes land.
 *
 *    BRANCH 2 (wave-10A): a MEASURED pitch (.text-block on slide_25,
 *      inline chips inflating the line boxes) stays absolute points.
 *      Google stores it as a percentage of another size (23.4 pt came
 *      back as 173 %), but the percentage of the paragraph's own size
 *      measured worse: Google sizes a line by its largest word.
 *
 *    BRANCH 3: the pitch. spcPct x 1.2 x size = CSS line-height.
 *
 *    FIRST LINE (top-anchored text in BRANCH 3 and native lists): extract-dom
 *      measures Chrome's first baseline (`firstBaselineY`) and the
 *      line's largest font size; topAnchoredTextPlacement turns the gap
 *      to Google's baseline into tIns (or raises the box). That covers
 *      CSS half-leading, padding-top and each family's own ascent. The
 *      older estimates (padding-top, the 1.197 line-box fix, the
 *      measured-pitch lead) remain only for elements without a
 *      measurement.
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
 *       post-process (postProcessPptx).
 *
 *    d. Conservative gates. Every layout rule above is narrowed by an
 *       extract-dom predicate (`lineHeightMeasured`, `verticallyCentered`,
 *       `singleLine`). Blanket rules always broke another slide; every
 *       wave has tightened — never widened — these gates.
 */

import * as pptxgenModule from "pptxgenjs";
import type PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { topAnchoredTextPlacement } from "./slides-first-baseline";
import type * as Wire from "./extraction-wire.ts";
/** Deterministic 8-hex digest (FNV-1a 32-bit) — platform-neutral: this module
 * is ALSO bundled for the browser (Sidebar.html), where node:crypto doesn't
 * exist. Collision strength is irrelevant here; the digest only makes drawio
 * diagramIds stable across re-runs of the converter. */
function fnv1a8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// pptxgenjs Slide / option types we reuse below. Keeping a single set of
// aliases here means the body of buildPptx talks about typed objects
// instead of sprinkling `any` on every `slide.addX(...)` call site.
type Slide = PptxGenJS.Slide;
type ShapeProps = PptxGenJS.ShapeProps;
type TextProps = PptxGenJS.TextProps;
type TextPropsOptions = PptxGenJS.TextPropsOptions;
type ShapeName = PptxGenJS.SHAPE_NAME;
type TableCellProps = PptxGenJS.TableCellProps;
type BorderProps = PptxGenJS.BorderProps;
type ShapeLineProps = NonNullable<ShapeProps["line"]>;
// The published pptxgenjs dash-type union omits several valid OOXML
// `<a:prstDash>` presets (notably "dot"). This file emits those raw OOXML
// values directly, so the produced dash strings are asserted to the library's
// (narrower) dashType at the call site. See `asDashType`.
type DashTypeValue = NonNullable<ShapeLineProps["dashType"]>;
// TODO(types): pptxgenjs 4.0.1's `dashType` union lacks "dot" (a valid OOXML
// preset). The runtime passes it through verbatim, so we narrow-assert here.
function asDashType(value: "solid" | "dash" | "sysDash" | "sysDot" | "dot"): DashTypeValue {
  return value as DashTypeValue;
}

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

// Tracking scale: CSS letter-spacing px to OOXML charSpacing pt. Calibrated
// against Google's rendering, which lays `spc` out tighter than the slide
// geometry scale: at PX2PT (0.5625) a 2px letter-spacing emits spc=113 and
// 'PRODUCT FEATURES' (slide_12 .section-label) measures ~165px vs the 185px
// target (~11% under). The plain 96-dpi px→pt factor lands it: 2px → 1.5pt
// (spc=150), matching the measured target.
const LETTER_SPACING_PX2PT = 0.75;

// Phase 1 (drawio round-trip): the editable drawio source is stored as an
// `.drawio.svg` on Google Drive and linked from the on-slide image (see
// runConvertPptx), NOT in an on-slide magenta marker text box. The former
// `CONFIG.drawioMetaColor` ("FF00FF") off-canvas-marker convention is retired.

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
  // Propagate CSS letter-spacing → run charSpacing (run over element), matching
  // the no-runs branch; the styled-runs path was dropping it so text packed
  // tighter than the original (slide_12/34/03).
  const ls = typeof rs.letterSpacing === "number" ? rs.letterSpacing : ps.letterSpacing;
  if (typeof ls === "number" && ls !== 0) opts.charSpacing = ls * LETTER_SPACING_PX2PT;
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
  // CSS writing-mode: vertical-* — emit a pptxgenjs `vert` body rotation rather
  // than a box rotation. The element's bounds box is already the narrow/tall
  // CSS column, so keep it axis-aligned and let `vert` flow text down it.
  // `vertical-rl` (default text-orientation) → glyphs rotated 90°CW reading
  // top→bottom = OOXML "vert"; an accompanying ~180° transform flips reading
  // direction to bottom→top = "vert270" (slide_32 .axis: vertical-rl + rotate180).
  const isVertical = typeof s.writingMode === "string" && s.writingMode.startsWith("vertical");
  let vertOpt: "vert" | "vert270" | undefined;
  if (isVertical) {
    const r = ((rot % 360) + 360) % 360;
    vertOpt = Math.abs(r - 180) < 30 ? "vert270" : "vert";
  } else if (Math.abs(rot) > 0.5 && el.naturalWidth && el.naturalHeight) {
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
  // Line-box vertical correction (systematic). Google Slides ALWAYS lays out
  // text on a `line-height: normal` line box (≈ 1.197 × font), regardless of
  // the spcPct we emit. When the source CSS line-height is TIGHTER than that
  // (ratio < 1.197 — e.g. big headline/amount/quote-mark at `line-height: 1`),
  // Slides anchors the top of its TALLER first line-box to the textbox top, so
  // the glyphs ride up by ≈ ((1.197 − cssRatio) / 2) × font versus Chrome
  // (~5px@48, 7px@72, 16px@160 — the proportional pattern the user reported on
  // slide_17 `$15M`, slide_06 quote-mark). Push the glyphs back down by folding
  // that half-gap into the textbox top inset (tIns). GATED to cssRatio < 1.197
  // so normal paragraphs / lists / code blocks (line-height 1.2–1.7) are a
  // strict no-op — they already match Chrome via the spcPct path and must NOT
  // move (slide_04/08/24/30 bodies, slide_06 quote-text @1.6).
  const SLIDES_NORMAL_LH = 1.197;
  const fontPx = s.fontSize || defaults.fontSize;
  const cssLHRatio = (s.lineHeight && s.fontSize) ? s.lineHeight / s.fontSize : 1.2;
  const lineBoxFixPt =
    valign === "top" && fontPx > 0 && cssLHRatio < SLIDES_NORMAL_LH
      ? ((SLIDES_NORMAL_LH - cssLHRatio) / 2) * fontPx * PX2PT
      : 0;
  // Companion fix for vertically-centered, descender-less numerics (the "3"
  // badge slide_22, "100%/50%/25%" badges slide_28). With anchor="ctr" Slides
  // centers the LINE BOX, and the pinned spcPct 1.2 (below) makes that box
  // taller than the glyph; a digit/percent has no descender so it sits visually
  // above the geometric center ("top vs middle" in the user's words). Nudge the
  // text down by folding a top inset — for anchor="ctr" the centering region
  // shifts by tIns/2, so we double the target shift. Gated to numeric-only text
  // (digits, %, $, ., ,, +, −) so lettered initials (EW/SV/GC/NX) and word
  // labels stay put.
  const isNumericCentered =
    valign === "middle" &&
    typeof el.text === "string" &&
    el.text.trim().length > 0 &&
    /^[\d%$.,+−–\-\s]+$/.test(el.text);
  const centerDigitInsetPt =
    isNumericCentered && fontPx > 0 ? 2 * (0.12 * fontPx) * PX2PT : 0;
  // First-line leading compensation for the MEASURED-pitch (absolute spcPts)
  // path. When extract-dom flagged `lineHeightMeasured` (inline children inflate
  // the line boxes — slide_25 `.text-block` @ line-height 2.2 with .code/.big/
  // .highlight chips), the block is emitted with absolute `<a:spcPts>` line
  // spacing. Google Slides anchors the FIRST line's ascent at the textbox top
  // WITHOUT the half-leading Chrome renders above it (`(lineHeight − font)/2`),
  // so the whole paragraph rides up — the user's "the start of the text is moved
  // up" report on slide_25 (~11px). Push the block down by that half-leading,
  // folded into the top inset. GATED to `lineHeightMeasured` so plain spcPct
  // paragraphs/lists (slide_04/08/24 bodies, slide_06 quote @1.6) are untouched
  // (those position the first line correctly via the multiplier path).
  const measuredFirstLineLeadPt =
    valign === "top" && s.lineHeightMeasured === true &&
    typeof s.lineHeight === "number" && fontPx > 0 && s.lineHeight > fontPx
      ? ((s.lineHeight - fontPx) / 2) * PX2PT
      : 0;
  // MEASURED first baseline (supersedes the three estimates above for top-anchored text in
  // percentage line spacing). Chrome's baseline is where extract-dom measured it; Google's sits a
  // fixed 0.9465 x size below the line top whatever the family and spacing (slides-first-baseline.ts),
  // so the inset is their difference. It also covers padding-top and `line-height: normal`, which
  // the estimates took as 1.2 for every family: Playfair's taller ascent left complex slide_17's
  // title 6.4 px high, and the 0.2 em half-leading of slide_06's quote at 1.6 another 6.4 px.
  // The measured-pitch path (absolute spcPts) keeps its own first-line lead: Google turns spcPts
  // into a percentage of another size, so the model's offset does not describe those lines.
  const measuredBaseline =
    valign === "top" && rotateDeg === 0 && vertOpt === undefined && s.lineHeightMeasured !== true &&
    typeof s.firstBaselineY === "number" && typeof s.firstLineFontSize === "number" && s.firstLineFontSize > 0
      ? topAnchoredTextPlacement({
          boxTopPx: by,
          boxHeightPx: bh,
          chromeFirstBaselinePx: s.firstBaselineY,
          lineSpacingMultiple: s.lineHeight && s.fontSize ? (s.lineHeight / s.fontSize) / 1.2 : 1,
          firstLineFontSizePx: s.firstLineFontSize,
        })
      : null;
  if (measuredBaseline !== null) {
    by = measuredBaseline.topPx;
    bh = measuredBaseline.heightPx;
  }
  const tInsPt = measuredBaseline !== null
    ? measuredBaseline.topInsetPx * PX2PT
    : padTopPt + lineBoxFixPt + centerDigitInsetPt + measuredFirstLineLeadPt;
  const commonOpts: TextPropsOptions = {
    x: px2in(bx), y: px2in(by), w: px2in(bw), h: px2in(bh),
    valign,
    align,
    fill: { type: "none" },
    line: { type: "none" },
    margin: tInsPt > 0 ? [0, 0, 0, tInsPt] : 0,
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
      // Kept absolute although Google stores it as a percentage of another size (slide_25's
      // 23.4 pt came back as 173.33 %): emitting (pitch / size) / 1.2 instead was measured WORSE on
      // slide_25 (0.97 % -> 1.40 %), because Google sizes the line holding the 24 px .big word by
      // that word, 55.5 px against Chrome's ~50, and every later line followed it down.
      commonOpts.lineSpacing = s.lineHeight * PX2PT;
    } else {
      commonOpts.lineSpacingMultiple = (s.lineHeight / s.fontSize) / 1.2;
    }
  }
  if (rotateDeg) commonOpts.rotate = rotateDeg;
  if (vertOpt) commonOpts.vert = vertOpt;

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
    if (typeof s.letterSpacing === "number" && s.letterSpacing !== 0) {
      textOpts.charSpacing = s.letterSpacing * LETTER_SPACING_PX2PT;
    }
    slide.addText(text, textOpts);
  }
}

// Map per-corner radii to OOXML preset + flip flags. Centralised so the
// outer/inner sandwich rects (rounded + partial border) and the table
// outline pick the SAME preset — otherwise the bottom edge of a top-only
// rounded card draws a curve from the outer rect even though the inner
// fill is flat (slide_01 Professional pricing card).
function cornerPresetFromRadii(cr: { tl: number; tr: number; br: number; bl: number }):
  { preset: ShapeName; flipH: boolean; flipV: boolean } {
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

/** Per-paragraph native-bullet colors for one BUCLR_<n>-tagged list textbox.
 *  `colors[i]` is the bare-6-hex bullet color of paragraph i (item order), or
 *  null when that paragraph's marker keeps the default (text-colored) bullet.
 *  pptxgenjs 4.0.1 cannot write `<a:buClr>` at all, so the colors ride this
 *  side-band registry and injectBulletColorsIntoZip patches them post-hoc. */
export interface BulletColorList {
  readonly colors: readonly (string | null)[];
}

export interface BoxShadowLayer {
  readonly color: string;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly blur?: number;
  readonly spread?: number;
  readonly alpha?: number;
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
  /** Chrome's first-line baseline (client y px), measured by extract-dom.ts measureFirstLine. */
  readonly firstBaselineY?: number;
  /** The largest baseline-aligned font size (px) on Chrome's first line: Google sizes the line by it. */
  readonly firstLineFontSize?: number;
  readonly textAlign?: "left" | "center" | "right" | "end" | "justify" | string;
  readonly textTransform?: "uppercase" | "lowercase" | "none" | string;
  readonly writingMode?: string | null;
  readonly textDecoration?: "underline" | "line-through" | "none" | string;
  readonly letterSpacing?: number;
  readonly opacity?: number;
  readonly bgColor?: string;
  readonly bgColorBehind?: string;
  readonly paddingTop?: number;
  readonly paddingRight?: number;
  readonly paddingLeft?: number;
  readonly bgAlpha?: number;
  readonly borderRadius?: number;
  readonly borderSides?: BorderSides;
}

/** Per-run inline style override. */
export interface RunStyle {
  readonly color?: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: "bold" | "normal" | string;
  readonly fontStyle?: "italic" | "normal" | string;
  readonly textDecoration?: "underline" | "line-through" | "none" | string;
  readonly letterSpacing?: number;
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
  /** Set by extract-dom when the clipping ancestor is rasterised to a 2× PNG
   * (the `clipped-container` device-mockup branch). Tells the patch emitter a
   * correctly-rounded backing image already exists, so a child overlay whose
   * required corner radius exceeds 50% of its clipped dimension (which a native
   * roundRect can't represent) is skipped rather than drawn as a clamped,
   * corner-poking shape over the device's true rounded edge. */
  readonly rasterizedHost?: boolean;
  /** Absolute y (px) where the rasterised top strip ends. Only the dark top
   * region of the host is rasterised; a child fill fully above this line is
   * already painted by the PNG, so its overlay is skipped. Undefined when the
   * whole host is rasterised. */
  readonly rasterBottomY?: number;
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
  /** Phase 1 (drawio): true only on the rendered diagram element (<svg>/<img>)
   * that pairs with an `Extraction.drawioSource`. When set, the converter tags
   * this element's image with `altText = drawio:<diagramId>` and collects the
   * source into `drawioDiagrams` for the post-upload Drive upload + image link
   * (see runConvertPptx step 4). Undefined on non-drawio slides → the
   * converter does nothing extra (byte-identical preserved). */
  readonly _drawioPaired?: boolean;
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
  readonly boxShadow?: BoxShadowLayer | null;
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
  readonly bulletIsDot?: boolean;
  readonly lineHeight?: number;
  readonly marginBottom?: number;
  readonly padding?: Padding;
  readonly bgColor?: string;
  readonly bgAlpha?: number;
  readonly borderRadius?: number;
  readonly borderSides?: BorderSides;
  readonly textAlign?: string;
  /** Bottom-separator colour for a row-style list item (CSS `border-bottom`),
   * passed straight to a thin divider line. */
  readonly borderBottom?: string;
}

export interface ListElement extends ElementCommon {
  readonly type: "list";
  readonly items: readonly ListItem[];
  readonly ordered?: boolean;
  readonly anyStyledItem?: boolean;
  readonly listStyleType?: string;
  /** True when the <ul>/<ol> is itself the visual (own bg/border/radius or a
   * majority of items use a border-bottom separator) — rows never get markers. */
  readonly isContainerList?: boolean;
  /** Chrome's first-line baseline of the list (client y px), measured by extract-dom.ts measureFirstLine. */
  readonly firstBaselineY?: number;
  /** The largest baseline-aligned font size (px) on the list's first line. */
  readonly firstLineFontSize?: number;
}

export interface TableCell {
  readonly text?: string;
  readonly runs?: readonly TextRun[];
  readonly bounds?: Bounds;
  readonly bgColor?: string;
  readonly colspan?: number;
  readonly rowspan?: number;
  readonly isHeader?: boolean;
  readonly padding?: Padding;
  readonly style?: ElementStyle;
}
/** A table row is the raw array of its cells (matches extract-dom's emitted
 * shape). */
export type TableRow = readonly TableCell[];
export interface TableElement extends ElementCommon {
  readonly type: "table";
  readonly rows: readonly TableRow[];
  readonly bgColor?: string;
  readonly borderRadius?: number;
  readonly cornerRadii?: CornerRadii;
  readonly borderSides?: BorderSides | null;
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
  /** Per-corner radii the `clipped-container` device PNG was captured under —
   * used to tag its rendered region descriptively. */
  readonly cornerRadii?: CornerRadii;
  /** `text-glow` visual: the `data-h2s-glow` id the io capture isolates. */
  readonly glowId?: number;
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

/** CSS border-triangle arrow → pptxgenjs `triangle` preset. */
export interface TriangleElement extends ElementCommon {
  readonly type: "triangle";
  readonly fill?: string | null;
}

/** A standalone hairline/decorative line. Either endpoint-defined
 * (`x1/y1/x2/y2`) or a thin decorative strip described by `bounds`. */
export interface LineElement extends ElementCommon {
  readonly type: "line";
  readonly color?: string | null;
  readonly dashType?: string;
  readonly strokeWidth?: number;
  readonly x1?: number;
  readonly y1?: number;
  readonly x2?: number;
  readonly y2?: number;
}

/** A line break placeholder emitted by extract-dom; carries no geometry the
 * converter renders. */
export interface BrElement extends ElementCommon {
  readonly type: "br";
}

/** A `clip-path: polygon(...)` host rendered as a native `custGeom` freeform.
 * `points` are px offsets relative to `bounds` top-left, in path order. Carries
 * a solid (`fill`/`fillAlpha`) OR linear-gradient fill. */
export interface PolyElement extends ElementCommon {
  readonly type: "poly";
  readonly points?: { readonly x: number; readonly y: number }[];
  readonly fill?: string | null;
  readonly fillAlpha?: number;
  readonly gradient?: Gradient | null;
}

/** Discriminated union over every variant extract-dom can emit. */
export type ExtractedElement =
  | RectElement
  | TextElement
  | ListElement
  | TableElement
  | VisualElement
  | ImageElement
  | TriangleElement
  | LineElement
  | PolyElement
  | BrElement
  | SkipElement;

export interface Extraction {
  readonly viewport: { readonly w: number; readonly h: number };
  readonly elementCount: number;
  /** Mutable: the emitter replaces merged-away text elements in place with a
   * `_skip` sentinel (so their index is preserved for the post-pass). */
  readonly elements: ExtractedElement[];
  /** Workstream E: editable drawio (mxGraph) XML behind this slide's rendered
   * diagram, lifted from the page's `<script
   * type="application/vnd.drawio+xml" id="drawio-source">`. Present ONLY for
   * slides that carry such a script; undefined otherwise. When set, the
   * converter emits one extra off-canvas marker text box (see buildPptx) so
   * the add-on can rediscover + re-edit the diagram. */
  readonly drawioSource?: string;
  /** Phase 1: outerHTML of the rendered diagram element WHEN it is an inline
   * `<svg>`, so `buildEditableSvg` can wrap the real SVG geometry as the
   * editable drawio image on Drive. Omitted when the paired visual is a raster
   * `<img>`/PNG (a minimal wrapper is emitted instead) and on every non-drawio
   * slide (byte-identical preserved). */
  readonly drawioBaseSvg?: string;
}

/** Phase 1: one editable drawio diagram lifted out of a slide during buildPptx.
 * `runConvertPptx` uploads each as a `.drawio.svg` to Drive after the
 * presentation upload, then links the on-slide image to it. Empty array when no
 * slide carried a drawio source. */
export interface DrawioDiagram {
  readonly slideIndex1: number;   // 1-based slide number
  readonly diagramId: string;     // `slide<n>_<sha256(xml).slice(0,8)>`
  readonly xml: string;           // editable mxGraph/mxfile XML
  readonly baseSvg?: string;      // rendered <svg> outerHTML when available
  readonly altText: string;       // `drawio:<diagramId>` (mirrors the image's descr)
}

// Wire drift guards (types only, erased at compile time). The interfaces above are this
// converter's narrowed, readonly view of the JSON extract-dom.ts emits; extraction-wire.ts is the
// producer's declaration of it. Each guard fails the type check when the converter reads a field
// the producer does not declare, which is how `style.bgColorBehind` once drifted: emitted and read,
// declared on one side only.
type FieldsOf<T> = T extends unknown ? keyof T : never;
type UndeclaredFields<Consumer, Producer> = Exclude<FieldsOf<Consumer>, FieldsOf<Producer>>;
type AllDeclared<Missing extends never> = Missing;
export type WireDriftGuards = [
  AllDeclared<UndeclaredFields<Bounds, Wire.Bounds>>,
  AllDeclared<UndeclaredFields<BorderSide, Wire.BorderSides["top"]>>,
  AllDeclared<UndeclaredFields<CornerRadii, Wire.CornerRadii>>,
  AllDeclared<UndeclaredFields<GradientStop, Wire.GradientStop>>,
  AllDeclared<UndeclaredFields<Gradient, Wire.Gradient>>,
  AllDeclared<UndeclaredFields<BoxShadowLayer, Wire.BoxShadow>>,
  AllDeclared<UndeclaredFields<ElementStyle, Wire.ElementStyle>>,
  AllDeclared<UndeclaredFields<RunStyle, NonNullable<Wire.TextRun["style"]>>>,
  AllDeclared<UndeclaredFields<TextRun, Wire.TextRun>>,
  AllDeclared<UndeclaredFields<ClipMask, Wire.ClipMask>>,
  AllDeclared<UndeclaredFields<ListItem, Wire.ListItem>>,
  AllDeclared<UndeclaredFields<TableCell, Wire.TableCell>>,
  AllDeclared<UndeclaredFields<ExtractedElement, Wire.ExtractedElement>>,
  AllDeclared<UndeclaredFields<Extraction, Wire.Extraction>>,
];
// Every variant this converter handles is a `type` the producer can emit.
export type WireKindGuard = AllDeclared<Exclude<ExtractedElement["type"], Wire.ExtractedElement["type"]>>;

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
 *                shape.
 *   __bulletColors: per-paragraph native-bullet colors, indexed by the
 *                BUCLR_<n> objectName tag on each colored-bullet list
 *                textbox. injectBulletColors* inserts <a:buClr> per <a:p>. */
export type PresentationWithRegistries = PptxGenJS & {
  __gradients: Gradient[];
  __bulletColors: BulletColorList[];
};

export function buildPptx(
  slides: readonly SlideInput[],
  title: string,
): { pres: PresentationWithRegistries; renderedRegions: RenderedRegion[][]; drawioDiagrams: DrawioDiagram[] } {
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
  const bulletColorRegistry: BulletColorList[] = [];
  pres.__bulletColors = bulletColorRegistry;
  pres.title = title;
  pres.layout = "LAYOUT_WIDE"; // 13.333" x 7.5" — wait, we want 10" x 5.625"

  // Actually define custom layout matching our slide dimensions
  pres.defineLayout({ name: "CUSTOM", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pres.layout = "CUSTOM";

  const renderedRegions: RenderedRegion[][] = [];
  const drawioDiagrams: DrawioDiagram[] = [];

  for (let si = 0; si < slides.length; si++) {
    const { extraction, visualPngs } = slides[si];
    const slideRegions: RenderedRegion[] = [];
    renderedRegions.push(slideRegions);
    const ctx: EmitContext = {
      slide: pres.addSlide(),
      slideIndex: si,
      extraction,
      visualPngs,
      gradientRegistry,
      bulletColorRegistry,
      slideRegions,
      drawioDiagrams,
    };
    // Re-read the element on every step: emitRect replaces a text it absorbs
    // further down the array with a `_skip` sentinel.
    for (let ei = 0; ei < extraction.elements.length; ei++) {
      emitElement(ctx, extraction.elements[ei], ei);
    }
    // Phase 1: a drawio diagram's editable source rides `drawioDiagrams` (see
    // emitVisual), and runConvertPptx uploads it as a `.drawio.svg` to Drive
    // after the presentation upload, so the slide XML carries no off-canvas
    // marker box.
  }

  return { pres, renderedRegions, drawioDiagrams };
}

/** What every element emitter of one slide shares: the slide being written,
 * its extraction (whose `elements` emitRect rewrites when it absorbs a text),
 * the deck-wide side-band registries, and the per-slide / per-deck outputs. */
interface EmitContext {
  readonly slide: Slide;
  /** 0-based slide index. */
  readonly slideIndex: number;
  readonly extraction: Extraction;
  readonly visualPngs: ReadonlyMap<number, Uint8Array | Buffer>;
  /** Gradients for injectGradientsIntoZip, indexed by the GRAD_<n> objectName. */
  readonly gradientRegistry: Gradient[];
  /** Native-bullet colours for injectBulletColorsIntoZip, indexed by BUCLR_<n>. */
  readonly bulletColorRegistry: BulletColorList[];
  /** Rasterised regions of this slide, surfaced to the rating UI. */
  readonly slideRegions: RenderedRegion[];
  readonly drawioDiagrams: DrawioDiagram[];
}

/** Emits one extracted element (at index `ei`) onto the context's slide. */
function emitElement(ctx: EmitContext, el: ExtractedElement, ei: number): void {
  switch (el.type) {
    case "_skip":
    case "br":
      return;
    case "rect":
      return emitRect(ctx, el, ei);
    case "triangle":
      return emitTriangle(ctx.slide, el);
    case "poly":
      return emitPoly(ctx, el);
    case "line":
      return emitLine(ctx.slide, el);
    case "text":
      // All slack/rotation/run-mapping logic lives in emitStyledText so
      // this site stays a single dispatch. Standalone-text defaults are
      // 16px / #000 (vs. the merged-into-rect path's 14px / #333 — those
      // texts are absorbed into a card and inherit a card-text vibe).
      return emitStyledText(
        ctx.slide, el, el.bounds,
        ctx.extraction.elements, ei,
        el.verticallyCentered ? "middle" : "top",
        true, // standalone text honors style.opacity via pptxgenjs transparency
        { color: "#000000", fontSize: 16 },
      );
    case "list":
      return emitList(ctx, el);
    case "table":
      return emitTable(ctx.slide, el);
    case "visual":
    case "image":
      return emitVisual(ctx, el, ei);
    default:
      return assertNever(el);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

/** The gradient when it has the two or more stops a gradient fill needs. */
function multiStopGradient(gradient: Gradient | null | undefined): Gradient | null {
  return gradient && gradient.stops && gradient.stops.length >= 2 ? gradient : null;
}

/** Fill of a rect or polygon shape. A gradient is registered in the registry
 * and painted as a SOLID first-stop placeholder tagged `GRAD_<n>`: stock
 * pptxgenjs can't emit shape gradients, so injectGradientsIntoZip rewrites the
 * tagged `<a:solidFill>` into the real `<a:gradFill>`. `gradientId` is -1 for
 * a solid or absent fill. */
function registerShapeFill(
  registry: Gradient[],
  el: { readonly fill?: string | null; readonly fillAlpha?: number; readonly gradient?: Gradient | null },
): { readonly fill?: ShapeProps["fill"]; readonly objectName?: string; readonly gradientId: number } {
  const gradient = multiStopGradient(el.gradient);
  if (gradient) {
    const gradientId = registry.length;
    registry.push(gradient);
    return { fill: { color: hexToRgb(gradient.stops[0].color) }, objectName: `GRAD_${gradientId}`, gradientId };
  }
  if (el.fill) {
    const fill: NonNullable<ShapeProps["fill"]> = { color: hexToRgb(el.fill) };
    if (typeof el.fillAlpha === "number" && el.fillAlpha < 1) {
      // pptxgenjs `transparency` is percent-transparent: 0 = opaque, 100 = invisible.
      fill.transparency = Math.round((1 - el.fillAlpha) * 100);
    }
    return { fill, gradientId: -1 };
  }
  return { gradientId: -1 };
}

/** An OOXML outer shadow for a CSS box-shadow. OOXML shadow dir: 0°=east,
 * 90°=south — matches CSS offsetY>0=down. */
function outerShadow(shadow: {
  readonly blurPx: number;
  readonly dx: number;
  readonly dy: number;
  readonly color: string;
  readonly opacity: number;
}): PptxGenJS.ShadowProps {
  const { dx, dy } = shadow;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (dx === 0 && dy === 0) angle = 90;
  if (angle < 0) angle += 360;
  return {
    type: "outer",
    blur: Math.min(shadow.blurPx * PX2PT, 30),
    offset: Math.sqrt(dx * dx + dy * dy) * PX2PT,
    color: hexToRgb(shadow.color),
    opacity: shadow.opacity,
    angle: Math.round(angle),
  };
}

/** Text options of one styled run: each field the run does not override is
 * inherited from its container (list item or table cell). */
function inheritedRunOptions(
  style: RunStyle,
  inherited: {
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly color: string;
    readonly bold: boolean;
    readonly italic: boolean;
  },
): TextPropsOptions {
  return {
    fontFace: mapFont(style.fontFamily || inherited.fontFamily),
    fontSize: (style.fontSize || inherited.fontSize) * PX2PT,
    color: hexToRgb(style.color || inherited.color),
    bold: style.fontWeight === "bold" || (!style.fontWeight && inherited.bold),
    italic: style.fontStyle === "italic" || (!style.fontStyle && inherited.italic),
  };
}

/** One painted edge strip of a box with per-side borders. */
interface BorderStrip {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  readonly style: string | undefined;
}

/** The strips (px, inside `box`) of every side of `sides` that has a width
 * and a colour, in top, bottom, left, right order. */
function borderStrips(box: Bounds, sides: BorderSides): BorderStrip[] {
  const { top, bottom, left, right } = sides;
  return [
    top?.width > 0 && top?.color ? { x: box.x, y: box.y, w: box.w, h: top.width, color: top.color, style: top.style } : null,
    bottom?.width > 0 && bottom?.color ? { x: box.x, y: box.y + box.h - bottom.width, w: box.w, h: bottom.width, color: bottom.color, style: bottom.style } : null,
    left?.width > 0 && left?.color ? { x: box.x, y: box.y, w: left.width, h: box.h, color: left.color, style: left.style } : null,
    right?.width > 0 && right?.color ? { x: box.x + box.w - right.width, y: box.y, w: right.width, h: box.h, color: right.color, style: right.style } : null,
  ].filter((strip): strip is BorderStrip => strip !== null);
}

/** Paints a border strip as a filled, outline-free rect. */
function emitSolidStrip(slide: Slide, strip: BorderStrip): void {
  slide.addShape("rect", {
    x: px2in(strip.x), y: px2in(strip.y), w: px2in(strip.w), h: px2in(strip.h),
    fill: { color: hexToRgb(strip.color) },
    line: { type: "none" },
  });
}

// --- rect ---

/** A `rect` element: background, card, pill, circle or stripe. May absorb the
 * text it hosts (see takeMergedText) and paints a non-uniform border over its
 * own fill. */
function emitRect(ctx: EmitContext, el: RectElement, ei: number): void {
  // Rule 1: a fully-transparent element with no content contributes
  // nothing to the slide. Don't emit a phantom shape — it pollutes the
  // outline pane in Slides and confuses post-pass element counting.
  if (!rectPaintsAnything(el)) return;
  const { slide } = ctx;
  const b = el.bounds;

  // Full-slide background. pptxgenjs `slide.background` can only carry a
  // solid fill, so skip this shortcut when the element owns a multi-stop
  // gradient: the rect drops through to the regular shape path, and the
  // post-processing gradFill injector rewrites <a:solidFill> → <a:gradFill>
  // (slide_17 navy→purple body wash).
  if (b.w > SLIDE_W_PX * 0.9 && b.h > SLIDE_H_PX * 0.9 && !multiStopGradient(el.gradient)) {
    if (el.fill) {
      slide.background = { fill: hexToRgb(el.fill) };
    }
    return;
  }

  const cr = el.cornerRadii || { tl: el.borderRadius || 0, tr: el.borderRadius || 0, br: el.borderRadius || 0, bl: el.borderRadius || 0 };
  const corner = rectCornerShape(b, cr);
  const merged = takeMergedText(ctx.extraction.elements, ei, b, corner.isCircle);
  // Non-uniform border info — computed now, painted AFTER content.
  const partialBorder = nonUniformBorderSides(el);
  // Only a bare fill (no absorbed text, no border to lose) may be left to a
  // rasterised clipping host's PNG.
  const bareFill = !merged && !partialBorder;

  // Rasterised top-strip skip: when a rounded clipping host had only its
  // dark top region rasterised (rasterBottomY set), any fill fully above
  // that line — the navy status bar, the black notch, the status dots —
  // is already painted (correctly rounded) by the 2× device PNG. Skip
  // the native overlay so a clamped/duplicate corner can't show over the
  // image. The notch hugs the top edge without touching a rounded corner
  // (so it has no clip patch), which is why this skip lives here rather
  // than in rectHostShape's patch block. Text rides on top via its own element.
  const rby = el.clipMask?.rasterizedHost ? el.clipMask.rasterBottomY : undefined;
  if (typeof rby === "number" && bareFill && b.y + b.h <= rby + 0.5) return;

  const host = rectHostShape(ctx.gradientRegistry, el, cr, corner, bareFill);
  if (host === null) return;
  slide.addShape(host.shapeName, host.opts);

  // Side-rounded masks (0b0110 = right side, 0b1001 = left side) emit
  // as `roundRect` above with all-4 curves; square off the CSS-flat
  // corner pair by painting R×R overlays in the same fill. Skipped
  // for gradient rects so the GRAD_N tag on the parent shape keeps
  // its solitary solidFill match for the injector.
  if (corner.anyRounded && !corner.isCircle && !el.gradient && needsFlatCornerOverlay(cr) && host.opts.fill) {
    emitFlatCornerOverlays(slide, b, cr, host.opts.fill);
  }

  if (partialBorder) emitRectPartialBorder(slide, el, cr, corner.anyRounded, partialBorder);

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
  if (merged) {
    const mb = merged.text.bounds || b;
    // Honour the extractor's verticallyCentered flag instead of
    // hardcoding "middle". Single-line absorbed text (chip labels,
    // card headers, flex-centered content) keeps verticallyCentered=
    // true and stays centered; multi-line absorbed text (slide_30
    // .code-block, padding:14px, multiple <br>s) gets verticallyCentered=
    // false and is emitted "top" so emitStyledText folds the CSS
    // padding-top into the textbox's tIns — first line sits at the
    // padding distance, matching Chrome's top-flowed layout.
    const mergedValign: "top" | "middle" =
      merged.text.verticallyCentered === false ? "top" : "middle";
    emitStyledText(
      slide, merged.text, mb,
      ctx.extraction.elements, merged.index,
      mergedValign,
      false, // merged-rect path historically didn't fold opacity into color
      { color: "#333333", fontSize: 14 },
    );
  }
}

/** False for a rect with no fill, border, shadow or gradient. */
function rectPaintsAnything(r: RectElement): boolean {
  const hasFill = r.fill && r.fill !== "transparent" && (r.fillAlpha === undefined || r.fillAlpha > 0);
  const hasBorder = (r.borderWidth || 0) > 0 && r.borderColor;
  const hasSideBorder = r.borderSides
    ? [r.borderSides.top, r.borderSides.right, r.borderSides.bottom, r.borderSides.left].some((s) => (s?.width || 0) > 0)
    : false;
  const hasShadow = !!r.boxShadow && (Array.isArray(r.boxShadow) ? r.boxShadow.length > 0 : true);
  const hasGradient = !!r.gradient && !!r.gradient.stops && r.gradient.stops.length > 0;
  return !!(hasFill || hasBorder || hasSideBorder || hasShadow || hasGradient);
}

/** The preset a rect's corner radii map to. Per-corner mask → OOXML preset +
 * flips so asymmetric border-radius (e.g. top-only round on a card header)
 * renders correctly rather than getting collapsed into an all-corners
 * roundRect. */
interface RectCornerShape {
  readonly preset: ShapeName;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly isCircle: boolean;
  readonly anyRounded: boolean;
}

function rectCornerShape(b: Bounds, cr: CornerRadii): RectCornerShape {
  const minDim = Math.min(b.w, b.h);
  const isCircle = cr.tl >= minDim * 0.4 && cr.tr >= minDim * 0.4 && cr.br >= minDim * 0.4 && cr.bl >= minDim * 0.4
    && Math.abs(b.w - b.h) < b.w * 0.3;
  const anyRounded = cr.tl > 2 || cr.tr > 2 || cr.br > 2 || cr.bl > 2;
  if (isCircle) return { preset: "ellipse", flipH: false, flipV: false, isCircle, anyRounded };
  if (anyRounded) return { ...cornerPresetFromRadii(cr), isCircle, anyRounded };
  return { preset: "rect", flipH: false, flipV: false, isCircle, anyRounded };
}

/** Finds the text element this rect absorbs, replaces it with a `_skip`
 * sentinel in `elements` (so it is not emitted again), and returns it with its
 * index; null when the rect absorbs nothing.
 *
 * IMPORTANT: only merge if this rect is the *innermost* ancestor that fits
 * the text. Otherwise a deeper-nested rect (with its own bg) will paint over
 * the merged text and bury it (slide_24: text inside 5 nested cards was
 * merged into level-3, then hidden by level-4's solid fill). */
function takeMergedText(
  elements: ExtractedElement[],
  ei: number,
  b: Bounds,
  isCircle: boolean,
): { readonly text: TextElement; readonly index: number } | null {
  if (hostsSeveralTexts(elements, ei, b)) return null;
  for (let ti = ei + 1; ti < elements.length; ti++) {
    const next = elements[ti];
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
      for (let di = ei + 1; di < ti; di++) {
        const mid = elements[di];
        if (mid.type !== "rect" || !mid.bounds || (!mid.fill && !mid.gradient)) continue;
        const mb = mid.bounds;
        const textInsideMid = tcx >= mb.x && tcx <= mb.x + mb.w && tcy >= mb.y && tcy <= mb.y + mb.h;
        if (textInsideMid) return null; // don't merge — let text render on its own
      }
      elements[ti] = { type: "_skip", bounds: nb };
      return { text: next, index: ti };
    }
  }
  return null;
}

/** True when more than one text element after `ei` is centred inside `b`
 * (before the scan passes the rect's vertical extent). A pull-quote
 * (`.pull-quote { bg + border-left } > <p> + .attr`) hosts TWO block texts —
 * merging just the first would center it vertically and push the `.attr`
 * caption off the decorated box. When multiple texts live inside, skip merging
 * and let each text emit at its own bounds so the rect acts as a pure
 * background + accent stripe. */
function hostsSeveralTexts(elements: readonly ExtractedElement[], ei: number, b: Bounds): boolean {
  let insideTextCount = 0;
  for (let ti = ei + 1; ti < elements.length; ti++) {
    const next = elements[ti];
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
  return insideTextCount > 1;
}

/** The rect's border sides when they are NOT uniform and at least one side
 * has a width and a colour; such borders are painted as separate strips. */
function nonUniformBorderSides(el: RectElement): BorderSides | null {
  const bs = el.borderSides;
  if (!bs || el.borderUniform) return null;
  const anySide = (bs.top?.width > 0 && bs.top?.color) || (bs.right?.width > 0 && bs.right?.color) ||
    (bs.bottom?.width > 0 && bs.bottom?.color) || (bs.left?.width > 0 && bs.left?.color);
  return anySide ? bs : null;
}

/** The rect's own content shape: fill, corners, uniform border, shadow,
 * rotation and the clip by a rounded ancestor. Null when a rasterised clipping
 * host already paints it (only for a `bareFill`). May rewrite the angle of the
 * gradient it registers. */
function rectHostShape(
  gradientRegistry: Gradient[],
  el: RectElement,
  cr: CornerRadii,
  corner: RectCornerShape,
  bareFill: boolean,
): { readonly shapeName: ShapeName; readonly opts: ShapeProps } | null {
  const b = el.bounds;
  const opts: ShapeProps = {
    x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
    line: { type: "none" },
  };

  // Fill (gradient tagged via objectName for post-processing — pptxgenjs has no gradient API).
  // `gradientId` is kept so the clip path (applyClipPatch) can angle-compensate
  // the registered gradient when it flips or rotates the shape; opts.fill is
  // re-synced from the registry just before returning.
  const paint = registerShapeFill(gradientRegistry, el);
  if (paint.fill) opts.fill = paint.fill;
  if (paint.objectName) opts.objectName = paint.objectName;
  const gradientId = paint.gradientId;

  // Corner radius (pptxgenjs rectRadius is in inches).
  // Clamp to half the shorter dimension — CSS `border-radius: 50px` on
  // a 18px-tall pill gives radius > h/2, which produces an invalid
  // OOXML `adj` value; Google Slides then renders the shape as empty
  // (no fill, no outline), leaving the tag's text floating on the slide
  // background. Clamping yields a proper stadium/pill shape.
  if (corner.anyRounded && !corner.isCircle) {
    const maxR = Math.min(b.w, b.h) / 2;
    const maxRadiusPx = Math.max(cr.tl, cr.tr, cr.br, cr.bl);
    opts.rectRadius = px2in(Math.min(maxRadiusPx, maxR));
    if (corner.flipH) opts.flipH = true;
    if (corner.flipV) opts.flipV = true;
  }

  // Border outline (uniform)
  if (!nonUniformBorderSides(el) && el.borderUniform && el.borderWidth !== undefined && el.borderWidth > 0 && el.borderColor) {
    const borderW = el.borderWidth;
    opts.line = {
      color: hexToRgb(el.borderColor),
      width: Math.min(borderW * PX2PT, 6),
      // Thin (≤2px) dashed borders use the finer sysDash cadence;
      // prstDash="dash" renders 1px hairline dividers as coarse long
      // dashes that don't match the CSS look (slide_33 .out).
      dashType: asDashType(el.borderStyle === "dashed" ? (borderW <= 2 ? "sysDash" : "dash") : el.borderStyle === "dotted" ? "dot" : "solid"),
    };
  }

  // Box shadow
  if (el.boxShadow && ((el.boxShadow.blur ?? 0) > 0 || el.boxShadow.offsetX !== 0 || el.boxShadow.offsetY !== 0)) {
    opts.shadow = outerShadow({
      blurPx: el.boxShadow.blur ?? 0,
      dx: el.boxShadow.offsetX || 0,
      dy: el.boxShadow.offsetY || 0,
      color: el.boxShadow.color || "#000000",
      opacity: el.boxShadow.alpha ?? 0.25,
    });
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
  // When a child is clipped by a rounded parent, the host MUST itself
  // become the clipped, correctly-cornered shape — adopting the patch's
  // bounds and rounding ONLY the corners that coincide with a rounded
  // parent corner (computeClippedPatch already zeroed the non-touching
  // ones). The previous "rounded underlay + full-square host on top"
  // was a fake clip: the square host re-squared every corner. Reuse the
  // existing [TL,TR,BR,BL] → ROUND_* preset mapping so e.g. a left-flush
  // pill → roundRect+flat-right overlays (left rounded only), a top
  // stripe / status-bar → round2SameRect (top rounded, bottom square).
  // A GRADIENT host keeps its GRAD_<n> objectName: that tag is what
  // injectGradientsIntoZip matches on (slide_32 P0/P1/P2 were invisible
  // when the clip path clobbered it).
  let shapeName = corner.preset;
  const patch = computeClippedPatch(b, el.clipMask);
  if (patch && opts.fill) {
    if (bareFill && rasterHostPaintsPatch(el.clipMask, patch)) return null;
    shapeName = applyClipPatch(opts, patch, gradientRegistry, gradientId);
  }

  // Keep the solid placeholder in sync with the (possibly angle-mutated)
  // registry entry; injectGradientsIntoZip reads the registry directly for
  // the final <a:gradFill>, so only the first-stop placeholder matters here.
  if (gradientId >= 0) opts.fill = { color: hexToRgb(gradientRegistry[gradientId].stops[0].color) };

  return { shapeName, opts };
}

/** Un-representable corner: the clipped region needs a radius larger than 50%
 * of its own dimension (e.g. slide_12's navy status-bar strip / notch hugging
 * the device top — radius 32px on a ~44px strip). A native roundRect's `adj`
 * maxes at 50% ("only goes halfway"), so emitting one would clamp the curve
 * and the squared shoulder would poke past the device's true rounded edge.
 * True when the clipping host was rasterised WHOLE to a 2× PNG
 * (rasterizedHost, no top-strip split) and the patch needs such a corner: that
 * backing image already paints the correct rounded chrome, so the native
 * overlay is skipped. Sub-50% corners (e.g. the tall gradient screen at the
 * device bottom) stay native. The top-strip case is handled in emitRect
 * before the patch is even computed, so it also catches the notch, which hugs
 * the top edge without touching a rounded corner. */
function rasterHostPaintsPatch(mask: ClipMask | null | undefined, patch: PatchGeometry): boolean {
  if (!mask?.rasterizedHost || typeof mask.rasterBottomY === "number") return false;
  const mcr = mask.cornerRadii;
  const pb0 = patch.bounds;
  const capR = Math.min(pb0.w, pb0.h) / 2;
  const reqR = Math.max(
    patch.cornerRadii.tl > 0 ? mcr.tl : 0,
    patch.cornerRadii.tr > 0 ? mcr.tr : 0,
    patch.cornerRadii.br > 0 ? mcr.br : 0,
    patch.cornerRadii.bl > 0 ? mcr.bl : 0,
  );
  return reqR > capR + 0.5;
}

/** Turns the host shape `opts` into the clipped patch: its bounds and the
 * preset of its rounded corners. Returns the preset to draw. A registered
 * gradient (`gradientId >= 0`) is pre-compensated for the flip or rotation the
 * preset needs, so its VISIBLE direction is unchanged. */
function applyClipPatch(
  opts: ShapeProps,
  patch: PatchGeometry,
  gradientRegistry: Gradient[],
  gradientId: number,
): ShapeName {
  const pcr = patch.cornerRadii;
  const pcp = cornerPresetFromRadii(pcr);
  const pb = patch.bounds;
  opts.x = px2in(pb.x); opts.y = px2in(pb.y);
  opts.w = px2in(pb.w); opts.h = px2in(pb.h);
  if (pcp.preset === "rect") return pcp.preset;
  opts.rectRadius = px2in(Math.max(pcr.tl, pcr.tr, pcr.br, pcr.bl));
  opts.flipH = pcp.flipH || undefined;
  opts.flipV = pcp.flipV || undefined;
  // A gradient fill rotates WITH the shape (rotWithShape="1"), so the
  // corner-preset flip(s) mirror the fill too — a 135° screen gradient
  // on a bottom-rounded device screen (round2SameRect + flipV) renders
  // upside-down (slide_12). Pre-mirror the stored CSS angle by the same
  // flip(s) so the VISIBLE direction is unchanged: vertical flip
  // θ→180−θ, horizontal flip θ→360−θ (they compose). The side-rounded
  // 90/270 path below handles the rotation case (angle−rot).
  if (gradientId >= 0 && (pcp.flipH || pcp.flipV)) {
    const g = gradientRegistry[gradientId];
    if (g && g.type !== "radial") {
      let a = (((g.angle ?? 180) % 360) + 360) % 360;
      if (pcp.flipV) a = (((180 - a) % 360) + 360) % 360;
      if (pcp.flipH) a = (((360 - a) % 360) + 360) % 360;
      gradientRegistry[gradientId] = { ...g, angle: a };
    }
  }
  if (!needsFlatCornerOverlay(pcr)) return pcp.preset;
  // Side-rounded clip (TL+BL / TR+BR) has no direct OOXML preset.
  // The old path fell back to an all-corners `roundRect` + solid R×R
  // corner overlays to square the flat pair — but on a GRADIENT host
  // those overlays use the solid first-stop fallback fill, painting a
  // mismatched solid block over the gradient and leaving the "straight"
  // edge rounded with artifacts (slide_32 P0/P1/P2 pills clipped at the
  // left edge of a rounded `.row`). Per the user's guidance: because
  // the radii are < half the dimension, draw it as a SINGLE
  // `round2SameRect` (rounds the TOP pair by default) rotated so the
  // rounded pair lands on the correct side — 270° → left-rounded,
  // 90° → right-rounded. No overlays, gradient injects onto the one
  // shape. Rotating swaps the footprint's w/h, so emit the un-rotated
  // shape with swapped ext, recentered on the patch center.
  const leftRounded = pcr.tl > 2 && pcr.bl > 2; // else right-rounded (TR+BR)
  const rot = leftRounded ? 270 : 90;
  const cx = pb.x + pb.w / 2;
  const cy = pb.y + pb.h / 2;
  const W0 = pb.h; // un-rotated width  (becomes footprint height after 90/270)
  const H0 = pb.w; // un-rotated height (becomes footprint width)
  const rPx = Math.min(
    Math.max(pcr.tl, pcr.tr, pcr.br, pcr.bl),
    Math.min(W0, H0) / 2,
  );
  opts.x = px2in(cx - W0 / 2);
  opts.y = px2in(cy - H0 / 2);
  opts.w = px2in(W0);
  opts.h = px2in(H0);
  opts.rectRadius = px2in(rPx);
  opts.rotate = rot;
  opts.flipH = undefined;
  opts.flipV = undefined;
  // Gradient fill rotates WITH the shape (rotWithShape="1"), so
  // pre-rotate the stored angle by -rot to keep the visible
  // direction unchanged.
  if (gradientId >= 0) {
    const g = gradientRegistry[gradientId];
    if (g && g.type !== "radial") {
      gradientRegistry[gradientId] = {
        ...g,
        angle: (((g.angle ?? 180) - rot) % 360 + 360) % 360,
      };
    }
  }
  return "round2SameRect";
}

/** Paints non-uniform border strips OVER the content shape so they survive
 * the bg fill (otherwise a 4px bottom-border on a white card disappears under
 * the white fill rect). A rounded, filled card takes the sandwich when it
 * applies; everything else gets flat strips. */
function emitRectPartialBorder(
  slide: Slide,
  el: RectElement,
  cr: CornerRadii,
  anyRounded: boolean,
  bs: BorderSides,
): void {
  if (anyRounded && el.fill && emitRoundedBorderSandwich(slide, el.bounds, cr, bs, { fill: el.fill, borderRadius: el.borderRadius ?? 0 })) return;
  for (const side of borderStrips(el.bounds, bs)) {
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
          // Thin (≤2px) dashed → finer sysDash cadence (slide_33
          // .out `border-top: 1px dashed`); coarse "dash" only for
          // thicker borders.
          dashType: side.style === "dashed" ? ((isHoriz ? side.h : side.w) <= 2 ? "sysDash" : "dash") : "sysDot",
        },
      });
    } else {
      emitSolidStrip(slide, side);
    }
  }
}

/** Rounded + partial borders, painted so the bordered sides follow the curve
 * (a flat strip along the edge would cut straight across the rounded corners,
 * slide_09). Two-rect sandwich:
 *   1. Outer rounded rect filled with the border color.
 *   2. Inner rounded rect filled with the card's own background, inset by
 *      (borderWidth) on each bordered side and 0 on the non-bordered sides.
 * Only the bordered sides' strips remain visible, and they curve along the
 * shared border-radius. Works for any single side, any combination, any
 * radius. Returns false (painting nothing) when any bordered side is
 * dashed/dotted (the inner-fill trick would blur the dashes), when the bordered
 * sides disagree on color, or when no bordered side touches a rounded corner. */
function emitRoundedBorderSandwich(
  slide: Slide,
  b: Bounds,
  cr: CornerRadii,
  bs: BorderSides,
  card: { readonly fill: string; readonly borderRadius: number },
): boolean {
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
  if (!(sameColor && allSolid && borderColors.length > 0 && roundedCornerOnBorderedSide)) return false;
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
    sandwichOuterOpts.rectRadius = px2in(card.borderRadius);
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
    fill: { color: hexToRgb(card.fill) },
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
  return true;
}

// --- triangle, poly, line ---

/** CSS border-triangle arrow → pptxgenjs `triangle` preset (apex-up by
 * default). `rotate` selects which way the apex points: 0=up, 90=right,
 * 180=down, 270=left.
 *
 * OOXML rotation rotates the shape about the bbox center but keeps the bbox
 * axis-aligned and fixed in size. A 12×16 triangle rotated 90° would render
 * inside a 12×16 slot, clipping apex/base. For 90° and 270° rotations we swap
 * w and h around the center so the post-rotation shape fits its visual
 * extent. */
function emitTriangle(slide: Slide, el: TriangleElement): void {
  const b = el.bounds;
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
}

/** CSS `clip-path: polygon(...)` host → native `custGeom` freeform. Emitting
 * the polygon as a real Slides shape (instead of a rasterised PNG) makes
 * trapezoids/arbitrary convex shapes editable and lets them carry a solid OR
 * linear-gradient fill. slide_13's four funnel stages are the motivating case:
 * four screenshots collapse into four shapes. */
function emitPoly(ctx: EmitContext, el: PolyElement): void {
  const b = el.bounds;
  const pts = el.points || [];
  if (pts.length < 3) return;
  // Points arrive as px offsets relative to the shape's bbox top-left;
  // custGeom expects them in the frame's own inch coordinate space.
  const polyPoints: NonNullable<ShapeProps["points"]> = pts.map((p) => ({
    x: px2in(p.x), y: px2in(p.y),
  }));
  polyPoints.push({ close: true });
  const polyOpts: ShapeProps = {
    x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
    points: polyPoints,
    line: { type: "none" },
  };
  const paint = registerShapeFill(ctx.gradientRegistry, el);
  if (paint.fill) polyOpts.fill = paint.fill;
  if (paint.objectName) polyOpts.objectName = paint.objectName;
  // `custGeom` is a valid runtime shape (pptxgen.es.js emits <a:custGeom>)
  // but the published SHAPE_NAME union omits it — cast like the preset path.
  ctx.slide.addShape("custGeom" as Parameters<Slide["addShape"]>[0], polyOpts);
}

/** A hairline: endpoint-defined (`x1/y1/x2/y2`), or a thin decorative strip
 * drawn along its long axis. */
function emitLine(slide: Slide, el: LineElement): void {
  if (
    typeof el.x1 === "number" && typeof el.y1 === "number" &&
    typeof el.x2 === "number" && typeof el.y2 === "number"
  ) {
    const dx = el.x2 - el.x1;
    const dy = el.y2 - el.y1;
    const lineOpts: ShapeProps = {
      x: px2in(Math.min(el.x1, el.x2)),
      y: px2in(Math.min(el.y1, el.y2)),
      w: px2in(Math.abs(dx)),
      h: px2in(Math.abs(dy)),
      line: {
        color: hexToRgb(el.color || "#000000"),
        width: Math.max(0.5, (el.strokeWidth || 1) * PX2PT),
      },
    };
    if (dx * dy < 0) lineOpts.flipV = true;
    slide.addShape("line", lineOpts);
    return;
  }
  const b = el.bounds;
  const isVertical = b.h > b.w * 2;
  const stroke: ShapeLineProps = {
    color: hexToRgb(el.color || "#000000"),
    width: Math.max(0.5, isVertical ? b.w * PX2PT : b.h * PX2PT),
  };
  // Decorative dashed strips (e.g. slide_33 `.road::before` centerline)
  // carry a dashType from extract-dom.
  // TODO(types): `dashType` is a raw OOXML preset string from extract-dom;
  // the published pptxgenjs union is narrower than the valid preset set.
  if (el.dashType && el.dashType !== "solid") stroke.dashType = el.dashType as DashTypeValue;
  // An OOXML line stroke is CENTERED on its position, so a decorative
  // strip must sit on its CENTER axis, not its top/left edge. The strip
  // bounds carry the full box (e.g. slide_33 `.road::before`: top:5px,
  // height:4px → visual center is the road's center). Placing the stroke
  // at `b.y` would render `b.h/2` (~2px) too high; center it instead.
  slide.addShape("line", {
    x: px2in(isVertical ? b.x + b.w / 2 : b.x),
    y: px2in(isVertical ? b.y : b.y + b.h / 2),
    w: isVertical ? 0 : px2in(b.w),
    h: isVertical ? px2in(b.h) : 0,
    line: stroke,
  });
}

// --- list ---

/** Lists come in two flavors:
 *   1. Pure-text lists → render natively with pptxgenjs bullet/number so the
 *      user sees real disc/decimal markers (Google Slides keeps them editable
 *      as a real bulleted list).
 *   2. Styled lists (any <li> has borderBottom, bg, or its own border/radius)
 *      → render item-by-item so we can paint per-row boxes, separators, and
 *      mixed backgrounds.
 * The list's container background (bg+border+radius on the <ul>/<ol> itself)
 * is emitted as a separate "rect" element upstream in walk(). */
function emitList(ctx: EmitContext, el: ListElement): void {
  const items: readonly ListItem[] = (el.items || []).filter((it) => (it.text || "").trim().length > 0);
  if (items.length === 0) return;
  if (el.anyStyledItem) emitStyledList(ctx.slide, el, items);
  else emitPlainList(ctx, el, items);
}

/** Options of a list marker run typed as text, in the item's font. */
function listMarkerOptions(it: ListItem, listStyle: ElementStyle, color: string): TextPropsOptions {
  return {
    fontFace: mapFont(it.fontFamily || listStyle.fontFamily || "Arial"),
    fontSize: (it.fontSize || listStyle.fontSize || 14) * PX2PT,
    color: hexToRgb(color),
  };
}

/** What a list item's styled runs inherit from the item and the list. */
function listItemRunInheritance(it: ListItem, listStyle: ElementStyle): Parameters<typeof inheritedRunOptions>[1] {
  return {
    fontFamily: it.fontFamily || listStyle.fontFamily || "Arial",
    fontSize: it.fontSize || listStyle.fontSize || 14,
    color: it.color || listStyle.color || "#333333",
    bold: it.fontWeight === "bold",
    italic: it.fontStyle === "italic",
  };
}

/** Pure text — a bulleted/numbered list in a single textbox.
 *
 * Native pptxgenjs `bullet` (→ `<a:buAutoNum>`/`<a:buChar>`) works only when
 * the paragraph is a single run. As soon as an item has multiple runs,
 * pptxgenjs writes a second <a:pPr> with <a:buNone/> between runs, and Google
 * Slides reads that and drops the marker. Workaround: when ANY item has styled
 * runs, prepend the marker as a plain text run and skip `bullet`. */
function emitPlainList(ctx: EmitContext, el: ListElement, items: readonly ListItem[]): void {
  const b = el.bounds;
  const listStyle = el.style || {};
  const ordered = !!el.ordered;
  const noListStyle = (el.listStyleType || "disc") === "none";
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
  // A `list-style:none` list normally has no markers, EXCEPT when
  // each <li> draws a CSS dot via `::before { content:''; background }`
  // (slide_30 Key Priorities) — those filled dots ARE the bullets and
  // were being dropped entirely ("There are no list items"). Those
  // dot-bullet lists now go NATIVE (see useNativeBullet below); a
  // literal-glyph `::before { content:'•'; color }` list (slide_11
  // SWOT) keeps its prior plain-text rendering untouched.
  const anyDotBullet = noListStyle && !ordered && items.some((it) => !!it.bulletColor && it.bulletIsDot);
  // list-style:none with a LITERAL-GLYPH ::before ('•', color) — slide_11
  // SWOT — was dropping its markers entirely; revive them too.
  const anyGlyphBullet = noListStyle && !ordered && items.some((it) => !!it.bulletColor && !it.bulletIsDot);
  const anyPerItemBulletColor = (!noListStyle && !ordered && items.some((it) => !!it.bulletColor)) || anyDotBullet || anyGlyphBullet;
  // Exclude ORDERED lists from the native autonumber path: pptxgenjs
  // hardcodes its autonumber buFont to the theme major font (Calibri
  // Light), so "1." markers render smaller/thinner than the item's
  // Arial (slide_12). The text-marker fallback (`marker + it.text`)
  // emits the number in the item's own font/size instead.
  //
  // `anyDotBullet` lists (list-style:none + CSS dot ::before,
  // slide_30) take the NATIVE path too: user feedback wave-13 —
  // "Not a list element, just text with bullets" — the typed
  // '•  ' glyph run is not a real Slides list. Per-item bullet
  // COLOR (which pptxgenjs cannot express) is recorded in
  // bulletColorRegistry and injected as <a:buClr> by the
  // injectBulletColorsIntoZip post-patch.
  const useNativeBullet = (!noListStyle || anyDotBullet) && !anyItemHasStyledRuns && !ordered;
  const paragraphs = items.map((it: ListItem, ii: number) => {
    const marker = ordered ? `${ii + 1}.  ` : "•  ";
    const markerColor = it.bulletColor || it.color || listStyle.color || "#333333";
    const rs: readonly TextRun[] | null = (it.runs && it.runs.length > 0) ? it.runs.filter((r) => r.text.length > 0) : null;
    if (rs && rs.length > 0 && rs.some((r) => r.style !== null)) {
      const out: TextProps[] = [];
      if (!useNativeBullet && (!noListStyle || anyDotBullet)) {
        // Plain marker prefix coloured per-item (falls back to the
        // item's text colour when there is no per-item bullet).
        // `anyDotBullet` lets a `list-style:none` list with CSS dot
        // markers still emit them in front of styled-run items.
        out.push({ text: marker, options: listMarkerOptions(it, listStyle, markerColor) });
      }
      rs.forEach((run: TextRun, ri: number) => {
        const opts = inheritedRunOptions(run.style || {}, listItemRunInheritance(it, listStyle));
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
      // CSS-dot items (::before filled box) get ● (U+25CF) so the
      // native marker approximates the original fat 8×8 dot — the
      // default • renders visibly smaller than the CSS dot.
      baseOpts.bullet = it.bulletIsDot && it.bulletColor
        ? { characterCode: "25CF", indent: 12 }
        : { indent: 12 };
      return [{ text: it.text, options: baseOpts }];
    }
    // Colored marker prefix when the list carries per-item bullet
    // colours (e.g. slide_30 Key Priorities). Split into a
    // coloured marker run + the item-coloured text run so each
    // row's "●" matches its CSS ::before background while body
    // text keeps the item colour.
    if (!ordered && anyPerItemBulletColor) {
      return [
        { text: marker, options: listMarkerOptions(it, listStyle, markerColor) },
        { text: it.text, options: { ...baseOpts } },
      ];
    }
    return [{ text: noListStyle ? it.text : marker + it.text, options: baseOpts }];
  }).flat();

  const layout = plainListLayout(el, items[0] || {});
  // Per-item native-bullet colors ride the side-band registry
  // (pptxgenjs has no <a:buClr> support); the BUCLR_<n> objectName
  // tag is how injectBulletColorsIntoZip finds this textbox. One
  // registry slot per item paragraph, null = keep default marker.
  const nativeBulletColors: (string | null)[] = useNativeBullet
    ? items.map((it) => (it.bulletColor ? hexToRgb(it.bulletColor) : null))
    : [];
  const needBulletClr = nativeBulletColors.some((c) => c !== null);
  const bulletClrName = needBulletClr ? `BUCLR_${ctx.bulletColorRegistry.length}` : undefined;
  if (needBulletClr) ctx.bulletColorRegistry.push({ colors: nativeBulletColors });
  ctx.slide.addText(paragraphs, {
    x: px2in(b.x), y: px2in(layout.y), w: px2in(b.w), h: px2in(layout.h),
    valign: "top",
    align: "left",
    fill: { type: "none" },
    line: { type: "none" },
    margin: layout.topInsetPt > 0 ? [0, 0, 0, layout.topInsetPt] : 0,
    paraSpaceAfter: layout.paraSpaceAfterPt > 0 ? layout.paraSpaceAfterPt : undefined,
    lineSpacingMultiple: layout.lineSpacingMultiple,
    objectName: bulletClrName,
  });
}

/** Vertical placement and spacing of a plain list's textbox, from its first
 * item's line-height, margin and padding. */
function plainListLayout(el: ListElement, firstIt: ListItem): {
  readonly y: number;
  readonly h: number;
  readonly topInsetPt: number;
  readonly paraSpaceAfterPt: number;
  readonly lineSpacingMultiple: number | undefined;
} {
  const b = el.bounds;
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
  //
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
  // First-line leading compensation. `paraSpaceAfter` spaces items
  // BETWEEN each other but never adds the leading Chrome renders ABOVE
  // the FIRST line: the first <li>'s padding-top + half-leading
  // ((ratio−1)/2 × font). Google Slides anchors the first paragraph at
  // the textbox top, so the whole list rides up and packs against the
  // card header — the user's "positioning of the text is too high"
  // report on slide_11 (~7px: li padding-top 4px + half-leading 3.5px
  // @ line-height 1.5). Fold that first-line lead into the textbox top
  // inset. No-op for tight/zero-padding lists (lead ≤ 1px).
  const liPadTopPx = (firstIt.padding && firstIt.padding.top) || 0;
  const liFirstLineLeadPx =
    liPadTopPx + (liUseRatio && firstIt.fontSize ? ((liRatio - 1) / 2) * firstIt.fontSize : 0);
  // When extract-dom measured Chrome's first baseline, place Google's on it instead
  // (slides-first-baseline.ts): the lead above is a stylesheet half-leading, but Google
  // puts a line's extra spacing below the glyphs, so slide_11's Roboto items at 1.5 drew
  // about 1.5 px low with it.
  const listPlacement =
    typeof el.firstBaselineY === "number" && typeof el.firstLineFontSize === "number" && el.firstLineFontSize > 0
      ? topAnchoredTextPlacement({
          boxTopPx: b.y,
          boxHeightPx: b.h,
          chromeFirstBaselinePx: el.firstBaselineY,
          lineSpacingMultiple: liUseRatio ? liEmittedRatio : 1,
          firstLineFontSizePx: el.firstLineFontSize,
        })
      : null;
  return {
    y: listPlacement === null ? b.y : listPlacement.topPx,
    h: listPlacement === null ? b.h : listPlacement.heightPx,
    topInsetPt: listPlacement !== null
      ? listPlacement.topInsetPx * PX2PT
      : liFirstLineLeadPx > 1 ? liFirstLineLeadPx * PX2PT : 0,
    paraSpaceAfterPt,
    lineSpacingMultiple: liUseRatio ? liEmittedRatio : undefined,
  };
}

/** Styled list — per-item rendering with optional per-row box. Semantically
 * still a list: prepend the bullet/number marker to each item's text so
 * disc/decimal markers survive the split. Suppress markers only when the item
 * is pill-like (large radius, content-fit width) — in that case the visual is
 * the pill chip, not a list row. */
function emitStyledList(slide: Slide, el: ListElement, items: readonly ListItem[]): void {
  const b = el.bounds;
  const rowH = b.h / items.length;
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    const ib = it.bounds || { x: b.x, y: b.y + ii * rowH, w: b.w, h: rowH };
    emitStyledListItem(slide, el, it, ii, ib);
  }
}

function emitStyledListItem(slide: Slide, el: ListElement, it: ListItem, ii: number, ib: Bounds): void {
  const listStyle = el.style || {};
  const ordered = !!el.ordered;
  const noListStyle = (el.listStyleType || "disc") === "none";
  const text = it.text || "";

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
        dashType: asDashType(bs.top.style === "dashed" ? "dash" : bs.top.style === "dotted" ? "dot" : "solid"),
      };
    }
    const rounded = it.borderRadius && it.borderRadius > 0;
    if (rounded) rectOpts.rectRadius = px2in(it.borderRadius);
    slide.addShape(rounded ? "roundRect" : "rect", rectOpts);
  }
  if (!uniformItemBorder && hasAnyItemBorder) {
    for (const strip of borderStrips(ib, bs)) emitSolidStrip(slide, strip);
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

  // Marker decision is per-LIST, not per-item. The per-item rule was
  // wrong because (a) :last-child losing its border-bottom
  // regressed into "marker added", and (b) a highlighted row with
  // `background` inside a card container wrongly flipped into a
  // marker row.
  //
  // `el.isContainerList` is true when the <ul>/<ol> has its own
  // bg/border/radius OR a majority of items use border-bottom as
  // row separator. In both cases the container is the visual,
  // rows inside never get markers.
  const showMarker = !el.isContainerList && !isPillLike && !noListStyle;
  const marker = ordered ? `${ii + 1}.  ` : "•  ";

  if (it.runs && it.runs.length > 0 && it.runs.some((r) => r.style !== null)) {
    const textRuns: TextProps[] = [];
    if (showMarker) {
      textRuns.push({ text: marker, options: listMarkerOptions(it, listStyle, it.color || listStyle.color || "#333333") });
    }
    for (const run of it.runs.filter((r) => r.text.length > 0)) {
      textRuns.push({ text: run.text, options: inheritedRunOptions(run.style || {}, listItemRunInheritance(it, listStyle)) });
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

// --- table ---

/** Rule 2: every HTML table emits as a native pptx `<a:tbl>`, except the
 * `<table data-shape-render>` debug path (renderTableAsShapes). */
function emitTable(slide: Slide, el: TableElement): void {
  // DEBUG path — `<table data-shape-render="true|empty">`. Render
  // the entire table via per-cell addShape rects + per-edge filled
  // rect borders (see renderTableAsShapes). Bypasses native `<a:tbl>` so we can
  // isolate geometry issues from `<a:tc>` rasterisation quirks.
  if (el.renderAsShapes) {
    renderTableAsShapes(slide, el);
    return;
  }
  const rows = el.rows || [];
  const tableCornerRadii = el.cornerRadii || { tl: 0, tr: 0, br: 0, bl: 0 };
  const tableHasRadius = (el.borderRadius || 0) > 0;
  // tablesFormat=native renders a real, editable <a:tbl> which CANNOT
  // express rounded corners — so a rounded table here renders SQUARE.
  // Warn so the reviewer knows to re-run with tablesFormat=baked (which
  // rasterises the table, preserving rounded corners + all elements).
  // In baked mode the table was retyped to an image upstream
  // (extract-dom / io) and never reaches this native branch.
  // (Rounded-corner edge/corner patching — synthMask + shape-twice
  // underlays — was removed for the same reason.)
  const anyCornerRadius = tableHasRadius
    || tableCornerRadii.tl > 0 || tableCornerRadii.tr > 0
    || tableCornerRadii.br > 0 || tableCornerRadii.bl > 0;
  if (anyCornerRadius) {
    console.warn("  ⚠ tablesFormat=native: rounded-corner table detected — "
      + "native tables render SQUARE corners. Re-run with --tables-format baked "
      + "for rounded corners + full fidelity.");
  }
  if (rows.length > 0) {
    emitNativeTable(slide, el, rows, tableHasRadius);
    return;
  }
  // A table without rows has no cells to draw; a rounded one still gets its
  // outer frame.
  if (tableHasRadius) emitTableOutline(slide, el, tableCornerRadii);
}

/** One side of a native table cell's `border: [t, r, b, l]` option. */
type BorderOpt = { type: "solid" | "dash" | "sysDot" | "none"; pt: number; color: string };

/** Per-side border of a native pptxgenjs cell. pptxgenjs's table cell `border`
 * option accepts a `[t, r, b, l]` array of `{type, pt, color}` (verified at
 * pptxgen.es.js:5341-5358) which emits `<a:lnT/lnR/lnB/lnL>` per cell —
 * exactly what CSS encodes (slide_15 "not a table in sides"). */
function sideToBorderOpt(side: BorderSide | undefined): BorderOpt {
  if (!side || !side.width || side.width <= 0) return { type: "none", pt: 0, color: "000000" };
  const dashType: BorderOpt["type"] = side.style === "dashed" ? "dash" : side.style === "dotted" ? "sysDot" : "solid";
  return { type: dashType, pt: Math.max(0.5, side.width * PX2PT), color: hexToRgb(side.color || "#000000") };
}

/** The native, editable `<a:tbl>`. */
function emitNativeTable(slide: Slide, el: TableElement, rows: readonly TableRow[], tableHasRadius: boolean): void {
  // The table-level border (declared on the `<table>` element itself, e.g.
  // `table.rounded { border:1px solid #d1d5db }`). CSS does NOT bubble this
  // into per-cell `getComputedStyle()`, so it is grafted onto the outer-edge
  // cells' tuples (see nativeTableCell).
  const tableBorderSides = el.borderSides;
  // True when a rounded post-table outline ring would be drawn on top
  // of the native <a:tbl>. When it WOULD draw, folding the table border
  // into native edge cells double-inks the perimeter:
  // the outline's `algn="in"` 1 px stroke sits at the rect's inner
  // edge, but native cell borders use `algn="ctr"` and straddle the
  // cell edge — the two paint at DIFFERENT pixels and combine to a
  // ~1.5 px gray bar (slide_17 L1 "double border on right side").
  // Suppress the fold in that case; the outline alone carries the
  // perimeter. Flat tables (no outline) keep the fold so they still
  // have an outer frame.
  const foldTableBorder = !(tableHasRadius
    && !!tableBorderSides
    && (tableBorderSides.top?.width || 0) > 0
    && !!tableBorderSides.top?.color);
  const geometry = nativeTableGeometry(el, rows);
  const grid = { rowCount: rows.length, colCount: rows[0].length };
  const tableRows = rows.map((row: readonly TableCell[], ri: number) => row.map((cell: TableCell, ci: number) =>
    nativeTableCell(cell, { ri, ci, ...grid, tableBg: el.bgColor || undefined, foldedBorder: foldTableBorder ? tableBorderSides ?? null : null })));
  slide.addTable(tableRows, {
    ...geometry,
    autoPage: false,
    fontFace: "Arial",
  });
}

/** Frame and grid of the native table, in inches.
 *
 * Quantize all table geometry to 1/100" so the graphicFrame and every
 * gridline land on the SAME source-inch lattice. Without quantization each
 * edge sits at arbitrary fractional inches (the px → inch conversion is
 * `* 10/1280 = * 0.0078125` per CSS pixel), and Slides rasterises shapes vs
 * <a:graphicFrame> cells onto display pixels independently → 1-2 display-px
 * seams at every boundary (the "missing white border" family of
 * complaints). */
function nativeTableGeometry(el: TableElement, rows: readonly TableRow[]): {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly colW: number[];
  readonly rowH: number[];
} {
  const b = el.bounds;
  const tableBorderSides = el.borderSides;
  const rowCount = rows.length;
  const q = (v: number): number => Math.round(v * 100) / 100;
  // Content extent = table bounds minus the outer border (the
  // per-`<td>` bounds exclude the table's CSS border). The native
  // cells must span EXACTLY this, edge to edge.
  const twL0 = px2in(tableBorderSides?.left?.width || 0);
  const twR0 = px2in(tableBorderSides?.right?.width || 0);
  const twT0 = px2in(tableBorderSides?.top?.width || 0);
  const twB0 = px2in(tableBorderSides?.bottom?.width || 0);
  // EDGE-ANCHORED table coords. Quantise the ABSOLUTE edges, never
  // position+size separately: `q(px2in(b.x)) + q(px2in(b.w))`
  // double-rounds (b.x 5.1875→5.19 AND b.w 4.125→4.13) and pushes
  // the right/bottom edge ~1-2 display-px PAST the table box — the
  // "slightly misaligned right/bottom edge" the user flagged on
  // every corner. `q(px2in(b.x + b.w))` rounds the edge once, so
  // the table spans exactly [xL,xR]×[yT,yB].
  const xL = q(px2in(b.x));
  const xR = q(px2in(b.x + b.w));
  const yT = q(px2in(b.y));
  const yB = q(px2in(b.y + b.h));
  const contentW = (xR - xL) - twL0 - twR0;
  const contentH = (yB - yT) - twT0 - twB0;
  // Column geometry — DRIFT-FREE and edge-anchored. Per-`<td>`
  // bounds sum to ~1 px less than `contentW` (extraction floors
  // each width), so scale the raw widths to fill `contentW`
  // exactly, accumulate, and quantize each cumulative gridline to
  // the 0.01" lattice; per-column widths are the differences.
  // Quantizing each width independently then summing (the old
  // approach) drifts short of the edge. Scaling +
  // cumulative-then-difference makes the columns span exactly
  // [0, contentW] with every gridline on the lattice.
  const firstRow = rows[0];
  const colWraw = firstRow.map((c: TableCell) => px2in(c.bounds?.w || b.w / firstRow.length));
  const colRawTotal = colWraw.reduce((a, w) => a + w, 0);
  const colScale = colRawTotal > 0 ? contentW / colRawTotal : 1;
  const colXPrefix: number[] = [0];
  { let acc = 0; for (const w of colWraw) { acc += w * colScale; colXPrefix.push(q(acc)); } }
  const colW = colWraw.map((_, i) => q(colXPrefix[i + 1] - colXPrefix[i]));
  // Row geometry — DRIFT-FREE, same cumulative-quantize model as
  // the columns above.
  const rowHraw = rows.map((row) => row[0]?.bounds ? px2in(row[0].bounds.h) : px2in(b.h / Math.max(1, rowCount)));
  const rowRawTotal = rowHraw.reduce((a, h) => a + h, 0);
  const rowScale = rowRawTotal > 0 ? contentH / rowRawTotal : 1;
  const rowYPrefix: number[] = [0];
  { let acc = 0; for (const h of rowHraw) { acc += h * rowScale; rowYPrefix.push(q(acc)); } }
  const rowH = rowHraw.map((_, i) => q(rowYPrefix[i + 1] - rowYPrefix[i]));
  // Pin each row's height to its CSS height so Google Slides
  // doesn't re-flow rows under the per-cell border tuples —
  // without an explicit `rowH`, pptxgenjs writes `<a:tr h="0">` and
  // Slides auto-sizes, producing a phantom blank row (slide_17, slide_05).
  // Pin the graphicFrame's `<a:ext cy>` to sum(rowH). Without
  // `h`, pptxgenjs falls back to a hard-coded 1 inch
  // (pptxgen.es.js:5187 `cy || EMU`), and Google Slides
  // compresses the rows to fit (the "phantom row" bug, slide_17 / slide_05).
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
  // makes native cells fill the CSS content area exactly.
  const tblTwLeft   = q(px2in(tableBorderSides?.left?.width   || 0));
  const tblTwTop    = q(px2in(tableBorderSides?.top?.width    || 0));
  const tableColSum = q(colW.reduce((acc: number, w: number) => acc + w, 0));
  return {
    x: q(xL + tblTwLeft),
    y: q(yT + tblTwTop),
    w: tableColSum,
    h: q(tableH),
    colW,
    rowH,
  };
}

/** One native table cell: text (or styled runs), font, fill, borders, spans
 * and padding. */
function nativeTableCell(
  cell: TableCell,
  at: {
    readonly ri: number;
    readonly ci: number;
    readonly rowCount: number;
    readonly colCount: number;
    /** CSS layers the `<table>`'s own background BEHIND every cell: a
     * transparent `<td>` shows the table bg, not the slide bg (slide_17's pink
     * `.table-wrap` leaked through odd-row cells without this fallback). */
    readonly tableBg: string | undefined;
    /** Table-level border folded onto outer-edge cells, or null when not folded. */
    readonly foldedBorder: BorderSides | null;
  },
): { text: string; options: TableCellProps } {
  const cs = cell.style || {};
  const cellOpts: TableCellProps = {
    align: cs.textAlign === "center" ? "center" : cs.textAlign === "right" ? "right" : "left",
    valign: "middle",
    fontFace: mapFont(cs.fontFamily || "Arial"),
    fontSize: (cs.fontSize || 14) * PX2PT,
    color: hexToRgb(cs.color || "#111111"),
    bold: cs.fontWeight === "bold" || cell.isHeader,
    italic: cs.fontStyle === "italic",
    // TODO(types): BorderOpt carries "sysDot" (valid OOXML, accepted by
    // the fork) which the published BorderProps union omits; the tuple
    // overlaps BorderProps so a direct assertion is type-checked.
    border: cellBorderTuple(cs.borderSides, at) as [BorderProps, BorderProps, BorderProps, BorderProps],
  };
  const effectiveBg = cs.bgColor || at.tableBg;
  if (effectiveBg) cellOpts.fill = { color: hexToRgb(effectiveBg) };
  if (cell.colspan && cell.colspan > 1) cellOpts.colspan = cell.colspan;
  if (cell.rowspan && cell.rowspan > 1) cellOpts.rowspan = cell.rowspan;
  // Cell padding → pptxgenjs cell margin (inches). pptxgenjs
  // defaults to `[0.05, 0.1, 0.05, 0.1]` which is much narrower
  // than typical CSS table padding (e.g. `14px 20px` in
  // complex_slide_05). Honor the cell's CSS padding directly. (A previous
  // col-0 "48px floor" on wide left-aligned cells — added for
  // box-shadow-halo wrapper tables — shifted plain tables' first column
  // ~0.5″ right [slide_15], so it's removed; CSS padding is authoritative.)
  if (cell.padding) {
    const p = cell.padding;
    cellOpts.margin = [px2in(p.top), px2in(p.right), px2in(p.bottom), px2in(p.left)];
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
    const inherited = {
      fontFamily: cs.fontFamily || "Arial",
      fontSize: cs.fontSize || 14,
      color: cs.color || "#111111",
      bold: cs.fontWeight === "bold" || !!cell.isHeader,
      italic: cs.fontStyle === "italic",
    };
    const entries: Array<{ text: string; options: TextPropsOptions }> = [];
    for (const r of runs) {
      if (r.text === "\n") {
        if (entries.length > 0) entries[entries.length - 1].options.breakLine = true;
        continue;
      }
      if (!r.text) continue;
      entries.push({ text: r.text, options: inheritedRunOptions(r.style || {}, inherited) });
    }
    if (entries.length > 0) {
      // pptxgenjs accepts a run array as a cell's `text`; its published cell
      // type only declares a string.
      return { text: entries as unknown as string, options: cellOpts };
    }
  }
  return { text: cell.text || "", options: cellOpts };
}

/** The cell's own per-side borders, with the table-level border folded onto
 * the outer-edge sides that have none (an explicit per-cell border wins). */
function cellBorderTuple(
  bs: BorderSides | undefined,
  at: {
    readonly ri: number;
    readonly ci: number;
    readonly rowCount: number;
    readonly colCount: number;
    readonly foldedBorder: BorderSides | null;
  },
): [BorderOpt, BorderOpt, BorderOpt, BorderOpt] {
  const out: [BorderOpt, BorderOpt, BorderOpt, BorderOpt] = [
    sideToBorderOpt(bs?.top),
    sideToBorderOpt(bs?.right),
    sideToBorderOpt(bs?.bottom),
    sideToBorderOpt(bs?.left),
  ];
  const table = at.foldedBorder;
  if (table) {
    if (at.ri === 0 && out[0].type === "none") out[0] = sideToBorderOpt(table.top);
    if (at.ri === at.rowCount - 1 && out[2].type === "none") out[2] = sideToBorderOpt(table.bottom);
    if (at.ci === 0 && out[3].type === "none") out[3] = sideToBorderOpt(table.left);
    if (at.ci === at.colCount - 1 && out[1].type === "none") out[1] = sideToBorderOpt(table.right);
  }
  return out;
}

/** Outer rounded frame of a table — no fill, so it acts as a mask outline.
 * Honors per-corner table radii: a table with `border-radius: 10px 10px 0 0`
 * outlines only the top corners, not all 4. */
function emitTableOutline(slide: Slide, el: TableElement, tableCornerRadii: CornerRadii): void {
  const b = el.bounds;
  const tableCp = cornerPresetFromRadii(tableCornerRadii);
  const outlineOpts: ShapeProps = {
    x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
    fill: { type: "none" },
  };
  if (tableCp.preset !== "rect") {
    outlineOpts.rectRadius = px2in(el.borderRadius ?? 0);
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

/**
 * Pure-shape table renderer — debug path for `<table data-shape-render>`.
 *
 * Emits per-cell `addShape("rect")` for cell fills and per-edge filled
 * rect strips for borders, using the geometry validated by the one-off
 * table-twoway investigation (since removed). All coordinates are snapped
 * to a 0.01" lattice so the output matches a `<p:sp>`-only path Slides renders
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
  // are exact.
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

// --- visual / image ---

/** A rasterised element: its PNG (when one was captured for index `ei`),
 * recorded as a rendered region. */
function emitVisual(ctx: EmitContext, el: VisualElement | ImageElement, ei: number): void {
  const buf = ctx.visualPngs.get(ei);
  if (!buf) return;
  const b = el.bounds;
  const imgOpts: NonNullable<Parameters<Slide["addImage"]>[0]> = {
    data: `image/png;base64,${bytesToBase64(buf)}`,
    x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
  };
  // Phase 1: a drawio-rendered diagram image gets a DETERMINISTIC
  // identity so the post-upload pass (runConvertPptx) can find it in
  // the imported Slides deck and link it to its editable `.drawio.svg`
  // on Drive. `objectName` sets the pptx cNvPr name (does NOT survive
  // Slides import) and `altText` sets the cNvPr descr (DOES survive as
  // the image's description/alt-text). Gated on `_drawioPaired` +
  // `drawioSource` — a strict no-op for every other image (byte output
  // unchanged on non-drawio slides).
  const { extraction, slideIndex: si } = ctx;
  if (el._drawioPaired && extraction.drawioSource) {
    const si1 = si + 1;
    const hash = fnv1a8(extraction.drawioSource);
    const diagramId = `slide${si1}_${hash}`;
    const altText = `drawio:${diagramId}`;
    imgOpts.objectName = `DRAWIO_IMG_${si}`;
    imgOpts.altText = altText;
    ctx.drawioDiagrams.push({
      slideIndex1: si1,
      diagramId,
      xml: extraction.drawioSource,
      baseSvg: extraction.drawioBaseSvg,
      altText,
    });
  }
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
    imgOpts.shadow = outerShadow({
      blurPx: sh.blur || 0,
      dx: sh.offsetX || 0,
      dy: sh.offsetY || 0,
      color: sh.color || "#000000",
      opacity: sh.alpha ?? 0.25,
    });
  }
  ctx.slide.addImage(imgOpts);
  // A large-radius `clipped-container` (phone/device mockup) is the
  // rasterised >50%-corner fallback: its rounded chrome can't be a
  // native roundRect, so it's emitted as this 2× PNG. Tag the region
  // descriptively so the rating UI's "Highlight rendered regions"
  // checkbox can mark/audit the device image.
  ctx.slideRegions.push({
    x: b.x / SLIDE_W_PX, y: b.y / SLIDE_H_PX,
    w: b.w / SLIDE_W_PX, h: b.h / SLIDE_H_PX,
    kind: renderedRegionKind(el),
  });
}

function renderedRegionKind(el: VisualElement | ImageElement): string {
  switch (el.type) {
    case "image":
      return el._wasEmojiText ? "emoji" : el.type;
    case "visual":
      return el.tag === "clipped-container" ? "device-corner-image" : el.type;
    default:
      return assertNever(el);
  }
}

// --- Gradient post-processing ---
// pptxgenjs has no gradFill API. We mark gradient shapes with descr="GRAD:{json}" via altText,
// then rewrite the saved .pptx XML to replace those shapes' <a:solidFill> with <a:gradFill>.

function cssAngleToOoxml(cssDeg: number): number {
  // CSS: 0deg=up (to top), clockwise. OOXML <a:lin ang=>: 0=east, clockwise, units of 60000ths deg.
  // CSS direction = OOXML direction rotated 90° CCW: ooxml = (css - 90 + 360) % 360.
  const ooxml = ((cssDeg - 90) % 360 + 360) % 360;
  return Math.round(ooxml * 60000);
}

function buildGradFillXml(gradient: { readonly angle?: number; readonly type?: string; readonly stops: ReadonlyArray<{ readonly color: string; readonly position: number; readonly alpha?: number }> }): string {
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
 * Insert `<a:buClr>` into native-bullet paragraphs of BUCLR_<n>-tagged list
 * textboxes. pptxgenjs 4.0.1 emits only `<a:buSzPct/><a:buChar/>` (no bullet
 * color at all — pptxgen.es.js ~5849-5894), so per-item colored bullets
 * (slide_30 Key Priorities: `li.red::before { background:#e53e3e }` dots)
 * cannot be expressed at build time. buildPptx records each such textbox's
 * per-paragraph colors in `pres.__bulletColors[n]` and names the shape
 * BUCLR_<n>; this patch walks the shape's `<a:buChar>` paragraphs in item
 * order and prepends `<a:buClr><a:srgbClr val="RRGGBB"/></a:buClr>` — buClr
 * must come BEFORE buSzPct/buFont/buChar per CT_TextParagraphProperties.
 * Google Slides imports `<a:buClr>` as a native colored bullet. A null color
 * leaves that paragraph's marker default (follows the run color). Pure
 * (mutates zip in place; returns the patched-paragraph count).
 */
export async function injectBulletColorsIntoZip(zip: JSZip, registry: readonly BulletColorList[]): Promise<number> {
  if (registry.length === 0) return 0;
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let patched = 0;
  for (const name of slideFiles) {
    let xml = await zip.file(name)!.async("string");
    let slidePatched = 0;
    xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (spBlock: string) => {
      const m = spBlock.match(/name="BUCLR_(\d+)"/);
      if (!m) return spBlock;
      const entry = registry[parseInt(m[1])];
      if (!entry) return spBlock;
      let para = 0;
      return spBlock.replace(/<a:buSzPct val="100000"\/><a:buChar /g, (bu: string) => {
        const color = entry.colors[para++];
        if (!color) return bu;
        slidePatched++;
        return `<a:buClr><a:srgbClr val="${color}"/></a:buClr>${bu}`;
      });
    });
    if (slidePatched > 0) { zip.file(name, xml); patched += slidePatched; }
  }
  return patched;
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
 * Repair `round2SameRect` adjust-value naming. pptxgenjs writes a single
 * `<a:gd name="adj" fmla="val N"/>` for every rounded preset (pptxgen.es.js
 * ~L5464), but `round2SameRect`'s OOXML adjust handles are named **`adj1`**
 * (the rounded corner pair) and **`adj2`** (the flat pair) — NOT `adj`. An
 * unmatched `name="adj"` override is ignored, so the renderer falls back to the
 * preset DEFAULT `adj1=16667` (16.667% of the short side) — over-rounding the
 * corner (slide_12's device screen / background bottom corners rendered ~35px
 * instead of the intended 24px). Rewrite `name="adj"` → `name="adj1"` inside a
 * `round2SameRect` prstGeom and append `<a:gd name="adj2" fmla="val 0"/>` so the
 * flat pair stays square. The shape's own flip/rotation (set at emit time)
 * places the rounded pair on the correct side. Idempotent (skips blocks already
 * carrying `adj1`); a no-op for renderers that already map positionally, so it
 * can only help.
 */
export async function injectRound2SameRectAdjIntoZip(zip: JSZip): Promise<number> {
  const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let patched = 0;
  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async("string");
    let slidePatched = 0;
    const next = xml.replace(
      /<a:prstGeom prst="round2SameRect"><a:avLst>([\s\S]*?)<\/a:avLst><\/a:prstGeom>/g,
      (full: string, inner: string) => {
        if (/name="adj1"/.test(inner) || !/name="adj"/.test(inner)) return full;
        const renamed = inner.replace(/name="adj"/, 'name="adj1"');
        const withAdj2 = /name="adj2"/.test(renamed)
          ? renamed
          : `${renamed}<a:gd name="adj2" fmla="val 0"/>`;
        slidePatched++;
        return `<a:prstGeom prst="round2SameRect"><a:avLst>${withAdj2}</a:avLst></a:prstGeom>`;
      },
    );
    if (slidePatched > 0) { zip.file(name, next); patched += slidePatched; }
  }
  return patched;
}

// --- The ONE pptx post-processing pipeline ---
// Every forward path ends here: the command line (convert-pptx-io.ts, which the
// goldens gate and bug_solving render) and the product (browser/convert-core.ts:
// sashaslides.com and the html2slides add-on). The patches below are the set the
// goldens were rated on; a patch added here reaches every path at once.

/**
 * Serialise `pres` and apply every OOXML post-patch in ONE zip pass, in order:
 * gradients, bullet colours, inside stroke alignment, round2SameRect adj names.
 * Returns the finished .pptx bytes. No fs, no network.
 */
export async function postProcessPptx(pres: PresentationWithRegistries): Promise<Uint8Array> {
  const ab = (await pres.write({ outputType: "arraybuffer" })) as ArrayBuffer;
  const zip = await JSZip.loadAsync(ab);
  const gradients = await injectGradientsIntoZip(zip, pres.__gradients);
  const bulletColors = await injectBulletColorsIntoZip(zip, pres.__bulletColors);
  const strokeAlignment = await injectStrokeAlignmentIntoZip(zip);
  const round2SameRectAdj = await injectRound2SameRectAdjIntoZip(zip);
  if (gradients > 0) console.log(`  Gradient injection: ${gradients} shape(s) patched`);
  if (bulletColors > 0) console.log(`  Bullet colors: ${bulletColors} <a:buClr> insertion(s)`);
  if (strokeAlignment > 0) console.log(`  Stroke alignment: ${strokeAlignment} <a:ln> rewrite(s) to algn="in"`);
  if (round2SameRectAdj > 0) console.log(`  round2SameRect adj: ${round2SameRectAdj} prstGeom(s) → adj1/adj2`);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// --- In-memory build (browser-friendly) ---
// Returns a fully-patched .pptx as bytes: buildPptx + the shared postProcessPptx.
export async function buildPptxInMemory(
  slides: readonly SlideInput[],
  title: string,
): Promise<Uint8Array> {
  const { pres } = buildPptx(slides, title);
  return await postProcessPptx(pres);
}
