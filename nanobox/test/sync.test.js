import { test } from "node:test";
import assert from "node:assert/strict";
import { MemStore } from "../public/lib/store.js";
import { computeSync, runSync, classify, sameEntry } from "../public/lib/sync.js";

const fileHashes = (snap) =>
  [...snap].filter(([, e]) => e.type === "file").map(([k, e]) => [k, e.hash]).sort();

// After a resolving sync, local, remote, and nextBase must agree on every file.
function assertConverged(localSnap, remoteSnap, nextBase) {
  assert.deepEqual(fileHashes(localSnap), fileHashes(remoteSnap), "local vs remote diverge");
  assert.deepEqual(fileHashes(localSnap), fileHashes(nextBase), "nextBase drifts from tree");
}

test("classify / sameEntry basics", () => {
  const a = { type: "file", hash: "h1" }, a2 = { type: "file", hash: "h1" }, b = { type: "file", hash: "h2" };
  assert.ok(sameEntry(a, a2));
  assert.ok(!sameEntry(a, b));
  assert.equal(classify(undefined, a), "added");
  assert.equal(classify(a, undefined), "deleted");
  assert.equal(classify(a, a2), "unchanged");
  assert.equal(classify(a, b), "modified");
  assert.equal(classify(undefined, undefined), "absent");
});

test("initial import: local files push to an empty remote", async () => {
  const local = MemStore.from({ "a.txt": "A", "d/b.txt": "B" });
  const remote = new MemStore();
  const res = await runSync(local, remote);
  assert.equal(res.conflicts.length, 0);
  assert.equal(remote.dump()["a.txt"], "A");
  assert.equal(remote.dump()["d/b.txt"], "B");
  assertConverged(await local.snapshot(), await remote.snapshot(), res.nextBase);
});

test("pull: files created in remote come back to local", async () => {
  const local = new MemStore();
  const remote = MemStore.from({ "server.log": "hi" });
  await runSync(local, remote);
  assert.equal(local.dump()["server.log"], "hi");
});

test("modify on local propagates to remote", async () => {
  const local = MemStore.from({ "f": "v1" });
  const remote = MemStore.from({ "f": "v1" });
  const base = await local.snapshot();
  await local.write("f", "v2");
  const res = await runSync(local, remote, base);
  assert.equal(remote.dump()["f"], "v2");
  assert.equal(res.conflicts.length, 0);
});

test("delete on local removes from remote (no resurrection)", async () => {
  const local = MemStore.from({ "f": "x", "g": "y" });
  const remote = MemStore.from({ "f": "x", "g": "y" });
  const base = await local.snapshot();
  await local.remove("f");
  const res = await runSync(local, remote, base);
  assert.ok(!("f" in remote.dump()));
  assert.equal(remote.dump()["g"], "y");
  // Run again: the deletion must not come back.
  const res2 = await runSync(local, remote, res.nextBase);
  assert.equal(res2.actions.length, 0);
  assert.ok(!("f" in local.dump()) && !("f" in remote.dump()));
});

test("delete on remote removes from local", async () => {
  const local = MemStore.from({ "f": "x" });
  const remote = MemStore.from({ "f": "x" });
  const base = await local.snapshot();
  await remote.remove("f");
  await runSync(local, remote, base);
  assert.ok(!("f" in local.dump()));
});

test("both create the same content independently: converge, zero actions", async () => {
  const local = MemStore.from({ "readme": "same" });
  const remote = MemStore.from({ "readme": "same" });
  const res = await runSync(local, remote); // empty base
  assert.equal(res.actions.length, 0);
  assert.equal(res.conflicts.length, 0);
});

test("conflict (manual): both modified differently => reported, nothing written", async () => {
  const local = MemStore.from({ "f": "base" });
  const remote = MemStore.from({ "f": "base" });
  const base = await local.snapshot();
  await local.write("f", "local-edit");
  await remote.write("f", "remote-edit");
  const res = await runSync(local, remote, base);
  assert.equal(res.actions.length, 0);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].path, "f");
  assert.equal(local.dump()["f"], "local-edit");   // untouched
  assert.equal(remote.dump()["f"], "remote-edit"); // untouched
  // base is left so the conflict re-surfaces next run
  assert.equal(res.nextBase.get("f").hash, base.get("f").hash);
});

