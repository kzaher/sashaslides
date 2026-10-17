// A TEXT BODY AS PARAGRAPHS AND RUNS, shared by the static renderer and the inline text editor, so
// the text a user edits in place is drawn by exactly the code that draws it everywhere else.
//
// Key decisions:
//
//  * POSITIONS ARE DATA ATTRIBUTES. Every paragraph carries the index it starts at and every run
//    the index of its first character (`data-sasha-paragraph-start`, `data-sasha-run-start`), in the
//    Y.Text index space (text-layout.ts). The inline editor maps a page selection back to indices
//    through them and nothing else, so drawing and editing agree by construction.
//  * A PARAGRAPH'S RUNS SIT IN ONE SPAN that carries the paragraph's base run (its first run):
//    family, size, weight, style, colour and Google's line box (inline-styles.ts). A run states
//    only what differs from it, so a run in the paragraph's own style is a bare span and exported
//    HTML can be edited in an HTML editor without the text breaking apart (complex slide 25). Only a
//    run larger than the base (a BIG word) moves its own box, by the difference of the two drops.
//  * PARAGRAPH KEYS CARRY A PREFIX. The inline editor passes `renderGeneration` into it, so when an
//    input-method composition ends the paragraphs remount instead of React reconciling text the
//    browser wrote into the page itself (SPEC.md "Input method composition").
//  * MARKERS AND FIELDS ARE NOT EDITABLE TEXT. A list marker is an absolutely positioned span outside
//    the index space; an automatic slide number is one character of the index space drawn as its live
//    value. Both are `contentEditable={false}`, so a caret never lands inside them.
//  * A LINK TO A SLIDE is an anchor carrying `data-sasha-link-slide-id`: the presenter navigates on
//    it; the editor never follows a link on click.
//  * A LIST PARAGRAPH WITH ITS OWN INDENTS IS LAID OUT THE WAY SLIDES LAYS IT OUT. With both indents
//    0 (every list made in the engine) the marker sits in a gutter of LIST_INDENT_PER_LEVEL per
//    level before the text. A paragraph that states indents (an imported list: Slides' default is
//    start 36 points, first line 18) means them as Slides does, and export writes them back as
//    such (google-slides/export-text.ts): the wrapped lines start at indentStart, and with a
//    hanging first line (indentFirstLine < 0) so does the first line's text, while the marker
//    ENDS at indentStart + indentFirstLine, right-aligned there. Measured on Google's thumbnails
//    of all four hanging lists in the SxS decks (deck 8, complex 30, basic 12 and 16): the
//    glyph's ink ends 0.8 to 3.2 units before that point (its side bearing) at sizes 12 to 40,
//    where a marker STARTING there was 4 to 25 units right of Google's. Adding the engine's gutter
//    on top as well drew the marker over the first letter and every line 32 units right of
//    Slides' (deck 8). A first line indented past indentStart (no measured case) starts the
//    marker there and the text one gutter later, as the engine's own lists do.
//  * A MARKER CAN HAVE ITS OWN COLOUR AND SIZE (`markerColour`, `markerFontSize`, Slides'
//    `bulletStyle`). The marker box keeps the paragraph's own font and line height, so its line
//    has the same baseline as the text's, and an inner span carries the glyph's colour and size.
//  * A SOFT LINE BREAK (U+000B, Shift+Enter, as Slides stores it) is drawn as "\n", which the text
//    layer's pre-wrap breaks on. Both are one character, so the positions the inline editor reads
//    from text node lengths do not move; a raw U+000B drew as a missing-glyph box.

