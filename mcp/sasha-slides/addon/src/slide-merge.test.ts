import assert from "node:assert/strict";
import test from "node:test";
import type { SlidesApiRequest, StackedElement } from "./converter-contract.ts";
import { describeMergeRefusal, planMerge, type MergePlan } from "./slide-merge.ts";

const PAGE = "g_slide_7";

/** A new element whose one shape is `objectId` on `page`, with a text insert after it. */
function element({ objectId, zIndex, page = PAGE }: { objectId: string; zIndex: number; page?: string }): StackedElement {
  return {
    zIndex,
    requests: [
      { createShape: { objectId, shapeType: "RECTANGLE", elementProperties: { pageObjectId: page } } },
      { insertText: { objectId, text: objectId } },
    ],
  };
}

/**
 * Slides' z-order, modelled: `pageElements` back to front, a create lands on top, a delete takes
 * the element out, SEND_TO_BACK / BRING_TO_FRONT move one element to an end. Asserting the order
 * this produces, rather than the request list alone, is what checks the plan does what it means.
 */
function applied({ before, requests }: { before: readonly string[]; requests: readonly SlidesApiRequest[] }): readonly string[] {
  let order = [...before];
  for (const request of requests) {
    const deleted = record(request["deleteObject"]);
    if (deleted !== null) {
      order = order.filter((objectId) => objectId !== deleted["objectId"]);
      continue;
    }
    const created = record(request["createShape"]);
    if (created !== null) {
      order.push(String(created["objectId"]));
      continue;
    }
    const moved = record(request["updatePageElementsZOrder"]);
    if (moved === null) continue;
    const ids = moved["pageElementObjectIds"];
    assert.ok(Array.isArray(ids) && ids.length === 1, "one element per z-order request");
    const objectId = String(ids[0]);
    order = order.filter((candidate) => candidate !== objectId);
    if (moved["operation"] === "SEND_TO_BACK") order.unshift(objectId);
    else if (moved["operation"] === "BRING_TO_FRONT") order.push(objectId);
    else assert.fail(`unexpected z-order operation ${String(moved["operation"])}`);
  }
  return order;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : null;
}

function planned(plan: MergePlan): Extract<MergePlan, { kind: "planned" }> {
  if (plan.kind !== "planned") assert.fail(`expected a plan, got ${describeMergeRefusal(plan.refusal)}`);
  return plan;
}

test("a NEGATIVE z-index goes behind every kept element, a positive one in front", () => {
  const before = ["title", "photo"];
  const plan = planned(
    planMerge({
      pageObjectId: PAGE,
      existingObjectIds: before,
      remove: [],
      newElements: [element({ objectId: "badge", zIndex: 2 }), element({ objectId: "panel", zIndex: -1 })],
    }),
  );
  assert.deepEqual(applied({ before, requests: plan.requests }), ["panel", "title", "photo", "badge"]);
  assert.deepEqual(plan.createdObjectIds, ["panel", "badge"]);
});

test("several negatives keep their z order at the back: the lowest z-index is rearmost", () => {
  const before = ["title"];
  const plan = planned(
    planMerge({
      pageObjectId: PAGE,
      existingObjectIds: before,
      remove: [],
      newElements: [
        element({ objectId: "shade", zIndex: -1 }),
        element({ objectId: "wash", zIndex: -5 }),
        element({ objectId: "grid", zIndex: -2 }),
      ],
    }),
  );
  assert.deepEqual(applied({ before, requests: plan.requests }), ["wash", "grid", "shade", "title"]);
});

test("positives stack in front in z order, and auto (0) sits in front of the kept content but under them", () => {
  const before = ["title"];
  const plan = planned(
    planMerge({
      pageObjectId: PAGE,
      existingObjectIds: before,
      remove: [],
      newElements: [
        element({ objectId: "top", zIndex: 9 }),
        element({ objectId: "plain", zIndex: 0 }),
        element({ objectId: "mid", zIndex: 3 }),
      ],
    }),
  );
  assert.deepEqual(applied({ before, requests: plan.requests }), ["title", "plain", "mid", "top"]);
});

test("TIES keep document order, on both sides of the kept content", () => {
  const before = ["title"];
  const plan = planned(
    planMerge({
      pageObjectId: PAGE,
      existingObjectIds: before,
      remove: [],
      newElements: [
        element({ objectId: "front1", zIndex: 1 }),
        element({ objectId: "back1", zIndex: -1 }),
        element({ objectId: "front2", zIndex: 1 }),
        element({ objectId: "back2", zIndex: -1 }),
      ],
    }),
  );
  assert.deepEqual(applied({ before, requests: plan.requests }), ["back1", "back2", "title", "front1", "front2"]);
});

