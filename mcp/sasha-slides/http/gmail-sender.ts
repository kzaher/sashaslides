/**
 * Sends the account portal's mail (address confirmations, password resets) through the
 * Gmail API as one Google account: `POST gmail/v1/users/me/messages/send` with the message
 * as `{ raw: base64url(RFC 5322 text) }`, authorised by an access token refreshed from a
 * stored refresh token for the `gmail.send` scope alone.
 *
 * Configured by `--mail-sender <file>`, a JSON file parsed here at the boundary:
 *
 *   { "clientId": "...", "clientSecret": "...", "refreshToken": "...",
 *     "from": "Sasha Slides <sasha.slides@exponent.company>" }
 *
 * `e2e/gmail-sender-token.ts` writes it after a consent screen. Error messages name the
 * offending key and never echo a value, so a typo next to a secret cannot leak the secret
 * into a log (the same rule as `identity-providers.ts`).
 *
 * Attacks and their defences:
 *
 *  - **Header injection** (an address or subject carrying `\r\nBcc: …` to turn our mail into
 *    a spam relay). Recipients and the From address must match a strict ASCII address
 *    pattern with no whitespace at all; subject text has every control character replaced
 *    before encoding; a display name with a control character is refused at startup.
 *  - **Credential leakage.** The refresh token and client secret appear only in the token
 *    request body; failure reasons carry Google's error code (`invalid_grant`), never a
 *    response body or a request.
 *  - **A slow Google.** Every request is bounded by `timeoutMs`.
 *
 * The access token is cached until a minute before it expires, and a 401 from Gmail (a token
 * revoked early) drops it and retries once with a fresh one.
 *
 * All network traffic goes through an injected `HttpFetch`, so tests use a fake Gmail.
 */
import type { HttpFetch } from "./identity-providers";
import { asRecord, asString, parseJson } from "./json-values";

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const MAIL_SENDER_TIMEOUT_MS = 10_000;

export type MailAddress = Readonly<{ address: string; displayName: string | null }>;

/** The parsed `--mail-sender` file, secrets included. Never logged. */
export type MailSenderConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  from: MailAddress;
}>;

export type MailSenderConfigParse =
  | Readonly<{ kind: "ok"; config: MailSenderConfig }>
  | Readonly<{ kind: "error"; message: string }>;

export type OutgoingMail = Readonly<{ to: string; subject: string; text: string; html: string }>;

export type SendOutcome =
  | Readonly<{ kind: "sent"; messageId: string }>
  /** `reason` is for the server log: no secret, no recipient. */
  | Readonly<{ kind: "failed"; reason: string }>;

export type MailSender = Readonly<{ send(mail: OutgoingMail): Promise<SendOutcome> }>;

export function parseMailSenderConfig(options: Readonly<{ text: string }>): MailSenderConfigParse {
  const parsed = parseJson(options.text);
  if (parsed.kind === "error") return { kind: "error", message: `mail sender file is not JSON: ${parsed.reason}` };
  const root = asRecord(parsed.value);
  if (root === null) return { kind: "error", message: `mail sender file must be an object with ${CONFIG_KEYS.join(", ")}` };
  const unknownKey = Object.keys(root).find((key) => !CONFIG_KEYS.includes(key));
  if (unknownKey !== undefined) return { kind: "error", message: `unknown key ${JSON.stringify(unknownKey)} (allowed: ${CONFIG_KEYS.join(", ")})` };
  // The values are deliberately absent from every message below.
  const clientId = asString(root.clientId);
  if (clientId === null || clientId === "") return { kind: "error", message: "clientId must be a non-empty string" };
  const clientSecret = asString(root.clientSecret);
  if (clientSecret === null || clientSecret === "") return { kind: "error", message: "clientSecret must be a non-empty string" };
  const refreshToken = asString(root.refreshToken);
  if (refreshToken === null || refreshToken === "") return { kind: "error", message: "refreshToken must be a non-empty string" };
  const fromText = asString(root.from);
  const from = fromText === null ? null : parseMailbox(fromText);
  if (from === null) {
    return { kind: "error", message: `from must be an address, optionally with a name: "Sasha Slides <noreply@example.com>"` };
  }
  return { kind: "ok", config: { clientId, clientSecret, refreshToken, from } };
}

