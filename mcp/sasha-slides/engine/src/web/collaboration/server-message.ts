// THE SERVER'S TEXT FRAMES, PARSED AT THE BOUNDARY (collaboration.ts: "text frames are
// ClientMessage / ServerMessage, parsed at the boundary by the receiver ... unknown kinds ignored
// and counted"). A frame that is not JSON, names a kind this client does not know, or misses a
// field becomes null; the connection counts it and carries on, so a newer server adding a message
// kind never breaks an older open editor.

import type { ServerMessage } from "../../contracts/collaboration.ts";
import { parseDeckId } from "../../contracts/ids.ts";
import {
  readCorrection,
  readDeckMember,
  readDeckRole,
  readDiscussionLogEntry,
  readDiscussionOutcome,
  readPerson,
  readResynchroniseReason,
} from "../parsing/collaboration-values.ts";
import {
  identifierAt,
  keysOf,
  listAt,
  memberAt,
  nonNegativeIntegerAt,
  numberAt,
  parseOrNull,
  parseStructuredText,
  recordOf,
  stringAt,
} from "../parsing/untrusted-values.ts";
import { assertNever } from "../../contracts/assert-never.ts";

/** A text frame as a `ServerMessage`, or null (see the header). Never throws. */
export function parseServerMessage(text: string): ServerMessage | null {
  return parseOrNull(() => readServerMessage(parseStructuredText(text)));
}

function readServerMessage(value: unknown): ServerMessage {
  const record = recordOf(value, "server message");
  const kind = memberAt(record, "kind", SERVER_MESSAGE_KINDS);
  switch (kind) {
    case "welcome":
      return {
        kind,
        protocolVersion: numberAt(record, "protocolVersion"),
        deckId: identifierAt(record, "deckId", parseDeckId),
        me: readPerson(record["me"]),
        role: readDeckRole(record["role"]),
        members: listAt(record, "members", readDeckMember),
        discussionSequence: nonNegativeIntegerAt(record, "discussionSequence"),
      };
    case "discussionEntries":
      return { kind, entries: listAt(record, "entries", readDiscussionLogEntry) };
    case "discussionOutcome":
      return { kind, outcome: readDiscussionOutcome(record["outcome"]) };
    case "accessChanged":
      return { kind, role: readDeckRole(record["role"]) };
    case "membersChanged":
      return { kind, members: listAt(record, "members", readDeckMember) };
    case "agentEdit":
      return { kind, agentSessionId: stringAt(record, "agentSessionId"), agentName: stringAt(record, "agentName"), summary: stringAt(record, "summary") };
    case "correction":
      return { kind, correction: readCorrection(record["correction"]) };
    case "rateLimited":
      return { kind, retryAfterMilliseconds: numberAt(record, "retryAfterMilliseconds") };
    case "heartbeat":
      return { kind };
    case "resynchroniseRequired":
      return { kind, reason: readResynchroniseReason(record["reason"]) };
    default:
      return assertNever(kind);
  }
}

const SERVER_MESSAGE_KINDS = keysOf<ServerMessage["kind"]>({
  welcome: true,
  discussionEntries: true,
  discussionOutcome: true,
  accessChanged: true,
  membersChanged: true,
  agentEdit: true,
  correction: true,
  rateLimited: true,
  heartbeat: true,
  resynchroniseRequired: true,
});
