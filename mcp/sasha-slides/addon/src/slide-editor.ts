// THE HOST'S SIDE of the visual editor's seam: what the picker codes against, and the do-nothing
// implementation the dialog ships with today.
//
// THE EDITOR ITSELF IS NOT THIS PACKAGE'S. It is a standalone module at `src/editor/`, built
// against the `SlideEditor` interface UI-CONTRACT.md declares, with no knowledge of Apps Script,
// Drive or the picker's state machine. Its types are IMPORTED from `./editor/index.ts` and
// re-exported here rather than restated: a second declaration of `SlideEdit` would compile
// perfectly and then drift (an earlier draft of this file had `recoloured.property: string` where
// the editor has a two-value `ColourProperty`), and the whole point of one interface is that there
// is one. `./editor/index.ts` is that module's public surface -- nothing here reaches deeper.
//
// WHAT IS LEFT HERE is the part the HOST owns:
//   * `nullSlideEditor`, the stub the annotation view's slot holds until the real editor is wired
//     in. It is declared with the imported `SlideEditor` type, so the day `createSlideEditor`
//     replaces it (one line, in dialog.tsx's `createEditor`) the compiler has already proved the
//     two are interchangeable.
//   * `slideEditRecord`, the shape that travels to the model.
//
// WHAT TRAVELS TO THE MODEL (UI-CONTRACT.md, "The edit record"): a structured record, never the
// slide's markup. `target` is a stable CSS selector, geometry is FRACTIONAL against the 1280x720
// slide -- the same convention `PICK.anomalies` and the feedback sentinel already use -- and
// `retext.to` is the one place slide text legitimately crosses, because the user typed it.

import type { SlideEdit, SlideEditor } from "./editor/index.ts";

export {
  SLIDE_HEIGHT_PX,
  SLIDE_WIDTH_PX,
  // Renamed on the way through only so the host's call sites read as host code; it is the editor's
  // own sentence for an edit, and the editor is the authority on what an edit means.
  describeEdit as describeSlideEdit,
  type FractionalPoint,
  type FractionalSize,
  type SlideEdit,
  type SlideEditor,
} from "./editor/index.ts";

/** The whole edit record for one candidate, as UI-CONTRACT.md specifies it. */
export type SlideEditRecord = Readonly<{
  protocolVersion: number;
  candidateIndex: number;
  edits: readonly SlideEdit[];
}>;

/**
 * A `SlideEditor` that does nothing, for the slot to hold until the real editor is wired in.
 *
 * It is not a silent no-op: it reports zero edits and returns the candidate's HTML UNCHANGED, which
 * is exactly true of a session in which nothing was edited, so every caller above it is already
 * exercising the real code path. `undo()` answers false -- there is nothing to undo -- which is the
 * contract's own answer, not a special case.
 */
export function nullSlideEditor({ html }: { html: string }): SlideEditor {
  return {
    attach() {
      /* nothing to attach to the frame: this editor has no behaviour to give it */
    },
    edits() {
      return [];
    },
    html() {
      return html;
    },
    undo() {
      return false;
    },
    /** It never selects anything, so there is never anything for the inspector to show. */
    selection() {
      return null;
    },
    /** With nothing selected there is nothing to replace, which is this editor's whole point. */
    replaceSelected() {
      return false;
    },
    detach() {
      /* nothing was attached */
    },
  };
}

/** The record that travels to the model. Separate from the editor so it is testable as a value. */
export function slideEditRecord({
  candidateIndex,
  edits,
  protocolVersion,
}: {
  candidateIndex: number;
  edits: readonly SlideEdit[];
  protocolVersion: number;
}): SlideEditRecord {
  return { protocolVersion, candidateIndex, edits };
}
