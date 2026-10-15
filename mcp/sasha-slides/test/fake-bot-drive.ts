/**
 * A fake Google for the comment bot, at the HTTP level: it answers the token endpoint and the
 * eight Drive v3 endpoints `comment-bot/bot-drive.ts` calls, from an in-memory change feed and
 * comment threads, and COUNTS every call by endpoint, so a test can state exactly how many
 * requests an event cost.
 */
import type { HttpFetch, HttpFetchInit, HttpFetchResponse } from "../http/identity-providers";
import { SLIDES_MIME_TYPE } from "../comment-bot/bot-drive";
import { GOOGLE_TOKEN_URL } from "../http/gmail-sender";

export type Endpoint =
  | "token"
  | "files.get"
  | "changes.getStartPageToken"
  | "changes.watch"
  | "channels.stop"
  | "changes.list"
  | "comments.list"
  | "replies.create"
  | "replies.update";

export type FakeChannel = Readonly<{ id: string; token: string; address: string; resourceId: string; expiresAtMs: number }>;

type FakeAuthor = Readonly<{ displayName: string; me: boolean }>;
type FakeReply = { id: string; content: string; author: FakeAuthor; createdTime: string; deleted: boolean };
type FakeComment = {
  id: string;
  fileId: string;
  content: string;
  author: FakeAuthor;
  createdTime: string;
  modifiedTime: string;
  anchor: string | null;
  quoted: string | null;
  replies: FakeReply[];
};

export type FakeBotDrive = Readonly<{
  fetch: HttpFetch;
  /** Calls per endpoint since the last `resetCounts`. */
  counts(): Readonly<Record<Endpoint, number>>;
  /** Every call, in order, since the last `resetCounts`. */
  calls(): readonly Readonly<{ endpoint: Endpoint; url: string }>[];
  resetCounts(): void;
  /** A deck the bot can see (shared with it). `canComment: false` is a Viewer share. */
  addDeck(options: Readonly<{ fileId: string; name: string; canComment?: boolean; mimeType?: string }>): void;
  /** Someone comments: a new thread, and a change on the bot's feed. */
  /** `me` marks a comment written by the bot's own account (the stopgap where the bot runs as the user). */
  addComment(options: Readonly<{ fileId: string; author: string; content: string; anchor?: string; quoted?: string; me?: boolean }>): string;
  addReply(options: Readonly<{ fileId: string; commentId: string; author: string; content: string; me?: boolean }>): string;
  /** Someone deletes a reply (the bot's acknowledgement, say): Drive keeps it, marked deleted. */
  deleteReply(options: Readonly<{ commentId: string; replyId: string }>): void;
  /** An edit that is not a comment: just a change on the feed. */
  touch(options: Readonly<{ fileId: string }>): void;
  /** The thread as Drive holds it, bot replies included. */
  thread(options: Readonly<{ commentId: string }>): Readonly<{ replies: readonly FakeReply[] }> | null;
  /** The live (not stopped) channels. */
  channels(): readonly FakeChannel[];
  /** How long Google grants a channel; it may be shorter than asked. */
  setChannelLifetimeMs(milliseconds: number): void;
  /** Makes every page token issued so far invalid (a 410), as an expired token would be. */
  expirePageTokens(): void;
}>;

