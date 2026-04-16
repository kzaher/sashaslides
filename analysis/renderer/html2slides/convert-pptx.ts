#!/usr/bin/env npx tsx
/**
 * convert-pptx.ts — Convert HTML slides to .pptx, then upload to Google Slides
 *
 * Pipeline:
 *   1. Extract DOM from HTML files (reuses extract-dom.ts + Chrome CDP)
 *   2. Build .pptx with pptxgenjs (exact corner radii, native text, shapes)
 *   3. Upload .pptx to Google Drive as Google Slides presentation
 *
 * Advantages over Slides API approach:
 *   - pptxgenjs rectRadius gives exact corner radii (OOXML adj attribute)
 *   - Native text is editable in Slides after import
 *   - Single file upload instead of hundreds of API calls
 *
 * Usage: npx tsx convert-pptx.ts <html-dir> [--title "Presentation Name"] [--out /tmp/output.pptx]
 */

import CDP from "chrome-remote-interface";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { Readable } from "stream";
import { createRequire } from "module";
const require = createRequire("/workspaces/sashaslides/package.json");

const CDP_PORT = 9222;
const SLIDE_W_PX = 1280;
const SLIDE_H_PX = 720;

// pptxgenjs slide dimensions in inches (widescreen 16:9)
const SLIDE_W_IN = 10;
const SLIDE_H_IN = 5.625;
const PX2IN = SLIDE_W_IN / SLIDE_W_PX; // 0.0078125

// Font scale: CSS px to PowerPoint pt
// At 96dpi CSS, 1px = 0.75pt. But our slide is 10" for 1280px, so effective:
const PX2PT = SLIDE_W_IN / SLIDE_W_PX * 72; // 10/1280*72 = 0.5625

