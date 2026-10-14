import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { googleBotDrive, parseCommentBotConfig, type CommentBotConfig } from "../comment-bot/bot-drive.ts";
import {
  CHANNEL_LIFETIME_MS,
  CLOCK_SKEW_MS,
  createCommentBot,
  parseDeckId,
  PUSH_DEBOUNCE_MS,
  SWEEP_INTERVAL_MS,
  WATCH_LIFETIME_MS,
  type CommentBot,
  type CommentBotStore,
  type SetTimer,
} from "../comment-bot/comment-bot.ts";
import { CHANNEL_KEY } from "../comment-bot/comment-records.ts";
import { fileBackedAuthStore, inMemoryAuthStore } from "../http/oauth-store.ts";
import { createSashaSlidesServer } from "../server.ts";
import { createFakeDrive } from "./fake-drive.ts";
import { createFakeComments } from "./fake-comments.ts";
import { createFakeBotDrive, type FakeBotDrive } from "./fake-bot-drive.ts";

/**
 * THE COMMENT BOT COSTS O(CHANGES), NEVER O(DECKS), AND NOTHING AT ALL WHEN IDLE.
 *
 * A user's session starts a watch on a deck shared with the bot account; every new comment on
 * it becomes a task for that session, answered as the bot. These tests drive the real bot and
 * its real REST client against a fake Google that counts every request, with a fake clock and
 * fake timers, so each claim below is a measured call count, not an assumption.
 */

const T0 = Date.parse("2026-10-14T09:00:00.000Z");
const BOT = "sasha@sashaslides.com";
const HOOK = "https://sashaslides.com/hooks/drive";
const CONFIG: CommentBotConfig = { clientId: "client", clientSecret: "secret", refreshToken: "refresh", address: BOT };
const DECK = "deckAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_DECK = "deckBBBBBBBBBBBBBBBBBBBBBBBB";
const ALICE = "google-sub-alice";
const BOB = "google-sub-bob";

type Harness = Readonly<{
  bot: CommentBot;
  google: FakeBotDrive;
  store: CommentBotStore;
  warnings: readonly string[];
  advance: (milliseconds: number) => Promise<void>;
  pendingTimers: () => number;
  push: (options?: Readonly<{ state?: string; token?: string; channelId?: string }>) => Promise<string>;
}>;

function harness(options: Readonly<{ store?: CommentBotStore; google?: FakeBotDrive; clock?: { ms: number } }> = {}): Harness {
  const clock = options.clock ?? { ms: T0 };
  const now = (): Date => new Date(clock.ms);
  const google = options.google ?? createFakeBotDrive({ now });
  const store = options.store ?? inMemoryAuthStore();
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
    drive: googleBotDrive({ config: CONFIG, fetch: google.fetch, now, timeoutMs: 1_000 }),
    store,
    address: BOT,
    webhookUrl: HOOK,
    now,
    setTimer,
    randomToken: () => `random${String(counter++)}${"x".repeat(24)}`,
    warn: (message) => warnings.push(message),
  });

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setImmediate(resolve));
    await bot.idle();
  };

  const self: Harness = {
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
      const channel = google.channels()[0];
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
  return self;
}

async function watching(h: Harness, owner: string = ALICE, deck: string = DECK): Promise<string> {
  h.google.addDeck({ fileId: deck, name: deck === DECK ? "Q3 review" : "Other deck" });
  const outcome = await h.bot.watch({ ownerSubject: owner, deck: `https://docs.google.com/presentation/d/${deck}/edit#slide=id.p` });
  assert.equal(outcome.kind, "watching");
  if (outcome.kind !== "watching") throw new Error("unreachable");
  return outcome.watch.watchId;
}

describe("parsing", () => {
  test("a deck is a Slides URL, a legacy open?id= URL or a bare id", () => {
    assert.equal(parseDeckId(`https://docs.google.com/presentation/d/${DECK}/edit`), DECK);
    assert.equal(parseDeckId(`https://docs.google.com/open?id=${DECK}`), DECK);
    assert.equal(parseDeckId(DECK), DECK);
    assert.equal(parseDeckId("https://evil.example.com/presentation/d/" + DECK), null);
    assert.equal(parseDeckId("not a deck"), null);
  });

  test("the config file names a bad key without echoing any value", () => {
    const bad = parseCommentBotConfig(JSON.stringify({ ...CONFIG, refreshToken: "" }));
    assert.equal(bad.kind, "error");
    assert.ok(bad.kind === "error" && !bad.message.includes("secret"));
    assert.equal(parseCommentBotConfig(JSON.stringify({ ...CONFIG, extra: "secret-value" })).kind, "error");
    assert.equal(parseCommentBotConfig(JSON.stringify(CONFIG)).kind, "ok");
  });
});

