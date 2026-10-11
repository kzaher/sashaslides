import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, utf8Bytes } from "./sha256.ts";

test("sha256Hex matches the published FIPS 180-4 vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("it agrees with node's own implementation across the block boundaries that break hand-rolled padding", () => {
  // 55/56/57 and 63/64/65 are where the length field moves into a new block.
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1000]) {
    const input = "k".repeat(length);
    assert.equal(sha256Hex(input), createHash("sha256").update(input, "utf-8").digest("hex"), `length ${length}`);
  }
});

test("it agrees with node on multi-byte input, so the UTF-8 encoder is right too", () => {
  for (const input of ["£1,284,300", "été", "日本語のスライド", "\u{1f600} emoji"]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input, "utf-8").digest("hex"), input);
  }
});

test("a lone surrogate encodes as U+FFFD rather than throwing or emitting junk", () => {
  assert.deepEqual([...utf8Bytes("\ud800")], [0xef, 0xbf, 0xbd]);
});
