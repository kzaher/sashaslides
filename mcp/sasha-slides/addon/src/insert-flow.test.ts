import assert from "node:assert/strict";
import test from "node:test";
import type { ConversionResult } from "./converter-contract.ts";
import { fakeDrive } from "./fake-drive.ts";
import { conversionForInsert, insertNewSlide, recordInsert } from "./insert-flow.ts";
import type { Proposal } from "./observer.ts";
import { writePick } from "./pick-writer.ts";
import { renderRequestFor } from "./render-artifact.ts";

const PREVIEW_PAGE = "sashaprev_2_p_1_2";
const PREVIEW: ConversionResult = {
  requests: [
    { createShape: { objectId: "p_1_2_shape1", elementProperties: { pageObjectId: PREVIEW_PAGE } } },
    { insertText: { objectId: "p_1_2_shape1", text: "Q3" } },
  ],
  unsupported: [],
};

const proposal: Proposal = {
  merge: null,
  proposalId: "p_1",
  folderId: "folder_p_1",
  presentationId: "deck_1",
  count: 2,
  revision: 1,
  slides: [1, 2].map((index) => ({ index, fileId: `html_${index}`, name: `0${String(index)}.html`, label: `option ${index}` })),
};

/**
 * THE USER'S QUESTION, "why is insert taking ages if it already has rendered preview?": the insert
 * converted the candidate again although the preview had already done it.
 */
test("A CANDIDATE THE PREVIEW ALREADY CONVERTED IS NOT CONVERTED AGAIN on insert", async () => {
  let conversions = 0;
  const chosen = await conversionForInsert({
    preview: PREVIEW,
    previewPageObjectId: PREVIEW_PAGE,
    pageObjectId: "sasha_new",
    convert: async () => {
      conversions += 1;
      return PREVIEW;
    },
  });
  assert.equal(conversions, 0);
  assert.equal(chosen.reused, true);
  assert.deepEqual(chosen.requests, [
    { createShape: { objectId: "sasha_new_1", elementProperties: { pageObjectId: "sasha_new" } } },
    { insertText: { objectId: "sasha_new_1", text: "Q3" } },
  ]);
});

test("...and one the preview never converted is converted exactly once", async () => {
  let conversions = 0;
  const chosen = await conversionForInsert({
    preview: null,
    previewPageObjectId: PREVIEW_PAGE,
    pageObjectId: "sasha_new",
    convert: async () => {
      conversions += 1;
      return { requests: [{ insertText: { objectId: "fresh", text: "x" } }], unsupported: [] };
    },
  });
  assert.equal(conversions, 1);
  assert.equal(chosen.reused, false);
  assert.deepEqual(chosen.requests, [{ insertText: { objectId: "fresh", text: "x" } }]);
});

/**
 * THE ORDER AND THE COUNT OF HOST CALLS on the insert path. Exactly ONE call -- the batchUpdate --
 * stands between the click and "Inserted"; PICK, the event and the render artifact are all started
 * after the success is on screen, and together, not one after the other.
 */
test("ONE HOST CALL BEFORE 'Inserted' is shown; PICK, the event and the render come after it", async () => {
  const drive = fakeDrive();
  drive.putDeck({ presentationId: "deck_1", slideObjectIds: ["s0", "s1", "s2"], selectedSlideIndex: 0 });
  const timeline: string[] = [];
  const shown = (step: string): void => {
    timeline.push(`${step} after [${drive.hostCalls().join(", ")}]`);
  };

  const attempt = await insertNewSlide({
    slides: drive.slides,
    presentationId: "deck_1",
    pageObjectId: "sasha_new",
    converted: PREVIEW.requests,
    position: "after",
  });
  assert.equal(attempt.kind, "inserted");
  if (attempt.kind !== "inserted") return;
  assert.deepEqual(attempt.inserted.where, { kind: "at", slideNumber: 2 });
  shown("Inserted");

  // Started together: each records itself synchronously before its first await.
  let eventStartedAfter: readonly string[] = [];
  const told = await recordInsert({
    slides: drive.slides,
    presentationId: "deck_1",
    render: renderRequestFor({ proposalId: "p_1", folderId: "folder_p_1", index: 2, pageObjectId: "sasha_new" }),
    writePick: () =>
      writePick({
        pick: drive.pick,
        proposal,
        decision: { picked: 2, insertedObjectIds: attempt.inserted.objectIds, anomalies: [] },
        decidedAt: "2026-10-14T12:00:00.000Z",
      }),
    appendEvent: async () => {
      eventStartedAfter = drive.hostCalls();
    },
    warn: (message) => assert.fail(message),
  });
  shown("Sasha told");

  assert.equal(told.kind, "written");
  assert.deepEqual(timeline, [
    "Inserted after [sashaInsert]",
    "Sasha told after [sashaInsert, sashaWritePick, sashaWriteRender]",
  ]);
  assert.deepEqual(eventStartedAfter, ["sashaInsert", "sashaWritePick"], "the event did not wait for PICK to finish");
  assert.ok(drive.byName("02.png") !== null, "the render artifact was still written");
});

test("a failed render artifact is a warning, never a failed insert or an untold Sasha", async () => {
  const drive = fakeDrive();
  const warnings: string[] = [];
  const told = await recordInsert({
    slides: { ...drive.slides, writeRender: async () => ({ kind: "failed", message: "thumbnail quota" }) },
    presentationId: "deck_1",
    render: renderRequestFor({ proposalId: "p_1", folderId: "folder_p_1", index: 1, pageObjectId: "sasha_new" }),
    writePick: () =>
      writePick({
        pick: drive.pick,
        proposal,
        decision: { picked: 1, insertedObjectIds: ["sasha_new"], anomalies: [] },
        decidedAt: "2026-10-14T12:00:00.000Z",
      }),
    appendEvent: async () => undefined,
    warn: (message) => warnings.push(message),
  });
  assert.equal(told.kind, "written");
  assert.equal(warnings.length, 1);
});
