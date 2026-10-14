// THE SETUP WALKTHROUGH AS DATA: a script of steps becomes a timeline, and a timeline answers
// "what is on screen at this millisecond?".
//
// Two pure functions do all the timing so the player only has to draw: `timelineOf` turns a script
// (caption, mock screen, and the pointer actions on it) into timed events, and `frameAt` reads one
// moment back out of them. The player keeps nothing but the elapsed time, which is what makes
// pausing, seeking and the screenshot hook exact: any moment can be drawn without having played up
// to it. Nothing here touches the DOM, so the tests check the timing rules directly.
//
// The pacing is the point. The recordings this replaces ran 284 s and 234 s, most of it pages
// loading. Here a step lasts as long as its pointer work, but never less than the time it takes to
// read its caption.

import {
  SCROLL_REGIONS,
  STAGE_HEIGHT,
  targetBox,
  targetPoint,
  type Point,
  type ScreenId,
  type ScrollRegion,
  type TargetName,
} from "./walkthrough-layout.ts";
import { assertNever } from "./protocol.ts";

/** One thing the pointer (or the page) does on the step's screen. */
export type WalkthroughAction<TScreen extends ScreenId> =
  | Readonly<{ kind: "move"; target: TargetName<TScreen> }>
  | Readonly<{ kind: "click"; target: TargetName<TScreen> }>
  | Readonly<{ kind: "type"; target: TargetName<TScreen>; text: string }>
  | Readonly<{ kind: "scroll"; region: ScrollRegion; to: number }>
  | Readonly<{ kind: "wait"; durationMs: number }>;

/** One captioned step: the screen it shows and what happens on it. */
export type WalkthroughStep = {
  [TScreen in ScreenId]: Readonly<{
    /** The step's number in the written steps ("3", "10a"), or "Start". */
    label: string;
    caption: string;
    screen: TScreen;
    actions: readonly WalkthroughAction<TScreen>[];
  }>;
}[ScreenId];

export type WalkthroughScript = readonly WalkthroughStep[];

export type TimedStep = Readonly<{
  index: number;
  label: string;
  caption: string;
  screen: ScreenId;
  startMs: number;
  endMs: number;
}>;

export type TimelineEvent =
  | Readonly<{ kind: "move"; startMs: number; endMs: number; from: Point; to: Point; screen: ScreenId; target: string }>
  | Readonly<{ kind: "click"; atMs: number; screen: ScreenId; target: string; point: Point }>
  | Readonly<{ kind: "type"; startMs: number; endMs: number; screen: ScreenId; target: string; text: string }>
  | Readonly<{ kind: "scroll"; startMs: number; endMs: number; region: ScrollRegion; from: number; to: number }>;

export type Timeline = Readonly<{
  steps: readonly TimedStep[];
  /** In time order. */
  events: readonly TimelineEvent[];
  totalMs: number;
}>;

export type PointerState = Readonly<{
  from: Point;
  to: Point;
  /** 0 to 1 along the current move, already eased. 1 when the pointer is at rest. */
  progress: number;
  at: Point;
}>;

export type Ripple = Readonly<{ point: Point; ageMs: number; progress: number }>;

export type ScreenTarget = Readonly<{ screen: ScreenId; target: string }>;

/** Everything needed to draw one moment. */
export type WalkthroughFrame = Readonly<{
  timeMs: number;
  stepIndex: number;
  stepCount: number;
  label: string;
  caption: string;
  screen: ScreenId;
  pointer: PointerState;
  /** The expanding ring of the latest click, while it is still visible. */
  ripple: Ripple | null;
  /** The target drawn pressed, briefly after it is clicked. */
  pressed: ScreenTarget | null;
  /** Every target clicked so far, oldest first: checkboxes and enabled buttons follow from it. */
  clicked: readonly ScreenTarget[];
  /** The field with the caret: the last target clicked on the current screen. */
  focused: string | null;
  /** The text typed so far into each field, by target name. */
  typed: Readonly<Record<string, string>>;
  scroll: Readonly<Record<ScrollRegion, number>>;
}>;

