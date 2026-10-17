/**
 * Slides text to engine text: runs, paragraphs and lists, with every inherited style RESOLVED
 * through the placeholder chain and written explicitly (SPEC.md 21.12).
 *
 * WHY RESOLVE INSTEAD OF INHERIT. The Slides programming interface reports a run's style with "inherited text styles
 * represented as unset fields": a run in a slide's body placeholder inherits from the "\n" of the
 * paragraph at the SAME NESTING LEVEL in its layout's placeholder, which inherits from the master's
 * (measured in the fixture: the master's body holds one paragraph per level 0 to 8, 18 point at
 * level 0 and 14 below). The engine's own chain is different (run, then the placeholder ROLE's
 * theme style, then the deck default), and has no per-level styles, so an inherited value left
 * unset would resolve to the wrong thing. Writing the Slides-resolved value onto the run keeps
 * what the person saw. Colours keep their theme references, so a theme change still recolours.
 *
 * The chain is walked by `parentObjectId` through an index of every layout and master element.
 *
 * A BULLET'S OWN STYLE CROSSES ONLY WHERE IT DIFFERS. Slides reports a `bulletStyle` per list
 * paragraph; the engine's marker otherwise takes the first run's style, so only a colour or size
 * that differs from that run's is written (`markerColour`, `markerFontSize`). The html2slides
 * converter's blue, red, green and orange dots came out grey without it.
 *
 * A SOFT LINE BREAK STAYS U+000B. Slides stores Shift+Enter as a vertical tab inside a run, and so
 * does the engine (state/editor/text-model.ts `LINE_BREAK_CHARACTER`); the renderer draws it.
 */
import type { Paragraph, TextBody, TextRun } from "../engine/src/contracts/document.ts";
import type { ListId, SlideId } from "../engine/src/contracts/ids.ts";
import type { BaselineOffset, Colour, ListGlyph, ListMarkerColour, ListMembership, ParagraphStylePatch, RunLink, RunStylePatch, TextAlignment } from "../engine/src/contracts/style.ts";
import { colourOf, type ColourContext } from "./import-colours.ts";
import type { InterchangeLossSink } from "./interchange-losses.ts";
import type { SlidesLink, SlidesParagraph, SlidesParagraphStyle, SlidesShape, SlidesText, SlidesTextStyle } from "./slides-presentation.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export type TextContext = Readonly<{
  colours: ColourContext;
  unitsPerPoint: number;
  /** Every layout and master shape by object id: the placeholder chain's parents. */
  placeholderParents: ReadonlyMap<string, SlidesShape>;
  /** Slides page object ids to the engine ids they became, in slide order. */
  slideIds: ReadonlyMap<string, SlideId>;
  slideOrder: readonly SlideId[];
  /** The slide this text is on (for relative links); null on layouts. */
  currentSlideIndex: number | null;
  /** The engine list id for a Slides list id (minted once per import). */
  listIdFor: (slidesListId: string) => ListId;
  losses: InterchangeLossSink;
}>;

export const EMPTY_BODY: TextBody = { paragraphs: [{ style: {}, runs: [] }] };

/**
 * One text body. `placeholderParentId` starts the chain (null for a plain text box, a table cell
 * or the speaker notes, whose runs carry their own complete styles or the deck defaults).
 */
export function importTextBody(
  options: Readonly<{ text: SlidesText | null; placeholderParentId: string | null; context: TextContext }>,
): TextBody {
  const { text, context } = options;
  if (text === null || text.paragraphs.length === 0) return EMPTY_BODY;
  const paragraphs = text.paragraphs.map((paragraph): Paragraph => {
    const chain = parentParagraphs({ parentId: options.placeholderParentId, level: paragraph.nestingLevel, context });
    const paragraphStyle = mergeParagraphStyles([...chain.map((parent) => parent.style), paragraph.style]);
    const runs = paragraph.runs.map((run): TextRun => {
      const resolved = mergeTextStyles([...chain.map((parent) => parent.markStyle), run.style]);
      const style = runStylePatch({ style: resolved, context });
      switch (run.kind) {
        case "text":
          return { kind: "text", text: run.content, style };
        case "autoText":
          if (run.autoTextType === "SLIDE_NUMBER") return { kind: "automaticText", field: "slideNumber", style };
          context.losses.add({ feature: "autoText", detail: `An automatic ${run.autoTextType} field was imported as its text "${run.content}".` });
          return { kind: "text", text: run.content, style };
        default:
          return assertNever(run);
      }
    });
    const firstRunStyle = runs[0]?.style ?? runStylePatch({ style: mergeTextStyles([...chain.map((parent) => parent.markStyle), paragraph.markStyle]), context });
    return { style: paragraphPatch({ style: paragraphStyle, paragraph, firstRunStyle, context }), runs: mergeAdjacentRuns(runs) };
  });
  return { paragraphs };
}

