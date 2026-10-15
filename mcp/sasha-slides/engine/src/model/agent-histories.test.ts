// Agent histories (SPEC.md 21.6, acceptance 7): reverting one agent session undoes only that
// session's steps, newest first, and counts the steps a person overwrote since instead of hiding
// them. Parametric over the cause: the only difference between the rows is whether the person
// overwrote session A's second step, and only `skippedSteps`, `stepsReverted` and that element's
// frame change with it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import type { CommandAuthor, ElementId, Frame, SlideId, SlideSnapshot } from "../contracts/index.ts";
import { createAgentHistories } from "./agent-histories.ts";
import { applyOrThrow, box, createTestStore, elementId, envelope, manualClock, seededRandom, shape, ALICE } from "./testing/model-fixtures.ts";

const SESSION_A: CommandAuthor = { kind: "agent", name: "Claude", agentSessionId: "as_sessionA" };
const SESSION_B: CommandAuthor = { kind: "agent", name: "Claude", agentSessionId: "as_sessionB" };

const ORIGINAL = box({ x: 100, y: 100, width: 200, height: 100 });
const MOVED_BY_A = box({ x: 500, y: 100, width: 200, height: 100 });
const MOVED_BY_B = box({ x: 100, y: 400, width: 200, height: 100 });
const MOVED_BY_PERSON = box({ x: 700, y: 500, width: 200, height: 100 });

type Row = Readonly<{
  name: string;
  personOverwritesSecondStep: boolean;
  expectedStepsReverted: number;
  expectedSkippedSteps: number;
  expectedThirdFrame: Frame;
}>;

const ROWS: readonly Row[] = [
  { name: "control: nobody touched A's steps since", personOverwritesSecondStep: false, expectedStepsReverted: 2, expectedSkippedSteps: 0, expectedThirdFrame: ORIGINAL },
  { name: "the person moved what A's second step moved", personOverwritesSecondStep: true, expectedStepsReverted: 1, expectedSkippedSteps: 1, expectedThirdFrame: MOVED_BY_PERSON },
];

describe("agent histories", () => {
  for (const row of ROWS) {
    test(`revertAgentSession(A) undoes only A's steps -- ${row.name}`, () => {
      const clock = manualClock(10_000);
      const sharedDocument = new Y.Doc();
      const { store } = createTestStore({ seed: "blankDeck", sharedDocument, clock });
      const histories = createAgentHistories({ sharedDocument, random: seededRandom(3), now: clock.now, revision: () => store.snapshot().revision });
      const slideId = firstSlide(store.snapshot().slides);
      const [first, second, third] = [elementId("el_first01"), elementId("el_second1"), elementId("el_third01")];
      applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, elements: [first, second, third].map((id) => shape({ id, frame: ORIGINAL })), placement: { kind: "front" } }] }));

      const move = (author: CommandAuthor, id: ElementId, frame: Frame) =>
        envelope({ author, commands: [{ kind: "setFrames", slideId, frames: [{ kind: "box", elementId: id, frame }] }] });
      assert.equal(histories.apply(move(SESSION_A, first, MOVED_BY_A)).kind, "applied");
      clock.advance(1_000);
      assert.equal(histories.apply(move(SESSION_B, second, MOVED_BY_B)).kind, "applied");
      clock.advance(1_000);
      applyOrThrow(store, envelope({ author: ALICE, commands: [{ kind: "setTitle", title: "The person's title" }] }));
      assert.equal(histories.apply(move(SESSION_A, third, MOVED_BY_A)).kind, "applied");
      if (row.personOverwritesSecondStep) applyOrThrow(store, move(ALICE, third, MOVED_BY_PERSON));

      const result = histories.revert({ agentSessionId: "as_sessionA" });

      assert.deepEqual(result, { stepsReverted: row.expectedStepsReverted, skippedSteps: row.expectedSkippedSteps });
      const frames = framesOf(store.snapshot().slides, slideId);
      assert.deepEqual(frames.get(first), ORIGINAL, "A's first step is undone");
      assert.deepEqual(frames.get(second), MOVED_BY_B, "B's step remains");
      assert.deepEqual(frames.get(third), row.expectedThirdFrame);
      assert.equal(store.snapshot().title, "The person's title", "the person's edit remains");
      assert.deepEqual(
        histories.sessions().map((session) => session.agentSessionId),
        ["as_sessionB"],
        "A's history is spent; B's is still revertible",
      );
      assert.deepEqual(histories.revert({ agentSessionId: "as_sessionA" }), { stepsReverted: 0, skippedSteps: 0 });
      histories[Symbol.dispose]();
      store[Symbol.dispose]();
    });
  }

  test("a person's envelope applied by the server lands on no history", () => {
    const clock = manualClock(10_000);
    const sharedDocument = new Y.Doc();
    const { store } = createTestStore({ seed: "blankDeck", sharedDocument, clock });
    const histories = createAgentHistories({ sharedDocument, random: seededRandom(3), now: clock.now, revision: () => store.snapshot().revision });
    assert.equal(histories.apply(envelope({ author: ALICE, commands: [{ kind: "setTitle", title: "Imported" }] })).kind, "applied");
    assert.equal(histories.hasHistory(), false);
    assert.equal(store.snapshot().title, "Imported");
    histories[Symbol.dispose]();
    store[Symbol.dispose]();
  });
});

function firstSlide(slides: readonly SlideSnapshot[]): SlideId {
  const slide = slides[0];
  if (slide === undefined) throw new Error("the blank deck has a slide");
  return slide.id;
}

function framesOf(slides: readonly SlideSnapshot[], slideId: SlideId): ReadonlyMap<ElementId, Frame> {
  const frames = new Map<ElementId, Frame>();
  for (const element of slides.find((candidate) => candidate.id === slideId)?.elements ?? []) {
    if ("frame" in element) frames.set(element.id, element.frame);
  }
  return frames;
}
