/**
 * The add-on's deck-editor pieces (SPEC.md 21.13): the generated Code.gs carries the menu item and
 * the functions, the manifest the two identity scopes, the shell stays a few kilobytes, and the
 * shell's relay listens only to the editor's own origin and source.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, transformSync } from "esbuild";
import { APPS_SCRIPT_MANIFEST, codeGs, DEFAULT_EDITOR_ORIGIN } from "./apps-script-project.ts";
import { SERVER_FUNCTION_NAMES } from "./bridge.ts";
import { createShellMessageHandler, editorFrameAddress, parseEditorSeed, type ExportOutcome } from "./editor-shell.ts";
import { EDITOR_SHELL_BUDGET_BYTES, SURFACE_BUDGET_BYTES } from "./surface-budget.ts";
import type { AddonShellMessage } from "../../engine/src/contracts/deck-api.ts";

const CODE = codeGs({ editorOrigin: DEFAULT_EDITOR_ORIGIN });

test("Code.gs: the 'Open in Sasha editor' menu item calls sashaOpenEditor, and the editor's functions exist", () => {
  assert.match(CODE, /\.addItem\('Open in Sasha editor', 'sashaOpenEditor'\)/);
  for (const name of ["sashaOpenEditor", "sashaRunExport", "sashaImportAgain"]) assert.match(CODE, new RegExp(`^function ${name}\\(`, "m"), name);
  for (const name of SERVER_FUNCTION_NAMES) assert.match(CODE, new RegExp(`^function ${name}\\(`, "m"), `${name} is callable from a surface, so Code.gs must declare it`);
  assert.match(CODE, /var SASHA_EDITOR_ORIGIN = 'https:\/\/sashaslides\.com';/);
  assert.match(CODE, /showModelessDialog\(page, 'Sasha editor'\)/);
  assert.match(CODE, /Utilities\.getUuid\(\) \+ Utilities\.getUuid\(\)/, "the binding secret is two UUIDs");
  assert.doesNotThrow(() => transformSync(CODE, { loader: "js", format: "iife", target: "es2017" }), "Code.gs parses as V8 script");
  assert.throws(() => codeGs({ editorOrigin: "http://insecure.example" }), /https origin/);
});

test("appsscript.json lists the openid and email scopes beside the four the add-on had", () => {
  const manifest: unknown = JSON.parse(APPS_SCRIPT_MANIFEST);
  const scopes = typeof manifest === "object" && manifest !== null && "oauthScopes" in manifest && Array.isArray(manifest.oauthScopes) ? manifest.oauthScopes : [];
  assert.ok(scopes.includes("openid"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/userinfo.email"));
  assert.equal(scopes.length, 6);
});

test("EditorShell.html stays under 10 KB (and every surface under SURFACE_BUDGET_BYTES, which build-addon enforces)", async () => {
  const bundled = await build({
    entryPoints: [new URL("./editor-shell.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    logLevel: "silent",
  });
  const script = bundled.outputFiles[0]?.text ?? "";
  // build-addon's page wrapper (surfaceHtml) adds under a kilobyte of fixed markup around the bundle.
  const pageEstimate = script.length + 1024;
  assert.ok(pageEstimate < EDITOR_SHELL_BUDGET_BYTES, `EditorShell.html would be about ${pageEstimate} bytes`);
  assert.equal(EDITOR_SHELL_BUDGET_BYTES, 10 * 1024);
  assert.ok(EDITOR_SHELL_BUDGET_BYTES < SURFACE_BUDGET_BYTES);
  assert.doesNotMatch(script, /react/i, "the shell does not carry React");
});

test("the shell's relay ignores any origin but the editor's and any source but sasha-editor", () => {
  const origin = "https://sashaslides.com";
  // Columns: the message's origin and data -> whether it is handled, and the effect it has.
  const rows: readonly Readonly<{ label: string; origin: string; data: unknown; outcome: "ignored" | "handled"; effect: string | null }>[] = [
    { label: "export from the editor", origin, data: { source: "sasha-editor", kind: "exportRequested", exportId: "export-1" }, outcome: "handled", effect: "export:export-1" },
    { label: "close from the editor", origin, data: { source: "sasha-editor", kind: "closeRequested" }, outcome: "handled", effect: "close" },
    { label: "ready from the editor", origin, data: { source: "sasha-editor", kind: "ready" }, outcome: "handled", effect: null },
    { label: "another origin", origin: "https://evil.example", data: { source: "sasha-editor", kind: "exportRequested", exportId: "export-1" }, outcome: "ignored", effect: null },
    { label: "a look-alike origin", origin: "https://sashaslides.com.evil.example", data: { source: "sasha-editor", kind: "closeRequested" }, outcome: "ignored", effect: null },
    { label: "the right origin, another source", origin, data: { source: "sasha-addon-shell", kind: "closeRequested" }, outcome: "ignored", effect: null },
    { label: "no source", origin, data: { kind: "closeRequested" }, outcome: "ignored", effect: null },
    { label: "not an object", origin, data: "closeRequested", outcome: "ignored", effect: null },
    { label: "an unknown kind", origin, data: { source: "sasha-editor", kind: "deleteEverything" }, outcome: "ignored", effect: null },
    { label: "an export without an id", origin, data: { source: "sasha-editor", kind: "exportRequested" }, outcome: "ignored", effect: null },
  ];
  for (const row of rows) {
    const effects: string[] = [];
    const posted: AddonShellMessage[] = [];
    const handler = createShellMessageHandler({
      editorOrigin: origin,
      effects: {
        postToEditor: (message) => posted.push(message),
        runExport: ({ exportId, finished }) => {
          effects.push(`export:${exportId}`);
          const outcome: ExportOutcome = { kind: "applied" };
          finished(outcome);
        },
        close: () => effects.push("close"),
      },
    });
    assert.equal(handler({ origin: row.origin, data: row.data }), row.outcome, row.label);
    assert.deepEqual(effects, row.effect === null ? [] : [row.effect], row.label);
    if (row.effect?.startsWith("export:") === true) {
      assert.deepEqual(posted, [{ source: "sasha-addon-shell", kind: "exportFinished", exportId: "export-1", outcome: "applied", message: "" }], "the answer names the export");
    }
  }
});

test("the seed Code.gs appends, and the editor frame's address", () => {
  assert.deepEqual(parseEditorSeed(JSON.stringify({ kind: "open", editorOrigin: "https://sashaslides.com", deckId: "dk_abc", ticket: "t1" })), { kind: "open", editorOrigin: "https://sashaslides.com", deckId: "dk_abc", ticket: "t1" });
  assert.equal(parseEditorSeed(JSON.stringify({ kind: "open", editorOrigin: "javascript:alert(1)", deckId: "dk_abc", ticket: "t1" })), null, "only an https origin");
  assert.equal(parseEditorSeed("not json"), null);
  assert.equal(parseEditorSeed(JSON.stringify({ kind: "failed", editorOrigin: "https://sashaslides.com", message: "Sign in" }))?.kind, "failed");
  assert.equal(editorFrameAddress({ editorOrigin: "https://sashaslides.com", deckId: "dk_abc", ticket: "a b" }), "https://sashaslides.com/deck/dk_abc?embed=addon#ticket=a%20b");
});
