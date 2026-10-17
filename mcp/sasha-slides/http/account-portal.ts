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
 *   POST /account/callback/<provider> the same, for a provider that answers by form POST
 *                                     (Apple); each provider's callback takes one method
 *   POST /account/erase               session + CSRF token + confirmation → eraser
 *   POST /account/logout              session + CSRF token → clear the session
 *   GET  /account/deck-session?return=<path>   the deck web application's session (SPEC.md
 *                                     21.2): signed in, set the `sasha_deck` cookie and 303 to the
 *                                     validated return path (`/decks` or `/deck/<id>`); signed out,
 *                                     remember the path in a 10-minute `sasha_return` cookie and
 *                                     send the browser to sign in -- after ANY sign-in method
 *                                     `/account` sends it back here
 *   GET  /account/link/<provider>?token=…   signed in, with a sign-in from the last 10 minutes:
 *                                     → 302 to the provider in LINK mode; its callback (the same
 *                                     `/account/callback/<provider>`) attaches the identity to
 *                                     this account instead of signing in
 *   GET  /account/link-complete       the second half of a link (see "Linking" below)
 *   POST /account/unlink              session + CSRF token + `link` id → remove one sign-in
 *   GET  /account/passkey.js          the passkey script (`passkey-browser/passkey.ts`)
 *   POST /account/passkey/<ceremony>/options   a fresh challenge, bound to this browser
 *   POST /account/passkey/<ceremony>/verify    check the authenticator's answer (`webauthn.ts`)
 *                                     and set the session; <ceremony> is `create` (a new
 *                                     account), `signin`, or `add` (session + CSRF token)
 *
 * With `--mail-sender` configured, email and password sign-in as well (rules and their
 * defences in `password-sign-in.ts`):
 *
 *   GET|POST /account/email/signup    form → mail a confirmation link
 *   POST     /account/email/signin    (the form is on the signed-out /account page)
 *   GET|POST /account/email/verify    the mailed link → a confirm button → signed in
 *   GET|POST /account/email/forgot    form → mail a reset link
 *   GET|POST /account/email/reset     the mailed link → a new-password form → signed in
 *   GET|POST /account/email/add       signed in: address + password → mail a link
 *   GET|POST /account/email/link      the mailed link → a confirm button → the address is added
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
 *    For a provider that answers by form POST (Apple) that cookie is `SameSite=None`: the
 *    POST comes from the provider's site, and a Lax cookie is not sent on a cross-site POST,
 *    so with Lax every Apple sign-in would read as "opened in a different browser". This
 *    does not weaken the check. The cookie is HttpOnly, Secure, lives 10 minutes, is scoped to
 *    that one provider's callback path, and only holds the random `state`; a forged POST
 *    carries the attacker's state, which never equals the victim's cookie. The session
 *    cookie the callback then sets stays Lax: a cookie may be set on the response to a
 *    cross-site top-level POST, and the 303 that follows is a top-level GET, which carries
 *    Lax cookies.
 *  - **Replay.** A pending sign-in is taken out of the map on first use, whatever the
 *    outcome, and is bound to the provider it was started for.
 *  - **Cross-site request forgery before a session exists** (a page elsewhere posting the
 *    sign-in or sign-up form, e.g. to sign the victim in as the attacker). Every email form
 *    carries `HMAC(session secret, form cookie)`, and the form cookie is a random value in a
 *    `__Host-` cookie, which only this exact origin over HTTPS can set (no `Domain`, so a
 *    sibling host cannot plant one). A cross-site page can neither read the cookie nor
 *    compute the field.
 *  - **Mail scanners spending single-use links.** A mailed link opens a page with a button;
 *    only the POST behind the button uses the token, so an automated GET changes nothing.
 *  - **Per-client limits dodged with a spoofed `X-Real-IP`.** The client address is read by
 *    `client-address.ts`, which believes proxy headers only from a trusted proxy.
 *  - **Markup injection.** Every interpolated value goes through `escapeHtml`, and the
 *    Content-Security-Policy allows exactly one script, by its full URL
 *    (`<public origin>/account/passkey.js`, not `'self'`, so no other same-origin response
 *    can ever run as script here), lets it `fetch` only `/account/passkey/`, and allows only
 *    the page's own stylesheet (by hash). No inline script, no `'unsafe-inline'`.
 *  - **Passkey challenges** follow the `state` pattern: each is random, single use, lives 5
 *    minutes, and is also set as a cookie scoped to `/account/passkey`, so an authenticator
 *    answer carried to another browser verifies against nothing. The passkey POSTs take only
 *    `application/json` (a cross-site form cannot send it without a CORS preflight, which
 *    this server never answers) and refuse an `Origin` header that is not the public origin.
 *    Adding a passkey also needs the session and its CSRF token, and the session must still
 *    be the one the challenge was issued to.
 *
 * LINKING another sign-in to the signed-in account, against the attacks it adds:
 *
 *  - **A stolen or unattended session adding the thief's sign-in.** Adding or removing a
 *    sign-in method needs a session from a sign-in in the last `LINK_FRESHNESS_MS` (10
 *    minutes); the session cookie carries when its sign-in happened. Otherwise the page asks
 *    to sign in again first.
 *  - **A link started from another site.** The start link carries `HMAC(session secret,
 *    session CSRF token)`, which a cross-site page cannot compute. It is a GET rather than a
 *    form POST because the page's `form-action 'self'` would block a form's redirect on to
 *    the provider.
 *  - **Replay and cross-browser callbacks.** A link uses the sign-in machinery unchanged:
 *    `state` + PKCE (+ nonce), the state cookie, single use, 10 minutes. The pending entry
 *    also names the account and the session (its CSRF token) that started it.
 *  - **Finishing in another session.** The callback does not attach anything itself: Apple's
 *    callback is a cross-site POST, which never carries the Lax session cookie. It parks the
 *    verified identity for 5 minutes under a random token, sets that token as a cookie on
 *    `/account/link-complete`, and sends the browser there; that GET carries the session
 *    cookie (top-level navigation), and the identity is attached only when the session is
 *    still the one that started the link. One path for every provider.
 *  - **Silent account merges.** An identity that already opens another account is refused
 *    with a message saying merging is not supported (`account-directory.ts`).
 *  - **Unverified addresses.** As at sign-in, only an address the provider verified is kept.
 *  - **Locking oneself out.** The last sign-in method cannot be removed.
 *
 * Every link and unlink is logged through `warn` as an `account portal: audit:` line naming
 * the account, the provider and the outcome, never a subject, an address or a token. (There is
 * no per-account audit record to write it to yet.)
 *
 * Pending sign-ins live in this process's memory for 10 minutes. A deployment with several
 * instances behind a load balancer would need sticky sessions or a shared store for them.
 *
 * The page HTML is rendered with template strings: these are static pages whose only script
 * shows the passkey buttons and runs the ceremony, which is the exception the React rule names.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PASSKEY_PROVIDER,
  type AccountDirectory,
  type IdentityLinkOutcome,
  type LinkedSignIn,
  type NewPasskey,
  type PasskeyLinkOutcome,
  type UnlinkOutcome,
} from "./account-directory";
import type { AccountEraser, AccountId, EraseReport } from "./account-vault";
import { clientAddress, type TrustedProxies } from "./client-address";
import type { IdentityProvider, PendingSignIn, ResponseMode, VerifiedIdentity } from "./identity-providers";
import { clearCookie, constantTimeEqual, cookieValues, setCookie, signedValues, type SameSite as CookieSameSite } from "./cookies";
import { createExpiringTable } from "./expiring-table";
import { escapeHtml, layout, messagePage, pageHeaders, sendHtml, sendScript, STYLE_HASH } from "./html-pages";
import { mediaTypeOf, readBodyText, sendJson } from "./http-kit";
import { asRecord, asString, parseJson } from "./json-values";
import {
  EMAIL_LINK_LIFETIME_MS,
  EMAIL_PROVIDER,
  EMAIL_PROVIDER_DISPLAY_NAME,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type EmailLinkOutcome,
  type InputProblem,
  type LinkOutcome,
  type LinkPurpose,
  type PasswordSignIn,
} from "./password-sign-in";
import { PASSKEY_SCRIPT } from "./passkey-script.generated";
import { providerButtonClass, providerMark } from "./provider-marks";
import {
  parseAuthenticationCredential,
  parseRegistrationCredential,
  PASSKEY_ALGORITHM_IDS,
  PASSKEY_ALGORITHMS,
  relyingPartyFor,
  verifyAuthentication,
  verifyRegistration,
  type RelyingParty,
} from "./webauthn";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

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

/**
 * The deck server's half of `/account/deck-session` (decks/deck-stack.ts): the portal decides who is
 * signed in; this mints the deck session for them and says which return paths are allowed.
 */
export type DeckSessionStart = Readonly<{
  /** The `Set-Cookie` value of a fresh deck session; also turns the account's pending invitations into memberships. */
  issueCookie(options: Readonly<{ accountId: AccountId }>): Promise<string>;
  /** `/decks` or `/deck/<valid id>`; anything else (another site, another page) becomes `/decks`. */
  validReturnPath(candidate: string | null): string;
  /** The `Set-Cookie` value that removes the deck session, sent with every sign-out. */
  clearCookie(): string;
}>;

