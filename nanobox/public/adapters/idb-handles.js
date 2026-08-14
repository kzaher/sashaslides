// Persist File System Access directory handles across sessions, keyed by handleKey.
//
// This is what makes "pick home once, remounts recreate themselves" possible: the mount table
// (mounts.json, in home) stores handleKeys; the actual FileSystemDirectoryHandle objects live here
// in IndexedDB. Handles ARE structured-cloneable, so they survive in IDB — but the permission grant
// does NOT persist silently; on a new session we must re-request it (a user gesture). resolvableKeys
// reports which handles are present AND already granted so planRemount can split ready vs re-pick.

const DB_NAME = "nanobox";
const STORE = "handles";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function putHandle(key, handle) {
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.put(handle, key));
}

export async function getHandle(key) {
  const db = await openDb();
  return (await tx(db, "readonly", (s) => s.get(key))) || null;
}

export async function deleteHandle(key) {
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.delete(key));
}

export async function allHandleKeys() {
  const db = await openDb();
  return (await tx(db, "readonly", (s) => s.getAllKeys())) || [];
}

// Prompt (if needed) for read/write permission. Must be called from a user gesture the first time.
export async function ensurePermission(handle, readWrite = true) {
  const opts = { mode: readWrite ? "readwrite" : "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

// Which of `keys` are present in IDB AND already granted (no prompt) — feed to mounts.planRemount.
export async function resolvableKeys(keys) {
  const out = new Set();
  for (const k of keys) {
    const h = await getHandle(k);
    if (h && (await h.queryPermission({ mode: "readwrite" })) === "granted") out.add(k);
  }
  return out;
}
