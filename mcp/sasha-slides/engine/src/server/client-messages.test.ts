// The discussion trust boundary over a mutation corpus: every command kind, comment target, text
// target and marking, each JSON path of each request deleted or replaced by one of a fixed set of
// wrong values. `parseDiscussionRequest` (the room's reader of a client's request) must accept and
// refuse exactly what the discussion-log reader (the web client's, and the connector's for stored
// entries) accepts and refuses, with the same output, and the accepted set itself is pinned (a
// count and a hash of every decision, recorded when the server still had its own parser), so a
// change to the wire format's accepted shapes is a deliberate edit of this file.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { DiscussionRequest } from "../contracts/discussion.ts";
import { readDiscussionLogEntry } from "../shared/discussion-wire-values.ts";
import { parseOrNull } from "../shared/untrusted-values.ts";
import { parseDiscussionRequest } from "./client-messages.ts";

type ValuePath = readonly (string | number)[];
type UntrustedRecord = Readonly<Record<string, unknown>>;

const POINT = { x: 0.1, y: 0.2 };
const BOX = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const ELEMENT_TEXT_TARGET = { kind: "element", slideId: "sl_valid00001", elementId: "el_valid00001" };
const CELL_TEXT_TARGET = { kind: "tableCell", slideId: "sl_valid00001", elementId: "el_valid00001", cell: { rowId: "rw_valid00001", columnId: "cl_valid00001" } };
const NOTES_TEXT_TARGET = { kind: "speakerNotes", slideId: "sl_valid00001" };
const ANCHORS = [
  { slideId: "sl_valid00001", target: { kind: "slide" }, region: null, elementFrameAtCreation: null },
  { slideId: "sl_valid00001", target: { kind: "element", elementId: "el_valid00001" }, region: BOX, elementFrameAtCreation: BOX },
  ...[ELEMENT_TEXT_TARGET, CELL_TEXT_TARGET, NOTES_TEXT_TARGET].map((target) => ({
    slideId: "sl_valid00001",
    target: { kind: "text", elementId: "el_valid00001", anchor: { target, start: "a", end: "b" }, quotedText: "q" },
    region: null,
    elementFrameAtCreation: null,
  })),
];
const MARKINGS = [
  { kind: "pen", points: [POINT, POINT], colour: "#123456", width: 2 },
  { kind: "rectangle", region: BOX, colour: "#123456" },
  { kind: "highlight", region: BOX, colour: "#123456" },
  { kind: "arrow", from: POINT, to: POINT, colour: "#123456" },
];
const THREAD = { threadId: "th_valid00001" };
const COMMANDS: readonly unknown[] = [
  ...ANCHORS.map((anchor) => ({ kind: "createThread", ...THREAD, anchor, markings: MARKINGS, messageId: "ms_valid00001", body: "hi", mentions: ["pe_valid00001"] })),
  { kind: "reply", ...THREAD, messageId: "ms_valid00001", body: "hi", mentions: [] },
  { kind: "editMessage", ...THREAD, messageId: "ms_valid00001", body: "hi", mentions: ["pe_valid00001"] },
  { kind: "deleteMessage", ...THREAD, messageId: "ms_valid00001" },
  { kind: "resolveThread", ...THREAD },
  { kind: "reopenThread", ...THREAD },
  { kind: "deleteThread", ...THREAD },
];
/** `undefined` deletes the value at the path (an array element is spliced out). */
const REPLACEMENTS: readonly unknown[] = [undefined, null, 0, -1, 1.5, "", "x", "th_valid00002", "bad id!", [], {}, true, [POINT], { kind: "slide" }];
const PERSON = { id: "pe_valid00001", displayName: "A", colourIndex: 0, kind: "person" };

