// Acceptance tests 5, 6, 7 and 9: the sandboxed lifecycle on a virtual clock with a fake runner
// site -- every deadline (counted only while visible), every fallback, the handshake checks, the
// size limits before posting, fresh asset bytes per run, and no runner at all for a show of
// built-ins. Each table keeps a control row where the cause is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { NEVER } from "rxjs";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { AssetRecord } from "../../contracts/document.ts";
import type { AssetId } from "../../contracts/ids.ts";
import type { PresenterDependencies, TransitionDiagnostic } from "../../contracts/presenter.ts";
import { TRANSITION_LIMITS, TRANSITION_PROTOCOL } from "../../contracts/transition-protocol.ts";
import { animationStep, builtinTransition, scriptIdOf, scriptedTransition, type FixtureScript, type FixtureSlide } from "../testing/document-fixture.ts";
import { fakeRenderSlideMarkup, presenterHarness, type PresenterHarness } from "../testing/presenter-harness.ts";
import type { PresenterSystemState } from "../presenter-state.ts";
import { RUNNER_CONTENT_SECURITY_POLICY } from "../runner/runner-page.ts";
import type { PrepareMessage } from "./prepare-message.ts";
import { RUNNER_FRAME_ATTRIBUTES } from "./sandbox-environment.ts";

const INK: FixtureScript = { id: "script_ink", script: "sashaTransition.define({ name: 'Ink', run() {} });", approved: true };

function scriptedDeck(durationMilliseconds = 1000): readonly FixtureSlide[] {
  return [
    { id: "slide_a" },
    { id: "slide_b", transition: scriptedTransition("script_ink", durationMilliseconds) },
    { id: "slide_c", transition: scriptedTransition("script_ink", durationMilliseconds) },
  ];
}