// Compile extract-dom.ts → JS at startup
import { transformSync } from "esbuild";
const EXTRACT_TS = readFileSync(join(dirname(new URL(import.meta.url).pathname), "extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function px2in(px: number): number { return px * PX2IN; }

function hexToRgb(hex: string): string {
  // pptxgenjs wants hex without # prefix
  return hex.replace("#", "").toUpperCase();
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

// Approximate CSS opacity by blending foreground with white (the dominant
// slide background) — pptxgenjs text color is hex with no alpha. Good enough
// for decorative watermark-style text like the oversized quote glyph in
// slide_06. Module-scope so both the standalone text emitter and any future
// run mapper can reuse it.
function blendOpacity(hexColor: string, op: number): string {
  const m = hexColor.replace("#", "").match(/.{2}/g);
  if (!m || m.length < 3) return hexColor;
  const [r, g, bl] = m.map(x => parseInt(x, 16));
  const br = Math.round(r * op + 255 * (1 - op));
  const bg = Math.round(g * op + 255 * (1 - op));
  const bb = Math.round(bl * op + 255 * (1 - op));
  return "#" + [br, bg, bb].map(v => v.toString(16).padStart(2, "0")).join("");
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
// `colorTransform` lets the caller apply blendOpacity (standalone text path)
// or pass-through (merged-into-rect path).
function mapRunOptions(
  run: any,
  parentStyle: any,
  uppercase: boolean,
  defaults: { color: string; fontSize: number },
  colorTransform: (hex: string) => string = (h) => h,
): { text: string; options: any } {
  const rs = run.style || {};
  const ps = parentStyle || {};
  const opts: any = {
    fontFace: mapFont(rs.fontFamily || ps.fontFamily || "Arial"),
    fontSize: (rs.fontSize || ps.fontSize || defaults.fontSize) * PX2PT,
    color: hexToRgb(colorTransform(rs.color || ps.color || defaults.color)),
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
// `opts.applyOpacityBlend`: when true, fold style.opacity into text colors
// (standalone path only — merged-rect path historically didn't do this).
// `opts.selfIndex`: index in `elements` for neighborSlackBudget self-skip.
function emitStyledText(
  slide: any,
  el: any,
  bounds: { x: number; y: number; w: number; h: number },
  elements: any[],
  selfIndex: number,
  valign: "top" | "middle",
  applyOpacityBlend: boolean,
  defaults: { color: string; fontSize: number },
): void {
  const s = el.style || {};
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
    const budget = neighborSlackBudget({ x: bx, y: by, w: bw, h: bh }, elements, selfIndex, SLACK_PX);
    const slacked = applySlack({ x: bx, y: by, w: bw, h: bh }, align, budget);
    bx = slacked.x; by = slacked.y; bw = slacked.w; bh = slacked.h;
  }

  const colorTransform = applyOpacityBlend && typeof s.opacity === "number" && s.opacity < 1
    ? (hex: string) => blendOpacity(hex, s.opacity)
    : (hex: string) => hex;

  const commonOpts: any = {
    x: px2in(bx), y: px2in(by), w: px2in(bw), h: px2in(bh),
    valign,
    align,
    fill: { type: "none" },
    line: { type: "none" },
    margin: 0,
  };
  if (s.lineHeight && s.fontSize) commonOpts.lineSpacingMultiple = s.lineHeight / s.fontSize;
  if (rotateDeg) commonOpts.rotate = rotateDeg;

  if (el.runs && el.runs.length > 0) {
    const textRuns = el.runs
      .filter((r: any) => r.text.length > 0)
      .map((run: any) => mapRunOptions(run, s, xfm, defaults, colorTransform));
    slide.addText(textRuns, commonOpts);
  } else {
    let text = el.text || "";
    if (xfm) text = text.toUpperCase();
    slide.addText(text, {
      ...commonOpts,
      fontSize: (s.fontSize || defaults.fontSize) * PX2PT,
      fontFace: mapFont(s.fontFamily || "Arial"),
      color: hexToRgb(colorTransform(s.color || defaults.color)),
      bold: s.fontWeight === "bold",
      italic: s.fontStyle === "italic",
      underline: s.textDecoration === "underline" ? { style: "sng" } : undefined,
      strike: s.textDecoration === "line-through" ? "sngStrike" : undefined,
    });
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

// --- Types ---
interface Bounds { x: number; y: number; w: number; h: number; }
interface ExtractedElement { type: string; bounds: Bounds; [key: string]: any; }
interface Extraction { viewport: { w: number; h: number }; elementCount: number; elements: ExtractedElement[]; }

// --- Auth ---
function getAuth() {
  const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
  const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (newTokens: any) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify(merged, null, 2));
  });
  return oauth2;
}

// --- DOM Extraction ---
async function extractFromHtml(htmlPath: string): Promise<{ extraction: Extraction; visualPngs: Map<number, Buffer> }> {
  const absPath = resolve(htmlPath);
  const tab = await (CDP as any).New({ port: CDP_PORT, url: `file://${absPath}` });
  await sleep(1200);

  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: 2, mobile: false });
  await sleep(800);
  await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true });
  await sleep(300);

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const extraction: Extraction = JSON.parse(result.value);

  // Emoji detection: Slides lacks an emoji font, so glyphs like ⚡🔒📊🔍🧐💳
  // render as tofu boxes. For text elements whose content is primarily emoji
  // codepoints, rasterize the element region from Chrome and emit as an image.
  const isEmojiCodepoint = (cp: number): boolean => {
    // Misc symbols & dingbats
    if (cp >= 0x2600 && cp <= 0x27BF) return true;
    // Emoji presentation selector / ZWJ / variation selector — accompany emoji
    if (cp === 0x200D || cp === 0xFE0F) return true;
    // Regional indicators (flags)
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;
    // Main emoji blocks
    if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
    // Supplemental symbols & pictographs / transport / enclosed
    if (cp >= 0x2300 && cp <= 0x23FF) return true; // misc technical (⚙ etc.)
    if (cp >= 0x25A0 && cp <= 0x25FF) return true; // geometric (▲ ■ etc. — usually fine but keep)
    return false;
  };
  const looksLikeEmojiText = (s: string): boolean => {
    if (!s) return false;
    // Iterate real codepoints (surrogate-pair safe).
    let emoji = 0, total = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp <= 0x20) continue; // whitespace
      total++;
      if (isEmojiCodepoint(cp)) emoji++;
    }
    if (total === 0) return false;
    // Primarily emoji (allow a stray ascii char in ZWJ sequences).
    return emoji / total >= 0.5 && total <= 4;
  };
  // Mark emoji text elements for rasterization — retype to "image" so the
  // existing visualPngs pipeline handles capture + addImage.
  for (const el of extraction.elements) {
    if (el.type !== "text") continue;
    if (!looksLikeEmojiText(el.text || "")) continue;
    el.type = "image";
    el._wasEmojiText = true;
  }

  // Screenshot visual elements (svg/canvas/images)
  const visualPngs = new Map<number, Buffer>();
  for (let i = 0; i < extraction.elements.length; i++) {
    const el = extraction.elements[i];
    if ((el.type === "visual" || el.type === "image") && el.bounds.w > 5 && el.bounds.h > 5) {
      const clip = { x: el.bounds.x, y: el.bounds.y, width: el.bounds.w, height: el.bounds.h, scale: 2 };
      const ss = await Page.captureScreenshot({ format: "png", clip, captureBeyondViewport: true });
      visualPngs.set(i, Buffer.from(ss.data, "base64"));
    }
  }

  await client.close();
  await (CDP as any).Close({ port: CDP_PORT, id: tab.id });
  return { extraction, visualPngs };
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
  b: { x: number; y: number; w: number; h: number },
  elements: any[],
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
function buildPptx(
  slides: { extraction: Extraction; visualPngs: Map<number, Buffer> }[],
  title: string,
): any {
  // ESM/CJS interop for pptxgenjs
  const pptxgenModule = require("pptxgenjs");
  const PptxGenJS = (pptxgenModule as any).default || pptxgenModule;
  const pres = new PptxGenJS();
  const gradientRegistry: any[] = [];
  (pres as any).__gradients = gradientRegistry;
  pres.title = title;
  pres.layout = "LAYOUT_WIDE"; // 13.333" x 7.5" — wait, we want 10" x 5.625"

  // Actually define custom layout matching our slide dimensions
  pres.defineLayout({ name: "CUSTOM", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pres.layout = "CUSTOM";

  for (let si = 0; si < slides.length; si++) {
    const { extraction, visualPngs } = slides[si];
    const slide = pres.addSlide();

    for (let ei = 0; ei < extraction.elements.length; ei++) {
      const el = extraction.elements[ei];
      if (el.type === "_skip") continue;
      const b = el.bounds;

      switch (el.type) {
        case "rect": {
          // Full-slide background
          if (b.w > SLIDE_W_PX * 0.9 && b.h > SLIDE_H_PX * 0.9) {
            if (el.fill) {
              slide.background = { fill: hexToRgb(el.fill) };
            }
            break;
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

          let mergedTextEl: any = null;
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
          const opts: any = {
            x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
            line: { type: "none" },
          };

          // Fill (gradient tagged via objectName for post-processing — pptxgenjs has no gradient API)
          if (el.gradient && el.gradient.stops && el.gradient.stops.length >= 2) {
            opts.fill = { color: hexToRgb(el.gradient.stops[0].color) };
            const gid = gradientRegistry.length;
            gradientRegistry.push(el.gradient);
            opts.objectName = `GRAD_${gid}`;
          } else if (el.fill) {
            const fillOpts: any = { color: hexToRgb(el.fill) };
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
          const rectRot = typeof (el as any).rotate === "number" ? (el as any).rotate : 0;
          if (Math.abs(rectRot) > 0.5 && (el as any).naturalWidth && (el as any).naturalHeight) {
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h / 2;
            const nw = (el as any).naturalWidth;
            const nh = (el as any).naturalHeight;
            opts.x = px2in(cx - nw / 2);
            opts.y = px2in(cy - nh / 2);
            opts.w = px2in(nw);
            opts.h = px2in(nh);
            opts.rotate = ((rectRot % 360) + 360) % 360;
          }

          slide.addShape(shapeName, opts);

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
              .every((s: any) => s.style !== "dashed" && s.style !== "dotted");
            if (sameColor && allSolid && borderColors.length > 0) {
              // Both outer and inner sandwich rects MUST honor the same
              // per-corner preset as the content shape — otherwise the
              // outer's `roundRect` (all-4-corners) draws a curved bottom
              // edge under a top-only-rounded card header (slide_01
              // Professional pricing card).
              const sandwichCp = cornerPresetFromRadii(cr);
              const sandwichOuterOpts: any = {
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
              // 2. Inner = card fill, inset by border widths on bordered sides only.
              const iTop = hasTop ? (bs.top.width || 0) : 0;
              const iBottom = hasBottom ? (bs.bottom.width || 0) : 0;
              const iLeft = hasLeft ? (bs.left.width || 0) : 0;
              const iRight = hasRight ? (bs.right.width || 0) : 0;
              const ix = b.x + iLeft;
              const iy = b.y + iTop;
              const iw = Math.max(0, b.w - iLeft - iRight);
              const ih = Math.max(0, b.h - iTop - iBottom);
              const innerInset = Math.max(iTop, iBottom, iLeft, iRight);
              // Inner per-corner radii: shrink each rounded corner by the
              // inset, leaving non-rounded corners flat.
              const innerCr = {
                tl: cr.tl > 2 ? Math.max(0, cr.tl - innerInset) : 0,
                tr: cr.tr > 2 ? Math.max(0, cr.tr - innerInset) : 0,
                br: cr.br > 2 ? Math.max(0, cr.br - innerInset) : 0,
                bl: cr.bl > 2 ? Math.max(0, cr.bl - innerInset) : 0,
              };
              const innerCp = cornerPresetFromRadii(innerCr);
              const innerR = Math.max(innerCr.tl, innerCr.tr, innerCr.br, innerCr.bl);
              const innerOpts: any = {
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
            emitStyledText(
              slide, mergedTextEl, mb,
              extraction.elements, mergedTextIndex,
              "middle",
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
          const triOpts: any = {
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
            true, // standalone text honors style.opacity by blending toward white
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
          const items = (el.items || []).filter((it: any) => (it.text || "").trim().length > 0);
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
            const anyItemHasStyledRuns = items.some((it: any) =>
              (it.runs || []).length > 0 && (it.runs || []).some((r: any) => r.style !== null)
            );
            const useNativeBullet = !anyItemHasStyledRuns;
            const paragraphs = items.map((it: any, ii: number) => {
              const marker = ordered ? `${ii + 1}.  ` : "•  ";
              const rs = (it.runs && it.runs.length > 0) ? it.runs.filter((r: any) => r.text.length > 0) : null;
              if (rs && rs.length > 0 && rs.some((r: any) => r.style !== null)) {
                const out: any[] = [];
                if (!useNativeBullet) {
                  // Plain marker prefix with item-default style.
                  out.push({
                    text: marker,
                    options: {
                      fontFace: mapFont(it.fontFamily || listStyle.fontFamily || "Arial"),
                      fontSize: (it.fontSize || listStyle.fontSize || 14) * PX2PT,
                      color: hexToRgb(it.color || listStyle.color || "#333333"),
                    },
                  });
                }
                rs.forEach((run: any, ri: number) => {
                  const s = run.style || {};
                  const opts: any = {
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
              const baseOpts: any = {
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
              return [{ text: marker + it.text, options: baseOpts }];
            }).flat();

            // Honor CSS line-height when explicitly set (ratio != 1.2 default).
            // Passing `lineSpacingMultiple` = CSS lineHeight/fontSize maps
            // directly to OOXML `<a:lnSpc><a:spcPct>`, which Slides respects.
            // Omitting it lets Slides fall back to its ~1.2 default (matches
            // CSS `line-height: normal`).
            const firstIt = items[0] || {};
            const paraSpaceAfterPt = (firstIt.marginBottom || 0) * PX2PT;
            const ratio = firstIt.lineHeight && firstIt.fontSize
              ? firstIt.lineHeight / firstIt.fontSize
              : 0;
            const useRatio = ratio >= 1.05 && ratio <= 3.0 && Math.abs(ratio - 1.2) > 0.08;
            slide.addText(paragraphs, {
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
              valign: "top",
              align: "left",
              fill: { type: "none" },
              line: { type: "none" },
              margin: 0,
              paraSpaceAfter: paraSpaceAfterPt > 0 ? paraSpaceAfterPt : undefined,
              lineSpacingMultiple: useRatio ? ratio : undefined,
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
            const bs = it.borderSides || { top: {}, right: {}, bottom: {}, left: {} };
            const sides = [bs.top, bs.right, bs.bottom, bs.left];
            const uniformItemBorder = sides.every((s: any) =>
              s && s.width === bs.top.width && s.color === bs.top.color && s.style === bs.top.style
            ) && (bs.top.width || 0) > 0;
            const hasItemBg = !!it.bgColor;
            const hasAnyItemBorder = sides.some((s: any) => s && (s.width || 0) > 0 && s.color);

            if (hasItemBg || uniformItemBorder) {
              const rectOpts: any = {
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
              ].filter(Boolean) as any[];
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
            const textOpts: any = {
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

            if (it.runs && it.runs.length > 0 && it.runs.some((r: any) => r.style !== null)) {
              const textRuns: any[] = [];
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
              for (const run of it.runs.filter((r: any) => r.text.length > 0)) {
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

          // Decide path: a table is "native-eligible" if every cell has a
          // uniform per-side border (all four sides identical — or all
          // widths zero) and the table has no outer border-radius.
          const cellUniformBorder = (cs: any): { width: number; color: string; style: string } | null => {
            const bs = cs?.borderSides;
            if (!bs) return { width: 0, color: "", style: "none" };
            const sides = [bs.top, bs.right, bs.bottom, bs.left];
            const widths = sides.map((s: any) => s?.width || 0);
            const hasAny = widths.some((w: number) => w > 0);
            if (!hasAny) return { width: 0, color: "", style: "none" };
            const same = sides.every((s: any) =>
              s && s.width === bs.top.width && s.color === bs.top.color && s.style === bs.top.style
            );
            if (!same) return null;
            return { width: bs.top.width, color: bs.top.color, style: bs.top.style };
          };
          let allCellsUniform = !tableHasRadius;
          let tableBorder: { width: number; color: string; style: string } | null = null;
          if (allCellsUniform) {
            for (const row of rows) for (const cell of row) {
              const ub = cellUniformBorder(cell.style || {});
              if (ub === null) { allCellsUniform = false; break; }
              if (!tableBorder && ub.width > 0) tableBorder = ub;
              else if (tableBorder && ub.width > 0 &&
                (tableBorder.width !== ub.width || tableBorder.color !== ub.color || tableBorder.style !== ub.style)) {
                // Mixed border widths across cells (e.g. separate-borders with
                // different borders per header/body) — still native-eligible,
                // but we'll pass borders per-cell via the `border` option.
                tableBorder = null;
                break;
              }
            }
          }

          if (allCellsUniform && rows.length > 0) {
            // Build column widths from the first row's cell widths.
            const firstRow = rows[0];
            const colW = firstRow.map((c: any) => px2in(c.bounds?.w || b.w / firstRow.length));
            const tableRows = rows.map((row: any[]) => row.map((cell: any) => {
              const cs = cell.style || {};
              const ub = cellUniformBorder(cs) || { width: 0, color: "", style: "none" };
              // pptxgenjs table cell border dashType: "dash" | "dashDot" | "lgDash" |
              // "lgDashDot" | "lgDashDotDot" | "solid" | "sysDash" | "sysDashDot" |
              // "sysDashDotDot" | "sysDot" | "none". Use "sysDot" for CSS dotted so
              // Google Slides preserves the dotted appearance (not a long dash).
              const dashType = ub.style === "dashed" ? "dash" : ub.style === "dotted" ? "sysDot" : "solid";
              const borderSpec = ub.width > 0
                ? { type: dashType as any, pt: Math.max(0.5, ub.width * PX2PT), color: hexToRgb(ub.color) }
                : { type: "none" as const, pt: 0, color: "000000" };
              const cellOpts: any = {
                align: cs.textAlign === "center" ? "center" : cs.textAlign === "right" ? "right" : "left",
                valign: "middle",
                fontFace: mapFont(cs.fontFamily || "Arial"),
                fontSize: (cs.fontSize || 14) * PX2PT,
                color: hexToRgb(cs.color || "#111111"),
                bold: cs.fontWeight === "bold" || cell.isHeader,
                italic: cs.fontStyle === "italic",
                border: borderSpec,
              };
              if (cs.bgColor) cellOpts.fill = { color: hexToRgb(cs.bgColor) };
              if (cell.colspan && cell.colspan > 1) cellOpts.colspan = cell.colspan;
              if (cell.rowspan && cell.rowspan > 1) cellOpts.rowspan = cell.rowspan;
              return { text: cell.text || "", options: cellOpts };
            }));
            slide.addTable(tableRows, {
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), colW,
              autoPage: false,
              fontFace: "Arial",
            });
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
              const rectOpts: any = {
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
              const bs = cs.borderSides || { top: {}, bottom: {}, left: {}, right: {} };
              const sides = [bs.top, bs.right, bs.bottom, bs.left];
              const uniform = sides.every((s: any) =>
                s && s.width === bs.top.width && s.color === bs.top.color && s.style === bs.top.style
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
                ].filter(Boolean) as any[];
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
              const pad = cell.padding || { top: 0, right: 0, bottom: 0, left: 0 };
              const tb = {
                x: cb.x + pad.left, y: cb.y + pad.top,
                w: Math.max(0, cb.w - pad.left - pad.right),
                h: Math.max(0, cb.h - pad.top - pad.bottom),
              };
              const text = cell.text || "";
              if (text.trim().length > 0) {
                const align = cs.textAlign === "center" ? "center" : cs.textAlign === "right" ? "right" : "left";
                const textOpts: any = {
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
                if (cell.runs && cell.runs.length > 0 && cell.runs.some((r: any) => r.style !== null)) {
                  const textRuns = cell.runs.filter((r: any) => r.text.length > 0).map((run: any) => {
                    const rs = run.style || {};
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
            const outlineOpts: any = {
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
            slide.addImage({
              data: `image/png;base64,${buf.toString("base64")}`,
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
            });
          }
          break;
        }
      }
    }
  }

  return pres;
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const htmlDir = resolve(args[0] || ".");
  let title = "Presentation";
  let outPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title") title = args[++i];
    if (args[i] === "--out") outPath = args[++i];
  }

  const htmlFiles = readdirSync(htmlDir)
    .filter(f => f.endsWith(".html"))
    .sort()
    .map(f => join(htmlDir, f));

  if (htmlFiles.length === 0) { console.error("No HTML files found in", htmlDir); process.exit(1); }
  console.log(`Converting ${htmlFiles.length} HTML slides → pptx "${title}"`);

  // Step 1: Extract DOM from all slides (parallel batches)
  const EXTRACT_BATCH = 4;
  const slideData: { extraction: Extraction; visualPngs: Map<number, Buffer> }[] = new Array(htmlFiles.length);
  const t0 = Date.now();
  for (let i = 0; i < htmlFiles.length; i += EXTRACT_BATCH) {
    const batch = htmlFiles.slice(i, i + EXTRACT_BATCH);
    const results = await Promise.all(batch.map(async (f, bi) => {
      const idx = i + bi;
      console.log(`  [${idx + 1}/${htmlFiles.length}] Extracting ${f.split("/").pop()}...`);
      const data = await extractFromHtml(f);
      console.log(`    [${idx + 1}] ${data.extraction.elementCount} elements, ${data.visualPngs.size} visuals`);
      return { idx, data };
    }));
    for (const { idx, data } of results) slideData[idx] = data;
  }
  console.log(`  Extraction: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Step 2: Build pptx
  console.log("\nBuilding .pptx...");
  const pres = buildPptx(slideData, title);

  const pptxPath = outPath || `/tmp/${title.replace(/[^a-zA-Z0-9]/g, "_")}.pptx`;
  await pres.writeFile({ fileName: pptxPath });
  console.log(`  Saved: ${pptxPath}`);

  // Post-process: inject <a:gradFill> into shapes tagged with name="GRAD_N"
  await injectGradients(pptxPath, (pres as any).__gradients || []);

  // Step 3: Upload to Google Drive as Google Slides
  console.log("\nUploading to Google Slides...");
  const auth = getAuth();
  const driveApi = google.drive({ version: "v3", auth });

  const buf = readFileSync(pptxPath);
  const res = await driveApi.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.presentation" },
    media: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", body: Readable.from(buf) },
    fields: "id",
  });
  const presId = res.data.id;
  console.log(`  → https://docs.google.com/presentation/d/${presId}/edit`);
  console.log("Done.");
}

// --- Gradient post-processing ---
// pptxgenjs has no gradFill API. We mark gradient shapes with descr="GRAD:{json}" via altText,
// then rewrite the saved .pptx XML to replace those shapes' <a:solidFill> with <a:gradFill>.
const JSZip = require("jszip");

function cssAngleToOoxml(cssDeg: number): number {
  // CSS: 0deg=up (to top), clockwise. OOXML <a:lin ang=>: 0=east, clockwise, units of 60000ths deg.
  // CSS direction = OOXML direction rotated 90° CCW: ooxml = (css - 90 + 360) % 360.
  const ooxml = ((cssDeg - 90) % 360 + 360) % 360;
  return Math.round(ooxml * 60000);
}

function buildGradFillXml(gradient: { angle: number; stops: { color: string; position: number }[] }): string {
  const ang = cssAngleToOoxml(gradient.angle);
  const gsItems = gradient.stops.map(s => {
    const pos = Math.round(Math.max(0, Math.min(1, s.position)) * 100000);
    const clr = hexToRgb(s.color);
    return `<a:gs pos="${pos}"><a:srgbClr val="${clr}"/></a:gs>`;
  }).join("");
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gsItems}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`;
}

async function injectGradients(pptxPath: string, registry: any[]): Promise<void> {
  if (registry.length === 0) return;
  const buf = readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);
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
      const gradXml = buildGradFillXml(gradient);
      slidePatched++;
      return spBlock.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/, gradXml);
    });
    if (slidePatched > 0) {
      zip.file(name, xml);
      patchedShapes += slidePatched;
    }
  }

  if (patchedShapes > 0) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(pptxPath, out);
    console.log(`  Gradient injection: ${patchedShapes} shape(s) patched`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
