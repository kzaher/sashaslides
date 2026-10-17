/**
 * Defect reports inside the connector, over real HTTP on loopback: the add-on's upload at
 * `/v1/reports`, then the admin pages at `/account/reports` behind the real account portal and a
 * real session cookie. Covers the overview, one report, the sandboxed slide, the zip, status and
 * notes, deletion, CSRF, and that only an allow-listed verified address sees anything.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/report-admin.test.ts
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { storeAccountDirectory } from "../http/account-directory";
import { createAccountEraser } from "../http/account-eraser";
import { createAccountVault, inMemoryDataKeyStore } from "../http/account-keys";
import { createAccountPortal, SESSION_LIFETIME_MS } from "../http/account-portal";
import type { AccountId } from "../http/account-vault";
import { signedValues } from "../http/cookies";
import { inMemoryAuthStore } from "../http/oauth-store";
import { parseAdminRoute } from "../reports/report-admin";
import { loadReportStack, type ReportStack } from "../reports/report-stack";
import { parseAdminAllowList, isAdmin } from "../reports/admin-allow-list";

const PUBLIC_URL = "https://slides.example.test";
const SESSION_SECRET = "a-session-secret-that-is-at-least-thirty-two-bytes-long";
const SANDBOX_ORIGIN = "https://n-abc123def-0lu-script.googleusercontent.com";
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const OWNER = "Owner@Example.com";

let server: Server;
let base = "";
let stack: ReportStack;
let dataDir = "";
let ownerCookie = "";
let strangerCookie = "";
const CSRF = "csrf-token-for-the-owner-session-000000";

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "report-admin-test-"));
  const store = inMemoryAuthStore();
  const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: randomBytes(32) });
  const directory = storeAccountDirectory({ store, vault, now: () => new Date(), newAccountId: () => `acct_${randomBytes(8).toString("hex")}` as AccountId });
  const owner = await directory.findOrCreateByIdentity({ provider: "google", subject: "owner", email: OWNER });
  const stranger = await directory.findOrCreateByIdentity({ provider: "google", subject: "stranger", email: "someone@example.com" });
  const loaded = await loadReportStack({
    directory: dataDir,
    env: { SASHA_ADMIN_EMAILS: "owner@example.com", REPORT_SWEEP_INTERVAL_SECONDS: "86400" },
    sessionSecret: SESSION_SECRET,
    now: () => new Date(),
    warn: () => undefined,
  });
  assert.equal(loaded.kind, "ok", loaded.kind === "failed" ? loaded.message : "");
  if (loaded.kind !== "ok") return;
  stack = loaded.stack;
  const portal = createAccountPortal({
    publicUrl: PUBLIC_URL,
    sessionSecret: SESSION_SECRET,
    providers: [],
    directory,
    eraser: createAccountEraser({ store, vault, revokeGoogleToken: () => Promise.resolve(false) }),
    now: () => new Date(),
    randomToken: () => randomBytes(24).toString("base64url"),
    warn: () => undefined,
    reportPages: stack.pages,
  });
  // The connector's order (http-server.ts): the portal, then the intake.
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    void (async () => {
      if (await portal.handleRequest({ request, response, url })) return;
      if (await stack.intake.handleRequest({ request, response, url })) return;
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  ownerCookie = sessionCookie({ accountId: owner, csrf: CSRF });
  strangerCookie = sessionCookie({ accountId: stranger, csrf: "csrf-token-for-the-stranger-000000000" });
});

after(async () => {
  stack.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

/** A session cookie exactly as the portal issues one (account-portal.ts `sessionCodec`). */
function sessionCookie(options: Readonly<{ accountId: AccountId; csrf: string }>): string {
  const now = Date.now();
  const value = signedValues({ secret: SESSION_SECRET, label: "" }).seal({
    accountId: options.accountId,
    exp: now + SESSION_LIFETIME_MS,
    csrf: options.csrf,
    auth: now,
  });
  return `sasha_account=${value}`;
}

