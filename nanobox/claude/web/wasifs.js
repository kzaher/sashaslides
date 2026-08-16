// nanobox/claude — a read-only in-memory WASI filesystem WITH symbolic links.
//
// container2wasm's browser runtime serves preopened directories to the guest over Bochs' built-in
// virtio-9p device (bochs/wasm.cc). Its WASI shim (@bjorn3/browser_wasi_shim 0.2.x) has no symlink
// support, which rules out serving a real container rootfs through it. This layer sits IN FRONT of
// the shim: it claims one preopen fd (and every fd it hands out) on the wasi import object and
// answers those calls itself; everything else falls through to the shim untouched.
//
//   const tree = NanoboxFs.dir();  NanoboxFs.add(tree, "rootfs/bin/sh", { symlink: "busybox" }) ...
//   const fs = NanoboxFs.attach(wasi.wasiImport, { fd: 6, name: "bundle", root: tree, memory: () => inst.exports.memory });
//
// Works in a classic worker (self.NanoboxFs) and in node (globalThis.NanoboxFs after import).
(function (global) {
  const E = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, LOOP: 32, NAMETOOLONG: 37, NOENT: 44, NOTDIR: 54, NOTSUP: 58, ROFS: 69, SPIPE: 70 };
  const FT = { UNKNOWN: 0, DIR: 3, REG: 4, LNK: 7 };
  const OFLAG = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
  const FIXED_TIME_NS = 1700000000n * 1000000000n; // deterministic timestamps (2023-11-14T22:13:20Z)
  let inoCounter = 1;
  const enc = new TextEncoder(), dec = new TextDecoder();

  function dir() { return { t: "d", e: new Map(), ino: inoCounter++ }; }
  function file(data) { return { t: "f", data, ino: inoCounter++ }; }
  function symlink(target) { return { t: "l", target, ino: inoCounter++ }; }
  // add(root, "a/b/c", {data}|{symlink}|{dir:true}); creates intermediate directories
  function add(root, path, what) {
    const parts = path.split("/").filter((p) => p && p !== ".");
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let n = d.e.get(parts[i]);
      if (!n) { n = dir(); d.e.set(parts[i], n); }
      if (n.t !== "d") throw new Error("not a directory: " + parts.slice(0, i + 1).join("/"));
      d = n;
    }
    if (!parts.length) return root;
    const name = parts[parts.length - 1];
    let node;
    if (what.symlink != null) node = symlink(what.symlink);
    else if (what.dir) { node = d.e.get(name); if (!node || node.t !== "d") { node = dir(); d.e.set(name, node); } return node; }
    else node = file(what.data || new Uint8Array(0));
    if (what.ino) node.ino = what.ino; // hard links share an inode
    if (what.mode != null) node.mode = what.mode;
    d.e.set(name, node);
    return node;
  }
  function remove(root, path) {
    const parts = path.split("/").filter((p) => p && p !== ".");
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) { d = d.e.get(parts[i]); if (!d || d.t !== "d") return false; }
    return d.e.delete(parts[parts.length - 1]);
  }
  function lookup(root, path) { // no symlink following at all; null if missing
    const parts = path.split("/").filter((p) => p && p !== ".");
    let n = root;
    for (const p of parts) { if (n.t !== "d") return null; n = n.e.get(p); if (!n) return null; }
    return n;
  }
  function fileData(node) { // files may hold a thunk to be resolved lazily
    if (typeof node.data === "function") node.data = node.data();
    return node.data;
  }
  function sizeOf(node) { return node.t === "d" ? 4096 : node.t === "l" ? enc.encode(node.target).length : fileData(node).byteLength; }
  function ftype(node) { return node.t === "d" ? FT.DIR : node.t === "l" ? FT.LNK : FT.REG; }

  function attach(wasiImport, cfg) {
    const ROOT = cfg.root, PRE_FD = cfg.fd, NAME = cfg.name;
    const memory = cfg.memory;
    const FIRST_FD = cfg.firstFd || 10000;
    const fds = new Map(); // fd -> { node, pos, name, path } (path: canonical, from the tree root, no symlinks — see resolve)
    let nextFd = FIRST_FD;
    const stats = { opens: 0, reads: 0, readBytes: 0, readdirs: 0, stats: 0, readlinks: 0 };
    const view = () => new DataView(memory().buffer);
    const u8 = () => new Uint8Array(memory().buffer);
    const readPath = (ptr, len) => dec.decode(u8().subarray(ptr, ptr + len));
    const mine = (fd) => fd === PRE_FD || fds.has(fd);
    const nodeOf = (fd) => (fd === PRE_FD ? ROOT : fds.get(fd).node);

    // resolve `path` relative to `base` (a dir node); intermediate symlinks are followed within
    // this tree, the last component only when `follow`. `basePath` is base's canonical path (the
    // names of the real nodes from ROOT down to it); the result carries the canonical path of the
    // resolved node the same way — symlink-free, so `lookup(ROOT, path)` finds the identical node in
    // a tree rebuilt from the same image (that is how open fds survive a checkpoint/restore).
    function resolve(base, path, follow, basePath) {
      let parts = path.split("/").filter((p) => p && p !== ".");
      let stack = [base]; // directory chain; the top is the current node
      let names = basePath ? basePath.slice() : []; // canonical names, parallel to stack (minus base)
      let hops = 0;
      while (parts.length) {
        const n = stack[stack.length - 1];
        if (n.t !== "d") return { err: E.NOTDIR };
        const p = parts.shift();
        if (p === "..") { if (stack.length > 1) { stack.pop(); names.pop(); } continue; }
        const c = n.e.get(p);
        if (!c) return { err: E.NOENT };
        if (c.t === "l" && (parts.length > 0 || follow)) {
          if (++hops > 40) return { err: E.LOOP };
          const tp = c.target.split("/").filter((q) => q && q !== ".");
          if (c.target.startsWith("/")) { stack = [ROOT]; names = []; } // absolute target: from the tree root
          parts = tp.concat(parts);                                       // relative: from the link's directory
          continue;
        }
        stack.push(c); names.push(p);
      }
      return { node: stack[stack.length - 1], path: names };
    }
    const pathOf = (fd) => (fd === PRE_FD ? [] : fds.get(fd).path);
    function writeFilestat(ptr, node) {
      const v = view();
      // WASI has no mode bits; the engine's 9p server (bochs/wasm.cc, NANOBOX_DETERMINISTIC) reads
      // them back out of the dev field when it carries the 0x6e62 ("nb") tag
      const mode = node.mode != null ? node.mode : node.t === "d" ? 0o755 : node.t === "l" ? 0o777 : 0o644;
      v.setBigUint64(ptr, BigInt(0x6e620000 | (mode & 0o7777)), true); // dev
      v.setBigUint64(ptr + 8, BigInt(node.ino), true);  // ino
      v.setUint8(ptr + 16, ftype(node));                // filetype
      v.setBigUint64(ptr + 24, 1n, true);               // nlink
      v.setBigUint64(ptr + 32, BigInt(sizeOf(node)), true);
      v.setBigUint64(ptr + 40, FIXED_TIME_NS, true);
      v.setBigUint64(ptr + 48, FIXED_TIME_NS, true);
      v.setBigUint64(ptr + 56, FIXED_TIME_NS, true);
    }
    const RIGHTS_ALL = 0x1fffffffn;
    function writeFdstat(ptr, node) {
      const v = view();
      v.setUint8(ptr, ftype(node)); v.setUint16(ptr + 2, 0, true);
      v.setBigUint64(ptr + 8, RIGHTS_ALL, true); v.setBigUint64(ptr + 16, RIGHTS_ALL, true);
    }
    // read into iovecs from `data` at `pos`; returns bytes copied
    function copyOut(iovs, iovsLen, data, pos) {
      const v = view(), h = u8(); let n = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
        const take = Math.min(len, data.byteLength - pos - n);
        if (take <= 0) break;
        h.set(data.subarray(pos + n, pos + n + take), buf); n += take;
      }
      return n;
    }

    const impl = {
      fd_prestat_get(fd, buf) {
        if (fd !== PRE_FD) return undefined;
        const v = view(); v.setUint8(buf, 0); v.setUint32(buf + 4, enc.encode(NAME).length, true); return E.SUCCESS;
      },
      fd_prestat_dir_name(fd, path, len) {
        if (fd !== PRE_FD) return undefined;
        const b = enc.encode(NAME); if (len < b.length) return E.NAMETOOLONG; u8().set(b, path); return E.SUCCESS;
      },
      path_open(fd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInh, fdflags, openedFdPtr) {
        if (!mine(fd)) return undefined;
        const base = nodeOf(fd); if (base.t !== "d") return E.NOTDIR;
        const path = readPath(pathPtr, pathLen);
        if (oflags & (OFLAG.CREAT | OFLAG.TRUNC)) { const r0 = resolve(base, path, true); if (r0.err === E.NOENT || (oflags & OFLAG.TRUNC)) return E.ROFS; if (oflags & OFLAG.EXCL) return E.EXIST; }
        const r = resolve(base, path, !!(dirflags & 1), pathOf(fd));
        if (r.err) return r.err;
        if (r.node.t === "l") return E.LOOP; // O_NOFOLLOW on a symlink
        if ((oflags & OFLAG.DIRECTORY) && r.node.t !== "d") return E.NOTDIR;
        const nfd = nextFd++;
        fds.set(nfd, { node: r.node, pos: 0, name: path, path: r.path });
        view().setUint32(openedFdPtr, nfd, true);
        stats.opens++;
        return E.SUCCESS;
      },
      fd_close(fd) { if (!fds.has(fd)) return undefined; fds.delete(fd); return E.SUCCESS; },
      fd_read(fd, iovs, iovsLen, nreadPtr) {
        if (!mine(fd)) return undefined;
        const f = fds.get(fd); if (!f) return E.BADF; if (f.node.t === "d") return E.ISDIR;
        const data = fileData(f.node); const n = copyOut(iovs, iovsLen, data, f.pos); f.pos += n;
        view().setUint32(nreadPtr, n, true); stats.reads++; stats.readBytes += n; return E.SUCCESS;
      },
      fd_pread(fd, iovs, iovsLen, offset, nreadPtr) {
        if (!mine(fd)) return undefined;
        const f = fds.get(fd); if (!f) return E.BADF; if (f.node.t === "d") return E.ISDIR;
        const data = fileData(f.node); const n = copyOut(iovs, iovsLen, data, Number(offset));
        view().setUint32(nreadPtr, n, true); stats.reads++; stats.readBytes += n; return E.SUCCESS;
      },
      fd_write(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      fd_pwrite(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      fd_seek(fd, offset, whence, newPtr) {
        if (!mine(fd)) return undefined;
        const f = fds.get(fd); if (!f) return E.BADF; if (f.node.t === "d") return E.ISDIR;
        const size = sizeOf(f.node); const off = Number(offset);
        let np = whence === 0 ? off : whence === 1 ? f.pos + off : size + off;
        if (np < 0) return E.INVAL; f.pos = np; view().setBigUint64(newPtr, BigInt(np), true); return E.SUCCESS;
      },
      fd_tell(fd, ptr) { if (!mine(fd)) return undefined; const f = fds.get(fd); if (!f) return E.BADF; view().setBigUint64(ptr, BigInt(f.pos), true); return E.SUCCESS; },
      fd_filestat_get(fd, buf) { if (!mine(fd)) return undefined; writeFilestat(buf, nodeOf(fd)); stats.stats++; return E.SUCCESS; },
      fd_fdstat_get(fd, buf) { if (!mine(fd)) return undefined; writeFdstat(buf, nodeOf(fd)); return E.SUCCESS; },
      fd_fdstat_set_flags(fd) { if (!mine(fd)) return undefined; return E.SUCCESS; },
      fd_sync(fd) { if (!mine(fd)) return undefined; return E.SUCCESS; },
      fd_datasync(fd) { if (!mine(fd)) return undefined; return E.SUCCESS; },
      fd_readdir(fd, buf, bufLen, cookie, bufusedPtr) {
        if (!mine(fd)) return undefined;
        const d = nodeOf(fd); if (d.t !== "d") return E.NOTDIR;
        const entries = [[".", d], ["..", d], ...d.e.entries()];
        const v = view(), h = u8(); let used = 0;
        for (let i = Number(cookie); i < entries.length; i++) {
          const [name, node] = entries[i]; const nb = enc.encode(name);
          const need = 24 + nb.length;
          const room = bufLen - used;
          if (room <= 0) break;
          // WASI: a truncated final entry is written partially and the caller retries with a bigger buffer
          const tmp = new Uint8Array(need); const tv = new DataView(tmp.buffer);
          tv.setBigUint64(0, BigInt(i + 1), true); tv.setBigUint64(8, BigInt(node.ino), true); tv.setUint32(16, nb.length, true); tv.setUint8(20, ftype(node)); tmp.set(nb, 24);
          const take = Math.min(need, room); h.set(tmp.subarray(0, take), buf + used); used += take;
          if (take < need) break;
        }
        v.setUint32(bufusedPtr, used, true); stats.readdirs++; return E.SUCCESS;
      },
      path_filestat_get(fd, flags, pathPtr, pathLen, buf) {
        if (!mine(fd)) return undefined;
        const base = nodeOf(fd); if (base.t !== "d") return E.NOTDIR;
        const r = resolve(base, readPath(pathPtr, pathLen), !!(flags & 1));
        if (r.err) return r.err;
        writeFilestat(buf, r.node); stats.stats++; return E.SUCCESS;
      },
      path_readlink(fd, pathPtr, pathLen, buf, bufLen, bufusedPtr) {
        if (!mine(fd)) return undefined;
        const base = nodeOf(fd); if (base.t !== "d") return E.NOTDIR;
        const r = resolve(base, readPath(pathPtr, pathLen), false);
        if (r.err) return r.err;
        if (r.node.t !== "l") return E.INVAL;
        const b = enc.encode(r.node.target); const n = Math.min(b.length, bufLen);
        u8().set(b.subarray(0, n), buf); view().setUint32(bufusedPtr, n, true); stats.readlinks++; return E.SUCCESS;
      },
      path_filestat_set_times(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      path_create_directory(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      path_unlink_file(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      path_remove_directory(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      path_symlink(oldPtr, oldLen, fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      path_link(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      path_rename(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      fd_allocate(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      fd_filestat_set_size(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      fd_filestat_set_times(fd) { if (!mine(fd)) return undefined; return E.ROFS; },
      fd_advise(fd) { if (!mine(fd)) return undefined; return E.SUCCESS; },
      fd_renumber(fd) { if (!mine(fd)) return undefined; return E.NOTSUP; },
    };
    for (const name of Object.keys(impl)) {
      const orig = wasiImport[name];
      const f = impl[name];
      wasiImport[name] = function () {
        const r = f.apply(null, arguments);
        if (cfg.log && r !== undefined) cfg.log(name, Array.from(arguments), r, name.startsWith("path_") ? readPath(arguments[name === "path_open" ? 2 : name === "path_readlink" ? 1 : 2], arguments[name === "path_open" ? 3 : name === "path_readlink" ? 2 : 3]) : "");
        if (r !== undefined) return r; return orig ? orig.apply(this, arguments) : E.NOTSUP;
      };
    }
    // checkpoint support (harness): the open-fd table as plain data (nodes by canonical path) and back.
    // restore() expects a tree built from the same image, so every path resolves to the same node.
    function snapshot() {
      return { nextFd, fds: Array.from(fds, ([fd, f]) => ({ fd, path: f.path.join("/"), pos: f.pos, name: f.name })), stats: Object.assign({}, stats) };
    }
    function restore(s) {
      fds.clear();
      for (const f of s.fds) {
        const node = lookup(ROOT, f.path);
        if (!node) throw new Error(`wasifs restore: fd ${f.fd} path "${f.path}" not in the tree`);
        fds.set(f.fd, { node, pos: f.pos, name: f.name, path: f.path.split("/").filter((p) => p) });
      }
      nextFd = s.nextFd;
      if (s.stats) Object.assign(stats, s.stats);
    }
    return { stats, fds, root: ROOT, snapshot, restore };
  }

  global.NanoboxFs = { dir, file, symlink, add, remove, lookup, attach, E, FT };
})(typeof self !== "undefined" ? self : globalThis);
