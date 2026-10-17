// BUILDS THE EDITOR DEMO (SPEC.md section 16): esbuild bundles src/view/application/demo.tsx into
// dist/demo/editor.js (minified, with a source map), writes dist/demo/editor.css (the shared
// Tidepool stylesheet, then the view's own rules) and dist/demo/index.html, and calls the
// presenter's `buildPresenterAssets` to build the sandboxed transition runner into dist/runner.
//
//   npx tsx build-demo.ts            build
//   npx tsx build-demo.ts --serve    build, then serve: the editor on http://127.0.0.1:8790 and the
//                                    runner, with its content security policy header, on
//                                    http://localhost:8791 -- two different sites, so a runaway
//                                    transition script runs in another process.
//
// Key decisions:
//
//  * THE SERVERS ARE `setsid`-DETACHED, never a bare background shell (project rules): the build
//    re-runs this file with `--serve-foreground` in its own session, logs to dist/serve.log, and
//    returns once both ports answer. Stop it with the process id it prints.
//  * THE RUNNER'S ADDRESS IS CONFIGURATION, written into the page as an inert JSON block and parsed
//    by the demo at its boundary, so the editor never guesses the other site.

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPresenterAssets, type RunnerBuild } from "./build-presenter.ts";
import { serveDirectory } from "./serve-directory.ts";
import { editorPageMarkup, editorStylesheet } from "./src/view/application/editor-page.ts";

export const EDITOR_SITE = { host: "127.0.0.1", port: 8790 } as const;
export const RUNNER_SITE = { host: "localhost", port: 8791 } as const;

const ENGINE_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(ENGINE_DIRECTORY, "dist");
const DEMO_DIRECTORY = join(DIST, "demo");
const RUNNER_DIRECTORY = join(DIST, "runner");
const RUNNER_POLICY_FILE = join(RUNNER_DIRECTORY, "policy.json");

/** Builds dist/demo and dist/runner; returns the runner build. */
export async function buildDemo(options: Readonly<{ minify: boolean }>): Promise<RunnerBuild> {
  await mkdir(DEMO_DIRECTORY, { recursive: true });
  await mkdir(RUNNER_DIRECTORY, { recursive: true });
  const runner = await buildPresenterAssets({ outputDirectory: RUNNER_DIRECTORY, minify: options.minify });
  await writeFile(RUNNER_POLICY_FILE, JSON.stringify(runner));
  const runnerAddress = `http://${RUNNER_SITE.host}:${RUNNER_SITE.port}/${runner.runnerPagePath}`;
  await build({
    entryPoints: [join(ENGINE_DIRECTORY, "src/view/application/demo.tsx")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(DEMO_DIRECTORY, "editor.js"),
    jsx: "automatic",
    minify: options.minify,
    sourcemap: true,
    define: { "process.env.NODE_ENV": options.minify ? '"production"' : '"development"' },
    logLevel: "warning",
  });
  await writeFile(join(DEMO_DIRECTORY, "editor.css"), editorStylesheet());
  await writeFile(join(DEMO_DIRECTORY, "index.html"), editorPageMarkup({ title: "Sasha editor", stylesheetPath: "editor.css", scriptPath: "editor.js", configuration: { runnerAddress } }));
  return runner;
}

/** Starts the servers in their own session (see the header) and waits until both answer. */
export async function serveDetached(): Promise<void> {
  if ((await answers(EDITOR_SITE)) && (await answers(RUNNER_SITE))) {
    console.log(`Already serving: editor http://${EDITOR_SITE.host}:${EDITOR_SITE.port}/  runner http://${RUNNER_SITE.host}:${RUNNER_SITE.port}/`);
    return;
  }
  const log = openSync(join(DIST, "serve.log"), "a");
  const child = spawn("setsid", [process.execPath, "--import", "tsx", fileURLToPath(import.meta.url), "--serve-foreground"], { cwd: ENGINE_DIRECTORY, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if ((await answers(EDITOR_SITE)) && (await answers(RUNNER_SITE))) {
      console.log(`Serving (process ${child.pid ?? "unknown"}, log dist/serve.log):`);
      console.log(`  editor  http://${EDITOR_SITE.host}:${EDITOR_SITE.port}/            two editors: http://${EDITOR_SITE.host}:${EDITOR_SITE.port}/?editors=2`);
      console.log(`  runner  http://${RUNNER_SITE.host}:${RUNNER_SITE.port}/`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("The demo servers did not answer within 25 seconds; see dist/serve.log");
}

/** The two servers, in this process (run by `serveDetached` in its own session). */
export async function serveForeground(): Promise<void> {
  const runner = parseRunnerBuild(await readFile(RUNNER_POLICY_FILE, "utf8"));
  await serveDirectory({ directory: DEMO_DIRECTORY, ...EDITOR_SITE });
  await serveDirectory({
    directory: RUNNER_DIRECTORY,
    // "::" answers both families: "localhost" alone binds one, and fetch may resolve the other.
    host: "::",
    port: RUNNER_SITE.port,
    headers: (path) => (runner !== null && extname(path) === ".html" ? { "content-security-policy": runner.runnerContentSecurityPolicy } : {}),
  });
  console.log(`editor on ${EDITOR_SITE.host}:${EDITOR_SITE.port}, runner on ${RUNNER_SITE.host}:${RUNNER_SITE.port}`);
}

async function answers(site: Readonly<{ host: string; port: number }>): Promise<boolean> {
  try {
    const response = await fetch(`http://${site.host}:${site.port}/`, { signal: AbortSignal.timeout(500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function parseRunnerBuild(text: string): RunnerBuild | null {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const runnerPagePath = Reflect.get(parsed, "runnerPagePath");
  const runnerContentSecurityPolicy = Reflect.get(parsed, "runnerContentSecurityPolicy");
  return typeof runnerPagePath === "string" && typeof runnerContentSecurityPolicy === "string" ? { runnerPagePath, runnerContentSecurityPolicy } : null;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--serve-foreground")) {
    await serveForeground();
  } else {
    await buildDemo({ minify: !flags.has("--no-minify") });
    console.log("Built dist/demo and dist/runner.");
    if (flags.has("--serve")) await serveDetached();
  }
}
