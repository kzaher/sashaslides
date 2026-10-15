// THE COLOUR PICKER'S "RECENT" ROW (SPEC.md 21.9, review fix 4): every colour the picker applies
// moves to the front of `chrome.recentColours`. Per viewer and never in the document -- the web
// module keeps the row in local storage and hands it back to `initialEditorState`.
//
// Two colours are the same colour when their kind, value and alpha agree: the theme's Accent 1 and
// the literal it currently resolves to are different choices (the theme slot follows a theme
// change, the literal does not), and the same hue at another alpha is another swatch.

import { assertNever, RECENT_COLOUR_LIMIT, type Colour } from "../../contracts/index.ts";

/** `colour` at the front, an equal colour later in the row removed, at most RECENT_COLOUR_LIMIT kept. */
export function withRecentColour(recent: readonly Colour[], colour: Colour): readonly Colour[] {
  return [colour, ...recent.filter((candidate) => !sameColour(candidate, colour))].slice(0, RECENT_COLOUR_LIMIT);
}

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
