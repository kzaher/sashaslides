// THE MOCK SCREENS of the setup walkthrough: an approximate claude.ai, ChatGPT and Google sign-in,
// drawn from plain elements so the walkthrough carries no screenshot of anyone's site.
//
// APPROXIMATE ON PURPOSE. Each mock only has to be recognisable (claude.ai's cream page, serif
// headings and orange mark; ChatGPT's white page and black pill buttons; Google's grey page and white
// card) and to put the buttons where the captions say they are. Copying either site's current look
// exactly would date the walkthrough with their next redesign, as it dated the recordings.
//
// Everything is placed in the stage's own 800x500 coordinates. The elements the pointer acts on are
// `Target`s, positioned from walkthrough-layout.ts so the pointer and the button can never disagree;
// the rest is placed by hand around them. A screen is a pure function of the frame: typed text,
// scroll offsets, pressed and ticked states all come from walkthrough-timeline.ts.

import type { CSSProperties, JSX, ReactNode } from "react";
import { SCROLL_REGIONS, targetBox, type ScreenId, type TargetName } from "./walkthrough-layout.ts";
import { scrolledToEnd, wasClicked, type WalkthroughFrame } from "./walkthrough-timeline.ts";
import { CHATGPT_PROMPT, CLAUDE_PROMPT } from "./walkthrough-scripts.ts";
import { assertNever } from "./protocol.ts";

/** The account the Google screens sign in with: a placeholder, never a real address. */
export const PLACEHOLDER_ACCOUNT = "you@example.com";

/** The 12 tools claude.ai lists once Sasha Slides is connected. */
export const SASHA_TOOLS: readonly string[] = [
  "open_work",
  "propose_slides",
  "await_pick",
  "proposal_state",
  "slide_images",
  "revise_slide",
  "clear_slides",
  "read_feedback",
  "reply_feedback",
  "resolve_feedback",
  "await_feedback",
  "session_events",
];

