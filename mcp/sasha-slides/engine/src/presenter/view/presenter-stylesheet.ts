// THE PRESENTER'S OWN TIDEPOOL RULES, on top of the shared stylesheet (src/theme/): the full-screen
// stage, the runner layer, the end screen, the control bar, the speaker view and the transition
// preview box. The user asked for "the entire editor in this same style", presenter controls and
// speaker view included, so these read only `--sasha-*` custom properties, exactly like the shared
// rules, and the test enforces it.
//
// Decisions:
//
//  * CONTROLS THAT OVERLAP THE SLIDE ARE NEARLY OPAQUE GLASS. The control bar is a `.sasha-card`
//    pill bar, but it floats over an arbitrary slide (often black), where the card's 0.45 glass
//    fails text contrast; it takes `--sasha-glass-over-canvas` like every popover over the canvas.
//  * NO BACKDROP FILTER anywhere here: nothing is blurred over a slide; the end screen's card is
//    the shared `.sasha-lively-card`, which carries its own.
//  * SLIDE-SPACE COLOURS ARE NOT CHROME. The letterbox around the slide and the B and W blank
//    screens are black and white by definition (what a projector shows), not Tidepool tokens; they
//    are the three constants in `PRESENTATION_SURFACE`, applied inline, and never appear in a rule.
//  * EVERY ANIMATION AND TRANSITION is inside `prefers-reduced-motion: no-preference`; under
//    reduced motion the controls appear and disappear at once.

import { SLIDE_ROOT_CLASS } from "../../contracts/render.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { RUNNER_FRAME_CLASS, RUNNER_SHOWN_ATTRIBUTE } from "../sandbox/sandbox-environment.ts";

export const PRESENTER_CLASS = {
  presentation: "sasha-presentation",
  viewport: "sasha-presentation-viewport",
  placedSlide: "sasha-placed-slide",
  stage: "sasha-transition-stage",
  stageLayer: "sasha-transition-layer",
  runnerLayer: "sasha-runner-layer",
  blank: "sasha-blank-screen",
  endScreen: "sasha-end-screen",
  endCard: "sasha-end-card",
  controls: "sasha-presenter-controls",
  slideCounter: "sasha-slide-counter",
  speakerView: "sasha-speaker-view",
  speakerHeader: "sasha-speaker-header",
  speakerGrid: "sasha-speaker-grid",
  speakerCurrent: "sasha-speaker-current",
  speakerSide: "sasha-speaker-side",
  speakerHeading: "sasha-speaker-heading",
  speakerSlideBox: "sasha-speaker-slide-box",
  speakerNotes: "sasha-speaker-notes",
  timers: "sasha-speaker-timers",
  timer: "sasha-speaker-timer",
  preview: "sasha-transition-preview",
} as const;

/** Slide-space colours (see the header): what a projector shows around and instead of a slide. */
export const PRESENTATION_SURFACE = {
  letterbox: "#000000",
  blankBlack: "#000000",
  blankWhite: "#ffffff",
} as const;

/** The rules, built once (they depend on nothing but class names). */
export const PRESENTER_RULES: string = presenterRules();

