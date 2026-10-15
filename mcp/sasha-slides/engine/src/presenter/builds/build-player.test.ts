// The in-page build player on a recording `TransitionContext`: the keyframes each effect produces,
// on which side, with which timing and fill; the outgoing slide hidden except the leaves it still
// needs; the individual transform properties (never `transform`, which carries a leaf's own rotation
// and flips); a leaf's own opacity as the visible value; spins that turn the full angle and follow
// their arc. Each table keeps a control row where the cause is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AnimationEffect, AnimationStep } from "../../contracts/animations.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ElementSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import { ELEMENT_ID_ATTRIBUTE, SLIDE_ROOT_CLASS } from "../../contracts/render.ts";
import { literalColour } from "../../contracts/style.ts";
import { stageElementRecordsOf } from "../stage-elements.ts";
import { animationStep, fixtureGroup, fixtureShape, fixtureSlide, type FixtureElement } from "../testing/document-fixture.ts";
import { buildTransitionContext } from "../transition-context.ts";
import { createBuildPlayer } from "./build-player.ts";
import { buildSegmentTimeline, leavesOf, slideBuildSegments } from "./build-states.ts";

const BOX: FixtureElement = { id: "box_a", frame: { x: 100, y: 100, width: 200, height: 100 } };
const STILL: FixtureElement = { id: "box_b", frame: { x: 800, y: 400, width: 100, height: 100 } };
const PLAIN = { translate: "0px 0px", rotate: "0deg", scale: "1" };

