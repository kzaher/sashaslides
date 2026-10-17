/**
 * Engine text to Slides text requests: one `insertText`, then `createParagraphBullets` per list
 * run, then `updateParagraphStyle` per paragraph and `updateTextStyle` per run (SPEC.md 21.12).
 *
 * EFFECTIVE STYLES ARE WRITTEN. An engine run stores only what was set and inherits the rest from
 * its placeholder role and the theme (document.ts). The exported element is no longer a
 * placeholder (layouts become plain elements), so each run's style is resolved through the same
 * chain the engine renders with and written whole, theme colours as their colour.
 *
 * LIST NESTING TRAVELS AS LEADING TABS. `createParagraphBullets` reads each paragraph's leading
 * tabs as its nesting level and REMOVES them, which shifts every later index. So the text is
 * inserted with the tabs, the bullet requests run from the LAST list run to the first (removing a
 * tab never moves an earlier range), and every style request after them uses the tab-free indices.
 */
import type { Paragraph, TextBody, TextRun, ThemeSnapshot } from "../engine/src/contracts/document.ts";
import type { PlaceholderRole } from "../engine/src/contracts/document.ts";
import type { SlideId } from "../engine/src/contracts/ids.ts";
import { DEFAULT_PARAGRAPH_STYLE, type Colour, type ListGlyph, type ParagraphStyle, type RunStyle } from "../engine/src/contracts/style.ts";
import { wireSolidFill } from "./export-colours.ts";
import type { InterchangeLossSink } from "./interchange-losses.ts";
import type { ExportRequest, WireCellLocation, WireParagraphStyle, WireTextStyle } from "./slides-requests.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export type TextExportContext = Readonly<{
  theme: ThemeSnapshot;
  pointsPerUnit: number;
  /** This slide's 1-based number, what an automatic slide number prints. */
  slideNumber: number;
  /** Engine slide ids that are exported, for links to slides. */
  exportedSlideIds: ReadonlySet<SlideId>;
  losses: InterchangeLossSink;
}>;

export function textRequests(
  options: Readonly<{
    objectId: string;
    body: TextBody;
    role: PlaceholderRole | null;
    cellLocation: WireCellLocation | null;
    context: TextExportContext;
  }>,
): readonly ExportRequest[] {
  const { objectId, body, context } = options;
  const location = options.cellLocation === null ? {} : { cellLocation: options.cellLocation };
  const paragraphs = body.paragraphs;
  const plainLength = paragraphs.reduce((total, paragraph) => total + paragraphText({ paragraph, context }).length, 0) + paragraphs.length - 1;
  if (plainLength === 0) return [];

  const placeholderStyle = options.role === null ? null : context.theme.placeholderStyles[options.role];
  const paragraphStyles = paragraphs.map((paragraph): ParagraphStyle => ({ ...DEFAULT_PARAGRAPH_STYLE, ...(placeholderStyle?.paragraph ?? {}), ...paragraph.style }));
  const withTabs = paragraphs
    .map((paragraph, index) => {
      const style = paragraphStyles[index] ?? DEFAULT_PARAGRAPH_STYLE;
      const tabs = "\t".repeat(listLevelOf(style.list) ?? 0);
      return tabs + paragraphText({ paragraph, context });
    })
    .join("\n");
  const requests: ExportRequest[] = [{ insertText: { objectId, text: withTabs, insertionIndex: 0, ...location } }];

  // Bullets, last list run first (see the header). Indices here still include the tabs.
  const listRuns = listRunsOf({ paragraphs, paragraphStyles, context });
  for (const listRun of [...listRuns].reverse()) {
    requests.push({ createParagraphBullets: { objectId, textRange: { type: "FIXED_RANGE", startIndex: listRun.start, endIndex: listRun.end }, bulletPreset: listRun.preset, ...location } });
  }

  // Paragraph and run styles, in tab-free indices.
  let offset = 0;
  paragraphs.forEach((paragraph, index) => {
    const text = paragraphText({ paragraph, context });
    const style = paragraphStyles[index] ?? DEFAULT_PARAGRAPH_STYLE;
    const end = offset + text.length + (index < paragraphs.length - 1 ? 1 : 0);
    if (end > offset) {
      // A list paragraph with no indents of its own keeps the indents its bullet preset set.
      const keepBulletIndents = listLevelOf(style.list) !== null && style.indentStart === 0 && style.indentFirstLine === 0;
      const fields = keepBulletIndents ? PARAGRAPH_FIELDS_WITHOUT_INDENTS : PARAGRAPH_FIELDS;
      requests.push({ updateParagraphStyle: { objectId, textRange: { type: "FIXED_RANGE", startIndex: offset, endIndex: end }, style: wireParagraphStyle({ style, context, withIndents: !keepBulletIndents }), fields, ...location } });
    }
    let runOffset = offset;
    for (const run of paragraph.runs) {
      const length = runText({ run, context }).length;
      if (length === 0) continue;
      const resolved: RunStyle = { ...context.theme.defaultRunStyle, ...(placeholderStyle?.run ?? {}), ...run.style };
      const wire = wireTextStyle({ style: resolved, context });
      requests.push({ updateTextStyle: { objectId, textRange: { type: "FIXED_RANGE", startIndex: runOffset, endIndex: runOffset + length }, style: wire.style, fields: wire.fields, ...location } });
      runOffset += length;
    }
    offset = end;
  });
  return requests;
}

