/**
 * The comment bot: a user's Claude session asks it to WATCH a deck (`watch_comments`), and
 * while the watch lasts every new comment or reply on that deck, by anyone but the bot,
 * becomes a COMMENT TASK for the session that started it. The session (not this server: no
 * model runs here) reads the task, does the thinking, and answers through
 * `reply_comment_task`, which the bot posts into the thread as its own account.
 *
 * Detection is event driven and costs O(changes), never O(decks):
 *
 *  1. ONE Drive `changes.watch` channel on the bot account's change feed, pushing to
 *     `POST /hooks/drive`. It exists only while at least one watch is active: the last watch
 *     ending stops it (`channels.stop`), so an idle bot holds no channel, runs no timer and
 *     makes no call at all. It is renewed a day before it expires.
 *  2. A push whose `X-Goog-Channel-ID` / `X-Goog-Channel-Token` match the stored channel
 *     schedules a sync after a short debounce, so a burst of edits is one sync. Anything else
 *     is ignored. While watches are active a safety sweep runs the same sync every few
 *     minutes, because Google may drop pushes.
 *  3. A sync is ONE `changes.list` from the saved page token. Changed files that are not a
 *     watched deck are dropped right there, with no further call. Each changed watched deck
 *     gets ONE `comments.list` with `startModifiedTime` = that deck's cursor (several decks in
 *     parallel, capped), and the cursor and page token are saved afterwards.
 *  4. Each comment or reply created since its watch began and not written by the bot is a
 *     task keyed by hash(watchId, commentId, replyId); a key already held is skipped, which
 *     makes duplicate pushes, overlapping sweeps and restarts harmless.
 *
 * ACKNOWLEDGEMENT. When the session first picks a task up (`pickUpTasks`, behind
 * `comment_tasks`), the bot at once posts a short "On it ⏳" reply in the thread, so the
 * commenter sees that Sasha has started. The answer (`reply`) then REWRITES that reply
 * (`replies.update`, allowed to the reply's author) instead of adding a second one, so the
 * thread reads as the question and then Sasha's answer. That is one Drive call per task and
 * no polling; if the acknowledgement is gone (someone deleted it), the answer falls back to a
 * new reply. Listing alone (`openTasks`, behind `open_work`) acknowledges nothing.
 *
 * The ⏳ is deliberately STATIC. Google Slides comments are plain text: there are no animated
 * emoji or GIFs. The only way to "animate" one would be to keep editing the reply ("." ->
 * ".." -> "..."), which costs a Drive write per second per open comment; at thousands of users
 * that is exactly the API spam this design avoids.
 *
 * Watches expire on their own after `WATCH_LIFETIME_MS` (24 hours) unless `watch_comments`
 * is called again for the same deck, in case the user forgets to stop one.
 *
 * Everything effectful is injected: the bot's Drive (`bot-drive.ts`), the store, the clock,
 * the timers and the randomness. State is mirrored in memory and written through to the
 * store, which assumes ONE server process serves the bot, as one process serves the store.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { assertNever } from "../google-auth";
import type { RecordStore } from "../http/oauth-store";
import { SLIDES_MIME_TYPE, type BotDrive, type DriveComment, type DriveResult } from "./bot-drive";
import { CHANNEL_KEY, type BotChannel, type CommentTask, type CommentWatch, type FileCursor } from "./comment-records";

/** How long a watch lasts unless renewed by calling `watch_comments` again. */
export const WATCH_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** The safety sweep's period while any watch is active. */
export const SWEEP_INTERVAL_MS = 3 * 60 * 1000;
/** Pushes inside this window collapse into one sync. */
export const PUSH_DEBOUNCE_MS = 2_000;
/** What the channel asks for: Google's maximum for a changes channel is one week. */
export const CHANNEL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Renew the channel when it has less than this left. Far above the sweep period. */
export const CHANNEL_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
/** Decks queried at once in one sync. */
export const COMMENT_SCAN_CONCURRENCY = 4;
export const MAX_WATCHES_PER_OWNER = 20;
export const MAX_REPLY_CHARACTERS = 4_000;
/** What the acknowledgement says; one is chosen per comment, deterministically. */
export const ACKNOWLEDGEMENT_TEXTS: readonly string[] = ["On it ⏳", "Got it, working on it ⏳", "On it, give me a moment ⏳"];
/**
 * The watch's start is our clock and a comment's `createdTime` is Google's. A comment written
 * this long before the watch began still counts, so a slightly fast server clock cannot drop
 * the first comment after `watch_comments`.
 */
