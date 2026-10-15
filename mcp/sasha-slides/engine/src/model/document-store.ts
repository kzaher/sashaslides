// THE DOCUMENT STORE: the model's one stateful object, wrapping a Y.Doc (document-store.ts in the
// contracts has the full arrangement with RxFeedback). It owns three things nobody else may touch:
// the writes (`apply`, validated first, one transaction per envelope), the undo history, and the
// stream of `DocumentChange`s every replica's editor reduces.
//
// Key decisions:
//
//  * CHANGES ARE COLLECTED PER TRANSACTION AND EMITTED WHEN YJS IS DONE. `afterTransaction` records
//    what each transaction reached (slides, elements, deck-level roots) and its text deltas while
//    Yjs still holds the events; `afterAllTransactions` then projects and emits them in order.
//    Emitting there means a subscriber that calls `apply` re-entrantly starts a fresh transaction
//    instead of one nested inside Yjs's cleanup, whose change would otherwise be projected before
//    its own transaction was recorded.
//  * TYPING MERGES BY THE INJECTED CLOCK. The UndoManager runs with an infinite capture timeout
//    and the store calls `stopCapturing()` before every envelope that must not merge, so the merge
//    window is `typingMergeWindowMilliseconds` of the injected `now`, never Yjs's own clock.
//  * SELECTIONS IN THE HISTORY ARE RELATIVE POSITIONS, kept per stack item in a WeakMap (typed,
//    unlike the stack item's `meta` map) and carried from an undo step to its redo step and back.
//  * SKIPPED STEPS ARE COUNTED, not hidden. Yjs already pops past steps whose undo changes nothing
//    (collaborators overwrote everything in them); the store counts them from the stack lengths.
//  * REPAIRS RUN ON THE SCHEDULER, after the transaction that revealed them and only over what it
//    touched, in one REPAIR_ORIGIN transaction; never on a document from a newer schema.

import { Subject, type Subscription } from "rxjs";
import * as Y from "yjs";
import type {
  CommandEnvelope,
  CommandOutcome,
  CreateDocumentStore,
  DocumentChange,
  DocumentChangeOrigin,
  ElementId,
  HistoryAvailability,
  HistoryOutcome,
  SlideId,
  TextDelta,
  TextDeltaOperation,
  TextTargetKey,
} from "../contracts/index.ts";
import {
  assertNever,
  DOCUMENT_SCHEMA_VERSION,
  LOCAL_EDIT_ORIGIN,
  META_KEY,
  REPAIR_ORIGIN,
  SEED_ORIGIN,
  textTargetKey,
  UNDO_SCOPE_ROOTS,
} from "../contracts/index.ts";
import { blankDeck } from "./blank-deck.ts";
import { applyCommand } from "./command-application.ts";
import { validateEnvelope } from "./command-validation.ts";
import { documentRoots, textTargetAt, typePath, type DocumentRoots } from "./document-paths.ts";
import { projectDocument, type ProjectionScope } from "./document-projection.ts";
import { writeBlankDeck } from "./document-writer.ts";
import { isRecord } from "./stored-values.ts";
import { encodeTextAnchor, NO_STORED_SELECTION, resolveTextAnchors, restoreSelection, storeSelection, type StoredSelection } from "./text-positions.ts";
import { applyRepairs, findIssues, hasRepairs, issuesOf, type ValidationScope } from "./validation.ts";