/** The fully resolved run and paragraph style of a placeholder at level 0: a theme's placeholder style. */
export function resolvedPlaceholderStyle(
  options: Readonly<{ shape: SlidesShape; context: TextContext }>,
): Readonly<{ run: RunStylePatch; paragraph: ParagraphStylePatch }> {
  const own = options.shape.text?.paragraphs[0];
  const chain = parentParagraphs({ parentId: options.shape.placeholder?.parentObjectId ?? null, level: 0, context: options.context });
  const markStyles = [...chain.map((parent) => parent.markStyle), ...(own === undefined ? [] : [own.markStyle])];
  const paragraphStyles = [...chain.map((parent) => parent.style), ...(own === undefined ? [] : [own.style])];
  const paragraph = paragraphPatch({ style: mergeParagraphStyles(paragraphStyles), paragraph: null, firstRunStyle: {}, context: options.context });
  return { run: runStylePatch({ style: mergeTextStyles(markStyles), context: options.context }), paragraph };
}

/** The nearest of the 12 glyph presets for a Slides bullet glyph, and whether it is exact. */
export function listGlyphFor(glyph: string): Readonly<{ glyph: ListGlyph; exact: boolean }> {
  const trimmed = glyph.trim();
  const exact = EXACT_GLYPHS.get(trimmed);
  if (exact !== undefined) return { glyph: exact, exact: true };
  const numbered = /^([0-9]+|[a-zA-Z]+)[.)]?$/.exec(trimmed);
  if (numbered?.[1] !== undefined) {
    const marker = numbered[1];
    if (/^0[0-9]+$/.test(marker)) return { glyph: "decimalZeroPadded", exact: true };
    if (/^[0-9]+$/.test(marker)) return { glyph: "decimal", exact: true };
    if (/^[ivx]+$/.test(marker)) return { glyph: "lowerRoman", exact: true };
    if (/^[IVX]+$/.test(marker)) return { glyph: "upperRoman", exact: true };
    if (/^[a-z]+$/.test(marker)) return { glyph: "lowerAlphabetic", exact: true };
    return { glyph: "upperAlphabetic", exact: true };
  }
  return { glyph: NEAREST_GLYPHS.get(trimmed) ?? "disc", exact: false };
}

/** The Slides glyphs the presets draw exactly (the BULLET_* presets' characters). */
const EXACT_GLYPHS: ReadonlyMap<string, ListGlyph> = new Map<string, ListGlyph>([
  ["●", "disc"],
  ["•", "disc"],
  ["○", "circle"],
  ["■", "square"],
  ["➢", "arrow"],
  ["★", "star"],
  ["❏", "checkbox"],
]);

/** Close-enough glyphs; importing one reports a `listGlyph` loss. */
const NEAREST_GLYPHS: ReadonlyMap<string, ListGlyph> = new Map<string, ListGlyph>([
  ["◆", "square"],
  ["❖", "square"],
  ["□", "checkbox"],
  ["☐", "checkbox"],
  ["✓", "checkbox"],
  ["➤", "arrow"],
  ["►", "arrow"],
  ["➔", "arrow"],
  ["→", "arrow"],
  ["☆", "star"],
  ["-", "disc"],
]);

/** The parent placeholder paragraphs at `level`, outermost (master) first. */
function parentParagraphs(options: Readonly<{ parentId: string | null; level: number; context: TextContext }>): readonly SlidesParagraph[] {
  const chain: SlidesParagraph[] = [];
  const visited = new Set<string>();
  let parentId = options.parentId;
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = options.context.placeholderParents.get(parentId);
    if (parent === undefined) break;
    const paragraph = paragraphAtLevel({ text: parent.text, level: options.level });
    if (paragraph !== null) chain.unshift(paragraph);
    parentId = parent.placeholder?.parentObjectId ?? null;
  }
  return chain;
}

