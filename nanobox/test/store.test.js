import { test } from "node:test";
import assert from "node:assert/strict";
import { MemStore } from "../public/lib/store.js";
import { normPath, parents, isUnder } from "../public/lib/util.js";

test("normPath strips slashes/dots and rejects traversal", () => {
  assert.equal(normPath("/a/b/"), "a/b");
  assert.equal(normPath("a//./b"), "a/b");
  assert.equal(normPath(""), "");
  assert.throws(() => normPath("a/../b"), /traversal/);
});

test("parents lists ancestors shallowest-first", () => {
  assert.deepEqual(parents("a/b/c"), ["a", "a/b"]);
  assert.deepEqual(parents("a"), []);
  assert.deepEqual(parents(""), []);
});

test("isUnder handles equality, nesting, and root", () => {
  assert.ok(isUnder("/a/b", "/a"));
  assert.ok(isUnder("/a", "/a"));
  assert.ok(!isUnder("/ab", "/a"));   // prefix but not a path segment
  assert.ok(isUnder("/anything", "/"));
});

test("write creates parent dirs implicitly in snapshot", async () => {
  const s = new MemStore();
  await s.write("a/b/c.txt", "hi");
  const snap = await s.snapshot();
  assert.equal(snap.get("a").type, "dir");
  assert.equal(snap.get("a/b").type, "dir");
  assert.equal(snap.get("a/b/c.txt").type, "file");
});

test("snapshot file entries carry hash + size; identical content => identical hash", async () => {
  const s = MemStore.from({ "x": "same", "y": "same", "z": "different" });
  const snap = await s.snapshot();
  assert.equal(snap.get("x").hash, snap.get("y").hash);
  assert.notEqual(snap.get("x").hash, snap.get("z").hash);
  assert.equal(snap.get("x").size, 4);
});

test("read throws on missing path", async () => {
  const s = new MemStore();
  await assert.rejects(() => s.read("nope"), /ENOENT/);
});

test("remove is recursive for directories", async () => {
  const s = MemStore.from({ "d/a.txt": "1", "d/sub/b.txt": "2", "keep.txt": "3" });
  await s.remove("d");
  const snap = await s.snapshot();
  assert.ok(!snap.has("d"));
  assert.ok(!snap.has("d/a.txt"));
  assert.ok(!snap.has("d/sub/b.txt"));
  assert.ok(snap.has("keep.txt"));
});

test("MemStore.from can create an explicit empty directory", async () => {
  const s = MemStore.from({ "emptydir/": null });
  const snap = await s.snapshot();
  assert.equal(snap.get("emptydir").type, "dir");
});

test("root path is never present in a snapshot", async () => {
  const s = MemStore.from({ "a.txt": "hi" });
  const snap = await s.snapshot();
  assert.ok(!snap.has(""));
});
