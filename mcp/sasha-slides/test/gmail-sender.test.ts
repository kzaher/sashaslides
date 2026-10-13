/**
 * The Gmail API sender: its config file parse, the refresh-token exchange, and the shape of
 * the message it sends, all against a fake token endpoint and a fake `messages.send`.
 *
 *   node --test --import tsx mcp/sasha-slides/test/gmail-sender.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  composeMessage,
  createGmailSender,
  encodeHeaderText,
  GMAIL_SEND_SCOPE,
  parseMailSenderConfig,
  type MailSenderConfig,
} from "../http/gmail-sender";
import { createFakeGmail, type FakeGmail } from "./fake-gmail";
import { fakeFetch } from "./fake-identity-providers";

const SECRET_VALUES = { clientId: "client-123.apps.googleusercontent.com", clientSecret: "GOCSPX-very-secret", refreshToken: "1//refresh-very-secret" };

const CONFIG: MailSenderConfig = {
  ...SECRET_VALUES,
  from: { address: "sasha.slides@exponent.company", displayName: "Sasha Slides" },
};

describe("mail sender config", () => {
  test("a complete file parses, with a display name in From", () => {
    const parsed = parseMailSenderConfig({ text: JSON.stringify({ ...SECRET_VALUES, from: "Sasha Slides <sasha.slides@exponent.company>" }) });
    assert.deepEqual(parsed, { kind: "ok", config: CONFIG });
  });

  test("a bare address is a From without a display name", () => {
    const parsed = parseMailSenderConfig({ text: JSON.stringify({ ...SECRET_VALUES, from: "noreply@example.com" }) });
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
      const parsed = parseMailSenderConfig({ text });
      assert.equal(parsed.kind, "error");
      if (parsed.kind !== "error") return;
      assert.match(parsed.message, row.names);
      for (const secret of Object.values(SECRET_VALUES)) assert.ok(!parsed.message.includes(secret), `${secret} not in ${parsed.message}`);
    });
  }
});

type Harness = Readonly<{ gmail: FakeGmail; send: ReturnType<typeof createGmailSender>["send"]; advanceClock: (milliseconds: number) => void }>;

function harness(options: Readonly<{ accessTokenLifetimeSeconds: number }>): Harness {
  let nowMs = Date.parse("2026-10-13T09:30:00Z");
  const gmail = createFakeGmail({ ...SECRET_VALUES, accessTokenLifetimeSeconds: options.accessTokenLifetimeSeconds });
  const network = fakeFetch({ routes: [gmail.route] });
  let counter = 0;
  const sender = createGmailSender({
    config: CONFIG,
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
