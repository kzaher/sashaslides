/**
 * post-extraction.ts — the ONE list of fixes applied to an extract-dom result
 * before rasterisation and `buildPptx`, shared by every forward converter path:
 *   - convert-pptx-io.ts   (command line, the goldens gate, bug_solving)
 *   - browser/convert-core.ts (sashaslides.com, the html2slides add-on sidebar)
 *
 * Pure: no DOM, no Node API. Each path then rasterises the elements
 * `rasterJobFor` names with its own capture technique (Chrome DevTools
 * screenshots, or canvas in the browser).
 */
import type { ExtractedElement, Extraction } from "./convert-pptx-lib.ts";

/** "native" emits an editable <a:tbl> (square corners); "baked" rasterises each table. */
export type TablesFormat = "native" | "baked";

/** What a rasterised element needs from the capture, in a closed set every capture switches on. */
export type RasterJob =
  | Readonly<{ kind: "text-glow"; glowId: number }> // the text-shadow halo alone, on transparency
  | Readonly<{ kind: "emoji"; text: string }>       // an emoji glyph retyped from text
  | Readonly<{ kind: "baked-table" }>               // a whole <table> (tablesFormat "baked")
  | Readonly<{ kind: "element" }>;                  // any other visual or image region, as painted

// Rasterisation oversampling factor (deviceScaleFactor + element capture
// scale). Clamp to [1,8]; default 2. A non-finite/missing value falls back to 2
// so unchanged callers stay byte-identical.
export function clampOversampling(n: number | undefined | null): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 2;
  return Math.min(8, Math.max(1, v));
}

/**
 * Apply every post-extraction fix, in order:
 *   1. tablesFormat "baked": re-type each <table> as an image.
 *   2. emoji text: re-type mostly-emoji text as a glyph-sized image.
 * Immutable: returns a fresh extraction.
 */
export function applyPostExtractionFixes(
  extraction: Extraction,
  options: Readonly<{ tablesFormat: TablesFormat }>,
): Extraction {
  return { ...extraction, elements: extraction.elements.map((el) => retypeElement(el, options.tablesFormat)) };
}

/** The capture an element needs, or null when it is not rasterised at all. */
export function rasterJobFor(el: ExtractedElement): RasterJob | null {
  if (el.type !== "visual" && el.type !== "image") return null;
  if (el.bounds.w <= 5 || el.bounds.h <= 5) return null;
  if (el.type === "visual" && el.tag === "text-glow" && el.glowId !== undefined) {
    return { kind: "text-glow", glowId: el.glowId };
  }
  // retypeElement spreads the source element, so a retyped image still carries
  // the table's or text's own fields; read the markers and the text through
  // that optional-field view.
  const marked = el as ExtractedElement & { readonly _wasEmojiText?: boolean; readonly _bakedTable?: boolean; readonly text?: string };
  if (marked._bakedTable === true) return { kind: "baked-table" };
  if (marked._wasEmojiText === true) return { kind: "emoji", text: marked.text ?? "" };
  return { kind: "element" };
}

// Emoji detection: Slides lacks an emoji font, so glyphs like ⚡🔒📊🔍🧐💳
// render as tofu boxes. Text elements whose content is primarily emoji
// codepoints are rasterised from the browser and emitted as an image.
function retypeElement(el: ExtractedElement, tablesFormat: TablesFormat): ExtractedElement {
  // tablesFormat=baked: rasterise each <table> as a single image so rounded
  // corners and every nested element render pixel-perfect (the capture loop
  // captures it; the lib's image case emits slide.addImage). The native <a:tbl>
  // path (which can't do rounded corners) is bypassed.
  if (tablesFormat === "baked" && el.type === "table" && el.bounds.w > 5 && el.bounds.h > 5) {
    return { ...el, type: "image" as const, _bakedTable: true } as ExtractedElement;
  }
  if (el.type !== "text" || !looksLikeEmojiText(el.text || "")) return el;
  // Tight glyph bbox: the original text bounds match the HOST element (e.g.
  // .stat-icon 42×42, .conversion-badge ::before host 110×30) which makes the
  // captured PNG fully mask the underlying native rect/text. Shrink to a
  // glyph-natural box (fontSize × 1.4 per side) positioned at the textbox's
  // alignment-derived centre so the surrounding native chrome (icon-circle
  // bg, "32% conversion" sibling text) shows through. User feedback wave-12A:
  // "make sure that the text is never baked into images" + "Why are bottom
  // icons rendered?" — the rect was native, only the PNG masked it.
  const text = el.text || "";
  const visibleChars = Array.from(text).filter((c) => (c.codePointAt(0) ?? 0) > 0x20);
  const numGlyphs = Math.max(1, visibleChars.length);
  const fontSize = el.style?.fontSize || 20;
  const align = el.style?.textAlign || "left";
  const vCentered = el.verticallyCentered === true;
  const glyphW = Math.min(el.bounds.w, fontSize * 1.4 * numGlyphs);
  const glyphH = Math.min(el.bounds.h, fontSize * 1.4);
  let nx: number;
  if (align === "center") nx = el.bounds.x + (el.bounds.w - glyphW) / 2;
  else if (align === "right" || align === "end") nx = el.bounds.x + el.bounds.w - glyphW;
  else nx = el.bounds.x;
  const ny = vCentered ? el.bounds.y + (el.bounds.h - glyphH) / 2 : el.bounds.y;
  return {
    ...el,
    type: "image" as const,
    _wasEmojiText: true,
    bounds: { x: nx, y: ny, w: glyphW, h: glyphH },
  } as ExtractedElement;
}

function looksLikeEmojiText(s: string): boolean {
  if (!s) return false;
  let emoji = 0, total = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x20) continue;
    total++;
    if (isEmojiCodepoint(cp)) emoji++;
  }
  if (total === 0) return false;
  return emoji / total >= 0.5 && total <= 4;
}

function isEmojiCodepoint(cp: number): boolean {
  // Glyphs that render fine in Slides' standard text fonts must stay TEXT
  // (selectable/editable) — never rasterise them. User feedback (slide_07
  // ✓ check icon, slide_13 ▼ conversion-chip arrows): "can't we use fonts
  // in output?" / "text should never be rendered". These BMP symbol glyphs
  // are NOT pictographic emoji and have reliable monochrome font coverage.
  if (cp >= 0x25A0 && cp <= 0x25FF) return false;      // geometric ▲ ▼ ■ ● ○ (text-renderable)
  if (cp >= 0x2713 && cp <= 0x2718) return false;      // check / cross marks ✓ ✔ ✗ ✘
  if (cp >= 0x2600 && cp <= 0x27BF) return true;       // Misc symbols & dingbats (pictographs)
  if (cp === 0x200D || cp === 0xFE0F) return true;     // ZWJ / variation selector
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;     // Regional indicators (flags)
  if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;     // Main emoji blocks
  if (cp >= 0x2300 && cp <= 0x23FF) return true;       // misc technical (⚙ etc.)
  return false;
}
