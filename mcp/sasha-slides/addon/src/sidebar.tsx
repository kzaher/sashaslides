// ASK SASHA'S COMPOSITION ROOT, and the one surface the Slides menu opens.
//
// WHAT IT IS NOW. The connection with the assistant and the assets it staged -- nothing else. The
// conversation itself happens in the deck's own Google Slides comments, which the comment bot
// answers, so the comment panel, the activity log, the composer and the defect-report entry are
// gone, and with them every call this panel made only for them: the deck's comment pane
// (`sashaReadFeedback`, every 20 s), the candidates' comments (`sashaCandidateComments`, every
// 30 s), posting a message (`sashaSendFeedback`), replying and resolving (`sashaReplyComment`,
// `sashaResolveComment`), and the report window (`sashaReportWindowUrl` on every open,
// `sashaOpenDefectReport`). Each was ~0.7 s of `google.script.run` overhead in the one queue the
// slides window shares.
//
// THIS FILE ONLY WIRES THE REAL PORTS: `google.script.run`, the document's visibility, the seed
// element `showSidebar` appended (sidebar-seed.ts), and React. Every loop and every decision about
// what to read lives in sidebar-controller.ts, where a test can drive it with a fake server.

import { createElement } from "react";
import { appsScriptCall } from "./bridge-client.ts";
import { ConversationPanel } from "./Conversation.tsx";
import { storedSetupChoiceStore, type SetupEnvironment } from "./setup-guide.tsx";
import { startSidebar, type SidebarView } from "./sidebar-controller.ts";
import { SIDEBAR_SEED_ELEMENT_ID } from "./sidebar-seed.ts";
import { seedText, surfaceRenderer } from "./surface-host.ts";

/**
 * WHAT THE NOTHING-LISTENING PANEL NEEDS TO SAY HOW TO CONNECT: two constants build-addon.ts bakes
 * in, and this viewer's remembered tab. `window.localStorage` is read lazily inside the store's
 * try, because the HtmlService sandbox may throw on the mere read.
 */
const SETUP: SetupEnvironment = {
  repoRoot: __SASHA_REPO_ROOT__,
  connectorUrl: __SASHA_CONNECTOR_URL__,
  store: storedSetupChoiceStore(() => window.localStorage),
};

const renderSurface = surfaceRenderer();

function render({ conversation, previews, commentAccess, actions }: SidebarView): void {
  renderSurface(createElement(ConversationPanel, { conversation, previews, commentAccess, setup: SETUP, actions }));
}

/**
 * THE SEED IS PARSED AFTER THE BUNDLE: `showSidebar` appends it to the page, behind the loader
 * that runs this script, so `seedText` waits for the document to finish parsing -- the same wait
 * the slides window makes for its own seed.
 */
async function boot(): Promise<void> {
  const seed = await seedText(SIDEBAR_SEED_ELEMENT_ID);
  startSidebar({
    call: appsScriptCall({ run: google.script.run }),
    render,
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => document.addEventListener("visibilitychange", listener),
    onWindowFocus: (listener) => window.addEventListener("focus", listener),
    seedText: seed,
  });
}

/**
 * THE ENTRY POINT, and it is LAST on purpose: everything a module-level initialiser needs is
 * declared above it, so the first render cannot see an undefined `SETUP`.
 */
void boot();
