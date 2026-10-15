// A DECK ADDRESS CAN ASK FOR A TRANSITION SCRIPT'S REVIEW (deck-api.ts TRANSITION_REVIEW_QUERY):
// `deck_write_transition` answers Claude with `/deck/<id>?reviewTransitionScript=<scriptId>`, and
// Claude hands that address to the person who must approve the script. The deck page opens that
// script's review once the editor is ready and drops the parameter from the address, so a reload
// or a shared link does not reopen it; every other parameter (`embed=addon`) and the fragment stay.

import { TRANSITION_REVIEW_QUERY } from "../../contracts/deck-api.ts";
import { parseTransitionScriptId, type TransitionScriptId } from "../../contracts/ids.ts";

export type ReviewRequest = Readonly<{ scriptId: TransitionScriptId; addressWithoutRequest: string }>;

/** The script the address asks to review, or null when it asks for none or names no valid id. */
export function reviewRequestOf(location: Readonly<{ pathname: string; search: string; hash: string }>): ReviewRequest | null {
  const parameters = new URLSearchParams(location.search);
  const requested = parameters.get(TRANSITION_REVIEW_QUERY);
  if (requested === null) return null;
  const scriptId = parseTransitionScriptId(requested);
  if (scriptId === null) return null;
  parameters.delete(TRANSITION_REVIEW_QUERY);
  const search = parameters.toString();
  return { scriptId, addressWithoutRequest: `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}` };
}
