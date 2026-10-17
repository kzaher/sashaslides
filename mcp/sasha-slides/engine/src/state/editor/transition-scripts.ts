// THE SCRIPT DIALOG'S STATE (SPEC.md section 9): a plain-text draft of a scripted transition or a
// scripted build step (its `purpose`, chosen when a NEW script is opened), saved
// whole (scripts are plain strings, last writer wins, never shared text). A save names the
// `updatedAt` it started from; the model rejects `staleScript` when someone saved since, and the
// dialog then offers "reload theirs" or "overwrite" (document-changes.ts sets `conflict`). A person's
// save approves the text it saved; "Approve" approves an agent's or a pasted script's exact
// fingerprint.

import { assertNever, type EditorState, type ScriptPurpose, type SlideId, type TransitionScriptDraft, type TransitionScriptId } from "../../contracts/index.ts";
import { queueCommands } from "./editor-queue.ts";
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

/**
 * What "New script" starts from in the Animate tab: a build step. A scripted step's run gets the
 * slide BEFORE the step as `outgoing` and AFTER it as `incoming`, with parameters
 * `{ ...defaults, ...step parameters, targetElementId, category }`; this one fades and lifts the
 * step's element in on the incoming side.
 */
export const NEW_ANIMATION_SCRIPT_TEMPLATE = [
  "sashaTransition.define({",
  '  name: "New build step",',
  "  async run(context) {",
  '    const targets = context.elements("incoming").filter((element) => element.elementId === context.parameters.targetElementId);',
  "    const keyframes = context.reducedMotion",
  "      ? [{ opacity: 0 }, { opacity: 1 }]",
  '      : [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }];',
  '    await Promise.all(targets.map((target) => context.animate(target.node, keyframes, { duration: context.durationMilliseconds, easing: "ease-out" }).finished));',
  "  },",
  "});",
  "",
].join("\n");

/**
 * The dialog over a stored script, or over a new draft for `purpose` (an existing script keeps its
 * own purpose: the purpose is part of what its approval covers).
 */
export function openScriptEditor(state: EditorState, options: Readonly<{ scriptId: TransitionScriptId | null; purpose: ScriptPurpose }>): EditorState {
  const record = options.scriptId === null ? undefined : state.document.transitionScripts.find((script) => script.id === options.scriptId);
  if (record !== undefined) {
    const draft: TransitionScriptDraft = {
      id: record.id,
      name: record.name,
      description: record.description,
      purpose: record.purpose,
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
    name: NEW_SCRIPT_NAME[options.purpose],
    description: "",
    purpose: options.purpose,
    script: NEW_SCRIPT_TEMPLATE_FOR[options.purpose],
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
  const queued = queueCommands(state, [{ kind: "upsertTransitionScript", script: editor.draft, basedOnUpdatedAt, approval: "authorDecides" }]);
  return withEditor(queued, { ...editor, conflict: false });
}

/** "Reload theirs": the draft becomes the stored record again. */
export function reloadScript(state: EditorState): EditorState {
  const editor = currentEditor(state);
  if (editor === null) return state;
  return openScriptEditor(state, { scriptId: editor.draft.id, purpose: editor.draft.purpose });
}

export function approveScript(state: EditorState, scriptId: TransitionScriptId, fingerprint: string): EditorState {
  return queueCommands(state, [{ kind: "approveTransitionScript", scriptId, fingerprint }]);
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

const NEW_SCRIPT_NAME: Readonly<Record<ScriptPurpose, string>> = { transition: "New transition", animation: "New build step" };

const NEW_SCRIPT_TEMPLATE_FOR: Readonly<Record<ScriptPurpose, string>> = { transition: NEW_SCRIPT_TEMPLATE, animation: NEW_ANIMATION_SCRIPT_TEMPLATE };
