// FAKE STORES for the editor's tests: the document store, discussion authority and asset store the
// feedbacks talk to, small enough to read in one sitting and controllable from a test. The real ones
// are the model module's; these only implement what the state module's acceptance tests exercise --
// text edits (through the same flat text model the reducer replays), frames, inserts and deletes,
// and the four build step commands with the model's ordering (deleting an element takes its steps) --
// and can SETTLE LATER: apply on call, but emit the change on a virtual scheduler, which is how the
// typing test proves the second keystroke is computed from the queued first.

import { Subject, type Observable } from "rxjs";
import { Doc } from "yjs";
import {
  assertNever,
  lineFrame,
  normaliseRotation,
  textTargetKey,
  type AnimationStep,
  type AnimationStepId,
  type AssetId,
  type AssetMediaType,
  type AssetStore,
  type CommandEnvelope,
  type CommandOutcome,
  type DiscussionOutcome,
  type DiscussionRequest,
  type DiscussionSnapshot,
  type DiscussionStore,
  type DocumentChange,
  type DocumentChangeOrigin,
  type DocumentCommand,
  type DocumentSnapshot,
  type DocumentStore,
  type ElementSnapshot,
  type EncodedTextAnchor,
  type FrameUpdate,
  type HistoryOutcome,
  type SlideId,
  type SlideSnapshot,
  type TextBody,
  type TextDelta,
  type TextRange,
  type TextTarget,
  type TextTargetKey,
} from "../../contracts/index.ts";
import { textBodyOf } from "../editor/document-lookup.ts";
import { applyTextOperations, bodyFromFlat, flattenBody, type FlatText } from "../editor/text-model.ts";
import type { VirtualScheduler } from "./virtual-scheduler.ts";

export type Settlement = Readonly<{ kind: "synchronously" }> | Readonly<{ kind: "onScheduler"; scheduler: VirtualScheduler; delayMilliseconds: number }>;

export type FakeDocumentStore = DocumentStore &
  Readonly<{
    appliedEnvelopes: () => readonly CommandEnvelope[];
    /** The outcome the next undo or redo returns (otherwise "nothing to do"). */
    queueHistoryOutcome: (outcome: HistoryOutcome) => void;
    plainTextOf: (target: TextTarget) => string;
  }>;

export function createFakeDocumentStore(options: Readonly<{ initial: DocumentSnapshot; settle: Settlement }>): FakeDocumentStore {
  let snapshot = options.initial;
  const changes = new Subject<DocumentChange>();
  const applied: CommandEnvelope[] = [];
  const historyOutcomes: HistoryOutcome[] = [];

  const emit = (change: DocumentChange): void => {
    switch (options.settle.kind) {
      case "synchronously":
        changes.next(change);
        return;
      case "onScheduler":
        options.settle.scheduler.schedule(() => changes.next(change), options.settle.delayMilliseconds);
        return;
      default:
        assertNever(options.settle);
    }
  };

  const commit = (next: DocumentSnapshot, origin: DocumentChangeOrigin, textChanges: ReadonlyMap<TextTargetKey, TextDelta>, changedSlideIds: readonly SlideId[]): void => {
    snapshot = { ...next, revision: snapshot.revision + 1 };
    emit({
      snapshot,
      origin,
      changedSlideIds,
      deckLevelChanged: false,
      textChanges,
      history: { canUndo: applied.length > 0, canRedo: false },
    });
  };

  const store: FakeDocumentStore = {
    sharedDocument: new Doc(),
    snapshot: () => snapshot,
    apply: (envelope: CommandEnvelope): CommandOutcome => {
      const result = applyCommands(snapshot, envelope.commands);
      switch (result.kind) {
        case "rejected":
          return { kind: "rejected", commandId: envelope.commandId, rejection: result.rejection };
        case "applied":
          applied.push(envelope);
          commit(result.snapshot, { kind: "local", commandId: envelope.commandId }, result.textChanges, result.changedSlideIds);
          return { kind: "applied", commandId: envelope.commandId, revision: snapshot.revision };
        default:
          return assertNever(result);
      }
    },
    undo: () => historyOutcomes.shift() ?? { kind: "nothingToDo", skippedSteps: 0 },
    redo: () => historyOutcomes.shift() ?? { kind: "nothingToDo", skippedSteps: 0 },
    history: () => ({ canUndo: applied.length > 0, canRedo: false }),
    changes,
    validate: () => [],
    encodeTextAnchor: (range: TextRange): EncodedTextAnchor | null =>
      textBodyOf(snapshot, range.target) === null ? null : { target: range.target, start: String(range.start), end: String(range.end) },
    resolveTextAnchors: (anchors) =>
      anchors.map((anchor) => (textBodyOf(snapshot, anchor.target) === null ? null : { target: anchor.target, start: Number(anchor.start), end: Number(anchor.end) })),
    appliedEnvelopes: () => applied.slice(),
    queueHistoryOutcome: (outcome) => {
      historyOutcomes.push(outcome);
    },
    plainTextOf: (target) => {
      const body = textBodyOf(snapshot, target);
      return body === null ? "" : indexText(flattenBody(body)).replace(/\n$/u, "");
    },
    [Symbol.dispose]: () => changes.complete(),
  };
  return store;
}

