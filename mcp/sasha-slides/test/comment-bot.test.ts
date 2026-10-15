import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { googleOwnerDrives } from "../comment-bot/owner-drive.ts";
import {
  ACKNOWLEDGEMENT_TEXTS,
  acknowledgementText,
  CHANNEL_LIFETIME_MS,
  CLOCK_SKEW_MS,
  createCommentBot,
  isSashaLine,
  parseDeckId,
  PUSH_DEBOUNCE_MS,
  SWEEP_INTERVAL_MS,
  WATCH_LIFETIME_MS,
  type CommentBot,
  type SetTimer,
} from "../comment-bot/comment-bot.ts";
import { allowUrlFor } from "../comment-bot/comment-access-page.ts";
import { fileBackedAuthStore, inMemoryAuthStore, type AuthStore } from "../http/oauth-store.ts";
import { COMMENT_BOT_FLAG_REMOVED, createSashaSlidesServer, parseServerMode } from "../server.ts";
import { createFakeDrive } from "./fake-drive.ts";
import { createFakeComments } from "./fake-comments.ts";
import { createFakeOwnerDrive, type FakeOwnerDrive } from "./fake-owner-drive.ts";

/**
 * THE COMMENT BOT ACTS AS EACH WATCH'S OWN USER, COSTS O(CHANGES), NEVER O(DECKS), AND NOTHING
 * AT ALL WHEN IDLE.
 *
 * A user's session starts a watch on a deck; every Drive call for it carries THAT user's Google
 * grant (there is no shared Sasha account), every line Sasha posts starts with "Sasha: ", and
 * every new comment becomes a task for that session. These tests drive the real bot and its real
 * REST client against a fake Google with per-user grants and `drive.file` per-deck access, which
 * counts every request and records whose token it carried, with a fake clock and fake timers, so
 * each claim below is a measured call count, not an assumption.
 */

const T0 = Date.parse("2026-10-14T09:00:00.000Z");
const PUBLIC_URL = "https://sashaslides.com";
const HOOK = `${PUBLIC_URL}/hooks/drive`;
const CLIENT = { clientId: "980752129078-test.apps.googleusercontent.com", clientSecret: "secret" };
const DECK = "deckAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_DECK = "deckBBBBBBBBBBBBBBBBBBBBBBBB";
const ALICE = "google-sub-alice";
const BOB = "google-sub-bob";

type Harness = Readonly<{
  bot: CommentBot;
  google: FakeOwnerDrive;
  store: AuthStore;
  warnings: readonly string[];
  advance: (milliseconds: number) => Promise<void>;
  pendingTimers: () => number;
  /** A push on `owner`'s channel (Alice's by default). */
  push: (options?: Readonly<{ owner?: string; state?: string; token?: string; channelId?: string }>) => Promise<string>;
}>;

function harness(options: Readonly<{ store?: AuthStore; google?: FakeOwnerDrive; clock?: { ms: number } }> = {}): Harness {
  const clock = options.clock ?? { ms: T0 };
  const now = (): Date => new Date(clock.ms);
  const google = options.google ?? createFakeOwnerDrive({ now });
  const store = options.store ?? inMemoryAuthStore();
  if (options.google === undefined) {
    void store.googleIdentities.put({ key: ALICE, value: google.addUser({ subject: ALICE, name: "Alice" }) });
    void store.googleIdentities.put({ key: BOB, value: google.addUser({ subject: BOB, name: "Bob" }) });
  }
  const timers: { due: number; run: () => void; cancelled: boolean }[] = [];
  const setTimer: SetTimer = ({ delayMs, run }) => {
    const timer = { due: clock.ms + delayMs, run, cancelled: false };
    timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  };
  const warnings: string[] = [];
  let counter = 0;
  const bot = createCommentBot({
    drives: googleOwnerDrives({ grants: store.googleIdentities, client: CLIENT, fetch: google.fetch, now, timeoutMs: 1_000 }),
    store,
    webhookUrl: HOOK,
    allowUrlFor: (fileId) => allowUrlFor({ publicUrl: PUBLIC_URL, fileId }),
    now,
    setTimer,
    randomToken: () => `random${String(counter++)}${"x".repeat(24)}`,
    warn: (message) => warnings.push(message),
  });

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setImmediate(resolve));
    await bot.idle();
  };

  return {
    bot,
    google,
    store,
    warnings,
    advance: async (milliseconds) => {
      const target = clock.ms + milliseconds;
      for (;;) {
        await settle();
        const next = timers.filter((timer) => !timer.cancelled).sort((left, right) => left.due - right.due)[0];
        if (next === undefined || next.due > target) break;
        clock.ms = Math.max(clock.ms, next.due);
        next.cancelled = true;
        next.run();
      }
      clock.ms = target;
      await settle();
    },
    pendingTimers: () => timers.filter((timer) => !timer.cancelled).length,
    push: async (push = {}) => {
      const channel = google.channels().find((candidate) => candidate.owner === (push.owner ?? ALICE));
      const outcome = await bot.handlePush({
        headers: {
          "x-goog-channel-id": push.channelId ?? channel?.id ?? "none",
          "x-goog-channel-token": push.token ?? channel?.token ?? "none",
          "x-goog-resource-state": push.state ?? "change",
        },
      });
      return outcome.kind;
    },
  };
}