export const CLOCK_SKEW_MS = 30_000;

export type CommentBotStore = Readonly<{
  commentBotChannel: RecordStore<BotChannel>;
  commentWatches: RecordStore<CommentWatch>;
  commentFileCursors: RecordStore<FileCursor>;
  commentTasks: RecordStore<CommentTask>;
}>;

export type SetTimer = (options: Readonly<{ delayMs: number; run: () => void }>) => Readonly<{ cancel(): void }>;

export type WatchOutcome =
  | Readonly<{ kind: "watching"; watch: CommentWatch; renewed: boolean }>
  | Readonly<{ kind: "invalid-deck" }>
  /** The bot cannot see the deck, or cannot comment on it: the user must share it. */
  | Readonly<{ kind: "not-shared"; address: string }>
  | Readonly<{ kind: "not-a-deck"; mimeType: string }>
  | Readonly<{ kind: "too-many"; limit: number }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

export type StopOutcome = Readonly<{ kind: "stopped"; watch: CommentWatch }> | Readonly<{ kind: "unknown-watch" }>;

export type ReplyOutcome =
  | Readonly<{ kind: "replied"; task: CommentTask }>
  | Readonly<{ kind: "unknown-task" }>
  | Readonly<{ kind: "invalid-text"; reason: string }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

export type PushHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export type PushOutcome =
  /** A change notice from our channel: a sync is scheduled. */
  | Readonly<{ kind: "accepted" }>
  /** The channel's opening `sync` message: nothing changed yet. */
  | Readonly<{ kind: "sync-message" }>
  /** Not our channel, or the wrong token. */
  | Readonly<{ kind: "ignored" }>;

export type CommentBot = Readonly<{
  /** The address users share their decks with. */
  address: string;
  /** Loads the store; resumes the channel and the sweep when watches survived a restart. */
  start(): Promise<void>;
  watch(options: Readonly<{ ownerSubject: string; deck: string }>): Promise<WatchOutcome>;
  stopWatching(options: Readonly<{ ownerSubject: string; watchId: string }>): Promise<StopOutcome>;
  listWatches(options: Readonly<{ ownerSubject: string }>): Promise<readonly CommentWatch[]>;
  /** The owner's open tasks, oldest first. */
  openTasks(options: Readonly<{ ownerSubject: string }>): Promise<readonly CommentTask[]>;
  /** `openTasks`, after posting the acknowledgement into each thread not yet acknowledged. */
  pickUpTasks(options: Readonly<{ ownerSubject: string }>): Promise<readonly CommentTask[]>;
  reply(options: Readonly<{ ownerSubject: string; taskId: string; text: string }>): Promise<ReplyOutcome>;
  handlePush(options: Readonly<{ headers: PushHeaders }>): Promise<PushOutcome>;
  /** Resolves once no sync is running or scheduled to run immediately; for tests and shutdown. */
  idle(): Promise<void>;
  /** Cancels the timers. The channel is left to expire (or to be reused by the next start). */
  close(): void;
}>;

/** A deck URL (`/presentation/d/<id>/…`, `open?id=<id>`) or a bare file id; null otherwise. */
export function parseDeckId(deck: string): string | null {
  const text = deck.trim();
  if (FILE_ID_PATTERN.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/(^|\.)google\.com$/.test(url.hostname)) return null;
  const fromPath = /\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] ?? null;
  const candidate = fromPath ?? url.searchParams.get("id");
  return candidate !== null && FILE_ID_PATTERN.test(candidate) ? candidate : null;
}

