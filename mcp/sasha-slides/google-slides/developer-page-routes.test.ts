/**
 * The developer page's two routes over real HTTP against fake Google and Drive endpoints
 * (testing-google-fakes.ts), on a virtual clock with a recorded `sleep`:
 *
 *   POST /deck-api/google-slides/insert-html   auth (401, 403 for a bearer, 409 with return=/dev),
 *     body problems (400, 413), the exact createSlide + batchUpdate bodies, staging on Drive and its
 *     clean-up, the diagram folder, file and link, best-effort warnings, Google failures by slide;
 *   POST /deck-api/google-slides/export-png    the zip's entries, "Skip slide", the range, the cap,
 *     the pacing between thumbnails and the backoff on 429.
 *
 * The router in front (Origin, `X-Sasha-Csrf`, the cookie) is tested in decks/deck-http.test.ts.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diagramVersionOf, DRAWIO_FILE_MEDIA_TYPE } from "../converter/drawio-diagram.ts";
import { diagramLinkRequests } from "../converter/drawio-save-plan.ts";
import { STAGED_IMAGE_URL } from "../converter/slide-image.ts";
import type { DeckApiErrorBody } from "../engine/src/contracts/deck-api.ts";
import { createGoogleSlidesInterchange } from "./google-slides-interchange.ts";
import { EXPORT_PNG_LIMITS, INSERT_HTML_LIMITS, type InsertHtmlResponseBody } from "./insert-html-contract.ts";
import { openPptxArchive } from "./pptx-archive.ts";
import { createTestDeckService } from "./testing-deck-service.ts";
import {
  connectedIdentity,
  createFakeAccounts,
  createFakeGoogle,
  createFakeGrantStore,
  createSigningKeys,
  PNG_BYTES,
  serveInterchange,
  sha256,
  TEST_CLIENT,
  thumbnailBytesOf,
  type FakeGoogle,
} from "./testing-google-fakes.ts";

const PRESENTATION_ID = "1Z7XcNtZXKwQLq6scGKZujaWFtWuCTVPLYjs3UcoJBnA";
const INSERT = "/deck-api/google-slides/insert-html";
const EXPORT = "/deck-api/google-slides/export-png";
const CONNECT_TO_DEV = "/deck-api/google-slides/connect?return=%2Fdev";
const DRAWIO_XML = '<mxfile><diagram id="a" name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
const DIAGRAM_ID = "dgabc12345";
const keys = createSigningKeys();

const elementProperties = { pageObjectId: "converter-page", size: { width: { magnitude: 100, unit: "EMU" }, height: { magnitude: 50, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: "EMU" } };
const insertBody = {
  presentation: `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit`,
  position: { kind: "index", index: 2 },
  slides: [
    { requests: [{ createShape: { objectId: "box", shapeType: "TEXT_BOX", elementProperties } }, { insertText: { objectId: "box", text: "Hello", insertionIndex: 0 } }], diagrams: [] },
    {
      requests: [{ createImage: { objectId: "pic", url: STAGED_IMAGE_URL, elementProperties }, sashaStageImage: { fileName: "pic.png", mimeType: "image/png", base64: PNG_BYTES.toString("base64") } }],
      diagrams: [{ objectId: "pic", diagramId: DIAGRAM_ID, xml: DRAWIO_XML }],
    },
  ],
};

describe("POST /deck-api/google-slides/insert-html", () => {
  test("signed out -> 401 with a sign-in address back to /dev; an embedded editor's bearer -> 403", async () => {
    await using harness = await createHarness();
    for (const path of [INSERT, EXPORT]) {
      const signedOut = await harness.server.call({ method: "POST", path, body: insertBody });
      assert.equal(signedOut.status, 401);
      assert.deepEqual(pick(await bodyOf<DeckApiErrorBody>(signedOut), ["error", "signInAddress"]), { error: "signedOut", signInAddress: "/account/deck-session?return=/dev" });
      const embedded = await harness.server.call({ method: "POST", path, account: "account-a", body: insertBody, headers: { authorization: "Bearer an-embed-token" } });
      assert.equal(embedded.status, 403);
      assert.equal((await bodyOf<DeckApiErrorBody>(embedded)).error, "notPermitted");
    }
    assert.equal(harness.google.batches.length, 0);
  });

  test("no grant, or a grant without drive.file -> 409 googleNotConnected with the connect address that returns to /dev", async () => {
    await using harness = await createHarness();
    const none = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody });
    assert.equal(none.status, 409);
    assert.deepEqual(pick(await bodyOf<DeckApiErrorBody>(none), ["error", "connectAddress"]), { error: "googleNotConnected", connectAddress: CONNECT_TO_DEV });
    const identity = connectedIdentity({ now: harness.clock.now() });
    harness.grants.grants.set("account-a", { ...identity, grantedScopes: identity.grantedScopes.filter((scope) => !scope.endsWith("/drive.file")) });
    const slidesOnly = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody });
    assert.equal(slidesOnly.status, 409);
    assert.equal((await bodyOf<DeckApiErrorBody>(slidesOnly)).connectAddress, CONNECT_TO_DEV);
    assert.equal(harness.google.drive.calls.length + harness.google.batches.length, 0);
  });

  test("body problems: not JSON -> 400, a disallowed kind -> 400, a foreign object or page -> 400, past the limit -> 413", async () => {
    await using harness = await createHarness();
    connect(harness);
    const notJson = await harness.raw({ path: INSERT, body: "{ not json" });
    assert.equal(notJson.status, 400);
    assert.equal((await bodyOf<DeckApiErrorBody>(notJson)).error, "invalidRequest");
    const withRequests = (requests: readonly unknown[]): unknown => ({ ...insertBody, slides: [{ requests, diagrams: [] }] });
    const rows: readonly Readonly<{ name: string; body: unknown; pattern: RegExp }>[] = [
      { name: "deleteObject", body: withRequests([{ deleteObject: { objectId: "g1" } }]), pattern: /deleteObject/ },
      { name: "replaceAllText", body: withRequests([{ replaceAllText: { containsText: { text: "a" }, replaceText: "b" } }]), pattern: /replaceAllText/ },
      { name: "an existing object", body: withRequests([{ insertText: { objectId: "g_existing", text: "x" } }]), pattern: /not created earlier/ },
      { name: "another page", body: withRequests([{ createShape: { objectId: "a", shapeType: "RECTANGLE", elementProperties } }, { createShape: { objectId: "b", shapeType: "RECTANGLE", elementProperties: { ...elementProperties, pageObjectId: "g_other_slide" } } }]), pattern: /same page/ },
    ];
    for (const row of rows) {
      const answer = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: row.body });
      assert.equal(answer.status, 400, row.name);
      const body = await bodyOf<DeckApiErrorBody>(answer);
      assert.equal(body.error, "invalidRequest", row.name);
      assert.match(body.message, row.pattern, row.name);
    }
    const oversized = await harness.raw({ path: INSERT, body: `"${"x".repeat(INSERT_HTML_LIMITS.maximumBodyBytes)}"` });
    assert.equal(oversized.status, 413);
    assert.equal((await bodyOf<DeckApiErrorBody>(oversized)).error, "tooLarge");
    assert.equal(harness.google.drive.calls.length + harness.google.batches.length, 0, "nothing reached Google");
  });

  test("happy path: createSlide + one batch per slide with rewritten ids, the staged picture uploaded, shared, substituted and deleted; the diagram saved and linked", async () => {
    await using harness = await createHarness();
    connect(harness);
    const answer = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody });
    assert.equal(answer.status, 200, await answer.clone().text());
    const body = await bodyOf<InsertHtmlResponseBody>(answer);
    const prefix = `h${sha256("token000000000001").slice(0, 12)}_`;
    const { drive } = harness.google;
    const staged = drive.uploaded[0];
    const diagramFile = drive.uploaded[1];
    assert.ok(staged !== undefined && diagramFile !== undefined);

    assert.deepEqual(harness.google.batches, [
      {
        presentationId: PRESENTATION_ID,
        requests: [
          { createSlide: { objectId: `${prefix}p1`, insertionIndex: 2, slideLayoutReference: { predefinedLayout: "BLANK" } } },
          { createShape: { objectId: `${prefix}s1e1`, shapeType: "TEXT_BOX", elementProperties: { ...elementProperties, pageObjectId: `${prefix}p1` } } },
          { insertText: { objectId: `${prefix}s1e1`, text: "Hello", insertionIndex: 0 } },
        ],
      },
      {
        presentationId: PRESENTATION_ID,
        requests: [
          { createSlide: { objectId: `${prefix}p2`, insertionIndex: 3, slideLayoutReference: { predefinedLayout: "BLANK" } } },
          { createImage: { objectId: `${prefix}s2e1`, url: `https://drive.google.com/uc?id=${staged.id}`, elementProperties: { ...elementProperties, pageObjectId: `${prefix}p2` } } },
        ],
      },
      {
        presentationId: PRESENTATION_ID,
        requests: [...diagramLinkRequests({ objectId: `${prefix}s2e1`, fileId: diagramFile.id, stamp: { diagramId: DIAGRAM_ID, version: diagramVersionOf(DRAWIO_XML) } })],
      },
    ]);
    assert.ok(!JSON.stringify(harness.google.batches).includes("sashaStageImage"), "the sidecar never reaches Google");

    assert.deepEqual({ name: staged.name, mimeType: staged.mimeType, parents: staged.parents, bytes: staged.bytes.toString("hex") }, { name: `${prefix}p2-image1.png`, mimeType: "image/png", parents: ["root"], bytes: PNG_BYTES.toString("hex") });
    assert.deepEqual(drive.permissions, [{ fileId: staged.id, body: { role: "reader", type: "anyone" } }]);
    assert.equal(drive.files.has(staged.id), false, "the staged copy is deleted after its batch");
    const folders = folderChain(harness.google);
    assert.deepEqual(folders.map((folder) => folder.name), ["sasha_slides", "slide", PRESENTATION_ID, "drawio"]);
    assert.deepEqual({ name: diagramFile.name, mimeType: diagramFile.mimeType, parents: diagramFile.parents, content: diagramFile.bytes.toString("utf8") }, { name: `${DIAGRAM_ID}.drawio`, mimeType: DRAWIO_FILE_MEDIA_TYPE, parents: [folders[3]?.id], content: DRAWIO_XML });
    assert.deepEqual(withoutIds(drive.calls), [
      `upload ${prefix}p2-image1.png`,
      "share <id>",
      "delete <id>",
      "find root/sasha_slides",
      "folder root/sasha_slides",
      "find <id>/slide",
      "folder <id>/slide",
      `find <id>/${PRESENTATION_ID}`,
      `folder <id>/${PRESENTATION_ID}`,
      "find <id>/drawio",
      "folder <id>/drawio",
      `find <id>/${DIAGRAM_ID}.drawio`,
      `upload ${DIAGRAM_ID}.drawio`,
    ]);
    assert.deepEqual(body, {
      presentationId: PRESENTATION_ID,
      presentationAddress: `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit`,
      pageObjectIds: [`${prefix}p1`, `${prefix}p2`],
      diagrams: [{ diagramId: DIAGRAM_ID, fileId: diagramFile.id }],
      warnings: [],
    });
  });

  test("a second insert of the same diagram reuses the folders and rewrites the same file in place", async () => {
    await using harness = await createHarness();
    connect(harness);
    const first = await bodyOf<InsertHtmlResponseBody>(await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody }));
    const callsBefore = harness.google.drive.calls.length;
    const second = await bodyOf<InsertHtmlResponseBody>(await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: { ...insertBody, position: { kind: "end" } } }));
    const later = withoutIds(harness.google.drive.calls.slice(callsBefore));
    assert.deepEqual(later.slice(3), ["find root/sasha_slides", "find <id>/slide", `find <id>/${PRESENTATION_ID}`, "find <id>/drawio", `find <id>/${DIAGRAM_ID}.drawio`, "update <id>"]);
    assert.deepEqual(second.diagrams, first.diagrams, "the same Drive file");
    assert.equal(folderChain(harness.google).length, 4, "no second folder of any name");
    const appended = harness.google.batches.slice(-3, -1).map((batch) => (batch.requests[0] as { createSlide: Readonly<Record<string, unknown>> }).createSlide);
    assert.deepEqual(appended.map((createSlide) => "insertionIndex" in createSlide), [false, false], "position end appends: no insertionIndex");
  });

  test("a diagram that cannot be saved or linked becomes a warning; the insert stands", async () => {
    await using harness = await createHarness();
    connect(harness);
    harness.google.drive.failNext = { operation: "folder", status: 500 };
    const folderless = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody });
    assert.equal(folderless.status, 200);
    const body = await bodyOf<InsertHtmlResponseBody>(folderless);
    assert.equal(body.pageObjectIds.length, 2);
    assert.deepEqual(body.diagrams, []);
    assert.equal(body.warnings.length, 1);
    assert.match(body.warnings[0] ?? "", /folder/);
    assert.equal(harness.google.batches.length, 2, "no link batch");

    harness.google.refuseBatch.text = "updateImageProperties";
    harness.google.refuseBatch.status = 400;
    const unlinked = await bodyOf<InsertHtmlResponseBody>(await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody }));
    assert.equal(unlinked.diagrams.length, 1, "the file was saved");
    assert.equal(unlinked.warnings.length, 1);
    assert.match(unlinked.warnings[0] ?? "", /could not be linked/);
  });

  test("Google failures: 403 on the first slide, 404 on the second (its staged copy still deleted), a staging upload refused", async () => {
    await using harness = await createHarness();
    connect(harness);
    harness.google.refuseBatch.text = '"createSlide"';
    harness.google.refuseBatch.status = 403;
    const denied = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody });
    assert.equal(denied.status, 403);
    const deniedBody = await bodyOf<DeckApiErrorBody>(denied);
    assert.equal(deniedBody.error, "googlePermissionDenied");
    assert.match(deniedBody.message, /^Slide 1 of 2 could not be inserted: .*No slide was inserted\.$/);

    harness.google.refuseBatch.text = "createImage";
    harness.google.refuseBatch.status = 404;
    const missing = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody });
    assert.equal(missing.status, 404);
    const missingBody = await bodyOf<DeckApiErrorBody>(missing);
    assert.equal(missingBody.error, "googlePresentationNotFound");
    assert.match(missingBody.message, /^Slide 2 of 2 .*Slide 1 was inserted\.$/);
    assert.deepEqual(withoutIds(harness.google.drive.calls).slice(-2), ["share <id>", "delete <id>"], "deleted although its batch failed; no diagram work after a failure");

    harness.google.refuseBatch.text = null;
    harness.google.drive.failNext = { operation: "upload", status: 403 };
    const unstaged = await harness.server.call({ method: "POST", path: INSERT, account: "account-a", body: insertBody });
    assert.equal(unstaged.status, 403);
    assert.match((await bodyOf<DeckApiErrorBody>(unstaged)).message, /^Slide 2 of 2 could not be inserted: a picture could not be staged on Drive/);
  });
});

describe("POST /deck-api/google-slides/export-png", () => {
  const EXPORT_ID = "1ExportPresentation0000000000000000000";
  const pages = (count: number, skipped: readonly number[]): unknown => ({
    presentationId: EXPORT_ID,
    slides: Array.from({ length: count }, (_, index) => ({ objectId: `page${index + 1}`, ...(skipped.includes(index + 1) ? { slideProperties: { isSkipped: true } } : {}) })),
  });
  const exportBody = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({ presentation: EXPORT_ID, from: null, to: null, skipHidden: true, ...overrides });

  test("a zip of slide-NN.png in slide order, skipped slides left out, thumbnails paced one second apart", async () => {
    await using harness = await createHarness();
    connect(harness);
    harness.google.presentations.set(EXPORT_ID, pages(4, [2]));
    const answer = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody() });
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.equal(answer.headers.get("content-type"), "application/zip");
    assert.equal(answer.headers.get("content-disposition"), `attachment; filename="${EXPORT_ID}-slides.zip"`);
    const zip = new Uint8Array(await answer.arrayBuffer());
    const entries = storedEntriesOf(zip);
    assert.deepEqual(entries.map((entry) => entry.name), ["slide-01.png", "slide-03.png", "slide-04.png"]);
    assert.deepEqual(entries.map((entry) => entry.bytes.toString("hex")), ["page1", "page3", "page4"].map((page) => thumbnailBytesOf(page).toString("hex")));
    assert.deepEqual(openPptxArchive(zip).names, ["slide-01.png", "slide-03.png", "slide-04.png"], "an independent reader agrees on the central directory");
    assert.deepEqual(harness.google.thumbnails.calls, ["page1", "page3", "page4"]);
    assert.deepEqual(harness.sleeps, [1000, 1000], "one second between thumbnail calls, none before the first");
  });

  test("the range is 1-based and inclusive; hidden slides stay when skipHidden is false; past the end -> 400", async () => {
    await using harness = await createHarness();
    connect(harness);
    harness.google.presentations.set(EXPORT_ID, pages(4, [2]));
    const ranged = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody({ from: 2, to: 3, skipHidden: false }) });
    assert.deepEqual(storedEntriesOf(new Uint8Array(await ranged.arrayBuffer())).map((entry) => entry.name), ["slide-02.png", "slide-03.png"]);
    for (const body of [exportBody({ from: 5 }), exportBody({ to: 9 }), exportBody({ from: 3, to: 2 }), exportBody({ from: 0 }), exportBody({ skipHidden: "yes" }), exportBody({ extra: 1 }), exportBody({ presentation: "nope" })]) {
      const refused = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body });
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
  });

  test("more than maximumSlides selected -> 400 before any thumbnail", async () => {
    await using harness = await createHarness();
    connect(harness);
    harness.google.presentations.set(EXPORT_ID, pages(EXPORT_PNG_LIMITS.maximumSlides + 1, []));
    const refused = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody() });
    assert.equal(refused.status, 400);
    assert.match((await bodyOf<DeckApiErrorBody>(refused)).message, /choose a range/);
    assert.equal(harness.google.thumbnails.calls.length, 0);
    const ranged = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody({ from: 2 }) });
    assert.equal(ranged.status, 200, "a range within the cap works");
  });

  test("a 429 backs off and retries; three in a row -> 429 rateLimited; a 403 fails at once; an unknown presentation -> 404", async () => {
    await using harness = await createHarness();
    connect(harness);
    harness.google.presentations.set(EXPORT_ID, pages(1, []));
    harness.google.thumbnails.statuses.push(429);
    const retried = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody() });
    assert.equal(retried.status, 200);
    assert.deepEqual(harness.sleeps, [2000]);
    harness.google.thumbnails.statuses.push(429, 429, 429);
    const limited = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody() });
    assert.equal(limited.status, 429);
    assert.equal((await bodyOf<DeckApiErrorBody>(limited)).error, "rateLimited");
    harness.google.thumbnails.statuses.push(403);
    const callsBefore = harness.google.thumbnails.calls.length;
    const denied = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody() });
    assert.equal(denied.status, 403);
    assert.equal(harness.google.thumbnails.calls.length, callsBefore + 1, "no retry after a 403");
    const unknown = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody({ presentation: "1NoSuchPresentation0000000000000" }) });
    assert.equal(unknown.status, 404);
    assert.equal((await bodyOf<DeckApiErrorBody>(unknown)).error, "googlePresentationNotFound");
  });

  test("without a grant -> 409 with the connect address back to /dev", async () => {
    await using harness = await createHarness();
    const answer = await harness.server.call({ method: "POST", path: EXPORT, account: "account-a", body: exportBody() });
    assert.equal(answer.status, 409);
    assert.equal((await bodyOf<DeckApiErrorBody>(answer)).connectAddress, CONNECT_TO_DEV);
  });
});

type Harness = AsyncDisposable &
  Readonly<{
    server: Awaited<ReturnType<typeof serveInterchange>>;
    google: FakeGoogle;
    grants: ReturnType<typeof createFakeGrantStore>;
    clock: Readonly<{ now: () => number }>;
    sleeps: readonly number[];
    raw(options: Readonly<{ path: string; body: string }>): Promise<Response>;
  }>;

async function createHarness(): Promise<Harness> {
  let time = Date.UTC(2026, 9, 17, 12);
  const sleeps: number[] = [];
  const google = createFakeGoogle({ keys, presentation: { presentationId: PRESENTATION_ID, slides: [] } });
  const grants = createFakeGrantStore();
  let counter = 0;
  const interchange = createGoogleSlidesInterchange({
    deckService: await createTestDeckService(),
    embedTickets: { issue: async ({ deckId }) => `ticket-for-${deckId}` },
    accounts: createFakeAccounts(),
    googleGrants: grants,
    googleClient: TEST_CLIENT,
    publicUrl: "https://sashaslides.example",
    fetch: google.fetch,
    now: () => time,
    randomToken: () => `token${(counter += 1).toString().padStart(12, "0")}`,
    warn: () => undefined,
    // The pacing seam: no real waiting, the virtual clock moves instead.
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
  });
  const server = await serveInterchange(interchange);
  return {
    server,
    google,
    grants,
    clock: { now: () => time },
    sleeps,
    raw: ({ path, body }) => fetch(`${server.origin}${path}`, { method: "POST", headers: { "x-test-account": "account-a", "content-type": "application/json" }, body }),
    [Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
  };
}

function connect(harness: Harness): void {
  harness.grants.grants.set("account-a", connectedIdentity({ now: harness.clock.now() }));
}

/** The answer's JSON. Test-only widening: the handler under test wrote it as `TBody`. */
async function bodyOf<TBody>(response: Response): Promise<TBody> {
  return (await response.json()) as TBody;
}