describe("watches", () => {
  test("an idle bot makes no call and holds no timer", async () => {
    const h = harness();
    await h.bot.start();
    await h.advance(6 * 60 * 60 * 1000);
    assert.deepEqual(h.google.calls(), []);
    assert.equal(h.pendingTimers(), 0);
  });

  test("a deck not shared with the bot is refused with the address to share it with, and opens no channel", async () => {
    const h = harness();
    const outcome = await h.bot.watch({ ownerSubject: ALICE, deck: DECK });
    assert.deepEqual(outcome, { kind: "not-shared", address: BOT });
    h.google.addDeck({ fileId: OTHER_DECK, name: "view only", canComment: false });
    assert.deepEqual(await h.bot.watch({ ownerSubject: ALICE, deck: OTHER_DECK }), { kind: "not-shared", address: BOT });
    assert.equal(h.google.counts()["changes.watch"], 0);
    assert.equal(h.pendingTimers(), 0);
  });

  test("the first watch opens ONE channel to the webhook; a second watch reuses it", async () => {
    const h = harness();
    await watching(h);
    await watching(h, BOB, OTHER_DECK);
    const channels = h.google.channels();
    assert.equal(channels.length, 1);
    assert.equal(channels[0]?.address, HOOK);
    assert.equal(h.google.counts()["changes.watch"], 1);
    assert.equal(h.google.counts()["changes.getStartPageToken"], 1);
  });

  test("start, list and stop; the last watch ending stops the channel and every timer", async () => {
    const h = harness();
    const first = await watching(h);
    const second = await watching(h, ALICE, OTHER_DECK);
    assert.deepEqual((await h.bot.listWatches({ ownerSubject: ALICE })).map((watch) => watch.watchId).sort(), [first, second].sort());
    assert.deepEqual(await h.bot.listWatches({ ownerSubject: BOB }), []);
    assert.deepEqual(await h.bot.stopWatching({ ownerSubject: BOB, watchId: first }), { kind: "unknown-watch" }, "only the owner stops a watch");

    assert.equal((await h.bot.stopWatching({ ownerSubject: ALICE, watchId: first })).kind, "stopped");
    assert.equal(h.google.channels().length, 1, "one watch left: the channel stays");
    assert.equal((await h.bot.stopWatching({ ownerSubject: ALICE, watchId: second })).kind, "stopped");
    assert.equal(h.google.channels().length, 0);
    assert.equal(h.google.counts()["channels.stop"], 1);
    assert.equal(await h.store.commentBotChannel.get({ key: CHANNEL_KEY }), null);

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
});

describe("pushes", () => {
  test("a push with a wrong token or channel is ignored; the opening sync message does nothing", async () => {
    const h = harness();
    await watching(h);
    h.google.addComment({ fileId: DECK, author: "Ada", content: "too dense" });
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
      h.google.addDeck({ fileId, name: `deck ${String(index)}` });
      h.google.addComment({ fileId, author: "Someone", content: "hello" });
    }
    const commentId = h.google.addComment({ fileId: DECK, author: "Ada", content: "make the chart bigger", quoted: "Revenue", anchor: '{"type":"page","pages":["p3"]}' });
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
      h.google.addComment({ fileId: DECK, author: "Ada", content: `point ${String(index)}` });
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
    h.google.addDeck({ fileId: DECK, name: "Q3 review" });
    const old = h.google.addComment({ fileId: DECK, author: "Ada", content: "old remark" });
    await h.advance(CLOCK_SKEW_MS * 4);
    await watching(h);
    h.google.addReply({ fileId: DECK, commentId: old, author: "Grace", content: "still true?" });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    const tasks = await h.bot.openTasks({ ownerSubject: ALICE });
    assert.deepEqual(tasks.map((task) => ({ text: task.text, thread: task.threadText })), [{ text: "still true?", thread: "old remark" }]);
  });

  test("the safety sweep finds a comment whose push was dropped", async () => {
    const h = harness();
    await watching(h);
    h.google.addComment({ fileId: DECK, author: "Ada", content: "no push for this one" });
    h.google.resetCounts();
    await h.advance(SWEEP_INTERVAL_MS);
    assert.equal(h.google.counts()["changes.list"], 1);
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 1);
  });

  test("an expired page token restarts the feed and rescans the watched decks once", async () => {
    const h = harness();
    await watching(h);
    h.google.addComment({ fileId: DECK, author: "Ada", content: "during the outage" });
    h.google.expirePageTokens();
    await h.advance(SWEEP_INTERVAL_MS);
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 1);
  });

  test("the channel is renewed before it expires, and the old channel's pushes are then ignored", async () => {
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

describe("tasks and replies", () => {
  test("a reply is posted as the bot; the bot's own reply never becomes a task", async () => {
    const h = harness();
    await watching(h);
    const commentId = h.google.addComment({ fileId: DECK, author: "Ada", content: "can you tighten this slide?" });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    const [task] = await h.bot.openTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    assert.deepEqual(await h.bot.reply({ ownerSubject: BOB, taskId: task.taskId, text: "hi" }), { kind: "unknown-task" }, "only the owner answers");

    h.google.resetCounts();
    const replied = await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "Done: https://sashaslides.com/p/p_123" });
    assert.equal(replied.kind, "replied");
    assert.equal(h.google.counts()["replies.create"], 1);
    const thread = h.google.thread({ commentId });
    assert.deepEqual(thread?.replies.map((reply) => ({ content: reply.content, bot: reply.author.me })), [
      { content: "Done: https://sashaslides.com/p/p_123", bot: true },
    ]);

    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(await h.bot.openTasks({ ownerSubject: ALICE }), [], "answered, and the bot's reply is not work");
    assert.equal((await h.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "   " })).kind, "invalid-text");
  });

  test("two owners watching one deck each get the comment; one comments.list serves both", async () => {
    const h = harness();
    await watching(h, ALICE);
    await watching(h, BOB);
    h.google.addComment({ fileId: DECK, author: "Ada", content: "shared deck remark" });
    h.google.resetCounts();
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.equal(h.google.counts()["comments.list"], 1);
    assert.equal((await h.bot.openTasks({ ownerSubject: ALICE })).length, 1);
    assert.equal((await h.bot.openTasks({ ownerSubject: BOB })).length, 1);
  });

  test("a restart over the persisted store resumes the watch without handling anything twice", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sasha-comment-bot-")), "store.json");
    const store = fileBackedAuthStore({ path, warn: () => undefined });
    const first = harness({ store });
    await watching(first);
    first.google.addComment({ fileId: DECK, author: "Ada", content: "first" });
    await first.push();
    await first.advance(PUSH_DEBOUNCE_MS);
    const [task] = await first.bot.openTasks({ ownerSubject: ALICE });
    assert.ok(task !== undefined);
    await first.bot.reply({ ownerSubject: ALICE, taskId: task.taskId, text: "answered" });

    // A new process: the store re-read from disk, the same Google.
    const second = harness({ store: fileBackedAuthStore({ path, warn: () => undefined }), google: first.google });
    first.bot.close();
    second.google.resetCounts();
    await second.bot.start();
    await second.advance(0);
    assert.equal(second.google.counts()["changes.watch"], 0, "the stored channel is reused");
    assert.deepEqual(await second.bot.openTasks({ ownerSubject: ALICE }), [], "the answered task stays answered");
    assert.equal(second.google.counts()["replies.create"], 0);
    assert.equal((await second.bot.listWatches({ ownerSubject: ALICE })).length, 1);

    second.google.addComment({ fileId: DECK, author: "Ada", content: "second" });
    await second.push();
    await second.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual((await second.bot.openTasks({ ownerSubject: ALICE })).map((open) => open.text), ["second"]);
  });
});

