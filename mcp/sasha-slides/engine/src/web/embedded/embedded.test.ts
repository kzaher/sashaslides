// THE EDITOR EMBEDDED IN THE ADD-ON (acceptance 12): the fragment's ticket is exchanged once and
// removed from the address; the bearer is renewed 2 minutes before it expires; messages go only to
// the shell's origin and messages from anywhere else are ignored; an export the server answers
// `runInAddon` posts `exportRequested` with its id to the shell.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVirtualScheduler } from "../../state/testing/virtual-scheduler.ts";
import { createDeckApiClient, sessionCredentials } from "../api/deck-api-client.ts";
import { createExportRunner, type PageNotice } from "../deck-page/deck-exports.ts";
import { TEST_DECK_ID, TEST_PERSON } from "../testing/collaboration-harness.ts";
import { BEARER_RENEW_BEFORE_EXPIRY_MILLISECONDS, scheduleBearerRenewal, startEmbeddedSession, ticketFromFragment, type FrameAddress } from "./embedded-session.ts";
import { createShellRelay, shellOriginOf, type InboundMessage } from "./shell-relay.ts";

const SHELL_ORIGIN = "https://n-abc123-0lu-script.googleusercontent.com";

type Recorded = Readonly<{ method: string; path: string; body: string | null; authorization: string | null }>;

function apiAnswering(answer: (request: Recorded) => unknown) {
  const requests: Recorded[] = [];
  const api = createDeckApiClient({
    origin: "https://sashaslides.test",
    credentials: sessionCredentials("bearer"),
    fetch: (address, init) => {
      const request: Recorded = { method: init.method ?? "GET", path: new URL(address).pathname, body: typeof init.body === "string" ? init.body : null, authorization: new Headers(init.headers).get("Authorization") };
      requests.push(request);
      return Promise.resolve(new Response(JSON.stringify(answer(request)), { status: 200 }));
    },
  });
  return { api, requests };
}

function embedSession(options: Readonly<{ bearerToken: string; expiresAt: number }>): unknown {
  return {
    bearerToken: options.bearerToken,
    expiresAt: options.expiresAt,
    deckId: TEST_DECK_ID,
    session: { me: TEST_PERSON, email: null, csrfToken: "csrf-embedded", expiresAt: options.expiresAt, authentication: "bearer" },
  };
}

function frameAddress(initialHash: string) {
  let hash = initialHash;
  const replaced: string[] = [];
  const address: FrameAddress = {
    hash: () => hash,
    pathname: () => `/deck/${TEST_DECK_ID}`,
    search: () => "?embed=addon",
    replaceState: (next) => {
      replaced.push(next);
      hash = "";
    },
  };
  return { address, replaced };
}

