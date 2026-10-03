// Reading the files a Bun standalone executable carries (`bun build --compile`, e.g. Claude Code's
// native installer build): the JS of such a binary is plain text inside the ELF section `.bun`,
// stored as NUL-terminated records
//
//     \0/$bunfs/root/cli\0// @bun @bytecode @bun-cjs\n(function(exports, require, module, …){…})\n\0
//     \0/$bunfs/root/image-processor.js\0…\0   \0/$bunfs/root/hljsBundle.generated.min.js\0…\0
//
// (a name with no content between it and the next name is an alias/source path, e.g.
// `/$bunfs/root/src/entrypoints/cli.js` right before `/$bunfs/root/cli`). The `@bytecode` blob that
// precedes them is JavaScriptCore's cache — useless off JSC, and the source next to it is complete,
// which is what lets nanobox run the same program on the browser's V8 (docs/system-node.md).
//
// SINCE 2.1.288 THE RECORDS ABOVE ARE GONE. Bun now writes an INDEX: the module contents, the
// sourcemaps, the JavaScriptCore bytecode and a NUL-separated name table are four separate regions of
// the `.bun` section, and one fixed-size record per module points into them. There is no
// \0<name>\0<contents>\0 adjacency left to scan for, so the record scan below finds nothing usable and
// entry()'s "biggest @bun-wrapped module" fallback happily returns a 5-byte asset — which is how a
// vendor bump turned into `SyntaxError: Invalid or unexpected token` inside the sandbox page.
// graph() reads the index instead, which is exact. Measured on 2.1.288 (linux-x64, 245,734,584 bytes,
// sha256 0298068b…7640c), `.bun` at 89,120,768 + 156,554,278:
//
//     section+0        u64 byte_count          (= section size - 8; pointer base is section+8)
//     …                contents | sourcemaps | bytecode | name table   (pointers are base-relative)
//     base+mod.offset  N x 52-byte records: name{u32 off,u32 len} contents{..} sourcemap{..}
//                      bytecode{..} u32 u32 sourcePath{..} u8 loader,u8 format,u8 flags,u8 pad
//     blob end         Offsets{u64 byte_count; u32 modules_off; u32 modules_len; u32 entry_id; …}
//     section end-16   "\n---- Bun! ----\n"
//
//   NanoboxBunFs.section(bytes)            -> {off, size} of `.bun` (ELF64), or null
//   NanoboxBunFs.graph(bytes)              -> {base, entryIndex, recordSize, modules} from the 2.1.288
//                                            index, or null when this slice has no readable index
//   NanoboxBunFs.modules(bytes, opts)      -> [{name, off, len, text()}]  (graph() first, then the
//                                            pre-2.1.288 record scan; opts.section skips the ELF parse)
//   NanoboxBunFs.entry(modules)            -> the program's main module (the index's entry_id, else
//                                            …/root/cli, else the biggest one)
//   NanoboxBunFs.unwrapCjs(text)           -> {body, wrapped} — `(function(exports, require, module, __filename,
//                                            __dirname){…})` as it stands is what our loader evaluates
//   NanoboxBunFs.SEARCH_TAIL_BYTES         how much of the file's tail holds the sources in practice (range fetches)
(function (global) {
  const NAME_PREFIX = "/$bunfs/";
  // 2.1.233: the sources sat in the last ~36 MB of 324 MB. 2.1.288: the contents region starts
  // 46.5 MB before EOF and the index is in the last 300 KB, so 64 MB still covers both.
  const SEARCH_TAIL_BYTES = 64 * 1024 * 1024;
  const TRAILER = "\n---- Bun! ----\n";          // Bun writes this as the last bytes of the `.bun` section
  // 52 on 2.1.288. The others are here so that a Bun release which adds a field to the record still
  // parses: the size is not assumed, it is the one whose records validate (readRecords below).
  const RECORD_SIZES = [52, 56, 60, 64, 48, 44, 40];
  const INDEX_SEARCH_BYTES = 256;                // how far before the trailer the Offsets struct may sit
  const dec = new TextDecoder("utf-8", { fatal: false });
  const enc = new TextEncoder();

  function section(bytes) {
    const u8 = asU8(bytes);
    if (u8.length < 64 || u8[0] !== 0x7f || u8[1] !== 0x45 || u8[2] !== 0x4c || u8[3] !== 0x46) return null; // \x7fELF
    if (u8[4] !== 2) return null;                                    // ELF64 only (x86-64 / arm64 binaries)
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const shoff = Number(dv.getBigUint64(0x28, true));
    const shentsize = dv.getUint16(0x3a, true), shnum = dv.getUint16(0x3c, true), shstrndx = dv.getUint16(0x3e, true);
    if (!shoff || !shnum || shoff + shnum * shentsize > u8.length) return null;   // truncated (range fetch): scan instead
    const strTab = shoff + shstrndx * shentsize;
    const strOff = Number(dv.getBigUint64(strTab + 0x18, true));
    for (let i = 0; i < shnum; i++) {
      const sh = shoff + i * shentsize;
      const nameOff = strOff + dv.getUint32(sh, true);
      let end = nameOff; while (end < u8.length && u8[end]) end++;
      if (dec.decode(u8.subarray(nameOff, end)) !== ".bun") continue;
      return { off: Number(dv.getBigUint64(sh + 0x18, true)), size: Number(dv.getBigUint64(sh + 0x20, true)) };
    }
    return null;
  }

  // The 2.1.288 index, read from the end of the `.bun` section. Works on a range-fetched tail: every
  // pointer is resolved as `indexAt - byteCount + pointer`, all of it relative to THIS buffer, so the
  // true file offset of the slice is never needed. null when there is no index to read (an older
  // binary, or a slice that does not reach the trailer) — modules() then falls back to the scan.
  function graph(bytes) {
    const u8 = asU8(bytes);
    const trailer = lastIndexOfBytes(u8, enc.encode(TRAILER));
    if (trailer < 0) return null;
    // the struct is just before the trailer but not flush against it (2.1.288 leaves 8 bytes), so the
    // handful of candidate positions are VALIDATED rather than assumed — a wrong one cannot validate.
    for (let at = trailer - 24; at >= Math.max(0, trailer - INDEX_SEARCH_BYTES); at -= 4) {
      const found = readIndex(u8, at);
      if (found) return found;
    }
    return null;
  }

  function readIndex(u8, at) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const byteCount = Number(dv.getBigUint64(at, true));
    const base = at - byteCount;                 // < 0 whenever the blob starts before this slice
    const modOff = dv.getUint32(at + 8, true), modLen = dv.getUint32(at + 12, true);
    const entryIndex = dv.getUint32(at + 16, true);
    if (!modLen || modLen > u8.length) return null;
    const arr = base + modOff;
    if (arr < 0 || arr + modLen > u8.length) return null;
    for (const recordSize of RECORD_SIZES) {
      if (modLen % recordSize) continue;
      const count = modLen / recordSize;
      if (entryIndex >= count) continue;
      const mods = readRecords(u8, dv, base, arr, count, recordSize);
      if (mods) { mods[entryIndex].entryPoint = true; return { base, entryIndex, recordSize, modules: mods }; }
    }
    return null;
  }

  // One record per module. The name pointers are what make a candidate layout provable: every one of
  // them must land on a NUL-terminated "/$bunfs/…" string of exactly the stated length. Contents that
  // fall outside the slice are not an error — a short tail fetch legitimately misses them, and the
  // caller wants to be told WHICH module it is missing (truncated) rather than handed nothing.
  function readRecords(u8, dv, base, arr, count, recordSize) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const rec = arr + i * recordSize;
      const nameOff = base + dv.getUint32(rec, true), nameLen = dv.getUint32(rec + 4, true);
      if (nameLen < NAME_PREFIX.length || nameLen > 4096) return null;
      if (nameOff < 0 || nameOff + nameLen + 1 > u8.length) return null;
      if (!startsWith(u8, nameOff, NAME_PREFIX) || u8[nameOff + nameLen] !== 0) return null;
      const off = base + dv.getUint32(rec + 8, true), len = dv.getUint32(rec + 12, true);
      const inSlice = off >= 0 && off + len <= u8.length;
      const from = inSlice ? off : 0, take = inSlice ? len : 0;
      out.push({ name: dec.decode(u8.subarray(nameOff, nameOff + nameLen)), off, len, truncated: !inSlice,
        loader: u8[rec + recordSize - 4], moduleFormat: u8[rec + recordSize - 3],
        text: () => dec.decode(u8.subarray(from, from + take)), bytes: () => u8.subarray(from, from + take) });
    }
    return out;
  }

  // Every embedded file, in the order they are stored. `off` is relative to `bytes`.
  function modules(bytes, opts) {
    const u8 = asU8(bytes);
    const indexed = graph(u8);
    if (indexed) return indexed.modules;
    const sec = (opts && opts.section) || section(u8) || { off: 0, size: u8.length };
    const from = Math.max(0, Math.min(sec.off, u8.length)), to = Math.min(sec.off + sec.size, u8.length);
    const needle = enc.encode("\0" + NAME_PREFIX);
    const out = [];
    let i = from;
    for (;;) {
      i = indexOfBytes(u8, needle, i, to);
      if (i < 0) return out;
      const nameStart = i + 1;
      const nameEnd = indexOfByte(u8, 0, nameStart, to);
      if (nameEnd < 0) return out;
      const contentStart = nameEnd + 1;
      // the record's terminator is the NUL the next record starts with; a slice may cut the last
      // one short, so take what is there and mark it (entry() then prefers a complete module)
      const nul = indexOfByte(u8, 0, contentStart, to);
      const contentEnd = nul < 0 ? to : nul;
      const truncated = nul < 0;
      // a record whose "content" is the next name is an alias (Bun stores the source path right
      // before the module it belongs to) — rewind so the real record is read next
      if (contentEnd === contentStart || startsWith(u8, contentStart, NAME_PREFIX)) { i = nameEnd; continue; }
      const name = dec.decode(u8.subarray(nameStart, nameEnd));
      const off = contentStart, len = contentEnd - contentStart;
      out.push({ name, off, len, truncated, text: () => dec.decode(u8.subarray(off, off + len)), bytes: () => u8.subarray(off, off + len) });
      if (truncated) return out;
      i = contentEnd;
    }
  }

  // The program's entry: the largest module Bun wrapped for its own loader (`// @bun … @bun-cjs`);
  // failing that (a source-only build), simply the largest one.
  function entry(mods) {
    if (!mods || !mods.length) return null;
    const declared = mods.find((m) => m.entryPoint);     // 2.1.288: the index says which one it is
    if (declared) return declared;
    const whole = mods.filter((m) => !m.truncated);
    const banner = (whole.length ? whole : mods).filter((m) => m.len > 1024 && startsWith(m.bytes(), 0, "// @bun"));
    return (banner.length ? banner : whole.length ? whole : mods).reduce((a, b) => (b.len > a.len ? b : a));
  }

  // Bun stores CJS entries wrapped for its own loader; our runtime evaluates the wrapper as an
  // expression and calls it with the module context, so no source transform is needed at all.
  function unwrapCjs(text) {
    const banner = /^\/\/ @bun[^\n]*\n/.exec(text);
    const body = banner ? text.slice(banner[0].length) : text;
    return { body, wrapped: /^\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)/.test(body) };
  }

  function asU8(b) { return b instanceof Uint8Array ? b : new Uint8Array(b); }
  function startsWith(u8, at, ascii) { for (let k = 0; k < ascii.length; k++) if (u8[at + k] !== ascii.charCodeAt(k)) return false; return true; }
  function indexOfByte(u8, byte, from, to) { for (let i = from; i < to; i++) if (u8[i] === byte) return i; return -1; }
  function lastIndexOfBytes(u8, needle) {
    for (let i = u8.length - needle.length; i >= 0; i--) {
      let k = 0; while (k < needle.length && u8[i + k] === needle[k]) k++;
      if (k === needle.length) return i;
    }
    return -1;
  }
  function indexOfBytes(u8, needle, from, to) {
    const first = needle[0], last = needle.length - 1, limit = to - needle.length;
    for (let i = from; i <= limit; i++) {
      if (u8[i] !== first) continue;
      let k = last; while (k > 0 && u8[i + k] === needle[k]) k--;
      if (k === 0) return i;
    }
    return -1;
  }

  global.NanoboxBunFs = { section, graph, modules, entry, unwrapCjs, NAME_PREFIX, TRAILER, SEARCH_TAIL_BYTES };
})(typeof self !== "undefined" ? self : globalThis);
