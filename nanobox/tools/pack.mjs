#!/usr/bin/env node
// Production packing: assemble a self-contained `dist/` (or --out DIR) that serves everything the
// browser needs with `node dist/serve.mjs [--port N]` — no build tools, no docker, no repo:
//   dist/serve.mjs                 the static server + /net/fetch relay (allow-listed), same code
//   dist/web/                      pages, workers, native runtime (runtime.js), shim (nbnode), specs, results
//   dist/engine/opt/{out.wasm.gzip,slim/out.wasm.gzip,jit/*.nbjb}, dist/engine/imagemounter.wasm.gzip
//   dist/public/c2w/               the ORIGINAL container2wasm runtime (engine, workers, vendor) + images
//   dist/extension/                the proxy extension (load unpacked)
//   dist/package.json              {start: "node serve.mjs"}, dist/README.md, dist/MANIFEST.json (files + sizes)
// Options:
//   --out DIR            default dist/
//   --images LIST        which OCI images to include: default "linux-base,base" (sandbox pages);
//                        "all" = also codex,agy,claude,claude-npm (the identity compare pages; +300 MB)
//   --no-bundles         skip the precomputed JIT bundles (build/eh-nb/jit/*.nbjb)
//   --tar                also write dist.tar.gz next to the dir
//   --check              after packing, start the packed server on a free port and GET the key URLs
// Everything copied must already exist (npm run build / build:engine / build:bundles first).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(opt("--out", "dist"));
const IMAGES = opt("--images", "linux-base,base") === "all" ? ["linux-base", "base", "codex", "agy", "claude", "claude-npm"] : opt("--images", "linux-base,base").split(",").filter(Boolean);
const NO_BUNDLES = argv.includes("--no-bundles");
const missing = [];
const need = (p, what) => { if (!existsSync(p)) missing.push(`${what}: ${relative(HERE, p)}`); return existsSync(p); };
const copy = (src, dst, filter) => { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst, { recursive: true, dereference: true, filter }); };

rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
// server
copy(join(HERE, "serve.mjs"), join(OUT, "serve.mjs"));
// pages + workers + native runtime + shim (skip node_modules, sources of the runtime, maps, big vendor JS we don't serve)
copy(join(HERE, "web"), join(OUT, "web"), (p) => !/\/(node_modules|src)(\/|$)|\.map$|\/claude-cli\.js$|package(-lock)?\.json$|build\.mjs$/.test(p));
need(join(HERE, "web/native/runtime.js"), "native runtime (npm run build:runtime)");
need(join(HERE, "web/native/nbnode"), "guest node shim (npm run build:shim)");
// engines
const eng = join(HERE, "build/eh-nb");
if (need(join(eng, "out.wasm.gzip"), "optimized engine (npm run build:engine + build:after)")) copy(join(eng, "out.wasm.gzip"), join(OUT, "engine/opt/out.wasm.gzip"));
if (existsSync(join(eng, "out-slim.wasm.gzip"))) copy(join(eng, "out-slim.wasm.gzip"), join(OUT, "engine/opt/slim/out.wasm.gzip"));
// JIT bundles: the kernel one always, per-image ones only for the images shipped (claude's alone is 105 MB)
if (!NO_BUNDLES && existsSync(join(eng, "jit"))) copy(join(eng, "jit"), join(OUT, "engine/opt/jit"), (p) => { const m = /([^/]+)\.nbjb$/.exec(p); return !m || m[1] === "kernel" || IMAGES.includes(m[1]); });
if (existsSync(join(HERE, "build/imagemounter-nb.wasm.gzip"))) copy(join(HERE, "build/imagemounter-nb.wasm.gzip"), join(OUT, "engine/imagemounter.wasm.gzip"));
// original runtime (container2wasm) + images
const c2w = join(HERE, "public/c2w");
for (const f of ["dist", "vendor", "wasi", "index.html", "wasi-worker.js", "imagemounter.wasm.gzip"]) if (need(join(c2w, f), "container2wasm runtime (vm-build)")) copy(join(c2w, f), join(OUT, "public/c2w", f));
for (const img of IMAGES) if (need(join(c2w, "images", img), `image ${img} (npm run build:images / vm-build)`)) copy(join(c2w, "images", img), join(OUT, "public/c2w/images", img));
// extension
copy(join(HERE, "extension"), join(OUT, "extension"));
// serve.mjs in dist resolves everything relative to itself: engine dir + c2w dir + web dir
// (the repo layout is build/eh-nb/... and public/c2w; the packed layout is engine/... and public/c2w)
let srv = (await import("node:fs")).readFileSync(join(OUT, "serve.mjs"), "utf8");
srv = srv.replace('opt("--engine", "build/eh-nb/out.wasm.gzip")', 'opt("--engine", "engine/opt/out.wasm.gzip")')
         .replace('opt("--jit-dir", "build/eh-nb/jit")', 'opt("--jit-dir", "engine/opt/jit")')
         .replace('opt("--mounter", "build/imagemounter-nb.wasm.gzip")', 'opt("--mounter", "engine/imagemounter.wasm.gzip")')
         .replace(/out-slim\.wasm\.gzip/g, "slim/out.wasm.gzip");
