/**
 * build-support.ts — what build-addon.ts and build-walkthroughs.ts both need.
 */
import { transformSync, type Plugin } from "esbuild";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The add-on's stylesheet modules: `src/<name>-styles.ts`, never one in a subdirectory. */
export const STYLESHEET_MODULE = /[\\/]src[\\/][a-z-]+-styles\.ts$/;

/**
 * THE STYLESHEETS SHIP MINIFIED. Each `src/*-styles.ts` is a string written for people -- block
 * comments and indentation -- and esbuild's JS minifier leaves a string's contents alone, so every
 * surface used to carry all of it. Measured 2026-10-14: 52,165 -> 27,991 characters through
 * esbuild's own CSS minifier, which is what let the merge path (src/merge-apply.ts) fit Dialog.html
 * back under SURFACE_BUDGET_BYTES. The module is swapped at bundle time for one exporting the same
 * names, so the source stays readable and the unit tests still read the original.
 *
 * Every export of such a module must be a string; the ones named `*_CSS` are minified and any other
 * is passed through as it is.
 */
export function minifiedStylesheets(): Plugin {
  return {
    name: "sasha-minified-stylesheets",
    setup(builder) {
      builder.onLoad({ filter: STYLESHEET_MODULE }, async ({ path }) => {
        // Imported here and not at the top: which module is only known once esbuild asks for it.
        const sheet: Readonly<Record<string, unknown>> = await import(pathToFileURL(path).href);
        const exports = Object.entries(sheet).map(([name, value]) => {
          if (typeof value !== "string") throw new Error(`${path}: export ${name} is not a string`);
          const shipped = name.endsWith("_CSS") ? transformSync(value, { loader: "css", minify: true }).code : value;
          return `export const ${name} = ${JSON.stringify(shipped)};`;
        });
        return { contents: exports.join("\n"), loader: "ts" };
      });
    },
  };
}

/** A binary from this package's node_modules or the repository root's. */
export function findBinary({ name, roots, caller }: Readonly<{ name: string; roots: readonly string[]; caller: string }>): string {
  for (const root of roots) {
    const candidate = join(root, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${caller}: no ${name} -- run 'npm install' at the repo root`);
}