/** One moment of the walkthrough's screen: the browser's address bar and the page under it. */
export function WalkthroughScreen({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  return (
    <div className="sasha-wt-screen">
      <ScreenBody frame={frame} />
      <div className="sasha-wt-browser" style={place({ x: 0, y: 0, width: 800, height: 30 })}>
        <span className="sasha-wt-dots" />
        <span className="sasha-wt-address">{addressOf(frame.screen)}</span>
      </div>
    </div>
  );
}

/** What the browser's address bar shows on each screen. */
export function addressOf(screen: ScreenId): string {
  switch (screen) {
    case "claude-home":
      return "claude.ai/new";
    case "claude-customize":
      return "claude.ai/customize";
    case "claude-connectors":
    case "claude-connectors-menu":
    case "claude-add-dialog":
    case "claude-dialog-options":
    case "claude-connector-detail":
    case "claude-connected":
      return "claude.ai/customize/connectors";
    case "claude-permission":
    case "claude-answer":
      return "claude.ai/chat";
    case "chatgpt-home":
      return "chatgpt.com";
    case "chatgpt-plugins":
    case "chatgpt-plugins-menu":
    case "chatgpt-mcp-form":
    case "chatgpt-connect":
    case "chatgpt-installed":
      return "chatgpt.com/plugins";
    case "chatgpt-mention":
    case "chatgpt-answer":
      return "chatgpt.com/c";
    case "google-choose-account":
    case "google-unverified":
    case "google-sign-in":
    case "google-additional-access":
      return "accounts.google.com";
    default:
      return assertNever(screen);
  }
}

type ClaudeScreen = Extract<ScreenId, `claude-${string}`>;
type ChatgptScreen = Extract<ScreenId, `chatgpt-${string}`>;

function ScreenBody({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  const screen = frame.screen;
  switch (screen) {
    case "claude-home":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeGreeting />
          <Target frame={frame} screen={screen} name="composer" className="sasha-wt-claude-composer">
            <FieldText frame={frame} name="composer" placeholder="How can I help you today?" wrap />
            <span className="sasha-wt-claude-send">↑</span>
          </Target>
          <div className="sasha-wt-claude-chips" style={place({ x: 255, y: 340, width: 460 })}>
            {["Write", "Learn", "Code", "Life stuff"].map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        </ClaudeFrame>
      );
    case "claude-customize":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeCustomizeHead frame={frame} screen={screen} active="skills" />
          {["Brand guidelines", "Meeting notes", "Data analysis"].map((skill, index) => (
            <div key={skill} className="sasha-wt-claude-row" style={place({ x: 200, y: 146 + index * 52, width: 576, height: 44 })}>
              <span className="sasha-wt-claude-row-name">{skill}</span>
              <span className="sasha-wt-claude-toggle" />
            </div>
          ))}
        </ClaudeFrame>
      );
    case "claude-connectors":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeConnectorsPage frame={frame} screen={screen} />
        </ClaudeFrame>
      );
    case "claude-connectors-menu":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeConnectorsPage frame={frame} screen={screen} />
          <div className="sasha-wt-claude-menu" style={place({ x: 560, y: 86, width: 220, height: 76 })} />
          <div className="sasha-wt-claude-menu-item" style={place({ x: 566, y: 92, width: 208, height: 30 })}>
            Browse connectors
          </div>
          <Target frame={frame} screen={screen} name="add-custom" className="sasha-wt-claude-menu-item sasha-wt-hover">
            Add custom connector
          </Target>
        </ClaudeFrame>
      );
    case "claude-add-dialog":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeConnectorsPage frame={frame} screen={screen} />
          <ClaudeDialog title="Add custom connector">
            <div className="sasha-wt-claude-dim-text" style={place({ x: 244, y: 118, width: 392 })}>
              Connect Claude to your data and tools.
            </div>
            <div className="sasha-wt-label" style={place({ x: 244, y: 148 })}>Name</div>
            <Target frame={frame} screen={screen} name="name-field" className="sasha-wt-claude-field">
              <FieldText frame={frame} name="name-field" placeholder="My connector" />
            </Target>
            <div className="sasha-wt-label" style={place({ x: 244, y: 220 })}>Remote MCP server URL</div>
            <Target frame={frame} screen={screen} name="url-field" className="sasha-wt-claude-field">
              <FieldText frame={frame} name="url-field" placeholder="https://" />
            </Target>
            <div className="sasha-wt-claude-dim-text" style={place({ x: 244, y: 290, width: 392 })}>
              Advanced settings ›
            </div>
            <div className="sasha-wt-claude-button sasha-wt-outline" style={place({ x: 446, y: 370, width: 90, height: 34 })}>
              Cancel
            </div>
            <Target frame={frame} screen={screen} name="continue" className="sasha-wt-claude-button">
              Continue
            </Target>
          </ClaudeDialog>
        </ClaudeFrame>
      );
    case "claude-dialog-options":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeConnectorsPage frame={frame} screen={screen} />
          <ClaudeDialog title="Add custom connector">
            <ClaudeOptions frame={frame} />
            <div className="sasha-wt-rule" style={place({ x: 220, y: 358, width: 440, height: 1 })} />
            <div className="sasha-wt-claude-button sasha-wt-outline" style={place({ x: 466, y: 370, width: 90, height: 34 })}>
              Cancel
            </div>
            <Target frame={frame} screen={screen} name="add" className="sasha-wt-claude-button">
              Add
            </Target>
          </ClaudeDialog>
        </ClaudeFrame>
      );
    case "claude-connector-detail":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeConnectorsPage frame={frame} screen={screen} sasha={<SashaRow frame={frame} />} />
          <Target frame={frame} screen={screen} name="connect" className="sasha-wt-claude-button">
            Connect
          </Target>
        </ClaudeFrame>
      );
    case "claude-connected":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeConnected frame={frame} />
        </ClaudeFrame>
      );
    case "claude-permission":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeUserMessage frame={frame} />
          <div className="sasha-wt-claude-card" style={place({ x: 200, y: 168, width: 580, height: 178 })} />
          <div className="sasha-wt-claude-card-title" style={place({ x: 222, y: 188, width: 536 })}>
            Claude wants to use <b>What is waiting for me</b> from <b>Sasha Slides</b>
          </div>
          <div className="sasha-wt-claude-dim-text" style={place({ x: 222, y: 250, width: 536 })}>
            Sasha Slides · open_work
          </div>
          <div className="sasha-wt-claude-button sasha-wt-outline" style={place({ x: 404, y: 296, width: 108, height: 32 })}>
            Always allow
          </div>
          <Target frame={frame} screen={screen} name="allow-once" className="sasha-wt-claude-button">
            Allow once
          </Target>
          <div className="sasha-wt-claude-button sasha-wt-plain" style={place({ x: 628, y: 296, width: 70, height: 32 })}>
            Deny
          </div>
          <ClaudeReplyBox />
        </ClaudeFrame>
      );
    case "claude-answer":
      return (
        <ClaudeFrame frame={frame} screen={screen}>
          <ClaudeUserMessage frame={frame} />
          <div className="sasha-wt-claude-tool" style={place({ x: 200, y: 160, width: 270, height: 32 })}>
            ✓ What is waiting for me <span>Sasha Slides</span>
          </div>
          <div className="sasha-wt-claude-answer" style={place({ x: 200, y: 210, width: 560 })}>
            <p>Nothing is waiting for you yet: there are no open proposals in your Drive.</p>
            <p>Ask me for a slide and I will stage a few candidates in Google Slides for you to pick from.</p>
          </div>
          <ClaudeReplyBox />
        </ClaudeFrame>
      );
    case "chatgpt-home":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <ChatgptGreeting />
          <Target frame={frame} screen={screen} name="composer" className="sasha-wt-gpt-composer">
            <span className="sasha-wt-gpt-plus">+</span>
            <FieldText frame={frame} name="composer" placeholder="Ask anything" />
            <span className="sasha-wt-gpt-send">↑</span>
          </Target>
          {(frame.typed["composer"] ?? "").startsWith("@") ? <ChatgptMentionList frame={frame} /> : null}
        </ChatgptFrame>
      );
    case "chatgpt-plugins":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <ChatgptPluginsPage frame={frame} screen={screen} installed={false} />
        </ChatgptFrame>
      );
    case "chatgpt-plugins-menu":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <ChatgptPluginsPage frame={frame} screen={screen} installed={false} />
          <div className="sasha-wt-gpt-menu" style={place({ x: 584, y: 114, width: 198, height: 48 })} />
          <Target frame={frame} screen={screen} name="add-custom" className="sasha-wt-gpt-menu-item sasha-wt-hover">
            Add custom MCP server
          </Target>
        </ChatgptFrame>
      );
    case "chatgpt-mcp-form":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <ChatgptPluginsPage frame={frame} screen={screen} installed={false} />
          <ChatgptMcpForm frame={frame} />
        </ChatgptFrame>
      );
    case "chatgpt-connect":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <ChatgptPluginsPage frame={frame} screen={screen} installed={false} />
          <div className="sasha-wt-shade" style={place({ x: 0, y: 30, width: 800, height: 470 })} />
          <div className="sasha-wt-gpt-modal" style={place({ x: 250, y: 130, width: 400, height: 250 })} />
          <SashaIcon style={place({ x: 430, y: 150, width: 40, height: 40 })} />
          <div className="sasha-wt-gpt-modal-title" style={place({ x: 250, y: 204, width: 400 })}>
            Connect Sasha Slides
          </div>
          <div className="sasha-wt-gpt-dim-text sasha-wt-center" style={place({ x: 284, y: 238, width: 332 })}>
            You will sign in to Sasha Slides so ChatGPT can use its tools with your account.
          </div>
          <Target frame={frame} screen={screen} name="continue" className="sasha-wt-gpt-button">
            Continue to Sasha Slides
          </Target>
        </ChatgptFrame>
      );
    case "chatgpt-installed":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <ChatgptPluginsPage frame={frame} screen={screen} installed />
        </ChatgptFrame>
      );
    case "chatgpt-mention":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <ChatgptGreeting />
          <div className="sasha-wt-gpt-composer sasha-wt-gpt-composer-tall" style={place({ x: 260, y: 212, width: 460, height: 84 })} />
          <div className="sasha-wt-gpt-chip" style={place({ x: 276, y: 228, width: 112, height: 26 })}>
            <SashaIcon style={{ width: 16, height: 16 }} /> Sasha Slides
          </div>
          <Target frame={frame} screen={screen} name="composer-text" className="sasha-wt-gpt-text-area">
            <FieldText frame={frame} name="composer-text" placeholder="" wrap />
          </Target>
          <span className="sasha-wt-gpt-send" style={place({ x: 682, y: 260, width: 28, height: 28 })}>
            ↑
          </span>
        </ChatgptFrame>
      );
    case "chatgpt-answer":
      return (
        <ChatgptFrame frame={frame} screen={screen}>
          <div className="sasha-wt-gpt-bubble" style={place({ x: 400, y: 82, width: 380 })}>
            <span className="sasha-wt-gpt-chip-inline">@Sasha Slides</span> {frame.typed["composer-text"] ?? CHATGPT_PROMPT}
          </div>
          <div className="sasha-wt-gpt-dim-text" style={place({ x: 210, y: 168, width: 400 })}>
            Called Sasha Slides · open_work ›
          </div>
          <div className="sasha-wt-gpt-answer" style={place({ x: 210, y: 198, width: 560 })}>
            <p>Nothing is waiting for you yet: there are no open proposals in your Drive.</p>
            <p>Ask for a slide and Sasha Slides will stage a few candidates in Google Slides for you to pick from.</p>
          </div>
          <div className="sasha-wt-gpt-composer" style={place({ x: 260, y: 424, width: 460, height: 50 })}>
            <span className="sasha-wt-gpt-plus">+</span>
            <span className="sasha-wt-placeholder">Ask anything</span>
          </div>
        </ChatgptFrame>
      );
    case "google-choose-account":
      return (
        <GoogleFrame>
          <div className="sasha-wt-google-title" style={place({ x: 80, y: 124, width: 300 })}>
            Choose an account
          </div>
          <div className="sasha-wt-google-text" style={place({ x: 80, y: 176, width: 300 })}>
            to continue to <span className="sasha-wt-google-link">sashaslides.com</span>
          </div>
          <Target frame={frame} screen={screen} name="account" className="sasha-wt-google-account sasha-wt-hover">
            <span className="sasha-wt-avatar">Y</span>
            <span className="sasha-wt-google-who">
              <b>You</b>
              <span>{PLACEHOLDER_ACCOUNT}</span>
            </span>
          </Target>
          <div className="sasha-wt-google-account sasha-wt-google-other" style={place({ x: 420, y: 216, width: 300, height: 50 })}>
            <span className="sasha-wt-avatar sasha-wt-avatar-empty">+</span>
            Use another account
          </div>
        </GoogleFrame>
      );
    case "google-unverified":
      return (
        <GoogleFrame>
          <div className="sasha-wt-google-warning" style={place({ x: 80, y: 104, width: 36, height: 36 })}>
            !
          </div>
          <div className="sasha-wt-google-title" style={place({ x: 80, y: 156, width: 620 })}>
            Google hasn’t verified this app
          </div>
          <div className="sasha-wt-google-text" style={place({ x: 80, y: 214, width: 600 })}>
            The app is requesting access to sensitive info in your Google Account. Until the developer verifies this app
            with Google, you shouldn’t use it.
          </div>
          <Target frame={frame} screen={screen} name="continue" className="sasha-wt-google-text-button">
            Continue
          </Target>
          <div className="sasha-wt-google-button" style={place({ x: 240, y: 396, width: 150, height: 36 })}>
            Back to safety
          </div>
        </GoogleFrame>
      );
    case "google-sign-in":
      return (
        <GoogleFrame>
          <div className="sasha-wt-google-title" style={place({ x: 80, y: 120, width: 320 })}>
            Sign in to sashaslides.com
          </div>
          <GoogleAccountChip />
          <div className="sasha-wt-google-text sasha-wt-google-small" style={place({ x: 420, y: 124, width: 300 })}>
            By continuing, Google will share your name, email address, language preference and profile picture with
            sashaslides.com.
          </div>
          <div className="sasha-wt-google-text sasha-wt-google-small" style={place({ x: 420, y: 230, width: 300 })}>
            You can manage Sign in with Google in your Google Account.
          </div>
          <div className="sasha-wt-google-text-button" style={place({ x: 500, y: 404, width: 96, height: 36 })}>
            Cancel
          </div>
          <Target frame={frame} screen={screen} name="continue" className="sasha-wt-google-button">
            Continue
          </Target>
        </GoogleFrame>
      );
    case "google-additional-access":
      return <GoogleAdditionalAccess frame={frame} />;
    default:
      return assertNever(screen);
  }
}

