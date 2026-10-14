// THE "NOTHING IS LISTENING" SETUP PANEL: a Setup tab for people who use a hosted connector, and a
// Dev tab with the exact local command. Rendered with renderToStaticMarkup, like the other panels.

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nothingListeningNotice } from "../../feedback-delivery.ts";
import {
  DEFAULT_SETUP_CHOICE,
  SetupGuide,
  devCommandOf,
  parseSetupChoice,
  storedSetupChoiceStore,
  type SetupChoice,
  type SetupChoiceStore,
  type SetupEnvironment,
} from "./setup-guide.tsx";

const REPO = "/workspaces/sashaslides";
const HOSTED = "https://sasha.example.com/mcp";

function remembering(choice: SetupChoice | null): SetupChoiceStore {
  return { load: () => choice, save() {} };
}

function markupOf({
  connectorUrl,
  choice,
}: Readonly<{ connectorUrl: string | null; choice: SetupChoice | null }>): string {
  const environment: SetupEnvironment = { repoRoot: REPO, connectorUrl, store: remembering(choice) };
  return renderToStaticMarkup(createElement(SetupGuide, { notice: nothingListeningNotice(), environment }));
}

/** Markup with the HTML entities React writes decoded, so a command can be matched as typed. */
function textOf(markup: string): string {
  return markup.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
}

test("the Dev command is the exact command, with the real repository path and no placeholder", () => {
  assert.equal(
    devCommandOf(REPO),
    "claude mcp add sasha-slides -- npx tsx /workspaces/sashaslides/mcp/sasha-slides/server.ts --stdio",
  );
  const dev = textOf(markupOf({ connectorUrl: null, choice: { tab: "dev", bot: "claude-app" } }));
  assert.ok(dev.includes(devCommandOf(REPO)), "the Dev tab prints it");
  assert.doesNotMatch(dev, /&lt;repo&gt;|<repo>/);
  assert.match(dev, /call open_work, then answer my open comments/, "and the prompt to paste after it");
  assert.match(dev, />Copy</, "each block has a Copy button");
});

test("the heading stays, and the notice no longer carries a placeholder command", () => {
  const notice = nothingListeningNotice();
  assert.equal(notice.headline, "Nothing has picked this up in 5 minutes.");
  assert.doesNotMatch(JSON.stringify(notice), /<repo>/);
  assert.match(markupOf({ connectorUrl: null, choice: null }), /Nothing has picked this up in 5 minutes\./);
});

test("Setup is the default tab, and with no connector address it says so instead of inventing one", () => {
  assert.deepEqual(DEFAULT_SETUP_CHOICE, { tab: "setup", bot: "claude-app" });
  const rows: readonly { connectorUrl: string | null; notConfigured: boolean }[] = [
    { connectorUrl: null, notConfigured: true },
    { connectorUrl: HOSTED, notConfigured: false },
  ];
  for (const row of rows) {
    const markup = textOf(markupOf({ connectorUrl: row.connectorUrl, choice: null }));
    assert.match(markup, /aria-selected="true"[^>]*>Setup</, "Setup is the tab that is on");
    assert.equal(/not configured/.test(markup), row.notConfigured, `not-configured for ${String(row.connectorUrl)}`);
    assert.equal(markup.includes(HOSTED), !row.notConfigured, "the URL appears only when it exists");
    assert.doesNotMatch(markup, /<your-public-host>|&lt;your-public-host&gt;/);
  }
});

test("the bot picker switches the instructions", () => {
  const rows: readonly { bot: SetupChoice["bot"]; shows: RegExp; hides: RegExp }[] = [
    { bot: "claude-app", shows: /Add custom connector/, hides: /claude mcp add --transport http|Add custom MCP server/ },
    { bot: "claude-code", shows: /claude mcp add --transport http sasha-slides https:\/\/sasha\.example\.com\/mcp/, hides: /Add custom connector|Add custom MCP server/ },
    { bot: "chatgpt", shows: /Add custom MCP server/, hides: /Add custom connector|claude mcp add/ },
  ];
  for (const row of rows) {
    const markup = textOf(markupOf({ connectorUrl: HOSTED, choice: { tab: "setup", bot: row.bot } }));
    assert.match(markup, row.shows, row.bot);
    assert.doesNotMatch(markup, row.hides, row.bot);
    assert.match(markup, /call open_work, then answer my open comments/, "every bot ends with the prompt");
  }
});

