// WHERE EVERYTHING IN THE SETUP WALKTHROUGH IS, in the stage's own 800x500 coordinates.
//
// The walkthrough replaces two screen recordings of connecting Sasha Slides to claude.ai and to
// ChatGPT. Its pointer has to land on mock buttons, so the mocks are laid out from THIS table rather
// than measured after they render: the timeline (walkthrough-timeline.ts) can then compute every
// pointer position as a pure function, the same numbers place the elements on screen, and a test
// can check them under `react-dom/server`, which has no layout to measure. Measuring the DOM would
// have needed a second render per screen and could still disagree with what the script assumed.
//
// Only the elements the pointer acts on are listed. Each is drawn by walkthrough-screens.tsx as an
// absolutely positioned element with `data-walkthrough-target="<name>"` at exactly this box.

/** The stage is authored at this fixed logical size and scaled to its container. */
export const STAGE_WIDTH = 800;
export const STAGE_HEIGHT = 500;

export type Point = Readonly<{ x: number; y: number }>;
export type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

const CLAUDE_SIDEBAR = {
  "new-chat": boxOf({ x: 10, y: 76, width: 150, height: 30 }),
  customize: boxOf({ x: 10, y: 172, width: 150, height: 30 }),
} as const;

const CHATGPT_SIDEBAR = {
  "new-chat": boxOf({ x: 10, y: 74, width: 160, height: 30 }),
  plugins: boxOf({ x: 10, y: 142, width: 160, height: 30 }),
} as const;

/** Every mock screen and the targets on it. A screen id is a key of this table. */
export const SCREEN_LAYOUT = {
  "claude-home": {
    ...CLAUDE_SIDEBAR,
    composer: boxOf({ x: 255, y: 232, width: 460, height: 92 }),
  },
  "claude-customize": {
    ...CLAUDE_SIDEBAR,
    "connectors-tab": boxOf({ x: 270, y: 92, width: 100, height: 30 }),
  },
  "claude-connectors": {
    ...CLAUDE_SIDEBAR,
    add: boxOf({ x: 698, y: 48, width: 80, height: 32 }),
  },
  "claude-connectors-menu": {
    ...CLAUDE_SIDEBAR,
    "add-custom": boxOf({ x: 566, y: 124, width: 208, height: 32 }),
  },
  "claude-add-dialog": {
    ...CLAUDE_SIDEBAR,
    "name-field": boxOf({ x: 244, y: 168, width: 392, height: 36 }),
    "url-field": boxOf({ x: 244, y: 240, width: 392, height: 36 }),
    continue: boxOf({ x: 546, y: 370, width: 90, height: 34 }),
  },
  "claude-dialog-options": {
    ...CLAUDE_SIDEBAR,
    add: boxOf({ x: 566, y: 370, width: 70, height: 34 }),
  },
  "claude-connector-detail": {
    ...CLAUDE_SIDEBAR,
    connect: boxOf({ x: 676, y: 150, width: 100, height: 32 }),
  },
  "claude-connected": {
    ...CLAUDE_SIDEBAR,
  },
  "claude-permission": {
    ...CLAUDE_SIDEBAR,
    "allow-once": boxOf({ x: 520, y: 296, width: 100, height: 32 }),
  },
  "claude-answer": {
    ...CLAUDE_SIDEBAR,
  },
  "chatgpt-home": {
    ...CHATGPT_SIDEBAR,
    composer: boxOf({ x: 260, y: 220, width: 460, height: 54 }),
    "mention-sasha": boxOf({ x: 270, y: 290, width: 280, height: 36 }),
  },
  "chatgpt-plugins": {
    ...CHATGPT_SIDEBAR,
    add: boxOf({ x: 708, y: 76, width: 72, height: 32 }),
  },
  "chatgpt-plugins-menu": {
    ...CHATGPT_SIDEBAR,
    "add-custom": boxOf({ x: 590, y: 122, width: 186, height: 32 }),
  },
  "chatgpt-mcp-form": {
    ...CHATGPT_SIDEBAR,
    "name-field": boxOf({ x: 234, y: 104, width: 432, height: 32 }),
    "description-field": boxOf({ x: 234, y: 162, width: 432, height: 32 }),
    "url-field": boxOf({ x: 234, y: 252, width: 432, height: 32 }),
    understand: boxOf({ x: 244, y: 398, width: 260, height: 24 }),
    create: boxOf({ x: 526, y: 442, width: 140, height: 34 }),
  },
  "chatgpt-connect": {
    ...CHATGPT_SIDEBAR,
    continue: boxOf({ x: 274, y: 318, width: 352, height: 38 }),
  },
  "chatgpt-installed": {
    ...CHATGPT_SIDEBAR,
  },
  "chatgpt-mention": {
    ...CHATGPT_SIDEBAR,
    "composer-text": boxOf({ x: 394, y: 226, width: 280, height: 60 }),
  },
  "chatgpt-answer": {
    ...CHATGPT_SIDEBAR,
  },
  "google-choose-account": {
    account: boxOf({ x: 420, y: 150, width: 300, height: 58 }),
  },
  "google-unverified": {
    continue: boxOf({ x: 120, y: 396, width: 100, height: 36 }),
  },
  "google-sign-in": {
    continue: boxOf({ x: 610, y: 404, width: 100, height: 36 }),
  },
  "google-additional-access": {
    "scroll-down": boxOf({ x: 664, y: 336, width: 40, height: 40 }),
    continue: boxOf({ x: 610, y: 404, width: 100, height: 36 }),
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, Box>>>>;

export type ScreenId = keyof typeof SCREEN_LAYOUT;

/**
 * The targets a screen has. For a UNION of screens this is the targets they all share (`keyof` of a
 * union is the common keys), which is what lets one sidebar component serve every Claude screen.
 */
export type TargetName<TScreen extends ScreenId> = keyof (typeof SCREEN_LAYOUT)[TScreen] & string;

/** The regions that scroll, how far each one goes, and the screen it belongs to. */
export const SCROLL_REGIONS = {
  "claude-options": { screen: "claude-dialog-options", maximumOffset: 170 },
  "google-access": { screen: "google-additional-access", maximumOffset: 210 },
} as const satisfies Readonly<Record<string, Readonly<{ screen: ScreenId; maximumOffset: number }>>>;

export type ScrollRegion = keyof typeof SCROLL_REGIONS;

/** One target's box. Throws for a name the screen does not have, which the types already rule out. */
export function targetBox(screen: ScreenId, target: string): Box {
  const box = LAYOUT_BY_NAME[screen][target];
  if (box === undefined) throw new Error(`walkthrough: screen ${screen} has no target ${target}`);
  return box;
}

/** Where the pointer's tip goes to act on a target: the middle of its box. */
export function targetPoint(screen: ScreenId, target: string): Point {
  const box = targetBox(screen, target);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** The same table, widened so a target can be looked up by a plain string. */
const LAYOUT_BY_NAME: Readonly<Record<ScreenId, Readonly<Record<string, Box>>>> = SCREEN_LAYOUT;

function boxOf(box: Box): Box {
  return box;
}
