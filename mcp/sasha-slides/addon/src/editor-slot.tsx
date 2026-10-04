// THE VISUAL EDITOR'S SLOT -- the one place the picker touches `SlideEditor`, and the EDIT tool's
// own panel. It is not tied to a zoom level: the editor attaches to the selected candidate's frame
// whether that frame is a grid cell or the single large pane (UI-CONTRACT.md, "The popup IS the
// editor").
//
// The editor module is NOT this package's (see slide-editor.ts); this file is the host half of the
// seam UI-CONTRACT.md specifies -- "The host supplies the iframe and decides when to persist. The
// editor never calls the server." So:
//
//   * the iframe comes from the annotation view's own pane, handed in as an element;
//   * `attach` happens in an effect and `detach` in its cleanup, so swapping candidate or closing
//     the view releases the editor on EVERY path, including a throw (typescript skill, resource
//     management: the scope owns the lifetime, never a hand-written pair of calls);
//   * every change is dispatched into the picker's state tree, because a Drive poll re-renders this
//     whole component and anything kept in component state would be lost mid-edit.
//
// Until `src/editor/` lands, `nullSlideEditor` fills the slot: zero edits, HTML unchanged, `undo()`
// false. The slot still says what it is for, because an empty box with no explanation is the thing
// this project has already shipped once.

import { useEffect, type JSX } from "react";
import { describeEditorReach, editorIsLive, type EditorReach } from "./picker-state.ts";
import { describeSlideEdit, type SlideEdit, type SlideEditor } from "./slide-editor.ts";

export function EditorSlot({
  editor,
  frame,
  reach,
  edits,
  disabled,
  onChange,
}: {
  editor: SlideEditor;
  /** The edited candidate's iframe, or null before it has been laid out -- or when `reach` refuses. */
  frame: HTMLIFrameElement | null;
  /**
   * WHY THE EDITOR IS OR IS NOT LIVE, from the state tree. A slot that simply sat empty when the
   * converted pane was showing was the "grey box with no explanation" this project has shipped
   * once already; `describeEditorReach` is the sentence instead.
   */
  reach: EditorReach;
  edits: readonly SlideEdit[];
  disabled: boolean;
  onChange: (edits: readonly SlideEdit[]) => void;
}): JSX.Element {
  useEffect(() => {
    if (frame === null) return;
    editor.attach({ frame, onChange });
    return () => editor.detach();
  }, [editor, frame, onChange]);

  return (
    <section className="sasha-editor" aria-label="visual editor">
      {/*
        ONE ROW WHEN THERE IS NOTHING TO LIST, and that is a measurement, not a taste.
        This panel is ALWAYS on screen now -- it is the edit tool's panel, and edit is the default --
        so every pixel it takes in its empty state is a pixel the grid does not get. At the 1000x760
        the dialog asks for, a two-line explanatory paragraph under a header took the panel to 55px
        and pushed the third candidate below the fold, which breaks the grid's own promise that two
        rows are comparable in one glance (candidate-grid.tsx). The browser smoke test measures the
        whole vertical budget and fails on it, so this cannot drift back.

        Nothing was cut: the sentence is still there in full, as the header's own caption, and the
        panel grows into a list the moment there is an edit to list.
      */}
      <header className="sasha-header">
        <strong>Visual edits</strong>
        <span className="sasha-dim">{caption({ frame, edits, reach })}</span>
        {edits.length === 0 ? (
          <span className="sasha-dim">{EMPTY_EXPLANATION}</span>
        ) : (
          <button
            type="button"
            className="sasha-secondary sasha-small"
            disabled={disabled}
            onClick={() => {
              // `undo` answers false when there is nothing to undo; the list is re-read either way,
              // so the state tree always matches the editor rather than this component's guess at it.
              editor.undo();
              onChange(editor.edits());
            }}
          >
            Undo
          </button>
        )}
      </header>
      {editorIsLive(reach) ? null : <p className="sasha-trouble">{describeEditorReach(reach)}</p>}
      {edits.length === 0 ? null : (
        <ul className="sasha-edits">
          {edits.map((edit, position) => (
            <li key={`${edit.kind}_${edit.target}_${position}`} className="sasha-edit">
              {describeSlideEdit(edit)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What an edit here means, in one line. The whole sentence, on the row the caption is on. */
const EMPTY_EXPLANATION =
  "-- what you move, resize, recolour or retype travels to Sasha as the change itself, never as the slide's markup.";

/**
 * The count comes FIRST, before "no frame yet": edits are recorded in the state tree, so they
 * outlive a re-render that has not laid the iframe out again, and reporting "waiting" over a list
 * of real edits would be a lie about work the user has already done.
 */
function caption({
  frame,
  edits,
  reach,
}: {
  frame: HTMLIFrameElement | null;
  edits: readonly SlideEdit[];
  reach: EditorReach;
}): string {
  if (edits.length > 0) return `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  if (!editorIsLive(reach)) return "not editable right now";
  return frame === null ? "waiting for the candidate to render" : "no edits yet";
}
