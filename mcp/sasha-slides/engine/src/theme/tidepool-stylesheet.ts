// THE SHARED CHROME STYLESHEET: the Tidepool classes every engine surface is built from -- the calm
// ground, the lively ground, glass panels, cards and popovers, dialogs on a scrim, ink pills, pill
// tabs, fields, notices, focus rings, disabled states. The view (editor chrome) and the presenter
// (controls, end screen, speaker view) both use it, so it lives here, built before either module,
// instead of in one of them.
//
// Decisions:
//
//  * ONLY CUSTOM PROPERTIES INSIDE THE RULES. Every colour, size, radius, layer and duration below is
//    `var(--sasha-...)` from tidepool-theme.ts; the only literal values are layout keywords. The
//    test rejects a colour literal in the rules.
//  * ONE STYLESHEET, BOTH SCHEMES: light on `:root`, dark under `prefers-color-scheme: dark` unless
//    the page forces light, and on `[data-theme="dark"]` when the page forces dark.
//  * CLASS NAMES ARE CONSTANTS (`TIDEPOOL_CLASS`), so a component never spells a class string and a
//    rename is a compile error, not a silently unstyled button.
//  * THE PANELS' BACKDROP BLUR IS GATED ON THE GESTURE (tidepool-theme.ts header): it is declared
//    only under `.sasha-engine:not([data-gesture="active"])`, so the moment a drag starts the blur
//    is gone and a pointer move never re-blurs the wash; the wash changes in discrete steps and
//    pauses while `data-gesture="active"` is on the engine root.
//  * THE CONTROL RESET HAS ZERO SPECIFICITY. Buttons and fields inherit the chrome font and colour
//    through `:where(...)`, so any class rule wins over the reset. Written as
//    `.sasha-engine button` it outranked `.sasha-pill-primary` and the ink pills' text vanished
//    (dark on dark), and `.sasha-code` lost its monospace font.
//  * THE CALM WASH IS DRAWN IN ITS OWN ELEMENT'S BOX (`position: absolute` on a positioned ground,
//    which the engine root is), not the viewport, so two editors on one page each keep their own
//    wash instead of the last one covering the rest.
//  * POPOVERS RENDER OUTSIDE THE PANELS. Panels carry a z-index, so each is its own stacking context:
//    a menu drawn inside the top bar can never rise above the toolbar below it, whatever its own
//    z-index. Render menus, popovers and context menus into a floating layer at the engine root
//    (the view's portal) so `--sasha-layer-popover` compares against the panels themselves.
//  * THE SLIDE ROOT RESETS INHERITANCE (`all: initial`), so nothing of the chrome -- font, colour,
//    line height -- leaks into slide content; the renderer sets every slide style inline.

import { SLIDE_ROOT_CLASS } from "../contracts/render.ts";
import { customPropertyDeclarations, tidepoolCustomProperties, type TidepoolTokens } from "./tidepool-theme.ts";

export const TIDEPOOL_CLASS = {
  /** The editor's (or presenter's) root element. */
  root: "sasha-engine",
  /** The editing screen's ground: pearl plus the calm wash, drawn in this element's box (it must be positioned). */
  calmGround: "sasha-calm-ground",
  /** Home and empty screens: the drifting shapes (render `LivelyShapes` inside). */
  livelyGround: "sasha-lively-ground",
  /** Fixed chrome: top bar, toolbar, filmstrip, properties panel, speaker notes, comment rail. */
  panel: "sasha-panel",
  /** A grouped block inside a panel; a comment thread; a presenter control bar. */
  card: "sasha-card",
  /** Glass over the lively shapes, with blur (home screens only). */
  livelyCard: "sasha-lively-card",
  /** Anything that can overlap the slide: menus, context menu, inline text toolbar, colour picker. Render it outside the panels (see the header). */
  popover: "sasha-popover",
  scrim: "sasha-scrim",
  dialog: "sasha-dialog",
  primaryPill: "sasha-pill-primary",
  secondaryPill: "sasha-pill-secondary",
  dangerPill: "sasha-pill-danger",
  iconButton: "sasha-icon-button",
  /** A row of pill tabs; the active tab carries `aria-selected="true"`. */
  tabs: "sasha-tabs",
  tab: "sasha-tab",
  field: "sasha-field",
  menuItem: "sasha-menu-item",
  muted: "sasha-muted",
  subtle: "sasha-subtle",
  /** A notice; its tone is `data-tone="information" | "warning" | "error"`. */
  notice: "sasha-notice",
  code: "sasha-code",
} as const;