/** The bullet preset for a list's level-0 glyph, and whether the preset draws that glyph exactly. */
export function bulletPresetFor(glyph: ListGlyph): Readonly<{ preset: string; exact: boolean }> {
  switch (glyph) {
    case "disc":
      return { preset: "BULLET_DISC_CIRCLE_SQUARE", exact: true };
    case "circle":
    case "square":
      return { preset: "BULLET_DISC_CIRCLE_SQUARE", exact: false };
    case "arrow":
      return { preset: "BULLET_ARROW_DIAMOND_DISC", exact: true };
    case "star":
      return { preset: "BULLET_STAR_CIRCLE_SQUARE", exact: true };
    case "checkbox":
      return { preset: "BULLET_CHECKBOX", exact: true };
    case "decimal":
      return { preset: "NUMBERED_DIGIT_ALPHA_ROMAN", exact: true };
    case "decimalZeroPadded":
      return { preset: "NUMBERED_ZERODIGIT_ALPHA_ROMAN", exact: true };
    case "upperAlphabetic":
      return { preset: "NUMBERED_UPPERALPHA_ALPHA_ROMAN", exact: true };
    case "upperRoman":
      return { preset: "NUMBERED_UPPERROMAN_UPPERALPHA_DIGIT", exact: true };
    case "lowerAlphabetic":
    case "lowerRoman":
      return { preset: "NUMBERED_DIGIT_ALPHA_ROMAN", exact: false };
    default:
      return assertNever(glyph);
  }
}

/** The nesting level of a list paragraph, or null outside a list. */
function listLevelOf(list: ParagraphStyle["list"]): number | null {
  switch (list.kind) {
    case "list":
      return list.level;
    case "none":
      return null;
    default:
      return assertNever(list);
  }
}

function highlightColourOf(highlight: RunStyle["highlight"]): Colour | null {
  switch (highlight.kind) {
    case "none":
      return null;
    case "literal":
    case "theme":
      return highlight;
    default:
      return assertNever(highlight);
  }
}

const PARAGRAPH_FIELDS = "alignment,lineSpacing,spaceAbove,spaceBelow,indentStart,indentFirstLine,direction";
const PARAGRAPH_FIELDS_WITHOUT_INDENTS = "alignment,lineSpacing,spaceAbove,spaceBelow,direction";

function paragraphText(options: Readonly<{ paragraph: Paragraph; context: TextExportContext }>): string {
  return options.paragraph.runs.map((run) => runText({ run, context: options.context })).join("");
}

function runText(options: Readonly<{ run: TextRun; context: TextExportContext }>): string {
  const { run, context } = options;
  switch (run.kind) {
    case "text":
      // A vertical tab is Slides' own line break inside a paragraph; anything else in the
      // control range would be refused by insertText.
      return run.text.replace(/[\u0000-\u0008\u000c\u000e-\u001f]/g, "");
    case "automaticText":
      context.losses.addOncePerDeck({ feature: "automaticText", detail: "Automatic slide numbers became fixed numbers; Google Slides has no request that inserts the field." });
      return String(context.slideNumber);
    default:
      return assertNever(run);
  }
}

type ListRun = Readonly<{ start: number; end: number; preset: string }>;

