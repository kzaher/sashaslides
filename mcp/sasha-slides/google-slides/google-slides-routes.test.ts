/**
 * The Google Slides ROUTES over real HTTP against fake Google endpoints (testing-google-fakes.ts)
 * and real engine model decks (testing-deck-service.ts), on a virtual clock:
 *
 *   import without a grant -> 409 googleNotConnected with the connect address;
 *   connect -> Google consent -> the shared callback answers ITS state and saves the grant, and a
 *     foreign state falls through (resolves false);
 *   import with a grant -> 201 and the deck;
 *   export with a grant -> exported, batches per slide;
 *   export without a grant, embedded (bearer) -> runInAddon; not embedded -> googleNotConnected;
 *   export-asset addresses serve only that export's assets, and 404 after 30 minutes;
 *   a failed batch on slide 3 reports slide 3 and keeps slides 1 and 2.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { DeckApiErrorBody, GoogleSlidesExportBody, GoogleSlidesImportBody } from "../engine/src/contracts/deck-api.ts";
import { createGoogleSlidesInterchange, EXPORT_ASSET_LIFETIME_MILLISECONDS } from "./google-slides-interchange.ts";
import { createTestDeckService, type TestDeckService } from "./testing-deck-service.ts";
import {
  asDeckId,
  connectedIdentity,
  createFakeAccounts,
  createFakeGoogle,
  createFakeGrantStore,
  createSigningKeys,
  PNG_BYTES,
  serveInterchange,
  signedToken,
  TEST_CLIENT,
  type FakeGoogle,
} from "./testing-google-fakes.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/presentation.json", import.meta.url), "utf-8"));
const PRESENTATION_ID = "1Z7XcNtZXKwQLq6scGKZujaWFtWuCTVPLYjs3UcoJBnA";
const PUBLIC_URL = "https://sashaslides.example";
const keys = createSigningKeys();

describe("Google Slides routes (fake Google, real model)", () => {
  test("import without a grant -> 409 googleNotConnected with the connect address", async () => {
    await using harness = await createHarness();
    const answer = await harness.server.call({ method: "POST", path: "/deck-api/google-slides/import", account: "account-a", body: { presentation: PRESENTATION_ID } });
    assert.equal(answer.status, 409);
    const body = await bodyOf<DeckApiErrorBody>(answer);
    assert.equal(body.error, "googleNotConnected");
    assert.equal(body.connectAddress, "/deck-api/google-slides/connect?return=%2Fdecks");
  });

  test("connect: consent for presentations and drive.file; the callback answers only its own state and saves the grant", async () => {
    await using harness = await createHarness();
    const consent = await harness.server.call({ method: "GET", path: "/deck-api/google-slides/connect?return=/deck/dk_test00000000000000001", account: "account-a" });
    assert.equal(consent.status, 303);
    const location = new URL(consent.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.deepEqual(location.searchParams.get("scope")?.split(" "), ["openid", "email", "https://www.googleapis.com/auth/presentations", "https://www.googleapis.com/auth/drive.file"]);
    assert.equal(location.searchParams.get("include_granted_scopes"), "true");
    assert.equal(location.searchParams.get("redirect_uri"), `${PUBLIC_URL}/oauth/google/callback`);
    const state = location.searchParams.get("state") ?? "";

    // Google answers the code exchange with tokens and an identity token issued to OUR client.
    harness.google.tokenAnswer.body = {
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3599,
      scope: "openid email https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.file",
      id_token: signedToken({ claims: { iss: "https://accounts.google.com", aud: TEST_CLIENT.clientId, sub: "google-subject-a", email: "a@example.com", email_verified: true, exp: harness.clock.now() / 1000 + 3600 }, key: keys.privateKey }),
    };
    const foreign = await harness.server.call({ method: "GET", path: "/oauth/google/callback?state=someone-elses&code=x" });
    assert.equal(foreign.status, 418, "a state this module did not issue falls through to the authorization server");
    assert.equal(harness.grants.saved.length, 0);

    const callback = await harness.server.call({ method: "GET", path: `/oauth/google/callback?state=${state}&code=the-code` });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/deck/dk_test00000000000000001?googleSlides=connected");
    assert.equal(harness.grants.saved.length, 1);
    assert.equal(harness.grants.saved[0]?.accountId, "account-a");
    assert.deepEqual({ subject: harness.grants.saved[0]?.identity.subject, refreshToken: harness.grants.saved[0]?.identity.refreshToken }, { subject: "google-subject-a", refreshToken: "fresh-refresh" });
    const replay = await harness.server.call({ method: "GET", path: `/oauth/google/callback?state=${state}&code=the-code` });
    assert.equal(replay.status, 418, "a state is answered once");
  });

  test("import with a grant -> 201 with the new deck and its report", async () => {
    await using harness = await createHarness();
    harness.grants.grants.set("account-a", connectedIdentity({ now: harness.clock.now() }));
    const answer = await harness.server.call({ method: "POST", path: "/deck-api/google-slides/import", account: "account-a", body: { presentation: `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit` } });
    assert.equal(answer.status, 201);
    const body = await bodyOf<GoogleSlidesImportBody>(answer);
    assert.equal(body.report.slideCount, 8);
    assert.equal(body.deck.googleSlides?.presentationId, PRESENTATION_ID);
    assert.equal(harness.service.decks.get(body.deck.deckId)?.store.snapshot().slides.length, 8);
  });

  test("export with a grant -> exported; without one, embedded -> runInAddon, not embedded -> googleNotConnected", async () => {
    await using harness = await createHarness();
    const deckId = await importedDeck(harness);
    const exported = await harness.server.call({ method: "POST", path: `/deck-api/decks/${deckId}/google-slides/export`, account: "account-a", body: { target: { kind: "newPresentation" } } });
    assert.equal(exported.status, 200);
    const body = await bodyOf<GoogleSlidesExportBody>(exported);
    assert.equal(body.kind, "exported");
    if (body.kind !== "exported") return;
    assert.equal(body.report.slideCount, 8);
    const slideBatches = harness.google.batches.filter((batch) => JSON.stringify(batch.requests[0]).includes("createSlide"));
    assert.equal(slideBatches.length, 8, "one batch per slide");

    harness.grants.grants.delete("account-a");
    const embedded = await harness.server.call({ method: "POST", path: `/deck-api/decks/${deckId}/google-slides/export`, account: "account-a", body: { target: { kind: "linkedPresentation" } }, headers: { authorization: "Bearer embedded-session" } });
    const embeddedBody = await bodyOf<GoogleSlidesExportBody>(embedded);
    assert.equal(embeddedBody.kind, "runInAddon");
    assert.ok(embeddedBody.kind === "runInAddon" && embeddedBody.exportId.length > 0);
    const webApplication = await harness.server.call({ method: "POST", path: `/deck-api/decks/${deckId}/google-slides/export`, account: "account-a", body: { target: { kind: "linkedPresentation" } } });
    assert.equal(webApplication.status, 409);
    assert.equal((await bodyOf<DeckApiErrorBody>(webApplication)).connectAddress, `/deck-api/google-slides/connect?return=${encodeURIComponent(`/deck/${deckId}`)}`);
  });

  test("export-asset addresses serve only that export's assets, and 404 after 30 minutes", async () => {
    await using harness = await createHarness();
    const deckId = await importedDeck(harness);
    await harness.server.call({ method: "POST", path: `/deck-api/decks/${deckId}/google-slides/export`, account: "account-a", body: { target: { kind: "newPresentation" } } });
    const imageAddress = /"createImage":\{"objectId":"[^"]+","url":"([^"]+)"/.exec(JSON.stringify(harness.google.batches))?.[1];
    assert.ok(imageAddress !== undefined, "an exported picture's createImage address");
    const path = new URL(imageAddress).pathname;
    assert.match(path, /^\/deck-api\/export-assets\/[^/]+\/[0-9a-f]{64}$/);
    // Columns: path, minutes later, expected status.
    const otherAsset = path.replace(/[0-9a-f]{64}$/, "b".repeat(64));
    const otherToken = path.replace(/export-assets\/[^/]+\//, "export-assets/not-a-token/");
    const rows = [
      { label: "its own picture", path, minutes: 0, status: 200 },
      { label: "a picture this export did not include", path: otherAsset, minutes: 0, status: 404 },
      { label: "another token", path: otherToken, minutes: 0, status: 404 },
      { label: "29 minutes later", path, minutes: 29, status: 200 },
      { label: "31 minutes later", path, minutes: 31, status: 404 },
    ];
    const start = harness.clock.now();
    for (const row of rows) {
      harness.clock.set(start + row.minutes * 60_000);
      const answer = await harness.server.call({ method: "GET", path: row.path });
      assert.equal(answer.status, row.status, row.label);
      if (row.status === 200) assert.deepEqual(Buffer.from(await answer.arrayBuffer()), PNG_BYTES, row.label);
    }
    assert.equal(EXPORT_ASSET_LIFETIME_MILLISECONDS, 30 * 60_000);
  });

  test("a failed batch on slide 3 reports slide 3 and keeps slides 1 and 2", async () => {
    await using harness = await createHarness();
    const deckId = await importedDeck(harness);
    const third = harness.service.decks.get(deckId)?.store.snapshot().slides[2]?.id ?? "";
    harness.google.refuseSlide.pageId = third;
    const answer = await harness.server.call({ method: "POST", path: `/deck-api/decks/${deckId}/google-slides/export`, account: "account-a", body: { target: { kind: "newPresentation" } } });
    assert.equal(answer.status, 502);
    const body = await bodyOf<DeckApiErrorBody>(answer);
    assert.equal(body.error, "googleFailed");
    assert.match(body.message, /slide 3/);
    const written = harness.google.batches.map((batch) => /"createSlide":\{"objectId":"([^"]+)"/.exec(JSON.stringify(batch.requests))?.[1]).filter((pageId) => pageId !== undefined);
    const slides = harness.service.decks.get(deckId)?.store.snapshot().slides.map((slide) => slide.id) ?? [];
    assert.deepEqual(written, slides.slice(0, 2), "slides 1 and 2 were written; nothing after the failure");
  });
});

/** The answer's JSON. Test-only widening: the handler under test wrote it as `TBody`, and each assertion reads its fields. */
async function bodyOf<TBody>(response: Response): Promise<TBody> {
  return (await response.json()) as TBody;
}