export function createGmailSender(
  options: Readonly<{
    config: MailSenderConfig;
    fetch: HttpFetch;
    now: () => Date;
    /** URL-safe; the Message-ID and the MIME boundary are drawn from it. */
    randomToken: () => string;
    timeoutMs: number;
  }>,
): MailSender {
  const { config, fetch, now, randomToken, timeoutMs } = options;
  let cached: Readonly<{ accessToken: string; expiresAtMs: number }> | null = null;

  async function accessToken(): Promise<Readonly<{ kind: "ok"; token: string }> | Readonly<{ kind: "failed"; reason: string }>> {
    const nowMs = now().getTime();
    if (cached !== null && cached.expiresAtMs - ACCESS_TOKEN_MARGIN_MS > nowMs) return { kind: "ok", token: cached.accessToken };
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
    const expiresIn = body?.expires_in;
    if (response.status !== 200 || token === null || typeof expiresIn !== "number") {
      return {
        kind: "failed",
        reason:
          `token refresh answered ${String(response.status)} ${errorCode(body?.error)}; ` +
          "mint a new refresh token with mcp/sasha-slides/e2e/gmail-sender-token.ts " +
          "(an OAuth client in Testing mode issues refresh tokens that expire after 7 days)",
      };
    }
    cached = { accessToken: token, expiresAtMs: nowMs + expiresIn * 1000 };
    return { kind: "ok", token };
  }

  async function post(raw: string, token: string): Promise<Readonly<{ status: number; body: Readonly<Record<string, unknown>> | null }>> {
    const response = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: asRecord(await response.json().catch(() => null)) };
  }

  async function send(mail: OutgoingMail): Promise<SendOutcome> {
    if (!isMailboxAddress(mail.to)) return { kind: "failed", reason: "the recipient is not a plain email address" };
    const raw = Buffer.from(
      composeMessage({
        from: config.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        date: now(),
        messageId: `<${randomToken()}@${domainOf(config.from.address)}>`,
        boundary: `sasha-${randomToken()}`,
      }),
      "utf-8",
    ).toString("base64url");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await accessToken();
      if (token.kind === "failed") return token;
      const answer = await post(raw, token.token);
      if (answer.status === 401 && attempt === 0) {
        cached = null;
        continue;
      }
      const messageId = asString(answer.body?.id);
      if (answer.status === 200 && messageId !== null) return { kind: "sent", messageId };
      return { kind: "failed", reason: `gmail answered ${String(answer.status)} ${errorCode(asRecord(answer.body?.error)?.status)}` };
    }
    return { kind: "failed", reason: "gmail refused two fresh access tokens" };
  }

  return {
    send: async (mail) => {
      try {
        return await send(mail);
      } catch (cause) {
        return { kind: "failed", reason: `cannot reach Google: ${cause instanceof Error ? cause.name : "unknown error"}` };
      }
    },
  };
}

/**
 * The RFC 5322 text of a `multipart/alternative` message with a plain-text and an HTML part,
 * both UTF-8 in base64 (so no body line can be read as a header or exceed 78 characters).
 */