/** How long a click's ring stays visible and its button stays pressed. */
export const RIPPLE_MS = 650;
export const PRESS_MS = 240;
/** The shortest a step may last: the caption must stay up long enough to read. */
export const MINIMUM_STEP_MS = 2800;
/** Where the pointer starts, before its first move. */
export const POINTER_START: Point = { x: 520, y: 380 };

/** The timed events of a script, and its total length. */
export function timelineOf(script: WalkthroughScript): Timeline {
  const steps: TimedStep[] = [];
  const events: TimelineEvent[] = [];
  let pointer: Point = POINTER_START;
  const offsets = new Map<ScrollRegion, number>();
  let clock = 0;
  for (const [index, step] of script.entries()) {
    const startMs = clock;
    let cursor = startMs + LEAD_IN_MS;
    const moveTo = (target: string): void => moveToPoint({ target, to: targetPoint(step.screen, target) });
    const moveToPoint = ({ target, to }: Readonly<{ target: string; to: Point }>): void => {
      if (to.x === pointer.x && to.y === pointer.y) return;
      const endMs = cursor + moveDurationOf({ from: pointer, to });
      events.push({ kind: "move", startMs: cursor, endMs, from: pointer, to, screen: step.screen, target });
      pointer = to;
      cursor = endMs;
    };
    for (const action of step.actions) {
      switch (action.kind) {
        case "move":
          moveTo(action.target);
          cursor += AFTER_MOVE_MS;
          break;
        case "click":
          moveTo(action.target);
          cursor += SETTLE_BEFORE_CLICK_MS;
          events.push({ kind: "click", atMs: cursor, screen: step.screen, target: action.target, point: pointer });
          cursor += AFTER_CLICK_MS;
          break;
        case "type": {
          // A hand moves the mouse off a field before typing, and so does this pointer: parked on
          // the field it would hide the very text the step is about.
          moveToPoint({ target: action.target, to: asidePointOf({ screen: step.screen, target: action.target, pointer }) });
          const durationMs = Math.min(TYPE_MAXIMUM_MS, action.text.length * TYPE_MS_PER_CHARACTER);
          events.push({
            kind: "type",
            startMs: cursor,
            endMs: cursor + durationMs,
            screen: step.screen,
            target: action.target,
            text: action.text,
          });
          cursor += durationMs + AFTER_TYPE_MS;
          break;
        }
        case "scroll": {
          const from = offsets.get(action.region) ?? 0;
          events.push({ kind: "scroll", startMs: cursor, endMs: cursor + SCROLL_MS, region: action.region, from, to: action.to });
          offsets.set(action.region, action.to);
          cursor += SCROLL_MS + AFTER_SCROLL_MS;
          break;
        }
        case "wait":
          cursor += action.durationMs;
          break;
        default:
          assertNever(action);
      }
    }
    const endMs = Math.max(cursor + TAIL_MS, startMs + readingTimeOf(step.caption));
    steps.push({ index, label: step.label, caption: step.caption, screen: step.screen, startMs, endMs });
    clock = endMs;
  }
  return { steps, events, totalMs: clock };
}

