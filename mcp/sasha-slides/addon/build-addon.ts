#!/usr/bin/env npx tsx
/**
 * build-addon.ts — emits the ready-to-push Apps Script project for sasha-slides.
 *
 *   src/sidebar.tsx  ->  Sidebar.html   (Ask Sasha: the assistant connection + the assets)
 *   src/dialog.tsx   ->  Dialog.html    (the slides: the grid + the mark-up view)
 *   src/report.tsx   ->  Report.html    (the defect report: anonymise, review, send)
 *   src/editor-shell.ts -> EditorShell.html (the deck editor's thin frame host, SPEC.md 21.13)
 *   src/apps-script-project.ts codeGs() -> Code.gs (every google.script.run function + the two menu items)
 *   src/apps-script-project.ts APPS_SCRIPT_MANIFEST -> appsscript.json
 *
 * THREE BUNDLES, BECAUSE THERE ARE THREE DOCUMENTS, and the third one exists FOR THE SIZE.
 * HtmlService has been observed corrupting a ~560 KB inlined blob with "Uncaught SyntaxError:
 * Invalid or unexpected token", and the bundle cannot be base64'd because the sandbox's
 * content-security policy forbids `unsafe-eval` -- so what goes in which bundle is a correctness
 * decision, not a tidiness one:
 *
 *   * the CONVERTER and the base64 extractor blob are reachable from dialog.tsx and report.tsx,
 *     never from sidebar.tsx, which is why Ask Sasha is a fraction of the size;
 *   * the ANONYMISER (src/anonymise/, ~47 KB bundled) plus Defect.tsx plus report-endpoint.ts are
 *     reachable only from report.tsx. Moving them out of Dialog.html is what brought it back under
 *     500 KB -- the same reasoning that took Sidebar.html from 439 KB to 256 KB when the surfaces
 *     were first split.
 *
 * The build prints all three so a regression in any of them is visible.
 *
 * Output goes to the repo-root dist/ (gitignored), mirroring the source path:
 *
 *   dist/mcp/sasha-slides/addon/{appsscript.json, Code.gs, Sidebar.html, Dialog.html, Report.html, EditorShell.html}
 *
 * SASHA_EDITOR_ORIGIN (default https://sashaslides.com) is where Code.gs sends the editor handoff
 * and where the editor frame is loaded from; a development build points it at a tunnel.
 *
 * It mirrors renderer/html2slides/browser/build-addon.ts in spirit and differs in two ways that
 * matter:
 *
 *   1. THE TYPECHECK IS ITS OWN FAILING STEP, BEFORE ANYTHING IS EMITTED. esbuild strips types
 *      without checking them (CLAUDE.md: "structured-prompting builds with esbuild only -- a
 *      misnamed object-literal field silently no-ops"), so `tsc --noEmit` runs first over BOTH
 *      projects: the shipped sources (browser types only) and the tests (which may also see
 *      @types/node). A type error here stops the build; it does not warn.
 *   2. NOTHING IS HAND-EDITED. Every emitted file carries a generated-file header and this script
 *      overwrites it wholesale. Code.gs in particular is a string in THIS file -- Apps Script's
 *      editor is not the source of truth.
 *
 * Run: cd mcp/sasha-slides/addon && npx tsx build-addon.ts
 */
import { build, transformSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBinary, minifiedStylesheets } from "./build-support.ts";
import { APPS_SCRIPT_MANIFEST, codeGs, DEFAULT_EDITOR_ORIGIN, GENERATED_BY } from "./src/apps-script-project.ts";
import { extractorScript } from "../../../renderer/html2slides/extractor-script.ts";
import { SERVER_FUNCTION_NAMES } from "./src/bridge.ts";
import { connectorUrlOf } from "./src/connector-url.ts";
import { EDITOR_SHELL_BUDGET_BYTES, SURFACE_BUDGET_BYTES } from "./src/surface-budget.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const OUT = join(REPO_ROOT, "dist", "mcp", "sasha-slides", "addon");
const TYPECHECK_PROJECTS = ["tsconfig.json", "tsconfig.test.json"] as const;