describe("the build player: one effect each", () => {
  const rows: readonly Readonly<{ label: string; effect: AnimationEffect; opacity?: number; expected: readonly Recorded[] }>[] = [
    { label: "appear: instant, to the leaf's opacity", effect: { kind: "appear" }, expected: [{ on: "incoming box_a", keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: 0 }] },
    { label: "fade in: to the leaf's OWN opacity, not 1", effect: { kind: "fadeIn" }, opacity: 0.5, expected: [{ on: "incoming box_a", keyframes: [{ opacity: 0 }, { opacity: 0.5 }], duration: 500 }] },
    {
      label: "fly in from the left: starts just beyond the left edge",
      effect: { kind: "flyIn", from: "left" },
      expected: [{ on: "incoming box_a", keyframes: [{ ...PLAIN, translate: "-300px 0px", offset: 0 }, { ...PLAIN, offset: 1 }], duration: 500 }],
    },
    {
      label: "fly in from the bottom: starts just below the page",
      effect: { kind: "flyIn", from: "bottom" },
      expected: [{ on: "incoming box_a", keyframes: [{ ...PLAIN, translate: "0px 620px", offset: 0 }, { ...PLAIN, offset: 1 }], duration: 500 }],
    },
    {
      label: "zoom in: from 0.3 with a fade",
      effect: { kind: "zoomIn" },
      expected: [
        { on: "incoming box_a", keyframes: [{ ...PLAIN, scale: "0.3", offset: 0 }, { ...PLAIN, offset: 1 }], duration: 500 },
        { on: "incoming box_a", keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: 500 },
      ],
    },
    {
      label: "float in: rises 40 units with a fade",
      effect: { kind: "floatIn" },
      expected: [
        { on: "incoming box_a", keyframes: [{ ...PLAIN, translate: "0px 40px", offset: 0 }, { ...PLAIN, offset: 1 }], duration: 500 },
        { on: "incoming box_a", keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: 500 },
      ],
    },
    {
      label: "wipe from the left: a clip opening from that edge",
      effect: { kind: "wipe", from: "left" },
      expected: [{ on: "incoming box_a", keyframes: [{ clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)" }], duration: 500 }],
    },
    {
      label: "pulse: swells and settles",
      effect: { kind: "pulse" },
      expected: [{ on: "incoming box_a", keyframes: [{ ...PLAIN, offset: 0 }, { ...PLAIN, scale: "1.08", offset: 0.5 }, { ...PLAIN, offset: 1 }], duration: 500 }],
    },
    {
      label: "grow: from the before size to the after frame it is drawn at",
      effect: { kind: "growShrink", scale: 2 },
      expected: [{ on: "incoming box_a", keyframes: [{ ...PLAIN, scale: "0.5", offset: 0 }, { ...PLAIN, offset: 1 }], duration: 500 }],
    },
    {
      label: "motion path: from the old place to the new",
      effect: { kind: "motionPath", offsetX: 50, offsetY: -20 },
      expected: [{ on: "incoming box_a", keyframes: [{ ...PLAIN, translate: "-50px 20px", offset: 0 }, { ...PLAIN, offset: 1 }], duration: 500 }],
    },
    {
      label: "colour change: the old-coloured twin fades out over the new one",
      effect: { kind: "colourChange", colour: literalColour({ hexadecimal: "#ff0000", alpha: 1 }), part: "fill" },
      expected: [{ on: "outgoing box_a", keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: 500 }],
    },
    { label: "disappear: instant, on the outgoing side", effect: { kind: "disappear" }, expected: [{ on: "outgoing box_a", keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: 0 }] },
    { label: "fade out: from the leaf's own opacity", effect: { kind: "fadeOut" }, opacity: 0.4, expected: [{ on: "outgoing box_a", keyframes: [{ opacity: 0.4 }, { opacity: 0 }], duration: 500 }] },
    {
      label: "fly out to the right: ends just beyond the right edge",
      effect: { kind: "flyOut", to: "right" },
      expected: [{ on: "outgoing box_a", keyframes: [{ ...PLAIN, offset: 0 }, { ...PLAIN, translate: "1180px 0px", offset: 1 }], duration: 500 }],
    },
    {
      label: "zoom out: to 0.3 with a fade",
      effect: { kind: "zoomOut" },
      expected: [
        { on: "outgoing box_a", keyframes: [{ ...PLAIN, offset: 0 }, { ...PLAIN, scale: "0.3", offset: 1 }], duration: 500 },
        { on: "outgoing box_a", keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: 500 },
      ],
    },
  ];
  for (const row of rows) {
    it(row.label, async () => {
      const slide = fixtureSlide({ id: "slide_a", elements: [BOX, STILL], animations: [step("step_a", "box_a", row.effect)] });
      const played = await playSegment({ slide: withOpacity({ slide, elementId: "box_a", opacity: row.opacity ?? 1 }), completed: 0 });
      assert.deepEqual(played.recorded.map((animation) => ({ on: animation.on, keyframes: animation.keyframes, duration: animation.duration })), row.expected);
      for (const animation of played.recorded) {
        assert.equal(animation.delay, 0);
        assert.equal(animation.fill, "both", "the first animation of a leaf holds its start state until its turn");
        assert.equal(animation.easing, "ease-in-out");
        for (const keyframe of animation.keyframes) assert.equal("transform" in keyframe, false, "never the leaf's own transform property");
      }
      assert.equal(played.outgoingRoot.style.visibility, "hidden", "the outgoing slide is hidden at the start");
      const outgoingVisible = row.expected.some((expected) => expected.on.startsWith("outgoing"));
      assert.equal(played.node("outgoing", "box_a")?.style.visibility === "visible", outgoingVisible, "only leaves the segment still needs are shown on the outgoing side");
      assert.equal(played.node("outgoing", "box_b")?.style.visibility ?? "", "", "control: an untouched leaf stays hidden there");
    });
  }
});

describe("the build player: timing, spin and groups", () => {
  it("a chained step starts at its own time; a leaf's later animation fills forwards only", async () => {
    const slide = fixtureSlide({
      id: "slide_a",
      elements: [BOX, STILL],
      animations: [
        step("step_a", "box_a", { kind: "motionPath", offsetX: 100, offsetY: 0 }),
        step("step_b", "box_a", { kind: "motionPath", offsetX: 0, offsetY: 100 }, { trigger: "afterPrevious", durationMilliseconds: 300, delayMilliseconds: 200 }),
      ],
    });
    const played = await playSegment({ slide, completed: 0 });
    assert.deepEqual(
      played.recorded.map((animation) => ({ delay: animation.delay, duration: animation.duration, fill: animation.fill, from: animation.keyframes[0]?.["translate"], to: animation.keyframes.at(-1)?.["translate"] })),
      [
        { delay: 0, duration: 500, fill: "both", from: "-100px -100px", to: "0px -100px" },
        { delay: 700, duration: 300, fill: "forwards", from: "0px -100px", to: "0px 0px" },
      ],
    );
  });

  const spins = [
    { label: "a full turn turns the whole way, not the short way (zero)", degrees: 360, first: "-360deg", keyframes: 25 },
    { label: "a quarter turn", degrees: 90, first: "-90deg", keyframes: 7 },
    { label: "an anticlockwise turn", degrees: -45, first: "45deg", keyframes: 4 },
  ];
  for (const row of spins) {
    it(`spin: ${row.label}`, async () => {
      const slide = fixtureSlide({ id: "slide_a", elements: [BOX], animations: [step("step_a", "box_a", { kind: "spin", degrees: row.degrees })] });
      const played = await playSegment({ slide, completed: 0 });
      const keyframes = played.recorded[0]?.keyframes ?? [];
      assert.equal(keyframes.length, row.keyframes);
      assert.equal(keyframes[0]?.["rotate"], row.first);
      assert.equal(keyframes.at(-1)?.["rotate"], "0deg");
      assert.equal(keyframes.every((keyframe) => keyframe["translate"] === "0px 0px"), true, "a leaf spins about its own centre");
    });
  }

  it("a spinning group's leaves follow the arc about the group's centre; control: a straight line would not", async () => {
    const children = [fixtureShape(BOX), fixtureShape({ id: "box_c", frame: { x: 300, y: 300, width: 100, height: 100 } })];
    const slide = fixtureSlide({ id: "slide_a", extraElements: [fixtureGroup({ id: "group_a", children })], animations: [step("step_a", "group_a", { kind: "spin", degrees: 90 })] });
    const played = await playSegment({ slide, completed: 0 });
    const corner = played.recorded.find((animation) => animation.on === "incoming box_c");
    // box_c's centre (350, 350) turns about (250, 250) to (150, 350), where it is drawn.
    assert.equal(corner?.keyframes[0]?.["translate"], "200px 0px");
    assert.equal(corner?.keyframes[3]?.["translate"], "100px 41.4214px", "half way round the arc");
    assert.equal(corner?.keyframes[3]?.["rotate"], "-45deg");
    assert.deepEqual(played.recorded.map((animation) => animation.on), ["incoming box_a", "incoming box_c"], "leaves only, never the group wrapper");
  });

  it("a group flies in as one: every leaf starts beyond the edge by the group's extent", async () => {
    const children = [fixtureShape(BOX), fixtureShape({ id: "box_c", frame: { x: 300, y: 300, width: 100, height: 100 } })];
    const slide = fixtureSlide({ id: "slide_a", extraElements: [fixtureGroup({ id: "group_a", children })], animations: [step("step_a", "group_a", { kind: "flyIn", from: "left" })] });
    const played = await playSegment({ slide, completed: 0 });
    assert.deepEqual(played.recorded.map((animation) => animation.keyframes[0]?.["translate"]), ["-400px 0px", "-400px 0px"]);
  });

  it("plays from the build position it starts at: the second segment, not the first", async () => {
    const slide = fixtureSlide({
      id: "slide_a",
      elements: [BOX, STILL],
      animations: [step("step_a", "box_a", { kind: "fadeIn" }), step("step_b", "box_b", { kind: "fadeOut" })],
    });
    const played = await playSegment({ slide, completed: 1 });
    assert.deepEqual(played.recorded.map((animation) => animation.on), ["outgoing box_b"]);
  });
});

type Recorded = Readonly<{ on: string; keyframes: readonly Readonly<Record<string, unknown>>[]; duration: number }>;

type RecordedAnimation = Readonly<{ on: string; keyframes: readonly Readonly<Record<string, string | number | null | undefined>>[]; duration: number; delay: number; fill: string; easing: string }>;

type FakeNode = { name: string; className: string; style: Record<string, string>; children: FakeNode[]; querySelector: (selector: string) => FakeNode | null };

function step(id: string, elementId: string, effect: AnimationEffect, extra: Partial<Parameters<typeof animationStep>[0]> = {}): AnimationStep {
  return animationStep({ id, elementId, effect, ...extra });
}

function withOpacity(options: Readonly<{ slide: SlideSnapshot; elementId: string; opacity: number }>): SlideSnapshot {
  const elements = options.slide.elements.map((element): ElementSnapshot => {
    if (element.id !== options.elementId) return element;
    switch (element.kind) {
      case "shape":
        return { ...element, box: { ...element.box, opacity: options.opacity } };
      case "image":
      case "line":
      case "table":
      case "group":
      case "unsupported":
        return element;
      default:
        return assertNever(element);
    }
  });
  return { ...options.slide, elements };
}

async function playSegment(options: Readonly<{ slide: SlideSnapshot; completed: number }>) {
  const segment = slideBuildSegments(options.slide)[options.completed];
  assert.ok(segment !== undefined, "the segment exists");
  const timeline = buildSegmentTimeline({ slide: options.slide, completed: options.completed, segment });
  const recorded: RecordedAnimation[] = [];
  const outgoing = layerOf({ side: "outgoing", slide: timeline.before });
  const incoming = layerOf({ side: "incoming", slide: timeline.after });
  const context = buildTransitionContext({
    stage: {
      // Test-only widening: the fake nodes implement what the context and the player use
      // (style, querySelector); a browser test covers real elements.
      stage: fakeNode({ name: "stage", className: "", children: [] }) as unknown as HTMLElement,
      outgoing: outgoing.layer as unknown as HTMLElement,
      incoming: incoming.layer as unknown as HTMLElement,
      overlay: fakeNode({ name: "overlay", className: "", children: [] }) as unknown as HTMLElement,
    },
    outgoingElements: stageElementRecordsOf(timeline.before),
    incomingElements: stageElementRecordsOf(timeline.after),
    durationMilliseconds: segment.durationMilliseconds,
    direction: "forward",
    parameters: {},
    reducedMotion: false,
    signal: new AbortController().signal,
    animateNode: (node, keyframes, timing) => {
      // Test-only widening: every node handed to the context is one of the fakes above.
      const fake = node as unknown as FakeNode;
      recorded.push({
        on: fake.name,
        // The player always passes keyframe arrays (never property-indexed keyframes).
        keyframes: keyframes as Readonly<Record<string, string | number | null | undefined>>[],
        duration: Number(timing.duration),
        delay: timing.delay ?? 0,
        fill: String(timing.fill),
        easing: String(timing.easing),
      });
      // Test-only widening: the player only awaits `finished`.
      return { finished: Promise.resolve(), cancel: () => undefined } as unknown as Animation;
    },
    now: () => 0,
    startTimer: (callback, milliseconds) => {
      const handle = setTimeout(callback, milliseconds);
      return () => clearTimeout(handle);
    },
  });
  await createBuildPlayer({ timeline, pageSize: { width: 1280, height: 720 } }).run(context);
  return {
    recorded,
    outgoingRoot: outgoing.root,
    node(side: "outgoing" | "incoming", elementId: string): FakeNode | undefined {
      const roots = { outgoing: outgoing.root, incoming: incoming.root };
      return roots[side].children.find((child) => child.name === `${side} ${elementId}`);
    },
  };
}

function layerOf(options: Readonly<{ side: "outgoing" | "incoming"; slide: SlideSnapshot }>): Readonly<{ layer: FakeNode; root: FakeNode }> {
  const leaves = options.slide.elements.flatMap(leavesOf);
  const root = fakeNode({ name: `${options.side} root`, className: SLIDE_ROOT_CLASS, children: leaves.map((leaf) => fakeNode({ name: `${options.side} ${leaf.id}`, className: "", children: [] })) });
  return { layer: fakeNode({ name: options.side, className: "", children: [root] }), root };
}

function fakeNode(options: Readonly<{ name: string; className: string; children: FakeNode[] }>): FakeNode {
  const node: FakeNode = {
    name: options.name,
    className: options.className,
    style: {},
    children: options.children,
    querySelector(selector) {
      const all = (from: FakeNode): FakeNode[] => from.children.flatMap((child) => [child, ...all(child)]);
      if (selector === `.${SLIDE_ROOT_CLASS}`) return all(node).find((child) => child.className === SLIDE_ROOT_CLASS) ?? null;
      const match = new RegExp(`^\\[${ELEMENT_ID_ATTRIBUTE}="(.+)"\\]$`).exec(selector);
      return all(node).find((child) => child.name.endsWith(` ${match?.[1] ?? ""}`)) ?? null;
    },
  };
  return node;
}
