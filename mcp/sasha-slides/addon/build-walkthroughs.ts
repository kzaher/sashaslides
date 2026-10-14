#!/usr/bin/env npx tsx
/**
 * build-walkthroughs.ts — emits the website's two setup walkthrough pages:
 *
 *   src/walkthrough-page.tsx  ->  renderer/html2slides/addon-server/public/walkthroughs/claude-ai.html
 *                             ->  renderer/html2slides/addon-server/public/walkthroughs/chatgpt.html
 *
 * The same animated player the add-on's Setup tab shows (src/walkthrough-player.tsx), bundled with
 * React into ONE self-contained page per flow: inline script and styles, no images, no requests. The
 * website serves anything in public/ at its own path, so these are /walkthroughs/<flow>.html.
 *
 * Typechecked first, like build-addon.ts: esbuild strips types without checking them.
 */

import { build, transformSync, type Plugin } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_CONNECTOR_URL } from "./src/connector-url.ts";
import { WALKTHROUGH_ROOT_ID } from "./src/walkthrough-page.tsx";
import { assistantNameOf, WALKTHROUGH_FLOWS, type WalkthroughFlow } from "./src/walkthrough-scripts.ts";
import { WALKTHROUGH_CSS } from "./src/walkthrough-styles.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const OUT = join(REPO_ROOT, "renderer/html2slides/addon-server/public/walkthroughs");

async function main(): Promise<void> {
  const tsc = findBinary("tsc");
  process.stdout.write("typecheck  tsconfig.json\n");
  execFileSync(tsc, ["--noEmit", "-p", join(HERE, "tsconfig.json")], { stdio: "inherit" });

  const bundled = await build({
    entryPoints: [join(HERE, "src", "walkthrough-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [MINIFIED_WALKTHROUGH_STYLESHEET],
  });
  const script = bundled.outputFiles?.[0]?.text;
  if (script === undefined) throw new Error("esbuild produced no output for walkthrough-page.tsx");
  if (/<\/script/i.test(script)) throw new Error('the bundle contains "</script", which would end its element early');

  mkdirSync(OUT, { recursive: true });
  for (const flow of WALKTHROUGH_FLOWS) {
    const html = pageHtml({ flow, script });
    writeFileSync(join(OUT, `${flow}.html`), html);
    process.stdout.write(`wrote      ${join(OUT, `${flow}.html`)} (${(html.length / 1024).toFixed(0)} KB)\n`);
  }
}

/** The walkthrough's stylesheet, minified at bundle time as build-addon.ts does; the source stays readable. */
const MINIFIED_WALKTHROUGH_STYLESHEET: Plugin = {
  name: "sasha-minified-walkthrough-stylesheet",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]walkthrough-styles\.ts$/ }, () => ({
      contents: `export const WALKTHROUGH_CSS = ${JSON.stringify(transformSync(WALKTHROUGH_CSS, { loader: "css", minify: true }).code)};`,
      loader: "ts",
    }));
  },
};

/** Connect <assistant> to Sasha Slides, as a page. */
function pageTitleOf(flow: WalkthroughFlow): string {
  return `Connect ${assistantNameOf(flow)} to Sasha Slides`;
}

function pageHtml({ flow, script }: Readonly<{ flow: WalkthroughFlow; script: string }>): string {
  return `<!DOCTYPE html>
<!-- GENERATED FILE - do not edit. Emitted by mcp/sasha-slides/addon/build-walkthroughs.ts from src/walkthrough-page.tsx. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitleOf(flow)}</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/static/sasha-slides-icon.svg" type="image/svg+xml">
</head>
<body>
<div id="${WALKTHROUGH_ROOT_ID}" data-flow="${flow}" data-connector="${PRODUCTION_CONNECTOR_URL}"></div>
<script>
${script}
</script>
</body>
</html>
`;
}

function findBinary(name: string): string {
  for (const base of [join(HERE, "node_modules", ".bin"), join(REPO_ROOT, "node_modules", ".bin")]) {
    const candidate = join(base, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`build-walkthroughs.ts: no ${name} -- run 'npm install' at the repo root`);
}

main().catch((cause: unknown) => {
  process.stderr.write(`build-walkthroughs failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
