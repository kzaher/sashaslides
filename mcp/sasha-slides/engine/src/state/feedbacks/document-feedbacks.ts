// THE TWO FEEDBACKS BETWEEN THE EDITOR AND THE DOCUMENT STORE (SPEC.md section 6): the only writer
// to the shared document, and the only way its changes come back.
//
//  * APPLY EDITS hands the oldest queued edit to `DocumentStore.apply` / `undo` / `redo` and reports
//    the verdict as `editSettled`. One at a time, and never while a command waits in
//    `inFlightCommandIds` for its change (a store that settles later): the next edit's
//    `basedOnRevision` is only right once the previous change has been reduced. With the synchronous
//    store, the change and the verdict are both reduced before the next keystroke (the mailbox drains
//    feedback events first), so typing never waits.
//
//  * STORE CHANGES turns every transaction -- local, remote, undo, repair -- into `documentChanged`,
//    and the discussion log's snapshots into `discussionChanged`.
//
// A store that throws is reported through `reportError` and turned into a rejection, so the queue
// moves on and the user sees a notice instead of an editor that silently stops saving.

import { defer, merge, of, type Observable } from "rxjs";
import { map } from "rxjs/operators";
import {
  assertNever,
  queuedEditId,
  type DiscussionStore,
  type DocumentStore,
  type EditorEvent,
  type EditorState,
  type Feedback,
  type QueuedEdit,
} from "../../contracts/index.ts";
import { react } from "../rxfeedback/react-feedbacks.ts";

/** How a feedback reports a failure it handled (the application logs it with what was being attempted). */
export type ReportError = (error: unknown, context: string) => void;

export function applyEditsFeedback(dependencies: Readonly<{ documentStore: DocumentStore; reportError: ReportError }>): Feedback<EditorState, EditorEvent> {
  return react<EditorState, QueuedEdit, EditorEvent>({
    query: (state) => (state.inFlightCommandIds.length === 0 ? (state.pendingEdits[0] ?? null) : null),
    areEqual: (previous, next) => queuedEditId(previous) === queuedEditId(next),
    effects: (edit) => defer(() => of(applyOne(edit, dependencies))),
  });
}

export function storeChangesFeedback(dependencies: Readonly<{ documentStore: DocumentStore; discussionStore: DiscussionStore }>): Feedback<EditorState, EditorEvent> {
  return (): Observable<EditorEvent> =>
    merge(
      dependencies.documentStore.changes.pipe(map((change): EditorEvent => ({ kind: "documentChanged", change }))),
      dependencies.discussionStore.changes.pipe(map((snapshot): EditorEvent => ({ kind: "discussionChanged", snapshot }))),
    );
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyOne(edit: QueuedEdit, dependencies: Readonly<{ documentStore: DocumentStore; reportError: ReportError }>): EditorEvent {
  try {
    switch (edit.kind) {
      case "apply":
        return { kind: "editSettled", settlement: { kind: "command", outcome: dependencies.documentStore.apply(edit.envelope) } };
      case "undo":
        return { kind: "editSettled", settlement: { kind: "history", commandId: edit.commandId, outcome: dependencies.documentStore.undo() } };
      case "redo":
        return { kind: "editSettled", settlement: { kind: "history", commandId: edit.commandId, outcome: dependencies.documentStore.redo() } };
      default:
        return assertNever(edit);
    }
  } catch (error: unknown) {
    dependencies.reportError(error, `applying ${edit.kind} ${queuedEditId(edit)}`);
    switch (edit.kind) {
      case "apply":
        return {
          kind: "editSettled",
          settlement: {
            kind: "command",
            outcome: { kind: "rejected", commandId: edit.envelope.commandId, rejection: { reason: "invalidValue", path: "", message: messageOf(error) } },
          },
        };
      case "undo":
      case "redo":
        return { kind: "editSettled", settlement: { kind: "history", commandId: edit.commandId, outcome: { kind: "nothingToDo", skippedSteps: 0 } } };
      default:
        return assertNever(edit);
    }
  }
}