/** The deck exists and is shared with Alice and Bob as commenters; `owner` picks it and watches. */
async function watching(h: Harness, owner: string = ALICE, deck: string = DECK): Promise<string> {
  ensureDeck(h, deck);
  h.google.pick({ subject: owner, fileId: deck });
  const outcome = await h.bot.watch({ ownerSubject: owner, deck: `https://docs.google.com/presentation/d/${deck}/edit#slide=id.p` });
  assert.equal(outcome.kind, "watching");
  if (outcome.kind !== "watching") throw new Error("unreachable");
  return outcome.watch.watchId;
}

const addedDecks = new WeakMap<Harness, Set<string>>();
function ensureDeck(h: Harness, deck: string): void {
  const known = addedDecks.get(h) ?? new Set<string>();
  addedDecks.set(h, known);
  if (known.has(deck)) return;
  known.add(deck);
  h.google.addDeck({ fileId: deck, name: deck === DECK ? "Q3 review" : "Other deck", sharedWith: { [ALICE]: "commenter", [BOB]: "commenter" } });
}

async function commentArrives(h: Harness, options: Readonly<{ by: string; content: string; owner?: string }>): Promise<string> {
  const commentId = h.google.addComment({ fileId: DECK, by: options.by, content: options.content });
  await h.push({ owner: options.owner ?? ALICE });
  await h.advance(PUSH_DEBOUNCE_MS);
  return commentId;
}

describe("parsing", () => {
  test("a deck is a Slides URL, a legacy open?id= URL or a bare id", () => {
    assert.equal(parseDeckId(`https://docs.google.com/presentation/d/${DECK}/edit`), DECK);
    assert.equal(parseDeckId(`https://docs.google.com/open?id=${DECK}`), DECK);
    assert.equal(parseDeckId(DECK), DECK);
    assert.equal(parseDeckId("https://evil.example.com/presentation/d/" + DECK), null);
    assert.equal(parseDeckId("not a deck"), null);
  });

  test("a Sasha line is one that starts with the prefix", () => {
    assert.equal(isSashaLine("Sasha: On it ⏳"), true);
    assert.equal(isSashaLine("  Sasha: done"), true);
    assert.equal(isSashaLine("please, Sasha: fix this"), false);
    assert.equal(isSashaLine("make it bigger"), false);
  });

  test("the removed shared-account flag refuses to start, by name", () => {
    const mode = parseServerMode(["--http", "--public-url", PUBLIC_URL, "--comment-bot", "/run/secrets/comment-bot.json"]);
    assert.deepEqual(mode, { kind: "usage", reason: COMMENT_BOT_FLAG_REMOVED });
    assert.equal(parseServerMode(["--http", "--public-url", PUBLIC_URL]).kind, "http");
  });
});

