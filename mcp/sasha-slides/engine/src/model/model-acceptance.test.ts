// The model's acceptance tests, numbered as the architect listed them (SPEC.md section 18). Each
// runs the real store on real Y.Docs; replicas talk through `connectInMemory`, and time and
// randomness are injected, so every run is the same run.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import type {
  CommandEnvelope,
  DocumentChange,
  DiscussionCommand,
  DiscussionLogEntry,
  DocumentCommand,
  DocumentCommandKind,
  DocumentSnapshot,
  DocumentStore,
  ElementId,
  ElementSnapshot,
  Frame,
  SlideId,
  SlideSnapshot,
  TableColumnId,
  TableRowId,
  TextTarget,
} from "../contracts/index.ts";
import {
  PLACEHOLDER_ROLES,
  plainText,
  scriptFingerprint,
  tableCellKey,
  textTargetKey,
  themeColour,
} from "../contracts/index.ts";
import { connectInMemory, createMemoryAssetStore, createMemoryDiscussionStore, reduceDiscussionLog } from "./index.ts";
import { childMap, documentRoots, elementMapOf, textOf } from "./document-paths.ts";
import { flattenElements } from "./element-tree.ts";
import { paragraphMarkAttributes, runInsertAttributes } from "./text-body.ts";
import {
  ALICE,
  applyOrThrow,
  assetRecord,
  box,
  CLAUDE,
  createTestStore,
  elementId,
  envelope,
  group,
  idMinter,
  image,
  line,
  personId,
  seededRandom,
  shape,
  table,
  textBody,
  type TestStore,
} from "./testing/model-fixtures.ts";

const mint = idMinter("Fixture1");

/** The fixture every table row starts from: the blank deck plus one of each element kind. */
type Fixture = Readonly<{
  slideId: SlideId;
  shapeId: ElementId;
  lineId: ElementId;
  imageId: ElementId;
  tableId: ElementId;
  groupId: ElementId;
  memberIds: readonly ElementId[];
  rowIds: readonly TableRowId[];
  columnIds: readonly TableColumnId[];
}>;