writeFileSync(join(OUT, "serve.mjs"), srv);
writeFileSync(join(OUT, "package.json"), JSON.stringify({ name: "nanobox-dist", private: true, type: "module", scripts: { start: "node serve.mjs" }, engines: { node: ">=20" } }, null, 2) + "\n");
writeFileSync(join(OUT, "README.md"), `# nanobox — packed distribution\n\n\`npm start\` (or \`node serve.mjs [--port 8093]\`) then open http://localhost:8093/ .\nPages: index (compare pages codex/agy/claude, sandbox pages), extension/ (load unpacked in Chrome for proxy-less egress).\nImages included: ${IMAGES.join(", ")}. The relay (/net/fetch) only forwards to the hosts in web/netpolicy.js.\n`);
// manifest
const files = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const st = statSync(p); if (st.isDirectory()) walk(p); else files.push({ path: relative(OUT, p), bytes: st.size }); } }; walk(OUT);
const total = files.reduce((s, f) => s + f.bytes, 0);
writeFileSync(join(OUT, "MANIFEST.json"), JSON.stringify({ created: new Date().toISOString(), images: IMAGES, files: files.length, bytes: total, entries: files }, null, 1));
console.log(`packed ${files.length} files, ${(total / 1e6).toFixed(1)} MB -> ${OUT}`);
for (const g of [["engine", /^engine\//], ["web", /^web\//], ["c2w runtime", /^public\/c2w\/(?!images)/], ["images", /^public\/c2w\/images\//], ["extension", /^extension\//]]) console.log(`  ${g[0].padEnd(12)} ${(files.filter((f) => g[1].test(f.path)).reduce((s, f) => s + f.bytes, 0) / 1e6).toFixed(1)} MB`);
if (missing.length) { console.log("MISSING (build first):\n  " + missing.join("\n  ")); }
if (argv.includes("--tar")) { execSync(`tar -C ${dirname(OUT)} -czf ${OUT}.tar.gz ${relative(dirname(OUT), OUT)}`); console.log("wrote " + OUT + ".tar.gz " + (statSync(OUT + ".tar.gz").size / 1e6).toFixed(1) + " MB"); }
if (argv.includes("--check")) {
  const port = 8100 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ["serve.mjs", "--port", String(port)], { cwd: OUT, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((r) => setTimeout(r, 1200));
  let ok = true;
  for (const u of ["/", "/codex.html", "/sandbox.html", "/engine/opt/out.wasm.gzip", "/engine/opt/slim/out.wasm.gzip", "/engine/imagemounter.wasm.gzip", "/engine/opt/jit/index.json", "/native/runtime.js", "/native/nbnode", "/netpolicy.js", "/proxyext.js", `/c2w/images/${IMAGES[0]}/index.json`, "/c2w/dist/worker-util.js"]) {
    try { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: "HEAD" }); console.log(`  ${r.ok ? "ok " : "FAIL"} ${r.status} ${u}`); if (!r.ok) ok = false; } catch (e) { console.log(`  FAIL ${u}: ${e.message}`); ok = false; }
  }
  child.kill();
  if (!ok) process.exit(1);
}
if (missing.length) process.exit(2);
