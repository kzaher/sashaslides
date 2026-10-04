// `PICK` and `render/NN.png` -- the only two files the extension writes. Against a fake Drive, so
// the exact bytes, the exact folder and the exact appProperties are all asserted with no network.

import assert from "node:assert/strict";
import test from "node:test";
import { fakeDrive } from "./fake-drive.ts";
import type { Proposal } from "./observer.ts";
import { PICK_FILE_NAME, buildPick, writePick } from "./pick-writer.ts";
import { WHOLE_SLIDE, serializePick } from "./protocol.ts";
import { writeRenderArtifact } from "./render-artifact.ts";
import { insertRequests, newPageObjectId } from "./slide-insert.ts";

const proposal: Proposal = {
  proposalId: "p_1733219000000_a1b2c3",
  folderId: "folder_p_1",
  presentationId: "deck_1",
  count: 4,
  slides: [1, 2, 3, 4].map((index) => ({
    index,
    fileId: `html_${index}`,
    name: `${String(index).padStart(2, "0")}.html`,
    label: `option ${index}`,
  })),
};

test("a pick lands in the proposal folder, named PICK, tagged for the server", async () => {
  const drive = fakeDrive();
  const outcome = await writePick({
    drive: drive.api,
    proposal,
    decision: {
      picked: 2,
      insertedObjectIds: ["sasha_abc", "sasha_abc_body"],
      anomalies: [{ index: 2, note: "chart gridlines lost", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }],
    },
    decidedAt: "2026-10-03T12:00:21.000Z",
  });
  assert.equal(outcome.kind, "written");

  const written = drive.written();
  assert.equal(written.length, 1, "exactly one file, and it is PICK");
  const pick = written[0];
  assert.ok(pick !== undefined);
  assert.equal(pick.name, PICK_FILE_NAME);
  assert.deepEqual(pick.parents, ["folder_p_1"]);
  assert.deepEqual(pick.appProperties, { sashaSlides: "pick", proposalId: proposal.proposalId });
  assert.deepEqual(JSON.parse(pick.body), {
    protocolVersion: 1,
    proposalId: "p_1733219000000_a1b2c3",
    picked: 2,
    decidedAt: "2026-10-03T12:00:21.000Z",
    insertedObjectIds: ["sasha_abc", "sasha_abc_body"],
    anomalies: [{ index: 2, note: "chart gridlines lost", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }],
  });
});

test("a dismissal is picked: null, which is what the server is blocked on", async () => {
  const drive = fakeDrive();
  const outcome = await writePick({
    drive: drive.api,
    proposal,
    decision: { picked: null, insertedObjectIds: [], anomalies: [] },
    decidedAt: "2026-10-03T12:00:21.000Z",
  });
  assert.equal(outcome.kind, "written");
  assert.equal(JSON.parse(drive.written()[0]?.body ?? "{}").picked, null);
});

test("anomalies may reference slides other than the picked one", () => {
  const built = buildPick({
    proposal,
    decision: {
      picked: 1,
      insertedObjectIds: [],
      anomalies: [
        { index: 3, note: "table borders doubled", region: WHOLE_SLIDE },
        { index: 4, note: "shadow dropped", region: { x: 0, y: 0, w: 0.5, h: 0.5 } },
      ],
    },
    decidedAt: "2026-10-03T12:00:21.000Z",
  });
  assert.equal(built.kind, "ok");
});

test("an out-of-range option is refused in the browser, not written", async () => {
  const drive = fakeDrive();
  for (const picked of [0, 5, 2.5]) {
    const outcome = await writePick({
      drive: drive.api,
      proposal,
      decision: { picked, insertedObjectIds: [], anomalies: [] },
      decidedAt: "2026-10-03T12:00:21.000Z",
    });
    assert.equal(outcome.kind, "refused", `picked ${picked}`);
  }
  assert.equal(drive.written().length, 0, "nothing reached Drive");
});

test("a 0-based anomaly index is refused -- everything in this protocol is 1-based", () => {
  const built = buildPick({
    proposal,
    decision: { picked: 1, insertedObjectIds: [], anomalies: [{ index: 0, note: "x", region: WHOLE_SLIDE }] },
    decidedAt: "2026-10-03T12:00:21.000Z",
  });
  assert.equal(built.kind, "invalid");
});

test("a dismissal cannot claim it inserted something", () => {
  const built = buildPick({
    proposal,
    decision: { picked: null, insertedObjectIds: ["sasha_abc"], anomalies: [] },
    decidedAt: "2026-10-03T12:00:21.000Z",
  });
  assert.equal(built.kind, "invalid");
});

test("a region outside 0-1 never serializes", () => {
  const outcome = serializePick({
    protocolVersion: 1,
    proposalId: "p_1",
    picked: 1,
    decidedAt: "2026-10-03T12:00:21.000Z",
    insertedObjectIds: [],
    anomalies: [{ index: 1, note: "x", region: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }],
  });
  assert.equal(outcome.kind, "invalid");
});

test("a Drive failure is reported as failed, not as written", async () => {
  const drive = fakeDrive();
  drive.failNext(1, "503 from Drive");
  const outcome = await writePick({
    drive: drive.api,
    proposal,
    decision: { picked: 1, insertedObjectIds: [], anomalies: [] },
    decidedAt: "2026-10-03T12:00:21.000Z",
  });
  assert.equal(outcome.kind, "failed");
});

test("a render artifact is NN.png inside the proposal's render folder", async () => {
  const drive = fakeDrive();
  const outcome = await writeRenderArtifact({
    drive: drive.api,
    slides: drive.slides,
    proposalId: proposal.proposalId,
    folderId: proposal.folderId,
    index: 3,
    presentationId: "deck_1",
    pageObjectId: "sasha_abc",
  });
  assert.deepEqual(outcome, { kind: "written", fileId: "written_2", name: "03.png" });
  assert.deepEqual(drive.thumbnails(), [{ presentationId: "deck_1", pageObjectId: "sasha_abc" }]);

  const folder = drive.byName("render");
  assert.ok(folder !== null);
  assert.deepEqual(folder.parents, ["folder_p_1"]);
  const png = drive.byName("03.png");
  assert.ok(png !== null);
  assert.deepEqual(png.parents, [folder.id]);
  assert.deepEqual(png.appProperties, { sashaSlides: "render", proposalId: proposal.proposalId, index: "3" });
});

test("a failed render artifact is skipped, never fatal -- the slide is already in the deck", async () => {
  const drive = fakeDrive();
  drive.failNext(1, "thumbnail quota");
  const outcome = await writeRenderArtifact({
    drive: drive.api,
    slides: drive.slides,
    proposalId: proposal.proposalId,
    folderId: proposal.folderId,
    index: 1,
    presentationId: "deck_1",
    pageObjectId: "sasha_abc",
  });
  assert.equal(outcome.kind, "skipped");
});

test("the insert batch creates the page first, with the id the converter was given", () => {
  const pageObjectId = newPageObjectId({ random: () => 0.5 });
  assert.match(pageObjectId, /^sasha_[a-z0-9]{12}$/);
  const requests = insertRequests({
    pageObjectId,
    converted: [{ createShape: { objectId: `${pageObjectId}_a` } }],
  });
  assert.deepEqual(requests[0], {
    createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } },
  });
  assert.equal(requests.length, 2);
});