export function createFakeBotDrive(options: Readonly<{ now: () => Date }>): FakeBotDrive {
  const { now } = options;
  const decks = new Map<string, Readonly<{ name: string; mimeType: string; canComment: boolean }>>();
  const comments = new Map<string, FakeComment>();
  const feed: string[] = [];
  const live = new Map<string, FakeChannel>();
  let epoch = 0;
  let channelLifetimeMs: number | null = null;
  let nextId = 1;
  let log: { endpoint: Endpoint; url: string }[] = [];

  const iso = (): string => now().toISOString();
  const record = (endpoint: Endpoint, url: string): void => {
    log.push({ endpoint, url });
  };

  const fetch: HttpFetch = (url, init) => {
    const response = route(url, init);
    return Promise.resolve(response);
  };

  function route(url: string, init: HttpFetchInit): HttpFetchResponse {
    if (url === GOOGLE_TOKEN_URL) {
      record("token", url);
      return json(200, { access_token: "fake-access-token", expires_in: 3600 });
    }
    assertBearer(init);
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/drive\/v3/, "");
    const body = init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    if (init.method === "GET" && path === "/changes/startPageToken") {
      record("changes.getStartPageToken", url);
      return json(200, { startPageToken: `${String(epoch)}-${String(feed.length)}` });
    }
    if (init.method === "POST" && path === "/changes/watch") {
      record("changes.watch", url);
      const resourceId = `resource-${String(nextId++)}`;
      const asked = Number(body.expiration);
      const expiresAtMs = channelLifetimeMs === null ? asked : Math.min(asked, now().getTime() + channelLifetimeMs);
      live.set(String(body.id), { id: String(body.id), token: String(body.token), address: String(body.address), resourceId, expiresAtMs });
      return json(200, { kind: "api#channel", id: body.id, resourceId, expiration: String(expiresAtMs) });
    }
    if (init.method === "POST" && path === "/channels/stop") {
      record("channels.stop", url);
      const channel = live.get(String(body.id));
      if (channel === undefined || channel.resourceId !== body.resourceId) return json(404, { error: { status: "NOT_FOUND" } });
      live.delete(channel.id);
      return json(204, null);
    }
    if (init.method === "GET" && path === "/changes") {
      record("changes.list", url);
      const [tokenEpoch, tokenIndex] = (parsed.searchParams.get("pageToken") ?? "").split("-").map(Number);
      const token = tokenIndex ?? -1;
      if (tokenEpoch !== epoch || !Number.isInteger(token) || token < 0 || token > feed.length) return json(410, { error: { status: "GONE" } });
      const changes = [...new Set(feed.slice(token))].map((fileId) => {
        const deck = decks.get(fileId);
        return { fileId, file: { name: deck?.name ?? "a file", mimeType: deck?.mimeType ?? "application/pdf" } };
      });
      return json(200, { changes, newStartPageToken: `${String(epoch)}-${String(feed.length)}` });
    }
    const updateMatch = /^\/files\/([^/]+)\/comments\/([^/]+)\/replies\/([^/]+)$/.exec(path);
    if (init.method === "PATCH" && updateMatch !== null) {
      record("replies.update", url);
      const comment = comments.get(decodeURIComponent(updateMatch[2] ?? ""));
      const reply = comment?.replies.find((candidate) => candidate.id === decodeURIComponent(updateMatch[3] ?? ""));
      // Drive lets only a reply's author change it, and a deleted reply is gone for good.
      if (comment === undefined || reply === undefined || reply.deleted) return json(404, { error: { status: "NOT_FOUND" } });
      if (!reply.author.me) return json(403, { error: { status: "PERMISSION_DENIED" } });
      reply.content = String(body.content);
      comment.modifiedTime = iso();
      feed.push(comment.fileId);
      return json(200, { id: reply.id });
    }
    const replyMatch = /^\/files\/([^/]+)\/comments\/([^/]+)\/replies$/.exec(path);
    if (init.method === "POST" && replyMatch !== null) {
      record("replies.create", url);
      const comment = comments.get(decodeURIComponent(replyMatch[2] ?? ""));
      if (comment === undefined) return json(404, { error: { status: "NOT_FOUND" } });
      const id = pushReply({ comment, author: { displayName: "Sasha", me: true }, content: String(body.content) });
      return json(200, { id });
    }
    const commentsMatch = /^\/files\/([^/]+)\/comments$/.exec(path);
    if (init.method === "GET" && commentsMatch !== null) {
      record("comments.list", url);
      const fileId = decodeURIComponent(commentsMatch[1] ?? "");
      if (!decks.has(fileId)) return json(404, { error: { status: "NOT_FOUND" } });
      if (parsed.searchParams.get("fields") === null) return json(400, { error: { status: "INVALID_ARGUMENT" } });
      const after = parsed.searchParams.get("startModifiedTime") ?? "";
      const listed = [...comments.values()]
        .filter((comment) => comment.fileId === fileId && comment.modifiedTime >= after)
        .map((comment) => ({
          id: comment.id,
          content: comment.content,
          author: comment.author,
          createdTime: comment.createdTime,
          modifiedTime: comment.modifiedTime,
          deleted: false,
          ...(comment.anchor === null ? {} : { anchor: comment.anchor }),
          ...(comment.quoted === null ? {} : { quotedFileContent: { mimeType: "text/plain", value: comment.quoted } }),
          replies: comment.replies.map((reply) => ({ ...reply })),
        }));
      return json(200, { comments: listed });
    }
    const fileMatch = /^\/files\/([^/]+)$/.exec(path);
    if (init.method === "GET" && fileMatch !== null) {
      record("files.get", url);
      const fileId = decodeURIComponent(fileMatch[1] ?? "");
      const deck = decks.get(fileId);
      if (deck === undefined) return json(404, { error: { status: "NOT_FOUND" } });
      return json(200, { id: fileId, name: deck.name, mimeType: deck.mimeType, trashed: false, capabilities: { canComment: deck.canComment } });
    }
    throw new Error(`fake bot drive: no route for ${init.method} ${url}`);
  }

  function pushReply(options: Readonly<{ comment: FakeComment; author: FakeAuthor; content: string }>): string {
    const id = `r${String(nextId++)}`;
    options.comment.replies.push({ id, content: options.content, author: options.author, createdTime: iso(), deleted: false });
    options.comment.modifiedTime = iso();
    feed.push(options.comment.fileId);
    return id;
  }

  const empty = (): Record<Endpoint, number> => ({
    token: 0,
    "files.get": 0,
    "changes.getStartPageToken": 0,
    "changes.watch": 0,
    "channels.stop": 0,
    "changes.list": 0,
    "comments.list": 0,
    "replies.create": 0,
    "replies.update": 0,
  });

  return {
    fetch,
    counts: () => {
      const counts = empty();
      for (const call of log) counts[call.endpoint] += 1;
      return counts;
    },
    calls: () => [...log],
    resetCounts: () => {
      log = [];
    },
    addDeck: ({ fileId, name, canComment, mimeType }) => {
      decks.set(fileId, { name, mimeType: mimeType ?? SLIDES_MIME_TYPE, canComment: canComment ?? true });
    },
    addComment: ({ fileId, author, content, anchor, quoted, me = false }) => {
      const id = `c${String(nextId++)}`;
      comments.set(id, {
        id,
        fileId,
        content,
        author: { displayName: author, me },
        createdTime: iso(),
        modifiedTime: iso(),
        anchor: anchor ?? null,
        quoted: quoted ?? null,
        replies: [],
      });
      feed.push(fileId);
      return id;
    },
    addReply: ({ commentId, author, content, me = false }) => {
      const comment = comments.get(commentId);
      if (comment === undefined) throw new Error(`no comment ${commentId}`);
      return pushReply({ comment, author: { displayName: author, me }, content });
    },
    deleteReply: ({ commentId, replyId }) => {
      const comment = comments.get(commentId);
      const reply = comment?.replies.find((candidate) => candidate.id === replyId);
      if (comment === undefined || reply === undefined) throw new Error(`no reply ${replyId} in ${commentId}`);
      reply.deleted = true;
      reply.content = "";
      comment.modifiedTime = iso();
      feed.push(comment.fileId);
    },
    touch: ({ fileId }) => {
      feed.push(fileId);
    },
    thread: ({ commentId }) => {
      const comment = comments.get(commentId);
      return comment === undefined ? null : { replies: [...comment.replies] };
    },
    channels: () => [...live.values()],
    setChannelLifetimeMs: (milliseconds) => {
      channelLifetimeMs = milliseconds;
    },
    expirePageTokens: () => {
      epoch += 1;
    },
  };
}

function assertBearer(init: HttpFetchInit): void {
  if (init.headers.authorization !== "Bearer fake-access-token") throw new Error("fake bot drive: call without the bot's access token");
}

function json(status: number, body: unknown): HttpFetchResponse {
  return { status, json: () => Promise.resolve(body) };
}
