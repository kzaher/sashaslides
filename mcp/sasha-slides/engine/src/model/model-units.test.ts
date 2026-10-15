// Unit tests for the model's parts beyond the acceptance list: order keys, command rejections,
// repairs, history details, derived frames, the presence hub and the discussion authority.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import type { CommandRejection, DocumentCommand, DocumentStore, ElementId, PeerPresence, SlideId, TextTarget } from "../contracts/index.ts";
import { identityFrame } from "../contracts/index.ts";
import { childMap, documentRoots, elementMapOf, slideMapOf, textOf } from "./document-paths.ts";
import { derivedGroupFrame, flattenElements } from "./element-tree.ts";
import { createMemoryDiscussionStore, createMemoryPresenceHub, reduceDiscussionLog } from "./index.ts";
import { compareOrderedSiblings, isCanonicalOrderKey, mintOrderKeys, planGapKeys, planReorderKeys, type OrderedSibling } from "./order-keys.ts";
import {
  applyOrThrow,
  assetRecord,
  box,
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
} from "./testing/model-fixtures.ts";

const mint = idMinter("Units001");

describe("order keys", () => {
  test("a minted key sits strictly between its neighbours, is no prefix of the upper one and never ends in 0", () => {
    const random = seededRandom(5);
    const cases: readonly (readonly [string | null, string | null])[] = [
      [null, null],
      ["V", null],
      [null, "V"],
      ["V", "W"],
      ["V", "V1"],
      ["Vz", "W"],
      ["0V", "1"],
      ["A", "A0V"],
    ];
    for (const [lower, upper] of cases) {
      for (const count of [1, 3, 70]) {
        const keys = mintOrderKeys({ lower, upper, count, random });
        assert.ok(keys !== null, `${lower} .. ${upper}`);
        assert.equal(keys.length, count);
        keys.forEach((key, index) => {
          assert.ok(isCanonicalOrderKey(key));
          assert.ok(!key.endsWith("0"), key);
          if (lower !== null) assert.ok(lower < key, `${lower} < ${key}`);
          if (upper !== null) assert.ok(key < upper && !upper.startsWith(key), `${key} < ${upper}`);
          if (index > 0) assert.ok((keys[index - 1] ?? "") < key);
        });
      }
    }
  });

  test("no key fits between equal neighbours, or under a neighbour of trailing zeros", () => {
    const random = seededRandom(1);
    assert.equal(mintOrderKeys({ lower: "V", upper: "V", count: 1, random }), null);
    assert.equal(mintOrderKeys({ lower: "V", upper: "V0", count: 1, random }), null);
    assert.equal(mintOrderKeys({ lower: "W", upper: "V", count: 1, random }), null);
  });

  test("a gap between equal keys re-keys the following run; an unusable key renumbers the list in order", () => {
    const random = seededRandom(2);
    const equal: readonly OrderedSibling[] = [{ id: "a", key: "V" }, { id: "b", key: "V" }, { id: "c", key: "k" }];
    const gap = planGapKeys({ siblings: equal, gapIndex: 1, count: 1, random });
    const keyOf = (id: string): string => gap.rekeyed.get(id) ?? equal.find((sibling) => sibling.id === id)?.key ?? "";
    assert.deepEqual([...gap.rekeyed.keys()], ["b"]);
    assert.ok("V" < (gap.inserted[0] ?? "") && (gap.inserted[0] ?? "") < keyOf("b") && keyOf("b") < "k");

    const broken: readonly OrderedSibling[] = [{ id: "a", key: "~" }, { id: "b", key: "V" }];
    const renumbered = planGapKeys({ siblings: broken, gapIndex: 1, count: 1, random });
    const order = [
      { id: "a", key: renumbered.rekeyed.get("a") ?? "" },
      { id: "new", key: renumbered.inserted[0] ?? "" },
      { id: "b", key: renumbered.rekeyed.get("b") ?? "" },
    ];
    assert.deepEqual([...order].sort(compareOrderedSiblings).map((sibling) => sibling.id), ["a", "new", "b"]);
  });

  test("reordering mints keys only for the moved siblings", () => {
    const siblings: readonly OrderedSibling[] = [{ id: "a", key: "F" }, { id: "b", key: "V" }, { id: "c", key: "k" }];
    const order = [siblings[1], siblings[0], siblings[2]].filter((sibling): sibling is OrderedSibling => sibling !== undefined);
    const changes = planReorderKeys({ order, moved: new Set(["b"]), random: seededRandom(3) });
    assert.deepEqual([...changes.keys()], ["b"]);
    assert.ok((changes.get("b") ?? "z") < "F");
  });
});