/** The whole stylesheet: font import, custom properties for both schemes, then the rules. Pass `TIDEPOOL_TOKENS`. */
export function tidepoolStylesheet(tokens: TidepoolTokens): string {
  return `@import url("${tokens.typography.fontStylesheetAddress}");\n${tidepoolCustomPropertyBlocks(tokens)}\n${tidepoolRules(tokens)}`;
}

/** The custom property blocks for the light and dark schemes. */
export function tidepoolCustomPropertyBlocks(tokens: TidepoolTokens): string {
  const light = customPropertyDeclarations(tidepoolCustomProperties({ tokens, scheme: "light" }));
  const dark = customPropertyDeclarations(tidepoolCustomProperties({ tokens, scheme: "dark" }));
  return [
    `:root { ${light} }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }`,
    `:root[data-theme="dark"] { ${dark} }`,
  ].join("\n");
}

/** The rules: they read custom properties only (see the header). */
export function tidepoolRules(tokens: TidepoolTokens): string {
  const motion = tokens.motion;
  const classes = TIDEPOOL_CLASS;
  return `
html, body { background: var(--sasha-ground); }
.${classes.root} { position: relative; isolation: isolate; color: var(--sasha-text); font-family: var(--sasha-font-family); font-size: var(--sasha-font-size-body); line-height: var(--sasha-line-height); }
/* Zero specificity (:where), so every class below -- a pill's text colour, a tab's size, the code font -- beats the reset. */
:where(.${classes.root}) :where(button, input, select, textarea) { font: inherit; color: inherit; }
.${classes.root} .${SLIDE_ROOT_CLASS} { all: initial; }

.${classes.calmGround}::before {
  content: ""; position: absolute; inset: 0; z-index: var(--sasha-layer-wash); pointer-events: none;
  background:
    radial-gradient(60% 70% at 10% 15%, var(--sasha-wash-colours-1) 0%, transparent 70%),
    radial-gradient(55% 65% at 92% 30%, var(--sasha-wash-colours-2) 0%, transparent 70%),
    radial-gradient(70% 60% at 50% 100%, var(--sasha-wash-colours-3) 0%, transparent 70%),
    var(--sasha-ground);
}
@media (prefers-reduced-motion: no-preference) {
  .${classes.calmGround}::before { animation: sasha-calm-hue var(--sasha-calm-hue-duration) steps(${motion.calmHueSteps}, end) infinite alternate; }
  .${classes.root}[data-gesture="active"] .${classes.calmGround}::before, .${classes.root}[data-gesture="active"].${classes.calmGround}::before { animation-play-state: paused; }
}
@keyframes sasha-calm-hue { 0% { filter: hue-rotate(0deg) saturate(1); } 100% { filter: hue-rotate(${motion.calmHueMaximumDegrees}deg) saturate(${motion.calmSaturateMaximum}); } }

.${classes.livelyGround} { position: fixed; inset: 0; z-index: var(--sasha-layer-wash); overflow: hidden; pointer-events: none; }
.${classes.livelyGround} span { position: absolute; width: 80vw; height: 80vw; border-radius: 50%; filter: blur(26px); opacity: var(--sasha-lively-shape-opacity); }
.${classes.livelyGround} span:nth-child(1) { left: -30vw; top: -10vh; background: radial-gradient(circle at 40% 40%, var(--sasha-lively-shape-gradients-1-1), var(--sasha-lively-shape-gradients-1-2) 70%); }
.${classes.livelyGround} span:nth-child(2) { right: -35vw; top: 25vh; background: radial-gradient(circle, var(--sasha-lively-shape-gradients-2-1), var(--sasha-lively-shape-gradients-2-2) 70%); }
.${classes.livelyGround} span:nth-child(3) { left: -20vw; bottom: -25vh; background: radial-gradient(circle, var(--sasha-lively-shape-gradients-3-1), var(--sasha-lively-shape-gradients-3-2) 70%); }
.${classes.livelyGround} span:nth-child(4) { right: -25vw; top: -15vh; width: 60vw; height: 60vw; background: radial-gradient(circle, var(--sasha-lively-shape-gradients-4-1), var(--sasha-lively-shape-gradients-4-2) 70%); }
.${classes.livelyGround} span:nth-child(5) { left: 10vw; top: 55vh; width: 55vw; height: 55vw; background: radial-gradient(circle, var(--sasha-lively-shape-gradients-5-1), var(--sasha-lively-shape-gradients-5-2) 70%); }
@media (prefers-reduced-motion: no-preference) {
${livelyAnimations(tokens)}
}
@keyframes sasha-lively-drift-a { 0% { border-radius: 42% 58% 63% 37% / 41% 44% 56% 59%; transform: translate(0, 0) scale(.85); } 50% { border-radius: 61% 39% 45% 55% / 55% 61% 39% 45%; transform: translate(45vw, 30vh) scale(1.25); } 100% { border-radius: 38% 62% 56% 44% / 63% 37% 63% 37%; transform: translate(15vw, 55vh) scale(.95); } }
@keyframes sasha-lively-drift-b { 0% { border-radius: 55% 45% 38% 62% / 47% 60% 40% 53%; transform: translate(0, 0) scale(1.15); } 50% { border-radius: 40% 60% 60% 40% / 60% 40% 60% 40%; transform: translate(-50vw, -20vh) scale(.8); } 100% { border-radius: 63% 37% 45% 55% / 40% 58% 42% 60%; transform: translate(-25vw, 30vh) scale(1.2); } }
@keyframes sasha-lively-drift-c { 0% { border-radius: 48% 52% 60% 40% / 52% 40% 60% 48%; transform: translate(0, 0) scale(1); } 50% { border-radius: 60% 40% 40% 60% / 40% 60% 40% 60%; transform: translate(40vw, -35vh) scale(1.3); } 100% { border-radius: 40% 60% 55% 45% / 60% 45% 55% 40%; transform: translate(10vw, -60vh) scale(.85); } }

.${classes.panel}, .${classes.card}, .${classes.livelyCard}, .${classes.popover}, .${classes.dialog} {
  border: 1px solid var(--sasha-glass-edge);
  box-shadow: inset 0 1px 0 var(--sasha-glass-top-highlight), inset 0 -1px 0 var(--sasha-glass-bottom-shade), var(--sasha-lift-shadow);
}
.${classes.panel} { background: var(--sasha-panel-glass); border-radius: var(--sasha-radius-panel); z-index: var(--sasha-layer-chrome); }
.${classes.root}:not([data-gesture="active"]) .${classes.panel} { -webkit-backdrop-filter: var(--sasha-panel-backdrop-filter); backdrop-filter: var(--sasha-panel-backdrop-filter); }
.${classes.card} { background: var(--sasha-card-glass); border-radius: var(--sasha-radius-card); padding: var(--sasha-space-medium); }
.${classes.livelyCard} { background: var(--sasha-lively-glass); border-radius: var(--sasha-radius-panel); padding: var(--sasha-space-large); -webkit-backdrop-filter: var(--sasha-lively-backdrop-filter); backdrop-filter: var(--sasha-lively-backdrop-filter); }
.${classes.popover} { background: var(--sasha-glass-over-canvas); border-radius: var(--sasha-radius-card); padding: var(--sasha-space-extra-small); z-index: var(--sasha-layer-popover); }
.${classes.scrim} { position: fixed; inset: 0; background: var(--sasha-scrim); z-index: var(--sasha-layer-scrim); }
.${classes.dialog} { background: var(--sasha-glass-over-canvas); border-radius: var(--sasha-radius-panel); padding: var(--sasha-space-extra-large); z-index: var(--sasha-layer-dialog); }

.${classes.primaryPill}, .${classes.secondaryPill}, .${classes.dangerPill} {
  min-height: var(--sasha-control-height); padding: 0 var(--sasha-space-large); border: 0; border-radius: var(--sasha-radius-pill);
  font-weight: var(--sasha-font-weight-semibold); cursor: pointer;
}
.${classes.primaryPill} { background: var(--sasha-ink-button); color: var(--sasha-ink-button-text); }
.${classes.primaryPill}:hover { background: var(--sasha-ink-button-hover); }
.${classes.secondaryPill} { background: var(--sasha-secondary-button); color: var(--sasha-text); }
.${classes.secondaryPill}:hover { background: var(--sasha-secondary-button-hover); }
.${classes.dangerPill} { background: var(--sasha-danger-button); color: var(--sasha-danger-button-text); }
.${classes.dangerPill}:hover { background: var(--sasha-danger-button-hover); }
.${classes.iconButton} { inline-size: var(--sasha-control-height); block-size: var(--sasha-control-height); display: inline-grid; place-items: center; border: 0; border-radius: var(--sasha-radius-pill); background: transparent; color: var(--sasha-text); cursor: pointer; }
.${classes.iconButton}:hover, .${classes.iconButton}[aria-pressed="true"] { background: var(--sasha-secondary-button-hover); }
.${classes.iconButton} svg { inline-size: var(--sasha-control-icon-size); block-size: var(--sasha-control-icon-size); }

.${classes.tabs} { display: flex; gap: var(--sasha-space-extra-small); flex-wrap: wrap; }
.${classes.tab} { min-height: calc(var(--sasha-control-height) - 6px); padding: 0 var(--sasha-space-medium); border: 0; border-radius: var(--sasha-radius-pill); background: var(--sasha-secondary-button); color: var(--sasha-text-subtle); font-size: var(--sasha-font-size-small); cursor: pointer; }
.${classes.tab}[aria-selected="true"] { background: var(--sasha-tab-on); color: var(--sasha-text); font-weight: var(--sasha-font-weight-bold); box-shadow: var(--sasha-tab-on-shadow); }

.${classes.field} { min-height: var(--sasha-control-height); padding: 0 var(--sasha-space-small); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); }
.${classes.field}::placeholder { color: var(--sasha-text-subtle); }
.${classes.menuItem} { display: flex; align-items: center; gap: var(--sasha-space-small); min-height: var(--sasha-control-height); padding: 0 var(--sasha-space-medium); border-radius: var(--sasha-radius-control); cursor: pointer; }
.${classes.menuItem}:hover, .${classes.menuItem}[data-active="true"] { background: var(--sasha-accent-soft); color: var(--sasha-accent); }
.${classes.muted} { color: var(--sasha-text-muted); }
.${classes.subtle} { color: var(--sasha-text-subtle); font-size: var(--sasha-font-size-caption); }
.${classes.code} { font-family: var(--sasha-code-font-family); font-size: var(--sasha-font-size-small); }
.${classes.notice} { background: var(--sasha-glass-over-canvas); border-radius: var(--sasha-radius-card); padding: var(--sasha-space-small) var(--sasha-space-medium); z-index: var(--sasha-layer-notice); }
.${classes.notice}[data-tone="warning"] { color: var(--sasha-warning); }
.${classes.notice}[data-tone="error"] { color: var(--sasha-danger); }
.${classes.root} a { color: var(--sasha-accent); }

.${classes.root} :focus-visible { outline: var(--sasha-control-focus-ring-width) solid var(--sasha-focus-ring); outline-offset: 2px; }
.${classes.root} [disabled], .${classes.root} [aria-disabled="true"] { opacity: var(--sasha-disabled-opacity); cursor: not-allowed; }
@media (prefers-reduced-motion: no-preference) {
  .${classes.primaryPill}, .${classes.secondaryPill}, .${classes.dangerPill}, .${classes.iconButton}, .${classes.tab}, .${classes.menuItem} { transition: background-color var(--sasha-chrome-transition-duration) ease, box-shadow var(--sasha-chrome-transition-duration) ease; }
}
`;
}

function livelyAnimations(tokens: TidepoolTokens): string {
  const drifts = ["a", "b", "c", "c", "a"];
  return tokens.motion.livelyDriftSeconds
    .map((seconds, index) => `  .${TIDEPOOL_CLASS.livelyGround} span:nth-child(${index + 1}) { animation: sasha-lively-drift-${drifts[index] ?? "a"} ${seconds}s ease-in-out ${-index * 3}s infinite alternate; }`)
    .join("\n");
}
