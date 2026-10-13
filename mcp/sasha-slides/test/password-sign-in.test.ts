/**
 * Email and password sign-in at /account, over real HTTP on a loopback port, with mail sent
 * through the real Gmail sender into a fake Gmail that captures every message.
 *
 *   node --test --import tsx mcp/sasha-slides/test/password-sign-in.test.ts
 *
 * Ordered like a visit: sign up and confirm, sign in, reset a forgotten password, then the
 * throttles, the forms' cross-site defence, and erasure.
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { inMemoryAccountDirectory, storeAccountDirectory } from "../http/account-directory";
import { createAccountEraser } from "../http/account-eraser";
import { createAccountVault, inMemoryDataKeyStore } from "../http/account-keys";
import { createAccountPortal } from "../http/account-portal";
import { LOOPBACK_PROXIES, NO_TRUSTED_PROXIES, type TrustedProxies } from "../http/client-address";
import { createGmailSender } from "../http/gmail-sender";
import { inMemoryAuthStore, inMemoryRecordStore, type PasswordCredential, type RecordStore } from "../http/oauth-store";
import type { ScryptCost } from "../http/password-hashing";
import {
  createPasswordSignIn,
  DEFAULT_PASSWORD_LIMITS,
  emailLinkKey,
  type PasswordLimits,
} from "../http/password-sign-in";
import { createThrottle } from "../http/request-throttle";
import { createFakeGmail, linkIn, type CapturedMail } from "./fake-gmail";
import { fakeFetch } from "./fake-identity-providers";

const PUBLIC_URL = "https://slides.example.test";
const SESSION_SECRET = "a-session-secret-that-is-at-least-thirty-two-bytes-long";
const SESSION_COOKIE = "sasha_account";
const FORM_COOKIE = "__Host-sasha_form";
const CHEAP: ScryptCost = { logCost: 10, blockSize: 8, parallelization: 1 };
const PASSWORD = "correct horse battery staple";
const MINUTE = 60 * 1000;

type Portal = Readonly<{
  baseUrl: string;
  /** Waits for every mail the portal queued, then returns all mail sent so far. */
  mailbox: () => Promise<readonly CapturedMail[]>;
  advanceClock: (milliseconds: number) => void;
  credentials: RecordStore<PasswordCredential>;
  warnings: readonly string[];
}>;

