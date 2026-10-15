// THE WAY BACK FROM THE STORE (SPEC.md section 6). Every transaction -- this editor's, a
// collaborator's, an undo, a repair -- arrives as one `documentChanged`, and every queued edit's
// verdict as one `editSettled`. Reduced here:
//
//  * OWN CHANGES ARE ALREADY IN THE CARET. A change whose origin is this editor's command was
//    reflected in `selection` when the edit was queued, and the edits queued behind it were computed
//    on top of it; only their `basedOnRevision` moves. Everyone else's change is carried through the
//    queue to the caret and the composition start (text-transform.ts).
//
//  * AN EDIT LEAVES THE QUEUE when its change has been seen. With the synchronous store the change
//    arrives before the verdict; with a store that settles later the verdict can come first, and the
//    command waits in `inFlightCommandIds` so the next edit is not sent against a revision the
//    editor has not seen yet (`applyEditsFeedback` in feedbacks/document-feedbacks.ts holds the
//    queue while it waits).
//
//  * SELECTION SURVIVES: ids that vanished are dropped, text mode on a vanished body falls back to
//    its element, and a deleted current slide hands over to its neighbour.
//
//  * A REJECTED ENVELOPE drops its `selectionAfter`, takes the text edits queued on top of it along
//    (they were computed against text that will never exist) and raises a notice; an undo that had
//    to skip steps says "a collaborator changed this since" (SPEC.md section 6, "Undo").

import {
  assertNever,
  queuedEditId,
  scriptFingerprint,
  textTargetKey,
  transformIndex,
  type CommandEnvelope,
  type CommandRejection,
  type Composition,
  type DocumentChange,
  type DocumentSnapshot,
  type EditSettlement,
  type EditorState,
  type HistoryOutcome,
  type QueuedEdit,
  type Selection,
  type SlideId,
  type TextDelta,
  type TextTargetKey,
} from "../../contracts/index.ts";
import { asEditText } from "./command-kinds.ts";
import { findElement, findSlide, findSlideIndex, textBodyOf } from "./document-lookup.ts";
import { raiseNotice } from "./editor-queue.ts";
import { selectionSlideId, surviveDocument } from "./editor-selection.ts";
import { rebaseQueueOnRevision, transformQueueThroughDelta } from "./text-transform.ts";

export const COLLABORATOR_CHANGED_MESSAGE = "a collaborator changed this since";

export function reduceDocumentChanged(state: EditorState, change: DocumentChange): EditorState {
  const ownCommandId = ownCommandIdOf(change);
  let pendingEdits = state.pendingEdits;
  let inFlightCommandIds = state.inFlightCommandIds;
  let selection = state.selection;
  let composition = state.textEditing.composition;
  if (ownCommandId !== null) {
    pendingEdits = pendingEdits.filter((edit) => queuedEditId(edit) !== ownCommandId);
    inFlightCommandIds = inFlightCommandIds.filter((commandId) => commandId !== ownCommandId);
  } else {
    for (const [key, delta] of change.textChanges) {
      const transformed = transformQueueThroughDelta({ pendingEdits, key, delta });
      pendingEdits = transformed.pendingEdits;
      selection = moveTextSelection(selection, key, transformed.deltaAfterQueue);
      composition = moveComposition(composition, key, transformed.deltaAfterQueue);
    }
  }
  pendingEdits = rebaseQueueOnRevision(pendingEdits, change.snapshot.revision);

  const updated: EditorState = {
    ...state,
    document: change.snapshot,
    history: change.history,
    pendingEdits,
    inFlightCommandIds,
    selection,
    textEditing: { ...state.textEditing, composition },
  };
  return surviveChange(updated, state.document);
}

export function reduceEditSettled(state: EditorState, settlement: EditSettlement): EditorState {
  switch (settlement.kind) {
    case "command": {
      const outcome = settlement.outcome;
      switch (outcome.kind) {
        case "applied": {
          const queued = state.pendingEdits.some((edit) => queuedEditId(edit) === outcome.commandId);
          if (!queued) return state;
          // The change for this revision is already reduced (synchronous store, or a no-op envelope).
          if (outcome.revision <= state.document.revision) {
            return { ...state, pendingEdits: state.pendingEdits.filter((edit) => queuedEditId(edit) !== outcome.commandId) };
          }
          if (state.inFlightCommandIds.includes(outcome.commandId)) return state;
          return { ...state, inFlightCommandIds: [...state.inFlightCommandIds, outcome.commandId] };
        }
        case "rejected":
          return rejectEnvelope(state, outcome.commandId, outcome.rejection);
        default:
          return assertNever(outcome);
      }
    }
    case "history":
      return settleHistory(state, settlement.commandId, settlement.outcome);
    default:
      return assertNever(settlement);
  }
}