/**
 * An element the pointer acts on, at its box from the layout table. It is drawn pressed for a moment
 * after a click, which is half of how a click reads on screen (the ripple is the other half).
 */
function Target<TScreen extends ScreenId>({
  frame,
  screen,
  name,
  className,
  disabled,
  children,
}: Readonly<{
  frame: WalkthroughFrame;
  screen: TScreen;
  name: TargetName<TScreen>;
  className: string;
  disabled?: boolean;
  children?: ReactNode;
}>): JSX.Element {
  const pressed = frame.pressed !== null && frame.pressed.screen === screen && frame.pressed.target === name;
  const classes = ["sasha-wt-target", className];
  if (pressed) classes.push("sasha-wt-pressed");
  if (frame.focused === name) classes.push("sasha-wt-focused");
  if (disabled === true) classes.push("sasha-wt-disabled");
  return (
    <div data-walkthrough-target={name} className={classes.join(" ")} style={place(targetBox(screen, name))}>
      {children}
    </div>
  );
}

/**
 * The text typed so far into a field, or its placeholder, with a caret while the field has focus.
 * Without `wrap` a long value keeps its END in view, the part being typed (the row is reversed, so it
 * overflows on the left).
 */
function FieldText({
  frame,
  name,
  placeholder,
  wrap,
}: Readonly<{ frame: WalkthroughFrame; name: string; placeholder: string; wrap?: boolean }>): JSX.Element {
  const value = frame.typed[name] ?? "";
  const caret = frame.focused === name ? <span className="sasha-wt-caret" /> : null;
  const content =
    value === "" ? (
      <>
        {caret}
        <span className="sasha-wt-placeholder">{placeholder}</span>
      </>
    ) : (
      <span className="sasha-wt-value">
        {value}
        {caret}
      </span>
    );
  return <span className={wrap === true ? "sasha-wt-field-text sasha-wt-wrap" : "sasha-wt-field-text"}>{content}</span>;
}

