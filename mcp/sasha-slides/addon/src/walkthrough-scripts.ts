// THE TWO SETUP WALKTHROUGHS, step by step: connecting Sasha Slides to claude.ai and to ChatGPT.
//
// Each caption is the matching line of docs/connect/recording/<flow>.steps.txt, the step texts that
// were checked click by click against the real sites when the videos were recorded; a test compares
// them, so the animation cannot drift from what was verified. `{URL}` there is the connector address,
// which here is the real one the caller passes.
//
// Both flows go through the same Google sign-in (choose an account, the unverified-app warning, the
// sign-in to sashaslides.com, the additional-access page), so those five steps come from one helper.

import { SCROLL_REGIONS } from "./walkthrough-layout.ts";
import type { WalkthroughScript, WalkthroughStep } from "./walkthrough-timeline.ts";
import { assertNever } from "./protocol.ts";

export type WalkthroughFlow = "claude-ai" | "chatgpt";

export const WALKTHROUGH_FLOWS: readonly WalkthroughFlow[] = ["claude-ai", "chatgpt"];

/** How long each screen recording ran. The walkthrough has to be at least 30% shorter. */
export const RECORDING_LENGTH_MS: Readonly<Record<WalkthroughFlow, number>> = {
  "claude-ai": 284_000,
  chatgpt: 234_000,
};

/** What the user types into Claude's message box. */
export const CLAUDE_PROMPT = "Use the sasha-slides connector: call open_work and tell me what is waiting for me.";
/** What the user types into ChatGPT after picking Sasha Slides with @. */
export const CHATGPT_MENTION = "@Sasha";
export const CHATGPT_PROMPT = "call open_work and tell me what is waiting for me.";

export function scriptOf({ flow, connectorUrl }: Readonly<{ flow: WalkthroughFlow; connectorUrl: string }>): WalkthroughScript {
  switch (flow) {
    case "claude-ai":
      return claudeScript(connectorUrl);
    case "chatgpt":
      return chatgptScript(connectorUrl);
    default:
      return assertNever(flow);
  }
}

/** The name each flow's assistant goes by in captions and page titles. */
export function assistantNameOf(flow: WalkthroughFlow): string {
  switch (flow) {
    case "claude-ai":
      return "Claude";
    case "chatgpt":
      return "ChatGPT";
    default:
      return assertNever(flow);
  }
}

function claudeScript(connectorUrl: string): WalkthroughScript {
  return [
    { label: "Start", caption: "claude.ai home page (claude.ai/new), already signed in", screen: "claude-home", actions: [] },
    {
      label: "1",
      caption: "In the left sidebar, click Customize.",
      screen: "claude-home",
      actions: [{ kind: "click", target: "customize" }],
    },
    {
      label: "2",
      caption: "At the top of Customize, click the Connectors tab.",
      screen: "claude-customize",
      actions: [{ kind: "click", target: "connectors-tab" }],
    },
    {
      label: "3",
      caption: "Top right, click the black + Add button.",
      screen: "claude-connectors",
      actions: [{ kind: "click", target: "add" }],
    },
    {
      label: "4",
      caption: "In the menu, click Add custom connector.",
      screen: "claude-connectors-menu",
      actions: [{ kind: "click", target: "add-custom" }],
    },
    {
      label: "5",
      caption: "Click the Name field and type: Sasha Slides",
      screen: "claude-add-dialog",
      actions: [
        { kind: "click", target: "name-field" },
        { kind: "type", target: "name-field", text: "Sasha Slides" },
      ],
    },
    {
      label: "6",
      caption: `Click the MCP server URL field and type the connector address: ${connectorUrl}`,
      screen: "claude-add-dialog",
      actions: [
        { kind: "click", target: "url-field" },
        { kind: "type", target: "url-field", text: connectorUrl },
      ],
    },
    {
      label: "7",
      caption: "Click Continue.",
      screen: "claude-add-dialog",
      actions: [{ kind: "click", target: "continue" }],
    },
    {
      label: "8",
      caption:
        "Leave the detected defaults: Authentication = Sign in now, OAuth client = Register automatically. Scroll to the bottom of the dialog.",
      screen: "claude-dialog-options",
      actions: [
        { kind: "wait", durationMs: 1400 },
        { kind: "scroll", region: "claude-options", to: SCROLL_REGIONS["claude-options"].maximumOffset },
      ],
    },
    {
      label: "9",
      caption: "Click Add.",
      screen: "claude-dialog-options",
      actions: [{ kind: "click", target: "add" }],
    },
    {
      label: "10",
      caption: "Click Connect. The same tab goes to the Sasha Slides sign-in, which hands you to Google.",
      screen: "claude-connector-detail",
      actions: [{ kind: "click", target: "connect" }],
    },
    ...googleSignInSteps({ number: "10", assistant: "Claude" }),
    {
      label: "11",
      caption: "Connected: the page now shows Disconnect and the 12 Sasha Slides tools (each 'Needs approval' by default).",
      screen: "claude-connected",
      actions: [],
    },
    {
      label: "12",
      caption: "In the left sidebar click New to start a chat.",
      screen: "claude-connected",
      actions: [{ kind: "click", target: "new-chat" }],
    },
    {
      label: "13",
      caption: `Click the message box, type: ${CLAUDE_PROMPT}  — then press Enter.`,
      screen: "claude-home",
      actions: [
        { kind: "click", target: "composer" },
        { kind: "type", target: "composer", text: CLAUDE_PROMPT },
      ],
    },
    {
      label: "14",
      caption: "Claude asks to use 'What is waiting for me' from Sasha Slides: click Allow once (or Always allow).",
      screen: "claude-permission",
      actions: [{ kind: "click", target: "allow-once" }],
    },
    {
      label: "15",
      caption:
        "Claude calls the tool and answers from your own Drive: the proposals waiting for you, or that there are none yet.",
      screen: "claude-answer",
      actions: [],
    },
  ];
}

