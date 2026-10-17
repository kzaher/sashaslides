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
import { editorPageMarkup, type PageConfiguration } from "../view/application/editor-page.ts";
import { TIDEPOOL_TOKENS } from "../theme/tidepool-theme.ts";
import { tidepoolStylesheet } from "../theme/tidepool-stylesheet.ts";
import { viewStylesheet } from "../view/view-stylesheet.ts";
import { PRESENTER_RULES } from "../presenter/view/presenter-stylesheet.ts";
import { webStylesheet } from "./web-stylesheet.ts";

/** The shared stylesheet of both pages (see the header). */
export function deckApplicationStylesheet(): string {
  return `${tidepoolStylesheet(TIDEPOOL_TOKENS)}\n${viewStylesheet()}\n${PRESENTER_RULES}\n${webStylesheet()}`;
}

/** The page shell: `editorPageMarkup` with the icon and every file under /deck-app/. */
export function webPageMarkup(options: Readonly<{ title: string; stylesheetFile: string; scriptFile: string; configuration: PageConfiguration }>): string {
  return editorPageMarkup({
    title: options.title,
    stylesheetPath: `${DECK_APPLICATION_ASSETS_PREFIX}${options.stylesheetFile}`,
    scriptPath: `${DECK_APPLICATION_ASSETS_PREFIX}${options.scriptFile}`,
    configuration: options.configuration,
    favicon: "/favicon.ico",
  });
}
