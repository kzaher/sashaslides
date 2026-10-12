// The connector image's build context: exactly the files `server.ts` reaches at runtime,
// one repo-relative path per line on stdout. `deploy/publish.sh` tars this list, so the
// server never receives the add-on, the extension, the e2e drivers or any secret.
//
//   npx tsx mcp/sasha-slides/deploy/context-files.ts      (from the repo root)
//
// The import graph comes from esbuild's metafile, so a new import is shipped without
// anyone editing a list. Files read from disk rather than imported are named below.

import { build } from "esbuild";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const DEPLOY_DIR = import.meta.dirname;
const REPO_ROOT = join(DEPLOY_DIR, "..", "..", "..");
const ENTRY = "mcp/sasha-slides/server.ts";

/** Read with readFileSync, so no import graph can find them. */
const READ_AT_RUNTIME: readonly string[] = [
  // workflow-instructions.ts: the client instructions, `<moduleDir>/../../` + this path.
  ".claude/skills/sasha-slides/SKILL.md",
];

/** The image recipe itself. */
const DEPLOY_FILES: readonly string[] = ["Dockerfile", "docker-compose.yml", "package.json", "package-lock.json"].map(
  (name) => relative(REPO_ROOT, join(DEPLOY_DIR, name)),
);

// tsx runs this as CommonJS (the root package.json has no "type"), so no top-level await.
void main();

async function main(): Promise<void> {
  const files = [...(await importedFiles()), ...READ_AT_RUNTIME, ...DEPLOY_FILES].sort();
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
