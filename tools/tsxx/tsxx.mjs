#!/usr/bin/env node
// tsxx — like `tsx`, but instruments every statement and writes a
// per-statement timing profile to /tmp/tsxx-XXXX/profile.txt on exit.
//
// Usage:
//   node tools/tsxx/tsxx.mjs <entry.ts> [...args]
//
// Implementation: register the instrumenting loader, then dynamically
// import the entry. argv is rewritten so the user script sees its normal
// `process.argv` (i.e. argv[1] = entry path, argv[2..] = forwarded args).

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("usage: tsxx <entry.ts> [...args]\n");
  process.exit(2);
}

const entry = args[0];
const forwarded = args.slice(1);

register("./loader.mjs", import.meta.url);

const entryAbs = resolvePath(process.cwd(), entry);
const entryURL = pathToFileURL(entryAbs).href;

// Reshape argv so the loaded script sees the conventional layout.
process.argv = [process.argv[0], entryAbs, ...forwarded];

await import(entryURL);
