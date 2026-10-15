/**
 * `/comments/allow?deck=<fileId>`: the one-time page where a Sasha user lets Sasha read and
 * answer the comments on ONE deck, as themselves. `watch_comments` hands its link to the session
 * when the user's Google grant cannot read the deck yet (`comment-bot.ts`, `needs-access`).
 *
 * WHY A PICKER. The grant holds `drive.file` (least privilege: Drive has no comments-only scope,
 * and the full `drive` scope is restricted and reads every file). Under `drive.file` a file
 * becomes reachable when the person chooses it in the Google Picker opened by this app, so the
 * page opens the picker preset to the one deck (`setFileIds`), with the person's own access
 * token and the OAuth client's project number as the app id. One pick, one deck.
 *
 *   GET /comments/allow?deck=<id>      -> 302 to Google: `openid email drive.file`,
 *                                          `include_granted_scopes=true`; a silent bounce when
 *                                          drive.file is already granted (sign-in asks for it),
 *                                          the incremental consent for drive.file alone when not
 *   GET <google callback>?state&code    -> verify who signed in, merge the fresh token and scopes
 *                                          into their stored grant, answer the picker page
 *   GET /comments/allow/picker.js       -> the picker script (`access-browser/picker.ts`)
 *
 * SIGNED-IN USERS ONLY, AND WHO. Google itself identifies the person on every visit: the
 * picker needs THAT Google account's token anyway, and the `/account` session cookie is scoped
 * to `Path=/account` (`http/account-portal.ts`), so it never reaches this path. A Google account
 * with no grant stored by the connector (never signed in to Sasha Slides) is refused.
 *
 * The callback is the connector's one registered Google redirect URI (shared with the MCP sign-in
 * and the Google Slides connect flow); this module answers it only for a `state` it issued and
 * resolves false otherwise, like `google-slides/google-slides-interchange.ts`. Login CSRF: the
 * state is also a short-lived cookie scoped to the callback path, and the two must match.
 *
 * The picker page carries the person's access token (the picker needs it in the browser), so it
 * is `no-store`, `no-referrer`, and its Content-Security-Policy admits only this server's script
 * and Google's picker origins.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GoogleClientCredentials } from "../google-auth";
import { escapeHtml } from "../http/account-portal";
import type { GoogleIdentity, RecordStore } from "../http/oauth-store";
import { SASHA_ICON_SVG } from "../http/sasha-icon.generated";
import { DRIVE_FILE_SCOPE, scopeAccessOf } from "./owner-drive";
import { parseDeckId } from "./comment-bot";
import { PICKER_SCRIPT } from "./picker-script.generated";

export const COMMENTS_ALLOW_PATH = "/comments/allow";
export const PICKER_SCRIPT_PATH = `${COMMENTS_ALLOW_PATH}/picker.js`;
export const ALLOW_STATE_COOKIE_NAME = "sasha_comments_state";
export const ALLOW_STATE_LIFETIME_MS = 10 * 60 * 1000;
/** Exactly what the page asks Google for: identity, and drive.file. Never the full `drive` scope. */
export const ALLOW_SCOPES: readonly string[] = ["openid", "email", DRIVE_FILE_SCOPE];
export const GOOGLE_CONSENT_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Google's loader for the picker (https://developers.google.com/drive/picker). */
export const GOOGLE_API_LOADER_URL = "https://apis.google.com/js/api.js";

export type CommentAccessPage = Readonly<{
  /** Answers `/comments/allow*` and the shared Google callback for its own states; false otherwise. */
  handleRequest(options: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL }>): Promise<boolean>;
}>;

/** A Google sign-in finished on the callback: who it was and what Google granted. */
export type GoogleSignInResult =
  | Readonly<{
      kind: "ok";
      subject: string;
      email: string | null;
      accessToken: string;
      refreshToken: string | null;
      accessTokenExpiresAtMs: number;
      grantedScopes: readonly string[];
    }>
  | Readonly<{ kind: "failed"; reason: string }>;

