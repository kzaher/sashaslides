#!/usr/bin/env node
// Unit test of the browser JIT host (web/jit-host.js + web/jit-bundle.js) against a FAKE engine:
// a memory + function table + the nanobox_hook_slot()/nanobox_set_jit() exports the host expects.
// The trampolines the host installs are real wasm functions, so calling table.get(slot)(...) from
// here exercises exactly the path the engine takes — including slot 5 (install_batch), which the
// engine build may not call yet, and the bundle round trip (record -> exportBundle -> preload ->
// lookup) with the link-function pinning.
//
//   node test/jit-host-unit.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

globalThis.self = globalThis;
const HERE = path.dirname(new URL(import.meta.url).pathname);
await import(pathToFileURL(path.join(HERE, "../web/jit-bundle.js")).href);
const B = NanoboxJitBundle;

// ---- tiny wasm assembler for the test modules -----------------------------------------------
function uleb(v) { const out = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; out.push(x); } while (v); return out; }
function sleb(v) { const out = []; for (;;) { const x = v & 0x7f; v >>= 7; if ((v === 0 && !(x & 0x40)) || (v === -1 && (x & 0x40))) { out.push(x); return out; } out.push(x | 0x80); } }
const str = (s) => [s.length, ...Buffer.from(s)];
const sec = (id, content) => [id, ...uleb(content.length), ...content];
// module: (import "e" "m" memory) (import "e" "t" table) (import "h" "0" (func (i32)->()))
//         (func $fk (param i32) local.get 0; i32.const k+base; i32.add; call $h0)  exported as names[k]
function traceModule(names, base) {
  const type = [0x60, 1, 0x7f, 0];
  const imports = [3, ...str("e"), ...str("m"), 0x02, 0x00, 0x01, ...str("e"), ...str("t"), 0x01, 0x70, 0x00, 0x00, ...str("h"), ...str("0"), 0x00, 0x00];
  const funcs = [names.length, ...names.map(() => 0)];
  const exports = [names.length, ...names.flatMap((n, k) => [...str(n), 0x00, 1 + k])];
  const bodies = names.map((_, k) => { const body = [0, 0x20, 0, 0x41, ...sleb(base + k), 0x6a, 0x10, 0x00, 0x0b]; return [...uleb(body.length), ...body]; });
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [1, ...type]), ...sec(2, imports), ...sec(3, funcs), ...sec(7, exports), ...sec(10, [names.length, ...bodies.flat()])]);
}
// a wasm function (i32)->() that records its argument (table.set only takes wasm functions)
function recorder(calls) {
  const type = [0x60, 1, 0x7f, 0];
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [1, ...type]), ...sec(2, [1, ...str("js"), ...str("f"), 0, 0]), ...sec(3, [1, 0]), ...sec(7, [1, ...str("f"), 0, 1]), ...sec(10, [1, 6, 0, 0x20, 0, 0x10, 0, 0x0b])]);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { js: { f: (x) => calls.push(x) } }).exports.f;
}

// ---- fake engine ---------------------------------------------------------------------------------
const HOOKS = 6, HELPER = 8, TABLE0 = 16; // hook slots 1..6, helper at 8, table initial length 16
function fakeEngine(calls) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const table = new WebAssembly.Table({ initial: TABLE0, element: "anyfunc" });
  table.set(HELPER, recorder(calls));
  const jit = {};
  return { exports: { memory, __indirect_function_table: table, nanobox_hook_slot: (k) => (k < HOOKS ? k + 1 : 0), nanobox_set_jit: (l, t) => { jit.level = l; jit.threshold = t; }, nanobox_set_jit_region: (n) => { jit.region = n; } }, jit };
}
let heapTop = 1024;
function put(memory, bytes) { const p = heapTop; new Uint8Array(memory.buffer).set(bytes, p); heapTop += bytes.length + 8 & ~7; return p; }
const hook = (eng, k) => eng.exports.__indirect_function_table.get(k + 1);
async function freshHost(tag) { await import(pathToFileURL(path.join(HERE, "../web/jit-host.js")).href + "?" + tag); return globalThis.NanoboxJit; }

