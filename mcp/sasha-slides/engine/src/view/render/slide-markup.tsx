// A SLIDE AS A MARKUP STRING for the transition sandbox (contracts/render.ts `RenderSlideMarkup`):
// the same `SlideRoot` the editor and presenter draw, rendered with `renderToStaticMarkup`, plus
// what the runner needs to stage it -- the leaf elements a script animates, the assets the markup
// refers to, and the font faces whose bytes the host must send (with the web stand-in of a family
// the platform may lack, view/render/font-families.ts).
//
// Key decisions:
//
//  * ASSETS BY TOKEN. The sandbox has an opaque origin and no network, so the markup refers to every
//    image as `sasha-asset://<id>` (`assetAddressToken`), and the runner substitutes its own blob
//    addresses for the bytes it receives.
//  * LEAVES ONLY, UNROTATED FRAMES. A group is a wrapper and is never animated itself; each leaf's
//    record carries its unrotated frame (what a morph interpolates) and its rotated bounds
//    separately, plus the groups it sits in, outermost first.
//  * NO LAYOUT EFFECTS RUN on the server renderer, so text set to shrink on overflow is in the
//    markup at full size and table rows at their stored minimum; the runner lays them out itself.

import { renderToStaticMarkup } from "react-dom/server";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DocumentSnapshot, ElementSnapshot, SlideSnapshot, TextBody } from "../../contracts/document.ts";
import { rotatedBounds } from "../../contracts/geometry.ts";
import type { AssetId, ElementId } from "../../contracts/ids.ts";
import { assetAddressToken, type AssetAddressResolver, type FontFaceRequest, type RenderSlideMarkup, type StageElementRecord } from "../../contracts/render.ts";
import type { Fill } from "../../contracts/style.ts";
import { withFontStandIns } from "./font-families.ts";
import type { SlideRenderContext } from "./render-context.ts";
import { SlideRoot, slideBackground, slideNumberLookup } from "./static-slide.tsx";
import { resolvedRunStylesOf, textStyleContextOf, type TextStyleContext } from "./text-layout.ts";

export const renderSlideMarkup: RenderSlideMarkup = (input) => ({
  markup: slideMarkupWith({ ...input, assetAddress: assetAddressToken }),
  elements: stageElementRecords(input.slide.elements),
  assetIds: referencedAssetIds({ slide: input.slide, document: input.document }),
  fontFaces: withFontStandIns(fontFacesOf({ slide: input.slide, document: input.document })),
});

/**
 * The slide's markup with its images at `assetAddress`'s addresses: the tokens for the sandbox, the
 * page's own addresses for a copy that leaves the editor (gesture-handlers.ts); null draws the
 * placeholder, as on the canvas.
 */
export function slideMarkupWith(input: Readonly<{ slide: SlideSnapshot; document: DocumentSnapshot; slideNumber: number; assetAddress: AssetAddressResolver }>): string {
  const context: SlideRenderContext = {
    theme: input.document.theme,
    slideId: input.slide.id,
    slideNumber: input.slideNumber,
    slideNumberOf: slideNumberLookup(input.document),
    assetAddress: input.assetAddress,
    measurement: null,
    editableText: null,
  };
  return renderToStaticMarkup(<SlideRoot slide={input.slide} document={input.document} context={context} />);
}

/** Every leaf, back to front, with its unrotated frame, rotated bounds and enclosing groups. */
export function stageElementRecords(elements: readonly ElementSnapshot[]): readonly StageElementRecord[] {
  const records: StageElementRecord[] = [];
  const visit = (element: ElementSnapshot, groupPath: readonly ElementId[]): void => {
    switch (element.kind) {
      case "group":
        for (const child of element.children) visit(child, [...groupPath, element.id]);
        return;
      case "shape":
      case "image":
      case "line":
      case "table":
      case "unsupported":
        records.push({ elementId: element.id, morphKey: element.morphKey, kind: element.kind, frame: element.frame, bounds: rotatedBounds(element.frame), groupPath });
        return;
      default:
        assertNever(element);
    }
  };
  for (const element of elements) visit(element, []);
  return records;
}

/** The assets the slide's markup refers to: its background, image elements and image fills. */
export function referencedAssetIds(options: Readonly<{ slide: SlideSnapshot; document: DocumentSnapshot }>): readonly AssetId[] {
  const found = new Set<AssetId>();
  const addFill = (fill: Fill): void => {
    const assetId = fillAssetId(fill);
    if (assetId !== null) found.add(assetId);
  };
  addFill(slideBackground(options));
  const visit = (element: ElementSnapshot): void => {
    switch (element.kind) {
      case "shape":
        addFill(element.box.fill);
        return;
      case "image":
        found.add(element.assetId);
        addFill(element.box.fill);
        return;
      case "table":
        for (const cell of element.cells) addFill(cell.fill);
        return;
      case "group":
        element.children.forEach(visit);
        return;
      case "line":
      case "unsupported":
        return;
      default:
        assertNever(element);
    }
  };
  options.slide.elements.forEach(visit);
  return [...found];
}

/** The distinct font faces the slide's text draws with. */
export function fontFacesOf(options: Readonly<{ slide: SlideSnapshot; document: DocumentSnapshot }>): readonly FontFaceRequest[] {
  const faces = new Map<string, FontFaceRequest>();
  const addBody = (body: TextBody, context: TextStyleContext): void => {
    for (const style of resolvedRunStylesOf(body, context)) {
      const face: FontFaceRequest = { family: style.fontFamily, weight: style.fontWeight, style: style.fontStyle };
      faces.set(`${face.family}|${face.weight}|${face.style}`, face);
    }
  };
  const visit = (element: ElementSnapshot): void => {
    const context = textStyleContextOf({ theme: options.document.theme, element });
    switch (element.kind) {
      case "shape":
        addBody(element.text, context);
        return;
      case "table":
        for (const cell of element.cells) addBody(cell.text, context);
        return;
      case "group":
        element.children.forEach(visit);
        return;
      case "image":
      case "line":
      case "unsupported":
        return;
      default:
        assertNever(element);
    }
  };
  options.slide.elements.forEach(visit);
  return [...faces.values()];
}

function fillAssetId(fill: Fill): AssetId | null {
  switch (fill.kind) {
    case "image":
      return fill.assetId;
    case "none":
    case "solid":
    case "linearGradient":
    case "radialGradient":
      return null;
    default:
      return assertNever(fill);
  }
}
