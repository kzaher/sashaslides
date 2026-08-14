// 3-way directory sync engine (the heart of nanobox).
//
// Three snapshots per run:
//   base   = the common state at the END of the previous sync (persisted between runs)
//   local  = current state of the picked local directory (File System Access)
//   remote = current state of the corresponding path inside the VM
//
// Comparing each side against `base` (not against each other) is what lets us tell "added on one
// side" apart from "deleted on the other" — the classic problem a naive 2-way diff gets wrong and
// silently resurrects deleted files. computeSync() is pure: snapshots in, a plan + conflicts +
// nextBase out. applySync() executes the plan against the two stores.
//
// Conflict policies: "manual" (default — report, touch nothing), "prefer-local", "prefer-remote",
// "keep-both" (local keeps the original path on both sides; the remote variant is copied to a
// "<path>.conflict-remote" sibling on both sides).

import { normPath } from "./util.js";

export function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "dir") return true;
  return a.hash === b.hash; // content only — mtime deliberately ignored
}

// State of one side relative to base.
export function classify(base, cur) {
  if (!base && !cur) return "absent";
  if (!base && cur) return "added";
  if (base && !cur) return "deleted";
  return sameEntry(base, cur) ? "unchanged" : "modified";
}

const CHANGED = new Set(["added", "modified"]);
const QUIET = new Set(["unchanged", "absent"]);

const copy = (fromSide, toSide, fromPath, toPath = fromPath) =>
  ({ type: "copy", from: { side: fromSide, path: normPath(fromPath) }, to: { side: toSide, path: normPath(toPath) } });
const del = (side, path) => ({ type: "del", side, path: normPath(path) });

export function computeSync(base, local, remote, opts = {}) {
  const policy = opts.conflict || "manual";
  const actions = [];
  const conflicts = [];
  const nextBase = new Map(base);

  const keys = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  for (const p of keys) {
    const b = base.get(p), l = local.get(p), r = remote.get(p);
    const ls = classify(b, l), rs = classify(b, r);

    // 1. Neither side diverged from base.
    if (QUIET.has(ls) && QUIET.has(rs)) {
      if (l) nextBase.set(p, l); else nextBase.delete(p);
      continue;
    }
    // 2. Only local diverged.
    if (QUIET.has(rs)) {
      if (ls === "deleted") { actions.push(del("remote", p)); nextBase.delete(p); }
      else { actions.push(copy("local", "remote", p)); nextBase.set(p, l); }
      continue;
    }
    // 3. Only remote diverged.
    if (QUIET.has(ls)) {
      if (rs === "deleted") { actions.push(del("local", p)); nextBase.delete(p); }
      else { actions.push(copy("remote", "local", p)); nextBase.set(p, r); }
      continue;
    }
    // 4. Both sides diverged.
    if (ls === "deleted" && rs === "deleted") { nextBase.delete(p); continue; }
    if (CHANGED.has(ls) && CHANGED.has(rs) && sameEntry(l, r)) {
      nextBase.set(p, l); // converged to the same content independently
      continue;
    }
    // 5. Genuine conflict.
    resolveConflict({ p, l, r, policy, actions, conflicts, nextBase, base });
  }

  return { actions: sortActions(actions), conflicts, nextBase };
}

function resolveConflict({ p, l, r, policy, actions, conflicts, nextBase, base }) {
  if (policy === "manual") {
    conflicts.push({ path: p, local: l || null, remote: r || null });
    // leave nextBase at its previous value so the conflict re-surfaces until resolved
    return;
  }
  if (policy === "prefer-local") {
    if (l) { actions.push(copy("local", "remote", p)); nextBase.set(p, l); }
    else { actions.push(del("remote", p)); nextBase.delete(p); }
    return;
  }
  if (policy === "prefer-remote") {
    if (r) { actions.push(copy("remote", "local", p)); nextBase.set(p, r); }
    else { actions.push(del("local", p)); nextBase.delete(p); }
    return;
  }
  if (policy === "keep-both") {
    const alt = p + ".conflict-remote";
    // Read the remote variant into `alt` on BOTH sides FIRST — before the push below overwrites
    // remote:p. applySync reads source bytes live, so ordering matters (read-after-write hazard).
    if (r) {
      actions.push(copy("remote", "local", p, alt));
      actions.push(copy("remote", "remote", p, alt));
      nextBase.set(alt, r);
    }
    if (l) { actions.push(copy("local", "remote", p)); nextBase.set(p, l); }
    else if (r) { actions.push(copy("remote", "local", p)); nextBase.set(p, r); }
    return;
  }
  throw new Error("unknown conflict policy: " + policy);
}

// Copies first (parents before children so dirs exist), dirs before files at equal depth;
// deletes last, children before parents.
export function sortActions(actions) {
  const depth = (p) => (p === "" ? 0 : p.split("/").length);
  const copies = actions.filter((a) => a.type === "copy").sort((a, b) => depth(a.to.path) - depth(b.to.path));
  const dels = actions.filter((a) => a.type === "del").sort((a, b) => depth(b.path) - depth(a.path));
  return [...copies, ...dels];
}

// Execute a plan. ctx = { local, remote, localSnap, remoteSnap }.
export async function applySync(result, ctx) {
  const stores = { local: ctx.local, remote: ctx.remote };
  const snaps = { local: ctx.localSnap, remote: ctx.remoteSnap };
  for (const a of result.actions) {
    if (a.type === "del") { await stores[a.side].remove(a.path); continue; }
    const src = stores[a.from.side], dst = stores[a.to.side];
    const entry = snaps[a.from.side].get(a.from.path);
    if (entry && entry.type === "dir") {
      await dst.mkdir(a.to.path);
    } else {
      const data = await src.read(a.from.path);
      await dst.write(a.to.path, data, entry ? entry.mtime : undefined);
    }
  }
  return result;
}

// Convenience: snapshot both stores, compute, apply, return everything (incl. nextBase to persist).
export async function runSync(localStore, remoteStore, base = new Map(), opts = {}) {
  const localSnap = await localStore.snapshot();
  const remoteSnap = await remoteStore.snapshot();
  const result = computeSync(base, localSnap, remoteSnap, opts);
  await applySync(result, { local: localStore, remote: remoteStore, localSnap, remoteSnap });
  return { ...result, localSnap, remoteSnap };
}
