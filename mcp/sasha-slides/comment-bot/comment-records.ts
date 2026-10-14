/**
 * What the comment bot remembers, as plain records, and the parse boundary for each when it
 * is read back from the `--store` file (`oauth-store.ts` holds them beside the account data).
 *
 * Four collections:
 *
 *  - `commentBotChannel`: at most one record (key `CHANNEL_KEY`), the bot account's ONE
 *    Drive `changes.watch` channel and the change-feed page token. Absent whenever no watch
 *    is active, so an idle bot holds no channel and makes no calls.
 *  - `commentWatches`: one per `watch_comments` call, keyed by `watchId`.
 *  - `commentFileCursors`: per watched deck, the newest comment `modifiedTime` already
 *    scanned, so a scan asks Drive only for what changed since (`startModifiedTime`).
 *  - `commentTasks`: one per comment or reply a watch turned into work, keyed by `taskId`, a
 *    hash of (watchId, commentId, replyId), which is what makes a re-scan, a duplicate push
 *    or a restart unable to create the same task twice. A task also remembers the bot's
 *    "On it ⏳" acknowledgement, so neither a second `comment_tasks` nor a restart posts it
 *    again, and the answer can replace it in place.
 *
 * Comment text is stored as Drive returned it, unsealed: it is readable by everyone the deck
 * is shared with, and the bot has to quote it back to the watch owner's session.
 */
import { asNumber, asRecord, asString } from "../http/json-values";
import type { JsonCodec } from "../http/oauth-store";

/** The one key of the `commentBotChannel` collection. */
export const CHANNEL_KEY = "channel";

export type BotChannel = Readonly<{
  /** Our id for the channel; Google echoes it as `X-Goog-Channel-ID`. */
  channelId: string;
  /** Google's id for the watched resource; `channels.stop` needs it. */
  resourceId: string;
  /** Random per channel; Google echoes it as `X-Goog-Channel-Token`. A secret. */
  token: string;
  expiresAtMs: number;
  /** Where the next `changes.list` starts. */
  pageToken: string;
}>;

export type CommentWatch = Readonly<{
  watchId: string;
  /** The Google `sub` of the connector session that started the watch: the tasks' owner. */
  ownerSubject: string;
  fileId: string;
  deckTitle: string;
  startedAtMs: number;
  expiresAtMs: number;
}>;

export type FileCursor = Readonly<{
  /** RFC 3339; the next `comments.list` passes it as `startModifiedTime`. */
  modifiedAfter: string;
}>;

export type CommentTask = Readonly<{
  taskId: string;
  watchId: string;
  ownerSubject: string;
  fileId: string;
  deckTitle: string;
  commentId: string;
  /** Null when the task is the thread's opening comment. */
  replyId: string | null;
  authorName: string;
  text: string;
  /** The thread's opening comment, when the task is a reply in it; context for the session. */
  threadText: string | null;
  /** The deck text the comment is attached to, when Drive reports one. */
  quotedText: string | null;
  /** Drive's raw `anchor` string (Slides writes JSON naming the page); null when unanchored. */
  anchor: string | null;
  createdTime: string;
  state: "open" | "answered";
  /** Drive's id of the bot's latest reply to this task; null until answered. */
  botReplyId: string | null;
  acknowledgement: Acknowledgement;
}>;

/**
 * The short reply the bot posts in the thread when the session first picks the task up.
 * `failed` is not retried: the answer then simply arrives as a new reply.
 */
export type Acknowledgement =
  | Readonly<{ kind: "not-posted" }>
  | Readonly<{ kind: "posted"; replyId: string }>
  | Readonly<{ kind: "failed" }>;

export const botChannelCodec: JsonCodec<BotChannel> = {
  encode: (value) => value,
  decode: (value) => {
    const record = asRecord(value);
    if (record === null) return null;
    const channelId = asString(record["channelId"]);
    const resourceId = asString(record["resourceId"]);
    const token = asString(record["token"]);
    const expiresAtMs = asNumber(record["expiresAtMs"]);
    const pageToken = asString(record["pageToken"]);
    if (channelId === null || resourceId === null || token === null || expiresAtMs === null || pageToken === null) return null;
    return { channelId, resourceId, token, expiresAtMs, pageToken };
  },
};

export const commentWatchCodec: JsonCodec<CommentWatch> = {
  encode: (value) => value,
  decode: (value) => {
    const record = asRecord(value);
    if (record === null) return null;
    const watchId = asString(record["watchId"]);
    const ownerSubject = asString(record["ownerSubject"]);
    const fileId = asString(record["fileId"]);
    const deckTitle = asString(record["deckTitle"]);
    const startedAtMs = asNumber(record["startedAtMs"]);
    const expiresAtMs = asNumber(record["expiresAtMs"]);
    if (watchId === null || ownerSubject === null || fileId === null || deckTitle === null || startedAtMs === null || expiresAtMs === null) {
      return null;
    }
    return { watchId, ownerSubject, fileId, deckTitle, startedAtMs, expiresAtMs };
  },
};

export const fileCursorCodec: JsonCodec<FileCursor> = {
  encode: (value) => value,
  decode: (value) => {
    const modifiedAfter = asString(asRecord(value)?.["modifiedAfter"]);
    return modifiedAfter === null ? null : { modifiedAfter };
  },
};

export const commentTaskCodec: JsonCodec<CommentTask> = {
  encode: (value) => value,
  decode: (value) => {
    const record = asRecord(value);
    if (record === null) return null;
    const taskId = asString(record["taskId"]);
    const watchId = asString(record["watchId"]);
    const ownerSubject = asString(record["ownerSubject"]);
    const fileId = asString(record["fileId"]);
    const deckTitle = asString(record["deckTitle"]);
    const commentId = asString(record["commentId"]);
    const authorName = asString(record["authorName"]);
    const text = asString(record["text"]);
    const createdTime = asString(record["createdTime"]);
    const state = record["state"] === "open" || record["state"] === "answered" ? record["state"] : null;
    if (
      taskId === null ||
      watchId === null ||
      ownerSubject === null ||
      fileId === null ||
      deckTitle === null ||
      commentId === null ||
      authorName === null ||
      text === null ||
      createdTime === null ||
      state === null
    ) {
      return null;
    }
    return {
      taskId,
      watchId,
      ownerSubject,
      fileId,
      deckTitle,
      commentId,
      replyId: asString(record["replyId"]),
      authorName,
      text,
      threadText: asString(record["threadText"]),
      quotedText: asString(record["quotedText"]),
      anchor: asString(record["anchor"]),
      createdTime,
      state,
      botReplyId: asString(record["botReplyId"]),
      acknowledgement: decodeAcknowledgement(record["acknowledgement"]),
    };
  },
};

/** A task stored before acknowledgements existed has none: `not-posted`. */
function decodeAcknowledgement(value: unknown): Acknowledgement {
  const record = asRecord(value);
  if (record?.["kind"] === "failed") return { kind: "failed" };
  const replyId = asString(record?.["replyId"]);
  if (record?.["kind"] === "posted" && replyId !== null) return { kind: "posted", replyId };
  return { kind: "not-posted" };
}
