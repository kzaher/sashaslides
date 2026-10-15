// THE TWO PAGE SHELLS (/decks and /deck/<id>) as build-web.ts writes them: one stylesheet, a root
// element, an inert configuration block, and the page's module bundle -- every file an absolute
// address under /deck-app/, because the same shell answers /deck/<any id>.
//
// Key decisions:
//
//  * NO INLINE SCRIPT AND NO INLINE STYLE ELEMENT: the pages' content security policy allows
//    scripts and stylesheets from 'self' only (SPEC.md 21.8). The configuration is a
//    `type="application/json"` block, which the browser never executes, read and parsed by the
//    entry point at its boundary.
//  * THE STYLESHEET IS THE WHOLE LOOK: the shared Tidepool rules, the view's rules (the editor),
//    the presenter's rules, then the web module's own (web-stylesheet.ts). The presenter also
//    renders its rules in a `<style>` element, which the policy refuses on these pages; carrying
//    them in the stylesheet is what keeps the slideshow styled here.

import { DECK_APPLICATION_ASSETS_PREFIX } from "../contracts/deck-api.ts";
import { TIDEPOOL_TOKENS } from "../theme/tidepool-theme.ts";
import { tidepoolStylesheet } from "../theme/tidepool-stylesheet.ts";
import { viewStylesheet } from "../view/view-stylesheet.ts";
import { PRESENTER_RULES } from "../presenter/view/presenter-stylesheet.ts";
import { parseOrNull, parseStructuredText, recordOf, stringAt } from "./parsing/untrusted-values.ts";
import { webStylesheet } from "./web-stylesheet.ts";

export const WEB_ROOT_ID = "sasha-root";
export const WEB_CONFIGURATION_ID = "sasha-configuration";

/** What the deck page needs to know that it cannot derive from its own address. */
export type WebPageConfiguration = Readonly<{
  /** The scripted-transition runner page (presenter `buildPresenterAssets`, served under /deck-app/runner/). */
  runnerAddress: string;
}>;

/** The shared stylesheet of both pages (see the header). */
export function deckApplicationStylesheet(): string {
  return `${tidepoolStylesheet(TIDEPOOL_TOKENS)}\n${viewStylesheet()}\n${PRESENTER_RULES}\n${webStylesheet()}`;
}

/** The page shell: the stylesheet, a root element, the configuration block and the bundle. */
export function webPageMarkup(options: Readonly<{ title: string; stylesheetFile: string; scriptFile: string; configuration: WebPageConfiguration }>): string {
  const configuration = JSON.stringify(options.configuration).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(options.title)}</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="stylesheet" href="${escapeText(`${DECK_APPLICATION_ASSETS_PREFIX}${options.stylesheetFile}`)}">
</head>
<body>
<div id="${WEB_ROOT_ID}"></div>
<script type="application/json" id="${WEB_CONFIGURATION_ID}">${configuration}</script>
<script type="module" src="${escapeText(`${DECK_APPLICATION_ASSETS_PREFIX}${options.scriptFile}`)}"></script>
</body>
</html>
`;
}

/** The page's configuration block, parsed at the boundary; null when it is missing or malformed. */
export function parseWebPageConfiguration(text: string | null): WebPageConfiguration | null {
  if (text === null) return null;
  return parseOrNull(() => {
    const record = recordOf(parseStructuredText(text), "configuration");
    return { runnerAddress: stringAt(record, "runnerAddress") };
  });
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