describe("command rejections", () => {
  type Row = Readonly<{ name: string; commands: (context: Context) => readonly DocumentCommand[]; reason: CommandRejection["reason"] | null }>;
  type Context = Readonly<{ slideId: SlideId; shapeId: ElementId; lineId: ElementId; tableId: ElementId; target: TextTarget; revision: number }>;
  const rows: readonly Row[] = [
    { name: "control: a valid edit", commands: (context) => [{ kind: "editText", target: context.target, basedOnRevision: context.revision, operations: [{ kind: "insert", index: 0, text: "a", style: {} }] }], reason: null },
    { name: "a stale revision", commands: (context) => [{ kind: "editText", target: context.target, basedOnRevision: context.revision - 1, operations: [] }], reason: "staleText" },
    { name: "an insert after the final mark", commands: (context) => [{ kind: "editText", target: context.target, basedOnRevision: context.revision, operations: [{ kind: "insert", index: 4, text: "a", style: {} }] }], reason: "textOutOfRange" },
    { name: "deleting the final mark", commands: (context) => [{ kind: "editText", target: context.target, basedOnRevision: context.revision, operations: [{ kind: "delete", index: 0, length: 4 }] }], reason: "textOutOfRange" },
    {
      name: "an operation out of range after an earlier one in the same edit",
      commands: (context) => [{ kind: "editText", target: context.target, basedOnRevision: context.revision, operations: [{ kind: "delete", index: 0, length: 2 }, { kind: "delete", index: 1, length: 1 }] }],
      reason: "textOutOfRange",
    },
    { name: "a box frame for a line", commands: (context) => [{ kind: "setFrames", slideId: context.slideId, frames: [{ kind: "box", elementId: context.lineId, frame: box({ x: 0, y: 0, width: 5, height: 5 }) }] }], reason: "wrongKind" },
    { name: "an existing element id", commands: (context) => [{ kind: "insertElements", slideId: context.slideId, elements: [shape({ id: context.shapeId })], placement: { kind: "front" } }], reason: "duplicateId" },
    // Deliberately unbranded: the point is an id that fails OBJECT_ID_PATTERN at the boundary.
    { name: "an invalid id", commands: (context) => [{ kind: "insertElements", slideId: context.slideId, elements: [shape({ id: "x" as ElementId })], placement: { kind: "front" } }], reason: "invalidId" },
    { name: "an image of an unregistered asset", commands: (context) => [{ kind: "insertElements", slideId: context.slideId, elements: [image({ id: mint("element"), assetId: assetRecord("assetMissing01").id })], placement: { kind: "front" } }], reason: "assetMissing" },
    {
      name: "an image whose asset the same envelope registers",
      commands: (context) => {
        const asset = assetRecord("assetInEnvelope");
        return [{ kind: "registerAsset", asset }, { kind: "insertElements", slideId: context.slideId, elements: [image({ id: mint("element"), assetId: asset.id })], placement: { kind: "front" } }];
      },
      reason: null,
    },
    { name: "an opacity above one", commands: (context) => [{ kind: "updateElements", slideId: context.slideId, elementIds: [context.shapeId], patch: { opacity: 2 } }], reason: "invalidValue" },
    { name: "a missing table row", commands: (context) => [{ kind: "deleteTableRows", slideId: context.slideId, elementId: context.tableId, rowIds: [mint("tableRow")] }], reason: "tableLineMissing" },
    { name: "a missing slide", commands: () => [{ kind: "setSlideProperties", slideId: mint("slide"), patch: { skipped: true } }], reason: "slideMissing" },
    { name: "a missing layout", commands: (context) => [{ kind: "setSlideProperties", slideId: context.slideId, patch: { layoutId: mint("layout") } }], reason: "layoutMissing" },
    { name: "grouping a single element", commands: (context) => [{ kind: "groupElements", slideId: context.slideId, elementIds: [context.shapeId], groupId: mint("element") }], reason: "invalidValue" },
    {
      name: "editing an element a previous command deleted",
      commands: (context) => [{ kind: "deleteElements", slideId: context.slideId, elementIds: [context.shapeId] }, { kind: "editText", target: context.target, basedOnRevision: context.revision, operations: [] }],
      reason: "elementMissing",
    },
    {
      name: "typing into a table a previous command inserted",
      commands: (context) => {
        const tableId = mint("element");
        const rowId = mint("tableRow");
        const columnId = mint("tableColumn");
        return [
          { kind: "insertElements", slideId: context.slideId, elements: [table({ id: tableId, rows: [rowId], columns: [columnId] })], placement: { kind: "front" } },
          { kind: "editText", target: { kind: "tableCell", slideId: context.slideId, elementId: tableId, cell: { rowId, columnId } }, basedOnRevision: context.revision, operations: [{ kind: "insert", index: 0, text: "1", style: {} }] },
        ];
      },
      reason: null,
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
      const slideId = store.snapshot().slides[0]?.id ?? mint("slide");
      const shapeId = mint("element");
      const lineId = mint("element");
      const tableId = mint("element");
      applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, placement: { kind: "front" }, elements: [shape({ id: shapeId, text: textBody("abc") }), line({ id: lineId }), table({ id: tableId, rows: [mint("tableRow")], columns: [mint("tableColumn")] })] }] }));
      const before = Y.encodeStateVector(sharedDocument);
      const context: Context = { slideId, shapeId, lineId, tableId, target: { kind: "element", slideId, elementId: shapeId }, revision: store.snapshot().revision };
      const outcome = store.apply(envelope({ commands: row.commands(context) }));
      assert.equal(outcome.kind === "rejected" ? outcome.rejection.reason : null, row.reason, JSON.stringify(outcome));
      if (row.reason !== null) assert.deepEqual(Y.encodeStateVector(sharedDocument), before);
    });
  }
});

