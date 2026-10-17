/**
 * The comment bot's Drive, as the WATCH OWNER: every Drive v3 call a watch makes (the deck
 * check, the change feed and its push channel, `comments.list`, the acknowledgement and the
 * answer) carries the access token of the Sasha user who started that watch, refreshed from the
 * Google grant they gave when they signed in (`store.googleIdentities`, keyed by their Google
 * subject). There is no shared Sasha Google account: an answer appears in the thread as the
 * user, starting with "Sasha: " (`comment-bot.ts`).
 *
 * WHY THE OWNER'S OWN GRANT, asked for by the product owner on 2026-10-15 ("don't do it under my
 * account"): a shared account would read every deck shared with it, for every user, and post as
 * one identity nobody owns. The owner's grant reaches only what that owner can reach, and only
 * the decks they handed to Sasha (next paragraph).
 *
 * LEAST PRIVILEGE. Drive has no comments-only scope. The grant has `drive.file` (sign-in asks for
 * it, `http/oauth-metadata.ts` BROKERED_SCOPES), which covers only files the person opened with
 * this app: a deck they choose once in the Google Picker on `/comments/allow`
 * (`comment-access-page.ts`). Until then Drive answers 404 for the deck, which the bot turns into
 * that page's link. The restricted full `drive` scope is never requested.
 *
 * Every method is one HTTP request, plus a token refresh when the owner's access token is due,
 * over an injected `HttpFetch`, so the tests run a fake Google with per-user grants and count
 * every call and whose token it carried. Failure reasons carry Google's status and error code,
 * never a body or a token.
 */
import { asNumber, asRecord, asString, googleErrorCode } from "../http/json-values";
import type { HttpFetch } from "../http/http-kit";
import type { GoogleClientCredentials } from "../google-auth";
import { DRIVE_FILE_SCOPE, FULL_DRIVE_SCOPE, GOOGLE_TOKEN_ENDPOINT } from "../google-constants";
import type { GoogleIdentity, RecordStore } from "../http/oauth-store";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
export const OWNER_DRIVE_TIMEOUT_MS = 10_000;

export type DriveFailure = Readonly<{ kind: "failed"; status: number; reason: string }>;
export type DriveResult<TValue> = Readonly<{ kind: "ok"; value: TValue }> | DriveFailure;

export type DriveDeck = Readonly<{ fileId: string; name: string; mimeType: string; canComment: boolean }>;
export type WatchedChannel = Readonly<{ resourceId: string; expiresAtMs: number }>;
export type ChangePage = Readonly<{
  changedFiles: readonly Readonly<{ fileId: string; name: string | null; mimeType: string | null }>[];
  nextPageToken: string | null;
  newStartPageToken: string | null;
}>;
/** `me` is relative to the caller: with the owner's token it marks the owner's own posts. */
export type DriveAuthor = Readonly<{ displayName: string; me: boolean }>;
export type DriveReply = Readonly<{ id: string; content: string; author: DriveAuthor; createdTime: string; deleted: boolean }>;
export type DriveComment = Readonly<{
  id: string;
  content: string;
  author: DriveAuthor;
  createdTime: string;
  modifiedTime: string;
  deleted: boolean;
  anchor: string | null;
  quotedText: string | null;
  replies: readonly DriveReply[];
}>;
export type CommentPage = Readonly<{ comments: readonly DriveComment[]; nextPageToken: string | null }>;

/** One owner's Drive. Every method is one HTTP request (plus a token refresh when due). */
export type OwnerDrive = Readonly<{
  getFile(options: Readonly<{ fileId: string }>): Promise<DriveResult<DriveDeck>>;
  getStartPageToken(): Promise<DriveResult<string>>;
  watchChanges(
    options: Readonly<{ pageToken: string; channelId: string; token: string; address: string; expiresAtMs: number }>,
  ): Promise<DriveResult<WatchedChannel>>;
  stopChannel(options: Readonly<{ channelId: string; resourceId: string }>): Promise<DriveResult<null>>;
  listChanges(options: Readonly<{ pageToken: string }>): Promise<DriveResult<ChangePage>>;
  listComments(
    options: Readonly<{ fileId: string; modifiedAfter: string; pageToken: string | null }>,
  ): Promise<DriveResult<CommentPage>>;
  createReply(options: Readonly<{ fileId: string; commentId: string; content: string }>): Promise<DriveResult<string>>;
  /** Rewrites a reply's text in place; Drive allows it only for the reply's own author. */
  updateReply(options: Readonly<{ fileId: string; commentId: string; replyId: string; content: string }>): Promise<DriveResult<null>>;
}>;