test("conflict prefer-local: local wins on both sides", async () => {
  const local = MemStore.from({ "f": "base" });
  const remote = MemStore.from({ "f": "base" });
  const base = await local.snapshot();
  await local.write("f", "L");
  await remote.write("f", "R");
  const res = await runSync(local, remote, base, { conflict: "prefer-local" });
  assert.equal(local.dump()["f"], "L");
  assert.equal(remote.dump()["f"], "L");
  assertConverged(await local.snapshot(), await remote.snapshot(), res.nextBase);
});

test("conflict prefer-remote: remote wins on both sides", async () => {
  const local = MemStore.from({ "f": "base" });
  const remote = MemStore.from({ "f": "base" });
  const base = await local.snapshot();
  await local.write("f", "L");
  await remote.write("f", "R");
  const res = await runSync(local, remote, base, { conflict: "prefer-remote" });
  assert.equal(local.dump()["f"], "R");
  assert.equal(remote.dump()["f"], "R");
  assertConverged(await local.snapshot(), await remote.snapshot(), res.nextBase);
});

test("conflict keep-both: local keeps path, remote variant saved to .conflict-remote on both", async () => {
  const local = MemStore.from({ "f": "base" });
  const remote = MemStore.from({ "f": "base" });
  const base = await local.snapshot();
  await local.write("f", "L");
  await remote.write("f", "R");
  const res = await runSync(local, remote, base, { conflict: "keep-both" });
  assert.equal(local.dump()["f"], "L");
  assert.equal(remote.dump()["f"], "L");
  assert.equal(local.dump()["f.conflict-remote"], "R");
  assert.equal(remote.dump()["f.conflict-remote"], "R");
  assert.equal(res.conflicts.length, 0);
  assertConverged(await local.snapshot(), await remote.snapshot(), res.nextBase);
});

test("edit/delete conflict is reported under manual policy", async () => {
  const local = MemStore.from({ "f": "base" });
  const remote = MemStore.from({ "f": "base" });
  const base = await local.snapshot();
  await local.write("f", "edited");
  await remote.remove("f");
  const res = await runSync(local, remote, base);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.actions.length, 0);
});

test("edit/delete conflict prefer-local restores the edited file remotely", async () => {
  const local = MemStore.from({ "f": "base" });
  const remote = MemStore.from({ "f": "base" });
  const base = await local.snapshot();
  await local.write("f", "edited");
  await remote.remove("f");
  await runSync(local, remote, base, { conflict: "prefer-local" });
  assert.equal(remote.dump()["f"], "edited");
});

test("nested directory trees sync in dependency order", async () => {
  const local = MemStore.from({ "x/y/z/deep.txt": "deep", "x/top.txt": "top" });
  const remote = new MemStore();
  await runSync(local, remote);
  assert.equal(remote.dump()["x/y/z/deep.txt"], "deep");
  assert.equal(remote.dump()["x/top.txt"], "top");
});

test("idempotency: a second sync with the returned base is a no-op", async () => {
  const local = MemStore.from({ "a": "1", "b/c": "2" });
  const remote = new MemStore();
  const first = await runSync(local, remote);
  const second = await runSync(local, remote, first.nextBase);
  assert.equal(second.actions.length, 0);
  assert.equal(second.conflicts.length, 0);
});

test("bidirectional: independent adds on each side merge both ways", async () => {
  const local = MemStore.from({ "onlyLocal": "L" });
  const remote = MemStore.from({ "onlyRemote": "R" });
  const res = await runSync(local, remote);
  assert.equal(remote.dump()["onlyLocal"], "L");
  assert.equal(local.dump()["onlyRemote"], "R");
  assertConverged(await local.snapshot(), await remote.snapshot(), res.nextBase);
});

test("computeSync is pure — it does not mutate the input base map", async () => {
  const local = MemStore.from({ "f": "v" });
  const remote = new MemStore();
  const base = new Map();
  computeSync(base, await local.snapshot(), await remote.snapshot());
  assert.equal(base.size, 0);
});
