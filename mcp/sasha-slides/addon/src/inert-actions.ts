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
import { nullSlideEditor } from "./slide-editor.ts";

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
  selectSlide() {},
  openEditor() {},
  closeEditor() {},
  applyMarkup() {},
  replyToThread() {},
  resolveThread() {},
  chooseView() {},
  chooseTool() {},
  chooseRendering() {},
  toggleFindings() {},
  drawAnomaly() {},
  noteAnomaly() {},
  removeAnomaly() {},
  commentOnSelection() {},
  clearSelection() {},
  sendAnomaly() {},
  zoomCandidate() {},
  changeEdits() {},
  insertPicked() {},
  dismiss() {},
  openReport() {},
  // The real factory is dialog.tsx's; the null editor is what the dialog ships with anyway, so a
  // rendered tree in a test exercises the same slot the user sees.
  createEditor({ html }) {
    return nullSlideEditor({ html });
  },
};

export const INERT_CONVERSATION_ACTIONS: ConversationActions = {
  typeMessage() {},
  send() {},
  refresh() {},
  showSlides() {},
  reportDefect() {},
  typeReply() {},
  reply() {},
  resolve() {},
  chooseCommentFilter() {},
  openArtifact() {},
};
