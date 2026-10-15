// THE SCRIPT DIALOG'S STATE (SPEC.md section 9): a plain-text draft of a scripted transition, saved
// whole (scripts are plain strings, last writer wins, never shared text). A save names the
// `updatedAt` it started from; the model rejects `staleScript` when someone saved since, and the
// dialog then offers "reload theirs" or "overwrite" (document-changes.ts sets `conflict`). A person's
// save approves the text it saved; "Approve" approves an agent's or a pasted script's exact
// fingerprint.

import { assertNever, type EditorState, type SlideId, type TransitionScriptDraft, type TransitionScriptId } from "../../contracts/index.ts";
import { queueEnvelope } from "./editor-queue.ts";
import { createIdMinter } from "./id-minter.ts";

/** What "New script" starts from: a working fade the user (or Claude) edits. */
export const NEW_SCRIPT_TEMPLATE = [
  "sashaTransition.define({",
  '  name: "New transition",',
  "  async run(context) {",
  "    await context.animate(context.incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: context.durationMilliseconds }).finished;",
  "  },",
  "});",
  "",
].join("\n");

export function openScriptEditor(state: EditorState, scriptId: TransitionScriptId | null): EditorState {
  const record = scriptId === null ? undefined : state.document.transitionScripts.find((script) => script.id === scriptId);
  if (record !== undefined) {
    const draft: TransitionScriptDraft = {
      id: record.id,
      name: record.name,
      description: record.description,
      script: record.script,
      stylesheet: record.stylesheet,
      markup: record.markup,
      defaultParameters: record.defaultParameters,
    };
    return withEditor(state, { draft, basedOnUpdatedAt: record.updatedAt, conflict: false, previewGeneration: 0 });
  }
  const minter = createIdMinter(state.idSeed);
  const draft: TransitionScriptDraft = {
    id: minter.next("transitionScript"),
    name: "New transition",
    description: "",
    script: NEW_SCRIPT_TEMPLATE,
    stylesheet: "",
    markup: "",
    defaultParameters: {},
  };
  return withEditor({ ...state, idSeed: minter.seed() }, { draft, basedOnUpdatedAt: null, conflict: false, previewGeneration: 0 });
}

export function changeScriptDraft(state: EditorState, draft: TransitionScriptDraft): EditorState {
  const editor = currentEditor(state);
  if (editor === null) return state;
  return withEditor(state, { ...editor, draft: { ...draft, id: editor.draft.id } });
}

/** Save; `overwrite` (after a conflict) bases the save on the newer record, replacing it. */
export function saveScript(state: EditorState, overwrite: boolean): EditorState {
  const editor = currentEditor(state);
  if (editor === null) return state;
  const record = state.document.transitionScripts.find((script) => script.id === editor.draft.id);
  const basedOnUpdatedAt = overwrite ? (record?.updatedAt ?? null) : editor.basedOnUpdatedAt;
  const queued = queueEnvelope(state, {
    commands: [{ kind: "upsertTransitionScript", script: editor.draft, basedOnUpdatedAt, approval: "authorDecides" }],
    selectionAfter: state.selection,
    mergeWithPrevious: false,
  });
  return withEditor(queued, { ...editor, conflict: false });
}

/** "Reload theirs": the draft becomes the stored record again. */
export function reloadScript(state: EditorState): EditorState {
  const editor = currentEditor(state);
  if (editor === null) return state;
  return openScriptEditor(state, editor.draft.id);
}

export function approveScript(state: EditorState, scriptId: TransitionScriptId, fingerprint: string): EditorState {
  return queueEnvelope(state, { commands: [{ kind: "approveTransitionScript", scriptId, fingerprint }], selectionAfter: state.selection, mergeWithPrevious: false });
}

export function previewTransition(state: EditorState, slideId: SlideId): EditorState {
  const generation = (state.chrome.transitionPreview?.generation ?? 0) + 1;
  const editor = currentEditor(state);
  const previewed = editor === null ? state : withEditor(state, { ...editor, previewGeneration: editor.previewGeneration + 1 });
  return { ...previewed, chrome: { ...previewed.chrome, transitionPreview: { slideId, generation } } };
}

type ScriptEditorState = Extract<EditorState["chrome"]["dialog"], { kind: "transitionScriptEditor" }>["editor"];

function currentEditor(state: EditorState): ScriptEditorState | null {
  const dialog = state.chrome.dialog;
  switch (dialog.kind) {
    case "transitionScriptEditor":
      return dialog.editor;
    case "none":
    case "insertImage":
    case "insertTable":
    case "linkEditor":
    case "keyboardShortcuts":
    case "renameDeck":
    case "newSlideFromLayout":
      return null;
    default:
      return assertNever(dialog);
  }
}

function withEditor(state: EditorState, editor: ScriptEditorState): EditorState {
  return { ...state, chrome: { ...state.chrome, dialog: { kind: "transitionScriptEditor", editor } } };
}
