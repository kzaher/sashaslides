// WHO MAY DO WHAT TO A DECK (milestone 2). Four roles, one total permission table, and the person
// identities collaborators see. The deck server is the only place a permission is ENFORCED; the
// editor reads the same table only to hide controls a role cannot use, so a forged client gains
// nothing by ignoring it (SPEC.md "Milestone 2", "Enforcement points").
//
// Key decisions:
//
//  * ROLES ARE ORDERED AND SMALL, as in Google Slides: owner, editor, commenter, viewer. A deck has
//    exactly one owner (the account whose data key seals it, so "delete my data" deletes the decks
//    one owns). Sharing is by email address; link sharing is off by default and can grant at most
//    commenter, never editor, because an editor can rewrite every slide.
//
//  * PERMISSIONS ARE A TOTAL TABLE OVER ROLES (`DECK_PERMISSIONS_BY_ROLE`), not scattered
//    `role === "owner"` comparisons: adding a role or a permission is a compile error until every
//    cell is decided.
//
//  * A PERSON ID NEVER REVEALS THE ACCOUNT ID. Collaborators see `pr_<32 hexadecimal>`, the first
//    128 bits of SHA-256("sasha-person.v1:" + accountId); the agent acting for that account is
//    `ag_<the same 32>`. Stable across sessions and secret rotations, unguessable from outside,
//    and both match ids.ts OBJECT_ID_PATTERN.

import type { Person } from "./discussion.ts";

export type DeckRole = "owner" | "editor" | "commenter" | "viewer";

export const DECK_ROLES: readonly DeckRole[] = ["owner", "editor", "commenter", "viewer"];

/** Every action the deck server checks. Names are the user's action, not the transport's. */
export type DeckPermission =
  /** Receive the document, the discussion and presence. */
  | "read"
  /** Send Yjs document updates (sync step 2 and update messages), upload assets, apply agent edits. */
  | "editDocument"
  /** Approve a transition script (a PERSON with this permission; an agent never approves). */
  | "approveTransitionScript"
  /** Create threads, reply, resolve and reopen, edit and delete one's own messages. */
  | "comment"
  /** Delete any thread, not only one's own. */
  | "moderateDiscussion"
  /** Invite by email, change roles, remove members, change link sharing. */
  | "share"
  /** Import from and export to Google Slides. */
  | "exchangeWithGoogleSlides"
  /** Undo an agent session's edits (`deck_revert`, the "Undo Claude's edit" notice). */
  | "revertAgentEdits"
  /** Delete the deck for everyone. */
  | "deleteDeck";

/** Total over roles and permissions: a new role or permission does not compile until decided. */
export const DECK_PERMISSIONS_BY_ROLE: Readonly<Record<DeckRole, Readonly<Record<DeckPermission, boolean>>>> = {
  owner: {
    read: true,
    editDocument: true,
    approveTransitionScript: true,
    comment: true,
    moderateDiscussion: true,
    share: true,
    exchangeWithGoogleSlides: true,
    revertAgentEdits: true,
    deleteDeck: true,
  },
  editor: {
    read: true,
    editDocument: true,
    approveTransitionScript: true,
    comment: true,
    moderateDiscussion: false,
    share: false,
    exchangeWithGoogleSlides: true,
    revertAgentEdits: true,
    deleteDeck: false,
  },
  commenter: {
    read: true,
    editDocument: false,
    approveTransitionScript: false,
    comment: true,
    moderateDiscussion: false,
    share: false,
    exchangeWithGoogleSlides: false,
    revertAgentEdits: false,
    deleteDeck: false,
  },
  viewer: {
    read: true,
    editDocument: false,
    approveTransitionScript: false,
    comment: false,
    moderateDiscussion: false,
    share: false,
    exchangeWithGoogleSlides: false,
    revertAgentEdits: false,
    deleteDeck: false,
  },
};

/** A null role (no longer a member: deck-service-contract.ts `DeckHandle.role`) allows nothing. */
export function roleAllows(options: Readonly<{ role: DeckRole | null; permission: DeckPermission }>): boolean {
  if (options.role === null) return false;
  return DECK_PERMISSIONS_BY_ROLE[options.role][options.permission];
}

/** Anyone signed in who opens the deck's address gets this role, unless they are a member. */
export type LinkSharing = Readonly<{ kind: "off" }> | Readonly<{ kind: "anyoneSignedIn"; role: "viewer" | "commenter" }>;

/** A member as the deck's people list shows them. `email` is only sent to members who may share. */
export type DeckMember = Readonly<{
  person: Person;
  role: DeckRole;
  email: string | null;
}>;

/** An invitation to an address that has no Sasha account yet; it becomes a membership at first sign-in. */
export type DeckInvitation = Readonly<{
  invitationId: string;
  /** Shown to the owner only. Stored sealed under the owner's data key. */
  email: string;
  role: Exclude<DeckRole, "owner">;
  invitedAt: number;
}>;

/** `pr_` + 32 hexadecimal characters (see the header). */
export const PERSON_ID_PREFIX = "pr_";
/** `ag_` + the same 32 characters as the account's person id. */
export const AGENT_PERSON_ID_PREFIX = "ag_";
/** What `SHA-256(PERSON_ID_HASH_LABEL + accountId)` is computed over. */
export const PERSON_ID_HASH_LABEL = "sasha-person.v1:";
/** Hexadecimal characters of the digest kept in a person id. */
export const PERSON_ID_DIGEST_LENGTH = 32;

/** The display name every agent person carries; the view adds "for <owner>" where it helps. */
export const AGENT_DISPLAY_NAME = "Claude";