test("REMOVING an element deletes it first, in the same batch, and the rest keep their order", () => {
  const before = ["bg", "old_chart", "title"];
  const plan = planned(
    planMerge({
      pageObjectId: PAGE,
      existingObjectIds: before,
      remove: ["old_chart"],
      newElements: [element({ objectId: "new_chart", zIndex: 0 })],
    }),
  );
  assert.deepEqual(plan.requests[0], { deleteObject: { objectId: "old_chart" } });
  assert.deepEqual(applied({ before, requests: plan.requests }), ["bg", "title", "new_chart"]);
});

test("a duplicated remove id is deleted once, since a second deleteObject would fail the whole batch", () => {
  const plan = planned(
    planMerge({ pageObjectId: PAGE, existingObjectIds: ["a", "b"], remove: ["a", "a"], newElements: [] }),
  );
  assert.deepEqual(plan.requests, [{ deleteObject: { objectId: "a" } }]);
});

test("an UNKNOWN remove id is REFUSED, naming it, and nothing is planned -- never a silent skip", () => {
  const plan = planMerge({
    pageObjectId: PAGE,
    existingObjectIds: ["title", "photo"],
    remove: ["photo", "gone_1", "gone_2"],
    newElements: [element({ objectId: "new", zIndex: 0 })],
  });
  assert.deepEqual(plan, {
    kind: "refused",
    refusal: { kind: "unknown-remove-ids", pageObjectId: PAGE, objectIds: ["gone_1", "gone_2"] },
  });
  if (plan.kind !== "refused") return;
  const sentence = describeMergeRefusal(plan.refusal);
  assert.match(sentence, /gone_1, gone_2/);
  assert.match(sentence, /no longer on slide g_slide_7/);
  assert.match(sentence, /nothing was changed/);
});

test("an EMPTY remove list only adds: no deletes, the slide's elements untouched", () => {
  const before = ["title", "photo"];
  const plan = planned(
    planMerge({
      pageObjectId: PAGE,
      existingObjectIds: before,
      remove: [],
      newElements: [element({ objectId: "caption", zIndex: 0 })],
    }),
  );
  assert.equal(plan.requests.filter((request) => "deleteObject" in request).length, 0);
  assert.deepEqual(applied({ before, requests: plan.requests }), ["title", "photo", "caption"]);
});

test("every request a new element brought is kept, after its create, so text lands in its shape", () => {
  const plan = planned(
    planMerge({ pageObjectId: PAGE, existingObjectIds: [], remove: [], newElements: [element({ objectId: "box", zIndex: 0 })] }),
  );
  assert.deepEqual(
    plan.requests.map((request) => Object.keys(request)[0]),
    ["createShape", "insertText"],
  );
});

test("an element the converter put on ANOTHER page is refused: it was asked for the wrong page", () => {
  const plan = planMerge({
    pageObjectId: PAGE,
    existingObjectIds: [],
    remove: [],
    newElements: [element({ objectId: "stray", zIndex: 0, page: "sasha_newpage" })],
  });
  assert.equal(plan.kind, "refused");
  if (plan.kind === "refused") assert.equal(plan.refusal.kind, "wrong-page");
});

test("a new id that is already on the slide is refused, unless the same batch removes it first", () => {
  const clash = planMerge({
    pageObjectId: PAGE,
    existingObjectIds: ["box"],
    remove: [],
    newElements: [element({ objectId: "box", zIndex: 0 })],
  });
  assert.deepEqual(clash, { kind: "refused", refusal: { kind: "id-collision", objectIds: ["box"] } });
  const replaced = planMerge({
    pageObjectId: PAGE,
    existingObjectIds: ["box"],
    remove: ["box"],
    newElements: [element({ objectId: "box", zIndex: 0 })],
  });
  assert.equal(replaced.kind, "planned");
});

test("nothing to remove and nothing to add is refused rather than sent as an empty batch", () => {
  assert.deepEqual(planMerge({ pageObjectId: PAGE, existingObjectIds: ["a"], remove: [], newElements: [] }), {
    kind: "refused",
    refusal: { kind: "empty" },
  });
});
