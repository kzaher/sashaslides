/**
 * claude-composer — Direct slide editing via template matching.
 */

// Types
export type { Slide, SlideElement } from "./slide.js";
export type { Template, TemplateTag } from "./template.js";
export type { ParsedSlide } from "./markdown-parser.js";
export type { MatchResult } from "./match-result.js";
export type { SlideRequest, AdaptResult } from "./slide-adapter.js";
export type { SlideScreenshot, ScreenshotOptions } from "./screenshot.js";
export type { PresentationInfo, SlidesApiConfig } from "./slides-api.js";
export type { PipelineConfig, PipelineResult } from "./pipeline.js";

// Functions
export { createSlide, withElements, withNotes } from "./slide.js";
export { createTemplate } from "./template.js";
export { parseMarkdown } from "./markdown-parser.js";
export { createMatchResult } from "./match-result.js";
export { scoreTemplate, matchTemplate, matchAllSlides } from "./template-matcher.js";
export { adaptTemplate } from "./slide-adapter.js";
export { screenshotSlide, screenshotAllSlides } from "./screenshot.js";
export { readPresentation, readSlide, applyRequests, extractPresentationId } from "./slides-api.js";
export { runPipeline } from "./pipeline.js";
