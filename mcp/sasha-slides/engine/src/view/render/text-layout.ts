// TEXT AS THE RENDERER DRAWS IT: resolving each run's and paragraph's style through the placeholder
// role and the theme, numbering list paragraphs, and walking a body in the Y.Text index space. Pure,
// so the static markup tests and the inline text editor (which maps page positions back to indices)
// share one definition of "which character is where".
//
// Key decisions:
//
//  * A RUN RESOLVES: its own attributes, then its placeholder role's style, then the theme's
//    `defaultRunStyle` (document.ts `ThemeSnapshot`). A paragraph likewise, ending at
//    `DEFAULT_PARAGRAPH_STYLE`. An empty paragraph takes the style of the place its mark sits, which
//    is the role's run style, so an empty line has the height the next typed letter will have.
//  * LISTS NUMBER BY `listId` AND LEVEL, across the whole body: paragraphs sharing a list id count
//    together even with other paragraphs between them, and entering a deeper level restarts it
//    while a shallower one keeps counting, as Slides does.
//  * INDICES ARE THE Y.Text'S: each paragraph's runs, then one paragraph mark; an automatic field
//    has length 1. `paragraphStarts` is what the inline editor keys positions by.

import { assertNever } from "../../contracts/assert-never.ts";
import { textRunLength, type ElementSnapshot, type Paragraph, type PlaceholderReference, type TextBody, type ThemeSnapshot } from "../../contracts/document.ts";
import { DEFAULT_PARAGRAPH_STYLE, type ParagraphStyle, type ParagraphStylePatch, type RunStyle, type RunStylePatch } from "../../contracts/style.ts";
import { clampListLevel, listMarkerText } from "../../shared/list-glyphs.ts";

/** Slide units each list level indents by; the marker sits in the last of them. */
export const LIST_INDENT_PER_LEVEL = 32;

/** What a text body's style resolves through (see the header). */
export type TextStyleContext = Readonly<{ theme: ThemeSnapshot; placeholder: PlaceholderReference | null }>;

export function resolveRunStyle(options: Readonly<{ context: TextStyleContext; patch: RunStylePatch }>): RunStyle {
  const role = options.context.placeholder === null ? null : options.context.theme.placeholderStyles[options.context.placeholder.role];
  return { ...options.context.theme.defaultRunStyle, ...definedOnly(role?.run ?? {}), ...definedOnly(options.patch) };
}

export function resolveParagraphStyle(options: Readonly<{ context: TextStyleContext; patch: ParagraphStylePatch }>): ParagraphStyle {
  const role = options.context.placeholder === null ? null : options.context.theme.placeholderStyles[options.context.placeholder.role];
  return { ...DEFAULT_PARAGRAPH_STYLE, ...definedOnly(role?.paragraph ?? {}), ...definedOnly(options.patch) };
}

/** The style an empty paragraph (or the paragraph box itself) is measured with: its first run's, or the role's. */
export function paragraphBaseRunStyle(options: Readonly<{ context: TextStyleContext; paragraph: Paragraph }>): RunStyle {
  const first = options.paragraph.runs[0];
  return resolveRunStyle({ context: options.context, patch: first?.style ?? {} });
}

/** The context a body of `element` resolves through. */
export function textStyleContextOf(options: Readonly<{ theme: ThemeSnapshot; element: ElementSnapshot | null }>): TextStyleContext {
  return { theme: options.theme, placeholder: options.element?.placeholder ?? null };
}

/** Each paragraph's list marker text, or null for a paragraph outside a list (see the header). */
export function listMarkers(body: TextBody, context: TextStyleContext): readonly (string | null)[] {
  const counters = new Map<string, number[]>();
  return body.paragraphs.map((paragraph) => {
    const list = resolveParagraphStyle({ context, patch: paragraph.style }).list;
    switch (list.kind) {
      case "none":
        return null;
      case "list": {
        const levels = counters.get(list.listId) ?? [];
        const level = clampListLevel(list.level);
        const count = (levels[level] ?? 0) + 1;
        const next = levels.slice(0, level);
        next[level] = count;
        counters.set(list.listId, next);
        return listMarkerText({ glyph: list.glyph, number: count });
      }
      default:
        return assertNever(list);
    }
  });
}

/** The index each paragraph starts at, and the body length after the last mark. */
export function paragraphStarts(body: TextBody): readonly number[] {
  const starts: number[] = [];
  let index = 0;
  for (const paragraph of body.paragraphs) {
    starts.push(index);
    for (const run of paragraph.runs) index += textRunLength(run);
    index += 1;
  }
  return starts;
}

/** The index each run of a paragraph starts at, given where the paragraph starts. */
export function runStarts(paragraph: Paragraph, paragraphStart: number): readonly number[] {
  const starts: number[] = [];
  let index = paragraphStart;
  for (const run of paragraph.runs) {
    starts.push(index);
    index += textRunLength(run);
  }
  return starts;
}

/** Every resolved run style a body draws, list markers included (their paragraph's first run). */
export function resolvedRunStylesOf(body: TextBody, context: TextStyleContext): readonly RunStyle[] {
  const styles: RunStyle[] = [];
  for (const paragraph of body.paragraphs) {
    if (paragraph.runs.length === 0) styles.push(paragraphBaseRunStyle({ context, paragraph }));
    for (const run of paragraph.runs) styles.push(resolveRunStyle({ context, patch: run.style }));
  }
  return styles;
}

/** A patch without `undefined` values, so spreading it never erases an inherited value. */
export function definedOnly<TPatch extends object>(patch: TPatch): Partial<TPatch> {
  const result: Partial<TPatch> = {};
  // A style patch is a plain object literal, so its own enumerable keys are exactly keys of TPatch.
  for (const key of Object.keys(patch) as (keyof TPatch)[]) {
    const value = patch[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
