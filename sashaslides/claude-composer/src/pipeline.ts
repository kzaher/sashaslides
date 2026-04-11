/**
 * Pipeline — the full markdown-to-slides workflow.
 *
 * 1. Parse markdown into slide descriptors
 * 2. Read existing presentation for templates
 * 3. Match each parsed slide to the best template
 * 4. Generate Slides API requests to adapt templates
 * 5. Apply changes and screenshot results
 */

import { parseMarkdown, type ParsedSlide } from "./markdown-parser.js";
import { matchAllSlides } from "./template-matcher.js";
import type { MatchResult } from "./match-result.js";
import { adaptTemplate, type AdaptResult } from "./slide-adapter.js";
import { createTemplate, type Template } from "./template.js";
import {
  readPresentation,
  applyRequests,
  type PresentationInfo,
  type SlidesApiConfig,
} from "./slides-api.js";
import {
  screenshotAllSlides,
  type ScreenshotOptions,
  type SlideScreenshot,
} from "./screenshot.js";

export type PipelineConfig = Readonly<{
  /** The presentation to edit. */
  presentationUrl: string;
  /** URL(s) of template presentations to draw from. */
  templatePresentationUrls: readonly string[];
  /** Slides API auth config. */
  slidesApiConfig: Partial<SlidesApiConfig>;
  /** Screenshot config. */
  screenshotConfig: Partial<ScreenshotOptions>;
  /** Output directory for screenshots. */
  screenshotOutputDir: string;
  /** Dry run — generate requests but don't apply them. */
  dryRun: boolean;
}>;

export type PipelineResult = Readonly<{
  /** Parsed slides from the markdown. */
  parsedSlides: readonly ParsedSlide[];
  /** Templates loaded from source presentations. */
  templates: readonly Template[];
  /** Match results pairing parsed slides to templates. */
  matches: readonly MatchResult[];
  /** Adaptation results with API requests. */
  adaptations: readonly AdaptResult[];
  /** Screenshots taken after applying changes (empty if dryRun). */
  screenshots: readonly SlideScreenshot[];
}>;

/**
 * Run the full pipeline: markdown -> parse -> match -> adapt -> apply -> screenshot.
 */
export async function runPipeline(
  markdown: string,
  config: PipelineConfig
): Promise<PipelineResult> {
  // Step 1: Parse markdown
  const parsedSlides = parseMarkdown(markdown);

  // Step 2: Load templates from source presentations
  const templates = await loadTemplates(
    config.templatePresentationUrls,
    config.slidesApiConfig
  );

  // Step 3: Match parsed slides to templates
  const matches = matchAllSlides(parsedSlides, templates);

  // Step 4: Generate adaptation requests
  const adaptations = matches.map(adaptTemplate);

  // Step 5: Apply changes (unless dry run)
  if (!config.dryRun) {
    for (const adaptation of adaptations) {
      await applyRequests(
        config.presentationUrl,
        adaptation.requests,
        config.slidesApiConfig
      );
    }
  }

  // Step 6: Screenshot results (unless dry run)
  let screenshots: readonly SlideScreenshot[] = [];
  if (!config.dryRun) {
    const info = await readPresentation(
      config.presentationUrl,
      config.slidesApiConfig
    );
    screenshots = await screenshotAllSlides(
      config.presentationUrl,
      info.slideCount,
      config.screenshotOutputDir,
      config.screenshotConfig
    );
  }

  return {
    parsedSlides,
    templates,
    matches,
    adaptations,
    screenshots,
  };
}

/**
 * Load templates from one or more presentations.
 */
async function loadTemplates(
  urls: readonly string[],
  apiConfig: Partial<SlidesApiConfig>
): Promise<readonly Template[]> {
  const templates: Template[] = [];

  for (const url of urls) {
    const info = await readPresentation(url, apiConfig);
    for (const slide of info.slides) {
      templates.push(
        createTemplate({
          id: `${info.presentationId}_${slide.slideId}`,
          presentationId: info.presentationId,
          slide,
        })
      );
    }
  }

  return templates;
}
