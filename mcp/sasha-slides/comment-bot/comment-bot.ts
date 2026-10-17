/**
 * The comment bot: a user's Claude session asks it to WATCH a deck (`watch_comments`), and
 * while the watch lasts every new comment or reply on that deck, except Sasha's own lines,
 * becomes a COMMENT TASK for the session that started it. The session (not this server: no
 * model runs here) reads the task, does the thinking, and answers through
 * `reply_comment_task`, which the bot posts into the thread.
 *
 * AS WHOM. Every Drive call a watch makes uses the WATCH OWNER's own Google grant
 * (`owner-drive.ts`): the Sasha user who signed in and started it. There is no shared Sasha
 * account. So an answer appears in the thread as that user, and every line Sasha writes starts
 * with `SASHA_PREFIX` ("Sasha: "). Drive's `author.me` cannot tell Sasha's lines from the
 * owner's own (both are the owner), so THE PREFIX is what marks a line as Sasha's: a line that
 * starts with it is never work, whoever's grant reads it. That also keeps two users watching
 * one deck from answering each other's Sasha in a loop. The owner's own comments, and everyone
 * else's, are work.
 *
 * ACCESS. The grant holds `drive.file`, which reaches a deck only after its owner chose it in
 * the Google Picker. When Drive answers 404 for the deck, or the grant lacks a Drive scope,
 * `watch` answers `needs-access` with the `/comments/allow?deck=<id>` link
 * (`comment-access-page.ts`), and the session hands that link to the user.
 *
 * Detection is event driven, per owner, and costs O(changes), never O(decks):
 *
 *  1. ONE Drive `changes.watch` channel PER OWNER WITH AN ACTIVE WATCH, on that owner's own
 *     change feed, pushing to `POST /hooks/drive`. Drive's change feed belongs to a user and a
 *     grant, so it cannot be shared between users. The owner's last watch ending stops their
 *     channel (`channels.stop`), so a user with no watch holds no channel and costs no call.
 *     It is renewed a day before it expires.
 *  2. A push whose `X-Goog-Channel-ID` / `X-Goog-Channel-Token` match a stored channel
 *     schedules a sync OF THAT OWNER after a short debounce, so a burst of edits is one sync.
 *     Anything else is ignored. While any watch is active a safety sweep runs every owner's
 *     sync every few minutes (a few at a time), because Google may drop pushes.
 *  3. An owner's sync is ONE `changes.list` from their saved page token. Changed files that
 *     are not a deck that owner watches are dropped right there, with no further call. Each
 *     changed watched deck gets ONE `comments.list` with `startModifiedTime` = that owner's
 *     cursor for it (several decks in parallel, capped).
 *  4. Each comment or reply created since its watch began and not Sasha's is a task keyed by
 *     hash(watchId, commentId, replyId); a key already held is skipped, which makes duplicate
 *     pushes, overlapping sweeps and restarts harmless.
 *
 * DRIVE CALLS PER COMMENT, measured in `test/comment-bot.test.ts` ("the call budget"): the
 * comment's push costs 1 `changes.list` + 1 `comments.list`; picking the task up costs 1
 * `replies.create` (the acknowledgement); the answer costs 1 `replies.update`. Sasha's two
 * writes are changes on the owner's own feed, so each push back costs 1 `changes.list` + 1
 * `comments.list` that finds nothing to do: at most 8 calls per comment, 4 when the two echoes
 * fall in one debounce window. Plus, per owner with watches: 1 `changes.list` per safety sweep
 * (every 3 minutes), 1 token refresh per hour of activity, and 2 calls to open or renew the
 * channel once a week.
 *
 * ACKNOWLEDGEMENT. When the session first picks a task up (`pickUpTasks`, behind
 * `comment_tasks`), the bot at once posts a short "Sasha: On it ⏳" reply in the thread, so the
 * commenter sees that Sasha has started. The answer (`reply`) then REWRITES that reply
 * (`replies.update`, allowed to the reply's author, the owner) instead of adding a second one.
 * If the acknowledgement is gone, the answer falls back to a new reply. Listing alone
 * (`openTasks`, behind `open_work`) acknowledges nothing.
 *
 * The ⏳ is deliberately STATIC. Google Slides comments are plain text; "animating" one would
 * mean a Drive write per second per open comment, exactly the API spam this design avoids.
 *
 * Watches expire on their own after `WATCH_LIFETIME_MS` (24 hours) unless `watch_comments`
 * is called again for the same deck, in case the user forgets to stop one.
 *
 * Everything effectful is injected: the owners' Drives, the store, the clock, the timers and
 * the randomness. State is mirrored in memory and written through to the store, which assumes
 * ONE server process serves the bot, as one process serves the store.
 */
