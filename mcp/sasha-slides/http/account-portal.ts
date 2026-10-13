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
 * Pending sign-ins live in this process's memory for 10 minutes. A deployment with several
 * instances behind a load balancer would need sticky sessions or a shared store for them.
 *
 * The page HTML is rendered with template strings: these are static pages whose only script
 * shows the passkey buttons and runs the ceremony, which is the exception the React rule names.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertNever } from "../google-auth";
import {
  PASSKEY_PROVIDER,
  type AccountDirectory,
  type LinkedSignIn,
  type NewPasskey,
  type PasskeyLinkOutcome,
} from "./account-directory";
import type { AccountEraser, AccountId, EraseReport } from "./account-vault";
import { clientAddress, type TrustedProxies } from "./client-address";
import type { IdentityProvider, PendingSignIn, ResponseMode } from "./identity-providers";
import { asRecord, asString, parseJson } from "./json-values";
import {
  EMAIL_LINK_LIFETIME_MS,
  EMAIL_PROVIDER,
  EMAIL_PROVIDER_DISPLAY_NAME,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type InputProblem,
  type LinkOutcome,
  type LinkPurpose,
  type PasswordSignIn,
} from "./password-sign-in";
import { PASSKEY_SCRIPT } from "./passkey-script.generated";
import { providerButtonClass, providerMark } from "./provider-marks";
import { SASHA_ICON_SVG } from "./sasha-icon.generated";
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
  }>,
): AccountPortal {
  const { publicUrl, sessionSecret, directory, eraser, now, randomToken, warn } = options;
  const passwordSignIn = options.passwordSignIn ?? null;
  const providers = new Map(options.providers.map((provider) => [provider.name, provider]));
  const pendingSignIns = new Map<string, Readonly<{ pending: PendingSignIn; expiresAtMs: number }>>();
  const pendingPasskeys = new Map<string, Readonly<{ pending: PendingPasskey; expiresAtMs: number }>>();
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
        return sendScript(response);
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
    sendPage({
      response,
      status: 200,
      html: signedInPage({ links: description.links, providers, csrf: session.csrf, scriptUrl: scriptUrlFor(relyingParty) }),
      headers: passkeyHeaders,
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

  function rememberPendingSignIn(pending: PendingSignIn): void {
    rememberBounded({ entries: pendingSignIns, key: pending.state, pending, nowMs: now().getTime(), lifetimeMs: PENDING_SIGNIN_LIFETIME_MS });
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
    const entry = state === null ? undefined : pendingSignIns.get(state);
    // Taken on first sight, so a replay finds nothing whatever happens below.
    if (state !== null) pendingSignIns.delete(state);
    const scope = signInCookieScope(provider);
    const clearSignIn = clearCookie({ name: SIGNIN_COOKIE_NAME, path: scope.path, sameSite: scope.sameSite });
    if (
      state === null ||
      !boundStates.some((boundState) => constantTimeEqual(state, boundState)) ||
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
      cookies: [clearSessionCookie()],
    });
  }

  async function logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (sessions.read({ request, nowMs: now().getTime() }) === null) {
      sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: [clearSessionCookie()] });
      return;
    }
    const form = await readVerifiedForm(request, response);
    if (form === null) return;
    sendRedirect({ response, status: 303, location: ACCOUNT_PATH, cookies: [clearSessionCookie()] });
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
    rememberBounded({ entries: pendingPasskeys, key: challenge, pending, nowMs, lifetimeMs: PASSKEY_CHALLENGE_LIFETIME_MS });
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
    const entry = challenge === null ? undefined : pendingPasskeys.get(challenge);
    if (challenge !== null) pendingPasskeys.delete(challenge);
    if (challenge === null || entry === undefined || entry.expiresAtMs <= now().getTime() || entry.pending.ceremony !== ceremony) {
      return refuse({ status: 400, message: "This passkey request has expired or was already used. Please try again.", reason: "no live challenge for this browser" });
    }
    const { pending } = entry;
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
    const text = await readBodyUpTo({ request, maxBytes: MAX_PASSKEY_BODY_BYTES });
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