const servers: { close: () => void }[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function startPortal(
  options: Readonly<{ limits?: PasswordLimits; trustedProxies?: TrustedProxies }> = {},
): Promise<Portal> {
  let nowMs = Date.parse("2026-10-13T12:00:00Z");
  const now = (): Date => new Date(nowMs);
  const gmail = createFakeGmail({ clientId: "mail-client", clientSecret: "mail-secret", refreshToken: "mail-refresh", accessTokenLifetimeSeconds: 3599 });
  const network = fakeFetch({ routes: [gmail.route] });
  const randomToken = (): string => randomBytes(32).toString("base64url");
  const directory = inMemoryAccountDirectory({ randomToken });
  const credentials = inMemoryRecordStore<PasswordCredential>();
  const background: Promise<void>[] = [];
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };
  const passwordSignIn = createPasswordSignIn({
    publicUrl: PUBLIC_URL,
    credentials,
    directory,
    mailSender: createGmailSender({
      config: {
        credentials: { kind: "refresh-token", clientId: "mail-client", clientSecret: "mail-secret", refreshToken: "mail-refresh" },
        from: { address: "noreply@slides.example.test", displayName: "Sasha Slides" },
      },
      fetch: network.fetch,
      now,
      randomToken,
      timeoutMs: 5000,
    }),
    throttle: createThrottle({ now, maxKeys: 10_000 }),
    limits: options.limits ?? DEFAULT_PASSWORD_LIMITS,
    now,
    randomToken,
    scryptCost: CHEAP,
    runInBackground: (work) => {
      background.push(work);
    },
    warn,
  });
  const portal = createAccountPortal({
    publicUrl: PUBLIC_URL,
    sessionSecret: SESSION_SECRET,
    providers: [],
    directory,
    eraser: { eraseAccount: () => Promise.resolve({ googleTokenRevoked: false, recordsRemoved: 0, keyDestroyed: true }) },
    now,
    randomToken,
    warn,
    passwordSignIn: { service: passwordSignIn, trustedProxies: options.trustedProxies ?? LOOPBACK_PROXIES },
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
    mailbox: async () => {
      await Promise.all(background);
      return gmail.sent();
    },
    advanceClock: (milliseconds) => {
      nowMs += milliseconds;
    },
    credentials,
    warnings,
  };
}

type Visit = Readonly<{ status: number; location: string | null; setCookies: readonly string[]; body: string; retryAfter: string | null }>;

async function visit(
  options: Readonly<{
    url: string;
    cookies?: Readonly<Record<string, string>>;
    form?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
  }>,
): Promise<Visit> {
  const cookieHeader = Object.entries(options.cookies ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const response = await fetch(options.url, {
    method: options.form === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      ...(options.headers ?? {}),
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
    retryAfter: response.headers.get("retry-after"),
  };
}

function cookieValue(setCookies: readonly string[], name: string): string | null {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return null;
}

function fieldOf(body: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(body);
  if (match?.[1] === undefined) throw new Error(`no ${name} field in page: ${body.slice(0, 400)}`);
  return match[1];
}

/** A browser that has opened a page with a form: its form cookie and the matching field. */
type Browser = Readonly<{ formCookie: string; formToken: string }>;

async function openForm(portal: Portal, path: string): Promise<Browser> {
  const page = await visit({ url: `${portal.baseUrl}${path}` });
  assert.equal(page.status, 200, page.body);
  const formCookie = cookieValue(page.setCookies, FORM_COOKIE);
  assert.ok(formCookie !== null, "the form page sets the form cookie");
  return { formCookie, formToken: fieldOf(page.body, "form") };
}

async function submit(
  portal: Portal,
  options: Readonly<{ path: string; fields: Readonly<Record<string, string>>; clientIp?: string; browser?: Browser }>,
): Promise<Visit> {
  const browser = options.browser ?? (await openForm(portal, "/account"));
  return visit({
    url: `${portal.baseUrl}${options.path}`,
    cookies: { [FORM_COOKIE]: browser.formCookie },
    form: { form: browser.formToken, ...options.fields },
    headers: { "x-real-ip": options.clientIp ?? "198.51.100.1" },
  });
}

function signUp(portal: Portal, options: Readonly<{ email: string; password?: string; clientIp?: string }>): Promise<Visit> {
  return submit(portal, {
    path: "/account/email/signup",
    fields: { email: options.email, password: options.password ?? PASSWORD },
    ...(options.clientIp === undefined ? {} : { clientIp: options.clientIp }),
  });
}

function signIn(portal: Portal, options: Readonly<{ email: string; password: string; clientIp?: string }>): Promise<Visit> {
  return submit(portal, {
    path: "/account/email/signin",
    fields: { email: options.email, password: options.password },
    ...(options.clientIp === undefined ? {} : { clientIp: options.clientIp }),
  });
}

/** Follows a mailed link the way a person does: open it, then press the button on the page. */
async function followLink(portal: Portal, options: Readonly<{ link: string; fields?: Readonly<Record<string, string>> }>): Promise<Visit> {
  const path = options.link.slice(PUBLIC_URL.length);
  const page = await visit({ url: `${portal.baseUrl}${path}` });
  if (page.status !== 200) return page;
  const formCookie = cookieValue(page.setCookies, FORM_COOKIE) ?? "";
  return visit({
    url: `${portal.baseUrl}${new URL(path, PUBLIC_URL).pathname}`,
    cookies: { [FORM_COOKIE]: formCookie },
    form: { form: fieldOf(page.body, "form"), token: fieldOf(page.body, "token"), ...(options.fields ?? {}) },
  });
}

async function accountPage(portal: Portal, session: string): Promise<string> {
  return (await visit({ url: `${portal.baseUrl}/account`, cookies: { [SESSION_COOKIE]: session } })).body;
}

function sessionOf(landed: Visit): string {
  assert.equal(landed.status, 303, landed.body);
  assert.equal(landed.location, "/account");
  const session = cookieValue(landed.setCookies, SESSION_COOKIE);
  assert.ok(session !== null && session !== "", "a session cookie is set");
  return session;
}

async function signedUp(portal: Portal, email: string): Promise<string> {
  await signUp(portal, { email });
  const mail = (await portal.mailbox()).at(-1);
  assert.ok(mail !== undefined);
  return sessionOf(await followLink(portal, { link: linkIn(mail, `${PUBLIC_URL}/account/email/verify?token=`) }));
}

function mailAt(mails: readonly CapturedMail[], index: number): CapturedMail {
  const mail = mails.at(index);
  if (mail === undefined) throw new Error(`no mail at ${String(index)} of ${String(mails.length)}`);
  return mail;
}

describe("signed-out page", () => {
  test("offers an email sign-in form and links to sign up and to reset a password", async () => {
    const portal = await startPortal();
    const page = await visit({ url: `${portal.baseUrl}/account` });
    assert.match(page.body, /<form method="post" action="\/account\/email\/signin">/);
    assert.match(page.body, /type="email"/);
    assert.match(page.body, /type="password"/);
    assert.match(page.body, /href="\/account\/email\/signup"/);
    assert.match(page.body, /href="\/account\/email\/forgot"/);
    // The email forms need no script; the only one on the page is the passkey buttons' external file.
    const scripts = page.body.match(/<script[^>]*>/g) ?? [];
    assert.ok(scripts.every((tag) => /src="[^"]*\/account\/passkey\.js"/.test(tag)), scripts.join(" "));
    const policy = (await fetch(`${portal.baseUrl}/account`)).headers.get("content-security-policy") ?? "";
    assert.match(policy, /form-action 'self'/, "the forms post to this origin, which the policy allows");
  });
});

describe("sign up", () => {
  test("mails a confirmation link; opening it and confirming signs in, and the account lists the email sign-in", async () => {
    const portal = await startPortal();
    const answer = await signUp(portal, { email: "  Ada@Example.COM " });
    assert.equal(answer.status, 200, answer.body);
    assert.match(answer.body, /Check your email/);
    assert.equal(cookieValue(answer.setCookies, SESSION_COOKIE), null, "not signed in before confirming");

    const [mail] = await portal.mailbox();
    assert.ok(mail !== undefined);
    assert.equal(mail.headers.get("to"), "ada@example.com", "the address is normalised to lowercase");
    const link = linkIn(mail, `${PUBLIC_URL}/account/email/verify?token=`);
    assert.match(link, /token=[A-Za-z0-9_-]{43}$/, "an unguessable 256-bit token");
    assert.match(mail.text, /30 minutes/);

    const opened = await visit({ url: `${portal.baseUrl}${link.slice(PUBLIC_URL.length)}` });
    assert.equal(opened.status, 200);
    assert.equal(cookieValue(opened.setCookies, SESSION_COOKIE), null, "opening the link alone (as a mail scanner would) changes nothing");

    const session = sessionOf(await followLink(portal, { link }));
    const page = await accountPage(portal, session);
    assert.match(page, /Email and password/);
    assert.ok(page.includes("a•••@example.com"), "email hint");
    assert.ok(!page.includes("ada@example.com"), "never the full address");
  });

  test("the confirmation link is single use", async () => {
    const portal = await startPortal();
    await signUp(portal, { email: "ada@example.com" });
    const [mail] = await portal.mailbox();
    assert.ok(mail !== undefined);
    const link = linkIn(mail, `${PUBLIC_URL}/account/email/verify?token=`);
    const path = link.slice(PUBLIC_URL.length);
    const page = await visit({ url: `${portal.baseUrl}${path}` });
    const browser = { [FORM_COOKIE]: cookieValue(page.setCookies, FORM_COOKIE) ?? "" };
    const form = { form: fieldOf(page.body, "form"), token: fieldOf(page.body, "token") };
    assert.equal((await visit({ url: `${portal.baseUrl}/account/email/verify`, cookies: browser, form })).status, 303);
    const replay = await visit({ url: `${portal.baseUrl}/account/email/verify`, cookies: browser, form });
    assert.equal(replay.status, 400);
    assert.equal(cookieValue(replay.setCookies, SESSION_COOKIE), null);
    assert.equal((await visit({ url: `${portal.baseUrl}${path}` })).status, 400, "the link now reads as used");
  });

  test("the confirmation link expires after 30 minutes", async () => {
    const portal = await startPortal();
    await signUp(portal, { email: "ada@example.com" });
    const [mail] = await portal.mailbox();
    assert.ok(mail !== undefined);
    portal.advanceClock(31 * MINUTE);
    const late = await followLink(portal, { link: linkIn(mail, `${PUBLIC_URL}/account/email/verify?token=`) });
    assert.equal(late.status, 400);
    assert.match(late.body, /expired/);
  });

  test("signing up again resends a fresh link and retires the older one", async () => {
    const portal = await startPortal();
    await signUp(portal, { email: "ada@example.com" });
    await signUp(portal, { email: "ada@example.com" });
    const [first, second] = await portal.mailbox();
    assert.ok(first !== undefined && second !== undefined);
    const older = linkIn(first, `${PUBLIC_URL}/account/email/verify?token=`);
    const newer = linkIn(second, `${PUBLIC_URL}/account/email/verify?token=`);
    assert.notEqual(older, newer);
    assert.equal((await followLink(portal, { link: older })).status, 400);
    sessionOf(await followLink(portal, { link: newer }));
  });

  test("signing up with an address that has an account answers exactly the same, and mails a notice instead of a link", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    const fresh = await signUp(portal, { email: "bob@example.com" });
    const taken = await signUp(portal, { email: "ada@example.com", password: "a different password entirely" });
    assert.equal(taken.status, fresh.status);
    assert.equal(taken.body.replace(/name="form" value="[^"]+"/g, ""), fresh.body.replace(/name="form" value="[^"]+"/g, ""));
    const notice = (await portal.mailbox()).at(-1);
    assert.ok(notice !== undefined);
    assert.equal(notice.headers.get("to"), "ada@example.com");
    assert.match(notice.text, /already/);
    assert.ok(!notice.text.includes("/account/email/verify"), "no confirmation link that could set a new password");
    assert.match(notice.text, /\/account\/email\/forgot/);
    assert.equal((await signIn(portal, { email: "ada@example.com", password: "a different password entirely" })).status, 401, "the old password stands");
  });

  const refusals: readonly Readonly<{ name: string; email: string; password: string; says: RegExp }>[] = [
    { name: "a password of 11 characters", email: "ada@example.com", password: "elevenchars", says: /at least 12/ },
    { name: "a password of 257 characters", email: "ada@example.com", password: "x".repeat(257), says: /at most 256/ },
    { name: "an address without @", email: "ada.example.com", password: PASSWORD, says: /email address/ },
    { name: "an address with a line break", email: "ada@example.com\r\nBcc: x@example.com", password: PASSWORD, says: /email address/ },
  ];
  for (const row of refusals) {
    test(`${row.name} is refused with a reason, and nothing is mailed`, async () => {
      const portal = await startPortal();
      const answer = await signUp(portal, { email: row.email, password: row.password });
      assert.equal(answer.status, 400);
      assert.match(answer.body, row.says);
      assert.equal((await portal.mailbox()).length, 0);
    });
  }

  test("a 12-character password of any characters is enough: no composition rules", async () => {
    const portal = await startPortal();
    assert.equal((await signUp(portal, { email: "ada@example.com", password: "aaaaaaaaaaaa" })).status, 200);
  });

  test("an unconfirmed sign-up cannot sign in; the right password resends the link, a wrong one reads as any failure", async () => {
    const portal = await startPortal();
    await signUp(portal, { email: "ada@example.com" });
    const wrong = await signIn(portal, { email: "ada@example.com", password: "not the password at all" });
    assert.equal(wrong.status, 401);
    const right = await signIn(portal, { email: "ada@example.com", password: PASSWORD });
    assert.equal(right.status, 403);
    assert.match(right.body, /Confirm your email address/);
    assert.equal(cookieValue(right.setCookies, SESSION_COOKIE), null);
    assert.equal((await portal.mailbox()).length, 2, "a new link was sent");
  });

  test("an unconfirmed sign-up expires after a day and no longer holds the address", async () => {
    const portal = await startPortal();
    await signUp(portal, { email: "ada@example.com", password: "the squatter's password" });
    portal.advanceClock(24 * 60 * MINUTE + MINUTE);
    assert.equal((await signIn(portal, { email: "ada@example.com", password: "the squatter's password" })).status, 401);
    await signedUp(portal, "ada@example.com");
  });
});

describe("sign in", () => {
  test("the right password signs in", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    const landed = await signIn(portal, { email: "ADA@example.com", password: PASSWORD });
    const page = await accountPage(portal, sessionOf(landed));
    assert.match(page, /Email and password/);
  });

  test("a wrong password and an unknown address get the same answer", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    const wrong = await signIn(portal, { email: "ada@example.com", password: "not the password at all" });
    const unknown = await signIn(portal, { email: "nobody@example.com", password: PASSWORD });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    const strip = (body: string): string => body.replace(/name="form" value="[^"]+"/g, "").replace(/value="[^"]*@example.com"/g, "");
    assert.equal(strip(wrong.body), strip(unknown.body));
    assert.match(wrong.body, /email address or password is not right/);
    assert.equal(cookieValue(wrong.setCookies, SESSION_COOKIE), null);
  });

  test("ten attempts per account in 15 minutes: the eleventh is refused even with the right password, from any address", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await signIn(portal, { email: "ada@example.com", password: `guess number ${String(attempt)}!`, clientIp: `203.0.113.${String(attempt)}` })).status, 401);
    }
    const throttled = await signIn(portal, { email: "ada@example.com", password: PASSWORD, clientIp: "203.0.113.200" });
    assert.equal(throttled.status, 429);
    assert.match(throttled.body, /try again later/i);
    assert.ok(Number(throttled.retryAfter) > 0, "Retry-After");
    portal.advanceClock(15 * MINUTE);
    sessionOf(await signIn(portal, { email: "ada@example.com", password: PASSWORD }));
  });

  test("ten attempts per client in 15 minutes across any accounts; another client is unaffected", async () => {
    const portal = await startPortal();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await signIn(portal, { email: `user${String(attempt)}@example.com`, password: PASSWORD, clientIp: "203.0.113.7" });
    }
    assert.equal((await signIn(portal, { email: "fresh@example.com", password: PASSWORD, clientIp: "203.0.113.7" })).status, 429);
    assert.equal((await signIn(portal, { email: "fresh@example.com", password: PASSWORD, clientIp: "203.0.113.8" })).status, 401);
  });
});

