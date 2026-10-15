/**
 * The comment bot's tools on the connector, for the signed-in user's own Claude session:
 *
 *   watch_comments { deck }            start (or renew) a watch; returns its watchId
 *   stop_watching { watchId }          end it; the caller's last one ending stops their Drive channel
 *   list_watches {}                    the caller's active watches
 *   comment_tasks {}                   the caller's open comment tasks; picking one up posts
 *                                      Sasha's "On it ⏳" acknowledgement into its thread
 *   reply_comment_task { taskId, text } the answer, replacing that acknowledgement
 *
 * The caller is the Google identity the connector's bearer token names (`googleSubjectOf`):
 * a session sees, stops and answers only its own watches and tasks, and every Drive call is
 * made with that same person's Google grant, so Sasha's lines appear as them, starting with
 * "Sasha: " (`comment-bot.ts`). On stdio the tools are still listed and answer why they cannot
 * work.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assertNever } from "../google-auth";
import { googleSubjectOf } from "../http/authorization-server";
import { describeWatchOutcome, MAX_REPLY_CHARACTERS, type CommentBot, type ReplyOutcome } from "./comment-bot";
import type { CommentTask, CommentWatch } from "./comment-records";

export const COMMENT_TOOL_NAMES = ["watch_comments", "stop_watching", "list_watches", "comment_tasks", "reply_comment_task"] as const;

/** One comment task as the session sees it. */
export type CommentTaskPayload = Readonly<{
  taskId: string;
  deck: string;
  deckUrl: string;
  /** Opens the deck with this comment thread selected. */
  commentUrl: string;
  author: string;
  text: string;
  /** The thread's opening comment, when this task is a reply in it. */
  inReplyTo: string | null;
  /** The deck text the comment is attached to, when Drive reports one. */
  quotedText: string | null;
  /** Drive's raw anchor (Slides writes JSON naming the page and shape); null when unanchored. */
  anchor: string | null;
  createdTime: string;
}>;

export type WatchPayload = Readonly<{ watchId: string; deck: string; deckUrl: string; startedAt: string; expiresAt: string }>;

export function registerCommentTools(options: Readonly<{ server: McpServer; commentBot: CommentBot | null }>): void {
  const { server, commentBot } = options;

  server.registerTool(
    "watch_comments",
    {
      title: "Watch a deck's comments",
      description:
        "Start watching every comment on one of the user's Google Slides decks. Sasha reads and answers the comments " +
        "as the user, with the Google sign-in they connected Sasha Slides with. The first time for a deck, this answers " +
        "with a link instead: give it to the user (they choose the deck once in Google's file picker), then call this " +
        "again when they say it is done. While the watch lasts (24 hours, renewed by calling this again), every new " +
        "comment or reply on the deck becomes a comment task for THIS session: read them with comment_tasks, answer " +
        "with reply_comment_task, and call stop_watching when the user is done. Returns the watchId.",
      inputSchema: { deck: z.string().min(1).describe("The deck's URL (https://docs.google.com/presentation/d/<id>/edit) or its file id.") },
    },
    async ({ deck }, extra) =>
      withCaller({ commentBot, authInfo: extra.authInfo }, async (bot, ownerSubject) => {
        const outcome = await bot.watch({ ownerSubject, deck });
        if (outcome.kind !== "watching") return errorResult(describeWatchOutcome(outcome));
        return jsonResult({ status: outcome.renewed ? "renewed" : "watching", ...watchPayload(outcome.watch), note: describeWatchOutcome(outcome) });
      }),
  );

  server.registerTool(
    "stop_watching",
    {
      title: "Stop watching a deck",
      description: "End a watch started by watch_comments. Its unanswered comment tasks are dropped. Call it when the user is done.",
      inputSchema: { watchId: z.string().min(1).describe("The watchId watch_comments or list_watches returned.") },
    },
    async ({ watchId }, extra) =>
      withCaller({ commentBot, authInfo: extra.authInfo }, async (bot, ownerSubject) => {
        const outcome = await bot.stopWatching({ ownerSubject, watchId });
        switch (outcome.kind) {
          case "stopped":
            return jsonResult({ status: "stopped", ...watchPayload(outcome.watch) });
          case "unknown-watch":
            return errorResult(`no active watch ${watchId} for this account (it may have expired); list_watches shows the active ones`);
          default:
            return assertNever(outcome);
        }
      }),
  );

  server.registerTool(
    "list_watches",
    {
      title: "List active comment watches",
      description: "The decks this account is watching for comments, with each watchId and when it expires.",
      inputSchema: {},
    },
    async (_arguments, extra) =>
      withCaller({ commentBot, authInfo: extra.authInfo }, async (bot, ownerSubject) => {
        const watches = await bot.listWatches({ ownerSubject });
        return jsonResult({ count: watches.length, watches: watches.map(watchPayload) });
      }),
  );

  server.registerTool(
    "comment_tasks",
    {
      title: "Comments waiting for an answer",
      description:
        "The open comment tasks on the decks this account watches: who wrote what, on which deck, the thread it " +
        "belongs to and the text it is attached to. The first time a task is listed here, Sasha automatically " +
        "posts a short acknowledgement in its thread (\"Sasha: On it ⏳\"), so the commenter sees work has started; do not " +
        "post one yourself. Answer each with reply_comment_task, which replaces that acknowledgement with your " +
        "answer. Empty means nothing is waiting.",
      inputSchema: {},
    },
    async (_arguments, extra) =>
      withCaller({ commentBot, authInfo: extra.authInfo }, async (bot, ownerSubject) => {
        const tasks = await bot.pickUpTasks({ ownerSubject });
        return jsonResult({ count: tasks.length, tasks: tasks.map(commentTaskPayload) });
      }),
  );

  server.registerTool(
    "reply_comment_task",
    {
      title: "Answer a comment",
      description:
        "Answer a comment task in its thread and mark the task answered. It is posted as the user, starting with " +
        "\"Sasha: \" (added for you; do not write it yourself), and replaces the \"On it ⏳\" acknowledgement " +
        "comment_tasks posted, so the thread reads as the question and then this answer (a new reply only if that " +
        "acknowledgement is gone). Plain text; https links are fine (for example to the deck, or to a proposal page).",
      inputSchema: {
        taskId: z.string().min(1).describe("The taskId from comment_tasks."),
        text: z.string().min(1).max(MAX_REPLY_CHARACTERS).describe("The reply, as the user should read it in the thread."),
      },
    },
    async ({ taskId, text }, extra) =>
      withCaller({ commentBot, authInfo: extra.authInfo }, async (bot, ownerSubject) =>
        replyResult(await bot.reply({ ownerSubject, taskId, text })),
      ),
  );
}

