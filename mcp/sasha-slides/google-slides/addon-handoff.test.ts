/**
 * The add-on HANDOFF (SPEC.md 21.13) against a fake set of Google keys:
 *
 *   identity tokens with a bad signature, the wrong issuer, the wrong audience or past their expiry
 *   are refused with 401 addonIdentityRejected, and a valid one is accepted (the control row);
 *   a valid token on a new binding -> needsImport; after the import -> open while the revision is
 *   unchanged, changedSinceImport when it differs; only SHA-256(binding secret) is stored; an
 *   import token works once; a binding bound to a deck the account cannot edit is refused.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { AddonExportPlanBody, AddonHandoffBody, AddonImportBody, DeckApiErrorBody, GoogleSlidesExportBody } from "../engine/src/contracts/deck-api.ts";
import { ADDON_BINDING_SECRET_HEADER, ADDON_IDENTITY_AUDIENCES, ADDON_IDENTITY_HEADER, ADDON_PAGE_IDS_HEADER } from "./addon-identity.ts";
import { createGoogleSlidesInterchange } from "./google-slides-interchange.ts";
import { createTestDeckService, testCaller, type TestDeckService } from "./testing-deck-service.ts";
import { createFakeAccounts, createFakeGoogle, createFakeGrantStore, createSigningKeys, serveInterchange, sha256, signedToken, TEST_CLIENT } from "./testing-google-fakes.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/presentation.json", import.meta.url), "utf-8"));
const PRESENTATION_ID = "1Z7XcNtZXKwQLq6scGKZujaWFtWuCTVPLYjs3UcoJBnA";
const RECORDED_REVISION = "5lBHi6qusmi34A";
const AUDIENCE = ADDON_IDENTITY_AUDIENCES[0]?.audience ?? "";
const BINDING_SECRET = "Q2xhdWRlLWJpbmRpbmctc2VjcmV0LXR3by11dWlkcw";
const NOW = Date.UTC(2026, 9, 15, 12);
const keys = createSigningKeys();

describe("add-on handoff (fake Google keys)", () => {
  test("identity token verification: signature, issuer, audience, expiry", async () => {
    await using harness = await createHarness();
    const valid = { iss: "https://accounts.google.com", aud: AUDIENCE, sub: "subject-one", email: "one@example.com", email_verified: true, exp: NOW / 1000 + 600 };
    // Columns: what is wrong with the token -> the status and error the handoff answers.
    const rows = [
      { label: "bad signature", token: signedToken({ claims: valid, key: keys.otherPrivateKey }), status: 401, error: "addonIdentityRejected" },
      { label: "wrong issuer", token: signedToken({ claims: { ...valid, iss: "https://evil.example" }, key: keys.privateKey }), status: 401, error: "addonIdentityRejected" },
      { label: "wrong audience", token: signedToken({ claims: { ...valid, aud: "someone-elses-client.apps.googleusercontent.com" }, key: keys.privateKey }), status: 401, error: "addonIdentityRejected" },
      { label: "expired", token: signedToken({ claims: { ...valid, exp: NOW / 1000 - 1 }, key: keys.privateKey }), status: 401, error: "addonIdentityRejected" },
      { label: "not a token", token: "nonsense", status: 401, error: "addonIdentityRejected" },
      { label: "valid (control)", token: signedToken({ claims: valid, key: keys.privateKey }), status: 200, error: null },
    ];
    for (const row of rows) {
      const answer = await handoff({ harness, token: row.token, revisionId: RECORDED_REVISION });
      assert.equal(answer.status, row.status, row.label);
      if (row.error !== null) assert.equal((await bodyOf<DeckApiErrorBody>(answer)).error, row.error, row.label);
    }
  });

  test("new binding -> needsImport; import (single use) binds SHA-256(secret); then open, or changedSinceImport when the revision differs", async () => {
    await using harness = await createHarness();
    const token = identity({ subject: "subject-one" });
    const first = await bodyOf<AddonHandoffBody>(await handoff({ harness, token, revisionId: RECORDED_REVISION }));
    assert.equal(first.kind, "needsImport");
    if (first.kind !== "needsImport") return;

    const imported = await harness.server.call({ method: "POST", path: "/deck-api/addon/import", body: { importToken: first.importToken, presentation: RECORDED, replaceDeckId: null } });
    assert.equal(imported.status, 201);
    const importBody = await bodyOf<AddonImportBody>(imported);
    assert.equal(importBody.ticket, `ticket-for-${importBody.deckId}`);
    assert.equal(importBody.report.slideCount, 8);

    assert.deepEqual([...harness.service.bindings.entries()], [[sha256(BINDING_SECRET), importBody.deckId]], "the binding is the secret's SHA-256");
    assert.ok(!JSON.stringify([...harness.service.bindings.keys()]).includes(BINDING_SECRET), "the secret itself is never stored");

    const reused = await harness.server.call({ method: "POST", path: "/deck-api/addon/import", body: { importToken: first.importToken, presentation: RECORDED, replaceDeckId: null } });
    assert.equal(reused.status, 401, "an import token works once");

    // Columns: the revision the add-on reads now -> what the handoff answers.
    const rows = [
      { label: "unchanged", revisionId: RECORDED_REVISION, kind: "open" },
      { label: "changed since the import", revisionId: "a-newer-revision", kind: "changedSinceImport" },
    ];
    for (const row of rows) {
      const answer = await bodyOf<AddonHandoffBody>(await handoff({ harness, token, revisionId: row.revisionId }));
      assert.equal(answer.kind, row.kind, row.label);
      if (answer.kind !== "needsImport") assert.equal(answer.deckId, importBody.deckId, row.label);
    }
    const changed = await bodyOf<AddonHandoffBody>(await handoff({ harness, token, revisionId: "a-newer-revision" }));
    assert.equal(changed.kind, "changedSinceImport");
    if (changed.kind !== "changedSinceImport") return;
    const again = await harness.server.call({ method: "POST", path: "/deck-api/addon/import", body: { importToken: changed.importToken, presentation: RECORDED, replaceDeckId: changed.deckId } });
    assert.equal(again.status, 201, "Import again replaces the bound deck");
    assert.equal((await bodyOf<AddonImportBody>(again)).deckId, importBody.deckId);
    assert.equal(harness.service.decks.size, 1, "no second deck");
  });

  test("a binding already bound to a deck the account cannot edit is refused", async () => {
    await using harness = await createHarness();
    const owner = identity({ subject: "owner-subject" });
    const first = await bodyOf<AddonHandoffBody>(await handoff({ harness, token: owner, revisionId: RECORDED_REVISION }));
    if (first.kind !== "needsImport") throw new Error(first.kind);
    await harness.server.call({ method: "POST", path: "/deck-api/addon/import", body: { importToken: first.importToken, presentation: RECORDED, replaceDeckId: null } });
    const deckId = harness.service.bindings.get(sha256(BINDING_SECRET));
    assert.ok(deckId !== undefined);
    // Columns: the other account's role on the bound deck -> the handoff's status.
    const rows = [
      { label: "not a member", role: null, status: 403 },
      { label: "a viewer", role: "viewer" as const, status: 403 },
      { label: "an editor (control)", role: "editor" as const, status: 200 },
    ];
    for (const row of rows) {
      // The fake accounts map a Google subject to testCaller(subject) (testing-google-fakes.ts).
      harness.service.setRole({ deckId, accountId: testCaller("other-subject").accountId, role: row.role });
      const answer = await handoff({ harness, token: identity({ subject: "other-subject" }), revisionId: RECORDED_REVISION });
      assert.equal(answer.status, row.status, row.label);
    }
  });

  test("export in the add-on: runInAddon -> the plan for Code.gs (boundaries, notes) -> the result, all checked by token and binding", async () => {
    await using harness = await createHarness();
    const token = identity({ subject: "subject-one" });
    const first = await bodyOf<AddonHandoffBody>(await handoff({ harness, token, revisionId: RECORDED_REVISION }));
    if (first.kind !== "needsImport") throw new Error(first.kind);
    const imported = await bodyOf<AddonImportBody>(await harness.server.call({ method: "POST", path: "/deck-api/addon/import", body: { importToken: first.importToken, presentation: RECORDED, replaceDeckId: null } }));
    const requested = await bodyOf<GoogleSlidesExportBody>(
      await harness.server.call({ method: "POST", path: `/deck-api/decks/${imported.deckId}/google-slides/export`, account: "subject-one", body: { target: { kind: "linkedPresentation" } }, headers: { authorization: "Bearer embedded" } }),
    );
    assert.equal(requested.kind, "runInAddon");
    if (requested.kind !== "runInAddon") return;
    const headers = { [ADDON_IDENTITY_HEADER]: token, [ADDON_BINDING_SECRET_HEADER]: BINDING_SECRET, [ADDON_PAGE_IDS_HEADER]: "p,g1a2b3c4d5_0_1,hand_made_slide" };
    const wrongSecret = await harness.server.call({ method: "GET", path: `/deck-api/addon/export/${requested.exportId}`, headers: { ...headers, [ADDON_BINDING_SECRET_HEADER]: "another-presentations-secret-0000000000" } });
    assert.equal(wrongSecret.status, 401, "another presentation's secret");
    const plan = await bodyOf<AddonExportPlanBody>(await harness.server.call({ method: "GET", path: `/deck-api/addon/export/${requested.exportId}`, headers }));
    assert.equal(plan.presentationId, PRESENTATION_ID);
    const text = JSON.stringify(plan.requests);
    assert.equal((text.match(/"sashaSlideBoundary"/g) ?? []).length, 8, "one boundary per slide");
    assert.ok(text.includes('"deleteObject":{"objectId":"g1a2b3c4d5_0_1"}'), "an existing page is replaced");
    assert.ok(!text.includes('"objectId":"hand_made_slide"'), "a page added by hand is kept");
    assert.ok(text.includes('"sashaSpeakerNotes":{"slideObjectId":"g1a2b3c4d5_0_1","text":"Say the budget first.\\nThen the timeline."}'));
    const result = await harness.server.call({ method: "POST", path: `/deck-api/addon/export/${requested.exportId}/result`, headers, body: { outcome: { kind: "applied" } } });
    assert.equal(result.status, 200);
    assert.ok((harness.service.decks.get(imported.deckId)?.link?.lastExportedAt ?? 0) > 0, "the link records the export");
  });
});

/** Test-only widening: the handler under test wrote the body as `TBody`; the assertions read its fields. */
async function bodyOf<TBody>(response: Response): Promise<TBody> {
  return (await response.json()) as TBody;
}

