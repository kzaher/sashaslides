// THE WALKTHROUGH'S CLOCK: how a script becomes timed events, and how one moment is read back.
// Small scripts, so each rule is checked on its own; the real flows are checked in
// walkthrough-scripts.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { targetPoint } from "./walkthrough-layout.ts";
import {
  MINIMUM_STEP_MS,
  POINTER_START,
  PRESS_MS,
  RIPPLE_MS,
  easeInOutCubic,
  frameAt,
  readingTimeOf,
  timelineOf,
  type WalkthroughScript,
} from "./walkthrough-timeline.ts";

const SCRIPT: WalkthroughScript = [
  { label: "Start", caption: "Start here.", screen: "claude-home", actions: [] },
  {
    label: "1",
    caption: "Click the box and type.",
    screen: "claude-home",
    actions: [
      { kind: "click", target: "composer" },
      { kind: "type", target: "composer", text: "hello" },
    ],
  },
  {
    label: "2",
    caption: "Scroll the dialog.",
    screen: "claude-dialog-options",
    actions: [{ kind: "scroll", region: "claude-options", to: 120 }],
  },
];

test("a step lasts at least as long as its caption takes to read, and steps follow each other without gaps", () => {
  const timeline = timelineOf(SCRIPT);
  assert.equal(timeline.steps.length, 3);
  let previousEnd = 0;
  for (const step of timeline.steps) {
    assert.equal(step.startMs, previousEnd, `${step.label} starts where the previous step ended`);
    assert.ok(step.endMs - step.startMs >= readingTimeOf(step.caption), `${step.label} is readable`);
    assert.ok(step.endMs - step.startMs >= MINIMUM_STEP_MS, `${step.label} is at least the minimum`);
    previousEnd = step.endMs;
  }
  assert.equal(timeline.totalMs, previousEnd);
});

test("reading time grows with the caption and stays within its bounds", () => {
  assert.equal(readingTimeOf(""), MINIMUM_STEP_MS);
  assert.ok(readingTimeOf("x".repeat(120)) > readingTimeOf("x".repeat(60)));
  assert.ok(readingTimeOf("x".repeat(5000)) <= 6500);
});

test("the pointer starts at rest, then eases from where it was to the middle of the clicked target", () => {
  const timeline = timelineOf(SCRIPT);
  assert.deepEqual(frameAt(timeline, 0).pointer.at, POINTER_START);
  const move = timeline.events.find((event) => event.kind === "move");
  assert.ok(move !== undefined && move.kind === "move");
  assert.deepEqual(move.from, POINTER_START);
  assert.deepEqual(move.to, targetPoint("claude-home", "composer"));
  const halfway = frameAt(timeline, (move.startMs + move.endMs) / 2).pointer;
  assert.ok(Math.abs(halfway.progress - 0.5) < 1e-9, "cubic easing passes the middle at half time");
  const early = frameAt(timeline, move.startMs + (move.endMs - move.startMs) * 0.1).pointer;
  assert.ok(early.progress < 0.1, "and starts slowly");
  assert.deepEqual(frameAt(timeline, move.endMs).pointer.at, move.to);
});

test("a click ripples, presses its target briefly, and focuses it", () => {
  const timeline = timelineOf(SCRIPT);
  const click = timeline.events.find((event) => event.kind === "click");
  assert.ok(click !== undefined && click.kind === "click");
  assert.equal(frameAt(timeline, click.atMs - 1).ripple, null, "no ring before the click");
  const at = frameAt(timeline, click.atMs);
  assert.deepEqual(at.ripple?.point, click.point);
  assert.deepEqual(at.pressed, { screen: "claude-home", target: "composer" });
  assert.equal(at.focused, "composer");
  assert.equal(frameAt(timeline, click.atMs + PRESS_MS).pressed, null, "the press is brief");
  assert.equal(frameAt(timeline, click.atMs + RIPPLE_MS).ripple, null, "and so is the ring");
});

test("typed text appears a character at a time, and scrolling eases to its offset", () => {
  const timeline = timelineOf(SCRIPT);
  const type = timeline.events.find((event) => event.kind === "type");
  assert.ok(type !== undefined && type.kind === "type");
  assert.equal(frameAt(timeline, type.startMs).typed["composer"], "");
  assert.equal(frameAt(timeline, (type.startMs + type.endMs) / 2).typed["composer"]?.length, 2);
  assert.equal(frameAt(timeline, type.endMs).typed["composer"], "hello");
  const scroll = timeline.events.find((event) => event.kind === "scroll");
  assert.ok(scroll !== undefined && scroll.kind === "scroll");
  assert.equal(frameAt(timeline, scroll.startMs).scroll["claude-options"], 0);
  assert.equal(frameAt(timeline, scroll.endMs).scroll["claude-options"], 120);
  assert.equal(frameAt(timeline, timeline.totalMs).typed["composer"], "hello", "typed text stays");
});

test("frames outside the timeline are clamped to its ends", () => {
  const timeline = timelineOf(SCRIPT);
  assert.equal(frameAt(timeline, -500).label, "Start");
  const last = frameAt(timeline, timeline.totalMs + 10_000);
  assert.equal(last.label, "2");
  assert.equal(last.timeMs, timeline.totalMs);
});

test("easing is anchored at both ends", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
});
