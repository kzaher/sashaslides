/**
 * The /account portal over real HTTP on a loopback port, signing in through fake providers
 * and erasing through a fake eraser. No network beyond 127.0.0.1.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/account-portal.test.ts
 *
 * Ordered like a visit: the signed-out page, the sign-in round trip and its replay and
 * cross-browser defences, Sign in with Apple's form POST callback, the session cookie, then
 * erase and sign-out, then escaping.
 */
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { inMemoryAccountDirectory, type AccountDirectory } from "../http/account-directory";
import { createAccountPortal } from "../http/account-portal";
import type { AccountId, EraseReport } from "../http/account-vault";
import { createIdentityProvider, type IdentityProviderSpec } from "../http/identity-providers";
import {
  createFakeApple,
  createFakeGitHub,
  createFakeOidcIssuer,
  fakeFetch,
  generateAppleKey,
  type FakeApple,
  type FakeGitHub,
  type FakeOidcIssuer,
  type IdTokenTamper,
} from "./fake-identity-providers";

const PUBLIC_URL = "https://slides.example.test";
const SESSION_SECRET = "a-session-secret-that-is-at-least-thirty-two-bytes-long";
const SESSION_COOKIE = "sasha_account";
const SIGNIN_COOKIE = "sasha_signin";

type ProviderName = "google" | "apple" | "okta" | "github";

const APPLE_KEY = generateAppleKey();
const APPLE_SUBJECT = "001234.abcdef.0987";

const SPECS: Readonly<Record<ProviderName, IdentityProviderSpec>> = {
  google: {
    protocol: "oidc",
    name: "google",
    displayName: "Google",
    issuer: "https://accounts.google.com",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    clientId: "google-client",
    clientSecret: "google-secret",
    scopes: ["openid", "email"],
  },
  apple: {
    protocol: "apple",
    name: "apple",
    displayName: "Apple",
    clientId: "com.sashaslides.signin",
    teamId: "TEAM123456",
    keyId: "ABC123DEFG",
    privateKey: APPLE_KEY.privateKey,
    scopes: ["name", "email"],
  },
  okta: {
    protocol: "oidc",
    name: "okta",
    displayName: "Okta",
    issuer: "https://acme.okta.example",
    issuers: ["https://acme.okta.example"],
    clientId: "okta-client",
    clientSecret: "okta-secret",
    scopes: ["openid", "email"],
  },
  github: {
    protocol: "github",
    name: "github",
    displayName: "GitHub",
    clientId: "gh-client",
    clientSecret: "gh-secret",
    scopes: ["read:user", "user:email"],
  },
};

type Portal = Readonly<{
  baseUrl: string;
  okta: FakeOidcIssuer;
  github: FakeGitHub;
  apple: FakeApple;
  directory: AccountDirectory;
  eraseCalls: AccountId[];
  advanceClock: (milliseconds: number) => void;
}>;

