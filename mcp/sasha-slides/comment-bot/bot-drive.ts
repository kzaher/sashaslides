/**
 * The comment bot's Drive, as the bot's own Google account (`sasha@sashaslides.com`): the
 * eight Drive v3 REST calls the bot makes, over an injected `HttpFetch`, so the tests run a
 * fake Drive and count every call.
 *
 * Configured by `--comment-bot <file>`, parsed here at the boundary:
 *
 *     { "clientId": "...", "clientSecret": "...", "refreshToken": "...",
 *       "address": "sasha@sashaslides.com" }
 *
 * The refresh token is the bot account's own consent to the `drive` scope (minted like the
 * mail sender's, `e2e/gmail-sender-token.ts`, with that scope). `address` is what users are
 * told to share their deck with.
 *
 * WHY NOT THE DOMAIN-WIDE-DELEGATION SERVICE ACCOUNT the mail sender can use: delegation is
 * granted per client ID and scope for the whole Workspace domain, so a service account with
 * the `drive` scope could act as ANY user of the domain and read every one of their files,
 * not just the bot's. A refresh token for the bot account alone can only ever reach what
 * people chose to share with that one address.
 *
 * Error messages name the offending key and never echo a value, and failure reasons carry
 * Google's status and error code, never a body, a token or an address.
 */
import { asNumber, asRecord, asString, parseJson } from "../http/json-values";
import type { HttpFetch } from "../http/identity-providers";
import { GOOGLE_TOKEN_URL, isMailboxAddress } from "../http/gmail-sender";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
export const BOT_DRIVE_TIMEOUT_MS = 10_000;

/**
 * `replyPrefix` is the STOPGAP for running the bot as a person's own Google account until a
 * dedicated Sasha account exists (asked for 2026-10-15): every line the bot posts starts with it
 * ("Sasha: "), and the bot then tells its own lines from that person's by the prefix instead of by
 * authorship. Empty for a dedicated account.
 */
export type CommentBotConfig = Readonly<{ clientId: string; clientSecret: string; refreshToken: string; address: string; replyPrefix: string }>;

export type CommentBotConfigParse =
  | Readonly<{ kind: "ok"; config: CommentBotConfig }>
  | Readonly<{ kind: "error"; message: string }>;

export type DriveFailure = Readonly<{ kind: "failed"; status: number; reason: string }>;
export type DriveResult<TValue> = Readonly<{ kind: "ok"; value: TValue }> | DriveFailure;

export type DriveDeck = Readonly<{ fileId: string; name: string; mimeType: string; canComment: boolean }>;
export type WatchedChannel = Readonly<{ resourceId: string; expiresAtMs: number }>;
export type ChangePage = Readonly<{
  changedFiles: readonly Readonly<{ fileId: string; name: string | null; mimeType: string | null }>[];
  nextPageToken: string | null;
  newStartPageToken: string | null;
}>;
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

/** The bot's Drive. Every method is one HTTP request (plus a token refresh when due). */
export type BotDrive = Readonly<{
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

export function parseCommentBotConfig(text: string): CommentBotConfigParse {
  const parsed = parseJson(text);
  if (parsed.kind === "error") return { kind: "error", message: `comment bot file is not JSON: ${parsed.reason}` };
  const root = asRecord(parsed.value);
  if (root === null) return { kind: "error", message: `comment bot file must be an object with ${CONFIG_KEYS.join(", ")}` };
  const unknownKey = Object.keys(root).find((key) => !CONFIG_KEYS.includes(key));
  if (unknownKey !== undefined) return { kind: "error", message: `unknown key ${JSON.stringify(unknownKey)} (allowed: ${CONFIG_KEYS.join(", ")})` };
  // The values are deliberately absent from every message below.
  const clientId = asString(root.clientId);
  if (clientId === null || clientId === "") return { kind: "error", message: "clientId must be a non-empty string" };
  const clientSecret = asString(root.clientSecret);
  if (clientSecret === null || clientSecret === "") return { kind: "error", message: "clientSecret must be a non-empty string" };
  const refreshToken = asString(root.refreshToken);
  if (refreshToken === null || refreshToken === "") return { kind: "error", message: "refreshToken must be a non-empty string" };
  const address = asString(root.address);
  if (address === null || !isMailboxAddress(address)) return { kind: "error", message: "address must be the bot account's email address" };
  const replyPrefix = root.replyPrefix === undefined ? "" : asString(root.replyPrefix);
  if (replyPrefix === null) return { kind: "error", message: "replyPrefix must be a string, e.g. \"Sasha: \"" };
  return { kind: "ok", config: { clientId, clientSecret, refreshToken, address, replyPrefix } };
}

export function googleBotDrive(
  options: Readonly<{ config: CommentBotConfig; fetch: HttpFetch; now: () => Date; timeoutMs: number }>,
): BotDrive {
  const { config, fetch, now, timeoutMs } = options;
  let cached: Readonly<{ accessToken: string; expiresAtMs: number }> | null = null;

  async function accessToken(): Promise<DriveResult<string>> {
    const nowMs = now().getTime();
    if (cached !== null && cached.expiresAtMs - ACCESS_TOKEN_MARGIN_MS > nowMs) return { kind: "ok", value: cached.accessToken };
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = asRecord(await response.json().catch(() => null));
    const token = asString(body?.access_token);
    const expiresIn = asNumber(body?.expires_in);
    if (response.status !== 200 || token === null || expiresIn === null) {
      return {
        kind: "failed",
        status: response.status,
        reason: `token refresh answered ${String(response.status)} ${errorCode(body?.error)}; mint a new refresh token for the bot account (scope drive)`,
      };
    }
    cached = { accessToken: token, expiresAtMs: nowMs + expiresIn * 1000 };
    return { kind: "ok", value: token };
  }

  /** One authorised request; a 401 (token revoked early) drops the cache and retries once. */
  async function call(
    request: Readonly<{ method: "GET" | "POST" | "PATCH"; url: string; body?: unknown }>,
  ): Promise<DriveResult<Readonly<Record<string, unknown>> | null>> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await accessToken();
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
        if (response.status === 401 && attempt === 0) {
          cached = null;
          continue;
        }
        const body = asRecord(await response.json().catch(() => null));
        if (response.status >= 200 && response.status < 300) return { kind: "ok", value: body };
        const error = asRecord(body?.error);
        return { kind: "failed", status: response.status, reason: `drive answered ${String(response.status)} ${errorCode(error?.status)}` };
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

const CONFIG_KEYS: readonly string[] = ["clientId", "clientSecret", "refreshToken", "address", "replyPrefix"];
/** Refresh this long before Google's stated expiry, so a token never dies mid-request. */
const ACCESS_TOKEN_MARGIN_MS = 60 * 1000;

function errorCode(value: unknown): string {
  const code = asString(value);
  return code !== null && /^[A-Za-z_]{1,64}$/.test(code) ? code : "(no error code)";
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
 * states "The author's email address and permission ID will not be populated." `me` is
 * relative to the caller, so with the bot's token it marks the bot's own posts.
 */
function parseAuthor(value: unknown): DriveAuthor {
  const author = asRecord(value);
  return { displayName: asString(author?.displayName) ?? "someone", me: author?.me === true };
}
