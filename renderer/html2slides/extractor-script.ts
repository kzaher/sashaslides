/**
 * extractor-script.ts — the ONE place that compiles extract-dom.ts into the script string every
 * caller injects into a page (Node only: it reads the source and runs esbuild).
 *
 * extract-dom.ts is a bare IIFE whose completion value is the extraction JSON, not a module, so a
 * caller evaluates the returned string (CDP `Runtime.evaluate`, or an esbuild `define` that inlines
 * it into a browser bundle). Compiled once per variant and cached for the life of the process.
 *
 *   extractorScript()                  — readable, as the converter and the browser bundles use it
 *   extractorScript({ minify: true })  — minified, as the Sasha add-on ships it (base64-wrapped)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

export type ExtractorScriptOptions = Readonly<{ minify?: boolean }>;

const EXTRACT_DOM_PATH = join(dirname(fileURLToPath(import.meta.url)), "extract-dom.ts");
const compiled = new Map<boolean, string>();

export function extractorScript(options: ExtractorScriptOptions = {}): string {
  const minify = options.minify === true;
  let script = compiled.get(minify);
  if (script === undefined) {
    const source = readFileSync(EXTRACT_DOM_PATH, "utf-8");
    script = transformSync(source, { loader: "ts", target: "es2020", ...(minify ? { minify: true } : {}) }).code;
    compiled.set(minify, script);
  }
  return script;
}