export const ACCOUNT_PATH = "/account";
export const DECK_SESSION_PATH = `${ACCOUNT_PATH}/deck-session`;
/** Where `/account` sends the browser after a sign-in that started at `/account/deck-session`. */
export const RETURN_COOKIE_NAME = "sasha_return";
export const RETURN_COOKIE_LIFETIME_MS = 10 * 60 * 1000;
export const SESSION_COOKIE_NAME = "sasha_account";
export const SIGNIN_COOKIE_NAME = "sasha_signin";
export const PASSKEY_COOKIE_NAME = "sasha_passkey";
/** `__Host-`: Secure, `Path=/`, no `Domain`, so only this origin can set it. */
export const FORM_COOKIE_NAME = "__Host-sasha_form";
export const FORM_COOKIE_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const SESSION_LIFETIME_MS = 15 * 60 * 1000;
export const PENDING_SIGNIN_LIFETIME_MS = 10 * 60 * 1000;
/** How long a passkey challenge may be answered; also the timeout the browser is given. */
export const PASSKEY_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
export const PASSKEY_SCRIPT_PATH = `${ACCOUNT_PATH}/passkey.js`;
export const MIN_SESSION_SECRET_LENGTH = 32;
/** Adding or removing a sign-in method needs a sign-in at most this long ago. */
export const LINK_FRESHNESS_MS = 10 * 60 * 1000;
export const LINK_COMPLETE_PATH = `${ACCOUNT_PATH}/link-complete`;
/** The parked, verified identity of a link in progress (see "Linking" in the header). */
export const LINK_COOKIE_NAME = "sasha_link";
export const LINK_COMPLETION_LIFETIME_MS = 5 * 60 * 1000;
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
    /** Email and password sign-in; absent or null when no mail sender is configured. */
    passwordSignIn?: Readonly<{ service: PasswordSignIn; trustedProxies: TrustedProxies }> | null;
    /** The deck web application's session start; absent or null answers `/account/deck-session` with 404. */
    deckSessionStart?: DeckSessionStart | null;
  }>,
): AccountPortal {
  const { publicUrl, sessionSecret, directory, eraser, now, randomToken, warn } = options;
  const passwordSignIn = options.passwordSignIn ?? null;
  const deckSessionStart = options.deckSessionStart ?? null;
  const providers = new Map(options.providers.map((provider) => [provider.name, provider]));
  const clock = (): number => now().getTime();
  const pendingSignIns = createExpiringTable<PendingProviderFlow>({ now: clock, capacity: MAX_PENDING_SIGNINS });
  const pendingLinkCompletions = createExpiringTable<LinkCompletion>({ now: clock, capacity: MAX_PENDING_SIGNINS });
  const pendingPasskeys = createExpiringTable<PendingPasskey>({ now: clock, capacity: MAX_PENDING_SIGNINS });
  // "preferred": a PIN-less security key is still a phishing-proof possession factor.
  const relyingParty = relyingPartyFor({ publicUrl, requireUserVerification: false });
  // Only the two pages with passkey buttons get a policy that admits the script.
  const passkeyHeaders = passkeyPageHeaders({ origin: relyingParty.origin });

  const sessions = sessionCodec({ secret: sessionSecret });
  const forms = formCodec({ secret: sessionSecret, randomToken });
  let warnedAboutUntrustedProxy = false;

  async function route(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const method = request.method ?? "GET";
    const [, section, providerName, extra, rest] = path.slice(1).split("/");
    const target = parseRoute({ section, providerName, extra, rest, emailEnabled: passwordSignIn !== null });
    switch (target.kind) {
      case "home":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return home(request, response);
      case "login":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return login(response, target.provider);
      case "link":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return linkStart(request, response, target.provider);
      case "link-complete":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return linkComplete(request, response);
      case "unlink":
        if (method !== "POST") return sendMethodNotAllowed({ response, allow: "POST" });
        return unlink(request, response);
      case "callback":
        return callback({ request, response, providerName: target.provider, method });
      case "erase":
        if (method !== "POST") return sendMethodNotAllowed({ response, allow: "POST" });
        return erase(request, response);
      case "logout":
        if (method !== "POST") return sendMethodNotAllowed({ response, allow: "POST" });
        return logout(request, response);
      case "passkey-script":
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return sendScript({ response, script: PASSKEY_SCRIPT });
      case "passkey-options":
        if (method !== "POST") return sendMethodNotAllowed({ response, allow: "POST" });
        return passkeyOptions(request, response, target.ceremony);
      case "passkey-verify":
        if (method !== "POST") return sendMethodNotAllowed({ response, allow: "POST" });
        return passkeyVerify(request, response, target.ceremony);
      case "email":
        if (passwordSignIn === null) break;
        if (method !== "GET" && method !== "POST") return sendMethodNotAllowed({ response, allow: "GET, POST" });
        return emailRoute({ request, response, action: target.action, method, password: passwordSignIn.service });
      case "email-add":
        if (passwordSignIn === null) break;
        if (method !== "GET" && method !== "POST") return sendMethodNotAllowed({ response, allow: "GET, POST" });
        return emailAdd({ request, response, method, password: passwordSignIn.service });
      case "email-link":
        if (passwordSignIn === null) break;
        if (method !== "GET" && method !== "POST") return sendMethodNotAllowed({ response, allow: "GET, POST" });
        return emailLink({ request, response, method, password: passwordSignIn.service });
      case "deck-session":
        if (deckSessionStart === null) break;
        if (method !== "GET") return sendMethodNotAllowed({ response, allow: "GET" });
        return deckSession(request, response, deckSessionStart);
      case "not-found":
        return sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "There is no such page." }) });
      default:
        return assertNever(target);
    }
    sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "There is no such page." }) });
  }

  async function home(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = sessions.read({ request, nowMs: now().getTime() });
    const description = session === null ? null : await directory.describe({ accountId: session.accountId });
    if (session === null || description === null) {
      const form = passwordSignIn === null ? null : forms.issue(request);
      sendPage({
        response,
        status: 200,
        html: signedOutPage({
          providers: [...providers.values()],
          scriptUrl: scriptUrlFor(relyingParty),
          emailForm: form === null ? null : { token: form.token, email: "", error: null },
        }),
        headers: passkeyHeaders,
        cookies: [
          // An erased account's session is cleared, not left to linger for its 15 minutes.
          ...(session === null ? [] : [clearSessionCookie()]),
          ...(form === null ? [] : [form.cookie]),
        ],
      });
      return;
    }
    const pendingReturn = cookieValues({ request, name: RETURN_COOKIE_NAME })[0];
    if (deckSessionStart !== null && pendingReturn !== undefined) {
      // A sign-in that began at /account/deck-session goes back there, whichever method was used.
      const target = deckSessionStart.validReturnPath(safeDecode(pendingReturn));
      sendRedirect({ response, status: 303, location: `${DECK_SESSION_PATH}?return=${encodeURIComponent(target)}`, cookies: [clearReturnCookie()] });
      return;
    }
    sendPage({
      response,
      status: 200,
      html: signedInPage({
        links: description.links,
        providers,
        csrf: session.csrf,
        scriptUrl: scriptUrlFor(relyingParty),
        fresh: isFresh(session),
        linkToken: linkStartToken(session),
        emailEnabled: passwordSignIn !== null,
      }),
      headers: passkeyHeaders,
    });
  }

  /** Whether the session's sign-in is recent enough to add or remove a sign-in method. */
  function isFresh(session: Session): boolean {
    return session.authenticatedAtMs > now().getTime() - LINK_FRESHNESS_MS;
  }

  /** The start link's token: only a page rendered for this session can carry it. */
  function linkStartToken(session: Session): string {
    return createHmac("sha256", sessionSecret).update(`link-start:${session.csrf}`).digest("base64url");
  }

  /** `account portal: audit: …`: account, provider and outcome; never a subject, address or token. */
  function audit(entry: Readonly<{ accountId: AccountId; action: "link" | "unlink"; provider: string; outcome: string }>): void {
    warn(`account portal: audit: account ${entry.accountId} ${entry.action} ${entry.provider}: ${entry.outcome}`);
  }

  /**
   * `GET /account/link/<provider>?token=…`: a sign-in with the provider in LINK mode. Needs
   * the session, its start token and a recent sign-in; then exactly the sign-in redirect,
   * with the pending entry naming the account and the session it is for.
   */
  async function linkStart(request: IncomingMessage, response: ServerResponse, providerName: string): Promise<void> {
    const session = sessions.read({ request, nowMs: now().getTime() });
    if (session === null) return sendSessionEnded(response);
    const token = new URLSearchParams(requestQuery(request)).get("token");
    if (token === null || !constantTimeEqual(token, linkStartToken(session))) {
      return sendPage({ response, status: 403, html: nothingChangedPage("This request did not come from your account page. Open the page again and retry.") });
    }
    if (!isFresh(session)) return sendPage({ response, status: 403, html: signInAgainPage() });
    const provider = providers.get(providerName);
    if (provider === undefined) {
      sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "That sign-in option is not available." }) });
      return;
    }
    await beginProviderFlow({ response, provider, purpose: { kind: "link", accountId: session.accountId, sessionCsrf: session.csrf } });
  }

  /**
   * `GET /account/link-complete`: attaches the identity the callback parked, if this browser
   * holds its cookie and is still signed in with the session that started the link.
   */
  async function linkComplete(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = cookieValues({ request, name: LINK_COOKIE_NAME })[0] ?? null;
    // Taken on first sight, like a pending sign-in, so a reload cannot attach it twice.
    const pending = token === null ? null : pendingLinkCompletions.take(token);
    const clearLink = clearCookie({ name: LINK_COOKIE_NAME, path: LINK_COMPLETE_PATH, sameSite: "Lax" });
    if (pending === null) {
      return sendPage({
        response,
        status: 400,
        html: messagePage({
          title: "Nothing was added",
          message: "This request has expired, was already used, or was opened in a different browser.",
          action: { href: ACCOUNT_PATH, label: "Back to your account" },
        }),
        cookies: [clearLink],
      });
    }
    const session = sessions.read({ request, nowMs: now().getTime() });
    if (session === null || session.accountId !== pending.accountId || !constantTimeEqual(session.csrf, pending.sessionCsrf)) {
      audit({ accountId: pending.accountId, action: "link", provider: pending.identity.provider, outcome: "refused, the session changed" });
      return sendPage({
        response,
        status: 403,
        html: messagePage({
          title: "Nothing was added",
          message: "You are no longer signed in with the session that started this, so nothing was added. Sign in and try again.",
          action: { href: ACCOUNT_PATH, label: "Back to the account page" },
        }),
        cookies: [clearLink],
      });
    }
    const outcome = await directory.linkIdentity({ accountId: pending.accountId, ...pending.identity });
    sendLinkOutcome({ response, accountId: pending.accountId, provider: pending.identity.provider, outcome, cookies: [clearLink] });
  }

  /** The answer to a finished link, for every kind of sign-in method. */
  function sendLinkOutcome(
    options: Readonly<{ response: ServerResponse; accountId: AccountId; provider: string; outcome: IdentityLinkOutcome; cookies: readonly string[] }>,
  ): void {
    const { response, accountId, provider, outcome, cookies } = options;
    const name = linkLabel({ provider, providers });
    audit({ accountId, action: "link", provider, outcome: outcome.kind });
    const back = { href: ACCOUNT_PATH, label: "Back to your account" };
    switch (outcome.kind) {
      case "linked":
        return sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies });
      case "already-linked-here":
        return sendPage({ response, status: 200, html: messagePage({ title: "Already added", message: `This ${name} sign-in already signs in to your account.`, action: back }), cookies });
      case "linked-to-another-account":
        return sendPage({
          response,
          status: 409,
          html: messagePage({
            title: "This sign-in belongs to another account",
            message:
              `This ${name} sign-in already opens a different Sasha Slides account, so it was not added to this one. ` +
              "Merging two accounts is not supported yet. To move it here, sign in with it, delete that account's data, then add it to this account.",
            action: back,
          }),
          cookies,
        });
      case "provider-already-linked":
        return sendPage({
          response,
          status: 409,
          html: messagePage({ title: "Nothing was added", message: `Your account already has a ${name} sign-in. Remove it first to use a different one.`, action: back }),
          cookies,
        });
      case "account-missing":
        return sendPage({ response, status: 410, html: messagePage({ title: "Nothing was added", message: "This account no longer exists. Please sign in again.", action: back }), cookies });
      default:
        return assertNever(outcome);
    }
  }

  /** `POST /account/unlink`: removes one sign-in method, never the last. */
  async function unlink(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readVerifiedForm(request, response);
    if (form === null) return;
    if (!isFresh(form.session)) return sendPage({ response, status: 403, html: signInAgainPage() });
    const outcome: UnlinkOutcome = await directory.unlink({ accountId: form.accountId, linkId: form.fields.get("link") ?? "" });
    const back = { href: ACCOUNT_PATH, label: "Back to your account" };
    switch (outcome.kind) {
      case "unlinked":
        audit({ accountId: form.accountId, action: "unlink", provider: outcome.provider, outcome: "unlinked" });
        return sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: [] });
      case "last-method":
        return sendPage({
          response,
          status: 409,
          html: messagePage({
            title: "Nothing was removed",
            message: "This is the only way to sign in to your account, so it cannot be removed. Add another sign-in method first.",
            action: back,
          }),
        });
      case "not-found":
        return sendPage({ response, status: 404, html: messagePage({ title: "Nothing was removed", message: "That sign-in method is not on your account any more.", action: back }) });
      case "account-missing":
        return sendPage({ response, status: 410, html: messagePage({ title: "Nothing was removed", message: "This account no longer exists.", action: back }) });
      default:
        return assertNever(outcome);
    }
  }

  /** `/account/email/add`: the form, then a mailed link (`password-sign-in.ts` `startLink`). */
  async function emailAdd(
    target: Readonly<{ request: IncomingMessage; response: ServerResponse; method: "GET" | "POST"; password: PasswordSignIn }>,
  ): Promise<void> {
    const { request, response, method, password } = target;
    if (method === "GET") {
      const session = sessions.read({ request, nowMs: now().getTime() });
      if (session === null) return sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: [] });
      if (!isFresh(session)) return sendPage({ response, status: 403, html: signInAgainPage() });
      return sendPage({ response, status: 200, html: addEmailPage({ csrf: session.csrf, email: "", error: null }) });
    }
    const form = await readVerifiedForm(request, response);
    if (form === null) return;
    if (!isFresh(form.session)) return sendPage({ response, status: 403, html: signInAgainPage() });
    const email = form.fields.get("email") ?? "";
    const outcome = await password.startLink({ accountId: form.accountId, email, password: form.fields.get("password") ?? "", clientAddress: clientOf(request) });
    switch (outcome.kind) {
      case "accepted":
        return sendPage({
          response,
          status: 200,
          html: checkEmailPage({ message: "We sent a message to the address you entered. Open the link in it within 30 minutes, in this browser, to add it to your account." }),
        });
      case "invalid":
        return sendPage({ response, status: 400, html: addEmailPage({ csrf: form.session.csrf, email, error: problemText(outcome.problem) }) });
      case "throttled":
        return sendThrottled({ response, retryAfterMs: outcome.retryAfterMs });
      default:
        return assertNever(outcome);
    }
  }

  /** `/account/email/link`: the mailed link's page, a button, and the address added on POST. */
  async function emailLink(
    target: Readonly<{ request: IncomingMessage; response: ServerResponse; method: "GET" | "POST"; password: PasswordSignIn }>,
  ): Promise<void> {
    const { request, response, method, password } = target;
    if (method === "GET") {
      const linkToken = new URLSearchParams(requestQuery(request)).get("token") ?? "";
      if (!password.isLinkLive({ purpose: "link", token: linkToken })) return sendPage({ response, status: 400, html: deadLinkPage("link") });
      const session = sessions.read({ request, nowMs: now().getTime() });
      if (session === null) {
        return sendPage({
          response,
          status: 401,
          html: messagePage({
            title: "Sign in first",
            message: "Sign in to the account you are adding this address to, then open the link in the message again. It works for 30 minutes.",
            action: { href: ACCOUNT_PATH, label: "Sign in" },
          }),
        });
      }
      return sendPage({ response, status: 200, html: confirmAddressLinkPage({ csrf: session.csrf, linkToken }) });
    }
    const form = await readVerifiedForm(request, response);
    if (form === null) return;
    const outcome: EmailLinkOutcome = await password.confirmLink({ token: form.fields.get("token") ?? "", accountId: form.accountId });
    switch (outcome.kind) {
      case "invalid-link":
        return sendPage({ response, status: 400, html: deadLinkPage("link") });
      case "wrong-account":
        return sendPage({
          response,
          status: 403,
          html: messagePage({
            title: "This link is for another account",
            message: "Sign in to the account that asked to add this address, then open the link in the message again.",
            action: { href: ACCOUNT_PATH, label: "Back to the account page" },
          }),
        });
      case "linked":
      case "already-linked-here":
      case "linked-to-another-account":
      case "provider-already-linked":
      case "account-missing":
        return sendLinkOutcome({ response, accountId: form.accountId, provider: EMAIL_PROVIDER, outcome, cookies: [] });
      default:
        return assertNever(outcome);
    }
  }

  /** `/account/deck-session` (see the header): the deck session for whoever is signed in here. */
  async function deckSession(request: IncomingMessage, response: ServerResponse, start: DeckSessionStart): Promise<void> {
    const target = start.validReturnPath(new URLSearchParams(requestQuery(request)).get("return"));
    const session = sessions.read({ request, nowMs: now().getTime() });
    const description = session === null ? null : await directory.describe({ accountId: session.accountId });
    if (session === null || description === null) {
      sendRedirect({
        response,
        status: 303,
        location: ACCOUNT_PATH,
        cookies: [setCookie({ name: RETURN_COOKIE_NAME, value: encodeURIComponent(target), path: ACCOUNT_PATH, maxAgeSeconds: RETURN_COOKIE_LIFETIME_MS / 1000, sameSite: "Lax" })],
      });
      return;
    }
    const deckCookie = await start.issueCookie({ accountId: session.accountId });
    sendRedirect({ response, status: 303, location: target, cookies: [deckCookie, clearReturnCookie()] });
  }

  async function login(response: ServerResponse, providerName: string): Promise<void> {
    const provider = providers.get(providerName);
    if (provider === undefined) {
      sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "That sign-in option is not available." }) });
      return;
    }
    await beginProviderFlow({ response, provider, purpose: { kind: "sign-in" } });
  }

  /** Sends the browser to the provider, remembering the flow under its `state` and binding it to this browser. */
  async function beginProviderFlow(
    options: Readonly<{ response: ServerResponse; provider: IdentityProvider; purpose: FlowPurpose }>,
  ): Promise<void> {
    const { response, provider, purpose } = options;
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
    rememberPendingSignIn({ signIn: begun.pending, purpose });
    const scope = signInCookieScope(provider);
    sendRedirect({
      response,
      status: 302,
      location: begun.location,
      cookies: [
        setCookie({
          name: SIGNIN_COOKIE_NAME,
          value: begun.pending.state,
          path: scope.path,
          maxAgeSeconds: PENDING_SIGNIN_LIFETIME_MS / 1000,
          sameSite: scope.sameSite,
        }),
      ],
    });
  }

  function rememberPendingSignIn(pending: PendingProviderFlow): void {
    pendingSignIns.put({ key: pending.signIn.state, value: pending, lifetimeMilliseconds: PENDING_SIGNIN_LIFETIME_MS });
  }

  async function callback(
    options: Readonly<{ request: IncomingMessage; response: ServerResponse; providerName: string; method: string }>,
  ): Promise<void> {
    const { request, response } = options;
    const provider = providers.get(options.providerName);
    if (provider === undefined) {
      sendPage({ response, status: 404, html: messagePage({ title: "Not found", message: "That sign-in option is not available." }) });
      return;
    }
    const expectedMethod = callbackMethod(provider.responseMode);
    if (options.method !== expectedMethod) return sendMethodNotAllowed({ response, allow: expectedMethod });
    const parameters = await callbackParameters({ request, response, responseMode: provider.responseMode });
    if (parameters === null) return;
    const state = parameters.get("state");
    // Every cookie of that name the browser sent: a stale one from another provider's
    // sign-in, on a broader path, must not hide the one this sign-in set.
    const boundStates = cookieValues({ request, name: SIGNIN_COOKIE_NAME });
    // Taken on first sight, so a replay finds nothing whatever happens below.
    const started = state === null ? null : pendingSignIns.take(state);
    const scope = signInCookieScope(provider);
    const clearSignIn = clearCookie({ name: SIGNIN_COOKIE_NAME, path: scope.path, sameSite: scope.sameSite });
    if (
      state === null ||
      !boundStates.some((boundState) => constantTimeEqual(state, boundState)) ||
      started === null ||
      started.signIn.provider !== provider.name
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
    const { purpose } = started;
    const outcome = await provider.complete({
      pending: started.signIn,
      parameters,
      redirectUri: accountCallbackUrl({ publicUrl, provider: provider.name }),
    });
    if (outcome.kind === "failed") {
      warn(`account portal: ${provider.name} ${purpose.kind} failed: ${outcome.reason}`);
      sendPage({
        response,
        status: 400,
        html: messagePage({
          title: "Sign-in did not complete",
          message: `${provider.displayName} did not confirm who you are, so ${purposeConsequence(purpose)}.`,
          action: { href: ACCOUNT_PATH, label: "Try again" },
        }),
        cookies: [clearSignIn],
      });
      return;
    }
    const identity = keptIdentity(outcome.identity);
    switch (purpose.kind) {
      case "sign-in":
        break;
      case "link": {
        // Parked, not attached: see "Finishing in another session" in the header.
        const token = randomToken();
        pendingLinkCompletions.put({
          key: token,
          value: { accountId: purpose.accountId, sessionCsrf: purpose.sessionCsrf, identity },
          lifetimeMilliseconds: LINK_COMPLETION_LIFETIME_MS,
        });
        sendRedirect({
          response,
          status: 303,
          location: LINK_COMPLETE_PATH,
          cookies: [
            clearSignIn,
            setCookie({ name: LINK_COOKIE_NAME, value: token, path: LINK_COMPLETE_PATH, maxAgeSeconds: LINK_COMPLETION_LIFETIME_MS / 1000, sameSite: "Lax" }),
          ],
        });
        return;
      }
      default:
        return assertNever(purpose);
    }
    const accountId = await directory.findOrCreateByIdentity(identity);
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
      cookies: [clearSessionCookie()],
    });
  }

  async function logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The deck session is a cookie of its own (Path=/deck-api) that renews itself while a deck is
    // open; signing out here must end it too, or this browser keeps every deck for 12 more hours.
    const signedOut = [clearSessionCookie(), ...(deckSessionStart === null ? [] : [deckSessionStart.clearCookie()])];
    if (sessions.read({ request, nowMs: now().getTime() }) === null) {
      sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: signedOut });
      return;
    }
    const form = await readVerifiedForm(request, response);
    if (form === null) return;
    sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: signedOut });
  }

  /**
   * Step one of every passkey ceremony: a fresh challenge, remembered for this browser, and
   * the options `navigator.credentials` needs. Adding a passkey requires the session and its
   * CSRF token, and lists the account's existing passkeys so an authenticator that already
   * holds one refuses to make a second.
   */
  async function passkeyOptions(request: IncomingMessage, response: ServerResponse, ceremony: PasskeyCeremony): Promise<void> {
    const body = await readPasskeyRequest(request, response);
    if (body === null) return;
    const nowMs = now().getTime();
    const challenge = randomBytes(PASSKEY_RANDOM_BYTES).toString("base64url");
    let pending: PendingPasskey;
    let publicKey: Readonly<Record<string, unknown>>;
    switch (ceremony) {
      case "create": {
        const userHandle = randomBytes(PASSKEY_RANDOM_BYTES).toString("base64url");
        pending = { ceremony, challenge, userHandle };
        publicKey = creationOptions({ relyingParty, challenge, userHandle, excludeIds: [], nowMs });
        break;
      }
      case "add": {
        const session = passkeySession({ request, response, body });
        if (session === null) return;
        if (!isFresh(session)) {
          sendJson({ response, status: 403, body: { message: SIGN_IN_AGAIN_MESSAGE }, cookies: [] });
          return;
        }
        const userHandle = randomBytes(PASSKEY_RANDOM_BYTES).toString("base64url");
        pending = { ceremony, challenge, accountId: session.accountId, userHandle };
        const excludeIds = await directory.passkeyIds({ accountId: session.accountId });
        publicKey = creationOptions({ relyingParty, challenge, userHandle, excludeIds, nowMs });
        break;
      }
      case "signin":
        pending = { ceremony, challenge };
        publicKey = {
          challenge,
          rpId: relyingParty.id,
          timeout: PASSKEY_CHALLENGE_LIFETIME_MS,
          userVerification: "preferred",
          allowCredentials: [],
        };
        break;
      default:
        return assertNever(ceremony);
    }
    pendingPasskeys.put({ key: challenge, value: pending, lifetimeMilliseconds: PASSKEY_CHALLENGE_LIFETIME_MS });
    sendJson({
      response,
      status: 200,
      body: { publicKey },
      cookies: [setCookie({ name: PASSKEY_COOKIE_NAME, value: challenge, path: PASSKEY_PATH, maxAgeSeconds: PASSKEY_CHALLENGE_LIFETIME_MS / 1000, sameSite: "Lax" })],
    });
  }

  /**
   * Step two: the challenge this browser holds (its cookie) is taken out of the map whatever
   * happens next, must have been issued for this ceremony, and must be the one the
   * authenticator signed over (`webauthn.ts` compares it with the client data).
   */
  async function passkeyVerify(request: IncomingMessage, response: ServerResponse, ceremony: PasskeyCeremony): Promise<void> {
    const body = await readPasskeyRequest(request, response);
    if (body === null) return;
    const clearChallenge = clearCookie({ name: PASSKEY_COOKIE_NAME, path: PASSKEY_PATH, sameSite: "Lax" });
    const refuse: Refuse = ({ status, message, reason }) => {
      warn(`account portal: passkey ${ceremony} refused: ${reason}`);
      sendJson({ response, status, body: { message }, cookies: [clearChallenge] });
    };
    const challenge = cookieValues({ request, name: PASSKEY_COOKIE_NAME })[0] ?? null;
    const pending = challenge === null ? null : pendingPasskeys.take(challenge);
    if (challenge === null || pending === null || pending.ceremony !== ceremony) {
      return refuse({ status: 400, message: "This passkey request has expired or was already used. Please try again.", reason: "no live challenge for this browser" });
    }
    switch (pending.ceremony) {
      case "create":
      case "add":
        return finishRegistration({ request, response, body, pending, refuse, clearChallenge });
      case "signin":
        return finishSignIn({ response, body, challenge, refuse, clearChallenge });
      default:
        return assertNever(pending);
    }
  }

  async function finishRegistration(
    context: Readonly<{
      request: IncomingMessage;
      response: ServerResponse;
      body: Readonly<Record<string, unknown>>;
      pending: PendingRegistration;
      refuse: Refuse;
      clearChallenge: string;
    }>,
  ): Promise<void> {
    const { request, response, body, pending, refuse, clearChallenge } = context;
    switch (pending.ceremony) {
      case "create":
        break;
      case "add": {
        const session = passkeySession({ request, response, body });
        if (session === null) return;
        if (session.accountId !== pending.accountId) {
          return refuse({ status: 403, message: "You signed in to another account since this started. Please try again.", reason: "the session changed account" });
        }
        break;
      }
      default:
        return assertNever(pending);
    }
    const credential = parseRegistrationCredential(body["credential"]);
    if (credential === null) return refuse({ status: 400, message: "Your browser sent a passkey we could not read.", reason: "unparseable registration" });
    const verified = verifyRegistration({ relyingParty, expectedChallenge: pending.challenge, credential });
    if (verified.kind === "rejected") {
      return refuse({ status: 400, message: "That passkey could not be verified, so nothing was saved.", reason: `${verified.reason}: ${verified.detail}` });
    }
    const { registration } = verified;
    const passkey = {
      credentialId: registration.credentialId,
      publicKey: registration.publicKey,
      algorithm: registration.algorithm,
      signCount: registration.signCount,
      userHandle: pending.userHandle,
      createdAtMs: now().getTime(),
    };
    const outcome = await linkRegisteredPasskey({ pending, passkey });
    if (pending.ceremony === "add") audit({ accountId: pending.accountId, action: "link", provider: PASSKEY_PROVIDER, outcome: outcome.kind });
    switch (outcome.kind) {
      case "linked":
        break;
      case "already-registered":
        return refuse({ status: 409, message: "This passkey is already registered with Sasha Slides.", reason: "credential id already registered" });
      case "account-missing":
        return refuse({ status: 410, message: "This account no longer exists. Please sign in again.", reason: "account erased during the ceremony" });
      default:
        return assertNever(outcome);
    }
    sendJson({
      response,
      status: 200,
      body: { redirect: ACCOUNT_PATH },
      cookies: [clearChallenge, ...sessionAfterRegistration({ pending, accountId: outcome.accountId })],
    });
  }

  /** A new account is signed in here; an added passkey leaves the current session as it is. */
  function sessionAfterRegistration(options: Readonly<{ pending: PendingRegistration; accountId: AccountId }>): readonly string[] {
    switch (options.pending.ceremony) {
      case "create":
        return [sessions.issue({ accountId: options.accountId, nowMs: now().getTime(), csrf: randomToken() })];
      case "add":
        return [];
      default:
        return assertNever(options.pending);
    }
  }

  function linkRegisteredPasskey(
    options: Readonly<{ pending: PendingRegistration; passkey: NewPasskey }>,
  ): Promise<PasskeyLinkOutcome> {
    const { pending, passkey } = options;
    switch (pending.ceremony) {
      case "create":
        return directory.createAccountWithPasskey({ passkey });
      case "add":
        return directory.addPasskey({ accountId: pending.accountId, passkey });
      default:
        return assertNever(pending);
    }
  }

  async function finishSignIn(
    context: Readonly<{
      response: ServerResponse;
      body: Readonly<Record<string, unknown>>;
      challenge: string;
      refuse: Refuse;
      clearChallenge: string;
    }>,
  ): Promise<void> {
    const { response, body, challenge, refuse, clearChallenge } = context;
    const credential = parseAuthenticationCredential(body["credential"]);
    if (credential === null) return refuse({ status: 400, message: "Your browser sent a passkey we could not read.", reason: "unparseable assertion" });
    const stored = await directory.findPasskey({ credentialId: credential.id });
    const notRecognised = "This passkey is not registered with Sasha Slides. Create an account with it, or sign in another way.";
    if (stored === null) return refuse({ status: 400, message: notRecognised, reason: "unknown credential id" });
    // The handle the authenticator stored with the key must be the one registered with it.
    if (credential.userHandle !== null && !constantTimeEqual(credential.userHandle, stored.userHandle)) {
      return refuse({ status: 400, message: notRecognised, reason: "user handle does not match the credential" });
    }
    const verified = verifyAuthentication({
      relyingParty,
      expectedChallenge: challenge,
      credential,
      publicKey: stored.publicKey,
      algorithm: stored.algorithm,
      storedSignCount: stored.signCount,
    });
    if (verified.kind === "rejected") {
      return refuse({ status: 400, message: "That passkey could not be verified, so you are not signed in.", reason: `${verified.reason}: ${verified.detail}` });
    }
    await directory.recordPasskeyUse({ credentialId: stored.credentialId, signCount: verified.signCount });
    sendJson({
      response,
      status: 200,
      body: { redirect: ACCOUNT_PATH },
      cookies: [clearChallenge, sessions.issue({ accountId: stored.accountId, nowMs: now().getTime(), csrf: randomToken() })],
    });
  }

  /**
   * The shared gate of the passkey POSTs: JSON from this origin, within the size limit.
   * Answers the request itself and returns null when it is not.
   */
  async function readPasskeyRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== relyingParty.origin) {
      sendJson({ response, status: 403, body: { message: "This request did not come from the account page." }, cookies: [] });
      return null;
    }
    if (mediaTypeOf(request) !== "application/json") {
      sendJson({ response, status: 415, body: { message: "This request must be sent by the account page." }, cookies: [] });
      return null;
    }
    const text = await readBodyText({ request, maximumBytes: MAX_PASSKEY_BODY_BYTES, onOverflow: "destroy" });
    const parsed = text === null ? null : parseJson(text);
    const body = parsed?.kind === "ok" ? asRecord(parsed.value) : null;
    if (body === null) {
      sendJson({ response, status: 400, body: { message: "This request must be sent by the account page." }, cookies: [] });
      return null;
    }
    return body;
  }

  /** The live session whose CSRF token the JSON body carries, or null after answering 401/403. */
  function passkeySession(
    context: Readonly<{ request: IncomingMessage; response: ServerResponse; body: Readonly<Record<string, unknown>> }>,
  ): Session | null {
    const { request, response, body } = context;
    const session = sessions.read({ request, nowMs: now().getTime() });
    if (session === null) {
      sendJson({ response, status: 401, body: { message: "Your session has ended. Sign in again, then add the passkey." }, cookies: [] });
      return null;
    }
    const csrf = asString(body["csrf"]);
    if (csrf === null || !constantTimeEqual(csrf, session.csrf)) {
      sendJson({ response, status: 403, body: { message: "This request did not come from your account page. Reload it and retry." }, cookies: [] });
      return null;
    }
    return session;
  }

  async function emailRoute(
    target: Readonly<{ request: IncomingMessage; response: ServerResponse; action: EmailAction; method: "GET" | "POST"; password: PasswordSignIn }>,
  ): Promise<void> {
    const { request, response, action, method, password } = target;
    if (method === "GET") return emailPage({ request, response, action, password });
    const form = await readAnonymousForm(request, response);
    if (form === null) return;
    const client = clientOf(request);
    const email = form.get("email") ?? "";
    switch (action) {
      case "signup": {
        const outcome = await password.signUp({ email, password: form.get("password") ?? "", clientAddress: client });
        switch (outcome.kind) {
          case "accepted":
            return sendPage({ response, status: 200, html: checkEmailPage({ message: "We sent a message to the address you entered. Open the link in it within 30 minutes to finish creating your account." }) });
          case "invalid": {
            const issued = forms.issue(request);
            return sendPage({ response, status: 400, html: signUpPage({ token: issued.token, email, error: problemText(outcome.problem) }), cookies: [issued.cookie] });
          }
          case "throttled":
            return sendThrottled({ response, retryAfterMs: outcome.retryAfterMs });
          default:
            return assertNever(outcome);
        }
      }
      case "signin": {
        const outcome = await password.signIn({ email, password: form.get("password") ?? "", clientAddress: client });
        switch (outcome.kind) {
          case "signed-in":
            return signInAndGoHome({ response, accountId: outcome.accountId });
          case "rejected": {
            const issued = forms.issue(request);
            return sendPage({
              response,
              status: 401,
              html: signedOutPage({
                providers: [...providers.values()],
                scriptUrl: scriptUrlFor(relyingParty),
                emailForm: { token: issued.token, email, error: "The email address or password is not right." },
              }),
              // The signed-out page again, passkey buttons included, so it keeps their policy.
              headers: passkeyHeaders,
              cookies: [issued.cookie],
            });
          }
          case "unconfirmed":
            return sendPage({
              response,
              status: 403,
              html: messagePage({
                title: "Confirm your email address",
                message: "Your account is not active until you confirm your address. We sent you a new link; open it within 30 minutes.",
              }),
            });
          case "throttled":
            return sendThrottled({ response, retryAfterMs: outcome.retryAfterMs });
          default:
            return assertNever(outcome);
        }
      }
      case "forgot": {
        const outcome = await password.requestReset({ email, clientAddress: client });
        switch (outcome.kind) {
          case "accepted":
            return sendPage({ response, status: 200, html: checkEmailPage({ message: "If an account uses this address, a message with a link to choose a new password is on its way. The link works for 30 minutes." }) });
          case "invalid": {
            const issued = forms.issue(request);
            return sendPage({ response, status: 400, html: forgotPage({ token: issued.token, email, error: problemText(outcome.problem) }), cookies: [issued.cookie] });
          }
          case "throttled":
            return sendThrottled({ response, retryAfterMs: outcome.retryAfterMs });
          default:
            return assertNever(outcome);
        }
      }
      case "verify":
        return finishLink({ request, response, purpose: "confirm", outcome: await password.confirmAddress({ token: form.get("token") ?? "" }), token: "" });
      case "reset": {
        const token = form.get("token") ?? "";
        return finishLink({ request, response, purpose: "reset", outcome: await password.completeReset({ token, password: form.get("password") ?? "" }), token });
      }
      default:
        return assertNever(action);
    }
  }

  function emailPage(
    target: Readonly<{ request: IncomingMessage; response: ServerResponse; action: EmailAction; password: PasswordSignIn }>,
  ): void {
    const { request, response, action, password } = target;
    const formPage = (html: (token: string) => string): void => {
      const issued = forms.issue(request);
      sendPage({ response, status: 200, html: html(issued.token), cookies: [issued.cookie] });
    };
    // The page behind a mailed link: a button (or a new-password form) that uses the token, never the GET itself.
    const linkPage = (purpose: LinkPurpose, html: (formToken: string, linkToken: string) => string): void => {
      const linkToken = new URLSearchParams(requestQuery(request)).get("token") ?? "";
      if (!password.isLinkLive({ purpose, token: linkToken })) {
        sendPage({ response, status: 400, html: deadLinkPage(purpose) });
        return;
      }
      formPage((formToken) => html(formToken, linkToken));
    };
    switch (action) {
      case "signin":
        // The sign-in form lives on the signed-out account page.
        return sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: [] });
      case "signup":
        return formPage((token) => signUpPage({ token, email: "", error: null }));
      case "forgot":
        return formPage((token) => forgotPage({ token, email: "", error: null }));
      case "verify":
        return linkPage("confirm", (formToken, linkToken) => confirmPage({ formToken, linkToken }));
      case "reset":
        return linkPage("reset", (formToken, linkToken) => newPasswordPage({ formToken, linkToken, error: null }));
      default:
        return assertNever(action);
    }
  }

  function finishLink(
    target: Readonly<{ request: IncomingMessage; response: ServerResponse; purpose: LinkPurpose; outcome: LinkOutcome; token: string }>,
  ): void {
    const { request, response, purpose, outcome } = target;
    switch (outcome.kind) {
      case "signed-in":
        return signInAndGoHome({ response, accountId: outcome.accountId });
      case "invalid-link":
        return sendPage({ response, status: 400, html: deadLinkPage(purpose) });
      case "invalid": {
        const issued = forms.issue(request);
        return sendPage({
          response,
          status: 400,
          html: newPasswordPage({ formToken: issued.token, linkToken: target.token, error: problemText(outcome.problem) }),
          cookies: [issued.cookie],
        });
      }
      default:
        return assertNever(outcome);
    }
  }

  function signInAndGoHome(target: Readonly<{ response: ServerResponse; accountId: AccountId }>): void {
    sendRedirect({
      response: target.response,
      status: 303,
      location: ACCOUNT_PATH,
      cookies: [sessions.issue({ accountId: target.accountId, nowMs: now().getTime(), csrf: randomToken() })],
    });
  }

  function clientOf(request: IncomingMessage): string {
    const trustedProxies = passwordSignIn?.trustedProxies;
    if (trustedProxies === undefined) return "unknown";
    const client = clientAddress({ request, trustedProxies });
    if (client.ignoredForwardedHeader && !warnedAboutUntrustedProxy) {
      warnedAboutUntrustedProxy = true;
      const peer = request.socket.remoteAddress ?? "";
      // Only a private or loopback peer is printed: that is a proxy, not a visitor.
      const shown = PRIVATE_PEER.test(peer) ? ` ${peer}` : "";
      warn(
        `account portal: ignoring X-Real-IP / X-Forwarded-For from untrusted peer${shown}, so every visitor through it counts as one client; ` +
          `if that is the reverse proxy, start with --trusted-proxy <its address or subnet> (trusted now: ${trustedProxies.description})`,
      );
    }
    return client.address;
  }

  /**
   * The gate of every email form, before any session exists: a form body, and a `form` field
   * that is the MAC of this browser's form cookie. Answers the request itself and returns
   * null when either is missing or wrong.
   */
  async function readAnonymousForm(request: IncomingMessage, response: ServerResponse): Promise<URLSearchParams | null> {
    if (mediaTypeOf(request) !== "application/x-www-form-urlencoded") {
      sendPage({ response, status: 415, html: messagePage({ title: "Unsupported request", message: "This form must be sent by the account page." }) });
      return null;
    }
    const body = await readBody(request);
    if (body === null) {
      sendPage({ response, status: 413, html: messagePage({ title: "Request too large", message: "This form must be sent by the account page." }) });
      return null;
    }
    const fields = new URLSearchParams(body);
    if (!forms.verify({ request, field: fields.get("form") })) {
      sendPage({
        response,
        status: 403,
        html: messagePage({
          title: "Nothing was sent",
          message: "This form has expired or did not come from the account page. Open the page again and retry.",
          action: { href: ACCOUNT_PATH, label: "Back to the account page" },
        }),
      });
      return null;
    }
    return fields;
  }

  /**
   * The shared gate of both POSTs: a form body, a live session, and that session's CSRF
   * token. Answers the request itself and returns null when any of them is missing.
   */
  async function readVerifiedForm(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<Readonly<{ accountId: AccountId; session: Session; fields: URLSearchParams }> | null> {
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
      sendSessionEnded(response);
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
    return { accountId: session.accountId, session, fields };
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

// ---------------------------------------------------------------- routing

type PasskeyCeremony = "create" | "signin" | "add";

/**
 * One issued passkey challenge, keyed by the challenge itself (which is also the browser's
 * cookie). A registration carries the fresh WebAuthn user handle it offered; an `add` also
 * names the signed-in account the passkey is for.
 */
type PendingPasskey = PendingRegistration | Readonly<{ ceremony: "signin"; challenge: string }>;

type PendingRegistration =
  | Readonly<{ ceremony: "create"; challenge: string; userHandle: string }>
  | Readonly<{ ceremony: "add"; challenge: string; userHandle: string; accountId: AccountId }>;

/** Answers a failed passkey step: `message` to the person, `reason` to the log. */
type Refuse = (refusal: Readonly<{ status: number; message: string; reason: string }>) => void;

type EmailAction = "signup" | "signin" | "verify" | "forgot" | "reset";

/**
 * A provider round trip in flight, keyed by its `state`: a sign-in, or a link that attaches
 * the identity to `accountId`, started by the session whose CSRF token is `sessionCsrf`.
 */
type PendingProviderFlow = Readonly<{ signIn: PendingSignIn; purpose: FlowPurpose }>;

type FlowPurpose = Readonly<{ kind: "sign-in" }> | Readonly<{ kind: "link"; accountId: AccountId; sessionCsrf: string }>;

/** A link whose provider round trip verified: waiting for `/account/link-complete`. */
type LinkCompletion = Readonly<{ accountId: AccountId; sessionCsrf: string; identity: KeptIdentity }>;

/** What the directory is given for a verified identity: the address only when the provider vouches for it. */
type KeptIdentity = Readonly<{ provider: string; subject: string; email: string | null }>;

type PortalRoute =
  | Readonly<{ kind: "email"; action: EmailAction }>
  | Readonly<{ kind: "email-add" }>
  | Readonly<{ kind: "email-link" }>
  | Readonly<{ kind: "link"; provider: string }>
  | Readonly<{ kind: "link-complete" }>
  | Readonly<{ kind: "unlink" }>
  | Readonly<{ kind: "home" }>
  | Readonly<{ kind: "login"; provider: string }>
  | Readonly<{ kind: "callback"; provider: string }>
  | Readonly<{ kind: "erase" }>
  | Readonly<{ kind: "logout" }>
  | Readonly<{ kind: "passkey-script" }>
  | Readonly<{ kind: "passkey-options"; ceremony: PasskeyCeremony }>
  | Readonly<{ kind: "passkey-verify"; ceremony: PasskeyCeremony }>
  | Readonly<{ kind: "deck-session" }>
  | Readonly<{ kind: "not-found" }>;

const MAX_PENDING_SIGNINS = 10_000;
const MAX_FORM_BYTES = 8 * 1024;
/** An RS256 registration, the largest body, is under 2 KiB. */
const MAX_PASSKEY_BODY_BYTES = 16 * 1024;
const PASSKEY_PATH = `${ACCOUNT_PATH}/passkey`;
/** 256 bits for each challenge and user handle; WebAuthn asks for at least 128. */
const PASSKEY_RANDOM_BYTES = 32;

/** Private and loopback ranges: an address there is a proxy or a container gateway, not a visitor. */
const PRIVATE_PEER = /^(?:::ffff:)?(?:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)|^::1$/;

function parseRoute(
  options: Readonly<{
    section: string | undefined;
    providerName: string | undefined;
    extra: string | undefined;
    rest: string | undefined;
    emailEnabled: boolean;
  }>,
): PortalRoute {
  const { section, providerName, extra, rest } = options;
  if (section === undefined) return { kind: "home" };
  if (section === "passkey.js" && providerName === undefined) return { kind: "passkey-script" };
  if (section === "passkey") return parsePasskeyRoute({ ceremony: providerName, step: extra, rest });
  if (extra !== undefined) return { kind: "not-found" };
  if (section === "email" && options.emailEnabled && providerName !== undefined) {
    if (providerName === "add") return { kind: "email-add" };
    if (providerName === "link") return { kind: "email-link" };
    if (isEmailAction(providerName)) return { kind: "email", action: providerName };
  }
  if ((section === "login" || section === "callback" || section === "link") && providerName !== undefined && providerName !== "") {
    if (section === "link") return { kind: "link", provider: providerName };
    return section === "login" ? { kind: "login", provider: providerName } : { kind: "callback", provider: providerName };
  }
  if (providerName !== undefined) return { kind: "not-found" };
  if (section === "erase") return { kind: "erase" };
  if (section === "link-complete") return { kind: "link-complete" };
  if (section === "unlink") return { kind: "unlink" };
  if (section === "deck-session") return { kind: "deck-session" };
  if (section === "logout") return { kind: "logout" };
  return { kind: "not-found" };
}

function parsePasskeyRoute(
  options: Readonly<{ ceremony: string | undefined; step: string | undefined; rest: string | undefined }>,
): PortalRoute {
  const { ceremony, step, rest } = options;
  if (rest !== undefined || (ceremony !== "create" && ceremony !== "signin" && ceremony !== "add")) return { kind: "not-found" };
  if (step === "options") return { kind: "passkey-options", ceremony };
  if (step === "verify") return { kind: "passkey-verify", ceremony };
  return { kind: "not-found" };
}

/**
 * The parse-boundary guard for the closed action set. Its input is any path segment, so it
 * cannot be exhaustive over `EmailAction`; a new action is added here by hand.
 */
function isEmailAction(candidate: string): candidate is EmailAction {
  return candidate === "signup" || candidate === "signin" || candidate === "verify" || candidate === "forgot" || candidate === "reset";
}

function requestQuery(request: IncomingMessage): string {
  const raw = request.url ?? "";
  const question = raw.indexOf("?");
  return question < 0 ? "" : raw.slice(question + 1);
}

/**
 * Only an address the provider vouches for is kept: deck invitations become memberships by
 * matching it (decks/deck-manager.ts `acceptInvitations`), so an unverified claim -- any tenant
 * of a generic OpenID provider can put any address there -- would join decks shared with
 * someone else's address. The same rule for a sign-in and for a link.
 */
function keptIdentity(identity: VerifiedIdentity): KeptIdentity {
  return { provider: identity.provider, subject: identity.subject, email: identity.emailVerified ? identity.email : null };
}

/** The end of "… did not confirm who you are, so …". */
function purposeConsequence(purpose: FlowPurpose): string {
  switch (purpose.kind) {
    case "sign-in":
      return "you are not signed in";
    case "link":
      return "nothing was added to your account";
    default:
      return assertNever(purpose);
  }
}

function callbackMethod(responseMode: ResponseMode): "GET" | "POST" {
  switch (responseMode) {
    case "query":
      return "GET";
    case "form_post":
      return "POST";
    default:
      return assertNever(responseMode);
  }
}

/**
 * The provider's answer: the query of a redirect, or the body of a form POST. Answers the
 * request itself and returns null when a form POST is not a form or is too large.
 */
async function callbackParameters(
  options: Readonly<{ request: IncomingMessage; response: ServerResponse; responseMode: ResponseMode }>,
): Promise<URLSearchParams | null> {
  const { request, response } = options;
  switch (options.responseMode) {
    case "query":
      return new URLSearchParams(requestQuery(request));
    case "form_post": {
      if (mediaTypeOf(request) !== "application/x-www-form-urlencoded") {
        sendPage({ response, status: 415, html: messagePage({ title: "Unsupported request", message: "This address only accepts the sign-in provider's form." }) });
        return null;
      }
      const body = await readBody(request);
      if (body === null) {
        sendPage({ response, status: 413, html: messagePage({ title: "Request too large", message: "This address only accepts the sign-in provider's form." }) });
        return null;
      }
      return new URLSearchParams(body);
    }
    default:
      return assertNever(options.responseMode);
  }
}

type SameSite = Extract<CookieSameSite, "Lax" | "None">;

/** Where the pending sign-in cookie lives and whether a cross-site callback carries it. */
function signInCookieScope(provider: IdentityProvider): Readonly<{ path: string; sameSite: SameSite }> {
  switch (provider.responseMode) {
    case "query":
      return { path: `${ACCOUNT_PATH}/callback`, sameSite: "Lax" };
    case "form_post":
      // See "Login CSRF" in the header: the provider's POST is cross-site.
      return { path: `${ACCOUNT_PATH}/callback/${provider.name}`, sameSite: "None" };
    default:
      return assertNever(provider.responseMode);
  }
}

// ---------------------------------------------------------------- session cookie

/** `authenticatedAtMs`: when the sign-in behind it happened, for `LINK_FRESHNESS_MS`. */
type Session = Readonly<{ accountId: AccountId; expiresAtMs: number; csrf: string; authenticatedAtMs: number }>;

type SessionCodec = Readonly<{
  issue(options: Readonly<{ accountId: AccountId; nowMs: number; csrf: string }>): string;
  read(options: Readonly<{ request: IncomingMessage; nowMs: number }>): Session | null;
}>;

function sessionCodec(options: Readonly<{ secret: string }>): SessionCodec {
  // Unlabelled: the label was added with the deck cookie, and a new one would sign everyone out.
  const signed = signedValues({ secret: options.secret, label: "" });
  return {
    issue: ({ accountId, nowMs, csrf }) => {
      // Every session is issued by a sign-in, so its issue time is when the sign-in happened.
      return setCookie({
        name: SESSION_COOKIE_NAME,
        value: signed.seal({ accountId, exp: nowMs + SESSION_LIFETIME_MS, csrf, auth: nowMs }),
        path: ACCOUNT_PATH,
        maxAgeSeconds: SESSION_LIFETIME_MS / 1000,
        sameSite: "Lax",
      });
    },
    read: ({ request, nowMs }) => {
      const [value] = cookieValues({ request, name: SESSION_COOKIE_NAME });
      if (value === undefined) return null;
      const claims = signed.open(value);
      const accountId = asString(claims?.accountId);
      const csrf = asString(claims?.csrf);
      const expiresAtMs = claims?.exp;
      if (accountId === null || csrf === null || typeof expiresAtMs !== "number") return null;
      if (expiresAtMs <= nowMs) return null;
      // A cookie from before `auth` existed was issued at sign-in, one lifetime before it expires.
      const authenticatedAtMs = typeof claims?.auth === "number" ? claims.auth : expiresAtMs - SESSION_LIFETIME_MS;
      return { accountId, expiresAtMs, csrf, authenticatedAtMs };
    },
  };
}

// ---------------------------------------------------------------- form token (before a session exists)

type FormCodec = Readonly<{
  /** This browser's form cookie (kept when it already has a well-formed one) and the field that matches it. */
  issue(request: IncomingMessage): Readonly<{ token: string; cookie: string }>;
  verify(options: Readonly<{ request: IncomingMessage; field: string | null }>): boolean;
}>;

function formCodec(options: Readonly<{ secret: string; randomToken: () => string }>): FormCodec {
  const mac = (value: string): string => createHmac("sha256", options.secret).update(`form:${value}`).digest("base64url");
  const current = (request: IncomingMessage): string | null => {
    const value = cookieValues({ request, name: FORM_COOKIE_NAME }).find((candidate) => /^[A-Za-z0-9_-]{32,128}$/.test(candidate));
    return value ?? null;
  };
  return {
    issue: (request) => {
      const value = current(request) ?? options.randomToken();
      return {
        token: mac(value),
        cookie: setCookie({ name: FORM_COOKIE_NAME, value, path: "/", maxAgeSeconds: FORM_COOKIE_LIFETIME_MS / 1000, sameSite: "Lax" }),
      };
    },
    verify: ({ request, field }) => {
      const value = current(request);
      return value !== null && field !== null && constantTimeEqual(field, mac(value));
    },
  };
}

function clearSessionCookie(): string {
  return clearCookie({ name: SESSION_COOKIE_NAME, path: ACCOUNT_PATH, sameSite: "Lax" });
}

function clearReturnCookie(): string {
  return clearCookie({ name: RETURN_COOKIE_NAME, path: ACCOUNT_PATH, sameSite: "Lax" });
}

/** A cookie value we encoded; null when it is not valid percent-encoding (then `/decks` is used). */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- passkey options

/**
 * What `navigator.credentials.create` is given, binary fields as base64url. A discoverable
 * credential (`residentKey: "required"`) is what makes a later sign-in need no username.
 * The user handle is fresh random bytes per passkey, never the account id, so the
 * authenticator holds nothing that names the account.
 */
function creationOptions(
  options: Readonly<{ relyingParty: RelyingParty; challenge: string; userHandle: string; excludeIds: readonly string[]; nowMs: number }>,
): Readonly<Record<string, unknown>> {
  const { relyingParty, challenge, userHandle, excludeIds, nowMs } = options;
  // Shown in the passkey picker; the date tells two Sasha Slides passkeys apart.
  const label = `Sasha Slides account (${new Date(nowMs).toISOString().slice(0, 10)})`;
  return {
    rp: { id: relyingParty.id, name: "Sasha Slides" },
    user: { id: userHandle, name: label, displayName: label },
    challenge,
    pubKeyCredParams: PASSKEY_ALGORITHMS.map((algorithm) => ({ type: "public-key", alg: PASSKEY_ALGORITHM_IDS[algorithm] })),
    timeout: PASSKEY_CHALLENGE_LIFETIME_MS,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    excludeCredentials: excludeIds.map((id) => ({ type: "public-key", id })),
  };
}

// ---------------------------------------------------------------- request bodies

/** A form body as text, or null when it exceeds `MAX_FORM_BYTES`. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return readBodyText({ request, maximumBytes: MAX_FORM_BYTES, onOverflow: "destroy" });
}

// ---------------------------------------------------------------- responses

/** A key, drawn in the text colour: passkeys belong to no company, so no logo. */
const PASSKEY_MARK =
  '<svg class="mark" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M15.5 7.5l3 3M18 5l2 2"/></svg>';

/** An envelope, drawn in the text colour like the passkey's key. */
const EMAIL_MARK =
  '<svg class="mark" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';

/** The passkey script's absolute URL: the one script source the CSP names. */
function scriptUrlFor(relyingParty: RelyingParty): string {
  return `${relyingParty.origin}${PASSKEY_SCRIPT_PATH}`;
}

const PAGE_HEADERS = pageHeaders({ formAction: "'self'" });

/**
 * `PAGE_HEADERS` for the two pages with passkey buttons: the policy also admits the passkey
 * script and its endpoints. `script-src` and `connect-src` name full URLs rather than
 * `'self'`, so any other same-origin response stays inert here. Every other page keeps the
 * policy that allows no script at all.
 */
function passkeyPageHeaders(options: Readonly<{ origin: string }>): Readonly<Record<string, string>> {
  const policy = [
    "default-src 'none'",
    `style-src ${STYLE_HASH}`,
    `script-src ${options.origin}${PASSKEY_SCRIPT_PATH}`,
    `connect-src ${options.origin}${PASSKEY_PATH}/`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  return { ...PAGE_HEADERS, "content-security-policy": policy };
}

function sendPage(
  options: Readonly<{
    response: ServerResponse;
    status: number;
    html: string;
    cookies?: readonly string[];
    /** `PAGE_HEADERS` when absent. */
    headers?: Readonly<Record<string, string>>;
  }>,
): void {
  sendHtml({ ...options, headers: options.headers ?? PAGE_HEADERS });
}

function sendMethodNotAllowed(options: Readonly<{ response: ServerResponse; allow: string }>): void {
  const html = messagePage({ title: "Not allowed", message: "This page does not accept that kind of request." });
  sendHtml({ response: options.response, status: 405, html, headers: { ...PAGE_HEADERS, allow: options.allow } });
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

function sendThrottled(options: Readonly<{ response: ServerResponse; retryAfterMs: number }>): void {
  const seconds = Math.max(1, Math.ceil(options.retryAfterMs / 1000));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  sendPage({
    response: options.response,
    status: 429,
    html: messagePage({
      title: "Too many attempts",
      message: `To keep accounts safe, we limit how often this can be done. Please try again later, in about ${String(minutes)} minute${minutes === 1 ? "" : "s"}.`,
      action: { href: ACCOUNT_PATH, label: "Back to the account page" },
    }),
    headers: { ...PAGE_HEADERS, "retry-after": String(seconds) },
  });
}

// ---------------------------------------------------------------- pages

type EmailFormState = Readonly<{ token: string; email: string; error: string | null }>;

function signedOutPage(
  options: Readonly<{ providers: readonly IdentityProvider[]; scriptUrl: string; emailForm: EmailFormState | null }>,
): string {
  const buttons = options.providers
    .map(
      (provider) =>
        `<a class="${buttonClass(provider.name)}" href="${escapeHtml(`${ACCOUNT_PATH}/login/${encodeURIComponent(provider.name)}`)}">${providerMark(provider.name)}Continue with ${escapeHtml(provider.displayName)}</a>`,
    )
    .join("\n");
  return layout({
    title: "Your account",
    main: `<h1>Sign in to manage your Sasha Slides data</h1>
<p class="muted">Use the same sign-in you use with Sasha Slides. You can then see what is linked to your account and delete your data.</p>
${buttons === "" ? "" : `<nav class="providers" aria-label="Sign-in options">\n${buttons}\n</nav>`}
<div class="providers" data-passkeys hidden>
<button type="button" class="button" data-passkey="signin">${PASSKEY_MARK}Sign in with a passkey</button>
<button type="button" class="button" data-passkey="create">${PASSKEY_MARK}Create an account with a passkey</button>
<p class="status" role="status" data-passkey-status hidden></p>
</div>
${options.emailForm === null ? "" : emailSignInForm(options.emailForm)}`,
    scriptUrl: options.scriptUrl,
  });
}

function emailSignInForm(state: EmailFormState): string {
  return `<h2>Sign in with email</h2>
${errorLine(state.error)}<form method="post" action="${ACCOUNT_PATH}/email/signin">
${formField(state.token)}
${emailInput({ value: state.email, autocomplete: "username" })}
${passwordInput({ autocomplete: "current-password" })}
<button type="submit">Sign in</button>
</form>
<p class="alternatives"><a href="${ACCOUNT_PATH}/email/signup">Create an account with email</a><a href="${ACCOUNT_PATH}/email/forgot">Forgot your password?</a></p>`;
}

function signUpPage(state: EmailFormState): string {
  return layout({
    title: "Create an account",
    main: `<h1>Create a Sasha Slides account</h1>
<p class="muted">We will email you a link to confirm the address. Your account works once you open it.</p>
${errorLine(state.error)}<form method="post" action="${ACCOUNT_PATH}/email/signup">
${formField(state.token)}
${emailInput({ value: state.email, autocomplete: "username" })}
${passwordInput({ autocomplete: "new-password" })}
<p class="muted">At least ${String(MIN_PASSWORD_LENGTH)} characters.</p>
<button type="submit">Create account</button>
</form>
<p class="alternatives"><a href="${ACCOUNT_PATH}">I already have an account</a></p>`,
  });
}

function forgotPage(state: EmailFormState): string {
  return layout({
    title: "Reset your password",
    main: `<h1>Reset your password</h1>
<p class="muted">Enter the address you signed up with. If it has an account, we will email you a link to choose a new password.</p>
${errorLine(state.error)}<form method="post" action="${ACCOUNT_PATH}/email/forgot">
${formField(state.token)}
${emailInput({ value: state.email, autocomplete: "username" })}
<button type="submit">Email me a link</button>
</form>`,
  });
}

function confirmPage(options: Readonly<{ formToken: string; linkToken: string }>): string {
  return layout({
    title: "Confirm your email address",
    main: `<h1>Confirm your email address</h1>
<p>Press the button to confirm this address and sign in to your new Sasha Slides account.</p>
<form method="post" action="${ACCOUNT_PATH}/email/verify">
${formField(options.formToken)}
<input type="hidden" name="token" value="${escapeHtml(options.linkToken)}">
<button type="submit">Confirm and sign in</button>
</form>`,
  });
}

function newPasswordPage(options: Readonly<{ formToken: string; linkToken: string; error: string | null }>): string {
  return layout({
    title: "Choose a new password",
    main: `<h1>Choose a new password</h1>
${errorLine(options.error)}<form method="post" action="${ACCOUNT_PATH}/email/reset">
${formField(options.formToken)}
<input type="hidden" name="token" value="${escapeHtml(options.linkToken)}">
${passwordInput({ autocomplete: "new-password" })}
<p class="muted">At least ${String(MIN_PASSWORD_LENGTH)} characters.</p>
<button type="submit">Save and sign in</button>
</form>`,
  });
}

function checkEmailPage(options: Readonly<{ message: string }>): string {
  return messagePage({ title: "Check your email", message: options.message, action: { href: ACCOUNT_PATH, label: "Back to the account page" } });
}

function deadLinkPage(purpose: LinkPurpose): string {
  const again = startAgain(purpose);
  return messagePage({
    title: "This link no longer works",
    message: `Links work once, for ${String(EMAIL_LINK_LIFETIME_MS / 60_000)} minutes, and only the newest one does. This one has expired, was already used, or was replaced by a newer one.`,
    action: again,
  });
}

function startAgain(purpose: LinkPurpose): Readonly<{ href: string; label: string }> {
  switch (purpose) {
    case "confirm":
      return { href: `${ACCOUNT_PATH}/email/signup`, label: "Sign up again" };
    case "reset":
      return { href: `${ACCOUNT_PATH}/email/forgot`, label: "Ask for a new link" };
    case "link":
      return { href: `${ACCOUNT_PATH}/email/add`, label: "Ask for a new link" };
    default:
      return assertNever(purpose);
  }
}

function problemText(problem: InputProblem): string {
  switch (problem) {
    case "address":
      return "Enter a valid email address, like name@example.com.";
    case "password-too-short":
      return `Use at least ${String(MIN_PASSWORD_LENGTH)} characters for your password.`;
    case "password-too-long":
      return `Use at most ${String(MAX_PASSWORD_LENGTH)} characters for your password.`;
    default:
      return assertNever(problem);
  }
}

function errorLine(error: string | null): string {
  return error === null ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>\n`;
}

function formField(token: string): string {
  return `<input type="hidden" name="form" value="${escapeHtml(token)}">`;
}

function emailInput(options: Readonly<{ value: string; autocomplete: string }>): string {
  return `<label class="field">Email address<input type="email" name="email" value="${escapeHtml(options.value)}" autocomplete="${options.autocomplete}" maxlength="254" required></label>`;
}

function passwordInput(options: Readonly<{ autocomplete: string }>): string {
  return `<label class="field">Password<input type="password" name="password" autocomplete="${options.autocomplete}" minlength="${String(MIN_PASSWORD_LENGTH)}" maxlength="${String(MAX_PASSWORD_LENGTH)}" required></label>`;
}

function buttonClass(providerName: string): string {
  const extra = providerButtonClass(providerName);
  return extra === null ? "button" : `button ${extra}`;
}

function signedInPage(
  options: Readonly<{
    links: readonly LinkedSignIn[];
    providers: ReadonlyMap<string, IdentityProvider>;
    csrf: string;
    scriptUrl: string;
    /** A sign-in within `LINK_FRESHNESS_MS`: methods can be added and removed. */
    fresh: boolean;
    /** The `?token=` of the provider link-start URLs. */
    linkToken: string;
    emailEnabled: boolean;
  }>,
): string {
  const { links, providers, csrf, fresh } = options;
  const csrfField = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  const removable = fresh && links.length > 1;
  const items = links
    .map((link) => {
      const name = linkLabel({ provider: link.provider, providers });
      const detail = linkDetail(link);
      const remove = removable
        ? `<form class="inline" method="post" action="${ACCOUNT_PATH}/unlink">${csrfField}<input type="hidden" name="link" value="${escapeHtml(link.linkId)}"><button type="submit" class="quiet" aria-label="Remove ${escapeHtml(name)}${detail === null ? "" : ` ${escapeHtml(detail)}`}">Remove</button></form>`
        : "";
      return `<li><span class="method"><span class="method-name">${escapeHtml(name)}</span>${detail === null ? "" : `<span class="hint">${escapeHtml(detail)}</span>`}</span><span class="method-side"><span>Added ${escapeHtml(formatDay(link.linkedAtMs))}</span>${remove}</span></li>`;
    })
    .join("\n");
  const linkedProviders = new Set(links.map((link) => link.provider));
  const addButtons = [...providers.values()]
    .filter((provider) => !linkedProviders.has(provider.name))
    .map(
      (provider) =>
        `<a class="${buttonClass(provider.name)}" href="${escapeHtml(`${ACCOUNT_PATH}/link/${encodeURIComponent(provider.name)}?token=${encodeURIComponent(options.linkToken)}`)}">${providerMark(provider.name)}Continue with ${escapeHtml(provider.displayName)}</a>`,
    );
  if (options.emailEnabled && !linkedProviders.has(EMAIL_PROVIDER)) {
    addButtons.push(`<a class="button" href="${ACCOUNT_PATH}/email/add">${EMAIL_MARK}Add an email address and password</a>`);
  }
  const adding = fresh
    ? `<h2>Add a sign-in method</h2>
<p class="muted">Each one you add signs in to this same account.</p>
${addButtons.length === 0 ? "" : `<nav class="providers" aria-label="Add a sign-in method">\n${addButtons.join("\n")}\n</nav>`}
<div class="providers" data-passkeys data-csrf="${escapeHtml(csrf)}" hidden>
<button type="button" class="button" data-passkey="add">${PASSKEY_MARK}Add a passkey</button>
<p class="status" role="status" data-passkey-status hidden></p>
</div>`
    : `<div class="notice">
<p>${escapeHtml(SIGN_IN_AGAIN_MESSAGE)}</p>
<form method="post" action="${ACCOUNT_PATH}/logout">
${csrfField}
<button type="submit">Sign out and sign in again</button>
</form>
</div>`;
  return layout({
    title: "Your account",
    main: `<h1>Your Sasha Slides account</h1>
<h2>Sign-in methods</h2>
<ul class="links">
${items}
</ul>
${adding}
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
    scriptUrl: options.scriptUrl,
  });
}

/** The second line of a linked sign-in: its address hint, or a passkey's name. */
function linkDetail(link: LinkedSignIn): string | null {
  // The name the passkey was offered under (`creationOptions`), as the person's passkey manager shows it.
  if (link.provider === PASSKEY_PROVIDER) return `Sasha Slides account (${new Date(link.linkedAtMs).toISOString().slice(0, 10)})`;
  return link.emailHint;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** `11 October 2026`: full words, one form for every reader. */
function formatDay(timeMs: number): string {
  return DAY_FORMAT.format(new Date(timeMs));
}

function addEmailPage(options: Readonly<{ csrf: string; email: string; error: string | null }>): string {
  return layout({
    title: "Add an email address",
    main: `<h1>Add an email address and password</h1>
<p class="muted">We will email you a link. Open it in this browser, while signed in, to add the address as a way to sign in to this account.</p>
${errorLine(options.error)}<form method="post" action="${ACCOUNT_PATH}/email/add">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
${emailInput({ value: options.email, autocomplete: "username" })}
${passwordInput({ autocomplete: "new-password" })}
<p class="muted">At least ${String(MIN_PASSWORD_LENGTH)} characters.</p>
<button type="submit">Email me a link</button>
</form>
<p class="alternatives"><a href="${ACCOUNT_PATH}">Back to your account</a></p>`,
  });
}

function confirmAddressLinkPage(options: Readonly<{ csrf: string; linkToken: string }>): string {
  return layout({
    title: "Add this email address",
    main: `<h1>Add this email address</h1>
<p>Press the button to add this address and its password as a way to sign in to your Sasha Slides account.</p>
<form method="post" action="${ACCOUNT_PATH}/email/link">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<input type="hidden" name="token" value="${escapeHtml(options.linkToken)}">
<button type="submit">Add to my account</button>
</form>`,
  });
}

/** Shown wherever adding or removing a sign-in method meets a session that is not fresh. */
const SIGN_IN_AGAIN_MESSAGE =
  `For your safety, adding or removing a sign-in method needs a sign-in from the last ${String(LINK_FRESHNESS_MS / 60_000)} minutes. Sign out, sign in again, then try again.`;

function signInAgainPage(): string {
  return messagePage({ title: "Please sign in again first", message: SIGN_IN_AGAIN_MESSAGE, action: { href: ACCOUNT_PATH, label: "Back to your account" } });
}

function nothingChangedPage(message: string): string {
  return messagePage({ title: "Nothing was changed", message, action: { href: ACCOUNT_PATH, label: "Back to your account" } });
}

function sendSessionEnded(response: ServerResponse): void {
  sendPage({
    response,
    status: 401,
    html: messagePage({
      title: "Your session has ended",
      message: "For your safety, sessions last 15 minutes. Sign in again to continue; nothing was changed.",
      action: { href: ACCOUNT_PATH, label: "Sign in again" },
    }),
  });
}

/** What a linked sign-in is called on the account page. */
function linkLabel(options: Readonly<{ provider: string; providers: ReadonlyMap<string, IdentityProvider> }>): string {
  if (options.provider === PASSKEY_PROVIDER) return "Passkey";
  if (options.provider === EMAIL_PROVIDER) return EMAIL_PROVIDER_DISPLAY_NAME;
  return options.providers.get(options.provider)?.displayName ?? options.provider;
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