export const createDocumentStore: CreateDocumentStore = (options) => {
  const { sharedDocument, now, random, scheduler } = options;
  const roots = documentRoots(sharedDocument);
  // Created before the store's own handler so its stacks are current when a change is reported.
  const undoManager = new Y.UndoManager(
    UNDO_SCOPE_ROOTS.map((name) => roots[name]),
    { captureTimeout: Number.POSITIVE_INFINITY, trackedOrigins: new Set<unknown>([LOCAL_EDIT_ORIGIN]) },
  );
  const changes = new Subject<DocumentChange>();
  const stepSelections = new WeakMap<StackItem, StepSelections>();
  const pending: PendingChange[] = [];
  let snapshot = projectDocument({ roots, previous: null, scope: "all", revision: 0 }).snapshot;
  let revision = 0;
  let flushing = false;
  let current: CurrentEnvelope | null = null;
  let lastStep: LastStep | null = null;
  let repairDirty: RepairDirty = { slides: new Set(), deck: false };
  let repairTask: Subscription | null = null;
  let disposed = false;

  const history = (): HistoryAvailability => ({ canUndo: undoManager.undoStack.length > 0, canRedo: undoManager.redoStack.length > 0 });
  const effectiveRevision = (): number => revision + pending.length;

  const onStackItemAdded = (event: StackItemEvent): void => {
    if (event.type !== "undo" || undoManager.undoing || undoManager.redoing || current === null) return;
    stepSelections.set(event.stackItem, { before: current.storedBefore, after: storeSelection(roots, current.envelope.selectionAfter) });
  };
  const onStackItemUpdated = (event: StackItemEvent): void => {
    if (event.type !== "undo" || undoManager.undoing || undoManager.redoing || current === null) return;
    const previous = stepSelections.get(event.stackItem);
    stepSelections.set(event.stackItem, { before: previous?.before ?? current.storedBefore, after: storeSelection(roots, current.envelope.selectionAfter) });
  };
  undoManager.on("stack-item-added", onStackItemAdded);
  undoManager.on("stack-item-updated", onStackItemUpdated);

  const onAfterTransaction = (transaction: Y.Transaction): void => {
    if (transaction.changed.size === 0) return;
    pending.push({
      origin: originOf({ transaction, undoManager, current }),
      scope: scopeOf(roots, transaction),
      textChanges: textChangesOf(roots, transaction),
    });
  };
  const flush = (): void => {
    if (flushing || disposed) return;
    flushing = true;
    try {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        revision += 1;
        const projection = projectDocument({ roots, previous: snapshot, scope: next.scope, revision });
        snapshot = projection.snapshot;
        const scope = next.scope;
        changes.next({
          snapshot,
          origin: next.origin,
          changedSlideIds: projection.changedSlideIds,
          deckLevelChanged: scope.meta || scope.theme || scope.layouts || scope.assets || scope.transitionScripts,
          textChanges: next.textChanges,
          history: history(),
        });
        if (next.origin.kind !== "repair") markForRepair(scope);
      }
    } finally {
      flushing = false;
    }
    scheduleRepairs();
  };
  sharedDocument.on("afterTransaction", onAfterTransaction);
  sharedDocument.on("afterAllTransactions", flush);

  function markForRepair(scope: ProjectionScope): void {
    if (options.repairPolicy !== "repairAfterTransaction") return;
    for (const slideId of scope.slides.keys()) repairDirty.slides.add(slideId);
    repairDirty = { slides: repairDirty.slides, deck: repairDirty.deck || scope.meta || scope.theme || scope.layouts || scope.assets || scope.transitionScripts || scope.slides.size > 0 };
  }

  function scheduleRepairs(): void {
    if (repairTask !== null || disposed) return;
    if (repairDirty.slides.size === 0 && !repairDirty.deck) return;
    repairTask = scheduler.schedule(() => {
      repairTask = null;
      runRepairs();
    });
  }

  function runRepairs(): void {
    if (disposed) return;
    const scope: ValidationScope = { slides: repairDirty.slides, deck: repairDirty.deck };
    repairDirty = { slides: new Set(), deck: false };
    if (schemaIsTooNew(roots)) return;
    if (!hasRepairs(findIssues({ roots, scope }))) return;
    sharedDocument.transact(() => {
      for (let pass = 0; pass < MAXIMUM_REPAIR_PASSES; pass += 1) {
        const findings = findIssues({ roots, scope });
        if (!hasRepairs(findings)) return;
        applyRepairs({ findings, random });
      }
    }, REPAIR_ORIGIN);
  }

  if (options.seed.kind === "blankDeck" && !roots.meta.has(META_KEY.deckId)) {
    const deck = blankDeck({ deckId: options.seed.deckId, random });
    sharedDocument.transact(() => writeBlankDeck({ roots, deck, createdAt: now(), random }), SEED_ORIGIN);
  }

  return {
    sharedDocument,
    changes: changes.asObservable(),
    snapshot: () => snapshot,
    apply: (envelope: CommandEnvelope): CommandOutcome => {
      if (disposed) throw new Error("The document store was disposed; nothing more can be applied through it.");
      const rejection = validateEnvelope({ context: { roots, revision: effectiveRevision() }, envelope });
      if (rejection !== null) return { kind: "rejected", commandId: envelope.commandId, rejection };
      const body = bodyOf(envelope);
      const merges = mergesWithPrevious({ envelope, body, lastStep, now: now(), window: options.typingMergeWindowMilliseconds });
      if (!merges) undoManager.stopCapturing();
      current = { envelope, storedBefore: storeSelection(roots, envelope.selectionBefore) };
      try {
        const context = { roots, random, now, author: envelope.author };
        sharedDocument.transact(() => {
          for (const command of envelope.commands) applyCommand(context, command);
        }, LOCAL_EDIT_ORIGIN);
      } finally {
        current = null;
      }
      lastStep = nextLastStep({ previous: lastStep, body, merges, at: now() });
      return { kind: "applied", commandId: envelope.commandId, revision: effectiveRevision() };
    },
    undo: () => stepThroughHistory({ direction: "undo" }),
    redo: () => stepThroughHistory({ direction: "redo" }),
    history,
    validate: () => {
      const findings = findIssues({ roots, scope: { slides: "all", deck: true } });
      return issuesOf({ findings, repairing: options.repairPolicy === "repairAfterTransaction" && !schemaIsTooNew(roots) });
    },
    encodeTextAnchor: (range) => encodeTextAnchor(roots, range),
    resolveTextAnchors: (anchors) => resolveTextAnchors({ roots, sharedDocument, anchors }),
    [Symbol.dispose]: () => {
      if (disposed) return;
      disposed = true;
      repairTask?.unsubscribe();
      sharedDocument.off("afterTransaction", onAfterTransaction);
      sharedDocument.off("afterAllTransactions", flush);
      undoManager.off("stack-item-added", onStackItemAdded);
      undoManager.off("stack-item-updated", onStackItemUpdated);
      undoManager.destroy();
      changes.complete();
    },
  };

  function stepThroughHistory(step: Readonly<{ direction: "undo" | "redo" }>): HistoryOutcome {
    const stack = step.direction === "undo" ? undoManager.undoStack : undoManager.redoStack;
    const before = stack.length;
    const popped = step.direction === "undo" ? undoManager.undo() : undoManager.redo();
    const after = (step.direction === "undo" ? undoManager.undoStack : undoManager.redoStack).length;
    lastStep = null;
    const skippedSteps = before - after - (popped === null ? 0 : 1);
    if (popped === null) return { kind: "nothingToDo", skippedSteps };
    const selections = stepSelections.get(popped) ?? { before: NO_STORED_SELECTION, after: NO_STORED_SELECTION };
    // The inverse step Yjs just pushed (onto the other stack) restores the same selections.
    const inverse = (step.direction === "undo" ? undoManager.redoStack : undoManager.undoStack).at(-1);
    if (inverse !== undefined) stepSelections.set(inverse, selections);
    const stored = step.direction === "undo" ? selections.before : selections.after;
    return { kind: "applied", revision: effectiveRevision(), selection: restoreSelection({ roots, sharedDocument, stored }), skippedSteps };
  }
};

