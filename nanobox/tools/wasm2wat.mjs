import wabtInit from "wabt"; import fs from "fs";
const wabt = await wabtInit();
for (const f of process.argv.slice(2)) {
  const m = wabt.readWasm(new Uint8Array(fs.readFileSync(f)), { readDebugNames: false, exceptions: true, multi_value: true, sign_extension: true, bulk_memory: true, mutable_globals: true, tail_call: true });
  fs.writeFileSync(f.replace(/\.wasm$/, ".wat"), m.toText({ foldExprs: false, inlineExport: true }));
}
