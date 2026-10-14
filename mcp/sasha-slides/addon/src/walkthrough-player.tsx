// THE SETUP WALKTHROUGH PLAYER: an animated, mocked click-through of connecting Sasha Slides to an
// assistant, shown above the written steps in the add-on's Setup tab and on the website.
//
// It replaces two screen recordings (284 s and 234 s, mostly pages loading, unreadable at sidebar
// width, and dated by every redesign of the sites they filmed). The animation is drawn from the
// script in walkthrough-scripts.ts, so it is short, carries the REAL connector address, and costs no
// download.
//
// WHAT IT KEEPS IN STATE IS ONLY THE CLOCK: status and elapsed milliseconds. Every pixel comes from
// `frameAt(timeline, elapsed)`, so pause, seek and the screenshot hook are exact. A
// requestAnimationFrame loop advances the clock only while playing.
//
// SCALED, NOT REFLOWED. The stage is authored at 800x500 and scaled with a CSS transform to its
// container's measured width (about 280 px in the sidebar, up to 960 px on the website). The caption
// sits OUTSIDE the scaled stage at the surrounding font size, so it stays readable at sidebar width.
// The pointer and its click ring are drawn inside the stage but enlarged when the stage is small,
// so they stay obvious at any width.
//
// NO MOTION UNLESS ASKED. With `prefers-reduced-motion: reduce` it does not start by itself: it shows
// the first frame under the play button until the viewer presses it.

import { useEffect, useMemo, useReducer, useRef, useState, type JSX, type MouseEvent } from "react";
import { STAGE_HEIGHT, STAGE_WIDTH } from "./walkthrough-layout.ts";
import { WalkthroughScreen } from "./walkthrough-screens.tsx";
import { WALKTHROUGH_CSS } from "./walkthrough-styles.ts";
import { assistantNameOf, scriptOf, type WalkthroughFlow } from "./walkthrough-scripts.ts";
import { frameAt, timelineOf, type WalkthroughFrame } from "./walkthrough-timeline.ts";
import { assertNever } from "./protocol.ts";

/** What a host may drive from outside: the website exposes `seek` for screenshots. */
export type WalkthroughControls = Readonly<{
  seek(timeMs: number): void;
  play(): void;
  pause(): void;
}>;

export function WalkthroughPlayer({
  flow,
  connectorUrl,
  onControls,
}: Readonly<{
  flow: WalkthroughFlow;
  connectorUrl: string;
  onControls?: (controls: WalkthroughControls) => void;
}>): JSX.Element {
  const timeline = useMemo(() => timelineOf(scriptOf({ flow, connectorUrl })), [flow, connectorUrl]);
  const [state, dispatch] = useReducer(reducePlayer, timeline.totalMs, initialPlayerState);
  const viewport = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number>(UNMEASURED_SCALE);

  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const measure = (): void => {
      // A box with no width yet (hidden, mid-reflow) keeps the last scale rather than collapsing to 0.
      if (element.clientWidth > 0) setScale(element.clientWidth / STAGE_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!prefersReducedMotion()) dispatch({ kind: "play" });
  }, []);

  useEffect(() => {
    if (state.status !== "playing") return;
    let previous: number | null = null;
    let handle = 0;
    const advance = (now: number): void => {
      // Capped, so a tab that was in the background resumes where it was instead of jumping ahead.
      const deltaMs = previous === null ? 0 : Math.min(now - previous, MAXIMUM_FRAME_MS);
      previous = now;
      dispatch({ kind: "tick", deltaMs });
      handle = requestAnimationFrame(advance);
    };
    handle = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(handle);
  }, [state.status]);

  useEffect(() => {
    if (onControls === undefined) return;
    onControls({
      seek: (timeMs) => dispatch({ kind: "seek", timeMs }),
      play: () => dispatch({ kind: "play" }),
      pause: () => dispatch({ kind: "pause" }),
    });
  }, [onControls]);

  const frame = frameAt(timeline, state.elapsedMs);
  const toggle = (): void => dispatch({ kind: state.status === "playing" ? "pause" : "play" });
  const seekTo = (event: MouseEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    dispatch({ kind: "seek", timeMs: ((event.clientX - box.left) / box.width) * timeline.totalMs });
  };
  const percent = timeline.totalMs === 0 ? 0 : (state.elapsedMs / timeline.totalMs) * 100;
  return (
    <figure className="sasha-wt" aria-label={`How to connect ${assistantNameOf(flow)} to Sasha Slides`}>
      <style>{WALKTHROUGH_CSS}</style>
      <div className="sasha-wt-viewport" ref={viewport} onClick={toggle}>
        <div className="sasha-wt-stage" style={{ transform: `scale(${scale})` }} aria-hidden="true">
          <WalkthroughScreen frame={frame} />
          <PointerLayer frame={frame} scale={scale} />
        </div>
        {showsBigPlay(state.status) ? (
          <button
            type="button"
            className="sasha-wt-big-play"
            aria-label={state.status === "ended" ? "Replay the walkthrough" : "Play the walkthrough"}
            onClick={(event) => {
              event.stopPropagation();
              dispatch({ kind: "play" });
            }}
          >
            {state.status === "ended" ? <ReplayIcon /> : <PlayIcon />}
          </button>
        ) : null}
      </div>
      <div className="sasha-wt-controls">
        <button
          type="button"
          className="sasha-wt-control"
          aria-label={state.status === "playing" ? "Pause" : "Play"}
          onClick={toggle}
        >
          {state.status === "playing" ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button type="button" className="sasha-wt-control" aria-label="Restart" onClick={() => dispatch({ kind: "restart" })}>
          <ReplayIcon />
        </button>
        <div
          className="sasha-wt-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.round(timeline.totalMs / 1000)}
          aria-valuenow={Math.round(state.elapsedMs / 1000)}
          onClick={seekTo}
        >
          <div className="sasha-wt-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="sasha-wt-time">
          {clockOf(state.elapsedMs)} / {clockOf(timeline.totalMs)}
        </span>
      </div>
      <figcaption className="sasha-wt-caption" aria-live="polite">
        <span className="sasha-wt-step">{frame.label === "Start" ? "Start" : `Step ${frame.label}`}</span>
        {frame.caption}
      </figcaption>
    </figure>
  );
}

