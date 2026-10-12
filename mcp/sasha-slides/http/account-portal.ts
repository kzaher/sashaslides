/**
 * The account portal at `/account`: sign in with any configured provider, see which sign-ins
 * belong to the account, and delete everything by resetting the account's encryption key.
 *
 * Routes (all under `/account`, so the session cookie's `Path=/account` keeps it off the MCP
 * and OAuth endpoints entirely):
 *
 *   GET  /account                     signed out: one button per provider; signed in: the
 *                                     linked sign-ins and the erase form
 *   GET  /account/login/<provider>    → 302 to the provider
 *   GET  /account/callback/<provider> verify, find or open the account, set the session
 *   POST /account/erase               session + CSRF token + confirmation → eraser
 *   POST /account/logout              session + CSRF token → clear the session
 *
 * Security choices, each against a named attack:
 *
 *  - **Session forgery.** The session is a stateless cookie, `payload.HMAC-SHA256(payload)`
 *    keyed by `SASHA_SESSION_SECRET`, holding `{accountId, exp, csrf}` and living 15 minutes.
 *    A tampered or expired cookie reads as signed out. It is `HttpOnly; Secure;
 *    SameSite=Lax; Path=/account`.
 *  - **Cross-site request forgery.** Both POSTs need the session's own CSRF token as a form
 *    field, compared in constant time, on top of SameSite=Lax. Erase also needs the
 *    confirmation checkbox, so a stray click on a stale page cannot delete anything.
 *  - **Login CSRF** (an attacker finishing a sign-in in the victim's browser so the victim
 *    works inside the attacker's account). The pending sign-in's `state` is also set as a
 *    short-lived cookie scoped to the callback path, and the callback requires the two to
 *    match, so a callback URL opened in a browser that did not start the sign-in is refused.
 *  - **Replay.** A pending sign-in is taken out of the map on first use, whatever the
 *    outcome, and is bound to the provider it was started for.
 *  - **Markup injection.** Every interpolated value goes through `escapeHtml`, and the
 *    Content-Security-Policy allows no script at all and only the page's own stylesheet
 *    (by hash).
 *
 * Pending sign-ins live in this process's memory for 10 minutes. A deployment with several
 * instances behind a load balancer would need sticky sessions or a shared store for them.
 *
 * The page HTML is rendered with template strings: these are static, non-interactive pages
 * with no client script, which is the exception the React rule names.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertNever } from "../google-auth";
import type { AccountDirectory, LinkedSignIn } from "./account-directory";
import type { AccountEraser, AccountId, EraseReport } from "./account-vault";
import type { IdentityProvider, PendingSignIn } from "./identity-providers";
import { asRecord, asString, parseJson } from "./json-values";
import { providerMark } from "./provider-marks";
import { SASHA_ICON_SVG } from "./sasha-icon.generated";

export type AccountPortal = Readonly<{
  /** The configured provider names, in button order, for the startup banner. */
  providerNames: readonly string[];
  /**
   * Answers any request under `/account` and resolves true; resolves false without touching
   * the response for every other path, so the caller can route it.
   */
  handleRequest(
    options: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL }>,
  ): Promise<boolean>;
}>;

export const ACCOUNT_PATH = "/account";
export const SESSION_COOKIE_NAME = "sasha_account";
export const SIGNIN_COOKIE_NAME = "sasha_signin";
export const SESSION_LIFETIME_MS = 15 * 60 * 1000;
export const PENDING_SIGNIN_LIFETIME_MS = 10 * 60 * 1000;
export const MIN_SESSION_SECRET_LENGTH = 32;
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

/** Where a provider sends the browser back to. Register exactly this with the provider. */
export function accountCallbackUrl(options: Readonly<{ publicUrl: string; provider: string }>): string {
  return `${options.publicUrl.replace(/\/+$/, "")}${ACCOUNT_PATH}/callback/${options.provider}`;
}

export type SessionSecretParse =
  | Readonly<{ kind: "ok"; secret: string }>
  | Readonly<{ kind: "error"; message: string }>;

