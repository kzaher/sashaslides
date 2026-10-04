import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_REPLY_MARKER, authoredByAgentText, withoutAgentMarker } from "../agent-marker.ts";

/**
 * Measured in the deployed add-on, 2026-10-04: Sasha's answer to a comment on candidate 2
 * rendered in the Ask Sasha log with a literal "[sasha-slides-agent]" line beneath it. The
 * marker is protocol, not prose, and the user should never read it.
 */
test("the marker is stripped for display, and the blank line it sat on goes with it", () => {
  const posted = `Sasha here -- I read this.\n\n${AGENT_REPLY_MARKER}`;
  assert.equal(withoutAgentMarker(posted), "Sasha here -- I read this.");
});

test("a post with no marker is returned untouched", () => {
  assert.equal(withoutAgentMarker("the borders look fine to me"), "the borders look fine to me");
});

test("authorship is read from the marker, which is the only thing that can tell the two apart", () => {
  assert.equal(authoredByAgentText(`done\n\n${AGENT_REPLY_MARKER}`), true);
  assert.equal(authoredByAgentText("done"), false);
});
