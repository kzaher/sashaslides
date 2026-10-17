// THE COLOUR PICKER'S "RECENT" ROW (SPEC.md 21.9, review fix 4): every colour the picker applies
// moves to the front of `chrome.recentColours`. Per viewer and never in the document -- the web
// module keeps the row in local storage and hands it back to `initialEditorState`.
//
// Two colours are the same colour when their kind, value and alpha agree (shared/colours.ts).

import { RECENT_COLOUR_LIMIT, type Colour } from "../../contracts/index.ts";
import { sameColour } from "../../shared/colours.ts";

/** `colour` at the front, an equal colour later in the row removed, at most RECENT_COLOUR_LIMIT kept. */
export function withRecentColour(recent: readonly Colour[], colour: Colour): readonly Colour[] {
  return [colour, ...recent.filter((candidate) => !sameColour(candidate, colour))].slice(0, RECENT_COLOUR_LIMIT);
}
