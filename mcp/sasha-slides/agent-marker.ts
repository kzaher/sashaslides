/**
 * The tag that says a comment post came from the agent, shared by the server and the add-on.
 *
 * It is on the WIRE, not in a database: the connector and the user authenticate as the same
 * Google account (dev mode reads one `tokens.json`), so a reply's author field cannot tell
 * them apart. The marker is the only thing that can.
 *
 * It lives in a file of its own because BOTH halves need it and they share nothing else:
 * `feedback/feedback.ts` pulls in `googleapis`, which cannot be bundled into an Apps Script
 * HTML surface. The add-on used to not know about it at all, and so rendered the literal
 * "[sasha-slides-agent]" to the user underneath Sasha's answer (seen in the deployed add-on,
 * 2026-10-04) while also being unable to tell the agent's replies from the user's.
 */
export const AGENT_REPLY_MARKER = "[sasha-slides-agent]";

/** Whether this post was written by the agent. The one test for authorship anywhere. */
export function authoredByAgentText(text: string): boolean {
  return text.includes(AGENT_REPLY_MARKER);
}

/**
 * The post as a reader should see it: the marker removed, and nothing else touched.
 *
 * Trailing whitespace goes with it, because the marker is appended after a blank line and
 * leaving that behind renders as an empty paragraph under every one of Sasha's answers.
 */
export function withoutAgentMarker(text: string): string {
  return text.split(AGENT_REPLY_MARKER).join("").trimEnd();
}
