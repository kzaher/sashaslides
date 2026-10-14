// MERGE PROPOSALS: a candidate redesigns part of an EXISTING slide (PROTOCOL.md "Merge proposals").
// The connector's half is staging -- the `merge` target and each slide's `remove` list reach the
// manifest exactly as the add-on parses it -- and `slide_structure`, which tells Claude what is on
// the slide. Applying a pick is the add-on's (addon/src/slide-merge.ts) and is tested there.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { slides_v1 } from "googleapis";
import { parseManifest } from "../addon/src/protocol.ts";
import { createProposal, reviseSlide, type ProposalEnvironment, type ProposalMerge } from "../proposal";
import { mergeRequestFrom, slideSelectorFrom, slideStructurePayload } from "../server";
import { slideStructureOf } from "../slide-structure";
import { createFakeDrive } from "./fake-drive";

const SLIDE = "<!doctype html><html><body style=\"width:1280px;height:720px\"><div>new</div></body></html>";
const TARGET = { presentationId: "deck-1", slideObjectId: "g_slide_7" };

function environment(): Readonly<{ env: ProposalEnvironment; fake: ReturnType<typeof createFakeDrive> }> {
  const fake = createFakeDrive();
  return {
    fake,
    env: {
      drive: fake.channel,
      now: () => new Date("2026-10-14T12:00:00.000Z"),
      randomSuffix: () => "aaa111",
      sleep: () => Promise.resolve(),
      statFile: () => ({ bytes: 2048 }),
      warn: () => undefined,
    },
  };
}

function manifestText(fake: ReturnType<typeof createFakeDrive>): string {
  const text = fake.find({ name: "manifest.json" })?.text;
  if (typeof text !== "string") throw new Error("no manifest was written");
  return text;
}

const MERGE: ProposalMerge = { target: TARGET, removePerSlide: [["g_title", "g_chart"], []] };

describe("staging a merge proposal", () => {
  test("the manifest carries the target and every slide's remove list, and the ADD-ON parses it", async () => {
    const { env, fake } = environment();
    const outcome = await createProposal({
      env,
      slides: [{ html: SLIDE, label: "a" }, { html: SLIDE, label: "b" }],
      presentationId: null,
      merge: MERGE,
    });
    assert.equal(outcome.kind, "ok");
    const raw: unknown = JSON.parse(manifestText(fake));
    assert.deepEqual((raw as { merge: unknown }).merge, TARGET);
    // The add-on's own parser is the contract: what the connector writes, it must accept.
    const parsed = parseManifest(manifestText(fake));
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    assert.equal(parsed.value.presentationId, "deck-1", "the merge's deck is the proposal's deck");
    assert.deepEqual(parsed.value.merge, {
      ...TARGET,
      removals: [
        { index: 1, remove: ["g_title", "g_chart"] },
        { index: 2, remove: [] },
      ],
    });
  });

  test("an ORDINARY manifest is unchanged: no merge key, no remove key, and the add-on reads merge null", async () => {
    const { env, fake } = environment();
    await createProposal({ env, slides: [{ html: SLIDE, label: null }], presentationId: "deck-1" });
    const text = manifestText(fake);
    assert.ok(!text.includes("\"merge\""), "no merge key");
    assert.ok(!text.includes("\"remove\""), "no remove key");
    const parsed = parseManifest(text);
    assert.equal(parsed.kind === "ok" ? parsed.value.merge : parsed.kind, null);
  });

  test("a revision keeps the merge: rewriting the manifest must not turn it back into an insert", async () => {
    const { env, fake } = environment();
    const staged = await createProposal({
      env,
      slides: [{ html: SLIDE, label: "a" }, { html: SLIDE, label: "b" }],
      presentationId: null,
      merge: MERGE,
    });
    const revised = await reviseSlide({
      env,
      proposalId: staged.kind === "ok" ? staged.proposalId : "",
      slideIndex: 1,
      html: SLIDE.replace("new", "newer"),
      label: null,
      answeredCommentIds: [],
    });
    assert.equal(revised.kind, "ok");
    const parsed = parseManifest(manifestText(fake));
    assert.deepEqual(parsed.kind === "ok" ? parsed.value.merge?.removals[0] : parsed, { index: 1, remove: ["g_title", "g_chart"] });
  });

  test("a merge into a different deck than presentationId, or with the wrong number of lists, is refused", async () => {
    const { env, fake } = environment();
    const otherDeck = await createProposal({ env, slides: [{ html: SLIDE, label: null }], presentationId: "deck-2", merge: { target: TARGET, removePerSlide: [[]] } });
    assert.equal(otherDeck.kind, "invalid-input");
    const misaligned = await createProposal({ env, slides: [{ html: SLIDE, label: null }], presentationId: null, merge: { target: TARGET, removePerSlide: [] } });
    assert.equal(misaligned.kind, "invalid-input");
    assert.equal(fake.calls().length, 0, "nothing reached Drive");
  });
});

