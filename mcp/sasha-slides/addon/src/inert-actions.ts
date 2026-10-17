// TEST-ONLY: action objects that do nothing, so the React tree can be rendered with no ports.
//
// It lives in its own file rather than in each test because several test files render the same
// trees, and `PickerActions` / `ConversationActions` / `DefectActions` are exactly the kind of
// injected dependency the style guide wants SUBSTITUTED rather than stubbed in place. It is
// excluded from tsconfig.json (the shipped-sources gate) the same way fake-drive.ts is: nothing
// that ships imports it.

import type { ConversationActions } from "./Conversation.tsx";
import type { DefectActions } from "./Defect.tsx";
import type { PickerActions } from "./Picker.tsx";
import type { SetupEnvironment } from "./setup-guide.tsx";
import type { SlideEditor } from "./editor/index.ts";

export const INERT_DEFECT_ACTIONS: DefectActions = {
  chooseView() {},
  editRun() {},
  resetRun() {},
  editSource() {},
  resetSource() {},
  editSent() {},
  resetSent() {},
  reanonymise() {},
  choosePolicy() {},
  typeNote() {},
  typeEndpoint() {},
  prepare() {},
  send() {},
  close() {},
  // The report attaches an editor to EACH pane, and the null one is what a server-rendered tree
  // needs: zero edits, html unchanged, nothing to undo -- the same code path the user exercises
  // before touching anything.
  createEditor({ html }) {
    return nullSlideEditor({ html });
  },
};

export const INERT_PICKER_ACTIONS: PickerActions = {
  openEditor() {},
  closeEditor() {},
  applyMarkup() {},
  replyToThread() {},
  resolveThread() {},
  chooseTool() {},
  chooseRendering() {},
  toggleFindings() {},
  drawAnomaly() {},
  noteAnomaly() {},
  removeAnomaly() {},
  commentOnSelection() {},
  clearSelection() {},
  sendAnomaly() {},
  changeEdits() {},
  insertPicked() {},
  dismiss() {},
  openReport() {},
  // The real factory is dialog.tsx's; the null editor gives a rendered tree the same slot with
  // nothing attached to it.
  createEditor({ html }) {
    return nullSlideEditor({ html });
  },
};

export const INERT_CONVERSATION_ACTIONS: ConversationActions = {
  openArtifact() {},
  setCandidateArchived() {},
  chooseCandidateTab() {},
  allowCommentAccessOpened() {},
};

/**
 * A `SlideEditor` that does nothing, for a tree rendered with no browser.
 *
 * It is not a silent no-op: it reports zero edits and returns the candidate's HTML UNCHANGED, which
 * is exactly true of a session in which nothing was edited. `undo()` answers false -- there is
 * nothing to undo -- which is the contract's own answer, not a special case.
 */
export function nullSlideEditor({ html }: { html: string }): SlideEditor {
  return {
    attach() {},
    edits: () => [],
    html: () => html,
    undo: () => false,
    selection: () => null,
    replaceSelected: () => false,
    detach() {},
  };
}

/** A build with no hosted connector address, and a viewer whose storage remembers nothing. */
export const UNCONFIGURED_SETUP: SetupEnvironment = {
  repoRoot: "/workspaces/sashaslides",
  connectorUrl: null,
  store: { load: () => null, save() {} },
};