export function createCommentBot(
  options: Readonly<{
    drive: BotDrive;
    store: CommentBotStore;
    address: string;
    /**
     * Empty for a dedicated bot account. When the bot runs as a person's own account (the
     * stopgap), every line it posts starts with this, and only lines that do are its own.
     */
    replyPrefix: string;
    /** `<public-url>/hooks/drive`: where Google pushes. */
    webhookUrl: string;
    now: () => Date;
    setTimer: SetTimer;
    /** URL-safe and unguessable: channel ids, channel tokens and watch ids are drawn from it. */
    randomToken: () => string;
    warn: (message: string) => void;
  }>,
): CommentBot {
  const { drive, store, address, replyPrefix, webhookUrl, now, setTimer, randomToken, warn } = options;
  const signed = (text: string): string => `${replyPrefix}${text}`;
  /**
   * Whose line is it? With a dedicated account, Drive's `me` says so. Running as a person's own
   * account, `me` is also true for everything THAT PERSON writes, so only the prefix marks the bot.
   */
  const isBotLine = (post: Readonly<{ author: Readonly<{ me: boolean }>; content: string }>): boolean =>
    post.author.me && (replyPrefix === "" || post.content.trimStart().startsWith(replyPrefix.trim()));
  const watches = new Map<string, CommentWatch>();
  const tasks = new Map<string, CommentTask>();
  let tickTimer: Readonly<{ cancel(): void }> | null = null;
  let syncTimer: Readonly<{ cancel(): void }> | null = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  // Channel creation, renewal and teardown run one at a time, so two watches started together
  // cannot open two channels.
  let channelQueue: Promise<unknown> = Promise.resolve();
  // One acknowledgement in flight per task, so two `comment_tasks` calls at once cannot post
  // two, and an answer arriving meanwhile waits for the reply it will replace.
  const acknowledging = new Map<string, Promise<void>>();

  function exclusive<TValue>(work: () => Promise<TValue>): Promise<TValue> {
    const next = channelQueue.then(work, work);
    channelQueue = next.catch(() => undefined);
    return next;
  }

  async function ensureChannel(): Promise<Readonly<{ kind: "ok" }> | Readonly<{ kind: "failed"; reason: string }>> {
    return exclusive(async () => {
      const nowMs = now().getTime();
      const current = await store.commentBotChannel.get({ key: CHANNEL_KEY });
      if (current !== null && current.expiresAtMs - nowMs > CHANNEL_RENEW_MARGIN_MS) return { kind: "ok" };
      let pageToken = current?.pageToken ?? null;
      if (pageToken === null) {
        const start = await drive.getStartPageToken();
        if (start.kind === "failed") return { kind: "failed", reason: start.reason };
        pageToken = start.value;
      }
      const channelId = randomToken();
      const token = randomToken();
      const watched = await drive.watchChanges({ pageToken, channelId, token, address: webhookUrl, expiresAtMs: nowMs + CHANNEL_LIFETIME_MS });
      if (watched.kind === "failed") return { kind: "failed", reason: watched.reason };
      await store.commentBotChannel.put({
        key: CHANNEL_KEY,
        value: { channelId, resourceId: watched.value.resourceId, token, expiresAtMs: watched.value.expiresAtMs, pageToken },
      });
      // The new channel first, then the old one stopped: the overlap can only duplicate a
      // push, which the task keys absorb, while the reverse order could miss one.
      if (current !== null) await stopChannel(current);
      return { kind: "ok" };
    });
  }

  async function stopChannel(channel: BotChannel): Promise<void> {
    const stopped = await drive.stopChannel({ channelId: channel.channelId, resourceId: channel.resourceId });
    // Best effort: a channel we fail to stop expires on its own, and its pushes are ignored.
    if (stopped.kind === "failed") warn(`comment bot: could not stop an old Drive channel (${stopped.reason})`);
  }

  /** The last watch ended: stop the channel and every timer, so the bot is silent. */
  async function goIdle(): Promise<void> {
    tickTimer?.cancel();
    tickTimer = null;
    syncTimer?.cancel();
    syncTimer = null;
    await exclusive(async () => {
      if (watches.size > 0) return;
      const current = await store.commentBotChannel.get({ key: CHANNEL_KEY });
      if (current === null) return;
      await store.commentBotChannel.remove({ key: CHANNEL_KEY });
      await stopChannel(current);
    });
  }

  function startTicking(): void {
    if (tickTimer !== null || watches.size === 0) return;
    tickTimer = setTimer({
      delayMs: SWEEP_INTERVAL_MS,
      run: () => {
        tickTimer = null;
        void tick()
          .catch((cause: unknown) => warn(`comment bot: sweep failed: ${describe(cause)}`))
          .finally(startTicking);
      },
    });
  }

  async function tick(): Promise<void> {
    const nowMs = now().getTime();
    for (const watch of [...watches.values()]) {
      if (watch.expiresAtMs <= nowMs) await removeWatch(watch);
    }
    if (watches.size === 0) {
      await goIdle();
      return;
    }
    const channel = await ensureChannel();
    if (channel.kind === "failed") warn(`comment bot: cannot renew the Drive channel (${channel.reason})`);
    requestSync({ delayMs: 0 });
  }

  function requestSync(request: Readonly<{ delayMs: number }>): void {
    if (syncTimer !== null) return;
    syncTimer = setTimer({
      delayMs: request.delayMs,
      run: () => {
        syncTimer = null;
        void runSync();
      },
    });
  }

  function runSync(): Promise<void> {
    if (running !== null) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await syncOnce();
        } while (rerun);
      } catch (cause) {
        warn(`comment bot: sync failed: ${describe(cause)}`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function syncOnce(): Promise<void> {
    if (watches.size === 0) return;
    const channel = await store.commentBotChannel.get({ key: CHANNEL_KEY });
    if (channel === null) return;
    const watchedFiles = new Set([...watches.values()].map((watch) => watch.fileId));
    const changed = new Map<string, string | null>();
    let pageToken = channel.pageToken;
    for (;;) {
      const page = await drive.listChanges({ pageToken });
      if (page.kind === "failed") {
        if (!INVALID_PAGE_TOKEN_STATUSES.includes(page.status)) {
          warn(`comment bot: changes.list failed (${page.reason}); the next sweep retries`);
          return;
        }
        // The token is gone (too old, or the feed was reset): start over from now, and scan
        // every watched deck once from its cursor so nothing in the gap is lost.
        const start = await drive.getStartPageToken();
        if (start.kind === "failed") return;
        for (const fileId of watchedFiles) changed.set(fileId, null);
        pageToken = start.value;
        break;
      }
      for (const file of page.value.changedFiles) {
        // Dropped here, with no further call: a change to anything but a watched deck.
        if (!watchedFiles.has(file.fileId)) continue;
        if (file.mimeType !== null && file.mimeType !== SLIDES_MIME_TYPE) continue;
        changed.set(file.fileId, file.name);
      }
      if (page.value.nextPageToken !== null) {
        pageToken = page.value.nextPageToken;
        continue;
      }
      pageToken = page.value.newStartPageToken ?? pageToken;
      break;
    }
    await inParallel({
      items: [...changed.entries()],
      limit: COMMENT_SCAN_CONCURRENCY,
      run: ([fileId, name]) => scanDeck({ fileId, name }),
    });
    // Saved after the scans: a crash before this line re-reads the same changes, which the
    // task keys make harmless, while saving first could skip a deck forever.
    await exclusive(async () => {
      const latest = await store.commentBotChannel.get({ key: CHANNEL_KEY });
      if (latest !== null) await store.commentBotChannel.put({ key: CHANNEL_KEY, value: { ...latest, pageToken } });
    });
  }

  async function scanDeck(options: Readonly<{ fileId: string; name: string | null }>): Promise<void> {
    const { fileId, name } = options;
    const onDeck = [...watches.values()].filter((watch) => watch.fileId === fileId);
    if (onDeck.length === 0) return;
    if (name !== null) {
      for (const watch of onDeck) {
        if (watch.deckTitle === name) continue;
        const renamed = { ...watch, deckTitle: name };
        watches.set(watch.watchId, renamed);
        await store.commentWatches.put({ key: watch.watchId, value: renamed });
      }
    }
    const cursor = await store.commentFileCursors.get({ key: fileId });
    const modifiedAfter = cursor?.modifiedAfter ?? isoTime(Math.min(...onDeck.map((watch) => watch.startedAtMs)) - CLOCK_SKEW_MS);
    let newest = modifiedAfter;
    let pageToken: string | null = null;
    do {
      const page = await drive.listComments({ fileId, modifiedAfter, pageToken });
      if (page.kind === "failed") {
        warn(`comment bot: comments.list failed (${page.reason}); the next sweep retries`);
        return;
      }
      for (const comment of page.value.comments) {
        if (comment.modifiedTime > newest) newest = comment.modifiedTime;
        await recordComment({ comment, watchers: watchersOf(fileId) });
      }
      pageToken = page.value.nextPageToken;
    } while (pageToken !== null);
    await store.commentFileCursors.put({ key: fileId, value: { modifiedAfter: newest } });
  }

  function watchersOf(fileId: string): readonly CommentWatch[] {
    return [...watches.values()].filter((watch) => watch.fileId === fileId);
  }

  async function recordComment(options: Readonly<{ comment: DriveComment; watchers: readonly CommentWatch[] }>): Promise<void> {
    const { comment, watchers } = options;
    const posts = [
      { replyId: null, content: comment.content, author: comment.author, createdTime: comment.createdTime, deleted: comment.deleted },
      ...comment.replies.map((reply) => ({ replyId: reply.id, content: reply.content, author: reply.author, createdTime: reply.createdTime, deleted: reply.deleted })),
    ];
    for (const post of posts) {
      // The bot's own replies are answers, not work; an empty reply is a resolve or reopen.
      if (post.deleted || isBotLine(post) || post.content.trim() === "") continue;
      const createdMs = Date.parse(post.createdTime);
      for (const watch of watchers) {
        if (!(createdMs >= watch.startedAtMs - CLOCK_SKEW_MS)) continue;
        const taskId = taskIdFor({ watchId: watch.watchId, commentId: comment.id, replyId: post.replyId });
        if (tasks.has(taskId)) continue;
        const task: CommentTask = {
          taskId,
          watchId: watch.watchId,
          ownerSubject: watch.ownerSubject,
          fileId: watch.fileId,
          deckTitle: watch.deckTitle,
          commentId: comment.id,
          replyId: post.replyId,
          authorName: post.author.displayName,
          text: post.content,
          threadText: post.replyId === null ? null : comment.content,
          quotedText: comment.quotedText,
          anchor: comment.anchor,
          createdTime: post.createdTime,
          state: "open",
          botReplyId: null,
          acknowledgement: { kind: "not-posted" },
        };
        tasks.set(taskId, task);
        await store.commentTasks.put({ key: taskId, value: task });
      }
    }
  }

  function acknowledge(taskId: string): Promise<void> {
    const inFlight = acknowledging.get(taskId);
    if (inFlight !== undefined) return inFlight;
    const work = postAcknowledgement(taskId).finally(() => acknowledging.delete(taskId));
    acknowledging.set(taskId, work);
    return work;
  }

  async function postAcknowledgement(taskId: string): Promise<void> {
    const task = tasks.get(taskId);
    if (task === undefined || task.state !== "open" || task.acknowledgement.kind !== "not-posted") return;
    const posted = await drive.createReply({ fileId: task.fileId, commentId: task.commentId, content: signed(acknowledgementText(task.commentId)) });
    if (posted.kind === "failed") warn(`comment bot: could not acknowledge a comment (${posted.reason}); the answer will be a new reply`);
    // Re-read: the watch may have ended while the reply was posted.
    const latest = tasks.get(taskId);
    if (latest === undefined) return;
    const acknowledged: CommentTask = {
      ...latest,
      acknowledgement: posted.kind === "ok" ? { kind: "posted", replyId: posted.value } : { kind: "failed" },
    };
    tasks.set(taskId, acknowledged);
    await store.commentTasks.put({ key: taskId, value: acknowledged });
  }

  /** The answer rewrites the acknowledgement when there is one; otherwise it is a new reply. */
  async function postAnswer(options: Readonly<{ task: CommentTask; content: string }>): Promise<DriveResult<string>> {
    const { task, content } = options;
    const postNewReply = (): Promise<DriveResult<string>> => drive.createReply({ fileId: task.fileId, commentId: task.commentId, content });
    // An already answered task is answered again: a follow-up, so a new reply.
    if (task.state === "answered") return postNewReply();
    switch (task.acknowledgement.kind) {
      case "not-posted":
      case "failed":
        return postNewReply();
      case "posted": {
        const replyId = task.acknowledgement.replyId;
        const updated = await drive.updateReply({ fileId: task.fileId, commentId: task.commentId, replyId, content });
        if (updated.kind === "ok") return { kind: "ok", value: replyId };
        // Deleted, most likely; any failure is worth one plain reply rather than no answer.
        return postNewReply();
      }
      default:
        return assertNever(task.acknowledgement);
    }
  }

  async function removeWatch(watch: CommentWatch): Promise<void> {
    watches.delete(watch.watchId);
    await store.commentWatches.remove({ key: watch.watchId });
    for (const task of [...tasks.values()]) {
      if (task.watchId !== watch.watchId) continue;
      tasks.delete(task.taskId);
      await store.commentTasks.remove({ key: task.taskId });
    }
    if (watchersOf(watch.fileId).length === 0) await store.commentFileCursors.remove({ key: watch.fileId });
  }

  async function load(): Promise<void> {
    for (const key of await store.commentWatches.keys()) {
      const watch = await store.commentWatches.get({ key });
      if (watch !== null) watches.set(watch.watchId, watch);
    }
    for (const key of await store.commentTasks.keys()) {
      const task = await store.commentTasks.get({ key });
      if (task !== null) tasks.set(task.taskId, task);
    }
  }

  const bot: CommentBot = {
    address,
    start: async () => {
      await load();
      const nowMs = now().getTime();
      for (const watch of [...watches.values()]) {
        if (watch.expiresAtMs <= nowMs) await removeWatch(watch);
      }
      if (watches.size === 0) {
        await goIdle();
        return;
      }
      const channel = await ensureChannel();
      if (channel.kind === "failed") warn(`comment bot: cannot open the Drive channel (${channel.reason}); the sweep retries`);
      startTicking();
      // Catch up on whatever changed while the server was down.
      requestSync({ delayMs: 0 });
    },
    watch: async ({ ownerSubject, deck }) => {
      const fileId = parseDeckId(deck);
      if (fileId === null) return { kind: "invalid-deck" };
      const nowMs = now().getTime();
      const existing = [...watches.values()].find((watch) => watch.ownerSubject === ownerSubject && watch.fileId === fileId);
      if (existing === undefined && [...watches.values()].filter((watch) => watch.ownerSubject === ownerSubject).length >= MAX_WATCHES_PER_OWNER) {
        return { kind: "too-many", limit: MAX_WATCHES_PER_OWNER };
      }
      const file = await drive.getFile({ fileId });
      if (file.kind === "failed") {
        // 404 is what Drive answers for a file the caller cannot see, shared or not.
        if (file.status === 404 || file.status === 403) return { kind: "not-shared", address };
        return { kind: "drive-failed", reason: file.reason };
      }
      if (file.value.mimeType !== SLIDES_MIME_TYPE) return { kind: "not-a-deck", mimeType: file.value.mimeType };
      if (!file.value.canComment) return { kind: "not-shared", address };
      const watch: CommentWatch =
        existing === undefined
          ? { watchId: `w_${randomToken()}`, ownerSubject, fileId, deckTitle: file.value.name, startedAtMs: nowMs, expiresAtMs: nowMs + WATCH_LIFETIME_MS }
          : { ...existing, deckTitle: file.value.name, expiresAtMs: nowMs + WATCH_LIFETIME_MS };
      watches.set(watch.watchId, watch);
      await store.commentWatches.put({ key: watch.watchId, value: watch });
      const channel = await ensureChannel();
      if (channel.kind === "failed") {
        if (existing === undefined) await removeWatch(watch);
        if (watches.size === 0) await goIdle();
        return { kind: "drive-failed", reason: channel.reason };
      }
      startTicking();
      return { kind: "watching", watch, renewed: existing !== undefined };
    },
    stopWatching: async ({ ownerSubject, watchId }) => {
      const watch = watches.get(watchId);
      if (watch === undefined || watch.ownerSubject !== ownerSubject) return { kind: "unknown-watch" };
      await removeWatch(watch);
      if (watches.size === 0) await goIdle();
      return { kind: "stopped", watch };
    },
    listWatches: async ({ ownerSubject }) => {
      await expireNow();
      return [...watches.values()].filter((watch) => watch.ownerSubject === ownerSubject);
    },
    openTasks: async ({ ownerSubject }) => {
      await expireNow();
      return [...tasks.values()]
        .filter((task) => task.ownerSubject === ownerSubject && task.state === "open")
        .sort((left, right) => left.createdTime.localeCompare(right.createdTime));
    },
    pickUpTasks: async ({ ownerSubject }) => {
      const open = await bot.openTasks({ ownerSubject });
      await inParallel({ items: open.map((task) => task.taskId), limit: COMMENT_SCAN_CONCURRENCY, run: acknowledge });
      return open.map((task) => tasks.get(task.taskId) ?? task);
    },
    reply: async ({ ownerSubject, taskId, text }) => {
      const found = tasks.get(taskId);
      if (found === undefined || found.ownerSubject !== ownerSubject) return { kind: "unknown-task" };
      const content = text.trim();
      if (content === "") return { kind: "invalid-text", reason: "the reply is empty" };
      if (content.length > MAX_REPLY_CHARACTERS) {
        return { kind: "invalid-text", reason: `the reply is longer than ${String(MAX_REPLY_CHARACTERS)} characters` };
      }
      await acknowledging.get(taskId);
      const task = tasks.get(taskId);
      if (task === undefined) return { kind: "unknown-task" };
      const posted = await postAnswer({ task, content: signed(content) });
      if (posted.kind === "failed") return { kind: "drive-failed", reason: posted.reason };
      const answered: CommentTask = { ...task, state: "answered", botReplyId: posted.value };
      tasks.set(taskId, answered);
      await store.commentTasks.put({ key: taskId, value: answered });
      return { kind: "replied", task: answered };
    },
    handlePush: async ({ headers }) => {
      const channel = await store.commentBotChannel.get({ key: CHANNEL_KEY });
      const channelId = headerValue(headers, "x-goog-channel-id");
      const token = headerValue(headers, "x-goog-channel-token");
      if (channel === null || channelId !== channel.channelId || token === null || !sameSecret(token, channel.token)) {
        return { kind: "ignored" };
      }
      const state = headerValue(headers, "x-goog-resource-state");
      if (state === "sync") return { kind: "sync-message" };
      requestSync({ delayMs: PUSH_DEBOUNCE_MS });
      return { kind: "accepted" };
    },
    idle: async () => {
      while (running !== null) await running;
    },
    close: () => {
      tickTimer?.cancel();
      tickTimer = null;
      syncTimer?.cancel();
      syncTimer = null;
    },
  };

  /** Expiry also applies between sweeps, so a list never shows a watch past its end. */
  async function expireNow(): Promise<void> {
    const nowMs = now().getTime();
    const expired = [...watches.values()].filter((watch) => watch.expiresAtMs <= nowMs);
    if (expired.length === 0) return;
    for (const watch of expired) await removeWatch(watch);
    if (watches.size === 0) await goIdle();
  }

  return bot;
}

/** What `comment_tasks` and `open_work` say about a watch outcome; the session reads it. */
export function describeWatchOutcome(outcome: WatchOutcome): string {
  switch (outcome.kind) {
    case "watching":
      return (
        `${outcome.renewed ? "still watching" : "watching"} "${outcome.watch.deckTitle}" until ${isoTime(outcome.watch.expiresAtMs)}. ` +
        "Every new comment or reply on it becomes a comment task: check comment_tasks, answer with reply_comment_task, " +
        "and call stop_watching when done."
      );
    case "invalid-deck":
      return "deck must be a Google Slides URL (https://docs.google.com/presentation/d/<id>/edit) or a file id";
    case "not-shared":
      return `share this deck with ${outcome.address} (Editor or Commenter), then call watch_comments again`;
    case "not-a-deck":
      return `that file is not a Google Slides presentation (it is ${outcome.mimeType})`;
    case "too-many":
      return `this account already watches ${String(outcome.limit)} decks; stop_watching one first`;
    case "drive-failed":
      return `the comment bot cannot reach Google Drive right now: ${outcome.reason}`;
    default:
      return assertNever(outcome);
  }
}

/** The acknowledgement for a comment: the same variant every time for the same comment. */
export function acknowledgementText(commentId: string): string {
  const index = createHash("sha256").update(commentId).digest()[0] ?? 0;
  return ACKNOWLEDGEMENT_TEXTS[index % ACKNOWLEDGEMENT_TEXTS.length] ?? "On it ⏳";
}

/** Drive's answers for a page token it no longer honours. */
const INVALID_PAGE_TOKEN_STATUSES: readonly number[] = [400, 404, 410];
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

function headerValue(headers: PushHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === "string") return value;
  return value?.[0] ?? null;
}

function sameSecret(given: string, expected: string): boolean {
  const left = Buffer.from(given, "utf-8");
  const right = Buffer.from(expected, "utf-8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function taskIdFor(options: Readonly<{ watchId: string; commentId: string; replyId: string | null }>): string {
  const digest = createHash("sha256").update(`${options.watchId}\n${options.commentId}\n${options.replyId ?? ""}`).digest("base64url");
  return `ct_${digest.slice(0, 22)}`;
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.name : "unknown error";
}

async function inParallel<TItem>(
  options: Readonly<{ items: readonly TItem[]; limit: number; run: (item: TItem) => Promise<void> }>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < options.items.length) {
      const item = options.items[next];
      next += 1;
      if (item !== undefined) await options.run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.limit, options.items.length) }, worker));
}