/** Consecutive paragraphs of one list, as ranges in the WITH-TABS text, each with its preset. */
function listRunsOf(
  options: Readonly<{ paragraphs: readonly Paragraph[]; paragraphStyles: readonly ParagraphStyle[]; context: TextExportContext }>,
): readonly ListRun[] {
  const runs: ListRun[] = [];
  let offset = 0;
  let open: { listId: string; start: number; end: number; preset: string } | null = null;
  options.paragraphs.forEach((paragraph, index) => {
    const style = options.paragraphStyles[index] ?? DEFAULT_PARAGRAPH_STYLE;
    const tabs = listLevelOf(style.list) ?? 0;
    const length = tabs + paragraphText({ paragraph, context: options.context }).length;
    const end = offset + length + (index < options.paragraphs.length - 1 ? 1 : 0);
    const list = style.list;
    switch (list.kind) {
      case "list": {
        if (open !== null && open.listId === list.listId) {
          open.end = end;
          break;
        }
        if (open !== null) runs.push(open);
        const preset = bulletPresetFor(list.glyph);
        if (!preset.exact) options.context.losses.add({ feature: "listGlyph", detail: `The ${list.glyph} bullets are drawn with the nearest Slides preset, ${preset.preset}.` });
        open = { listId: list.listId, start: offset, end, preset: preset.preset };
        break;
      }
      case "none":
        if (open !== null) runs.push(open);
        open = null;
        break;
      default:
        assertNever(list);
    }
    offset = end;
  });
  if (open !== null) runs.push(open);
  return runs.map((run) => ({ start: run.start, end: run.end, preset: run.preset }));
}

function wireParagraphStyle(options: Readonly<{ style: ParagraphStyle; context: TextExportContext; withIndents: boolean }>): WireParagraphStyle {
  const { style, context } = options;
  const points = (units: number): Readonly<{ magnitude: number; unit: "PT" }> => ({ magnitude: roundPoints(units * context.pointsPerUnit), unit: "PT" });
  const base: WireParagraphStyle = {
    alignment: ALIGNMENT[style.alignment],
    lineSpacing: Math.round(style.lineSpacing * 100),
    spaceAbove: points(style.spaceAbove),
    spaceBelow: points(style.spaceBelow),
    direction: style.direction === "rightToLeft" ? "RIGHT_TO_LEFT" : "LEFT_TO_RIGHT",
  };
  if (!options.withIndents) return base;
  // Slides measures the first line from the start edge; the engine from `indentStart` (import-text.ts).
  return { ...base, indentStart: points(style.indentStart), indentFirstLine: points(style.indentStart + style.indentFirstLine) };
}

const ALIGNMENT: Readonly<Record<ParagraphStyle["alignment"], NonNullable<WireParagraphStyle["alignment"]>>> = {
  start: "START",
  centre: "CENTER",
  end: "END",
  justify: "JUSTIFIED",
};

function wireTextStyle(options: Readonly<{ style: RunStyle; context: TextExportContext }>): Readonly<{ style: WireTextStyle; fields: string }> {
  const { style, context } = options;
  const fields = ["weightedFontFamily", "fontSize", "bold", "italic", "underline", "strikethrough", "smallCaps", "baselineOffset", "foregroundColor", "backgroundColor", "link"];
  const foreground = wireSolidFill({ colour: style.colour, theme: context.theme, losses: context.losses });
  const highlight = highlightColourOf(style.highlight);
  const highlightFill = highlight === null ? null : wireSolidFill({ colour: highlight, theme: context.theme, losses: context.losses });
  if (style.letterSpacing !== 0) context.losses.add({ feature: "letterSpacing", detail: "Letter spacing has no Slides equivalent and was left out." });
  if (style.textCase === "allCaps") context.losses.add({ feature: "allCaps", detail: "All capitals has no Slides equivalent; the text keeps its own case." });
  const link = linkOf({ style, context });
  return {
    style: {
      weightedFontFamily: { fontFamily: style.fontFamily, weight: Math.round(style.fontWeight / 100) * 100 },
      fontSize: { magnitude: roundPoints(style.fontSize * context.pointsPerUnit), unit: "PT" },
      bold: style.fontWeight >= 600,
      italic: style.fontStyle === "italic",
      underline: style.underline,
      strikethrough: style.strikethrough,
      smallCaps: style.textCase === "smallCaps",
      baselineOffset: style.baselineOffset === "superscript" ? "SUPERSCRIPT" : style.baselineOffset === "subscript" ? "SUBSCRIPT" : "NONE",
      foregroundColor: { opaqueColor: foreground.color },
      backgroundColor: highlightFill === null ? {} : { opaqueColor: highlightFill.color },
      ...(link === null ? {} : { link }),
    },
    // `link` in the mask with no value clears an inherited link, which is what "none" means.
    fields: fields.join(","),
  };
}

function linkOf(options: Readonly<{ style: RunStyle; context: TextExportContext }>): NonNullable<WireTextStyle["link"]> | null {
  const link = options.style.link;
  switch (link.kind) {
    case "none":
      return null;
    case "webAddress":
      return { url: link.address };
    case "slide":
      return options.context.exportedSlideIds.has(link.slideId) ? { pageObjectId: link.slideId } : null;
    default:
      return assertNever(link);
  }
}

function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}
