/**
 * The connector image's two build-time gates, run the way the Dockerfile and publish.sh run them
 * (acceptance 12): the build context lists the deck server's engine sources, and `server.ts
 * --help` loads the whole import graph -- engine ECMAScript modules required from tsx's CommonJS
 * included (SPEC.md 21.18) -- and exits 0.
 *
 *   cd mcp/sasha-slides && npx tsx --test decks/packaging.test.ts
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPOSITORY_ROOT = join(__dirname, "..", "..", "..");

test("context-files.ts lists the engine's model and server sources, its package.json and any web build", () => {
  const run = spawnSync("npx", ["tsx", "mcp/sasha-slides/deploy/context-files.ts"], { cwd: REPOSITORY_ROOT, encoding: "utf-8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const files = run.stdout.split("\n").filter((line) => line !== "");
  for (const expected of [
    "mcp/sasha-slides/engine/package.json",
    "mcp/sasha-slides/engine/src/server/deck-room.ts",
    "mcp/sasha-slides/engine/src/server/protected-field-guard.ts",
    "mcp/sasha-slides/engine/src/model/document-store.ts",
    "mcp/sasha-slides/engine/src/model/agent-histories.ts",
    "mcp/sasha-slides/decks/deck-stack.ts",
  ]) {
    assert.ok(files.includes(expected), `${expected} is not in the build context`);
  }
  assert.equal(files.some((file) => file.includes("node_modules")), false, "dependencies come from the image's npm ci");
  assert.equal(files.some((file) => file.endsWith(".test.ts") || file.endsWith("deck-test-support.ts")), false, "no test code ships");
  const manifest = "mcp/sasha-slides/engine/dist/web/manifest.json";
  assert.equal(files.includes(manifest), existsSync(join(REPOSITORY_ROOT, manifest)), "the web build ships exactly when it exists");
});

test("server.ts --help exits 0 with the engine imported through tsx's CommonJS", () => {
  const run = spawnSync("npx", ["tsx", "mcp/sasha-slides/server.ts", "--help"], { cwd: REPOSITORY_ROOT, encoding: "utf-8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /--deck-data/u);
  assert.doesNotMatch(run.stderr, /Yjs was already imported/u, "one copy of Yjs");
});
