/**
 * An in-memory `FeedbackChannel` plus a call recorder, so the whole comment feedback channel
 * can be tested with no credentials and no network.
 *
 * It reproduces the three behaviours of real Drive that the production code is shaped around,
 * each of which was measured against the live deck (see `e2e/feedback-live.ts`):
 *
 *  - `startModifiedTime` is **inclusive**: a thread whose `modifiedTime` equals the filter is
 *    returned. A fake that treated it as exclusive would hide the exact bug `newPostsSince`
 *    exists to prevent.
 *  - adding a reply **bumps the parent comment's `modifiedTime`** to the reply's time.
 *  - `resolved` is reached only through a reply with `action: "resolve"`, and the list call
 *    keeps returning resolved threads afterwards.
 *  - **threads belong to ONE file.** `comments.list` and `comments.get` are per `fileId`, and
 *    a `get` with the wrong file is a 404. That matters now that comments live on `NN.html`:
 *    a fake that ignored `fileId` would report every candidate's threads on every candidate
 *    and would let a reply addressed to the wrong `slideIndex` succeed.
 */
import type {
  CommentReply,
  CommentThread,
  DeckPages,
  FeedbackChannel,
} from "../feedback/feedback-channel";

export type FakeComments = Readonly<{
  channel: FeedbackChannel;
  /** Ordered transcript of every channel operation. */
  calls: () => readonly RecordedCall[];
  threads: () => readonly CommentThread[];
  /**
   * Simulates the USER commenting in Google Slides — including the anchor Slides writes,
   * which is the one thing our own `createComment` can never produce.
   */
  putUserComment: (
    options: Readonly<{
      text: string;
      anchor: string | null;
      /** Which file the user commented on. Defaults to the environment's `defaultFileId`. */
      fileId?: string;
      quotedText?: string | null;
      author?: string;
    }>,
  ) => CommentThread;
  /** Simulates the user answering the agent in their own thread. */
  putUserReply: (options: Readonly<{ commentId: string; text: string; author?: string }>) => CommentReply;
  setDeckPages: (options: Readonly<{ pages: DeckPages }>) => void;
}>;

export type RecordedCall = Readonly<{ op: RecordedOperation; detail: string }>;

export type RecordedOperation =
  | "listComments"
  | "getComment"
  | "createComment"
  | "createReply"
  | "deleteComment"
  | "listSlidePages";

export const FAKE_OWNER = "Ante M";

/**
 * `now` is INJECTED rather than kept here, and that is not incidental: when the fake held
 * its own clock, the harness's clock and the fake's drifted apart and a reply written "now"
 * landed before a cursor taken "now". One clock, passed in, makes that unrepresentable.
 */
