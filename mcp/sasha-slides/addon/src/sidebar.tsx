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

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { appsScriptCall } from "./bridge-client.ts";
import { ConversationPanel } from "./Conversation.tsx";
import { storedSetupChoiceStore, type SetupEnvironment } from "./setup-guide.tsx";
import { startSidebar, type SidebarView } from "./sidebar-controller.ts";
import { SIDEBAR_SEED_ELEMENT_ID } from "./sidebar-seed.ts";

const ROOT_ELEMENT_ID = "sasha-slides-root";

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

let root: Root | null = null;

function render({ conversation, previews, commentAccess, actions }: SidebarView): void {
  if (root === null) {
    const existing = document.getElementById(ROOT_ELEMENT_ID);
    const host = existing ?? document.createElement("div");
    host.id = ROOT_ELEMENT_ID;
    if (existing === null) document.body.append(host);
    root = createRoot(host);
  }
  root.render(createElement(ConversationPanel, { conversation, previews, commentAccess, setup: SETUP, actions }));
}

/**
 * THE SEED IS PARSED AFTER THE BUNDLE: `showSidebar` appends it to the page, behind the loader
 * that runs this script, so it is only in the document once parsing is done -- the same wait the
 * slides window makes for its own seed (dialog.tsx).
 */
function boot(): void {
  startSidebar({
    call: appsScriptCall({ run: google.script.run }),
    render,
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => document.addEventListener("visibilitychange", listener),
    onWindowFocus: (listener) => window.addEventListener("focus", listener),
    seedText: document.getElementById(SIDEBAR_SEED_ELEMENT_ID)?.textContent ?? null,
  });
}

/**
 * THE ENTRY POINT, and it is LAST on purpose: everything a module-level initialiser needs is
 * declared above it, so the first render cannot see an undefined `SETUP`.
 */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
