/**
 * The Gmail API sender: its config file parse (both shapes: a refresh token, or a service
 * account with domain-wide delegation), the two token grants, and the shape of the message it
 * sends, all against a fake token endpoint and a fake `messages.send`. The fake verifies each
 * service-account assertion's RS256 signature against the test key's public half.
 *
 *   node --test --import tsx mcp/sasha-slides/test/gmail-sender.test.ts
 */
import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { describe, test } from "node:test";
import {
  composeMessage,
  createGmailSender,
  encodeHeaderText,
  GMAIL_SEND_SCOPE,
  JWT_BEARER_GRANT_TYPE,
  parseMailSenderConfig,
  type MailSenderConfig,
} from "../http/gmail-sender";
import { GOOGLE_TOKEN_ENDPOINT } from "../google-constants";
import { createFakeGmail, type FakeGmail } from "./fake-gmail";
import { fakeFetch } from "./fake-identity-providers";

const SECRET_VALUES = { clientId: "client-123.apps.googleusercontent.com", clientSecret: "GOCSPX-very-secret", refreshToken: "1//refresh-very-secret" };

const CONFIG: MailSenderConfig = {
  credentials: { kind: "refresh-token", ...SECRET_VALUES },
  from: { address: "sasha.slides@exponent.company", displayName: "Sasha Slides" },
};

/** A refresh-token file has no key file to read; reading one is a test failure. */
const NO_KEY_FILES = (path: string): string => {
  throw new Error(`unexpected key file read: ${path}`);
};

const SERVICE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SERVICE_KEY_PEM = SERVICE_KEY.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const SERVICE_KEY_ID = "0123456789abcdef0123456789abcdef01234567";
const SERVICE_ACCOUNT_EMAIL = "sasha-mailer@sasha-slides.iam.gserviceaccount.com";
const IMPERSONATE = "noreply@exponent.company";
/** Google's standard downloaded key file, as `gcloud iam service-accounts keys create` writes it. */
const KEY_FILE = {
  type: "service_account",
  project_id: "sasha-slides",
  private_key_id: SERVICE_KEY_ID,
  private_key: SERVICE_KEY_PEM,
  client_email: SERVICE_ACCOUNT_EMAIL,
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: GOOGLE_TOKEN_ENDPOINT,
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/sasha-mailer%40sasha-slides.iam.gserviceaccount.com",
  universe_domain: "googleapis.com",
};
const SERVICE_DOCUMENT = { serviceAccountKeyPath: "gmail-service-account.json", impersonate: IMPERSONATE, from: "Sasha Slides <noreply@sashaslides.com>" };

function keyFiles(files: Readonly<Record<string, string>>): (path: string) => string {
  return (path) => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
    return text;
  };
}

function parseServiceAccount(keyFile: string, document: unknown = SERVICE_DOCUMENT): ReturnType<typeof parseMailSenderConfig> {
  return parseMailSenderConfig({ text: JSON.stringify(document), readKeyFile: keyFiles({ "gmail-service-account.json": keyFile }) });
}

