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
  // eslint + typescript-eslint are declared under structured-prompting (see
  // eslint.config.mjs), so the binary lives in SP_DIR/node_modules, not the
  // repo-root node_modules (the root package.json doesn't own them, and a
  // root `npm install` prunes any stray copy there).
  const eslintBin = resolve(SP_DIR, "node_modules/.bin/eslint");
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
/** Shape of the unplugin Context we hand to typia. `transformTypia` only ever
 *  reads `.warn` (via its `warnDiagnostic` helper); every other member is a
 *  no-op the upstream type requires structurally. We pull the exact `parse` /
 *  `getNativeBuildContext` return types out of the declared parameter type so
 *  this stub is genuinely assignable to it (no cast at the call site). */
type UnContextParam = Parameters<typeof transformTypia>[2];
type StubAstNode = ReturnType<NonNullable<UnContextParam["parse"]>>;
interface UnpluginCtxStub {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  addWatchFile: (path: string) => void;
  emitFile: (file: unknown) => string;
  getNativeBuildContext?: UnContextParam["getNativeBuildContext"];
  parse: (code: string) => StubAstNode;
  getWatchFiles: () => string[];
}
const unpluginCtxStub: UnpluginCtxStub = {
  warn: (...args: unknown[]) => console.warn("[typia]", ...args),
  error: (...args: unknown[]) => console.error("[typia]", ...args),
  debug: (..._args: unknown[]) => {},
  addWatchFile: (_p: string) => {},
  emitFile: (_f: unknown) => "",
  // `parse` is never invoked by `transformTypia`; return an empty node typed as
  // the upstream AST node so the stub stays assignable without altering runtime.
  parse: (_c: string): StubAstNode => ({} as StubAstNode),
  getWatchFiles: () => [] as string[],
};

const combinedPlugin: esbuild.Plugin = {
  name: "sp-inject-schema-and-typia",
  setup(build) {
    build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
      if (args.path.includes("/node_modules/")) return undefined;
      const raw = await readFile(args.path, "utf8");
      const loader = args.path.endsWith(".tsx") ? "tsx" : "ts";

      // Step 1: rewrite .send<T>({...}) → inject typia.json.schema<T>() call.
      // injectSchemaIntoSendCalls self-fast-paths on ITS OWN trigger, so running
      // it on every file is cheap AND authoritative — we don't re-guess which
      // send forms it handles.
      const { code: afterInject, changed } = injectSchemaIntoSendCalls(raw, args.path);

      // CHEAP GATE: typia's transform spins up the TS compiler per file (~2-5s
      // each), so we run it ONLY when there's actually a `typia.*` call to inline:
      // either the injector just added one (`changed`), or the source calls typia
      // by hand. A file with neither is a guaranteed no-op → skip it (this is the
      // whole ~44-92s → ~4s win; for main-scaffolding NO file needs typia).
      const needsTypia = changed || /\btypia\s*\.\s*[A-Za-z]/.test(raw);
      if (!needsTypia) return { contents: afterInject, loader };

      // Step 2: hand to typia to inline the generic → JSON Schema literal.
      let transformed: string;
      try {
        // `transformTypia` takes branded `ID` / `Source` strings (type-fest
        // `Tagged<string, …>`). Those brands aren't exported, so reference the
        // exact declared parameter types via `Parameters<…>` and assert the
        // plain strings into them — type-fest sanctions casting the underlying
        // type into a tag (see Tagged docs).
        type TransformArgs = Parameters<typeof transformTypia>;
        transformed = await transformTypia(
          args.path as TransformArgs[0],
          afterInject as TransformArgs[1],
          unpluginCtxStub,
          typiaOpts,
        );
      } catch (e) {
        console.error(`[sp] typia transform failed for ${args.path}:`, (e as Error).message);
        transformed = afterInject;
      }
      return { contents: transformed, loader };
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