describe("whose grant", () => {
  test("(b) a deck the owner's grant cannot read answers with the allow link, and opens no channel", async () => {
    const h = harness();
    ensureDeck(h, DECK);
    const outcome = await h.bot.watch({ ownerSubject: ALICE, deck: DECK });
    assert.deepEqual(outcome, { kind: "needs-access", allowUrl: `https://sashaslides.com/comments/allow?deck=${DECK}` });
    assert.equal(h.google.counts()["changes.watch"], 0);
    assert.deepEqual(h.google.calls().map((call) => call.caller), [ALICE, ALICE], "a token refresh and files.get, both Alice's");
    assert.equal(h.pendingTimers(), 0);
  });

  test("(c) after the user picks the deck, the same call watches it", async () => {
    const h = harness();
    ensureDeck(h, DECK);
    assert.equal((await h.bot.watch({ ownerSubject: ALICE, deck: DECK })).kind, "needs-access");
    h.google.pick({ subject: ALICE, fileId: DECK });
    const outcome = await h.bot.watch({ ownerSubject: ALICE, deck: DECK });
    assert.equal(outcome.kind, "watching");
    assert.equal(h.google.channels().length, 1);
  });

  test("a grant without any Drive scope is sent to the allow page without a Drive call; no grant at all says sign in", async () => {
    const h = harness();
    ensureDeck(h, DECK);
    await h.store.googleIdentities.put({
      key: ALICE,
      value: h.google.addUser({ subject: ALICE, name: "Alice", scopes: ["openid", "email", "https://www.googleapis.com/auth/presentations"] }),
    });
    assert.equal((await h.bot.watch({ ownerSubject: ALICE, deck: DECK })).kind, "needs-access");
    assert.deepEqual(h.google.calls(), []);
    assert.deepEqual(await h.bot.watch({ ownerSubject: "google-sub-stranger", deck: DECK }), { kind: "no-grant" });
  });

  test("a deck the owner may only view is refused: they need Commenter access", async () => {
    const h = harness();
    h.google.addDeck({ fileId: OTHER_DECK, name: "view only", sharedWith: { [ALICE]: "viewer" } });
    h.google.pick({ subject: ALICE, fileId: OTHER_DECK });
    assert.deepEqual(await h.bot.watch({ ownerSubject: ALICE, deck: OTHER_DECK }), { kind: "cannot-comment" });
  });

  test("(a) a watch's every Drive call carries its owner's grant, never another user's", async () => {
    const h = harness();
    await watching(h, ALICE);
    await watching(h, BOB);
    h.google.resetCounts();
    const commentId = await commentArrives(h, { by: "Ada", content: "tighten slide 2" });
    assert.deepEqual([...new Set(h.google.calls().map((call) => call.caller))], [ALICE], "Alice's push: only Alice's grant");
    const [task] = await h.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Tightened." });
    assert.deepEqual([...new Set(h.google.calls().map((call) => call.caller))], [ALICE]);
    assert.deepEqual(h.google.thread({ commentId })?.replies.map((reply) => ({ author: reply.author, content: reply.content })), [
      { author: ALICE, content: "Sasha: Tightened." },
    ]);

    h.google.resetCounts();
    await h.push({ owner: BOB });
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual([...new Set(h.google.calls().map((call) => call.caller))], [BOB], "Bob's push: only Bob's grant");
    assert.deepEqual((await h.bot.openTasks({ ownerSubject: BOB })).map((open) => open.text), ["tighten slide 2"]);
  });
});