type PortalRoute =
  | Readonly<{ kind: "email"; action: EmailAction }>
  | Readonly<{ kind: "home" }>
  | Readonly<{ kind: "login"; provider: string }>
  | Readonly<{ kind: "callback"; provider: string }>
  | Readonly<{ kind: "erase" }>
  | Readonly<{ kind: "logout" }>
  | Readonly<{ kind: "passkey-script" }>
  | Readonly<{ kind: "passkey-options"; ceremony: PasskeyCeremony }>
  | Readonly<{ kind: "passkey-verify"; ceremony: PasskeyCeremony }>
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
  if (section === "email" && options.emailEnabled && providerName !== undefined && isEmailAction(providerName)) {
    return { kind: "email", action: providerName };
  }
  if ((section === "login" || section === "callback") && providerName !== undefined && providerName !== "") {
    return section === "login" ? { kind: "login", provider: providerName } : { kind: "callback", provider: providerName };
  }
  if (providerName !== undefined) return { kind: "not-found" };
  if (section === "erase") return { kind: "erase" };
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
 * Remembers one pending ceremony: expired entries are dropped first, then the oldest, so
 * someone hammering the start endpoints bounds memory instead of exhausting it.
 */
function rememberBounded<TPending>(
  options: Readonly<{
    entries: Map<string, Readonly<{ pending: TPending; expiresAtMs: number }>>;
    key: string;
    pending: TPending;
    nowMs: number;
    lifetimeMs: number;
  }>,
): void {
  const { entries, key, pending, nowMs, lifetimeMs } = options;
  for (const [existing, entry] of entries) {
    if (entry.expiresAtMs <= nowMs) entries.delete(existing);
  }
  while (entries.size >= MAX_PENDING_SIGNINS) {
    const oldest = entries.keys().next();
    if (oldest.done === true) break;
    entries.delete(oldest.value);
  }
  entries.set(key, { pending, expiresAtMs: nowMs + lifetimeMs });
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

type SameSite = "Lax" | "None";

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
        sameSite: "Lax",
      });
    },
    read: ({ request, nowMs }) => {
      const [value] = cookieValues({ request, name: SESSION_COOKIE_NAME });
      if (value === undefined) return null;
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

function setCookie(
  options: Readonly<{ name: string; value: string; path: string; maxAgeSeconds: number; sameSite: SameSite }>,
): string {
  return `${options.name}=${options.value}; Path=${options.path}; Max-Age=${String(options.maxAgeSeconds)}; HttpOnly; Secure; SameSite=${options.sameSite}`;
}

function clearCookie(options: Readonly<{ name: string; path: string; sameSite: SameSite }>): string {
  return `${options.name}=; Path=${options.path}; Max-Age=0; HttpOnly; Secure; SameSite=${options.sameSite}`;
}

function clearSessionCookie(): string {
  return clearCookie({ name: SESSION_COOKIE_NAME, path: ACCOUNT_PATH, sameSite: "Lax" });
}

/** Every value sent under `name`, most specific path first (the order browsers send them in). */
function cookieValues(options: Readonly<{ request: IncomingMessage; name: string }>): readonly string[] {
  const header = options.request.headers.cookie;
  if (header === undefined) return [];
  const values: string[] = [];
  for (const pair of header.split(/;\s*/)) {
    const equals = pair.indexOf("=");
    if (equals > 0 && pair.slice(0, equals) === options.name) values.push(pair.slice(equals + 1));
  }
  return values;
}

/** Compares digests, so neither the length nor the content of the secret leaks by timing. */
function constantTimeEqual(left: string, right: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text, "utf-8").digest();
  return timingSafeEqual(digest(left), digest(right));
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

function mediaTypeOf(request: IncomingMessage): string | null {
  const header = request.headers["content-type"];
  if (typeof header !== "string") return null;
  return header.split(";")[0]?.trim().toLowerCase() ?? null;
}

/** The body as text, or null when it exceeds `MAX_FORM_BYTES`. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return readBodyUpTo({ request, maxBytes: MAX_FORM_BYTES });
}

/** The body as text, or null when it exceeds `maxBytes`. */
function readBodyUpTo(options: Readonly<{ request: IncomingMessage; maxBytes: number }>): Promise<string | null> {
  const { request, maxBytes } = options;
  return new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
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
.button-apple{background:#000;border-color:#000;color:#fff}
.button-apple:hover{border-color:#000;opacity:.85}
@media (prefers-color-scheme:dark){.button-apple{background:#fff;border-color:#fff;color:#000}.button-apple:hover{border-color:#fff}}
button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
button.quiet{display:inline;width:auto;padding:0;border:0;background:none;color:var(--link);font-weight:400}
ul.links{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}
ul.links li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:12px 0;border-bottom:1px solid var(--line)}
.hint{color:var(--muted);word-break:break-all}
label.confirm{display:flex;gap:10px;align-items:flex-start;margin:16px 0}
label.confirm input{flex:none;width:18px;height:18px;margin-top:4px}
form.signout{margin-top:32px}
[hidden]{display:none!important}
.passkeys{margin-top:16px}
.providers[data-passkeys]{margin-top:12px}
.status{margin:0;color:var(--danger)}
label.field{display:block;margin:16px 0 0;font-weight:500}
label.field input{display:block;width:100%;margin-top:6px;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;font-weight:400}
label.field+button,label.field~button{margin-top:22px}
.error{color:var(--danger);font-weight:500}
.alternatives{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px 20px}
`;

/** A key, drawn in the text colour: passkeys belong to no company, so no logo. */
const PASSKEY_MARK =
  '<svg class="mark" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M15.5 7.5l3 3M18 5l2 2"/></svg>';

/** The CSP admits exactly this stylesheet by hash, so no `'unsafe-inline'` is needed. */
const STYLE_HASH = `'sha256-${createHash("sha256").update(STYLE, "utf-8").digest("base64")}'`;

/** The passkey script's absolute URL: the one script source the CSP names. */
function scriptUrlFor(relyingParty: RelyingParty): string {
  return `${relyingParty.origin}${PASSKEY_SCRIPT_PATH}`;
}

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src ${STYLE_HASH}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Keeps the callback's code and state out of any Referer a later navigation sends.
  "referrer-policy": "no-referrer",
};

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
  const { response, status, html, cookies } = options;
  response.writeHead(status, {
    ...(options.headers ?? PAGE_HEADERS),
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

function sendMethodNotAllowed(options: Readonly<{ response: ServerResponse; allow: string }>): void {
  const html = messagePage({ title: "Not allowed", message: "This page does not accept that kind of request." });
  options.response.writeHead(405, {
    ...PAGE_HEADERS,
    allow: options.allow,
    "content-length": String(Buffer.byteLength(html, "utf-8")),
  });
  options.response.end(html);
}

function sendJson(
  options: Readonly<{ response: ServerResponse; status: number; body: Readonly<Record<string, unknown>>; cookies: readonly string[] }>,
): void {
  const text = JSON.stringify(options.body);
  options.response.writeHead(options.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text, "utf-8")),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(options.cookies.length === 0 ? {} : { "set-cookie": [...options.cookies] }),
  });
  options.response.end(text);
}

function sendScript(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": String(Buffer.byteLength(PASSKEY_SCRIPT, "utf-8")),
    // Revalidated on every page load, so a deploy is picked up at once.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  response.end(PASSKEY_SCRIPT);
}

// ---------------------------------------------------------------- pages

function layout(options: Readonly<{ title: string; main: string; scriptUrl?: string }>): string {
  const script = options.scriptUrl === undefined ? "" : `\n<script src="${escapeHtml(options.scriptUrl)}" defer></script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} · Sasha Slides</title>
<style>${STYLE}</style>${script}
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
  options: Readonly<{ links: readonly LinkedSignIn[]; providers: ReadonlyMap<string, IdentityProvider>; csrf: string; scriptUrl: string }>,
): string {
  const { links, providers, csrf } = options;
  const items = links
    .map((link) => {
      const name = linkLabel({ provider: link.provider, providers });
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
<div class="passkeys" data-passkeys data-csrf="${escapeHtml(csrf)}" hidden>
<button type="button" class="button" data-passkey="add">${PASSKEY_MARK}Add a passkey</button>
<p class="status" role="status" data-passkey-status hidden></p>
</div>
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