/** The moment `timeMs` into the timeline, clamped to its ends. */
export function frameAt(timeline: Timeline, timeMs: number): WalkthroughFrame {
  const time = Math.min(Math.max(timeMs, 0), timeline.totalMs);
  const step = stepAt(timeline, time);
  let pointer: PointerState = { from: POINTER_START, to: POINTER_START, progress: 1, at: POINTER_START };
  let ripple: Ripple | null = null;
  let pressed: ScreenTarget | null = null;
  let focused: string | null = null;
  const clicked: ScreenTarget[] = [];
  const typed: Record<string, string> = {};
  const scroll: Record<ScrollRegion, number> = { "claude-options": 0, "google-access": 0 };
  for (const event of timeline.events) {
    switch (event.kind) {
      case "move": {
        if (event.startMs > time) continue;
        const progress = easeInOutCubic(fractionOf({ time, startMs: event.startMs, endMs: event.endMs }));
        pointer = { from: event.from, to: event.to, progress, at: interpolatePoint({ from: event.from, to: event.to, progress }) };
        break;
      }
      case "click": {
        if (event.atMs > time) continue;
        clicked.push({ screen: event.screen, target: event.target });
        if (event.screen === step.screen) focused = event.target;
        const ageMs = time - event.atMs;
        ripple = ageMs < RIPPLE_MS ? { point: event.point, ageMs, progress: ageMs / RIPPLE_MS } : null;
        pressed = ageMs < PRESS_MS ? { screen: event.screen, target: event.target } : null;
        break;
      }
      case "type": {
        if (event.startMs > time) continue;
        const shown = Math.floor(fractionOf({ time, startMs: event.startMs, endMs: event.endMs }) * event.text.length);
        typed[event.target] = event.text.slice(0, shown);
        break;
      }
      case "scroll": {
        if (event.startMs > time) continue;
        const progress = easeInOutQuad(fractionOf({ time, startMs: event.startMs, endMs: event.endMs }));
        scroll[event.region] = Math.round(event.from + (event.to - event.from) * progress);
        break;
      }
      default:
        assertNever(event);
    }
  }
  return {
    timeMs: time,
    stepIndex: step.index,
    stepCount: timeline.steps.length,
    label: step.label,
    caption: step.caption,
    screen: step.screen,
    pointer,
    ripple,
    pressed,
    clicked,
    focused,
    typed,
    scroll,
  };
}

/** Whether `target` on `screen` has been clicked by this moment. */
export function wasClicked(frame: WalkthroughFrame, screen: ScreenId, target: string): boolean {
  return frame.clicked.some((click) => click.screen === screen && click.target === target);
}

/** Whether a region has been scrolled all the way down. */
export function scrolledToEnd(frame: WalkthroughFrame, region: ScrollRegion): boolean {
  return frame.scroll[region] >= SCROLL_REGIONS[region].maximumOffset;
}

/** How long a caption needs on screen to be read, at a relaxed pace. */
export function readingTimeOf(caption: string): number {
  return Math.min(Math.max(READING_BASE_MS + caption.length * READING_MS_PER_CHARACTER, MINIMUM_STEP_MS), READING_MAXIMUM_MS);
}

/** Slow out of the start, fast through the middle, slow into the target: how a hand moves a mouse. */
export function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

const LEAD_IN_MS = 450;
const AFTER_MOVE_MS = 250;
const SETTLE_BEFORE_CLICK_MS = 160;
const AFTER_CLICK_MS = 520;
const TYPE_MS_PER_CHARACTER = 45;
const TYPE_MAXIMUM_MS = 2200;
const AFTER_TYPE_MS = 450;
const SCROLL_MS = 1100;
const AFTER_SCROLL_MS = 350;
const TAIL_MS = 500;
const READING_BASE_MS = 800;
const READING_MS_PER_CHARACTER = 36;
const READING_MAXIMUM_MS = 6500;

function moveDurationOf({ from, to }: Readonly<{ from: Point; to: Point }>): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.round(Math.min(380 + distance * 0.9, 1000));
}

/** Just below a field and to the right of where its text starts, when the pointer is on the field. */
function asidePointOf({ screen, target, pointer }: Readonly<{ screen: ScreenId; target: string; pointer: Point }>): Point {
  const box = targetBox(screen, target);
  const onField = pointer.x >= box.x && pointer.x <= box.x + box.width && pointer.y >= box.y && pointer.y <= box.y + box.height;
  if (!onField) return pointer;
  return { x: Math.round(box.x + box.width * 0.78), y: Math.min(box.y + box.height + 24, STAGE_HEIGHT - 24) };
}

function stepAt(timeline: Timeline, time: number): TimedStep {
  let found = timeline.steps[0];
  for (const step of timeline.steps) {
    if (step.startMs > time) break;
    found = step;
  }
  if (found === undefined) throw new Error("walkthrough: a timeline needs at least one step");
  return found;
}

function fractionOf({ time, startMs, endMs }: Readonly<{ time: number; startMs: number; endMs: number }>): number {
  if (endMs <= startMs) return 1;
  return Math.min(Math.max((time - startMs) / (endMs - startMs), 0), 1);
}

function interpolatePoint({ from, to, progress }: Readonly<{ from: Point; to: Point; progress: number }>): Point {
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
}

function easeInOutQuad(progress: number): number {
  return progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
}
