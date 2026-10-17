/**
 * A stored `discussion.log` line is read by the engine's discussion-log reader, so the connector
 * refuses exactly what the web client refuses: a negative or fractional sequence, a fractional or
 * negative colour index, an unknown actor kind. Before, it accepted `sequence: -1` and
 * `colourIndex: 0.5`, served them, and the client then refused the whole `discussionEntries` frame.
 *
 *   cd mcp/sasha-slides && npx tsx --test decks/deck-wire-values.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readDiscussionLogEntry } from "../engine/src/shared/discussion-wire-values.ts";
import { parseOrNull } from "../engine/src/shared/untrusted-values.ts";
import { parseDiscussionLogEntry, parsePerson } from "./deck-wire-values";

const ACTOR = { id: "pe_valid00001", displayName: "A", colourIndex: 2, kind: "person" };
const ENTRY = {
  sequence: 3,
  requestId: "dq_valid00001",
  actor: ACTOR,
  at: 5,
  command: { kind: "reply", threadId: "th_valid00001", messageId: "ms_valid00001", body: "hi", mentions: [] },
};

describe("parseDiscussionLogEntry", () => {
  test("reads a well-formed entry whole", () => {
    assert.deepEqual(parseDiscussionLogEntry(ENTRY), ENTRY);
    assert.deepEqual(parsePerson(ACTOR), ACTOR);
  });

  const refused: readonly (readonly [string, unknown])[] = [
    ["sequence -1", { ...ENTRY, sequence: -1 }],
    ["sequence 1.5", { ...ENTRY, sequence: 1.5 }],
    ["sequence 2^60", { ...ENTRY, sequence: 2 ** 60 }],
    ["colourIndex -1", { ...ENTRY, actor: { ...ACTOR, colourIndex: -1 } }],
    ["colourIndex 0.5", { ...ENTRY, actor: { ...ACTOR, colourIndex: 0.5 } }],
    ["actor kind robot", { ...ENTRY, actor: { ...ACTOR, kind: "robot" } }],
    ["at missing", { ...ENTRY, at: undefined }],
    ["thread id malformed", { ...ENTRY, command: { ...ENTRY.command, threadId: "bad id!" } }],
  ];
  for (const [name, value] of refused) {
    test(`refuses ${name}, exactly as the web client's reader does`, () => {
      const json: unknown = JSON.parse(JSON.stringify(value));
      assert.equal(parseDiscussionLogEntry(json), null);
      assert.equal(parseOrNull(() => readDiscussionLogEntry(json)), null);
    });
  }

  test("parsePerson refuses a fractional or negative colour index", () => {
    assert.equal(parsePerson({ ...ACTOR, colourIndex: 0.5 }), null);
    assert.equal(parsePerson({ ...ACTOR, colourIndex: -1 }), null);
  });
});