describe("channels: one per user with watches", () => {
  test("(e) an idle bot makes no call and holds no timer", async () => {
    const h = harness();
    await h.bot.start();
    await h.advance(6 * 60 * 60 * 1000);
    assert.deepEqual(h.google.calls(), []);
    assert.equal(h.pendingTimers(), 0);
  });

  test("(e) each user with watches has ONE channel of their own; it goes when their last watch does", async () => {
    const h = harness();
    const aliceFirst = await watching(h, ALICE, DECK);
    const aliceSecond = await watching(h, ALICE, OTHER_DECK);
    assert.deepEqual(h.google.channels().map((channel) => channel.owner), [ALICE], "two watches, one channel");
    const bobs = await watching(h, BOB, DECK);
    assert.deepEqual(h.google.channels().map((channel) => channel.owner).sort(), [ALICE, BOB].sort());
    assert.ok(h.google.channels().every((channel) => channel.address === HOOK));
    assert.equal(h.google.counts()["changes.watch"], 2);

    assert.deepEqual(await h.bot.stopWatching({ ownerSubject: BOB, watchId: aliceFirst }), { kind: "unknown-watch" }, "only the owner stops a watch");
    await h.bot.stopWatching({ ownerSubject: ALICE, watchId: aliceFirst });
    assert.equal(h.google.channels().length, 2, "Alice still watches a deck: her channel stays");
    await h.bot.stopWatching({ ownerSubject: ALICE, watchId: aliceSecond });
    assert.deepEqual(h.google.channels().map((channel) => channel.owner), [BOB], "Alice has none: hers is stopped, Bob's stays");
    assert.equal(await h.store.commentChannels.get({ key: ALICE }), null);
    assert.equal(h.google.calls().filter((call) => call.endpoint === "channels.stop")[0]?.caller, ALICE);

    await h.bot.stopWatching({ ownerSubject: BOB, watchId: bobs });
    assert.equal(h.google.channels().length, 0);
    h.google.resetCounts();
    await h.advance(24 * 60 * 60 * 1000);
    assert.deepEqual(h.google.calls(), [], "no watch: no call");
    assert.equal(h.pendingTimers(), 0);
  });

  test("watching the same deck again renews the watch instead of adding one", async () => {
    const h = harness();
    const first = await watching(h);
    await h.advance(60 * 60 * 1000);
    const again = await h.bot.watch({ ownerSubject: ALICE, deck: DECK });
    assert.ok(again.kind === "watching" && again.renewed && again.watch.watchId === first);
    assert.equal((await h.bot.listWatches({ ownerSubject: ALICE })).length, 1);
  });

  test("a forgotten watch expires after 24 hours and the bot goes silent", async () => {
    const h = harness();
    await watching(h);
    await h.advance(WATCH_LIFETIME_MS + SWEEP_INTERVAL_MS);
    assert.deepEqual(await h.bot.listWatches({ ownerSubject: ALICE }), []);
    assert.equal(h.google.channels().length, 0);
    h.google.resetCounts();
    await h.advance(24 * 60 * 60 * 1000);
    assert.deepEqual(h.google.calls(), []);
    assert.equal(h.pendingTimers(), 0);
  });

  test("a channel is renewed before it expires, and the old channel's pushes are then ignored", async () => {
    const h = harness();
    h.google.setChannelLifetimeMs(2 * 60 * 60 * 1000);
    await watching(h);
    const old = h.google.channels()[0];
    await h.advance(SWEEP_INTERVAL_MS);
    const channels = h.google.channels();
    assert.equal(channels.length, 1, "the old channel was stopped");
    assert.notEqual(channels[0]?.id, old?.id);
    assert.equal(h.google.counts()["changes.watch"], 2);
    assert.equal(await h.push({ channelId: old?.id ?? "", token: old?.token ?? "" }), "ignored");
    assert.equal(await h.push(), "accepted");
    assert.ok(CHANNEL_LIFETIME_MS > 2 * 60 * 60 * 1000, "the bot asked for longer than Google granted");
  });
});

