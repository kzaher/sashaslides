// The slide at a build position, derived from the steps' declared outcomes: visibility from each
// element's first visibility step, geometry and colour changes per effect, the same filter as
// `buildSegmentsOf`, and untouched elements kept by identity. Every table keeps a control row where
// the cause under test is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AnimationEffect, AnimationStep } from "../../contracts/animations.ts";
import type { ElementSnapshot, LineElement, ShapeElement, SlideSnapshot } from "../../contracts/document.ts";
import { literalColour } from "../../contracts/style.ts";
import { animationStep, fixtureGroup, fixtureLine, fixtureShape, fixtureSlide, scriptIdOf, type FixtureElement } from "../testing/document-fixture.ts";
import { buildSegmentTimeline, finalBuildOf, findElement, slideAtBuild, slideBuildSegments } from "./build-states.ts";

const BOX: FixtureElement = { id: "box_a", frame: { x: 100, y: 100, width: 200, height: 100 }, fill: "#112233", text: "Hello" };
const OTHER: FixtureElement = { id: "box_b", frame: { x: 600, y: 300, width: 100, height: 100 } };
const RED = literalColour({ hexadecimal: "#ff0000", alpha: 1 });

describe("slideAtBuild: visibility", () => {
  const scripted = (category: "entrance" | "emphasis" | "exit"): AnimationEffect => ({ kind: "scripted", scriptId: scriptIdOf("script_build"), category, parameters: {} });
  const rows: readonly Readonly<{ label: string; steps: readonly AnimationStep[]; visibleAt: readonly (readonly string[])[] }>[] = [
    { label: "control: no steps, everything shown", steps: [], visibleAt: [["box_a", "box_b"]] },
    { label: "an entrance first: hidden until it plays", steps: [step("step_a", "box_a", { kind: "fadeIn" })], visibleAt: [["box_b"], ["box_a", "box_b"]] },
    { label: "an exit first: shown until it plays", steps: [step("step_a", "box_a", { kind: "fadeOut" })], visibleAt: [["box_a", "box_b"], ["box_b"]] },
    {
      label: "entrance then exit",
      steps: [step("step_a", "box_a", { kind: "appear" }), step("step_b", "box_a", { kind: "disappear" })],
      visibleAt: [["box_b"], ["box_a", "box_b"], ["box_b"]],
    },
    {
      label: "an emphasis before the entrance does not decide visibility",
      steps: [step("step_a", "box_a", { kind: "pulse" }), step("step_b", "box_a", { kind: "flyIn", from: "left" })],
      visibleAt: [["box_b"], ["box_b"], ["box_a", "box_b"]],
    },
    { label: "a scripted entrance by its category", steps: [step("step_a", "box_a", scripted("entrance"))], visibleAt: [["box_b"], ["box_a", "box_b"]] },
    { label: "control: a scripted emphasis keeps it shown", steps: [step("step_a", "box_a", scripted("emphasis"))], visibleAt: [["box_a", "box_b"], ["box_a", "box_b"]] },
    { label: "a step with values this client does not understand is skipped", steps: [step("step_a", "box_a", { kind: "fadeIn" }, { unsupportedKeys: ["sparkle"] })], visibleAt: [["box_a", "box_b"]] },
    { label: "a step whose element is gone is skipped", steps: [step("step_a", "box_gone", { kind: "fadeIn" })], visibleAt: [["box_a", "box_b"]] },
  ];
  for (const row of rows) {
    it(row.label, () => {
      const slide = fixtureSlide({ id: "slide_a", elements: [BOX, OTHER], animations: row.steps });
      assert.equal(finalBuildOf(slide), row.visibleAt.length - 1);
      row.visibleAt.forEach((expected, completed) => {
        assert.deepEqual(topLevelIds(slideAtBuild({ slide, completed })), expected, `after ${completed} segments`);
      });
    });
  }

  const groupRows = [
    { label: "an exit of the group removes the group", target: "group_a", effect: { kind: "zoomOut" } as const, expectedAtEnd: [] as string[], expectedAtStart: ["group_a"], onlyChild: false },
    { label: "an entrance of its only child hides the group until it plays", target: "box_a", effect: { kind: "fadeIn" } as const, expectedAtEnd: ["group_a"], expectedAtStart: [], onlyChild: true },
    { label: "control: a pulse of the child changes nothing", target: "box_a", effect: { kind: "pulse" } as const, expectedAtEnd: ["group_a"], expectedAtStart: ["group_a"], onlyChild: true },
  ];
  for (const row of groupRows) {
    it(`groups: ${row.label}`, () => {
      const slide = groupSlide({ animations: [step("step_a", row.target, row.effect)], onlyChild: row.onlyChild });
      assert.deepEqual(topLevelIds(slideAtBuild({ slide, completed: 0 })), row.expectedAtStart);
      assert.deepEqual(topLevelIds(slideAtBuild({ slide, completed: 1 })), row.expectedAtEnd);
    });
  }

  it("chained steps are one segment, and the position counts segments, not steps", () => {
    const slide = fixtureSlide({
      id: "slide_a",
      elements: [BOX, OTHER],
      animations: [step("step_a", "box_a", { kind: "fadeIn" }), step("step_b", "box_b", { kind: "fadeIn" }, { trigger: "afterPrevious" })],
    });
    assert.equal(slideBuildSegments(slide).length, 1);
    assert.deepEqual(topLevelIds(slideAtBuild({ slide, completed: 0 })), []);
    assert.deepEqual(topLevelIds(slideAtBuild({ slide, completed: 1 })), ["box_a", "box_b"]);
  });

  it("positions past the end clamp to the fully built slide; control: negative is the start", () => {
    const slide = fixtureSlide({ id: "slide_a", elements: [BOX], animations: [step("step_a", "box_a", { kind: "fadeIn" })] });
    assert.equal(slideAtBuild({ slide, completed: 99 }), slideAtBuild({ slide, completed: 1 }));
    assert.equal(slideAtBuild({ slide, completed: -3 }), slideAtBuild({ slide, completed: 0 }));
  });
});