describe("12. the embedded editor", () => {
  it("reads the ticket from the fragment only", () => {
    assert.equal(ticketFromFragment("#ticket=abc123"), "abc123");
    assert.equal(ticketFromFragment("#other=1&ticket=xyz"), "xyz");
    assert.equal(ticketFromFragment(""), null);
    assert.equal(ticketFromFragment("#ticket="), null);
  });

  for (const row of [
    { hash: "#ticket=T1cket", exchanges: 1, replaced: [`/deck/${TEST_DECK_ID}?embed=addon`], outcome: "started" },
    { hash: "", exchanges: 0, replaced: [], outcome: "noTicket" },
  ]) {
    it(`exchanges a ticket once and removes it from the address (fragment "${row.hash}")`, async () => {
      const { api, requests } = apiAnswering(() => embedSession({ bearerToken: "bearer-1", expiresAt: 900_000 }));
      const { address, replaced } = frameAddress(row.hash);
      const first = await startEmbeddedSession({ address, api });
      const second = await startEmbeddedSession({ address, api });
      assert.equal(first.kind, row.outcome);
      assert.equal(second.kind, "noTicket", "the second start finds no ticket");
      assert.equal(requests.length, row.exchanges);
      if (row.exchanges === 1) assert.deepEqual(requests[0], { method: "POST", path: "/deck-api/embed/session", body: JSON.stringify({ ticket: "T1cket" }), authorization: null });
      assert.deepEqual(replaced, row.replaced);
      assert.equal(api.credentials.bearerToken(), row.exchanges === 1 ? "bearer-1" : null, "the bearer is held in memory");
    });
  }

  it("renews the bearer 2 minutes before it expires, with the bearer, and again after each renewal", async () => {
    const scheduler = createVirtualScheduler({ startAt: 1_000_000 });
    let issued = 1;
    const { api, requests } = apiAnswering(() => {
      issued += 1;
      return embedSession({ bearerToken: `bearer-${issued}`, expiresAt: scheduler.now() + 15 * 60_000 });
    });
    api.credentials.update({ csrfToken: "csrf", bearerToken: "bearer-1" });
    const expiresAt = 1_000_000 + 15 * 60_000;
    const renewed: number[] = [];
    using _renewal = scheduleBearerRenewal({ api, scheduler, expiresAt, onRenewed: (session) => renewed.push(session.expiresAt), onExpired: () => assert.fail("expired") });
    scheduler.advanceBy(expiresAt - BEARER_RENEW_BEFORE_EXPIRY_MILLISECONDS - 1_000_000 - 1);
    assert.equal(requests.length, 0, "not before expiresAt - 2 minutes");
    scheduler.advanceBy(1);
    await settle();
    assert.deepEqual(requests.map((request) => ({ path: request.path, authorization: request.authorization })), [{ path: "/deck-api/embed/renew", authorization: "Bearer bearer-1" }]);
    assert.equal(api.credentials.bearerToken(), "bearer-2");
    assert.equal(renewed.length, 1);
    scheduler.advanceBy(13 * 60_000);
    await settle();
    assert.equal(requests.length, 2, "renewed again 13 minutes later");
    assert.equal(requests[1]?.authorization, "Bearer bearer-2");
  });

  it("accepts only the add-on's shell origins", () => {
    const rows = [
      { ancestorOrigins: [SHELL_ORIGIN], referrer: "", expected: SHELL_ORIGIN },
      { ancestorOrigins: ["https://docs.google.com"], referrer: "", expected: "https://docs.google.com" },
      { ancestorOrigins: null, referrer: `${SHELL_ORIGIN}/userCodeAppPanel?x=1`, expected: SHELL_ORIGIN },
      { ancestorOrigins: ["https://evil.example"], referrer: "", expected: null },
      { ancestorOrigins: ["https://googleusercontent.com"], referrer: "", expected: null },
      { ancestorOrigins: ["http://n-abc-script.googleusercontent.com"], referrer: "", expected: null },
      { ancestorOrigins: ["https://googleusercontent.com.evil.example"], referrer: "", expected: null },
      { ancestorOrigins: null, referrer: "", expected: null },
    ];
    for (const row of rows) assert.equal(shellOriginOf({ ancestorOrigins: row.ancestorOrigins, referrer: row.referrer }), row.expected, JSON.stringify(row));
  });

  it("posts only to the shell origin and ignores messages from another origin or window", () => {
    const posted: { message: unknown; targetOrigin: string }[] = [];
    const shell = { postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }) };
    let deliver: (message: InboundMessage) => void = () => undefined;
    using relay = createShellRelay({
      shellOrigin: SHELL_ORIGIN,
      shell,
      listen: (handler) => {
        deliver = handler;
        return { [Symbol.dispose]: () => undefined };
      },
      scheduler: createVirtualScheduler({ startAt: 0 }),
    });
    relay.post({ source: "sasha-editor", kind: "ready" });
    assert.deepEqual(posted, [{ message: { source: "sasha-editor", kind: "ready" }, targetOrigin: SHELL_ORIGIN }]);

    const received: unknown[] = [];
    const subscription = relay.messages.subscribe((message) => received.push(message));
    const finished = { source: "sasha-addon-shell", kind: "exportFinished", exportId: "ex_1", outcome: "applied", message: "" };
    const rows = [
      { origin: "https://evil.example", source: shell, data: finished, accepted: false },
      { origin: SHELL_ORIGIN, source: {}, data: finished, accepted: false },
      { origin: SHELL_ORIGIN, source: shell, data: { ...finished, kind: "somethingElse" }, accepted: false },
      { origin: SHELL_ORIGIN, source: shell, data: "not an object", accepted: false },
      { origin: SHELL_ORIGIN, source: shell, data: finished, accepted: true },
    ];
    for (const row of rows) {
      const before = received.length;
      deliver({ origin: row.origin, source: row.source, data: row.data });
      assert.equal(received.length - before, row.accepted ? 1 : 0, JSON.stringify({ origin: row.origin, data: row.data }));
    }
    subscription.unsubscribe();
  });

  it("an export answered runInAddon posts exportRequested with its id to the shell, and reports the shell's outcome", async () => {
    const { api, requests } = apiAnswering(() => ({ kind: "runInAddon", exportId: "ex_42" }));
    const posted: { message: unknown; targetOrigin: string }[] = [];
    const shell = { postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }) };
    let deliver: (message: InboundMessage) => void = () => undefined;
    using relay = createShellRelay({
      shellOrigin: SHELL_ORIGIN,
      shell,
      listen: (handler) => {
        deliver = handler;
        return { [Symbol.dispose]: () => undefined };
      },
      scheduler: createVirtualScheduler({ startAt: 0 }),
    });
    const notices: PageNotice[] = [];
    const exporting = createExportRunner({ deck: api.deck(TEST_DECK_ID), shell: relay, notify: (notice) => notices.push(notice) }).exportTo({ kind: "linkedPresentation" });
    await settle();
    assert.deepEqual(requests.map((request) => ({ method: request.method, path: request.path, body: request.body })), [
      { method: "POST", path: `/deck-api/decks/${TEST_DECK_ID}/google-slides/export`, body: JSON.stringify({ target: { kind: "linkedPresentation" } }) },
    ]);
    assert.deepEqual(posted, [{ message: { source: "sasha-editor", kind: "exportRequested", exportId: "ex_42" }, targetOrigin: SHELL_ORIGIN }]);
    deliver({ origin: SHELL_ORIGIN, source: shell, data: { source: "sasha-addon-shell", kind: "exportFinished", exportId: "ex_42", outcome: "applied", message: "" } });
    await exporting;
    assert.deepEqual(notices.at(-1), { tone: "information", message: "Exported to this presentation.", link: null });
  });
});

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}
