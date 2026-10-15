// THE DECK'S IMAGES OVER HTTP (document-store.ts `AssetStore`, SPEC.md 21.8): uploads go to
// PUT /deck-api/decks/<id>/assets, and bytes come back from GET .../assets/<sha256> into object
// addresses (`URL.createObjectURL` in the page).
//
// Key decisions:
//
//  * BYTES ARE FETCHED WITH THE SESSION, NEVER LINKED. An `<img src="/deck-api/...">` would carry
//    the cookie but not the embedded editor's bearer token (a third-party frame has no cookie), so
//    both paths fetch the bytes through the API client and render an object address: the cookie
//    and the bearer behave the same, and the content security policy's `img-src blob:` covers it.
//  * `addressFor` NEVER WAITS. It answers null and starts the fetch; when the bytes arrive,
//    `available` emits the id and the editor re-renders (`assetAvailable`). A failed fetch is not
//    retried before `FETCH_RETRY_AFTER_MILLISECONDS` by the injected scheduler's clock, so a missing
//    image does not turn every render into a request.
//  * BYTES ARE COPIED IN AND OUT (`copyBytesOf` returns a fresh `slice(0)`), because the presenter
//    transfers what it gets into the runner frame, which detaches the buffer.

import { Subject, type SchedulerLike } from "rxjs";
import { assertNever } from "../../contracts/assert-never.ts";
import type { AssetMediaType } from "../../contracts/document.ts";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { AssetId } from "../../contracts/ids.ts";
import { okBodyOf, problemOf, type DeckClient } from "../api/deck-api-client.ts";

export const FETCH_RETRY_AFTER_MILLISECONDS = 10_000;

export type HttpAssetStore = AssetStore & Disposable;

export function createHttpAssetStore(options: Readonly<{
  deck: DeckClient;
  /** `URL.createObjectURL(new Blob([bytes], { type }))` in the page. */
  createAddress: (bytes: ArrayBuffer, mediaType: AssetMediaType) => string;
  /** `URL.revokeObjectURL` in the page, called on dispose. */
  releaseAddress: (address: string) => void;
  scheduler: SchedulerLike;
  reportError: (error: unknown, context: string) => void;
}>): HttpAssetStore {
  const entries = new Map<AssetId, Readonly<{ bytes: ArrayBuffer; address: string }>>();
  const fetches = new Map<AssetId, Promise<ArrayBuffer | null>>();
  const failedAt = new Map<AssetId, number>();
  const available = new Subject<AssetId>();

  const keep = (keepOptions: Readonly<{ assetId: AssetId; bytes: ArrayBuffer; mediaType: AssetMediaType }>): void => {
    if (entries.has(keepOptions.assetId)) return;
    entries.set(keepOptions.assetId, { bytes: keepOptions.bytes, address: options.createAddress(keepOptions.bytes.slice(0), keepOptions.mediaType) });
    available.next(keepOptions.assetId);
  };

  const fetchBytes = (assetId: AssetId): Promise<ArrayBuffer | null> => {
    const running = fetches.get(assetId);
    if (running !== undefined) return running;
    const fetching = options.deck.fetchAsset(assetId).then((result) => {
      fetches.delete(assetId);
      const fetched = okBodyOf(result);
      if (fetched === null) {
        failedAt.set(assetId, options.scheduler.now());
        options.reportError(new Error(problemOf(result) ?? "unknown"), `fetching the image ${assetId}`);
        return null;
      }
      failedAt.delete(assetId);
      keep({ assetId, bytes: fetched.bytes, mediaType: fetched.mediaType ?? "image/png" });
      return fetched.bytes;
    });
    fetches.set(assetId, fetching);
    return fetching;
  };

  return {
    put: async (bytes, mediaType) => {
      const copy = bytes.slice(0);
      const result = await options.deck.putAsset({ bytes: copy.slice(0), mediaType });
      switch (result.kind) {
        case "ok":
          keep({ assetId: result.body.assetId, bytes: copy, mediaType: result.body.mediaType });
          return result.body.assetId;
        case "failed":
        case "unreachable":
          // The uploads feedback retries a rejected put with backoff and reports the sentence.
          throw new Error(problemOf(result) ?? "The image could not be uploaded.");
        default:
          return assertNever(result);
      }
    },
    addressFor: (assetId) => {
      const entry = entries.get(assetId);
      if (entry !== undefined) return entry.address;
      const failed = failedAt.get(assetId);
      if (failed === undefined || options.scheduler.now() - failed >= FETCH_RETRY_AFTER_MILLISECONDS) void fetchBytes(assetId);
      return null;
    },
    available: available.asObservable(),
    copyBytesOf: async (assetId) => {
      const entry = entries.get(assetId);
      if (entry !== undefined) return entry.bytes.slice(0);
      const bytes = await fetchBytes(assetId);
      return bytes === null ? null : bytes.slice(0);
    },
    [Symbol.dispose]: () => {
      for (const entry of entries.values()) options.releaseAddress(entry.address);
      entries.clear();
      available.complete();
    },
  };
}
