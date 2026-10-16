// A SLIDE AS A SELF-CONTAINED PAGE: one HTML document per slide that draws it at exactly 1280 x 720
// CSS pixels, for the reverse importer (Google Slides -> Sasha document -> page -> screenshot) and
// for anyone who wants a slide outside the editor.
//
// Key decisions:
//
//  * THE ENGINE'S OWN RENDERER, NOT A SECOND ONE. The page body is `SlideRoot` -- the component the
//    editing canvas, the filmstrip, the presenter and the transition sandbox all draw -- rendered by
//    react-dom/server. Every slide style is inline on the elements already (static-slide.tsx resets
//    inheritance on the root), so the page needs no stylesheet of ours and the export cannot drift
//    from the editor.
//  * ONE LAYOUT PASS STANDS IN FOR THE EDITOR'S LAYOUT EFFECTS. The server renderer runs none, so
//    text set to shrink on overflow would be drawn at full size; export-layout.ts repeats the
//    editor's shrink loop in the page and then marks the root `data-sasha-export-ready`, which
//    screenshot drivers wait for.
//  * FONTS FROM GOOGLE FONTS, ONE STYLESHEET PER FACE. css2 refuses a whole request when one weight
//    of it does not exist, so each face the slide draws (and the regular face of each family, for the
//    browser to synthesise from) gets its own link; a missing face then costs only itself. System
//    families are never requested, as in the editor (browser-services.ts), but the metric-compatible
//    stand-in of one the platform may lack is, with the original's vertical metrics
//    (view/render/font-families.ts).
//  * EXACTLY 1280 x 720. The engine's page is always 1280 units wide; a deck that is not 16:9 is
//    scaled to fit the height and centred on white, so every exported page has one size and a
//    pixel comparison never needs to resample.
//  * IMAGES RESOLVE THROUGH THE CALLER'S `assetAddress`; a `data:` address keeps the file
//    self-contained.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assertNever } from "../contracts/assert-never.ts";
import type { DocumentSnapshot, ElementSnapshot, SlideSnapshot } from "../contracts/document.ts";
import type { AssetId, SlideId } from "../contracts/ids.ts";
import { ELEMENT_ID_ATTRIBUTE, type FontFaceRequest } from "../contracts/render.ts";
import { isSystemFontFamily } from "../view/application/browser-services.ts";
import { SHRINK_MINIMUM_SCALE, SHRINK_STEP, TEXT_CONTENT_ATTRIBUTE, TEXT_LAYER_ATTRIBUTE } from "../view/render/element-view.tsx";
import type { SlideRenderContext } from "../view/render/render-context.ts";
import { fontMetricOverridesFor, withFontStandIns } from "../view/render/font-families.ts";
import { fontFacesOf } from "../view/render/slide-markup.tsx";
import { SlideRoot, slideNumberLookup } from "../view/render/static-slide.tsx";
import { LIST_MARKER_ATTRIBUTE } from "../view/render/text-paragraphs.tsx";
import { layOutExportedSlide, type ExportLayoutSettings, type ShrinkTarget } from "./export-layout.ts";

/** The size of every exported page, in CSS pixels. */
export const EXPORT_PAGE_SIZE = { width: 1280, height: 720 } as const;
/** Set to "true" on the page's root element once fonts have loaded and text has shrunk to fit. */
export const EXPORT_READY_ATTRIBUTE = "data-sasha-export-ready";
/** How long the page waits for its fonts before laying out with whatever has arrived. */
export const FONT_WAIT_MILLISECONDS = 4000;

export type SlideExportOptions = Readonly<{
  snapshot: DocumentSnapshot;
  slideId: SlideId;
  /** Where an image's bytes are loaded from in the page; a `data:` address keeps it self-contained. */
  assetAddress: (assetId: AssetId) => string;
}>;

export type DeckExportOptions = Readonly<{
  snapshot: DocumentSnapshot;
  assetAddress: (assetId: AssetId) => string;
}>;

