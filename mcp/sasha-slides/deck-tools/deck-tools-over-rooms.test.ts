/**
 * CLAUDE'S DECK TOOLS OVER THE REAL ROOMS (SPEC.md 21.14 with 21.6): the same MCP client as the
 * other deck tool tests, but the `DeckService` is the collaboration server's own
 * (decks/memory-deck-service.ts: real rooms, the room guard, agent histories), not the model-only
 * fake. It checks the three promises that only the server can keep: an agent's slide lands in the
 * room every editor syncs from, its transition script lands UNAPPROVED, and `deck_revert` takes
 * back exactly that session's steps.
 *
 *   cd mcp/sasha-slides && npx tsx --test deck-tools/deck-tools-over-rooms.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { DeckId } from "../engine/src/contracts/ids.ts";
import { manualTimers } from "../decks/deck-test-support";
import { createMemoryDeckService } from "../decks/memory-deck-service";
import { connectAssistant } from "./assistant-harness.ts";

const IRIS = `sashaTransition.define({ name: "Iris", async run(context) { if (context.outgoing === null) return; await context.animate(context.outgoing, [{ clipPath: "circle(80%)" }, { clipPath: "circle(0%)" }], { duration: context.durationMilliseconds }).finished; } });`;

describe("deck tools over the collaboration server's rooms", () => {
  test("an agent's slide and transition reach the room, the script stays unapproved, and deck_revert undoes the session", async () => {
    const timers = manualTimers(1_000_000);
    await using decks = createMemoryDeckService({ now: timers.now, timers });
    const ada = await decks.signIn({ email: "ada@example.com" });
    const assistant = await connectAssistant({ service: decks.deckService, sessionId: "mcp-session-ada", caller: ada, now: timers.now });
    try {
      const created = (await assistant.read("deck_create", { title: "Quarterly" })) as { deckId: DeckId };
      const deckId = created.deckId;
      const slideCount = async (): Promise<number> => {
        const opened = await decks.deckService.openDeck({ caller: ada, deckId });
        assert.equal(opened.kind, "opened");
        if (opened.kind !== "opened") return -1;
        await using deck = opened.deck;
        return deck.snapshot().slides.length;
      };
      const before = await slideCount();

      const edited = (await assistant.read("deck_edit", {
        deckId,
        summary: "Added a closing slide",
        edits: [{ kind: "addSlide", after: null, layoutId: null, placeholderText: { title: [{ text: "Thank you", style: {}, runs: [] }] }, background: null, speakerNotes: "" }],
      })) as { kind: string; created: readonly { slideId: string }[] };
      assert.equal(edited.kind, "applied", JSON.stringify(edited));
      const slideId = edited.created[0]?.slideId ?? "";
      assert.equal(await slideCount(), before + 1, "the room holds the agent's slide");

      const written = (await assistant.read("deck_write_transition", {
        deckId,
        scriptId: null,
        name: "Iris",
        description: "The old slide closes as a circle.",
        script: IRIS,
        stylesheet: "",
        markup: "",
        defaultParameters: {},
        assignTo: [{ slideId, durationMilliseconds: 1200 }],
      })) as { scriptId: string; approved: boolean; reviewAddress: string };
      assert.equal(written.approved, false);
      assert.match(written.reviewAddress, new RegExp(`/deck/${deckId}\\?reviewTransitionScript=${written.scriptId}$`, "u"));

      const opened = await decks.deckService.openDeck({ caller: ada, deckId });
      assert.equal(opened.kind, "opened");
      if (opened.kind !== "opened") return;
      {
        await using deck = opened.deck;
        const snapshot = deck.snapshot();
        const script = snapshot.transitionScripts.find((candidate) => candidate.id === written.scriptId);
        assert.equal(script?.approval.kind, "unapproved", "an agent's script lands unapproved in the room");
        assert.equal(script?.author.kind, "agent");
        const slide = snapshot.slides.find((candidate) => candidate.id === slideId);
        assert.deepEqual(slide?.transition?.kind, "scripted", "the assigned slide switched to the script in the same envelope");
      }

      const reverted = (await assistant.read("deck_revert", { deckId })) as { kind: string };
      assert.equal(reverted.kind, "reverted", JSON.stringify(reverted));
      assert.equal(await slideCount(), before, "the session's slide is gone again");
    } finally {
      await assistant.close();
    }
  });
});
