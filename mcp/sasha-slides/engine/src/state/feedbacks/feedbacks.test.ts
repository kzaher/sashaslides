// Acceptance tests 13, 14 and 15, through the real editor system over fake stores and a virtual-time
// scheduler: comments are encoded and submitted, uploads retry and time out on the scheduler, notices
// expire on it, and an undo that skipped steps says so.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { of } from "rxjs";
import type { AssetId, AssetStore, ChosenImageFile, EditorEvent, EditorState, LocalPresence, Modifiers, PeerPresence, PresenceChannel } from "../../contracts/index.ts";
import { COLLABORATOR_CHANGED_MESSAGE } from "../editor/document-changes.ts";
import { reduceEditor } from "../editor/reduce-editor.ts";
import { editorStateFor, elementId, shape, slide, slideId, testDocument, textBody } from "../testing/document-fixtures.ts";
import { createEditorHarness, flushPromises } from "../testing/editor-harness.ts";
import { createFakeAssetStore, type PutBehaviour } from "../testing/fake-stores.ts";
import { assetAvailabilityFeedback, uploadBackoffMilliseconds } from "./scheduled-feedbacks.ts";

const SLIDE = slideId("slide_one");
const TEXT = elementId("shape_text");
const document = testDocument({ slides: [slide({ id: "slide_one", elements: [shape({ id: "shape_text", x: 100, y: 100, width: 400, height: 80, text: textBody("Hello world") })] })] });
const twoSlides = testDocument({ slides: [slide({ id: "slide_one", elements: [] }), slide({ id: "slide_two", elements: [] })] });

// Content addresses are lowercase SHA-256 hexadecimal; this one is a fixed 64-digit stand-in.
const STORED_ASSET = "a".repeat(64) as AssetId;

const PHOTO: ChosenImageFile = { name: "photo.png", mediaType: "image/png", bytes: new ArrayBuffer(16), pixelWidth: 800, pixelHeight: 600 };
const PRIMARY_ALT: Modifiers = { primary: true, alt: true, shift: false };

describe("discussion requests (acceptance 13)", () => {
  it("queues a createThread draft, encodes its text anchor, submits it, and a rejection raises a notice", async () => {
    using harness = createEditorHarness({ document });
    harness.dispatch({ kind: "textEditingRequested", target: { kind: "element", slideId: SLIDE, elementId: TEXT }, at: { index: 0 } });
    harness.dispatch({ kind: "textSelectionChanged", anchor: 0, focus: 5 });
    harness.dispatch({ kind: "keyPressed", chord: { key: "m", code: "KeyM", modifiers: PRIMARY_ALT } });
    harness.dispatch({ kind: "commentDraftChanged", draft: "Typo here?" });
    harness.dispatch({ kind: "commentSubmitted" });

    assert.deepEqual(harness.state().pendingDiscussion, [], "the feedback reported it sent");
    const queued = harness.state().inFlightDiscussion;
    assert.equal(queued.length, 1);
    const command = queued[0]?.command;
    assert.equal(command?.kind, "createThread");
    if (command?.kind !== "createThread") return;
    assert.deepEqual(command.target, {
      kind: "text",
      elementId: TEXT,
      range: { target: { kind: "element", slideId: SLIDE, elementId: TEXT }, start: 0, end: 5 },
      quotedText: "Hello",
    });
    assert.deepEqual(command.elementFrameAtCreation, { x: 100, y: 100, width: 400, height: 80 });

    const submitted = harness.discussionStore.submitted();
    assert.equal(submitted.length, 1);
    const sent = submitted[0]?.command;
    assert.equal(sent?.kind === "createThread" ? sent.anchor.target.kind : null, "text");
    assert.deepEqual(sent?.kind === "createThread" && sent.anchor.target.kind === "text" ? { start: sent.anchor.target.anchor.start, end: sent.anchor.target.anchor.end } : null, { start: "0", end: "5" });

    harness.dispatch({ kind: "resolvedThreadsToggled" });
    assert.equal(harness.state().inFlightDiscussion.length, 1);
    assert.equal(harness.discussionStore.submitted().length, 1, "moving to in flight never submits twice");

    const requestId = queued[0]?.requestId;
    assert.ok(requestId !== undefined);
    harness.discussionStore.settle({ kind: "rejected", requestId, reason: "notPermitted", message: "comments are closed" });
    await flushPromises();
    assert.deepEqual(harness.state().inFlightDiscussion, []);
    assert.ok(harness.state().notices.some((notice) => notice.message.includes("comments are closed")));
  });
});