/** `SASHA_SESSION_SECRET`, checked at startup. The value never appears in the message. */
export function parseSessionSecret(value: string | undefined): SessionSecretParse {
  if (value === undefined || value === "") {
    return {
      kind: "error",
      message:
        "SASHA_SESSION_SECRET is not set. The /account portal signs its session cookies with it; " +
        `set it to a random string of at least ${String(MIN_SESSION_SECRET_LENGTH)} characters ` +
        "(for example: openssl rand -base64 48).",
    };
  }
  if (value.length < MIN_SESSION_SECRET_LENGTH) {
    return {
      kind: "error",
      message: `SASHA_SESSION_SECRET is too short: it needs at least ${String(MIN_SESSION_SECRET_LENGTH)} characters.`,
    };
  }
  return { kind: "ok", secret: value };
}

export function createAccountPortal(
  options: Readonly<{
    publicUrl: string;
    /** At least `MIN_SESSION_SECRET_LENGTH` characters; see `parseSessionSecret`. */
    sessionSecret: string;
    providers: readonly IdentityProvider[];
    directory: AccountDirectory;
    eraser: AccountEraser;
    now: () => Date;
    /** URL-safe, at least 128 bits: the CSRF token is drawn from it. */
    randomToken: () => string;
    warn: (message: string) => void;
  }>,
): AccountPortal {
  const { publicUrl, sessionSecret, directory, eraser, now, randomToken, warn } = options;
  const providers = new Map(options.providers.map((provider) => [provider.name, provider]));
  const pendingSignIns = new Map<string, Readonly<{ pending: PendingSignIn; expiresAtMs: number }>>();

  const sessions = sessionCodec({ secret: sessionSecret });

  async function route(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const method = request.method ?? "GET";
    const [, section, providerName, extra] = path.slice(1).split("/");
    const target = parseRoute({ section, providerName, extra });
    switch (target.kind) {
      case "home":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return home(request, response);
      case "login":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return login(response, target.provider);
      case "callback":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return callback(request, response, target.provider);
      case "erase":
        if (method !== "POST") return sendMethodNotAllowed({ response, allow: "POST" });
        return erase(request, response);
      case "logout":
        if (method !== "POST") return sendMethodNotAllowed({ response, allow: "POST" });
        return logout(request, response);
      case "not-found":
        return sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "There is no such page." }) });
      default:
        return assertNever(target);
    }
  }

  async function home(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = sessions.read({ request, nowMs: now().getTime() });
    const description = session === null ? null : await directory.describe({ accountId: session.accountId });
    if (session === null || description === null) {
      sendPage({
        response,
        status: 200,
        html: signedOutPage({ providers: [...providers.values()] }),
        // An erased account's session is cleared, not left to linger for its 15 minutes.
        cookies: session === null ? [] : [clearCookie({ name: SESSION_COOKIE_NAME, path: ACCOUNT_PATH })],
      });
      return;
    }
    sendPage({
      response,
      status: 200,
      html: signedInPage({ links: description.links, providers, csrf: session.csrf }),
    });
  }

  async function login(response: ServerResponse, providerName: string): Promise<void> {
    const provider = providers.get(providerName);
    if (provider === undefined) {
      sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "That sign-in option is not available." }) });
      return;
    }
    const begun = await provider.begin({ redirectUri: accountCallbackUrl({ publicUrl, provider: provider.name }) });
    if (begun.kind === "failed") {
      warn(`account portal: cannot start ${provider.name} sign-in: ${begun.reason}`);
      sendPage({
        response,
        status: 502,
        html: messagePage({ title: "Sign-in is unavailable", message: `We could not reach ${provider.displayName}. Please try again in a moment.` }),
      });
      return;
    }
    rememberPendingSignIn(begun.pending);
    sendRedirect({
      response,
      status: 302,
      location: begun.location,
      cookies: [
        setCookie({
          name: SIGNIN_COOKIE_NAME,
          value: begun.pending.state,
          path: `${ACCOUNT_PATH}/callback`,
          maxAgeSeconds: PENDING_SIGNIN_LIFETIME_MS / 1000,
        }),
      ],
    });
  }

  function rememberPendingSignIn(pending: PendingSignIn): void {
    const nowMs = now().getTime();
    for (const [state, entry] of pendingSignIns) {
      if (entry.expiresAtMs <= nowMs) pendingSignIns.delete(state);
    }
    // Bounds memory against someone hammering /account/login; the oldest entries go first.
    while (pendingSignIns.size >= MAX_PENDING_SIGNINS) {
      const oldest = pendingSignIns.keys().next();
      if (oldest.done === true) break;
      pendingSignIns.delete(oldest.value);
    }
    pendingSignIns.set(pending.state, { pending, expiresAtMs: nowMs + PENDING_SIGNIN_LIFETIME_MS });
  }

  async function callback(request: IncomingMessage, response: ServerResponse, providerName: string): Promise<void> {
    const provider = providers.get(providerName);
    if (provider === undefined) {
      sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "That sign-in option is not available." }) });
      return;
    }
    const parameters = new URLSearchParams(requestQuery(request));
    const state = parameters.get("state");
    const boundState = cookieOf({ request, name: SIGNIN_COOKIE_NAME });
    const entry = state === null ? undefined : pendingSignIns.get(state);
    // Taken on first sight, so a replay finds nothing whatever happens below.
    if (state !== null) pendingSignIns.delete(state);
    const clearSignIn = clearCookie({ name: SIGNIN_COOKIE_NAME, path: `${ACCOUNT_PATH}/callback` });
    if (
      state === null ||
      boundState === null ||
      !constantTimeEqual(state, boundState) ||
      entry === undefined ||
      entry.expiresAtMs <= now().getTime() ||
      entry.pending.provider !== provider.name
    ) {
      sendPage({
        response,
        status: 400,
        html: messagePage({
          title: "Please sign in again",
          message: "This sign-in link has expired, was already used, or was opened in a different browser.",
          action: { href: ACCOUNT_PATH, label: "Start again" },
        }),
        cookies: [clearSignIn],
      });
      return;
    }
    const outcome = await provider.complete({
      pending: entry.pending,
      parameters,
      redirectUri: accountCallbackUrl({ publicUrl, provider: provider.name }),
    });
    if (outcome.kind === "failed") {
      warn(`account portal: ${provider.name} sign-in failed: ${outcome.reason}`);
      sendPage({
        response,
        status: 400,
        html: messagePage({
          title: "Sign-in did not complete",
          message: `${provider.displayName} did not confirm who you are, so you are not signed in.`,
          action: { href: ACCOUNT_PATH, label: "Try again" },
        }),
        cookies: [clearSignIn],
      });
      return;
    }
    const { identity } = outcome;
    const accountId = await directory.findOrCreateByIdentity({
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email,
    });
    sendRedirect({
      response,
      status: 303,
      location: ACCOUNT_PATH,
      cookies: [clearSignIn, sessions.issue({ accountId, nowMs: now().getTime(), csrf: randomToken() })],
    });
  }

  async function erase(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readVerifiedForm(request, response);
    if (form === null) return;
    if (form.fields.get("confirm") !== "yes") {
      sendPage({
        response,
        status: 400,
        html: messagePage({
          title: "Nothing was deleted",
          message: "Tick the box to confirm you understand this cannot be undone, then try again.",
          action: { href: ACCOUNT_PATH, label: "Back to your account" },
        }),
      });
      return;
    }
    let report: EraseReport;
    try {
      report = await eraser.eraseAccount({ accountId: form.accountId });
    } catch (cause) {
      warn(`account portal: erasing an account failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      sendPage({
        response,
        status: 500,
        html: messagePage({
          title: "We could not finish deleting your data",
          message: "Something went wrong on our side. Please try again; if it keeps failing, contact sasha.slides@exponent.company.",
          action: { href: ACCOUNT_PATH, label: "Back to your account" },
        }),
      });
      return;
    }
    sendPage({
      response,
      status: 200,
      html: erasedPage({ report }),
      cookies: [clearCookie({ name: SESSION_COOKIE_NAME, path: ACCOUNT_PATH })],
    });
  }

  async function logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (sessions.read({ request, nowMs: now().getTime() }) === null) {
      sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: [clearCookie({ name: SESSION_COOKIE_NAME, path: ACCOUNT_PATH })] });
      return;
    }
    const form = await readVerifiedForm(request, response);
    if (form === null) return;
    sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: [clearCookie({ name: SESSION_COOKIE_NAME, path: ACCOUNT_PATH })] });
  }

  /**
   * The shared gate of both POSTs: a form body, a live session, and that session's CSRF
   * token. Answers the request itself and returns null when any of them is missing.
   */
  async function readVerifiedForm(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<Readonly<{ accountId: AccountId; fields: URLSearchParams }> | null> {
    if (mediaTypeOf(request) !== "application/x-www-form-urlencoded") {
      sendPage({ response, status: 415, html: messagePage({ title: "Unsupported request", message: "This form must be sent by the account page." }) });
      return null;
    }
    const body = await readBody(request);
    if (body === null) {
      sendPage({ response, status: 413, html: messagePage({ title: "Request too large", message: "This form must be sent by the account page." }) });
      return null;
    }
    const session = sessions.read({ request, nowMs: now().getTime() });
    if (session === null) {
      sendPage({
        response,
        status: 401,
        html: messagePage({
          title: "Your session has ended",
          message: "For your safety, sessions last 15 minutes. Sign in again to continue; nothing was changed.",
          action: { href: ACCOUNT_PATH, label: "Sign in again" },
        }),
      });
      return null;
    }
    const fields = new URLSearchParams(body);
    const csrf = fields.get("csrf");
    if (csrf === null || !constantTimeEqual(csrf, session.csrf)) {
      sendPage({
        response,
        status: 403,
        html: messagePage({
          title: "Nothing was changed",
          message: "This request did not come from your account page. Open the page again and retry.",
          action: { href: ACCOUNT_PATH, label: "Back to your account" },
        }),
      });
      return null;
    }
    return { accountId: session.accountId, fields };
  }

  return {
    providerNames: options.providers.map((provider) => provider.name),
    handleRequest: async ({ request, response, url }) => {
      const path = url.pathname.replace(/\/+$/, "");
      if (path !== ACCOUNT_PATH && !path.startsWith(`${ACCOUNT_PATH}/`)) return false;
      await route(request, response, path);
      return true;
    },
  };
}

/** Escapes text for an HTML element body or a double- or single-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------- routing

type PortalRoute =
  | Readonly<{ kind: "home" }>
  | Readonly<{ kind: "login"; provider: string }>
  | Readonly<{ kind: "callback"; provider: string }>
  | Readonly<{ kind: "erase" }>
  | Readonly<{ kind: "logout" }>
  | Readonly<{ kind: "not-found" }>;

const MAX_PENDING_SIGNINS = 10_000;
const MAX_FORM_BYTES = 8 * 1024;

function parseRoute(
  options: Readonly<{ section: string | undefined; providerName: string | undefined; extra: string | undefined }>,
): PortalRoute {
  const { section, providerName, extra } = options;
  if (section === undefined) return { kind: "home" };
  if (extra !== undefined) return { kind: "not-found" };
  if ((section === "login" || section === "callback") && providerName !== undefined && providerName !== "") {
    return section === "login" ? { kind: "login", provider: providerName } : { kind: "callback", provider: providerName };
  }
  if (providerName !== undefined) return { kind: "not-found" };
  if (section === "erase") return { kind: "erase" };
  if (section === "logout") return { kind: "logout" };
  return { kind: "not-found" };
}

function requestQuery(request: IncomingMessage): string {
  const raw = request.url ?? "";
  const question = raw.indexOf("?");
  return question < 0 ? "" : raw.slice(question + 1);
}

// ---------------------------------------------------------------- session cookie

type Session = Readonly<{ accountId: AccountId; expiresAtMs: number; csrf: string }>;

type SessionCodec = Readonly<{
  issue(options: Readonly<{ accountId: AccountId; nowMs: number; csrf: string }>): string;
  read(options: Readonly<{ request: IncomingMessage; nowMs: number }>): Session | null;
}>;

function sessionCodec(options: Readonly<{ secret: string }>): SessionCodec {
  const mac = (payload: string): string => createHmac("sha256", options.secret).update(payload).digest("base64url");
  return {
    issue: ({ accountId, nowMs, csrf }) => {
      const payload = Buffer.from(JSON.stringify({ accountId, exp: nowMs + SESSION_LIFETIME_MS, csrf }), "utf-8").toString("base64url");
      return setCookie({
        name: SESSION_COOKIE_NAME,
        value: `${payload}.${mac(payload)}`,
        path: ACCOUNT_PATH,
        maxAgeSeconds: SESSION_LIFETIME_MS / 1000,
      });
    },
    read: ({ request, nowMs }) => {
      const value = cookieOf({ request, name: SESSION_COOKIE_NAME });
      if (value === null) return null;
      const [payload, signature, extra] = value.split(".");
      if (payload === undefined || signature === undefined || extra !== undefined) return null;
      if (!constantTimeEqual(signature, mac(payload))) return null;
      const parsed = parseJson(Buffer.from(payload, "base64url").toString("utf-8"));
      const claims = parsed.kind === "ok" ? asRecord(parsed.value) : null;
      const accountId = asString(claims?.accountId);
      const csrf = asString(claims?.csrf);
      const expiresAtMs = claims?.exp;
      if (accountId === null || csrf === null || typeof expiresAtMs !== "number") return null;
      if (expiresAtMs <= nowMs) return null;
      return { accountId, expiresAtMs, csrf };
    },
  };
}

function setCookie(options: Readonly<{ name: string; value: string; path: string; maxAgeSeconds: number }>): string {
  return `${options.name}=${options.value}; Path=${options.path}; Max-Age=${String(options.maxAgeSeconds)}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(options: Readonly<{ name: string; path: string }>): string {
  return `${options.name}=; Path=${options.path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function cookieOf(options: Readonly<{ request: IncomingMessage; name: string }>): string | null {
  const header = options.request.headers.cookie;
  if (header === undefined) return null;
  for (const pair of header.split(/;\s*/)) {
    const equals = pair.indexOf("=");
    if (equals > 0 && pair.slice(0, equals) === options.name) return pair.slice(equals + 1);
  }
  return null;
}

/** Compares digests, so neither the length nor the content of the secret leaks by timing. */
function constantTimeEqual(left: string, right: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text, "utf-8").digest();
  return timingSafeEqual(digest(left), digest(right));
}

// ---------------------------------------------------------------- request bodies

function mediaTypeOf(request: IncomingMessage): string | null {
  const header = request.headers["content-type"];
  if (typeof header !== "string") return null;
  return header.split(";")[0]?.trim().toLowerCase() ?? null;
}

/** The body as text, or null when it exceeds `MAX_FORM_BYTES`. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_FORM_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    request.on("error", reject);
  });
}

// ---------------------------------------------------------------- responses

const STYLE = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--panel:#f5f5f7;--link:#0066cc;--danger:#c4161c;--sans:"Helvetica Neue",Helvetica,Arial,system-ui,-apple-system,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--muted:#a1a1a6;--line:#2c2c2e;--panel:#111113;--link:#2997ff;--danger:#ff453a;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:4px}
.bar{border-bottom:1px solid var(--line)}
.bar-inner,.wrap{max-width:560px;margin:0 auto;padding-inline:16px}
.bar-inner{display:flex;align-items:center;height:52px}
.brand{color:var(--fg);font-weight:600;letter-spacing:-.01em;display:inline-flex;align-items:center;gap:10px}
.brand svg{width:26px;height:26px}
.wrap{padding-block:48px 80px}
h1{font-size:clamp(28px,6vw,40px);letter-spacing:-.03em;line-height:1.1;margin:0 0 12px;font-weight:600}
h2{font-size:20px;letter-spacing:-.015em;margin:36px 0 8px;font-weight:600}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.providers{display:grid;gap:12px;margin-top:28px}
.button,button{display:block;width:100%;padding:13px 18px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font:inherit;font-weight:500;text-align:center;cursor:pointer}
.button:hover{text-decoration:none;border-color:var(--muted)}
.button{display:flex;align-items:center;justify-content:center;gap:12px}
.button .mark{width:20px;height:20px;flex:none}
button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
button.quiet{display:inline;width:auto;padding:0;border:0;background:none;color:var(--link);font-weight:400}
ul.links{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}
ul.links li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:12px 0;border-bottom:1px solid var(--line)}
.hint{color:var(--muted);word-break:break-all}
label.confirm{display:flex;gap:10px;align-items:flex-start;margin:16px 0}
label.confirm input{flex:none;width:18px;height:18px;margin-top:4px}
form.signout{margin-top:32px}
`;

/** The CSP admits exactly this stylesheet and no script, so no `'unsafe-inline'` is needed. */
const STYLE_HASH = `'sha256-${createHash("sha256").update(STYLE, "utf-8").digest("base64")}'`;

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src ${STYLE_HASH}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Keeps the callback's code and state out of any Referer a later navigation sends.
  "referrer-policy": "no-referrer",
};

function sendPage(
  options: Readonly<{ response: ServerResponse; status: number; html: string; cookies?: readonly string[] }>,
): void {
  const { response, status, html, cookies } = options;
  response.writeHead(status, {
    ...PAGE_HEADERS,
    "content-length": String(Buffer.byteLength(html, "utf-8")),
    ...(cookies === undefined || cookies.length === 0 ? {} : { "set-cookie": [...cookies] }),
  });
  response.end(html);
}

function sendRedirect(
  options: Readonly<{ response: ServerResponse; status: 302 | 303; location: string; cookies: readonly string[] }>,
): void {
  options.response.writeHead(options.status, {
    location: options.location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...(options.cookies.length === 0 ? {} : { "set-cookie": [...options.cookies] }),
  });
  options.response.end();
}

function sendMethodNotAllowed(options: Readonly<{ response: ServerResponse; allow: string }>): void {
  const html = messagePage({ title: "Not allowed", message: "This page does not accept that kind of request." });
  options.response.writeHead(405, {
    ...PAGE_HEADERS,
    allow: options.allow,
    "content-length": String(Buffer.byteLength(html, "utf-8")),
  });
  options.response.end(html);
}

// ---------------------------------------------------------------- pages

function layout(options: Readonly<{ title: string; main: string }>): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} · Sasha Slides</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar"><div class="bar-inner"><a class="brand" href="https://sashaslides.com/">${SASHA_ICON_SVG}Sasha Slides</a></div></header>
<main class="wrap">
${options.main}
</main>
</body>
</html>
`;
}

function signedOutPage(options: Readonly<{ providers: readonly IdentityProvider[] }>): string {
  const buttons = options.providers
    .map(
      (provider) =>
        `<a class="button" href="${escapeHtml(`${ACCOUNT_PATH}/login/${encodeURIComponent(provider.name)}`)}">${providerMark(provider.name)}Continue with ${escapeHtml(provider.displayName)}</a>`,
    )
    .join("\n");
  return layout({
    title: "Your account",
    main: `<h1>Sign in to manage your Sasha Slides data</h1>
<p class="muted">Use the same sign-in you use with Sasha Slides. You can then see what is linked to your account and delete your data.</p>
<nav class="providers" aria-label="Sign-in options">
${buttons}
</nav>`,
  });
}

function signedInPage(
  options: Readonly<{ links: readonly LinkedSignIn[]; providers: ReadonlyMap<string, IdentityProvider>; csrf: string }>,
): string {
  const { links, providers, csrf } = options;
  const items = links
    .map((link) => {
      const name = providers.get(link.provider)?.displayName ?? link.provider;
      const hint = link.emailHint === null ? "" : `<span class="hint">${escapeHtml(link.emailHint)}</span>`;
      return `<li><span>${escapeHtml(name)}</span>${hint}</li>`;
    })
    .join("\n");
  const csrfField = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  return layout({
    title: "Your account",
    main: `<h1>Your Sasha Slides account</h1>
<h2>Signed in with</h2>
<ul class="links">
${items}
</ul>
<h2>Delete your data</h2>
<p>Everything Sasha Slides keeps about you — your sign-ins, your Google connection, and data kept to improve the service — is encrypted with a key that belongs to your account alone.</p>
<p>Resetting that key makes all of it unreadable at once, including copies in backups. We also ask Google to remove Sasha Slides' access. Your slides stay in your own Google Drive.</p>
<form method="post" action="${ACCOUNT_PATH}/erase">
${csrfField}
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required> <span>I understand this deletes my Sasha Slides data and cannot be undone.</span></label>
<button type="submit" class="danger">Reset my key and delete my data</button>
</form>
<form class="signout" method="post" action="${ACCOUNT_PATH}/logout">
${csrfField}
<button type="submit" class="quiet">Sign out</button>
</form>`,
  });
}

function erasedPage(options: Readonly<{ report: EraseReport }>): string {
  const permissionsLink = `<a href="${GOOGLE_PERMISSIONS_URL}">myaccount.google.com/permissions</a>`;
  const google = options.report.googleTokenRevoked
    ? `<p>Google access was revoked. You can confirm that Sasha Slides is gone at ${permissionsLink}.</p>`
    : `<p>We could not revoke Google access, or there was no Google connection to revoke. To be sure, remove Sasha Slides at ${permissionsLink}.</p>`;
  return layout({
    title: "Your data has been deleted",
    main: `<h1>Your data has been deleted.</h1>
<p>Your key was reset, so anything stored before now can no longer be read — including in backups.</p>
${google}
<p class="muted">You have been signed out. Signing in again starts a new, empty account.</p>`,
  });
}

function messagePage(
  options: Readonly<{ title: string; message: string; action?: Readonly<{ href: string; label: string }> }>,
): string {
  const action =
    options.action === undefined ? "" : `<p><a href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a></p>`;
  return layout({
    title: options.title,
    main: `<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.message)}</p>
${action}`,
  });
}
