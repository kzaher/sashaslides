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
//   NanoboxBunFs.section(bytes)            -> {off, size} of `.bun` (ELF64), or null
//   NanoboxBunFs.modules(bytes, opts)      -> [{name, off, len, text()}]  (opts.section to skip the ELF parse)
//   NanoboxBunFs.entry(modules)            -> the program's main module (…/root/cli or the biggest one)
//   NanoboxBunFs.unwrapCjs(text)           -> {body, wrapped} — `(function(exports, require, module, __filename,
//                                            __dirname){…})` as it stands is what our loader evaluates
//   NanoboxBunFs.SEARCH_TAIL_BYTES         how much of the file's tail holds the sources in practice (range fetches)
(function (global) {
  const NAME_PREFIX = "/$bunfs/";
  const SEARCH_TAIL_BYTES = 64 * 1024 * 1024;   // Claude Code 2.1.233: sources sit in the last ~36 MB of 324 MB
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

  // Every embedded file, in the order they are stored. `off` is relative to `bytes`.
  function modules(bytes, opts) {
    const u8 = asU8(bytes);
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
  function indexOfBytes(u8, needle, from, to) {
    const first = needle[0], last = needle.length - 1, limit = to - needle.length;
    for (let i = from; i <= limit; i++) {
      if (u8[i] !== first) continue;
      let k = last; while (k > 0 && u8[i + k] === needle[k]) k--;
      if (k === 0) return i;
    }
    return -1;
  }

  global.NanoboxBunFs = { section, modules, entry, unwrapCjs, NAME_PREFIX, SEARCH_TAIL_BYTES };
})(typeof self !== "undefined" ? self : globalThis);