describe("mail sender config", () => {
  test("a complete file parses, with a display name in From", () => {
    const parsed = parseMailSenderConfig({ text: JSON.stringify({ ...SECRET_VALUES, from: "Sasha Slides <sasha.slides@exponent.company>" }), readKeyFile: NO_KEY_FILES });
    assert.deepEqual(parsed, { kind: "ok", config: CONFIG });
  });

  test("a bare address is a From without a display name", () => {
    const parsed = parseMailSenderConfig({ text: JSON.stringify({ ...SECRET_VALUES, from: "noreply@example.com" }), readKeyFile: NO_KEY_FILES });
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    assert.deepEqual(parsed.config.from, { address: "noreply@example.com", displayName: null });
  });

  const broken: readonly Readonly<{ name: string; document: unknown; names: RegExp }>[] = [
    { name: "not JSON", document: "{", names: /not JSON/ },
    { name: "an array", document: [], names: /must be an object/ },
    { name: "a missing clientSecret", document: { ...SECRET_VALUES, clientSecret: undefined, from: "a@example.com" }, names: /clientSecret/ },
    { name: "an empty refreshToken", document: { ...SECRET_VALUES, refreshToken: "", from: "a@example.com" }, names: /refreshToken/ },
    { name: "an unknown key", document: { ...SECRET_VALUES, from: "a@example.com", scope: "x" }, names: /unknown key "scope"/ },
    { name: "a From with a line break", document: { ...SECRET_VALUES, from: "a@example.com\r\nBcc: victim@example.com" }, names: /from/ },
    { name: "a From that is not an address", document: { ...SECRET_VALUES, from: "Sasha Slides" }, names: /from/ },
  ];
  for (const row of broken) {
    test(`${row.name} is refused, naming the field and echoing no secret`, () => {
      const text = typeof row.document === "string" ? row.document : JSON.stringify(row.document);
      const parsed = parseMailSenderConfig({ text, readKeyFile: NO_KEY_FILES });
      assert.equal(parsed.kind, "error");
      if (parsed.kind !== "error") return;
      assert.match(parsed.message, row.names);
      for (const secret of Object.values(SECRET_VALUES)) assert.ok(!parsed.message.includes(secret), `${secret} not in ${parsed.message}`);
    });
  }

  test("a service-account file parses, reading Google's key file by the path it names", () => {
    const parsed = parseServiceAccount(JSON.stringify(KEY_FILE));
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    if (parsed.kind !== "ok") return;
    assert.deepEqual(parsed.config.from, { address: "noreply@sashaslides.com", displayName: "Sasha Slides" });
    const credentials = parsed.config.credentials;
    assert.equal(credentials.kind, "service-account");
    if (credentials.kind !== "service-account") return;
    assert.equal(credentials.clientEmail, SERVICE_ACCOUNT_EMAIL);
    assert.equal(credentials.impersonate, IMPERSONATE);
    assert.equal(credentials.privateKeyId, SERVICE_KEY_ID);
    assert.equal(credentials.tokenUrl, GOOGLE_TOKEN_ENDPOINT);
    assert.equal(credentials.privateKey.asymmetricKeyType, "rsa");
  });

  test("a key file without token_uri or private_key_id falls back to Google's token URL and no kid", () => {
    const parsed = parseServiceAccount(JSON.stringify({ ...KEY_FILE, token_uri: undefined, private_key_id: undefined }));
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    if (parsed.kind !== "ok" || parsed.config.credentials.kind !== "service-account") return;
    assert.equal(parsed.config.credentials.tokenUrl, GOOGLE_TOKEN_ENDPOINT);
    assert.equal(parsed.config.credentials.privateKeyId, null);
  });

  const ecPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const KEY_SECRET = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ-secret-looking";
  const brokenServiceAccounts: readonly Readonly<{ name: string; keyFile: string | null; document?: unknown; names: RegExp }>[] = [
    { name: "a missing key file", keyFile: null, names: /serviceAccountKeyPath: cannot read the key file \(ENOENT\)/ },
    { name: "a key file that is not JSON", keyFile: `{${KEY_SECRET}`, names: /serviceAccountKeyPath: the key file is not JSON/ },
    { name: "a key file of another type", keyFile: JSON.stringify({ ...KEY_FILE, type: "authorized_user" }), names: /type must be "service_account"/ },
    { name: "an OAuth client file", keyFile: JSON.stringify({ installed: { client_id: "x", client_secret: KEY_SECRET } }), names: /type must be "service_account"/ },
    { name: "a key file without client_email", keyFile: JSON.stringify({ ...KEY_FILE, client_email: undefined }), names: /client_email/ },
    { name: "a private_key that is not PEM", keyFile: JSON.stringify({ ...KEY_FILE, private_key: `-----BEGIN PRIVATE KEY-----\n${KEY_SECRET}\n-----END PRIVATE KEY-----\n` }), names: /private_key is not a PEM private key/ },
    { name: "a private_key that is not RSA", keyFile: JSON.stringify({ ...KEY_FILE, private_key: ecPem }), names: /private_key must be an RSA key/ },
    { name: "a token_uri that is not https", keyFile: JSON.stringify({ ...KEY_FILE, token_uri: "http://oauth2.googleapis.com/token" }), names: /token_uri/ },
    { name: "an impersonate that is not an address", keyFile: JSON.stringify(KEY_FILE), document: { ...SERVICE_DOCUMENT, impersonate: "noreply" }, names: /impersonate/ },
    { name: "a refresh-token key beside a key path", keyFile: JSON.stringify(KEY_FILE), document: { ...SERVICE_DOCUMENT, refreshToken: "x" }, names: /unknown key "refreshToken" \(allowed: serviceAccountKeyPath, impersonate, from\)/ },
    { name: "an empty key path", keyFile: JSON.stringify(KEY_FILE), document: { ...SERVICE_DOCUMENT, serviceAccountKeyPath: "" }, names: /serviceAccountKeyPath must name/ },
  ];
  for (const row of brokenServiceAccounts) {
    test(`${row.name} is refused, naming the field and echoing no key material`, () => {
      const parsed =
        row.keyFile === null
          ? parseMailSenderConfig({ text: JSON.stringify(SERVICE_DOCUMENT), readKeyFile: keyFiles({}) })
          : parseServiceAccount(row.keyFile, row.document ?? SERVICE_DOCUMENT);
      assert.equal(parsed.kind, "error");
      if (parsed.kind !== "error") return;
      assert.match(parsed.message, row.names);
      for (const secret of [KEY_SECRET, SERVICE_KEY_PEM.split("\n")[1] ?? "", "secret-looking"]) {
        assert.ok(!parsed.message.includes(secret), `key material in ${parsed.message}`);
      }
    });
  }
});