type Harness = AsyncDisposable &
  Readonly<{
    server: Awaited<ReturnType<typeof serveInterchange>>;
    google: FakeGoogle;
    grants: ReturnType<typeof createFakeGrantStore>;
    service: TestDeckService;
    clock: Readonly<{ now: () => number; set: (time: number) => void }>;
  }>;

async function createHarness(): Promise<Harness> {
  let time = Date.UTC(2026, 9, 15, 12);
  const clock = { now: () => time, set: (next: number) => (time = next) };
  const google = createFakeGoogle({ keys, presentation: RECORDED });
  const grants = createFakeGrantStore();
  const service = await createTestDeckService();
  let counter = 0;
  const interchange = createGoogleSlidesInterchange({
    deckService: service,
    embedTickets: { issue: async ({ deckId }) => `ticket-for-${deckId}` },
    accounts: createFakeAccounts(),
    googleGrants: grants,
    googleClient: TEST_CLIENT,
    publicUrl: PUBLIC_URL,
    fetch: google.fetch,
    now: clock.now,
    randomToken: () => `token${(counter += 1).toString().padStart(12, "0")}`,
    warn: () => undefined,
  });
  const server = await serveInterchange(interchange);
  return { server, google, grants, service, clock, [Symbol.asyncDispose]: () => server[Symbol.asyncDispose]() };
}

async function importedDeck(harness: Harness) {
  harness.grants.grants.set("account-a", connectedIdentity({ now: harness.clock.now() }));
  const answer = await harness.server.call({ method: "POST", path: "/deck-api/google-slides/import", account: "account-a", body: { presentation: PRESENTATION_ID } });
  const body = await bodyOf<GoogleSlidesImportBody>(answer);
  return asDeckId(body.deck.deckId);
}
