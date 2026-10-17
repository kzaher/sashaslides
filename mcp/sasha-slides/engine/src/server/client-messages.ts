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
//  * THE REQUEST IS READ BY THE SAME READER THE WEB CLIENT USES for the discussion log
//    (shared/discussion-wire-values.ts), so the server never accepts a command that the clients
//    would refuse when it comes back to them as an entry.

import type { ClientMessage } from "../contracts/collaboration.ts";
import type { DiscussionRequest } from "../contracts/discussion.ts";
import { readDiscussionRequest } from "../shared/discussion-wire-values.ts";
import { parseOrNull, recordOf } from "../shared/untrusted-values.ts";

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
  const record = parseOrNull(() => recordOf(value, "message"));
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
  return parseOrNull(() => readDiscussionRequest(value));
}
