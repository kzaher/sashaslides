// BUILD STEPS IN THE MODEL (contracts/animations.ts): stored per slide as keyed maps with order
// keys, removed with their elements, merged per field between collaborators, validated before any
// write, and read back from older and newer documents without a fight. Each test runs the real store
// on real Y.Docs with injected time and randomness, like model-acceptance.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import type { AnimationEffect, CommandRejection, DocumentCommand, DocumentSnapshot, DocumentStore, ElementId, SlideId, SlideSnapshot, TransitionScriptDraft } from "../contracts/index.ts";
import { ANIMATION_LIMITS, scriptFingerprint } from "../contracts/index.ts";
import { connectInMemory } from "./index.ts";
import { childMap, documentRoots, slideMapOf } from "./document-paths.ts";
import { ALICE, applyOrThrow, box, buildStep, createTestStore, envelope, group, idMinter, shape, textBody } from "./testing/model-fixtures.ts";

const mint = idMinter("Builds01");

type Fixture = Readonly<{ slideId: SlideId; titleId: ElementId; pictureId: ElementId; groupId: ElementId; memberIds: readonly ElementId[] }>;

function buildFixture(store: DocumentStore): Fixture {
  const slideId = firstSlide(store.snapshot()).id;
  const fixture: Fixture = { slideId, titleId: mint("element"), pictureId: mint("element"), groupId: mint("element"), memberIds: [mint("element"), mint("element")] };
  applyOrThrow(
    store,
    envelope({
      commands: [
        {
          kind: "insertElements",
          slideId,
          placement: { kind: "front" },
          elements: [
            shape({ id: fixture.titleId, text: textBody("Builds") }),
            shape({ id: fixture.pictureId, frame: box({ x: 100, y: 300, width: 200, height: 120 }) }),
            group({ id: fixture.groupId, children: fixture.memberIds.map((id, index) => shape({ id, frame: box({ x: 600 + 150 * index, y: 400, width: 100, height: 80 }) })) }),
          ],
        },
      ],
    }),
  );
  return fixture;
}

function firstSlide(snapshot: DocumentSnapshot): SlideSnapshot {
  const slide = snapshot.slides[0];
  if (slide === undefined) throw new Error("the deck has no slide");
  return slide;
}

function stepTargets(snapshot: DocumentSnapshot): readonly string[] {
  return firstSlide(snapshot).animations.map((step) => step.elementId);
}

function rejectionOf(store: DocumentStore, commands: readonly DocumentCommand[]): CommandRejection | null {
  const outcome = store.apply(envelope({ commands }));
  return outcome.kind === "rejected" ? outcome.rejection : null;
}

