/**
 * A fake Google token endpoint and Gmail `messages.send`, answering through the same
 * injected `fetch` as the fake sign-in providers, so a test can read every message the code
 * under test sent.
 *
 * The token endpoint accepts either grant the sender can use, each checked exactly:
 *
 *  - **refresh token**: client id, client secret and refresh token must all match;
 *  - **service account** (domain-wide delegation, the JWT bearer grant of RFC 7523): the
 *    assertion's RS256 signature must verify against the service account's PUBLIC key, and
 *    its header and claims must be what Google requires (`iss` the service account, `sub` the
 *    user acted for, `scope` gmail.send, `aud` the token URL, a lifetime of at most an hour
 *    that has not run out). Why an assertion was refused is kept for the test to read.
 *
 * A send that arrives with any other access token is refused with 401, as Gmail would. Each
 * captured message is the decoded RFC 5322 text, parsed just enough to read headers and the
 * decoded bodies of a `multipart/alternative`, together with the account its token acts for.
 */
import { verify, type KeyObject } from "node:crypto";
import type { HttpFetchInit, HttpFetchResponse } from "../http/identity-providers";
import { GMAIL_SEND_SCOPE, GMAIL_SEND_URL, GOOGLE_TOKEN_URL, JWT_BEARER_GRANT_TYPE } from "../http/gmail-sender";
import { asNumber, asRecord, asString, parseJson } from "../http/json-values";
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
  /** The mailbox `users/me` meant for this send: the impersonated user, or the refresh token's owner. */
  actingAs: string;
}>;

/** The service account the fake trusts, as Google knows it after domain-wide delegation. */
export type FakeServiceAccount = Readonly<{
  clientEmail: string;
  /** The public half of the key file's `private_key`. */
  publicKey: KeyObject;
  /** The key file's `private_key_id`, expected as the JWT `kid`. */
  privateKeyId: string;
  /** The users of the Workspace domain it may act for; any other `sub` is `invalid_grant`. */
  users: readonly string[];
  /** The fake's clock, for checking `iat` and `exp`. */
  nowMs: () => number;
}>;

export type FakeGmail = Readonly<{
  route: FakeRoute;
  sent: () => readonly CapturedMail[];
  /** How many access tokens have been issued, by either grant. */
  tokenRefreshes: () => number;
  /** Requests made of each endpoint, for asserting request shape. */
  tokenRequests: () => readonly Readonly<{ init: HttpFetchInit }>[];
  sendRequests: () => readonly Readonly<{ init: HttpFetchInit }>[];
  /** Why each refused service-account assertion was refused, in order. */
  assertionRefusals: () => readonly string[];
  /** Makes the next N sends answer 401, as an access token revoked early would. */
  rejectNextSends: (count: number) => void;
  /** Makes every refresh answer `invalid_grant`, as an expired refresh token would. */
  expireRefreshToken: () => void;
  /** Makes every valid assertion answer `unauthorized_client`, as a missing domain-wide delegation does. */
  withdrawDelegation: () => void;
}>;

