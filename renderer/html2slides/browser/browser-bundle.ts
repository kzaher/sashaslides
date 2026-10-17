/**
 * browser-bundle.ts — the ONE esbuild configuration for the in-browser converter bundles
 * (build.ts's standalone page, build-addon.ts's sidebar and the site's convert-bundle.js).
 *
 * The bundle graph (entry → convert-core.ts → convert-pptx-lib.ts) imports no Node module, so the
 * only aliases are the two vendors: `pptxgenjs` and `jszip` are inlined as vendor <script> tags (or
 * loaded from a CDN) and these thin stubs read window.PptxGenJS / window.JSZip, so esbuild does not
 * bundle the ~560 KB of source twice. `__EXTRACT_JS_LITERAL__` is replaced by the compiled
 * extract-dom script at every use site.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bundle `entry` into one IIFE and return its JavaScript text. */
export async function browserBundle(entry: string, extractJs: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: false,
    sourcemap: false,
    alias: {
      "pptxgenjs": join(HERE, "stubs", "pptxgenjs-global.ts"),
      "jszip": join(HERE, "stubs", "jszip-global.ts"),
    },
    define: {
      __EXTRACT_JS_LITERAL__: JSON.stringify(extractJs),
    },
    logLevel: "info",
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}
