/**
 * Template — a slide from a past presentation used as a basis for new slides.
 */

import type { Slide } from "./slide.js";

export type TemplateTag =
  | "title"
  | "title_and_body"
  | "section_header"
  | "two_columns"
  | "image_with_caption"
  | "blank"
  | "comparison"
  | "chart";

export type Template = Readonly<{
  id: string;
  /** Which presentation this template came from. */
  presentationId: string;
  /** The original slide snapshot. */
  slide: Slide;
  /** Tags describing what kind of slide this is. */
  tags: readonly TemplateTag[];
  /** Free-text description for semantic matching. */
  description: string;
}>;

export function createTemplate(
  partial: Partial<Template> & Pick<Template, "id" | "presentationId" | "slide">
): Template {
  return {
    id: partial.id,
    presentationId: partial.presentationId,
    slide: partial.slide,
    tags: partial.tags ?? inferTags(partial.slide),
    description: partial.description ?? "",
  };
}

/** Heuristic tag inference from slide layout name. */
function inferTags(slide: Slide): readonly TemplateTag[] {
  const layout = slide.layout.toUpperCase();
  const tags: TemplateTag[] = [];

  if (layout.includes("TITLE") && layout.includes("BODY")) tags.push("title_and_body");
  else if (layout.includes("TITLE")) tags.push("title");
  if (layout.includes("SECTION")) tags.push("section_header");
  if (layout.includes("TWO") || layout.includes("COLUMN")) tags.push("two_columns");
  if (layout.includes("BLANK")) tags.push("blank");
  if (layout.includes("COMPARISON")) tags.push("comparison");

  return tags.length > 0 ? tags : ["blank"];
}
