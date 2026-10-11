import assert from "node:assert/strict";
import test from "node:test";
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

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("the key is the REQUESTS, so the same drawing is the same picture", () => {
  const a = renderKeyOf([{ createShape: { objectId: "s1" } }]);
  const b = renderKeyOf([{ createShape: { objectId: "s1" } }]);
  assert.equal(a, b);
});

test("A REVISED SLIDE MISSES, with nothing having to remember to invalidate it", () => {
  const before = renderKeyOf([{ insertText: { text: "Q3" } }]);
  const after = renderKeyOf([{ insertText: { text: "Q4" } }]);
  assert.notEqual(before, after, "different requests, different picture, different key");
});

test("a remembered picture comes back", () => {
  const store = fakeStore();
  const key = renderKeyOf([{ createShape: {} }]);
  assert.equal(cachedRender(key, store), null, "nothing yet");
  rememberRender(key, PNG, store);
  assert.equal(cachedRender(key, store), PNG);
});

test("ANYTHING THAT IS NOT A PICTURE IS A MISS, never rendered as one", () => {
  const store = fakeStore();
  store.setItem("sashaSlides.render.x", JSON.stringify({ dataUri: "javascript:alert(1)" }));
  assert.equal(cachedRender("sashaSlides.render.x", store), null, "only data:image/ is a picture");
  store.setItem("sashaSlides.render.y", "{ not json");
  assert.equal(cachedRender("sashaSlides.render.y", store), null);
});

test("the shelf is bounded: the oldest go first", () => {
  const store = fakeStore();
  for (let at = 0; at < RENDER_CACHE_LIMIT + 5; at += 1) {
    rememberRender(renderKeyOf([{ n: at }]), PNG, store);
  }
  let ours = 0;
  for (let at = 0; at < store.length; at += 1) {
    if ((store.key(at) ?? "").startsWith("sashaSlides.render.")) ours += 1;
  }
  assert.ok(ours <= RENDER_CACHE_LIMIT, `kept ${String(ours)}, limit ${String(RENDER_CACHE_LIMIT)}`);
  // The newest is still there: eviction takes the oldest, not whatever was just written.
  assert.equal(cachedRender(renderKeyOf([{ n: RENDER_CACHE_LIMIT + 4 }]), store), PNG);
});

test("A FULL OR BROKEN STORE IS NOT A FAILED RENDER: it degrades to no cache", () => {
  const full = fakeStore(0);
  const key = renderKeyOf([{ a: 1 }]);
  assert.doesNotThrow(() => rememberRender(key, PNG, full));
  assert.equal(cachedRender(key, full), null, "a miss, not a throw");

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
  assert.doesNotThrow(() => rememberRender(key, PNG, hostile));
  assert.equal(cachedRender(key, hostile), null);
});
