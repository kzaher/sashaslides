/**
 * index.ts — the converter's public surface.
 *
 * Two entry points, by how much of the browser you have:
 *   - `convertHtmlToSlideRequests` — HTML string in, batchUpdate body out. Needs
 *     a DOM (it stages an offscreen iframe) and the compiled extractor blob.
 *   - `emitSlideRequests` — a parsed extraction in, batchUpdate body out. Pure
 *     and synchronous; this is the half worth unit-testing densely.
 */
export { afterNextFrame, convertHtmlToSlideRequests, extractSlideLayout } from "./convert-html-to-slide-requests.js";
export type { ConvertHtmlOptions, HtmlConversionResult } from "./convert-html-to-slide-requests.js";

export { emitSlideRequests } from "./emit-requests.js";
export type { ConversionResult, EmitOptions } from "./emit-requests.js";

export { parseExtraction } from "./extraction.js";
export type { ParsedExtraction, SlideElement } from "./extraction.js";

export { describeUnsupportedFeature } from "./unsupported-feature.js";
export type {
  FractionalRegion,
  UnsupportedFallback,
  UnsupportedFeature,
} from "./unsupported-feature.js";

export type { SlidesApiRequest } from "./slides-api.js";

export {
  SLIDES_MAX_IMAGE_BYTES,
  SLIDES_MAX_IMAGE_URL_BYTES,
  STAGED_IMAGE_FIELD,
  STAGED_IMAGE_URL,
  slideImageSourceFor,
  stagedImageOf,
  stagedImageUrl,
} from "./slide-image.js";
export type { SlideImageSource, SlideImageUpload, StagedImageMediaType } from "./slide-image.js";

export {
  DEFAULT_PAGE_SIZE_EMU,
  DEFAULT_TEXT_INSET_EMU,
  EMU_PER_POINT,
  pageScaleFor,
  predictGoogleRowHeightPx,
  pxToPoints,
  specForColumnWidthPx,
  specForRowHeightPx,
} from "./geometry.js";
export type { SlidePageSizeEmu, TextInsetEmu } from "./geometry.js";