export function presenterRules(): string {
  const classes = PRESENTER_CLASS;
  const tidepool = TIDEPOOL_CLASS;
  return `
.${classes.presentation} { position: fixed; inset: 0; z-index: var(--sasha-layer-presenter); overflow: hidden; user-select: none; }
.${classes.presentation}[data-controls-visible="false"] { cursor: none; }
.${classes.viewport} { position: absolute; inset: 0; overflow: hidden; }
.${classes.placedSlide} { position: absolute; overflow: hidden; }
.${classes.placedSlide} .${SLIDE_ROOT_CLASS} { pointer-events: none; }
.${classes.stage} { position: absolute; left: 0; top: 0; overflow: hidden; transform-origin: 0 0; }
.${classes.stageLayer} { position: absolute; left: 0; top: 0; }
.${classes.runnerLayer} { position: absolute; pointer-events: none; }
.${RUNNER_FRAME_CLASS} { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; opacity: 0; color-scheme: normal; }
.${RUNNER_FRAME_CLASS}[${RUNNER_SHOWN_ATTRIBUTE}="true"] { opacity: 1; }
.${classes.blank} { position: absolute; inset: 0; }

.${classes.endScreen} { position: absolute; inset: 0; isolation: isolate; display: grid; place-items: center; background: var(--sasha-ground); }
.${classes.endCard} { display: grid; gap: var(--sasha-space-small); justify-items: center; text-align: center; max-width: min(520px, calc(100% - 2 * var(--sasha-space-extra-large))); }
.${classes.endCard} h1 { margin: 0; font-size: var(--sasha-font-size-heading); font-weight: var(--sasha-font-weight-bold); color: var(--sasha-text); }
.${classes.endCard} p { margin: 0; }

.${classes.controls} {
  position: absolute; left: 50%; bottom: var(--sasha-space-extra-large); transform: translateX(-50%);
  display: flex; align-items: center; gap: var(--sasha-space-extra-small);
  padding: var(--sasha-space-extra-small); border-radius: var(--sasha-radius-pill);
  background: var(--sasha-glass-over-canvas); z-index: var(--sasha-layer-chrome);
}
.${classes.controls}[data-visible="false"] { opacity: 0; pointer-events: none; }
.${classes.controls} .${tidepool.secondaryPill}, .${classes.controls} .${tidepool.primaryPill} { min-height: calc(var(--sasha-control-height) - 2px); padding: 0 var(--sasha-space-medium); }
.${classes.slideCounter} { min-width: 5.5em; text-align: center; font-variant-numeric: tabular-nums; color: var(--sasha-text-muted); font-weight: var(--sasha-font-weight-semibold); }

.${classes.speakerView} { position: fixed; inset: 0; display: grid; grid-template-rows: auto 1fr auto; gap: var(--sasha-space-medium); padding: var(--sasha-space-medium); box-sizing: border-box; }
.${classes.speakerView} .${tidepool.panel} { padding: var(--sasha-space-medium); min-height: 0; }
.${classes.speakerHeader} { display: flex; align-items: center; justify-content: space-between; gap: var(--sasha-space-medium); padding: var(--sasha-space-small) var(--sasha-space-large); }
.${classes.speakerHeader} strong { font-size: var(--sasha-font-size-title); }
.${classes.timers} { display: flex; gap: var(--sasha-space-large); align-items: baseline; }
.${classes.timer} { font-variant-numeric: tabular-nums; font-size: var(--sasha-font-size-title); font-weight: var(--sasha-font-weight-bold); }
.${classes.speakerGrid} { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--sasha-space-medium); min-height: 0; }
.${classes.speakerCurrent}, .${classes.speakerSide} > * { display: grid; grid-template-rows: auto 1fr; gap: var(--sasha-space-small); min-height: 0; }
.${classes.speakerSide} { display: grid; grid-template-rows: minmax(0, 2fr) minmax(0, 3fr); gap: var(--sasha-space-medium); min-height: 0; }
.${classes.speakerHeading} { margin: 0; font-size: var(--sasha-font-size-small); font-weight: var(--sasha-font-weight-semibold); color: var(--sasha-text-subtle); text-transform: uppercase; letter-spacing: 0.06em; }
.${classes.speakerSlideBox} { position: relative; min-height: 0; border-radius: var(--sasha-radius-control); overflow: hidden; }
.${classes.speakerNotes} { overflow: auto; white-space: pre-wrap; font-size: var(--sasha-font-size-title); line-height: var(--sasha-line-height); color: var(--sasha-text); }
.${classes.speakerView} .${classes.controls} { position: static; transform: none; justify-self: center; }
@media (max-width: 760px) { .${classes.speakerGrid} { grid-template-columns: minmax(0, 1fr); } }

.${classes.preview} { position: relative; overflow: hidden; border-radius: var(--sasha-radius-control); box-shadow: var(--sasha-lift-shadow); }

@media (prefers-reduced-motion: no-preference) {
  .${classes.controls} { transition: opacity var(--sasha-chrome-transition-duration) ease; }
}
`;
}
