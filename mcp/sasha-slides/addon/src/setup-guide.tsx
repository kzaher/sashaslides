// HOW TO CONNECT SASHA, shown when nothing is listening (waiting.ts decides WHEN; this file only
// decides WHAT). Two tabs:
//
//   Setup  for people using a hosted sasha-slides connector (CONNECT.md section B): pick the
//          assistant you use, follow its few steps, paste the prompt. The connector address is a
//          build-time constant; when the build was given none, the tab says so rather than
//          printing a placeholder a user would paste verbatim.
//   Dev    the exact local command (CONNECT.md section A) with the real repository path baked in
//          at build time, then the same prompt.
//
// The chosen tab and assistant are remembered per viewer through an injected store, because the
// HtmlService sandbox may refuse storage outright and the panel must render either way.

import { type JSX, useRef, useState } from "react";
import type { NothingListeningNotice } from "../../feedback-delivery.ts";
import { assertNever } from "./protocol.ts";

/** Everything the panel needs from outside: two build-time constants and where choices are kept. */
export type SetupEnvironment = Readonly<{
  /** Absolute path of the repository checkout the add-on was built from. */
  repoRoot: string;
  /** The hosted connector's `https://<host>/mcp` address, or null when the build was given none. */
  connectorUrl: string | null;
  store: SetupChoiceStore;
}>;

/** Where one viewer's last choice is kept. Both calls must be safe to make when storage is refused. */
export type SetupChoiceStore = Readonly<{
  load(): SetupChoice | null;
  save(choice: SetupChoice): void;
}>;

export type SetupTab = "setup" | "dev";

/**
 * The assistants that can use the REMOTE connector with per-user sign-in. Only clients whose setup
 * steps were checked against their vendor's current documentation are listed (CONNECT.md cites it).
 */
export type SetupBot = "claude-app" | "claude-code" | "chatgpt";

export type SetupChoice = Readonly<{ tab: SetupTab; bot: SetupBot }>;

export const DEFAULT_SETUP_CHOICE: SetupChoice = { tab: "setup", bot: "claude-app" };

const SETUP_TABS: readonly SetupTab[] = ["setup", "dev"];
const SETUP_BOTS: readonly SetupBot[] = ["claude-app", "claude-code", "chatgpt"];

/**
 * THE PANEL. The heading line comes from the shared notice; below it, the two tabs.
 */
