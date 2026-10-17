// BUILDS THE DEVELOPER PAGE'S SCRIPTS into public/ (git-ignored; the image builds them too):
//
//   public/dev.js         dev-page.tsx: the page, the product converter and the compiled extractor
//   public/dev-pptx.js    pptx-download.ts: the offline .pptx path, loaded only on demand
//   public/e2e-drawio.js  drawio-harness.ts: the draw.io round-trip harness for e2e/drawio-editor.e2e.ts
//
// The extractor is compiled by renderer/html2slides/extractor-script.ts, the one place every caller
// gets it from, exactly as converter/calibration/in-page-converter.ts and the add-on build do.
// pptxgenjs is OUR FORK, bundled from its TypeScript source (deps/pptxgenjs/src): no rollup, no gulp,
// no prebuilt copy, so the bundle is the same on a laptop and in the image.
//
// The type check is NOT here: esbuild strips types without checking them, so `npm run typecheck`
// is its own failing step (and `npm test` runs it first).
//
//   npx tsx dev/build.ts          (from addon-server: npm run build)

import { build, type BuildOptions } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractorScript } from "../../extractor-script.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../../..");
export const PUBLIC_DIR = resolve(HERE, "../public");
export const PPTXGENJS_FORK_SOURCE = join(REPOSITORY_ROOT, "deps/pptxgenjs/src/pptxgen.ts");

export type PageBundle = Readonly<{ name: string; options: BuildOptions }>;

/** The three bundles, as esbuild options without an output decision (the tests bundle in memory). */
export function pageBundles(): readonly PageBundle[] {
  const common: BuildOptions = {
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  };
  return [
    {
      name: "dev.js",
      options: {
        ...common,
        entryPoints: [join(HERE, "dev-page.tsx")],
        jsx: "automatic",
        jsxImportSource: "preact",
        define: { __SASHA_EXTRACTOR_JS__: JSON.stringify(extractorScript({ minify: true })) },
      },
    },
    {
      name: "dev-pptx.js",
      options: {
        ...common,
        entryPoints: [join(HERE, "pptx-download.ts")],
        alias: { pptxgenjs: PPTXGENJS_FORK_SOURCE },
        // The fork reaches for node:fs / node:https only behind a Node check, and `sizeof` only
        // behind `typeof require`; neither runs in a browser, so they stay unresolved.
        external: ["node:*", "sizeof"],
        define: { __EXTRACT_JS_LITERAL__: JSON.stringify(extractorScript()) },
      },
    },
    { name: "e2e-drawio.js", options: { ...common, entryPoints: [join(HERE, "drawio-harness.ts")] } },
  ];
}

async function main(): Promise<void> {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const bundle of pageBundles()) {
    const outfile = join(PUBLIC_DIR, bundle.name);
    const result = await build({ ...bundle.options, outfile, metafile: true });
    const bytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
    process.stdout.write(`${bundle.name.padEnd(14)} ${bytes.toLocaleString().padStart(11)} bytes -> ${outfile}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
