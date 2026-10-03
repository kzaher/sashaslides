#!/usr/bin/env node
// Bundle the Node-compat runtime (src/worker.js + the npm polyfills) into runtime.js, a classic
// worker script. `node build.mjs [--watch]`
import { build, context } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const opts = {
  // THE RESOLVE ROOT, and it is not optional. esbuild resolves the TARGETS of `alias` (and bare
  // specifiers reached through them) as if they were imported from `absWorkingDir`, which defaults to
  // process.cwd() — so `node web/native/build.mjs` from the repo root used to resolve
  // alias.stream -> "readable-stream" out of the PARENT workspace's /workspaces/sashaslides/node_modules,
  // a tree that has no `events`, and the build died with `Could not resolve "events"`. Pinning the
  // working directory to this directory keeps every polyfill on web/native/node_modules (the only tree
  // that has the full set) no matter where the command is run from. Fixed in preference to installing
  // the polyfills into the parent workspace: the parent is not this bundle's dependency tree.
  absWorkingDir: here,
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