export function rejectionMessage(rejection: CommandRejection): string {
  switch (rejection.reason) {
    case "slideMissing":
      return "That slide was deleted, so the change was not made.";
    case "elementMissing":
      return "That object was deleted, so the change was not made.";
    case "layoutMissing":
      return "That layout no longer exists.";
    case "transitionScriptMissing":
      return "That transition script no longer exists.";
    case "assetMissing":
      return "That image is not stored yet.";
    case "tableLineMissing":
      return "That table row or column was deleted.";
    case "animationStepMissing":
      return "That animation was removed.";
    case "duplicateId":
      return "Something with the same identity already exists, so the change was not made.";
    case "invalidId":
      return "The change used an identifier the document cannot store.";
    case "invalidValue":
      return `The change was not made: ${rejection.message}`;
    case "wrongKind":
      return `That change does not apply to a ${rejection.actual}.`;
    case "groupCycle":
      return "A group cannot contain itself.";
    case "textOutOfRange":
      return "The text changed under the edit, so it was not applied.";
    case "staleText":
      return "The text changed while you typed; the last keystroke was not applied.";
    case "staleScript":
      return "Someone saved this script since you opened it.";
    case "staleApproval":
      return "Someone changed this script after you reviewed it, so it was not approved. Review the new version.";
    case "approvalNeedsPerson":
      return "Only a person can approve a transition script.";
    default:
      return assertNever(rejection);
  }
}

function ownCommandIdOf(change: DocumentChange): QueuedEditCommandId | null {
  switch (change.origin.kind) {
    case "local":
      return change.origin.commandId;
    case "remote":
    case "history":
    case "seed":
    case "repair":
      return null;
    default:
      return assertNever(change.origin);
  }
}

type QueuedEditCommandId = ReturnType<typeof queuedEditId>;

function moveTextSelection(selection: Selection, key: TextTargetKey, delta: TextDelta): Selection {
  switch (selection.kind) {
    case "text":
      if (textTargetKey(selection.target) !== key) return selection;
      return {
        ...selection,
        anchor: transformIndex({ delta, index: selection.anchor, bias: "before" }),
        focus: transformIndex({ delta, index: selection.focus, bias: "before" }),
      };
    case "none":
    case "slides":
    case "elements":
    case "tableCells":
      return selection;
    default:
      return assertNever(selection);
  }
}

function moveComposition(composition: Composition | null, key: TextTargetKey, delta: TextDelta): Composition | null {
  if (composition === null || textTargetKey(composition.target) !== key) return composition;
  // Only the start moves: the browser owns the composed text and the view keeps the frozen body.
  return { ...composition, startIndex: transformIndex({ delta, index: composition.startIndex, bias: "before" }) };
}

/** Drop what pointed at things the change removed, and follow the script dialog's own save. */
function surviveChange(state: EditorState, previousDocument: DocumentSnapshot): EditorState {
  const currentSlideId = survivingSlideId(state, previousDocument);
  const slideChanged = currentSlideId !== state.currentSlideId;
  const enteredGroupId = enteredGroupSurvives(state, currentSlideId) ? state.enteredGroupId : null;
  const composition = state.textEditing.composition;
  const survivingComposition = composition !== null && textBodyOf(state.document, composition.target) === null ? null : composition;
  const composer = state.chrome.composer;
  const survivingComposer = composerSurvives(state, composer) ? composer : ({ kind: "closed" } as const);
  return {
    ...state,
    currentSlideId,
    enteredGroupId,
    selection: surviveDocument(state),
    gesture: slideChanged ? { kind: "idle" } : state.gesture,
    textEditing: survivingComposition === composition ? state.textEditing : { ...state.textEditing, composition: survivingComposition },
    chrome: { ...state.chrome, composer: survivingComposer, dialog: followScriptSave(state) },
  };
}

function enteredGroupSurvives(state: EditorState, slideId: SlideId | null): boolean {
  if (state.enteredGroupId === null) return true;
  if (slideId === null) return false;
  const slide = findSlide(state.document, slideId);
  return slide !== null && findElement(slide, state.enteredGroupId) !== null;
}

function survivingSlideId(state: EditorState, previousDocument: DocumentSnapshot): SlideId | null {
  const current = state.currentSlideId;
  if (current !== null && findSlide(state.document, current) !== null) return current;
  if (state.document.slides.length === 0) return null;
  const previousIndex = current === null ? 0 : Math.max(0, findSlideIndex(previousDocument, current));
  const neighbour = state.document.slides[Math.min(previousIndex, state.document.slides.length - 1)];
  return neighbour?.id ?? null;
}

function composerSurvives(state: EditorState, composer: EditorState["chrome"]["composer"]): boolean {
  switch (composer.kind) {
    case "closed":
      return true;
    case "composing":
      return findSlide(state.document, composer.slideId) !== null;
    default:
      return assertNever(composer);
  }
}