// ---------------------------------------------------------------- claude.ai

function ClaudeFrame({
  frame,
  screen,
  children,
}: Readonly<{ frame: WalkthroughFrame; screen: ClaudeScreen; children: ReactNode }>): JSX.Element {
  return (
    <div className="sasha-wt-claude">
      <div className="sasha-wt-claude-side" style={place({ x: 0, y: 30, width: 170, height: 470 })} />
      <div className="sasha-wt-claude-brand" style={place({ x: 18, y: 42 })}>
        Claude
      </div>
      <Target frame={frame} screen={screen} name="new-chat" className="sasha-wt-claude-nav">
        <span className="sasha-wt-claude-new">+</span> New chat
      </Target>
      {["Chats", "Projects", "Artifacts"].map((item, index) => (
        <div key={item} className="sasha-wt-claude-nav" style={place({ x: 10, y: 108 + index * 22, width: 150, height: 22 })}>
          {item}
        </div>
      ))}
      <Target frame={frame} screen={screen} name="customize" className="sasha-wt-claude-nav">
        Customize
      </Target>
      <div className="sasha-wt-claude-section" style={place({ x: 18, y: 222 })}>
        Recents
      </div>
      {["Quarterly review deck", "Team offsite plan", "Reading list"].map((item, index) => (
        <div key={item} className="sasha-wt-claude-recent" style={place({ x: 18, y: 244 + index * 24, width: 140 })}>
          {item}
        </div>
      ))}
      <div className="sasha-wt-claude-me" style={place({ x: 12, y: 456, width: 150, height: 32 })}>
        <span className="sasha-wt-avatar sasha-wt-avatar-small">Y</span> You
      </div>
      {children}
    </div>
  );
}

