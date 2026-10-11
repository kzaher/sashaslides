// FileStore backed by a File System Access API directory handle (the user-picked local folder).
// Browser-only. Implements the exact interface the tested sync engine drives (see lib/store.js).
//
// Perf note (acknowledged): snapshot() hashes every file by reading it fully. For a personal
// project tree that's fine; for huge trees you'd cache hashes by (size,mtime). Left simple on
// purpose — correctness first.

import { normPath, toBytes } from "../lib/util.js";
import { hashBytes } from "../lib/hash.js";

export class FsaStore {
  constructor(rootHandle) { this.root = rootHandle; }

  async _dirHandle(path, create = false) {
    let h = this.root;
    for (const seg of normPath(path).split("/").filter(Boolean)) {
      h = await h.getDirectoryHandle(seg, { create });
    }
    return h;
  }

  async _fileHandle(path, create = false) {
    const parts = normPath(path).split("/").filter(Boolean);
    const name = parts.pop();
    let dir = this.root;
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create });
    return dir.getFileHandle(name, { create });
  }

  async snapshot() {
    const m = new Map();
    const walk = async (handle, base) => {
      for await (const [name, h] of handle.entries()) {
        const path = base ? base + "/" + name : name;
        if (h.kind === "directory") { m.set(path, { type: "dir" }); await walk(h, path); }
        else {
          const file = await h.getFile();
          const data = new Uint8Array(await file.arrayBuffer());
          m.set(path, { type: "file", hash: hashBytes(data), size: data.length, mtime: Math.floor(file.lastModified / 1000) });
        }
      }
    };
    await walk(this.root, "");
    m.delete("");
    return m;
  }

  async read(path) {
    const file = await (await this._fileHandle(path)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path, data) {
    const fh = await this._fileHandle(path, true);
    const w = await fh.createWritable();
    await w.write(toBytes(data));
    await w.close();
  }

  async mkdir(path) { if (normPath(path)) await this._dirHandle(path, true); }

  async remove(path) {
    const parts = normPath(path).split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) return;
    let dir = this.root;
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg);
    await dir.removeEntry(name, { recursive: true });
  }
}
