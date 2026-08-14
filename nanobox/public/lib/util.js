// Tiny shared utilities. Pure ESM — runs identically in Node and the browser.
// No Node-only APIs here so the exact same code the tests exercise is the code the browser runs.

const _enc = new TextEncoder();
const _dec = new TextDecoder();

export function toBytes(x) {
  if (x == null) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (typeof x === "string") return _enc.encode(x);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError("toBytes: unsupported " + typeof x);
}

export function toText(bytes) {
  return _dec.decode(toBytes(bytes));
}

export function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Normalize a POSIX-ish relative path: strip leading/trailing/duplicate slashes,
// drop ".", and REJECT ".." (no traversal). Returns "" for the root.
export function normPath(p) {
  const parts = [];
  for (const seg of String(p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error("path traversal rejected: " + p);
    parts.push(seg);
  }
  return parts.join("/");
}

// Absolute POSIX path normalization (for VM mount points): keeps a single leading "/".
export function normAbs(p) {
  const rel = normPath(p);
  return "/" + rel;
}

// Ancestor directories of a path, shallowest first. parents("a/b/c") -> ["a","a/b"].
export function parents(path) {
  const parts = normPath(path).split("/").filter(Boolean);
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

// Is `child` equal to or nested under `dir` (both normalized abs paths)?
export function isUnder(child, dir) {
  if (dir === "/") return true;
  return child === dir || child.startsWith(dir + "/");
}
