// THE WEBSITE'S WALKTHROUGH PAGES: the same player the add-on's Setup tab shows, full width on its
// own page (public/walkthroughs/<flow>.html on sashaslides.com, emitted by build-walkthroughs.ts).
//
// One bundle serves both pages; the page says which flow it is and which connector address to type
// through data attributes on its root element, parsed here at that boundary. The page also exposes
// `window.walkthroughSeek(ms)`, which pauses the player on an exact moment, for screenshot checks.

import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { WalkthroughPlayer, type WalkthroughControls } from "./walkthrough-player.tsx";
import { assistantNameOf, WALKTHROUGH_FLOWS, type WalkthroughFlow } from "./walkthrough-scripts.ts";

/** The id of the element the page mounts into; build-walkthroughs.ts writes it. */
export const WALKTHROUGH_ROOT_ID = "walkthrough-root";

export function WalkthroughPage({ flow, connectorUrl }: Readonly<{ flow: WalkthroughFlow; connectorUrl: string }>): JSX.Element {
  return (
    <main className="sasha-wt-page">
      <style>{PAGE_CSS}</style>
      <h1>Connect {assistantNameOf(flow)} to Sasha Slides</h1>
      <p className="sasha-wt-page-lead">
        Every click, start to finish. The connector address is <code>{connectorUrl}</code>.
      </p>
      <WalkthroughPlayer flow={flow} connectorUrl={connectorUrl} onControls={exposeControls} />
    </main>
  );
}

/** The flow a page names, or null for anything unrecognised. */
export function parseWalkthroughFlow(raw: string | undefined): WalkthroughFlow | null {
  return WALKTHROUGH_FLOWS.find((flow) => flow === raw) ?? null;
}

const PAGE_CSS = [
  "html, body { margin: 0; background: #fff; }",
  ".sasha-wt-page { max-width: 960px; margin: 0 auto; padding: 24px 16px 40px; font-family: Roboto, Arial, sans-serif; font-size: 16px; color: #202124; }",
  ".sasha-wt-page h1 { font-size: 26px; margin: 0 0 6px; }",
  ".sasha-wt-page-lead { margin: 0 0 16px; color: #5f6368; overflow-wrap: anywhere; }",
  ".sasha-wt-page-lead code { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; }",
  ".sasha-wt-page .sasha-wt-control { width: 32px; height: 32px; font-size: 15px; }",
  ".sasha-wt-page .sasha-wt-time { font-size: 13px; }",
].join("\n");

/** Stable (module-level), so the player's effect hands the controls over once. */
function exposeControls(controls: WalkthroughControls): void {
  Reflect.set(window, "walkthroughSeek", (timeMs: number) => {
    controls.pause();
    controls.seek(timeMs);
  });
}

mount();

function mount(): void {
  if (typeof document === "undefined") return;
  const root = document.getElementById(WALKTHROUGH_ROOT_ID);
  if (root === null) return;
  const flow = parseWalkthroughFlow(root.dataset["flow"]);
  const connectorUrl = root.dataset["connector"];
  if (flow === null || connectorUrl === undefined || connectorUrl === "") {
    root.textContent = "This walkthrough page is missing its flow or connector address.";
    return;
  }
  createRoot(root).render(<WalkthroughPage flow={flow} connectorUrl={connectorUrl} />);
}
