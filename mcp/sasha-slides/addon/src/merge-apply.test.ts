import assert from "node:assert/strict";
import test from "node:test";
import type { ConvertSlideHtml, StackedConversion } from "./converter-contract.ts";
import { fakeDrive, type FakeDrive } from "./fake-drive.ts";
import { applyMergeCandidate, type MergeApplyOutcome } from "./merge-apply.ts";
import type { MergeSpec } from "./protocol.ts";

const DECK = "deck_1";
const SLIDE = "g_slide_7";

const MERGE: MergeSpec = {
  presentationId: DECK,
  slideObjectId: SLIDE,
  removals: [
    { index: 1, remove: ["g_old_chart"] },
    { index: 2, remove: ["g_gone"] },
  ],
};

/** A converter that makes one shape behind (z -1) and one in front (z 2), on whatever page it is asked for. */
function stackedConverter(): Readonly<{ convert: ConvertSlideHtml; asked: string[] }> {
  const asked: string[] = [];
  const convert: ConvertSlideHtml = async ({ pageObjectId, objectIdPrefix }) => {
    asked.push(pageObjectId);
    const shape = (objectId: string) => ({
      createShape: { objectId, shapeType: "RECTANGLE", elementProperties: { pageObjectId } },
    });
    const result: StackedConversion = {
      requests: [shape(`${objectIdPrefix}_back`), shape(`${objectIdPrefix}_front`)],
      unsupported: [],
      stackedElements: [
        { zIndex: -1, requests: [shape(`${objectIdPrefix}_back`)] },
        { zIndex: 2, requests: [shape(`${objectIdPrefix}_front`)] },
      ],
    };
    return result;
  };
  return { convert, asked };
}

async function apply({
  drive,
  index = 1,
  openPresentationId = DECK,
}: {
  drive: FakeDrive;
  index?: number;
  openPresentationId?: string;
}): Promise<MergeApplyOutcome> {
  const { convert } = stackedConverter();
  return applyMergeCandidate({
    slides: drive.slides,
    convert,
    merge: MERGE,
    openPresentationId,
    index,
    html: "<html><body></body></html>",
    objectIdPrefix: "sasha_m1",
    render: null,
    onSending: () => undefined,
  });
}

test("a picked merge is ONE batch on the target slide: delete, create on that page, send the negative back -- no createSlide", async () => {
  const drive = fakeDrive();
  drive.putPage({ presentationId: DECK, pageObjectId: SLIDE, objectIds: ["g_title", "g_old_chart"] });
  const outcome = await apply({ drive });
  assert.equal(outcome.kind, "applied");
  assert.equal(drive.batches().length, 1);
  const requests = drive.batches()[0]?.requests ?? [];
  assert.deepEqual(
    requests.map((request) => Object.keys(request)[0]),
    ["deleteObject", "createShape", "createShape", "updatePageElementsZOrder"],
  );
  assert.deepEqual(requests[0], { deleteObject: { objectId: "g_old_chart" } });
  assert.deepEqual(requests[3], {
    updatePageElementsZOrder: { pageElementObjectIds: ["sasha_m1_back"], operation: "SEND_TO_BACK" },
  });
  if (outcome.kind === "applied") {
    assert.equal(outcome.pageObjectId, SLIDE);
    assert.deepEqual(outcome.createdObjectIds, ["sasha_m1_back", "sasha_m1_front"]);
  }
});

test("the candidate is converted onto the TARGET slide's page id, not a fresh one", async () => {
  const drive = fakeDrive();
  drive.putPage({ presentationId: DECK, pageObjectId: SLIDE, objectIds: ["g_old_chart"] });
  const { convert, asked } = stackedConverter();
  await applyMergeCandidate({
    slides: drive.slides,
    convert,
    merge: MERGE,
    openPresentationId: DECK,
    index: 1,
    html: "<html></html>",
    objectIdPrefix: "sasha_m2",
    render: null,
    onSending: () => undefined,
  });
  assert.deepEqual(asked, [SLIDE]);
});

test("a remove id that is no longer on the slide is REFUSED, naming it, and NOTHING is sent", async () => {
  const drive = fakeDrive();
  drive.putPage({ presentationId: DECK, pageObjectId: SLIDE, objectIds: ["g_title"] });
  const outcome = await apply({ drive, index: 2 });
  assert.equal(outcome.kind, "refused");
  if (outcome.kind === "refused") assert.match(outcome.message, /g_gone/);
  assert.equal(drive.batches().length, 0);
});

test("a merge into a deck other than the open one is refused before anything is read", async () => {
  const drive = fakeDrive();
  drive.putPage({ presentationId: DECK, pageObjectId: SLIDE, objectIds: ["g_old_chart"] });
  const outcome = await apply({ drive, openPresentationId: "deck_other" });
  assert.equal(outcome.kind, "refused");
  assert.equal(drive.batches().length, 0);
});

test("a slide that cannot be read (deleted since capture) fails with the reason, and nothing is sent", async () => {
  const drive = fakeDrive();
  const outcome = await apply({ drive });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.match(outcome.message, /could not read slide g_slide_7/);
  assert.equal(drive.batches().length, 0);
});

test("the slide's full-page backdrop, as sashaPageElements reports it, stays rearmost behind the negative", async () => {
  const drive = fakeDrive();
  drive.putPage({ presentationId: DECK, pageObjectId: SLIDE, objectIds: ["g_bg", "g_old_chart"], fullPageObjectIds: ["g_bg"] });
  await apply({ drive });
  const requests = drive.batches()[0]?.requests ?? [];
  assert.deepEqual(requests.slice(-2), [
    { updatePageElementsZOrder: { pageElementObjectIds: ["sasha_m1_back"], operation: "SEND_TO_BACK" } },
    { updatePageElementsZOrder: { pageElementObjectIds: ["g_bg"], operation: "SEND_TO_BACK" } },
  ]);
});
