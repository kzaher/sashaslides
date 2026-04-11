import { describe, expect, it } from "vitest";
import { ImageCache, type ImageEmbedding } from "./image-cache.js";

const emb = (label: string, size = 1000): ImageEmbedding => ({ handle: label, sizeBytes: size });

describe("ImageCache", () => {
  it("stores and retrieves embeddings by sha256", () => {
    const c = new ImageCache();
    c.put("abc", emb("e1"));
    expect(c.get("abc")?.handle).toBe("e1");
    expect(c.has("abc")).toBe(true);
  });

  it("returns null for unknown keys", () => {
    const c = new ImageCache();
    expect(c.get("nope")).toBeNull();
  });

  it("overwrites existing entries", () => {
    const c = new ImageCache();
    c.put("k", emb("old", 100));
    c.put("k", emb("new", 300));
    expect(c.get("k")?.handle).toBe("new");
    expect(c.byteSize()).toBe(300);
  });

  it("evicts entries past their TTL", () => {
    let t = 0;
    const c = new ImageCache({ ttlMs: 1000, now: () => t });
    t = 100;
    c.put("k", emb("e"));
    t = 2000;
    expect(c.get("k")).toBeNull();
  });

  it("evicts LRU when over maxBytes", () => {
    let t = 0;
    const c = new ImageCache({ maxBytes: 1500, now: () => t });
    t = 1;
    c.put("a", emb("A", 1000));
    t = 2;
    c.put("b", emb("B", 1000));
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
  });

  it("clear() resets state", () => {
    const c = new ImageCache();
    c.put("a", emb("A"));
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.byteSize()).toBe(0);
  });
});
