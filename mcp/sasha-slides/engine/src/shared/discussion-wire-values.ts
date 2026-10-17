// THE DISCUSSION WIRE FORMAT, READ FROM UNTRUSTED JSON: a person, a client's discussion request
// (command, comment anchor, text target, table cell, markings, mentions, points and boxes) and a
// discussion-log entry (the request plus the authority's stamps). One reader for every side of
// the wire: the deck server's room parses a client's request with it (server/client-messages.ts),
// the connector's `decks/` re-reads a stored `discussion.log` line with it, and the web client
// reads the server's `discussionEntries` frames with it (web/parsing/collaboration-values.ts). So
// the server never stores an entry the client would refuse. Built from untrusted-values.ts: each
// `read...` throws `MalformedValue` and is wrapped by a boundary function that returns null.
//
// Key decisions:
//
//  * EVERY CLOSED SET IS A TOTAL TABLE (`Record<Union, true>`): adding a command kind, a comment
//    target or a marking to the contracts stops this file compiling until the reader knows it.
//  * IDS ARE CHECKED BY SHAPE ONLY (ids.ts OBJECT_ID_PATTERN). Whether a thread or an element
//    exists is the authority's and the fold's business (`reduceDiscussionLog` skips what it cannot
//    place), not the reader's. Sizes (body length, marking counts) are the authority's rules too.

import { assertNever } from "../contracts/assert-never.ts";
import type { CommentAnchor, CommentTarget, DiscussionCommand, DiscussionLogEntry, DiscussionRequest, Marking, Person } from "../contracts/discussion.ts";
import type { EncodedTextAnchor } from "../contracts/document-store.ts";
import type { Box, FractionalPoint, FractionalRegion, Point } from "../contracts/geometry.ts";
import {
  isObjectId,
  parseElementId,
  parseMessageId,
  parsePersonId,
  parseSlideId,
  parseThreadId,
  type DiscussionRequestId,
  type PersonId,
  type TableColumnId,
  type TableRowId,
} from "../contracts/ids.ts";
import type { CellAddress, TextTarget } from "../contracts/selection.ts";
import { arrayAt, identifierAt, keysOf, listAt, MalformedValue, memberAt, nonNegativeIntegerAt, numberAt, recordOf, stringAt, stringOf, type UntrustedRecord } from "./untrusted-values.ts";

export function readDiscussionRequest(value: unknown): DiscussionRequest {
  const record = recordOf(value, "discussion request");
  return { requestId: identifierAt(record, "requestId", objectIdentifier<DiscussionRequestId>), command: readDiscussionCommand(record["command"]) };
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

export function readPerson(value: unknown): Person {
  const record = recordOf(value, "person");
  return {
    id: identifierAt(record, "id", parsePersonId),
    displayName: stringAt(record, "displayName"),
    colourIndex: nonNegativeIntegerAt(record, "colourIndex"),
    kind: memberAt(record, "kind", PERSON_KINDS),
  };
}

export function readTextTarget(value: unknown): TextTarget {
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

export function readCellAddress(value: unknown): CellAddress {
  const record = recordOf(value, "cell");
  return { rowId: identifierAt(record, "rowId", objectIdentifier<TableRowId>), columnId: identifierAt(record, "columnId", objectIdentifier<TableColumnId>) };
}

export function readPoint(value: unknown): Point {
  const record = recordOf(value, "point");
  return { x: numberAt(record, "x"), y: numberAt(record, "y") };
}

/** Request, table row and table column ids share the object-id shape (ids.ts) and have no parser of their own. */
export function objectIdentifier<TIdentifier extends string>(candidate: string): TIdentifier | null {
  // The brand is a compile-time marker only; OBJECT_ID_PATTERN is the runtime invariant every
  // minted id of these kinds satisfies (ids.ts `mintId`).
  return isObjectId(candidate) ? (candidate as TIdentifier) : null;
}

const PERSON_KINDS = keysOf<Person["kind"]>({ person: true, agent: true });
const TEXT_TARGET_KINDS = keysOf<TextTarget["kind"]>({ element: true, tableCell: true, speakerNotes: true });

function readDiscussionCommand(value: unknown): DiscussionCommand {
  const record = recordOf(value, "discussion command");
  const kind = memberAt(record, "kind", COMMAND_KINDS);
  const threadId = identifierAt(record, "threadId", parseThreadId);
  switch (kind) {
    case "createThread":
      return {
        kind,
        threadId,
        anchor: readCommentAnchor(record["anchor"]),
        markings: listAt(record, "markings", readMarking),
        messageId: identifierAt(record, "messageId", parseMessageId),
        body: stringAt(record, "body"),
        mentions: readMentions(record),
      };
    case "reply":
    case "editMessage":
      return { kind, threadId, messageId: identifierAt(record, "messageId", parseMessageId), body: stringAt(record, "body"), mentions: readMentions(record) };
    case "deleteMessage":
      return { kind, threadId, messageId: identifierAt(record, "messageId", parseMessageId) };
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

function readFractionalRegion(value: unknown): FractionalRegion {
  return readBox(value);
}

function readBox(value: unknown): Box {
  const record = recordOf(value, "box");
  return { x: numberAt(record, "x"), y: numberAt(record, "y"), width: numberAt(record, "width"), height: numberAt(record, "height") };
}
