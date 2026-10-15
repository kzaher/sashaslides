/**
 * CLAUDE'S DECK TOOLS OVER THE REAL ROOMS (SPEC.md 21.14 with 21.6): the same MCP client as the
 * other deck tool tests, but the `DeckService` is the collaboration server's own
 * (decks/memory-deck-service.ts: real rooms, the room guard, agent histories), not the model-only
 * fake. It checks the three promises that only the server can keep: an agent's slide lands in the
 * room every editor syncs from, its transition script lands UNAPPROVED, and `deck_revert` takes
 * back exactly that session's steps; and for builds, that an agent's steps land in the room, its
 * animation script lands unapproved, and the agent cannot approve it itself.
 *
 *   cd mcp/sasha-slides && npx tsx --test deck-tools/deck-tools-over-rooms.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { DeckOutline } from "../engine/src/contracts/assistant-deck-tools.ts";
import { scriptFingerprint, type DocumentSnapshot } from "../engine/src/contracts/document.ts";
import type { DeckId } from "../engine/src/contracts/ids.ts";
import type { DeckCaller, DeckService } from "../deck-contracts/deck-service-contract.ts";
import { manualTimers } from "../decks/deck-test-support";
import { createMemoryDeckService } from "../decks/memory-deck-service";
import { connectAssistant } from "./assistant-harness.ts";

const INK_RISE = `sashaTransition.define({ name: "Ink rise", async run(context) { const target = context.elements("incoming").find((element) => element.id === context.parameters.targetElementId); if (target === undefined || context.reducedMotion) return; await context.animate(target, [{ opacity: 0 }, { opacity: 1 }], { duration: context.durationMilliseconds }).finished; } });`;

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

  test("Claude adds a fly-in and a scripted build step: both land in the room, the script is unapproved, and the agent cannot approve it", async () => {
    const timers = manualTimers(1_000_000);
    await using decks = createMemoryDeckService({ now: timers.now, timers });
    const ada = await decks.signIn({ email: "ada@example.com" });
    const assistant = await connectAssistant({ service: decks.deckService, sessionId: "mcp-session-ada", caller: ada, now: timers.now });
    try {
      const created = (await assistant.read("deck_create", { title: "Builds" })) as { deckId: DeckId };
      const deckId = created.deckId;
      const outline = (await assistant.read("deck_read", { deckId })) as DeckOutline;
      const slideId = outline.slides[0]?.slideId ?? "";
      const titleId = outline.slides[0]?.elements.find((element) => element.placeholder !== null)?.elementId ?? "";

      const edited = (await assistant.read("deck_edit", {
        deckId,
        summary: "a card that flies in",
        edits: [
          { kind: "addShape", id: "el_flyingCard1", slideId, preset: "roundedRectangle", frame: { x: 100, y: 300, width: 300, height: 200 } },
          { kind: "addAnimations", slideId, steps: [{ elementId: "el_flyingCard1", effect: { kind: "flyIn", from: "bottom" } }] },
        ],
      })) as { kind: string; created: readonly { animationStepIds: readonly string[] }[] };
      assert.equal(edited.kind, "applied", JSON.stringify(edited));
      const flyInId = edited.created[1]?.animationStepIds[0];

      const written = (await assistant.read("deck_write_animation", {
        deckId,
        name: "Ink rise",
        description: "The title rises out of an ink blot.",
        script: INK_RISE,
        assignTo: [{ slideId, elementId: titleId, category: "entrance", trigger: "afterPrevious", durationMilliseconds: 1400 }],
      })) as { scriptId: string; approved: boolean; reviewAddress: string; animationStepIds: readonly string[] };
      assert.equal(written.approved, false);
      assert.match(written.reviewAddress, new RegExp(`/deck/${deckId}\\?reviewTransitionScript=${written.scriptId}$`, "u"));

      const fingerprint = await withDeck({ decks, caller: ada, deckId }, (snapshot) => {
        const slide = snapshot.slides.find((candidate) => candidate.id === slideId);
        assert.deepEqual(slide?.animations.map((step) => step.id), [flyInId, written.animationStepIds[0]], "the fly-in, then the scripted step, in the room every editor syncs from");
        assert.deepEqual(slide?.animations[1]?.effect, { kind: "scripted", scriptId: written.scriptId, category: "entrance", parameters: {} });
        assert.equal(slide?.animations[1]?.trigger, "afterPrevious");
        const script = snapshot.transitionScripts.find((candidate) => candidate.id === written.scriptId);
        assert.ok(script !== undefined);
        assert.equal(script.purpose, "animation");
        assert.equal(script.approval.kind, "unapproved", "an agent's animation script lands unapproved");
        return scriptFingerprint(script);
      });

      const approval = await assistant.call("deck_edit", {
        deckId,
        summary: "approve my own script",
        edits: [{ kind: "raw", commands: [{ kind: "approveTransitionScript", scriptId: written.scriptId, fingerprint }] }],
      });
      assert.equal(approval.isError, true, "an agent never approves a script");
      assert.match(approval.text, /approvalNeedsPerson|notPermitted/u);
      await withDeck({ decks, caller: ada, deckId }, (snapshot) => {
        assert.equal(snapshot.transitionScripts.find((candidate) => candidate.id === written.scriptId)?.approval.kind, "unapproved", "still unapproved");
      });
    } finally {
      await assistant.close();
    }
  });
});

async function withDeck<TResult>(
  options: Readonly<{ decks: Readonly<{ deckService: DeckService }>; caller: DeckCaller; deckId: DeckId }>,
  read: (snapshot: DocumentSnapshot) => TResult,
): Promise<TResult> {
  const opened = await options.decks.deckService.openDeck({ caller: options.caller, deckId: options.deckId });
  if (opened.kind !== "opened") throw new Error(`the deck did not open: ${opened.kind}`);
  await using deck = opened.deck;
  return read(deck.snapshot());
}
