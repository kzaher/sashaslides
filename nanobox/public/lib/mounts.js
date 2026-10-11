// Mount registry — the persistent map of "which local directory backs which VM path".
//
// The FIRST directory the user picks becomes the VM's HOME (default vmPath "/root"). Inside it we
// keep `.nanobox/mounts.json` — so the mount table travels with the user's own files, not with the
// disposable VM overlay or browser storage. On the next boot the user re-picks home, we read this
// file, and recreate every other mount (re-permissioning persisted directory handles; re-prompting
// for any that are gone). This module is the PURE logic of that table: parse/serialize, validate,
// add/remove, and plan a remount given which handles are currently resolvable. No browser, no I/O.

import { normAbs, isUnder } from "./util.js";

export const REGISTRY_PATH = ".nanobox/mounts.json";
export const DEFAULT_HOME_VMPATH = "/root";
const VERSION = 1;

export function emptyRegistry(homeVmPath = DEFAULT_HOME_VMPATH) {
  return { version: VERSION, home: { vmPath: normAbs(homeVmPath), handleKey: "home" }, mounts: [] };
}

export function serializeRegistry(reg) {
  return JSON.stringify(
    { version: VERSION, home: reg.home, mounts: reg.mounts },
    null, 2
  );
}

export function parseRegistry(json) {
  let obj;
  try { obj = typeof json === "string" ? JSON.parse(json) : json; }
  catch { throw new Error("mounts.json: invalid JSON"); }
  if (!obj || typeof obj !== "object") throw new Error("mounts.json: not an object");
  const home = obj.home && obj.home.vmPath
    ? { vmPath: normAbs(obj.home.vmPath), handleKey: obj.home.handleKey || "home" }
    : emptyRegistry().home;
  const mounts = Array.isArray(obj.mounts) ? obj.mounts.map(normalizeMount) : [];
  const reg = { version: VERSION, home, mounts: [] };
  for (const m of mounts) addMount(reg, m); // re-validate on load; drops nothing silently — throws
  return reg;
}

function normalizeMount(m) {
  if (!m || !m.vmPath) throw new Error("mount entry missing vmPath");
  return {
    id: m.id || slug(m.vmPath),
    vmPath: normAbs(m.vmPath),
    label: m.label || baseName(m.vmPath),
    handleKey: m.handleKey || ("mount:" + (m.id || slug(m.vmPath))),
  };
}

// Add a mount, enforcing the invariants that keep sync unambiguous.
export function addMount(reg, mount) {
  const m = normalizeMount(mount);
  if (m.vmPath === "/") throw new Error("cannot mount at /");
  if (m.vmPath === reg.home.vmPath) throw new Error("mount collides with home: " + m.vmPath);
  for (const ex of reg.mounts) {
    if (ex.vmPath === m.vmPath) throw new Error("duplicate mount vmPath: " + m.vmPath);
    if (isUnder(m.vmPath, ex.vmPath) || isUnder(ex.vmPath, m.vmPath))
      throw new Error(`nested mounts not allowed: ${m.vmPath} vs ${ex.vmPath}`);
    if (ex.id === m.id) throw new Error("duplicate mount id: " + m.id);
  }
  // A mount nested under home is allowed (it's just a subtree of home) — but then it would be
  // synced twice. Forbid it so each byte has exactly one owning store.
  if (isUnder(m.vmPath, reg.home.vmPath))
    throw new Error(`mount ${m.vmPath} is inside home ${reg.home.vmPath}; sync home instead`);
  reg.mounts.push(m);
  return m;
}

export function removeMount(reg, id) {
  const before = reg.mounts.length;
  reg.mounts = reg.mounts.filter((m) => m.id !== id && m.vmPath !== id);
  return reg.mounts.length < before;
}

// All handle keys the registry references (home + every mount) — what the browser must resolve.
export function requiredHandleKeys(reg) {
  return [reg.home.handleKey, ...reg.mounts.map((m) => m.handleKey)];
}

// Given the set of handleKeys currently resolvable (permission granted, handle present in IDB),
// split the mounts into those we can recreate now vs. those needing a fresh user pick.
// `availableKeys` is an array or Set of handleKey strings.
export function planRemount(reg, availableKeys) {
  const have = availableKeys instanceof Set ? availableKeys : new Set(availableKeys);
  const ready = [];
  const needsRepick = [];
  const homeReady = have.has(reg.home.handleKey);
  for (const m of reg.mounts) (have.has(m.handleKey) ? ready : needsRepick).push(m);
  return { homeReady, ready, needsRepick };
}

function baseName(p) {
  const parts = normAbs(p).split("/").filter(Boolean);
  return parts[parts.length - 1] || "root";
}
function slug(p) {
  return normAbs(p).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "root";
}
