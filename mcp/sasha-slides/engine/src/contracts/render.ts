// RENDERING CONTRACT: how a slide becomes page elements, shared by three consumers that must agree
// exactly -- the editor canvas and filmstrip (view module), the slideshow (presenter module) and
// the transition sandbox, which receives a slide as a MARKUP STRING because it cannot share the
// editor's page or React tree.
//
// Key decisions:
//
//  * ONE RENDERER, THREE OUTPUTS. The view module implements a React `StaticSlide` component and a
//    `renderSlideMarkup` function built on the same element components (react-dom/server
//    `renderToStaticMarkup`), so the presenter's live slide, the thumbnail and the transition
//    snapshot are pixel-identical. The presenter receives both as injected dependencies, which is
//    also what lets the presenter and view modules be built in parallel.
//
//  * ABSOLUTE POSITIONING IN SLIDE UNITS. The slide root is a `position: relative` box of
//    1280 x pageHeight pixels; each LEAF element is `position: absolute` at its frame, rotated and
//    flipped with a transform about its centre. The whole slide is scaled by ONE transform on a
//    wrapper. Nothing inside a slide knows the zoom.
//
//  * A GROUP IS A WRAPPER, NOT A TRANSFORM. A group renders as `position: absolute; inset: 0`
//    carrying the element attributes, with its children inside in SLIDE coordinates (their frames
//    are absolute already). Nothing about a group's own rotation reaches the page: it only shapes
//    the group's selection handles. So nothing is ever transformed twice, and the morph transition
//    pairs LEAVES only (`StageElementRecord` lists leaves).
//
//  * STABLE DATA ATTRIBUTES are the hit-testing and morphing interface: the editor's pointer handler
//    reads `data-sasha-element-id` from the event target's ancestors, and morphing pairs
//    `data-sasha-morph-key`s. They are the only attributes outside code may rely on.
//
//  * ASSETS BY TOKEN IN MARKUP. The sandbox has an opaque origin and no network, so it cannot load
//    the editor's object addresses. Markup refers to images as `sasha-asset://<id>`; the runner
//    receives the bytes, makes its own blob addresses and substitutes the tokens.

import type { ComponentType } from "react";
import type { DocumentSnapshot, ElementKind, SlideSnapshot } from "./document.ts";
import type { Box, Frame } from "./geometry.ts";
import type { AssetId, ElementId } from "./ids.ts";

export const SLIDE_ID_ATTRIBUTE = "data-sasha-slide-id";
export const ELEMENT_ID_ATTRIBUTE = "data-sasha-element-id";
export const ELEMENT_KIND_ATTRIBUTE = "data-sasha-element-kind";
export const MORPH_KEY_ATTRIBUTE = "data-sasha-morph-key";
/** On a text link to another slide of the deck, with that slide's id; the presenter navigates to it on click. */
export const SLIDE_LINK_ATTRIBUTE = "data-sasha-link-slide-id";
/** Marks the root of a slide: chrome styles never apply below it (SPEC.md "Visual style"). */
export const SLIDE_ROOT_CLASS = "sasha-slide-root";

export const ASSET_ADDRESS_SCHEME = "sasha-asset://";

/** The token markup uses in place of an asset address (see the header). */
export function assetAddressToken(assetId: AssetId): string {
  return `${ASSET_ADDRESS_SCHEME}${assetId}`;
}

/** Resolves an asset to an address loadable where the slide is drawn; null draws a placeholder. */
export type AssetAddressResolver = (assetId: AssetId) => string | null;

/** What any static rendering of one slide needs. */
export type StaticSlideProperties = Readonly<{
  slide: SlideSnapshot;
  /** For the theme, the page size, layouts and slide links. */
  document: DocumentSnapshot;
  /** 1-based position in the deck, for automatic slide-number text. */
  slideNumber: number;
  /** Client pixels per slide unit. */
  scale: number;
  assetAddress: AssetAddressResolver;
}>;

/** The view module's `StaticSlide` (view/render/static-slide.tsx) is of this type. */
export type StaticSlideComponent = ComponentType<StaticSlideProperties>;

/** A slide as a self-contained markup string, for the transition sandbox. */
export type SlideMarkup = Readonly<{
  /** One root element, 1280 x pageHeight pixels, unscaled, every style inline. */
  markup: string;
  /** Every rendered LEAF element, z-order back to front (groups are wrappers, see the header). */
  elements: readonly StageElementRecord[];
  /** Assets the markup references by token. */
  assetIds: readonly AssetId[];
  /** Font faces the markup uses (the host sends their bytes to the runner). */
  fontFaces: readonly FontFaceRequest[];
}>;

export type FontFaceRequest = Readonly<{ family: string; weight: number; style: "normal" | "italic" }>;

export type StageElementRecord = Readonly<{
  elementId: ElementId;
  morphKey: string;
  kind: Exclude<ElementKind, "group">;
  /** The UNROTATED frame: what a morph interpolates (rotation separately), so rotation is never counted twice. */
  frame: Frame;
  /** Rotated bounds in slide units, for hit areas and author scripts that want a box. */
  bounds: Box;
  /** Enclosing groups, outermost first; empty at the top level. */
  groupPath: readonly ElementId[];
}>;

/** The view module's `renderSlideMarkup` (view/render/slide-markup.tsx) is of this type. */
export type RenderSlideMarkup = (input: Readonly<{
  slide: SlideSnapshot;
  document: DocumentSnapshot;
  slideNumber: number;
}>) => SlideMarkup;
