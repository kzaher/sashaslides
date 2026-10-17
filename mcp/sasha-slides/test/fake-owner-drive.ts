/**
 * A fake Google for the comment bot, at the HTTP level, with PER-USER GRANTS: it answers the
 * token endpoint and the eight Drive v3 endpoints `comment-bot/owner-drive.ts` calls, and works
 * out WHO is calling from the bearer token, so a test can prove whose grant each call used.
 *
 * Access is modelled the way `drive.file` works: a user reaches a deck only when the deck is
 * shared with them AND they chose it in the picker (`pick`); anything else is a 404, which is
 * what Drive answers for a file the caller cannot see. `author.me` is computed per caller. Each
 * user has their own change feed (the changes to files they can reach) and channels belong to
 * the user who opened them.
 *
 * Every call is COUNTED by endpoint and recorded with its caller.
 */
import type { HttpFetch, HttpFetchInit, HttpFetchResponse } from "../http/http-kit";
import { SLIDES_MIME_TYPE } from "../comment-bot/owner-drive";
import { DRIVE_FILE_SCOPE, GOOGLE_TOKEN_ENDPOINT, SLIDES_SCOPE } from "../google-constants";
import type { GoogleIdentity } from "../http/oauth-store";

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

/** One recorded call: the endpoint and the Google subject whose token it carried. */
export type FakeCall = Readonly<{ endpoint: Endpoint; caller: string; url: string }>;

export type FakeChannel = Readonly<{ id: string; owner: string; token: string; address: string; resourceId: string; expiresAtMs: number }>;

type Role = "commenter" | "viewer";
type FakeAuthor = Readonly<{ subject: string; displayName: string }>;
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
type FakeDeck = { name: string; mimeType: string; shares: Map<string, Role>; picked: Set<string> };

export type FakeOwnerDrive = Readonly<{
  fetch: HttpFetch;
  /** Calls per endpoint since the last `resetCounts`. */
  counts(): Readonly<Record<Endpoint, number>>;
  /** Every call, in order, with its caller, since the last `resetCounts`. */
  calls(): readonly FakeCall[];
  resetCounts(): void;
  /** A Sasha user: their refresh token works at the token endpoint, and `grant` is what the connector stored at sign-in. */
  addUser(options: Readonly<{ subject: string; name: string; scopes?: readonly string[] }>): GoogleIdentity;
  /** A deck, shared with these users. Nobody has picked it yet. */
  addDeck(options: Readonly<{ fileId: string; name: string; sharedWith: Readonly<Record<string, Role>>; mimeType?: string }>): void;
  /** The user chose the deck in the Google Picker: their `drive.file` grant now reaches it. */
  pick(options: Readonly<{ subject: string; fileId: string }>): void;
  /** A comment by a user (their subject) or by someone outside Sasha (any name): a new thread and a change. */
  addComment(options: Readonly<{ fileId: string; by: string; content: string; anchor?: string; quoted?: string }>): string;
  addReply(options: Readonly<{ fileId: string; commentId: string; by: string; content: string }>): string;
  /** Someone deletes a reply (Sasha's acknowledgement, say): Drive keeps it, marked deleted. */
  deleteReply(options: Readonly<{ commentId: string; replyId: string }>): void;
  /** An edit that is not a comment: just a change on the feed. */
  touch(options: Readonly<{ fileId: string }>): void;
  /** The thread as Drive holds it. `author` is the writer's subject (or outside name). */
  thread(options: Readonly<{ commentId: string }>): Readonly<{ replies: readonly Readonly<{ id: string; content: string; author: string; deleted: boolean }>[] }> | null;
  /** The live (not stopped) channels. */
  channels(): readonly FakeChannel[];
  /** How long Google grants a channel; it may be shorter than asked. */
  setChannelLifetimeMs(milliseconds: number): void;
  /** Makes every page token issued so far invalid (a 410), as an expired token would be. */
  expirePageTokens(): void;
}>;

