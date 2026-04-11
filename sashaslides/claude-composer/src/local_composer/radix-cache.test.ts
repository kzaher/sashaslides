import { describe, expect, it } from "vitest";
import { RadixCache, type KVHandle } from "./radix-cache.js";

const h = (label: string, size = 1000): KVHandle => ({ handle: label, sizeBytes: size });

describe("RadixCache", () => {
  it("returns no match for an empty tree", () => {
    const c = new RadixCache();
    expect(c.lookup([1, 2, 3])).toEqual({ matchedTokens: 0, handle: null });
  });

  it("stores and retrieves an exact prefix", () => {
    const c = new RadixCache();
    c.insert([1, 2, 3, 4], h("A"));
    const hit = c.lookup([1, 2, 3, 4]);
    expect(hit.matchedTokens).toBe(4);
    expect(hit.handle).toBe("A");
  });

  it("returns longest matching prefix when the query is longer", () => {
    const c = new RadixCache();
    c.insert([1, 2, 3], h("A"));
    const hit = c.lookup([1, 2, 3, 4, 5]);
    expect(hit.matchedTokens).toBe(3);
    expect(hit.handle).toBe("A");
  });

  it("returns partial match when the query diverges", () => {
    const c = new RadixCache();
    c.insert([1, 2, 3, 4], h("A"));
    const hit = c.lookup([1, 2, 9]);
    // Partial edge match — stops before the KV node, so no handle.
    expect(hit.matchedTokens).toBe(0);
    expect(hit.handle).toBeNull();
  });

  it("splits an existing edge when a shorter prefix is inserted", () => {
    const c = new RadixCache();
    c.insert([1, 2, 3, 4, 5], h("long", 500));
    c.insert([1, 2, 3], h("short", 500));

    const longHit = c.lookup([1, 2, 3, 4, 5]);
    expect(longHit.matchedTokens).toBe(5);
    expect(longHit.handle).toBe("long");

    const shortHit = c.lookup([1, 2, 3]);
    expect(shortHit.matchedTokens).toBe(3);
    expect(shortHit.handle).toBe("short");
  });

  it("deepest hit wins when multiple ancestors have KV", () => {
    const c = new RadixCache();
    c.insert([1, 2], h("shallow"));
    c.insert([1, 2, 3, 4], h("deep"));
    const hit = c.lookup([1, 2, 3, 4, 5]);
    expect(hit.handle).toBe("deep");
    expect(hit.matchedTokens).toBe(4);
  });

  it("evicts entries past their TTL", () => {
    let t = 0;
    const c = new RadixCache({ ttlMs: 1000, now: () => t });
    t = 100;
    c.insert([1, 2, 3], h("A"));
    t = 500;
    expect(c.lookup([1, 2, 3]).handle).toBe("A");
    t = 2000;
    expect(c.lookup([1, 2, 3]).handle).toBeNull();
  });

  it("evicts LRU entries when over budget", () => {
    let t = 0;
    const c = new RadixCache({ maxBytes: 2000, now: () => t });
    t = 1;
    c.insert([1], h("A", 1000));
    t = 2;
    c.insert([2], h("B", 1000));
    t = 3;
    // Touch A so B becomes LRU.
    c.lookup([1]);
    t = 4;
    c.insert([3], h("C", 1000));

    expect(c.lookup([1]).handle).toBe("A");
    expect(c.lookup([3]).handle).toBe("C");
    expect(c.lookup([2]).handle).toBeNull(); // evicted
  });

  it("tracks total byte size after inserts and eviction", () => {
    const c = new RadixCache({ maxBytes: 10_000 });
    c.insert([1, 2], h("A", 3000));
    c.insert([3, 4], h("B", 4000));
    expect(c.byteSize()).toBe(7000);
  });

  it("clear() resets state", () => {
    const c = new RadixCache();
    c.insert([1, 2, 3], h("A"));
    c.clear();
    expect(c.lookup([1, 2, 3]).handle).toBeNull();
    expect(c.byteSize()).toBe(0);
  });
});
