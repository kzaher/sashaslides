/**
 * MatchResult — the outcome of matching a parsed slide to a template.
 */

import type { ParsedSlide } from "./markdown-parser.js";
import type { Template } from "./template.js";

export type MatchResult = Readonly<{
  /** The parsed slide that was matched. */
  parsedSlide: ParsedSlide;
  /** The best-matching template. */
  template: Template;
  /** Similarity score 0..1. */
  score: number;
  /** Why this template was chosen. */
  reason: string;
}>;

export function createMatchResult(
  parsedSlide: ParsedSlide,
  template: Template,
  score: number,
  reason: string
): MatchResult {
  return { parsedSlide, template, score, reason };
}
