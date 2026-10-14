// THE TWO REAL WALKTHROUGHS: short enough, readable, faithful to the verified step texts, and
// pointing at buttons that are really on the screen at the moment they are clicked.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WalkthroughScreen } from "./walkthrough-screens.tsx";
import { RECORDING_LENGTH_MS, WALKTHROUGH_FLOWS, scriptOf, type WalkthroughFlow } from "./walkthrough-scripts.ts";
import { frameAt, timelineOf, type Timeline } from "./walkthrough-timeline.ts";

const HOSTED = "https://sasha.example.com/mcp";
const STEPS_DIRECTORY = join(import.meta.dirname, "..", "..", "docs", "connect", "recording");

function timelineFor(flow: WalkthroughFlow): Timeline {
  return timelineOf(scriptOf({ flow, connectorUrl: HOSTED }));
}

/** The verified steps file as label and caption pairs, with {URL} filled in. */
function verifiedSteps(flow: WalkthroughFlow): readonly Readonly<{ label: string; caption: string }>[] {
  const text = readFileSync(join(STEPS_DIRECTORY, `${flow}.steps.txt`), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const match = /^(START|\d+[a-z]?)[.:] (.*)$/.exec(line);
      assert.ok(match !== null, `unrecognised steps line: ${line}`);
      const label = match[1] === "START" ? "Start" : (match[1] ?? "");
      return { label, caption: (match[2] ?? "").replaceAll("{URL}", HOSTED) };
    });
}

test("each walkthrough is at least 30% shorter than the recording it replaces", () => {
  for (const flow of WALKTHROUGH_FLOWS) {
    const timeline = timelineFor(flow);
    const limit = RECORDING_LENGTH_MS[flow] * 0.7;
    assert.ok(timeline.totalMs <= limit, `${flow}: ${timeline.totalMs} ms is over ${limit} ms`);
  }
});

test("every caption stays on screen for at least 2.5 seconds", () => {
  for (const flow of WALKTHROUGH_FLOWS) {
    for (const step of timelineFor(flow).steps) {
      assert.ok(step.endMs - step.startMs >= 2500, `${flow} step ${step.label}: ${step.endMs - step.startMs} ms`);
    }
  }
});

test("captions are the verified step texts, in their order, and the URL step carries the connector address", () => {
  for (const flow of WALKTHROUGH_FLOWS) {
    const timeline = timelineFor(flow);
    const shown = timeline.steps.map((step) => ({ label: step.label, caption: step.caption }));
    assert.deepEqual(shown, verifiedSteps(flow), flow);
    assert.ok(shown.some((step) => step.caption.includes(HOSTED)), `${flow} names the connector address`);
    const typedAddress = timeline.events.some((event) => event.kind === "type" && event.text === HOSTED);
    assert.ok(typedAddress, `${flow} types the connector address into the URL field`);
  }
});

test("every target the pointer acts on is on the screen at the moment it acts", () => {
  for (const flow of WALKTHROUGH_FLOWS) {
    const timeline = timelineFor(flow);
    for (const event of timeline.events) {
      if (event.kind === "scroll") continue;
      const at = event.kind === "click" ? event.atMs : event.kind === "move" ? event.endMs : event.startMs;
      const frame = frameAt(timeline, at);
      assert.equal(frame.screen, event.screen, `${flow}: ${event.kind} ${event.target} happens on its own screen`);
      const markup = renderToStaticMarkup(createElement(WalkthroughScreen, { frame }));
      assert.ok(
        markup.includes(`data-walkthrough-target="${event.target}"`),
        `${flow}: ${event.screen} shows ${event.target} when it is ${event.kind === "click" ? "clicked" : event.kind === "type" ? "typed into" : "reached"}`,
      );
    }
  }
});

test("the pointer is on a click's target before that click's ring starts", () => {
  for (const flow of WALKTHROUGH_FLOWS) {
    const timeline = timelineFor(flow);
    for (const event of timeline.events) {
      if (event.kind !== "click") continue;
      const before = frameAt(timeline, event.atMs - 1);
      assert.deepEqual(before.pointer.at, event.point, `${flow}: at ${event.target} before clicking it`);
      assert.equal(before.pointer.progress, 1, `${flow}: and at rest`);
      const during = frameAt(timeline, event.atMs);
      assert.deepEqual(during.ripple?.point, event.point, `${flow}: the ring starts on ${event.target}`);
      assert.equal(during.ripple?.ageMs, 0);
    }
  }
});

test("every screen renders the address bar of its site", () => {
  for (const flow of WALKTHROUGH_FLOWS) {
    const timeline = timelineFor(flow);
    for (const step of timeline.steps) {
      const markup = renderToStaticMarkup(createElement(WalkthroughScreen, { frame: frameAt(timeline, step.startMs) }));
      assert.match(markup, /claude\.ai|chatgpt\.com|accounts\.google\.com/, `${flow} ${step.label}`);
    }
  }
});