function identity(options: Readonly<{ subject: string }>): string {
  return signedToken({ claims: { iss: "https://accounts.google.com", aud: AUDIENCE, sub: options.subject, email: `${options.subject}@example.com`, email_verified: true, exp: NOW / 1000 + 600 }, key: keys.privateKey });
}

async function handoff(options: Readonly<{ harness: Harness; token: string; revisionId: string }>): Promise<Response> {
  return options.harness.server.call({ method: "POST", path: "/deck-api/addon/handoff", body: { identityToken: options.token, presentationId: PRESENTATION_ID, bindingSecret: BINDING_SECRET, revisionId: options.revisionId } });
}

type Harness = AsyncDisposable & Readonly<{ server: Awaited<ReturnType<typeof serveInterchange>>; service: TestDeckService }>;

async function createHarness(): Promise<Harness> {
  const google = createFakeGoogle({ keys, presentation: RECORDED });
  const service = await createTestDeckService();
  let counter = 0;
  const interchange = createGoogleSlidesInterchange({
    deckService: service,
    embedTickets: { issue: async ({ deckId }) => `ticket-for-${deckId}` },
    accounts: createFakeAccounts(),
    googleGrants: createFakeGrantStore(),
    googleClient: TEST_CLIENT,
    publicUrl: "https://sashaslides.example",
    fetch: google.fetch,
    now: () => NOW,
    randomToken: () => `handoff${(counter += 1).toString().padStart(12, "0")}`,
    warn: () => undefined,
  });
  const server = await serveInterchange(interchange);
  return { server, service, [Symbol.asyncDispose]: () => server[Symbol.asyncDispose]() };
}