import { memo, type CSSProperties, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import { plainRunText, type Paragraph, type TextBody, type TextRun } from "../../contracts/document.ts";
import type { SlideId } from "../../contracts/ids.ts";
import { listMarkerColour, type ListMembership, type ParagraphStyle, type RunLink, type RunStyle } from "../../contracts/style.ts";
import { SLIDE_LINK_ATTRIBUTE } from "../../contracts/render.ts";
import { clampListLevel } from "../../shared/list-glyphs.ts";
import { colourValue, markerRunDeclarations, paragraphDeclarations, paragraphRunsDeclarations, roundNumber, runDeclarations } from "./inline-styles.ts";
import {
  LIST_INDENT_PER_LEVEL,
  listMarkers,
  paragraphBaseRunStyle,
  paragraphStarts,
  resolveParagraphStyle,
  resolveRunStyle,
  runStarts,
  type TextStyleContext,
} from "./text-layout.ts";

export const PARAGRAPH_START_ATTRIBUTE = "data-sasha-paragraph-start";
export const RUN_START_ATTRIBUTE = "data-sasha-run-start";
export const AUTOMATIC_TEXT_ATTRIBUTE = "data-sasha-automatic-text";
export const LIST_MARKER_ATTRIBUTE = "data-sasha-list-marker";
/** The editor generation a paragraph was rendered in (observable proof of the composition remount). */
export const RENDER_GENERATION_ATTRIBUTE = "data-sasha-render-generation";

export type TextParagraphsProperties = Readonly<{
  body: TextBody;
  styleContext: TextStyleContext;
  slideNumber: number;
  slideNumberOf: (slideId: SlideId) => number | null;
  /** The shrink-on-overflow factor, 1 when the text fits. */
  fontScale: number;
  /** Paragraph keys start with it (see the header); the static renderer passes 0. */
  renderGeneration: number;
  /**
   * Draws every run in this colour instead of its own: speaker notes are read in the chrome, where
   * slide ink (dark text for a white slide) would vanish on the dark scheme's panels. Slides never set it.
   */
  inkColour?: string;
}>;

export const TextParagraphs = memo(function TextParagraphs(properties: TextParagraphsProperties): ReactElement {
  const starts = paragraphStarts(properties.body);
  const markers = listMarkers(properties.body, properties.styleContext);
  return (
    <>
      {properties.body.paragraphs.map((paragraph, index) => (
        <ParagraphView
          key={paragraphKey({ renderGeneration: properties.renderGeneration, index })}
          paragraph={paragraph}
          start={starts[index] ?? 0}
          marker={markers[index] ?? null}
          properties={properties}
        />
      ))}
    </>
  );
});

/** A paragraph's React key: the generation first, so a bumped generation remounts every paragraph. */
export function paragraphKey(options: Readonly<{ renderGeneration: number; index: number }>): string {
  return `${options.renderGeneration}:${options.index}`;
}

function ParagraphView(options: Readonly<{ paragraph: Paragraph; start: number; marker: string | null; properties: TextParagraphsProperties }>): ReactElement {
  const { paragraph, properties } = options;
  const context = properties.styleContext;
  const style = resolveParagraphStyle({ context, patch: paragraph.style });
  const base = paragraphBaseRunStyle({ context, paragraph });
  const list = listOf(style.list);
  const layout = list === null ? null : listLayout({ style, level: list.level });
  const laidOut = layout === null ? style : { ...style, indentFirstLine: layout.textIndent };
  const declarations = inked(paragraphDeclarations({ style: laidOut, base, theme: context.theme, fontScale: properties.fontScale, listIndent: layout?.listIndent ?? 0 }), properties.inkColour);
  const starts = runStarts(paragraph, options.start);
  const attributes = {
    [PARAGRAPH_START_ATTRIBUTE]: options.start,
    [RENDER_GENERATION_ATTRIBUTE]: properties.renderGeneration,
  };
  return (
    <div style={declarations} {...attributes}>
      {options.marker === null || list === null || layout === null ? null : (
        <span contentEditable={false} {...{ [LIST_MARKER_ATTRIBUTE]: "" }} style={markerDeclarations({ layout, fontScale: properties.fontScale, runStyle: inked(markerRunDeclarations({ base, lineSpacing: style.lineSpacing, theme: context.theme, fontScale: properties.fontScale }), properties.inkColour) })}>
          {markerGlyph({ marker: options.marker, list, properties })}
        </span>
      )}
      {paragraph.runs.length === 0 ? (
        <br />
      ) : (
        <span style={inked(paragraphRunsDeclarations({ base, lineSpacing: style.lineSpacing, theme: context.theme, fontScale: properties.fontScale }), properties.inkColour)}>
          {paragraph.runs.map((run, index) => (
            <RunView key={index} run={run} base={base} lineSpacing={style.lineSpacing} start={starts[index] ?? options.start} properties={properties} />
          ))}
        </span>
      )}
    </div>
  );
}

function RunView(options: Readonly<{ run: TextRun; base: RunStyle; lineSpacing: number; start: number; properties: TextParagraphsProperties }>): ReactElement {
  const { run, properties } = options;
  const style = resolveRunStyle({ context: properties.styleContext, patch: run.style });
  const declarations = runDeclarations({ style, base: options.base, lineSpacing: options.lineSpacing, theme: properties.styleContext.theme, fontScale: properties.fontScale });
  // The ink colour is on the paragraph's span already; a run's own colour would override it.
  if (properties.inkColour !== undefined) delete declarations.color;
  const text = plainRunText({ run, slideNumber: properties.slideNumber }).replace(SOFT_LINE_BREAKS, "\n");
  const content = runContent({ run, text, start: options.start, declarations });
  return linkWrapped({ link: style.link, content, slideNumberOf: properties.slideNumberOf });
}

function runContent(options: Readonly<{ run: TextRun; text: string; start: number; declarations: CSSProperties }>): ReactElement {
  switch (options.run.kind) {
    case "text":
      return (
        <span style={options.declarations} {...{ [RUN_START_ATTRIBUTE]: options.start }}>
          {options.text}
        </span>
      );
    case "automaticText":
      return (
        <span style={options.declarations} contentEditable={false} {...{ [RUN_START_ATTRIBUTE]: options.start, [AUTOMATIC_TEXT_ATTRIBUTE]: options.run.field }}>
          {options.text}
        </span>
      );
    default:
      return assertNever(options.run);
  }
}

function linkWrapped(options: Readonly<{ link: RunLink; content: ReactElement; slideNumberOf: (slideId: SlideId) => number | null }>): ReactElement {
  const link = options.link;
  switch (link.kind) {
    case "none":
      return options.content;
    case "webAddress":
      return (
        <a href={safeWebAddress(link.address)} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "inherit" }}>
          {options.content}
        </a>
      );
    case "slide": {
      const number = options.slideNumberOf(link.slideId);
      return (
        <a href={number === null ? "#" : `#slide=${number}`} style={{ color: "inherit", textDecoration: "inherit" }} {...{ [SLIDE_LINK_ATTRIBUTE]: link.slideId }}>
          {options.content}
        </a>
      );
    }
    default:
      return assertNever(link);
  }
}