// ================================================================================================
// phase A: record (like harness --jit-bundle-out): link fn pin, install, install_batch, note, release
const callsA = [];
const engA = fakeEngine(callsA);
const hostA = await freshHost("A");
assert.equal(hostA.install(engA, { level: 2, threshold: 7, record: true }), true);
assert.deepEqual(engA.jit, { level: 2, threshold: 7 });
const memA = engA.exports.memory, tabA = engA.exports.__indirect_function_table;
const keysPtr = put(memA, new Uint8Array(new Uint32Array([HELPER]).buffer));
const install = (eng, bytes) => { const p = put(eng.exports.memory, bytes); return hook(eng, 0)(p, bytes.length, keysPtr, 1); };
// 1. the first install is the link function -> pinned at the table's initial length
const linkBytes = traceModule(["r"], 1000);
const linkSlot = install(engA, linkBytes);
assert.equal(linkSlot, TABLE0, "link fn pinned at the first free slot");
assert.equal(hostA.state.link.slot, linkSlot);
tabA.get(linkSlot)(1); assert.deepEqual(callsA.splice(0), [1001]);
// re-installing byte-identical bytes answers the pinned slot, no new instance
assert.equal(install(engA, linkBytes), linkSlot); assert.equal(hostA.state.linkReuse, 1);
// 2. plain install + note
const t1 = install(engA, traceModule(["r"], 100));
assert.notEqual(t1, 0); tabA.get(t1)(5); assert.deepEqual(callsA.splice(0), [105]);
hook(engA, 4)(t1, 0x11111111, 0x22222222);
// 3. batch install (slot 5): f0..f2, indices written at outPtr
const outPtr = put(memA, new Uint8Array(16));
const bb = traceModule(["f0", "f1", "f2"], 200);
const bp = put(memA, bb);
assert.equal(hook(engA, 5)(0, 0, 0, 0, 0, 0), 1, "capability probe");
assert.equal(hook(engA, 5)(bp, bb.length, keysPtr, 1, 3, outPtr), 1);
const out = Array.from(new Uint32Array(memA.buffer, outPtr, 3));
assert.ok(out.every((x) => x > 0) && new Set(out).size === 3, "three distinct slots: " + out);
out.forEach((fn, k) => tabA.get(fn)(10)); assert.deepEqual(callsA.splice(0), [210, 211, 212]);
out.forEach((fn, k) => hook(engA, 4)(fn, 0xa0 + k, 0xb0 + k));
assert.equal(hostA.state.batches, 1);
// 4. release / releaseAll: link slot untouched, others recycled
hook(engA, 1)(t1); assert.equal(tabA.get(t1), null); assert.equal(hostA.state.released, 1);
hook(engA, 2)(); assert.equal(tabA.get(out[0]), null); assert.notEqual(tabA.get(linkSlot), null);
hook(engA, 1)(linkSlot); assert.notEqual(tabA.get(linkSlot), null, "link slot survives release");
// lookup on the recording host: no bundle -> 0 (and LINK_KEY -> the pinned slot)
assert.equal(hook(engA, 3)(0x11111111, 0x22222222), 0);
assert.equal(hook(engA, 3)(...B.LINK_KEY), linkSlot);
const st = hostA.stats(engA);
assert.equal(st.installed, 5); assert.equal(st.linkSlot, linkSlot);
// 5. export the bundle: link module + t1 + batch (released ones included)
const bundle = hostA.exportBundle("engine-X");
const dec = B.decode(bundle);
assert.equal(dec.tag, "engine-X"); assert.equal(dec.linkSlot, linkSlot); assert.equal(dec.modules.length, 3);
assert.deepEqual(dec.modules[0].funcKeys, [B.LINK_KEY]);
assert.deepEqual(dec.modules[2].funcKeys, [[0xa0, 0xb0], [0xa1, 0xb1], [0xa2, 0xb2]]);
console.log("phase A ok: link @" + linkSlot + ", bundle " + bundle.length + " bytes, " + dec.modules.length + " modules");

// ================================================================================================
// phase B: replay (like harness --jit-bundle / the worker): preload, pin, lookup, no compile
const callsB = [];
const engB = fakeEngine(callsB);
const hostB = await freshHost("B");
const served = { "http://x/a.nbjb": bundle, "http://x/bad.nbjb": B.encode([], "engine-Y", 0), "http://x/junk.nbjb": new Uint8Array([1, 2, 3]) };
globalThis.fetch = async (u) => (u in served ? new Response(served[u]) : new Response("nope", { status: 404 }));
const pre = await hostB.preload(["http://x/missing.nbjb", "http://x/junk.nbjb", "http://x/bad.nbjb", "http://x/a.nbjb"], Promise.resolve("engine-X"));
assert.deepEqual([pre.files, pre.modules, pre.keys], [1, 2, 4], JSON.stringify(pre));
assert.equal(hostB.install(engB, { level: 2, threshold: 2 }), true);
const tabB = engB.exports.__indirect_function_table;
assert.equal(hostB.state.link.slot, linkSlot, "link fn pinned from the bundle before any install");
tabB.get(linkSlot)(2); assert.deepEqual(callsB.splice(0), [1002]);
// the engine's own install of the link fn -> the pinned slot
assert.equal(install(engB, linkBytes), linkSlot); assert.equal(hostB.state.installed, 0);
// lookup of a batch sibling instantiates the module once and binds all three
const f1 = hook(engB, 3)(0xa1, 0xb1);
assert.notEqual(f1, 0); tabB.get(f1)(1); assert.deepEqual(callsB.splice(0), [202]);
assert.equal(hostB.state.bundleInst, 1);
const f0 = hook(engB, 3)(0xa0, 0xb0), f2 = hook(engB, 3)(0xa2, 0xb2);
assert.equal(hostB.state.bundleInst, 1, "siblings are map hits");
tabB.get(f0)(0); tabB.get(f2)(0); assert.deepEqual(callsB.splice(0), [200, 202]);
const g = hook(engB, 3)(0x11111111, 0x22222222); tabB.get(g)(1); assert.deepEqual(callsB.splice(0), [101]);
assert.equal(hook(engB, 3)(1, 2), 0, "unknown key misses");
// release / releaseAll never touch bundle slots; a re-lookup answers the same slot
hook(engB, 1)(f1); hook(engB, 2)();
assert.notEqual(tabB.get(f1), null); assert.equal(hook(engB, 3)(0xa1, 0xb1), f1);
const sb = hostB.stats(engB);
assert.equal(sb.bundleHits, 5); assert.equal(sb.bundleMisses, 1); assert.equal(sb.bundleInst, 2); assert.equal(sb.bundleModules, 2);
console.log("phase B ok: " + JSON.stringify({ hits: sb.bundleHits, misses: sb.bundleMisses, inst: sb.bundleInst, linkSlot: sb.linkSlot }));

// tag mismatch: everything refused
const hostC = await freshHost("C");
const preC = await hostC.preload(["http://x/a.nbjb"], "engine-Z");
assert.deepEqual([preC.files, preC.modules], [0, 0]);
console.log("phase C ok: mismatching engine tag refused");
console.log("ALL OK");