import { createHash } from "node:crypto";
import { mapWithConcurrency } from "../concurrency";
import { constantTimeEqual } from "../http/cookies";
import type { RecordStore } from "../http/oauth-store";
import { SLIDES_MIME_TYPE, type DriveComment, type DriveResult, type OwnerDrive, type OwnerDrives } from "./owner-drive";
import { fileCursorKey, type CommentTask, type CommentWatch, type FileCursor, type OwnerChannel } from "./comment-records";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

/** How long a watch lasts unless renewed by calling `watch_comments` again. */
export const WATCH_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** The safety sweep's period while any watch is active. */
export const SWEEP_INTERVAL_MS = 3 * 60 * 1000;
/** Pushes inside this window collapse into one sync of that owner. */
export const PUSH_DEBOUNCE_MS = 2_000;
/** What a channel asks for: Google's maximum for a changes channel is one week. */
export const CHANNEL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Renew a channel when it has less than this left. Far above the sweep period. */
export const CHANNEL_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
/** Decks queried at once in one sync, and owners swept at once in one safety sweep. */
export const COMMENT_SCAN_CONCURRENCY = 4;
export const MAX_WATCHES_PER_OWNER = 20;
export const MAX_REPLY_CHARACTERS = 4_000;
/** Starts every line Sasha posts, and is how a line is recognised as Sasha's (see the header). */
export const SASHA_PREFIX = "Sasha: ";
/** What the acknowledgement says, after the prefix; one is chosen per comment, deterministically. */
export const ACKNOWLEDGEMENT_TEXTS: readonly string[] = ["On it ⏳", "Got it, working on it ⏳", "On it, give me a moment ⏳"];
/**
 * The watch's start is our clock and a comment's `createdTime` is Google's. A comment written
 * this long before the watch began still counts, so a slightly fast server clock cannot drop
 * the first comment after `watch_comments`.
 */
export const CLOCK_SKEW_MS = 30_000;

export type CommentBotStore = Readonly<{
  commentChannels: RecordStore<OwnerChannel>;
  commentWatches: RecordStore<CommentWatch>;
  commentFileCursors: RecordStore<FileCursor>;
  commentTasks: RecordStore<CommentTask>;
}>;

export type SetTimer = (options: Readonly<{ delayMs: number; run: () => void }>) => Readonly<{ cancel(): void }>;

export type WatchOutcome =
  | Readonly<{ kind: "watching"; watch: CommentWatch; renewed: boolean }>
  | Readonly<{ kind: "invalid-deck" }>
  /** No usable Google grant is stored for the caller: they sign in to the connector again. */
  | Readonly<{ kind: "no-grant" }>
  /** The caller's grant cannot read this deck yet: they choose it once on `allowUrl`. */
  | Readonly<{ kind: "needs-access"; allowUrl: string }>
  /** The caller can see the deck but not comment on it (a Viewer share). */
  | Readonly<{ kind: "cannot-comment" }>
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
  /** A change notice from one of our channels: a sync of its owner is scheduled. */
  | Readonly<{ kind: "accepted" }>
  /** A channel's opening `sync` message: nothing changed yet. */
  | Readonly<{ kind: "sync-message" }>
  /** Not our channel, or the wrong token. */
  | Readonly<{ kind: "ignored" }>;