describe("slideAtBuild: geometry and colour", () => {
  const rows: readonly Readonly<{ label: string; effect: AnimationEffect; expected: Partial<ShapeElement["frame"]> | null }>[] = [
    { label: "grow scales the frame about its centre", effect: { kind: "growShrink", scale: 2 }, expected: { x: 0, y: 50, width: 400, height: 200, rotation: 0 } },
    { label: "shrink scales it down about its centre", effect: { kind: "growShrink", scale: 0.5 }, expected: { x: 150, y: 125, width: 100, height: 50 } },
    { label: "spin adds the degrees, normalised, centre kept", effect: { kind: "spin", degrees: 450 }, expected: { x: 100, y: 100, width: 200, height: 100, rotation: 90 } },
    { label: "a motion path translates", effect: { kind: "motionPath", offsetX: 50, offsetY: -20 }, expected: { x: 150, y: 80, width: 200, height: 100 } },
    { label: "control: a pulse changes nothing", effect: { kind: "pulse" }, expected: null },
  ];
  for (const row of rows) {
    it(row.label, () => {
      const slide = fixtureSlide({ id: "slide_a", elements: [BOX, OTHER], animations: [step("step_a", "box_a", row.effect)] });
      const built = slideAtBuild({ slide, completed: 1 });
      const box = shapeOf(built, "box_a");
      if (row.expected === null) {
        assert.equal(built, slide);
        return;
      }
      assert.deepEqual(pick(box.frame, Object.keys(row.expected)), row.expected);
      assert.equal(built.elements[1], slide.elements[1], "the untouched element keeps its identity");
    });
  }

  const lineRows = [
    { label: "grow scales both end points about the centre", effect: { kind: "growShrink", scale: 2 } as const, start: { x: 50, y: 100 }, end: { x: 250, y: 100 } },
    { label: "spin turns both end points about the centre", effect: { kind: "spin", degrees: 90 } as const, start: { x: 150, y: 50 }, end: { x: 150, y: 150 } },
    { label: "control: a motion path moves both by the offset", effect: { kind: "motionPath", offsetX: 10, offsetY: 5 } as const, start: { x: 110, y: 105 }, end: { x: 210, y: 105 } },
  ];
  for (const row of lineRows) {
    it(`lines: ${row.label}`, () => {
      const line = fixtureLine({ id: "line_a", start: { x: 100, y: 100 }, end: { x: 200, y: 100 } });
      const slide = fixtureSlide({ id: "slide_a", extraElements: [line], animations: [step("step_a", "line_a", row.effect)] });
      const built = lineOf(slideAtBuild({ slide, completed: 1 }), "line_a");
      assert.deepEqual(roundPoint(built.start), row.start);
      assert.deepEqual(roundPoint(built.end), row.end);
      assert.deepEqual(roundBox(built.frame), roundBox({ x: Math.min(row.start.x, row.end.x), y: Math.min(row.start.y, row.end.y), width: Math.abs(row.end.x - row.start.x), height: Math.abs(row.end.y - row.start.y) }));
    });
  }

  it("a group grows about its own centre: every leaf moves and scales", () => {
    const built = slideAtBuild({ slide: groupSlide({ animations: [step("step_a", "group_a", { kind: "growShrink", scale: 2 })], onlyChild: false }), completed: 1 });
    // Group bounds (100, 100)-(400, 400), centre (250, 250).
    assert.deepEqual(roundBox(shapeOf(built, "box_a").frame), { x: -50, y: -50, width: 400, height: 200 });
    assert.deepEqual(roundBox(shapeOf(built, "box_c").frame), { x: 350, y: 350, width: 200, height: 200 });
    assert.deepEqual(roundBox(findElement({ elements: built.elements, elementId: "group_a" })?.frame ?? ZERO), { x: -50, y: -50, width: 600, height: 600 });
  });

  it("a group spins about its own centre: leaves orbit and turn by the degrees", () => {
    const built = slideAtBuild({ slide: groupSlide({ animations: [step("step_a", "group_a", { kind: "spin", degrees: 90 })], onlyChild: false }), completed: 1 });
    const corner = shapeOf(built, "box_c");
    // box_c's centre (350, 350) turns 90 degrees clockwise about (250, 250) to (150, 350).
    assert.deepEqual(roundBox(corner.frame), { x: 100, y: 300, width: 100, height: 100 });
    assert.equal(corner.frame.rotation, 90);
    assert.equal(findElement({ elements: built.elements, elementId: "group_a" })?.frame.rotation, 90);
  });

  const colourRows = [
    { label: "fill: the box fill becomes that solid colour", part: "fill" as const, fillColour: RED, textColour: undefined },
    { label: "text: every run takes the colour, the fill stays", part: "text" as const, fillColour: literalColour({ hexadecimal: "#112233", alpha: 1 }), textColour: RED },
  ];
  for (const row of colourRows) {
    it(`colour change of the ${row.label}`, () => {
      const slide = fixtureSlide({ id: "slide_a", elements: [BOX], animations: [step("step_a", "box_a", { kind: "colourChange", colour: RED, part: row.part })] });
      const box = shapeOf(slideAtBuild({ slide, completed: 1 }), "box_a");
      assert.deepEqual(box.box.fill, { kind: "solid", colour: row.fillColour });
      const run = box.text.paragraphs[0]?.runs[0];
      assert.deepEqual(run?.style.colour, row.textColour);
      assert.deepEqual(shapeOf(slideAtBuild({ slide, completed: 0 }), "box_a").box.fill, { kind: "solid", colour: literalColour({ hexadecimal: "#112233", alpha: 1 }) }, "control: before the step");
    });
  }

  it("a line's fill colour change recolours its stroke", () => {
    const slide = fixtureSlide({
      id: "slide_a",
      extraElements: [fixtureLine({ id: "line_a", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } })],
      animations: [step("step_a", "line_a", { kind: "colourChange", colour: RED, part: "fill" })],
    });
    assert.deepEqual(lineOf(slideAtBuild({ slide, completed: 1 }), "line_a").stroke.colour, RED);
  });

  it("derived slides are cached per position, and a slide with no builds is itself", () => {
    const plain = fixtureSlide({ id: "slide_a", elements: [BOX] });
    assert.equal(slideAtBuild({ slide: plain, completed: 0 }), plain);
    const built = fixtureSlide({ id: "slide_b", elements: [BOX], animations: [step("step_a", "box_a", { kind: "spin", degrees: 30 })] });
    assert.equal(slideAtBuild({ slide: built, completed: 1 }), slideAtBuild({ slide: built, completed: 1 }));
  });
});