describe("the connector's tools", () => {
  test("a task shows in open_work and comment_tasks for the watch owner only, and reply_comment_task answers it", async () => {
    const h = harness();
    await watching(h, ALICE);
    h.google.addComment({ fileId: DECK, author: "Ada", content: "swap the order" });
    await h.push();
    await h.advance(PUSH_DEBOUNCE_MS);

    const alice = await connect({ bot: h.bot, subject: ALICE });
    const bob = await connect({ bot: h.bot, subject: BOB });
    try {
      const aliceWork = JSON.parse(await text(alice.callTool({ name: "open_work", arguments: {} }))) as { commentTasks?: { taskId: string; text: string }[] };
      assert.deepEqual(aliceWork.commentTasks?.map((task) => task.text), ["swap the order"]);
      const bobWork = JSON.parse(await text(bob.callTool({ name: "open_work", arguments: {} }))) as { commentTasks?: unknown };
      assert.equal(bobWork.commentTasks, undefined);
      const bobTasks = JSON.parse(await text(bob.callTool({ name: "comment_tasks", arguments: {} }))) as { count: number };
      assert.equal(bobTasks.count, 0);

      const taskId = aliceWork.commentTasks?.[0]?.taskId ?? "";
      const refused = await bob.callTool({ name: "reply_comment_task", arguments: { taskId, text: "not mine" } });
      assert.equal(refused.isError, true);
      const replied = JSON.parse(await text(alice.callTool({ name: "reply_comment_task", arguments: { taskId, text: "Swapped." } }))) as { status: string };
      assert.equal(replied.status, "replied");

      const watches = JSON.parse(await text(alice.callTool({ name: "list_watches", arguments: {} }))) as { watches: { watchId: string }[] };
      const stopped = JSON.parse(await text(alice.callTool({ name: "stop_watching", arguments: { watchId: watches.watches[0]?.watchId ?? "" } }))) as { status: string };
      assert.equal(stopped.status, "stopped");
      assert.equal(h.google.channels().length, 0);

      const unshared = await alice.callTool({ name: "watch_comments", arguments: { deck: OTHER_DECK } });
      assert.equal(unshared.isError, true);
      assert.match(await text(Promise.resolve(unshared)), /share this deck with sasha@sashaslides\.com \(Editor or Commenter\), then call watch_comments again/);
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