export type FakeDiscussionStore = DiscussionStore &
  Readonly<{
    submitted: () => readonly DiscussionRequest[];
    settle: (outcome: DiscussionOutcome) => void;
  }>;

export function createFakeDiscussionStore(initial: DiscussionSnapshot): FakeDiscussionStore {
  const changes = new Subject<DiscussionSnapshot>();
  const submitted: DiscussionRequest[] = [];
  const waiting = new Map<string, (outcome: DiscussionOutcome) => void>();
  return {
    snapshot: () => initial,
    changes,
    submit: (request) => {
      submitted.push(request);
      return new Promise<DiscussionOutcome>((resolve) => waiting.set(request.requestId, resolve));
    },
    submitted: () => submitted.slice(),
    settle: (outcome) => {
      waiting.get(outcome.requestId)?.(outcome);
      waiting.delete(outcome.requestId);
    },
    [Symbol.dispose]: () => changes.complete(),
  };
}

export type PutBehaviour = "neverSettles" | "rejects" | Readonly<{ resolvesWith: AssetId }>;

export type FakeAssetStore = AssetStore &
  Readonly<{
    putCalls: () => readonly number[];
    makeAvailable: (assetId: AssetId, address: string) => void;
  }>;

/** `behaviours[n]` decides the n-th `put`; the last one repeats. `now` stamps each call. */
export function createFakeAssetStore(options: Readonly<{ behaviours: readonly PutBehaviour[]; now: () => number }>): FakeAssetStore {
  const available = new Subject<AssetId>();
  const addresses = new Map<AssetId, string>();
  const calls: number[] = [];
  return {
    put: (_bytes: ArrayBuffer, _mediaType: AssetMediaType) => {
      calls.push(options.now());
      const behaviour = options.behaviours[Math.min(calls.length - 1, options.behaviours.length - 1)] ?? "neverSettles";
      if (typeof behaviour !== "string") return Promise.resolve(behaviour.resolvesWith);
      switch (behaviour) {
        case "neverSettles":
          return new Promise<AssetId>(() => undefined);
        case "rejects":
          return Promise.reject(new Error("storage refused"));
        default:
          return assertNever(behaviour);
      }
    },
    addressFor: (assetId) => addresses.get(assetId) ?? null,
    available: available as Observable<AssetId>,
    copyBytesOf: () => Promise.resolve(null),
    putCalls: () => calls.slice(),
    makeAvailable: (assetId, address) => {
      addresses.set(assetId, address);
      available.next(assetId);
    },
  };
}

type ApplyResult =
  | Readonly<{ kind: "applied"; snapshot: DocumentSnapshot; textChanges: ReadonlyMap<TextTargetKey, TextDelta>; changedSlideIds: readonly SlideId[] }>
  | Readonly<{ kind: "rejected"; rejection: Extract<CommandOutcome, { kind: "rejected" }>["rejection"] }>;