describe("repairs on the repairing replica", () => {
  function repairing(): Readonly<{ store: DocumentStore; sharedDocument: Y.Doc; flush: () => void; slideId: SlideId }> {
    const { store, sharedDocument, scheduler } = createTestStore({ seed: "blankDeck", repairPolicy: "repairAfterTransaction" });
    return { store, sharedDocument, flush: () => scheduler.flush(), slideId: store.snapshot().slides[0]?.id ?? mint("slide") };
  }

  test("a dangling child moves to the top level where it is shown, in front", () => {
    const { store, sharedDocument, flush, slideId } = repairing();
    const [groupId, childOne, childTwo, front] = [mint("element"), mint("element"), mint("element"), mint("element")];
    applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, placement: { kind: "front" }, elements: [group({ id: groupId, children: [shape({ id: childOne }), shape({ id: childTwo })] }), shape({ id: front })] }] }));
    flush();
    sharedDocument.transact(() => childMap(slideMapOf(documentRoots(sharedDocument), slideId) ?? new Y.Map(), "elements")?.delete(groupId));
    const shown = store.snapshot().slides[0]?.elements.map((element) => element.id).slice(-3);
    assert.deepEqual(shown, [front, childOne, childTwo]);
    assert.ok(store.validate().some((issue) => issue.problem === "danglingReference" && issue.repair === "moveToTopLevel"));
    flush();
    assert.deepEqual(store.snapshot().slides[0]?.elements.map((element) => element.id).slice(-3), shown);
    assert.equal(elementMapOf(documentRoots(sharedDocument), slideId, childOne)?.get("groupId"), null);
    assert.deepEqual(store.validate(), []);
  });

  test("an empty group is deleted and a single-child group dissolves", () => {
    const { store, sharedDocument, flush, slideId } = repairing();
    const [emptyGroup, singleGroup, keep, removeOne, removeTwo] = [mint("element"), mint("element"), mint("element"), mint("element"), mint("element")];
    applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, placement: { kind: "front" }, elements: [
      group({ id: emptyGroup, children: [shape({ id: removeOne }), shape({ id: removeTwo })] }),
      group({ id: singleGroup, children: [shape({ id: keep }), shape({ id: mint("element") })] }),
    ] }] }));
    flush();
    const roots = documentRoots(sharedDocument);
    const elements = childMap(slideMapOf(roots, slideId) ?? new Y.Map(), "elements");
    sharedDocument.transact(() => {
      elements?.delete(removeOne);
      elements?.delete(removeTwo);
      for (const [id, value] of elements?.entries() ?? []) {
        if (value instanceof Y.Map && value.get("groupId") === singleGroup && id !== keep) elements?.delete(id);
      }
    });
    const problems = store.validate().map((issue) => issue.problem).sort();
    assert.deepEqual(problems, ["emptyGroup", "singleChildGroup"]);
    flush();
    assert.equal(elements?.has(emptyGroup), false);
    assert.equal(elements?.has(singleGroup), false);
    assert.equal(elementMapOf(roots, slideId, keep)?.get("groupId"), null);
    assert.deepEqual(store.validate(), []);
  });

  test("missing keys get defaults, a body gets its final mark, duplicate slide keys are re-keyed in order", () => {
    const { store, sharedDocument, flush, slideId } = repairing();
    const shapeId = mint("element");
    const second = mint("slide");
    applyOrThrow(store, envelope({ commands: [
      { kind: "insertElements", slideId, placement: { kind: "front" }, elements: [shape({ id: shapeId, text: textBody("abc") })] },
      { kind: "insertSlides", slides: [{ id: second, layoutId: null, background: null, skipped: false, speakerNotes: textBody(""), transition: null, elements: [] }], after: slideId },
    ] }));
    flush();
    const roots = documentRoots(sharedDocument);
    const order = store.snapshot().slides.map((slide) => slide.id);
    sharedDocument.transact(() => {
      elementMapOf(roots, slideId, shapeId)?.delete("border");
      const text = textOf(roots, { kind: "element", slideId, elementId: shapeId });
      text?.delete(3, 1);
      const key = slideMapOf(roots, slideId)?.get("position");
      slideMapOf(roots, second)?.set("position", key);
    });
    const problems = store.validate().map((issue) => issue.problem).sort();
    assert.deepEqual(problems, ["duplicateOrderKey", "missingKey", "missingParagraphMark"]);
    flush();
    assert.deepEqual(store.validate(), []);
    assert.deepEqual(elementMapOf(roots, slideId, shapeId)?.get("border"), { kind: "none" });
    assert.equal(textOf(roots, { kind: "element", slideId, elementId: shapeId })?.toString(), "abc\n");
    assert.deepEqual(store.snapshot().slides.map((slide) => slide.id), order);
  });

  test("meta is never repaired, and nothing is written on a report-only replica", () => {
    const { store, sharedDocument, scheduler } = createTestStore({ seed: "blankDeck", repairPolicy: "reportOnly" });
    sharedDocument.transact(() => documentRoots(sharedDocument).meta.delete("title"));
    const before = Y.encodeStateVector(sharedDocument);
    scheduler.flush();
    assert.deepEqual(Y.encodeStateVector(sharedDocument), before);
    assert.deepEqual(store.validate().map((issue) => [issue.path, issue.repair]), [["meta/title", "none"]]);
  });

  test("an element of an unknown kind is an UnsupportedElement at its frame, reported and left alone", () => {
    const { store, sharedDocument, flush, slideId } = repairing();
    const roots = documentRoots(sharedDocument);
    sharedDocument.transact(() => {
      const map = new Y.Map<unknown>();
      childMap(slideMapOf(roots, slideId) ?? new Y.Map(), "elements")?.set("el_hologram01", map);
      map.set("kind", "hologram");
      map.set("position", "zz");
      map.set("frame", identityFrame({ x: 1, y: 2, width: 3, height: 4 }));
    });
    flush();
    const element = flattenElements(store.snapshot().slides[0]?.elements ?? []).get(elementId("el_hologram01"));
    assert.equal(element?.kind, "unsupported");
    assert.equal(element?.kind === "unsupported" ? element.storedKind : "", "hologram");
    assert.deepEqual(element?.frame, identityFrame({ x: 1, y: 2, width: 3, height: 4 }));
    assert.deepEqual(store.validate().map((issue) => [issue.problem, issue.repair]), [["unsupportedValue", "none"]]);
  });
});

