// THE CONTRACT VALUES THAT ARRIVE FROM OUTSIDE, parsed: people and roles (the welcome, the deck
// API), the discussion log (entries, outcomes), the server's corrections, and a peer's presence (an
// awareness state another browser wrote, relayed by the server). Built from untrusted-values.ts;
// each `read...` throws `MalformedValue` and is wrapped by a boundary function that returns null.
//
// Key decisions:
//
//  * EVERY CLOSED SET IS A TOTAL TABLE (`Record<Union, true>`): adding a command kind, a rejection
//    reason or a marking to the contracts stops this file compiling until the parser knows it.
//  * IDS ARE CHECKED BY SHAPE ONLY (ids.ts OBJECT_ID_PATTERN). Whether a thread or an element
//    exists is the fold's business (`reduceDiscussionLog` skips what it cannot place), not the
//    parser's.

import type { ApprovalRevocationReason, ProtectedFieldCorrection, ProtectedMetaKey, ResynchroniseReason } from "../../contracts/collaboration.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { DECK_ROLES, type DeckMember, type DeckRole } from "../../contracts/deck-access.ts";
import type {
  CommentAnchor,
  CommentTarget,
  DiscussionCommand,
  DiscussionLogEntry,
  DiscussionOutcome,
  DiscussionRejectionReason,
  Marking,
  Person,
} from "../../contracts/discussion.ts";
import type { EncodedTextAnchor } from "../../contracts/document-store.ts";
import type { Box, FractionalPoint, FractionalRegion, Point } from "../../contracts/geometry.ts";
import {
  isObjectId,
  parseElementId,
  parsePersonId,
  parseSlideId,
  type DiscussionRequestId,
  type MessageId,
  type PersonId,
  type TableColumnId,
  type TableRowId,
  type ThreadId,
  type TransitionScriptId,
} from "../../contracts/ids.ts";
import type { LocalPresence, PresenceActivity } from "../../contracts/presence.ts";
import type { CellAddress, Selection, TextTarget } from "../../contracts/selection.ts";
import {
  arrayAt,
  identifierAt,
  keysOf,
  listAt,
  MalformedValue,
  memberAt,
  nonNegativeIntegerAt,
  numberAt,
  parseOrNull,
  recordOf,
  stringAt,
  stringOf,
  type UntrustedRecord,
} from "./untrusted-values.ts";

export function readPerson(value: unknown): Person {
  const record = recordOf(value, "person");
  return {
    id: identifierAt(record, "id", parsePersonId),
    displayName: stringAt(record, "displayName"),
    colourIndex: nonNegativeIntegerAt(record, "colourIndex"),
    kind: memberAt(record, "kind", PERSON_KINDS),
  };
}

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