describe("buildSegmentTimeline", () => {
  it("lists the whole tree before the first step and after each step, hidden elements included", () => {
    const slide = fixtureSlide({
      id: "slide_a",
      elements: [BOX],
      animations: [step("step_a", "box_a", { kind: "fadeIn" }), step("step_b", "box_a", { kind: "motionPath", offsetX: 100, offsetY: 0 }, { trigger: "afterPrevious" })],
    });
    const segment = slideBuildSegments(slide)[0];
    assert.ok(segment !== undefined);
    const timeline = buildSegmentTimeline({ slide, completed: 0, segment });
    assert.deepEqual(topLevelIds(timeline.before), []);
    assert.deepEqual(topLevelIds(timeline.after), ["box_a"]);
    assert.deepEqual(
      timeline.trees.map((tree) => findElement({ elements: tree, elementId: "box_a" })?.frame.x),
      [100, 100, 200],
    );
  });
});

const ZERO = { x: 0, y: 0, width: 0, height: 0 };

function step(id: string, elementId: string, effect: AnimationEffect, extra: Partial<Parameters<typeof animationStep>[0]> = {}): AnimationStep {
  return animationStep({ id, elementId, effect, ...extra });
}

/** A group of box_a and box_c (bounds (100, 100)-(400, 400)), or of box_a alone. */
function groupSlide(options: Readonly<{ animations: readonly AnimationStep[]; onlyChild: boolean }>): SlideSnapshot {
  const children = [fixtureShape(BOX), fixtureShape({ id: "box_c", frame: { x: 300, y: 300, width: 100, height: 100 } })];
  return fixtureSlide({ id: "slide_g", extraElements: [fixtureGroup({ id: "group_a", children: options.onlyChild ? children.slice(0, 1) : children })], animations: options.animations });
}

