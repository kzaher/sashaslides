/**
 * The `DeckService` contract over `memory-deck-service.ts` (acceptance 10), the service modules 4
 * and 5 test against: a non-member's open is `notFound`, an agent's envelope reaches a connected
 * socket as a sync update plus an `agentEdit` carrying the summary, and `waitForDiscussion`
 * resolves on a new entry and at its timeout.
 *
 *   cd mcp/sasha-slides && npx tsx --test decks/memory-deck-service.test.ts
 */
import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";
import type { CommandId, DiscussionRequestId, MessageId, SlideId, ThreadId } from "../engine/src/contracts/ids.ts";
import { connectSocket, manualTimers, settle, startLoopbackServer } from "./deck-test-support";
import { createMemoryDeckService } from "./memory-deck-service";

const PUBLIC_URL = "https://decks.example.test";
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe("the memory deck service", () => {
  test("openDeck by a non-member is notFound; by a member it opens", async () => {
    const timers = manualTimers(1_000_000);
    await using decks = createMemoryDeckService({ now: timers.now, timers });
    const owner = await decks.signIn({ email: "owner@example.com" });
    const stranger = await decks.signIn({ email: "stranger@example.com" });
    const created = await decks.deckService.createDeck({ caller: owner, title: "Contract" });
    assert.equal(created.kind, "opened");
    if (created.kind !== "opened") return;
    await using deck = created.deck;
    assert.deepEqual(await decks.deckService.openDeck({ caller: stranger, deckId: deck.deckId }), { kind: "notFound" });
    const reopened = await decks.deckService.openDeck({ caller: owner, deckId: deck.deckId });
    assert.equal(reopened.kind, "opened");
    if (reopened.kind === "opened") await reopened.deck[Symbol.asyncDispose]();
    assert.equal(deck.role(), "owner");
    assert.equal(deck.summary().title, "Contract");
  });

  test("a handle held across the caller's removal reports no role and allows nothing", async () => {
    const timers = manualTimers(1_000_000);
    await using decks = createMemoryDeckService({ now: timers.now, timers });
    const owner = await decks.signIn({ email: "owner@example.com" });
    const member = await decks.signIn({ email: "member@example.com" });
    const created = await decks.deckService.createDeck({ caller: owner, title: "Removal" });
    assert.equal(created.kind, "opened");
    if (created.kind !== "opened") return;
    await using ownerDeck = created.deck;
    const deckId = ownerDeck.deckId;
    assert.equal((await decks.server.manager.invite({ accountId: owner.accountId, deckId, email: "member@example.com", role: "editor" })).kind, "ok");
    const opened = await decks.deckService.openDeck({ caller: member, deckId });
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    await using memberDeck = opened.deck;
    assert.equal(memberDeck.role(), "editor", "control: a member's handle reports the role");
    assert.equal((await decks.server.manager.removeMember({ accountId: owner.accountId, deckId, personId: member.person.id })).kind, "ok");
    assert.equal(memberDeck.role(), null);
    assert.deepEqual(await memberDeck.putAsset({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" }), { kind: "notPermitted" });
  });

  test("an agent's envelope reaches a connected socket as a sync update and an agentEdit with the summary", async () => {
    const timers = manualTimers(1_000_000);
    const decks = createMemoryDeckService({ now: timers.now, timers, publicUrl: PUBLIC_URL });
    const loopback = await startLoopbackServer({ portal: null, decks: decks.server });
    cleanups.push(async () => {
      await decks[Symbol.asyncDispose]();
      await loopback[Symbol.asyncDispose]();
    });
    const owner = await decks.signIn({ email: "owner@example.com" });
    const created = await decks.deckService.createDeck({ caller: owner, title: "Live" });
    if (created.kind !== "opened") throw new Error(created.kind);
    const deck = created.deck;
    const cookie = (await decks.server.deckSessionStart.issueCookie({ accountId: owner.accountId })).split(";")[0] ?? "";
    const socket = connectSocket({ port: loopback.port, path: `/deck-api/sync/${deck.deckId}`, origin: PUBLIC_URL, cookie });
    await socket.opened;
    await socket.until(() => socket.messages().some((message) => message.kind === "welcome"));
    const framesBefore = socket.binaryFrames().length;

    const applied = await deck.apply({
      envelope: {
        // A valid object id (ids.ts) by construction.
        commandId: "cm_agentContract1" as CommandId,
        author: { kind: "agent", name: owner.agent.displayName, agentSessionId: "as_contract0001" },
        commands: [{ kind: "setTitle", title: "Written by Claude" }],
        selectionBefore: { kind: "none" },
        selectionAfter: { kind: "none" },
        mergeWithPrevious: false,
      },
      summaryForCollaborators: "renamed the deck",
    });
    assert.equal(applied.kind, "applied");

    await socket.until(() => socket.messages().some((message) => message.kind === "agentEdit"));
    const agentEdit = socket.messages().find((message) => message.kind === "agentEdit");
    assert.deepEqual(agentEdit, { kind: "agentEdit", agentSessionId: "as_contract0001", agentName: "Claude", summary: "renamed the deck" });
    const updates = socket.binaryFrames().slice(framesBefore).filter((frame) => frame[0] === 0 && frame[1] === 2);
    assert.ok(updates.length >= 1, "a y-websocket sync update frame (message type 0, sync update 2)");
    socket.socket.close();
    await deck[Symbol.asyncDispose]();
  });

  test("a room unloads 60 seconds after its last lease, or 30 minutes after an agent edit while its history exists", async () => {
    type Row = Readonly<{ name: string; agentEdit: boolean; stillLoadedAt: number; unloadedBy: number }>;
    const rows: readonly Row[] = [
      { name: "control: no agent history", agentEdit: false, stillLoadedAt: 59_000, unloadedBy: 61_000 },
      { name: "an agent history keeps it 30 minutes", agentEdit: true, stillLoadedAt: 29 * 60_000, unloadedBy: 30 * 60_000 + 1_000 },
    ];
    for (const row of rows) {
      const timers = manualTimers(1_000_000);
      await using decks = createMemoryDeckService({ now: timers.now, timers });
      const owner = await decks.signIn({ email: "owner@example.com" });
      const created = await decks.deckService.createDeck({ caller: owner, title: "Lifecycle" });
      if (created.kind !== "opened") throw new Error(created.kind);
      const deckId = created.deck.deckId;
      if (row.agentEdit) {
        const slideId = created.deck.snapshot().slides[0]?.id;
        if (slideId === undefined) throw new Error("the blank deck has a slide");
        // An undoable change (slides are in the undo scope; the title is not, yjs-schema.ts).
        const applied = await created.deck.apply({
          envelope: {
            // A valid object id (ids.ts) by construction.
            commandId: "cm_lifecycleAgent" as CommandId,
            author: { kind: "agent", name: "Claude", agentSessionId: "as_lifecycle01" },
            commands: [{ kind: "setSlideProperties", slideId, patch: { skipped: true } }],
            selectionBefore: { kind: "none" },
            selectionAfter: { kind: "none" },
            mergeWithPrevious: false,
          },
          summaryForCollaborators: "skipped the first slide",
        });
        assert.equal(applied.kind, "applied");
      }
      await created.deck[Symbol.asyncDispose]();
      timers.advance(row.stillLoadedAt);
      await settle();
      assert.notEqual(decks.server.manager.registry.loaded({ deckId }), null, `${row.name}: still loaded`);
      timers.advance(row.unloadedBy - row.stillLoadedAt);
      await settle();
      assert.equal(decks.server.manager.registry.loaded({ deckId }), null, `${row.name}: unloaded`);
    }
  });

  test("waitForDiscussion resolves on a new entry, and with the current discussion at its timeout", async () => {
    const timers = manualTimers(1_000_000);
    await using decks = createMemoryDeckService({ now: timers.now, timers });
    const owner = await decks.signIn({ email: "owner@example.com" });
    const created = await decks.deckService.createDeck({ caller: owner, title: "Discussion" });
    if (created.kind !== "opened") throw new Error(created.kind);
    await using deck = created.deck;
    const slideId: SlideId | undefined = deck.snapshot().slides[0]?.id;
    assert.ok(slideId !== undefined);

    const timedOut = deck.waitForDiscussion({ afterSequence: 0, timeoutMilliseconds: 5_000, signal: new AbortController().signal });
    timers.advance(5_000);
    assert.equal((await timedOut).sequence, 0);

    const waiting = deck.waitForDiscussion({ afterSequence: 0, timeoutMilliseconds: 60_000, signal: new AbortController().signal });
    const outcome = await deck.submitDiscussion({
      as: "agent",
      request: {
        // Valid object ids (ids.ts) by construction.
        requestId: "dq_contract0001" as DiscussionRequestId,
        command: {
          kind: "createThread",
          threadId: "th_contract0001" as ThreadId,
          anchor: { slideId, target: { kind: "slide" }, region: null, elementFrameAtCreation: null },
          markings: [],
          messageId: "ms_contract0001" as MessageId,
          body: "Claude has a question",
          mentions: [],
        },
      },
    });
    assert.equal(outcome.kind, "applied");
    const resolved = await waiting;
    assert.equal(resolved.sequence, 1);
    assert.equal(resolved.threads[0]?.createdBy.kind, "agent", "the agent person is the actor");
  });
});