function chatgptScript(connectorUrl: string): WalkthroughScript {
  return [
    { label: "Start", caption: "chatgpt.com home page, signed in (ChatGPT Plus)", screen: "chatgpt-home", actions: [] },
    {
      label: "1",
      caption: "In the left sidebar, click Plugins.",
      screen: "chatgpt-home",
      actions: [{ kind: "click", target: "plugins" }],
    },
    {
      label: "2",
      caption: "Top right, click Add.",
      screen: "chatgpt-plugins",
      actions: [{ kind: "click", target: "add" }],
    },
    {
      label: "3",
      caption: "In the menu, click Add custom MCP server.",
      screen: "chatgpt-plugins-menu",
      actions: [{ kind: "click", target: "add-custom" }],
    },
    {
      label: "4",
      caption: "Name: type Sasha Slides",
      screen: "chatgpt-mcp-form",
      actions: [
        { kind: "click", target: "name-field" },
        { kind: "type", target: "name-field", text: "Sasha Slides" },
      ],
    },
    {
      label: "5",
      caption: "Description (optional): type Candidate slides for Google Slides",
      screen: "chatgpt-mcp-form",
      actions: [
        { kind: "click", target: "description-field" },
        { kind: "type", target: "description-field", text: "Candidate slides for Google Slides" },
      ],
    },
    {
      label: "6",
      caption: `Connection: keep Server URL selected and type the connector address: ${connectorUrl}`,
      screen: "chatgpt-mcp-form",
      actions: [
        { kind: "click", target: "url-field" },
        { kind: "type", target: "url-field", text: connectorUrl },
      ],
    },
    {
      label: "7",
      caption:
        "Leave Authentication on OAuth (ChatGPT registers itself; no client ID or secret needed). Tick 'I understand and want to continue'.",
      screen: "chatgpt-mcp-form",
      actions: [
        { kind: "wait", durationMs: 1200 },
        { kind: "click", target: "understand" },
      ],
    },
    {
      label: "8",
      caption: "Click Create as a plugin.",
      screen: "chatgpt-mcp-form",
      actions: [{ kind: "click", target: "create" }],
    },
    {
      label: "9",
      caption:
        "ChatGPT shows 'Connect Sasha Slides': click Continue to Sasha Slides. The same tab goes to the Sasha Slides sign-in, which hands you to Google.",
      screen: "chatgpt-connect",
      actions: [{ kind: "click", target: "continue" }],
    },
    ...googleSignInSteps({ number: "9", assistant: "ChatGPT" }),
    {
      label: "10",
      caption: "Signed in: Sasha Slides now appears under Installed on the Plugins page.",
      screen: "chatgpt-installed",
      actions: [],
    },
    {
      label: "11",
      caption: "In the left sidebar click New chat.",
      screen: "chatgpt-installed",
      actions: [{ kind: "click", target: "new-chat" }],
    },
    {
      label: "12",
      caption: "Click the message box and type @Sasha; pick Sasha Slides from the list that appears.",
      screen: "chatgpt-home",
      actions: [
        { kind: "click", target: "composer" },
        { kind: "type", target: "composer", text: CHATGPT_MENTION },
        { kind: "click", target: "mention-sasha" },
      ],
    },
    {
      label: "13",
      caption: `After the Sasha Slides chip, type: ${CHATGPT_PROMPT} — then press Enter.`,
      screen: "chatgpt-mention",
      actions: [{ kind: "type", target: "composer-text", text: CHATGPT_PROMPT }],
    },
    {
      label: "14",
      caption:
        "ChatGPT calls Sasha Slides open_work and answers from your own Drive: the proposals waiting for you, or that there are none yet.",
      screen: "chatgpt-answer",
      actions: [],
    },
  ];
}

/** Google's sign-in, the same five pages in both flows; only the step number and who it returns to differ. */
function googleSignInSteps({ number, assistant }: Readonly<{ number: string; assistant: string }>): readonly WalkthroughStep[] {
  return [
    {
      label: `${number}a`,
      caption: "Google asks you to choose an account: click your account.",
      screen: "google-choose-account",
      actions: [{ kind: "click", target: "account" }],
    },
    {
      label: `${number}b`,
      caption: "Google warns 'Google hasn't verified this app' (the Sasha Slides app is in testing): click Continue.",
      screen: "google-unverified",
      actions: [{ kind: "click", target: "continue" }],
    },
    {
      label: `${number}c`,
      caption: "Google shows the sign-in to sashaslides.com with your account: click Continue.",
      screen: "google-sign-in",
      actions: [{ kind: "click", target: "continue" }],
    },
    {
      label: `${number}d`,
      caption:
        "On 'sashaslides.com wants additional access to your Google Account' (Google Slides access), click the round down-arrow button to scroll to the end; Continue becomes active.",
      screen: "google-additional-access",
      actions: [
        { kind: "click", target: "scroll-down" },
        { kind: "scroll", region: "google-access", to: SCROLL_REGIONS["google-access"].maximumOffset },
      ],
    },
    {
      label: `${number}e`,
      caption: `Click Continue. Google returns you to Sasha Slides, which returns you to ${assistant}.`,
      screen: "google-additional-access",
      actions: [{ kind: "click", target: "continue" }],
    },
  ];
}