describe("pushes", () => {
  test("a push with a wrong token or channel is ignored; the opening sync message does nothing", async () => {
    const h = harness();
    await watching(h);
    h.google.addComment({ fileId: DECK, by: "Ada", content: "too dense" });
    h.google.resetCounts();
    assert.equal(await h.push({ token: "forged-token-of-the-same-length-xxxxxxx" }), "ignored");
    assert.equal(await h.push({ channelId: "someone-elses-channel" }), "ignored");
    assert.equal(await h.push({ state: "sync" }), "sync-message");
    await h.advance(PUSH_DEBOUNCE_MS * 2);
    assert.equal(h.google.counts()["changes.list"], 0);
  });

  test("a push costs ONE changes.list, and comments.list only for the watched deck among 50 changed files", async () => {
    const h = harness();
    await watching(h);
    for (let index = 0; index < 50; index += 1) {
      const fileId = `unwatched${String(index).padStart(20, "0")}`;
      h.google.addDeck({ fileId, name: `deck ${String(index)}`, sharedWith: { [ALICE]: "commenter" } });
      h.google.pick({ subject: ALICE, fileId });
      h.google.addComment({ fileId, by: "Someone", content: "hello" });
    }
    const commentId = h.google.addComment({ fileId: DECK, by: "Ada", content: "make the chart bigger", quoted: "Revenue", anchor: '{"type":"page","pages":["p3"]}' });
    h.google.resetCounts();
    assert.equal(await h.push(), "accepted");
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(
      { changes: h.google.counts()["changes.list"], comments: h.google.counts()["comments.list"], replies: h.google.counts()["replies.create"] },
      { changes: 1, comments: 1, replies: 0 },
    );
    const tasks = await h.bot.openTasks({ ownerSubject: ALICE });
    assert.equal(tasks.length, 1);
    assert.deepEqual(
      { commentId: tasks[0]?.commentId, author: tasks[0]?.authorName, text: tasks[0]?.text, deck: tasks[0]?.deckTitle, quoted: tasks[0]?.quotedText },
      { commentId, author: "Ada", text: "make the chart bigger", deck: "Q3 review", quoted: "Revenue" },
    );
    assert.equal(tasks[0]?.anchor, '{"type":"page","pages":["p3"]}');
  });

  test("a burst of comments and pushes is debounced into one changes.list and one comments.list", async () => {
    const h = harness();
    await watching(h);
    h.google.resetCounts();
    for (let index = 0; index < 5; index += 1) {
      h.google.addComment({ fileId: DECK, by: "Ada", content: `point ${String(index)}` });
      await h.push();
      await h.advance(200);
    }
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.equal(h.google.counts()["changes.list"], 1);
    assert.equal(h.google.counts()["comments.list"], 1);
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 5);
  });

  test("comments from before the watch began are not tasks; replies after it are, with their thread", async () => {
    const h = harness();
    ensureDeck(h, DECK);
    const old = h.google.addComment({ fileId: DECK, by: "Ada", content: "old remark" });
    await h.advance(CLOCK_SKEW_MS * 4);
    await watching(h);
    h.google.addReply({ fileId: DECK, commentId: old, by: "Grace", content: "still true?" });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    const tasks = await h.bot.openTasks({ ownerSubject: ALICE });
    assert.deepEqual(tasks.map((task) => ({ text: task.text, thread: task.threadText })), [{ text: "still true?", thread: "old remark" }]);
  });

  test("the safety sweep finds a comment whose push was dropped", async () => {
    const h = harness();
    await watching(h);
    h.google.addComment({ fileId: DECK, by: "Ada", content: "no push for this one" });
    h.google.resetCounts();
    await h.advance(SWEEP_INTERVAL_MS);
    assert.equal(h.google.counts()["changes.list"], 1);
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 1);
  });

  test("an expired page token restarts the feed and rescans the watched decks once", async () => {
    const h = harness();
    await watching(h);
    h.google.addComment({ fileId: DECK, by: "Ada", content: "during the outage" });
    h.google.expirePageTokens();
    await h.advance(SWEEP_INTERVAL_MS);
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 1);
  });
});

