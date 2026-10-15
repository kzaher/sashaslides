// QUEUING EFFECTS AS STATE. Every document change the editor wants is a `CommandEnvelope` appended to
// `pendingEdits` (the apply feedback hands it to the store); every message to the user is a `Notice`
// whose expiry a feedback times. Both mint their ids from `idSeed`, so this file is where a reduce
// step turns an intent into an effect request -- and the place that enforces the rule from
// editor-state.ts: queuing an envelope moves `selection` to its `selectionAfter` AT ONCE.
//
// It also answers "what will this text body be": the snapshot's body with every queued `editText`
// replayed over it (text-model.ts), because the caret already lives in that future.

import {
  assertNever,
  DOCUMENT_SCHEMA_VERSION,
  textTargetKey,
  type CommandAuthor,
  type DocumentCommand,
  type EditorState,
  type Notice,
  type NoticeAction,
  type Selection,
  type TextTarget,
} from "../../contracts/index.ts";
import { asEditText } from "./command-kinds.ts";
import { textBodyOf } from "./document-lookup.ts";
import { createIdMinter } from "./id-minter.ts";
import { applyTextOperations, flattenBody, type FlatText } from "./text-model.ts";

/** How long a notice of each tone stays when it expires by itself; errors stay until dismissed. */
export const NOTICE_LIFETIME_MILLISECONDS: Readonly<Record<Notice["tone"], number | null>> = {
  information: 6000,
  warning: 10000,
  error: null,
};

export type EnvelopeRequest = Readonly<{
  commands: readonly DocumentCommand[];
  selectionAfter: Selection;
  mergeWithPrevious: boolean;
  /** Who the envelope acts for; the signed-in person unless stated (clipboard.ts pastes foreign scripts). */
  author?: CommandAuthor;
}>;

/** Append one envelope (one undo step) and show its `selectionAfter` now. */
export function queueEnvelope(state: EditorState, request: EnvelopeRequest): EditorState {
  if (request.commands.length === 0) return { ...state, selection: request.selectionAfter };
  if (isReadOnly(state)) return state;
  const minter = createIdMinter(state.idSeed);
  const commandId = minter.next("command");
  return {
    ...state,
    idSeed: minter.seed(),
    selection: request.selectionAfter,
    pendingEdits: [
      ...state.pendingEdits,
      {
        kind: "apply",
        envelope: {
          commandId,
          author: request.author ?? { kind: "person", personId: state.me.id },
          commands: request.commands,
          selectionBefore: state.selection,
          selectionAfter: request.selectionAfter,
          mergeWithPrevious: request.mergeWithPrevious,
        },
      },
    ],
  };
}

export function queueHistory(state: EditorState, direction: "undo" | "redo"): EditorState {
  if (state.textEditing.composition !== null) return state;
  const minter = createIdMinter(state.idSeed);
  const commandId = minter.next("command");
  return { ...state, idSeed: minter.seed(), pendingEdits: [...state.pendingEdits, { kind: direction, commandId }] };
}

export function raiseNotice(
  state: EditorState,
  notice: Readonly<{ tone: Notice["tone"]; message: string; action: NoticeAction | null }>,
): EditorState {
  const minter = createIdMinter(state.idSeed);
  const id = minter.next("notice");
  return {
    ...state,
    idSeed: minter.seed(),
    notices: [...state.notices, { id, tone: notice.tone, message: notice.message, action: notice.action, expiresAfterMilliseconds: NOTICE_LIFETIME_MILLISECONDS[notice.tone] }],
  };
}

/** A document from a newer schema opens read-only (SPEC.md section 5, "Versions"). */
export function isReadOnly(state: EditorState): boolean {
  return state.document.schemaVersion > DOCUMENT_SCHEMA_VERSION;
}

/** The body as it will be once every queued edit on it applies; null when the body is gone. */
export function optimisticText(state: EditorState, target: TextTarget): FlatText | null {
  const body = textBodyOf(state.document, target);
  if (body === null) return null;
  const key = textTargetKey(target);
  let items = flattenBody(body);
  for (const edit of state.pendingEdits) {
    switch (edit.kind) {
      case "undo":
      case "redo":
        continue;
      case "apply":
        for (const command of edit.envelope.commands) {
          const editText = asEditText(command);
          if (editText === null || textTargetKey(editText.target) !== key) continue;
          items = applyTextOperations(items, editText.operations);
        }
        continue;
      default:
        assertNever(edit);
    }
  }
  return items;
}