export type OwnerDriveLookup =
  | Readonly<{ kind: "ok"; drive: OwnerDrive; scopeAccess: ScopeAccess }>
  /** No stored Google grant for this subject, or one with no usable token: sign in again. */
  | Readonly<{ kind: "no-grant" }>;

/**
 * What the stored grant's scopes say about reading comments. `per-file` is `drive.file`: decks
 * chosen in the picker only. `missing` needs the incremental consent on `/comments/allow`.
 * `unknown` is a grant Google reported no scopes for: the Drive call itself decides.
 */
export type ScopeAccess = "per-file" | "full" | "missing" | "unknown";

/** Hands out each watch owner's Drive; the comment bot never holds any other. */
export type OwnerDrives = Readonly<{
  forOwner(options: Readonly<{ ownerSubject: string }>): Promise<OwnerDriveLookup>;
}>;

export function googleOwnerDrives(
  options: Readonly<{
    /** The connector's sealed grant store, keyed by Google subject. Read only: refreshed tokens stay in memory. */
    grants: Pick<RecordStore<GoogleIdentity>, "get">;
    /** The connector's own OAuth client, which every stored refresh token was issued to. */
    client: GoogleClientCredentials;
    fetch: HttpFetch;
    now: () => Date;
    timeoutMs: number;
  }>,
): OwnerDrives {
  const { grants, client, fetch, now, timeoutMs } = options;
  // Per owner, so one user's refresh can never hand out another's token.
  const cachedTokens = new Map<string, Readonly<{ accessToken: string; expiresAtMs: number }>>();

  return {
    forOwner: async ({ ownerSubject }) => {
      const identity = await grants.get({ key: ownerSubject });
      if (identity === null || (identity.refreshToken === null && identity.accessToken === null)) return { kind: "no-grant" };
      const stored = identity.accessToken;
      const storedExpiry = identity.accessTokenExpiresAtMs;
      if (!cachedTokens.has(ownerSubject) && stored !== null && storedExpiry !== null) {
        cachedTokens.set(ownerSubject, { accessToken: stored, expiresAtMs: storedExpiry });
      }
      const drive = ownerDrive({
        accessToken: (forceRefresh) => accessTokenFor({ ownerSubject, refreshToken: identity.refreshToken, forceRefresh }),
        fetch,
        timeoutMs,
      });
      return { kind: "ok", drive, scopeAccess: scopeAccessOf(identity.grantedScopes) };
    },
  };

  async function accessTokenFor(
    request: Readonly<{ ownerSubject: string; refreshToken: string | null; forceRefresh: boolean }>,
  ): Promise<DriveResult<string>> {
    const nowMs = now().getTime();
    const cached = cachedTokens.get(request.ownerSubject);
    if (!request.forceRefresh && cached !== undefined && cached.expiresAtMs - ACCESS_TOKEN_MARGIN_MS > nowMs) {
      return { kind: "ok", value: cached.accessToken };
    }
    cachedTokens.delete(request.ownerSubject);
    if (request.refreshToken === null) return { kind: "failed", status: 401, reason: "the Google grant has expired; sign in to Sasha Slides again" };
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: request.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = asRecord(await response.json().catch(() => null));
    const token = asString(body?.access_token);
    const expiresIn = asNumber(body?.expires_in);
    if (response.status !== 200 || token === null || expiresIn === null) {
      return {
        kind: "failed",
        // `invalid_grant` is Google's answer for a refresh token it no longer honours (revoked, or
        // past the 7 days of a Testing-mode client): the grant is gone, which callers read as 401.
        status: googleErrorCode(body?.error) === "invalid_grant" ? 401 : response.status,
        reason: `token refresh answered ${String(response.status)} ${googleErrorCode(body?.error)}; sign in to Sasha Slides again`,
      };
    }
    cachedTokens.set(request.ownerSubject, { accessToken: token, expiresAtMs: nowMs + expiresIn * 1000 });
    return { kind: "ok", value: token };
  }
}