export type CommentBot = Readonly<{
  /** Loads the store; resumes channels and the sweep when watches survived a restart. */
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
  /** Resolves once no sync is running; for tests and shutdown. */
  idle(): Promise<void>;
  /** Cancels the timers. Channels are left to expire (or to be reused by the next start). */
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

/** True for a line Sasha wrote: it starts with `SASHA_PREFIX` (see the header for why not `me`). */
export function isSashaLine(content: string): boolean {
  return content.trimStart().startsWith(SASHA_PREFIX.trim());
}

export function createCommentBot(
  options: Readonly<{
    drives: OwnerDrives;
    store: CommentBotStore;
    /** `<public-url>/hooks/drive`: where Google pushes. */
    webhookUrl: string;
    /** The `/comments/allow` page for one deck, handed to the user when their grant cannot read it. */
    allowUrlFor: (fileId: string) => string;
    now: () => Date;
    setTimer: SetTimer;
    /** URL-safe and unguessable: channel ids, channel tokens and watch ids are drawn from it. */
    randomToken: () => string;
    warn: (message: string) => void;
  }>,
): CommentBot {
  const { drives, store, webhookUrl, allowUrlFor, now, setTimer, randomToken, warn } = options;
  const watches = new Map<string, CommentWatch>();
  const tasks = new Map<string, CommentTask>();
  /** Mirror of `commentChannels`, by owner, and the index pushes are matched by. */
  const channels = new Map<string, OwnerChannel>();
  const ownerByChannelId = new Map<string, string>();
  const syncs = new Map<string, OwnerSyncState>();
  let tickTimer: Readonly<{ cancel(): void }> | null = null;
  // Per owner, channel creation, renewal and teardown run one at a time, so two watches
  // started together cannot open two channels for one owner.
  const channelQueues = new Map<string, Promise<unknown>>();
  // One acknowledgement in flight per task, so two `comment_tasks` calls at once cannot post
  // two, and an answer arriving meanwhile waits for the reply it will replace.
  const acknowledging = new Map<string, Promise<void>>();

  function exclusive<TValue>(ownerSubject: string, work: () => Promise<TValue>): Promise<TValue> {
    const previous = channelQueues.get(ownerSubject) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    channelQueues.set(ownerSubject, settled);
    void settled.then(() => {
      if (channelQueues.get(ownerSubject) === settled) channelQueues.delete(ownerSubject);
    });
    return next;
  }

  function watchesOf(ownerSubject: string): readonly CommentWatch[] {
    return [...watches.values()].filter((watch) => watch.ownerSubject === ownerSubject);
  }

  function watchersOf(options: Readonly<{ ownerSubject: string; fileId: string }>): readonly CommentWatch[] {
    return watchesOf(options.ownerSubject).filter((watch) => watch.fileId === options.fileId);
  }

  async function saveChannel(channel: OwnerChannel): Promise<void> {
    const previous = channels.get(channel.ownerSubject);
    if (previous !== undefined) ownerByChannelId.delete(previous.channelId);
    channels.set(channel.ownerSubject, channel);
    ownerByChannelId.set(channel.channelId, channel.ownerSubject);
    await store.commentChannels.put({ key: channel.ownerSubject, value: channel });
  }

  async function forgetChannel(ownerSubject: string): Promise<void> {
    const previous = channels.get(ownerSubject);
    if (previous !== undefined) ownerByChannelId.delete(previous.channelId);
    channels.delete(ownerSubject);
    await store.commentChannels.remove({ key: ownerSubject });
  }

  async function ensureChannel(
    options: Readonly<{ ownerSubject: string; drive: OwnerDrive }>,
  ): Promise<Readonly<{ kind: "ok" }> | Readonly<{ kind: "failed"; reason: string }>> {
    const { ownerSubject, drive } = options;
    return exclusive(ownerSubject, async () => {
      const nowMs = now().getTime();
      const current = channels.get(ownerSubject) ?? null;
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
      await saveChannel({ ownerSubject, channelId, resourceId: watched.value.resourceId, token, expiresAtMs: watched.value.expiresAtMs, pageToken });
      // The new channel first, then the old one stopped: the overlap can only duplicate a
      // push, which the task keys absorb, while the reverse order could miss one.
      if (current !== null) await stopChannel({ channel: current, drive });
      return { kind: "ok" };
    });
  }

  async function stopChannel(options: Readonly<{ channel: OwnerChannel; drive: OwnerDrive | null }>): Promise<void> {
    const { channel, drive } = options;
    // Best effort: a channel we fail to stop expires on its own, and its pushes are ignored.
    if (drive === null) {
      warn("comment bot: could not stop a Drive channel (its owner's grant is gone); it expires on its own");
      return;
    }
    const stopped = await drive.stopChannel({ channelId: channel.channelId, resourceId: channel.resourceId });
    if (stopped.kind === "failed") warn(`comment bot: could not stop an old Drive channel (${stopped.reason})`);
  }

  /** The owner's last watch ended: stop their channel and their sync timer. */
  async function idleOwner(ownerSubject: string): Promise<void> {
    if (watchesOf(ownerSubject).length > 0) return;
    const sync = syncs.get(ownerSubject);
    sync?.timer?.cancel();
    if (sync !== undefined && sync.running === null) syncs.delete(ownerSubject);
    else if (sync !== undefined) sync.timer = null;
    await exclusive(ownerSubject, async () => {
      if (watchesOf(ownerSubject).length > 0) return;
      const current = channels.get(ownerSubject);
      if (current === undefined) return;
      await forgetChannel(ownerSubject);
      const lookup = await drives.forOwner({ ownerSubject });
      await stopChannel({ channel: current, drive: lookup.kind === "ok" ? lookup.drive : null });
    });
  }

  /** No watch left anywhere: the sweep stops too, so the bot is silent. */
  function stopTickingWhenIdle(): void {
    if (watches.size > 0) return;
    tickTimer?.cancel();
    tickTimer = null;
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
    await expireNow();
    const owners = [...new Set([...watches.values()].map((watch) => watch.ownerSubject))];
    await mapWithConcurrency({
      items: owners,
      limit: COMMENT_SCAN_CONCURRENCY,
      work: async (ownerSubject) => {
        const lookup = await drives.forOwner({ ownerSubject });
        if (lookup.kind !== "ok") {
          warn("comment bot: a watch owner's Google grant is gone; their watches wait for a new sign-in");
          return;
        }
        const channel = await ensureChannel({ ownerSubject, drive: lookup.drive });
        if (channel.kind === "failed") warn(`comment bot: cannot renew a Drive channel (${channel.reason})`);
        requestSync({ ownerSubject, delayMs: 0 });
      },
    });
  }

  function syncStateOf(ownerSubject: string): OwnerSyncState {
    const existing = syncs.get(ownerSubject);
    if (existing !== undefined) return existing;
    const created: OwnerSyncState = { timer: null, running: null, rerun: false };
    syncs.set(ownerSubject, created);
    return created;
  }

  function requestSync(request: Readonly<{ ownerSubject: string; delayMs: number }>): void {
    const state = syncStateOf(request.ownerSubject);
    if (state.timer !== null) return;
    state.timer = setTimer({
      delayMs: request.delayMs,
      run: () => {
        state.timer = null;
        void runSync(request.ownerSubject);
      },
    });
  }

  function runSync(ownerSubject: string): Promise<void> {
    const state = syncStateOf(ownerSubject);
    if (state.running !== null) {
      state.rerun = true;
      return state.running;
    }
    state.running = (async () => {
      try {
        do {
          state.rerun = false;
          await syncOnce(ownerSubject);
        } while (state.rerun);
      } catch (cause) {
        warn(`comment bot: sync failed: ${describe(cause)}`);
      } finally {
        state.running = null;
        if (state.timer === null && watchesOf(ownerSubject).length === 0) syncs.delete(ownerSubject);
      }
    })();
    return state.running;
  }

  async function syncOnce(ownerSubject: string): Promise<void> {
    const watched = watchesOf(ownerSubject);
    if (watched.length === 0) return;
    const channel = channels.get(ownerSubject);
    if (channel === undefined) return;
    const lookup = await drives.forOwner({ ownerSubject });
    if (lookup.kind !== "ok") {
      warn("comment bot: a watch owner's Google grant is gone; their watches wait for a new sign-in");
      return;
    }
    const drive = lookup.drive;
    const watchedFiles = new Set(watched.map((watch) => watch.fileId));
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
        // Dropped here, with no further call: a change to anything but a deck this owner watches.
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
    await mapWithConcurrency({
      items: [...changed.entries()],
      limit: COMMENT_SCAN_CONCURRENCY,
      work: ([fileId, name]) => scanDeck({ ownerSubject, drive, fileId, name }),
    });
    // Saved after the scans: a crash before this line re-reads the same changes, which the
    // task keys make harmless, while saving first could skip a deck forever.
    await exclusive(ownerSubject, async () => {
      const latest = channels.get(ownerSubject);
      if (latest !== undefined) await saveChannel({ ...latest, pageToken });
    });
  }

  async function scanDeck(options: Readonly<{ ownerSubject: string; drive: OwnerDrive; fileId: string; name: string | null }>): Promise<void> {
    const { ownerSubject, drive, fileId, name } = options;
    const onDeck = watchersOf({ ownerSubject, fileId });
    if (onDeck.length === 0) return;
    if (name !== null) {
      for (const watch of onDeck) {
        if (watch.deckTitle === name) continue;
        const renamed = { ...watch, deckTitle: name };
        watches.set(watch.watchId, renamed);
        await store.commentWatches.put({ key: watch.watchId, value: renamed });
      }
    }
    const cursorKey = fileCursorKey({ ownerSubject, fileId });
    const cursor = await store.commentFileCursors.get({ key: cursorKey });
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
        await recordComment({ comment, watchers: watchersOf({ ownerSubject, fileId }) });
      }
      pageToken = page.value.nextPageToken;
    } while (pageToken !== null);
    await store.commentFileCursors.put({ key: cursorKey, value: { modifiedAfter: newest } });
  }

  async function recordComment(options: Readonly<{ comment: DriveComment; watchers: readonly CommentWatch[] }>): Promise<void> {
    const { comment, watchers } = options;
    const posts = [
      { replyId: null, content: comment.content, author: comment.author, createdTime: comment.createdTime, deleted: comment.deleted },
      ...comment.replies.map((reply) => ({ replyId: reply.id, content: reply.content, author: reply.author, createdTime: reply.createdTime, deleted: reply.deleted })),
    ];
    for (const post of posts) {
      // Sasha's own lines are answers, not work; an empty reply is a resolve or reopen.
      if (post.deleted || isSashaLine(post.content) || post.content.trim() === "") continue;
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
    const lookup = await drives.forOwner({ ownerSubject: task.ownerSubject });
    const posted: DriveResult<string> =
      lookup.kind === "ok"
        ? await lookup.drive.createReply({ fileId: task.fileId, commentId: task.commentId, content: signed(acknowledgementText(task.commentId)) })
        : { kind: "failed", status: 401, reason: "the watch owner's Google grant is gone" };
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
  async function postAnswer(options: Readonly<{ drive: OwnerDrive; task: CommentTask; content: string }>): Promise<DriveResult<string>> {
    const { drive, task, content } = options;
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
    if (watchersOf({ ownerSubject: watch.ownerSubject, fileId: watch.fileId }).length === 0) {
      await store.commentFileCursors.remove({ key: fileCursorKey({ ownerSubject: watch.ownerSubject, fileId: watch.fileId }) });
    }
  }

  /** Expiry also applies between sweeps, so a list never shows a watch past its end. */
  async function expireNow(): Promise<void> {
    const nowMs = now().getTime();
    const expired = [...watches.values()].filter((watch) => watch.expiresAtMs <= nowMs);
    if (expired.length === 0) return;
    for (const watch of expired) await removeWatch(watch);
    for (const ownerSubject of new Set(expired.map((watch) => watch.ownerSubject))) await idleOwner(ownerSubject);
    stopTickingWhenIdle();
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
    for (const key of await store.commentChannels.keys()) {
      const channel = await store.commentChannels.get({ key });
      if (channel === null) continue;
      channels.set(channel.ownerSubject, channel);
      ownerByChannelId.set(channel.channelId, channel.ownerSubject);
    }
  }

  const bot: CommentBot = {
    start: async () => {
      await load();
      await expireNow();
      // A channel whose owner has no watch left (they all ended while the server was down).
      for (const ownerSubject of [...channels.keys()]) await idleOwner(ownerSubject);
      const owners = [...new Set([...watches.values()].map((watch) => watch.ownerSubject))];
      for (const ownerSubject of owners) {
        const lookup = await drives.forOwner({ ownerSubject });
        if (lookup.kind !== "ok") continue;
        const channel = await ensureChannel({ ownerSubject, drive: lookup.drive });
        if (channel.kind === "failed") warn(`comment bot: cannot open a Drive channel (${channel.reason}); the sweep retries`);
        // Catch up on whatever changed while the server was down.
        requestSync({ ownerSubject, delayMs: 0 });
      }
      startTicking();
    },
    watch: async ({ ownerSubject, deck }) => {
      const fileId = parseDeckId(deck);
      if (fileId === null) return { kind: "invalid-deck" };
      const nowMs = now().getTime();
      const existing = watchesOf(ownerSubject).find((watch) => watch.fileId === fileId);
      if (existing === undefined && watchesOf(ownerSubject).length >= MAX_WATCHES_PER_OWNER) {
        return { kind: "too-many", limit: MAX_WATCHES_PER_OWNER };
      }
      const lookup = await drives.forOwner({ ownerSubject });
      if (lookup.kind === "no-grant") return { kind: "no-grant" };
      if (lookup.scopeAccess === "missing") return { kind: "needs-access", allowUrl: allowUrlFor(fileId) };
      const file = await lookup.drive.getFile({ fileId });
      if (file.kind === "failed") {
        // 404 is what Drive answers for a file this grant cannot see: under `drive.file`, a
        // deck not yet chosen in the picker (or one the user has no access to at all).
        if (file.status === 404 || file.status === 403) return { kind: "needs-access", allowUrl: allowUrlFor(fileId) };
        if (file.status === 401) return { kind: "no-grant" };
        return { kind: "drive-failed", reason: file.reason };
      }
      if (file.value.mimeType !== SLIDES_MIME_TYPE) return { kind: "not-a-deck", mimeType: file.value.mimeType };
      if (!file.value.canComment) return { kind: "cannot-comment" };
      const watch: CommentWatch =
        existing === undefined
          ? { watchId: `w_${randomToken()}`, ownerSubject, fileId, deckTitle: file.value.name, startedAtMs: nowMs, expiresAtMs: nowMs + WATCH_LIFETIME_MS }
          : { ...existing, deckTitle: file.value.name, expiresAtMs: nowMs + WATCH_LIFETIME_MS };
      watches.set(watch.watchId, watch);
      await store.commentWatches.put({ key: watch.watchId, value: watch });
      const channel = await ensureChannel({ ownerSubject, drive: lookup.drive });
      if (channel.kind === "failed") {
        if (existing === undefined) await removeWatch(watch);
        await idleOwner(ownerSubject);
        stopTickingWhenIdle();
        return { kind: "drive-failed", reason: channel.reason };
      }
      startTicking();
      return { kind: "watching", watch, renewed: existing !== undefined };
    },
    stopWatching: async ({ ownerSubject, watchId }) => {
      const watch = watches.get(watchId);
      if (watch === undefined || watch.ownerSubject !== ownerSubject) return { kind: "unknown-watch" };
      await removeWatch(watch);
      await idleOwner(ownerSubject);
      stopTickingWhenIdle();
      return { kind: "stopped", watch };
    },
    listWatches: async ({ ownerSubject }) => {
      await expireNow();
      return watchesOf(ownerSubject);
    },
    openTasks: async ({ ownerSubject }) => {
      await expireNow();
      return [...tasks.values()]
        .filter((task) => task.ownerSubject === ownerSubject && task.state === "open")
        .sort((left, right) => left.createdTime.localeCompare(right.createdTime));
    },
    pickUpTasks: async ({ ownerSubject }) => {
      const open = await bot.openTasks({ ownerSubject });
      await mapWithConcurrency({ items: open.map((task) => task.taskId), limit: COMMENT_SCAN_CONCURRENCY, work: acknowledge });
      return open.map((task) => tasks.get(task.taskId) ?? task);
    },
    reply: async ({ ownerSubject, taskId, text }) => {
      const found = tasks.get(taskId);
      if (found === undefined || found.ownerSubject !== ownerSubject) return { kind: "unknown-task" };
      // A session that wrote the prefix itself would otherwise post "Sasha: Sasha: ...".
      const content = (isSashaLine(text) ? text.trimStart().slice(SASHA_PREFIX.trim().length) : text).trim();
      if (content === "") return { kind: "invalid-text", reason: "the reply is empty" };
      if (content.length > MAX_REPLY_CHARACTERS) {
        return { kind: "invalid-text", reason: `the reply is longer than ${String(MAX_REPLY_CHARACTERS)} characters` };
      }
      await acknowledging.get(taskId);
      const task = tasks.get(taskId);
      if (task === undefined) return { kind: "unknown-task" };
      const lookup = await drives.forOwner({ ownerSubject });
      if (lookup.kind !== "ok") return { kind: "drive-failed", reason: "no Google sign-in is stored for this account; reconnect Sasha Slides" };
      const posted = await postAnswer({ drive: lookup.drive, task, content: signed(content) });
      if (posted.kind === "failed") return { kind: "drive-failed", reason: posted.reason };
      const answered: CommentTask = { ...task, state: "answered", botReplyId: posted.value };
      tasks.set(taskId, answered);
      await store.commentTasks.put({ key: taskId, value: answered });
      return { kind: "replied", task: answered };
    },
    handlePush: ({ headers }) => {
      const channelId = headerValue(headers, "x-goog-channel-id");
      const token = headerValue(headers, "x-goog-channel-token");
      const ownerSubject = channelId === null ? undefined : ownerByChannelId.get(channelId);
      const channel = ownerSubject === undefined ? undefined : channels.get(ownerSubject);
      if (ownerSubject === undefined || channel === undefined || channel.channelId !== channelId || token === null || !constantTimeEqual(token, channel.token)) {
        return Promise.resolve({ kind: "ignored" });
      }
      const state = headerValue(headers, "x-goog-resource-state");
      if (state === "sync") return Promise.resolve({ kind: "sync-message" });
      requestSync({ ownerSubject, delayMs: PUSH_DEBOUNCE_MS });
      return Promise.resolve({ kind: "accepted" });
    },
    idle: async () => {
      for (;;) {
        const running = [...syncs.values()].flatMap((state) => (state.running === null ? [] : [state.running]));
        if (running.length === 0) return;
        await Promise.all(running);
      }
    },
    close: () => {
      tickTimer?.cancel();
      tickTimer = null;
      for (const state of syncs.values()) {
        state.timer?.cancel();
        state.timer = null;
      }
    },
  };

  return bot;
}

/** What `watch_comments` says about a watch outcome; the session reads it. */
export function describeWatchOutcome(outcome: WatchOutcome): string {
  switch (outcome.kind) {
    case "watching":
      return (
        `${outcome.renewed ? "still watching" : "watching"} "${outcome.watch.deckTitle}" until ${isoTime(outcome.watch.expiresAtMs)}. ` +
        "Every new comment or reply on it becomes a comment task: check comment_tasks, answer with reply_comment_task " +
        `(posted as the user, starting with "${SASHA_PREFIX.trim()}"), and call stop_watching when done.`
      );
    case "invalid-deck":
      return "deck must be a Google Slides URL (https://docs.google.com/presentation/d/<id>/edit) or a file id";
    case "no-grant":
      return "this account has no Google sign-in stored on Sasha Slides, or it has expired: reconnect the Sasha Slides connector, signing in with Google, then call watch_comments again";
    case "needs-access":
      return (
        `Sasha cannot read this deck's comments yet. Give the user this link: ${outcome.allowUrl} . It opens Google's file picker ` +
        "with this deck; choosing it once lets Sasha read and answer the comments on this one deck, as the user. " +
        "When the user says it is done, call watch_comments again."
      );
    case "cannot-comment":
      return "the user can view this deck but not comment on it: ask its owner for Commenter or Editor access, then call watch_comments again";
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

/** The acknowledgement for a comment, prefix not included: the same variant every time for the same comment. */
export function acknowledgementText(commentId: string): string {
  const index = createHash("sha256").update(commentId).digest()[0] ?? 0;
  return ACKNOWLEDGEMENT_TEXTS[index % ACKNOWLEDGEMENT_TEXTS.length] ?? "On it ⏳";
}

/** Drive's answers for a page token it no longer honours. */
const INVALID_PAGE_TOKEN_STATUSES: readonly number[] = [400, 404, 410];
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

/** One owner's sync bookkeeping. Mutable on purpose: it is the scheduler's own state, never shared. */
type OwnerSyncState = {
  timer: Readonly<{ cancel(): void }> | null;
  running: Promise<void> | null;
  rerun: boolean;
};

function signed(text: string): string {
  return `${SASHA_PREFIX}${text}`;
}

function headerValue(headers: PushHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === "string") return value;
  return value?.[0] ?? null;
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