function pick(body: DeckApiErrorBody, keys: readonly (keyof DeckApiErrorBody)[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(keys.map((key) => [key, body[key]]));
}

function withoutIds(calls: readonly string[]): readonly string[] {
  return calls.map((call) => call.replace(/drivefile\d+xyz/g, "<id>"));
}

/** The diagram folders from My Drive's root down, as the fake holds them. */
function folderChain(google: FakeGoogle): readonly Readonly<{ id: string; name: string }>[] {
  const folders = [...google.drive.files.values()].filter((file) => file.mimeType === "application/vnd.google-apps.folder");
  const chain: Readonly<{ id: string; name: string }>[] = [];
  let parent = "root";
  for (;;) {
    const next = folders.find((folder) => folder.parents.includes(parent));
    if (next === undefined) return chain;
    chain.push({ id: next.id, name: next.name });
    parent = next.id;
  }
}

/** Each local entry of a stored zip: its name and bytes (method 0 asserted). */
function storedEntriesOf(zip: Uint8Array): readonly Readonly<{ name: string; bytes: Buffer }>[] {
  const buffer = Buffer.from(zip);
  const entries: Readonly<{ name: string; bytes: Buffer }>[] = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, "stored");
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, bytes: buffer.subarray(start, start + size) });
    offset = start + size;
  }
  return entries;
}
