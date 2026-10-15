// WHAT EVERY ELEMENT COMPONENT NEEDS BESIDES ITS OWN SNAPSHOT, in one value: the theme to resolve
// colours and text styles through, the slide's number, how to address assets, and -- on the editing
// canvas only -- where to report measured layout and which text body is being edited in place.
//
// Key decision: THE CONTEXT CHANGES ONLY WHEN WHAT IT HOLDS CHANGES. Element components are
// `React.memo`'d on (element, context), so a context rebuilt on every document revision would
// re-render all 200 elements of a slide on every keystroke. The context therefore holds the theme
// (shared between revisions by the model), not the document, and a `slideNumberOf` lookup that the
// slide builds once per slide order.

import type { ReactElement } from "react";
import type { TextBody, ThemeSnapshot } from "../../contracts/document.ts";
import type { ElementMeasurement } from "../../contracts/editor-state.ts";
import type { ElementId, SlideId } from "../../contracts/ids.ts";
import type { AssetAddressResolver } from "../../contracts/render.ts";
import type { TextTarget } from "../../contracts/selection.ts";
import type { TextStyleContext } from "./text-layout.ts";

export type SlideRenderContext = Readonly<{
  theme: ThemeSnapshot;
  slideId: SlideId;
  /** 1-based, for automatic slide-number text. */
  slideNumber: number;
  /** The 1-based number of a linked slide; null when it no longer exists. */
  slideNumberOf: (slideId: SlideId) => number | null;
  assetAddress: AssetAddressResolver;
  /** The editing canvas only: where layout effects report measured table rows and text heights. */
  measurement: MeasurementReporter | null;
  /** The editing canvas only: the body edited in place, rendered by the inline text editor. */
  editableText: EditableTextSlot | null;
}>;

export type MeasurementReporter = (report: Readonly<{ elementId: ElementId; measurement: ElementMeasurement }>) => void;

/** The inline text editor, plugged into the renderer for exactly one text body. */
export type EditableTextSlot = Readonly<{
  target: TextTarget;
  render: (properties: EditableTextProperties) => ReactElement;
}>;

/** What the renderer hands the inline editor: the body as the document holds it, and its style context. */
export type EditableTextProperties = Readonly<{
  body: TextBody;
  styleContext: TextStyleContext;
  slideNumber: number;
  slideNumberOf: (slideId: SlideId) => number | null;
}>;
