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
//    separately, plus the groups it sits in, outermost first (shared/stage-elements.ts, which the
//    in-page presenter host reads too).
//  * NO LAYOUT EFFECTS RUN on the server renderer, so text set to shrink on overflow is in the
//    markup at full size and table rows at their stored minimum; the runner lays them out itself.

import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { AssetId } from "../../contracts/ids.ts";
import { assetAddressToken, type AssetAddressResolver, type FontFaceRequest, type RenderSlideMarkup } from "../../contracts/render.ts";
import { referencedAssetIdsOf } from "../../shared/asset-references.ts";
import { stageElementRecordsOf } from "../../shared/stage-elements.ts";
import { textBodiesOf } from "../../shared/text-bodies.ts";
import { withFontStandIns } from "./font-families.ts";
import type { SlideRenderContext } from "./render-context.ts";
import { SlideRoot, slideBackground, slideNumberLookup } from "./static-slide.tsx";
import { resolvedRunStylesOf, textStyleContextOf } from "./text-layout.ts";

export const renderSlideMarkup: RenderSlideMarkup = (input) => ({
  markup: slideMarkupWith({ ...input, assetAddress: assetAddressToken }),
  elements: stageElementRecordsOf(input.slide),
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

/** The assets the slide's markup refers to: its background, image elements and image fills. */
export function referencedAssetIds(options: Readonly<{ slide: SlideSnapshot; document: DocumentSnapshot }>): readonly AssetId[] {
  return referencedAssetIdsOf({ backgrounds: [slideBackground(options)], elements: options.slide.elements });
}

/** The distinct font faces the slide's text draws with. */
export function fontFacesOf(options: Readonly<{ slide: SlideSnapshot; document: DocumentSnapshot }>): readonly FontFaceRequest[] {
  const faces = new Map<string, FontFaceRequest>();
  for (const { owner, body } of options.slide.elements.flatMap(textBodiesOf)) {
    for (const style of resolvedRunStylesOf(body, textStyleContextOf({ theme: options.document.theme, element: owner }))) {
      const face: FontFaceRequest = { family: style.fontFamily, weight: style.fontWeight, style: style.fontStyle };
      faces.set(`${face.family}|${face.weight}|${face.style}`, face);
    }
  }
  return [...faces.values()];
}