describe("history", () => {
  test("redo restores the selection after, and history() follows the stacks", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const slideId = store.snapshot().slides[0]?.id ?? mint("slide");
    const shapeId = mint("element");
    assert.deepEqual(store.history(), { canUndo: false, canRedo: false });
    applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, elements: [shape({ id: shapeId })], placement: { kind: "front" } }], selectionAfter: { kind: "elements", slideId, elementIds: [shapeId] } }));
    assert.deepEqual(store.history(), { canUndo: true, canRedo: false });
    const undone = store.undo();
    assert.deepEqual(undone.kind === "applied" ? undone.selection : null, { kind: "none" });
    assert.deepEqual(store.history(), { canUndo: false, canRedo: true });
    const redone = store.redo();
    assert.deepEqual(redone.kind === "applied" ? redone.selection : null, { kind: "elements", slideId, elementIds: [shapeId] });
    assert.equal(store.undo().kind, "applied", "the redone step can be undone again");
    assert.deepEqual(store.undo(), { kind: "nothingToDo", skippedSteps: 0 });
  });

  test("history changes are reported with their direction", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    applyOrThrow(store, envelope({ commands: [{ kind: "updateTheme", patch: { name: "Dusk" } }] }));
    const origins: string[] = [];
    const subscription = store.changes.subscribe((change) => origins.push(change.origin.kind === "history" ? `history:${change.origin.direction}` : change.origin.kind));
    store.undo();
    store.redo();
    subscription.unsubscribe();
    assert.deepEqual(origins, ["history:undo", "history:redo"]);
    assert.equal(store.snapshot().theme.name, "Dusk");
  });
});

