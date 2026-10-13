/**
 * The passkey script the portal serves is generated from TypeScript
 * (`http/passkey-browser/passkey.ts`, bundled by `http/passkey-browser/build.ts`). This fails
 * when the checked-in `http/passkey-script.generated.ts` no longer matches its source, so a
 * source edit without the rebuild cannot ship.
 *
 *   node --test --import tsx mcp/sasha-slides/test/passkey-script.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PASSKEY_SCRIPT_MODULE, renderPasskeyScriptModule } from "../http/passkey-browser/build";

test("passkey-script.generated.ts is the current build of passkey.ts (rebuild: npx tsx mcp/sasha-slides/http/passkey-browser/build.ts)", async () => {
  assert.equal(readFileSync(PASSKEY_SCRIPT_MODULE, "utf-8"), await renderPasskeyScriptModule());
});