test("ChatGPT's steps name every click in order, around the same connector address", () => {
  const markup = textOf(markupOf({ connectorUrl: HOSTED, choice: { tab: "setup", bot: "chatgpt" } }));
  assert.match(markup, />ChatGPT</, "the picker offers ChatGPT");
  // The order a user meets them in ChatGPT's own flow (developers.openai.com custom-mcp-server).
  const clicks = [
    "https://chatgpt.com/plugins",
    "Add custom MCP server",
    "Sasha Slides",
    HOSTED,
    "OAuth",
    "I understand and want to continue",
    "Create as a plugin",
    "https://chatgpt.com/plugins?view=personal",
    "@",
    "call open_work, then answer my open comments",
  ];
  let from = 0;
  for (const click of clicks) {
    const at = markup.indexOf(click, from);
    assert.ok(at >= 0, `"${click}" must appear after the previous step`);
    from = at + click.length;
  }
  assert.match(markup, /Business, Enterprise (and|or) Edu/, "the plans that allow write tools are named");
  assert.match(markup, /Pro/, "and the limit on Pro is said honestly");
  assert.match(markup, /Plus/, "and what was measured on Plus (2026-10-11) is said too");
});

test("with no connector address every bot says so, ChatGPT included", () => {
  for (const bot of ["claude-app", "claude-code", "chatgpt"] as const) {
    const markup = textOf(markupOf({ connectorUrl: null, choice: { tab: "setup", bot } }));
    assert.match(markup, /not configured/, bot);
    assert.doesNotMatch(markup, /Add custom MCP server|Add custom connector|claude mcp add --transport/, bot);
  }
});

test("a remembered choice is parsed at the boundary, and garbage falls back to nothing", () => {
  assert.deepEqual(parseSetupChoice('{"tab":"dev","bot":"claude-code"}'), { tab: "dev", bot: "claude-code" });
  assert.deepEqual(parseSetupChoice('{"tab":"setup","bot":"chatgpt"}'), { tab: "setup", bot: "chatgpt" });
  assert.equal(parseSetupChoice('{"tab":"elsewhere","bot":"claude-code"}'), null);
  assert.equal(parseSetupChoice("not json"), null);
  assert.equal(parseSetupChoice(null), null);
});

test("storage that throws is survived: nothing is remembered, nothing crashes", () => {
  const refusing = storedSetupChoiceStore(() => {
    throw new Error("SecurityError: storage is disabled");
  });
  assert.equal(refusing.load(), null);
  assert.doesNotThrow(() => refusing.save({ tab: "dev", bot: "claude-app" }));

  const saved = new Map<string, string>();
  const working = storedSetupChoiceStore(() => ({
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  }));
  working.save({ tab: "dev", bot: "claude-code" });
  assert.deepEqual(working.load(), { tab: "dev", bot: "claude-code" });
});

// Asked for 2026-10-14: the walkthrough plays in place, above the written steps, instead of a
// link out ("Prefer to watch? Every click, recorded") at the bottom of the list.
test("the Claude app and ChatGPT walkthroughs play inline, above the written steps, from the connector's host", () => {
  const rows: readonly { bot: SetupChoice["bot"]; video: string | null }[] = [
    { bot: "claude-app", video: "https://sasha.example.com/videos/claude-ai.mp4" },
    { bot: "chatgpt", video: "https://sasha.example.com/videos/chatgpt.mp4" },
    { bot: "claude-code", video: null },
  ];
  for (const row of rows) {
    const markup = textOf(markupOf({ connectorUrl: HOSTED, choice: { tab: "setup", bot: row.bot } }));
    if (row.video === null) {
      assert.doesNotMatch(markup, /\/videos\/|<video/, row.bot);
      continue;
    }
    const video = markup.indexOf("<video");
    assert.ok(video >= 0, `${row.bot} embeds a <video>`);
    assert.ok(markup.includes(`src="${row.video}"`), `${row.bot} plays ${row.video}`);
    assert.match(markup.slice(video, markup.indexOf(">", video)), /controls/, `${row.bot}'s video has a play button`);
    assert.ok(video < markup.indexOf('class="sasha-setup-steps"'), `${row.bot}'s video comes before the steps`);
    assert.doesNotMatch(markup, /Every click, recorded/, `${row.bot} no longer links out`);
  }
  for (const bot of ["claude-app", "chatgpt"] as const) {
    assert.doesNotMatch(textOf(markupOf({ connectorUrl: null, choice: { tab: "setup", bot } })), /\/videos\/|<video/, "no video without a host");
  }
});

test("the Claude app steps follow claude.ai's current menus, and ChatGPT's note reports what Plus did", () => {
  const claude = textOf(markupOf({ connectorUrl: HOSTED, choice: { tab: "setup", bot: "claude-app" } }));
  assert.match(claude, /Customize → Connectors/, "measured 2026-10-12: Settings → Connectors moved");
  const chatgpt = textOf(markupOf({ connectorUrl: HOSTED, choice: { tab: "setup", bot: "chatgpt" } }));
  assert.match(chatgpt, /staging slides and receiving your pick/, "measured on Plus 2026-10-12");
});