describe("(d) Sasha's lines and the user's own", () => {
  test("every line Sasha posts starts with 'Sasha: ', appears as the user, and never becomes a task", async () => {
    const h = harness();
    await watching(h);
    const commentId = await commentArrives(h, { by: "Ada", content: "can you tighten this slide?" });
    const [task] = await h.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    const acknowledgement = h.google.thread({ commentId })?.replies[0];
    assert.deepEqual({ author: acknowledgement?.author, content: acknowledgement?.content }, { author: ALICE, content: `Sasha: ${acknowledgementText(commentId)}` });
    assert.deepEqual(await h.bot.reply({ ownerSubject: BOB, taskId: task.taskId, text: "hi" }), { kind: "unknown-task" }, "only the owner answers");
    assert.equal((await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Done: https://sashaslides.com/p/p_123" })).kind, "replied");
    assert.deepEqual(h.google.thread({ commentId })?.replies.map((reply) => reply.content), ["Sasha: Done: https://sashaslides.com/p/p_123"]);

    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(await h.bot.openTasks({ ownerSubject: ALICE }), [], "answered, and Sasha's reply is not work");
    assert.equal((await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "   " })).kind, "invalid-text");
  });

  test("the user's OWN comments and replies are tasks, although Drive reports them as 'me'", async () => {
    const h = harness();
    await watching(h);
    const commentId = await commentArrives(h, { by: ALICE, content: "make slide 2 calmer" });
    const [task] = await h.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined && task.text === "make slide 2 calmer" && task.authorName === "Alice");
    await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Softened the colours." });

    h.google.touch({ fileId: DECK });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(await h.bot.openTasks({ ownerSubject: ALICE }), []);

    h.google.addReply({ fileId: DECK, commentId, by: ALICE, content: "and slide 3 too" });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual((await h.bot.openTasks({ ownerSubject: ALICE })).map((open) => open.text), ["and slide 3 too"]);
  });

  test("two users watching one deck never answer each other's Sasha (no loop)", async () => {
    const h = harness();
    await watching(h, ALICE);
    await watching(h, BOB);
    const commentId = await commentArrives(h, { by: "Ada", content: "one remark" });
    await h.push({ owner: BOB });
    await h.advance(PUSH_DEBOUNCE_MS);
    const [aliceTask] = await h.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(aliceTask !== undefined);
    await h.bot.reply({ ownerSubject: ALICE, taskId: aliceTask.taskId, text: "Alice's Sasha answered." });
    await h.push({ owner: BOB });
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual((await h.bot.openTasks({ ownerSubject: BOB })).map((open) => open.text), ["one remark"], "Alice's Sasha line is not Bob's work");
    assert.equal(h.google.thread({ commentId })?.replies.length, 1);
  });

  test("an answer that already starts with the prefix is not prefixed twice", async () => {
    const h = harness();
    await watching(h);
    const commentId = await commentArrives(h, { by: "Ada", content: "shorter title?" });
    const [task] = await h.bot.openTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Sasha: Shortened." });
    assert.deepEqual(h.google.thread({ commentId })?.replies.map((reply) => reply.content), ["Sasha: Shortened."]);
  });
});

