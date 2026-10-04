/**
 * The narrow capability the comment feedback channel needs, plus the real googleapis-backed
 * implementation of it.
 *
 * Shaped exactly like `drive-channel.ts`: everything effectful goes through one interface so
 * the whole of `feedback.ts` is testable against an in-memory fake (`test/fake-comments.ts`)
 * with no credentials and no network. Authentication is the single `OAuth2Client` that
 * `google-auth.ts` already produces — there is no second credential path.
 *
 * Two shapes here are forced by what Google actually does, and both are easy to get wrong:
 *
 *  - **Resolving is a reply, not an update.** `drive.comments.update({resolved:true})` is
 *    rejected with *"Comment content is required."* — `Comment.resolved` is output-only. A
 *    thread is resolved by `drive.replies.create` with `action:"resolve"`, which is why
 *    `createReply` takes a `resolve` flag instead of this interface having an `update`.
 *  - **`listComments` returns resolved threads too.** Drive offers no server-side filter for
 *    them (only `includeDeleted` and `startModifiedTime`), so the channel reports `resolved`
 *    per thread and the filtering is the caller's.
 */
import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type FeedbackChannel = Readonly<{
  /**
   * Open and resolved threads, newest first. `startModifiedTime` is Drive's own filter and
   * is **inclusive** (measured: a comment whose `modifiedTime` equals it is returned), so a
   * caller cannot use it alone to mean "since" — see `FeedbackCursor`.
   */
  listComments(
    options: Readonly<{ fileId: string; startModifiedTime: string | null }>,
  ): Promise<readonly CommentThread[]>;

  /** Null when no live comment has that id, which is how an unknown id stays a value. */
  getComment(options: Readonly<{ fileId: string; commentId: string }>): Promise<CommentThread | null>;

  /** Unanchored by construction: Slides renders Drive-API comments as unanchored. */
  createComment(options: Readonly<{ fileId: string; text: string }>): Promise<CommentThread>;

  createReply(
    options: Readonly<{ fileId: string; commentId: string; text: string; resolve: boolean }>,
  ): Promise<CommentReply>;

  deleteComment(options: Readonly<{ fileId: string; commentId: string }>): Promise<void>;

  /** The deck's page object ids in filmstrip order, so a page id becomes "slide 3". */
  listSlidePages(options: Readonly<{ presentationId: string }>): Promise<DeckPages>;
}>;

/** One comment and every reply under it: a Slides comment thread. */
export type CommentThread = Readonly<{
  id: string;
  author: CommentAuthor;
  /** Plain text, as the user typed it. Never rewritten — the agent must see it verbatim. */
  text: string;
  htmlText: string | null;
  createdTime: string;
  /** Bumped when a reply is added (measured), which is what makes it a usable cursor. */
  modifiedTime: string;
  /** Verbatim as Drive stores it; interpreted by `comment-anchor.ts`, never here. */
  anchor: string | null;
  /** The content the comment refers to, when the editor recorded any. */
  quotedText: string | null;
  resolved: boolean;
  deleted: boolean;
  replies: readonly CommentReply[];
}>;

export type CommentReply = Readonly<{
  id: string;
  author: CommentAuthor;
  text: string;
  htmlText: string | null;
  createdTime: string;
  modifiedTime: string;
  deleted: boolean;
  action: ReplyAction;
}>;

/** `resolve` / `reopen` replies change the thread's state and carry no new feedback. */
export type ReplyAction = "none" | "resolve" | "reopen";

export type CommentAuthor = Readonly<{
  displayName: string;
  emailAddress: string | null;
  /** True when the author is the account this server is acting as. */
  isMe: boolean;
}>;