const servers: { close: () => void }[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function startPortal(
  options: Readonly<{ providers: readonly ProviderName[]; eraseReport: EraseReport }>,
): Promise<Portal> {
  let nowMs = Date.parse("2026-10-11T12:00:00Z");
  const now = (): Date => new Date(nowMs);
  const okta = createFakeOidcIssuer({
    discoveryBase: "https://acme.okta.example",
    advertisedIssuer: "https://acme.okta.example",
    tokenIssuer: "https://acme.okta.example",
    clientId: "okta-client",
    clientSecret: "okta-secret",
    now,
    extraClaims: {},
  });
  const google = createFakeOidcIssuer({
    discoveryBase: "https://accounts.google.com",
    advertisedIssuer: "https://accounts.google.com",
    tokenIssuer: "https://accounts.google.com",
    clientId: "google-client",
    clientSecret: "google-secret",
    now,
    extraClaims: {},
  });
  const github = createFakeGitHub({
    clientId: "gh-client",
    clientSecret: "gh-secret",
    userId: 7,
    emails: [{ email: "octo@example.com", primary: true, verified: true }],
  });
  const apple = createFakeApple({ clientId: "com.sashaslides.signin", teamId: "TEAM123456", keyId: "ABC123DEFG", clientPublicKey: APPLE_KEY.publicKey, now });
  const network = fakeFetch({ routes: [okta.route, google.route, github.route, apple.route] });
  let counter = 0;
  const randomToken = (): string => `random-${String((counter += 1))}-${"x".repeat(32)}`;
  const directory = inMemoryAccountDirectory({ randomToken });
  const eraseCalls: AccountId[] = [];
  const portal = createAccountPortal({
    publicUrl: PUBLIC_URL,
    sessionSecret: SESSION_SECRET,
    providers: options.providers.map((name) =>
      createIdentityProvider({ spec: SPECS[name], fetch: network.fetch, now, randomToken, timeoutMs: 5000 }),
    ),
    directory,
    eraser: {
      eraseAccount: ({ accountId }) => {
        eraseCalls.push(accountId);
        return Promise.resolve(options.eraseReport);
      },
    },
    now,
    randomToken,
    warn: () => undefined,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    void portal.handleRequest({ request, response, url }).then((handled) => {
      if (!handled) response.writeHead(404).end("not the portal");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    okta,
    github,
    apple,
    directory,
    eraseCalls,
    advanceClock: (milliseconds) => {
      nowMs += milliseconds;
    },
  };
}

const REVOKED: EraseReport = { googleTokenRevoked: true, recordsRemoved: 4, keyDestroyed: true };

type Visit = Readonly<{ status: number; location: string | null; setCookies: readonly string[]; body: string }>;

async function visit(
  options: Readonly<{ url: string; cookies: Readonly<Record<string, string>>; form?: Readonly<Record<string, string>> }>,
): Promise<Visit> {
  const cookieHeader = Object.entries(options.cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const response = await fetch(options.url, {
    method: options.form === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      ...(cookieHeader === "" ? {} : { cookie: cookieHeader }),
      ...(options.form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    },
    ...(options.form === undefined ? {} : { body: new URLSearchParams(options.form).toString() }),
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookies: response.headers.getSetCookie(),
    body: await response.text(),
  };
}

function cookieValue(setCookies: readonly string[], name: string): string | null {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return null;
}

function cookieLine(setCookies: readonly string[], name: string): string {
  return setCookies.find((line) => line.startsWith(`${name}=`)) ?? "";
}

function csrfOf(body: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(body);
  if (match?.[1] === undefined) throw new Error(`no csrf field in page: ${body.slice(0, 200)}`);
  return match[1];
}

/** The whole browser dance for a provider: login → provider → callback → /account. */
async function signIn(
  portal: Portal,
  options: Readonly<{ provider: "okta" | "github"; email: string; emailVerified?: boolean }>,
): Promise<Readonly<{ session: string; callback: string; signinCookie: string }>> {
  const login = await visit({ url: `${portal.baseUrl}/account/login/${options.provider}`, cookies: {} });
  assert.equal(login.status, 302, login.body);
  assert.ok(login.location !== null);
  const signinCookie = cookieValue(login.setCookies, SIGNIN_COOKIE) ?? "";
  const parameters =
    options.provider === "okta"
      ? portal.okta.authorize({ authorizationUrl: login.location, subject: "okta-user", email: options.email, emailVerified: options.emailVerified ?? true, tamper: {} })
      : portal.github.authorize({ authorizationUrl: login.location });
  const redirectUri = new URL(login.location).searchParams.get("redirect_uri");
  assert.equal(redirectUri, `${PUBLIC_URL}/account/callback/${options.provider}`);
  const callback = `${portal.baseUrl}/account/callback/${options.provider}?${new URLSearchParams(parameters).toString()}`;
  const landed = await visit({ url: callback, cookies: { [SIGNIN_COOKIE]: signinCookie } });
  assert.equal(landed.status, 303, landed.body);
  assert.equal(landed.location, "/account");
  const session = cookieValue(landed.setCookies, SESSION_COOKIE);
  assert.ok(session !== null && session !== "", "a session cookie is set");
  return { session, callback, signinCookie };
}

describe("signed-out page", () => {
  const rows: readonly Readonly<{ providers: readonly ProviderName[]; shown: readonly string[]; absent: readonly string[] }>[] = [
    { providers: ["google", "github"], shown: ["Continue with Google", "Continue with GitHub"], absent: ["Continue with Okta", "Microsoft"] },
    { providers: ["okta"], shown: ["Continue with Okta"], absent: ["Continue with Google", "Continue with GitHub"] },
  ];
  for (const row of rows) {
    test(`lists exactly ${row.providers.join(" + ")}`, async () => {
      const portal = await startPortal({ providers: row.providers, eraseReport: REVOKED });
      const page = await visit({ url: `${portal.baseUrl}/account`, cookies: {} });
      assert.equal(page.status, 200);
      assert.match(page.body, /Sign in to manage your Sasha Slides data/);
      for (const label of row.shown) assert.ok(page.body.includes(label), `${label} shown`);
      for (const label of row.absent) assert.ok(!page.body.includes(label), `${label} absent`);
      assert.equal((page.body.match(/Continue with /g) ?? []).length, row.providers.length);
      assert.ok(!page.body.includes("Reset my key"), "no erase form while signed out");
    });
  }

  test("an unconfigured provider's login is a 404, and paths outside /account are not handled", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    assert.equal((await visit({ url: `${portal.baseUrl}/account/login/github`, cookies: {} })).status, 404);
    const outside = await visit({ url: `${portal.baseUrl}/accounts`, cookies: {} });
    assert.equal(outside.body, "not the portal");
  });

  test("every page carries the Sasha Slides icon, and each button its provider's own mark", async () => {
    const portal = await startPortal({ providers: ["google", "apple", "github", "okta"], eraseReport: REVOKED });
    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: {} });
    assert.match(page.body, /<a class="brand"[^>]*><svg[^>]*aria-hidden="true"/, "the header has the icon");
    const marks: readonly { provider: string; mark: RegExp }[] = [
      { provider: "Google", mark: /fill="#4285F4"/ },
      { provider: "Apple", mark: /data-mark="apple"/ },
      { provider: "GitHub", mark: /data-mark="github"/ },
    ];
    for (const row of marks) {
      const button = page.body.match(new RegExp(`<a class="button[^"]*"[^>]*>(?:(?!</a>).)*Continue with ${row.provider}</a>`, "s"));
      assert.ok(button, `${row.provider} button`);
      assert.match(button[0], row.mark, `${row.provider} mark inside its button`);
    }
    const appleButton = page.body.match(/<a class="([^"]*)"[^>]*>(?:(?!<\/a>).)*Continue with Apple<\/a>/s);
    assert.match(appleButton?.[1] ?? "", /\bbutton-apple\b/, "Apple's button is Apple's black style");
    const okta = page.body.match(/<a class="button[^"]*"[^>]*>(?:(?!<\/a>).)*Continue with Okta<\/a>/s);
    assert.ok(okta, "a configured OIDC provider still gets a button");
    assert.doesNotMatch(okta[0], /<svg/, "with no invented logo");
  });
});

describe("sign-in round trip", () => {
  test("login → provider → callback sets a session, and the signed-in page shows the linked sign-in", async () => {
    const portal = await startPortal({ providers: ["okta", "github"], eraseReport: REVOKED });
    const { session } = await signIn(portal, { provider: "okta", email: "ada@example.com" });
    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("Okta"), page.body);
    assert.ok(page.body.includes("a•••@example.com"), "email hint");
    assert.ok(!page.body.includes("ada@example.com"), "never the full address");
    assert.ok(page.body.includes("Reset my key and delete my data"));
    assert.ok(page.body.includes("Sign out"));
  });

  // Deck invitations become memberships by matching this address, so an address the provider
  // does not vouch for must never be kept (control: the verified row above keeps it).
  test("an address the provider did not verify is not kept on the account", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const { session } = await signIn(portal, { provider: "okta", email: "victim@example.com", emailVerified: false });
    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } });
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes("v•••@example.com"), "no email hint for an unverified address");
  });

  test("GitHub signs in through the same portal", async () => {
    const portal = await startPortal({ providers: ["okta", "github"], eraseReport: REVOKED });
    const { session } = await signIn(portal, { provider: "github", email: "" });
    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } });
    assert.ok(page.body.includes("GitHub"));
    assert.ok(page.body.includes("o•••@example.com"));
  });

  test("the same identity signing in twice lands in the same account", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const first = await signIn(portal, { provider: "okta", email: "ada@example.com" });
    const second = await signIn(portal, { provider: "okta", email: "ada@example.com" });
    const csrfFirst = csrfOf((await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: first.session } })).body);
    await visit({ url: `${portal.baseUrl}/account/erase`, cookies: { [SESSION_COOKIE]: first.session }, form: { csrf: csrfFirst, confirm: "yes" } });
    const csrfSecond = csrfOf((await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: second.session } })).body);
    await visit({ url: `${portal.baseUrl}/account/erase`, cookies: { [SESSION_COOKIE]: second.session }, form: { csrf: csrfSecond, confirm: "yes" } });
    assert.equal(portal.eraseCalls.length, 2);
    assert.equal(portal.eraseCalls[0], portal.eraseCalls[1]);
  });

  test("a replayed callback is rejected: the state is single use", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const { callback, signinCookie } = await signIn(portal, { provider: "okta", email: "ada@example.com" });
    const replay = await visit({ url: callback, cookies: { [SIGNIN_COOKIE]: signinCookie } });
    assert.equal(replay.status, 400);
    assert.equal(cookieValue(replay.setCookies, SESSION_COOKIE), null, "no session from a replay");
  });

  test("a callback arriving in a browser that did not start the sign-in is rejected", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const login = await visit({ url: `${portal.baseUrl}/account/login/okta`, cookies: {} });
    const parameters = portal.okta.authorize({ authorizationUrl: login.location ?? "", subject: "attacker", email: null, emailVerified: false, tamper: {} });
    const victim = await visit({ url: `${portal.baseUrl}/account/callback/okta?${new URLSearchParams(parameters).toString()}`, cookies: {} });
    assert.equal(victim.status, 400);
    assert.equal(cookieValue(victim.setCookies, SESSION_COOKIE), null);
  });

  test("a state minted for one provider is not accepted on another provider's callback", async () => {
    const portal = await startPortal({ providers: ["okta", "github"], eraseReport: REVOKED });
    const login = await visit({ url: `${portal.baseUrl}/account/login/okta`, cookies: {} });
    const signinCookie = cookieValue(login.setCookies, SIGNIN_COOKIE) ?? "";
    const parameters = portal.okta.authorize({ authorizationUrl: login.location ?? "", subject: "u", email: null, emailVerified: false, tamper: {} });
    const crossed = await visit({
      url: `${portal.baseUrl}/account/callback/github?${new URLSearchParams(parameters).toString()}`,
      cookies: { [SIGNIN_COOKIE]: signinCookie },
    });
    assert.equal(crossed.status, 400);
  });
});

