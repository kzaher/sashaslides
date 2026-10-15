// Engine ids must double as Google Slides object ids (ids.ts header), whatever the session prefix
// and however large the counter grows -- including the random source's extremes, which is where an
// off-by-one in the alphabet index would show. Minting must also be a pure function of the seed, so
// a replayed event log reproduces the same ids.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isObjectId, mintId, newSessionPrefix, parseAssetId, parseSlideId, type IdSeed, type ObjectIdKind } from "./ids.ts";

describe("object ids", () => {
  const kinds: readonly ObjectIdKind[] = [
    "slide",
    "element",
    "layout",
    "thread",
    "message",
    "transitionScript",
    "tableRow",
    "tableColumn",
    "list",
    "command",
    "discussionRequest",
    "upload",
    "notice",
    "transitionRun",
    "runner",
  ];

  for (const randomValue of [0, 0.5, 0.999999999]) {
    it(`every kind is a valid Slides objectId when random() returns ${randomValue}`, () => {
      const sessionPrefix = newSessionPrefix(() => randomValue);
      for (const kind of kinds) {
        for (const counter of [0, 35, 36, Number.MAX_SAFE_INTEGER]) {
          const minted = mintId({ seed: { sessionPrefix, counter }, kind });
          assert.ok(isObjectId(minted.id), `${kind}: ${minted.id}`);
        }
      }
    });
  }

  it("minting is a pure function of the seed and advances the counter", () => {
    const seed: IdSeed = { sessionPrefix: "Qx81mPa0", counter: 41 };
    const first = mintId({ seed, kind: "element" });
    const again = mintId({ seed, kind: "element" });
    assert.equal(first.id, "el_Qx81mPa015");
    assert.equal(again.id, first.id);
    assert.deepEqual(first.seed, { sessionPrefix: "Qx81mPa0", counter: 42 });
    assert.notEqual(mintId({ seed: first.seed, kind: "element" }).id, first.id);
  });

  it("parsing rejects what Slides would reject", () => {
    assert.equal(parseSlideId("ab"), null);
    assert.equal(parseSlideId("-starts-with-dash"), null);
    assert.equal(parseSlideId("has space in it"), null);
    assert.equal(parseSlideId("x".repeat(51)), null);
    assert.equal(parseSlideId("sl_valid:1"), "sl_valid:1");
  });

  // An asset id is a SHA-256 content address: 64 lowercase hexadecimal characters, which an object
  // id could never be (too long). The rows vary only the candidate.
  for (const row of [
    { label: "a SHA-256 in lowercase hexadecimal", candidate: "0123456789abcdef".repeat(4), valid: true },
    { label: "control: upper-case hexadecimal", candidate: "0123456789ABCDEF".repeat(4), valid: false },
    { label: "control: one character short", candidate: "a".repeat(63), valid: false },
    { label: "control: a valid object id", candidate: "asset_photo", valid: false },
    { label: "control: a path", candidate: `${"a".repeat(32)}/${"a".repeat(31)}`, valid: false },
  ] as const) {
    it(`asset ids: ${row.label} is ${row.valid ? "accepted" : "rejected"}`, () => {
      assert.equal(parseAssetId(row.candidate) !== null, row.valid);
    });
  }
});