export function readDiscussionLogEntry(value: unknown): DiscussionLogEntry {
  const record = recordOf(value, "discussion entry");
  return {
    sequence: nonNegativeIntegerAt(record, "sequence"),
    requestId: identifierAt(record, "requestId", objectIdentifier<DiscussionRequestId>),
    actor: readPerson(record["actor"]),
    at: numberAt(record, "at"),
    command: readDiscussionCommand(record["command"]),
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
      return { kind, scriptId: identifierAt(record, "scriptId", objectIdentifier<TransitionScriptId>), reason: memberAt(record, "reason", APPROVAL_REVOCATION_REASONS) };
    case "scriptAuthorRestored":
      return { kind, scriptId: identifierAt(record, "scriptId", objectIdentifier<TransitionScriptId>) };
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

/** Thread, message, request and script ids share the object-id shape (ids.ts). */
export function objectIdentifier<TIdentifier extends string>(candidate: string): TIdentifier | null {
  // The brand is a compile-time marker only; OBJECT_ID_PATTERN is the runtime invariant every
  // minted id of these kinds satisfies (ids.ts `mintId`).
  return isObjectId(candidate) ? (candidate as TIdentifier) : null;
}

const PERSON_KINDS = keysOf<Person["kind"]>({ person: true, agent: true });
const OUTCOME_KINDS = keysOf<DiscussionOutcome["kind"]>({ applied: true, rejected: true });
const REJECTION_REASONS = keysOf<DiscussionRejectionReason>({
  threadMissing: true,
  messageMissing: true,
  notAuthor: true,
  duplicateId: true,
  invalidValue: true,
  notPermitted: true,
});
const CORRECTION_KINDS = keysOf<ProtectedFieldCorrection["kind"]>({ approvalRevoked: true, scriptAuthorRestored: true, metaRestored: true });
const APPROVAL_REVOCATION_REASONS = keysOf<ApprovalRevocationReason>({ approvedByAnotherPerson: true, fingerprintMismatch: true, notPermitted: true });
const PROTECTED_META_KEYS = keysOf<ProtectedMetaKey>({ deckId: true, schemaVersion: true, createdAt: true });
const RESYNCHRONISE_REASONS = keysOf<ResynchroniseReason>({ updateFromReadOnlyRole: true, updateTooLarge: true, updateMalformed: true });
const PRESENCE_ACTIVITIES = keysOf<PresenceActivity>({ editing: true, presenting: true, idle: true });

function readDiscussionCommand(value: unknown): DiscussionCommand {
  const record = recordOf(value, "discussion command");
  const kind = memberAt(record, "kind", COMMAND_KINDS);
  const threadId = identifierAt(record, "threadId", objectIdentifier<ThreadId>);
  switch (kind) {
    case "createThread":
      return {
        kind,
        threadId,
        anchor: readCommentAnchor(record["anchor"]),
        markings: listAt(record, "markings", readMarking),
        messageId: identifierAt(record, "messageId", objectIdentifier<MessageId>),
        body: stringAt(record, "body"),
        mentions: readMentions(record),
      };
    case "reply":
    case "editMessage":
      return { kind, threadId, messageId: identifierAt(record, "messageId", objectIdentifier<MessageId>), body: stringAt(record, "body"), mentions: readMentions(record) };
    case "deleteMessage":
      return { kind, threadId, messageId: identifierAt(record, "messageId", objectIdentifier<MessageId>) };
    case "resolveThread":
    case "reopenThread":
    case "deleteThread":
      return { kind, threadId };
    default:
      return assertNever(kind);
  }
}

const COMMAND_KINDS = keysOf<DiscussionCommand["kind"]>({
  createThread: true,
  reply: true,
  editMessage: true,
  deleteMessage: true,
  resolveThread: true,
  reopenThread: true,
  deleteThread: true,
});

function readMentions(record: UntrustedRecord): readonly PersonId[] {
  return arrayAt(record, "mentions").map((mention) => {
    const parsed = parsePersonId(stringOf(mention, "mention"));
    if (parsed === null) throw new MalformedValue("a mention is not a person id");
    return parsed;
  });
}

function readCommentAnchor(value: unknown): CommentAnchor {
  const record = recordOf(value, "anchor");
  return {
    slideId: identifierAt(record, "slideId", parseSlideId),
    target: readCommentTarget(record["target"]),
    region: record["region"] === null ? null : readFractionalRegion(record["region"]),
    elementFrameAtCreation: record["elementFrameAtCreation"] === null ? null : readBox(record["elementFrameAtCreation"]),
  };
}

function readCommentTarget(value: unknown): CommentTarget {
  const record = recordOf(value, "comment target");
  const kind = memberAt(record, "kind", COMMENT_TARGET_KINDS);
  switch (kind) {
    case "slide":
      return { kind };
    case "element":
      return { kind, elementId: identifierAt(record, "elementId", parseElementId) };
    case "text":
      return { kind, elementId: identifierAt(record, "elementId", parseElementId), anchor: readEncodedTextAnchor(record["anchor"]), quotedText: stringAt(record, "quotedText") };
    default:
      return assertNever(kind);
  }
}

const COMMENT_TARGET_KINDS = keysOf<CommentTarget["kind"]>({ slide: true, element: true, text: true });

function readEncodedTextAnchor(value: unknown): EncodedTextAnchor {
  const record = recordOf(value, "text anchor");
  return { target: readTextTarget(record["target"]), start: stringAt(record, "start"), end: stringAt(record, "end") };
}

function readTextTarget(value: unknown): TextTarget {
  const record = recordOf(value, "text target");
  const kind = memberAt(record, "kind", TEXT_TARGET_KINDS);
  const slideId = identifierAt(record, "slideId", parseSlideId);
  switch (kind) {
    case "element":
      return { kind, slideId, elementId: identifierAt(record, "elementId", parseElementId) };
    case "tableCell":
      return { kind, slideId, elementId: identifierAt(record, "elementId", parseElementId), cell: readCellAddress(record["cell"]) };
    case "speakerNotes":
      return { kind, slideId };
    default:
      return assertNever(kind);
  }
}

const TEXT_TARGET_KINDS = keysOf<TextTarget["kind"]>({ element: true, tableCell: true, speakerNotes: true });

function readCellAddress(value: unknown): CellAddress {
  const record = recordOf(value, "cell");
  return { rowId: identifierAt(record, "rowId", objectIdentifier<TableRowId>), columnId: identifierAt(record, "columnId", objectIdentifier<TableColumnId>) };
}

function readMarking(value: unknown): Marking {
  const record = recordOf(value, "marking");
  const kind = memberAt(record, "kind", MARKING_KINDS);
  const colour = stringAt(record, "colour");
  switch (kind) {
    case "pen":
      return { kind, points: listAt(record, "points", readFractionalPoint), colour, width: numberAt(record, "width") };
    case "rectangle":
    case "highlight":
      return { kind, region: readFractionalRegion(record["region"]), colour };
    case "arrow":
      return { kind, from: readFractionalPoint(record["from"]), to: readFractionalPoint(record["to"]), colour };
    default:
      return assertNever(kind);
  }
}

const MARKING_KINDS = keysOf<Marking["kind"]>({ pen: true, rectangle: true, arrow: true, highlight: true });

function readFractionalPoint(value: unknown): FractionalPoint {
  return readPoint(value);
}

function readPoint(value: unknown): Point {
  const record = recordOf(value, "point");
  return { x: numberAt(record, "x"), y: numberAt(record, "y") };
}

function readFractionalRegion(value: unknown): FractionalRegion {
  return readBox(value);
}

function readBox(value: unknown): Box {
  const record = recordOf(value, "box");
  return { x: numberAt(record, "x"), y: numberAt(record, "y"), width: numberAt(record, "width"), height: numberAt(record, "height") };
}

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

