// Serving Claude Code's NATIVE build to the browser's V8, since Bun stopped emitting one
// CommonJS-wrapped file (2.1.233) and started emitting a code-split ES-module graph (2.1.288):
//
//     // @bun @bytecode
//     import{F}from"/$bunfs/root/chunk-vs3dgs32.js"; … await import("/$bunfs/root/chunk-8z67b21p.js")
//     … import.meta.require("/$bunfs/root/chunk-pyfezkhg.js").default …
//
// 2,170 JS modules, 157,924 static and 1,319 literal-dynamic /$bunfs specifiers, 2,697 bare module
// ids, 472 `import.meta.require` sites (measured on 2.1.288 linux-x64). A classic Worker CAN
// `await import()` a graph like that, top-level await and all (measured, Chrome 154) — what it
// cannot do is RESOLVE the specifiers, because a Worker has no import map. So web/bunfs-sw.js serves
// /$bunfs/* from this origin, every module keeps ONE stable URL, and this file rewrites each module
// on the way out: ONLY the things a browser cannot resolve are touched, and `/$bunfs/root/…` is left
// exactly as the vendor wrote it.
//
// WHY A SERVICEWORKER AND NOT BLOB URLS. Publishing each chunk as its own blob: URL needs no page
// cooperation and was tried first; it cannot work here. A blob URL exists only once its content
// does, so a module can only be written after its dependencies are published — which demands an
// acyclic graph. Measured with Tarjan over all 2,170 modules:
//   * static imports alone:              ACYCLIC. No SCC > 1 node, no self-edge, longest chain 35.
//   * plus the import.meta.require edges: 3 SCCs, of 54, 4 and 3 modules.
// `import.meta.require` is Bun's SYNCHRONOUS require of its own embedded modules and is exactly what
// its bundler emits where a static import would have closed a cycle, so those edges are real. Every
// way of cutting one is wrong, and each failure is worth keeping written down:
//   * rewrite the site to `(await __nbImport("…"))` — `SyntaxError: Unexpected reserved word` for
//     the 76 of 2,170 modules whose site sits inside a NON-async function;
//   * await it at the module's top level — legal syntax, DEADLOCK: the partner statically imports
//     this module, so once this module is `evaluating-async` the partner's evaluation waits on it
//     (PendingAsyncDependencies) while it waits on the partner's import. Silent: the CLI loads and
//     prints nothing at all;
//   * start the partner and read it back at the call (`__nbSyncRequire`) — works for a site inside a
//     function, which is what a lazy require is for, but 2.1.288 also requires at a module's own TOP
//     LEVEL (`var r5=import.meta.require("/$bunfs/root/chunk-pyfezkhg.js").default` in
//     chunk-y95r52ev.js), and nothing can serve that asynchronously;
//   * cut the cycle's STATIC back edge instead, binding its clause late from a `.then(…)` — the
//     bindings are then `undefined` while the importer's own top level runs, which is where
//     chunk-y95r52ev.js died with `Cannot convert undefined or null to object`.
// With stable URLs none of this arises: an `import.meta.require` becomes an ordinary static import
// and the browser's module loader resolves the cycles the same way Bun's does.
import { BUNFS_PREFIX } from "./bun-entry.js";