function buildFixture(store: DocumentStore): Fixture {
  const slideId = firstSlide(store.snapshot()).id;
  const fixture: Fixture = {
    slideId,
    shapeId: mint("element"),
    lineId: mint("element"),
    imageId: mint("element"),
    tableId: mint("element"),
    groupId: mint("element"),
    memberIds: [mint("element"), mint("element")],
    rowIds: [mint("tableRow"), mint("tableRow")],
    columnIds: [mint("tableColumn"), mint("tableColumn")],
  };
  const asset = assetRecord("asset0000photo");
  applyOrThrow(
    store,
    envelope({
      commands: [
        { kind: "registerAsset", asset },
        {
          kind: "insertElements",
          slideId,
          placement: { kind: "front" },
          elements: [
            shape({ id: fixture.shapeId, text: textBody("Hello world") }),
            line({ id: fixture.lineId }),
            image({ id: fixture.imageId, assetId: asset.id }),
            table({ id: fixture.tableId, rows: fixture.rowIds, columns: fixture.columnIds }),
            group({
              id: fixture.groupId,
              children: fixture.memberIds.map((id, index) => shape({ id, frame: box({ x: 600 + 120 * index, y: 500, width: 100, height: 80 }) })),
            }),
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

function elementOf(snapshot: DocumentSnapshot, slideId: SlideId, elementId: ElementId): ElementSnapshot {
  const slide = snapshot.slides.find((candidate) => candidate.id === slideId);
  const element = slide === undefined ? undefined : flattenElements(slide.elements).get(elementId);
  if (element === undefined) throw new Error(`element ${elementId} is not in the snapshot`);
  return element;
}

function maybeElement(snapshot: DocumentSnapshot, slideId: SlideId, elementId: ElementId): ElementSnapshot | undefined {
  const slide = snapshot.slides.find((candidate) => candidate.id === slideId);
  return slide === undefined ? undefined : flattenElements(slide.elements).get(elementId);
}

function bodyText(snapshot: DocumentSnapshot, slideId: SlideId, elementId: ElementId): string {
  const element = elementOf(snapshot, slideId, elementId);
  if (element.kind !== "shape") throw new Error("not a shape");
  return plainText({ body: element.text, slideNumber: null });
}

function insertText(options: Readonly<{ target: TextTarget; index: number; text: string; revision: number }>): DocumentCommand {
  return { kind: "editText", target: options.target, basedOnRevision: options.revision, operations: [{ kind: "insert", index: options.index, text: options.text, style: {} }] };
}

/**
 * Two replicas of one deck, synchronised and then disconnected. A created the deck; B joined and
 * built the fixture, so A's own undo history starts empty and every step on it is the test's.
 */
function twoReplicas(): Readonly<{ first: TestStore; second: TestStore; fixture: Fixture; connect: () => Disposable }> {
  const first = createTestStore({ seed: "blankDeck", randomSeed: 11 });
  const second = createTestStore({ seed: "none", randomSeed: 12 });
  const connect = (): Disposable => connectInMemory({ first: first.sharedDocument, second: second.sharedDocument });
  connect()[Symbol.dispose]();
  const fixture = buildFixture(second.store);
  connect()[Symbol.dispose]();
  return { first, second, fixture, connect };
}

function withoutRevision(snapshot: DocumentSnapshot): DocumentSnapshot {
  return { ...snapshot, revision: 0 };
}

describe("model acceptance", () => {
  test("1. seeding blankDeck gives the deck id, a complete theme, layouts and one title slide, and no issues", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const snapshot = store.snapshot();
    assert.equal(snapshot.deckId, "dk_testDeck01");
    assert.deepEqual(Object.keys(snapshot.theme.placeholderStyles).sort(), [...PLACEHOLDER_ROLES].sort());
    assert.ok(snapshot.layouts.length >= 2);
    assert.equal(snapshot.slides.length, 1);
    const slide = firstSlide(snapshot);
    assert.equal(slide.layoutId, snapshot.layouts[0]?.id);
    assert.deepEqual(slide.elements.map((element) => element.placeholder?.role), ["centredTitle", "subtitle"]);
    assert.deepEqual(store.validate(), []);
  });

  describe("2. every command kind applies in one transaction", () => {
    type Row = Readonly<{
      setup?: (fixture: Fixture, store: DocumentStore) => readonly DocumentCommand[];
      commands: (fixture: Fixture, store: DocumentStore) => readonly DocumentCommand[];
      author?: CommandEnvelope["author"];
      expect: (snapshot: DocumentSnapshot, fixture: Fixture) => void;
    }>;
    const newSlide = (id: SlideId): SlideSnapshot => ({ id, layoutId: null, background: null, skipped: false, speakerNotes: textBody(""), transition: null, elements: [] });
    const scriptId = mint("transitionScript");
    const draft = { id: scriptId, name: "Ink wipe", description: "", script: "sashaTransition.define({})", stylesheet: "", markup: "", defaultParameters: {} };
    const extraSlideOne = mint("slide");
    const extraSlideTwo = mint("slide");
    const extraLayout = mint("layout");
    const rows: Readonly<Record<DocumentCommandKind, Row>> = {
      setTitle: { commands: () => [{ kind: "setTitle", title: "Quarterly review" }], expect: (snapshot) => assert.equal(snapshot.title, "Quarterly review") },
      updateTheme: { commands: () => [{ kind: "updateTheme", patch: { name: "Night" } }], expect: (snapshot) => assert.equal(snapshot.theme.name, "Night") },
      upsertLayout: {
        commands: () => [{ kind: "upsertLayout", layout: { id: extraLayout, name: "Custom", background: null, elements: [shape({ id: mint("element") })] } }],
        expect: (snapshot) => assert.equal(snapshot.layouts.find((layout) => layout.id === extraLayout)?.elements.length, 1),
      },
      deleteLayout: {
        commands: (_fixture, store) => [{ kind: "deleteLayout", layoutId: store.snapshot().layouts.at(-1)?.id ?? extraLayout }],
        expect: (snapshot) => assert.equal(snapshot.layouts.length, 4),
      },
      registerAsset: {
        commands: () => [{ kind: "registerAsset", asset: assetRecord("asset0000second") }],
        expect: (snapshot) => assert.ok(snapshot.assets.some((asset) => asset.id === assetRecord("asset0000second").id)),
      },
      upsertTransitionScript: {
        commands: () => [{ kind: "upsertTransitionScript", script: draft, basedOnUpdatedAt: null, approval: "authorDecides" }],
        expect: (snapshot) => assert.equal(snapshot.transitionScripts.find((script) => script.id === scriptId)?.approval.kind, "approved"),
      },
      deleteTransitionScript: {
        setup: () => [{ kind: "upsertTransitionScript", script: draft, basedOnUpdatedAt: null, approval: "authorDecides" }],
        commands: () => [{ kind: "deleteTransitionScript", scriptId }],
        expect: (snapshot) => assert.equal(snapshot.transitionScripts.length, 0),
      },
      approveTransitionScript: {
        setup: () => [{ kind: "upsertTransitionScript", script: draft, basedOnUpdatedAt: null, approval: "authorDecides" }],
        commands: () => [{ kind: "approveTransitionScript", scriptId, fingerprint: scriptFingerprint(draft) }],
        expect: (snapshot) => assert.equal(snapshot.transitionScripts[0]?.approval.kind, "approved"),
      },
      insertSlides: {
        commands: (fixture) => [{ kind: "insertSlides", slides: [newSlide(extraSlideOne)], after: fixture.slideId }],
        expect: (snapshot, fixture) => assert.deepEqual(snapshot.slides.map((slide) => slide.id), [fixture.slideId, extraSlideOne]),
      },
      deleteSlides: { commands: (fixture) => [{ kind: "deleteSlides", slideIds: [fixture.slideId] }], expect: (snapshot) => assert.equal(snapshot.slides.length, 0) },
      moveSlides: {
        setup: (fixture) => [{ kind: "insertSlides", slides: [newSlide(extraSlideOne), newSlide(extraSlideTwo)], after: fixture.slideId }],
        commands: () => [{ kind: "moveSlides", slideIds: [extraSlideTwo], after: null }],
        expect: (snapshot, fixture) => assert.deepEqual(snapshot.slides.map((slide) => slide.id), [extraSlideTwo, fixture.slideId, extraSlideOne]),
      },
      setSlideProperties: {
        commands: (fixture) => [{ kind: "setSlideProperties", slideId: fixture.slideId, patch: { skipped: true } }],
        expect: (snapshot) => assert.equal(firstSlide(snapshot).skipped, true),
      },
      insertElements: {
        commands: (fixture) => [{ kind: "insertElements", slideId: fixture.slideId, elements: [shape({ id: mint("element") })], placement: { kind: "back" } }],
        expect: (snapshot) => assert.equal(firstSlide(snapshot).elements[0]?.kind, "shape"),
      },
      deleteElements: {
        commands: (fixture) => [{ kind: "deleteElements", slideId: fixture.slideId, elementIds: [fixture.groupId] }],
        expect: (snapshot, fixture) => {
          assert.equal(maybeElement(snapshot, fixture.slideId, fixture.groupId), undefined);
          assert.equal(maybeElement(snapshot, fixture.slideId, fixture.memberIds[0] ?? fixture.groupId), undefined);
        },
      },
      setFrames: {
        commands: (fixture) => [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.shapeId, frame: box({ x: 5, y: 6, width: 7, height: 8 }) }] }],
        expect: (snapshot, fixture) => assert.deepEqual(elementOf(snapshot, fixture.slideId, fixture.shapeId).frame, box({ x: 5, y: 6, width: 7, height: 8 })),
      },
      updateElements: {
        commands: (fixture) => [
          { kind: "updateElements", slideId: fixture.slideId, elementIds: [fixture.shapeId, fixture.lineId], patch: { fill: { kind: "solid", colour: themeColour({ slot: "accent2", alpha: 1 }) }, endArrow: "oval" } },
        ],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.shapeId);
          assert.equal(updated.kind === "shape" ? updated.box.fill.kind : "", "solid");
          const updatedLine = elementOf(snapshot, fixture.slideId, fixture.lineId);
          assert.equal(updatedLine.kind === "line" ? updatedLine.endArrow : "", "oval");
        },
      },
      reorderElements: {
        commands: (fixture) => [{ kind: "reorderElements", slideId: fixture.slideId, elementIds: [fixture.groupId], placement: "back" }],
        expect: (snapshot, fixture) => assert.equal(firstSlide(snapshot).elements[0]?.id, fixture.groupId),
      },
      groupElements: {
        commands: (fixture) => [{ kind: "groupElements", slideId: fixture.slideId, elementIds: [fixture.shapeId, fixture.lineId], groupId: mint("element") }],
        expect: (snapshot, fixture) => assert.notEqual(elementOf(snapshot, fixture.slideId, fixture.shapeId).groupId, null),
      },
      ungroupElements: {
        commands: (fixture) => [{ kind: "ungroupElements", slideId: fixture.slideId, groupIds: [fixture.groupId] }],
        expect: (snapshot, fixture) => {
          assert.equal(maybeElement(snapshot, fixture.slideId, fixture.groupId), undefined);
          assert.deepEqual(firstSlide(snapshot).elements.slice(-2).map((element) => element.id), fixture.memberIds);
        },
      },
      editText: {
        commands: (fixture, store) => [insertText({ target: { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId }, index: 11, text: "!", revision: store.snapshot().revision })],
        expect: (snapshot, fixture) => assert.equal(bodyText(snapshot, fixture.slideId, fixture.shapeId), "Hello world!"),
      },
      insertTableRows: {
        commands: (fixture) => [{ kind: "insertTableRows", slideId: fixture.slideId, elementId: fixture.tableId, rows: [{ id: mint("tableRow"), after: fixture.rowIds[0] ?? null, size: 50 }] }],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.tableId);
          assert.equal(updated.kind === "table" ? updated.cells.length : 0, 6);
        },
      },
      insertTableColumns: {
        commands: (fixture) => [{ kind: "insertTableColumns", slideId: fixture.slideId, elementId: fixture.tableId, columns: [{ id: mint("tableColumn"), after: null, size: 90 }] }],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.tableId);
          assert.equal(updated.kind === "table" ? updated.columns[0]?.width : 0, 90);
        },
      },
      deleteTableRows: {
        commands: (fixture) => [{ kind: "deleteTableRows", slideId: fixture.slideId, elementId: fixture.tableId, rowIds: [fixture.rowIds[0] ?? mint("tableRow")] }],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.tableId);
          assert.equal(updated.kind === "table" ? updated.rows.length : 0, 1);
        },
      },
      deleteTableColumns: {
        commands: (fixture) => [{ kind: "deleteTableColumns", slideId: fixture.slideId, elementId: fixture.tableId, columnIds: [fixture.columnIds[1] ?? mint("tableColumn")] }],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.tableId);
          assert.equal(updated.kind === "table" ? updated.cells.length : 0, 2);
        },
      },
      setTableColumnWidths: {
        commands: (fixture) => [{ kind: "setTableColumnWidths", slideId: fixture.slideId, elementId: fixture.tableId, widths: [{ columnId: fixture.columnIds[0] ?? mint("tableColumn"), width: 200 }] }],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.tableId);
          assert.equal(updated.kind === "table" ? updated.columns[0]?.width : 0, 200);
          assert.equal(updated.frame.width, 320);
        },
      },
      setTableRowHeights: {
        commands: (fixture) => [{ kind: "setTableRowHeights", slideId: fixture.slideId, elementId: fixture.tableId, heights: [{ rowId: fixture.rowIds[1] ?? mint("tableRow"), minimumHeight: 80 }] }],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.tableId);
          assert.equal(updated.kind === "table" ? updated.rows[1]?.minimumHeight : 0, 80);
        },
      },
      updateTableCells: {
        commands: (fixture) => [
          {
            kind: "updateTableCells",
            slideId: fixture.slideId,
            elementId: fixture.tableId,
            cells: [{ rowId: fixture.rowIds[0] ?? mint("tableRow"), columnId: fixture.columnIds[0] ?? mint("tableColumn") }],
            patch: { fill: { kind: "solid", colour: themeColour({ slot: "accent3", alpha: 1 }) }, borders: { top: { width: 2, colour: themeColour({ slot: "dark1", alpha: 1 }), dash: "dot" } } },
          },
        ],
        expect: (snapshot, fixture) => {
          const updated = elementOf(snapshot, fixture.slideId, fixture.tableId);
          const cell = updated.kind === "table" ? updated.cells[0] : undefined;
          assert.equal(cell?.fill.kind, "solid");
          assert.equal(cell?.borders.top?.dash, "dot");
          assert.equal(cell?.borders.left, null);
        },
      },
    };

    for (const [kind, row] of Object.entries(rows)) {
      test(kind, () => {
        const { store } = createTestStore({ seed: "blankDeck" });
        const fixture = buildFixture(store);
        if (row.setup !== undefined) applyOrThrow(store, envelope({ commands: row.setup(fixture, store) }));
        const emitted: DocumentChange[] = [];
        const subscription = store.changes.subscribe((change) => emitted.push(change));
        const outcome = store.apply(envelope({ commands: row.commands(fixture, store), author: row.author ?? ALICE }));
        subscription.unsubscribe();
        assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
        assert.equal(emitted.length, 1, "one envelope is one transaction and one change");
        assert.equal(emitted[0]?.origin.kind, "local");
        row.expect(store.snapshot(), fixture);
      });
    }

    test("an envelope with one invalid command writes nothing and returns that rejection", () => {
      const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
      const fixture = buildFixture(store);
      const stateBefore = Y.encodeStateVector(sharedDocument);
      const missing = mint("element");
      const outcome = store.apply(envelope({ commands: [{ kind: "setTitle", title: "Never written" }, { kind: "deleteElements", slideId: fixture.slideId, elementIds: [missing] }] }));
      assert.deepEqual(outcome.kind === "rejected" ? outcome.rejection : null, { reason: "elementMissing", slideId: fixture.slideId, elementId: missing });
      assert.deepEqual(Y.encodeStateVector(sharedDocument), stateBefore);
      assert.notEqual(store.snapshot().title, "Never written");
    });
  });

  test("3. structural sharing: setFrames rebuilds only the moved element and its slide", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const fixture = buildFixture(store);
    applyOrThrow(store, envelope({ commands: [{ kind: "insertSlides", slides: [{ id: mint("slide"), layoutId: null, background: null, skipped: false, speakerNotes: textBody(""), transition: null, elements: [shape({ id: mint("element") })] }], after: fixture.slideId }] }));
    const before = store.snapshot();
    applyOrThrow(store, envelope({ commands: [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.memberIds[0] ?? fixture.shapeId, frame: box({ x: 1, y: 2, width: 30, height: 40 }) }] }] }));
    const after = store.snapshot();
    assert.equal(after.slides[1], before.slides[1], "the untouched slide keeps its identity");
    assert.notEqual(after.slides[0], before.slides[0]);
    const beforeElements = flattenElements(firstSlide(before).elements);
    const afterElements = flattenElements(firstSlide(after).elements);
    const changed = new Set([fixture.memberIds[0], fixture.groupId]);
    for (const [id, element] of afterElements) {
      if (changed.has(id)) assert.notEqual(element, beforeElements.get(id), `${id} changed`);
      else assert.equal(element, beforeElements.get(id), `${id} keeps its identity`);
    }
    assert.equal(after.theme, before.theme);
    assert.equal(after.layouts, before.layouts);
  });

  test("4. a concurrent move and resize converge to exactly one of the two frames", () => {
    const { first, second, fixture, connect } = twoReplicas();
    const moved: Frame = box({ x: 500, y: 300, width: 200, height: 100 });
    const resized: Frame = box({ x: 100, y: 100, width: 420, height: 260 });
    connect()[Symbol.dispose]();
    applyOrThrow(first.store, envelope({ commands: [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.shapeId, frame: moved }] }] }));
    applyOrThrow(second.store, envelope({ commands: [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.shapeId, frame: resized }] }] }));
    using _connection = connect();
    const firstFrame = elementOf(first.store.snapshot(), fixture.slideId, fixture.shapeId).frame;
    const secondFrame = elementOf(second.store.snapshot(), fixture.slideId, fixture.shapeId).frame;
    assert.deepEqual(firstFrame, secondFrame);
    assert.ok([moved, resized].some((frame) => JSON.stringify(frame) === JSON.stringify(firstFrame)), JSON.stringify(firstFrame));
  });

  describe("5. typing merges by the injected clock", () => {
    const rows = [
      { name: "three keystrokes within the window are one step", gaps: [200, 200], undoes: 1, expected: "Hello world" },
      { name: "a keystroke past the window starts a second step", gaps: [200, 700], undoes: 1, expected: "Hello worldab" },
      { name: "two steps take two undos", gaps: [200, 700], undoes: 2, expected: "Hello world" },
    ] as const;
    for (const row of rows) {
      test(row.name, () => {
        const { store, clock } = createTestStore({ seed: "blankDeck" });
        const fixture = buildFixture(store);
        const target: TextTarget = { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId };
        ["a", "b", "c"].forEach((letter, index) => {
          if (index > 0) clock.advance(row.gaps[index - 1] ?? 0);
          applyOrThrow(store, envelope({ commands: [insertText({ target, index: 11 + index, text: letter, revision: store.snapshot().revision })], mergeWithPrevious: true }));
        });
        for (let undo = 0; undo < row.undoes; undo += 1) assert.equal(store.undo().kind, "applied");
        assert.equal(bodyText(store.snapshot(), fixture.slideId, fixture.shapeId), row.expected);
      });
    }
    test("a move right after typing is its own step", () => {
      const { store, clock } = createTestStore({ seed: "blankDeck" });
      const fixture = buildFixture(store);
      const target: TextTarget = { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId };
      applyOrThrow(store, envelope({ commands: [insertText({ target, index: 11, text: "!", revision: store.snapshot().revision })], mergeWithPrevious: true }));
      clock.advance(50);
      const moved = box({ x: 9, y: 9, width: 200, height: 100 });
      applyOrThrow(store, envelope({ commands: [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.shapeId, frame: moved }] }] }));
      store.undo();
      const after = store.snapshot();
      assert.equal(bodyText(after, fixture.slideId, fixture.shapeId), "Hello world!");
      assert.notDeepEqual(elementOf(after, fixture.slideId, fixture.shapeId).frame, moved);
    });
  });

  describe("6. undo restores the selection through other people's edits", () => {
    test("a caret follows a remote insert made before it", () => {
      const { first, second, fixture, connect } = twoReplicas();
      using _connection = connect();
      const target: TextTarget = { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId };
      applyOrThrow(
        first.store,
        envelope({
          commands: [insertText({ target, index: 5, text: "XYZ", revision: first.store.snapshot().revision })],
          selectionBefore: { kind: "text", target, anchor: 5, focus: 5 },
          selectionAfter: { kind: "text", target, anchor: 8, focus: 8 },
        }),
      );
      applyOrThrow(second.store, envelope({ commands: [insertText({ target, index: 0, text: "abc", revision: second.store.snapshot().revision })] }));
      const outcome = first.store.undo();
      assert.deepEqual(outcome.kind === "applied" ? outcome.selection : null, { kind: "text", target, anchor: 8, focus: 8 });
      assert.equal(bodyText(first.store.snapshot(), fixture.slideId, fixture.shapeId), "abcHello world");
    });
    test("the element is selected when the text is gone", () => {
      const { first, second, fixture, connect } = twoReplicas();
      using _connection = connect();
      const rowId = fixture.rowIds[1] ?? mint("tableRow");
      const target: TextTarget = { kind: "tableCell", slideId: fixture.slideId, elementId: fixture.tableId, cell: { rowId, columnId: fixture.columnIds[0] ?? mint("tableColumn") } };
      applyOrThrow(
        first.store,
        envelope({
          commands: [{ kind: "updateElements", slideId: fixture.slideId, elementIds: [fixture.tableId], patch: { name: "Results" } }],
          selectionBefore: { kind: "text", target, anchor: 0, focus: 0 },
        }),
      );
      applyOrThrow(second.store, envelope({ commands: [{ kind: "deleteTableRows", slideId: fixture.slideId, elementId: fixture.tableId, rowIds: [rowId] }] }));
      const outcome = first.store.undo();
      assert.deepEqual(outcome.kind === "applied" ? outcome.selection : null, { kind: "elements", slideId: fixture.slideId, elementIds: [fixture.tableId] });
    });
  });

  describe("7. undo against collaborators reports skipped steps", () => {
    for (const peerOverwrites of [true, false]) {
      test(peerOverwrites ? "a step a peer overwrote is skipped" : "control: an untouched step is undone", () => {
        const { first, second, fixture, connect } = twoReplicas();
        using _connection = connect();
        applyOrThrow(second.store, envelope({ commands: [{ kind: "setTitle", title: "B was here" }] }));
        applyOrThrow(first.store, envelope({ commands: [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.shapeId, frame: box({ x: 1, y: 1, width: 50, height: 50 }) }] }] }));
        if (peerOverwrites) {
          applyOrThrow(second.store, envelope({ commands: [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.shapeId, frame: box({ x: 2, y: 2, width: 60, height: 60 }) }] }] }));
        }
        const outcome = first.store.undo();
        if (peerOverwrites) {
          assert.equal(outcome.kind, "nothingToDo");
          assert.ok(outcome.skippedSteps >= 1);
          assert.deepEqual(elementOf(first.store.snapshot(), fixture.slideId, fixture.shapeId).frame, box({ x: 2, y: 2, width: 60, height: 60 }));
        } else {
          assert.equal(outcome.kind, "applied");
          assert.equal(outcome.skippedSteps, 0);
        }
      });
    }
  });

  test("8. undoing a paste that registered an asset keeps the asset record", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const slideId = firstSlide(store.snapshot()).id;
    const asset = assetRecord("asset0000pasted");
    const imageId = mint("element");
    applyOrThrow(store, envelope({ commands: [{ kind: "registerAsset", asset }, { kind: "insertElements", slideId, elements: [image({ id: imageId, assetId: asset.id })], placement: { kind: "front" } }] }));
    assert.equal(store.undo().kind, "applied");
    const snapshot = store.snapshot();
    assert.equal(maybeElement(snapshot, slideId, imageId), undefined);
    assert.deepEqual(snapshot.assets, [asset]);
  });

  test("9. text changes arrive as deltas keyed by the body, remote and local", () => {
    const { first, second, fixture, connect } = twoReplicas();
    using _connection = connect();
    const target: TextTarget = { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId };
    const seen: DocumentChange[] = [];
    const subscription = first.store.changes.subscribe((change) => seen.push(change));
    applyOrThrow(second.store, envelope({ commands: [insertText({ target, index: 3, text: "xy", revision: second.store.snapshot().revision })] }));
    applyOrThrow(first.store, envelope({ commands: [{ kind: "editText", target, basedOnRevision: first.store.snapshot().revision, operations: [{ kind: "delete", index: 0, length: 2 }] }] }));
    subscription.unsubscribe();
    assert.deepEqual(seen.map((change) => change.origin.kind), ["remote", "local"]);
    assert.deepEqual(seen[0]?.textChanges.get(textTargetKey(target)), [{ kind: "retain", length: 3 }, { kind: "insert", length: 2 }]);
    assert.deepEqual(seen[1]?.textChanges.get(textTargetKey(target)), [{ kind: "delete", length: 2 }]);
  });

  describe("10. text attribute rules", () => {
    const listParagraph = { alignment: "centre", list: { kind: "list", listId: mint("list"), glyph: "disc", level: 0 } } as const;
    for (const row of [
      { name: "rule 1: the complete attribute set leaves typed characters without paragraph keys", rule: true, inherits: false },
      { name: "control: an insert without attributes would inherit the previous mark's", rule: false, inherits: true },
    ]) {
      test(row.name, () => {
        const sharedDocument = new Y.Doc();
        const text = sharedDocument.getText("probe");
        text.insert(0, "Item", runInsertAttributes({}));
        text.insert(4, "\n\n", paragraphMarkAttributes({}));
        // How `formatParagraphs` styles a paragraph: a format over its mark.
        text.format(4, 1, { ...listParagraph });
        if (row.rule) text.insert(5, "ab", runInsertAttributes({}));
        else text.insert(5, "ab");
        const typed = text.toDelta().find((operation: { insert?: unknown }) => typeof operation.insert === "string" && operation.insert.includes("ab"));
        const attributes: Readonly<Record<string, unknown>> = typed?.attributes ?? {};
        assert.equal("alignment" in attributes || "list" in attributes, row.inherits);
      });
    }
    test("rule 1 through the store: typing at a paragraph's start after a centred list paragraph", () => {
      const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
      const fixture = buildFixture(store);
      const target: TextTarget = { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId };
      applyOrThrow(store, envelope({ commands: [{ kind: "editText", target, basedOnRevision: store.snapshot().revision, operations: [
        { kind: "insert", index: 11, text: "\n", style: {} },
        { kind: "formatParagraphs", index: 0, length: 1, patch: listParagraph, clear: [] },
      ] }] }));
      applyOrThrow(store, envelope({ commands: [insertText({ target, index: 12, text: "ab", revision: store.snapshot().revision })] }));
      const text = textOf(documentRoots(sharedDocument), target);
      const typed = text?.toDelta().find((operation: { insert?: unknown }) => typeof operation.insert === "string" && operation.insert.startsWith("ab"));
      assert.ok(typed !== undefined);
      const attributes: Readonly<Record<string, unknown>> = typed.attributes ?? {};
      assert.equal("alignment" in attributes || "list" in attributes, false);
      const element = elementOf(store.snapshot(), fixture.slideId, fixture.shapeId);
      assert.deepEqual(element.kind === "shape" ? element.text.paragraphs.map((paragraph) => paragraph.style.alignment) : [], ["centre", undefined]);
    });
    test("rule 2: splitting a paragraph copies its paragraph attributes to the new mark", () => {
      const { store } = createTestStore({ seed: "blankDeck" });
      const fixture = buildFixture(store);
      const target: TextTarget = { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId };
      applyOrThrow(store, envelope({ commands: [{ kind: "editText", target, basedOnRevision: store.snapshot().revision, operations: [{ kind: "formatParagraphs", index: 0, length: 0, patch: listParagraph, clear: [] }] }] }));
      applyOrThrow(store, envelope({ commands: [insertText({ target, index: 5, text: "\n", revision: store.snapshot().revision })] }));
      const element = elementOf(store.snapshot(), fixture.slideId, fixture.shapeId);
      assert.equal(element.kind, "shape");
      if (element.kind !== "shape") return;
      assert.deepEqual(element.text.paragraphs.map((paragraph) => paragraph.style), [listParagraph, listParagraph]);
      assert.deepEqual(element.text.paragraphs.map((paragraph) => paragraph.runs.map((run) => (run.kind === "text" ? run.text : ""))), [["Hello"], [" world"]]);
    });
    test("rule 3: the snapshot strips cross-namespace keys from old data", () => {
      const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
      const fixture = buildFixture(store);
      const text = textOf(documentRoots(sharedDocument), { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId });
      sharedDocument.transact(() => {
        text?.format(0, 5, { alignment: "centre" });
        text?.format(11, 1, { fontWeight: 700 });
      });
      const element = elementOf(store.snapshot(), fixture.slideId, fixture.shapeId);
      assert.equal(element.kind, "shape");
      if (element.kind !== "shape") return;
      assert.deepEqual(element.text.paragraphs, [{ style: {}, runs: [{ kind: "text", text: "Hello world", style: {} }] }]);
    });
  });

  describe("11. order keys", () => {
    test("two replicas inserting three slides into one gap keep contiguous runs (200 seeds)", () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const first = createTestStore({ seed: "blankDeck", randomSeed: seed });
        const second = createTestStore({ seed: "none", randomSeed: seed + 1000 });
        connectInMemory({ first: first.sharedDocument, second: second.sharedDocument })[Symbol.dispose]();
        const anchor = firstSlide(first.store.snapshot()).id;
        const runs = [idMinter(`RunA${String(seed).padStart(4, "0")}`), idMinter(`RunB${String(seed).padStart(4, "0")}`)];
        const insert = (store: DocumentStore, next: (typeof runs)[number]): readonly SlideId[] => {
          const slides = [next("slide"), next("slide"), next("slide")];
          applyOrThrow(store, envelope({ commands: [{ kind: "insertSlides", slides: slides.map((id) => ({ id, layoutId: null, background: null, skipped: false, speakerNotes: textBody(""), transition: null, elements: [] })), after: anchor }] }));
          return slides;
        };
        const runA = insert(first.store, runs[0] ?? idMinter("Fallback"));
        const runB = insert(second.store, runs[1] ?? idMinter("Fallback"));
        using _connection = connectInMemory({ first: first.sharedDocument, second: second.sharedDocument });
        const order = first.store.snapshot().slides.map((slide) => slide.id);
        assert.deepEqual(second.store.snapshot().slides.map((slide) => slide.id), order, `seed ${seed}`);
        const contiguous = [[anchor, ...runA, ...runB], [anchor, ...runB, ...runA]].some((candidate) => JSON.stringify(candidate) === JSON.stringify(order));
        assert.ok(contiguous, `seed ${seed}: ${order.join(" ")}`);
      }
    });
    test("a key between two equal neighbours re-keys locally", () => {
      const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
      const slideId = firstSlide(store.snapshot()).id;
      const back = mint("element");
      const front = mint("element");
      applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, elements: [shape({ id: back }), shape({ id: front })], placement: { kind: "front" } }] }));
      const roots = documentRoots(sharedDocument);
      sharedDocument.transact(() => {
        elementMapOf(roots, slideId, back)?.set("position", "zz");
        elementMapOf(roots, slideId, front)?.set("position", "zz");
      });
      const middle = mint("element");
      applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, elements: [shape({ id: middle })], placement: { kind: "above", elementId: back } }] }));
      const order = firstSlide(store.snapshot()).elements.map((element) => element.id).slice(-3);
      assert.deepEqual(order, [back, middle, front]);
      const keys = order.map((id) => String(elementMapOf(roots, slideId, id)?.get("position")));
      assert.ok((keys[0] ?? "") < (keys[1] ?? "") && (keys[1] ?? "") < (keys[2] ?? ""), keys.join(" "));
    });
  });

  describe("12. a group cycle from concurrent writes", () => {
    for (const repairPolicy of ["repairAfterTransaction", "reportOnly"] as const) {
      test(repairPolicy, () => {
        const first = createTestStore({ seed: "blankDeck", randomSeed: 3, repairPolicy });
        const slideId = firstSlide(first.store.snapshot()).id;
        const groupOne = elementId("el_groupOne");
        const groupTwo = elementId("el_groupTwo");
        applyOrThrow(
          first.store,
          envelope({ commands: [{ kind: "insertElements", slideId, placement: { kind: "front" }, elements: [
            group({ id: groupOne, children: [shape({ id: mint("element") }), shape({ id: mint("element") })] }),
            group({ id: groupTwo, children: [shape({ id: mint("element") }), shape({ id: mint("element") })] }),
          ] }] }),
        );
        first.scheduler.flush();
        const second = createTestStore({ seed: "none", randomSeed: 4, repairPolicy: "reportOnly" });
        connectInMemory({ first: first.sharedDocument, second: second.sharedDocument })[Symbol.dispose]();
        // The command layer refuses a cycle on one replica; only two concurrent writes can make one.
        first.sharedDocument.transact(() => elementMapOf(documentRoots(first.sharedDocument), slideId, groupOne)?.set("groupId", groupTwo));
        second.sharedDocument.transact(() => elementMapOf(documentRoots(second.sharedDocument), slideId, groupTwo)?.set("groupId", groupOne));
        using _connection = connectInMemory({ first: first.sharedDocument, second: second.sharedDocument });
        const topLevel = firstSlide(first.store.snapshot()).elements.filter((element) => element.kind === "group");
        assert.deepEqual(topLevel.map((element) => element.id), [groupTwo]);
        const top = topLevel[0];
        assert.ok(top?.kind === "group" && top.children.some((child) => child.id === groupOne));
        assert.ok(first.store.validate().some((issue) => issue.problem === "groupCycle"));
        const stateBefore = Y.encodeStateVector(first.sharedDocument);
        first.scheduler.flush();
        if (repairPolicy === "reportOnly") {
          assert.deepEqual(Y.encodeStateVector(first.sharedDocument), stateBefore);
          assert.ok(first.store.validate().some((issue) => issue.problem === "groupCycle" && issue.repair === "none"));
          return;
        }
        assert.ok(!first.store.validate().some((issue) => issue.problem === "groupCycle"));
        assert.equal(elementMapOf(documentRoots(first.sharedDocument), slideId, groupTwo)?.get("groupId"), null);
        assert.equal(elementMapOf(documentRoots(second.sharedDocument), slideId, groupTwo)?.get("groupId"), null, "the repair reached the peer");
      });
    }
  });

  describe("13. ungrouping re-keys the children into the group's place", () => {
    for (const lowChildKeys of [true, false]) {
      test(lowChildKeys ? "children whose keys sort below the back element" : "control: children with ordinary keys", () => {
        const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
        const slideId = firstSlide(store.snapshot()).id;
        const [back, groupId, childOne, childTwo, front] = [mint("element"), mint("element"), mint("element"), mint("element"), mint("element")];
        applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, placement: { kind: "front" }, elements: [
          shape({ id: back }),
          group({ id: groupId, children: [shape({ id: childOne }), shape({ id: childTwo })] }),
          shape({ id: front }),
        ] }] }));
        if (lowChildKeys) {
          const roots = documentRoots(sharedDocument);
          sharedDocument.transact(() => {
            elementMapOf(roots, slideId, childOne)?.set("position", "1");
            elementMapOf(roots, slideId, childTwo)?.set("position", "2");
          });
        }
        applyOrThrow(store, envelope({ commands: [{ kind: "ungroupElements", slideId, groupIds: [groupId] }] }));
        assert.deepEqual(firstSlide(store.snapshot()).elements.map((element) => element.id).slice(-4), [back, childOne, childTwo, front]);
      });
    }
  });

  test("14. values from a newer client project to defaults, are reported, and are never written", () => {
    const { store, sharedDocument, scheduler } = createTestStore({ seed: "blankDeck", repairPolicy: "repairAfterTransaction" });
    const fixture = buildFixture(store);
    const roots = documentRoots(sharedDocument);
    sharedDocument.transact(() => {
      const map = elementMapOf(roots, fixture.slideId, fixture.shapeId);
      map?.set("preset", "superStar");
      map?.set("fill", { kind: "mesh", points: 9 });
    });
    scheduler.flush();
    const element = elementOf(store.snapshot(), fixture.slideId, fixture.shapeId);
    assert.deepEqual(element.unsupportedKeys, ["preset", "fill"]);
    assert.equal(element.kind === "shape" ? element.preset : "", "rectangle");
    assert.deepEqual(element.kind === "shape" ? element.box.fill : null, { kind: "none" });
    const issues = store.validate().filter((issue) => issue.problem === "unsupportedValue");
    assert.deepEqual(issues.map((issue) => [issue.path.split("/").at(-1), issue.repair]), [["fill", "none"], ["preset", "none"]]);
    applyOrThrow(store, envelope({ commands: [{ kind: "setFrames", slideId: fixture.slideId, frames: [{ kind: "box", elementId: fixture.shapeId, frame: box({ x: 3, y: 3, width: 30, height: 30 }) }] }, { kind: "updateElements", slideId: fixture.slideId, elementIds: [fixture.shapeId], patch: { name: "renamed" } }] }));
    scheduler.flush();
    const map = elementMapOf(roots, fixture.slideId, fixture.shapeId);
    assert.equal(map?.get("preset"), "superStar");
    assert.deepEqual(map?.get("fill"), { kind: "mesh", points: 9 });
  });

  test("15. a row and a column inserted concurrently meet in an empty default cell until its first edit", () => {
    const { first, second, fixture, connect } = twoReplicas();
    const rowId = mint("tableRow");
    const columnId = mint("tableColumn");
    applyOrThrow(first.store, envelope({ commands: [{ kind: "insertTableRows", slideId: fixture.slideId, elementId: fixture.tableId, rows: [{ id: rowId, after: fixture.rowIds[1] ?? null, size: 40 }] }] }));
    applyOrThrow(second.store, envelope({ commands: [{ kind: "insertTableColumns", slideId: fixture.slideId, elementId: fixture.tableId, columns: [{ id: columnId, after: fixture.columnIds[1] ?? null, size: 100 }] }] }));
    using _connection = connect();
    const tableElement = elementOf(first.store.snapshot(), fixture.slideId, fixture.tableId);
    assert.equal(tableElement.kind, "table");
    if (tableElement.kind !== "table") return;
    assert.equal(tableElement.cells.length, 9);
    const meeting = tableElement.cells.find((cell) => cell.rowId === rowId && cell.columnId === columnId);
    assert.deepEqual(meeting?.text, { paragraphs: [{ style: {}, runs: [] }] });
    const cells = childMap(elementMapOf(documentRoots(first.sharedDocument), fixture.slideId, fixture.tableId) ?? new Y.Map(), "cells");
    assert.equal(cells?.has(tableCellKey({ rowId, columnId })), false);
    const target: TextTarget = { kind: "tableCell", slideId: fixture.slideId, elementId: fixture.tableId, cell: { rowId, columnId } };
    applyOrThrow(first.store, envelope({ commands: [insertText({ target, index: 0, text: "42", revision: first.store.snapshot().revision })] }));
    assert.equal(cells?.has(tableCellKey({ rowId, columnId })), true);
    const updated = elementOf(second.store.snapshot(), fixture.slideId, fixture.tableId);
    const cell = updated.kind === "table" ? updated.cells.find((candidate) => candidate.rowId === rowId && candidate.columnId === columnId) : undefined;
    assert.equal(cell === undefined ? "" : plainText({ body: cell.text, slideNumber: null }), "42");
  });

  test("16. transition scripts: stale saves, agent saves, person approvals, clock stamps", () => {
    const { store, clock } = createTestStore({ seed: "blankDeck" });
    const scriptId = mint("transitionScript");
    const draft = { id: scriptId, name: "Wipe", description: "", script: "sashaTransition.define({ run() {} })", stylesheet: "", markup: "", defaultParameters: {} };
    clock.set(5_000);
    applyOrThrow(store, envelope({ commands: [{ kind: "upsertTransitionScript", script: draft, basedOnUpdatedAt: null, approval: "authorDecides" }] }));
    const saved = store.snapshot().transitionScripts[0];
    assert.equal(saved?.updatedAt, 5_000);
    assert.deepEqual(saved?.approval, { kind: "approved", approvedBy: personId("pe_alice01"), fingerprint: scriptFingerprint(draft) });

    const stale = store.apply(envelope({ commands: [{ kind: "upsertTransitionScript", script: draft, basedOnUpdatedAt: 4_000, approval: "authorDecides" }] }));
    assert.deepEqual(stale.kind === "rejected" ? stale.rejection : null, { reason: "staleScript", scriptId, basedOnUpdatedAt: 4_000, currentUpdatedAt: 5_000 });

    clock.set(6_000);
    const agentDraft = { ...draft, script: "sashaTransition.define({ async run() {} })" };
    applyOrThrow(store, envelope({ author: CLAUDE, commands: [{ kind: "upsertTransitionScript", script: agentDraft, basedOnUpdatedAt: 5_000, approval: "authorDecides" }] }));
    const byAgent = store.snapshot().transitionScripts[0];
    assert.equal(byAgent?.updatedAt, 6_000);
    assert.deepEqual(byAgent?.approval, { kind: "unapproved" });
    assert.deepEqual(byAgent?.author, { kind: "agent", name: "Claude", agentSessionId: "agentSession1" });

    const agentApproval = store.apply(envelope({ author: CLAUDE, commands: [{ kind: "approveTransitionScript", scriptId, fingerprint: scriptFingerprint(agentDraft) }] }));
    assert.deepEqual(agentApproval.kind === "rejected" ? agentApproval.rejection : null, { reason: "approvalNeedsPerson", scriptId });
    const reviewedOld = store.apply(envelope({ commands: [{ kind: "approveTransitionScript", scriptId, fingerprint: scriptFingerprint(draft) }] }));
    assert.deepEqual(reviewedOld.kind === "rejected" ? reviewedOld.rejection : null, {
      reason: "staleApproval",
      scriptId,
      fingerprint: scriptFingerprint(draft),
      currentFingerprint: scriptFingerprint(agentDraft),
    });
    applyOrThrow(store, envelope({ commands: [{ kind: "approveTransitionScript", scriptId, fingerprint: scriptFingerprint(agentDraft) }] }));
    assert.equal(store.snapshot().transitionScripts[0]?.approval.kind, "approved");
  });

  // The save's `approval` decides, not only the author: the control rows show the author alone
  // (authorDecides) approving a person's save and not an agent's.
  for (const row of [
    { label: "a person, authorDecides", author: "person", saveApproval: "authorDecides", expected: "approved" },
    { label: "a person, unapproved (a paste from another deck)", author: "person", saveApproval: "unapproved", expected: "unapproved" },
    { label: "an agent, authorDecides", author: "agent", saveApproval: "authorDecides", expected: "unapproved" },
    { label: "an agent, unapproved", author: "agent", saveApproval: "unapproved", expected: "unapproved" },
  ] as const) {
    test(`16. a save by ${row.label} is stored ${row.expected}`, () => {
      const { store } = createTestStore({ seed: "blankDeck" });
      const draft = { id: mint("transitionScript"), name: "Wipe", description: "", script: "sashaTransition.define({ run() {} })", stylesheet: "", markup: "", defaultParameters: {} };
      applyOrThrow(store, envelope({ ...(row.author === "agent" ? { author: CLAUDE } : {}), commands: [{ kind: "upsertTransitionScript", script: draft, basedOnUpdatedAt: null, approval: row.saveApproval }] }));
      assert.equal(store.snapshot().transitionScripts[0]?.approval.kind, row.expected);
    });
  }

  describe("17. discussion", () => {
    const alice = { id: personId("pe_alice01"), displayName: "Alice", colourIndex: 0, kind: "person" } as const;
    const bob = { id: personId("pe_bob0001"), displayName: "Bob", colourIndex: 1, kind: "person" } as const;
    const threadId = mint("thread");
    const messageId = mint("message");
    const slideId = mint("slide");
    const created: DiscussionLogEntry = {
      sequence: 1,
      requestId: mint("discussionRequest"),
      actor: alice,
      at: 100,
      command: { kind: "createThread", threadId, anchor: { slideId, target: { kind: "slide" }, region: null, elementFrameAtCreation: null }, markings: [], messageId, body: "Is this right?", mentions: [] },
    };
    for (const row of [
      { name: "a non-author's edit is rejected notAuthor", actor: bob, expected: "rejected" },
      { name: "control: the author's edit is applied", actor: alice, expected: "applied" },
    ] as const) {
      test(row.name, async () => {
        using store = createMemoryDiscussionStore({ actor: row.actor, now: () => 200, initialLog: [created] });
        const outcome = await store.submit({ requestId: mint("discussionRequest"), command: { kind: "editMessage", threadId, messageId, body: "Is this right now?", mentions: [] } });
        assert.equal(outcome.kind, row.expected);
        if (outcome.kind === "rejected") assert.equal(outcome.reason, "notAuthor");
      });
    }
    test("the same log folds to the same snapshot everywhere, and reopen leaves no resolution residue", async () => {
      using store = createMemoryDiscussionStore({ actor: alice, now: () => 300, initialLog: [created] });
      const log: DiscussionLogEntry[] = [created];
      const commands: readonly DiscussionCommand[] = [{ kind: "resolveThread", threadId }, { kind: "reopenThread", threadId }];
      for (const command of commands) {
        const requestId = mint("discussionRequest");
        const outcome = await store.submit({ requestId, command });
        assert.equal(outcome.kind, "applied");
        log.push({ sequence: log.length + 1, requestId, actor: alice, at: 300, command });
      }
      const replicaOne = log.reduce(reduceDiscussionLog, { sequence: 0, threads: [] });
      const replicaTwo = log.reduce(reduceDiscussionLog, { sequence: 0, threads: [] });
      assert.deepEqual(replicaOne, replicaTwo);
      assert.deepEqual(replicaOne, store.snapshot());
      assert.deepEqual(store.snapshot().threads[0]?.status, { kind: "open" });
    });
    test("a text anchor follows the text: [5, 9) becomes [8, 12) after three characters before it", () => {
      const { store } = createTestStore({ seed: "blankDeck" });
      const fixture = buildFixture(store);
      const target: TextTarget = { kind: "element", slideId: fixture.slideId, elementId: fixture.shapeId };
      const anchor = store.encodeTextAnchor({ target, start: 5, end: 9 });
      assert.ok(anchor !== null);
      applyOrThrow(store, envelope({ commands: [insertText({ target, index: 0, text: "abc", revision: store.snapshot().revision })] }));
      assert.deepEqual(store.resolveTextAnchors([anchor]), [{ target, start: 8, end: 12 }]);
    });
  });

  test("18. copyBytesOf returns a fresh buffer every time, and available announces new assets", async () => {
    const assets = createMemoryAssetStore({ createAddress: () => "blob:test", digest: () => Promise.resolve("d1".repeat(32)) });
    const announced: string[] = [];
    const subscription = assets.available.subscribe((assetId) => announced.push(assetId));
    const assetId = await assets.put(new Uint8Array([1, 2, 3, 4]).buffer, "image/png");
    subscription.unsubscribe();
    assert.deepEqual(announced, [assetId]);
    const first = await assets.copyBytesOf(assetId);
    const second = await assets.copyBytesOf(assetId);
    assert.ok(first !== null && second !== null);
    assert.notEqual(first, second);
    structuredClone(first, { transfer: [first] });
    assert.equal(first.byteLength, 0, "transferring detaches the copy");
    const third = await assets.copyBytesOf(assetId);
    assert.deepEqual([...new Uint8Array(third ?? new ArrayBuffer(0))], [1, 2, 3, 4]);
  });

  test("19. three replicas converge under random interleavings (200 seeds, under 30 seconds)", () => {
    const started = performance.now();
    let applied = 0;
    for (let seed = 1; seed <= 200; seed += 1) applied += runConvergence(seed);
    assert.ok(performance.now() - started < 30_000);
    assert.ok(applied > 2_000, `only ${applied} envelopes applied: the run would prove little`);
  });
});

