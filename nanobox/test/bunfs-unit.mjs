// web/native/bunfs.js — reading the files out of a Bun standalone executable (that is how the
// sandbox gets the JS of Claude Code's NATIVE build, docs/system-node.md). Runs without a browser:
//
//   node test/bunfs-unit.mjs [path/to/bun-standalone-binary]
//
// The synthetic cases always run; if the real binary is around (work/bun/claude-bun.bin, produced by
// `tar -xOf work/oci-cache/<layer>.tar usr/local/bin/claude`) it is parsed too — whole and as the
// 64 MB tail slice the browser installer range-fetches.
import { openSync, readSync, fstatSync, closeSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
await import("../web/native/bunfs.js");
const B = globalThis.NanoboxBunFs;
const HERE = dirname(fileURLToPath(import.meta.url));
// the SAME classifier the loader in web/native/src/worker.js branches on — imported, not re-expressed,
// because a copied regexp drifting from the loader's is what let 2.1.288 fail as a runtime SyntaxError
const { bunEntryShape } = await import("../web/native/src/bun-entry.js");
const { esmToCjs } = await import("../web/native/src/esm2cjs.js");
// the rewriter web/bunfs-sw.js serves the 2.1.288 ES-module graph through
const { createBunfsModuleServer, linkBunEsmModule } = await import("../web/native/src/bun-link.js");
const BUN_CJS_ENTRY = (text) => bunEntryShape(text).kind === "bun-cjs";
// evaluated at load time, so it has to sit above syntheticIndexed() rather than next to it
const TRAILER_BYTES = new TextEncoder().encode("\n---- Bun! ----\n");

let failures = 0;
const ok = (cond, what, got) => { console.log(`  ${cond ? "ok" : "FAIL"}: ${what}${cond ? "" : ` (got ${JSON.stringify(got)})`}`); if (!cond) failures++; };

console.log("synthetic standalone:");
{
  const entrySrc = "// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {module.exports = 42;})\n";
  const bin = synthetic([
    ["/$bunfs/root/src/entrypoints/cli.js", null],           // alias record: name followed by a name
    ["/$bunfs/root/cli", entrySrc],
    ["/$bunfs/root/mermaid.min.js", "/* mermaid */\n"],
    ["/$bunfs/root/audio-capture.node", "\x7fELF-ish-addon"],
  ]);
  const sec = B.section(bin);
  ok(!!sec, "finds the .bun section in an ELF64 image", sec);
  const mods = B.modules(bin, sec ? { section: sec } : undefined);
  ok(mods.length === 3, "skips the alias record and reads the three real files", mods.map((m) => m.name));
  ok(mods[0].name === "/$bunfs/root/cli", "the entry keeps its stored name", mods[0].name);
  ok(mods[0].text() === entrySrc, "contents are byte-exact", mods[0].text().slice(0, 40));
  const entry = B.entry(mods);
  ok(entry && entry.name === "/$bunfs/root/cli", "entry() picks the @bun-wrapped module, not the biggest asset", entry && entry.name);
  const un = B.unwrapCjs(entry.text());
  ok(un.wrapped, "unwrapCjs recognises Bun's CJS wrapper");
  ok(BUN_CJS_ENTRY(entry.text()), "the runtime loader agrees with unwrapCjs (shape bun-cjs)");
  ok(runAsRuntimeWould(entry.text()) === 42, "the wrapper runs when called with a module context");
}

console.log("truncated slice (what a range fetch gets):");
{
  const bin = synthetic([["/$bunfs/root/cli", "// @bun\n(function(exports, require, module, __filename, __dirname) {})\n"]]);
  const tail = bin.subarray(40);                                // mid-header slice: no usable ELF header
  ok(B.section(tail) === null, "section() gives up on a slice without the section table");
  const mods = B.modules(tail);
  ok(mods.length === 1 && mods[0].name === "/$bunfs/root/cli", "modules() still finds the records by scanning", mods.map((m) => m.name));
}

console.log("indexed standalone (the 2.1.288 layout: contents and names in separate regions + an index):");
{
  const entrySrc = "// @bun @bytecode\nimport{F}from\"/$bunfs/root/chunk-aa.js\";await F();\n";
  const bin = syntheticIndexed([
    // padded so that the fixed-size tail slice at the end of this block reaches the index but not the
    // contents region — exactly the shape of a range fetch that came up short
    ["/$bunfs/root/chunk-aa.js", "// @bun @bytecode\nexport function F(){}\n" + "//" + "x".repeat(3000) + "\n"],
    ["/$bunfs/root/cli", entrySrc],
    ["/$bunfs/root/template.md", "# not javascript\n"],
  ], 1);
  const g = B.graph(bin);
  ok(!!g, "graph() reads the index off the trailer");
  ok(g && g.recordSize === 52, "the 52-byte record layout validates", g && g.recordSize);
  ok(g && g.modules.length === 3, "every record is read", g && g.modules.length);
  const entry = B.entry(B.modules(bin));
  ok(!!entry && entry.name === "/$bunfs/root/cli", "entry() honours the index's entry_point_id, not the biggest module", entry && entry.name);
  ok(entry && entry.text() === entrySrc, "the entry's contents are byte-exact", entry && entry.text().slice(0, 40));
  // THE REGRESSION THIS FILE EXISTS FOR: the pre-2.1.288 scan found no usable record in this layout
  // and entry() fell back to "the biggest @bun-wrapped module" — a 17-byte markdown asset, installed
  // as cli.js, which only showed up as `SyntaxError: Invalid or unexpected token` in the browser.
  ok(bunEntryShape(entry.text()).kind === "bun-esm", "the indexed entry is classified bun-esm", bunEntryShape(entry.text()).kind);
  ok(esmToCjs(entry.text()).residual.count > 0, "esm2cjs reports it cannot rewrite the /$bunfs chunk imports (so the loader must refuse, not transform)");
  // a tail slice that stops short of the contents must SAY so rather than hand back empty modules
  const shortTail = bin.subarray(bin.length - 600);
  const gs = B.graph(shortTail);
  ok(!!gs && gs.modules.some((m) => m.truncated), "a slice that misses the contents marks the modules truncated", gs && gs.modules.map((m) => m.truncated));
}

const real = process.argv[2] || join(HERE, "../work/bun/claude-bun.bin");
if (existsSync(real)) {
  console.log(`real binary ${real}:`);
  const whole = readAll(real);
  const sec = B.section(whole);
  ok(!!sec && sec.size > 1e6, "`.bun` section found", sec);
  const mods = B.modules(whole, { section: sec });
  const entry = B.entry(mods);
  ok(mods.length >= 5, `${mods.length} embedded modules`);
  ok(!!entry && entry.name === "/$bunfs/root/cli", "entry is the /$bunfs/root/cli module", entry && `${entry.name} ${entry.len}`);
  ok(!!entry && !entry.truncated && entry.len > 1024, "the entry's contents are present and non-trivial", entry && `${entry.len} truncated=${entry.truncated}`);
  // THE GATE. The next vendor bump must fail HERE, in a unit test, and not as a SyntaxError thrown
  // out of importScripts() in the browser: whatever we install as cli.js has to be real JavaScript,
  // and it has to be a shape web/native/src/worker.js knows how to branch on.
  const shape = bunEntryShape(entry.text());
  ok(shape.kind === "bun-cjs" || shape.kind === "bun-esm", `the entry is a shape the loader knows (${shape.kind})`, shape);
  const syntax = checkSyntax(entry.text(), shape.kind === "bun-cjs" ? "cjs" : "mjs");
  ok(syntax === null, `the extracted entry parses as ${shape.kind === "bun-cjs" ? "a script" : "an ES module"}`, syntax);
  const tail = whole.subarray(Math.max(0, whole.length - B.SEARCH_TAIL_BYTES));
  const tailEntry = B.entry(B.modules(tail));
  ok(!!tailEntry && tailEntry.name === entry.name && tailEntry.len === entry.len && !tailEntry.truncated,
    `the ${(B.SEARCH_TAIL_BYTES / 1e6) | 0} MB tail slice yields the same entry, whole (the installer never downloads the whole binary)`,
    tailEntry && `${tailEntry.name} ${tailEntry.len} truncated=${tailEntry.truncated}`);
} else {
  console.log(`real binary not present (${real}) — synthetic cases only`);
}

// ---- the LINKING step: what web/bunfs-sw.js answers /$bunfs/* with -------------------------------
// Since 2.1.288 extracting the modules is only half the job: each one is rewritten on the way out
// (bare specifiers to `require`, import.meta to the standalone's own paths, import.meta.require to an
// import) and the result has to be a loadable ES MODULE. Every mistake this file now guards was first
// seen as a runtime error in the browser — `SyntaxError: Unexpected reserved word`,
// `Cannot convert undefined or null to object`, a silent hang — so the parse is the gate.
console.log("bunfs module server (the 2.1.288 ESM graph):");
{
  const ROOT = "/$bunfs/root";
  const files = {
    [`${ROOT}/cli`]: '// @bun @bytecode\nimport{F}from"/$bunfs/root/chunk-a.js";await F();export{};\n',
    [`${ROOT}/chunk-a.js`]: 'import{readFile as rf}from"node:fs/promises";import*as os from"os";import p from"path";import"node:assert";'
      + 'import{B}from"/$bunfs/root/chunk-b.js";var meta=[import.meta.url,import.meta.dirname,import.meta.dir];'
      + 'var lazy=import.meta.require("/$bunfs/root/chunk-b.js");var asset=import.meta.require;'
      + 'export function F(){return[rf,os,p,B,meta,lazy,asset,import("/$bunfs/root/chunk-b.js"),import("crypto")]}\n',
    [`${ROOT}/chunk-b.js`]: 'import{F}from"/$bunfs/root/chunk-a.js";export const B=()=>F;\n',
    [`${ROOT}/note-7f.md`]: "hello asset\n",
    [`${ROOT}/wide-7f.md`]: "h\u0000i\u0000!\u0000",                      // UTF-16LE, as Bun stores one
  };
  const enc2 = new TextEncoder();
  const server = createBunfsModuleServer({
    readFile: (path) => { const text = files[path === `${ROOT}/cli` ? "entry" : path] ?? files[path]; if (text === undefined) throw new Error("ENOENT " + path); return enc2.encode(text); },
    rootDir: ROOT, entryPath: `${ROOT}/cli`, requireNode: (id) => ({ id }), canRequire: (id) => id !== "ws",
  });
  const entry = server.read(`${ROOT}/cli`);
  ok(entry.includes('from"/$bunfs/root/chunk-a.js"'), "a /$bunfs specifier is left exactly as the vendor wrote it (the ServiceWorker resolves it)", entry);
  const a = server.read(`${ROOT}/chunk-a.js`);
  ok(/var \{readFile:rf\}=require\("node:fs\/promises"\)/.test(a), "a named import of a builtin becomes a hoisted require", a.slice(0, 200));
  ok(/var os=__nbEsm\(require\("os"\)\)/.test(a), "a namespace import of a builtin goes through the interop helper", a.slice(0, 260));
  ok(/var p=require\("path"\)/.test(a) && /require\("node:assert"\);/.test(a), "default and side-effect imports of builtins are hoisted too", a.slice(0, 320));
  ok(a.includes(JSON.stringify("file://" + ROOT + "/chunk-a.js")) && a.includes(JSON.stringify(ROOT)), "import.meta.url / .dirname / .dir become the standalone's own paths");
  ok(a.includes("__nbMetaRequire"), "`import.meta.require` used as a VALUE keeps a callable (it is handed asset paths, not only modules)");
  ok(a.includes('__nbPreload("/$bunfs/root/chunk-b.js")') && a.includes('__nbSyncRequire("/$bunfs/root/chunk-b.js")'),
    "import.meta.require of a module that imports this one BACK stays lazy — a static import would close a cycle and evaluate it first", a.slice(0, 400));
  ok(a.includes('import("/$bunfs/root/chunk-b.js")'), "a dynamic import of a chunk is left alone");
  ok(a.includes('__nbImport("crypto")'), "a dynamic import of a BARE specifier is routed at the module shim");
  ok(server.read(`${ROOT}/note-7f.md`) !== undefined, "a UTF-8 text asset reads back");
  ok(server.globals.__nbMetaRequire(`${ROOT}/note-7f.md`) === "hello asset\n", "import.meta.require of a text asset gives its contents, like Bun's text loader", server.globals.__nbMetaRequire(`${ROOT}/note-7f.md`));
  ok(server.globals.__nbMetaRequire(`${ROOT}/wide-7f.md`) === "hi!", "a UTF-16LE asset is decoded as UTF-16, not as mojibake", server.globals.__nbMetaRequire(`${ROOT}/wide-7f.md`));
  ok(server.globals.__nbMetaRequire("node:fs").id === "node:fs", "import.meta.require of a bare id goes to the Node shim");
  // a non-async function is where `(await …)` would be `SyntaxError: Unexpected reserved word`
  const sync = linkBunEsmModule({ text: 'export function f(){return import.meta.require("/$bunfs/root/x.js").y}', name: `${ROOT}/s.js`, rootDir: ROOT, canRequire: () => true, importsBack: () => false });
  ok(/import\*as __nbm0 from"\/\$bunfs\/root\/x\.js"/.test(sync.code) && /__nbm0\.y/.test(sync.code),
    "a require inside a function becomes a static import when the partner does not import back (no await, which would not parse there)", sync.code);
  const parsed = await parsesAsModules({ [`${ROOT}/cli`]: entry, [`${ROOT}/chunk-a.js`]: a, [`${ROOT}/chunk-b.js`]: server.read(`${ROOT}/chunk-b.js`) });
  ok(parsed.length === 0, "every rewritten module parses as an ES module", parsed);
}

// The real 2.1.288 graph: 2,167 JS modules, rewritten and parsed. Not downloaded by this test —
// `curl -r -67108864 https://downloads.claude.ai/claude-code-releases/2.1.288/linux-x64/claude
//  -o work/bun/claude-2.1.288-tail.bin` is the 64 MB tail the browser installer range-fetches too.
const esmTail = process.argv[3] || join(HERE, "../work/bun/claude-2.1.288-tail.bin");
if (existsSync(esmTail)) {
  console.log(`real ESM graph ${esmTail}:`);
  const whole = readAll(esmTail);
  const graph = B.graph(whole);
  ok(!!graph && graph.modules.length > 2000, "the index parses", graph && graph.modules.length);
  const byName = new Map(graph.modules.map((m) => [m.name, m]));
  const entry = B.entry(graph.modules);
  ok(bunEntryShape(entry.text()).kind === "bun-esm", "the entry is the code-split ESM shape");
  const server = createBunfsModuleServer({
    readFile: (path) => { const m = byName.get(path); if (!m) throw new Error("ENOENT " + path); return m.bytes(); },
    rootDir: "/$bunfs/root", entryPath: entry.name, requireNode: (id) => ({ id }), canRequire: () => true,
  });
  const served = {};
  // loader 1 is Bun's UTF-8 JS loader; the three `.js` names it stores with loader 0 are
  // zstd-compressed ASSETS (chart.umd.min.js, mermaid.min.js, hljsBundle.generated.min.js)
  for (const m of graph.modules) if (m.loader === 1 && /\.js$/.test(m.name)) served[m.name] = server.read(m.name);
  const count = Object.keys(served).length;
  ok(count > 2000, `${count} modules rewritten`);
  const failed = await parsesAsModules(served);
  ok(failed.length === 0, "every one of them parses as an ES module", failed.slice(0, 4));
  const stats = server.stats();
  ok(stats.metaStatic + stats.metaLazy > 400, "the import.meta.require sites were all rewritten", { metaStatic: stats.metaStatic, metaLazy: stats.metaLazy });
  ok(stats.metaLazy < stats.metaStatic / 10, "almost none of them had to stay lazy (only a partner that imports back does)", { metaStatic: stats.metaStatic, metaLazy: stats.metaLazy });
} else {
  console.log(`2.1.288 tail not present (${esmTail}) — ESM-graph gate skipped (see the comment above for the one curl that fetches it)`);
}

console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);

