// What shape is the JS that web/native/bunfs.js pulled out of a Bun standalone binary? The loader in
// worker.js, tools/bun-extract.mjs and test/bunfs-unit.mjs all have to agree on the answer, which is
// why it is one function here and not a regexp copied into each of them — the copies drifting is
// exactly how a vendor bump became an unexplained `SyntaxError` on the page.
//
// TWO shapes have shipped in Claude Code's native build. Both are recognised; neither is guessed at.
//
//   "bun-cjs"  (2.1.233 and earlier)
//       // @bun @bytecode @bun-cjs
//       (function(exports, require, module, __filename, __dirname){ … 26 MB … })
//     ONE module held the whole CLI, already wrapped for Bun's own CommonJS loader. The runtime
//     evaluates that wrapper as an expression and calls it with our module context: no transform.
//
//   "bun-esm"  (2.1.288, measured; linux-x64 sha256 0298068b…7640c)
//       // @bun @bytecode
//       import{F}from"/$bunfs/root/chunk-vs3dgs32.js"; … await import("/$bunfs/root/chunk-….js")
//     Code-split ES modules: 2396 records / 2170 JS chunks, a 23,466-byte entry with 6 static and
//     141 dynamic imports of /$bunfs/root/chunk-*.js, and top-level await. A classic worker script
//     can hold none of that as SOURCE, and esm2cjs.js only rewrites imports of NODE BUILTINS, so
//     `importScripts()` of an esm2cjs'd copy throws `SyntaxError: Invalid or unexpected token`.
//     This shape is `await import()`ed instead — which a CLASSIC worker can do, top-level await and
//     all (measured, Chrome 154) — with web/bunfs-sw.js, a ServiceWorker the page registers, serving
//     /$bunfs/* from this origin so the specifiers resolve, and src/bun-link.js rewriting each
//     module on the way out. docs/claude-native.md.
//
//   "esm"      the npm build's single-file cli.js: ESM, but every specifier is a Node builtin, which
//              is precisely what esm2cjs.js rewrites. This is the supported transform path.
//   "cjs"      no ESM syntax left at statement level: load it as it stands.

export const BUN_BANNER = /^\/\/ @bun[^\n]*\n/;
export const BUN_CJS_WRAPPER = /^\(function\s*\(\s*exports\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)/;
export const BUNFS_PREFIX = "/$bunfs/";

// Statement-level ESM that a classic script cannot contain. Anchored to a line start (or the very
// start) so that the word "import" inside the bundle's own strings and doc comments is not counted —
// the minifier puts every real import at statement level, which esm2cjs.js relies on too.
const STATIC_ESM = /(?:^|[\n;}])\s*(?:import\s*(?:[{*"']|[\w$]+\s*(?:,|from))|export\s*(?:[{*]|default\b|(?:const|let|var|function|class|async)\b))/g;
const TOP_LEVEL_AWAIT = /(?:^|[\n;{}])\s*(?:await\s|(?:let|const|var)\s[^\n;]*?=\s*await\s)/g;

export function bunEntryShape(text) {
  const banner = BUN_BANNER.exec(text);
  const body = banner ? text.slice(banner[0].length) : text;
  const shape = { banner: banner ? banner[0].trim() : null, bytes: text.length,
    bunfsStatic: count(text, /\bfrom\s*["']\/\$bunfs\/[^"']*["']/g), bunfsDynamic: count(text, /\bimport\s*\(\s*["']\/\$bunfs\/[^"']*["']/g),
    staticEsm: count(text, STATIC_ESM), topLevelAwait: count(text, TOP_LEVEL_AWAIT) };
  if (BUN_CJS_WRAPPER.test(body)) return Object.assign(shape, { kind: "bun-cjs" });
  if (shape.bunfsStatic + shape.bunfsDynamic > 0) return Object.assign(shape, { kind: "bun-esm" });
  if (shape.staticEsm > 0) return Object.assign(shape, { kind: "esm" });
  return Object.assign(shape, { kind: "cjs" });
}

// One line the page and the TTY can both show, so "it broke" always names WHAT broke.
export function bunEntryShapeSummary(shape, where) {
  if (shape.kind === "bun-cjs") return `${where}: Bun CJS entry, ${shape.bytes} bytes`;
  if (shape.kind === "bun-esm")
    return `${where}: Bun CODE-SPLIT ES MODULE entry (${shape.bytes} bytes, ${shape.bunfsStatic} static + ${shape.bunfsDynamic} dynamic imports of /$bunfs/root/*), `
      + "served module-by-module from this origin by web/bunfs-sw.js and rewritten by src/bun-link.js. See docs/claude-native.md.";
  return `${where}: ${shape.kind}, ${shape.bytes} bytes, ${shape.staticEsm} statement-level import/export`;
}

function count(text, re) { re.lastIndex = 0; let n = 0; while (re.exec(text)) n++; return n; }