function inked(declarations: CSSProperties, inkColour: string | undefined): CSSProperties {
  return inkColour === undefined ? declarations : { ...declarations, color: inkColour };
}

/** Slides' soft line break, drawn as a line feed (see the header). */
const SOFT_LINE_BREAKS = /\u000B/g;

/** The membership with its level clamped to 0..8, or null outside a list. */
function listOf(list: ParagraphStyle["list"]): ListMembership | null {
  switch (list.kind) {
    case "none":
      return null;
    case "list":
      return { ...list, level: clampListLevel(list.level) };
    default:
      return assertNever(list);
  }
}

/** Where a list paragraph's marker and text go, in slide units from the text box's content start. */
export type ListLayout = Readonly<{
  /** Added to `indentStart` as the paragraph's start padding: the wrapped lines' start. */
  listIndent: number;
  /** The first line's text indent from the wrapped lines' start. */
  textIndent: number;
  /** The marker's box: its start, its width, and which edge of it the glyph keeps to. */
  markerStart: number;
  markerWidth: number;
  markerAlignment: "start" | "end";
}>;

/** The two list layouts (see the header): the engine's gutter, or Slides' own indents. */
export function listLayout(options: Readonly<{ style: Pick<ParagraphStyle, "indentStart" | "indentFirstLine">; level: number }>): ListLayout {
  const { indentStart, indentFirstLine } = options.style;
  if (indentStart === 0 && indentFirstLine === 0) {
    return { listIndent: (options.level + 1) * LIST_INDENT_PER_LEVEL, textIndent: 0, markerStart: options.level * LIST_INDENT_PER_LEVEL, markerWidth: LIST_INDENT_PER_LEVEL, markerAlignment: "start" };
  }
  const firstLineStart = indentStart + indentFirstLine;
  return indentFirstLine < 0
    ? { listIndent: 0, textIndent: 0, markerStart: firstLineStart - LIST_INDENT_PER_LEVEL, markerWidth: LIST_INDENT_PER_LEVEL, markerAlignment: "end" }
    : { listIndent: 0, textIndent: indentFirstLine + LIST_INDENT_PER_LEVEL, markerStart: firstLineStart, markerWidth: LIST_INDENT_PER_LEVEL, markerAlignment: "start" };
}

function markerDeclarations(options: Readonly<{ layout: ListLayout; fontScale: number; runStyle: CSSProperties }>): CSSProperties {
  return {
    ...options.runStyle,
    position: "absolute",
    insetInlineStart: `${roundNumber(options.layout.markerStart * options.fontScale)}px`,
    width: `${roundNumber(options.layout.markerWidth * options.fontScale)}px`,
    textIndent: 0,
    ...(options.layout.markerAlignment === "end" ? { textAlign: "end", whiteSpace: "nowrap" } : {}),
    textDecoration: "none",
    userSelect: "none",
  };
}

/** The marker text, in its own colour and size when the list states them (see the header). */
function markerGlyph(options: Readonly<{ marker: string; list: ListMembership; properties: TextParagraphsProperties }>): ReactElement | string {
  const { list, properties } = options;
  if (list.markerColour === undefined && list.markerFontSize === undefined) return options.marker;
  const declarations: CSSProperties = {
    ...(list.markerColour === undefined || properties.inkColour !== undefined ? {} : { color: colourValue(listMarkerColour(list.markerColour), properties.styleContext.theme) }),
    ...(list.markerFontSize === undefined ? {} : { fontSize: `${roundNumber(list.markerFontSize * properties.fontScale)}px` }),
  };
  return <span style={declarations}>{options.marker}</span>;
}

/** Only web addresses a browser treats as navigation, never `javascript:` (pasted content is untrusted). */
function safeWebAddress(address: string): string {
  return /^(https?:|mailto:)/i.test(address.trim()) ? address.trim() : `https://${address.trim().replace(/^[a-z]+:/i, "")}`;
}