// a minimal ELF64 image whose `.bun` section holds `\0name\0contents` records (contents null = alias)
function synthetic(records) {
  const enc = new TextEncoder();
  const parts = [];
  for (const [name, contents] of records) { parts.push(enc.encode("\0" + name + "\0")); if (contents !== null) parts.push(enc.encode(contents)); }
  return elf(concat(parts));
}

// the same minimal ELF64 wrapper for either payload: one `.bun` section holding it verbatim
function elf(payload) {
  const enc = new TextEncoder();
  const shstr = enc.encode("\0.bun\0.shstrtab\0");
  const ehsize = 64, shentsize = 64, shnum = 3;
  const secOff = ehsize;
  const shstrOff = secOff + payload.length;
  const shoff = shstrOff + shstr.length;
  const out = new Uint8Array(shoff + shnum * shentsize);
  const dv = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);               // \x7fELF, 64-bit, little endian
  dv.setBigUint64(0x28, BigInt(shoff), true);
  dv.setUint16(0x3a, shentsize, true); dv.setUint16(0x3c, shnum, true); dv.setUint16(0x3e, 2, true);
  out.set(payload, secOff); out.set(shstr, shstrOff);
  const sh = (i, nameOff, off, size) => { const b = shoff + i * shentsize; dv.setUint32(b, nameOff, true); dv.setBigUint64(b + 0x18, BigInt(off), true); dv.setBigUint64(b + 0x20, BigInt(size), true); };
  sh(0, 0, 0, 0);                                              // null section
  sh(1, 1, secOff, payload.length);                            // ".bun"
  sh(2, 6, shstrOff, shstr.length);                            // ".shstrtab"
  return out;
}

