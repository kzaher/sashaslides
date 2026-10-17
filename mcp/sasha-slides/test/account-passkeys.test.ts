/**
 * Passkeys through the /account portal over real HTTP on a loopback port, end to end: a
 * software authenticator (`software-authenticator.ts`) answers the challenges the portal
 * issues, and this file plays the browser, carrying cookies by hand.
 *
 *   node --test --import tsx mcp/sasha-slides/test/account-passkeys.test.ts
 *
 * Ordered like a visit: the page and its script, creating an account with a passkey,
 * signing in with it, adding one to an account that signed in with GitHub, then every
 * refusal: wrong origin, wrong relying party, tampered signature, counter going backwards,
 * replayed challenge, a challenge carried to another browser, and the request gates.
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { storeAccountDirectory, type AccountDirectory } from "../http/account-directory";
import { createAccountVault, inMemoryDataKeyStore } from "../http/account-keys";
import { createAccountPortal } from "../http/account-portal";
import { createIdentityProvider } from "../http/identity-providers";
import { inMemoryAuthStore } from "../http/oauth-store";
import { PASSKEY_SCRIPT } from "../http/passkey-script.generated";
import { createFakeGitHub, fakeFetch, type FakeGitHub } from "./fake-identity-providers";
import { createSoftwareAuthenticator, type CeremonyTamper, type SoftwareAuthenticator } from "./software-authenticator";

const PUBLIC_URL = "https://slides.example.test";
const RP_ID = "slides.example.test";
const SESSION_SECRET = "a-session-secret-that-is-at-least-thirty-two-bytes-long";
const SESSION_COOKIE = "sasha_account";
const SIGNIN_COOKIE = "sasha_signin";
const PASSKEY_COOKIE = "sasha_passkey";

type Portal = Readonly<{
  baseUrl: string;
  github: FakeGitHub;
  directory: AccountDirectory;
  warnings: string[];
  advanceClock: (milliseconds: number) => void;
}>;

const servers: { close: () => void }[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function startPortal(): Promise<Portal> {
  let nowMs = Date.parse("2026-10-13T12:00:00Z");
  const now = (): Date => new Date(nowMs);
  const github = createFakeGitHub({
    clientId: "gh-client",
    clientSecret: "gh-secret",
    userId: 7,
    emails: [{ email: "octo@example.com", primary: true, verified: true }],
  });
  const network = fakeFetch({ routes: [github.route] });
  let counter = 0;
  const randomToken = (): string => `random-${String((counter += 1))}-${"x".repeat(32)}`;
  const directory = storeAccountDirectory({
    store: inMemoryAuthStore(),
    vault: createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: randomBytes(32) }),
    now,
    newAccountId: randomToken,
  });
  const warnings: string[] = [];
  const portal = createAccountPortal({
    publicUrl: PUBLIC_URL,
    sessionSecret: SESSION_SECRET,
    providers: [
      createIdentityProvider({
        spec: { protocol: "github", name: "github", displayName: "GitHub", clientId: "gh-client", clientSecret: "gh-secret", scopes: ["read:user", "user:email"] },
        fetch: network.fetch,
        now,
        randomToken,
        timeoutMs: 5000,
      }),
    ],
    directory,
    eraser: { eraseAccount: () => Promise.resolve({ googleTokenRevoked: false, recordsRemoved: 0, keyDestroyed: true }) },
    now,
    randomToken,
    warn: (message) => warnings.push(message),
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
    github,
    directory,
    warnings,
    advanceClock: (milliseconds) => {
      nowMs += milliseconds;
    },
  };
}

/** One browser's cookie jar. */
type Browser = Map<string, string>;

type Answer = Readonly<{ status: number; location: string | null; setCookies: readonly string[]; body: string; json: Readonly<Record<string, unknown>> }>;

