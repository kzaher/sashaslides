// THE EDITOR PAGE'S FILES, shared by build-demo.ts and the end-to-end harness so both serve the same
// page: one stylesheet (the shared Tidepool rules, then the view's own) and the page markup that
// loads it and the bundle. The markup carries the demo's configuration as an inert JSON block, read
// and validated by the entry point, never executed.

import { TIDEPOOL_TOKENS } from "../../theme/tidepool-theme.ts";
import { tidepoolStylesheet } from "../../theme/tidepool-stylesheet.ts";
import { viewStylesheet } from "../view-stylesheet.ts";

export const PAGE_ROOT_ID = "sasha-root";
export const PAGE_CONFIGURATION_ID = "sasha-configuration";

/** The whole editor stylesheet: tokens for both schemes, the shared rules, the view's rules. */
export function editorStylesheet(): string {
  return `${tidepoolStylesheet(TIDEPOOL_TOKENS)}\n${viewStylesheet()}`;
}

/** The page: stylesheet, a root element, the configuration block and the module bundle. */
export function editorPageMarkup(options: Readonly<{ title: string; stylesheetPath: string; scriptPath: string; configuration: Readonly<Record<string, string>> }>): string {
  const configuration = JSON.stringify(options.configuration).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(options.title)}</title>
<link rel="stylesheet" href="${escapeText(options.stylesheetPath)}">
</head>
<body>
<div id="${PAGE_ROOT_ID}"></div>
<script type="application/json" id="${PAGE_CONFIGURATION_ID}">${configuration}</script>
<script type="module" src="${escapeText(options.scriptPath)}"></script>
</body>
</html>
`;
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