/** The parent's paragraph for a nesting level: the one at that level, else the deepest shallower one. */
function paragraphAtLevel(options: Readonly<{ text: SlidesText | null; level: number }>): SlidesParagraph | null {
  const paragraphs = options.text?.paragraphs ?? [];
  let best: SlidesParagraph | null = null;
  for (const paragraph of paragraphs) {
    if (paragraph.nestingLevel === options.level) return paragraph;
    if (paragraph.nestingLevel < options.level && (best === null || paragraph.nestingLevel > best.nestingLevel)) best = paragraph;
  }
  return best ?? paragraphs[0] ?? null;
}

function mergeTextStyles(styles: readonly SlidesTextStyle[]): SlidesTextStyle {
  return styles.reduce<SlidesTextStyle>((merged, style) => ({ ...merged, ...style }), {});
}

function mergeParagraphStyles(styles: readonly SlidesParagraphStyle[]): SlidesParagraphStyle {
  return styles.reduce<SlidesParagraphStyle>((merged, style) => ({ ...merged, ...style }), {});
}

function runStylePatch(options: Readonly<{ style: SlidesTextStyle; context: TextContext }>): RunStylePatch {
  const { style, context } = options;
  const patch: { -readonly [Key in keyof RunStylePatch]: RunStylePatch[Key] } = {};
  if (style.fontFamily !== undefined) patch.fontFamily = style.fontFamily;
  if (style.fontSizePoints !== undefined) patch.fontSize = roundUnits(style.fontSizePoints * context.unitsPerPoint);
  const weight = style.weight ?? (style.bold === undefined ? undefined : style.bold ? 700 : 400);
  if (weight !== undefined) patch.fontWeight = style.bold === true && weight < 600 ? 700 : weight;
  if (style.italic !== undefined) patch.fontStyle = style.italic ? "italic" : "normal";
  if (style.underline !== undefined) patch.underline = style.underline;
  if (style.strikethrough !== undefined) patch.strikethrough = style.strikethrough;
  if (style.foreground !== undefined && style.foreground !== null) patch.colour = colourOf({ colour: style.foreground, alpha: 1, context: context.colours });
  if (style.background !== undefined) {
    patch.highlight = style.background === null ? { kind: "none" } : colourOf({ colour: style.background, alpha: 1, context: context.colours });
  }
  if (style.link !== undefined) patch.link = runLinkOf({ link: style.link, context });
  if (style.baselineOffset !== undefined) patch.baselineOffset = baselineOffsetOf(style.baselineOffset);
  if (style.smallCaps !== undefined) patch.textCase = style.smallCaps ? "smallCaps" : "none";
  return patch;
}

function runLinkOf(options: Readonly<{ link: SlidesLink; context: TextContext }>): RunLink {
  const { link, context } = options;
  switch (link.kind) {
    case "url":
      return { kind: "webAddress", address: link.url };
    case "page": {
      const slideId = context.slideIds.get(link.pageObjectId);
      return slideId === undefined ? { kind: "none" } : { kind: "slide", slideId };
    }
    case "slideIndex":
      return slideLinkAt({ index: link.slideIndex, context });
    case "relative":
      return slideLinkAt({ index: relativeSlideIndex({ relativeLink: link.relativeLink, context }), context });
    default:
      return assertNever(link);
  }
}

function relativeSlideIndex(options: Readonly<{ relativeLink: string; context: TextContext }>): number {
  const current = options.context.currentSlideIndex ?? 0;
  switch (options.relativeLink) {
    case "NEXT_SLIDE":
      return current + 1;
    case "PREVIOUS_SLIDE":
      return current - 1;
    case "FIRST_SLIDE":
      return 0;
    case "LAST_SLIDE":
      return options.context.slideOrder.length - 1;
    default:
      return -1;
  }
}

function slideLinkAt(options: Readonly<{ index: number; context: TextContext }>): RunLink {
  const slideId = options.context.slideOrder[options.index];
  return slideId === undefined ? { kind: "none" } : { kind: "slide", slideId };
}

function baselineOffsetOf(offset: string): BaselineOffset {
  if (offset === "SUPERSCRIPT") return "superscript";
  if (offset === "SUBSCRIPT") return "subscript";
  return "none";
}