describe("sandboxed runner lifecycle", () => {
  it("a cooperative runner plays through: connect, prepare, start, pings, finished", async () => {
    const harness = presenterHarness({ slides: scriptedDeck(), scripts: [INK] });
    await harness.advanceBy(100);
    assert.equal(harness.state().spareRunner.kind, "ready");
    harness.press("ArrowRight");
    await harness.advanceBy(300);
    assert.equal(harness.state().run?.phase, "running");
    assert.equal(harness.site.frames[0]?.shown, true, "the frame shows only once the run started");
    await harness.advanceBy(600);
    assert.deepEqual(harness.state().screen, { kind: "slide", slideId: "slide_b", build: 0 });
    assert.deepEqual(harness.site.postedKinds().slice(0, 3), ["prepare", "start", "ping"]);
    assert.equal(harness.site.frames[0]?.disposed, true, "the used runner is removed");
    assert.equal(fallbacks(harness).length, 0);
    assert.deepEqual(harness.errors, []);
  });

  const readiness = [
    { announce: "never", expected: "runnerNotReady" },
    { announce: "normal", expected: null },
  ] as const;
  for (const row of readiness) {
    it(`runner that ${row.announce === "never" ? "never announces" : "announces (control)"}: ${row.expected ?? "no fallback"}`, async () => {
      const harness = presenterHarness({ slides: scriptedDeck(), scripts: [INK], runner: { announce: row.announce } });
      await harness.advanceBy(10);
      harness.press("ArrowRight");
      const pressedAt = harness.scheduler.now();
      await harness.advanceBy(2950);
      assert.equal(fallbacks(harness).length, 0, "nothing before 3000 milliseconds");
      await harness.advanceBy(200);
      assert.equal(fallbacks(harness)[0]?.reason ?? null, row.expected);
      // Deadlines advance by whole clock ticks (100 milliseconds), so a fallback lands within a tick of its limit.
      if (row.expected !== null) assertWithin({ value: (fallbacks(harness)[0]?.at ?? 0) - pressedAt, from: 2900, to: 3100 });
    });
  }

  const prepareTimes = [
    { fontMilliseconds: 2500, expected: "prepareTimedOut", preparePosted: false },
    { fontMilliseconds: 100, expected: null, preparePosted: true },
  ] as const;
  for (const row of prepareTimes) {
    it(`font bytes taking ${row.fontMilliseconds} milliseconds: ${row.expected ?? "prepared in time (control)"}`, async () => {
      let harnessReference: PresenterHarness | null = null;
      const slowFonts: PresenterDependencies["fontFiles"] = () =>
        new Promise((resolve) => harnessReference?.scheduler.schedule(() => resolve([]), row.fontMilliseconds));
      const harness = presenterHarness({ slides: scriptedDeck(), scripts: [INK], fontFiles: slowFonts });
      harnessReference = harness;
      await harness.advanceBy(100);
      harness.press("ArrowRight");
      const pressedAt = harness.scheduler.now();
      await harness.advanceBy(3000);
      assert.equal(fallbacks(harness)[0]?.reason ?? null, row.expected);
      if (row.expected !== null) assertWithin({ value: (fallbacks(harness)[0]?.at ?? 0) - pressedAt, from: 1900, to: 2100 });
      assert.equal(harness.site.postedKinds().includes("prepare"), row.preparePosted);
    });
  }

  const stalls = [
    { answersPings: false, expected: "stalled" },
    { answersPings: true, expected: null },
  ] as const;
  for (const row of stalls) {
    it(`a runner that ${row.answersPings ? "answers pings (control)" : "stops answering pings"}: ${row.expected ?? "still running"}`, async () => {
      const harness = presenterHarness({ slides: scriptedDeck(8000), scripts: [INK], runner: { answersPings: row.answersPings, finishAfterMilliseconds: null } });
      const firstPingAt = await startRunning(harness);
      await harness.advanceBy(2300);
      assert.equal(fallbacks(harness)[0]?.reason ?? null, row.expected);
      // Deadlines advance by whole clock ticks (100 milliseconds), so a fallback lands within a tick of its limit.
      if (row.expected !== null) assertWithin({ value: (fallbacks(harness)[0]?.at ?? 0) - firstPingAt, from: 1900, to: 2110 });
    });
  }

  it("no stall or overrun accrues while the page is hidden; it resumes counting when visible", async () => {
    const harness = presenterHarness({ slides: scriptedDeck(8000), scripts: [INK], runner: { answersPings: false, finishAfterMilliseconds: null } });
    await startRunning(harness);
    harness.visibility.next(false);
    await harness.advanceBy(10_000);
    assert.equal(fallbacks(harness).length, 0);
    assert.equal(harness.state().run?.phase, "running");
    harness.visibility.next(true);
    await harness.advanceBy(2200);
    assert.equal(fallbacks(harness)[0]?.reason, "stalled");
  });

  it("overran at the duration plus 1000 milliseconds", async () => {
    const harness = presenterHarness({ slides: scriptedDeck(1000), scripts: [INK], runner: { finishAfterMilliseconds: null } });
    await harness.advanceBy(100);
    harness.press("ArrowRight");
    const runningSince = await waitFor({ harness, condition: (state) => state.run?.phase === "running" });
    await harness.advanceBy(1850);
    assert.equal(fallbacks(harness).length, 0, JSON.stringify({ runningSince, fallbacks: fallbacks(harness) }));
    await harness.advanceBy(300);
    assert.equal(fallbacks(harness)[0]?.reason, "overran");
    assertWithin({ value: (fallbacks(harness)[0]?.at ?? 0) - runningSince, from: 1900, to: 2110 });
  });

  it("failed becomes scriptFailed with the script's message", async () => {
    const harness = presenterHarness({ slides: scriptedDeck(), scripts: [INK], runner: { failureOnStart: "ReferenceError: oops" } });
    await harness.advanceBy(100);
    harness.press("ArrowRight");
    await harness.advanceBy(300);
    assert.equal(fallbacks(harness)[0]?.reason, "scriptFailed");
    assert.match(fallbacks(harness)[0]?.message ?? "", /ReferenceError: oops/);
    assert.deepEqual(harness.state().screen, { kind: "slide", slideId: "slide_b", build: 0 });
  });

  const loads = [
    { extraLoads: 1, expected: "runnerNavigated" },
    { extraLoads: 0, expected: null },
  ] as const;
  for (const row of loads) {
    it(`${row.extraLoads === 1 ? "a second runnerLoaded" : "one load (control)"} during a run: ${row.expected ?? "no fallback"}`, async () => {
      const harness = presenterHarness({ slides: scriptedDeck(8000), scripts: [INK], runner: { finishAfterMilliseconds: null } });
      await startRunning(harness);
      const frame = harness.site.frames[0];
      assert.ok(frame !== undefined);
      for (let load = 0; load < row.extraLoads; load += 1) harness.site.reload(frame);
      await harness.advanceBy(10);
      assert.equal(fallbacks(harness)[0]?.reason ?? null, row.expected);
    });
  }

  const handshakes = [
    { label: "a runnerReady from a window that is not the frame", source: "stranger", origin: "null", counted: 1 },
    { label: "a runnerReady from the frame with a non-null origin", source: "frame", origin: "https://evil.example", counted: 1 },
    { label: "control: the frame, origin null", source: "frame", origin: "null", counted: 0 },
  ] as const;
  for (const row of handshakes) {
    it(`handshake: ${row.label} is ${row.counted === 1 ? "rejected and counted" : "accepted"}`, async () => {
      const harness = presenterHarness({ slides: scriptedDeck(), scripts: [INK], runner: { announce: "never" } });
      await harness.advanceBy(50);
      const frame = harness.site.frames[0];
      assert.ok(frame !== undefined);
      harness.site.windowMessages.next({
        source: row.source === "frame" ? frame.window : { stranger: true },
        origin: row.origin,
        data: { protocol: TRANSITION_PROTOCOL, kind: "runnerReady" },
      });
      await harness.advanceBy(10);
      assert.equal(harness.state().rejectedMessageCount, row.counted);
      assert.equal(harness.state().spareRunner.kind, row.counted === 1 ? "loading" : "ready");
    });
  }

  it("port messages that fail validation or name another run are rejected and counted", async () => {
    const harness = presenterHarness({ slides: scriptedDeck(8000), scripts: [INK], runner: { finishAfterMilliseconds: null } });
    await startRunning(harness);
    const runnerId = harness.site.frames[0]?.runnerId;
    assert.ok(runnerId !== undefined);
    const before = harness.state().rejectedMessageCount;
    harness.system.dispatch({ kind: "runnerMessage", runnerId, message: { protocol: TRANSITION_PROTOCOL, kind: "finished", runId: "rn_someoneElse" } });
    harness.system.dispatch({ kind: "runnerMessageRejected", runnerId, problem: "malformed pong" });
    assert.equal(harness.state().rejectedMessageCount, before + 2);
    assert.equal(harness.state().run?.phase, "running", "a message for another run changes nothing");
  });
});

