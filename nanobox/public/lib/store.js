// FileStore: the abstract filesystem the sync engine drives. Every backend (in-memory for tests,
// File System Access for the picked local dir, the CheerpX VM over tar) implements this same shape,
// so the unit-tested engine runs unchanged against real backends.
//
//   snapshot(): Promise<Map<path, Entry>>   // path = normalized relative, "" excluded
//        Entry = { type:"file"|"dir", hash?, size?, mtime? }   (hash/size/mtime only for files)
//   read(path):  Promise<Uint8Array>
//   write(path, bytes, mtime?): Promise<void>   // creates parent dirs
//   mkdir(path): Promise<void>
//   remove(path): Promise<void>                 // recursive for dirs
//
// Change detection compares Entry.hash only (see sync.sameEntry), so backends that cannot preserve
// mtime (File System Access can't) still sync correctly.

import { toBytes, normPath, parents } from "./util.js";
import { hashBytes } from "./hash.js";

export class MemStore {
  constructor() {
    this.files = new Map();  // path -> Uint8Array
    this.dirs = new Set();   // explicit dir paths
    this.mtimes = new Map(); // path -> number
  }

  // Build from a plain object: { "a.txt": "hi", "d/b.bin": Uint8Array, "emptydir/": null }
  static from(obj, mtime = 1000) {
    const s = new MemStore();
    for (const [k, v] of Object.entries(obj)) {
      if (k.endsWith("/") || v === null) s._mkdir(k);
      else s._put(k, toBytes(v), mtime);
    }
    return s;
  }

  _mkdir(path) {
    path = normPath(path);
    if (!path) return;
    this.dirs.add(path);
    for (const d of parents(path)) this.dirs.add(d);
  }

  _put(path, data, mtime = 1000) {
    path = normPath(path);
    if (!path) throw new Error("cannot write root");
    for (const d of parents(path)) this.dirs.add(d);
    this.files.set(path, data);
    this.mtimes.set(path, mtime);
  }

  async snapshot() {
    const m = new Map();
    for (const d of this.dirs) m.set(d, { type: "dir" });
    for (const [p, data] of this.files) {
      m.set(p, { type: "file", hash: hashBytes(data), size: data.length, mtime: this.mtimes.get(p) });
      for (const d of parents(p)) if (!m.has(d)) m.set(d, { type: "dir" });
    }
    m.delete("");
    return m;
  }

  async read(path) {
    path = normPath(path);
    const d = this.files.get(path);
    if (!d) throw new Error("ENOENT: " + path);
    return d;
  }

  async write(path, data, mtime = 1000) {
    this._put(path, toBytes(data), mtime);
  }

  async mkdir(path) {
    this._mkdir(path);
  }

  async remove(path) {
    path = normPath(path);
    if (!path) return;
    this.files.delete(path);
    this.mtimes.delete(path);
    this.dirs.delete(path);
    const prefix = path + "/";
    for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) { this.files.delete(f); this.mtimes.delete(f); }
    for (const d of [...this.dirs]) if (d.startsWith(prefix)) this.dirs.delete(d);
  }

  // Test convenience: current file contents as { path: "utf8" }.
  dump() {
    const out = {};
    for (const [p, data] of [...this.files].sort()) out[p] = new TextDecoder().decode(data);
    return out;
  }
}
