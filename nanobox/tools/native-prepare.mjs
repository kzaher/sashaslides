#!/usr/bin/env node
// Prepare Claude Code's cli.js for the native (browser V8) page from the claude-npm OCI image:
//   1. pull usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js out of the image layers
//      (the very bytes the emulated VM runs; SHA-256 recorded)
//   2. mechanical module-format transform with esbuild (no bundling, no minification, no code
//      change): ESM `import x from "fs"` -> `require("fs")` so the worker's module loader can
//      serve the Node builtins; `import.meta.url` -> the file: URL of cli.js in the image.
//      Web Workers cannot resolve bare ESM specifiers (no import maps in workers), which is the
//      only reason the transform exists.
//   -> web/native/claude-cli.js (gitignored, ~14 MB) + web/native/cli.json (version, hashes, sizes)
//
//   node tools/native-prepare.mjs [public/c2w/images/claude-npm]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "../web/native/node_modules/esbuild/lib/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(HERE, "../public/c2w/images/claude-npm");
const CLI = "usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js";
const blob = (d) => readFileSync(join(dir, "blobs", "sha256", d.split(":")[1]));
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
const manifest = JSON.parse(blob(index.manifests[0].digest).toString());

function* tarEntries(tar) {
  let off = 0, longName = null;
  const str = (o, n) => { let e = o; while (e < o + n && tar[e] !== 0) e++; return tar.toString("utf8", o, e); };
  while (off + 512 <= tar.length) {
    if (tar[off] === 0) { off += 512; continue; }
    const size = parseInt(str(off + 124, 12).trim(), 8) || 0, type = String.fromCharCode(tar[off + 156] || 48);
    let name = str(off, 100); const prefix = str(off + 345, 155); if (prefix && str(off + 257, 6).startsWith("ustar")) name = prefix + "/" + name;
    const data = tar.subarray(off + 512, off + 512 + size); off += 512 + ((size + 511) & ~511);
    if (type === "L") { longName = data.toString().replace(/\0+$/, ""); continue; }
    if (longName) { name = longName; longName = null; }
    yield { name: name.replace(/^\.?\/+/, ""), type, data };
  }
}
let src = null, layerDigest = null;
for (const l of manifest.layers) {
  const raw = blob(l.digest); const tar = /gzip/.test(l.mediaType) ? gunzipSync(raw) : raw;
  for (const e of tarEntries(tar)) if (e.name === CLI && (e.type === "0" || e.type === "\0")) { src = Buffer.from(e.data); layerDigest = l.digest; }
}
if (!src) { console.error("cli.js not found in " + dir); process.exit(1); }
const version = (/\/\/ Version: ([\d.]+)/.exec(src.toString("utf8", 0, 2000)) || [])[1] || "?";
const out = await transform(src.toString("utf8"), { format: "cjs", platform: "node", target: "es2022", minifyWhitespace: true, logLevel: "error", define: { "import.meta.url": JSON.stringify("file:///" + CLI) }, sourcefile: "cli.js" });
let code = out.code;
if (code.startsWith("#!")) code = "// " + code; // the shebang line, neutralised (a worker script has no hashbang)
const outDir = join(HERE, "../web/native");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "claude-cli.js"), code);
const meta = { version, source: CLI, layer: layerDigest, image: dir.replace(/.*\/public\//, "public/"), sha256: createHash("sha256").update(src).digest("hex"), bytes: src.length, transformedBytes: Buffer.byteLength(code), transform: "esbuild transform format=cjs (ESM imports -> require; import.meta.url defined; whitespace-only minification), no bundling, no renaming", date: new Date().toISOString() };
writeFileSync(join(outDir, "cli.json"), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
