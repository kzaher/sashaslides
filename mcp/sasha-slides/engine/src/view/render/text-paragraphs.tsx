// A TEXT BODY AS PARAGRAPHS AND RUNS, shared by the static renderer and the inline text editor, so
// the text a user edits in place is drawn by exactly the code that draws it everywhere else.
//
// Key decisions:
//
//  * POSITIONS ARE DATA ATTRIBUTES. Every paragraph carries the index it starts at and every run
//    the index of its first character (`data-sasha-paragraph-start`, `data-sasha-run-start`), in the
//    Y.Text index space (text-layout.ts). The inline editor maps a page selection back to indices
//    through them and nothing else, so drawing and editing agree by construction.
//  * PARAGRAPH KEYS CARRY A PREFIX. The inline editor passes `renderGeneration` into it, so when an
//    input-method composition ends the paragraphs remount instead of React reconciling text the
//    browser wrote into the page itself (SPEC.md "Input method composition").
//  * MARKERS AND FIELDS ARE NOT EDITABLE TEXT. A list marker is an absolutely positioned span outside
//    the index space; an automatic slide number is one character of the index space drawn as its live
//    value. Both are `contentEditable={false}`, so a caret never lands inside them.
//  * A LINK TO A SLIDE is an anchor carrying `data-sasha-link-slide-id`: the presenter navigates on
//    it; the editor never follows a link on click.

import { memo, type CSSProperties, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { Paragraph, TextBody, TextRun } from "../../contracts/document.ts";
import type { SlideId } from "../../contracts/ids.ts";
import type { RunLink } from "../../contracts/style.ts";
import { SLIDE_LINK_ATTRIBUTE } from "../../contracts/render.ts";
import { paragraphDeclarations, roundNumber, runDeclarations } from "./inline-styles.ts";
import {
  LIST_INDENT_PER_LEVEL,
  listMarkers,
  paragraphBaseRunStyle,
  paragraphStarts,
  resolveParagraphStyle,
  resolveRunStyle,
  runDisplayText,
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
  const level = listLevel(style.list);
  const listIndent = level === null ? 0 : (level + 1) * LIST_INDENT_PER_LEVEL;
  const declarations = inked(paragraphDeclarations({ style, base, theme: context.theme, fontScale: properties.fontScale, listIndent }), properties.inkColour);
  const starts = runStarts(paragraph, options.start);
  const attributes = {
    [PARAGRAPH_START_ATTRIBUTE]: options.start,
    [RENDER_GENERATION_ATTRIBUTE]: properties.renderGeneration,
  };
  return (
    <div style={declarations} {...attributes}>
      {options.marker === null || level === null ? null : (
        <span contentEditable={false} {...{ [LIST_MARKER_ATTRIBUTE]: "" }} style={markerDeclarations({ level, indentStart: style.indentStart, fontScale: properties.fontScale, runStyle: inked(runDeclarations({ style: base, theme: context.theme, fontScale: properties.fontScale }), properties.inkColour) })}>
          {options.marker}
        </span>
      )}
      {paragraph.runs.length === 0 ? <br /> : paragraph.runs.map((run, index) => <RunView key={index} run={run} start={starts[index] ?? options.start} properties={properties} />)}
    </div>
  );
}

function RunView(options: Readonly<{ run: TextRun; start: number; properties: TextParagraphsProperties }>): ReactElement {
  const { run, properties } = options;
  const style = resolveRunStyle({ context: properties.styleContext, patch: run.style });
  const declarations = inked(runDeclarations({ style, theme: properties.styleContext.theme, fontScale: properties.fontScale }), properties.inkColour);
  const text = runDisplayText({ run, slideNumber: properties.slideNumber });
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

function listLevel(list: ReturnType<typeof resolveParagraphStyle>["list"]): number | null {
  switch (list.kind) {
    case "none":
      return null;
    case "list":
      return Math.max(0, Math.min(8, list.level));
    default:
      return assertNever(list);
  }
}

function markerDeclarations(options: Readonly<{ level: number; indentStart: number; fontScale: number; runStyle: CSSProperties }>): CSSProperties {
  return {
    ...options.runStyle,
    position: "absolute",
    insetInlineStart: `${roundNumber((options.indentStart + options.level * LIST_INDENT_PER_LEVEL) * options.fontScale)}px`,
    width: `${roundNumber(LIST_INDENT_PER_LEVEL * options.fontScale)}px`,
    textIndent: 0,
    textDecoration: "none",
    userSelect: "none",
  };
}

/** Only web addresses a browser treats as navigation, never `javascript:` (pasted content is untrusted). */
function safeWebAddress(address: string): string {
  return /^(https?:|mailto:)/i.test(address.trim()) ? address.trim() : `https://${address.trim().replace(/^[a-z]+:/i, "")}`;
}