function applyCommands(start: DocumentSnapshot, commands: readonly DocumentCommand[]): ApplyResult {
  let snapshot = start;
  const textChanges = new Map<TextTargetKey, TextDelta>();
  const changed = new Set<SlideId>();
  for (const command of commands) {
    switch (command.kind) {
      case "editText": {
        if (command.basedOnRevision !== start.revision) return { kind: "rejected", rejection: { reason: "staleText", basedOnRevision: command.basedOnRevision, currentRevision: start.revision } };
        const body = textBodyOf(snapshot, command.target);
        if (body === null) return { kind: "rejected", rejection: { reason: "slideMissing", slideId: command.target.slideId } };
        const before = flattenBody(body);
        const after = applyTextOperations(before, command.operations);
        snapshot = replaceBody(snapshot, command.target, bodyFromFlat(after));
        textChanges.set(textTargetKey(command.target), deltaBetween(indexText(before), indexText(after)));
        changed.add(command.target.slideId);
        break;
      }
      case "setFrames":
        snapshot = mapSlide(snapshot, command.slideId, (slide) => ({ ...slide, elements: mapTree(slide.elements, (element) => withFrameUpdates(element, command.frames)) }));
        changed.add(command.slideId);
        break;
      case "insertElements":
        snapshot = mapSlide(snapshot, command.slideId, (slide) => ({ ...slide, elements: [...slide.elements, ...command.elements] }));
        changed.add(command.slideId);
        break;
      case "deleteElements":
        snapshot = mapSlide(snapshot, command.slideId, (slide) => {
          const elements = withoutIds(slide.elements, new Set<string>(command.elementIds));
          const remaining = new Set<string>(idsInTrees(elements));
          return { ...slide, elements, animations: slide.animations.filter((step) => remaining.has(step.elementId)) };
        });
        changed.add(command.slideId);
        break;
      case "insertAnimationSteps":
      case "updateAnimationSteps":
      case "moveAnimationSteps":
      case "deleteAnimationSteps": {
        const slide = snapshot.slides.find((candidate) => candidate.id === command.slideId);
        if (slide === undefined) return { kind: "rejected", rejection: { reason: "slideMissing", slideId: command.slideId } };
        const result = applyStepCommand({ animations: slide.animations, command });
        switch (result.kind) {
          case "rejected":
            return result;
          case "applied":
            snapshot = mapSlide(snapshot, command.slideId, (current) => ({ ...current, animations: result.animations }));
            changed.add(command.slideId);
            break;
          default:
            assertNever(result);
        }
        break;
      }
      case "deleteSlides":
        snapshot = { ...snapshot, slides: snapshot.slides.filter((slide) => !command.slideIds.includes(slide.id)) };
        break;
      case "insertSlides": {
        const index = command.after === null ? 0 : snapshot.slides.findIndex((slide) => slide.id === command.after) + 1;
        snapshot = { ...snapshot, slides: [...snapshot.slides.slice(0, index), ...command.slides, ...snapshot.slides.slice(index)] };
        break;
      }
      case "registerAsset":
        snapshot = snapshot.assets.some((asset) => asset.id === command.asset.id) ? snapshot : { ...snapshot, assets: [...snapshot.assets, command.asset] };
        break;
      case "setTitle":
      case "updateTheme":
      case "upsertLayout":
      case "deleteLayout":
      case "upsertTransitionScript":
      case "deleteTransitionScript":
      case "approveTransitionScript":
      case "moveSlides":
      case "setSlideProperties":
      case "updateElements":
      case "reorderElements":
      case "groupElements":
      case "ungroupElements":
      case "insertTableRows":
      case "insertTableColumns":
      case "deleteTableRows":
      case "deleteTableColumns":
      case "setTableColumnWidths":
      case "setTableRowHeights":
      case "updateTableCells":
        break;
      default:
        assertNever(command);
    }
  }
  return { kind: "applied", snapshot, textChanges, changedSlideIds: [...changed] };
}

type StepCommand = Extract<DocumentCommand, { kind: "insertAnimationSteps" | "updateAnimationSteps" | "moveAnimationSteps" | "deleteAnimationSteps" }>;

type StepResult = Readonly<{ kind: "applied"; animations: readonly AnimationStep[] }> | Extract<ApplyResult, { kind: "rejected" }>;

/** The model's order semantics for the four step commands (model/command-application.ts), on plain arrays. */
function applyStepCommand(options: Readonly<{ animations: readonly AnimationStep[]; command: StepCommand }>): StepResult {
  const { animations, command } = options;
  const known = new Set<string>(animations.map((step) => step.id));
  const missing = (stepIds: readonly AnimationStepId[]): StepResult | null => {
    const stepId = stepIds.find((candidate) => !known.has(candidate));
    return stepId === undefined ? null : { kind: "rejected", rejection: { reason: "animationStepMissing", slideId: command.slideId, stepId } };
  };
  const insertAfter = (remaining: readonly AnimationStep[], after: AnimationStepId | null, inserted: readonly AnimationStep[]): readonly AnimationStep[] => {
    const index = after === null ? 0 : remaining.findIndex((step) => step.id === after) + 1;
    return [...remaining.slice(0, index), ...inserted, ...remaining.slice(index)];
  };
  switch (command.kind) {
    case "insertAnimationSteps":
      return missing(command.after === null ? [] : [command.after]) ?? { kind: "applied", animations: insertAfter(animations, command.after, command.steps) };
    case "updateAnimationSteps":
      return missing(command.stepIds) ?? { kind: "applied", animations: animations.map((step) => (command.stepIds.includes(step.id) ? { ...step, ...command.patch } : step)) };
    case "moveAnimationSteps": {
      const rejected = missing([...command.stepIds, ...(command.after === null ? [] : [command.after])]);
      if (rejected !== null) return rejected;
      const moved = animations.filter((step) => command.stepIds.includes(step.id));
      const remaining = animations.filter((step) => !command.stepIds.includes(step.id));
      return { kind: "applied", animations: insertAfter(remaining, command.after, moved) };
    }
    case "deleteAnimationSteps":
      return missing(command.stepIds) ?? { kind: "applied", animations: animations.filter((step) => !command.stepIds.includes(step.id)) };
    default:
      return assertNever(command);
  }
}

