// THE TRUST BOUNDARY FOR TEXT FRAMES: a client's JSON is parsed into a `ClientMessage` here and
// nowhere else, so the room and the discussion authority work on typed values (collaboration.ts
// "parsed at the boundary by the receiver").
//
// Key decisions:
//
//  * UNKNOWN KINDS ARE NOT ERRORS. A newer client may send a message this server does not know;
//    it is reported as `unknown` (the room counts and ignores it) rather than closing anything.
//  * A KNOWN KIND WITH A BAD BODY IS `malformed`. Ids must be object ids (ids.ts), numbers finite,
//    strings strings; anything else is refused before the authority sees it. Sizes are NOT judged
//    here -- body length and marking counts are the authority's rules, with their own answers.
//  * Brands are applied only after the pattern check that justifies them (`parse...Id`).

import { assertNever } from "../contracts/assert-never.ts";
import type { ClientMessage } from "../contracts/collaboration.ts";
import type { EncodedTextAnchor } from "../contracts/document-store.ts";
import type { CommentAnchor, CommentTarget, DiscussionCommand, DiscussionRequest, Marking } from "../contracts/discussion.ts";
import type { Box, FractionalPoint, FractionalRegion } from "../contracts/geometry.ts";
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
} from "../contracts/ids.ts";
import type { TextTarget } from "../contracts/selection.ts";

export type ParsedClientMessage =
  | Readonly<{ kind: "message"; message: ClientMessage }>
  | Readonly<{ kind: "unknown"; messageKind: string }>
  | Readonly<{ kind: "malformed"; reason: string }>;

export function parseClientMessage(text: string): ParsedClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "malformed", reason: "not JSON" };
  }
  const record = asRecord(value);
  if (record === null) return { kind: "malformed", reason: "not an object" };
  const kind = record["kind"];
  if (typeof kind !== "string") return { kind: "malformed", reason: "no kind" };
  if (kind === "heartbeat") return { kind: "message", message: { kind: "heartbeat" } };
  if (kind !== "discussionRequest") return { kind: "unknown", messageKind: kind };
  const request = parseDiscussionRequest(record["request"]);
  return request === null ? { kind: "malformed", reason: "the discussion request does not parse" } : { kind: "message", message: { kind: "discussionRequest", request } };
}

/** Null when `value` is not a well-formed request (see the header). */
export function parseDiscussionRequest(value: unknown): DiscussionRequest | null {
  const record = asRecord(value);
  if (record === null) return null;
  const requestId = brandedId<DiscussionRequestId>(record["requestId"]);
  const command = parseDiscussionCommand(record["command"]);
  if (requestId === null || command === null) return null;
  return { requestId, command };
}

const DISCUSSION_COMMAND_KINDS: readonly DiscussionCommand["kind"][] = [
  "createThread",
  "reply",
  "editMessage",
  "deleteMessage",
  "resolveThread",
  "reopenThread",
  "deleteThread",
];

function parseDiscussionCommand(value: unknown): DiscussionCommand | null {
  const record = asRecord(value);
  if (record === null) return null;
  const kind = DISCUSSION_COMMAND_KINDS.find((candidate) => candidate === record["kind"]);
  if (kind === undefined) return null;
  const threadId = brandedId<ThreadId>(record["threadId"]);
  if (threadId === null) return null;
  switch (kind) {
    case "createThread": {
      const anchor = parseAnchor(record["anchor"]);
      const markings = parseList({ value: record["markings"], parse: parseMarking });
      const messageId = brandedId<MessageId>(record["messageId"]);
      const body = record["body"];
      const mentions = parseMentions(record["mentions"]);
      if (anchor === null || markings === null || messageId === null || typeof body !== "string" || mentions === null) return null;
      return { kind, threadId, anchor, markings, messageId, body, mentions };
    }
    case "reply":
    case "editMessage": {
      const messageId = brandedId<MessageId>(record["messageId"]);
      const body = record["body"];
      const mentions = parseMentions(record["mentions"]);
      if (messageId === null || typeof body !== "string" || mentions === null) return null;
      return { kind, threadId, messageId, body, mentions };
    }
    case "deleteMessage": {
      const messageId = brandedId<MessageId>(record["messageId"]);
      return messageId === null ? null : { kind, threadId, messageId };
    }
    case "resolveThread":
    case "reopenThread":
    case "deleteThread":
      return { kind, threadId };
    default:
      return assertNever(kind);
  }
}

function parseAnchor(value: unknown): CommentAnchor | null {
  const record = asRecord(value);
  if (record === null) return null;
  const slideId = typeof record["slideId"] === "string" ? parseSlideId(record["slideId"]) : null;
  const target = parseTarget(record["target"]);
  const region = record["region"] === null ? null : parseRegion(record["region"]);
  const frame = record["elementFrameAtCreation"] === null ? null : parseBox(record["elementFrameAtCreation"]);
  if (slideId === null || target === null) return null;
  if (record["region"] !== null && region === null) return null;
  if (record["elementFrameAtCreation"] !== null && frame === null) return null;
  return { slideId, target, region, elementFrameAtCreation: frame };
}

