// WHY A CONTROL IS DISABLED, in the words the reducer uses when it refuses the same action (SPEC.md
// 21.9: "A commenter's and a viewer's editing controls are disabled with the reason"). The view
// never imports the state module, so it asks the same two questions here, from the same contract
// table (deck-access.ts `roleAllows`); access.test.ts holds the two copies of the words equal.

import { assertNever } from "../../contracts/assert-never.ts";
import type { ClosedReason, CollaborationStatus } from "../../contracts/collaboration.ts";
import { roleAllows, type DeckRole } from "../../contracts/deck-access.ts";
import { DOCUMENT_SCHEMA_VERSION } from "../../contracts/document.ts";
import type { EditorState } from "../../contracts/editor-state.ts";

/** Why the document cannot be changed from this editor now; null when it can. */
export function editingDisabledReason(state: Pick<EditorState, "collaboration" | "document">): string | null {
  const closed = closedReason(state.collaboration);
  if (closed !== null) return CLOSED_EXPLANATION[closed];
  if (state.document.schemaVersion > DOCUMENT_SCHEMA_VERSION) return NEWER_SCHEMA_EXPLANATION;
  if (roleAllows({ role: state.collaboration.role, permission: "editDocument" })) return null;
  return ROLE_EDIT_EXPLANATION[state.collaboration.role] ?? "You cannot edit this deck.";
}

/** Why comments cannot be written from this editor now; null when they can. */
export function commentingDisabledReason(state: Pick<EditorState, "collaboration">): string | null {
  const closed = closedReason(state.collaboration);
  if (closed !== null) return CLOSED_EXPLANATION[closed];
  if (roleAllows({ role: state.collaboration.role, permission: "comment" })) return null;
  return VIEWER_COMMENT_EXPLANATION;
}

/** The reason the connection will not come back by itself, or null. */
export function closedReason(status: CollaborationStatus): ClosedReason | null {
  const connection = status.connection;
  switch (connection.kind) {
    case "closed":
      return connection.reason;
    case "local":
    case "connecting":
    case "synchronising":
    case "online":
    case "offline":
      return null;
    default:
      return assertNever(connection);
  }
}

/** The closed banner's text, and the reason every control gives while it shows. */
export const CLOSED_EXPLANATION: Readonly<Record<ClosedReason, string>> = {
  accessRevoked: "Your access to this deck was removed, so it is read-only now.",
  deckNotFound: "This deck no longer exists, so it is read-only now.",
  deckDeleted: "This deck was deleted, so it is read-only now.",
  signedOut: "You were signed out. Sign in again to keep editing.",
  protocolVersionUnsupported: "This editor is out of date. Reload the page to keep editing.",
  documentSchemaTooNew: "This deck was made with a newer version of Sasha Slides. Reload the page to edit it.",
};

export const NEWER_SCHEMA_EXPLANATION = "This deck was made with a newer version of Sasha Slides, so it opens read-only here.";

export const ROLE_EDIT_EXPLANATION: Readonly<Record<DeckRole, string | null>> = {
  owner: null,
  editor: null,
  commenter: "You can comment on this deck, but not edit it.",
  viewer: "You can view this deck, but not edit it.",
};

export const VIEWER_COMMENT_EXPLANATION = "You can view this deck, but not comment on it.";