function paragraphPatch(
  options: Readonly<{ style: SlidesParagraphStyle; paragraph: SlidesParagraph | null; firstRunStyle: RunStylePatch; context: TextContext }>,
): ParagraphStylePatch {
  const { style, paragraph, context } = options;
  const patch: { -readonly [Key in keyof ParagraphStylePatch]: ParagraphStylePatch[Key] } = {};
  if (style.alignment !== undefined) patch.alignment = alignmentOf(style.alignment);
  if (style.lineSpacingPercent !== undefined) patch.lineSpacing = style.lineSpacingPercent / 100;
  if (style.spaceAbovePoints !== undefined) patch.spaceAbove = roundUnits(style.spaceAbovePoints * context.unitsPerPoint);
  if (style.spaceBelowPoints !== undefined) patch.spaceBelow = roundUnits(style.spaceBelowPoints * context.unitsPerPoint);
  const indentStart = style.indentStartPoints ?? 0;
  if (style.indentStartPoints !== undefined) patch.indentStart = roundUnits(indentStart * context.unitsPerPoint);
  // Slides' first-line indent is measured from the start edge; the engine's is relative to
  // `indentStart` (a stylesheet text-indent), so the difference is what crosses.
  if (style.indentFirstLinePoints !== undefined) patch.indentFirstLine = roundUnits((style.indentFirstLinePoints - indentStart) * context.unitsPerPoint);
  if (style.direction !== undefined) patch.direction = style.direction === "RIGHT_TO_LEFT" ? "rightToLeft" : "leftToRight";
  if (paragraph === null) return patch;
  const bullet = paragraph.bullet;
  if (bullet === null || bullet.glyph.trim().length === 0) {
    patch.list = { kind: "none" };
    return patch;
  }
  const glyph = listGlyphFor(bullet.glyph);
  if (!glyph.exact) context.losses.add({ feature: "listGlyph", detail: `The bullet "${bullet.glyph}" is shown as the nearest preset, ${glyph.glyph}.` });
  const membership: ListMembership = { kind: "list", listId: context.listIdFor(bullet.listId), glyph: glyph.glyph, level: Math.min(8, Math.max(0, bullet.nestingLevel)) };
  patch.list = { ...membership, ...markerStyle({ bulletStyle: runStylePatch({ style: bullet.style, context }), firstRunStyle: options.firstRunStyle }) };
  return patch;
}

/** The bullet's colour and size where they differ from the text the marker would otherwise copy (see the header). */
function markerStyle(
  options: Readonly<{ bulletStyle: RunStylePatch; firstRunStyle: RunStylePatch }>,
): Readonly<{ markerColour?: ListMarkerColour; markerFontSize?: number }> {
  const { bulletStyle, firstRunStyle } = options;
  const colour = bulletStyle.colour;
  const differentColour = colour !== undefined && JSON.stringify(colour) !== JSON.stringify(firstRunStyle.colour);
  const fontSize = bulletStyle.fontSize;
  const differentSize = fontSize !== undefined && fontSize !== firstRunStyle.fontSize;
  return {
    ...(differentColour ? { markerColour: markerColourOf(colour) } : {}),
    ...(differentSize ? { markerFontSize: fontSize } : {}),
  };
}

/** A colour as the membership's flat marker colour; the alpha is dropped (Slides' bullets are opaque). */
function markerColourOf(colour: Colour): ListMarkerColour {
  switch (colour.kind) {
    case "literal":
      return colour.hexadecimal;
    case "theme":
      return colour.slot;
    default:
      return assertNever(colour);
  }
}

function alignmentOf(alignment: string): TextAlignment {
  switch (alignment) {
    case "CENTER":
      return "centre";
    case "END":
      return "end";
    case "JUSTIFIED":
      return "justify";
    default:
      return "start";
  }
}

/** Two neighbouring text runs with identical styles are one run (Slides splits at link and spell boundaries). */
function mergeAdjacentRuns(runs: readonly TextRun[]): readonly TextRun[] {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    const previousText = previous === undefined ? null : plainTextOf(previous);
    const text = plainTextOf(run);
    if (previous !== undefined && previousText !== null && text !== null && sameStyle(previous.style, run.style)) {
      merged[merged.length - 1] = { kind: "text", text: previousText + text, style: previous.style };
      continue;
    }
    merged.push(run);
  }
  return merged;
}

/** A plain text run's text; null for a field (it never merges with its neighbours). */
function plainTextOf(run: TextRun): string | null {
  switch (run.kind) {
    case "text":
      return run.text;
    case "automaticText":
      return null;
    default:
      return assertNever(run);
  }
}

function sameStyle(first: RunStylePatch, second: RunStylePatch): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** Sizes to a thousandth of a unit, so 18 points is 32 units, not 31.999999999999996. */
export function roundUnits(value: number): number {
  return Math.round(value * 1000) / 1000;
}
