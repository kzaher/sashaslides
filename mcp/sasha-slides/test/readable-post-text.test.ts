import test from "node:test";
import assert from "node:assert/strict";
import { readableFeedbackText } from "../feedback/feedback.ts";
import { AGENT_REPLY_MARKER } from "../agent-marker.ts";
import { FEEDBACK_SENTINEL } from "../feedback/comment-anchor.ts";

/**
 * Measured end to end against the deployed add-on, 2026-10-04.
 *
 * A box drawn on candidate 2 arrived at a real connector session through `await_feedback`
 * as:
 *
 *   Second round: the footer row is cut off at the bottom. Give the table a bit more
 *   height.\n\nsasha-slides-feedback={"protocolVersion":1,"noteId":"user_2_…", …}
 *
 * The agent then quoted that back to the user, machine line and all. Both the sentinel and
 * the agent marker are PROTOCOL: the server already parses them into `region`, `noteId` and
 * `authoredByAgent`, so leaving them in the prose only gives the model something to echo.
 */
test("the sentinel the add-on appends is parsed, not handed to the model as prose", () => {
  const posted = `the footer row is cut off\n\n${FEEDBACK_SENTINEL}{"protocolVersion":1,"noteId":"user_2_x","pageObjectId":null,"region":{"x":0.1,"y":0.6,"w":0.4,"h":0.2}}`;
  assert.equal(readableFeedbackText(posted), "the footer row is cut off");
});

test("the agent's own marker is off the prose too, so a quoted reply cannot carry it", () => {
  assert.equal(readableFeedbackText(`evened them out\n\n${AGENT_REPLY_MARKER}`), "evened them out");
});

test("a sentinel the user quoted mid-comment is still removed, and the words around it stay", () => {
  const posted = `before\n${FEEDBACK_SENTINEL}{"noteId":"a"}\nafter`;
  assert.equal(readableFeedbackText(posted), "before\nafter");
});

test("an ordinary comment is returned exactly as written", () => {
  assert.equal(readableFeedbackText("make the title bigger"), "make the title bigger");
});