/** Which kind of Drive access the granted scopes give; see `ScopeAccess`. */
export function scopeAccessOf(grantedScopes: readonly string[]): ScopeAccess {
  if (grantedScopes.length === 0) return "unknown";
  if (grantedScopes.includes(FULL_DRIVE_SCOPE)) return "full";
  if (grantedScopes.includes(DRIVE_FILE_SCOPE)) return "per-file";
  return "missing";
}

/** Refresh this long before Google's stated expiry, so a token never dies mid-request. */
const ACCESS_TOKEN_MARGIN_MS = 60 * 1000;

function ownerDrive(
  options: Readonly<{ accessToken: (forceRefresh: boolean) => Promise<DriveResult<string>>; fetch: HttpFetch; timeoutMs: number }>,
): OwnerDrive {
  const { accessToken, fetch, timeoutMs } = options;

  /** One authorised request; a 401 (token revoked early) refreshes and retries once. */
  async function call(
    request: Readonly<{ method: "GET" | "POST" | "PATCH"; url: string; body?: unknown }>,
  ): Promise<DriveResult<Readonly<Record<string, unknown>> | null>> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await accessToken(attempt > 0);
        if (token.kind === "failed") return token;
        const response = await fetch(request.url, {
          method: request.method,
          headers: {
            authorization: `Bearer ${token.value}`,
            accept: "application/json",
            ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 401 && attempt === 0) continue;
        const body = asRecord(await response.json().catch(() => null));
        if (response.status >= 200 && response.status < 300) return { kind: "ok", value: body };
        const error = asRecord(body?.error);
        return { kind: "failed", status: response.status, reason: `drive answered ${String(response.status)} ${googleErrorCode(error?.status)}` };
      }
      return { kind: "failed", status: 401, reason: "drive refused two fresh access tokens" };
    } catch (cause) {
      return { kind: "failed", status: 0, reason: `cannot reach Google: ${cause instanceof Error ? cause.name : "unknown error"}` };
    }
  }

  return {
    getFile: async ({ fileId }) => {
      const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${new URLSearchParams({
        fields: "id,name,mimeType,trashed,capabilities/canComment",
        supportsAllDrives: "true",
      }).toString()}`;
      const answer = await call({ method: "GET", url });
      if (answer.kind === "failed") return answer;
      const name = asString(answer.value?.name);
      const mimeType = asString(answer.value?.mimeType);
      if (name === null || mimeType === null) return { kind: "failed", status: 502, reason: "drive answered a file with no name or type" };
      const canComment = asRecord(answer.value?.capabilities)?.canComment === true;
      return { kind: "ok", value: { fileId, name, mimeType, canComment } };
    },
    getStartPageToken: async () => {
      const answer = await call({ method: "GET", url: `${DRIVE_API}/changes/startPageToken?supportsAllDrives=true` });
      if (answer.kind === "failed") return answer;
      const token = asString(answer.value?.startPageToken);
      return token === null ? { kind: "failed", status: 502, reason: "drive answered no startPageToken" } : { kind: "ok", value: token };
    },
    watchChanges: async ({ pageToken, channelId, token, address, expiresAtMs }) => {
      const url = `${DRIVE_API}/changes/watch?${new URLSearchParams({
        pageToken,
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        includeRemoved: "false",
      }).toString()}`;
      const answer = await call({
        method: "POST",
        url,
        body: { id: channelId, type: "web_hook", address, token, expiration: String(expiresAtMs) },
      });
      if (answer.kind === "failed") return answer;
      const resourceId = asString(answer.value?.resourceId);
      // Google returns the expiration as a string of milliseconds; it may be earlier than asked.
      const expiration = Number(asString(answer.value?.expiration) ?? answer.value?.expiration);
      if (resourceId === null || !Number.isFinite(expiration)) return { kind: "failed", status: 502, reason: "drive answered a channel with no resourceId or expiration" };
      return { kind: "ok", value: { resourceId, expiresAtMs: expiration } };
    },
    stopChannel: async ({ channelId, resourceId }) => {
      const answer = await call({ method: "POST", url: `${DRIVE_API}/channels/stop`, body: { id: channelId, resourceId } });
      return answer.kind === "failed" ? answer : { kind: "ok", value: null };
    },
    listChanges: async ({ pageToken }) => {
      const url = `${DRIVE_API}/changes?${new URLSearchParams({
        pageToken,
        pageSize: "1000",
        includeRemoved: "false",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        fields: "nextPageToken,newStartPageToken,changes(fileId,file(name,mimeType))",
      }).toString()}`;
      const answer = await call({ method: "GET", url });
      if (answer.kind === "failed") return answer;
      const changes = Array.isArray(answer.value?.changes) ? answer.value.changes : [];
      const changedFiles = changes.flatMap((entry: unknown) => {
        const change = asRecord(entry);
        const fileId = asString(change?.fileId);
        if (fileId === null) return [];
        const file = asRecord(change?.file);
        return [{ fileId, name: asString(file?.name), mimeType: asString(file?.mimeType) }];
      });
      return {
        kind: "ok",
        value: { changedFiles, nextPageToken: asString(answer.value?.nextPageToken), newStartPageToken: asString(answer.value?.newStartPageToken) },
      };
    },
    listComments: async ({ fileId, modifiedAfter, pageToken }) => {
      const query = new URLSearchParams({
        pageSize: "100",
        includeDeleted: "false",
        startModifiedTime: modifiedAfter,
        // Minimal: Drive's comments API requires `fields`, and every byte here is per change.
        fields:
          "nextPageToken,comments(id,content,createdTime,modifiedTime,deleted,anchor,quotedFileContent/value," +
          "author(displayName,me),replies(id,content,createdTime,deleted,author(displayName,me)))",
      });
      if (pageToken !== null) query.set("pageToken", pageToken);
      const answer = await call({ method: "GET", url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}/comments?${query.toString()}` });
      if (answer.kind === "failed") return answer;
      const comments = (Array.isArray(answer.value?.comments) ? answer.value.comments : []).flatMap((entry: unknown) => {
        const comment = parseComment(entry);
        return comment === null ? [] : [comment];
      });
      return { kind: "ok", value: { comments, nextPageToken: asString(answer.value?.nextPageToken) } };
    },
    createReply: async ({ fileId, commentId, content }) => {
      const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies?fields=id`;
      const answer = await call({ method: "POST", url, body: { content } });
      if (answer.kind === "failed") return answer;
      const id = asString(answer.value?.id);
      return id === null ? { kind: "failed", status: 502, reason: "drive answered a reply with no id" } : { kind: "ok", value: id };
    },
    updateReply: async ({ fileId, commentId, replyId, content }) => {
      const url =
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}` +
        `/replies/${encodeURIComponent(replyId)}?fields=id`;
      const answer = await call({ method: "PATCH", url, body: { content } });
      return answer.kind === "failed" ? answer : { kind: "ok", value: null };
    },
  };
}