async function main(): Promise<void> {
  // 1. THE GATE, before anything is emitted. Two projects: the shipped sources (browser types only)
  //    and the tests (which may also see @types/node). Both must be clean.
  const tsc = findBinary({ name: "tsc", roots: [HERE, REPO_ROOT], caller: "build-addon.ts" });
  for (const project of TYPECHECK_PROJECTS) {
    process.stdout.write(`typecheck  ${project}\n`);
    execFileSync(tsc, ["--noEmit", "-p", join(HERE, project)], { stdio: "inherit" });
  }

  // 2. The extractor, compiled exactly as the renderer compiles it (renderer/html2slides/
  //    extractor-script.ts) -- a bare IIFE source string. It is a SCRIPT, not a module (no
  //    `export`), so the bundler is the only thing that can carry it; the converter runs it inside
  //    its staging iframe.
  // MINIFIED, and that is a size decision with a measurement behind it: base64 costs 33% on top of
  // whatever it wraps, so every byte here costs 1.33 in the two bundles that carry it. Un-minified
  // it was 93 KB -> 125 KB of base64, which is a quarter of Dialog.html's entire budget. The
  // extractor is a self-contained IIFE that reads the DOM and never looks at a function's `.name`
  // or its `toString()`, so renaming is safe -- and the browser smoke test converts a real
  // candidate through this exact base64 path, so a mangled extractor fails a test rather than a
  // user's slide.
  const extractorJs = extractorScript({ minify: true });
  // Base64, not a raw string literal. HtmlService sanitises and relays the sidebar document, and a
  // large inlined blob has been observed to come back corrupted ("Uncaught SyntaxError: Invalid or
  // unexpected token" -- see renderer/html2slides/browser/build-addon.ts step 3). Base64 narrows
  // the whole payload to [A-Za-z0-9+/=], which nothing in that pipeline can mangle; the 33% growth
  // is the price. sidebar.tsx decodes it with atob + TextDecoder.
  const extractorBase64 = Buffer.from(extractorJs, "utf-8").toString("base64");
  process.stdout.write(
    `extractor  extract-dom.ts -> ${extractorJs.length.toLocaleString()} bytes JS` +
      ` -> ${extractorBase64.length.toLocaleString()} bytes base64\n`,
  );

  // 3. THREE BUNDLES, one per document. IIFE, because each is inlined into one <script>.
  //
  //    The EXTRACTOR goes to the two that convert: `__SASHA_EXTRACTOR_JS_B64__` is referenced from
  //    dialog.tsx and report.tsx, never from sidebar.tsx, so the conversation's bundle neither
  //    needs nor contains the blob. The ANONYMISER goes only to report.tsx. That is the whole
  //    reason the three differ so much in size -- see the printed figures below, and the ceiling
  //    they exist to stay under.
  const dialogJs = await bundleSurface({
    entry: join(HERE, "src", "dialog.tsx"),
    define: {
      "process.env.NODE_ENV": '"production"',
      __SASHA_EXTRACTOR_JS_B64__: JSON.stringify(extractorBase64),
    },
  });
  const reportJs = await bundleSurface({
    entry: join(HERE, "src", "report.tsx"),
    define: {
      "process.env.NODE_ENV": '"production"',
      __SASHA_EXTRACTOR_JS_B64__: JSON.stringify(extractorBase64),
    },
  });
  //    The SIDEBAR gets the two facts its "nothing is listening" setup panel prints: this
  //    checkout's absolute path (the Dev tab's exact command) and the hosted connector's address
  //    (the Setup tab): production unless SASHA_CONNECTOR_URL names another, and `null` only for
  //    SASHA_CONNECTOR_URL=none -- the panel then says it is not configured (src/connector-url.ts).
  const connectorUrl = connectorUrlOf(process.env.SASHA_CONNECTOR_URL);
  const sidebarJs = await bundleSurface({
    entry: join(HERE, "src", "sidebar.tsx"),
    define: {
      "process.env.NODE_ENV": '"production"',
      __SASHA_REPO_ROOT__: JSON.stringify(REPO_ROOT),
      __SASHA_CONNECTOR_URL__: JSON.stringify(connectorUrl),
    },
  });
  process.stdout.write(`connector  ${connectorUrl ?? "not configured (SASHA_CONNECTOR_URL=none)"}\n`);

  // 4. The three pages. No `eval` anywhere and no external <script src>: the Slides editor serves
  //    an HtmlService document from a sandboxed googleusercontent iframe whose CSP forbids
  //    `unsafe-eval`, so the bundle is an inline <script> (which runs synchronously on parse and
  //    does not trip that CSP) and the extractor reaches its staging iframe through the
  //    inline-<script> injection path in converter/convert-html-to-slide-requests.ts -- the same
  //    fallback proven at renderer/html2slides/browser/convert-core.ts:89-113.
  //    THE EDITOR SHELL: a few kilobytes that only host the deck editor's frame and relay its
  //    messages (src/editor-shell.ts). Told nothing at build time: Code.gs seeds it at runtime.
  const editorShellJs = await bundleSurface({ entry: join(HERE, "src", "editor-shell.ts"), define: {} });
  const editorOrigin = process.env.SASHA_EDITOR_ORIGIN ?? DEFAULT_EDITOR_ORIGIN;
  if (!/^https:\/\/[a-z0-9.-]+$/.test(editorOrigin)) throw new Error(`SASHA_EDITOR_ORIGIN must be an https origin, got ${editorOrigin}`);
  process.stdout.write(`editor     ${editorOrigin}\n`);
  const CODE_GS = codeGs({ editorOrigin });
  const editorShellHtml = surfaceHtml({ from: "src/editor-shell.ts", script: editorShellJs });

  const dialogHtml = surfaceHtml({ from: "src/dialog.tsx", script: dialogJs });
  const reportHtml = surfaceHtml({ from: "src/report.tsx", script: reportJs });
  const sidebarHtml = surfaceHtml({ from: "src/sidebar.tsx", script: sidebarJs });

  // 5. Emit.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "appsscript.json"), APPS_SCRIPT_MANIFEST);
  writeFileSync(join(OUT, "Code.gs"), CODE_GS);
  writeFileSync(join(OUT, "Sidebar.html"), sidebarHtml);
  writeFileSync(join(OUT, "Dialog.html"), dialogHtml);
  writeFileSync(join(OUT, "Report.html"), reportHtml);
  writeFileSync(join(OUT, "EditorShell.html"), editorShellHtml);
  process.stdout.write(`\nwrote the Apps Script project to ${OUT}\n`);
  process.stdout.write(`    appsscript.json  (6 scopes)\n`);
  /*
   * CODE.GS IS PARSED BEFORE IT IS EMITTED.
   *
   * It is a template literal in this file, so TypeScript never looks inside it: a stray bracket
   * or a bad `var` shipped happily and only surfaced as a broken add-on after a deploy, with no
   * line number. esbuild parses it here for the price of nothing. V8 is the Apps Script runtime,
   * so plain-script syntax is exactly the right dialect to check against.
   */
  try {
    transformSync(CODE_GS, { loader: "js", format: "iife", target: "es2017" });
  } catch (cause: unknown) {
    throw new Error(`Code.gs does not parse: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const declared = serverFunctionsMissingFrom(CODE_GS);
  if (declared.length > 0) {
    // A name the client can call but Code.gs does not define is the "Script function not found"
    // that explainHostFailure (src/bridge.ts) exists to diagnose at RUNTIME, in a deployed add-on.
    // It is cheaper to refuse to emit.
    throw new Error(`Code.gs does not declare ${declared.join(", ")} -- SERVER_FUNCTION_NAMES lists them as callable`);
  }
  process.stdout.write(
    `    Code.gs          (${CODE_GS.length.toLocaleString()} bytes, ${SERVER_FUNCTION_NAMES.length} server functions)\n`,
  );
  process.stdout.write(`    Sidebar.html     (${kb(sidebarHtml)} KB, Ask Sasha -- connection + assets)\n`);
  process.stdout.write(`    Dialog.html      (${kb(dialogHtml)} KB, the slides + converter)\n`);
  process.stdout.write(`    Report.html      (${kb(reportHtml)} KB, the defect report + anonymiser)\n`);
  process.stdout.write(`    EditorShell.html (${(editorShellHtml.length / 1024).toFixed(1)} KB, the deck editor's frame host)\n`);

  // 6. THE CEILING, enforced rather than hoped for. HtmlService has been observed corrupting a
  //    ~560 KB inlined blob ("Uncaught SyntaxError: Invalid or unexpected token"), and there is no
  //    base64 escape for the page itself because the sandbox's CSP forbids `unsafe-eval`. So a
  //    bundle that grows past the budget fails the BUILD, here, rather than failing in a user's
  //    browser with a syntax error in minified code.
  const tooBig = [
    { name: "Sidebar.html", html: sidebarHtml },
    { name: "Dialog.html", html: dialogHtml },
    { name: "Report.html", html: reportHtml },
    { name: "EditorShell.html", html: editorShellHtml },
  ].filter((page) => page.html.length > SURFACE_BUDGET_BYTES);
  if (tooBig.length > 0) {
    const named = tooBig.map((page) => `${page.name} is ${kb(page.html)} KB`).join(", ");
    throw new Error(
      `${named} -- over the ${(SURFACE_BUDGET_BYTES / 1024).toFixed(0)} KB HtmlService budget. ` +
        "Move code to another surface; do NOT raise this number without new evidence.",
    );
  }
  // The shell's own, much smaller budget (SPEC.md 21.13: "a few kilobytes"): it is a frame host,
  // and anything more belongs in the editor it hosts.
  if (editorShellHtml.length > EDITOR_SHELL_BUDGET_BYTES) {
    throw new Error(`EditorShell.html is ${editorShellHtml.length} bytes -- over its ${EDITOR_SHELL_BUDGET_BYTES} byte budget.`);
  }
  process.stdout.write(`\nclasp:  cd ${OUT} && clasp push\n`);
}

/** One surface's inlined IIFE bundle. */
async function bundleSurface({
  entry,
  define,
}: {
  entry: string;
  define: Readonly<Record<string, string>>;
}): Promise<string> {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    // PREACT, NOT REACT, IN EVERY SHIPPED PAGE (review S-1). The sources keep importing "react" and
    // are type-checked against @types/react; only the bundle swaps the runtime. Measured: react-dom
    // was ~209 KB of each page, preact/compat is ~10 KB, so every surface gains ~200 KB of headroom
    // under SURFACE_BUDGET_BYTES. package.json maps react/react-dom to @preact/compat as well, so
    // the node tests exercise the same runtime the pages ship -- never test React while shipping
    // Preact. The engine keeps React for its own web build; none of its React modules is bundled
    // here (only its contracts and theme constants).
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react-dom/client": "preact/compat/client",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    define: { ...define },
    plugins: [minifiedStylesheets()],
  });
  const text = bundled.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error(`esbuild produced no output for ${entry}`);
  process.stdout.write(`bundle     ${entry.slice(HERE.length + 1)} -> ${text.length.toLocaleString()} bytes JS\n`);
  return text;
}

/**
 * The HtmlService page around one bundle. Identical for every surface; only the script differs.
 *
 * THE BUNDLE IS NOT AN EXECUTABLE <script>. MEASURED 2026-10-04 on the Report web app: HtmlService
 * runs a JavaScript COMMENT STRIPPER over every inline executable script before serving it. It
 * deleted `/* ... *\/` CSS comments inside template strings (harmless) and, having lost track of
 * string state once, deleted `//staged.sasha-slides.invalid/image";...` up to the next newline:
 * 9,803 bytes of code, served as "Uncaught SyntaxError: Invalid or unexpected token". That is the
 * "corruption" the size ceiling below was written against -- it depends on what the bundle
 * contains, not on how big it is, which is why it hit a 453 KB page under the budget.
 *
 * So the bundle travels in a `type="text/plain"` container, which the HTML parser keeps as raw
 * text and nothing treats as JavaScript, and a loader with no comments and no `/` copies it into a
 * real <script> element. Injecting a script element is not eval, so the sandbox's CSP (no
 * `unsafe-eval`) allows it -- the converter's extractor already relies on that path. The loader
 * runs where the inline script used to, at the end of <body>, so the bundle still sees a parsed
 * document.
 */
function surfaceHtml({ from, script }: { from: string; script: string }): string {
  if (/<\/script/i.test(script)) {
    throw new Error(`${from}: the bundle contains "</script", which would end its container early`);
  }
  return `<!DOCTYPE html>
<!-- GENERATED FILE - do not edit. Emitted by ${GENERATED_BY} from ${from}.
     Change the TypeScript source and rebuild; this file is overwritten wholesale. -->
<html>
<head>
<base target="_top">
<meta charset="utf-8">
</head>
<body>
<script type="text/plain" id="${BUNDLE_ELEMENT_ID}">
${script}
</script>
<script>
(function () { window.sashaBuild = "${buildStampOf(script)}"; var bundle = document.getElementById("${BUNDLE_ELEMENT_ID}"); var run = document.createElement("script"); run.text = bundle.textContent; bundle.remove(); document.body.appendChild(run); })();
</script>
</body>
</html>
`;
}

/**
 * A short hash of one bundle, published by the loader as `window.sashaBuild`. The converter is
 * compiled INTO the bundle, so dialog.tsx keys its localStorage conversion cache by this: a new
 * deploy misses rather than serving what an older converter produced. Hex, so the loader stays
 * free of `/` (see surfaceHtml).
 */
function buildStampOf(script: string): string {
  return createHash("sha256").update(script).digest("hex").slice(0, 16);
}

/** The id of the inert container each page's bundle travels in. See surfaceHtml. */
const BUNDLE_ELEMENT_ID = "sasha-bundle";

/**
 * The callable names SERVER_FUNCTION_NAMES promises that the emitted Code.gs does not define.
 *
 * The list and the generated string are edited in different places, and nothing else compares
 * them: TypeScript cannot see inside a template literal, so a name added to one and not the other
 * builds, deploys, and fails only when a user presses the button. This is that comparison.
 */
function serverFunctionsMissingFrom(code: string): readonly string[] {
  return SERVER_FUNCTION_NAMES.filter((name) => !new RegExp(`^function ${name}\\(`, "m").test(code));
}

function kb(text: string): string {
  return (text.length / 1024).toFixed(0);
}

/** The repo root's binary, or the add-on's own if someone ran npm install here. */
main().catch((cause: unknown) => {
  process.stderr.write(`build-addon failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
