// THE STATE MODULE'S SURFACE (contracts/module-surfaces.ts `StateModule`): the RxFeedback toolkit the
// presenter receives by injection, the editor system the view's application shell runs, and the two
// pure selectors the view calls directly (the clipboard payload inside a copy handler, the comment
// rail's thread placement). Below the surface: the reducer, the key map and the layout remapping,
// exported for the view's keyboard handler and for tests that want them without a running system.

export { createSystem } from "./rxfeedback/create-system.ts";
export { react, reactSet } from "./rxfeedback/react-feedbacks.ts";
export { createEditorSystem } from "./editor-system.ts";
export { initialEditorState } from "./editor/initial-editor-state.ts";
export { clipboardContentFor } from "./editor/clipboard.ts";
export { arrangeThreads } from "./editor/arrange-threads.ts";

export { reduceEditor, applyKeyIntent } from "./editor/reduce-editor.ts";
export { chordToIntent, type KeyIntent } from "./editor/keyboard.ts";
export { remapSlideToLayout } from "./editor/layout-remap.ts";
export { alignUpdates, distributeUpdates } from "./editor/arrange.ts";
