// THE PRESENTER'S BUILD STEP (contracts/module-surfaces.ts `BuildPresenterAssets`): bundles the
// runner bootstrap (src/presenter/runner/bootstrap.ts) with esbuild into `runner-bootstrap.js` and
// writes the runner page `index.html` next to it in `outputDirectory`, then returns the page's path
// relative to that directory and the content security policy its server must send with it. The
// view's build-demo.ts calls this with `dist/runner` and serves that directory on the runner's own
// site (SPEC.md section 16).
//
// Built-in transitions are not built here: they are ordinary modules in the editor bundle. The
// bootstrap is a separate file, not inline, because the runner's policy allows scripts only from
// `self` and `blob:`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { BuildPresenterAssets } from "./src/contracts/index.ts";
import { RUNNER_BOOTSTRAP_FILE, RUNNER_CONTENT_SECURITY_POLICY, runnerPageMarkup } from "./src/presenter/runner/runner-page.ts";

export const buildPresenterAssets: BuildPresenterAssets = async (options) => {
  await mkdir(options.outputDirectory, { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL("./src/presenter/runner/bootstrap.ts", import.meta.url))],
    outfile: join(options.outputDirectory, RUNNER_BOOTSTRAP_FILE),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: options.minify,
    sourcemap: options.minify ? false : "inline",
    legalComments: "none",
    logLevel: "warning",
  });
  await writeFile(join(options.outputDirectory, RUNNER_PAGE_FILE), runnerPageMarkup({ bootstrapAddress: RUNNER_BOOTSTRAP_FILE }));
  return { runnerPagePath: RUNNER_PAGE_FILE, runnerContentSecurityPolicy: RUNNER_CONTENT_SECURITY_POLICY };
};

const RUNNER_PAGE_FILE = "index.html";
