// tsxx Node module hook (use with `node --import` or `module.register`).
//
// Two responsibilities:
//   resolve()  — map ./foo, ./foo.js, etc. to a real .ts/.tsx/.mts file
//                (TS source style: extension-less or .js-aliased imports).
//   load()     — for .ts/.tsx/.mts files, read raw source, run it through
//                the instrumenter, return the compiled ESM JS.
//
// Files inside this tools/tsxx directory itself are NEVER instrumented —
// otherwise we'd recurse into the runtime.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname, dirname, resolve as resolvePath } from "node:path";
import { instrument } from "./instrument.mjs";

const TS_EXTS = new Set([".ts", ".tsx", ".mts"]);
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

function tryCandidates(filePath) {
  const ext = extname(filePath);
  const tries = [filePath];
  if (ext === ".js") {
    tries.push(filePath.slice(0, -3) + ".ts", filePath.slice(0, -3) + ".tsx");
  } else if (ext === ".mjs") {
    tries.push(filePath.slice(0, -4) + ".mts");
  } else if (ext === "") {
    tries.push(
      filePath + ".ts",
      filePath + ".tsx",
      filePath + ".mts",
      filePath + "/index.ts",
      filePath + "/index.tsx",
      filePath + "/index.mts",
    );
  }
  for (const t of tries) {
    if (existsSync(t)) return t;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // Only intervene for path-like specifiers — bare module names (`fs`,
  // `chrome-remote-interface`) defer to Node's default resolver.
  const isPathLike =
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:");

  if (!isPathLike) return nextResolve(specifier, context);

  let absURL;
  try {
    if (specifier.startsWith("file:")) {
      absURL = new URL(specifier);
    } else if (specifier.startsWith("/")) {
      absURL = pathToFileURL(specifier);
    } else {
      if (!context.parentURL) return nextResolve(specifier, context);
      absURL = new URL(specifier, context.parentURL);
    }
  } catch {
    return nextResolve(specifier, context);
  }

  let filePath;
  try {
    filePath = fileURLToPath(absURL);
  } catch {
    return nextResolve(specifier, context);
  }

  const found = tryCandidates(filePath);
  if (found) {
    return {
      url: pathToFileURL(found).href,
      format: "module",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file://")) return nextLoad(url, context);

  let filePath;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return nextLoad(url, context);
  }

  // Never instrument the loader/runtime/instrumenter themselves.
  if (filePath.startsWith(SELF_DIR + "/") || filePath === SELF_DIR) {
    return nextLoad(url, context);
  }

  const ext = extname(filePath);
  if (!TS_EXTS.has(ext)) return nextLoad(url, context);

  const source = readFileSync(filePath, "utf8");
  const compiled = instrument(source, filePath);
  return {
    format: "module",
    source: compiled,
    shortCircuit: true,
  };
}