describe("tasks and acknowledgements", () => {
  test("the first pickUpTasks posts one acknowledgement per new task, in its thread; a second posts nothing", async () => {
    const h = harness();
    await watching(h);
    const first = h.google.addComment({ fileId: DECK, by: "Ada", content: "tighten slide 2" });
    const second = h.google.addComment({ fileId: DECK, by: "Grace", content: "fix the chart" });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);

    h.google.resetCounts();
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 2);
    assert.equal(h.google.counts()["replies.create"], 0, "listing (open_work) is not picking up: no acknowledgement");

    assert.equal((await h.bot.pickUpTasks({ ownerSubject: ALICE })).length, 2);
    assert.equal(h.google.counts()["replies.create"], 2, "one acknowledgement per task");
    for (const commentId of [first, second]) {
      const replies = h.google.thread({ commentId })?.replies ?? [];
      assert.deepEqual(replies.map((reply) => reply.content), [`Sasha: ${acknowledgementText(commentId)}`]);
    }
    assert.deepEqual(new Set(ACKNOWLEDGEMENT_TEXTS.map((variant) => variant.endsWith("⏳"))), new Set([true]));

    h.google.resetCounts();
    assert.equal((await h.bot.pickUpTasks({ ownerSubject: ALICE })).length, 2, "still open until answered");
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.equal(h.google.counts()["replies.create"], 0, "a second pickUpTasks posts nothing");
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 2, "the acknowledgements are not work");
  });

  test("the answer replaces the acknowledgement: same reply, new content, no second reply", async () => {
    const h = harness();
    await watching(h);
    const commentId = await commentArrives(h, { by: "Ada", content: "tighten slide 2" });
    const [task] = await h.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    const acknowledgementId = h.google.thread({ commentId })?.replies[0]?.id;

    h.google.resetCounts();
    const replied = await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Tightened: three bullets now." });
    assert.equal(replied.kind, "replied");
    assert.deepEqual({ create: h.google.counts()["replies.create"], update: h.google.counts()["replies.update"] }, { create: 0, update: 1 });
    assert.deepEqual(h.google.thread({ commentId })?.replies.map((reply) => ({ id: reply.id, content: reply.content })), [
      { id: acknowledgementId, content: "Sasha: Tightened: three bullets now." },
    ]);
    assert.ok(replied.kind === "replied" && replied.task.botReplyId === acknowledgementId);
    assert.deepEqual(await h.bot.pickUpTasks({ ownerSubject: ALICE }), []);
  });

  test("when the acknowledgement is gone, the answer is posted as a new reply", async () => {
    const h = harness();
    await watching(h);
    const commentId = await commentArrives(h, { by: "Ada", content: "tighten slide 2" });
    const [task] = await h.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    const acknowledgementId = h.google.thread({ commentId })?.replies[0]?.id ?? "";
    h.google.deleteReply({ commentId, replyId: acknowledgementId });

    h.google.resetCounts();
    const replied = await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Tightened." });
    assert.equal(replied.kind, "replied");
    assert.deepEqual({ create: h.google.counts()["replies.create"], update: h.google.counts()["replies.update"] }, { create: 1, update: 1 });
    const live = h.google.thread({ commentId })?.replies.filter((reply) => !reply.deleted) ?? [];
    assert.deepEqual(live.map((reply) => reply.content), ["Sasha: Tightened."]);
    assert.ok(replied.kind === "replied" && replied.task.botReplyId === live[0]?.id);
  });

  test("a restart over the persisted store resumes each owner's watch without handling anything twice", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sasha-comment-bot-")), "store.json");
    const first = harness({ store: fileBackedAuthStore({ path, warn: () => undefined }) });
    await watching(first);
    const commentId = await commentArrives(first, { by: "Ada", content: "first" });
    await first.bot.pickUpTasks({ ownerSubject: ALICE });

    // A new process: the store re-read from disk, the same Google.
    const second = harness({ store: fileBackedAuthStore({ path, warn: () => undefined }), google: first.google });
    first.bot.close();
    second.google.resetCounts();
    await second.bot.start();
    await second.advance(0);
    assert.equal(second.google.counts()["changes.watch"], 0, "Alice's stored channel is reused");
    assert.equal((await second.bot.listWatches({ ownerSubject: ALICE })).length, 1);
    const [task] = await second.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    assert.equal(second.google.counts()["replies.create"], 0, "not acknowledged twice");
    await second.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "answered after the restart" });
    assert.deepEqual(second.google.thread({ commentId })?.replies.map((reply) => reply.content), ["Sasha: answered after the restart"]);

    second.google.addComment({ fileId: DECK, by: "Ada", content: "second" });
    await second.push();
    await second.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual((await second.bot.openTasks({ ownerSubject: ALICE })).map((open) => open.text), ["second"]);
  });
});

describe("the call budget", () => {
  test("one comment, picked up and answered, costs at most 8 Drive calls, all the owner's", async () => {
    const h = harness();
    await watching(h);
    await h.advance(PUSH_DEBOUNCE_MS);
    h.google.resetCounts();

    const commentId = await commentArrives(h, { by: "Ada", content: "swap slides 2 and 3" });
    const detected = h.google.calls().length;
    const [task] = await h.bot.pickUpTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Swapped." });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);

    const counts = h.google.counts();
    assert.deepEqual(
      { detected, changes: counts["changes.list"], comments: counts["comments.list"], create: counts["replies.create"], update: counts["replies.update"], token: counts.token },
      { detected: 2, changes: 3, comments: 3, create: 1, update: 1, token: 0 },
      "detect: changes.list + comments.list; acknowledge: replies.create; answer: replies.update; each of Sasha's two writes echoes once",
    );
    assert.equal(h.google.calls().length, 8);
    assert.deepEqual([...new Set(h.google.calls().map((call) => call.caller))], [ALICE]);
    assert.deepEqual(h.google.thread({ commentId })?.replies.map((reply) => reply.content), ["Sasha: Swapped."]);
  });
});

