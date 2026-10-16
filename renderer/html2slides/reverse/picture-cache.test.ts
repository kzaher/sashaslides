/**
 * The picture cache is what lets the reverse round trip be re-measured after the developer token
 * expires, so its contract is pinned here: an online answer is stored and replayed byte for byte
 * offline, a failed online answer is never stored, and an offline miss is a 404 (which the import
 * reports as a picture loss) rather than a network call.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cachingPictureFetch } from "./picture-cache.ts";

const ADDRESS = "https://lh7-rt.googleusercontent.com/slidesz/picture-one";
const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

function withDirectory(run: (directory: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "picture-cache-"));
    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test(
  "an online answer is stored and replayed offline without a network call",
  withDirectory(async (directory) => {
    let networkCalls = 0;
    const network: typeof fetch = async () => {
      networkCalls += 1;
      return new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } });
    };
    const online = await cachingPictureFetch({ directory, mode: "online", fetch: network })(ADDRESS);
    assert.deepEqual(new Uint8Array(await online.arrayBuffer()), BYTES);
    const offline = await cachingPictureFetch({ directory, mode: "offline", fetch: network })(ADDRESS);
    assert.equal(offline.status, 200);
    assert.equal(offline.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await offline.arrayBuffer()), BYTES);
    assert.equal(networkCalls, 1, "the offline read came from disk");
  }),
);

test(
  "a failed online answer is passed through and never stored",
  withDirectory(async (directory) => {
    const network: typeof fetch = async () => new Response("expired", { status: 403 });
    const answer = await cachingPictureFetch({ directory, mode: "online", fetch: network })(ADDRESS);
    assert.equal(answer.status, 403);
    assert.deepEqual(readdirSync(directory), []);
  }),
);

test(
  "an offline miss answers 404 and never reaches the network",
  withDirectory(async (directory) => {
    const network: typeof fetch = async () => assert.fail("offline must not fetch");
    const answer = await cachingPictureFetch({ directory, mode: "offline", fetch: network })(ADDRESS);
    assert.equal(answer.status, 404);
  }),
);