type Harness = Readonly<{ gmail: FakeGmail; send: ReturnType<typeof createGmailSender>["send"]; advanceClock: (milliseconds: number) => void }>;

function harness(options: Readonly<{ accessTokenLifetimeSeconds: number; config?: MailSenderConfig }>): Harness {
  let nowMs = Date.parse("2026-10-13T09:30:00Z");
  const gmail = createFakeGmail({
    ...SECRET_VALUES,
    refreshTokenOwner: CONFIG.from.address,
    serviceAccount: {
      clientEmail: SERVICE_ACCOUNT_EMAIL,
      publicKey: SERVICE_KEY.publicKey,
      privateKeyId: SERVICE_KEY_ID,
      users: [IMPERSONATE],
      nowMs: () => nowMs,
    },
    accessTokenLifetimeSeconds: options.accessTokenLifetimeSeconds,
  });
  const network = fakeFetch({ routes: [gmail.route] });
  let counter = 0;
  const sender = createGmailSender({
    config: options.config ?? CONFIG,
    fetch: network.fetch,
    now: () => new Date(nowMs),
    randomToken: () => `token${String((counter += 1))}`,
    timeoutMs: 5000,
  });
  return {
    gmail,
    send: sender.send,
    advanceClock: (milliseconds) => {
      nowMs += milliseconds;
    },
  };
}

const MAIL = {
  to: "ada@example.com",
  subject: "Confirm your email address",
  text: "Open this link: https://slides.example.test/account/email/verify?token=abc\n",
  html: "<p>Open <a href=\"https://slides.example.test/account/email/verify?token=abc\">this link</a></p>",
};