describe("automatic text", () => {
  test("the slide number is one embedded item, length 1 in the index space", () => {
    const { store, sharedDocument } = createTestStore({ seed: "blankDeck" });
    const slideId = store.snapshot().slides[0]?.id ?? mint("slide");
    const shapeId = mint("element");
    applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, elements: [shape({ id: shapeId, text: textBody("Slide ") })], placement: { kind: "front" } }] }));
    const target: TextTarget = { kind: "element", slideId, elementId: shapeId };
    applyOrThrow(store, envelope({ commands: [{ kind: "editText", target, basedOnRevision: store.snapshot().revision, operations: [{ kind: "insertAutomaticText", index: 6, field: "slideNumber", style: { fontWeight: 700 } }] }] }));
    assert.equal(textOf(documentRoots(sharedDocument), target)?.length, 8);
    const element = flattenElements(store.snapshot().slides[0]?.elements ?? []).get(shapeId);
    assert.deepEqual(element?.kind === "shape" ? element.text.paragraphs[0]?.runs : null, [
      { kind: "text", text: "Slide ", style: {} },
      { kind: "automaticText", field: "slideNumber", style: { fontWeight: 700 } },
    ]);
  });
});

describe("derived frames", () => {
  test("a group's frame bounds its children in its own rotated axes", () => {
    const children = [shape({ id: mint("element"), frame: box({ x: 0, y: 0, width: 100, height: 50 }) }), shape({ id: mint("element"), frame: box({ x: 200, y: 100, width: 100, height: 50 }) })];
    assert.deepEqual(derivedGroupFrame({ rotation: 0, children }), { ...identityFrame({ x: 0, y: 0, width: 300, height: 150 }) });
    const turned = derivedGroupFrame({ rotation: 90, children });
    assert.equal(turned.rotation, 90);
    assert.ok(Math.abs(turned.width - 150) < 1e-9 && Math.abs(turned.height - 300) < 1e-9, JSON.stringify(turned));
    assert.ok(Math.abs(turned.x + turned.width / 2 - 150) < 1e-9 && Math.abs(turned.y + turned.height / 2 - 75) < 1e-9);
  });

  test("a line's frame is the bounds of its end points, whatever the stored input frame said", () => {
    const { store } = createTestStore({ seed: "blankDeck" });
    const slideId = store.snapshot().slides[0]?.id ?? mint("slide");
    const lineId = mint("element");
    applyOrThrow(store, envelope({ commands: [{ kind: "insertElements", slideId, elements: [{ ...line({ id: lineId }), frame: box({ x: 999, y: 999, width: 1, height: 1 }) }], placement: { kind: "front" } }] }));
    assert.deepEqual(flattenElements(store.snapshot().slides[0]?.elements ?? []).get(lineId)?.frame, identityFrame({ x: 10, y: 10, width: 200, height: 50 }));
  });
});