async function send(
  portal: Portal,
  options: Readonly<{
    browser: Browser;
    path: string;
    json?: unknown;
    /** Overrides the JSON content type; for the gate tests. */
    contentType?: string;
    origin?: string;
  }>,
): Promise<Answer> {
  const cookie = [...options.browser].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(`${portal.baseUrl}${options.path}`, {
    method: options.json === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      ...(cookie === "" ? {} : { cookie }),
      ...(options.json === undefined ? {} : { "content-type": options.contentType ?? "application/json" }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
  });
  const setCookies = response.headers.getSetCookie();
  // The browser keeps what it is told to keep, and drops what is cleared.
  for (const line of setCookies) {
    const [pair = ""] = line.split(";");
    const equals = pair.indexOf("=");
    const name = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (value === "" || /Max-Age=0/.test(line)) options.browser.delete(name);
    else options.browser.set(name, value);
  }
  const body = await response.text();
  let json: Readonly<Record<string, unknown>> = {};
  if ((response.headers.get("content-type") ?? "").startsWith("application/json")) json = JSON.parse(body) as Record<string, unknown>;
  return { status: response.status, location: response.headers.get("location"), setCookies, body, json };
}

function softwareAuthenticator(options: Readonly<{ counting: boolean }>): SoftwareAuthenticator {
  return createSoftwareAuthenticator({ algorithm: "ES256", rpId: RP_ID, origin: PUBLIC_URL, counting: options.counting });
}

type PublicKeyOptions = Readonly<{ challenge: string; user?: Readonly<{ id: string }>; excludeCredentials?: readonly Readonly<{ id: string }>[] }>;

async function ceremonyOptions(
  portal: Portal,
  browser: Browser,
  ceremony: "create" | "signin" | "add",
  body: Readonly<Record<string, unknown>> = {},
): Promise<PublicKeyOptions> {
  const answer = await send(portal, { browser, path: `/account/passkey/${ceremony}/options`, json: body });
  assert.equal(answer.status, 200, answer.body);
  return answer.json["publicKey"] as PublicKeyOptions;
}

/** Create options → authenticator → verify, in one browser. Returns the verify answer. */
async function createWithPasskey(
  portal: Portal,
  options: Readonly<{ browser: Browser; authenticator: SoftwareAuthenticator; tamper: CeremonyTamper }>,
): Promise<Answer> {
  const offered = await ceremonyOptions(portal, options.browser, "create");
  const credential = options.authenticator.register({ challenge: offered.challenge, userHandle: offered.user?.id ?? "", tamper: options.tamper });
  return send(portal, { browser: options.browser, path: "/account/passkey/create/verify", json: { credential } });
}

async function signInWithPasskey(
  portal: Portal,
  options: Readonly<{ browser: Browser; authenticator: SoftwareAuthenticator; tamper: CeremonyTamper }>,
): Promise<Answer> {
  const offered = await ceremonyOptions(portal, options.browser, "signin");
  const credential = options.authenticator.assert({ challenge: offered.challenge, tamper: options.tamper });
  return send(portal, { browser: options.browser, path: "/account/passkey/signin/verify", json: { credential } });
}

/** The account id inside a session cookie (its payload is base64url JSON; the MAC is the server's business). */
function sessionAccount(browser: Browser): string | null {
  const session = browser.get(SESSION_COOKIE);
  if (session === undefined) return null;
  const [payload = ""] = session.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { accountId?: string };
  return claims.accountId ?? null;
}

function csrfOf(body: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(body);
  if (match?.[1] === undefined) throw new Error(`no csrf field in page: ${body.slice(0, 200)}`);
  return match[1];
}

async function signInWithGitHub(portal: Portal, browser: Browser): Promise<void> {
  const login = await send(portal, { browser, path: "/account/login/github" });
  assert.equal(login.status, 302);
  const parameters = portal.github.authorize({ authorizationUrl: login.location ?? "" });
  const landed = await send(portal, { browser, path: `/account/callback/github?${new URLSearchParams(parameters).toString()}` });
  assert.equal(landed.status, 303, landed.body);
  assert.ok(!browser.has(SIGNIN_COOKIE));
}

describe("the page and its script", () => {
  test("the signed-out page offers passkeys behind the script, and the CSP admits exactly that script", async () => {
    const portal = await startPortal();
    const page = await fetch(`${portal.baseUrl}/account`);
    const body = await page.text();
    assert.match(body, /<div class="providers" data-passkeys hidden>/, "hidden until the script shows it");
    assert.match(body, /data-passkey="signin"[^>]*>.*Sign in with a passkey/s);
    assert.match(body, /data-passkey="create"[^>]*>.*Create an account with a passkey/s);
    assert.match(body, /Continue with GitHub/, "the other providers still work without script");
    const scripts = body.match(/<script[^>]*>/g) ?? [];
    assert.deepEqual(scripts, [`<script src="${PUBLIC_URL}/account/passkey.js" defer>`], "one script, by URL, none inline");
    const policy = page.headers.get("content-security-policy") ?? "";
    assert.ok(policy.split("; ").includes(`script-src ${PUBLIC_URL}/account/passkey.js`), policy);
    assert.ok(policy.split("; ").includes(`connect-src ${PUBLIC_URL}/account/passkey/`), policy);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|'self'[^;]*script/);
    const notFound = await fetch(`${portal.baseUrl}/account/nowhere`);
    assert.doesNotMatch(notFound.headers.get("content-security-policy") ?? "", /script-src/, "pages without passkey buttons allow no script");
  });

  test("/account/passkey.js serves the generated script as JavaScript", async () => {
    const portal = await startPortal();
    const response = await fetch(`${portal.baseUrl}/account/passkey.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), PASSKEY_SCRIPT);
  });

  test("create options ask for a discoverable ES256/RS256 credential for this host, with no attestation", async () => {
    const portal = await startPortal();
    const answer = await send(portal, { browser: new Map(), path: "/account/passkey/create/options", json: {} });
    const publicKey = answer.json["publicKey"] as Record<string, unknown>;
    assert.deepEqual(publicKey["rp"], { id: RP_ID, name: "Sasha Slides" });
    assert.deepEqual(publicKey["pubKeyCredParams"], [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ]);
    assert.equal(publicKey["attestation"], "none");
    assert.deepEqual(publicKey["authenticatorSelection"], { residentKey: "required", requireResidentKey: true, userVerification: "preferred" });
    const user = publicKey["user"] as Record<string, string>;
    assert.match(user["id"] ?? "", /^[A-Za-z0-9_-]{43}$/, "a random 32-byte user handle");
    const cookie = answer.setCookies.find((line) => line.startsWith(`${PASSKEY_COOKIE}=`)) ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/account/passkey", "Max-Age=300"]) {
      assert.ok(cookie.split("; ").includes(attribute), `${attribute} in ${cookie}`);
    }
    assert.equal(cookie.split(";")[0], `${PASSKEY_COOKIE}=${String(publicKey["challenge"])}`, "the browser holds its own challenge");
  });
});

describe("create an account with a passkey, then sign in with it", () => {
  test("a new account opens with the passkey as its only sign-in", async () => {
    const portal = await startPortal();
    const browser: Browser = new Map();
    const authenticator = softwareAuthenticator({ counting: true });
    const created = await createWithPasskey(portal, { browser, authenticator, tamper: {} });
    assert.equal(created.status, 200, created.body);
    assert.deepEqual(created.json, { redirect: "/account" });
    assert.ok(!browser.has(PASSKEY_COOKIE), "the challenge cookie is cleared");
    const accountId = sessionAccount(browser);
    assert.ok(accountId !== null);
    assert.equal((await portal.directory.findPasskey({ credentialId: authenticator.credentialId }))?.accountId, accountId);
    const page = await send(portal, { browser, path: "/account" });
    assert.match(page.body, /<span class="method-name">Passkey<\/span>/);
    assert.doesNotMatch(page.body, />Remove</, "its only sign-in cannot be removed");
    assert.match(page.body, /Reset my key and delete my data/);
  });

  test("signing in with it in a fresh browser lands in the same account, and the counter is recorded", async () => {
    const portal = await startPortal();
    const authenticator = softwareAuthenticator({ counting: true });
    const creator: Browser = new Map();
    await createWithPasskey(portal, { browser: creator, authenticator, tamper: {} });
    const browser: Browser = new Map();
    const signedIn = await signInWithPasskey(portal, { browser, authenticator, tamper: {} });
    assert.equal(signedIn.status, 200, signedIn.body);
    assert.equal(sessionAccount(browser), sessionAccount(creator));
    assert.equal((await portal.directory.findPasskey({ credentialId: authenticator.credentialId }))?.signCount, 2);
    const again = await signInWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    assert.equal(again.status, 200, "a growing counter keeps working");
  });

  test("a synced passkey whose counter is always zero signs in every time", async () => {
    const portal = await startPortal();
    const authenticator = softwareAuthenticator({ counting: false });
    await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal((await signInWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} })).status, 200);
    }
  });

  test("the same passkey cannot open a second account", async () => {
    const portal = await startPortal();
    const authenticator = softwareAuthenticator({ counting: false });
    await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    const second = await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    assert.equal(second.status, 409);
  });
});

describe("add a passkey to an account that signed in another way", () => {
  test("it joins the GitHub account, is listed beside GitHub, and later signs in to that account", async () => {
    const portal = await startPortal();
    const browser: Browser = new Map();
    await signInWithGitHub(portal, browser);
    const githubAccount = sessionAccount(browser);
    const csrf = csrfOf((await send(portal, { browser, path: "/account" })).body);
    const page = await send(portal, { browser, path: "/account" });
    assert.match(page.body, /data-passkeys data-csrf="[^"]+" hidden>/);

    const authenticator = softwareAuthenticator({ counting: true });
    const offered = await ceremonyOptions(portal, browser, "add", { csrf });
    assert.deepEqual(offered.excludeCredentials, []);
    const credential = authenticator.register({ challenge: offered.challenge, userHandle: offered.user?.id ?? "", tamper: {} });
    const added = await send(portal, { browser, path: "/account/passkey/add/verify", json: { csrf, credential } });
    assert.equal(added.status, 200, added.body);
    assert.equal(sessionAccount(browser), githubAccount, "still the same session's account");

    const listed = await send(portal, { browser, path: "/account" });
    assert.match(listed.body, /<span class="method-name">GitHub<\/span><span class="hint">o•••@example.com<\/span>/);
    // Listed by the name it was offered under in the passkey manager, and the day it was added.
    assert.match(listed.body, /<span class="method-name">Passkey<\/span><span class="hint">Sasha Slides account \(2026-10-13\)<\/span><\/span><span class="method-side"><span>Added 13 October 2026<\/span>/);
    const next = await ceremonyOptions(portal, browser, "add", { csrf });
    assert.deepEqual(next.excludeCredentials, [{ type: "public-key", id: authenticator.credentialId }], "the authenticator is told it already has one");

    const elsewhere: Browser = new Map();
    assert.equal((await signInWithPasskey(portal, { browser: elsewhere, authenticator, tamper: {} })).status, 200);
    assert.equal(sessionAccount(elsewhere), githubAccount);
  });

  const gates: readonly Readonly<{ name: string; signedIn: boolean; ageMinutes: number; body: (csrf: string) => Record<string, unknown>; status: number }>[] = [
    { name: "9 minutes after signing in (control)", signedIn: true, ageMinutes: 9, body: (csrf) => ({ csrf }), status: 200 },
    { name: "without a session", signedIn: false, ageMinutes: 0, body: () => ({}), status: 401 },
    { name: "without the CSRF token", signedIn: true, ageMinutes: 0, body: () => ({}), status: 403 },
    { name: "with a wrong CSRF token", signedIn: true, ageMinutes: 0, body: () => ({ csrf: "forged" }), status: 403 },
    { name: "11 minutes after signing in", signedIn: true, ageMinutes: 11, body: (csrf) => ({ csrf }), status: 403 },
  ];
  for (const gate of gates) {
    test(`asking to add one ${gate.name} → ${String(gate.status)}`, async () => {
      const portal = await startPortal();
      const browser: Browser = new Map();
      let csrf = "";
      if (gate.signedIn) {
        await signInWithGitHub(portal, browser);
        csrf = csrfOf((await send(portal, { browser, path: "/account" })).body);
      }
      portal.advanceClock(gate.ageMinutes * 60 * 1000);
      const answer = await send(portal, { browser, path: "/account/passkey/add/options", json: gate.body(csrf) });
      assert.equal(answer.status, gate.status, answer.body);
      assert.equal(browser.has(PASSKEY_COOKIE), gate.status === 200, "a challenge only when allowed");
      if (gate.ageMinutes > 10) assert.match(answer.body, /sign in again/);
    });
  }

  test("finishing an add needs the CSRF token too, and nothing is linked without it", async () => {
    const portal = await startPortal();
    const browser: Browser = new Map();
    await signInWithGitHub(portal, browser);
    const csrf = csrfOf((await send(portal, { browser, path: "/account" })).body);
    const authenticator = softwareAuthenticator({ counting: false });
    const offered = await ceremonyOptions(portal, browser, "add", { csrf });
    const credential = authenticator.register({ challenge: offered.challenge, userHandle: offered.user?.id ?? "", tamper: {} });
    const answer = await send(portal, { browser, path: "/account/passkey/add/verify", json: { credential } });
    assert.equal(answer.status, 403);
    assert.equal(await portal.directory.findPasskey({ credentialId: authenticator.credentialId }), null);
  });
});

describe("refusals", () => {
  const registrationRows: readonly Readonly<{ name: string; tamper: CeremonyTamper }>[] = [
    { name: "a phishing origin", tamper: { origin: "https://slides.example.test.evil.example" } },
    { name: "a foreign relying party id", tamper: { rpId: "evil.example" } },
    { name: "no user presence", tamper: { userPresent: false } },
  ];
  for (const row of registrationRows) {
    test(`creating with ${row.name} opens no account`, async () => {
      const portal = await startPortal();
      const browser: Browser = new Map();
      const authenticator = softwareAuthenticator({ counting: false });
      const answer = await createWithPasskey(portal, { browser, authenticator, tamper: row.tamper });
      assert.equal(answer.status, 400, answer.body);
      assert.equal(sessionAccount(browser), null);
      assert.equal(await portal.directory.findPasskey({ credentialId: authenticator.credentialId }), null);
    });
  }

  const signInRows: readonly Readonly<{ name: string; tamper: CeremonyTamper; reason: RegExp }>[] = [
    { name: "a phishing origin", tamper: { origin: "https://evil.example" }, reason: /origin-mismatch/ },
    { name: "a foreign relying party id", tamper: { rpId: "evil.example" }, reason: /rp-id-mismatch/ },
    { name: "a tampered signature", tamper: { flipSignature: true }, reason: /bad-signature/ },
    { name: "a counter that went backwards", tamper: { signCount: 1 }, reason: /counter-regressed/ },
    { name: "a user handle that is not the credential's", tamper: { userHandle: "c29tZW9uZS1lbHNl" }, reason: /user handle/ },
  ];
  for (const row of signInRows) {
    test(`signing in with ${row.name} is refused and sets no session`, async () => {
      const portal = await startPortal();
      const authenticator = softwareAuthenticator({ counting: true });
      await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
      // One honest sign-in first, so the stored counter is 2 and "backwards" is meaningful.
      assert.equal((await signInWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} })).status, 200);
      const browser: Browser = new Map();
      const answer = await signInWithPasskey(portal, { browser, authenticator, tamper: row.tamper });
      assert.equal(answer.status, 400, answer.body);
      assert.equal(sessionAccount(browser), null);
      assert.match(portal.warnings.join("\n"), row.reason);
    });
  }

  test("a passkey the portal never registered does not sign in", async () => {
    const portal = await startPortal();
    const answer = await signInWithPasskey(portal, { browser: new Map(), authenticator: softwareAuthenticator({ counting: false }), tamper: {} });
    assert.equal(answer.status, 400);
    assert.match(String(answer.json["message"]), /not registered/);
  });

  test("a replayed answer is refused: the challenge is single use", async () => {
    const portal = await startPortal();
    const authenticator = softwareAuthenticator({ counting: false });
    await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    const browser: Browser = new Map();
    const offered = await ceremonyOptions(portal, browser, "signin");
    const challengeCookie = browser.get(PASSKEY_COOKIE) ?? "";
    const credential = authenticator.assert({ challenge: offered.challenge, tamper: {} });
    assert.equal((await send(portal, { browser, path: "/account/passkey/signin/verify", json: { credential } })).status, 200);
    const replayer: Browser = new Map([[PASSKEY_COOKIE, challengeCookie]]);
    const replay = await send(portal, { browser: replayer, path: "/account/passkey/signin/verify", json: { credential } });
    assert.equal(replay.status, 400);
    assert.equal(sessionAccount(replayer), null);
  });

  test("an answer carried to another browser is refused, with that browser's own challenge or with none", async () => {
    const portal = await startPortal();
    const authenticator = softwareAuthenticator({ counting: false });
    await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    const victim: Browser = new Map();
    const offered = await ceremonyOptions(portal, victim, "signin");
    const credential = authenticator.assert({ challenge: offered.challenge, tamper: {} });

    const other: Browser = new Map();
    await ceremonyOptions(portal, other, "signin");
    const withOwnChallenge = await send(portal, { browser: other, path: "/account/passkey/signin/verify", json: { credential } });
    assert.equal(withOwnChallenge.status, 400);
    assert.match(portal.warnings.join("\n"), /challenge-mismatch/);
    const withNone = await send(portal, { browser: new Map(), path: "/account/passkey/signin/verify", json: { credential } });
    assert.equal(withNone.status, 400);
    assert.equal(sessionAccount(other), null);
  });

  test("a challenge issued for creating an account does not finish a sign-in", async () => {
    const portal = await startPortal();
    const authenticator = softwareAuthenticator({ counting: false });
    await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    const browser: Browser = new Map();
    const offered = await ceremonyOptions(portal, browser, "create");
    const credential = authenticator.assert({ challenge: offered.challenge, tamper: {} });
    const answer = await send(portal, { browser, path: "/account/passkey/signin/verify", json: { credential } });
    assert.equal(answer.status, 400);
  });

  test("a challenge older than five minutes is refused", async () => {
    const portal = await startPortal();
    const authenticator = softwareAuthenticator({ counting: false });
    await createWithPasskey(portal, { browser: new Map(), authenticator, tamper: {} });
    const browser: Browser = new Map();
    const offered = await ceremonyOptions(portal, browser, "signin");
    portal.advanceClock(5 * 60 * 1000 + 1000);
    const credential = authenticator.assert({ challenge: offered.challenge, tamper: {} });
    assert.equal((await send(portal, { browser, path: "/account/passkey/signin/verify", json: { credential } })).status, 400);
  });

  const requestGates: readonly Readonly<{ name: string; contentType?: string; origin?: string; status: number }>[] = [
    { name: "a form post", contentType: "application/x-www-form-urlencoded", status: 415 },
    { name: "a foreign Origin header", origin: "https://evil.example", status: 403 },
    { name: "the public Origin header", origin: PUBLIC_URL, status: 200 },
  ];
  for (const gate of requestGates) {
    test(`a passkey request with ${gate.name} → ${String(gate.status)}`, async () => {
      const portal = await startPortal();
      const answer = await send(portal, {
        browser: new Map(),
        path: "/account/passkey/signin/options",
        json: {},
        ...(gate.contentType === undefined ? {} : { contentType: gate.contentType }),
        ...(gate.origin === undefined ? {} : { origin: gate.origin }),
      });
      assert.equal(answer.status, gate.status, answer.body);
    });
  }

  test("unknown ceremonies and steps are 404, and the endpoints take POST only", async () => {
    const portal = await startPortal();
    assert.equal((await send(portal, { browser: new Map(), path: "/account/passkey/delete/options", json: {} })).status, 404);
    assert.equal((await send(portal, { browser: new Map(), path: "/account/passkey/signin/finish", json: {} })).status, 404);
    assert.equal((await send(portal, { browser: new Map(), path: "/account/passkey/signin/options" })).status, 405);
  });
});