describe("password reset", () => {
  async function requestReset(portal: Portal, email: string, clientIp?: string): Promise<Visit> {
    return submit(portal, { path: "/account/email/forgot", fields: { email }, ...(clientIp === undefined ? {} : { clientIp }) });
  }

  test("mails a link; setting a new password with it signs in, and only the new password works afterwards", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    const asked = await requestReset(portal, "Ada@Example.com");
    assert.equal(asked.status, 200);
    const mail = (await portal.mailbox()).at(-1);
    assert.ok(mail !== undefined);
    const link = linkIn(mail, `${PUBLIC_URL}/account/email/reset?token=`);
    const landed = await followLink(portal, { link, fields: { password: "a brand new password" } });
    sessionOf(landed);
    assert.equal((await signIn(portal, { email: "ada@example.com", password: PASSWORD })).status, 401);
    sessionOf(await signIn(portal, { email: "ada@example.com", password: "a brand new password" }));
    assert.equal((await followLink(portal, { link, fields: { password: "yet another password" } })).status, 400, "single use");
  });

  test("an unknown address gets the same answer and nothing is mailed", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    const sentBefore = (await portal.mailbox()).length;
    const known = await requestReset(portal, "ada@example.com");
    const unknown = await requestReset(portal, "nobody@example.com");
    assert.equal(known.status, unknown.status);
    const strip = (body: string): string => body.replace(/name="form" value="[^"]+"/g, "");
    assert.equal(strip(known.body), strip(unknown.body));
    assert.equal((await portal.mailbox()).length, sentBefore + 1);
  });

  test("a newer request retires the older link, and links expire after 30 minutes", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    await requestReset(portal, "ada@example.com");
    await requestReset(portal, "ada@example.com");
    const mails = await portal.mailbox();
    const older = linkIn(mailAt(mails, -2), `${PUBLIC_URL}/account/email/reset?token=`);
    const newer = linkIn(mailAt(mails, -1), `${PUBLIC_URL}/account/email/reset?token=`);
    assert.equal((await followLink(portal, { link: older, fields: { password: "a brand new password" } })).status, 400);
    portal.advanceClock(31 * MINUTE);
    assert.equal((await followLink(portal, { link: newer, fields: { password: "a brand new password" } })).status, 400);
    sessionOf(await signIn(portal, { email: "ada@example.com", password: PASSWORD }));
  });

  test("a too-short new password is refused without using up the link", async () => {
    const portal = await startPortal();
    await signedUp(portal, "ada@example.com");
    await requestReset(portal, "ada@example.com");
    const link = linkIn(mailAt(await portal.mailbox(), -1), `${PUBLIC_URL}/account/email/reset?token=`);
    const short = await followLink(portal, { link, fields: { password: "short" } });
    assert.equal(short.status, 400);
    assert.match(short.body, /at least 12/);
    sessionOf(await followLink(portal, { link, fields: { password: "long enough this time" } }));
  });
});

