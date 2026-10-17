// THE DECK API AS THE DEVELOPER PAGE CALLS IT (deck-api.ts): the session, the insert and the PNG
// export, against `Response`s built here. Covers the answers the page must tell apart: signed out
// (401), no Google grant (409 googleNotConnected), a refused request (400), and no service at all.

import assert from "node:assert/strict";
import test from "node:test";
import { CSRF_HEADER_NAME } from "../../../../mcp/sasha-slides/engine/src/contracts/deck-api.ts";
import type { ExportPngRequestBody, InsertHtmlResponseBody } from "../../../../mcp/sasha-slides/google-slides/insert-html-contract.ts";
import {
  attachmentNameOf,
  DEV_CONNECT_ADDRESS,
  DEV_SIGN_IN_ADDRESS,
  exportPng,
  failureOutcome,
  insertHtml,
  okValueOf,
  readSession,
  signInAddressOf,
  type Fetch,
} from "./deck-api.ts";

type Call = Readonly<{ address: string; init: RequestInit }>;

/** A fetch that records every call and answers with `answer`. */
function recordingFetch(answer: () => Response | Promise<Response>): Readonly<{ fetch: Fetch; calls: Call[] }> {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (address, init) => {
      calls.push({ address, init });
      return answer();
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SESSION = { me: { id: "person_ada_1", displayName: "Ada", colourIndex: 2, kind: "person" }, email: "ada@example.com", csrfToken: "csrf-123", expiresAt: 1, authentication: "cookie" };
const INSERTED: InsertHtmlResponseBody = {
  presentationId: "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY",
  presentationAddress: "https://docs.google.com/presentation/d/1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY/edit",
  pageObjectIds: ["p1", "p2"],
  diagrams: [{ diagramId: "d1", fileId: "f1" }],
  warnings: ["the diagram link could not be set"],
};
const EXPORT: ExportPngRequestBody = { presentation: "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY", from: 2, to: 4, skipHidden: true };

function headerOf(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

test("the session: signed in reads the CSRF token from GET /deck-api/session with the cookie", async () => {
  const { fetch, calls } = recordingFetch(() => json(200, SESSION));
  assert.deepEqual(await readSession({ fetch }), { kind: "signedIn", csrfToken: "csrf-123", displayName: "Ada", email: "ada@example.com" });
  assert.equal(calls[0]?.address, "/deck-api/session");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(calls[0]?.init.method, "GET");
});

test("the session: 401 is signed out, with the sign-in address that comes back to /dev", async () => {
  const { fetch } = recordingFetch(() => json(401, { error: "signedOut", message: "Sign in.", signInAddress: "/account/deck-session?return=%2Fdecks", connectAddress: null, retryAfterSeconds: null }));
  assert.deepEqual(await readSession({ fetch }), { kind: "signedOut", signInAddress: "/account/deck-session?return=%2Fdev" });
  assert.equal(DEV_SIGN_IN_ADDRESS, "/account/deck-session?return=%2Fdev");
});

test("the session: no connector (the local site answers 404), a body that does not parse, or no network is 'unavailable'", async () => {
  const notFound = await readSession({ fetch: recordingFetch(() => new Response("not found", { status: 404 })).fetch });
  assert.equal(notFound.kind, "unavailable");
  const garbled = await readSession({ fetch: recordingFetch(() => json(200, { me: 1 })).fetch });
  assert.equal(garbled.kind, "unavailable");
  const offline = await readSession({
    fetch: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.deepEqual(offline, { kind: "unavailable", message: "The deck service could not be reached (Failed to fetch)." });
});

test("insert: POSTs the body with the CSRF header and the cookie, and parses the answer", async () => {
  const { fetch, calls } = recordingFetch(() => json(200, INSERTED));
  const outcome = await insertHtml({ fetch, csrfToken: "csrf-123", bodyText: '{"x":1}' });
  assert.deepEqual(outcome, { kind: "ok", value: INSERTED });
  assert.equal(calls[0]?.address, "/deck-api/google-slides/insert-html");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(calls[0]?.init.body, '{"x":1}');
  assert.equal(headerOf(calls[0], CSRF_HEADER_NAME), "csrf-123");
  assert.equal(headerOf(calls[0], "Content-Type"), "application/json");
  assert.deepEqual(okValueOf(outcome), INSERTED);
});

test("insert: a presentation link that is not a Google address is dropped rather than linked", async () => {
  const { fetch } = recordingFetch(() => json(200, { ...INSERTED, presentationAddress: "javascript:alert(1)" }));
  const outcome = await insertHtml({ fetch, csrfToken: "t", bodyText: "{}" });
  assert.equal(okValueOf(outcome)?.presentationAddress, "");
});

test("insert: 401 signs the page out; 409 googleNotConnected offers the server's connect address", async () => {
  const signedOut = await insertHtml({ fetch: recordingFetch(() => json(401, { error: "signedOut", message: "Sign in.", signInAddress: null, connectAddress: null, retryAfterSeconds: null })).fetch, csrfToken: "t", bodyText: "{}" });
  assert.deepEqual(signedOut, { kind: "signedOut", signInAddress: DEV_SIGN_IN_ADDRESS });
  assert.equal(signInAddressOf(signedOut), DEV_SIGN_IN_ADDRESS);
  const connect = "/deck-api/google-slides/connect?return=%2Fdev";
  const notConnected = await insertHtml({
    fetch: recordingFetch(() => json(409, { error: "googleNotConnected", message: "Connect Google Slides to insert into it.", signInAddress: null, connectAddress: connect, retryAfterSeconds: null })).fetch,
    csrfToken: "t",
    bodyText: "{}",
  });
  assert.deepEqual(notConnected, { kind: "googleNotConnected", connectAddress: connect, message: "Connect Google Slides to insert into it." });
  assert.equal(signInAddressOf(notConnected), null);
  assert.equal(okValueOf(notConnected), null);
});

test("insert: 400 invalidRequest and other refusals show the server's sentence", async () => {
  const refused = await insertHtml({
    fetch: recordingFetch(() => json(400, { error: "invalidRequest", message: "Request 3 of slide 1 is not allowed: deleteObject.", signInAddress: null, connectAddress: null, retryAfterSeconds: null })).fetch,
    csrfToken: "t",
    bodyText: "{}",
  });
  assert.deepEqual(refused, { kind: "refused", status: 400, code: "invalidRequest", message: "Request 3 of slide 1 is not allowed: deleteObject." });
  const proxyPage = await insertHtml({ fetch: recordingFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 })).fetch, csrfToken: "t", bodyText: "{}" });
  assert.deepEqual(proxyPage, { kind: "refused", status: 502, code: "serverError", message: "The server answered 502." });
});

test("a failure answer: an unreadable 401 is still signed out; a foreign connect address is replaced by ours", () => {
  assert.deepEqual(failureOutcome({ status: 401, text: "" }), { kind: "signedOut", signInAddress: DEV_SIGN_IN_ADDRESS });
  const elsewhere = failureOutcome({ status: 409, text: JSON.stringify({ error: "googleNotConnected", message: "m", signInAddress: null, connectAddress: "https://evil.example/", retryAfterSeconds: null }) });
  assert.deepEqual(elsewhere, { kind: "googleNotConnected", connectAddress: DEV_CONNECT_ADDRESS, message: "m" });
  assert.equal(DEV_CONNECT_ADDRESS, "/deck-api/google-slides/connect?return=%2Fdev");
});

test("insert: a 200 whose body does not parse, and a network failure, are 'unreachable'", async () => {
  const garbled = await insertHtml({ fetch: recordingFetch(() => json(200, { presentationId: 1 })).fetch, csrfToken: "t", bodyText: "{}" });
  assert.equal(garbled.kind, "unreachable");
  const offline = await insertHtml({
    fetch: async () => {
      throw new TypeError("network down");
    },
    csrfToken: "t",
    bodyText: "{}",
  });
  assert.deepEqual(offline, { kind: "unreachable", message: "Sasha Slides could not be reached (network down)." });
});

test("PNG export: POSTs the range with the CSRF header and hands back the zip and its file name", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const { fetch, calls } = recordingFetch(
    () => new Response(bytes, { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="slides-2-4.zip"' } }),
  );
  const outcome = await exportPng({ fetch, csrfToken: "csrf-9", body: EXPORT });
  const value = okValueOf(outcome);
  assert.ok(value !== null, JSON.stringify(outcome));
  assert.equal(value.fileName, "slides-2-4.zip");
  assert.deepEqual(new Uint8Array(await value.zip.arrayBuffer()), bytes);
  assert.equal(calls[0]?.address, "/deck-api/google-slides/export-png");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), EXPORT);
  assert.equal(headerOf(calls[0], CSRF_HEADER_NAME), "csrf-9");
});

test("PNG export: errors are JSON like the insert's; a 200 that is not a zip is refused", async () => {
  const notConnected = await exportPng({
    fetch: recordingFetch(() => json(409, { error: "googleNotConnected", message: "Connect.", signInAddress: null, connectAddress: null, retryAfterSeconds: null })).fetch,
    csrfToken: "t",
    body: EXPORT,
  });
  assert.deepEqual(notConnected, { kind: "googleNotConnected", connectAddress: DEV_CONNECT_ADDRESS, message: "Connect." });
  const notZip = await exportPng({ fetch: recordingFetch(() => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } })).fetch, csrfToken: "t", body: EXPORT });
  assert.deepEqual(notZip, { kind: "unreachable", message: "The export answered text/html, not a zip." });
});

test("an attachment name is kept only when it is a plain file name", () => {
  assert.equal(attachmentNameOf('attachment; filename="deck (1).zip"'), "deck (1).zip");
  assert.equal(attachmentNameOf("attachment; filename=slides.zip"), "slides.zip");
  assert.equal(attachmentNameOf('attachment; filename="../../etc/passwd"'), null);
  assert.equal(attachmentNameOf(null), null);
});
