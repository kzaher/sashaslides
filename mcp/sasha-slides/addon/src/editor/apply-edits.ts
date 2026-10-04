// THE DOM SIDE: measure the slide, write the overrides onto it, and serialize it back out.
//
// Two rules hold this file together.
//
// ONE SOURCE OF TRUTH. The live document and the string `html()` returns are produced from the
// SAME folded overrides (slide-edit.ts), applied to the same nodes, and `html()` is a serialization
// of the document the user is looking at -- not a second renderer that re-derives the edits. That
// is what makes the round trip true by construction instead of by luck.
//
// NOTHING OF THE EDITOR'S IS INSIDE THE CANDIDATE. No injected stylesheet, no wrapper div, no data
// attribute left behind: the overrides live in each edited element's own `style` attribute and the
// selection chrome lives in the HOST document, over the iframe. So an attached editor with no edits
// serializes byte-for-byte what it was given, and `detach()` has nothing to sweep up inside the
// frame but the baselines it restores.

import { assertNever } from "../protocol.ts";
import { hexOfCssColour } from "./css-colour.ts";
import {
  declarationsFor,
  fractionOfSlideX,
  fractionOfSlideY,
  overridesOf,
  type ColourProperty,
  type ElementBaseline,
  type FractionalPoint,
  type FractionalSize,
  type SlideEdit,
} from "./slide-edit.ts";

/** The candidate document, once it is proven reachable. */
export type SlideDom = Readonly<{ document: Document; view: Window; body: Element }>;

/**
 * An iframe's innards, parsed at the boundary. `contentDocument` is null for a cross-origin frame
 * -- including `sandbox=""`, which is what the picker's read-only pane uses -- so the editor says
 * why it cannot attach instead of throwing from inside a pointer handler ten frames later.
 */
export type SlideDomResult =
  | Readonly<{ kind: "ready"; dom: SlideDom }>
  | Readonly<{ kind: "unreachable"; reason: string }>;

export function slideDomOf(frame: HTMLIFrameElement): SlideDomResult {
  const view = frame.contentWindow;
  if (view === null) return { kind: "unreachable", reason: "the iframe has no content window yet" };
  let document: Document | null = null;
  try {
    document = frame.contentDocument;
  } catch {
    document = null;
  }
  if (document === null) {
    return {
      kind: "unreachable",
      reason: 'the iframe document is not same-origin: a candidate pane needs sandbox="allow-same-origin" to be editable',
    };
  }
  const body: Element | null = document.body;
  if (body === null) return { kind: "unreachable", reason: "the iframe document has no body yet" };
  return { kind: "ready", dom: { document, view, body } };
}

/** Fractional geometry of one element against the 1280x720 slide. */
export type Measurement = Readonly<{ position: FractionalPoint; size: FractionalSize }>;

/**
 * `getBoundingClientRect` is in the frame's own viewport coordinates, which for a 1280x720
 * candidate document IS slide space; the scroll offsets are added because a candidate whose
 * content overflows can be scrolled, and then the two stop being the same thing.
 */
export function measureOf({ element, view }: { element: Element; view: Window }): Measurement {
  const box = element.getBoundingClientRect();
  return {
    position: { x: fractionOfSlideX(box.left + view.scrollX), y: fractionOfSlideY(box.top + view.scrollY) },
    size: { w: fractionOfSlideX(box.width), h: fractionOfSlideY(box.height) },
  };
}

/**
 * The element's current colour, as the record will carry it.
 *
 * For `background` this reads `background-color`, the only part of the shorthand that is a colour.
 * A card painted with a gradient therefore records `from: "transparent"` (or whatever sits under
 * the image) while `to` replaces the whole shorthand -- deliberately asymmetric, and the honest
 * reading of "the user picked a flat colour for this card".
 */
export function colourOf({
  element,
  view,
  property,
}: {
  element: Element;
  view: Window;
  property: ColourProperty;
}): string {
  const computed = view.getComputedStyle(element);
  switch (property) {
    case "color":
      return hexOfCssColour(computed.color);
    case "background":
      return hexOfCssColour(computed.backgroundColor);
    default:
      return assertNever(property);
  }
}

