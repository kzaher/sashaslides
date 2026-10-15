// BUILDS THE DECK WEB APPLICATION (SPEC.md 21.8, 16): esbuild bundles the two pages -- the deck list
// (src/web/deck-list/deck-list-entry.tsx) and the deck (src/web/deck-page/deck-page-entry.tsx) --
// into content-hashed files under dist/web/assets/, writes their shared stylesheet there under a
// content-hashed name too, writes the two page shells (dist/web/decks.html, dist/web/deck.html),
// builds the scripted-transition runner with the presenter's `buildPresenterAssets` into
// dist/web/runner/, and writes dist/web/manifest.json (`WebBuildManifest`), which the connector
// reads at startup to serve all of it.
//
//   npm run -s build:web                 build (minified)
//   npx tsx build-web.ts --no-minify     build readable bundles
//
// Key decisions:
//
//  * EVERY ASSET NAME CARRIES ITS CONTENT HASH, so the connector serves them `immutable` for a year
//    and a new build can never be half-cached. The page shells are not hashed: they are what the
//    connector answers at /decks and /deck/<id>, and they name the hashed files.
//  * THE TWO PAGES SHARE CHUNKS (esbuild `splitting`): React, Yjs and the theme load once and are
//    cached across /decks and /deck/<id>.
//  * THE OUTPUT DIRECTORY IS REPLACED, not added to, so dist/web/assets/ never accumulates the hashed
//    files of older builds and `manifest.assets` is the whole directory.
//  * THE POLICIES COME FROM src/web/content-security-policy.ts and the runner's from the presenter's
//    build, so the connector serves exactly what was built.

import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildPresenterAssets } from "./build-presenter.ts";
import type { WebBuildManifest } from "./src/contracts/deck-api.ts";
import { DECK_APPLICATION_ASSETS_PREFIX } from "./src/contracts/deck-api.ts";
import { deckPagesContentSecurityPolicies, PRESENTER_INLINE_STYLE_TEXTS } from "./src/web/content-security-policy.ts";
import { deckApplicationStylesheet, webPageMarkup } from "./src/web/web-page.ts";

const ENGINE_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_WEB_OUTPUT_DIRECTORY = join(ENGINE_DIRECTORY, "dist", "web");

export const LIST_PAGE_FILE = "decks.html";
export const DECK_PAGE_FILE = "deck.html";
export const ASSETS_DIRECTORY = "assets";
export const RUNNER_DIRECTORY = "runner";
export const MANIFEST_FILE = "manifest.json";

const LIST_ENTRY = join(ENGINE_DIRECTORY, "src/web/deck-list/deck-list-entry.tsx");
const DECK_ENTRY = join(ENGINE_DIRECTORY, "src/web/deck-page/deck-page-entry.tsx");

/** Builds the whole web application into `outputDirectory` and answers the manifest it wrote. */
export async function buildWeb(options: Readonly<{ outputDirectory: string; minify: boolean; now: () => Date }>): Promise<WebBuildManifest> {
  await rm(options.outputDirectory, { recursive: true, force: true });
  const assetsDirectory = join(options.outputDirectory, ASSETS_DIRECTORY);
  await mkdir(assetsDirectory, { recursive: true });

  const bundles = await build({
    entryPoints: { "deck-list": LIST_ENTRY, deck: DECK_ENTRY },
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: assetsDirectory,
    entryNames: "[name]-[hash]",
    chunkNames: "chunk-[hash]",
    assetNames: "[name]-[hash]",
    jsx: "automatic",
    minify: options.minify,
    sourcemap: "linked",
    legalComments: "none",
    metafile: true,
    define: { "process.env.NODE_ENV": options.minify ? '"production"' : '"development"' },
    logLevel: "warning",
  });

  const stylesheet = deckApplicationStylesheet();
  const stylesheetFile = `deck-app-${contentHash(stylesheet)}.css`;
  await writeFile(join(assetsDirectory, stylesheetFile), stylesheet);

  const runner = await buildPresenterAssets({ outputDirectory: join(options.outputDirectory, RUNNER_DIRECTORY), minify: options.minify });
  const runnerAddress = `${DECK_APPLICATION_ASSETS_PREFIX}${RUNNER_DIRECTORY}/${runner.runnerPagePath}`;

  const entryFile = (entryPoint: string): string => {
    for (const [output, details] of Object.entries(bundles.metafile.outputs)) {
      if (details.entryPoint !== undefined && join(ENGINE_DIRECTORY, details.entryPoint) === entryPoint) return basename(output);
    }
    throw new Error(`esbuild produced no output for ${relative(ENGINE_DIRECTORY, entryPoint)}`);
  };
  await writeFile(join(options.outputDirectory, LIST_PAGE_FILE), webPageMarkup({ title: "Your decks - Sasha Slides", stylesheetFile, scriptFile: entryFile(LIST_ENTRY), configuration: { runnerAddress } }));
  await writeFile(join(options.outputDirectory, DECK_PAGE_FILE), webPageMarkup({ title: "Sasha Slides", stylesheetFile, scriptFile: entryFile(DECK_ENTRY), configuration: { runnerAddress } }));

  const policies = deckPagesContentSecurityPolicies({
    inlineStyleHashes: PRESENTER_INLINE_STYLE_TEXTS.map((text) => createHash("sha256").update(text, "utf8").digest("base64")),
  });
  const manifest: WebBuildManifest = {
    listPage: LIST_PAGE_FILE,
    deckPage: DECK_PAGE_FILE,
    assets: (await readdir(assetsDirectory)).sort(),
    contentSecurityPolicy: policies.standalone,
    embeddedContentSecurityPolicy: policies.embedded,
    runnerPage: runner.runnerPagePath,
    runnerContentSecurityPolicy: runner.runnerContentSecurityPolicy,
    builtAt: options.now().toISOString(),
  };
  await writeFile(join(options.outputDirectory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The first 16 hexadecimal characters of SHA-256: esbuild's hashes are as long and as safe. */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = new Set(process.argv.slice(2));
  const manifest = await buildWeb({ outputDirectory: DEFAULT_WEB_OUTPUT_DIRECTORY, minify: !flags.has("--no-minify"), now: () => new Date() });
  console.log(`Built dist/web: ${manifest.listPage}, ${manifest.deckPage}, ${manifest.assets.length} assets, runner ${RUNNER_DIRECTORY}/${manifest.runnerPage}.`);
}