describe("Sign in with Apple's form POST callback", () => {
  type AppleStart = Readonly<{ portal: Portal; signinCookie: string; signinCookieLine: string; location: string }>;

  async function startAppleSignIn(): Promise<AppleStart> {
    const portal = await startPortal({ providers: ["okta", "apple"], eraseReport: REVOKED });
    const login = await visit({ url: `${portal.baseUrl}/account/login/apple`, cookies: {} });
    assert.equal(login.status, 302, login.body);
    return {
      portal,
      signinCookie: cookieValue(login.setCookies, SIGNIN_COOKIE) ?? "",
      signinCookieLine: cookieLine(login.setCookies, SIGNIN_COOKIE),
      location: login.location ?? "",
    };
  }

  /** What Apple's page POSTs back: code, state and, on first consent, `user`. */
  function appleForm(start: AppleStart, tamper: IdTokenTamper): Record<string, string> {
    return {
      ...start.portal.apple.authorize({
        authorizationUrl: start.location,
        subject: APPLE_SUBJECT,
        email: "x7k2q9@privaterelay.appleid.com",
        emailVerified: "true",
        tamper,
      }),
    };
  }

  test("login sends the browser to Apple asking for a form POST, with nonce and PKCE", async () => {
    const { location } = await startAppleSignIn();
    const query = new URL(location).searchParams;
    assert.equal(query.get("response_mode"), "form_post");
    assert.equal(query.get("scope"), "name email");
    assert.equal(query.get("redirect_uri"), `${PUBLIC_URL}/account/callback/apple`);
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.ok((query.get("nonce") ?? "") !== "", "a nonce");
  });

  // Apple's POST is cross-site, so a SameSite=Lax cookie would not come back with it.
  const cookieRows: readonly Readonly<{ provider: "okta" | "apple"; attributes: readonly string[] }>[] = [
    { provider: "okta", attributes: ["HttpOnly", "Secure", "SameSite=Lax", "Path=/account/callback", "Max-Age=600"] },
    { provider: "apple", attributes: ["HttpOnly", "Secure", "SameSite=None", "Path=/account/callback/apple", "Max-Age=600"] },
  ];
  for (const row of cookieRows) {
    test(`the pending sign-in cookie for ${row.provider} is ${row.attributes.join("; ")}`, async () => {
      const portal = await startPortal({ providers: ["okta", "apple"], eraseReport: REVOKED });
      const login = await visit({ url: `${portal.baseUrl}/account/login/${row.provider}`, cookies: {} });
      const line = cookieLine(login.setCookies, SIGNIN_COOKIE);
      assert.deepEqual(line.split("; ").slice(1).sort(), [...row.attributes].sort(), line);
    });
  }

  test("a form POST with the bound state signs in as apple + Apple's subject, never by email", async () => {
    const start = await startAppleSignIn();
    const { portal } = start;
    const landed = await visit({
      url: `${portal.baseUrl}/account/callback/apple`,
      cookies: { [SIGNIN_COOKIE]: start.signinCookie },
      form: appleForm(start, {}),
    });
    assert.equal(landed.status, 303, landed.body);
    assert.equal(landed.location, "/account");
    const session = cookieValue(landed.setCookies, SESSION_COOKIE) ?? "";
    assert.ok(session !== "", "a session cookie is set");
    assert.match(cookieLine(landed.setCookies, SESSION_COOKIE), /SameSite=Lax/, "the session cookie stays Lax");
    const cleared = landed.setCookies.find((line) => line.startsWith(`${SIGNIN_COOKIE}=;`)) ?? "";
    assert.match(cleared, /Path=\/account\/callback\/apple/, "the Apple cookie is cleared on its own path");

    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } });
    assert.ok(page.body.includes("Apple"), page.body);
    assert.ok(page.body.includes("@privaterelay.appleid.com"), "the relay address as the hint");
    const csrf = csrfOf(page.body);
    await visit({ url: `${portal.baseUrl}/account/erase`, cookies: { [SESSION_COOKIE]: session }, form: { csrf, confirm: "yes" } });
    const keyed = await portal.directory.findOrCreateByIdentity({ provider: "apple", subject: APPLE_SUBJECT, email: null });
    assert.equal(portal.eraseCalls[0], keyed);
  });

  const nowSeconds = Math.floor(Date.parse("2026-10-11T12:00:00Z") / 1000);
  const rows: readonly Readonly<{
    name: string;
    cookie: "bound" | "none" | "another sign-in's";
    form: (start: AppleStart) => Record<string, string>;
    status: number;
    says: RegExp;
  }>[] = [
    { name: "control: bound cookie, honest token", cookie: "bound", form: (start) => appleForm(start, {}), status: 303, says: /^$/ },
    { name: "no pending sign-in cookie", cookie: "none", form: (start) => appleForm(start, {}), status: 400, says: /Please sign in again/ },
    { name: "another sign-in's cookie", cookie: "another sign-in's", form: (start) => appleForm(start, {}), status: 400, says: /Please sign in again/ },
    { name: "a nonce from another sign-in", cookie: "bound", form: (start) => appleForm(start, { claims: { nonce: "stolen" } }), status: 400, says: /Sign-in did not complete/ },
    { name: "a token for another Services ID", cookie: "bound", form: (start) => appleForm(start, { claims: { aud: "com.example.other" } }), status: 400, says: /Sign-in did not complete/ },
    { name: "an expired token", cookie: "bound", form: (start) => appleForm(start, { claims: { exp: nowSeconds - 3600 } }), status: 400, says: /Sign-in did not complete/ },
    {
      name: "the user cancelling at Apple",
      cookie: "bound",
      form: (start) => ({ error: "user_cancelled_authorize", state: new URL(start.location).searchParams.get("state") ?? "" }),
      status: 400,
      says: /Sign-in did not complete/,
    },
  ];
  for (const row of rows) {
    test(`a callback POST with ${row.name} → ${String(row.status)}`, async () => {
      const start = await startAppleSignIn();
      const cookies: Record<string, string> =
        row.cookie === "bound" ? { [SIGNIN_COOKIE]: start.signinCookie } : row.cookie === "none" ? {} : { [SIGNIN_COOKIE]: "random-999-forged-state" };
      const answer = await visit({ url: `${start.portal.baseUrl}/account/callback/apple`, cookies, form: row.form(start) });
      assert.equal(answer.status, row.status, answer.body);
      assert.match(answer.body, row.says);
      assert.equal(cookieValue(answer.setCookies, SESSION_COOKIE) !== null, row.status === 303, "a session only on success");
    });
  }

  test("a replayed form POST is rejected: the state is single use", async () => {
    const start = await startAppleSignIn();
    const form = appleForm(start, {});
    const url = `${start.portal.baseUrl}/account/callback/apple`;
    assert.equal((await visit({ url, cookies: { [SIGNIN_COOKIE]: start.signinCookie }, form })).status, 303);
    const replay = await visit({ url, cookies: { [SIGNIN_COOKIE]: start.signinCookie }, form });
    assert.equal(replay.status, 400);
    assert.equal(cookieValue(replay.setCookies, SESSION_COOKIE), null);
  });

  test("Apple's callback takes only a form POST; the other providers' callbacks only a GET", async () => {
    const start = await startAppleSignIn();
    const { baseUrl } = start.portal;
    const asGet = await visit({ url: `${baseUrl}/account/callback/apple?${new URLSearchParams(appleForm(start, {})).toString()}`, cookies: { [SIGNIN_COOKIE]: start.signinCookie } });
    assert.equal(asGet.status, 405);
    const json = await fetch(`${baseUrl}/account/callback/apple`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", cookie: `${SIGNIN_COOKIE}=${start.signinCookie}` },
      body: JSON.stringify(appleForm(start, {})),
    });
    assert.equal(json.status, 415);
    const oktaPost = await visit({ url: `${baseUrl}/account/callback/okta`, cookies: {}, form: { code: "x", state: "y" } });
    assert.equal(oktaPost.status, 405);
  });
});

