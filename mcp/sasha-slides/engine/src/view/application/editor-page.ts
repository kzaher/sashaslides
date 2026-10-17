// THE EDITOR PAGE'S FILES, shared by build-demo.ts and the end-to-end harness so both serve the same
// page: one stylesheet (the shared Tidepool rules, then the view's own) and the page markup that
// loads it and the bundle. The markup carries the page's configuration as an inert JSON block, read
// and validated by the entry point, never executed. The web module's two pages (web/web-page.ts) are
// built by the same `editorPageMarkup` and read their block with the same `parsePageConfiguration`.

import { TIDEPOOL_TOKENS } from "../../theme/tidepool-theme.ts";
import { tidepoolStylesheet } from "../../theme/tidepool-stylesheet.ts";
import { viewStylesheet } from "../view-stylesheet.ts";
// The reader module has no imports of its own, so this is not a dependency on the web module's code.
import { parseOrNull, parseStructuredText, recordOf, stringAt } from "../../shared/untrusted-values.ts";

export const PAGE_ROOT_ID = "sasha-root";
export const PAGE_CONFIGURATION_ID = "sasha-configuration";

/** What a page needs to know that it cannot derive from its own address. */
export type PageConfiguration = Readonly<{
  /** The scripted-transition runner page (presenter `buildPresenterAssets`). */
  runnerAddress: string;
}>;

/** The whole editor stylesheet: tokens for both schemes, the shared rules, the view's rules. */
export function editorStylesheet(): string {
  return `${tidepoolStylesheet(TIDEPOOL_TOKENS)}\n${viewStylesheet()}`;
}

/** The page: stylesheet, a root element, the configuration block and the module bundle. `favicon` adds the icon link. */
export function editorPageMarkup(
  options: Readonly<{ title: string; stylesheetPath: string; scriptPath: string; configuration: Readonly<Record<string, string>>; favicon?: string }>,
): string {
  const configuration = JSON.stringify(options.configuration).replace(/</g, "\\u003c");
  const favicon = options.favicon === undefined ? "" : `<link rel="icon" href="${escapeText(options.favicon)}" sizes="any">\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(options.title)}</title>
${favicon}<link rel="stylesheet" href="${escapeText(options.stylesheetPath)}">
</head>
<body>
<div id="${PAGE_ROOT_ID}"></div>
<script type="application/json" id="${PAGE_CONFIGURATION_ID}">${configuration}</script>
<script type="module" src="${escapeText(options.scriptPath)}"></script>
</body>
</html>
`;
}

/** The page's configuration block, parsed at the boundary; null when it is missing or malformed. */
export function parsePageConfiguration(text: string | null): PageConfiguration | null {
  if (text === null) return null;
  return parseOrNull(() => {
    const record = recordOf(parseStructuredText(text), "configuration");
    return { runnerAddress: stringAt(record, "runnerAddress") };
  });
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
