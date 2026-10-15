/**
 * The deck tools are always LISTED, and without a deck service every one of them answers why it
 * cannot work instead of throwing (acceptance 1), and the agent session id is the documented
 * derivation of the MCP session id.
 *
 *   cd mcp/sasha-slides && npx tsx --test deck-tools/*.test.ts deck-tools/model-tests/*.test.ts
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { ASSISTANT_DECK_TOOL_NAMES } from "../engine/src/contracts/assistant-deck-tools.ts";
import { agentSessionIdFor } from "./agent-session.ts";
import { connectAssistant, type AssistantConnection } from "./assistant-harness.ts";
import { DECKS_UNAVAILABLE_MESSAGE } from "./deck-tools.ts";

const DECK = "dk_someDeck0000000000000";
const THREAD = "th_someThread01";

/** One valid call per tool, so the refusal measured is the missing service, not the input schema. */
const VALID_CALLS: Readonly<Record<(typeof ASSISTANT_DECK_TOOL_NAMES)[number], Readonly<Record<string, unknown>>>> = {
  deck_list: {},
  deck_create: { title: "Quarterly review" },
  deck_read: { deckId: DECK },
  deck_edit: { deckId: DECK, summary: "added a slide", edits: [{ kind: "setTitle", title: "Q3" }] },
  deck_write_transition: { deckId: DECK, name: "Ink wipe", script: "sashaTransition.define({})" },
  deck_write_animation: { deckId: DECK, name: "Rise", script: "sashaTransition.define({})" },
  deck_revert: { deckId: DECK },
  deck_read_comments: { deckId: DECK },
  deck_reply_comment: { deckId: DECK, threadId: THREAD, body: "Done" },
  deck_resolve_comment: { deckId: DECK, threadId: THREAD },
  deck_await_comments: { deckId: DECK, afterSequence: 0, timeoutSeconds: 1 },
};

describe("without a deck service", () => {
  let connection: AssistantConnection;
  before(async () => {
    connection = await connectAssistant({ service: null, sessionId: "session-without-service", caller: null });
  });
  after(async () => {
    await connection.close();
  });

  test("every assistant deck tool is listed", async () => {
    const names = await connection.listToolNames();
    for (const name of ASSISTANT_DECK_TOOL_NAMES) assert.ok(names.includes(name), `${name} is listed`);
    assert.equal(names.length, ASSISTANT_DECK_TOOL_NAMES.length, "and nothing else is registered by registerDeckTools");
  });

  for (const name of ASSISTANT_DECK_TOOL_NAMES) {
    test(`${name} answers isError with the reason, and does not throw`, async () => {
      const answer = await connection.call(name, VALID_CALLS[name]);
      assert.equal(answer.isError, true);
      assert.equal(answer.text, DECKS_UNAVAILABLE_MESSAGE);
    });
  }

  test("an invalid input is a refusal too, not a thrown error", async () => {
    const answer = await connection.call("deck_read", { deckId: "not a deck id" });
    assert.equal(answer.isError, true);
    assert.match(answer.text, /deck id/u);
  });
});

describe("agent session ids", () => {
  // Parametric over the MCP session id, with the expected value computed independently.
  for (const sessionId of ["session-a", "session-b", "a-much-longer-streamable-http-session-identifier"]) {
    test(`${sessionId} -> as_ + 24 hexadecimal of its SHA-256`, () => {
      const expected = `as_${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
      assert.equal(agentSessionIdFor(sessionId), expected);
      assert.match(agentSessionIdFor(sessionId), /^as_[0-9a-f]{24}$/u);
    });
  }

  test("different sessions differ; the same session is stable", () => {
    assert.notEqual(agentSessionIdFor("session-a"), agentSessionIdFor("session-b"));
    assert.equal(agentSessionIdFor("session-a"), agentSessionIdFor("session-a"));
  });
});