/** What `open_work` adds: the caller's open comment tasks, or nothing on stdio. */
export async function openCommentTasks(
  options: Readonly<{ commentBot: CommentBot | null; authInfo: AuthInfo | undefined }>,
): Promise<readonly CommentTaskPayload[]> {
  const ownerSubject = googleSubjectOf({ authInfo: options.authInfo });
  if (options.commentBot === null || ownerSubject === null) return [];
  return (await options.commentBot.openTasks({ ownerSubject })).map(commentTaskPayload);
}

export function commentTaskPayload(task: CommentTask): CommentTaskPayload {
  const deckUrl = deckUrlOf(task.fileId);
  return {
    taskId: task.taskId,
    deck: task.deckTitle,
    deckUrl,
    commentUrl: `${deckUrl}?disco=${encodeURIComponent(task.commentId)}`,
    author: task.authorName,
    text: task.text,
    inReplyTo: task.threadText,
    quotedText: task.quotedText,
    anchor: task.anchor,
    createdTime: task.createdTime,
  };
}

function watchPayload(watch: CommentWatch): WatchPayload {
  return {
    watchId: watch.watchId,
    deck: watch.deckTitle,
    deckUrl: deckUrlOf(watch.fileId),
    startedAt: new Date(watch.startedAtMs).toISOString(),
    expiresAt: new Date(watch.expiresAtMs).toISOString(),
  };
}

function replyResult(outcome: ReplyOutcome): CallToolResult {
  switch (outcome.kind) {
    case "replied":
      return jsonResult({ status: "replied", taskId: outcome.task.taskId, deck: outcome.task.deckTitle, commentUrl: commentTaskPayload(outcome.task).commentUrl });
    case "unknown-task":
      return errorResult("no such comment task for this account; comment_tasks lists the open ones");
    case "invalid-text":
      return errorResult(outcome.reason);
    case "drive-failed":
      return errorResult(`the reply was not posted: ${outcome.reason}`);
    default:
      return assertNever(outcome);
  }
}

async function withCaller(
  options: Readonly<{ commentBot: CommentBot | null; authInfo: AuthInfo | undefined }>,
  work: (bot: CommentBot, ownerSubject: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (options.commentBot === null) {
    return errorResult("comment watches need the remote Sasha Slides connector (https://sashaslides.com/mcp); this local server cannot watch comments");
  }
  const ownerSubject = googleSubjectOf({ authInfo: options.authInfo });
  if (ownerSubject === null) return errorResult("comment watches need the signed-in remote connector; this session has no Google identity");
  return work(options.commentBot, ownerSubject);
}

function deckUrlOf(fileId: string): string {
  return `https://docs.google.com/presentation/d/${encodeURIComponent(fileId)}/edit`;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
