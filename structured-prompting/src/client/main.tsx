/**
 * Browser entry point. esbuild bundles this file (server.ts's
 * bundleClientScript points at it) into a single classic IIFE that the
 * monitor HTML response embeds inline.
 *
 * All actual UI logic lives in sibling files:
 *
 *   App.tsx                  — root component, polling loop, layout
 *   Tree.tsx                 — recursive TreeNode (left pane)
 *   Detail.tsx               — selected-node detail (right pane)
 *   AskPanel.tsx             — POSTs /api/ask, ancestry-walks for resume anchor
 *   RetryPanel.tsx           — POSTs /api/retry
 *   ComposedPromptReveal.tsx — collapsible "entire prompt" block on sends
 *   JsonView.tsx             — pretty-printed JSON + per-string expand
 *   helpers.ts               — fmtDur, METRICS, nodeValue, computeRollup
 *
 * Wire types come from `src/api/wire.ts` — the only cross-half import.
 */
import { render } from "preact";
import { App } from "./App.js";

// Visible fallback so a JS failure doesn't just leave the page blank.
try {
  render(<App />, document.getElementById("root")!);
} catch (e) {
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML =
      '<pre style="padding:16px;color:#f85149;white-space:pre-wrap">monitor crashed: ' +
      (e && (e as Error).stack ? (e as Error).stack : String(e)) +
      "</pre>";
  }
  console.error("[sp monitor]", e);
  throw e;
}