describe("mail throttles", () => {
  test("three mails per client in 15 minutes, then 429; another client is unaffected; the window slides", async () => {
    const portal = await startPortal();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await signUp(portal, { email: `user${String(attempt)}@example.com`, clientIp: "203.0.113.7" })).status, 200);
    }
    const refused = await signUp(portal, { email: "user9@example.com", clientIp: "203.0.113.7" });
    assert.equal(refused.status, 429);
    assert.match(refused.body, /try again later/i);
    assert.ok(Number(refused.retryAfter) > 0);
    assert.equal((await signUp(portal, { email: "user9@example.com", clientIp: "203.0.113.8" })).status, 200);
    assert.equal((await portal.mailbox()).length, 4);
    portal.advanceClock(15 * MINUTE);
    assert.equal((await signUp(portal, { email: "user10@example.com", clientIp: "203.0.113.7" })).status, 200);
  });

  test("ten mails per client per day", async () => {
    const portal = await startPortal();
    let admitted = 0;
    for (let window = 0; window < 4; window += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const answer = await signUp(portal, { email: `user${String(window)}-${String(attempt)}@example.com`, clientIp: "203.0.113.7" });
        if (answer.status === 200) admitted += 1;
      }
      portal.advanceClock(16 * MINUTE);
    }
    assert.equal(admitted, 10);
  });

  test("three mails per recipient in an hour, from any client", async () => {
    const portal = await startPortal();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await signUp(portal, { email: "ada@example.com", clientIp: `203.0.113.${String(attempt)}` })).status, 200);
    }
    assert.equal((await signUp(portal, { email: "ada@example.com", clientIp: "203.0.113.99" })).status, 429);
    assert.equal(
      (await submit(portal, { path: "/account/email/forgot", fields: { email: "ADA@example.com" }, clientIp: "203.0.113.98" })).status,
      429,
      "reset requests share the recipient's budget",
    );
    portal.advanceClock(61 * MINUTE);
    assert.equal((await signUp(portal, { email: "ada@example.com", clientIp: "203.0.113.97" })).status, 200);
  });

  test("a global daily cap stops all mail", async () => {
    const portal = await startPortal({ limits: { ...DEFAULT_PASSWORD_LIMITS, mailGlobalDaily: { ...DEFAULT_PASSWORD_LIMITS.mailGlobalDaily, limit: 2 } } });
    assert.equal((await signUp(portal, { email: "a@example.com", clientIp: "203.0.113.1" })).status, 200);
    assert.equal((await signUp(portal, { email: "b@example.com", clientIp: "203.0.113.2" })).status, 200);
    assert.equal((await signUp(portal, { email: "c@example.com", clientIp: "203.0.113.3" })).status, 429);
  });

  test("X-Real-IP is believed only from a trusted proxy: without one, every header value is the same client", async () => {
    const portal = await startPortal({ trustedProxies: NO_TRUSTED_PROXIES });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await signUp(portal, { email: `user${String(attempt)}@example.com`, clientIp: `203.0.113.${String(attempt)}` })).status, 200);
    }
    assert.equal((await signUp(portal, { email: "user9@example.com", clientIp: "203.0.113.50" })).status, 429, "the spoofed header bought nothing");
    assert.ok(portal.warnings.some((line) => /X-Real-IP/.test(line) && /--trusted-proxy/.test(line)), portal.warnings.join("\n"));
  });

  test("the logs never carry a full address or password", async () => {
    const portal = await startPortal({ trustedProxies: NO_TRUSTED_PROXIES });
    await signUp(portal, { email: "ada@example.com" });
    await signIn(portal, { email: "ada@example.com", password: PASSWORD });
    for (const line of portal.warnings) {
      assert.ok(!line.includes("ada@example.com"), line);
      assert.ok(!line.includes(PASSWORD), line);
    }
  });
});