describe("sending", () => {
  test("refreshes an access token with the stored refresh token, then posts raw base64url to messages.send", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599 });
    const outcome = await send(MAIL);
    assert.deepEqual(outcome, { kind: "sent", messageId: "message-1" });

    const [refresh] = gmail.tokenRequests();
    assert.ok(refresh !== undefined);
    assert.equal(refresh.init.headers["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(refresh.init.body ?? "");
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), SECRET_VALUES.refreshToken);

    const [request] = gmail.sendRequests();
    assert.ok(request !== undefined);
    assert.equal(request.init.headers.authorization, "Bearer fake-access-1");
    assert.equal(request.init.headers["content-type"], "application/json");
    assert.deepEqual(Object.keys(JSON.parse(request.init.body ?? "{}") as object), ["raw"]);

    const [mail] = gmail.sent();
    assert.ok(mail !== undefined);
    assert.equal(mail.actingAs, "sasha.slides@exponent.company");
    assert.equal(mail.headers.get("from"), "Sasha Slides <sasha.slides@exponent.company>");
    assert.equal(mail.headers.get("to"), "ada@example.com");
    assert.equal(mail.headers.get("subject"), "Confirm your email address");
    assert.equal(mail.headers.get("date"), "Tue, 13 Oct 2026 09:30:00 +0000");
    assert.match(mail.headers.get("message-id") ?? "", /^<[A-Za-z0-9._-]+@exponent\.company>$/);
    assert.equal(mail.headers.get("mime-version"), "1.0");
    assert.match(mail.headers.get("content-type") ?? "", /^multipart\/alternative; boundary="[^"]+"$/);
    assert.equal(mail.text, MAIL.text);
    assert.equal(mail.html, MAIL.html);
    assert.ok(!mail.raw.replace(/\r\n/g, "").includes("\n"), "every line ends in CRLF");
    assert.ok(mail.raw.split("\r\n").every((line) => line.length <= 78), "no line is longer than 78 characters");
  });

  test("reuses the access token until it is about to expire", async () => {
    const { gmail, send, advanceClock } = harness({ accessTokenLifetimeSeconds: 3599 });
    await send(MAIL);
    await send(MAIL);
    assert.equal(gmail.tokenRefreshes(), 1);
    advanceClock(3599 * 1000 - 30 * 1000);
    await send(MAIL);
    assert.equal(gmail.tokenRefreshes(), 2, "refreshed inside the expiry margin");
    assert.equal(gmail.sent().length, 3);
  });

  test("a 401 from Gmail refreshes once and retries", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599 });
    gmail.rejectNextSends(1);
    assert.equal((await send(MAIL)).kind, "sent");
    assert.equal(gmail.tokenRefreshes(), 2);
    assert.equal(gmail.sent().length, 1);
  });

  test("a rejected refresh token fails the send with a reason that names the grant and no secret", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599 });
    gmail.expireRefreshToken();
    const outcome = await send(MAIL);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.match(outcome.reason, /invalid_grant/);
    assert.match(outcome.reason, /gmail-sender-token/);
    for (const secret of Object.values(SECRET_VALUES)) assert.ok(!outcome.reason.includes(secret));
    assert.equal(gmail.sent().length, 0);
  });

  test("a recipient with a line break is refused before anything is sent", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599 });
    const outcome = await send({ ...MAIL, to: "ada@example.com\r\nBcc: victim@example.com" });
    assert.equal(outcome.kind, "failed");
    assert.equal(gmail.sendRequests().length, 0);
  });

  test("the scope it needs is gmail.send alone", () => {
    assert.equal(GMAIL_SEND_SCOPE, "https://www.googleapis.com/auth/gmail.send");
  });
});

function serviceAccountConfig(document: unknown = SERVICE_DOCUMENT): MailSenderConfig {
  const parsed = parseServiceAccount(JSON.stringify(KEY_FILE), document);
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return parsed.config;
}

