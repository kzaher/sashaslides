// THE TEXT BODIES OF AN ELEMENT: a shape's text, every cell of a table, and those of a group's
// children, recursively, each with the shape or table that holds it (its placeholder is what the
// body's style resolves through). One walk for every reader that visits all the text of an
// element: the properties panel's shared values (view/chrome/properties-values.ts), the font
// families a deck needs (view/application/browser-services.ts) and the font faces a slide draws
// (view/render/slide-markup.tsx). DOM-free and Node-free.

import { assertNever } from "../contracts/assert-never.ts";
import type { ElementSnapshot, TextBody } from "../contracts/document.ts";

export type ElementTextBody = Readonly<{ owner: ElementSnapshot; body: TextBody }>;

export function textBodiesOf(element: ElementSnapshot): readonly ElementTextBody[] {
  switch (element.kind) {
    case "shape":
      return [{ owner: element, body: element.text }];
    case "table":
      return element.cells.map((cell) => ({ owner: element, body: cell.text }));
    case "group":
      return element.children.flatMap(textBodiesOf);
    case "image":
    case "line":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}