export type PlayerStatus = "ready" | "playing" | "paused" | "ended";

export type PlayerState = Readonly<{ status: PlayerStatus; elapsedMs: number; totalMs: number }>;

export type PlayerEvent =
  | Readonly<{ kind: "play" }>
  | Readonly<{ kind: "pause" }>
  | Readonly<{ kind: "restart" }>
  | Readonly<{ kind: "tick"; deltaMs: number }>
  | Readonly<{ kind: "seek"; timeMs: number }>;

export function initialPlayerState(totalMs: number): PlayerState {
  return { status: "ready", elapsedMs: 0, totalMs };
}

/** The player's clock. Pure, so play, pause, seek and the end of the timeline are tested directly. */
export function reducePlayer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.kind) {
    case "play":
      if (state.status === "ended") return { ...state, status: "playing", elapsedMs: 0 };
      return { ...state, status: "playing" };
    case "pause":
      return state.status === "playing" ? { ...state, status: "paused" } : state;
    case "restart":
      return { ...state, status: "playing", elapsedMs: 0 };
    case "tick": {
      if (state.status !== "playing") return state;
      const elapsedMs = state.elapsedMs + event.deltaMs;
      if (elapsedMs >= state.totalMs) return { ...state, status: "ended", elapsedMs: state.totalMs };
      return { ...state, elapsedMs };
    }
    case "seek": {
      const elapsedMs = Math.min(Math.max(event.timeMs, 0), state.totalMs);
      return { ...state, elapsedMs, status: seekStatusOf(state.status) };
    }
    default:
      return assertNever(event);
  }
}

/** The first paint's scale, before the viewport is measured: about the sidebar's width. */
const UNMEASURED_SCALE = 0.35;
const MAXIMUM_FRAME_MS = 100;
/**
 * The pointer is drawn at this scale of the stage or larger on screen, so it is about as big as a
 * real pointer whether the stage is shown at 280 px or 960 px.
 */
const POINTER_MINIMUM_SCREEN_SCALE = 0.62;

/**
 * The big button covers the stage before the first play and after the end. A PAUSED frame stays
 * uncovered: someone pausing wants to read it, and the control bar's own button resumes.
 */
function showsBigPlay(status: PlayerStatus): boolean {
  switch (status) {
    case "ready":
    case "ended":
      return true;
    case "playing":
    case "paused":
      return false;
    default:
      return assertNever(status);
  }
}

/** Seeking keeps a playing walkthrough playing; anything else holds still on the chosen moment. */
function seekStatusOf(status: PlayerStatus): PlayerStatus {
  switch (status) {
    case "playing":
      return "playing";
    case "ready":
    case "paused":
    case "ended":
      return "paused";
    default:
      return assertNever(status);
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The highlighted pointer and the ring of its latest click, in stage coordinates. */
function PointerLayer({ frame, scale }: Readonly<{ frame: WalkthroughFrame; scale: number }>): JSX.Element {
  const enlarge = Math.max(1, POINTER_MINIMUM_SCREEN_SCALE / scale);
  const { at } = frame.pointer;
  const ripple = frame.ripple;
  return (
    <svg className="sasha-wt-overlay" viewBox={`0 0 ${STAGE_WIDTH} ${STAGE_HEIGHT}`} width={STAGE_WIDTH} height={STAGE_HEIGHT}>
      {ripple === null ? null : (
        <g opacity={1 - ripple.progress}>
          <circle
            cx={ripple.point.x}
            cy={ripple.point.y}
            r={(8 + 34 * ripple.progress) * enlarge}
            fill="rgba(255, 171, 0, 0.18)"
            stroke="#f29900"
            strokeWidth={3.5 * enlarge}
          />
        </g>
      )}
      <g transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)}) scale(${enlarge.toFixed(3)})`}>
        <circle r={20} fill="rgba(255, 214, 0, 0.42)" stroke="rgba(242, 153, 0, 0.55)" strokeWidth={1.5} />
        <path
          d="M0 0 L0 23 L6.2 17.4 L10.4 26.4 L14.2 24.6 L10.1 15.8 L18 15.8 Z"
          fill="#fff"
          stroke="#111"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

function clockOf(timeMs: number): string {
  const seconds = Math.floor(timeMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function PlayIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
      <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
      <path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z" fill="currentColor" />
    </svg>
  );
}

function ReplayIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
      <path
        d="M12 5V2L7 6.5 12 11V8a5 5 0 1 1-5 5H4.5A7.5 7.5 0 1 0 12 5z"
        fill="currentColor"
      />
    </svg>
  );
}