export function composeMessage(
  options: Readonly<{
    from: MailAddress;
    to: string;
    subject: string;
    text: string;
    html: string;
    date: Date;
    messageId: string;
    boundary: string;
  }>,
): string {
  const { boundary } = options;
  const lines = [
    `From: ${formatMailbox(options.from)}`,
    `To: ${options.to}`,
    `Subject: ${encodeHeaderText(options.subject)}`,
    `Date: ${formatDate(options.date)}`,
    `Message-ID: ${options.messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative;",
    ` boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...base64Lines(options.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...base64Lines(options.html),
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

/**
 * Header text: printable ASCII stays as it is; anything else becomes RFC 2047 encoded words
 * (`=?UTF-8?B?…?=`), split on character boundaries and folded onto continuation lines.
 * Control characters, CR and LF included, become spaces first, so text cannot end a header.
 */
export function encodeHeaderText(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean) && clean.length <= MAX_PLAIN_HEADER_TEXT) return clean;
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let chunkBytes = 0;
  for (const character of clean) {
    const bytes = Buffer.from(character, "utf-8");
    if (chunkBytes + bytes.length > ENCODED_WORD_BYTES && chunkBytes > 0) {
      words.push(encodedWord(Buffer.concat(chunk)));
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(bytes);
    chunkBytes += bytes.length;
  }
  if (chunkBytes > 0 || words.length === 0) words.push(encodedWord(Buffer.concat(chunk)));
  return words.join("\r\n ");
}

/**
 * A plain ASCII mailbox address, with no whitespace, quotes or control characters anywhere
 * (the WHATWG `type=email` shape). Deliberately narrower than RFC 5322: everything it admits
 * is safe to place in a header verbatim.
 */
export function isMailboxAddress(text: string): boolean {
  if (text.length > MAX_ADDRESS_LENGTH) return false;
  const at = text.lastIndexOf("@");
  if (at < 1 || at > MAX_LOCAL_PART_LENGTH) return false;
  return ADDRESS_PATTERN.test(text);
}

const CONFIG_KEYS: readonly string[] = ["clientId", "clientSecret", "refreshToken", "from"];
/** Refresh this long before Google's stated expiry, so a token never dies mid-request. */
const ACCESS_TOKEN_MARGIN_MS = 60 * 1000;
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const ADDRESS_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** Keeps `Subject: ` plus the text inside 78 characters. */
const MAX_PLAIN_HEADER_TEXT = 68;
/** 39 bytes → 52 base64 characters → a 64-character word; with `Subject: ` still under 78. */
const ENCODED_WORD_BYTES = 39;
const BASE64_LINE_LENGTH = 76;
const DAY_NAMES: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function errorCode(value: unknown): string {
  const code = asString(value);
  return code !== null && /^[A-Za-z_]{1,64}$/.test(code) ? code : "(no error code)";
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** `Name <address>` or a bare address; null for anything else, a control character included. */
function parseMailbox(text: string): MailAddress | null {
  const trimmed = text.trim();
  if (isMailboxAddress(trimmed)) return { address: trimmed, displayName: null };
  const named = /^([^<>]*)<([^<>]+)>$/.exec(trimmed);
  if (named === null) return null;
  const displayName = (named[1] ?? "").trim();
  const address = (named[2] ?? "").trim();
  if (!isMailboxAddress(address) || /[\u0000-\u001f\u007f]/.test(displayName)) return null;
  return { address, displayName: displayName === "" ? null : displayName };
}

function formatMailbox(mailbox: MailAddress): string {
  if (mailbox.displayName === null) return mailbox.address;
  const name = mailbox.displayName;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return `${name} <${mailbox.address}>`;
  if (/^[\x20-\x7e]+$/.test(name)) return `"${name.replace(/["\\]/g, "\\$&")}" <${mailbox.address}>`;
  return `${encodeHeaderText(name)} <${mailbox.address}>`;
}

function encodedWord(bytes: Buffer): string {
  return `=?UTF-8?B?${bytes.toString("base64")}?=`;
}

/** RFC 5322 §3.3, always in UTC: `Tue, 13 Oct 2026 09:30:00 +0000`. */
function formatDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${DAY_NAMES[date.getUTCDay()] ?? "Sun"}, ${String(date.getUTCDate())} ${MONTH_NAMES[date.getUTCMonth()] ?? "Jan"} ${String(date.getUTCFullYear())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

function base64Lines(text: string): readonly string[] {
  const encoded = Buffer.from(text, "utf-8").toString("base64");
  const lines: string[] = [];
  for (let start = 0; start < encoded.length; start += BASE64_LINE_LENGTH) lines.push(encoded.slice(start, start + BASE64_LINE_LENGTH));
  return lines;
}