describe("limits are checked before anything is posted", () => {
  const big = (bytes: number): string => "x".repeat(bytes + 1);
  const rows = [
    { label: "script", script: { ...INK, script: `/*${big(TRANSITION_LIMITS.maximumScriptBytes)}*/` }, markupBytes: 0, fontBytes: 0, expected: "scriptTooLarge" },
    { label: "stylesheet", script: { ...INK, stylesheet: big(TRANSITION_LIMITS.maximumStylesheetBytes) }, markupBytes: 0, fontBytes: 0, expected: "scriptTooLarge" },
    { label: "overlay markup", script: { ...INK, markup: big(TRANSITION_LIMITS.maximumOverlayMarkupBytes) }, markupBytes: 0, fontBytes: 0, expected: "scriptTooLarge" },
    { label: "slide markup", script: INK, markupBytes: TRANSITION_LIMITS.maximumSlideMarkupBytes + 1, fontBytes: 0, expected: "slideTooLarge" },
    { label: "transferred bytes", script: INK, markupBytes: 0, fontBytes: TRANSITION_LIMITS.maximumTransferredBytes + 1, expected: "transferTooLarge" },
    { label: "control: everything within its limit", script: INK, markupBytes: 1000, fontBytes: 1000, expected: null },
  ] as const;
  for (const row of rows) {
    it(`${row.label}: ${row.expected ?? "prepare is posted"}`, async () => {
      const harness = presenterHarness({
        slides: scriptedDeck(),
        scripts: [row.script],
        renderSlideMarkup: fakeRenderSlideMarkup({ markupBytes: row.markupBytes }),
        fontFiles: () => Promise.resolve([{ family: "Manrope", weight: 400, style: "normal", bytes: new ArrayBuffer(row.fontBytes) }]),
      });
      await harness.advanceBy(100);
      harness.press("ArrowRight");
      await harness.advanceBy(100);
      assert.equal(fallbacks(harness)[0]?.reason ?? null, row.expected);
      assert.equal(harness.site.postedKinds().includes("prepare"), row.expected === null);
    });
  }
});