export function createFakeOwnerDrive(options: Readonly<{ now: () => Date }>): FakeOwnerDrive {
  const { now } = options;
  const users = new Map<string, Readonly<{ name: string }>>();
  const decks = new Map<string, FakeDeck>();
  const comments = new Map<string, FakeComment>();
  const feed: string[] = [];
  const live = new Map<string, FakeChannel>();
  let epoch = 0;
  let channelLifetimeMs: number | null = null;
  let nextId = 1;
  let log: FakeCall[] = [];

  const iso = (): string => now().toISOString();
  const record = (endpoint: Endpoint, caller: string, url: string): void => {
    log.push({ endpoint, caller, url });
  };
  const reaches = (subject: string, fileId: string): boolean => {
    const deck = decks.get(fileId);
    return deck !== undefined && deck.shares.has(subject) && deck.picked.has(subject);
  };
  const authorFor = (by: string): FakeAuthor => ({ subject: by, displayName: users.get(by)?.name ?? by });

  const fetch: HttpFetch = (url, init) => Promise.resolve(route(url, init));

  function route(url: string, init: HttpFetchInit): HttpFetchResponse {
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const refresh = new URLSearchParams(init.body ?? "").get("refresh_token") ?? "";
      const subject = refresh.replace(/^refresh-/, "");
      record("token", subject, url);
      if (!refresh.startsWith("refresh-") || !users.has(subject)) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: `access-${subject}`, expires_in: 3600 });
    }
    const caller = callerOf(init);
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/drive\/v3/, "");
    const body = init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    if (init.method === "GET" && path === "/changes/startPageToken") {
      record("changes.getStartPageToken", caller, url);
      return json(200, { startPageToken: `${String(epoch)}-${String(feed.length)}` });
    }
    if (init.method === "POST" && path === "/changes/watch") {
      record("changes.watch", caller, url);
      const resourceId = `resource-${String(nextId++)}`;
      const asked = Number(body.expiration);
      const expiresAtMs = channelLifetimeMs === null ? asked : Math.min(asked, now().getTime() + channelLifetimeMs);
      live.set(String(body.id), { id: String(body.id), owner: caller, token: String(body.token), address: String(body.address), resourceId, expiresAtMs });
      return json(200, { kind: "api#channel", id: body.id, resourceId, expiration: String(expiresAtMs) });
    }
    if (init.method === "POST" && path === "/channels/stop") {
      record("channels.stop", caller, url);
      const channel = live.get(String(body.id));
      // Only the user who opened a channel can stop it.
      if (channel === undefined || channel.resourceId !== body.resourceId || channel.owner !== caller) return json(404, { error: { status: "NOT_FOUND" } });
      live.delete(channel.id);
      return json(204, null);
    }
    if (init.method === "GET" && path === "/changes") {
      record("changes.list", caller, url);
      const [tokenEpoch, tokenIndex] = (parsed.searchParams.get("pageToken") ?? "").split("-").map(Number);
      const token = tokenIndex ?? -1;
      if (tokenEpoch !== epoch || !Number.isInteger(token) || token < 0 || token > feed.length) return json(410, { error: { status: "GONE" } });
      // The caller's own feed: only files their grant reaches.
      const changes = [...new Set(feed.slice(token))]
        .filter((fileId) => reaches(caller, fileId))
        .map((fileId) => {
          const deck = decks.get(fileId);
          return { fileId, file: { name: deck?.name ?? "a file", mimeType: deck?.mimeType ?? "application/pdf" } };
        });
      return json(200, { changes, newStartPageToken: `${String(epoch)}-${String(feed.length)}` });
    }
    const updateMatch = /^\/files\/([^/]+)\/comments\/([^/]+)\/replies\/([^/]+)$/.exec(path);
    if (init.method === "PATCH" && updateMatch !== null) {
      record("replies.update", caller, url);
      const fileId = decodeURIComponent(updateMatch[1] ?? "");
      if (!reaches(caller, fileId)) return json(404, { error: { status: "NOT_FOUND" } });
      const comment = comments.get(decodeURIComponent(updateMatch[2] ?? ""));
      const reply = comment?.replies.find((candidate) => candidate.id === decodeURIComponent(updateMatch[3] ?? ""));
      // Drive lets only a reply's author change it, and a deleted reply is gone for good.
      if (comment === undefined || reply === undefined || reply.deleted) return json(404, { error: { status: "NOT_FOUND" } });
      if (reply.author.subject !== caller) return json(403, { error: { status: "PERMISSION_DENIED" } });
      reply.content = String(body.content);
      comment.modifiedTime = iso();
      feed.push(comment.fileId);
      return json(200, { id: reply.id });
    }
    const replyMatch = /^\/files\/([^/]+)\/comments\/([^/]+)\/replies$/.exec(path);
    if (init.method === "POST" && replyMatch !== null) {
      record("replies.create", caller, url);
      const fileId = decodeURIComponent(replyMatch[1] ?? "");
      if (!reaches(caller, fileId)) return json(404, { error: { status: "NOT_FOUND" } });
      if (decks.get(fileId)?.shares.get(caller) !== "commenter") return json(403, { error: { status: "PERMISSION_DENIED" } });
      const comment = comments.get(decodeURIComponent(replyMatch[2] ?? ""));
      if (comment === undefined) return json(404, { error: { status: "NOT_FOUND" } });
      const id = pushReply({ comment, author: authorFor(caller), content: String(body.content) });
      return json(200, { id });
    }
    const commentsMatch = /^\/files\/([^/]+)\/comments$/.exec(path);
    if (init.method === "GET" && commentsMatch !== null) {
      record("comments.list", caller, url);
      const fileId = decodeURIComponent(commentsMatch[1] ?? "");
      if (!reaches(caller, fileId)) return json(404, { error: { status: "NOT_FOUND" } });
      if (parsed.searchParams.get("fields") === null) return json(400, { error: { status: "INVALID_ARGUMENT" } });
      const after = parsed.searchParams.get("startModifiedTime") ?? "";
      const asSeenBy = (author: FakeAuthor): Readonly<{ displayName: string; me: boolean }> => ({ displayName: author.displayName, me: author.subject === caller });
      const listed = [...comments.values()]
        .filter((comment) => comment.fileId === fileId && comment.modifiedTime >= after)
        .map((comment) => ({
          id: comment.id,
          content: comment.content,
          author: asSeenBy(comment.author),
          createdTime: comment.createdTime,
          modifiedTime: comment.modifiedTime,
          deleted: false,
          ...(comment.anchor === null ? {} : { anchor: comment.anchor }),
          ...(comment.quoted === null ? {} : { quotedFileContent: { mimeType: "text/plain", value: comment.quoted } }),
          replies: comment.replies.map((reply) => ({ id: reply.id, content: reply.content, author: asSeenBy(reply.author), createdTime: reply.createdTime, deleted: reply.deleted })),
        }));
      return json(200, { comments: listed });
    }
    const fileMatch = /^\/files\/([^/]+)$/.exec(path);
    if (init.method === "GET" && fileMatch !== null) {
      record("files.get", caller, url);
      const fileId = decodeURIComponent(fileMatch[1] ?? "");
      const deck = decks.get(fileId);
      if (deck === undefined || !reaches(caller, fileId)) return json(404, { error: { status: "NOT_FOUND" } });
      return json(200, { id: fileId, name: deck.name, mimeType: deck.mimeType, trashed: false, capabilities: { canComment: deck.shares.get(caller) === "commenter" } });
    }
    throw new Error(`fake owner drive: no route for ${init.method} ${url}`);
  }

  function callerOf(init: HttpFetchInit): string {
    const bearer = /^Bearer access-(.+)$/.exec(init.headers.authorization ?? "")?.[1];
    if (bearer === undefined || !users.has(bearer)) throw new Error("fake owner drive: a Drive call without a known user's access token");
    return bearer;
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
    addUser: ({ subject, name, scopes }) => {
      users.set(subject, { name });
      return {
        subject,
        email: `${name.toLowerCase()}@example.com`,
        accessToken: null,
        refreshToken: `refresh-${subject}`,
        accessTokenExpiresAtMs: null,
        grantedScopes: scopes ?? ["openid", "email", SLIDES_SCOPE, DRIVE_FILE_SCOPE],
      };
    },
    addDeck: ({ fileId, name, sharedWith, mimeType }) => {
      decks.set(fileId, { name, mimeType: mimeType ?? SLIDES_MIME_TYPE, shares: new Map(Object.entries(sharedWith)), picked: new Set() });
    },
    pick: ({ subject, fileId }) => {
      const deck = decks.get(fileId);
      if (deck === undefined) throw new Error(`no deck ${fileId}`);
      deck.picked.add(subject);
    },
    addComment: ({ fileId, by, content, anchor, quoted }) => {
      const id = `c${String(nextId++)}`;
      comments.set(id, {
        id,
        fileId,
        content,
        author: authorFor(by),
        createdTime: iso(),
        modifiedTime: iso(),
        anchor: anchor ?? null,
        quoted: quoted ?? null,
        replies: [],
      });
      feed.push(fileId);
      return id;
    },
    addReply: ({ commentId, by, content }) => {
      const comment = comments.get(commentId);
      if (comment === undefined) throw new Error(`no comment ${commentId}`);
      return pushReply({ comment, author: authorFor(by), content });
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
      if (comment === undefined) return null;
      return { replies: comment.replies.map((reply) => ({ id: reply.id, content: reply.content, author: reply.author.subject, deleted: reply.deleted })) };
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

function json(status: number, body: unknown): HttpFetchResponse {
  return { status, json: () => Promise.resolve(body) };
}