// A standalone laid out the way Bun has written one since 2.1.288: one contents region, one
// NUL-separated name table, an array of 52-byte records pointing into both (offsets relative to
// section+8), the Offsets struct, and the trailer as the section's last 16 bytes.
function syntheticIndexed(records, entryIndex) {
  const enc = new TextEncoder();
  const RECORD = 52;
  const contents = [], names = [];
  let contentLen = 0, nameLen = 0;
  for (const [name, text] of records) {
    const body = enc.encode(text), label = enc.encode(name + "\0");
    contents.push({ off: contentLen, bytes: body }); contentLen += body.length;
    names.push({ off: nameLen, bytes: label, len: label.length - 1 }); nameLen += label.length;
  }
  const blobHead = 8;                                     // the u64 byte_count the section opens with
  const nameBase = blobHead + contentLen;
  const arrBase = nameBase + nameLen;
  const payload = new Uint8Array(arrBase + records.length * RECORD + 24 + TRAILER_BYTES.length);
  const dv = new DataView(payload.buffer);
  for (let i = 0; i < records.length; i++) {
    payload.set(contents[i].bytes, blobHead + contents[i].off);
    payload.set(names[i].bytes, nameBase + names[i].off);
    const rec = arrBase + i * RECORD;
    dv.setUint32(rec, nameBase - blobHead + names[i].off, true); dv.setUint32(rec + 4, names[i].len, true);
    dv.setUint32(rec + 8, contents[i].off, true); dv.setUint32(rec + 12, contents[i].bytes.length, true);
    payload[rec + RECORD - 4] = 1; payload[rec + RECORD - 3] = 1;      // loader, module_format
  }
  const indexAt = arrBase + records.length * RECORD;
  dv.setBigUint64(indexAt, BigInt(indexAt - blobHead), true);          // byte_count, measured from base
  dv.setUint32(indexAt + 8, arrBase - blobHead, true); dv.setUint32(indexAt + 12, records.length * RECORD, true);
  dv.setUint32(indexAt + 16, entryIndex, true);
  payload.set(TRAILER_BYTES, indexAt + 24);
  dv.setBigUint64(0, BigInt(payload.length - 8), true);
  return elf(payload);
}
// esbuild, not `node --check`: `node --check` only ever checks its FIRST file argument, so a batched
// check of 2,167 of them silently passes 2,166 unexamined — which is exactly how an `await` inside a
// non-async function reached the browser as `SyntaxError: Unexpected reserved word`.
async function parsesAsModules(sources) {
  const esbuild = await import("../web/native/node_modules/esbuild/lib/main.js");
  const failed = [];
  for (const [name, code] of Object.entries(sources)) {
    try { esbuild.transformSync(code, { loader: "js", format: "esm" }); }
    catch (error) { failed.push(`${name}: ${(error.errors || []).map((e) => `${e.text} @${e.location && e.location.line}`).join("; ") || error.message}`); }
  }
  return failed;
}

function checkSyntax(text, extension) {
  const dir = mkdtempSync(join(tmpdir(), "bunfs-syntax-"));
  const file = join(dir, `entry.${extension}`);
  writeFileSync(file, text);
  try { execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"], timeout: 20000 }); return null; }
  catch (error) { return String(error.stderr || error.message).split("\n").slice(0, 4).join(" | "); }
}

function runAsRuntimeWould(text) {
  const module = { exports: {} };
  const call = `\n(module.exports, require, module, "/x/cli.js", "/x");\n`;
  return new Function("module", "require", `${text}${call}\nreturn module.exports;`)(module, () => { throw new Error("no require in this test"); });
}

function concat(list) { const n = list.reduce((s, b) => s + b.length, 0); const out = new Uint8Array(n); let o = 0; for (const b of list) { out.set(b, o); o += b.length; } return out; }
function readAll(path) { const fd = openSync(path, "r"); const size = fstatSync(fd).size; const buf = Buffer.alloc(size); let off = 0; while (off < size) off += readSync(fd, buf, off, Math.min(1 << 26, size - off), off); closeSync(fd); return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); }