describe("uploads and notices on the scheduler (acceptance 14)", () => {
  it("times out each attempt after 20 seconds and retries 3 attempts with doubling backoff", async () => {
    using harness = createEditorHarness({ document, putBehaviours: ["neverSettles"] });
    harness.dispatch({ kind: "imageFilesChosen", files: [PHOTO], at: null, destination: "newImage" });
    await flushPromises();
    const attempt = (): number | undefined => harness.state().uploads[0]?.attempt;
    assert.deepEqual(harness.assetStore.putCalls(), [0]);

    harness.scheduler.advanceBy(19_999);
    assert.equal(attempt(), 1);
    harness.scheduler.advanceBy(1);
    assert.equal(attempt(), 2, "the first attempt timed out at 20 seconds");
    harness.scheduler.advanceBy(uploadBackoffMilliseconds(1) - 1);
    assert.deepEqual(harness.assetStore.putCalls(), [0]);
    harness.scheduler.advanceBy(1);
    assert.deepEqual(harness.assetStore.putCalls(), [0, 20_500]);

    harness.scheduler.advanceBy(20_000 + uploadBackoffMilliseconds(2));
    assert.deepEqual(harness.assetStore.putCalls(), [0, 20_500, 41_500]);
    assert.equal(attempt(), 3);

    harness.scheduler.advanceBy(20_000);
    const failure = harness.state().notices.find((notice) => notice.action?.kind === "retryUpload");
    assert.ok(failure !== undefined, "the last timeout gives up with a retry notice");
    assert.equal(failure.tone, "error");
    harness.scheduler.advanceBy(600_000);
    assert.deepEqual(harness.assetStore.putCalls(), [0, 20_500, 41_500], "no fourth attempt");
    assert.ok(harness.state().notices.includes(failure), "an error notice does not expire");
  });

  const outcomeRows = [
    { name: "succeeds at once", behaviours: [{ resolvesWith: STORED_ASSET }], expectedCalls: [0] },
    { name: "succeeds on the third attempt after two refusals", behaviours: ["rejects", "rejects", { resolvesWith: STORED_ASSET }], expectedCalls: [0, 500, 1500] },
  ] as const satisfies readonly Readonly<{ name: string; behaviours: readonly PutBehaviour[]; expectedCalls: readonly number[] }>[];
  for (const row of outcomeRows) {
    it(`an upload that ${row.name} becomes one envelope inserting the image`, async () => {
      using harness = createEditorHarness({ document, putBehaviours: row.behaviours });
      harness.dispatch({ kind: "imageFilesChosen", files: [PHOTO], at: { x: 640, y: 360 }, destination: "newImage" });
      for (let step = 0; step < 4; step += 1) {
        await flushPromises();
        harness.scheduler.advanceBy(uploadBackoffMilliseconds(step + 1));
      }
      await flushPromises();
      assert.deepEqual(harness.assetStore.putCalls(), row.expectedCalls);
      assert.deepEqual(harness.state().uploads, []);
      const inserted = harness.documentStore.appliedEnvelopes().flatMap((envelope) => envelope.commands.map((command) => command.kind));
      assert.deepEqual(inserted, ["registerAsset", "insertElements"]);
      const image = harness.state().document.slides[0]?.elements.at(-1);
      assert.equal(image?.kind, "image");
      assert.deepEqual(harness.state().selection, { kind: "elements", slideId: SLIDE, elementIds: image === undefined ? [] : [image.id] });
    });
  }

  it("an information notice expires on the scheduler", () => {
    using harness = createEditorHarness({ document });
    harness.dispatch({ kind: "clipboardUnavailable", operation: "paste" });
    assert.equal(harness.state().notices.length, 1);
    harness.scheduler.advanceBy(5_999);
    assert.equal(harness.state().notices.length, 1);
    harness.scheduler.advanceBy(1);
    assert.equal(harness.state().notices.length, 0);
  });

  it("a notice dismissed before it expires takes its timer with it", () => {
    using harness = createEditorHarness({ document });
    harness.dispatch({ kind: "clipboardUnavailable", operation: "copy" });
    const notice = harness.state().notices[0];
    assert.ok(notice !== undefined);
    harness.dispatch({ kind: "noticeDismissed", noticeId: notice.id });
    assert.equal(harness.scheduler.pendingCount(), 0);
  });
});

describe("undo against collaborators (acceptance 15)", () => {
  const rows = [
    { name: "skipped 2 steps", outcome: { kind: "applied", revision: 1, selection: { kind: "none" }, skippedSteps: 2 }, expectsNotice: true },
    { name: "found nothing to undo after skipping 1", outcome: { kind: "nothingToDo", skippedSteps: 1 }, expectsNotice: true },
    { name: "skipped nothing (control)", outcome: { kind: "applied", revision: 1, selection: { kind: "none" }, skippedSteps: 0 }, expectsNotice: false },
  ] as const;
  for (const row of rows) {
    it(`an undo that ${row.name}`, () => {
      using harness = createEditorHarness({ document });
      harness.documentStore.queueHistoryOutcome(row.outcome);
      const undo: EditorEvent = { kind: "undoRequested" };
      harness.dispatch(undo);
      assert.deepEqual(harness.state().pendingEdits, []);
      assert.equal(harness.state().notices.some((notice) => notice.message.includes(COLLABORATOR_CHANGED_MESSAGE)), row.expectsNotice);
    });
  }
});