describe("build steps in the model", () => {
  describe("deleting an element deletes its steps, and one undo restores both", () => {
    // The control row deletes an element nobody animates: the steps stay as they were.
    for (const row of [
      { name: "the animated picture", deleted: "picture", stepsAfter: ["title"] },
      { name: "control: an element without steps", deleted: "member", stepsAfter: ["title", "picture"] },
    ] as const) {
      test(row.name, () => {
        const { store } = createTestStore({ seed: "blankDeck" });
        const fixture = buildFixture(store);
        const names = new Map<string, string>([[fixture.titleId, "title"], [fixture.pictureId, "picture"]]);
        applyOrThrow(
          store,
          envelope({
            commands: [
              { kind: "insertAnimationSteps", slideId: fixture.slideId, after: null, steps: [buildStep({ id: mint("animationStep"), elementId: fixture.titleId }), buildStep({ id: mint("animationStep"), elementId: fixture.pictureId })] },
            ],
          }),
        );
        const deleted = row.deleted === "picture" ? fixture.pictureId : (fixture.memberIds[0] ?? fixture.pictureId);
        applyOrThrow(store, envelope({ commands: [{ kind: "deleteElements", slideId: fixture.slideId, elementIds: [deleted] }] }));
        assert.deepEqual(stepTargets(store.snapshot()).map((id) => names.get(id)), row.stepsAfter);
        store.undo();
        assert.deepEqual(stepTargets(store.snapshot()).map((id) => names.get(id)), ["title", "picture"]);
      });
    }
  });

  test("ungrouping removes the group's own steps and keeps its children's", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const fixture = buildFixture(store);
    const member = fixture.memberIds[0] ?? fixture.groupId;
    applyOrThrow(
      store,
      envelope({
        commands: [
          { kind: "insertAnimationSteps", slideId: fixture.slideId, after: null, steps: [buildStep({ id: mint("animationStep"), elementId: fixture.groupId }), buildStep({ id: mint("animationStep"), elementId: member })] },
        ],
      }),
    );
    applyOrThrow(store, envelope({ commands: [{ kind: "ungroupElements", slideId: fixture.slideId, groupIds: [fixture.groupId] }] }));
    assert.deepEqual(stepTargets(store.snapshot()), [member]);
  });

  test("two people adding steps at the same moment both keep theirs, in the same order on both replicas", () => {
    const first = createTestStore({ seed: "blankDeck", randomSeed: 11 });
    const fixture = buildFixture(first.store);
    const second = createTestStore({ seed: "none", randomSeed: 12 });
    connectInMemory({ first: first.sharedDocument, second: second.sharedDocument })[Symbol.dispose]();
    applyOrThrow(first.store, envelope({ commands: [{ kind: "insertAnimationSteps", slideId: fixture.slideId, after: null, steps: [buildStep({ id: mint("animationStep"), elementId: fixture.titleId })] }] }));
    applyOrThrow(second.store, envelope({ commands: [{ kind: "insertAnimationSteps", slideId: fixture.slideId, after: null, steps: [buildStep({ id: mint("animationStep"), elementId: fixture.pictureId })] }] }));
    using _connection = connectInMemory({ first: first.sharedDocument, second: second.sharedDocument });
    const order = firstSlide(first.store.snapshot()).animations.map((step) => step.id);
    assert.equal(order.length, 2);
    assert.deepEqual(firstSlide(second.store.snapshot()).animations.map((step) => step.id), order);
  });

  describe("concurrent edits of one step merge per field", () => {
    // Different fields both survive; the same field resolves to one of the two values, never a mix.
    for (const row of [
      { name: "duration on one replica, trigger on the other", firstPatch: { durationMilliseconds: 1200 }, secondPatch: { trigger: "afterPrevious" }, both: true },
      { name: "control: the same field on both", firstPatch: { durationMilliseconds: 1200 }, secondPatch: { durationMilliseconds: 300 }, both: false },
    ] as const) {
      test(row.name, () => {
        const first = createTestStore({ seed: "blankDeck", randomSeed: 21 });
        const fixture = buildFixture(first.store);
        const stepId = mint("animationStep");
        applyOrThrow(first.store, envelope({ commands: [{ kind: "insertAnimationSteps", slideId: fixture.slideId, after: null, steps: [buildStep({ id: stepId, elementId: fixture.titleId })] }] }));
        const second = createTestStore({ seed: "none", randomSeed: 22 });
        connectInMemory({ first: first.sharedDocument, second: second.sharedDocument })[Symbol.dispose]();
        applyOrThrow(first.store, envelope({ commands: [{ kind: "updateAnimationSteps", slideId: fixture.slideId, stepIds: [stepId], patch: row.firstPatch }] }));
        applyOrThrow(second.store, envelope({ commands: [{ kind: "updateAnimationSteps", slideId: fixture.slideId, stepIds: [stepId], patch: row.secondPatch }] }));
        using _connection = connectInMemory({ first: first.sharedDocument, second: second.sharedDocument });
        const merged = firstSlide(first.store.snapshot()).animations[0];
        assert.deepEqual(firstSlide(second.store.snapshot()).animations[0], merged);
        if (row.both) {
          assert.equal(merged?.durationMilliseconds, 1200);
          assert.equal(merged?.trigger, "afterPrevious");
          return;
        }
        assert.ok(merged?.durationMilliseconds === 1200 || merged?.durationMilliseconds === 300);
      });
    }
  });

  describe("every bad step is rejected before anything is written", () => {
    const transitionScriptId = mint("transitionScript");
    const animationScriptId = mint("transitionScript");
    const scriptDraft = (id: TransitionScriptDraft["id"], purpose: TransitionScriptDraft["purpose"]): TransitionScriptDraft => ({
      id,
      name: purpose,
      description: "",
      purpose,
      script: "sashaTransition.define({ run() {} })",
      stylesheet: "",
      markup: "",
      defaultParameters: {},
    });
    const scripted = (scriptId: TransitionScriptDraft["id"]): AnimationEffect => ({ kind: "scripted", scriptId, category: "entrance", parameters: {} });
    type Row = Readonly<{ name: string; commands: (fixture: Fixture) => readonly DocumentCommand[]; expected: (fixture: Fixture) => Partial<CommandRejection> | null }>;
    const insert = (fixture: Fixture, effect: AnimationEffect, elementId: ElementId = fixture.titleId): DocumentCommand => ({
      kind: "insertAnimationSteps",
      slideId: fixture.slideId,
      after: null,
      steps: [buildStep({ id: mint("animationStep"), elementId, effect })],
    });
    const rows: readonly Row[] = [
      { name: "control: a valid fly in is applied", commands: (fixture) => [insert(fixture, { kind: "flyIn", from: "top" })], expected: () => null },
      { name: "an element that is not on the slide", commands: (fixture) => [insert(fixture, { kind: "fadeIn" }, mint("element"))], expected: () => ({ reason: "elementMissing" }) },
      { name: "a spin past the limit", commands: (fixture) => [insert(fixture, { kind: "spin", degrees: ANIMATION_LIMITS.maximumSpinDegrees + 1 })], expected: () => ({ reason: "invalidValue" }) },
      { name: "a scale of zero", commands: (fixture) => [insert(fixture, { kind: "growShrink", scale: 0 })], expected: () => ({ reason: "invalidValue" }) },
      { name: "a scripted step naming a missing script", commands: (fixture) => [insert(fixture, scripted(mint("transitionScript")))], expected: () => ({ reason: "transitionScriptMissing" }) },
      {
        name: "a scripted step naming a TRANSITION script",
        commands: (fixture) => [{ kind: "upsertTransitionScript", script: scriptDraft(transitionScriptId, "transition"), basedOnUpdatedAt: null, approval: "authorDecides" }, insert(fixture, scripted(transitionScriptId))],
        expected: () => ({ reason: "invalidValue" }),
      },
      {
        name: "control: a scripted step naming an animation script",
        commands: (fixture) => [{ kind: "upsertTransitionScript", script: scriptDraft(animationScriptId, "animation"), basedOnUpdatedAt: null, approval: "authorDecides" }, insert(fixture, scripted(animationScriptId))],
        expected: () => null,
      },
      {
        name: "an update of a step that does not exist",
        commands: (fixture) => [{ kind: "updateAnimationSteps", slideId: fixture.slideId, stepIds: [mint("animationStep")], patch: { trigger: "withPrevious" } }],
        expected: () => ({ reason: "animationStepMissing" }),
      },
      {
        name: "a sequence longer than the limit",
        commands: (fixture) => [
          {
            kind: "insertAnimationSteps",
            slideId: fixture.slideId,
            after: null,
            steps: Array.from({ length: ANIMATION_LIMITS.maximumStepsPerSlide + 1 }, () => buildStep({ id: mint("animationStep"), elementId: fixture.titleId })),
          },
        ],
        expected: () => ({ reason: "invalidValue" }),
      },
      {
        name: "a step of an element deleted earlier in the same envelope",
        commands: (fixture) => [{ kind: "deleteElements", slideId: fixture.slideId, elementIds: [fixture.titleId] }, insert(fixture, { kind: "fadeIn" })],
        expected: () => ({ reason: "elementMissing" }),
      },
    ];
    for (const row of rows) {
      test(row.name, () => {
        const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
        const fixture = buildFixture(store);
        const before = Y.encodeStateVector(sharedDocument);
        const rejection = rejectionOf(store, row.commands(fixture));
        const expected = row.expected(fixture);
        if (expected === null) {
          assert.equal(rejection, null);
          return;
        }
        assert.equal(rejection?.reason, expected.reason, JSON.stringify(rejection));
        assert.deepEqual(Y.encodeStateVector(sharedDocument), before, "nothing was written");
      });
    }
  });

  describe("a slide stored before builds existed", () => {
    for (const repairPolicy of ["repairAfterTransaction", "reportOnly"] as const) {
      test(`reads as no builds; ${repairPolicy === "reportOnly" ? "a client only reports the missing map" : "the repairing replica adds it"}`, () => {
        const { store, sharedDocument, scheduler } = createTestStore({ seed: "blankDeck", repairPolicy });
        const slideId = firstSlide(store.snapshot()).id;
        sharedDocument.transact(() => slideMapOf(documentRoots(sharedDocument), slideId)?.delete("animations"));
        scheduler.flush();
        assert.deepEqual(firstSlide(store.snapshot()).animations, []);
        const slide = slideMapOf(documentRoots(sharedDocument), slideId);
        if (repairPolicy === "reportOnly") {
          assert.equal(slide?.has("animations"), false);
          assert.ok(store.validate().some((issue) => issue.path.endsWith("/animations") && issue.problem === "missingKey"));
          return;
        }
        assert.ok(slide?.get("animations") instanceof Y.Map);
      });
    }
  });

  test("an effect from a newer client is shown as unsupported and never rewritten", () => {
    const { store, sharedDocument, scheduler } = createTestStore({ seed: "blankDeck", repairPolicy: "repairAfterTransaction" });
    const fixture = buildFixture(store);
    const stepId = mint("animationStep");
    applyOrThrow(store, envelope({ commands: [{ kind: "insertAnimationSteps", slideId: fixture.slideId, after: null, steps: [buildStep({ id: stepId, elementId: fixture.titleId })] }] }));
    const stepMap = (): Y.Map<unknown> | null => {
      const animations = childMap(slideMapOf(documentRoots(sharedDocument), fixture.slideId) ?? new Y.Map<unknown>(), "animations");
      return animations === null ? null : childMap(animations, stepId);
    };
    sharedDocument.transact(() => stepMap()?.set("effect", { kind: "bounceIn", height: 3 }));
    scheduler.flush();
    const step = firstSlide(store.snapshot()).animations[0];
    assert.deepEqual(step?.unsupportedKeys, ["effect"]);
    applyOrThrow(store, envelope({ commands: [{ kind: "updateAnimationSteps", slideId: fixture.slideId, stepIds: [stepId], patch: { trigger: "withPrevious" } }] }));
    scheduler.flush();
    assert.deepEqual(stepMap()?.get("effect"), { kind: "bounceIn", height: 3 });
  });

  test("one envelope of steps is one undo step, and the snapshot keeps untouched steps by identity", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const fixture = buildFixture(store);
    const kept = mint("animationStep");
    applyOrThrow(store, envelope({ commands: [{ kind: "insertAnimationSteps", slideId: fixture.slideId, after: null, steps: [buildStep({ id: kept, elementId: fixture.titleId })] }] }));
    const before = firstSlide(store.snapshot()).animations[0];
    applyOrThrow(
      store,
      envelope({
        commands: [
          { kind: "insertAnimationSteps", slideId: fixture.slideId, after: kept, steps: [buildStep({ id: mint("animationStep"), elementId: fixture.pictureId }), buildStep({ id: mint("animationStep"), elementId: fixture.groupId, trigger: "withPrevious" })] },
        ],
      }),
    );
    assert.equal(firstSlide(store.snapshot()).animations.length, 3);
    assert.equal(firstSlide(store.snapshot()).animations[0], before, "the untouched step is the same object");
    store.undo();
    assert.deepEqual(firstSlide(store.snapshot()).animations.map((step) => step.id), [kept]);
  });

  test("a slide inserted with builds keeps them, and one naming an element it does not hold is refused", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const anchor = firstSlide(store.snapshot()).id;
    const elementId = mint("element");
    const slideWith = (target: ElementId): SlideSnapshot => ({
      id: mint("slide"),
      layoutId: null,
      background: null,
      skipped: false,
      speakerNotes: textBody(""),
      transition: null,
      elements: [shape({ id: elementId })],
      animations: [buildStep({ id: mint("animationStep"), elementId: target, effect: { kind: "zoomIn" } })],
    });
    assert.equal(rejectionOf(store, [{ kind: "insertSlides", slides: [slideWith(mint("element"))], after: anchor }])?.reason, "elementMissing");
    applyOrThrow(store, envelope({ commands: [{ kind: "insertSlides", slides: [slideWith(elementId)], after: anchor }] }));
    assert.deepEqual(store.snapshot().slides[1]?.animations.map((step) => step.effect), [{ kind: "zoomIn" }]);
  });

  test("an approval of a script as a transition does not cover the same text as a build step", () => {
    const sources = { script: "sashaTransition.define({ run() {} })", stylesheet: "", markup: "" };
    const asTransition = scriptFingerprint({ ...sources, purpose: "transition" });
    const asAnimation = scriptFingerprint({ ...sources, purpose: "animation" });
    assert.notEqual(asTransition, asAnimation);
    const { store } = createTestStore({ seed: "blankDeck" });
    const scriptId = mint("transitionScript");
    applyOrThrow(store, envelope({ author: { kind: "agent", name: "Claude", agentSessionId: "agentSession1" }, commands: [{ kind: "upsertTransitionScript", script: { id: scriptId, name: "Bounce", description: "", purpose: "animation", ...sources, defaultParameters: {} }, basedOnUpdatedAt: null, approval: "authorDecides" }] }));
    const stale = rejectionOf(store, [{ kind: "approveTransitionScript", scriptId, fingerprint: asTransition }]);
    assert.equal(stale?.reason, "staleApproval");
    applyOrThrow(store, envelope({ author: ALICE, commands: [{ kind: "approveTransitionScript", scriptId, fingerprint: asAnimation }] }));
    assert.equal(store.snapshot().transitionScripts[0]?.approval.kind, "approved");
    assert.equal(store.snapshot().transitionScripts[0]?.purpose, "animation");
  });
});