function parseComment(value: unknown): DriveComment | null {
  const record = asRecord(value);
  const id = asString(record?.id);
  const createdTime = asString(record?.createdTime);
  if (record === null || id === null || createdTime === null) return null;
  const replies = (Array.isArray(record.replies) ? record.replies : []).flatMap((entry: unknown) => {
    const reply = asRecord(entry);
    const replyId = asString(reply?.id);
    const replyCreated = asString(reply?.createdTime);
    if (reply === null || replyId === null || replyCreated === null) return [];
    return [{ id: replyId, content: asString(reply.content) ?? "", author: parseAuthor(reply.author), createdTime: replyCreated, deleted: reply.deleted === true }];
  });
  return {
    id,
    content: asString(record.content) ?? "",
    author: parseAuthor(record.author),
    createdTime,
    modifiedTime: asString(record.modifiedTime) ?? createdTime,
    deleted: record.deleted === true,
    anchor: asString(record.anchor),
    quotedText: asString(asRecord(record.quotedFileContent)?.value),
    replies,
  };
}

/**
 * Drive gives a comment's author only `displayName`, `photoLink` and `me`: its documentation
 * states "The author's email address and permission ID will not be populated."
 */
function parseAuthor(value: unknown): DriveAuthor {
  const author = asRecord(value);
  return { displayName: asString(author?.displayName) ?? "someone", me: author?.me === true };
}
