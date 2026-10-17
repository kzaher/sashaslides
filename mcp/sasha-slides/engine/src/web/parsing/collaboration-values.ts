// THE CONTRACT VALUES THAT ARRIVE FROM OUTSIDE, parsed: roles and members (the welcome, the deck
// API), discussion outcomes, the server's corrections, and a peer's presence (an awareness state
// another browser wrote, relayed by the server). People and the discussion log itself are read by
// shared/discussion-wire-values.ts, which the server and the connector use too. Built from
// shared/untrusted-values.ts; each `read...` throws `MalformedValue` and is wrapped by a boundary
// function that returns null.
//
// Key decisions:
//
//  * EVERY CLOSED SET IS A TOTAL TABLE (`Record<Union, true>`): adding a rejection reason, a
//    correction or a selection kind to the contracts stops this file compiling until the parser
//    knows it.
//  * IDS ARE CHECKED BY SHAPE ONLY (ids.ts OBJECT_ID_PATTERN). Whether a script or an element
//    exists is the fold's business, not the parser's.

import type { ApprovalRevocationReason, ProtectedFieldCorrection, ProtectedMetaKey, ResynchroniseReason } from "../../contracts/collaboration.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { DECK_ROLES, type DeckMember, type DeckRole } from "../../contracts/deck-access.ts";
import type { DiscussionOutcome, DiscussionRejectionReason } from "../../contracts/discussion.ts";
import { parseElementId, parseSlideId, parseTransitionScriptId, type DiscussionRequestId } from "../../contracts/ids.ts";
import type { LocalPresence, PresenceActivity } from "../../contracts/presence.ts";
import type { Selection } from "../../contracts/selection.ts";
import { objectIdentifier, readCellAddress, readPerson, readPoint, readTextTarget } from "../../shared/discussion-wire-values.ts";
import { arrayAt, identifierAt, keysOf, memberAt, nonNegativeIntegerAt, numberAt, parseOrNull, recordOf, stringAt, stringOf } from "../../shared/untrusted-values.ts";

export function readDeckRole(value: unknown): DeckRole {
  return memberAt({ role: value }, "role", DECK_ROLES);
}

export function readDeckMember(value: unknown): DeckMember {
  const record = recordOf(value, "member");
  const email = record["email"];
  return {
    person: readPerson(record["person"]),
    role: readDeckRole(record["role"]),
    email: email === null || email === undefined ? null : stringOf(email, "email"),
  };
}

export function readDiscussionOutcome(value: unknown): DiscussionOutcome {
  const record = recordOf(value, "discussion outcome");
  const requestId = identifierAt(record, "requestId", objectIdentifier<DiscussionRequestId>);
  const kind = memberAt(record, "kind", OUTCOME_KINDS);
  switch (kind) {
    case "applied":
      return { kind, requestId, sequence: nonNegativeIntegerAt(record, "sequence") };
    case "rejected":
      return { kind, requestId, reason: memberAt(record, "reason", REJECTION_REASONS), message: stringAt(record, "message") };
    default:
      return assertNever(kind);
  }
}

export function readCorrection(value: unknown): ProtectedFieldCorrection {
  const record = recordOf(value, "correction");
  const kind = memberAt(record, "kind", CORRECTION_KINDS);
  switch (kind) {
    case "approvalRevoked":
      return { kind, scriptId: identifierAt(record, "scriptId", parseTransitionScriptId), reason: memberAt(record, "reason", APPROVAL_REVOCATION_REASONS) };
    case "scriptAuthorRestored":
      return { kind, scriptId: identifierAt(record, "scriptId", parseTransitionScriptId) };
    case "metaRestored":
      return { kind, key: memberAt(record, "key", PROTECTED_META_KEYS) };
    default:
      return assertNever(kind);
  }
}

export function readResynchroniseReason(value: unknown): ResynchroniseReason {
  return memberAt({ reason: value }, "reason", RESYNCHRONISE_REASONS);
}

/** A peer's presence from its awareness state, or null when it is missing or malformed. */
export function parseLocalPresence(value: unknown): LocalPresence | null {
  return parseOrNull(() => {
    const record = recordOf(value, "presence");
    return {
      person: readPerson(record["person"]),
      slideId: record["slideId"] === null ? null : identifierAt(record, "slideId", parseSlideId),
      selection: readSelection(record["selection"]),
      pointer: record["pointer"] === null ? null : readPoint(record["pointer"]),
      activity: memberAt(record, "activity", PRESENCE_ACTIVITIES),
    };
  });
}

const OUTCOME_KINDS = keysOf<DiscussionOutcome["kind"]>({ applied: true, rejected: true });
const REJECTION_REASONS = keysOf<DiscussionRejectionReason>({
  threadMissing: true,
  messageMissing: true,
  notAuthor: true,
  duplicateId: true,
  invalidValue: true,
  notPermitted: true,
  limitReached: true,
  rateLimited: true,
});
const CORRECTION_KINDS = keysOf<ProtectedFieldCorrection["kind"]>({ approvalRevoked: true, scriptAuthorRestored: true, metaRestored: true });
const APPROVAL_REVOCATION_REASONS = keysOf<ApprovalRevocationReason>({ approvedByAnotherPerson: true, fingerprintMismatch: true, notPermitted: true });
const PROTECTED_META_KEYS = keysOf<ProtectedMetaKey>({ deckId: true, schemaVersion: true, createdAt: true });
const RESYNCHRONISE_REASONS = keysOf<ResynchroniseReason>({ updateFromReadOnlyRole: true, updateTooLarge: true, updateMalformed: true });
const PRESENCE_ACTIVITIES = keysOf<PresenceActivity>({ editing: true, presenting: true, idle: true });

function readSelection(value: unknown): Selection {
  const record = recordOf(value, "selection");
  const kind = memberAt(record, "kind", SELECTION_KINDS);
  switch (kind) {
    case "none":
      return { kind };
    case "slides":
      return { kind, slideIds: arrayAt(record, "slideIds").map((slideId) => identifierAt({ slideId }, "slideId", parseSlideId)) };
    case "elements":
      return {
        kind,
        slideId: identifierAt(record, "slideId", parseSlideId),
        elementIds: arrayAt(record, "elementIds").map((elementId) => identifierAt({ elementId }, "elementId", parseElementId)),
      };
    case "text":
      return { kind, target: readTextTarget(record["target"]), anchor: numberAt(record, "anchor"), focus: numberAt(record, "focus") };
    case "tableCells":
      return {
        kind,
        slideId: identifierAt(record, "slideId", parseSlideId),
        elementId: identifierAt(record, "elementId", parseElementId),
        anchor: readCellAddress(record["anchor"]),
        focus: readCellAddress(record["focus"]),
      };
    default:
      return assertNever(kind);
  }
}

const SELECTION_KINDS = keysOf<Selection["kind"]>({ none: true, slides: true, elements: true, text: true, tableCells: true });

