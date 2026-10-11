import assert from "node:assert/strict";
import test from "node:test";
import type { ConversionResult } from "./converter-contract.ts";
import {
  CONVERSION_CACHE_LIMIT,
  CONVERSION_ENTRY_MAX_CHARS,
  cachedConversion,
  conversionKeyOf,
  rememberConversion,
  type ConversionCacheInput,
} from "./conversion-cache.ts";
import { RENDER_CACHE_LIMIT, cachedRender, rememberRender, renderKeyOf } from "./render-cache.ts";

/** A `Storage` that behaves like the real one, including a quota that throws. */
function fakeStore(limit = Number.POSITIVE_INFINITY): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (at: number) => [...map.keys()][at] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (!map.has(key) && map.size >= limit) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage;
}

const INPUT: ConversionCacheInput = {
  build: "b1",
  html: "<html><body>Q3</body></html>",
  presentationId: "deck_1",
  pageObjectId: "sashaprev_1_p_1",
  objectIdPrefix: "p_1_1",
};

const RESULT: ConversionResult = {
  requests: [{ createShape: { objectId: "p_1_1_a" } }, { insertText: { objectId: "p_1_1_a", text: "Q3" } }],
  unsupported: [{ feature: "filter", note: "blur is dropped", region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }],
};

test("the key is a function of the HTML, the ids and the build -- and of nothing else", () => {
  assert.equal(conversionKeyOf(INPUT), conversionKeyOf({ ...INPUT }));
  assert.notEqual(conversionKeyOf(INPUT), conversionKeyOf({ ...INPUT, html: "<html><body>Q4</body></html>" }), "a revision misses");
  assert.notEqual(conversionKeyOf(INPUT), conversionKeyOf({ ...INPUT, build: "b2" }), "a new converter misses");
  assert.notEqual(conversionKeyOf(INPUT), conversionKeyOf({ ...INPUT, objectIdPrefix: "p_1_2" }), "another candidate misses");
});

test("a remembered conversion comes back intact", () => {
  const store = fakeStore();
  const key = conversionKeyOf(INPUT);
  assert.equal(cachedConversion(key, store), null, "nothing yet");
  rememberConversion(key, RESULT, store);
  assert.deepEqual(cachedConversion(key, store), RESULT);
});

test("ANYTHING NOT SHAPED LIKE A CONVERSION IS A MISS, never handed to the picker", () => {
  const store = fakeStore();
  const key = conversionKeyOf(INPUT);
  for (const junk of ["{ not json", "null", "[]", '{"requests":[1],"unsupported":[]}', '{"requests":[],"unsupported":[{"feature":"x"}]}']) {
    store.setItem(key, junk);
    assert.equal(cachedConversion(key, store), null, junk);
  }
});

test("a conversion too big to be worth the quota is not kept", () => {
  const store = fakeStore();
  const key = conversionKeyOf(INPUT);
  const huge: ConversionResult = {
    requests: [{ createImage: { url: `data:image/png;base64,${"A".repeat(CONVERSION_ENTRY_MAX_CHARS)}` } }],
    unsupported: [],
  };
  rememberConversion(key, huge, store);
  assert.equal(cachedConversion(key, store), null);
});

test("the shelf is bounded, the newest survives, and the PICTURES ARE LEFT ALONE", () => {
  const store = fakeStore();
  const picture = renderKeyOf([{ kept: true }]);
  rememberRender(picture, "data:image/png;base64,iVBORw0KGgo=", store);
  for (let at = 0; at < CONVERSION_CACHE_LIMIT + 5; at += 1) {
    rememberConversion(conversionKeyOf({ ...INPUT, html: `<p>${String(at)}</p>` }), RESULT, store);
  }
  let ours = 0;
  for (let at = 0; at < store.length; at += 1) {
    if ((store.key(at) ?? "").startsWith("sashaSlides.conversion.")) ours += 1;
  }
  assert.ok(ours <= CONVERSION_CACHE_LIMIT, `kept ${String(ours)}`);
  assert.deepEqual(cachedConversion(conversionKeyOf({ ...INPUT, html: `<p>${String(CONVERSION_CACHE_LIMIT + 4)}</p>` }), store), RESULT);
  assert.notEqual(cachedRender(picture, store), null, "evicting conversions never touches the render cache");
  assert.ok(RENDER_CACHE_LIMIT > 0);
});

test("A FULL OR BROKEN STORE IS NOT A FAILED CONVERSION: it degrades to no cache", () => {
  const key = conversionKeyOf(INPUT);
  const full = fakeStore(0);
  assert.doesNotThrow(() => rememberConversion(key, RESULT, full));
  assert.equal(cachedConversion(key, full), null);

  // Deliberate test-only widening: every member of Storage is present and throws, which is the point.
  const hostile = {
    get length(): number {
      throw new Error("blocked");
    },
    key: () => { throw new Error("blocked"); },
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
    clear: () => { throw new Error("blocked"); },
  } as unknown as Storage;
  assert.doesNotThrow(() => rememberConversion(key, RESULT, hostile));
  assert.equal(cachedConversion(key, hostile), null);
});