// What web/bunfs-sw.js answers /$bunfs/* with. Every dependency is injected, so this runs with plain
// strings and no browser at all (test/bunfs-unit.mjs does that):
//   readFile(path)   the bytes stored at that path (a Uint8Array)
//   rootDir          the directory the standalone's modules live in ("/$bunfs/root")
//   entryPath        where the installer put the entry module, which is NOT under rootDir
//   requireNode(id)  the worker's Node `require`, for a bare specifier
//   canRequire(id)   whether that `require` can answer `id` — reported, never enforced
// `globals` are the names the rewritten modules call; the host puts them on the worker's global.
export function createBunfsModuleServer({ readFile, rootDir, entryPath, requireNode, canRequire }) {
  const entryName = rootDir + "/cli";
  const staticDeps = new Map();                 // module name -> the /$bunfs modules it statically imports
  const totals = { modules: 0, bytes: 0, chunkStatic: 0, chunkDynamic: 0, metaStatic: 0, metaLazy: 0, requires: 0, bareDynamic: 0, external: [], failed: [] };

  // The source to hand back for one /$bunfs path. Bun's entry is the only module the installer does
  // NOT store under rootDir — it writes it as the CLI's cli.js, the file the guest's argv points at.
  function read(path) {
    const bytes = readFile(path === entryName ? entryPath : path);
    totals.modules++; totals.bytes += bytes.length;
    const linked = linkBunEsmModule({ text: UTF8.decode(bytes), name: path, rootDir, canRequire,
      importsBack: (specifier) => reaches(specifier, path, new Set()) });
    for (const key of ["chunkStatic", "chunkDynamic", "metaStatic", "metaLazy", "requires", "bareDynamic"]) totals[key] += linked[key];
    for (const spec of linked.external) if (!totals.external.includes(spec)) totals.external.push(spec);
    return linked.code;
  }

  // Does `from` reach `target` through the vendor's own STATIC imports? That is the test for whether
  // adding a static import of `from` to `target` would close a cycle — the static graph is acyclic as
  // the vendor ships it (Tarjan over all 2,170 modules), so a path can only run one way. Each
  // module's static dependencies are read out of its source once and kept.
  function reaches(from, target, seen) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const dep of staticDepsOf(from)) if (reaches(dep, target, seen)) return true;
    return false;
  }

  function staticDepsOf(name) {
    const have = staticDeps.get(name);
    if (have) return have;
    let deps = [];
    try {
      const text = UTF8.decode(readFile(name === entryName ? entryPath : name));
      const found = new Set();
      STATIC_IMPORT.lastIndex = 0;
      for (let match = STATIC_IMPORT.exec(text); match; match = STATIC_IMPORT.exec(text)) if (match[6].startsWith(BUNFS_PREFIX)) found.add(match[6]);
      deps = [...found];
    } catch { deps = []; }                    // an asset path, or a module this build does not carry
    staticDeps.set(name, deps);
    return deps;
  }

  // `import("…")` with a BARE specifier — `import("crypto")`, `import("bun:jsc")` — which a Worker
  // cannot resolve either. A /$bunfs path is left to the browser: the ServiceWorker answers it.
  function importSpecifier(specifier) {
    const spec = String(specifier);
    if (!MODULE_ID.test(spec)) return Promise.reject(new Error(`cannot resolve dynamic import(${JSON.stringify(spec)}) in a Worker`));
    return Promise.resolve().then(() => esmNamespace(requireNode(spec)));
  }

  // `import.meta.require` is also passed around as a VALUE — chunk-hxtj0ds5.js exports it as `He`,
  // and 70-odd call sites then hand it an EMBEDDED ASSET path rather than a module:
  // `He("/$bunfs/root/design-6m4nsdef.md").trim()`. So the rewritten name has to behave like Bun's
  // require for all three kinds of thing the standalone embeds, not only for modules. A module is
  // the one case it cannot serve, and 2.1.288 never asks: all 472 of those specifiers are literals
  // and were rewritten into static imports.
  function metaRequire(specifier) {
    const spec = String(specifier);
    if (!spec.startsWith(BUNFS_PREFIX)) return requireNode(spec);
    if (TEXT_ASSET.test(spec)) return decodeBunText(readFile(spec));
    if (!JS_MODULE.test(spec)) return spec;      // Bun's `file` loader hands back a path, and the
                                                 // installer wrote this asset at exactly that path
    throw new Error(`import.meta.require(${JSON.stringify(spec)}): a browser cannot evaluate a module synchronously, and this specifier is not a literal the linker could rewrite into an import`);
  }

  const namespaces = new Map();
  const globals = {
    __nbImport: importSpecifier, __nbMetaRequire: metaRequire,
    // `import.meta.require` is Bun's LAZY synchronous require, and turning it into a static import
    // changes the evaluation order: the partner then evaluates BEFORE the requiring module instead
    // of during/after it, and a partner that reads the requirer's exports at its own top level gets
    // `undefined` (chunk-bsf70959.js: `Object.entries(undefined)`). So the order of the static graph
    // — which is acyclic, and is exactly the order Bun evaluates in — is left alone: the partner is
    // only STARTED from the requiring module's prelude, and read back at the call.
    __nbPreload: (specifier) => { importModule(specifier).catch(() => {}); },
    // Bun returns the namespace here and then; a browser's load is asynchronous and the call site can
    // be reached first — 2.1.288 does exactly that, at chunk-y95r52ev.js's own top level, which no
    // amount of starting earlier can fix (the partner's evaluation waits for this module to finish).
    // So what is handed back until the load lands is a stand-in that forwards on USE: every one of
    // these four values is a function or a schema that the CLI calls later, never reads now.
    __nbSyncRequire: (specifier) => namespaces.get(String(specifier)) || lazyNamespace(String(specifier), namespaces),
  };
  function importModule(specifier) {
    const spec = String(specifier);
    return import(new URL(spec, location.href).href).then((namespace) => { namespaces.set(spec, namespace); return namespace; });
  }
  return { read, globals, entryName, noteFailure: (path, message) => { if (totals.failed.length < 8) totals.failed.push(`${path}: ${message}`); },
    stats: () => Object.assign({}, totals, { external: totals.external.slice(), failed: totals.failed.slice() }) };
}