/** How many repair passes one scheduled run makes at most (each pass re-reads what the last wrote). */
const MAXIMUM_REPAIR_PASSES = 5;

type StackItem = Y.UndoManager["undoStack"][number];
type StackItemEvent = Readonly<{ stackItem: StackItem; type: "undo" | "redo" }>;
type StepSelections = Readonly<{ before: StoredSelection; after: StoredSelection }>;
type CurrentEnvelope = Readonly<{ envelope: CommandEnvelope; storedBefore: StoredSelection }>;
type PendingChange = Readonly<{ origin: DocumentChangeOrigin; scope: ProjectionScope; textChanges: ReadonlyMap<TextTargetKey, TextDelta> }>;
type RepairDirty = Readonly<{ slides: Set<SlideId>; deck: boolean }>;

/** The body the previous undo step typed into, so the next keystroke can merge with it. */
type LastStep = Readonly<{ body: EnvelopeBody | null; at: number }>;
type EnvelopeBody = Readonly<{ key: TextTargetKey; slideId: SlideId; elementId: ElementId | null }>;

function schemaIsTooNew(roots: DocumentRoots): boolean {
  const version = roots.meta.get(META_KEY.schemaVersion);
  return typeof version === "number" && version > DOCUMENT_SCHEMA_VERSION;
}

function originOf(
  options: Readonly<{ transaction: Y.Transaction; undoManager: Y.UndoManager; current: CurrentEnvelope | null }>,
): DocumentChangeOrigin {
  const origin: unknown = options.transaction.origin;
  if (origin === options.undoManager) return { kind: "history", direction: options.undoManager.undoing ? "undo" : "redo" };
  if (origin === LOCAL_EDIT_ORIGIN && options.current !== null) return { kind: "local", commandId: options.current.envelope.commandId };
  if (origin === SEED_ORIGIN) return { kind: "seed" };
  if (origin === REPAIR_ORIGIN) return { kind: "repair" };
  return { kind: "remote" };
}

