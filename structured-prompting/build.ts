/**
 * Generic build step for any structured-prompting entry file.
 *
 *   npx tsx structured-prompting/build.ts <entry.ts> [outfile]
 *
 * A single esbuild onLoad plugin chains two transformations per source file:
 *
 *   1. `injectSchemaIntoSendCalls` (src/transformer.ts) rewrites every
 *      `.send<T>({...})` call into `.send<T>({schema: typia.json.schema<T>(), ...})`
 *      and adds `import typia from "typia";` when needed.
 *
 *   2. `@typia/unplugin`'s `transformTypia` is invoked on the rewritten
 *      source in-place — it sees the injected `typia.json.schema<T>()` calls
 *      and replaces them with literal JSON Schema objects.
 *
 * Both passes happen inside one esbuild onLoad hook, so no shadow directory
 * or multi-pass dance is needed. Final output: a plain JS bundle with no
 * runtime reflection — schemas are static data by the time `node <outfile>`
 * runs.
 *
 * Examples:
 *   npx tsx build.ts example/main-scaffolding.ts
 *   npx tsx build.ts structured-prompts/my-task.ts dist/my-task.mjs
 */

import * as esbuild from "esbuild";
import { transformTypia, resolveOptions } from "@typia/unplugin/api";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { injectSchemaIntoSendCalls } from "./src/transformer.ts";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: tsx build.ts <entry.ts> [outfile.mjs]");
  process.exit(2);
}
const resolvedEntry = resolve(process.cwd(), entry);
const outfile =
  process.argv[3] ??
  `dist/${basename(entry).replace(/\.tsx?$/i, "")}.mjs`;

// Resolve typia options once; reuse across every onLoad call.
const typiaOpts = resolveOptions({ log: false });

// Minimal stub for the unplugin context that transformTypia expects. It
// primarily uses it for logging (`warn`/`error`) and cache hints — safe to
// no-op for our purposes.
const unpluginCtxStub = {
  warn: (...args: unknown[]) => console.warn("[typia]", ...args),
  error: (...args: unknown[]) => console.error("[typia]", ...args),
  debug: (..._args: unknown[]) => {},
  addWatchFile: (_p: string) => {},
  emitFile: (_f: unknown) => "" as any,
  getNativeBuildContext: () => undefined,
  parse: (_c: string) => ({} as any),
  getWatchFiles: () => [] as string[],
} as any;

const combinedPlugin: esbuild.Plugin = {
  name: "sp-inject-schema-and-typia",
  setup(build) {
    build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
      if (args.path.includes("/node_modules/")) return undefined;
      const raw = await readFile(args.path, "utf8");
      // Step 1: rewrite .send<T>({...}) → inject typia.json.schema<T>() call.
      const { code: afterInject } = injectSchemaIntoSendCalls(raw, args.path);
      // Step 2: hand to typia to inline the generic → JSON Schema literal.
      let transformed: string;
      try {
        transformed = await transformTypia(
          args.path as any,
          afterInject as any,
          unpluginCtxStub,
          typiaOpts,
        );
      } catch (e) {
        console.error(`[sp] typia transform failed for ${args.path}:`, (e as Error).message);
        transformed = afterInject;
      }
      return {
        contents: transformed,
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
};

await esbuild.build({
  entryPoints: [resolvedEntry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  plugins: [combinedPlugin],
  logLevel: "info",
});
console.error(`[sp] built ${outfile}`);
