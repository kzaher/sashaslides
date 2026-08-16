#!/usr/bin/env node
// Unit test: the writable-subtree ops of web/wasifs.js through the WASI import surface (fake memory).
import { dirname, join } from "node:path"; import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
await import(join(HERE, "../web/wasifs.js"));
const F = globalThis.NanoboxFs, E = F.E;
const mem = new WebAssembly.Memory({ initial: 1 });
const root = F.dir();
F.add(root, "rootfs/etc/hosts", { data: new TextEncoder().encode("127.0.0.1 localhost\n") });
F.add(root, "persist/usr/local/bin", { dir: true });
F.add(root, "persist/root/.claude/settings.json", { data: new TextEncoder().encode("{}") });
const changes = [];
const wasi = {};
const fs = F.attach(wasi, { fd: 6, name: "bundle", root, memory: () => mem, writable: (p) => p[0] === "persist", onChange: (ev) => changes.push(ev.op + ":" + ev.path.join("/") + (ev.to ? "->" + ev.to.join("/") : "")) });
const u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer), enc = new TextEncoder(), dec = new TextDecoder();
let heap = 1024;
const str = (s) => { const b = enc.encode(s); u8.set(b, heap); const r = [heap, b.length]; heap += b.length + 1; return r; };
const iov = (s) => { const b = enc.encode(s); const dp = heap; u8.set(b, dp); heap += b.length + 8; const ip = heap; dv.setUint32(ip, dp, true); dv.setUint32(ip + 4, b.length, true); heap += 8; return ip; };
const CREAT = 1, TRUNC = 8, EXCL = 4;
let bad = 0; const check = (name, cond, extra) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra != null ? " " + extra : ""}`); if (!cond) bad++; };
const open = (path, oflags, fdflags = 0) => { const [p, l] = str(path); const out = heap; heap += 4; const r = wasi.path_open(6, 1, p, l, oflags, 0n, 0n, fdflags, out); return [r, dv.getUint32(out, true)]; };
// 1. create + pwrite + close -> change
let [r, fd] = open("persist/root/.claude.json", CREAT | TRUNC);
check("create in persist", r === E.SUCCESS, r);
const np = heap; heap += 4;
r = wasi.fd_pwrite(fd, iov('{"a":1}'), 1, 0n, np); check("pwrite", r === E.SUCCESS && dv.getUint32(np, true) === 7);
r = wasi.fd_pwrite(fd, iov('X'), 1, 3n, np); check("pwrite at offset", r === E.SUCCESS);
wasi.fd_close(fd);
check("content", dec.decode(F.lookup(root, "persist/root/.claude.json").data) === '{"aX:1}', dec.decode(F.lookup(root, "persist/root/.claude.json").data));
check("change event", changes.at(-1) === "write:persist/root/.claude.json", changes.at(-1));
// 2. EROFS outside persist
[r, fd] = open("rootfs/etc/newfile", CREAT); check("create outside persist -> EROFS", r === E.ROFS, r);
[r, fd] = open("rootfs/etc/hosts", 0); r = wasi.fd_pwrite(fd, iov("x"), 1, 0n, np); check("write image file -> EROFS", r === E.ROFS, r); wasi.fd_close(fd);
// 3. write to an image-derived file under persist (view into shared buffer) makes a private copy
[r, fd] = open("persist/root/.claude/settings.json", 0);
r = wasi.fd_pwrite(fd, iov('{"theme":"dark"}'), 1, 0n, np); wasi.fd_close(fd);
check("overwrite existing", dec.decode(F.lookup(root, "persist/root/.claude/settings.json").data) === '{"theme":"dark"}');
// 4. append flag
[r, fd] = open("persist/root/log.txt", CREAT, 1);
wasi.fd_write(fd, iov("a\n"), 1, np); wasi.fd_write(fd, iov("b\n"), 1, np); wasi.fd_close(fd);
check("append", dec.decode(F.lookup(root, "persist/root/log.txt").data) === "a\nb\n");
// 5. mkdir / rename / unlink / rmdir / symlink / truncate
{ const [p, l] = str("persist/root/dir"); check("mkdir", wasi.path_create_directory(6, p, l) === E.SUCCESS); }
{ const [p, l] = str("persist/root/log.txt"), [q, m] = str("persist/root/dir/log2.txt"); check("rename", wasi.path_rename(6, p, l, 6, q, m) === E.SUCCESS && !!F.lookup(root, "persist/root/dir/log2.txt") && !F.lookup(root, "persist/root/log.txt")); check("rename event", changes.at(-1) === "rename:persist/root/log.txt->persist/root/dir/log2.txt", changes.at(-1)); }
{ const [p, l] = str("persist/root/dir/log2.txt"); check("unlink", wasi.path_unlink_file(6, p, l) === E.SUCCESS && !F.lookup(root, "persist/root/dir/log2.txt")); }
{ const [p, l] = str("persist/root/dir"); check("rmdir", wasi.path_remove_directory(6, p, l) === E.SUCCESS); }
{ const [t, tl] = str("../lib/node_modules/x/cli.js"), [p, l] = str("persist/usr/local/bin/x"); check("symlink", wasi.path_symlink(t, tl, 6, p, l) === E.SUCCESS && F.lookup(root, "persist/usr/local/bin/x").t === "l"); }
[r, fd] = open("persist/root/.claude.json", 0); check("truncate", wasi.fd_filestat_set_size(fd, 2n) === E.SUCCESS && F.lookup(root, "persist/root/.claude.json").data.byteLength === 2); wasi.fd_close(fd);
[r, fd] = open("persist/root/.claude.json", CREAT | EXCL); check("O_EXCL on existing -> EEXIST", r === E.EXIST, r);
{ const [p, l] = str("rootfs/etc/hosts"); check("unlink outside -> EROFS", wasi.path_unlink_file(6, p, l) === E.ROFS); }
// 6. read back through fd_read
[r, fd] = open("persist/root/.claude/settings.json", 0); { const dp = heap; heap += 64; const ip = heap; heap += 8; dv.setUint32(ip, dp, true); dv.setUint32(ip + 4, 64, true); wasi.fd_read(fd, ip, 1, np); check("read back", dec.decode(u8.subarray(dp, dp + dv.getUint32(np, true))) === '{"theme":"dark"}'); }
console.log("changes:", changes.join(", "));
console.log(bad ? `FAILED (${bad})` : "ALL OK", JSON.stringify(fs.stats));
process.exit(bad ? 1 : 0);
