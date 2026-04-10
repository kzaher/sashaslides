/**
 * Template matching — finds the closest template for a parsed slide.
 */

import type { ParsedSlide } from "./markdown-parser.js";
import type { Template, TemplateTag } from "./template.js";
import { createMatchResult, type MatchResult } from "./match-result.js";

/** Map from layoutHint to preferred template tags. */
const LAYOUT_TO_TAGS: Record<ParsedSlide["layoutHint"], readonly TemplateTag[]> = {
  title_only: ["title"],
  title_and_body: ["title_and_body"],
  section_header: ["section_header", "title"],
  two_columns: ["two_columns", "comparison"],
  image_with_caption: ["image_with_caption", "title_and_body"],
};

/**
 * Score how well a template matches a parsed slide.
 * Returns 0..1 where 1 is perfect match.
 */
export function scoreTemplate(parsed: ParsedSlide, template: Template): number {
  let score = 0;

  // Tag overlap (weighted heavily — 0.6 max)
  const preferredTags = LAYOUT_TO_TAGS[parsed.layoutHint] ?? [];
  const tagOverlap = preferredTags.filter((t) => template.tags.includes(t)).length;
  score += (tagOverlap / Math.max(preferredTags.length, 1)) * 0.6;

  // Element count compatibility (0.2 max)
  const bodyCount = parsed.body.length;
  const elemCount = template.slide.elements.length;
  if (elemCount > 0) {
    // Prefer templates that have roughly the right number of text elements
    const ratio = Math.min(bodyCount, elemCount) / Math.max(bodyCount, elemCount, 1);
    score += ratio * 0.2;
  }

  // Description keyword overlap (0.2 max)
  if (template.description) {
    const descWords = new Set(template.description.toLowerCase().split(/\s+/));
    const titleWords = parsed.title.toLowerCase().split(/\s+/);
    const overlap = titleWords.filter((w) => descWords.has(w)).length;
    score += Math.min(overlap / Math.max(titleWords.length, 1), 1) * 0.2;
  }

  return Math.min(score, 1);
}

/**
 * Find the best matching template for a parsed slide.
 * Returns null if no templates are available.
 */
export function matchTemplate(
  parsed: ParsedSlide,
  templates: readonly Template[]
): MatchResult | null {
  if (templates.length === 0) return null;

  let best: { template: Template; score: number } | null = null;

  for (const template of templates) {
    const score = scoreTemplate(parsed, template);
    if (!best || score > best.score) {
      best = { template, score };
    }
  }

  if (!best) return null;

  const reason = buildReason(parsed, best.template, best.score);
  return createMatchResult(parsed, best.template, best.score, reason);
}

/**
 * Match all parsed slides to templates.
 */
export function matchAllSlides(
  parsedSlides: readonly ParsedSlide[],
  templates: readonly Template[]
): readonly MatchResult[] {
  const results: MatchResult[] = [];
  for (const parsed of parsedSlides) {
    const result = matchTemplate(parsed, templates);
    if (result) {
      results.push(result);
    }
  }
  return results;
}

function buildReason(parsed: ParsedSlide, template: Template, score: number): string {
  const parts: string[] = [];
  parts.push(`layout="${parsed.layoutHint}" matched tags=[${template.tags.join(",")}]`);
  parts.push(`score=${score.toFixed(2)}`);
  if (template.description) {
    parts.push(`template="${template.description}"`);
  }
  return parts.join("; ");
}
