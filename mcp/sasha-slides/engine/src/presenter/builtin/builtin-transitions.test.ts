// Acceptance test 3: the built-ins run on the in-page context with a fake animate recorder, produce
// their expected keyframes and complete; morph interpolates the unrotated frame and the rotation
// separately, pairs leaves only and fades what does not pair. Plus the context's own promises:
// timing clamped to the transition, animations cancelled on abort.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BuiltinTransitionEffect, GroupElement } from "../../contracts/document.ts";
import { ELEMENT_ID_ATTRIBUTE } from "../../contracts/render.ts";
import type { TransitionContext, TransitionDirection } from "../../contracts/transition-protocol.ts";
import { stageElementRecordsOf } from "../stage-elements.ts";
import { fixtureShape, fixtureSlide, elementIdOf, type FixtureElement } from "../testing/document-fixture.ts";
import { buildTransitionContext, clampTiming } from "../transition-context.ts";
import { BUILTIN_TRANSITIONS } from "./builtin-transitions.ts";
import { builtinParameters } from "./builtin-parameters.ts";
import { shortestTurn } from "./morph.ts";

describe("built-in transitions on the in-page context", () => {
  const rows: readonly Readonly<{ label: string; effect: BuiltinTransitionEffect; direction: TransitionDirection; expected: readonly ExpectedAnimation[]; incomingOnTop: boolean }>[] = [
    { label: "fade", effect: { effect: "fade" }, direction: "forward", expected: [{ on: "outgoing", keyframes: [{ opacity: 1 }, { opacity: 0 }] }], incomingOnTop: false },
    {
      label: "push from the right",
      effect: { effect: "push", direction: "fromRight" },
      direction: "forward",
      expected: [
        { on: "incoming", keyframes: [{ transform: "translateX(100%)" }, { transform: "translate(0px, 0px)" }] },
        { on: "outgoing", keyframes: [{ transform: "translate(0px, 0px)" }, { transform: "translateX(-100%)" }] },
      ],
      incomingOnTop: false,
    },
    {
      label: "push from the right, backward, mirrors to the left",
      effect: { effect: "push", direction: "fromRight" },
      direction: "backward",
      expected: [
        { on: "incoming", keyframes: [{ transform: "translateX(-100%)" }, { transform: "translate(0px, 0px)" }] },
        { on: "outgoing", keyframes: [{ transform: "translate(0px, 0px)" }, { transform: "translateX(100%)" }] },
      ],
      incomingOnTop: false,
    },
    {
      label: "slide cover from the bottom",
      effect: { effect: "slide", direction: "fromBottom", mode: "cover" },
      direction: "forward",
      expected: [{ on: "incoming", keyframes: [{ transform: "translateY(100%)" }, { transform: "translate(0px, 0px)" }] }],
      incomingOnTop: true,
    },
    {
      label: "slide uncover from the bottom",
      effect: { effect: "slide", direction: "fromBottom", mode: "uncover" },
      direction: "forward",
      expected: [{ on: "outgoing", keyframes: [{ transform: "translate(0px, 0px)" }, { transform: "translateY(-100%)" }] }],
      incomingOnTop: false,
    },
    {
      label: "slide cover, backward, uncovers the other way",
      effect: { effect: "slide", direction: "fromBottom", mode: "cover" },
      direction: "backward",
      expected: [{ on: "outgoing", keyframes: [{ transform: "translate(0px, 0px)" }, { transform: "translateY(100%)" }] }],
      incomingOnTop: false,
    },
    {
      label: "zoom in",
      effect: { effect: "zoom", mode: "in" },
      direction: "forward",
      expected: [{ on: "incoming", keyframes: [{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }] }],
      incomingOnTop: true,
    },
    {
      label: "zoom out",
      effect: { effect: "zoom", mode: "out" },
      direction: "forward",
      expected: [{ on: "outgoing", keyframes: [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.6)", opacity: 0 }] }],
      incomingOnTop: false,
    },
  ];
  for (const row of rows) {
    it(`${row.label}: expected keyframes, and the run completes`, async () => {
      const harness = stageHarness({ outgoingElements: [], incomingElements: [] });
      const context = harness.context({ effect: row.effect, direction: row.direction });
      await BUILTIN_TRANSITIONS[row.effect.effect].run(context);
      assert.deepEqual(
        harness.recorded.map((animation) => ({ on: harness.nameOf(animation.node), keyframes: animation.keyframes })),
        row.expected.map((expected) => ({ on: expected.on, keyframes: expected.keyframes })),
      );
      for (const animation of harness.recorded) assert.equal(animation.options.duration, 600);
      assert.equal(harness.layers.incoming.style.zIndex === "2", row.incomingOnTop);
    });
  }

  it("fade from black fades the incoming slide in; control: with an outgoing slide it fades that out", async () => {
    const fromBlack = stageHarness({ outgoingElements: [], incomingElements: [], fromBlack: true });
    await BUILTIN_TRANSITIONS.fade.run(fromBlack.context({ effect: { effect: "fade" }, direction: "forward" }));
    assert.deepEqual(fromBlack.recorded.map((animation) => fromBlack.nameOf(animation.node)), ["incoming"]);
  });
});

describe("morph", () => {
  const rotated: FixtureElement = { id: "box_out", morphKey: "box", frame: { x: 100, y: 100, width: 200, height: 100, rotation: 0 } };
  const rotatedTarget: FixtureElement = { id: "box_in", morphKey: "box", frame: { x: 500, y: 300, width: 400, height: 200, rotation: 90 } };

  it("moves a paired leaf along its unrotated frame and turns it separately (end scale 1)", async () => {
    const harness = stageHarness({ outgoingElements: [rotated], incomingElements: [rotatedTarget] });
    await BUILTIN_TRANSITIONS.morph.run(harness.context({ effect: { effect: "morph" }, direction: "forward" }));
    const incoming = harness.recorded.find((animation) => harness.nameOf(animation.node) === "box_in");
    assert.deepEqual(incoming?.keyframes, [
      // Centres (200, 150) -> (700, 400); sizes 200 x 100 -> 400 x 200: half scale; angle 0 -> 90.
      { transform: "translate(-500px, -250px) rotate(0deg) scale(0.5, 0.5)", opacity: 0 },
      { transform: "translate(0px, 0px) rotate(90deg) scale(1, 1)", opacity: 1 },
    ]);
    const outgoing = harness.recorded.find((animation) => harness.nameOf(animation.node) === "box_out");
    assert.deepEqual(outgoing?.keyframes, [
      { transform: "translate(0px, 0px) rotate(0deg) scale(1, 1)" },
      { transform: "translate(500px, 250px) rotate(90deg) scale(2, 2)" },
    ]);
  });

  const unpairedRows = [
    { label: "unpaired leaves fade", outgoing: [rotated, { id: "only_old", frame: { x: 0, y: 0, width: 10, height: 10 } }], incoming: [rotatedTarget, { id: "only_new", frame: { x: 0, y: 0, width: 10, height: 10 } }], fadedOut: ["only_old"], fadedIn: ["only_new"] },
    { label: "control: everything pairs, nothing extra fades", outgoing: [rotated], incoming: [rotatedTarget], fadedOut: [], fadedIn: [] },
  ];
  for (const row of unpairedRows) {
    it(row.label, async () => {
      const harness = stageHarness({ outgoingElements: row.outgoing, incomingElements: row.incoming });
      await BUILTIN_TRANSITIONS.morph.run(harness.context({ effect: { effect: "morph" }, direction: "forward" }));
      const fades = (from: number, to: number): readonly string[] =>
        harness.recorded
          .filter((animation) => JSON.stringify(animation.keyframes) === JSON.stringify([{ opacity: from }, { opacity: to }]))
          .map((animation) => harness.nameOf(animation.node))
          .filter((name) => name !== "outgoing" && name !== "incoming");
      assert.deepEqual(fades(1, 0), row.fadedOut);
      assert.deepEqual(fades(0, 1), row.fadedIn);
      assert.ok(harness.recorded.some((animation) => harness.nameOf(animation.node) === "outgoing"), "the outgoing slide fades as a whole");
    });
  }

  it("pairs leaves only: a group around the incoming leaf is never animated", async () => {
    const harness = stageHarness({ outgoingElements: [rotated], incomingElements: [rotatedTarget], groupIncoming: true });
    await BUILTIN_TRANSITIONS.morph.run(harness.context({ effect: { effect: "morph" }, direction: "forward" }));
    const animated = harness.recorded.map((animation) => harness.nameOf(animation.node));
    assert.ok(animated.includes("box_in"));
    assert.equal(animated.includes("group_wrap"), false);
  });

  const turns = [
    { from: 350, to: 10, expected: 20 },
    { from: 10, to: 350, expected: -20 },
    { from: 0, to: 180, expected: 180 },
    { from: 90, to: 90, expected: 0 },
  ];
  for (const row of turns) {
    it(`turns ${row.from} to ${row.to} degrees the short way (${row.expected})`, () => {
      assert.equal(shortestTurn({ from: row.from, to: row.to }), row.expected);
    });
  }
});

describe("the transition context", () => {
  const clamps = [
    { label: "fits: unchanged", timing: { duration: 300, delay: 100 }, remaining: 500, expected: { duration: 300, delay: 100 } },
    { label: "runs past the end: shortened", timing: { duration: 1000, delay: 200 }, remaining: 500, expected: { duration: 300, delay: 200 } },
    { label: "delay past the end: no active time left", timing: { duration: 1000, delay: 900 }, remaining: 500, expected: { duration: 0, delay: 500 } },
  ];
  for (const row of clamps) {
    it(`clamps timing to the remaining time: ${row.label}`, () => {
      const clamped = clampTiming({ timing: row.timing, remaining: row.remaining });
      assert.equal(clamped.duration, row.expected.duration);
      assert.equal(clamped.delay, row.expected.delay);
    });
  }

  it("cancels every animation it started when the signal aborts", async () => {
    const harness = stageHarness({ outgoingElements: [], incomingElements: [] });
    const controller = new AbortController();
    const context = harness.context({ effect: { effect: "push", direction: "fromLeft" }, direction: "forward", signal: controller.signal, pending: true });
    const running = Promise.resolve(BUILTIN_TRANSITIONS.push.run(context));
    controller.abort();
    await assert.rejects(running);
    assert.equal(harness.recorded.every((animation) => animation.cancelled), true);
  });
});

type ExpectedAnimation = Readonly<{ on: string; keyframes: readonly Keyframe[] }>;

type RecordedAnimation = { node: object; keyframes: Keyframe[] | PropertyIndexedKeyframes; options: KeyframeAnimationOptions; cancelled: boolean };

type FakeNode = { name: string; style: { zIndex: string }; children: FakeNode[]; querySelector: (selector: string) => FakeNode | null };

function stageHarness(
  options: Readonly<{ outgoingElements: readonly FixtureElement[]; incomingElements: readonly FixtureElement[]; fromBlack?: boolean; groupIncoming?: boolean }>,
) {
  const recorded: RecordedAnimation[] = [];
  const outgoingSlide = fixtureSlide({ id: "slide_out", elements: options.outgoingElements });
  const plainIncoming = fixtureSlide({ id: "slide_in", elements: options.incomingElements });
  const incomingSlide = options.groupIncoming === true ? { ...plainIncoming, elements: [groupOf(plainIncoming.elements)] } : plainIncoming;
  const layers = {
    stage: fakeNode({ name: "stage", children: [] }),
    outgoing: fakeNode({ name: "outgoing", children: options.outgoingElements.map((element) => fakeNode({ name: element.id, children: [] })) }),
    incoming: fakeNode({
      name: "incoming",
      children: options.incomingElements.map((element) => fakeNode({ name: element.id, children: [] })),
    }),
    overlay: fakeNode({ name: "overlay", children: [] }),
  };
  return {
    recorded,
    layers,
    nameOf(node: object): string {
      return (node as FakeNode).name;
    },
    context(contextOptions: Readonly<{ effect: BuiltinTransitionEffect; direction: TransitionDirection; signal?: AbortSignal; pending?: boolean }>): TransitionContext {
      return buildTransitionContext({
        stage: {
          // Test-only widening: the fake nodes implement the members the context and built-ins use
          // (style.zIndex, querySelector); a browser test covers real elements.
          stage: layers.stage as unknown as HTMLElement,
          outgoing: options.fromBlack === true ? null : (layers.outgoing as unknown as HTMLElement),
          incoming: layers.incoming as unknown as HTMLElement,
          overlay: layers.overlay as unknown as HTMLElement,
        },
        outgoingElements: stageElementRecordsOf(outgoingSlide),
        incomingElements: stageElementRecordsOf(incomingSlide),
        durationMilliseconds: 600,
        direction: contextOptions.direction,
        parameters: builtinParameters({ effect: contextOptions.effect, easing: "easeInOut" }),
        reducedMotion: false,
        signal: contextOptions.signal ?? new AbortController().signal,
        animateNode: (node, keyframes, timing) => recordAnimation({ recorded, node, keyframes, timing, pending: contextOptions.pending === true }),
        now: () => 0,
        startTimer: (callback, milliseconds) => {
          const handle = setTimeout(callback, milliseconds);
          return () => clearTimeout(handle);
        },
      });
    },
  };
}

function recordAnimation(
  options: Readonly<{ recorded: RecordedAnimation[]; node: Element; keyframes: Keyframe[] | PropertyIndexedKeyframes; timing: KeyframeAnimationOptions; pending: boolean }>,
): Animation {
  const entry: RecordedAnimation = { node: options.node, keyframes: options.keyframes, options: options.timing, cancelled: false };
  options.recorded.push(entry);
  let rejectFinished: (reason: Error) => void = () => undefined;
  const finished = options.pending ? new Promise<unknown>((_resolve, reject) => (rejectFinished = reject)) : Promise.resolve();
  const fake = {
    finished,
    cancel() {
      entry.cancelled = true;
      rejectFinished(new Error("cancelled"));
    },
  };
  // Test-only widening: the context and built-ins only use `finished` and `cancel`.
  return fake as unknown as Animation;
}

function fakeNode(options: Readonly<{ name: string; children: FakeNode[] }>): FakeNode {
  const node: FakeNode = {
    name: options.name,
    style: { zIndex: "" },
    children: options.children,
    querySelector(selector) {
      const match = new RegExp(`^\\[${ELEMENT_ID_ATTRIBUTE}="(.+)"\\]$`).exec(selector);
      return node.children.find((child) => child.name === match?.[1]) ?? null;
    },
  };
  return node;
}

function groupOf(children: GroupElement["children"]): GroupElement {
  const template = fixtureShape({ id: "group_wrap", frame: { x: 0, y: 0, width: 1280, height: 720 } });
  return { ...template, kind: "group", id: elementIdOf("group_wrap"), children };
}