describe("session cookie", () => {
  test("is HttpOnly, Secure, SameSite=Lax, scoped to /account, and lives 15 minutes", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const login = await visit({ url: `${portal.baseUrl}/account/login/okta`, cookies: {} });
    const signinCookie = cookieValue(login.setCookies, SIGNIN_COOKIE) ?? "";
    assert.match(cookieLine(login.setCookies, SIGNIN_COOKIE), /HttpOnly/);
    const parameters = portal.okta.authorize({ authorizationUrl: login.location ?? "", subject: "u", email: null, emailVerified: false, tamper: {} });
    const landed = await visit({
      url: `${portal.baseUrl}/account/callback/okta?${new URLSearchParams(parameters).toString()}`,
      cookies: { [SIGNIN_COOKIE]: signinCookie },
    });
    const line = cookieLine(landed.setCookies, SESSION_COOKIE);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/account", "Max-Age=900"]) {
      assert.ok(line.split("; ").includes(attribute), `${attribute} in ${line}`);
    }
  });

  const tamperings: readonly Readonly<{ name: string; spoil: (session: string) => string; signedIn: boolean }>[] = [
    { name: "control: untouched", spoil: (session) => session, signedIn: true },
    {
      name: "payload rewritten to another account",
      spoil: (session) => {
        const [payload, signature] = session.split(".");
        const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf-8")) as Record<string, unknown>;
        return `${Buffer.from(JSON.stringify({ ...claims, accountId: "someone-else" })).toString("base64url")}.${signature ?? ""}`;
      },
      signedIn: false,
    },
    { name: "signature flipped", spoil: (session) => `${session.slice(0, -2)}${session.endsWith("AA") ? "BB" : "AA"}`, signedIn: false },
    { name: "garbage", spoil: () => "not-a-session", signedIn: false },
  ];
  for (const row of tamperings) {
    test(`a session cookie that is ${row.name} ${row.signedIn ? "is honoured" : "is ignored"}`, async () => {
      const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
      const { session } = await signIn(portal, { provider: "okta", email: "ada@example.com" });
      const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: row.spoil(session) } });
      assert.equal(page.body.includes("Reset my key and delete my data"), row.signedIn);
      assert.equal(page.body.includes("Sign in to manage your Sasha Slides data"), !row.signedIn);
    });
  }

  test("a session older than 15 minutes is ignored", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const { session } = await signIn(portal, { provider: "okta", email: "ada@example.com" });
    portal.advanceClock(15 * 60 * 1000 + 1000);
    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } });
    assert.match(page.body, /Sign in to manage your Sasha Slides data/);
  });
});

