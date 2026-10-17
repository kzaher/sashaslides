// THE STATE MODULE'S SURFACE: the RxFeedback toolkit the presenter receives by injection, the editor
// system the view's composition roots run, and the two pure selectors the view calls directly (the
// clipboard payload inside a copy handler, the comment rail's thread placement). Tests import the
// reducer and its parts from their own files.

export { createSystem } from "./rxfeedback/create-system.ts";
export { react, reactSet } from "./rxfeedback/react-feedbacks.ts";
export { createEditorSystem } from "./editor-system.ts";
export { clipboardContentFor } from "./editor/clipboard.ts";
export { arrangeThreads } from "./editor/arrange-threads.ts";
