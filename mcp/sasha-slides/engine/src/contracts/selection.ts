// WHAT THE USER HAS SELECTED. Local editor state (never stored in the document), but it travels in
// three places that are not the editor: undo history (the model restores the selection an undo
// step was taken with), presence (collaborators see your selection) and command envelopes. So it
// is its own contract rather than a field buried in editor-state.ts.
//
// A discriminated union, not a bag of optional ids, because the editor's behaviour forks on it
// everywhere (Delete removes slides, elements or characters; the properties panel shows slide,
// element or text controls) and every fork must be an exhaustive switch.
//
// Text indices here are plain numbers in the body's index space (document.ts). They are kept
// current by `transformIndex` (text-delta.ts) on every document change; where a selection must
// survive OTHER people's edits for longer -- inside the undo history -- the model stores it as Yjs
// relative positions instead (document-store.ts).

import type { ElementId, SlideId, TableColumnId, TableRowId } from "./ids.ts";

export type Selection =
  | Readonly<{ kind: "none" }>
  /** Slides selected in the filmstrip (Delete, duplicate, reorder, skip act on them). Non-empty. */
  | Readonly<{ kind: "slides"; slideIds: readonly SlideId[] }>
  /** Elements on one slide. Non-empty. A group's child appears here only after "enter group". */
  | Readonly<{ kind: "elements"; slideId: SlideId; elementIds: readonly ElementId[] }>
  /** A caret (anchor === focus) or range inside one text body. */
  | Readonly<{ kind: "text"; target: TextTarget; anchor: number; focus: number }>
  /** A rectangle of table cells, from anchor cell to focus cell inclusive. */
  | Readonly<{ kind: "tableCells"; slideId: SlideId; elementId: ElementId; anchor: CellAddress; focus: CellAddress }>;

export type CellAddress = Readonly<{ rowId: TableRowId; columnId: TableColumnId }>;

/**
 * Every rich text body the editor can type into. Transition scripts are NOT text targets: they are
 * plain strings edited in their own dialog (document.ts `TransitionScriptRecord`), so Tab, list
 * levels and paragraph styling never reach code.
 */
export type TextTarget =
  | Readonly<{ kind: "element"; slideId: SlideId; elementId: ElementId }>
  | Readonly<{ kind: "tableCell"; slideId: SlideId; elementId: ElementId; cell: CellAddress }>
  | Readonly<{ kind: "speakerNotes"; slideId: SlideId }>;
