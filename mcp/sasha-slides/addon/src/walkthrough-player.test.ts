// THE PLAYER: its clock as a pure reducer, and its first frame as markup (what a viewer who prefers
// reduced motion sees until they press play).

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WalkthroughPlayer, initialPlayerState, reducePlayer, type PlayerState } from "./walkthrough-player.tsx";

const HOSTED = "https://sasha.example.com/mcp";

test("the first frame is the start screen under a play button, with the first caption below it", () => {
  const markup = renderToStaticMarkup(createElement(WalkthroughPlayer, { flow: "claude-ai", connectorUrl: HOSTED }));
  assert.match(markup, /aria-label="Play the walkthrough"/);
  assert.match(markup, /claude\.ai home page \(claude\.ai\/new\), already signed in/);
  assert.match(markup, /role="progressbar"/);
  assert.match(markup, /aria-label="Restart"/);
  assert.match(markup, /aria-label="Full screen"/, "the sidebar player can go full screen");
  assert.ok(markup.indexOf("sasha-wt-stage") < markup.indexOf("sasha-wt-caption"), "the caption sits outside, below the stage");
  assert.doesNotMatch(markup, /<video|<img/);
});

test("play, pause, the end of the timeline, replay and seek", () => {
  const ready = initialPlayerState(10_000);
  assert.equal(ready.status, "ready");
  assert.equal(reducePlayer(ready, { kind: "tick", deltaMs: 500 }).elapsedMs, 0, "the clock only runs while playing");
  const playing = reducePlayer(ready, { kind: "play" });
  const later = reducePlayer(playing, { kind: "tick", deltaMs: 2500 });
  assert.deepEqual(later, { status: "playing", elapsedMs: 2500, totalMs: 10_000 });
  assert.equal(reducePlayer(later, { kind: "pause" }).status, "paused");
  const ended: PlayerState = reducePlayer(later, { kind: "tick", deltaMs: 60_000 });
  assert.deepEqual(ended, { status: "ended", elapsedMs: 10_000, totalMs: 10_000 });
  assert.deepEqual(reducePlayer(ended, { kind: "play" }), { status: "playing", elapsedMs: 0, totalMs: 10_000 }, "play after the end replays");
  assert.deepEqual(reducePlayer(later, { kind: "restart" }), { status: "playing", elapsedMs: 0, totalMs: 10_000 });
  assert.deepEqual(reducePlayer(ready, { kind: "seek", timeMs: 4000 }), { status: "paused", elapsedMs: 4000, totalMs: 10_000 });
  assert.equal(reducePlayer(later, { kind: "seek", timeMs: 99_000 }).elapsedMs, 10_000, "seeking is clamped");
  assert.equal(reducePlayer(later, { kind: "seek", timeMs: 100 }).status, "playing", "seeking while playing keeps playing");
});
