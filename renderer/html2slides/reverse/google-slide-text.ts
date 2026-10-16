/**
 * The text Google draws on each slide, read from the parsed `presentations.get` answer: the
 * expected side of the reverse step's text match.
 *
 * WHAT COUNTS AS DRAWN: the slide's own shapes, tables and word art, plus the decorations
 * (non-placeholder elements) of its layout and master, because Slides paints those behind the
 * slide and the importer copies them onto it (import-presentation.ts header). A layout's or
 * master's PLACEHOLDERS are not drawn on a slide (their prompt text is editor chrome), so they are
 * left out. Speaker notes are not on the slide either.
 */
import type { SlidesElementContent, SlidesPage, SlidesPageElement, SlidesPresentation, SlidesText } from "../../../mcp/sasha-slides/google-slides/slides-presentation.ts";

/** The drawn text of every slide, keyed by the slide's object id, paragraphs on their own lines. */
export function slideTextsOf(presentation: SlidesPresentation): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const slide of presentation.slides) {
    const layout = presentation.layouts.find((candidate) => candidate.objectId === slide.layoutObjectId);
    const master = layout === undefined ? presentation.masters[0] : (masterOfLayout({ layout, presentation }) ?? presentation.masters[0]);
    const decorations = [...(master?.elements ?? []), ...(layout?.elements ?? [])].filter(isDecoration);
    const lines = [...decorations, ...slide.elements].flatMap(elementLines);
    texts.set(slide.objectId, lines.join("\n"));
  }
  return texts;
}

function masterOfLayout(options: Readonly<{ layout: SlidesPage; presentation: SlidesPresentation }>): SlidesPage | undefined {
  const parentIds = new Set(options.layout.elements.map((element) => placeholderParentOf(element.content)).filter((parentId): parentId is string => parentId !== null));
  return options.presentation.masters.find((master) => master.elements.some((element) => parentIds.has(element.objectId)));
}

function placeholderParentOf(content: SlidesElementContent): string | null {
  switch (content.kind) {
    case "shape":
    case "image":
      return content.placeholder?.parentObjectId ?? null;
    case "line":
    case "table":
    case "group":
    case "sheetsChart":
    case "video":
    case "wordArt":
    case "speakerSpotlight":
    case "unknown":
      return null;
    default:
      return assertNever(content);
  }
}

function isDecoration(element: SlidesPageElement): boolean {
  switch (element.content.kind) {
    case "shape":
    case "image":
      return element.content.placeholder === null;
    case "line":
    case "table":
    case "group":
    case "sheetsChart":
    case "video":
    case "wordArt":
    case "speakerSpotlight":
    case "unknown":
      return true;
    default:
      return assertNever(element.content);
  }
}

function elementLines(element: SlidesPageElement): readonly string[] {
  const content = element.content;
  switch (content.kind) {
    case "shape":
      return textLines(content.text);
    case "table":
      return [...content.cells]
        .sort((first, second) => first.rowIndex - second.rowIndex || first.columnIndex - second.columnIndex)
        .flatMap((cell) => textLines(cell.text));
    case "group":
      return content.children.flatMap(elementLines);
    case "wordArt":
      return [content.renderedText];
    case "image":
    case "line":
    case "sheetsChart":
    case "video":
    case "speakerSpotlight":
    case "unknown":
      return [];
    default:
      return assertNever(content);
  }
}

function textLines(text: SlidesText | null): readonly string[] {
  if (text === null) return [];
  return text.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.content).join("")).filter((line) => line.trim().length > 0);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
