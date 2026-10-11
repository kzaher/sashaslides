// nanobox JIT bundle format (".nbjb") — pre-computed trace/region translations, shared by the node
// harness (harness/run.mjs: --jit-bundle-out / --jit-bundle), the browser JIT host (jit-host.js:
// NanoboxJit.preload) and the static server (serve.mjs: engine tag in /engine/opt/jit/index.json).
// Plain script (no modules): loaded with importScripts() in the worker and with `await import()` +
// `globalThis.self = globalThis` from node, like netstub.js / wasifs.js.
//
// A bundle is the set of wasm modules the engine's JIT emitted in an earlier run, keyed by the
// engine's own *content key* (a 64-bit hash of the decoded instructions of a trace/region — the
// key the engine passes to the lookup/note hooks). The modules are position independent (per-region
// data travels in the call argument), and their imports (`h.i` = Bochs functions by function-table
// index) are stable for one engine build, so a module dumped in one run is valid in every other run
// of the SAME build — hence the engine tag: a bundle records which build it belongs to and hosts
// refuse (warn + ignore) a bundle whose tag differs from the engine they run.
//
// The shared link function. Every compiled trace ends in a tail call to ONE engine-emitted "link"
// function (nanobox_ensure_link_fn: installed through the same install hook, then its table index
// is baked into every module as an `i32.const` + `return_call_indirect`). Modules are therefore
// position independent only if the link function sits at the SAME table slot in every run. Hosts
// guarantee that: the link module is pinned at a fixed slot (`linkSlot`, the engine table's initial
// length — a build constant — since it is the first thing the engine installs), it is never
// released, and a re-install of byte-identical bytes (the engine drops it on every cache clear)
// answers with the pinned slot. The bundle carries the link module (content key LINK_KEY =
// ffffffff:ffffffff, reserved) plus `linkSlot`, so a replaying host pins it BEFORE the engine runs. An engine that notes the link function explicitly
// (note(fn, LINK_KEY) after installing it, lookup(LINK_KEY) before) works with the same hosts.
//
// Layout, all integers little-endian u32:
//   "NBJB"                       magic
//   u32 version                  = 1
//   u32 tagLen, tagLen bytes     engine tag (utf-8; see engineTagInput below)
//   u32 linkSlot                 table slot the link function was pinned at (0 = bundle has no link
//                                module: engine without a shared link function)
//   u32 count                    number of modules
//   count times:
//     u32 nkeys, u32 keys[nkeys]              import keys: h.i = engine table entry keys[i]
//     u32 nfuncs, (u32 keyLo, u32 keyHi)[nfuncs]
//                                 content key of each *function export* of the module, in the
//                                 module's export order (a slot-0 module has one export "r"; a
//                                 slot-5 batch module exports f0..f(n-1)); (0,0) = no key noted
//     u32 len, len bytes          the wasm module
// Nothing is aligned or compressed (serve it gzipped if you care; wasm compresses ~3x).
(function (global) {
  const MAGIC = 0x424a424e; // "NBJB" read as LE u32
  const VERSION = 1;
  const LINK_KEY = [0xffffffff, 0xffffffff]; // reserved content key of the shared link function
  const isLinkKey = (lo, hi) => (lo >>> 0) === 0xffffffff && (hi >>> 0) === 0xffffffff;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // records: [{ keys: Uint32Array|number[], funcKeys: [[lo, hi], ...], bytes: Uint8Array }]
  function encode(records, tag, linkSlot) {
    const tagBytes = enc.encode(tag || "");
    let size = 4 + 4 + 4 + tagBytes.length + 4 + 4;
    for (const r of records) size += 4 + 4 * r.keys.length + 4 + 8 * r.funcKeys.length + 4 + r.bytes.length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let o = 0;
    const u32 = (v) => { dv.setUint32(o, v >>> 0, true); o += 4; };
    u32(MAGIC); u32(VERSION); u32(tagBytes.length); out.set(tagBytes, o); o += tagBytes.length;
    u32(linkSlot || 0);
    u32(records.length);
    for (const r of records) {
      u32(r.keys.length); for (const k of r.keys) u32(k);
      u32(r.funcKeys.length); for (const [lo, hi] of r.funcKeys) { u32(lo); u32(hi); }
      u32(r.bytes.length); out.set(r.bytes, o); o += r.bytes.length;
    }
    return out;
  }

  // -> { tag, linkSlot, modules: [{ keys: Uint32Array, funcKeys: [[lo, hi]...], bytes: Uint8Array }] }
  // (the link module, if any, is the one whose single funcKey is LINK_KEY); throws on a malformed file
  function decode(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let o = 0;
    const u32 = () => { if (o + 4 > u8.length) throw new Error("nbjb: truncated"); const v = dv.getUint32(o, true); o += 4; return v; };
    if (u32() !== MAGIC) throw new Error("nbjb: bad magic");
    const version = u32();
    if (version !== VERSION) throw new Error("nbjb: unsupported version " + version);
    const tagLen = u32(); const tag = dec.decode(u8.subarray(o, o + tagLen)); o += tagLen;
    const linkSlot = u32();
    const count = u32();
    const modules = [];
    for (let i = 0; i < count; i++) {
      const nkeys = u32(); if (o + 4 * nkeys > u8.length) throw new Error("nbjb: truncated");
      const keys = new Uint32Array(nkeys); for (let k = 0; k < nkeys; k++) keys[k] = u32();
      const nfuncs = u32(); if (o + 8 * nfuncs > u8.length) throw new Error("nbjb: truncated");
      const funcKeys = []; for (let k = 0; k < nfuncs; k++) { const lo = u32(), hi = u32(); funcKeys.push([lo, hi]); }
      const len = u32(); if (o + len > u8.length) throw new Error("nbjb: truncated");
      // slice (copy): keeps each module's bytes independent of the (large) file buffer
      const bytes = u8.slice(o, o + len); o += len;
      modules.push({ keys, funcKeys, bytes });
    }
    return { tag, linkSlot, modules, version };
  }

  // Engine identity. Hashing all 116 MB of the wizer snapshot on every page load is pointless: the
  // first MiB (types/imports/function section/start of the code) and the last MiB (tail of the data
  // segments) plus the exact byte length pin a build down well enough. The tag is
  //   "<byteLength>-<sha256(head 1 MiB || tail 1 MiB) as hex, first 32 chars>"
  // engineTagInput() returns the bytes to hash; the hosts hash them with whatever sha256 they have
  // (node: crypto.createHash, worker: crypto.subtle) and format with engineTagFormat().
  const TAG_WINDOW = 1 << 20;
  function engineTagInput(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length <= 2 * TAG_WINDOW) return u8;
    const out = new Uint8Array(2 * TAG_WINDOW);
    out.set(u8.subarray(0, TAG_WINDOW), 0);
    out.set(u8.subarray(u8.length - TAG_WINDOW), TAG_WINDOW);
    return out;
  }
  function engineTagFormat(byteLength, sha256hex) { return byteLength + "-" + sha256hex.slice(0, 32); }
  // canonical string form of a content key (Map key on the host side)
  function keyString(lo, hi) { return (hi >>> 0).toString(16) + ":" + (lo >>> 0).toString(16); }

  // byte equality (link-module detection on install)
  function sameBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

  global.NanoboxJitBundle = { MAGIC, VERSION, LINK_KEY, isLinkKey, encode, decode, engineTagInput, engineTagFormat, keyString, sameBytes };
})(typeof self !== "undefined" ? self : globalThis);
