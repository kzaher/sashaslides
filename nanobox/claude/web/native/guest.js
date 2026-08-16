// Runtime-worker side of the host channel: the "syscall backend #2" for the Node-compat layer.
// Everything the JavaScript needs from Linux (files, tty, child processes) is done INSIDE the guest
// by the nbnode shim (guest/nbnode/nbnode.c); this object turns those into async calls.
//
//   const g = NanoboxGuest.connect({ port, ringSab });   // port: MessagePort carrying guest->host
//                                                        // bytes from opt-worker.js; ringSab: host->guest ring
//   g.onHello = (h) => ...   // {argv, env, cwd, pid, cols, rows, isatty}  — the shim started: run its argv
//   g.onStdin = (u8) => ...  // bytes typed on the container tty (empty = EOF)
//   g.onResize = (cols, rows) => ...
//   g.onChildOut = (cid, fd, u8) => ...;  g.onChildExit = (cid, code, signal) => ...;  g.onSignal = (signum) => ...
//   await g.open(path, flags, mode) -> fd; g.read(fd, len, off) -> Uint8Array; g.write(fd, data, off) -> n
//   g.stat/lstat(path) -> {dev,ino,mode,...} (BigInt fields); g.fstat(fd); g.readdir(path) -> [{name, type}]
//   g.readlink, mkdir, unlink, rmdir, rename, access, chmod, realpath, utimes, truncate, ftruncate, symlink,
//   link, fsync, chown, fchmod, stdout(u8), stderr(u8), exit(code), ttyRaw(on), ttySize() -> {cols, rows},
//   spawn(cid, argv, env, cwd, flags) -> pid, childStdin(cid, u8), kill(cid, sig), getpid(), hrtime()
//   Errors reject with an Error carrying .errno (Linux number) and .code ("ENOENT" ...).
// Requires proto.js and hcring.js (importScripts before this file).
(function (global) {
  const P = global.NanoboxProto, OP = P.OP;
  const ERRNO = { 1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM", 13: "EACCES", 17: "EEXIST", 18: "EXDEV",
    20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 24: "EMFILE", 27: "EFBIG", 28: "ENOSPC", 29: "ESPIPE", 30: "EROFS", 31: "EMLINK", 32: "EPIPE", 36: "ENAMETOOLONG",
    38: "ENOSYS", 39: "ENOTEMPTY", 40: "ELOOP", 95: "EOPNOTSUPP" };
  function connect(cfg) {
    // transport: {port, ringSab} in the browser (worker <-> worker), or {send(u8), onData(cb)}
    // (the harness's NanoboxHostChan object works as-is)
    const writer = cfg.ringSab ? global.NanoboxHcRing.writer(cfg.ringSab) : null;
    const pending = new Map(); let nextId = 1;
    const g = { stats: { sent: 0, recv: 0, bytesOut: 0, bytesIn: 0 } };
    const send = (u8) => { if (writer) writer.write(u8); else cfg.transport.send(u8); g.stats.sent++; g.stats.bytesOut += u8.length; };
    const call = (op, build, parse) => new Promise((resolve, reject) => {
      const id = nextId++; const w = new P.W(); if (build) build(w);
      pending.set(id, { resolve, reject, parse, op });
      send(w.frame(op, id));
    });
    const fire = (op, build) => { const w = new P.W(); if (build) build(w); send(w.frame(op, 0)); };
    const onFrame = (op, id, r) => {
      g.stats.recv++;
      if (g.debug) g.debug(`frame op=${op} id=${id} len=${r.left()}`);
      if (op === OP.REPLY) {
        const p = pending.get(id); if (!p) return; pending.delete(id);
        const errno = r.i32();
        if (errno) { const e = new Error((ERRNO[errno] || "E" + errno) + " (guest " + p.op + ")"); e.errno = errno; e.code = ERRNO[errno] || "EUNKNOWN"; p.reject(e); return; }
        p.resolve(p.parse ? p.parse(r) : undefined);
        return;
      }
      switch (op) {
        case OP.HELLO: { const version = r.u32(); const argv = r.list((x) => x.str()); const env = r.list((x) => x.str()); const cwd = r.str(); const pid = r.i32(); const cols = r.i32(), rows = r.i32(); const isatty = r.i32();
          g.hello = { version, argv, env, cwd, pid, cols, rows, isatty }; if (g.onHello) g.onHello(g.hello); break; }
        case OP.STDIN: { const b = r.bin(); if (g.onStdin) g.onStdin(b); break; }
        case OP.RESIZE: { const c = r.i32(), rr = r.i32(); if (g.onResize) g.onResize(c, rr); break; }
        case OP.CHILD_OUT: { const cid = r.u32(), fd = r.i32(), b = r.bin(); if (g.onChildOut) g.onChildOut(cid, fd, b); break; }
        case OP.CHILD_EXIT: { const cid = r.u32(), code = r.i32(), sig = r.i32(); if (g.onChildExit) g.onChildExit(cid, code, sig); break; }
        case OP.SIGNAL: { const s = r.i32(); if (g.onSignal) g.onSignal(s); break; }
        case OP.LOG: { const t = r.str(); if (g.onLog) g.onLog(t); else console.log("[nbnode] " + t); break; }
        default: console.warn("[guest] unknown op", op);
      }
    };
    const feed = P.framer(onFrame);
    if (cfg.port) {
      cfg.port.onmessage = (m) => { const d = m.data; if (d && d.type === "hc") { g.stats.bytesIn += d.data.length; feed(new Uint8Array(d.data)); } };
      if (cfg.port.start) cfg.port.start();
    } else cfg.transport.onData = (b) => { g.stats.bytesIn += b.length; feed(b); };
    // ---- requests
    g.open = (path, flags, mode) => call(OP.OPEN, (w) => w.str(path).i32(flags | 0).i32(mode | 0), (r) => r.i32());
    g.close = (fd) => call(OP.CLOSE, (w) => w.i32(fd));
    g.read = (fd, len, off) => call(OP.READ, (w) => w.i32(fd).u32(len).i64(off == null ? -1 : off), (r) => r.bin());
    g.write = (fd, data, off) => call(OP.WRITE, (w) => w.i32(fd).i64(off == null ? -1 : off).bin(data), (r) => r.i32());
    g.stat = (path) => call(OP.STAT, (w) => w.str(path), P.readStat);
    g.lstat = (path) => call(OP.LSTAT, (w) => w.str(path), P.readStat);
    g.fstat = (fd) => call(OP.FSTAT, (w) => w.i32(fd), P.readStat);
    g.readdir = (path) => call(OP.READDIR, (w) => w.str(path), (r) => r.list((x) => ({ name: x.str(), type: x.u8() })));
    g.readlink = (path) => call(OP.READLINK, (w) => w.str(path), (r) => r.str());
    g.mkdir = (path, mode) => call(OP.MKDIR, (w) => w.str(path).i32(mode == null ? 0o777 : mode));
    g.unlink = (path) => call(OP.UNLINK, (w) => w.str(path));
    g.rmdir = (path) => call(OP.RMDIR, (w) => w.str(path));
    g.rename = (a, b) => call(OP.RENAME, (w) => w.str(a).str(b));
    g.access = (path, mode) => call(OP.ACCESS, (w) => w.str(path).i32(mode | 0));
    g.chmod = (path, mode) => call(OP.CHMOD, (w) => w.str(path).i32(mode));
    g.realpath = (path) => call(OP.REALPATH, (w) => w.str(path), (r) => r.str());
    g.utimes = (path, atimeNs, mtimeNs) => call(OP.UTIMES, (w) => w.str(path).i64(atimeNs).i64(mtimeNs));
    g.truncate = (path, len) => call(OP.TRUNCATE, (w) => w.str(path).i64(len));
    g.ftruncate = (fd, len) => call(OP.FTRUNCATE, (w) => w.i32(fd).i64(len));
    g.symlink = (target, path) => call(OP.SYMLINK, (w) => w.str(target).str(path));
    g.link = (a, b) => call(OP.LINK, (w) => w.str(a).str(b));
    g.fsync = (fd) => call(OP.FSYNC, (w) => w.i32(fd));
    g.chown = (path, uid, gid) => call(OP.CHOWN, (w) => w.str(path).i32(uid).i32(gid));
    g.fchmod = (fd, mode) => call(OP.FCHMOD, (w) => w.i32(fd).i32(mode));
    g.stdout = (u8) => fire(OP.STDOUT, (w) => w.bin(u8));
    g.stderr = (u8) => fire(OP.STDERR, (w) => w.bin(u8));
    g.exit = (code) => fire(OP.EXIT, (w) => w.i32(code | 0));
    g.ttyRaw = (on) => fire(OP.TTY_RAW, (w) => w.i32(on ? 1 : 0));
    g.ttySize = () => call(OP.TTY_SIZE, null, (r) => ({ cols: r.i32(), rows: r.i32() }));
    g.spawn = (cid, argv, env, cwd, flags) => call(OP.SPAWN, (w) => w.u32(cid).list(argv, (x, a) => x.str(a)).list(env, (x, e) => x.str(e)).str(cwd || "/").i32(flags | 0), (r) => r.i32());
    g.childStdin = (cid, u8) => fire(OP.CHILD_STDIN, (w) => w.u32(cid).bin(u8 || new Uint8Array(0)));
    g.kill = (cid, sig) => fire(OP.KILL, (w) => w.u32(cid).i32(sig | 0));
    g.getpid = () => call(OP.GETPID, null, (r) => r.i32());
    g.hrtime = () => call(OP.HRTIME, null, (r) => r.i64());
    // convenience: whole-file read through the guest (open/read loop/close)
    g.readFile = async (path) => { const fd = await g.open(path, 0, 0); try { const chunks = []; for (;;) { const b = await g.read(fd, 1 << 20, -1); if (!b.length) break; chunks.push(b); } const n = chunks.reduce((s, c) => s + c.length, 0); const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; } finally { await g.close(fd); } };
    return g;
  }
  global.NanoboxGuest = { connect };
})(typeof self !== "undefined" ? self : globalThis);
