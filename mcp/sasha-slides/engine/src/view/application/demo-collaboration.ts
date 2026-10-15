// A STAND-IN DECK SERVER SESSION FOR THE DEMO PAGE (contracts/collaboration.ts): the demo's two
// editors share one in-memory document, so there is no server, but the chrome still needs what a
// session supplies -- the deck's members (for "@" mentions), a role, and a connection to show. The
// page's address picks them (`?role=commenter`, `?connection=offline` or `closed`), so the e2e
// drivers and a person can look at every state of the collaboration chrome without a server.

import { EMPTY } from "rxjs";
import type { AgentRevertOutcome, CollaborationSession, CollaborationStatus, ConnectionState } from "../../contracts/collaboration.ts";
import type { DeckMember, DeckRole } from "../../contracts/deck-access.ts";
import { DECK_ROLES } from "../../contracts/deck-access.ts";

export function createDemoCollaborationSession(options: Readonly<{ members: readonly DeckMember[]; role: DeckRole; connection: ConnectionState }>): CollaborationSession {
  const status: CollaborationStatus = { connection: options.connection, role: options.role, members: options.members, unsentChanges: false };
  const nothingToRevert: AgentRevertOutcome = { kind: "nothingToRevert", skippedSteps: 0 };
  return {
    status: () => status,
    statusChanges: EMPTY,
    notices: EMPTY,
    reconnectNow: () => undefined,
    revertAgentSession: () => Promise.resolve(nothingToRevert),
    [Symbol.dispose]: () => undefined,
  };
}

/** `?role=` parsed at the page boundary; the owner when absent or unknown. */
export function demoRole(text: string | null): DeckRole {
  return DECK_ROLES.find((role) => role === text) ?? "owner";
}

/** `?connection=offline` or `closed`; online otherwise. */
export function demoConnection(text: string | null): ConnectionState {
  switch (text) {
    case "offline":
      return { kind: "offline", reason: "networkLost", attempt: 3, retryInMilliseconds: 8000 };
    case "closed":
      return { kind: "closed", reason: "accessRevoked" };
    default:
      return { kind: "online" };
  }
}