/** The script dialog's base moves to the saved record once OUR text is what the document holds. */
function followScriptSave(state: EditorState): EditorState["chrome"]["dialog"] {
  const dialog = state.chrome.dialog;
  switch (dialog.kind) {
    case "transitionScriptEditor": {
      const record = state.document.transitionScripts.find((script) => script.id === dialog.editor.draft.id);
      if (record === undefined || record.updatedAt === dialog.editor.basedOnUpdatedAt) return dialog;
      const ours = scriptFingerprint(record) === scriptFingerprint(dialog.editor.draft);
      if (!ours) return dialog;
      return { ...dialog, editor: { ...dialog.editor, basedOnUpdatedAt: record.updatedAt, conflict: false } };
    }
    case "none":
    case "insertImage":
    case "insertTable":
    case "linkEditor":
    case "keyboardShortcuts":
    case "renameDeck":
    case "newSlideFromLayout":
      return dialog;
    default:
      return assertNever(dialog);
  }
}

function rejectEnvelope(state: EditorState, commandId: QueuedEditCommandId, rejection: CommandRejection): EditorState {
  const index = state.pendingEdits.findIndex((edit) => queuedEditId(edit) === commandId);
  const rejected = state.pendingEdits[index];
  const envelope = rejected === undefined ? null : envelopeOf(rejected);
  const textKeys = new Set(envelope === null ? [] : textKeysOf(envelope));
  // Text edits queued on top of the rejected one were computed against text that will never exist.
  const pendingEdits = state.pendingEdits.filter((edit, editIndex) => {
    if (editIndex === index) return false;
    if (editIndex < index || textKeys.size === 0) return true;
    const later = envelopeOf(edit);
    return later === null || !textKeysOf(later).some((key) => textKeys.has(key));
  });
  const selection = envelope !== null && textKeys.size > 0 ? envelope.selectionBefore : state.selection;
  const withoutEdit: EditorState = {
    ...state,
    pendingEdits,
    inFlightCommandIds: state.inFlightCommandIds.filter((inFlight) => inFlight !== commandId),
  };
  const survived: EditorState = { ...withoutEdit, selection: surviveDocument({ ...withoutEdit, selection }) };
  const dialog = survived.chrome.dialog;
  switch (rejection.reason) {
    case "staleScript":
      switch (dialog.kind) {
        case "transitionScriptEditor":
          if (dialog.editor.draft.id === rejection.scriptId) {
            return { ...survived, chrome: { ...survived.chrome, dialog: { ...dialog, editor: { ...dialog.editor, conflict: true } } } };
          }
          break;
        case "none":
        case "insertImage":
        case "insertTable":
        case "linkEditor":
        case "keyboardShortcuts":
        case "renameDeck":
        case "newSlideFromLayout":
          break;
        default:
          assertNever(dialog);
      }
      break;
    case "slideMissing":
    case "elementMissing":
    case "layoutMissing":
    case "transitionScriptMissing":
    case "assetMissing":
    case "tableLineMissing":
    case "animationStepMissing":
    case "duplicateId":
    case "invalidId":
    case "invalidValue":
    case "wrongKind":
    case "groupCycle":
    case "textOutOfRange":
    case "staleText":
    case "staleApproval":
    case "approvalNeedsPerson":
      break;
    default:
      assertNever(rejection);
  }
  return raiseNotice(survived, { tone: "warning", message: rejectionMessage(rejection), action: null });
}

function settleHistory(state: EditorState, commandId: QueuedEditCommandId, outcome: HistoryOutcome): EditorState {
  const removed: EditorState = {
    ...state,
    pendingEdits: state.pendingEdits.filter((edit) => queuedEditId(edit) !== commandId),
    textEditing: { ...state.textEditing, composition: null },
  };
  switch (outcome.kind) {
    case "applied": {
      const selected = surviveDocument({ ...removed, selection: outcome.selection });
      const slideId = selectionSlideId(selected);
      const restored: EditorState = {
        ...removed,
        selection: selected,
        currentSlideId: slideId !== null && findSlide(removed.document, slideId) !== null ? slideId : removed.currentSlideId,
      };
      if (outcome.skippedSteps === 0) return restored;
      return raiseNotice(restored, { tone: "information", message: `Skipped ${outcome.skippedSteps} step${outcome.skippedSteps === 1 ? "" : "s"}: ${COLLABORATOR_CHANGED_MESSAGE}.`, action: null });
    }
    case "nothingToDo":
      if (outcome.skippedSteps === 0) return removed;
      return raiseNotice(removed, { tone: "information", message: `Nothing changed: ${COLLABORATOR_CHANGED_MESSAGE}.`, action: null });
    default:
      return assertNever(outcome);
  }
}

function envelopeOf(edit: QueuedEdit): CommandEnvelope | null {
  switch (edit.kind) {
    case "apply":
      return edit.envelope;
    case "undo":
    case "redo":
      return null;
    default:
      return assertNever(edit);
  }
}

function textKeysOf(envelope: CommandEnvelope): readonly TextTargetKey[] {
  return envelope.commands.flatMap((command) => {
    const editText = asEditText(command);
    return editText === null ? [] : [textTargetKey(editText.target)];
  });
}