export function SetupGuide({
  notice,
  environment,
}: {
  notice: NothingListeningNotice;
  environment: SetupEnvironment;
}): JSX.Element {
  const [choice, setChoice] = useState<SetupChoice>(() => environment.store.load() ?? DEFAULT_SETUP_CHOICE);
  const choose = (next: SetupChoice): void => {
    setChoice(next);
    environment.store.save(next);
  };
  return (
    <div className="sasha-nobody-listening">
      <p className="sasha-nobody-head">{notice.headline}</p>
      <div className="sasha-filter sasha-setup-tabs" role="tablist" aria-label="How to connect Sasha">
        {SETUP_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={tab === choice.tab}
            className={tab === choice.tab ? "sasha-tab sasha-tab-on" : "sasha-tab"}
            onClick={() => choose({ ...choice, tab })}
          >
            {setupTabLabel(tab)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="sasha-setup-panel">
        <SetupTabBody choice={choice} environment={environment} prompt={notice.prompt} onChoose={choose} />
      </div>
    </div>
  );
}

/** The local, single-account command from CONNECT.md section A, for this checkout. */
export function devCommandOf(repoRoot: string): string {
  return `claude mcp add sasha-slides -- npx tsx ${repoRoot}/mcp/sasha-slides/server.ts --stdio`;
}

/** A remembered choice, parsed at the storage boundary. Anything unrecognised is no choice at all. */
export function parseSetupChoice(raw: string | null): SetupChoice | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const tab: unknown = Reflect.get(parsed, "tab");
  const bot: unknown = Reflect.get(parsed, "bot");
  const knownTab = SETUP_TABS.find((candidate) => candidate === tab);
  const knownBot = SETUP_BOTS.find((candidate) => candidate === bot);
  if (knownTab === undefined || knownBot === undefined) return null;
  return { tab: knownTab, bot: knownBot };
}

/**
 * A store over Web Storage. `storage` is a getter rather than a value because merely READING
 * `window.localStorage` throws in a sandbox that refuses it; every access is inside the try.
 */
export function storedSetupChoiceStore(
  storage: () => Pick<Storage, "getItem" | "setItem">,
): SetupChoiceStore {
  return {
    load() {
      try {
        return parseSetupChoice(storage().getItem(SETUP_CHOICE_KEY));
      } catch {
        return null;
      }
    },
    save(choice) {
      try {
        storage().setItem(SETUP_CHOICE_KEY, JSON.stringify(choice));
      } catch {
        // Refused storage only means the choice is not remembered next time.
      }
    },
  };
}

const SETUP_CHOICE_KEY = "sasha-slides.setup-choice";

function setupTabLabel(tab: SetupTab): string {
  switch (tab) {
    case "setup":
      return "Setup";
    case "dev":
      return "Dev";
    default:
      return assertNever(tab);
  }
}

function SetupTabBody({
  choice,
  environment,
  prompt,
  onChoose,
}: {
  choice: SetupChoice;
  environment: SetupEnvironment;
  prompt: string;
  onChoose: (choice: SetupChoice) => void;
}): JSX.Element {
  switch (choice.tab) {
    case "setup":
      return (
        <>
          <div className="sasha-setup-bots" role="group" aria-label="Your assistant">
            {SETUP_BOTS.map((bot) => (
              <button
                key={bot}
                type="button"
                aria-pressed={bot === choice.bot}
                className={bot === choice.bot ? "sasha-tab sasha-tab-on" : "sasha-tab"}
                onClick={() => onChoose({ ...choice, bot })}
              >
                {setupBotLabel(bot)}
              </button>
            ))}
          </div>
          <BotSteps bot={choice.bot} connectorUrl={environment.connectorUrl} prompt={prompt} />
        </>
      );
    case "dev":
      return (
        <ol className="sasha-setup-steps">
          <li>
            In a terminal on the machine with this checkout, attach the local connector:
            <CopyBlock text={devCommandOf(environment.repoRoot)} />
          </li>
          <li>
            Start <code className="sasha-setup-inline">claude</code> and paste:
            <CopyBlock text={prompt} />
          </li>
        </ol>
      );
    default:
      return assertNever(choice.tab);
  }
}

function setupBotLabel(bot: SetupBot): string {
  switch (bot) {
    case "claude-app":
      return "Claude app";
    case "claude-code":
      return "Claude Code";
    case "chatgpt":
      return "ChatGPT";
    default:
      return assertNever(bot);
  }
}

/** One assistant's steps. With no connector address there are no steps to give, and it says so. */
function BotSteps({
  bot,
  connectorUrl,
  prompt,
}: {
  bot: SetupBot;
  connectorUrl: string | null;
  prompt: string;
}): JSX.Element {
  if (connectorUrl === null) {
    return (
      <>
        <p className="sasha-dim sasha-setup-missing">
          The Sasha connector address is not configured yet for this add-on, so there is nothing to
          connect {setupBotLabel(bot)} to. Ask whoever runs Sasha Slides for it, or use the Dev tab to
          run it on your own machine.
        </p>
        <div className="sasha-setup-missing">
          If {setupBotLabel(bot)} already has the Sasha connector, paste:
          <CopyBlock text={prompt} />
        </div>
      </>
    );
  }
  switch (bot) {
    case "claude-app":
      return (
        <ol className="sasha-setup-steps">
          <li>
            In claude.ai or Claude Desktop open Settings → Connectors → Add custom connector. (On a
            Team or Enterprise plan an owner adds it under Admin settings → Connectors.)
          </li>
          <li>
            Name it Sasha Slides and give it this address:
            <CopyBlock text={connectorUrl} />
          </li>
          <li>Press Connect and sign in with the Google account that owns this deck.</li>
          <li>
            In a new chat, paste:
            <CopyBlock text={prompt} />
          </li>
        </ol>
      );
    case "claude-code":
      return (
        <ol className="sasha-setup-steps">
          <li>
            In a terminal, add the connector:
            <CopyBlock text={`claude mcp add --transport http sasha-slides ${connectorUrl}`} />
          </li>
          <li>
            Start <code className="sasha-setup-inline">claude</code>, run <code className="sasha-setup-inline">/mcp</code> and sign in with
            the Google account that owns this deck.
          </li>
          <li>
            Paste:
            <CopyBlock text={prompt} />
          </li>
        </ol>
      );
    case "chatgpt":
      // Steps and plan limits from OpenAI's "Add custom MCP server" guide
      // (developers.openai.com/api/docs/guides/custom-mcp-server) and help centre article 12584461.
      return (
        <>
          <p className="sasha-dim">
            Needs ChatGPT on the web. Checked on a Plus account: adding the server, signing in and a
            read-only call all worked. OpenAI lists full MCP with write tools, which Sasha needs to
            stage slides, for Business, Enterprise and Edu, and read-only tools on Pro. In a workspace
            an admin may first have to allow custom MCP servers.
          </p>
          <ol className="sasha-setup-steps">
            <li>
              Open <ExternalLink href="https://chatgpt.com/plugins" />.
            </li>
            <li>Press the + button, then Add custom MCP server.</li>
            <li>
              Name it Sasha Slides. Under Connection, paste this as the Server URL:
              <CopyBlock text={connectorUrl} />
            </li>
            <li>
              Under Authentication choose OAuth. Leave any client ID and secret empty: Sasha registers
              ChatGPT by itself. If it asks how to register, pick dynamic client registration (DCR).
            </li>
            <li>Read the risk warning and press I understand and want to continue.</li>
            <li>Press Create as a plugin, and sign in with the Google account that owns this deck when asked.</li>
            <li>
              Open <ExternalLink href="https://chatgpt.com/plugins?view=personal" />, open Sasha Slides and
              press + to install it.
            </li>
            <li>
              Start a new chat, type @, choose Sasha Slides, and paste:
              <CopyBlock text={prompt} />
              ChatGPT asks you to confirm each Sasha action that writes to your Drive; approve them.
            </li>
          </ol>
        </>
      );
    default:
      return assertNever(bot);
  }
}

/** A link out of the sidebar. The HtmlService frame cannot navigate itself, so it opens a new tab. */
function ExternalLink({ href }: { href: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {href}
    </a>
  );
}

/**
 * A copyable block. The HtmlService sandbox may refuse `navigator.clipboard`, so a refusal (or its
 * absence) falls back to selecting the text, and the button then says to press Ctrl+C.
 */
function CopyBlock({ text }: { text: string }): JSX.Element {
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<CopyOutcome>("idle");
  const selectText = (): void => {
    const code = codeRef.current;
    const selection = window.getSelection();
    if (code === null || selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    setCopied("selected");
  };
  const copy = (): void => {
    // `navigator.clipboard` is typed as always present but is undefined outside a secure context.
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      selectText();
      return;
    }
    clipboard.writeText(text).then(() => setCopied("copied"), selectText);
  };
  return (
    <div className="sasha-copy-row">
      <code ref={codeRef} className="sasha-copyable">
        {text}
      </code>
      <button type="button" className="sasha-copy-button" onClick={copy}>
        {copyLabel(copied)}
      </button>
    </div>
  );
}

type CopyOutcome = "idle" | "copied" | "selected";

function copyLabel(outcome: CopyOutcome): string {
  switch (outcome) {
    case "idle":
      return "Copy";
    case "copied":
      return "Copied";
    case "selected":
      return "Press Ctrl+C";
    default:
      return assertNever(outcome);
  }
}
