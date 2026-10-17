// ASSET REFERENCES: which assets a tree of elements (and the backgrounds around it) draws. Two places
// need the answer and differ only in where a background comes from: the clipboard copies exactly the
// asset records a selection uses (state/editor/clipboard.ts, backgrounds as stored on the slides),
// and the slide markup lists the assets a slide needs resolved (view/render/slide-markup.tsx, the
// background after the layout's is applied). The caller passes the backgrounds; this file walks the
// elements. Pure and DOM-free so any layer may import it.

import { assertNever } from "../contracts/assert-never.ts";
import type { ElementSnapshot } from "../contracts/document.ts";
import type { AssetId } from "../contracts/ids.ts";
import type { Fill } from "../contracts/style.ts";

/**
 * Every distinct asset the `backgrounds` and the element trees draw, backgrounds first, then each
 * element in document order (an image's own asset before its fill, a group's children after it).
 */
export function referencedAssetIdsOf(options: Readonly<{ backgrounds: readonly (Fill | null)[]; elements: readonly ElementSnapshot[] }>): readonly AssetId[] {
  const found = new Set<AssetId>();
  for (const background of options.backgrounds) for (const assetId of assetIdsOfFill(background)) found.add(assetId);
  const visit = (element: ElementSnapshot): void => {
    for (const assetId of assetIdsOfElement(element)) found.add(assetId);
    if (element.kind === "group") element.children.forEach(visit);
  };
  options.elements.forEach(visit);
  return [...found];
}

/** The assets one element draws itself (a group's children are not included). */
function assetIdsOfElement(element: ElementSnapshot): readonly AssetId[] {
  switch (element.kind) {
    case "image":
      return [element.assetId, ...assetIdsOfFill(element.box.fill)];
    case "shape":
      return assetIdsOfFill(element.box.fill);
    case "table":
      return element.cells.flatMap((cell) => assetIdsOfFill(cell.fill));
    case "line":
    case "group":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function assetIdsOfFill(fill: Fill | null): readonly AssetId[] {
  if (fill === null) return [];
  switch (fill.kind) {
    case "image":
      return [fill.assetId];
    case "none":
    case "solid":
    case "linearGradient":
    case "radialGradient":
      return [];
    default:
      return assertNever(fill);
  }
}