describe("erase", () => {
  async function signedIn(eraseReport: EraseReport): Promise<Readonly<{ portal: Portal; session: string; csrf: string }>> {
    const portal = await startPortal({ providers: ["okta"], eraseReport });
    const { session } = await signIn(portal, { provider: "okta", email: "ada@example.com" });
    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } });
    return { portal, session, csrf: csrfOf(page.body) };
  }

  const rows: readonly Readonly<{ name: string; withSession: boolean; form: (csrf: string) => Record<string, string>; status: number }>[] = [
    { name: "no CSRF token", withSession: true, form: () => ({ confirm: "yes" }), status: 403 },
    { name: "a wrong CSRF token", withSession: true, form: () => ({ csrf: "forged", confirm: "yes" }), status: 403 },
    { name: "no confirmation", withSession: true, form: (csrf) => ({ csrf }), status: 400 },
    { name: "no session", withSession: false, form: (csrf) => ({ csrf, confirm: "yes" }), status: 401 },
  ];
  for (const row of rows) {
    test(`with ${row.name} → ${String(row.status)}, and nothing is erased`, async () => {
      const { portal, session, csrf } = await signedIn(REVOKED);
      const answer = await visit({
        url: `${portal.baseUrl}/account/erase`,
        cookies: row.withSession ? { [SESSION_COOKIE]: session } : {},
        form: row.form(csrf),
      });
      assert.equal(answer.status, row.status, answer.body);
      assert.equal(portal.eraseCalls.length, 0);
    });
  }

  const reports: readonly Readonly<{ report: EraseReport; says: RegExp; neverSays: RegExp }>[] = [
    { report: REVOKED, says: /Google access was revoked/, neverSays: /could not revoke/ },
    {
      report: { googleTokenRevoked: false, recordsRemoved: 2, keyDestroyed: true },
      says: /could not revoke Google access/,
      neverSays: /Google access was revoked/,
    },
  ];
  for (const row of reports) {
    test(`with CSRF and confirmation erases once, signs out, and reports googleTokenRevoked=${String(row.report.googleTokenRevoked)}`, async () => {
      const { portal, session, csrf } = await signedIn(row.report);
      const answer = await visit({ url: `${portal.baseUrl}/account/erase`, cookies: { [SESSION_COOKIE]: session }, form: { csrf, confirm: "yes" } });
      assert.equal(answer.status, 200, answer.body);
      assert.equal(portal.eraseCalls.length, 1);
      const accountId = await portal.directory.findOrCreateByIdentity({ provider: "okta", subject: "okta-user", email: null });
      assert.equal(portal.eraseCalls[0], accountId);
      assert.match(answer.body, /Your data has been deleted\./);
      assert.match(answer.body, /including in backups/);
      assert.match(answer.body, row.says);
      assert.doesNotMatch(answer.body, row.neverSays);
      assert.ok(answer.body.includes("https://myaccount.google.com/permissions"));
      const cleared = cookieLine(answer.setCookies, SESSION_COOKIE);
      assert.ok(cleared.startsWith(`${SESSION_COOKIE}=;`), cleared);
      assert.match(cleared, /Max-Age=0/);
    });
  }
});

