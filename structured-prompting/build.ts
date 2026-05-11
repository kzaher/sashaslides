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
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { injectSchemaIntoSendCalls } from "./src/server/transformer.ts";

// Repo root is the nearest ancestor of THIS file that contains
// eslint.config.mjs — anchors path lookups so build.ts can be invoked
// from any cwd ("npx tsx structured-prompting/build.ts X" vs "cd
// structured-prompting && npx tsx build.ts X" both work).
const SP_DIR = dirname(fileURLToPath(import.meta.url));
function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(cur, "eslint.config.mjs"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`[sp] could not find eslint.config.mjs walking up from ${start}`);
}
const REPO_ROOT = findRepoRoot(SP_DIR);

const entry = process.argv[2];
if (!entry) {
  console.error("usage: tsx build.ts <entry.ts> [outfile.mjs]");
  process.exit(2);
}
const resolvedEntry = resolve(process.cwd(), entry);
const outfile =
  process.argv[3] ??
  `dist/${basename(entry).replace(/\.tsx?$/i, "")}.mjs`;

// ---- gate: ESLint with @typescript-eslint/no-explicit-any -----------------
// TypeScript's `noImplicitAny` (already on via "strict": true in
// tsconfig.json) only catches MISSING annotations. Explicit `: any`,
// `as any`, `<any>`, `any[]` are how production-time crashes (e.g. the
// pixelmatch-as-any bug that crashed wave-7b) slip past the type checker.
// This step runs ESLint over ALL source the bundle will touch BEFORE we
// invoke esbuild — fail fast, no half-built dist.
{
  const eslintBin = resolve(REPO_ROOT, "node_modules/.bin/eslint");
  const eslintConfig = resolve(REPO_ROOT, "eslint.config.mjs");
  const targets = [
    "renderer/structured-prompts/bug_solving",
    "structured-prompting/src",
    "structured-prompting/build.ts",
  ];
  const r = spawnSync(eslintBin, ["--config", eslintConfig, ...targets], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("[sp] ESLint failed — fix the errors above before rebuilding.");
    process.exit(r.status ?? 1);
  }
}

// Resolve typia options once; reuse across every onLoad call.
const typiaOpts = resolveOptions({ log: false });

// Minimal stub for the unplugin context that transformTypia expects. It
// primarily uses it for logging (`warn`/`error`) and cache hints — safe to
// no-op for our purposes.
/** Shape of the unplugin Context we hand to typia. We type the bits typia
 *  reads (warn/error/debug + a couple of no-op hooks) and let the rest stay
 *  unknown — the cast at the call site narrows to `Parameters<typeof
 *  transformTypia>[2]` since the upstream type is too loose to model precisely. */
interface UnpluginCtxStub {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  addWatchFile: (path: string) => void;
  emitFile: (file: unknown) => string;
  getNativeBuildContext: () => undefined;
  parse: (code: string) => Record<string, unknown>;
  getWatchFiles: () => string[];
}
const unpluginCtxStub: UnpluginCtxStub = {
  warn: (...args: unknown[]) => console.warn("[typia]", ...args),
  error: (...args: unknown[]) => console.error("[typia]", ...args),
  debug: (..._args: unknown[]) => {},
  addWatchFile: (_p: string) => {},
  emitFile: (_f: unknown) => "",
  getNativeBuildContext: () => undefined,
  parse: (_c: string) => ({}),
  getWatchFiles: () => [] as string[],
};

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
          args.path,
          afterInject,
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