describe("asset bytes travel as fresh copies", () => {
  const rows = [
    { label: "a store that copies (copyBytesOf as the contract says): the second run still has the bytes", copies: true, expectedPrepares: 2, expectedFallback: null },
    { label: "control: a store handing out its cached buffer cannot transfer it twice", copies: false, expectedPrepares: 1, expectedFallback: "hostPrepareFailed" },
  ] as const;
  for (const row of rows) {
    it(row.label, async () => {
      // A fixture content address (64 hexadecimal characters, like a SHA-256); the brand records the role.
      const assetId = "ab".repeat(32) as AssetId;
      const record: AssetRecord = { id: assetId, mediaType: "image/png", pixelWidth: 10, pixelHeight: 10, name: "photo", byteLength: 1000 };
      const harness = presenterHarness({
        slides: scriptedDeck(),
        scripts: [INK],
        assets: [record],
        assetStore: storeWith({ assetId, bytes: new ArrayBuffer(1000), copies: row.copies }),
        renderSlideMarkup: fakeRenderSlideMarkup({ assetIds: [assetId] }),
      });
      await harness.advanceBy(100);
      harness.press("ArrowRight");
      await harness.advanceBy(1000);
      harness.press("ArrowRight");
      await harness.advanceBy(1000);
      const prepares = harness.site.hostPosts.map((post) => post.message).filter((message): message is PrepareMessage => message.kind === "prepare");
      assert.equal(prepares.length, row.expectedPrepares);
      for (const prepare of prepares) assert.equal(prepare.assets[0]?.bytes.byteLength, 1000);
      assert.equal(fallbacks(harness)[0]?.reason ?? null, row.expectedFallback);
    });
  }
});

describe("runner frames only when the show needs them", () => {
  const rows = [
    { label: "a show whose transitions are all built-in never creates a runner frame", scripted: false, expectFrames: false },
    { label: "control: one scripted transition warms a runner", scripted: true, expectFrames: true },
  ];
  for (const row of rows) {
    it(row.label, async () => {
      const harness = presenterHarness({
        slides: [
          { id: "slide_a" },
          { id: "slide_b", transition: builtinTransition({ effect: "fade" }) },
          { id: "slide_c", transition: builtinTransition({ effect: "push", direction: "fromLeft" }) },
          { id: "slide_d", transition: row.scripted ? scriptedTransition("script_ink") : builtinTransition({ effect: "morph" }) },
        ],
        scripts: [INK],
      });
      for (let press = 0; press < 8; press += 1) {
        harness.press("ArrowRight");
        await harness.advanceBy(50);
      }
      assert.equal(harness.site.frames.length > 0, row.expectFrames);
    });
  }
});

/** Advances in 10 millisecond steps until `condition` holds; returns that time. */
async function waitFor(options: Readonly<{ harness: PresenterHarness; condition: (state: PresenterSystemState) => boolean }>): Promise<number> {
  for (let step = 0; step < 500; step += 1) {
    if (options.condition(options.harness.state())) return options.harness.scheduler.now();
    await options.harness.advanceBy(10);
  }
  throw new Error("the condition never held");
}

