// Minimal, dependency-free ustar tar writer/reader.
//
// This is the transport format across the JS<->VM boundary: the browser tars a directory tree and
// pipes it to `tar -x` inside the VM; sync-back runs `tar -c` in the VM and we parse the stream
// here. Tar is trivial (512-byte headers, octal fields) and lets us move a whole subtree in one
// shot instead of N per-file round-trips over the CheerpX console.

import { toBytes, concat, normPath } from "./util.js";

const BLOCK = 512;

function writeString(buf, off, str, len) {
  for (let i = 0; i < len; i++) buf[off + i] = 0;
  for (let i = 0; i < str.length && i < len; i++) buf[off + i] = str.charCodeAt(i) & 0xff;
}

function writeOctal(buf, off, val, len) {
  const width = len - 1;
  let s = Math.max(0, Math.floor(val)).toString(8).padStart(width, "0").slice(-width);
  for (let i = 0; i < width; i++) buf[off + i] = s.charCodeAt(i);
  buf[off + width] = 0; // NUL terminator
}

function writeName(header, name) {
  if (name.length <= 100) { writeString(header, 0, name, 100); return; }
  // ustar prefix/name split: suffix (<=100) at 0, prefix (<=155) at 345, joined by "/".
  let split = name.length - 100;
  let slash = name.indexOf("/", split);
  if (slash === -1) slash = name.lastIndexOf("/");
  const prefix = name.slice(0, slash);
  const suffix = name.slice(slash + 1);
  writeString(header, 0, suffix, 100);
  writeString(header, 345, prefix, 155);
}

function setChecksum(header) {
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20; // spaces during computation
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  const s = sum.toString(8).padStart(6, "0").slice(-6);
  for (let i = 0; i < 6; i++) header[148 + i] = s.charCodeAt(i);
  header[154] = 0;    // NUL
  header[155] = 0x20; // space
}

// entries: [{ path, type:"file"|"dir", data?, mtime?, mode? }]
export function buildTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const path = normPath(e.path);
    if (!path) continue; // never emit the root itself
    const isDir = e.type === "dir";
    const data = isDir ? new Uint8Array(0) : toBytes(e.data);
    const header = new Uint8Array(BLOCK);

    writeName(header, isDir ? path + "/" : path);
    writeOctal(header, 100, e.mode != null ? e.mode : (isDir ? 0o755 : 0o644), 8);
    writeOctal(header, 108, 0, 8);  // uid
    writeOctal(header, 116, 0, 8);  // gid
    writeOctal(header, 124, data.length, 12);
    writeOctal(header, 136, e.mtime != null ? e.mtime : 0, 12);
    header[156] = isDir ? 0x35 /* '5' */ : 0x30 /* '0' */;
    writeString(header, 257, "ustar", 6);
    header[263] = 0x30; header[264] = 0x30; // version "00"
    setChecksum(header);

    blocks.push(header);
    if (data.length) {
      const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2)); // end-of-archive marker
  return concat(blocks);
}

function readCString(bytes, off, len) {
  let end = off;
  const limit = off + len;
  while (end < limit && bytes[end] !== 0) end++;
  let s = "";
  for (let i = off; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function readOctal(bytes, off, len) {
  let s = "";
  for (let i = off; i < off + len; i++) {
    const c = bytes[i];
    if (c === 0 || c === 0x20) { if (s) break; else continue; }
    s += String.fromCharCode(c);
  }
  return s ? parseInt(s, 8) : 0;
}

function readName(header) {
  const name = readCString(header, 0, 100);
  const prefix = readCString(header, 345, 155);
  return prefix ? prefix + "/" + name : name;
}

function isZeroBlock(bytes, off) {
  for (let i = 0; i < BLOCK; i++) if (bytes[off + i] !== 0) return false;
  return true;
}

// Returns [{ path, type, data?, mtime? }]
export function parseTar(input) {
  const bytes = toBytes(input);
  const out = [];
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, off)) break;
    const header = bytes.subarray(off, off + BLOCK);
    const rawName = readName(header);
    const size = readOctal(header, 124, 12);
    const mtime = readOctal(header, 136, 12);
    const typeflag = String.fromCharCode(header[156]);
    off += BLOCK;
    let data = new Uint8Array(0);
    if (size > 0) {
      data = bytes.slice(off, off + size);
      off += Math.ceil(size / BLOCK) * BLOCK;
    }
    const isDir = typeflag === "5" || rawName.endsWith("/");
    const path = normPath(rawName);
    if (!path) continue;
    if (isDir) out.push({ path, type: "dir" });
    else out.push({ path, type: "file", data, mtime });
  }
  return out;
}