describe("presence hub", () => {
  test("each channel sees the others, stamped by the hub's clock, never itself", () => {
    let time = 100;
    const hub = createMemoryPresenceHub({ now: () => time });
    const seen: (readonly PeerPresence[])[] = [];
    const subscription = hub.channelFor(2).subscribe((peers) => seen.push(peers));
    const person = { id: personId("pe_alice01"), displayName: "Alice", colourIndex: 0, kind: "person" } as const;
    hub.channelFor(1).publish({ person, slideId: null, selection: { kind: "none" }, pointer: { x: 1, y: 2 }, activity: "editing" });
    time = 200;
    hub.channelFor(2).publish({ person, slideId: null, selection: { kind: "none" }, pointer: null, activity: "idle" });
    subscription[Symbol.dispose]();
    hub.channelFor(1).publish({ person, slideId: null, selection: { kind: "none" }, pointer: null, activity: "presenting" });
    assert.deepEqual(seen.map((peers) => peers.map((peer) => [peer.clientId, peer.lastSeenAt, peer.activity])), [[], [[1, 100, "editing"]], [[1, 100, "editing"]]]);
  });
});

describe("discussion authority", () => {
  const alice = { id: personId("pe_alice01"), displayName: "Alice", colourIndex: 0, kind: "person" } as const;
  const bob = { id: personId("pe_bob0001"), displayName: "Bob", colourIndex: 1, kind: "agent" } as const;
  test("stamps actor and time, is idempotent per request, and checks the thread's creator for deletes", async () => {
    using aliceStore = createMemoryDiscussionStore({ actor: alice, now: () => 42, initialLog: [] });
    const threadId = mint("thread");
    const requestId = mint("discussionRequest");
    const create = { kind: "createThread", threadId, anchor: { slideId: mint("slide"), target: { kind: "slide" }, region: null, elementFrameAtCreation: null }, markings: [], messageId: mint("message"), body: "Hi", mentions: [] } as const;
    const first = await aliceStore.submit({ requestId, command: create });
    const again = await aliceStore.submit({ requestId, command: create });
    assert.deepEqual(again, first);
    assert.equal(aliceStore.snapshot().threads.length, 1);
    assert.equal(aliceStore.snapshot().threads[0]?.createdAt, 42);
    const missing = await aliceStore.submit({ requestId: mint("discussionRequest"), command: { kind: "reply", threadId: mint("thread"), messageId: mint("message"), body: "?", mentions: [] } });
    assert.equal(missing.kind === "rejected" ? missing.reason : null, "threadMissing");
    using bobStore = createMemoryDiscussionStore({ actor: bob, now: () => 43, initialLog: [{ sequence: 1, requestId, actor: alice, at: 42, command: create }] });
    const deleted = await bobStore.submit({ requestId: mint("discussionRequest"), command: { kind: "deleteThread", threadId } });
    assert.equal(deleted.kind === "rejected" ? deleted.reason : null, "notAuthor");
  });

  test("the fold skips an entry about a thread that does not exist", () => {
    const empty = { sequence: 0, threads: [] };
    const folded = reduceDiscussionLog(empty, { sequence: 1, requestId: mint("discussionRequest"), actor: alice, at: 1, command: { kind: "resolveThread", threadId: mint("thread") } });
    assert.deepEqual(folded, { sequence: 1, threads: [] });
  });
});
