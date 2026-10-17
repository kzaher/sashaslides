// WHEN TWO COLOURS ARE THE SAME CHOICE: their kind, value and alpha agree. The theme's Accent 1 and
// the literal it currently resolves to are different choices (the theme slot follows a theme change,
// the literal does not), and the same hue at another alpha is another swatch. The state module's
// Recent colours row (state/editor/recent-colours.ts) drops a repeat by this rule, and the view's
// colour palette (view/chrome/fields.tsx) marks the current swatch pressed by it.

import { assertNever } from "../contracts/assert-never.ts";
import type { Colour } from "../contracts/style.ts";

export function sameColour(first: Colour, second: Colour): boolean {
  switch (first.kind) {
    case "literal":
      return second.kind === "literal" && first.hexadecimal === second.hexadecimal && first.alpha === second.alpha;
    case "theme":
      return second.kind === "theme" && first.slot === second.slot && first.alpha === second.alpha;
    default:
      return assertNever(first);
  }
}