/** One convergence run: three replicas edit at random while links come and go, then all connect. Returns how many envelopes applied. */
function runConvergence(seed: number): number {
  const random = seededRandom(seed);
  const replicas = [0, 1, 2].map((index) =>
    createTestStore({ seed: index === 0 ? "blankDeck" : "none", randomSeed: seed * 3 + index }),
  );
  const [first, second, third] = replicas;
  if (first === undefined || second === undefined || third === undefined) return 0;
  connectInMemory({ first: first.sharedDocument, second: second.sharedDocument })[Symbol.dispose]();
  connectInMemory({ first: second.sharedDocument, second: third.sharedDocument })[Symbol.dispose]();
  const minters = replicas.map((_replica, index) => idMinter(`Rep${index}${String(seed).padStart(4, "0")}`));
  let applied = 0;
  for (let step = 0; step < 24; step += 1) {
    const choice = Math.floor(random() * replicas.length);
    const replica = replicas[choice];
    const minter = minters[choice];
    if (replica === undefined || minter === undefined) continue;
    if (random() < 0.2) {
      const other = replicas[(choice + 1 + Math.floor(random() * 2)) % replicas.length];
      if (other !== undefined) connectInMemory({ first: replica.sharedDocument, second: other.sharedDocument })[Symbol.dispose]();
      continue;
    }
    const commands = randomCommands({ snapshot: replica.store.snapshot(), random, mint: minter });
    if (commands.length > 0 && replica.store.apply(envelope({ commands })).kind === "applied") applied += 1;
    if (random() < 0.1) replica.store.undo();
  }
  using _one = connectInMemory({ first: first.sharedDocument, second: second.sharedDocument });
  using _two = connectInMemory({ first: second.sharedDocument, second: third.sharedDocument });
  const expected = withoutRevision(first.store.snapshot());
  assert.deepEqual(withoutRevision(second.store.snapshot()), expected, `seed ${seed}: first and second differ`);
  assert.deepEqual(withoutRevision(third.store.snapshot()), expected, `seed ${seed}: first and third differ`);
  return applied;
}