describe("presence and asset availability", () => {
  it("publishes this editor's presence at most once per 50 milliseconds, the last state included", () => {
    const published: Readonly<{ at: number; presence: LocalPresence }>[] = [];
    const listener: { current: ((peers: readonly PeerPresence[]) => void) | null } = { current: null };
    let clock = (): number => 0;
    const channel: PresenceChannel = {
      publish: (presence) => published.push({ at: clock(), presence }),
      subscribe: (onPeers) => {
        listener.current = onPeers;
        return { [Symbol.dispose]: () => (listener.current = null) };
      },
    };
    using harness = createEditorHarness({ document: twoSlides, presence: channel });
    clock = () => harness.scheduler.now();
    const before = published.length;
    harness.dispatch({ kind: "slideActivated", slideId: slideId("slide_two") });
    harness.dispatch({ kind: "slideActivated", slideId: SLIDE });
    harness.dispatch({ kind: "slideActivated", slideId: slideId("slide_two") });
    harness.scheduler.advanceBy(49);
    assert.equal(published.length, before, "nothing more inside the window");
    harness.scheduler.advanceBy(1);
    assert.equal(published.length, before + 1);
    assert.equal(published.at(-1)?.presence.slideId, slideId("slide_two"));

    listener.current?.([]);
    assert.deepEqual(harness.state().peers, []);
  });

  // Collaborators see a hovering cursor, not only a dragging one; the control row (the pointer left
  // the canvas) publishes none.
  for (const row of [
    { name: "a hover with no gesture publishes the pointer", leaves: false, expected: { x: 320, y: 180 } },
    { name: "control: after the pointer leaves, none is published", leaves: true, expected: null },
  ] as const) {
    it(row.name, () => {
      const published: LocalPresence[] = [];
      const channel: PresenceChannel = { publish: (presence) => published.push(presence), subscribe: () => ({ [Symbol.dispose]: () => undefined }) };
      using harness = createEditorHarness({ document: twoSlides, presence: channel });
      harness.dispatch({ kind: "canvasPointerMove", sample: { slidePoint: { x: 320, y: 180 }, clientPoint: { x: 320, y: 180 } }, modifiers: { shift: false, alt: false, primary: false } });
      if (row.leaves) harness.dispatch({ kind: "canvasPointerLeft" });
      harness.scheduler.advanceBy(100);
      assert.equal(harness.state().gesture.kind, "idle");
      assert.deepEqual(published.at(-1)?.pointer, row.expected);
    });
  }

  // An effect with no outcome event of its own reports its failure as `feedbackFailed`, which the
  // reducer turns into a notice; the control row's check simply finds no bytes and says nothing.
  for (const row of [
    { name: "an asset check that throws reports feedbackFailed and raises a notice", throws: true, expectedKinds: ["feedbackFailed"], expectedNotices: 1 },
    { name: "control: an asset check that finds no bytes reports nothing", throws: false, expectedKinds: [], expectedNotices: 0 },
  ] as const) {
    it(row.name, () => {
      const withAsset: EditorState = editorStateFor({ ...document, assets: [{ id: STORED_ASSET, mediaType: "image/png", pixelWidth: 1, pixelHeight: 1, name: "photo.png", byteLength: 1 }] });
      const assetStore = createFakeAssetStore({ behaviours: ["neverSettles"], now: () => 0 });
      const checking: AssetStore = {
        ...assetStore,
        addressFor: (assetId) => {
          if (row.throws) throw new Error("storage is unreadable");
          return assetStore.addressFor(assetId);
        },
      };
      const events: EditorEvent[] = [];
      assetAvailabilityFeedback({ assetStore: checking, reportError: () => undefined })(of(withAsset)).subscribe((event) => events.push(event));
      assert.deepEqual(events.map((event) => event.kind), row.expectedKinds);
      const reduced = events.reduce(reduceEditor, withAsset);
      assert.equal(reduced.notices.length, row.expectedNotices);
      if (row.throws) assert.match(reduced.notices[0]?.message ?? "", /Loading an image failed: storage is unreadable/);
    });
  }

  it("an asset whose bytes become loadable is marked available", () => {
    using harness = createEditorHarness({ document });
    harness.assetStore.makeAvailable(STORED_ASSET, "blob:stored");
    assert.ok(harness.state().availableAssetIds.has(STORED_ASSET));
  });
});