function parseTarget(value: unknown): CommentTarget | null {
  const record = asRecord(value);
  if (record === null) return null;
  switch (record["kind"]) {
    case "slide":
      return { kind: "slide" };
    case "element": {
      const elementId = typeof record["elementId"] === "string" ? parseElementId(record["elementId"]) : null;
      return elementId === null ? null : { kind: "element", elementId };
    }
    case "text": {
      const elementId = typeof record["elementId"] === "string" ? parseElementId(record["elementId"]) : null;
      const anchor = parseEncodedAnchor(record["anchor"]);
      const quotedText = record["quotedText"];
      if (elementId === null || anchor === null || typeof quotedText !== "string") return null;
      return { kind: "text", elementId, anchor, quotedText };
    }
    default:
      return null;
  }
}

function parseEncodedAnchor(value: unknown): EncodedTextAnchor | null {
  const record = asRecord(value);
  if (record === null) return null;
  const target = parseTextTarget(record["target"]);
  const start = record["start"];
  const end = record["end"];
  if (target === null || typeof start !== "string" || typeof end !== "string") return null;
  return { target, start, end };
}

function parseTextTarget(value: unknown): TextTarget | null {
  const record = asRecord(value);
  if (record === null) return null;
  const slideId = typeof record["slideId"] === "string" ? parseSlideId(record["slideId"]) : null;
  if (slideId === null) return null;
  switch (record["kind"]) {
    case "speakerNotes":
      return { kind: "speakerNotes", slideId };
    case "element": {
      const elementId = typeof record["elementId"] === "string" ? parseElementId(record["elementId"]) : null;
      return elementId === null ? null : { kind: "element", slideId, elementId };
    }
    case "tableCell": {
      const elementId = typeof record["elementId"] === "string" ? parseElementId(record["elementId"]) : null;
      const cell = asRecord(record["cell"]);
      const rowId = cell === null ? null : brandedId<TableRowId>(cell["rowId"]);
      const columnId = cell === null ? null : brandedId<TableColumnId>(cell["columnId"]);
      if (elementId === null || rowId === null || columnId === null) return null;
      return { kind: "tableCell", slideId, elementId, cell: { rowId, columnId } };
    }
    default:
      return null;
  }
}

function parseMarking(value: unknown): Marking | null {
  const record = asRecord(value);
  if (record === null) return null;
  const colour = record["colour"];
  if (typeof colour !== "string") return null;
  switch (record["kind"]) {
    case "pen": {
      const points = parseList({ value: record["points"], parse: parsePoint });
      const width = finite(record["width"]);
      return points === null || width === null ? null : { kind: "pen", points, colour, width };
    }
    case "rectangle":
    case "highlight": {
      const region = parseRegion(record["region"]);
      if (region === null) return null;
      return record["kind"] === "rectangle" ? { kind: "rectangle", region, colour } : { kind: "highlight", region, colour };
    }
    case "arrow": {
      const from = parsePoint(record["from"]);
      const to = parsePoint(record["to"]);
      return from === null || to === null ? null : { kind: "arrow", from, to, colour };
    }
    default:
      return null;
  }
}

function parseMentions(value: unknown): readonly PersonId[] | null {
  return parseList({ value, parse: (candidate) => (typeof candidate === "string" ? parsePersonId(candidate) : null) });
}

function parsePoint(value: unknown): FractionalPoint | null {
  const record = asRecord(value);
  if (record === null) return null;
  const x = finite(record["x"]);
  const y = finite(record["y"]);
  return x === null || y === null ? null : { x, y };
}

function parseRegion(value: unknown): FractionalRegion | null {
  return parseBox(value);
}

function parseBox(value: unknown): Box | null {
  const record = asRecord(value);
  if (record === null) return null;
  const x = finite(record["x"]);
  const y = finite(record["y"]);
  const width = finite(record["width"]);
  const height = finite(record["height"]);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function parseList<TValue>(options: Readonly<{ value: unknown; parse: (value: unknown) => TValue | null }>): readonly TValue[] | null {
  if (!Array.isArray(options.value)) return null;
  const parsed: TValue[] = [];
  for (const item of options.value) {
    const value = options.parse(item);
    if (value === null) return null;
    parsed.push(value);
  }
  return parsed;
}

function brandedId<TId extends string>(value: unknown): TId | null {
  // The brand is only a compile-time marker; the object-id pattern check is the runtime invariant.
  return typeof value === "string" && isObjectId(value) ? (value as TId) : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}