describe("mergeRequestFrom (the propose_slides merge boundary)", () => {
  test("a target and per-slide removes become one remove list per slide, [] where omitted", () => {
    const merged = mergeRequestFrom({
      slides: [{ html: SLIDE, remove: ["g_title"] }, { html: SLIDE }],
      merge: TARGET,
      presentationId: undefined,
    });
    assert.deepEqual(merged, { kind: "ok", merge: { target: TARGET, removePerSlide: [["g_title"], []] } });
  });

  test("no target and no remove is an ordinary proposal", () => {
    assert.deepEqual(mergeRequestFrom({ slides: [{ html: SLIDE }], merge: undefined, presentationId: "deck-1" }), {
      kind: "ok",
      merge: null,
    });
  });

  test("remove without a target, a target in another deck, and a repeated id are each refused with a reason", () => {
    const rows = [
      { why: /needs `merge/, merged: mergeRequestFrom({ slides: [{ html: SLIDE }, { html: SLIDE, remove: ["g_x"] }], merge: undefined, presentationId: undefined }) },
      { why: /different deck/, merged: mergeRequestFrom({ slides: [{ html: SLIDE }], merge: TARGET, presentationId: "deck-2" }) },
      { why: /g_x twice/, merged: mergeRequestFrom({ slides: [{ html: SLIDE, remove: ["g_x", "g_x"] }], merge: TARGET, presentationId: undefined }) },
    ];
    for (const row of rows) {
      assert.equal(row.merged.kind, "error");
      assert.match(row.merged.kind === "error" ? row.merged.message : "", row.why);
    }
  });
});

/** A slide like Google returns it: a title text box, a rotated image, a group of two shapes. */
const PAGE: slides_v1.Schema$Page = {
  objectId: "g_slide_7",
  pageElements: [
    {
      objectId: "g_bg",
      size: { width: { magnitude: 9_144_000, unit: "EMU" }, height: { magnitude: 5_143_500, unit: "EMU" } },
      transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU" },
      shape: { shapeType: "RECTANGLE" },
    },
    {
      objectId: "g_title",
      // 360 x 40 pt at (36, 18) pt: 640 x 71.1 px at (64, 32) on the 1280 frame.
      size: { width: { magnitude: 360, unit: "PT" }, height: { magnitude: 40, unit: "PT" } },
      transform: { scaleX: 1, scaleY: 1, translateX: 457_200, translateY: 228_600, unit: "EMU" },
      shape: {
        shapeType: "TEXT_BOX",
        placeholder: { type: "TITLE" },
        text: { textElements: [{ textRun: { content: "Q3   revenue\n" } }, { textRun: { content: "by region\n" } }] },
      },
    },
    {
      objectId: "g_photo",
      // A 100x100 pt square rotated 90 degrees about the origin then moved: its box stays 100x100 pt.
      size: { width: { magnitude: 1_270_000, unit: "EMU" }, height: { magnitude: 1_270_000, unit: "EMU" } },
      transform: { scaleX: 0, scaleY: 0, shearX: -1, shearY: 1, translateX: 2_540_000, translateY: 1_270_000, unit: "EMU" },
      image: {},
      description: "team photo",
    },
    {
      objectId: "g_group",
      transform: { scaleX: 1, scaleY: 1, translateX: 914_400, translateY: 0, unit: "EMU" },
      elementGroup: {
        children: [
          {
            objectId: "g_child_a",
            size: { width: { magnitude: 914_400, unit: "EMU" }, height: { magnitude: 914_400, unit: "EMU" } },
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 914_400, unit: "EMU" },
            shape: { shapeType: "ELLIPSE" },
          },
          {
            objectId: "g_child_b",
            size: { width: { magnitude: 914_400, unit: "EMU" }, height: { magnitude: 914_400, unit: "EMU" } },
            transform: { scaleX: 2, scaleY: 1, translateX: 914_400, translateY: 1_828_800, unit: "EMU" },
            shape: { shapeType: "RECTANGLE" },
          },
        ],
      },
    },
  ],
};

const PAGE_SIZE: slides_v1.Schema$Size = {
  width: { magnitude: 9_144_000, unit: "EMU" },
  height: { magnitude: 5_143_500, unit: "EMU" },
};

describe("slide_structure", () => {
  const structure = slideStructureOf({
    presentationId: "deck-1",
    slideObjectId: "g_slide_7",
    slideNumber: 3,
    pageSize: PAGE_SIZE,
    page: PAGE,
  });

  test("every top-level element, back to front, with its z-order position", () => {
    assert.deepEqual(
      structure.elements.map((element) => [element.objectId, element.zOrder, element.kind]),
      [
        ["g_bg", 0, "shape:RECTANGLE"],
        ["g_title", 1, "shape:TEXT_BOX"],
        ["g_photo", 2, "image"],
        ["g_group", 3, "group:2"],
      ],
    );
    assert.deepEqual(structure.frame, { w: 1280, h: 720 });
  });

  test("boxes are px on the 1280x720 frame: PT and EMU sizes, rotation and groups all resolved", () => {
    const boxOf = (objectId: string) => structure.elements.find((element) => element.objectId === objectId)?.box;
    assert.deepEqual(boxOf("g_bg"), { x: 0, y: 0, w: 1280, h: 720 });
    assert.deepEqual(boxOf("g_title"), { x: 64, y: 32, w: 640, h: 71.1 });
    // Rotated a quarter turn: the square's corners land left of the translate, the box keeps its size.
    assert.deepEqual(boxOf("g_photo"), { x: 177.8, y: 177.8, w: 177.8, h: 177.8 });
    // Children are relative to the group (moved 1 in right): a 1 in circle and a 2x1 in box below it.
    assert.deepEqual(boxOf("g_group"), { x: 128, y: 128, w: 384, h: 256 });
  });

  test("text is collapsed into an excerpt, a placeholder is named, and an image falls back to its alt text", () => {
    const title = structure.elements.find((element) => element.objectId === "g_title");
    assert.equal(title?.text, "Q3 revenue by region");
    assert.equal(title?.placeholder, "TITLE");
    assert.equal(structure.elements.find((element) => element.objectId === "g_photo")?.text, "team photo");
    assert.equal(structure.elements.find((element) => element.objectId === "g_bg")?.text, null);
  });

  test("the tool payload: the listing on success, and Google's own reason when the deck cannot be read", () => {
    const ok = slideStructurePayload({
      presentationId: "deck-1",
      read: { kind: "ok", slideObjectId: "g_slide_7", slideNumber: 3, pageSize: PAGE_SIZE, page: PAGE },
    });
    assert.equal(ok.kind === "payload" ? ok.payload.elements.length : ok.kind, 4);
    const refused = slideStructurePayload({
      presentationId: "deck-1",
      read: { kind: "unavailable", reason: "The caller does not have permission" },
    });
    assert.match(refused.kind === "error" ? refused.message : "", /does not have permission/);
  });

  test("the slide is named by exactly one of slideObjectId and slideNumber", () => {
    assert.deepEqual(slideSelectorFrom({ slideObjectId: "g_slide_7", slideNumber: undefined }), {
      kind: "ok",
      selector: { kind: "object-id", objectId: "g_slide_7" },
    });
    assert.deepEqual(slideSelectorFrom({ slideObjectId: undefined, slideNumber: 3 }), {
      kind: "ok",
      selector: { kind: "number", number: 3 },
    });
    assert.equal(slideSelectorFrom({ slideObjectId: "g", slideNumber: 3 }).kind, "error");
    assert.equal(slideSelectorFrom({ slideObjectId: undefined, slideNumber: undefined }).kind, "error");
  });
});
