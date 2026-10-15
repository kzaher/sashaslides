// The connector image's build context: exactly the files `server.ts` reaches at runtime,
// one repo-relative path per line on stdout. `deploy/publish.sh` tars this list, so the
// server never receives the add-on, the extension, the e2e drivers or any secret.
//
//   npx tsx mcp/sasha-slides/deploy/context-files.ts      (from the repo root)
//
// The import graph comes from esbuild's metafile, so a new import is shipped without
// anyone editing a list -- the deck server's engine sources (engine/src/model, engine/src/server
// and the contract files they import) arrive that way. Files read from disk rather than imported
// are named below, and the built deck web application (engine/dist/web/**, read at runtime by
// decks/web-application.ts) is listed from disk: publish.sh builds it first.

import { build } from "esbuild";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DEPLOY_DIR = import.meta.dirname;
const REPO_ROOT = join(DEPLOY_DIR, "..", "..", "..");
const ENTRY = "mcp/sasha-slides/server.ts";

/** Read with readFileSync, so no import graph can find them. */
const READ_AT_RUNTIME: readonly string[] = [
  // workflow-instructions.ts: the client instructions, `<moduleDir>/../../` + this path.
  ".claude/skills/sasha-slides/SKILL.md",
  // Its "type": "module" makes tsx load the engine's sources as ECMAScript modules in the image
  // exactly as in development (SPEC.md 21.18); without it they would load as CommonJS instead.
  "mcp/sasha-slides/engine/package.json",
];

/** The built deck web application, served from disk (decks/web-application.ts). */
const WEB_BUILD_DIRECTORY = "mcp/sasha-slides/engine/dist/web";

/** The image recipe itself. */
const DEPLOY_FILES: readonly string[] = ["Dockerfile", "docker-compose.yml", "package.json", "package-lock.json"].map(
  (name) => relative(REPO_ROOT, join(DEPLOY_DIR, name)),
);

// tsx runs this as CommonJS (the root package.json has no "type"), so no top-level await.
void main();

async function main(): Promise<void> {
  const webBuild = filesUnder(WEB_BUILD_DIRECTORY);
  if (!webBuild.includes(`${WEB_BUILD_DIRECTORY}/manifest.json`)) {
    process.stderr.write(`context-files: ${WEB_BUILD_DIRECTORY} is not built (no manifest.json); /decks will answer 503 until it is\n`);
  }
  const files = [...(await importedFiles()), ...READ_AT_RUNTIME, ...webBuild, ...DEPLOY_FILES].sort();
  const missing = files.filter((file) => !existsSync(join(REPO_ROOT, file)));
  if (missing.length > 0) {
    process.stderr.write(`context-files: missing ${missing.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`${files.join("\n")}\n`);
}

async function importedFiles(): Promise<readonly string[]> {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    write: false,
    logLevel: "error",
  });
  return Object.keys(result.metafile.inputs).filter((path) => !path.startsWith("node_modules/"));
}

/** Every file under `directory` (repo-relative), or none when it does not exist. */
function filesUnder(directory: string): readonly string[] {
  const absolute = join(REPO_ROOT, directory);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const name of readdirSync(absolute)) {
    const path = `${directory}/${name}`;
    if (statSync(join(REPO_ROOT, path)).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}