export function baselineOf({ element, view }: { element: Element; view: Window }): ElementBaseline {
  return {
    transform: view.getComputedStyle(element).transform,
    inlineStyle: element.getAttribute("style") ?? "",
  };
}

/** Resolves a `target` to the live element it names, or null when it no longer exists. */
export type TargetResolver = (target: string) => Element | null;

/**
 * Re-apply the WHOLE record list to the document, from the baselines up.
 *
 * Idempotent and total: every call first restores each touched element to how its author wrote it,
 * then paints the folded overrides on. `undo()` is therefore "drop the last record and call this
 * again" -- there is no inverse operation per edit kind to get wrong, and no drift after a hundred
 * gestures.
 */
export function applyEdits({
  edits,
  resolve,
  baselines,
  pristineInnerHtml,
  onWarning,
}: {
  edits: readonly SlideEdit[];
  resolve: TargetResolver;
  baselines: ReadonlyMap<string, ElementBaseline>;
  pristineInnerHtml: ReadonlyMap<string, string>;
  onWarning: (message: string) => void;
}): void {
  for (const [target, baseline] of baselines) {
    const element = resolve(target);
    if (element === null) continue;
    const pristine = pristineInnerHtml.get(target);
    if (pristine !== undefined) element.innerHTML = pristine;
    if (baseline.inlineStyle === "") element.removeAttribute("style");
    else element.setAttribute("style", baseline.inlineStyle);
  }
  for (const override of overridesOf(edits)) {
    const element = resolve(override.target);
    if (element === null) {
      onWarning(`dropped the edits to ${override.target}: that element is no longer in the slide`);
      continue;
    }
    const baseline = baselines.get(override.target) ?? { transform: "none", inlineStyle: "" };
    const style = styleOf(element);
    for (const declaration of declarationsFor({ override, baseline })) {
      style?.setProperty(declaration.property, declaration.value, declaration.important ? "important" : "");
    }
    if (override.text !== null) element.textContent = override.text;
    // `display: none` rather than a detached node, so the record list stays the only state and
    // undo cannot lose the element. `html()` deletes it outright -- see `editedHtmlOf`.
    if (override.removed) style?.setProperty("display", "none", "important");
  }
}

/** Marks the element the user is typing into, so it can never be serialized mid-edit. */
export const EDITING_ATTRIBUTE = "data-sasha-editing";

/**
 * The candidate's HTML with the edits applied: a serialization of the live document, with the
 * removed elements actually gone and the in-place text editing attributes stripped.
 *
 * Removed elements are DELETED here rather than left as `display: none`, because this string is
 * also what gets converted into native Slides objects, and the converter has no reason to believe
 * a hidden element should not become a shape. Deleting it is layout-identical to hiding it, which
 * is what keeps the round trip exact.
 */
export function editedHtmlOf({ document, removedTargets }: { document: Document; removedTargets: readonly string[] }): string {
  // SAFETY: the DOM spec says a clone is a node of the same interface, so cloning an Element
  // yields an Element. `instanceof` is not available for this check: these nodes belong to the
  // iframe's realm, where every constructor is a different object from this document's.
  const root = document.documentElement.cloneNode(true) as Element;
  for (const target of removedTargets) {
    for (const node of root.querySelectorAll(target)) node.remove();
  }
  for (const node of root.querySelectorAll(`[${EDITING_ATTRIBUTE}]`)) {
    node.removeAttribute(EDITING_ATTRIBUTE);
    node.removeAttribute("contenteditable");
  }
  const doctype = document.doctype === null ? "" : `<!doctype ${document.doctype.name}>\n`;
  return `${doctype}${root.outerHTML}`;
}

/** `style` is on HTMLElement and SVGElement but not on Element, and these nodes are cross-realm. */
function styleOf(element: Element): CSSStyleDeclaration | null {
  const candidate: unknown = (element as Readonly<{ style?: unknown }>).style;
  // SAFETY: a node that has a `style` property at all has a CSSStyleDeclaration there per the
  // CSSOM `ElementCSSInlineStyle` mixin; SVG and MathML elements included. A node without one
  // (a plain XML element in a foreign namespace) gets no inline overrides, and says so by null.
  return candidate === null || candidate === undefined ? null : (candidate as CSSStyleDeclaration);
}