function ClaudeGreeting(): JSX.Element {
  return (
    <div className="sasha-wt-claude-greeting" style={place({ x: 170, y: 160, width: 630 })}>
      <ClaudeMark size={30} /> Good afternoon
    </div>
  );
}

/** claude.ai's orange mark, approximated: rounded spokes around a centre. */
function ClaudeMark({ size }: Readonly<{ size: number }>): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true">
      {CLAUDE_SPOKES.map((angle) => (
        <line
          key={angle}
          x1={0}
          y1={0}
          x2={10.5 * Math.cos((angle * Math.PI) / 180)}
          y2={10.5 * Math.sin((angle * Math.PI) / 180)}
          stroke="#d97757"
          strokeWidth={2.8}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

const CLAUDE_SPOKES: readonly number[] = [0, 33, 70, 105, 140, 180, 214, 250, 287, 322];

type CustomizeTab = "skills" | "connectors";

function ClaudeCustomizeHead({
  frame,
  screen,
  active,
}: Readonly<{ frame: WalkthroughFrame; screen: ClaudeScreen; active: CustomizeTab }>): JSX.Element {
  const tabClass = (tab: CustomizeTab): string => (tab === active ? "sasha-wt-claude-tab sasha-wt-claude-tab-on" : "sasha-wt-claude-tab");
  return (
    <>
      <div className="sasha-wt-claude-title" style={place({ x: 200, y: 46 })}>
        Customize
      </div>
      <div className={tabClass("skills")} style={place({ x: 200, y: 92, width: 62, height: 30 })}>
        Skills
      </div>
      {screen === "claude-customize" ? (
        <Target frame={frame} screen="claude-customize" name="connectors-tab" className={tabClass("connectors")}>
          Connectors
        </Target>
      ) : (
        <div className={tabClass("connectors")} style={place(targetBox("claude-customize", "connectors-tab"))}>
          Connectors
        </div>
      )}
      <div className="sasha-wt-claude-tab" style={place({ x: 378, y: 92, width: 60, height: 30 })}>
        Styles
      </div>
      <div className="sasha-wt-rule" style={place({ x: 200, y: 122, width: 580, height: 1 })} />
    </>
  );
}

function ClaudeConnectorsPage({
  frame,
  screen,
  sasha,
}: Readonly<{ frame: WalkthroughFrame; screen: ClaudeScreen; sasha?: ReactNode }>): JSX.Element {
  const first = sasha === undefined ? 0 : 1;
  return (
    <>
      <ClaudeCustomizeHead frame={frame} screen={screen} active="connectors" />
      {screen === "claude-connectors" ? (
        <Target frame={frame} screen="claude-connectors" name="add" className="sasha-wt-claude-button">
          + Add
        </Target>
      ) : (
        <div className="sasha-wt-claude-button" style={place(targetBox("claude-connectors", "add"))}>
          + Add
        </div>
      )}
      {sasha}
      {CLAUDE_CONNECTORS.map((connector, index) => (
        <div
          key={connector.name}
          className="sasha-wt-claude-row"
          style={place({ x: 200, y: 142 + (index + first) * 52, width: 580, height: 46 })}
        >
          <span className="sasha-wt-claude-icon" style={{ background: connector.color }} />
          <span className="sasha-wt-claude-row-name">{connector.name}</span>
          <span className="sasha-wt-claude-dim-text">{connector.state}</span>
        </div>
      ))}
    </>
  );
}

const CLAUDE_CONNECTORS: readonly Readonly<{ name: string; color: string; state: string }>[] = [
  { name: "Web search", color: "#6a9bcc", state: "Enabled" },
  { name: "Calendar", color: "#788c5d", state: "Connected" },
  { name: "Email", color: "#c46686", state: "Connect" },
  { name: "Files", color: "#bcab8b", state: "Connect" },
];

function SashaRow({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  return (
    <div className="sasha-wt-claude-row sasha-wt-claude-row-new" style={place({ x: 200, y: 142, width: 580, height: 46 })}>
      <SashaIcon style={{ width: 26, height: 26 }} />
      <span className="sasha-wt-claude-row-name">
        Sasha Slides <span className="sasha-wt-badge">Custom</span>
      </span>
      <span className="sasha-wt-claude-dim-text sasha-wt-ellipsis" style={{ maxWidth: 200 }}>
        {frame.typed["url-field"] ?? ""}
      </span>
    </div>
  );
}

function ClaudeDialog({ title, children }: Readonly<{ title: string; children: ReactNode }>): JSX.Element {
  return (
    <>
      <div className="sasha-wt-shade" style={place({ x: 0, y: 30, width: 800, height: 470 })} />
      <div className="sasha-wt-claude-dialog" style={place({ x: 220, y: 66, width: 440, height: 356 })} />
      <div className="sasha-wt-claude-dialog-title" style={place({ x: 244, y: 82, width: 392 })}>
        {title} <span className="sasha-wt-badge">Beta</span>
      </div>
      {children}
    </>
  );
}

/** Step 8's dialog body: the detected defaults, in a region that scrolls to Add. */
function ClaudeOptions({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  const offset = frame.scroll["claude-options"];
  const viewport = { x: 220, y: 116, width: 440, height: 238 };
  const content = viewport.height + SCROLL_REGIONS["claude-options"].maximumOffset;
  const thumb = (viewport.height * viewport.height) / content;
  const rows: readonly Readonly<{ label: string; value: string; select: boolean }>[] = [
    { label: "Name", value: frame.typed["name-field"] ?? "Sasha Slides", select: false },
    { label: "Remote MCP server URL", value: frame.typed["url-field"] ?? "", select: false },
    { label: "Authentication", value: "Sign in now", select: true },
    { label: "OAuth client", value: "Register automatically", select: true },
  ];
  return (
    <div className="sasha-wt-scroll" style={place(viewport)}>
      <div className="sasha-wt-claude-options" style={{ transform: `translateY(${-offset}px)`, minHeight: content }}>
        {rows.map((row) => (
          <div key={row.label} className="sasha-wt-claude-option">
            <div className="sasha-wt-label">{row.label}</div>
            <div className={row.select ? "sasha-wt-claude-field sasha-wt-select" : "sasha-wt-claude-field sasha-wt-readonly"}>
              <span className="sasha-wt-ellipsis">{row.value}</span>
            </div>
          </div>
        ))}
        <p className="sasha-wt-claude-dim-text">Claude registers itself with the server. You only sign in.</p>
        <p className="sasha-wt-claude-dim-text">Only add connectors from developers you trust.</p>
      </div>
      <div className="sasha-wt-scrollbar" style={{ height: thumb, top: (offset * viewport.height) / content }} />
    </div>
  );
}

function ClaudeConnected({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  return (
    <>
      <SashaIcon style={place({ x: 200, y: 48, width: 30, height: 30 })} />
      <div className="sasha-wt-claude-title" style={place({ x: 240, y: 46 })}>
        Sasha Slides <span className="sasha-wt-badge">Custom</span>
      </div>
      <div className="sasha-wt-claude-dim-text sasha-wt-ellipsis" style={place({ x: 240, y: 84, width: 400 })}>
        {frame.typed["url-field"] ?? ""}
      </div>
      <div className="sasha-wt-claude-button sasha-wt-outline" style={place({ x: 676, y: 48, width: 100, height: 32 })}>
        Disconnect
      </div>
      <div className="sasha-wt-claude-section sasha-wt-claude-section-dark" style={place({ x: 200, y: 120 })}>
        Tool permissions · 12 tools
      </div>
      {SASHA_TOOLS.map((tool, index) => (
        <div
          key={tool}
          className="sasha-wt-claude-tool-row"
          style={place({ x: index < 6 ? 200 : 494, y: 148 + (index % 6) * 46, width: 286, height: 38 })}
        >
          <span>{tool}</span>
          <span className="sasha-wt-claude-approval">Needs approval</span>
        </div>
      ))}
    </>
  );
}

function ClaudeUserMessage({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  return (
    <div className="sasha-wt-claude-bubble" style={place({ x: 360, y: 52, width: 420 })}>
      {frame.typed["composer"] ?? CLAUDE_PROMPT}
    </div>
  );
}

function ClaudeReplyBox(): JSX.Element {
  return (
    <div className="sasha-wt-claude-composer" style={place({ x: 255, y: 420, width: 460, height: 56 })}>
      <span className="sasha-wt-placeholder">Reply to Claude…</span>
      <span className="sasha-wt-claude-send">↑</span>
    </div>
  );
}

// ---------------------------------------------------------------- ChatGPT

function ChatgptFrame({
  frame,
  screen,
  children,
}: Readonly<{ frame: WalkthroughFrame; screen: ChatgptScreen; children: ReactNode }>): JSX.Element {
  return (
    <div className="sasha-wt-gpt">
      <div className="sasha-wt-gpt-side" style={place({ x: 0, y: 30, width: 180, height: 470 })} />
      <ChatgptMark style={place({ x: 18, y: 42, width: 22, height: 22 })} />
      <Target frame={frame} screen={screen} name="new-chat" className="sasha-wt-gpt-nav">
        <span className="sasha-wt-gpt-glyph">✎</span> New chat
      </Target>
      <div className="sasha-wt-gpt-nav" style={place({ x: 10, y: 108, width: 160, height: 30 })}>
        <span className="sasha-wt-gpt-glyph">⌕</span> Search chats
      </div>
      <Target frame={frame} screen={screen} name="plugins" className="sasha-wt-gpt-nav">
        <span className="sasha-wt-gpt-glyph">⊞</span> Plugins
      </Target>
      <div className="sasha-wt-gpt-section" style={place({ x: 18, y: 192 })}>
        Chats
      </div>
      {["Quarterly review deck", "Team offsite plan", "Reading list"].map((item, index) => (
        <div key={item} className="sasha-wt-gpt-recent" style={place({ x: 18, y: 214 + index * 26, width: 150 })}>
          {item}
        </div>
      ))}
      <div className="sasha-wt-gpt-model" style={place({ x: 200, y: 40 })}>
        ChatGPT <span>⌄</span>
      </div>
      <span className="sasha-wt-avatar sasha-wt-avatar-small" style={place({ x: 758, y: 40, width: 24, height: 24 })}>
        Y
      </span>
      {children}
    </div>
  );
}

/** ChatGPT's knot, approximated by three crossed loops. */
function ChatgptMark({ style }: Readonly<{ style: CSSProperties }>): JSX.Element {
  return (
    <svg style={style} viewBox="-12 -12 24 24" aria-hidden="true">
      <g fill="none" stroke="#0d0d0d" strokeWidth={2}>
        {[0, 60, 120].map((angle) => (
          <ellipse key={angle} rx={9.5} ry={4.5} transform={`rotate(${angle})`} />
        ))}
      </g>
    </svg>
  );
}

function ChatgptGreeting(): JSX.Element {
  return (
    <div className="sasha-wt-gpt-greeting" style={place({ x: 180, y: 160, width: 620 })}>
      What can I help with?
    </div>
  );
}

function ChatgptMentionList({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  return (
    <>
      <div className="sasha-wt-gpt-menu" style={place({ x: 260, y: 282, width: 300, height: 92 })} />
      <Target frame={frame} screen="chatgpt-home" name="mention-sasha" className="sasha-wt-gpt-menu-item sasha-wt-hover">
        <SashaIcon style={{ width: 20, height: 20 }} /> Sasha Slides
      </Target>
      <div className="sasha-wt-gpt-menu-item" style={place({ x: 270, y: 330, width: 280, height: 36 })}>
        <span className="sasha-wt-gpt-tile" style={{ width: 20, height: 20, background: "#9fc5f8" }} /> Web search
      </div>
    </>
  );
}

function ChatgptPluginsPage({
  frame,
  screen,
  installed,
}: Readonly<{ frame: WalkthroughFrame; screen: ChatgptScreen; installed: boolean }>): JSX.Element {
  const featuredTop = installed ? 300 : 192;
  return (
    <>
      <div className="sasha-wt-gpt-title" style={place({ x: 210, y: 74 })}>
        Plugins
      </div>
      {screen === "chatgpt-plugins" ? (
        <Target frame={frame} screen="chatgpt-plugins" name="add" className="sasha-wt-gpt-button">
          Add
        </Target>
      ) : (
        <div className="sasha-wt-gpt-button" style={place(targetBox("chatgpt-plugins", "add"))}>
          Add
        </div>
      )}
      <div className="sasha-wt-gpt-search" style={place({ x: 210, y: 122, width: 570, height: 32 })}>
        ⌕ Search plugins
      </div>
      {installed ? (
        <>
          <div className="sasha-wt-gpt-section sasha-wt-gpt-section-dark" style={place({ x: 210, y: 166 })}>
            Installed
          </div>
          <div className="sasha-wt-gpt-card sasha-wt-gpt-card-new" style={place({ x: 210, y: 190, width: 280, height: 74 })}>
            <SashaIcon style={{ width: 36, height: 36 }} />
            <span>
              <b>Sasha Slides</b>
              <small>Candidate slides for Google Slides</small>
            </span>
            <span className="sasha-wt-gpt-installed">✓</span>
          </div>
        </>
      ) : null}
      <div className="sasha-wt-gpt-section sasha-wt-gpt-section-dark" style={place({ x: 210, y: featuredTop - 24 })}>
        Featured
      </div>
      {CHATGPT_PLUGINS.map((plugin, index) => (
        <div
          key={plugin.name}
          className="sasha-wt-gpt-card"
          style={place({ x: 210 + (index % 3) * 194, y: featuredTop + Math.floor(index / 3) * 84, width: 182, height: 74 })}
        >
          <span className="sasha-wt-gpt-tile" style={{ background: plugin.color }} />
          <span>
            <b>{plugin.name}</b>
            <small>Plugin</small>
          </span>
        </div>
      ))}
    </>
  );
}

const CHATGPT_PLUGINS: readonly Readonly<{ name: string; color: string }>[] = [
  { name: "Calendar", color: "#f6c26b" },
  { name: "Notes", color: "#8fd3b6" },
  { name: "Travel", color: "#9fc5f8" },
  { name: "Recipes", color: "#f4a7a3" },
  { name: "Music", color: "#c5b3f6" },
  { name: "Docs", color: "#a8d08d" },
];

function ChatgptMcpForm({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  const screen = "chatgpt-mcp-form";
  const ticked = wasClicked(frame, screen, "understand");
  return (
    <>
      <div className="sasha-wt-shade" style={place({ x: 0, y: 30, width: 800, height: 470 })} />
      <div className="sasha-wt-gpt-modal" style={place({ x: 210, y: 40, width: 480, height: 452 })} />
      <div className="sasha-wt-gpt-modal-title sasha-wt-left" style={place({ x: 234, y: 56, width: 400 })}>
        Add custom MCP server
      </div>
      <div className="sasha-wt-gpt-close" style={place({ x: 652, y: 54, width: 20, height: 20 })}>
        ×
      </div>
      <div className="sasha-wt-label" style={place({ x: 234, y: 86 })}>Name</div>
      <Target frame={frame} screen={screen} name="name-field" className="sasha-wt-gpt-field">
        <FieldText frame={frame} name="name-field" placeholder="My server" />
      </Target>
      <div className="sasha-wt-label" style={place({ x: 234, y: 144 })}>Description (optional)</div>
      <Target frame={frame} screen={screen} name="description-field" className="sasha-wt-gpt-field">
        <FieldText frame={frame} name="description-field" placeholder="What it does" />
      </Target>
      <div className="sasha-wt-label" style={place({ x: 234, y: 202 })}>Connection</div>
      <div className="sasha-wt-gpt-radio" style={place({ x: 234, y: 222, width: 200, height: 22 })}>
        <span className="sasha-wt-gpt-dot" /> Server URL
      </div>
      <Target frame={frame} screen={screen} name="url-field" className="sasha-wt-gpt-field">
        <FieldText frame={frame} name="url-field" placeholder="https://" />
      </Target>
      <div className="sasha-wt-label" style={place({ x: 234, y: 292 })}>Authentication</div>
      <div className="sasha-wt-gpt-field sasha-wt-select" style={place({ x: 234, y: 310, width: 432, height: 32 })}>
        OAuth
      </div>
      <div className="sasha-wt-gpt-warning" style={place({ x: 234, y: 352, width: 432, height: 78 })}>
        Custom MCP servers are not reviewed by OpenAI. Only connect servers you trust.
      </div>
      <Target frame={frame} screen={screen} name="understand" className="sasha-wt-gpt-check">
        <span className={ticked ? "sasha-wt-box sasha-wt-box-on" : "sasha-wt-box"}>{ticked ? "✓" : ""}</span>I understand and want
        to continue
      </Target>
      <div className="sasha-wt-gpt-button sasha-wt-outline" style={place({ x: 430, y: 442, width: 86, height: 34 })}>
        Cancel
      </div>
      <Target frame={frame} screen={screen} name="create" className="sasha-wt-gpt-button" disabled={!ticked}>
        Create as a plugin
      </Target>
    </>
  );
}

// ---------------------------------------------------------------- Google

function GoogleFrame({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <div className="sasha-wt-google">
      <div className="sasha-wt-google-page" style={place({ x: 0, y: 30, width: 800, height: 470 })} />
      <div className="sasha-wt-google-card" style={place({ x: 50, y: 54, width: 700, height: 420 })} />
      <div className="sasha-wt-google-brand" style={place({ x: 80, y: 72 })}>
        <span className="sasha-wt-google-g">G</span> Sign in with Google
      </div>
      {children}
    </div>
  );
}

function GoogleAccountChip(): JSX.Element {
  return (
    <div className="sasha-wt-google-chip" style={place({ x: 80, y: 250, width: 220, height: 32 })}>
      <span className="sasha-wt-avatar sasha-wt-avatar-small">Y</span> {PLACEHOLDER_ACCOUNT}
    </div>
  );
}

function GoogleAdditionalAccess({ frame }: Readonly<{ frame: WalkthroughFrame }>): JSX.Element {
  const screen = "google-additional-access";
  const offset = frame.scroll["google-access"];
  const atEnd = scrolledToEnd(frame, "google-access");
  const viewport = { x: 420, y: 86, width: 300, height: 300 };
  return (
    <GoogleFrame>
      <div className="sasha-wt-google-title sasha-wt-google-title-small" style={place({ x: 80, y: 120, width: 300 })}>
        sashaslides.com wants additional access to your Google Account
      </div>
      <GoogleAccountChip />
      <div className="sasha-wt-scroll" style={place(viewport)}>
        <div
          className="sasha-wt-google-access"
          style={{ transform: `translateY(${-offset}px)`, minHeight: viewport.height + SCROLL_REGIONS["google-access"].maximumOffset }}
        >
          <p>
            <b>When you allow this access, sashaslides.com will be able to</b>
          </p>
          <div className="sasha-wt-google-scope">
            <span className="sasha-wt-google-slides" />
            See, edit, create and delete all your Google Slides presentations.
          </div>
          <div className="sasha-wt-google-scope">
            <span className="sasha-wt-google-drive" />
            See, edit, create and delete only the specific Google Drive files you use with this app.
          </div>
          <p>
            <b>Make sure that you trust sashaslides.com</b>
          </p>
          <p>Review its Privacy Policy and Terms of Service to understand how it will process and protect your data.</p>
          <p>To make changes at any time, go to your Google Account.</p>
          <p>Learn how Google helps you share data safely.</p>
        </div>
      </div>
      {atEnd ? null : (
        <Target frame={frame} screen={screen} name="scroll-down" className="sasha-wt-google-round">
          ↓
        </Target>
      )}
      <div className="sasha-wt-google-text-button" style={place({ x: 500, y: 404, width: 96, height: 36 })}>
        Cancel
      </div>
      <Target frame={frame} screen={screen} name="continue" className="sasha-wt-google-button" disabled={!atEnd}>
        Continue
      </Target>
    </GoogleFrame>
  );
}

// ---------------------------------------------------------------- shared

/** Sasha Slides' own mark: a rounded tile with an S, in the add-on's blue. */
function SashaIcon({ style }: Readonly<{ style: CSSProperties }>): JSX.Element {
  return (
    <span className="sasha-wt-sasha-icon" style={style}>
      S
    </span>
  );
}

function place({ x, y, width, height }: Readonly<{ x: number; y: number; width?: number; height?: number }>): CSSProperties {
  return { position: "absolute", left: x, top: y, width, height };
}