export type ExportedSlide = Readonly<{ slideId: SlideId; html: string }>;

/** One slide as a self-contained 1280 x 720 page (see the header). */
export function renderSlideHtml(options: SlideExportOptions): string {
  const slideIndex = options.snapshot.slides.findIndex((slide) => slide.id === options.slideId);
  const slide = options.snapshot.slides[slideIndex];
  if (slide === undefined) throw new Error(`The deck has no slide ${options.slideId}.`);
  return slidePage({ snapshot: options.snapshot, slide, slideNumber: slideIndex + 1, assetAddress: options.assetAddress, slideNumberOf: slideNumberLookup(options.snapshot) });
}

/** Every slide of the deck, skipped ones included, in presentation order. */
export function renderDeckHtml(options: DeckExportOptions): readonly ExportedSlide[] {
  const slideNumberOf = slideNumberLookup(options.snapshot);
  return options.snapshot.slides.map((slide, index) => ({
    slideId: slide.id,
    html: slidePage({ snapshot: options.snapshot, slide, slideNumber: index + 1, assetAddress: options.assetAddress, slideNumberOf }),
  }));
}

/** The scale and offset that fit a 1280-wide page of `pageHeight` into the exported page. */
export function pagePlacement(pageHeight: number): Readonly<{ scale: number; offsetX: number; offsetY: number }> {
  const scale = Math.min(EXPORT_PAGE_SIZE.width / 1280, EXPORT_PAGE_SIZE.height / Math.max(1, pageHeight));
  return { scale, offsetX: (EXPORT_PAGE_SIZE.width - 1280 * scale) / 2, offsetY: (EXPORT_PAGE_SIZE.height - pageHeight * scale) / 2 };
}

/** The text boxes of a slide that shrink their text on overflow, groups included. */
export function shrinkTargetsOf(elements: readonly ElementSnapshot[]): readonly ShrinkTarget[] {
  const targets: ShrinkTarget[] = [];
  const visit = (element: ElementSnapshot): void => {
    switch (element.kind) {
      case "shape":
        if (shrinksText(element.textBox.autofit)) targets.push({ elementId: element.id, verticalPadding: element.textBox.paddingTop + element.textBox.paddingBottom });
        return;
      case "group":
        element.children.forEach(visit);
        return;
      case "image":
      case "line":
      case "table":
      case "unsupported":
        return;
      default:
        assertNever(element);
    }
  };
  elements.forEach(visit);
  return targets;
}

/** The Google Fonts stylesheets for a slide's faces: one per face, plus each family's regular face. */
export function fontStylesheetAddresses(faces: readonly FontFaceRequest[]): readonly string[] {
  const requested = new Map<string, string>();
  const add = (face: FontFaceRequest): void => {
    if (isSystemFontFamily(face.family)) return;
    const weight = Math.max(100, Math.min(900, Math.round(face.weight / 100) * 100));
    const italic = face.style === "italic" ? 1 : 0;
    const family = encodeURIComponent(face.family).replace(/%20/g, "+");
    requested.set(`${face.family}|${italic}|${weight}`, `https://fonts.googleapis.com/css2?family=${family}:ital,wght@${italic},${weight}&display=block`);
  };
  for (const face of faces) {
    add({ family: face.family, weight: 400, style: "normal" });
    add(face);
  }
  return [...requested.values()];
}