describe("sending as a service account with domain-wide delegation", () => {
  test("signs an RS256 assertion for gmail.send acting as the impersonated user, and Gmail sends as that user", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599, config: serviceAccountConfig() });
    const outcome = await send(MAIL);
    assert.deepEqual(outcome, { kind: "sent", messageId: "message-1" });
    assert.deepEqual(gmail.assertionRefusals(), []);

    const [grant] = gmail.tokenRequests();
    assert.ok(grant !== undefined);
    assert.equal(grant.init.headers["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(grant.init.body ?? "");
    assert.deepEqual([...form.keys()].sort(), ["assertion", "grant_type"]);
    assert.equal(form.get("grant_type"), JWT_BEARER_GRANT_TYPE);
    const [header, claims] = (form.get("assertion") ?? "")
      .split(".")
      .slice(0, 2)
      .map((segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as Record<string, unknown>);
    assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: SERVICE_KEY_ID });
    const issuedAt = Date.parse("2026-10-13T09:30:00Z") / 1000;
    assert.deepEqual(claims, { iss: SERVICE_ACCOUNT_EMAIL, sub: IMPERSONATE, scope: GMAIL_SEND_SCOPE, aud: GOOGLE_TOKEN_ENDPOINT, iat: issuedAt, exp: issuedAt + 3600 });

    const [request] = gmail.sendRequests();
    assert.equal(request?.init.headers.authorization, "Bearer fake-access-1");
    const [mail] = gmail.sent();
    assert.ok(mail !== undefined);
    assert.equal(mail.actingAs, IMPERSONATE);
    assert.equal(mail.headers.get("from"), "Sasha Slides <noreply@sashaslides.com>");
    assert.match(mail.headers.get("message-id") ?? "", /@sashaslides\.com>$/);
    assert.equal(mail.text, MAIL.text);
  });

  test("mints one access token and reuses it until it is about to expire", async () => {
    const { gmail, send, advanceClock } = harness({ accessTokenLifetimeSeconds: 3599, config: serviceAccountConfig() });
    await send(MAIL);
    await send(MAIL);
    assert.equal(gmail.tokenRequests().length, 1, "the second send reused the token");
    advanceClock(3599 * 1000 - 30 * 1000);
    await send(MAIL);
    assert.equal(gmail.tokenRequests().length, 2, "minted again inside the expiry margin, with a fresh assertion");
    assert.deepEqual(gmail.assertionRefusals(), []);
    assert.equal(gmail.sent().length, 3);
  });

  test("a 401 from Gmail mints a fresh token once and retries", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599, config: serviceAccountConfig() });
    gmail.rejectNextSends(1);
    assert.equal((await send(MAIL)).kind, "sent");
    assert.equal(gmail.tokenRefreshes(), 2);
  });

  test("unauthorized_client explains that domain-wide delegation is not set up, and where", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599, config: serviceAccountConfig() });
    gmail.withdrawDelegation();
    const outcome = await send(MAIL);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.match(outcome.reason, /unauthorized_client/);
    assert.match(outcome.reason, /domain-wide delegation is not set up for this service account's client ID with scope gmail\.send/);
    assert.match(outcome.reason, /Admin console → Security → API controls → Domain-wide delegation/);
    assert.ok(!outcome.reason.includes(SERVICE_KEY_PEM.split("\n")[1] ?? "-"));
    assert.equal(gmail.sent().length, 0);
  });

  test("invalid_grant says the impersonated user must exist and the key may be revoked", async () => {
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599, config: serviceAccountConfig({ ...SERVICE_DOCUMENT, impersonate: "nobody@exponent.company" }) });
    const outcome = await send(MAIL);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.match(outcome.reason, /invalid_grant/);
    assert.match(outcome.reason, /impersonate/);
    assert.match(outcome.reason, /revoked/);
    assert.ok(!outcome.reason.includes("nobody@exponent.company"), "no full address in the log line");
    assert.ok(!/gmail-sender-token/.test(outcome.reason), "the refresh-token advice does not apply");
    assert.equal(gmail.sent().length, 0);
  });

  test("an assertion signed by another key is refused by the token endpoint", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const parsed = parseMailSenderConfig({
      text: JSON.stringify(SERVICE_DOCUMENT),
      readKeyFile: keyFiles({ "gmail-service-account.json": JSON.stringify({ ...KEY_FILE, private_key: other }) }),
    });
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const { gmail, send } = harness({ accessTokenLifetimeSeconds: 3599, config: parsed.config });
    const outcome = await send(MAIL);
    assert.equal(outcome.kind, "failed");
    assert.deepEqual(gmail.assertionRefusals(), ["RS256 signature does not verify against the service account's public key"]);
  });
});

describe("message text", () => {
  test("a non-ASCII subject is RFC 2047 encoded in words of at most 75 characters, and decodes back", () => {
    const subject = "Potvrdite adresu e-pošte za Sasha Slides — šđčćž ✓ ".repeat(3);
    const encoded = encodeHeaderText(subject);
    const words = encoded.split(/\r\n /);
    assert.ok(words.length > 1);
    for (const word of words) {
      assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      assert.ok(word.length <= 75, `${String(word.length)}: ${word}`);
    }
    const decoded = words.map((word) => Buffer.from(word.slice(10, -2), "base64")).reduce((all, part) => Buffer.concat([all, part]), Buffer.alloc(0));
    assert.equal(decoded.toString("utf-8"), subject);
  });

  test("plain ASCII stays readable", () => {
    assert.equal(encodeHeaderText("Reset your password"), "Reset your password");
  });

  test("a subject cannot smuggle a header", () => {
    const message = composeMessage({
      from: CONFIG.from,
      to: "ada@example.com",
      subject: "Hello\r\nBcc: victim@example.com",
      text: "x",
      html: "<p>x</p>",
      date: new Date(0),
      messageId: "<id@example.com>",
      boundary: "b",
    });
    const headerBlock = message.slice(0, message.indexOf("\r\n\r\n"));
    assert.ok(!/^Bcc:/im.test(headerBlock), headerBlock);
  });
});
