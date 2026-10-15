// WHAT THIS PERSON MAY DO TO THE DECK RIGHT NOW, and in words when not (SPEC.md 21.9). The deck
// server is the only place a permission is enforced (deck-access.ts); the reducer asks these two
// questions before it queues a document edit or a discussion request, so the editor never queues
// what the server would refuse and the person learns why at once. The view answers the same
// questions with the same words (view/chrome/access.ts; a test keeps the two in step).
//
// A closed connection makes the deck read-only for everyone, with the close reason as the
// message; a document from a newer schema is read-only too (SPEC.md section 5, "Versions").

import { assertNever, DOCUMENT_SCHEMA_VERSION, roleAllows, type ClosedReason, type CollaborationStatus, type DeckRole, type EditorState } from "../../contracts/index.ts";

/** Why this editor may not change the document now; null when it may. */
export function editingRefusal(state: EditorState): string | null {
  const closed = closedReasonOf(state.collaboration);
  if (closed !== null) return CLOSED_MESSAGE[closed];
  if (state.document.schemaVersion > DOCUMENT_SCHEMA_VERSION) return NEWER_SCHEMA_MESSAGE;
  if (roleAllows({ role: state.collaboration.role, permission: "editDocument" })) return null;
  return ROLE_EDIT_REFUSAL[state.collaboration.role] ?? "You cannot edit this deck.";
}

/** Why this editor may not start, answer, resolve or delete comments now; null when it may. */
export function commentingRefusal(state: EditorState): string | null {
  const closed = closedReasonOf(state.collaboration);
  if (closed !== null) return CLOSED_MESSAGE[closed];
  if (roleAllows({ role: state.collaboration.role, permission: "comment" })) return null;
  return VIEWER_COMMENT_REFUSAL;
}

/** The close reason when the connection will not come back by itself. */
export function closedReasonOf(status: CollaborationStatus): ClosedReason | null {
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

/** Why a closed deck is read-only: the banner and the refusals say the same. */
export const CLOSED_MESSAGE: Readonly<Record<ClosedReason, string>> = {
  accessRevoked: "Your access to this deck was removed, so it is read-only now.",
  deckNotFound: "This deck no longer exists, so it is read-only now.",
  deckDeleted: "This deck was deleted, so it is read-only now.",
  signedOut: "You were signed out. Sign in again to keep editing.",
  protocolVersionUnsupported: "This editor is out of date. Reload the page to keep editing.",
  documentSchemaTooNew: "This deck was made with a newer version of Sasha Slides. Reload the page to edit it.",
  deckUnreadable: "This deck's saved copy could not be read, so it was not opened. Nothing was changed; ask the server's operator to recover it.",
};

export const NEWER_SCHEMA_MESSAGE = "This deck was made with a newer version of Sasha Slides, so it opens read-only here.";

/** What each role is told when it tries to edit; null where the role may edit. */
export const ROLE_EDIT_REFUSAL: Readonly<Record<DeckRole, string | null>> = {
  owner: null,
  editor: null,
  commenter: "You can comment on this deck, but not edit it.",
  viewer: "You can view this deck, but not edit it.",
};

export const VIEWER_COMMENT_REFUSAL = "You can view this deck, but not comment on it.";
