// ONE DOCUMENT THROUGH THE PRODUCT CONVERTER, in this page: the same `convertHtmlToSlideRequests`
// the add-on's candidates window runs (mcp/sasha-slides/converter), bundled with the compiled
// extractor exactly as converter/calibration/in-page-converter.ts and the add-on build do. A draw.io
// placeholder is drawn by the self-hosted editor this site serves at /drawio/, same-origin.

import { convertHtmlToSlideRequests, renderDrawioPicture } from "../../../../mcp/sasha-slides/converter/index.ts";
import { inertSlideHtml } from "./inert-html.ts";
import { PLACEHOLDER_PAGE_OBJECT_ID } from "./insert-request.ts";
import type { ConvertedSlide } from "./queue-state.ts";

/**
 * The compiled `renderer/html2slides/extract-dom.ts`, substituted by the build (dev/build.ts) with
 * `extractorScript()` from renderer/html2slides/extractor-script.ts.
 */
declare const __SASHA_EXTRACTOR_JS__: string;

/** A presentation id the converter echoes back; the insert route takes the real one from the form. */
const PLACEHOLDER_PRESENTATION_ID = "sasha_dev_page";

export async function convertDocument(
  options: Readonly<{ html: string; objectIdPrefix: string; document: Document; now: () => number }>,
): Promise<ConvertedSlide> {
  const { document } = options;
  const started = options.now();
  const result = await convertHtmlToSlideRequests({
    // Never the pasted text itself: its scripts would run on this origin (inert-html.ts).
    html: inertSlideHtml({ html: options.html, parser: new DOMParser() }).html,
    presentationId: PLACEHOLDER_PRESENTATION_ID,
    pageObjectId: PLACEHOLDER_PAGE_OBJECT_ID,
    extractorScript: __SASHA_EXTRACTOR_JS__,
    container: document.body,
    objectIdPrefix: options.objectIdPrefix,
    renderDrawio: ({ xml }) => renderDrawioPicture({ document, editorOrigin: document.location.origin, xml }),
  });
  return {
    requests: result.requests,
    unsupported: result.unsupported,
    elementCount: result.elementCount,
    malformedCount: result.malformedCount,
    drawioDiagrams: result.drawioDiagrams,
    elapsedMilliseconds: options.now() - started,
  };
}

/**
 * Object ids must be unique within the presentation the slides land in, so each conversion gets
 * its own prefix: the queue item's number and a random tail (two people inserting the same queue
 * into one deck must not collide). Letters and digits only, as the converter's allocator expects.
 */
export function objectIdPrefixFor(options: Readonly<{ itemNumber: number; randomTail: string }>): string {
  const tail = options.randomTail.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return `dev${options.itemNumber}${tail}`;
}