// One module, rewritten from "an ES module Bun would have loaded out of its own filesystem" into "an
// ES module the browser can load from /$bunfs/…". Pure, and deliberately minimal — every
// `/$bunfs/root/…` specifier, static or dynamic, is left ALONE, because the ServiceWorker makes those
// resolve. What is rewritten is only what no browser can resolve or provide:
//   import{a as b}from"node:fs"            -> var {a:b}=require("node:fs")    (hoisted, like ESM links)
//   import*as N from"os"                   -> var N=__nbEsm(require("os"))
//   import("crypto")                       -> __nbImport("crypto")
//   import.meta.require("/$bunfs/root/x.js")
//                                          -> __nbm0, bound by a hoisted `import*as __nbm0 from"…"`
//   import.meta.require (bare, or computed) -> __nbMetaRequire
//   import.meta.dirname / .dir / .url      -> the standalone's own paths, as string literals
// `export` is left exactly as it stands: the output IS a module, so its exports must survive.
export function linkBunEsmModule({ text, name, rootDir, canRequire, importsBack }) {
  const base = rootDir + "/" + name.replace(/^.*\//, "");
  const hoisted = [];
  const external = [];
  let chunkStatic = 0, chunkDynamic = 0, metaStatic = 0, metaLazy = 0, requires = 0, bareDynamic = 0, ignored = 0;
  let code = text.startsWith("#!") ? "//" + text : text;
  // Bun's synchronous require of its own embedded modules: 472 sites, every one naming a chunk
  // literally. Done before the `import.meta.*` pass below, which would otherwise eat the `.require`
  // and leave a `__nbMetaRequire("/$bunfs/…")` that cannot load a module synchronously.
  // Bun's require is LAZY: the partner evaluates AT THE CALL. A static import evaluates it before
  // this module instead, which is harmless — and far more robust, since the value is then simply
  // there — for all but one shape: a partner that imports THIS module back. Then the static import
  // closes a cycle, the partner evaluates first, and its own top-level reads of this module's
  // exports come out `undefined` (chunk-bsf70959.js died on `Object.entries(undefined)` that way).
  // 468 of the 472 sites are safe; the 4 that are not are all in chunk-y95r52ev.js, and they get the
  // lazy shape: start the partner from the prelude, read it back at the call.
  code = code.replace(META_REQUIRE, (whole, quote, specifier) => {
    if (importsBack(specifier)) {
      metaLazy++;
      hoisted.push(`__nbPreload(${JSON.stringify(specifier)});`);
      return `__nbSyncRequire(${JSON.stringify(specifier)})`;
    }
    const local = `__nbm${metaStatic++}`;
    hoisted.push(`import*as ${local} from${JSON.stringify(specifier)};`);
    return local;
  });
  // `import.meta.require` is 472 of the 626 import.meta uses in 2.1.288 and does not exist off Bun;
  // the others are paths. Alternation is longest-first so `dirname` is not read as `dir`.
  code = code.replace(/import\.meta\.(require|dirname|dir|url)\b/g, (whole, which) =>
    which === "require" ? "__nbMetaRequire" : which === "url" ? JSON.stringify("file://" + base) : JSON.stringify(rootDir));
  code = code.replace(STATIC_IMPORT, (whole, pre, named, ns, def, defNamed, specifier) => {
    if (specifier.startsWith(BUNFS_PREFIX)) { chunkStatic++; return whole; }
    // A match whose "specifier" is not even shaped like a module id came from the bundle's own prose
    // (the word `import` next to a quoted string: `","`, `" and "`, `"${e}"`, `",description:"` —
    // about 100 of them). Those are string CONTENTS; rewriting them would corrupt the strings.
    if (!MODULE_ID.test(specifier)) { ignored++; return whole; }
    // Everything else becomes a require, builtin or not. A package the shim does not have (the
    // bundle statically imports "@aws-sdk/credential-providers" in its Bedrock chunk) then throws
    // MODULE_NOT_FOUND when that chunk is evaluated — which is what Node does — instead of leaving a
    // bare ESM specifier that no Worker can resolve and that fails the whole chunk at link time.
    if (!canRequire(specifier)) external.push(specifier);
    requires++;
    const req = `require(${JSON.stringify(specifier)})`;
    if (named) hoisted.push(`var ${named.replace(/\s+as\s+/g, ":")}=${req};`);
    else if (ns) hoisted.push(`var ${ns.replace(/^\*\s*as\s+/, "")}=__nbEsm(${req});`);
    else if (defNamed) hoisted.push(`var ${def}=${req},${defNamed.replace(/\s+as\s+/g, ":")}=${def};`);
    else if (def) hoisted.push(`var ${def}=${req};`);
    else hoisted.push(req + ";");                 // `import"node:x"`: the side effect, nothing bound
    return pre;
  });
  // Only a call whose specifier is already a STRING is considered, which is what keeps the bundle's
  // own prose out of it: the 10 places that say "import()" inside a message have `)` after the
  // paren. A /$bunfs one resolves on its own; a bare one (`import("crypto")`) cannot, and the one
  // genuinely computed site (import(`@withfig/autocomplete/build/${e}.js`), inside a try/catch) is
  // left to reject as it would on Node, where that package is equally absent.
  code = code.replace(DYNAMIC_IMPORT, (whole, pre, quote, specifier) => {
    if (specifier.startsWith(BUNFS_PREFIX)) { chunkDynamic++; return whole; }
    bareDynamic++;
    return `${pre}__nbImport(${quote}${specifier}${quote}`;
  });
  const prelude = hoisted.length ? ESM_NAMESPACE_HELPER + hoisted.join("") + "\n" : "";
  return { code: prelude + code, chunkStatic, chunkDynamic, metaStatic, metaLazy, requires, bareDynamic, ignored, external };
}

// A stand-in for a module whose load has not landed yet: property reads give a stand-in for that
// member, and a member only has to be REAL when it is finally called, constructed or read through.
// Narrow on purpose — it exists for the four `import.meta.require` sites whose partner imports the
// requiring module back, where Bun's synchronous evaluation has no browser equivalent at all.
function lazyNamespace(specifier, namespaces) {
  const loaded = () => namespaces.get(specifier);
  return new Proxy(Object.create(null), {
    get(target, property) {
      const namespace = loaded();
      if (namespace) return namespace[property];
      if (typeof property === "symbol" || property === "then") return undefined;   // not a thenable, not iterable
      return lazyMember(specifier, property, namespaces);
    },
    has(target, property) { const namespace = loaded(); return namespace ? property in namespace : true; },
  });
}

function lazyMember(specifier, property, namespaces) {
  const member = () => {
    const namespace = namespaces.get(specifier);
    if (!namespace) throw new Error(`import.meta.require(${JSON.stringify(specifier)}).${String(property)} was used before that module finished loading; Bun evaluates it synchronously at the call and a browser cannot`);
    return namespace[property];
  };
  return new Proxy(function stillLoading() {}, {
    apply: (target, self, args) => Reflect.apply(member(), undefined, args),
    construct: (target, args) => Reflect.construct(member(), args),
    get: (target, key) => (typeof key === "symbol" || key === "then" ? undefined : member()[key]),
  });
}

// `import X from"fs"` wants module.exports, `import*as X from"fs"` wants a namespace object with a
// `default`. One helper, inlined per module that needs it rather than put on the global scope: a
// served chunk must not depend on anything the worker happens to have defined.
const ESM_NAMESPACE_HELPER = `var __nbEsm=(m)=>{if(m&&typeof m==="object"&&"default"in m)return m;var o=Object.create(null);if(m&&(typeof m==="object"||typeof m==="function"))for(var k of Object.getOwnPropertyNames(m))if(k!=="default")Object.defineProperty(o,k,{get:((mm,kk)=>()=>mm[kk])(m,k),enumerable:true});o.default=m;return o;};`;

// The minifier's own spelling of a static import, with `(^|[^\w$.])` in front so that a longer
// identifier ending in "import" cannot match. 2.1.288 writes 22,874 of these with a double quote and
// one with a single, and 3 with a space before the string, hence the tolerant quote/space handling.
const STATIC_IMPORT = /(^|[^\w$.])import(?:(?:(\{[^}]*\})|(\*\s*as\s+[\w$]+)|\s+([\w$]+)(?:\s*,\s*(\{[^}]*\}))?)\s*from\s*)?\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /(^|[^\w$.])import\s*\(\s*(["'])([^"']+)\2/g;
const META_REQUIRE = /import\.meta\.require\s*\(\s*(["'])(\/\$bunfs\/[^"']+)\1\s*\)/g;
// "shaped like something a module loader could be asked for" — the gate that keeps the rewriter out
// of the bundle's string literals. `node:fs`, `fs/promises`, `ws`, `@aws-sdk/credential-providers`
// pass; `","`, `" and "`, `"${e}"`, `",description:"` do not.
const MODULE_ID = /^(?:node:)?@?[a-zA-Z][\w.-]*(?:\/[\w.@-]+)*$/;

// Bun stores an embedded text file as UTF-8 unless it needs UTF-16, in which case it stores UTF-16LE
// with no BOM (`design-6m4nsdef.md` is one of 19). UTF-8 text cannot contain a NUL byte and UTF-16LE
// Latin text is half NUL bytes, which is the whole test.
function decodeBunText(bytes) {
  return bytes.includes(0) ? UTF16LE.decode(bytes) : UTF8.decode(bytes);
}

const UTF8 = new TextDecoder();
const UTF16LE = new TextDecoder("utf-16le");
const TEXT_ASSET = /\.(md|txt|json|html|css|svg|ts|tsx)$/;
const JS_MODULE = /(\.(js|mjs|cjs)|\/[^./]+)$/;

function esmNamespace(mod) {
  if (mod && typeof mod === "object" && "default" in mod) return mod;
  const out = Object.create(null);
  if (mod && (typeof mod === "object" || typeof mod === "function"))
    for (const key of Object.getOwnPropertyNames(mod)) if (key !== "default") Object.defineProperty(out, key, { get: () => mod[key], enumerable: true });
  out.default = mod;
  return out;
}
