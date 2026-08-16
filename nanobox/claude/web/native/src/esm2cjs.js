// Mechanical ESM -> classic-script transform for a SINGLE-FILE bundle such as Claude Code's cli.js
// (Bun's minified ESM output), so a Web Worker can importScripts() it: Workers cannot resolve bare
// specifiers ("fs", "node:module"), which is the only reason this exists. Same result as the offline
// `esbuild --format=cjs` transform tools/native-prepare.mjs used, done in the browser on the bytes the
// installer fetched from the vendor:
//   import{a as b,c}from"x"      -> var {a:b,c}=require("x")      (hoisted to the top like ESM links them)
//   import*as N from"x"          -> var N=__nbEsm(require("x"))   (namespace: named exports + default)
//   import D from"x"             -> var D=require("x")            (default of a builtin = module.exports)
//   import D,{a}from"x"          -> var D=require("x"),{a}=D
//   import"x"                    -> require("x")
//   import.meta.url              -> the file: URL of the script in the guest
//   import("x")                  -> __nbImport("x")  (Promise.resolve().then(() => __nbEsm(require("x"))))
//   #!shebang                    -> comment
// Only imports of Node builtins (optionally node:-prefixed) written the way the minifier writes them
// (`import{`, `import*as`, `import X from"…"`, no space before the string) are touched: cli.js has
// 872 of them and every one is at statement level; the doc strings inside the bundle that mention
// `import fs from "fs"` (spaced) are left alone. Verified against esbuild's output on 2.1.112.
const BUILTINS = new Set(["assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "inspector", "inspector/promises", "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "repl", "stream", "stream/consumers", "stream/promises", "stream/web", "string_decoder", "sys", "test", "timers", "timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib", "sea", "sqlite"]);
const IMPORT_RE = /import(?:(\{[^}]*\})|(\*\s*as\s+[\w$]+)|\s+([\w$]+)(?:\s*,\s*(\{[^}]*\}))?)\s*from"([^"]+)"|import"([^"]+)"/g;

export function esmToCjs(src, opts) {
  const fileUrl = (opts && opts.fileUrl) || "file:///cli.js";
  let code = src;
  if (code.startsWith("#!")) code = "//" + code;
  const hoisted = [];
  let n = 0;
  code = code.replace(IMPORT_RE, (m, named, ns, def, defNamed, spec, sideSpec) => {
    const s = spec || sideSpec;
    if (!BUILTINS.has(s.replace(/^node:/, ""))) return m;
    n++;
    const req = `require(${JSON.stringify(s)})`;
    if (sideSpec) hoisted.push(req + ";");
    else if (named) hoisted.push(`var ${named.replace(/\s+as\s+/g, ":")}=${req};`);
    else if (ns) hoisted.push(`var ${ns.replace(/^\*\s*as\s+/, "")}=__nbEsm(${req});`);
    else if (defNamed) hoisted.push(`var ${def}=${req},${defNamed.replace(/\s+as\s+/g, ":")}=${def};`);
    else hoisted.push(`var ${def}=${req};`);
    return "";
  });
  const metaN = (code.match(/import\.meta\.url/g) || []).length;
  code = code.replace(/import\.meta\.url/g, JSON.stringify(fileUrl));
  let dynN = 0;
  code = code.replace(/(^|[^\w$.])import\(/g, (m, pre) => { dynN++; return pre + "__nbImport("; });
  const prelude = `var __nbEsm=(m)=>{if(m&&typeof m==="object"&&"default"in m)return m;var o=Object.create(null);if(m&&(typeof m==="object"||typeof m==="function"))for(var k of Object.getOwnPropertyNames(m))if(k!=="default")Object.defineProperty(o,k,{get:((mm,kk)=>()=>mm[kk])(m,k),enumerable:true});o.default=m;return o;};var __nbImport=(s)=>Promise.resolve().then(()=>__nbEsm(require(s)));`;
  return { code: prelude + hoisted.join("") + "\n" + code, imports: n, metaUrl: metaN, dynamicImports: dynN };
}