/** Which slides (and elements) and deck-level roots a transaction reached, from the types Yjs says changed. */
function scopeOf(roots: DocumentRoots, transaction: Y.Transaction): ProjectionScope {
  const slides = new Map<SlideId, Set<string> | "all">();
  const flags = { meta: false, theme: false, layouts: false, assets: false, transitionScripts: false };
  const touch = (slideId: SlideId, elementIds: readonly string[] | "all"): void => {
    const existing = slides.get(slideId);
    if (existing === "all") return;
    if (elementIds === "all") {
      slides.set(slideId, "all");
      return;
    }
    const set = existing ?? new Set<string>();
    for (const id of elementIds) set.add(id);
    slides.set(slideId, set);
  };
  transaction.changed.forEach((keys, type) => {
    const path = typePath(roots, type);
    if (path === null) return;
    const changedKeys = [...keys].filter((key): key is string => key !== null);
    switch (path.root) {
      case "slides": {
        // Keys under the slides root are slide ids by construction (document-writer.ts).
        const [slideKey, second, elementKey] = path.keys;
        if (slideKey === undefined) {
          for (const key of changedKeys) touch(key as SlideId, "all");
          return;
        }
        // As above: the first key under the slides root is a slide id.
        const slideId = slideKey as SlideId;
        if (second === undefined) {
          touch(slideId, changedKeys.includes("elements") ? "all" : []);
          return;
        }
        if (second !== "elements") {
          touch(slideId, []);
          return;
        }
        touch(slideId, elementKey === undefined ? changedKeys : [elementKey]);
        return;
      }
      case "meta":
        flags.meta = true;
        return;
      case "theme":
        flags.theme = true;
        return;
      case "layouts":
        flags.layouts = true;
        return;
      case "assets":
        flags.assets = true;
        return;
      case "transitionScripts":
        flags.transitionScripts = true;
        return;
      default:
        assertNever(path.root);
    }
  });
  return { slides, ...flags };
}

/** One delta per text body the transaction changed, in the body's old index space (text-delta.ts). */
function textChangesOf(roots: DocumentRoots, transaction: Y.Transaction): ReadonlyMap<TextTargetKey, TextDelta> {
  const textChanges = new Map<TextTargetKey, TextDelta>();
  transaction.changed.forEach((_keys, type) => {
    if (!(type instanceof Y.Text)) return;
    const path = typePath(roots, type);
    const target = path === null ? null : textTargetAt(path);
    if (target === null) return;
    const delta = ownDelta(transaction, type);
    if (delta !== null) textChanges.set(textTargetKey(target), deltaOf(delta));
  });
  return textChanges;
}

/** The delta of `type`'s own event in this transaction (Yjs files it under the type and every ancestor). */
function ownDelta(transaction: Y.Transaction, type: Y.Text): readonly unknown[] | null {
  for (const [candidate, events] of transaction.changedParentTypes) {
    if (!Object.is(candidate, type)) continue;
    const event = events.find((candidateEvent) => Object.is(candidateEvent.target, type));
    return event === undefined ? null : event.delta;
  }
  return null;
}

function deltaOf(delta: readonly unknown[]): TextDelta {
  const operations: TextDeltaOperation[] = [];
  for (const operation of delta) {
    if (!isRecord(operation)) continue;
    const insert = operation["insert"];
    const retain = operation["retain"];
    const deleted = operation["delete"];
    if (typeof retain === "number") operations.push({ kind: "retain", length: retain });
    else if (typeof deleted === "number") operations.push({ kind: "delete", length: deleted });
    else if (typeof insert === "string") operations.push({ kind: "insert", length: insert.length });
    else if (insert !== undefined) operations.push({ kind: "insert", length: 1 });
  }
  return operations;
}

/** The text body an envelope types into: the one target of all its `editText`s, else null. */
function bodyOf(envelope: CommandEnvelope): EnvelopeBody | null {
  let body: EnvelopeBody | null = null;
  for (const command of envelope.commands) {
    if (command.kind !== "editText") continue;
    const key = textTargetKey(command.target);
    if (body !== null && body.key !== key) return null;
    body = { key, slideId: command.target.slideId, elementId: command.target.kind === "speakerNotes" ? null : command.target.elementId };
  }
  return body;
}

/**
 * True when the envelope joins the previous undo step: it asks to, the previous step typed into a
 * body less than the window ago, and it types into that same body -- or only resizes the element
 * holding it (a text box growing with its text, SPEC.md "Measured layout").
 */
function mergesWithPrevious(
  options: Readonly<{ envelope: CommandEnvelope; body: EnvelopeBody | null; lastStep: LastStep | null; now: number; window: number }>,
): boolean {
  const { envelope, body, lastStep } = options;
  if (!envelope.mergeWithPrevious || lastStep === null || lastStep.body === null) return false;
  if (options.now - lastStep.at >= options.window) return false;
  if (body !== null) return body.key === lastStep.body.key;
  const previous = lastStep.body;
  return (
    envelope.commands.length > 0 &&
    envelope.commands.every(
      (command) =>
        command.kind === "setFrames" &&
        command.slideId === previous.slideId &&
        command.frames.every((frame) => frame.kind === "box" && frame.elementId === previous.elementId),
    )
  );
}

function nextLastStep(options: Readonly<{ previous: LastStep | null; body: EnvelopeBody | null; merges: boolean; at: number }>): LastStep {
  if (options.body !== null) return { body: options.body, at: options.at };
  // A growth step that merged keeps the typing step's body and time.
  if (options.merges && options.previous !== null) return options.previous;
  return { body: null, at: options.at };
}