export function createFakeComments(
  options: Readonly<{
    now: () => Date;
    pageObjectIds: readonly string[];
    /** The file `putUserComment` attaches to when a test does not name one. */
    defaultFileId: string;
  }>,
): FakeComments {
  const stored: MutableThread[] = [];
  const calls: RecordedCall[] = [];
  let nextId = 1;
  let deckPages: DeckPages = { kind: "ok", pageObjectIds: options.pageObjectIds };

  const stamp = (): string => options.now().toISOString();
  const mintId = (prefix: string): string => {
    const id = `${prefix}${String(nextId).padStart(3, "0")}`;
    nextId += 1;
    return id;
  };
  const find = (commentId: string): MutableThread | null =>
    stored.find((thread) => thread.id === commentId) ?? null;

  return {
    channel: {
      listComments: ({ fileId, startModifiedTime }) => {
        calls.push({ op: "listComments", detail: `${fileId} since=${startModifiedTime ?? "<none>"}` });
        const sinceMs = startModifiedTime === null ? null : Date.parse(startModifiedTime);
        const matching = stored.filter((thread) => {
          if (thread.deleted) return false;
          if (thread.fileId !== fileId) return false;
          // Inclusive, exactly as Drive behaves.
          return sinceMs === null || Date.parse(thread.modifiedTime) >= sinceMs;
        });
        // Drive returns newest first.
        const ordered = [...matching].sort(
          (left, right) => Date.parse(right.modifiedTime) - Date.parse(left.modifiedTime),
        );
        return Promise.resolve(ordered.map(freeze));
      },

      getComment: ({ fileId, commentId }) => {
        calls.push({ op: "getComment", detail: `${fileId}/${commentId}` });
        const thread = find(commentId);
        // Drive 404s a get whose fileId does not hold that comment, which is what makes a
        // reply addressed to the wrong candidate an `unknown-comment` rather than a success.
        if (thread !== null && thread.fileId !== fileId) return Promise.resolve(null);
        return Promise.resolve(thread === null || thread.deleted ? null : freeze(thread));
      },

      createComment: ({ fileId, text }) => {
        calls.push({ op: "createComment", detail: `${fileId}: ${text}` });
        const thread: MutableThread = {
          id: mintId("c"),
          fileId,
          author: { displayName: FAKE_OWNER, emailAddress: "ante.materija@gmail.com", isMe: true },
          text,
          htmlText: text,
          createdTime: stamp(),
          modifiedTime: stamp(),
          // The whole point: a comment created through the Drive API is unanchored.
          anchor: null,
          quotedText: null,
          resolved: false,
          deleted: false,
          replies: [],
        };
        stored.push(thread);
        return Promise.resolve(freeze(thread));
      },

      createReply: ({ fileId, commentId, text, resolve }) => {
        calls.push({ op: "createReply", detail: `${fileId}/${commentId} resolve=${String(resolve)}` });
        const thread = find(commentId);
        if (thread === null || thread.deleted || thread.fileId !== fileId) {
          return Promise.reject(new Error(`fake Drive: no comment ${commentId} on ${fileId}`));
        }
        const reply: CommentReply = {
          id: mintId("r"),
          author: { displayName: FAKE_OWNER, emailAddress: "ante.materija@gmail.com", isMe: true },
          text,
          htmlText: text,
          createdTime: stamp(),
          modifiedTime: stamp(),
          deleted: false,
          action: resolve ? "resolve" : "none",
        };
        thread.replies.push(reply);
        // A reply bumps the parent, which is what makes one cursor cover both.
        thread.modifiedTime = reply.modifiedTime;
        if (resolve) thread.resolved = true;
        return Promise.resolve(reply);
      },

      deleteComment: ({ fileId, commentId }) => {
        calls.push({ op: "deleteComment", detail: `${fileId}/${commentId}` });
        const thread = find(commentId);
        if (thread === null) return Promise.reject(new Error(`fake Drive: no comment ${commentId}`));
        thread.deleted = true;
        return Promise.resolve();
      },

      listSlidePages: ({ presentationId }) => {
        calls.push({ op: "listSlidePages", detail: presentationId });
        return Promise.resolve(deckPages);
      },
    },

    calls: () => [...calls],
    threads: () => stored.filter((thread) => !thread.deleted).map(freeze),

    putUserComment: ({ text, anchor, fileId, quotedText, author }) => {
      const thread: MutableThread = {
        id: mintId("u"),
        fileId: fileId ?? options.defaultFileId,
        author: {
          displayName: author ?? FAKE_OWNER,
          emailAddress: "ante.materija@gmail.com",
          // True for the user too: this server acts AS the user, so identity cannot tell
          // the user's comments from the agent's replies.
          isMe: true,
        },
        text,
        htmlText: text,
        createdTime: stamp(),
        modifiedTime: stamp(),
        anchor,
        quotedText: quotedText ?? null,
        resolved: false,
        deleted: false,
        replies: [],
      };
      stored.push(thread);
      return freeze(thread);
    },

    putUserReply: ({ commentId, text, author }) => {
      const thread = find(commentId);
      if (thread === null) throw new Error(`fake Drive: no comment ${commentId}`);
      const reply: CommentReply = {
        id: mintId("ur"),
        author: {
          displayName: author ?? FAKE_OWNER,
          emailAddress: "ante.materija@gmail.com",
          isMe: true,
        },
        text,
        htmlText: text,
        createdTime: stamp(),
        modifiedTime: stamp(),
        deleted: false,
        action: "none",
      };
      thread.replies.push(reply);
      thread.modifiedTime = reply.modifiedTime;
      return reply;
    },

    setDeckPages: ({ pages }) => {
      deckPages = pages;
    },
  };
}

/** The fake's own storage: the one place in these files that is deliberately mutable. */
type MutableThread = {
  readonly id: string;
  readonly fileId: string;
  readonly author: CommentThread["author"];
  text: string;
  htmlText: string | null;
  readonly createdTime: string;
  modifiedTime: string;
  anchor: string | null;
  quotedText: string | null;
  resolved: boolean;
  deleted: boolean;
  readonly replies: CommentReply[];
};

function freeze(thread: MutableThread): CommentThread {
  return {
    id: thread.id,
    author: thread.author,
    text: thread.text,
    htmlText: thread.htmlText,
    createdTime: thread.createdTime,
    modifiedTime: thread.modifiedTime,
    anchor: thread.anchor,
    quotedText: thread.quotedText,
    resolved: thread.resolved,
    deleted: thread.deleted,
    replies: [...thread.replies],
  };
}
