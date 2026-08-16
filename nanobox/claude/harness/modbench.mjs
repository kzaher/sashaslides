// Micro-benchmark: what does one JIT trace module cost the host (compile / instantiate / first call)?
// usage: node [v8 flags] modbench.mjs <dir-with-tNNNNNN.wasm> [count]
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const count = Number(process.argv[3] || 5000);
const files = fs.readdirSync(dir).filter((f) => f.startsWith("t")).sort().slice(0, count);
const mods = files.map((f) => fs.readFileSync(path.join(dir, f)));
const memory = new WebAssembly.Memory({ initial: 256, maximum: 65536 });
const table = new WebAssembly.Table({ initial: 4096, element: "anyfunc" });
let bytes = 0, imports = 0;
// helper stubs: any imported name gets a no-op of the right signature by parsing the import section
function parseImports(b) {
  // returns [{mod,name,typeIdx}] and types
  let p = 8; const rd = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  const types = []; const imps = [];
  while (p < b.length) {
    const id = b[p++]; const len = rd(); const end = p + len;
    if (id === 1) { const n = rd(); for (let i = 0; i < n; i++) { p++; const np = rd(); const params = []; for (let k = 0; k < np; k++) params.push(b[p++]); const nr = rd(); const res = []; for (let k = 0; k < nr; k++) res.push(b[p++]); types.push({ params, res }); } }
    else if (id === 2) { const n = rd(); for (let i = 0; i < n; i++) { const ml = rd(); const mod = String.fromCharCode(...b.subarray(p, p + ml)); p += ml; const nl = rd(); const name = String.fromCharCode(...b.subarray(p, p + nl)); p += nl; const kind = b[p++]; if (kind === 0) { const t = rd(); imps.push({ mod, name, t }); } else { p = end; break; } } }
    p = end;
  }
  return { types, imps };
}
const stubCache = new Map();
function stubFor(type) {
  const key = type.params.join(",") + "->" + type.res.join(",");
  if (stubCache.has(key)) return stubCache.get(key);
  // build a tiny wasm function returning zeros
  const sec = (id, body) => [id, ...uleb(body.length), ...body];
  const uleb = (v) => { const out = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; out.push(x); } while (v); return out; };
  const body = [];
  for (const r of type.res) body.push(r === 0x7e ? 0x42 : 0x41, 0);
  body.push(0x0b);
  const t = [0x60, ...uleb(type.params.length), ...type.params, ...uleb(type.res.length), ...type.res];
  const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [1, ...t]), ...sec(3, [1, 0]), ...sec(7, [1, 1, 0x66, 0x00, 0]), ...sec(10, [1, ...uleb(body.length + 1), 0, ...body])]);
  const f = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.f;
  stubCache.set(key, f);
  return f;
}
const t0 = performance.now();
const compiled = [];
for (const b of mods) { bytes += b.length; compiled.push(new WebAssembly.Module(b)); }
const t1 = performance.now();
const insts = [];
for (let i = 0; i < mods.length; i++) {
  const h = {}; for (const im of WebAssembly.Module.imports(compiled[i])) if (im.kind === "function") { imports++; h[im.name] = () => 0; }
  insts.push(new WebAssembly.Instance(compiled[i], { e: { m: memory, t: table }, h }));
}
const t2 = performance.now();
let traps = 0;
for (const ins of insts) { try { ins.exports.r(0); } catch (e) { traps++; } }
const t3 = performance.now();
for (const ins of insts) { try { ins.exports.r(0); } catch (e) { traps++; } }
const t4 = performance.now();
const n = mods.length;
console.log(`n=${n} avgBytes=${(bytes / n).toFixed(0)} avgImports=${(imports / n).toFixed(1)}`);
console.log(`Module:   ${(t1 - t0).toFixed(0)} ms  (${((t1 - t0) * 1000 / n).toFixed(1)} us/mod)`);
console.log(`Instance: ${(t2 - t1).toFixed(0)} ms  (${((t2 - t1) * 1000 / n).toFixed(1)} us/mod)`);
console.log(`1st call: ${(t3 - t2).toFixed(0)} ms  (${((t3 - t2) * 1000 / n).toFixed(1)} us/mod)  traps=${traps}`);
console.log(`2nd call: ${(t4 - t3).toFixed(0)} ms  (${((t4 - t3) * 1000 / n).toFixed(1)} us/mod)`);
