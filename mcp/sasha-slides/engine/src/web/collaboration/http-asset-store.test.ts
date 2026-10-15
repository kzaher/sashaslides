// THE HTTP ASSET STORE (acceptance 7): an upload is a PUT with the session's credentials -- the
// CSRF header with the cookie, `Authorization` with the embedded editor's bearer -- and answers the
// server's asset id; `addressFor` is null until the bytes are fetched, then an object address, and
// `available` says so.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssetId } from "../../contracts/ids.ts";
import { createVirtualScheduler } from "../../state/testing/virtual-scheduler.ts";
import { createDeckApiClient, sessionCredentials, type SessionCredentials } from "../api/deck-api-client.ts";
import { TEST_DECK_ID } from "../testing/collaboration-harness.ts";
import { createHttpAssetStore, FETCH_RETRY_AFTER_MILLISECONDS } from "./http-asset-store.ts";

const ASSET_ID = "a".repeat(64) as AssetId;

type Recorded = Readonly<{ method: string; path: string; headers: Headers; credentials: RequestCredentials | undefined }>;

function storeWith(options: Readonly<{ credentials: SessionCredentials; answers: (request: Recorded) => Response }>) {
  const requests: Recorded[] = [];
  const api = createDeckApiClient({
    origin: "https://sashaslides.test",
    credentials: options.credentials,
    fetch: (address, init) => {
      const recorded: Recorded = { method: init.method ?? "GET", path: new URL(address).pathname, headers: new Headers(init.headers), credentials: init.credentials };
      requests.push(recorded);
      return Promise.resolve(options.answers(recorded));
    },
  });
  const scheduler = createVirtualScheduler({ startAt: 0 });
  const addresses: string[] = [];
  const errors: string[] = [];
  const store = createHttpAssetStore({
    deck: api.deck(TEST_DECK_ID),
    createAddress: (_bytes, mediaType) => {
      const address = `blob:test/${addresses.length + 1}/${mediaType}`;
      addresses.push(address);
      return address;
    },
    releaseAddress: () => undefined,
    scheduler,
    reportError: (error) => errors.push(String(error)),
  });
  return { store, requests, scheduler, addresses, errors };
}

describe("7. the HTTP asset store", () => {
  for (const row of [
    { mode: "cookie" as const, bearer: null, csrfHeader: "csrf-cookie", authorization: null, credentials: "same-origin" },
    { mode: "bearer" as const, bearer: "bearer-token-1", csrfHeader: "csrf-cookie", authorization: "Bearer bearer-token-1", credentials: "omit" },
  ]) {
    it(`put sends PUT with the session's credentials (${row.mode}) and answers the server's asset id`, async () => {
      const credentials = sessionCredentials(row.mode);
      credentials.update({ csrfToken: "csrf-cookie", bearerToken: row.bearer });
      const { store, requests } = storeWith({
        credentials,
        answers: () => new Response(JSON.stringify({ assetId: ASSET_ID, mediaType: "image/png", byteLength: 3 }), { status: 200 }),
      });
      const assetId = await store.put(new Uint8Array([1, 2, 3]).buffer, "image/png");
      assert.equal(assetId, ASSET_ID);
      const [request] = requests;
      assert.ok(request !== undefined);
      assert.deepEqual(
        { method: request.method, path: request.path, csrf: request.headers.get("X-Sasha-Csrf"), authorization: request.headers.get("Authorization"), type: request.headers.get("Content-Type"), credentials: request.credentials },
        { method: "PUT", path: `/deck-api/decks/${TEST_DECK_ID}/assets`, csrf: row.csrfHeader, authorization: row.authorization, type: "image/png", credentials: row.credentials },
      );
      assert.equal(store.addressFor(assetId), "blob:test/1/image/png", "the uploaded bytes are addressable at once");
    });
  }

  it("addressFor is null until the bytes are fetched, then an object address, and available emits the id", async () => {
    const { store, requests } = storeWith({
      credentials: sessionCredentials("cookie"),
      answers: () => new Response(new Uint8Array([9, 9]), { status: 200, headers: { "Content-Type": "image/svg+xml" } }),
    });
    const available: AssetId[] = [];
    const subscription = store.available.subscribe((assetId) => available.push(assetId));
    assert.equal(store.addressFor(ASSET_ID), null);
    assert.equal(store.addressFor(ASSET_ID), null, "asked twice while fetching");
    await settle();
    assert.equal(requests.length, 1, "fetched once");
    assert.deepEqual({ method: requests[0]?.method, path: requests[0]?.path }, { method: "GET", path: `/deck-api/decks/${TEST_DECK_ID}/assets/${ASSET_ID}` });
    assert.equal(store.addressFor(ASSET_ID), "blob:test/1/image/svg+xml");
    assert.deepEqual(available, [ASSET_ID]);
    const copy = await store.copyBytesOf(ASSET_ID);
    assert.deepEqual(copy === null ? null : [...new Uint8Array(copy)], [9, 9]);
    subscription.unsubscribe();
  });

  it("a failed fetch is not retried before the retry interval", async () => {
    const { store, requests, scheduler } = storeWith({
      credentials: sessionCredentials("cookie"),
      answers: () => new Response(JSON.stringify({ error: "notFound", message: "No such image.", signInAddress: null, connectAddress: null, retryAfterSeconds: null }), { status: 404 }),
    });
    assert.equal(store.addressFor(ASSET_ID), null);
    await settle();
    assert.equal(store.addressFor(ASSET_ID), null);
    await settle();
    assert.equal(requests.length, 1, "not again at once");
    scheduler.advanceBy(FETCH_RETRY_AFTER_MILLISECONDS);
    assert.equal(store.addressFor(ASSET_ID), null);
    await settle();
    assert.equal(requests.length, 2, "again after the interval");
  });
});

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}