describe("parseDiscussionRequest over the mutation corpus", () => {
  const decisions = corpus().map((candidate) => ({ candidate, server: parseDiscussionRequest(candidate), web: readAsLogEntry(candidate) }));

  test("accepts and refuses exactly what the web client's discussion-log reader does, with the same output", () => {
    const mismatches = decisions.filter(({ server, web }) => JSON.stringify(server) !== JSON.stringify(web));
    assert.deepEqual(mismatches, []);
  });

  test("the accepted set is pinned: 4,704 mutations, 548 accepted, and a hash of every decision", () => {
    const lines = decisions.map(({ server }) => (server === null ? "refused" : JSON.stringify(server)));
    assert.equal(decisions.length, 4704);
    assert.equal(decisions.filter(({ server }) => server !== null).length, 548);
    assert.equal(createHash("sha256").update(lines.join("\n")).digest("hex"), "65758f9ae8f8106e2a8f31b1675195b3615ee3eb7e59bfeb440ad6ca127245ac");
  });

  test("named rows: a text-anchored thread parses whole; malformed ids, numbers and mentions refuse the request", () => {
    const request = { requestId: "dq_valid00001", command: COMMANDS[2] };
    assert.deepEqual(parseDiscussionRequest(request), request);
    assert.equal(parseDiscussionRequest({ ...request, requestId: "bad id!" }), null);
    assert.equal(parseDiscussionRequest(withReplacement({ value: request, path: ["command", "markings", 0, "width"], replacement: "x" })), null);
    assert.equal(parseDiscussionRequest(withReplacement({ value: request, path: ["command", "mentions", 0], replacement: "bad id!" })), null);
    assert.equal(parseDiscussionRequest(withReplacement({ value: request, path: ["command", "anchor", "region"], replacement: BOX })) === null, false);
    assert.equal(parseDiscussionRequest(withReplacement({ value: request, path: ["command", "kind"], replacement: "x" })), null);
  });
});

function corpus(): readonly unknown[] {
  return COMMANDS.flatMap((command) => {
    const request = { requestId: "dq_valid00001", command };
    return pathsOf(request).flatMap((path) =>
      REPLACEMENTS.map((replacement) => {
        // A JSON round trip, as the wire does: undefined at the root becomes null.
        const parsed: unknown = JSON.parse(JSON.stringify(withReplacement({ value: request, path, replacement })) ?? "null");
        return parsed;
      }),
    );
  });
}

/** The web client reads the same command inside a discussion-log entry; its stamps are fixed. */
function readAsLogEntry(candidate: unknown): DiscussionRequest | null {
  if (!isRecord(candidate)) return null;
  const entry = parseOrNull(() => readDiscussionLogEntry({ sequence: 0, requestId: candidate["requestId"], actor: PERSON, at: 0, command: candidate["command"] }));
  return entry === null ? null : { requestId: entry.requestId, command: entry.command };
}

function pathsOf(value: unknown, prefix: ValuePath = []): readonly ValuePath[] {
  if (Array.isArray(value)) return [prefix, ...value.flatMap((item: unknown, index) => pathsOf(item, [...prefix, index]))];
  if (isRecord(value)) return [prefix, ...Object.entries(value).flatMap(([key, item]) => pathsOf(item, [...prefix, key]))];
  return [prefix];
}

/** A copy of `value` with the value at `path` replaced, or removed when `replacement` is undefined. */
function withReplacement(options: Readonly<{ value: unknown; path: ValuePath; replacement: unknown }>): unknown {
  const [head, ...rest] = options.path;
  if (head === undefined) return options.replacement;
  const inner = (child: unknown): unknown => withReplacement({ value: child, path: rest, replacement: options.replacement });
  if (Array.isArray(options.value)) {
    const copy: unknown[] = [...options.value];
    if (rest.length === 0 && options.replacement === undefined) copy.splice(Number(head), 1);
    else copy[Number(head)] = inner(copy[Number(head)]);
    return copy;
  }
  if (isRecord(options.value)) {
    const copy: Record<string, unknown> = { ...options.value };
    if (rest.length === 0 && options.replacement === undefined) delete copy[head];
    else copy[head] = inner(copy[head]);
    return copy;
  }
  return options.value;
}

function isRecord(value: unknown): value is UntrustedRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
