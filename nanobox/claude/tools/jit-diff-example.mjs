// Show the SAME guest trace compiled by two engine variants (bundles recorded with --jit-bundle-out):
// bundles are keyed by the content hash of the decoded x86 instructions, so a key present in both
// names the same trace. Prints the WAT of the smallest function pair whose text differs (or the pair
// for --key hi:lo). Usage: node tools/jit-diff-example.mjs A.nbjb B.nbjb [--grep REGEX] [--key K] [--out DIR]
import fs from "fs"; import path from "path"; import wabtInit from "wabt";
await import("../web/jit-bundle.js");
const B = globalThis.NanoboxJitBundle;
const argv = process.argv.slice(2); const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const [fa, fb] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const grep = opt("--grep") ? new RegExp(opt("--grep")) : null, wantKey = opt("--key"), out = opt("--out");
const wabt = await wabtInit();
const feats = { exceptions: true, multi_value: true, sign_extension: true, bulk_memory: true, mutable_globals: true, tail_call: true };
function funcs(bundle) { // key -> { wat of that function, module index, export name }
  const m = new Map();
  for (const mod of bundle.modules) {
    let wat; try { wat = wabt.readWasm(new Uint8Array(mod.bytes), feats).toText({ foldExprs: false, inlineExport: true }); } catch (e) { console.error("wabt:", String(e).slice(0, 120)); continue; }
    // split into functions by "(export "..." )" header lines
    const parts = wat.split(/\n(?=  \(func )/);
    for (const p of parts) {
      const mm = /\(export "([^"]+)"\)/.exec(p); if (!mm) continue;
      const name = mm[1]; const idx = name === "r" ? 0 : Number(name.slice(1));
      const fk = mod.funcKeys[idx]; if (!fk) continue;
      m.set(B.keyString(fk[0], fk[1]), { wat: p.replace(/\n\s*\(export[^\n]*$/, ""), name });
    }
  }
  return m;
}
const A = funcs(B.decode(fs.readFileSync(fa))), Bm = funcs(B.decode(fs.readFileSync(fb)));
console.error("functions:", A.size, Bm.size);
let best = null;
for (const [k, a] of A) {
  const b = Bm.get(k); if (!b || a.wat === b.wat) continue;
  if (wantKey && k !== wantKey) continue;
  if (grep && !grep.test(b.wat) && !grep.test(a.wat)) continue;
  const size = a.wat.length + b.wat.length;
  if (!best || size < best.size) best = { k, a, b, size };
}
if (!best) { console.log("no differing common function"); process.exit(1); }
console.log(`key ${best.k}: A ${best.a.wat.split("\n").length} lines, B ${best.b.wat.split("\n").length} lines (common keys ${[...A.keys()].filter((k) => Bm.has(k)).length})`);
if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "A.wat"), best.a.wat); fs.writeFileSync(path.join(out, "B.wat"), best.b.wat); console.log("written to", out); }
else { console.log("=== A\n" + best.a.wat + "\n=== B\n" + best.b.wat); }
