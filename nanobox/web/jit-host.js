// nanobox JIT host — the browser side of the trace JIT inside the optimized Bochs engine.
//
// The engine (bochs/bochs/nanobox_jit.cc) compiles hot iCache traces/regions into tiny wasm modules
// and talks to the host through function-table hook slots (ex.nanobox_hook_slot(k) = table index):
//   slot 0  install(ptr, len, keysPtr, n) -> table index of the new function (0 = failed)
//   slot 1  release(idx)
//   slot 2  releaseAll()
//   slot 3  lookup(keyLo, keyHi) -> table index of a PRE-COMPUTED translation for this content key,
//           or 0 (asked before the engine compiles anything; answered from preloaded bundles)
//   slot 4  note(fn, keyLo, keyHi): "slot fn holds the translation for this content key" (right
//           after a successful install; lets the host dump bundles)
//   slot 5  install_batch(ptr, len, keysPtr, n, nfuncs, outPtr) -> 1/0: like install, but the module
//           exports f0..f(nfuncs-1); their slot indices go to outPtr as u32 LE in engine memory
// Slots 3..5 exist only in engines that have them (nanobox_hook_slot returns 0 otherwise).
// The host instantiates each module against the engine's own memory + function table, imports the
// helper functions the module asks for (Bochs handlers/accessors, by table index), and drops the
// compiled code into free table slots so the engine can call_indirect it.
//
// Bundles (web/jit-bundle.js): NanoboxJit.preload(urls, engineTag) fetches .nbjb files, checks the
// engine tag, WebAssembly.compile()s every module (async, before the VM starts) and keeps the
// compiled Modules; lookup instantiates a module the first time one of its keys is asked for (which
// binds all of its exports) — no compile on the VM thread. Bundle slots are permanent: release /
// releaseAll skip them (the engine may look the same key up again right after a cache clear).
// The engine's shared link function (every trace tail-calls it through a table index baked into the
// module) is pinned at a fixed slot — the first free slot, i.e. the table's initial length — from the
// bundle before the engine starts, or as the engine's first install; byte-identical re-installs get
// the pinned slot back. See jit-bundle.js for why.
//
// Loaded with importScripts() by opt-worker.js (classic worker) — plain script, no modules.
(function (global) {
  function uleb(v) { const out = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; out.push(x); } while (v); return out; }
  // (module (import "js" "f" (func $f T)) (func (export "f") T (local.get ...) (call $f)))
  function trampoline(params, results, jsfn) {
    const vec = (arr) => [arr.length, ...arr];
    const type = [0x60, ...vec(params), ...vec(results)];
    const sec = (id, content) => [id, ...uleb(content.length), ...content];
    const body = [...params.flatMap((_, i) => [0x20, i]), 0x10, 0x00, 0x0b];
    const bytes = new Uint8Array([
      0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      ...sec(1, [1, ...type]),
      ...sec(2, [1, 2, 0x6a, 0x73, 1, 0x66, 0x00, 0]),
      ...sec(3, [1, 0]),
      ...sec(7, [1, 1, 0x66, 0x00, 1]),
      ...sec(10, [1, ...uleb(body.length + 1), 0, ...body]),
    ]);
    return new WebAssembly.Instance(new WebAssembly.Module(bytes), { js: { f: jsfn } }).exports.f;
  }
  const B = () => global.NanoboxJitBundle; // jit-bundle.js (importScripts'd before this file); only needed for bundles

  const state = { table: null, memory: null, fns: new Map(), free: [], installed: 0, released: 0, bytes: 0, compileMs: 0, level: 0, threshold: 0, ok: false,
    // bundles
    bundle: new Map(),      // content key string -> { mod, keys, funcKeys, inst, fail } (compiled by preload, instantiated on first lookup)
    bundleLink: null,       // { mod, keys, bytes, slot } from the bundle, pinned by install()
    link: null, linkReuse: 0, // { slot, rec, inst }: the pinned link function; installs answered with its slot
    batches: 0,             // slot-5 (multi-function module) installs
    bundleFns: new Map(),   // content key string -> table index (instantiated; permanent slots)
    bundleSlots: new Set(),
    bundleHits: 0, bundleMisses: 0, bundleInst: 0, bundleModules: 0, bundleFiles: 0, bundleLoadMs: 0, bundleInstMs: 0, bundleTag: null,
    // optional recording of what the engine installs (cfg.record): [{bytes, keys, funcKeys}] -> exportBundle()
    record: false, records: [], fnRecord: new Map() };

  // Fetch + compile bundle files. `engineTag` is the tag of the engine that will run (string, or a
  // promise of one — the worker computes it from the engine bytes while they download); a bundle
  // whose tag differs is refused (warn + ignore). Resolves to { files, modules, keys, ms } once
  // every module is compiled; install() then answers lookup from state.bundle.
  async function preload(urls, engineTag) {
    const t = performance.now();
    const tag = await Promise.resolve(engineTag);
    const get = (u) => (global.NanoboxCache ? global.NanoboxCache.fetchValidated(u) : fetch(u, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); }));
    const files = await Promise.all((urls || []).map((u) => get(u)
      .then((buf) => ({ u, buf }))
      .catch((e) => { console.warn(`[nanobox-jit] bundle ${u}: ${e.message}, ignored`); return null; })));
    for (const f of files) {
      if (!f) continue;
      let b;
      try { b = B().decode(f.buf); } catch (e) { console.warn(`[nanobox-jit] bundle ${f.u}: ${e.message}, ignored`); continue; }
      if (tag && b.tag !== tag) { console.warn(`[nanobox-jit] bundle ${f.u}: engine tag ${b.tag} != ${tag} (different engine build), ignored`); continue; }
      if (b.linkSlot && state.bundleLink && state.bundleLink.slot !== b.linkSlot) { console.warn(`[nanobox-jit] bundle ${f.u}: link slot ${b.linkSlot} != ${state.bundleLink.slot} of an earlier bundle, ignored`); continue; }
      if (!tag) console.warn(`[nanobox-jit] bundle ${f.u}: no engine tag to check against, trusting it (tag ${b.tag})`);
      state.bundleFiles++; state.bundleTag = b.tag;
      const mods = await Promise.all(b.modules.map((m) => WebAssembly.compile(m.bytes).catch((e) => { console.warn(`[nanobox-jit] bundle ${f.u}: module rejected: ${e.message}`); return null; })));
      let dup = 0;
      for (let i = 0; i < b.modules.length; i++) {
        if (!mods[i]) continue;
        const m = b.modules[i];
        if (m.funcKeys.length === 1 && B().isLinkKey(...m.funcKeys[0])) { // the shared link function (same in every bundle of a build)
          if (!state.bundleLink) state.bundleLink = { mod: mods[i], keys: m.keys, bytes: m.bytes, slot: b.linkSlot };
          continue;
        }
        const entry = { mod: mods[i], keys: m.keys, funcKeys: m.funcKeys, inst: null, fail: false };
        let used = false;
        for (const [lo, hi] of m.funcKeys) {
          if (!lo && !hi) continue;
          const ks = B().keyString(lo, hi);
          if (state.bundle.has(ks)) { dup++; continue; } // first bundle wins (kernel before image)
          state.bundle.set(ks, entry); used = true;
        }
        if (used) state.bundleModules++;
      }
      console.log(`[nanobox-jit] bundle ${f.u}: ${b.modules.length} modules, ${state.bundle.size} keys total${dup ? ` (${dup} duplicates skipped)` : ""}${b.linkSlot ? `, link fn @${b.linkSlot}` : ""}`);
    }
    state.bundleLoadMs = performance.now() - t;
    return { files: state.bundleFiles, modules: state.bundleModules, keys: state.bundle.size, ms: Math.round(state.bundleLoadMs) };
  }

  // Install the hooks. `inst` is the engine instance; `cfg` = { level, threshold, maxlen?, region?, record? }.
  function install(inst, cfg) {
    const ex = inst.exports;
    if (!ex.nanobox_hook_slot || !ex.__indirect_function_table) return false;
    const table = ex.__indirect_function_table, memory = ex.memory;
    state.table = table; state.memory = memory;
    state.record = !!(cfg && cfg.record);
    const allocSlot = () => {
      // grow the table in big chunks (per-call table.grow is O(table size) in V8)
      if (!state.free.length) { const base = table.grow(65536); for (let k = 65535; k >= 0; k--) state.free.push(base + k); }
      return state.free.pop();
    };
    const imports = (keys) => {
      const h = {}; for (let i = 0; i < keys.length; i++) h[String(i)] = table.get(keys[i]);
      return { e: { m: memory, t: table }, h };
    };
    // pin the link function at `want` (0 = wherever the first free slot is); it is never released
    const pinLink = (rec, ins, want) => {
      const slot = allocSlot();
      if (want && slot !== want) { state.free.push(slot); return 0; }
      table.set(slot, ins.exports.r);
      state.link = { slot, rec, inst: ins };
      return slot;
    };
    if (state.bundleLink) {
      const bl = state.bundleLink; let ok = 0;
      try { ok = pinLink({ bytes: bl.bytes, keys: bl.keys, funcKeys: [B().LINK_KEY.slice()] }, new WebAssembly.Instance(bl.mod, imports(bl.keys)), bl.slot); }
      catch (e) { console.error("[nanobox-jit] bundle link module failed to instantiate:", e.message); }
      if (!ok) { console.warn(`[nanobox-jit] cannot pin the link function at slot ${bl.slot} (table length ${table.length}); bundles disabled`); state.bundle.clear(); state.bundleModules = 0; }
    }
    // slot 0 / slot 5: instantiate the module at [ptr,len) with imports h.i = table[keys[i]] and put
    // its function exports `names` into fresh slots; returns their indices (or null)
    let nInstalls = 0;
    const instantiate = (ptr, len, keysPtr, n, names) => {
      const bytes = new Uint8Array(memory.buffer, ptr, len).slice();
      const keys = new Uint32Array(memory.buffer, keysPtr, n).slice();
      if (state.link && names.length === 1 && B().sameBytes(bytes, state.link.rec.bytes)) { state.linkReuse++; return [state.link.slot]; }
      let ins;
      const tc0 = performance.now();
      try {
        const mod = new WebAssembly.Module(bytes);
        ins = new WebAssembly.Instance(mod, imports(keys));
      } catch (err) {
        console.error("[nanobox-jit] module rejected:", err.message);
        return null;
      }
      state.compileMs += performance.now() - tc0;
      // the record keeps the bytes only when recording (exportBundle); the link module always (byte compare)
      const first = nInstalls++ === 0;
      const rec = state.record || first ? { bytes, keys, funcKeys: names.map(() => [0, 0]) } : null;
      if (rec && state.record) state.records.push(rec);
      state.installed += names.length; state.bytes += len;
      if (!state.link && names.length === 1 && first) {
        // first install of the run: the engine's link function
        const slot = pinLink(rec, ins, 0);
        state.fnRecord.set(slot, { rec, i: 0 });
        return [slot];
      }
      const idxs = [];
      for (let i = 0; i < names.length; i++) {
        const f = ins.exports[names[i]];
        if (typeof f !== "function") { console.error("[nanobox-jit] module has no export " + names[i]); for (const idx of idxs) { table.set(idx, null); state.free.push(idx); state.fns.delete(idx); } return null; }
        const idx = allocSlot();
        table.set(idx, f);
        state.fns.set(idx, ins);
        if (rec) state.fnRecord.set(idx, { rec, i });
        idxs.push(idx);
      }
      return idxs;
    };
    const installFn = (ptr, len, keysPtr, n) => { const r = instantiate(ptr, len, keysPtr, n, ["r"]); return r ? r[0] : 0; };
    const installBatchFn = (ptr, len, keysPtr, n, nfuncs, outPtr) => {
      if (len === 0 && nfuncs === 0) return 1; // capability probe: the placeholder answers 0, a host 1
      const names = []; for (let i = 0; i < nfuncs; i++) names.push("f" + i);
      const r = instantiate(ptr, len, keysPtr, n, names);
      if (!r) return 0;
      const dv = new DataView(memory.buffer); for (let i = 0; i < nfuncs; i++) dv.setUint32(outPtr + 4 * i, r[i], true);
      state.batches++;
      return 1;
    };
    // bundle slots are permanent: never nulled, never recycled
    const releaseFn = (idx) => { if (state.fns.delete(idx)) { table.set(idx, null); state.free.push(idx); state.released++; state.fnRecord.delete(idx); } };
    const releaseAllFn = () => { for (const idx of state.fns.keys()) { table.set(idx, null); state.free.push(idx); state.released++; state.fnRecord.delete(idx); } state.fns.clear(); };
    const noteFn = (fn, lo, hi) => {
      const r = state.fnRecord.get(fn); if (!r) return;
      r.rec.funcKeys[r.i] = [lo >>> 0, hi >>> 0];
      if (B().isLinkKey(lo, hi) && !(state.link && state.link.slot === fn)) { state.link = { slot: fn, rec: r.rec, inst: state.fns.get(fn) }; state.fns.delete(fn); } // explicit: permanent from now on
    };
    // lookup: instantiating a bundle module binds ALL its exports and registers all their keys, so
    // sibling regions of a batch module are map hits afterwards
    const lookupFn = (lo, hi) => {
      if (B().isLinkKey(lo, hi)) return state.link ? state.link.slot : 0;
      const ks = B().keyString(lo, hi);
      let idx = state.bundleFns.get(ks);
      if (idx === undefined) {
        const entry = state.bundle.get(ks);
        if (entry && !entry.inst && !entry.fail) {
          const t = performance.now();
          try { entry.inst = new WebAssembly.Instance(entry.mod, imports(entry.keys)); }
          catch (err) { entry.fail = true; console.error("[nanobox-jit] bundle module failed to instantiate:", err.message); }
          if (entry.inst) {
            const names = WebAssembly.Module.exports(entry.mod).filter((e) => e.kind === "function").map((e) => e.name);
            for (let i = 0; i < names.length && i < entry.funcKeys.length; i++) {
              const [flo, fhi] = entry.funcKeys[i];
              if (!flo && !fhi) continue;
              const fks = B().keyString(flo, fhi);
              if (state.bundleFns.has(fks)) continue;
              const s = allocSlot();
              table.set(s, entry.inst.exports[names[i]]);
              state.bundleSlots.add(s); state.bundleFns.set(fks, s);
            }
            state.bundleInst++;
          }
          state.bundleInstMs += performance.now() - t;
          idx = state.bundleFns.get(ks);
        }
      }
      if (idx === undefined) { state.bundleMisses++; return 0; }
      state.bundleHits++;
      return idx;
    };
    table.set(ex.nanobox_hook_slot(0), trampoline([0x7f, 0x7f, 0x7f, 0x7f], [0x7f], installFn));
    table.set(ex.nanobox_hook_slot(1), trampoline([0x7f], [], releaseFn));
    table.set(ex.nanobox_hook_slot(2), trampoline([], [], releaseAllFn));
    if (ex.nanobox_hook_slot(3)) table.set(ex.nanobox_hook_slot(3), trampoline([0x7f, 0x7f], [0x7f], lookupFn));
    if (ex.nanobox_hook_slot(4)) table.set(ex.nanobox_hook_slot(4), trampoline([0x7f, 0x7f, 0x7f], [], noteFn));
    if (ex.nanobox_hook_slot(5)) table.set(ex.nanobox_hook_slot(5), trampoline([0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f], [0x7f], installBatchFn));
    if (state.bundle.size && !ex.nanobox_hook_slot(3)) console.warn("[nanobox-jit] engine has no lookup hook (slot 3): preloaded bundles are unused");
    const level = cfg && cfg.level != null ? cfg.level : 2;
    const threshold = cfg && cfg.threshold != null ? cfg.threshold : 0;
    ex.nanobox_set_jit(level, threshold);
    if (cfg && cfg.maxlen && ex.nanobox_set_jit_maxlen) ex.nanobox_set_jit_maxlen(cfg.maxlen);
    if (cfg && cfg.region != null && ex.nanobox_set_jit_region) ex.nanobox_set_jit_region(cfg.region); // max blocks per region (0/1 = single traces only)
    state.level = level; state.threshold = threshold; state.ok = true;
    return true;
  }

  // With cfg.record: the modules the engine installed in this session as a bundle (Uint8Array,
  // jit-bundle.js format) — the browser equivalent of the harness' --jit-bundle-out.
  function exportBundle(engineTag) {
    let linkSlot = 0;
    if (state.link) {
      const k = state.link.rec.funcKeys[0];
      if (!k[0] && !k[1]) state.link.rec.funcKeys[0] = B().LINK_KEY.slice();
      if (B().isLinkKey(...state.link.rec.funcKeys[0])) linkSlot = state.link.slot;
    }
    const recs = state.records.filter((r) => r.funcKeys.some(([lo, hi]) => lo || hi));
    if (linkSlot && !recs.includes(state.link.rec)) recs.unshift(state.link.rec);
    return B().encode(recs, engineTag || state.bundleTag || "", linkSlot);
  }

  // Engine counters, for the page's live status line.
  function stats(inst) {
    const ex = inst.exports;
    const u64 = (lo, hi) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    const out = { installed: state.installed, batches: state.batches, released: state.released, live: state.fns.size, bytes: state.bytes, compileMs: Math.round(state.compileMs), level: state.level, threshold: state.threshold };
    if (state.link) out.linkSlot = state.link.slot, out.linkReuse = state.linkReuse;
    if (state.bundleFiles || state.bundle.size) Object.assign(out, { bundleHits: state.bundleHits, bundleMisses: state.bundleMisses, bundleInst: state.bundleInst, bundleModules: state.bundleModules, bundleFiles: state.bundleFiles, bundleLoadMs: Math.round(state.bundleLoadMs), bundleInstMs: Math.round(state.bundleInstMs) });
    if (ex.nanobox_icount_lo) {
      out.icount = u64(ex.nanobox_icount_lo(), ex.nanobox_icount_hi()).toString();
      out.ticks = u64(ex.nanobox_ticks_lo(), ex.nanobox_ticks_hi()).toString();
    }
    if (ex.nanobox_stat) out.traces = ex.nanobox_stat(2), out.jitTraces = ex.nanobox_stat(3), out.compiled = ex.nanobox_stat(4);
    return out;
  }

  global.NanoboxJit = { install, preload, exportBundle, stats, state, trampoline };
})(self);