function randomCommands(
  options: Readonly<{ snapshot: DocumentSnapshot; random: () => number; mint: ReturnType<typeof idMinter> }>,
): readonly DocumentCommand[] {
  const { snapshot, random, mint: next } = options;
  const pick = <TItem>(items: readonly TItem[]): TItem | undefined => items[Math.floor(random() * items.length)];
  const slide = pick(snapshot.slides);
  if (slide === undefined) {
    return [{ kind: "insertSlides", slides: [{ id: next("slide"), layoutId: null, background: null, skipped: false, speakerNotes: textBody(""), transition: null, elements: [] }], after: null }];
  }
  const elements = [...flattenElements(slide.elements).values()];
  const element = pick(elements);
  const shapes = elements.filter((candidate) => candidate.kind === "shape");
  const topLevel = slide.elements;
  switch (Math.floor(random() * 10)) {
    case 0:
      return [{ kind: "insertSlides", slides: [{ id: next("slide"), layoutId: null, background: null, skipped: false, speakerNotes: textBody(""), transition: null, elements: [] }], after: pick(snapshot.slides)?.id ?? null }];
    case 1:
      return [{ kind: "insertElements", slideId: slide.id, elements: [shape({ id: next("element"), text: textBody("abc") })], placement: { kind: "front" } }];
    case 2:
      return element === undefined || element.kind === "group" || element.kind === "line"
        ? []
        : [{ kind: "setFrames", slideId: slide.id, frames: [{ kind: "box", elementId: element.id, frame: box({ x: Math.floor(random() * 900), y: Math.floor(random() * 500), width: 50 + Math.floor(random() * 300), height: 50 }) }] }];
    case 3: {
      const target = pick(shapes);
      if (target === undefined || target.kind !== "shape") return [];
      const length = target.text.paragraphs.reduce((total, paragraph) => total + paragraph.runs.reduce((sum, run) => sum + (run.kind === "text" ? run.text.length : 1), 0) + 1, 0);
      const index = Math.floor(random() * length);
      return [{ kind: "editText", target: { kind: "element", slideId: slide.id, elementId: target.id }, basedOnRevision: snapshot.revision, operations: [{ kind: "insert", index, text: random() < 0.2 ? "\n" : "xy", style: random() < 0.5 ? {} : { fontWeight: 700 } }] }];
    }
    case 4:
      return element === undefined ? [] : [{ kind: "deleteElements", slideId: slide.id, elementIds: [element.id] }];
    case 5: {
      const members = topLevel.slice(0, 2);
      return members.length < 2 ? [] : [{ kind: "groupElements", slideId: slide.id, elementIds: members.map((member) => member.id), groupId: next("element") }];
    }
    case 6: {
      const grouped = topLevel.find((candidate) => candidate.kind === "group");
      return grouped === undefined ? [] : [{ kind: "ungroupElements", slideId: slide.id, groupIds: [grouped.id] }];
    }
    case 7:
      return element === undefined ? [] : [{ kind: "reorderElements", slideId: slide.id, elementIds: [element.id], placement: pick(["front", "forward", "backward", "back"] as const) ?? "front" }];
    case 8:
      return [{ kind: "moveSlides", slideIds: [slide.id], after: null }];
    default:
      return [{ kind: "setTitle", title: `Title ${Math.floor(random() * 100)}` }];
  }
}