/** The code exchange plus the identity token's verification; `comment-bot-stack.ts` builds the real one. */
export type GoogleSignIn = Readonly<{
  finish(options: Readonly<{ code: string; redirectAddress: string }>): Promise<GoogleSignInResult>;
}>;

/** The picker's browser key: a Google Cloud API key with the Picker API, restricted to this site. */
export type PickerSettings = Readonly<{ apiKey: string; appId: string }>;

/** The page link `watch_comments` hands out. */
export function allowUrlFor(options: Readonly<{ publicUrl: string; fileId: string }>): string {
  return `${options.publicUrl.replace(/\/+$/, "")}${COMMENTS_ALLOW_PATH}?deck=${encodeURIComponent(options.fileId)}`;
}

/**
 * The picker's app id is the Cloud project NUMBER, which Google puts in front of every OAuth
 * client id (`<number>-<suffix>.apps.googleusercontent.com`). Null for an id without one.
 */
export function projectNumberOf(clientId: string): string | null {
  const prefix = clientId.split("-")[0] ?? "";
  return /^\d{6,}$/.test(prefix) ? prefix : null;
}

export function createCommentAccessPage(
  options: Readonly<{
    publicUrl: string;
    /** The connector's registered Google redirect URI (`Endpoints.googleCallbackUrl`). */
    googleCallbackUrl: string;
    googleClient: GoogleClientCredentials;
    /** Null: the page explains that the picker is not configured on this server. */
    picker: PickerSettings | null;
    grants: Pick<RecordStore<GoogleIdentity>, "get" | "put">;
    signIn: GoogleSignIn;
    now: () => Date;
    /** URL-safe, at least 128 bits: the OAuth state. */
    randomToken: () => string;
    warn: (message: string) => void;
  }>,
): CommentAccessPage {
  const { googleCallbackUrl, googleClient, picker, grants, signIn, now, randomToken, warn } = options;
  const origin = new URL(options.publicUrl).origin;
  const callbackPath = new URL(googleCallbackUrl).pathname;
  const pending = new Map<string, Readonly<{ fileId: string; expiresAtMs: number }>>();

  function begin(request: Readonly<{ response: ServerResponse; url: URL }>): void {
    const { response, url } = request;
    const fileId = parseDeckId(url.searchParams.get("deck") ?? "");
    if (fileId === null) {
      sendPage({ response, status: 400, html: messagePage({ title: "Not a deck", message: "This link does not name a Google Slides deck. Ask your assistant for the link again." }) });
      return;
    }
    if (picker === null) {
      sendPage({
        response,
        status: 503,
        html: messagePage({ title: "Not available yet", message: "Choosing a deck for Sasha is not set up on this server yet. Please try again later." }),
      });
      return;
    }
    const nowMs = now().getTime();
    for (const [key, entry] of pending) if (entry.expiresAtMs <= nowMs) pending.delete(key);
    if (pending.size >= MAX_PENDING) {
      sendPage({ response, status: 503, html: messagePage({ title: "Busy", message: "Too many people are doing this at once. Please try again in a minute." }) });
      return;
    }
    const state = randomToken();
    pending.set(state, { fileId, expiresAtMs: nowMs + ALLOW_STATE_LIFETIME_MS });
    const consent = new URL(GOOGLE_CONSENT_URL);
    consent.search = new URLSearchParams({
      client_id: googleClient.clientId,
      redirect_uri: googleCallbackUrl,
      response_type: "code",
      scope: ALLOW_SCOPES.join(" "),
      state,
      // Keeps every scope granted at sign-in; Google asks only for what is new (drive.file at most).
      include_granted_scopes: "true",
      // A new refresh token when Google issues one; the stored one is kept otherwise.
      access_type: "offline",
    }).toString();
    response.writeHead(302, {
      location: consent.toString(),
      "cache-control": "no-store",
      "set-cookie": `${ALLOW_STATE_COOKIE_NAME}=${state}; Path=${callbackPath}; Max-Age=${String(ALLOW_STATE_LIFETIME_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
    });
    response.end();
  }

  async function finish(request: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL }>): Promise<boolean> {
    const { response, url } = request;
    const state = url.searchParams.get("state");
    if (state === null) return false;
    const started = pending.get(state);
    if (started === undefined) return false;
    pending.delete(state);
    const retry = allowUrlFor({ publicUrl: options.publicUrl, fileId: started.fileId });
    const cookies = [`${ALLOW_STATE_COOKIE_NAME}=; Path=${callbackPath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`];
    if (started.expiresAtMs <= now().getTime()) {
      sendPage({ response, status: 400, cookies, html: messagePage({ title: "Link expired", message: "That took too long.", retry }) });
      return true;
    }
    if (!cookieValues({ request: request.request, name: ALLOW_STATE_COOKIE_NAME }).includes(state)) {
      sendPage({ response, status: 400, cookies, html: messagePage({ title: "Start again", message: "This page was opened in a different browser from the one that started it.", retry }) });
      return true;
    }
    const code = url.searchParams.get("code");
    if (code === null) {
      sendPage({ response, status: 200, cookies, html: messagePage({ title: "Nothing changed", message: "Google was not asked to let Sasha in, so nothing changed.", retry }) });
      return true;
    }
    const signedIn = await signIn.finish({ code, redirectAddress: googleCallbackUrl });
    if (signedIn.kind === "failed") {
      warn(`comment access: Google sign-in failed: ${signedIn.reason}`);
      sendPage({ response, status: 502, cookies, html: messagePage({ title: "Google did not answer", message: "Signing in with Google did not finish.", retry }) });
      return true;
    }
    const stored = await grants.get({ key: signedIn.subject });
    if (stored === null) {
      sendPage({
        response,
        status: 403,
        cookies,
        html: messagePage({
          title: "Sign in to Sasha Slides first",
          message:
            "This Google account has not connected Sasha Slides yet. Connect Sasha Slides to your assistant with this Google " +
            "account, then open the link again.",
          retry,
        }),
      });
      return true;
    }
    const grantedScopes = signedIn.grantedScopes.length > 0 ? signedIn.grantedScopes : stored.grantedScopes;
    await grants.put({
      key: signedIn.subject,
      value: {
        ...stored,
        email: signedIn.email ?? stored.email,
        accessToken: signedIn.accessToken,
        // Google sends a refresh token only on some consents; the stored one stays otherwise.
        refreshToken: signedIn.refreshToken ?? stored.refreshToken,
        accessTokenExpiresAtMs: signedIn.accessTokenExpiresAtMs,
        grantedScopes,
      },
    });
    if (scopeAccessOf(grantedScopes) === "missing" || picker === null) {
      sendPage({
        response,
        status: 200,
        cookies,
        html: messagePage({
          title: "Access was not given",
          message: "Google did not give Sasha access to the files you choose. Open the link again and allow it when Google asks.",
          retry,
        }),
      });
      return true;
    }
    sendPage({
      response,
      status: 200,
      cookies,
      html: pickerPage({ picker, fileId: started.fileId, accessToken: signedIn.accessToken, email: signedIn.email ?? stored.email, scriptUrl: `${origin}${PICKER_SCRIPT_PATH}` }),
      policy: pickerPolicy({ scriptUrl: `${origin}${PICKER_SCRIPT_PATH}` }),
    });
    return true;
  }

  return {
    handleRequest: async ({ request, response, url }) => {
      const method = request.method ?? "GET";
      const path = url.pathname.replace(/\/+$/, "");
      if (path === callbackPath) return method === "GET" ? finish({ request, response, url }) : false;
      if (path === PICKER_SCRIPT_PATH && method === "GET") {
        sendScript(response);
        return true;
      }
      if (path !== COMMENTS_ALLOW_PATH) return false;
      if (method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();
        return true;
      }
      begin({ response, url });
      return true;
    },
  };
}

/** At most this many sign-ins waiting for Google's answer at once; each lives 10 minutes. */
const MAX_PENDING = 10_000;

/** The stylesheet of `/account` ("Tidepool"), repeated here because the portal does not export it. */
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
p{margin:0 0 12px}
.muted{color:var(--muted)}
.button,button{display:block;width:100%;margin-top:28px;padding:13px 18px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font:inherit;font-weight:500;text-align:center;cursor:pointer}
.button:hover{text-decoration:none;border-color:var(--muted)}
button:disabled{cursor:default;opacity:.6}
.status{margin-top:16px}
.status.done{font-weight:500}
[hidden]{display:none!important}
`;

const STYLE_HASH = `'sha256-${createHash("sha256").update(STYLE, "utf-8").digest("base64")}'`;

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src ${STYLE_HASH}; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Keeps the callback's code and state out of any Referer a later navigation sends.
  "referrer-policy": "no-referrer",
};

/**
 * The picker page's policy. Google's loader pulls further scripts from apis.google.com and the
 * picker runs in a docs.google.com frame that styles its own overlay inline, so styles allow
 * `'unsafe-inline'` (no user text is ever interpolated unescaped); scripts stay limited to this
 * server's one file and Google's loader origin.
 */
function pickerPolicy(options: Readonly<{ scriptUrl: string }>): string {
  return [
    "default-src 'none'",
    `script-src ${options.scriptUrl} https://apis.google.com https://www.gstatic.com`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src https://*.googleusercontent.com https://ssl.gstatic.com https://www.gstatic.com https://drive-thirdparty.googleusercontent.com data:",
    "frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com",
    "connect-src https://apis.google.com https://content.googleapis.com https://www.googleapis.com",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function sendPage(
  options: Readonly<{ response: ServerResponse; status: number; html: string; cookies?: readonly string[]; policy?: string }>,
): void {
  const cookies = options.cookies ?? [];
  options.response.writeHead(options.status, {
    ...PAGE_HEADERS,
    ...(options.policy === undefined ? {} : { "content-security-policy": options.policy }),
    ...(cookies.length === 0 ? {} : { "set-cookie": [...cookies] }),
  });
  options.response.end(options.html);
}

function sendScript(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": String(Buffer.byteLength(PICKER_SCRIPT, "utf-8")),
    // Revalidated on every page load, so a deploy is picked up at once.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  response.end(PICKER_SCRIPT);
}

function layout(options: Readonly<{ title: string; main: string; head?: string }>): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} · Sasha Slides</title>
<style>${STYLE}</style>${options.head ?? ""}
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

function messagePage(options: Readonly<{ title: string; message: string; retry?: string }>): string {
  const retry = options.retry === undefined ? "" : `\n<a class="button" href="${escapeHtml(options.retry)}">Try again</a>`;
  return layout({ title: options.title, main: `<h1>${escapeHtml(options.title)}</h1>\n<p>${escapeHtml(options.message)}</p>${retry}` });
}

function pickerPage(
  options: Readonly<{ picker: PickerSettings; fileId: string; accessToken: string; email: string | null; scriptUrl: string }>,
): string {
  const who = options.email === null ? "you" : `you (${options.email})`;
  return layout({
    title: "Let Sasha answer comments",
    head: `\n<script src="${escapeHtml(options.scriptUrl)}" defer></script>`,
    main: `<h1>Let Sasha answer the comments on this deck</h1>
<p>Choose the deck in Google's window. That lets Sasha read and answer the comments on this one deck, as ${escapeHtml(who)}, starting each line with &ldquo;Sasha:&rdquo;. Nothing else in your Drive.</p>
<div data-picker data-token="${escapeHtml(options.accessToken)}" data-key="${escapeHtml(options.picker.apiKey)}" data-app="${escapeHtml(options.picker.appId)}" data-deck="${escapeHtml(options.fileId)}" data-loader="${escapeHtml(GOOGLE_API_LOADER_URL)}">
<button type="button" data-open disabled>Choose the deck</button>
<p class="status muted" data-status role="status">Opening Google&rsquo;s file picker&hellip;</p>
</div>`,
  });
}

function cookieValues(options: Readonly<{ request: IncomingMessage; name: string }>): readonly string[] {
  const header = options.request.headers.cookie;
  if (header === undefined) return [];
  return header.split(/;\s*/u).flatMap((pair) => {
    const equals = pair.indexOf("=");
    return equals > 0 && pair.slice(0, equals) === options.name ? [pair.slice(equals + 1)] : [];
  });
}
