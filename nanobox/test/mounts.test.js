import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyRegistry, serializeRegistry, parseRegistry, addMount, removeMount,
  requiredHandleKeys, planRemount, REGISTRY_PATH, DEFAULT_HOME_VMPATH,
} from "../public/lib/mounts.js";

test("empty registry defaults home to /root with handleKey 'home'", () => {
  const reg = emptyRegistry();
  assert.equal(reg.home.vmPath, DEFAULT_HOME_VMPATH);
  assert.equal(reg.home.handleKey, "home");
  assert.deepEqual(reg.mounts, []);
  assert.equal(REGISTRY_PATH, ".nanobox/mounts.json");
});

test("addMount normalizes vmPath, derives id/label/handleKey", () => {
  const reg = emptyRegistry();
  const m = addMount(reg, { vmPath: "/mnt/projects/" });
  assert.equal(m.vmPath, "/mnt/projects");
  assert.equal(m.label, "projects");
  assert.equal(m.id, "mnt-projects");
  assert.equal(m.handleKey, "mount:mnt-projects");
});

test("serialize -> parse is a faithful round-trip", () => {
  const reg = emptyRegistry();
  addMount(reg, { vmPath: "/mnt/projects", label: "Projects", handleKey: "mount:p" });
  addMount(reg, { vmPath: "/mnt/data", label: "Data", handleKey: "mount:d" });
  const reg2 = parseRegistry(serializeRegistry(reg));
  assert.equal(reg2.home.vmPath, reg.home.vmPath);
  assert.deepEqual(reg2.mounts.map((m) => m.vmPath), ["/mnt/projects", "/mnt/data"]);
  assert.deepEqual(reg2.mounts.map((m) => m.handleKey), ["mount:p", "mount:d"]);
});

test("rejects mount at /, at home, duplicates, and nested mounts", () => {
  const reg = emptyRegistry();
  assert.throws(() => addMount(reg, { vmPath: "/" }), /cannot mount at \//);
  assert.throws(() => addMount(reg, { vmPath: DEFAULT_HOME_VMPATH }), /collides with home/);
  addMount(reg, { vmPath: "/mnt/a" });
  assert.throws(() => addMount(reg, { vmPath: "/mnt/a" }), /duplicate mount vmPath/);
  assert.throws(() => addMount(reg, { vmPath: "/mnt/a/child" }), /nested mounts/);
  assert.throws(() => addMount(reg, { vmPath: "/mnt" }), /nested mounts/); // parent of existing
});

test("rejects a mount nested inside home (would double-sync)", () => {
  const reg = emptyRegistry("/root");
  assert.throws(() => addMount(reg, { vmPath: "/root/projects" }), /inside home/);
});

test("home can be a custom path and mounts validate against it", () => {
  const reg = emptyRegistry("/home/dev");
  assert.equal(reg.home.vmPath, "/home/dev");
  assert.throws(() => addMount(reg, { vmPath: "/home/dev/x" }), /inside home/);
  const m = addMount(reg, { vmPath: "/work" });
  assert.equal(m.vmPath, "/work");
});

test("removeMount removes by id or by vmPath", () => {
  const reg = emptyRegistry();
  addMount(reg, { vmPath: "/mnt/a", handleKey: "k" });
  assert.ok(removeMount(reg, "mnt-a"));       // by id
  assert.equal(reg.mounts.length, 0);
  addMount(reg, { vmPath: "/mnt/b" });
  assert.ok(removeMount(reg, "/mnt/b"));       // by vmPath
  assert.equal(reg.mounts.length, 0);
  assert.ok(!removeMount(reg, "nope"));
});

test("requiredHandleKeys covers home + every mount", () => {
  const reg = emptyRegistry();
  addMount(reg, { vmPath: "/mnt/a", handleKey: "ka" });
  addMount(reg, { vmPath: "/mnt/b", handleKey: "kb" });
  assert.deepEqual(requiredHandleKeys(reg), ["home", "ka", "kb"]);
});

test("planRemount splits ready vs needs-repick by available handle keys", () => {
  const reg = emptyRegistry();
  addMount(reg, { vmPath: "/mnt/a", handleKey: "ka" });
  addMount(reg, { vmPath: "/mnt/b", handleKey: "kb" });
  addMount(reg, { vmPath: "/mnt/c", handleKey: "kc" });
  const plan = planRemount(reg, ["home", "ka", "kc"]); // kb missing (permission revoked / gone)
  assert.equal(plan.homeReady, true);
  assert.deepEqual(plan.ready.map((m) => m.vmPath), ["/mnt/a", "/mnt/c"]);
  assert.deepEqual(plan.needsRepick.map((m) => m.vmPath), ["/mnt/b"]);
});

test("planRemount flags home not ready when its handle is unavailable", () => {
  const reg = emptyRegistry();
  addMount(reg, { vmPath: "/mnt/a", handleKey: "ka" });
  const plan = planRemount(reg, ["ka"]); // home handle missing
  assert.equal(plan.homeReady, false);
  assert.deepEqual(plan.ready.map((m) => m.vmPath), ["/mnt/a"]);
});

test("parseRegistry re-validates and throws on a corrupt/nested table", () => {
  const bad = JSON.stringify({
    version: 1, home: { vmPath: "/root", handleKey: "home" },
    mounts: [{ vmPath: "/mnt/a" }, { vmPath: "/mnt/a/inside" }],
  });
  assert.throws(() => parseRegistry(bad), /nested mounts/);
  assert.throws(() => parseRegistry("{ not json"), /invalid JSON/);
});