describe("form cross-site defence", () => {
  const forgeries: readonly Readonly<{ name: string; cookie: boolean; token: (browser: Browser) => string | null }>[] = [
    { name: "no form cookie", cookie: false, token: (browser) => browser.formToken },
    { name: "no form field", cookie: true, token: () => null },
    { name: "a field minted for another browser", cookie: true, token: () => "AAAA" },
  ];
  for (const row of forgeries) {
    test(`a sign-up with ${row.name} → 403, and nothing is mailed`, async () => {
      const portal = await startPortal();
      const browser = await openForm(portal, "/account/email/signup");
      const token = row.token(browser);
      const answer = await visit({
        url: `${portal.baseUrl}/account/email/signup`,
        cookies: row.cookie ? { [FORM_COOKIE]: browser.formCookie } : {},
        form: { email: "ada@example.com", password: PASSWORD, ...(token === null ? {} : { form: token }) },
      });
      assert.equal(answer.status, 403);
      assert.equal((await portal.mailbox()).length, 0);
    });
  }

  test("the form cookie is __Host- prefixed: Secure, Path=/, no Domain, so a sibling host cannot plant one", async () => {
    const portal = await startPortal();
    const page = await visit({ url: `${portal.baseUrl}/account/email/signup` });
    const line = page.setCookies.find((cookie) => cookie.startsWith(`${FORM_COOKIE}=`)) ?? "";
    for (const attribute of ["Secure", "Path=/", "HttpOnly", "SameSite=Lax"]) assert.ok(line.split("; ").includes(attribute), `${attribute} in ${line}`);
    assert.ok(!/Domain=/i.test(line));
  });
});

describe("erase", () => {
  test("erasing an account removes its password, so the address can no longer sign in to anything", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: randomBytes(32) });
    const store = inMemoryAuthStore();
    const directory = storeAccountDirectory({ store, vault, now: () => new Date(), newAccountId: () => "acct-1" });
    const subject = "subject-of-ada";
    await store.passwordCredentials.put({ key: emailLinkKey(subject), value: { subject, passwordHash: "$scrypt$x", updatedAtMs: 0 } });
    const accountId = await directory.findOrCreateByIdentity({ provider: "email", subject, email: "ada@example.com" });
    const eraser = createAccountEraser({ store, vault, revokeGoogleToken: () => Promise.resolve(false) });
    const report = await eraser.eraseAccount({ accountId });
    assert.equal(await store.passwordCredentials.get({ key: emailLinkKey(subject) }), null);
    assert.equal(report.recordsRemoved, 3, "link, password and account");
  });
});