async function upload(note: string): Promise<string> {
  const answer = await fetch(`${base}/v1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: JSON.stringify({
      schemaVersion: 2,
      note,
      document: { html: '<!doctype html><p>slide</p><script>alert("x")</script>' },
      converterOutput: { format: "slides-api-requests-json", text: "[]" },
      versions: { addon: "0.1.0", converter: "2026.10.04", protocol: 1 },
      clientReportedAt: "2026-10-04T12:00:00.000Z",
      context: { slideLabel: "Quarterly <results>" },
      attachments: {
        annotations: [{ id: "residual_0", tone: "risk", heading: "Numbers kept", detail: "Digits stay.", side: "as-sent" }],
        screenshots: [{ name: "as-sent.png", mediaType: "image/png", base64: PIXEL_PNG }],
      },
    }),
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.headers.get("access-control-allow-origin"), SANDBOX_ORIGIN);
  return String(((await answer.json()) as Record<string, unknown>)["id"]);
}

function get(path: string, cookie: string | null): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: "manual", headers: cookie === null ? {} : { cookie } });
}

function postForm(path: string, cookie: string, fields: Readonly<Record<string, string>>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

test("signed out is sent to sign in, and a signed-in account that is not an admin sees nothing", async () => {
  const id = await upload("private slide content ZEBRA");
  const signedOut = await get("/account/reports", null);
  assert.equal(signedOut.status, 303);
  assert.equal(signedOut.headers.get("location"), "/account");

  for (const path of ["/account/reports", `/account/reports/${id}`, `/account/reports/${id}/download`, `/account/reports/${id}/slide`]) {
    const refused = await get(path, strangerCookie);
    assert.equal(refused.status, 403, path);
    assert.equal((await refused.text()).includes("ZEBRA"), false);
  }
  const forged = await postForm(`/account/reports/${id}/delete`, strangerCookie, { csrf: "x", confirm: "yes" });
  assert.equal(forged.status, 403);
  assert.equal((await get(`/account/reports/${id}`, ownerCookie)).status, 200, "still there");
});

test("the overview lists date, slide, comment and status, and filters", async () => {
  await upload("the table lost its borders");
  await upload("chart legend vanished");
  const page = await get("/account/reports?q=legend", ownerCookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-src 'self'/);
  assert.match(html, /chart legend vanished/);
  assert.doesNotMatch(html, /the table lost its borders/);
  assert.match(html, /Quarterly &lt;results&gt;/, "the label is escaped");
  assert.match(html, /status-new/);
  assert.match(html, /owner@example\.com/i);
});

test("one report shows the comment, the review notes and the screenshot, and its slide is sandboxed", async () => {
  const id = await upload("rows overlap");
  const page = await get(`/account/reports/${id}`, ownerCookie);
  const html = await page.text();
  assert.match(html, /rows overlap/);
  assert.match(html, /Numbers kept/);
  assert.match(html, /<iframe src="\/account\/reports\/[^"]+\/slide" sandbox=""/);
  assert.equal(html.includes("<script"), false, "the slide's markup is never inlined");

  const slide = await get(`/account/reports/${id}/slide`, ownerCookie);
  assert.equal(slide.status, 200);
  assert.match(slide.headers.get("content-security-policy") ?? "", /^sandbox;/);
  assert.match(await slide.text(), /<p>slide<\/p>/);

  const shot = await get(`/account/reports/${id}/screenshots/as-sent.png`, ownerCookie);
  assert.equal(shot.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), Buffer.from(PIXEL_PNG, "base64"));
});

test("status and notes are saved, need the CSRF token, and travel in the zip", async () => {
  const id = await upload("text overflows");
  const withoutToken = await postForm(`/account/reports/${id}/status`, ownerCookie, { status: "fixed" });
  assert.equal(withoutToken.status, 403);

  const saved = await postForm(`/account/reports/${id}/status`, ownerCookie, { csrf: CSRF, status: "triaged" });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get("location"), `/account/reports/${id}`);
  assert.equal((await postForm(`/account/reports/${id}/status`, ownerCookie, { csrf: CSRF, status: "bogus" })).status, 400);
  assert.equal((await postForm(`/account/reports/${id}/notes`, ownerCookie, { csrf: CSRF, text: "seen on Chrome" })).status, 303);

  const html = await (await get(`/account/reports/${id}`, ownerCookie)).text();
  assert.match(html, /status-triaged/);
  assert.match(html, /seen on Chrome/);
  assert.match(await (await get("/account/reports?status=triaged", ownerCookie)).text(), /text overflows/);

  const zip = await get(`/account/reports/${id}/download`, ownerCookie);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.equal(zip.headers.get("content-disposition"), `attachment; filename="${id}.zip"`);
  const files = unzip(Buffer.from(await zip.arrayBuffer()));
  assert.ok(files.has(`${id}/slide.html`));
  assert.ok(files.has(`${id}/screenshots/as-sent.png`));
  const summary = JSON.parse(files.get(`${id}/report.json`)?.toString("utf8") ?? "{}") as Record<string, Record<string, unknown>>;
  assert.equal(summary["triage"]?.["status"], "triaged");
  assert.equal(summary["triage"]?.["statusChangedBy"], "owner@example.com");
});

test("delete needs the confirmation, then the report and its pages are gone", async () => {
  const id = await upload("delete me");
  assert.equal((await postForm(`/account/reports/${id}/delete`, ownerCookie, { csrf: CSRF })).status, 400);
  const deleted = await postForm(`/account/reports/${id}/delete`, ownerCookie, { csrf: CSRF, confirm: "yes" });
  assert.equal(deleted.status, 303);
  assert.equal(deleted.headers.get("location"), "/account/reports");
  assert.equal((await get(`/account/reports/${id}`, ownerCookie)).status, 404);
  assert.equal((await fetch(`${base}/v1/reports/${id}`)).status, 404);
});

test("routes parse only real ids, and the allow-list matches verified addresses case-insensitively", () => {
  assert.deepEqual(parseAdminRoute("/account/reports/"), { kind: "overview" });
  assert.equal(parseAdminRoute("/account/reports/..%2F..%2Fetc").kind, "not-found");
  assert.equal(parseAdminRoute("/account/reports/rep_0000000000000000000000000a/slide/x").kind, "not-found");
  const allow = parseAdminAllowList(" Owner@example.com, b@example.com ");
  assert.equal(allow.kind, "ok");
  if (allow.kind !== "ok") return;
  assert.equal(isAdmin({ allowList: allow.allowList, verifiedEmails: ["owner@example.com"] }), true);
  assert.equal(isAdmin({ allowList: allow.allowList, verifiedEmails: ["c@example.com"] }), false);
  assert.equal(parseAdminAllowList("not-an-address").kind, "error");
});

function unzip(zip: Buffer): ReadonlyMap<string, Buffer> {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(endAt + 10);
  let cursor = zip.readUInt32LE(endAt + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    const method = zip.readUInt16LE(cursor + 10);
    const size = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const localAt = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return files;
}