describe("sign out", () => {
  test("needs the CSRF token, then clears the session and returns to /account", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const { session } = await signIn(portal, { provider: "okta", email: "ada@example.com" });
    const csrf = csrfOf((await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } })).body);
    const forged = await visit({ url: `${portal.baseUrl}/account/logout`, cookies: { [SESSION_COOKIE]: session }, form: {} });
    assert.equal(forged.status, 403);
    const out = await visit({ url: `${portal.baseUrl}/account/logout`, cookies: { [SESSION_COOKIE]: session }, form: { csrf } });
    assert.equal(out.status, 303);
    assert.equal(out.location, "/account");
    assert.match(cookieLine(out.setCookies, SESSION_COOKIE), /Max-Age=0/);
  });
});

describe("escaping", () => {
  test("a hostile email address is rendered as text, never as markup", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const hostile = `<b>@"><img src=x onerror=alert(1)>.example`;
    const { session } = await signIn(portal, { provider: "okta", email: hostile });
    const page = await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } });
    assert.ok(!page.body.includes("<img"), "no injected element");
    assert.ok(!page.body.includes("<b>"), "no injected element");
    assert.ok(page.body.includes("&lt;img src=x onerror=alert(1)&gt;"), "shown as text");
    assert.ok(page.body.includes("&quot;"), "quotes escaped");
  });

  test("pages forbid framing and every script but the passkey script", async () => {
    const portal = await startPortal({ providers: ["okta"], eraseReport: REVOKED });
    const response = await fetch(`${portal.baseUrl}/account`);
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.ok(policy.split("; ").includes(`script-src ${PUBLIC_URL}/account/passkey.js`), policy);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const scripts = (await response.text()).match(/<script[^>]*>/g) ?? [];
    assert.deepEqual(scripts, [`<script src="${PUBLIC_URL}/account/passkey.js" defer>`], "no inline script");
  });
});
