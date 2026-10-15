// ONE SLIDE, DRAWN: the slide root (1280 x pageHeight slide units, the deck background, inheritance
// reset) and `StaticSlide`, the scaled, read-only rendering the presenter, the filmstrip and the
// speaker view use (contracts/render.ts `StaticSlideComponent`). The editing canvas draws the same
// `SlideRoot` with the gesture preview applied and the inline editor plugged in.
//
// Key decisions:
//
//  * THE ROOT RESETS INHERITANCE INLINE (`all: initial`, then the root's own declarations), not only
//    through the chrome stylesheet: the transition sandbox and a speaker window draw slides with no
//    stylesheet of ours, and they must look the same.
//  * ONE SCALE TRANSFORM on a wrapper (`transform-origin: 0 0`); nothing inside a slide knows the
//    zoom.
//  * `StaticSlide` IS MEMOISED ON WHAT IT DRAWS, not on the document object: every revision makes a
//    new `DocumentSnapshot`, but a thumbnail only depends on its slide, the theme, the layouts and
//    -- only when the slide links to other slides -- the slide order. So editing one slide re-renders
//    one thumbnail, which the filmstrip's cost depends on (SPEC.md section 8, "Memoisation").

import { memo, useMemo, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { DocumentSnapshot, ElementSnapshot, SlideSnapshot, TextBody } from "../../contracts/document.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { SlideId } from "../../contracts/ids.ts";
import { SLIDE_ID_ATTRIBUTE, SLIDE_ROOT_CLASS, type AssetAddressResolver, type StaticSlideProperties } from "../../contracts/render.ts";
import type { Fill, RunLink } from "../../contracts/style.ts";
import { ElementView } from "./element-view.tsx";
import type { EditableTextSlot, MeasurementReporter, SlideRenderContext } from "./render-context.ts";
import { fillRendering, roundNumber } from "./inline-styles.ts";

export const StaticSlide = memo(function StaticSlide(properties: StaticSlideProperties): ReactElement {
  const pageHeight = properties.document.pageSize.height;
  const context = useSlideRenderContext({
    document: properties.document,
    slide: properties.slide,
    slideNumber: properties.slideNumber,
    assetAddress: properties.assetAddress,
    measurement: null,
    editableText: null,
  });
  return (
    <div style={{ position: "relative", width: roundNumber(1280 * properties.scale), height: roundNumber(pageHeight * properties.scale), overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1280, height: pageHeight, transform: `scale(${properties.scale})`, transformOrigin: "0 0" }}>
        <SlideRoot slide={properties.slide} document={properties.document} context={context} />
      </div>
    </div>
  );
}, staticSlidePropertiesEqual);

export type SlideRootProperties = Readonly<{
  slide: SlideSnapshot;
  document: DocumentSnapshot;
  context: SlideRenderContext;
  /** Drawn above the elements, inside the slide's coordinates (the canvas puts nothing here today). */
  children?: ReactNode;
}>;

/** The slide root: every slide style inline, inheritance reset (see the header). */
export function SlideRoot(properties: SlideRootProperties): ReactElement {
  const background = fillRendering({ fill: slideBackground({ slide: properties.slide, document: properties.document }), theme: properties.context.theme, assetAddress: properties.context.assetAddress });
  const style: CSSProperties = {
    all: "initial",
    display: "block",
    position: "relative",
    width: 1280,
    height: properties.document.pageSize.height,
    overflow: "hidden",
    boxSizing: "border-box",
    backgroundColor: "#ffffff",
    ...background.background,
  };
  return (
    <div className={SLIDE_ROOT_CLASS} style={style} {...{ [SLIDE_ID_ATTRIBUTE]: properties.slide.id }}>
      {background.imageLayer === null ? null : <div style={background.imageLayer} />}
      <SlideElements elements={properties.slide.elements} context={properties.context} />
      {properties.children}
    </div>
  );
}

/** The top-level elements in z-order; memoised so a chrome re-render never walks them. */
const SlideElements = memo(function SlideElements(properties: Readonly<{ elements: readonly ElementSnapshot[]; context: SlideRenderContext }>): ReactElement {
  return (
    <>
      {properties.elements.map((element) => (
        <ElementView key={element.id} element={element} context={properties.context} />
      ))}
    </>
  );
});

/** The fill behind a slide: its own, else its layout's, else the theme's. */
export function slideBackground(options: Readonly<{ slide: SlideSnapshot; document: DocumentSnapshot }>): Fill {
  if (options.slide.background !== null) return options.slide.background;
  const layout = options.document.layouts.find((candidate) => candidate.id === options.slide.layoutId);
  return layout?.background ?? options.document.theme.background;
}

/** The render context for one slide, rebuilt only when what it holds changes (render-context.ts). */
export function useSlideRenderContext(options: Readonly<{
  document: DocumentSnapshot;
  slide: SlideSnapshot;
  slideNumber: number;
  assetAddress: AssetAddressResolver;
  measurement: MeasurementReporter | null;
  editableText: EditableTextSlot | null;
}>): SlideRenderContext {
  const slideOrderKey = options.document.slides.map((slide) => slide.id).join(" ");
  const slideNumberOf = useMemo(() => slideNumberLookup(options.document), [slideOrderKey]);
  return useMemo(
    (): SlideRenderContext => ({ theme: options.document.theme, slideId: options.slide.id, slideNumber: options.slideNumber, slideNumberOf, assetAddress: options.assetAddress, measurement: options.measurement, editableText: options.editableText }),
    [options.document.theme, options.slide.id, options.slideNumber, slideNumberOf, options.assetAddress, options.measurement, options.editableText],
  );
}

/** 1-based slide numbers by id, for links to slides. */
export function slideNumberLookup(document: DocumentSnapshot): (slideId: SlideId) => number | null {
  const numbers = new Map<SlideId, number>();
  document.slides.forEach((slide, index) => numbers.set(slide.id, index + 1));
  return (slideId) => numbers.get(slideId) ?? null;
}

/** Whether any text in the slide links to another slide (then its rendering depends on slide order). */
export function slideLinksToSlides(slide: SlideSnapshot): boolean {
  const cached = LINKS_TO_SLIDES.get(slide);
  if (cached !== undefined) return cached;
  const result = slide.elements.some(elementLinksToSlides);
  LINKS_TO_SLIDES.set(slide, result);
  return result;
}

/** Equality for `StaticSlide`'s memo (see the header). */
export function staticSlidePropertiesEqual(previous: StaticSlideProperties, next: StaticSlideProperties): boolean {
  if (previous.slide !== next.slide || previous.slideNumber !== next.slideNumber || previous.scale !== next.scale || previous.assetAddress !== next.assetAddress) return false;
  if (previous.document === next.document) return true;
  if (previous.document.theme !== next.document.theme) return false;
  if (previous.document.layouts !== next.document.layouts || previous.document.pageSize.height !== next.document.pageSize.height) return false;
  return !slideLinksToSlides(next.slide) || previous.document.slides === next.document.slides;
}

const LINKS_TO_SLIDES = new WeakMap<SlideSnapshot, boolean>();

function elementLinksToSlides(element: ElementSnapshot): boolean {
  switch (element.kind) {
    case "shape":
      return bodyLinksToSlides(element.text);
    case "table":
      return element.cells.some((cell) => bodyLinksToSlides(cell.text));
    case "group":
      return element.children.some(elementLinksToSlides);
    case "image":
    case "line":
    case "unsupported":
      return false;
    default:
      return assertNever(element);
  }
}

function bodyLinksToSlides(body: TextBody): boolean {
  return body.paragraphs.some((paragraph) => paragraph.runs.some((run) => run.style.link !== undefined && isSlideLink(run.style.link)));
}

function isSlideLink(link: RunLink): boolean {
  switch (link.kind) {
    case "slide":
      return true;
    case "none":
    case "webAddress":
      return false;
    default:
      return assertNever(link);
  }
}