export type DeckPages =
  | Readonly<{ kind: "ok"; pageObjectIds: readonly string[] }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export function googleFeedbackChannel(options: Readonly<{ auth: OAuth2Client }>): FeedbackChannel {
  const drive = google.drive({ version: "v3", auth: options.auth });
  const slides = google.slides({ version: "v1", auth: options.auth });
  return {
    listComments: async ({ fileId, startModifiedTime }) => {
      // Annotated so the overloaded `comments.list` resolves without inferring `response`
      // from an argument that itself mentions the page token (TS7022) — the same shape
      // drive-channel.ts needs for `files.list`.
      const params: drive_v3.Params$Resource$Comments$List = {
        fileId,
        pageSize: LIST_PAGE_SIZE,
        includeDeleted: false,
        fields: `nextPageToken, comments(${COMMENT_FIELDS})`,
        ...(startModifiedTime === null ? {} : { startModifiedTime }),
      };
      const collected: CommentThread[] = [];
      let pageToken: string | null = null;
      // Bounded so a deck with a surprising number of threads cannot turn one tool call
      // into a long scan.
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const listed = await listCommentPage({
          drive,
          params: pageToken === null ? params : { ...params, pageToken },
        });
        collected.push(...listed.comments);
        pageToken = listed.nextPageToken;
        if (pageToken === null) break;
      }
      return collected;
    },

    getComment: async ({ fileId, commentId }) => {
      try {
        const response = await drive.comments.get({ fileId, commentId, fields: COMMENT_FIELDS });
        const narrowed = narrowComment(response.data);
        return narrowed === null || narrowed.deleted ? null : narrowed;
      } catch (cause) {
        // Measured: a comment that has been deleted is a 404 ("Comment not found: <id>"),
        // not a record with `deleted: true`. Only that one status is absence — a 403 or a
        // 500 is a real failure and must not be reported as "no such comment".
        if (isNotFound(cause)) return null;
        throw cause;
      }
    },

    createComment: async ({ fileId, text }) => {
      const response = await drive.comments.create({
        fileId,
        fields: COMMENT_FIELDS,
        requestBody: { content: text },
      });
      return requireComment({ comment: response.data, what: "the comment just created" });
    },

    createReply: async ({ fileId, commentId, text, resolve }) => {
      const response = await drive.replies.create({
        fileId,
        commentId,
        fields: REPLY_FIELDS,
        // `action` is what resolves the thread; Drive still requires `content` alongside it.
        requestBody: { content: text, ...(resolve ? { action: "resolve" } : {}) },
      });
      const narrowed = narrowReply(response.data);
      if (narrowed === null) throw new Error("Drive returned no usable id for the reply just created");
      return narrowed;
    },

    deleteComment: async ({ fileId, commentId }) => {
      await drive.comments.delete({ fileId, commentId });
    },

    listSlidePages: async ({ presentationId }) => {
      try {
        const response = await slides.presentations.get({ presentationId, fields: "slides(objectId)" });
        const pageObjectIds: string[] = [];
        for (const page of response.data.slides ?? []) {
          if (typeof page.objectId === "string") pageObjectIds.push(page.objectId);
        }
        return { kind: "ok", pageObjectIds };
      } catch (cause) {
        // A deck we cannot read costs us the 1-based slide number and nothing else, so this
        // degrades to a value rather than failing the whole read.
        return { kind: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  };
}

/**
 * `fields` is mandatory on every Drive comments call — omitting it is a 400, not a default.
 * `resolved` is absent rather than `false` on an open thread (measured), which is why
 * `narrowComment` compares against `true` instead of coercing.
 */
const COMMENT_FIELDS =
  "id, createdTime, modifiedTime, author(displayName, emailAddress, me), content, htmlContent, " +
  "deleted, resolved, anchor, quotedFileContent(mimeType, value), " +
  `replies(${"id, createdTime, modifiedTime, author(displayName, emailAddress, me), content, htmlContent, deleted, action"})`;

const REPLY_FIELDS =
  "id, createdTime, modifiedTime, author(displayName, emailAddress, me), content, htmlContent, deleted, action";

const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 10;

/** One page of `comments.list`, narrowed. Kept out of the loop for the same TS7022 reason. */
async function listCommentPage(
  options: Readonly<{ drive: drive_v3.Drive; params: drive_v3.Params$Resource$Comments$List }>,
): Promise<Readonly<{ comments: readonly CommentThread[]; nextPageToken: string | null }>> {
  const response = await options.drive.comments.list(options.params);
  const comments: CommentThread[] = [];
  for (const candidate of response.data.comments ?? []) {
    const narrowed = narrowComment(candidate);
    if (narrowed !== null && !narrowed.deleted) comments.push(narrowed);
  }
  return { comments, nextPageToken: response.data.nextPageToken ?? null };
}

function requireComment(options: Readonly<{ comment: drive_v3.Schema$Comment; what: string }>): CommentThread {
  const narrowed = narrowComment(options.comment);
  if (narrowed === null) throw new Error(`Drive returned no usable id/time for ${options.what}`);
  return narrowed;
}

/**
 * Whether a googleapis rejection means "there is no such thing", as opposed to a failure.
 *
 * gaxios carries the HTTP status on the error object but does not export a type guard for
 * it, so this reads the two fields it is known to set rather than casting to `any`.
 */
function isNotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const candidate = cause as Readonly<{ status?: unknown; code?: unknown }>;
  return candidate.status === 404 || candidate.code === 404 || candidate.code === "404";
}

/** Drive's generated types make every field optional; this is the parse boundary for them. */
function narrowComment(comment: drive_v3.Schema$Comment): CommentThread | null {
  const id = comment.id;
  const createdTime = comment.createdTime;
  if (typeof id !== "string" || typeof createdTime !== "string") return null;
  const replies: CommentReply[] = [];
  for (const candidate of comment.replies ?? []) {
    const narrowed = narrowReply(candidate);
    if (narrowed !== null && !narrowed.deleted) replies.push(narrowed);
  }
  return {
    id,
    author: narrowAuthor(comment.author),
    text: comment.content ?? "",
    htmlText: typeof comment.htmlContent === "string" ? comment.htmlContent : null,
    createdTime,
    modifiedTime: typeof comment.modifiedTime === "string" ? comment.modifiedTime : createdTime,
    anchor: typeof comment.anchor === "string" && comment.anchor !== "" ? comment.anchor : null,
    quotedText: narrowQuoted(comment.quotedFileContent),
    resolved: comment.resolved === true,
    deleted: comment.deleted === true,
    replies,
  };
}

function narrowReply(reply: drive_v3.Schema$Reply): CommentReply | null {
  const id = reply.id;
  const createdTime = reply.createdTime;
  if (typeof id !== "string" || typeof createdTime !== "string") return null;
  return {
    id,
    author: narrowAuthor(reply.author),
    text: reply.content ?? "",
    htmlText: typeof reply.htmlContent === "string" ? reply.htmlContent : null,
    createdTime,
    modifiedTime: typeof reply.modifiedTime === "string" ? reply.modifiedTime : createdTime,
    deleted: reply.deleted === true,
    action: narrowAction(reply.action),
  };
}

/** `action` is a bare string on the wire, so this is a parse-boundary guard, not a switch. */
function narrowAction(action: string | null | undefined): ReplyAction {
  if (action === "resolve") return "resolve";
  if (action === "reopen") return "reopen";
  return "none";
}

function narrowAuthor(author: drive_v3.Schema$User | undefined): CommentAuthor {
  return {
    displayName: typeof author?.displayName === "string" ? author.displayName : "unknown",
    emailAddress: typeof author?.emailAddress === "string" ? author.emailAddress : null,
    isMe: author?.me === true,
  };
}

function narrowQuoted(
  quoted: drive_v3.Schema$Comment["quotedFileContent"] | undefined,
): string | null {
  const value = quoted?.value;
  // Slides sets this to "" for a whole-page anchor and to the marked run for a text anchor,
  // so empty is "nothing quoted", not "quoted the empty string".
  return typeof value === "string" && value !== "" ? value : null;
}
