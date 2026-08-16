#!/usr/bin/env node
// Bundle the Node-compat runtime (src/worker.js + the npm polyfills) into runtime.js, a classic
// worker script. `node build.mjs [--watch]`
import { build, context } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const opts = {
  entryPoints: [here + "/src/worker.js"], bundle: true, format: "iife", platform: "browser", target: ["chrome120"],
  outfile: here + "/runtime.js", sourcemap: "linked", logLevel: "info", legalComments: "none",
  define: { global: "globalThis", "process.env.NODE_DEBUG": "undefined", "process.env.READABLE_STREAM": "undefined" },
  alias: { stream: "readable-stream", "node:stream": "readable-stream", "node:events": "events", "node:buffer": "buffer", "node:util": "util", "node:string_decoder": "string_decoder" },
  inject: [here + "/src/inject-process.js"],
  // the polyfills' `require('process/')` / `require('process')` -> the forwarder to the real process object
  plugins: [{ name: "process-forwarder", setup(b) { b.onResolve({ filter: /^(node:)?process\/?(browser(\.js)?)?$/ }, () => ({ path: here + "/src/process-shim.cjs" })); } }],
};
if (process.argv.includes("--watch")) { const c = await context(opts); await c.watch(); console.log("watching"); }
else await build(opts);