export function createFakeGmail(
  options: Readonly<{
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** Whose mailbox a refresh-token access token opens. */
    refreshTokenOwner?: string;
    serviceAccount?: FakeServiceAccount;
    accessTokenLifetimeSeconds: number;
  }>,
): FakeGmail {
  const sent: CapturedMail[] = [];
  const tokenRequests: { init: HttpFetchInit }[] = [];
  const sendRequests: { init: HttpFetchInit }[] = [];
  const assertionRefusals: string[] = [];
  /** Access token → the mailbox it acts for. */
  const liveTokens = new Map<string, string>();
  let refreshes = 0;
  let rejections = 0;
  let refreshExpired = false;
  let delegationWithdrawn = false;

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

  function issue(actingAs: string): HttpFetchResponse {
    refreshes += 1;
    const accessToken = `fake-access-${String(refreshes)}`;
    liveTokens.set(accessToken, actingAs);
    return jsonResponse({
      status: 200,
      body: { access_token: accessToken, expires_in: options.accessTokenLifetimeSeconds, token_type: "Bearer", scope: GMAIL_SEND_SCOPE },
    });
  }

  function token(init: HttpFetchInit): HttpFetchResponse {
    const form = new URLSearchParams(init.body ?? "");
    if (init.method === "POST" && form.get("grant_type") === JWT_BEARER_GRANT_TYPE) return bearerGrant(form);
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
    return issue(options.refreshTokenOwner ?? "refresh-token-owner@example.com");
  }

  function bearerGrant(form: URLSearchParams): HttpFetchResponse {
    const account = options.serviceAccount;
    if (account === undefined) return jsonResponse({ status: 400, body: { error: "invalid_grant", error_description: "no service account configured" } });
    const checked = checkAssertion({ assertion: form.get("assertion") ?? "", account });
    if (checked.kind === "refused") {
      assertionRefusals.push(checked.reason);
      return jsonResponse({ status: 400, body: { error: "invalid_grant", error_description: checked.reason } });
    }
    if (delegationWithdrawn) {
      return jsonResponse({
        status: 401,
        body: { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested." },
      });
    }
    if (!account.users.includes(checked.subject)) {
      return jsonResponse({ status: 400, body: { error: "invalid_grant", error_description: "Invalid email or User ID" } });
    }
    return issue(checked.subject);
  }

  function send(init: HttpFetchInit): HttpFetchResponse {
    const bearer = /^Bearer (.+)$/.exec(init.headers.authorization ?? "")?.[1];
    const actingAs = bearer === undefined ? undefined : liveTokens.get(bearer);
    if (init.method !== "POST" || bearer === undefined || actingAs === undefined) {
      return jsonResponse({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } });
    }
    if (rejections > 0) {
      rejections -= 1;
      liveTokens.delete(bearer);
      return jsonResponse({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } });
    }
    const body = JSON.parse(init.body ?? "{}") as { raw?: unknown };
    if (typeof body.raw !== "string") return jsonResponse({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT" } } });
    sent.push({ ...parseMessage(body.raw), actingAs });
    return jsonResponse({ status: 200, body: { id: `message-${String(sent.length)}`, threadId: "thread", labelIds: ["SENT"] } });
  }

  return {
    route,
    sent: () => sent,
    tokenRefreshes: () => refreshes,
    tokenRequests: () => tokenRequests,
    sendRequests: () => sendRequests,
    assertionRefusals: () => assertionRefusals,
    rejectNextSends: (count) => {
      rejections = count;
    },
    expireRefreshToken: () => {
      refreshExpired = true;
    },
    withdrawDelegation: () => {
      delegationWithdrawn = true;
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

/** Google's limit on an assertion's lifetime. */
const MAX_ASSERTION_LIFETIME_SECONDS = 3600;

type AssertionCheck = Readonly<{ kind: "accepted"; subject: string }> | Readonly<{ kind: "refused"; reason: string }>;

function checkAssertion(options: Readonly<{ assertion: string; account: FakeServiceAccount }>): AssertionCheck {
  const { account } = options;
  const refuse = (reason: string): AssertionCheck => ({ kind: "refused", reason });
  const segments = options.assertion.split(".");
  if (segments.length !== 3) return refuse("not three dot-separated segments");
  const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] = segments;
  const signatureValid = verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf-8"),
    account.publicKey,
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!signatureValid) return refuse("RS256 signature does not verify against the service account's public key");
  const header = decodeSegment(encodedHeader);
  const claims = decodeSegment(encodedClaims);
  if (header === null || claims === null) return refuse("header or claims are not base64url JSON objects");
  if (header.alg !== "RS256" || header.typ !== "JWT") return refuse(`header is ${JSON.stringify(header)}, not RS256 JWT`);
  if (header.kid !== account.privateKeyId) return refuse("kid is not the key's private_key_id");
  if (claims.iss !== account.clientEmail) return refuse("iss is not the service account's client_email");
  if (claims.scope !== GMAIL_SEND_SCOPE) return refuse("scope is not gmail.send alone");
  if (claims.aud !== GOOGLE_TOKEN_URL) return refuse("aud is not the token URL");
  const issuedAt = asNumber(claims.iat);
  const expiresAt = asNumber(claims.exp);
  const nowSeconds = Math.floor(account.nowMs() / 1000);
  if (issuedAt === null || expiresAt === null) return refuse("iat or exp is not a number");
  if (issuedAt > nowSeconds + 60) return refuse("iat is in the future");
  if (expiresAt <= nowSeconds) return refuse("exp has passed");
  if (expiresAt - issuedAt > MAX_ASSERTION_LIFETIME_SECONDS) return refuse("lifetime is longer than an hour");
  const subject = asString(claims.sub);
  if (subject === null) return refuse("sub is missing");
  return { kind: "accepted", subject };
}

function decodeSegment(segment: string): Readonly<Record<string, unknown>> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const parsed = parseJson(Buffer.from(segment, "base64url").toString("utf-8"));
  return parsed.kind === "ok" ? asRecord(parsed.value) : null;
}

function parseMessage(encoded: string): Omit<CapturedMail, "actingAs"> {
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