describe("the connector's tools", () => {
  test("a task shows in open_work and comment_tasks for the watch owner only, and reply_comment_task answers it", async () => {
    const h = harness();
    await watching(h, ALICE);
    const commentId = await commentArrives(h, { by: "Ada", content: "swap the order" });

    const alice = await connect({ bot: h.bot, subject: ALICE });
    const bob = await connect({ bot: h.bot, subject: BOB });
    try {
      const aliceWork = JSON.parse(await text(alice.callTool({ name: "open_work", arguments: {} }))) as { commentTasks?: { taskId: string; text: string }[] };
      assert.deepEqual(aliceWork.commentTasks?.map((task) => task.text), ["swap the order"]);
      const bobWork = JSON.parse(await text(bob.callTool({ name: "open_work", arguments: {} }))) as { commentTasks?: unknown };
      assert.equal(bobWork.commentTasks, undefined);
      const bobTasks = JSON.parse(await text(bob.callTool({ name: "comment_tasks", arguments: {} }))) as { count: number };
      assert.equal(bobTasks.count, 0);

      h.google.resetCounts();
      const listed = JSON.parse(await text(alice.callTool({ name: "comment_tasks", arguments: {} }))) as { tasks: { taskId: string }[] };
      await text(alice.callTool({ name: "comment_tasks", arguments: {} }));
      assert.equal(h.google.counts()["replies.create"], 1, "comment_tasks acknowledges once");
      const taskId = listed.tasks[0]?.taskId ?? "";
      const refused = await bob.callTool({ name: "reply_comment_task", arguments: { taskId, text: "not mine" } });
      assert.equal(refused.isError, true);
      const replied = JSON.parse(await text(alice.callTool({ name: "reply_comment_task", arguments: { taskId, text: "Swapped." } }))) as { status: string };
      assert.equal(replied.status, "replied");
      assert.deepEqual(h.google.thread({ commentId })?.replies.map((reply) => reply.content), ["Sasha: Swapped."]);

      const watches = JSON.parse(await text(alice.callTool({ name: "list_watches", arguments: {} }))) as { watches: { watchId: string }[] };
      const stopped = JSON.parse(await text(alice.callTool({ name: "stop_watching", arguments: { watchId: watches.watches[0]?.watchId ?? "" } }))) as { status: string };
      assert.equal(stopped.status, "stopped");
      assert.equal(h.google.channels().length, 0);

      ensureDeck(h, OTHER_DECK);
      const unpicked = await alice.callTool({ name: "watch_comments", arguments: { deck: OTHER_DECK } });
      assert.equal(unpicked.isError, true);
      const message = await text(Promise.resolve(unpicked));
      assert.ok(message.includes(`https://sashaslides.com/comments/allow?deck=${OTHER_DECK}`), message);
      assert.match(message, /call watch_comments again/);
      assert.doesNotMatch(message, /sasha@sashaslides\.com|share this deck/);
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});

async function connect(options: Readonly<{ bot: CommentBot; subject: string }>): Promise<Client> {
  const drive = createFakeDrive();
  const now = (): Date => new Date(T0);
  const comments = createFakeComments({ now, pageObjectIds: ["p"], defaultFileId: "unused-deck" });
  const server = createSashaSlidesServer({
    resolveEnvironment: () =>
      Promise.resolve({
        kind: "ok",
        env: { drive: drive.channel, now, randomSuffix: () => "aaaaaa", sleep: async () => undefined, statFile: () => ({ bytes: 64 }), warn: () => undefined },
      }),
    resolveFeedbackEnvironment: () =>
      Promise.resolve({ kind: "ok", env: { channel: comments.channel, now, sleep: async () => undefined, warn: () => undefined } }),
    instructions: "test",
    remote: true,
    commentBot: options.bot,
  });
  const authInfo: AuthInfo = { token: "t", clientId: "c", scopes: [], extra: { googleSubject: options.subject } };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  // The HTTP transport attaches the caller's AuthInfo to each request; do the same here.
  const send = clientSide.send.bind(clientSide);
  clientSide.send = (message, sendOptions) => send(message, { ...sendOptions, authInfo });
  await server.connect(serverSide);
  const client = new Client({ name: "comment-bot-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientSide);
  return client;
}

async function text(result: Promise<Awaited<ReturnType<Client["callTool"]>>>): Promise<string> {
  const resolved = await result;
  const content = resolved.content;
  const first = Array.isArray(content) ? (content[0] as { type?: string; text?: string } | undefined) : undefined;
  return first?.text ?? "";
}