function idsInTrees(elements: readonly ElementSnapshot[]): readonly string[] {
  return elements.flatMap((element) => {
    switch (element.kind) {
      case "group":
        return [element.id, ...idsInTrees(element.children)];
      case "shape":
      case "image":
      case "line":
      case "table":
      case "unsupported":
        return [element.id];
      default:
        return assertNever(element);
    }
  });
}

/**
 * The delta that turns `before` into `after`, as one retain, delete, insert around the common
 * prefix and suffix. Enough for a single edit; how these stores report `textChanges`.
 */
function deltaBetween(before: string, after: string): TextDelta {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const deleted = before.length - prefix - suffix;
  const inserted = after.length - prefix - suffix;
  const delta: TextDelta[number][] = [];
  if (prefix > 0) delta.push({ kind: "retain", length: prefix });
  if (deleted > 0) delta.push({ kind: "delete", length: deleted });
  if (inserted > 0) delta.push({ kind: "insert", length: inserted });
  return delta;
}

/** One character per index: what `deltaBetween` diffs. */
function indexText(items: FlatText): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case "character":
          return item.character;
        case "automaticText":
          return "￼";
        case "paragraphMark":
          return "\n";
        default:
          return assertNever(item);
      }
    })
    .join("");
}

function replaceBody(snapshot: DocumentSnapshot, target: TextTarget, body: TextBody): DocumentSnapshot {
  switch (target.kind) {
    case "speakerNotes":
      return mapSlide(snapshot, target.slideId, (slide) => ({ ...slide, speakerNotes: body }));
    case "element":
      return mapSlide(snapshot, target.slideId, (slide) => ({
        ...slide,
        elements: mapTree(slide.elements, (element) => {
          if (element.id !== target.elementId) return element;
          switch (element.kind) {
            case "shape":
              return { ...element, text: body };
            case "image":
            case "line":
            case "table":
            case "group":
            case "unsupported":
              return element;
            default:
              return assertNever(element);
          }
        }),
      }));
    case "tableCell":
      return snapshot;
    default:
      return assertNever(target);
  }
}

function mapSlide(snapshot: DocumentSnapshot, slideId: SlideId, change: (slide: SlideSnapshot) => SlideSnapshot): DocumentSnapshot {
  return { ...snapshot, slides: snapshot.slides.map((slide) => (slide.id === slideId ? change(slide) : slide)) };
}

function mapTree(elements: readonly ElementSnapshot[], change: (element: ElementSnapshot) => ElementSnapshot): readonly ElementSnapshot[] {
  return elements.map((element) => {
    const changed = change(element);
    switch (changed.kind) {
      case "group":
        return { ...changed, children: mapTree(changed.children, change) };
      case "shape":
      case "image":
      case "line":
      case "table":
      case "unsupported":
        return changed;
      default:
        return assertNever(changed);
    }
  });
}

function withoutIds(elements: readonly ElementSnapshot[], ids: ReadonlySet<string>): readonly ElementSnapshot[] {
  return elements
    .filter((element) => !ids.has(element.id))
    .map((element) => {
      switch (element.kind) {
        case "group":
          return { ...element, children: withoutIds(element.children, ids) };
        case "shape":
        case "image":
        case "line":
        case "table":
        case "unsupported":
          return element;
        default:
          return assertNever(element);
      }
    });
}

function withFrameUpdates(element: ElementSnapshot, updates: readonly FrameUpdate[]): ElementSnapshot {
  let result = element;
  for (const update of updates) {
    if (update.elementId !== element.id) continue;
    switch (update.kind) {
      case "box":
        result = { ...result, frame: update.frame };
        break;
      case "line":
        switch (result.kind) {
          case "line":
            result = { ...result, start: update.start, end: update.end, frame: lineFrame({ start: update.start, end: update.end }) };
            break;
          case "shape":
          case "image":
          case "table":
          case "group":
          case "unsupported":
            break;
          default:
            assertNever(result);
        }
        break;
      case "groupRotation":
        result = { ...result, frame: { ...result.frame, rotation: normaliseRotation(update.rotation) } };
        break;
      default:
        assertNever(update);
    }
  }
  return result;
}