/** The page for one slide (see the header). */
function slidePage(options: Readonly<{
  snapshot: DocumentSnapshot;
  slide: SlideSnapshot;
  slideNumber: number;
  assetAddress: (assetId: AssetId) => string;
  slideNumberOf: (slideId: SlideId) => number | null;
}>): string {
  const context: SlideRenderContext = {
    theme: options.snapshot.theme,
    slideId: options.slide.id,
    slideNumber: options.slideNumber,
    slideNumberOf: options.slideNumberOf,
    assetAddress: options.assetAddress,
    measurement: null,
    editableText: null,
  };
  const slideMarkup = renderToStaticMarkup(createElement(SlideRoot, { slide: options.slide, document: options.snapshot, context }));
  const drawnFaces = fontFacesOf({ slide: options.slide, document: options.snapshot });
  const faces = withFontStandIns(drawnFaces);
  const settings: ExportLayoutSettings = {
    shrinkTargets: shrinkTargetsOf(options.slide.elements),
    fontQueries: faces.filter((face) => !isSystemFontFamily(face.family)).map((face) => `${face.style} ${face.weight} 16px "${face.family.replace(/["\\]/g, "")}"`),
    fontMetricOverrides: fontMetricOverridesFor(drawnFaces.map((face) => face.family)),
    readyAttribute: EXPORT_READY_ATTRIBUTE,
    elementIdAttribute: ELEMENT_ID_ATTRIBUTE,
    textLayerAttribute: TEXT_LAYER_ATTRIBUTE,
    textContentAttribute: TEXT_CONTENT_ATTRIBUTE,
    listMarkerAttribute: LIST_MARKER_ATTRIBUTE,
    minimumScale: SHRINK_MINIMUM_SCALE,
    scaleStep: SHRINK_STEP,
    fontWaitMilliseconds: FONT_WAIT_MILLISECONDS,
  };
  const fontLinks = fontStylesheetAddresses(faces).map((address) => `<link rel="stylesheet" href="${escapeAttribute(address)}">`);
  const title = `${options.snapshot.title.trim() === "" ? "Slide" : options.snapshot.title} - slide ${options.slideNumber}`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta name="viewport" content="width=${EXPORT_PAGE_SIZE.width}">`,
    `<title>${escapeText(title)}</title>`,
    ...(fontLinks.length === 0 ? [] : ['<link rel="preconnect" href="https://fonts.googleapis.com">', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', ...fontLinks]),
    `<style>html,body{margin:0;padding:0;width:${EXPORT_PAGE_SIZE.width}px;height:${EXPORT_PAGE_SIZE.height}px;overflow:hidden;background:#ffffff}</style>`,
    "</head>",
    "<body>",
    placedSlide({ slideMarkup, pageHeight: options.snapshot.pageSize.height }),
    layoutScript(settings),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function shrinksText(autofit: "none" | "shrinkText" | "resizeShape"): boolean {
  switch (autofit) {
    case "shrinkText":
      return true;
    case "none":
    case "resizeShape":
      return false;
    default:
      return assertNever(autofit);
  }
}

/** The slide as it is when the page is 16:9; otherwise inside a wrapper that fits it (see the header). */
function placedSlide(options: Readonly<{ slideMarkup: string; pageHeight: number }>): string {
  if (options.pageHeight === EXPORT_PAGE_SIZE.height) return options.slideMarkup;
  const placement = pagePlacement(options.pageHeight);
  const style = `position:absolute;left:${placement.offsetX}px;top:${placement.offsetY}px;width:1280px;height:${options.pageHeight}px;transform:scale(${placement.scale});transform-origin:0 0`;
  return `<div style="position:relative;width:${EXPORT_PAGE_SIZE.width}px;height:${EXPORT_PAGE_SIZE.height}px;overflow:hidden;background:#ffffff"><div style="${style}">${options.slideMarkup}</div></div>`;
}

/**
 * The layout pass as an inline script: the compiled function and its settings. The `__name` shim
 * keeps the source runnable when it was compiled with esbuild's keep-names helper (tsx does that),
 * which would otherwise call a helper that exists only in the module the function came from.
 */
function layoutScript(settings: ExportLayoutSettings): string {
  const source = `var __name = function (target) { return target; };\n(${layOutExportedSlide.toString()})(document, ${JSON.stringify(settings)});`;
  return `<script>\n${scriptSafe(source)}\n</script>`;
}

/** Text that cannot end the script element early or break a line in old parsers. */
function scriptSafe(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}