function topLevelIds(slide: SlideSnapshot): readonly string[] {
  return slide.elements.map((element) => element.id);
}

function shapeOf(slide: SlideSnapshot, elementId: string): ShapeElement {
  const element = findElement({ elements: slide.elements, elementId });
  assert.ok(element !== null && element.kind === "shape", `${elementId} is a shape on the slide`);
  return element;
}

function lineOf(slide: SlideSnapshot, elementId: string): LineElement {
  const element: ElementSnapshot | null = findElement({ elements: slide.elements, elementId });
  assert.ok(element !== null && element.kind === "line", `${elementId} is a line on the slide`);
  return element;
}

function pick(frame: ShapeElement["frame"], keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(keys.map((key) => [key, Math.round(Number(Reflect.get(frame, key)) * 1000) / 1000]));
}

function roundPoint(point: Readonly<{ x: number; y: number }>): Readonly<{ x: number; y: number }> {
  return { x: Math.round(point.x * 1000) / 1000 + 0, y: Math.round(point.y * 1000) / 1000 + 0 };
}

function roundBox(box: Readonly<{ x: number; y: number; width: number; height: number }>): Readonly<{ x: number; y: number; width: number; height: number }> {
  const round = (value: number): number => Math.round(value * 1000) / 1000 + 0;
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}