/** Runs until the first ping was sent; returns that time (to the 10 millisecond step). */
describe("a scripted build step in the sandbox", () => {
  const sparkle: FixtureScript = { id: "script_sparkle", script: "sashaTransition.define({ name: 'Sparkle', run() {} });", approved: true, purpose: "animation" };
  const slides: readonly FixtureSlide[] = [
    {
      id: "slide_a",
      elements: [{ id: "box_a", frame: { x: 0, y: 0, width: 100, height: 100 } }, { id: "box_b", frame: { x: 200, y: 0, width: 100, height: 100 } }],
      animations: [
        animationStep({ id: "step_a", elementId: "box_a", effect: { kind: "scripted", scriptId: scriptIdOf("script_sparkle"), category: "entrance", parameters: {} }, durationMilliseconds: 600 }),
      ],
    },
    { id: "slide_b" },
  ];

  it("plays through the runner from the slide before the step to the slide after it, then rests at build 1", async () => {
    const harness = presenterHarness({ slides, scripts: [sparkle] });
    await harness.advanceBy(100);
    assert.equal(harness.state().spareRunner.kind, "ready", "a show with a scripted step warms a runner");
    harness.press("ArrowRight");
    await harness.advanceBy(300);
    const prepare = harness.site.hostPosts.map((post) => post.message).find((message): message is PrepareMessage => message.kind === "prepare");
    assert.deepEqual(prepare?.outgoing?.elements.map((element) => element.elementId), ["box_b"], "before the entrance");
    assert.deepEqual(prepare?.incoming.elements.map((element) => element.elementId), ["box_a", "box_b"], "after it");
    assert.equal(prepare?.durationMilliseconds, 600);
    assert.deepEqual(prepare?.parameters, { targetElementId: "box_a", category: "entrance" });
    await harness.advanceBy(600);
    assert.deepEqual(harness.state().screen, { kind: "slide", slideId: "slide_a", build: 1 });
    assert.equal(fallbacks(harness).length, 0);
    harness.press("ArrowRight");
    await harness.advanceBy(10);
    assert.deepEqual(harness.state().screen, { kind: "slide", slideId: "slide_b", build: 0 }, "control: the next press leaves the slide");
  });
});

async function startRunning(harness: PresenterHarness): Promise<number> {
  await harness.advanceBy(100);
  harness.press("ArrowRight");
  for (let step = 0; step < 100; step += 1) {
    await harness.advanceBy(10);
    if ((harness.state().run?.nextPingSequence ?? 0) > 1) return harness.scheduler.now();
  }
  throw new Error("the run never sent a ping");
}

function fallbacks(harness: PresenterHarness): readonly TransitionDiagnostic[] {
  return harness.state().diagnostics.filter((diagnostic) => diagnostic.kind === "fallback");
}

function assertWithin(options: Readonly<{ value: number; from: number; to: number }>): void {
  assert.ok(options.value >= options.from && options.value <= options.to, `${options.value} is not within [${options.from}, ${options.to}]`);
}

function storeWith(options: Readonly<{ assetId: AssetId; bytes: ArrayBuffer; copies: boolean }>): AssetStore {
  return {
    put: () => Promise.reject(new Error("not used")),
    addressFor: () => null,
    available: NEVER,
    copyBytesOf: (assetId) => Promise.resolve(assetId === options.assetId ? (options.copies ? options.bytes.slice(0) : options.bytes) : null),
  };
}

describe("the runner frame's security boundary", () => {
  it("is sandboxed to scripts alone (an opaque origin), inert, without features or a referrer", () => {
    assert.equal(RUNNER_FRAME_ATTRIBUTES["sandbox"], "allow-scripts");
    assert.equal(RUNNER_FRAME_ATTRIBUTES["allow"], "");
    assert.equal(RUNNER_FRAME_ATTRIBUTES["referrerpolicy"], "no-referrer");
    assert.equal(RUNNER_FRAME_ATTRIBUTES["inert"], "");
    assert.equal(Object.values(RUNNER_FRAME_ATTRIBUTES).some((value) => value.includes("allow-same-origin")), false);
  });

  it("the runner page's policy denies every network fetch and allows no inline or evaluated script", () => {
    const directives = new Map(RUNNER_CONTENT_SECURITY_POLICY.split(";").map((directive) => {
      const [name = "", ...values] = directive.trim().split(/\s+/);
      return [name, values] as const;
    }));
    assert.deepEqual(directives.get("default-src"), ["'none'"]);
    for (const fetching of ["connect-src", "frame-src", "child-src", "worker-src", "media-src", "object-src"]) assert.equal(directives.has(fetching), false, fetching);
    assert.deepEqual(directives.get("script-src"), ["'self'", "blob:"]);
  });
});
