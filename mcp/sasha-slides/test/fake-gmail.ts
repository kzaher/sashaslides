/**
 * A fake Google token endpoint and Gmail `messages.send`, answering through the same
 * injected `fetch` as the fake sign-in providers, so a test can read every message the code
 * under test sent.
 *
 * The token endpoint checks the refresh-token grant exactly (client id, client secret,
 * refresh token), so a send that arrives with any other access token is refused with 401,
 * as Gmail would. Each captured message is the decoded RFC 5322 text, parsed just enough to
 * read headers and the decoded bodies of a `multipart/alternative`.
 */
import type { HttpFetchInit, HttpFetchResponse } from "../http/identity-providers";
import { GMAIL_SEND_URL, GOOGLE_TOKEN_URL } from "../http/gmail-sender";
import { jsonResponse, type FakeRoute } from "./fake-identity-providers";

export type CapturedMail = Readonly<{
  /** The message exactly as sent, after base64url decoding. */
  raw: string;
  /** Header names lowercased; a repeated header keeps its first value. */
  headers: ReadonlyMap<string, string>;
  /** Every header line, unfolded, in order. */
  headerLines: readonly string[];
  text: string;
  html: string;
  /** The `raw` field as it arrived, before decoding. */
  encoded: string;
}>;

export type FakeGmail = Readonly<{
  route: FakeRoute;
  sent: () => readonly CapturedMail[];
  /** How many refresh-token exchanges have happened. */
  tokenRefreshes: () => number;
  /** Requests made of each endpoint, for asserting request shape. */
  tokenRequests: () => readonly Readonly<{ init: HttpFetchInit }>[];
  sendRequests: () => readonly Readonly<{ init: HttpFetchInit }>[];
  /** Makes the next N sends answer 401, as an access token revoked early would. */
  rejectNextSends: (count: number) => void;
  /** Makes every refresh answer `invalid_grant`, as an expired refresh token would. */
  expireRefreshToken: () => void;
}>;

export function createFakeGmail(
  options: Readonly<{ clientId: string; clientSecret: string; refreshToken: string; accessTokenLifetimeSeconds: number }>,
): FakeGmail {
  const sent: CapturedMail[] = [];
  const tokenRequests: { init: HttpFetchInit }[] = [];
  const sendRequests: { init: HttpFetchInit }[] = [];
  const liveTokens = new Set<string>();
  let refreshes = 0;
  let rejections = 0;
  let refreshExpired = false;

  const route: FakeRoute = (url, init) => {
    const target = `${url.origin}${url.pathname}`;
    if (target === GOOGLE_TOKEN_URL) {
      tokenRequests.push({ init });
      return token(init);
    }
    if (target === GMAIL_SEND_URL) {
      sendRequests.push({ init });
      return send(init);
    }
    return null;
  };

  function token(init: HttpFetchInit): HttpFetchResponse {
    const form = new URLSearchParams(init.body ?? "");
    if (
      init.method !== "POST" ||
      form.get("grant_type") !== "refresh_token" ||
      form.get("client_id") !== options.clientId ||
      form.get("client_secret") !== options.clientSecret
    ) {
      return jsonResponse({ status: 401, body: { error: "invalid_client" } });
    }
    if (refreshExpired || form.get("refresh_token") !== options.refreshToken) {
      return jsonResponse({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    }
    refreshes += 1;
    const accessToken = `fake-access-${String(refreshes)}`;
    liveTokens.add(accessToken);
    return jsonResponse({
      status: 200,
      body: { access_token: accessToken, expires_in: options.accessTokenLifetimeSeconds, token_type: "Bearer", scope: "https://www.googleapis.com/auth/gmail.send" },
    });
  }

  function send(init: HttpFetchInit): HttpFetchResponse {
    const bearer = /^Bearer (.+)$/.exec(init.headers.authorization ?? "")?.[1];
    if (init.method !== "POST" || bearer === undefined || !liveTokens.has(bearer)) {
      return jsonResponse({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } });
    }
    if (rejections > 0) {
      rejections -= 1;
      liveTokens.delete(bearer);
      return jsonResponse({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } });
    }
    const body = JSON.parse(init.body ?? "{}") as { raw?: unknown };
    if (typeof body.raw !== "string") return jsonResponse({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT" } } });
    sent.push(parseMessage(body.raw));
    return jsonResponse({ status: 200, body: { id: `message-${String(sent.length)}`, threadId: "thread", labelIds: ["SENT"] } });
  }

  return {
    route,
    sent: () => sent,
    tokenRefreshes: () => refreshes,
    tokenRequests: () => tokenRequests,
    sendRequests: () => sendRequests,
    rejectNextSends: (count) => {
      rejections = count;
    },
    expireRefreshToken: () => {
      refreshExpired = true;
    },
  };
}

/** The first link in a captured mail's text part that starts with `prefix`. */
export function linkIn(mail: CapturedMail, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}[^\\s<>"]+`).exec(mail.text);
  if (match === null) throw new Error(`no ${prefix} link in mail: ${mail.text}`);
  return match[0];
}

function parseMessage(encoded: string): CapturedMail {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("raw is not base64url (padding or +/ found)");
  const raw = Buffer.from(encoded, "base64url").toString("utf-8");
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("no blank CRLF line between headers and body");
  const headerLines = raw
    .slice(0, split)
    .replace(/\r\n[ \t]/g, " ")
    .split("\r\n");
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`malformed header line: ${line}`);
    const name = line.slice(0, colon).toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get("content-type") ?? "")?.[1];
  if (boundary === undefined) throw new Error("not multipart");
  const parts = raw
    .slice(split + 4)
    .split(`--${boundary}`)
    .slice(1, -1);
  const decoded = new Map<string, string>();
  for (const part of parts) {
    const partSplit = part.indexOf("\r\n\r\n");
    const partHeaders = part.slice(0, partSplit).toLowerCase();
    const type = /content-type:\s*([a-z/]+)/.exec(partHeaders)?.[1] ?? "";
    if (!partHeaders.includes("content-transfer-encoding: base64")) throw new Error("part is not base64");
    decoded.set(type, Buffer.from(part.slice(partSplit + 4).replace(/\s+/g, ""), "base64").toString("utf-8"));
  }
  return { raw, headers, headerLines, text: decoded.get("text/plain") ?? "", html: decoded.get("text/html") ?? "", encoded };
}
