/**
 * The browser scripts the connector serves are generated from TypeScript (bundled by
 * `browser-scripts/build.ts`). This fails when a checked-in generated module no longer matches
 * its source, so a source edit without the rebuild cannot ship.
 *
 *   node --test --import tsx mcp/sasha-slides/test/browser-scripts.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BROWSER_SCRIPTS, generatedModulePath, renderScriptModule } from "../browser-scripts/build.ts";

for (const script of BROWSER_SCRIPTS) {
  test(`${script.generatedModule} is the current build of ${script.entry} (rebuild: npx tsx mcp/sasha-slides/browser-scripts/build.ts)`, async () => {
    assert.equal(readFileSync(generatedModulePath(script), "utf-8"), await renderScriptModule(script));
  });
}
