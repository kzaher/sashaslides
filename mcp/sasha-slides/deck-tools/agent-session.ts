/**
 * WHICH AGENT SESSION AN EDIT BELONGS TO. Every `deck_edit` of one MCP session lands in the same
 * agent session, so "Undo Claude's edit" and `deck_revert` can take back exactly what one
 * conversation did and nothing a colleague's Claude did meanwhile (SPEC.md 21.14).
 *
 * The id is derived, not stored: `"as_" + the first 24 hexadecimal characters of
 * SHA-256(MCP session id)`. Derivation means a reconnecting client that keeps its session id keeps
 * its agent session without the connector remembering anything, and the hash means the MCP session
 * id (a bearer-like secret on the streamable transport) never reaches collaborators' editors, where
 * the agent session id is shown in notices and revert addresses.
 */
import { createHash } from "node:crypto";

export const AGENT_SESSION_ID_PREFIX = "as_";
export const AGENT_SESSION_DIGEST_CHARACTERS = 24;

/** The agent session of one MCP session (see the header). */
export function agentSessionIdFor(mcpSessionId: string): string {
  const digest = createHash("sha256").update(mcpSessionId, "utf8").digest("hex");
  return AGENT_SESSION_ID_PREFIX + digest.slice(0, AGENT_SESSION_DIGEST_CHARACTERS);
}
