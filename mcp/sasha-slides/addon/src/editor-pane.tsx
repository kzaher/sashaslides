// ONE SLIDE IN THE VISUAL EDITOR, with a caption and its own list of edits -- the unit the defect
// report puts two of side by side (UI-CONTRACT.md, "The defect report is the same editor, not a
// table").
//
// WHY IT IS ITS OWN FILE. The slides window attaches the editor to the candidate it is working on
// (editor-slot.tsx, one at a time, because there is one selection). The report attaches it to TWO
// documents at once -- the slide as it is and the slide as it will be sent -- and each needs its own
// frame, its own instance and its own lifetime. That is a pane, and a pane is the thing worth
// sharing; "the host supplies the iframe and decides when to persist" is satisfied once, here.
//
// THE LIFETIME IS SCOPE-BOUND. `attach` happens in an effect and `detach` in its cleanup, so a
// changed document, a changed editor or an unmounted pane releases it on EVERY path including a
// throw (coding skill, resource management: the scope owns the lifetime, never a hand-written pair
// of calls).
//
// THE FRAME IS LOADED ONCE PER DOCUMENT AND EDITED IN PLACE. `html` must therefore be STABLE while
// the user works: the editor mutates the live DOM and reports a serialization, and feeding that
// serialization back in as `srcDoc` would reload the frame after every gesture. See
// `sourceFrameHtmlOf` / `sentFrameHtmlOf` in defect-state.ts for the two selectors that keep that
// straight.

import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { ScaledHtmlFrame } from "./scaled-frame.tsx";
import { describeSlideEdit, type SlideEdit, type SlideEditor } from "./slide-editor.ts";

export function EditorPane({
  title,
  blurb,
  tone,
  html,
  missing,
  createEditor,
  edits,
  disabled,
  onChange,
  onReset,
  children,
}: {
  title: string;
  blurb: string;
  /** `sent` is the pane whose bytes leave the browser, and it is drawn as such. */
  tone: EditorPaneTone;
  /** The document to load, or null when there is none yet. MUST be stable while editing. */
  html: string | null;
  /** What to say when `html` is null. A pane with no document explains itself. */
  missing: string;
  createEditor: (spec: Readonly<{ html: string }>) => SlideEditor;
  edits: readonly SlideEdit[];
  disabled: boolean;
  onChange: (spec: Readonly<{ html: string; edits: readonly SlideEdit[] }>) => void;
  onReset: () => void;
  /** Annotations pinned to this slide, rendered in the gutter beside its stage. */
  children?: ReactNode;
}): JSX.Element {
  const [element, setElement] = useState<HTMLIFrameElement | null>(null);
  const editor = useMemo(() => createEditor({ html: html ?? "" }), [createEditor, html]);

  useEffect(() => {
    if (element === null || html === null || disabled) return;
    // The editor is the authority on both halves of what it did: the records AND the serialization.
    // The host asks it for both at the same moment, so the two can never describe different states.
    editor.attach({ frame: element, onChange: (reported) => onChange({ html: editor.html(), edits: reported }) });
    return () => editor.detach();
  }, [editor, element, html, disabled, onChange]);

  return (
    <figure className={`sasha-pane-side sasha-pane-${tone}`}>
      <figcaption className="sasha-pane-cap">
        <strong>{title}</strong>
        <span className="sasha-dim">{blurb}</span>
      </figcaption>
      {/*
        THE SLIDE AND ITS MARGIN. The notes go in a GUTTER beside the stage, not on top of it: the
        stage is `overflow: hidden` (it has to be -- it clips a 1280x720 document scaled into it),
        so a pin column inside it is silently clipped the moment there is one pin too many. Silent
        clipping on the panel the user is told to read before sending is the failure this codebase
        has already fixed twice. Out here the figure simply grows.
      */}
      <div className="sasha-pane-body">
        <div className="sasha-stage sasha-pane-stage">
          {html === null ? (
            <p className="sasha-dim sasha-placeholder">{missing}</p>
          ) : (
            <ScaledHtmlFrame html={html} title={title} onFrame={setElement} editable />
          )}
        </div>
        {children}
      </div>
      <PaneEdits edits={edits} disabled={disabled} onReset={onReset} />
    </figure>
  );
}

/** Which slide a pane is. `sent` is the one whose bytes leave; `source` never leaves the browser. */
export type EditorPaneTone = "source" | "sent";

/**
 * WHAT THE USER CHANGED ON THIS SLIDE, in the editor's own sentences (`describeEdit`), with one way
 * to take all of it back. The editor is the authority on what one of its edits means, so the list
 * is not reworded here -- the same rule editor-slot.tsx follows.
 */
function PaneEdits({
  edits,
  disabled,
  onReset,
}: {
  edits: readonly SlideEdit[];
  disabled: boolean;
  onReset: () => void;
}): JSX.Element {
  return (
    <div className="sasha-pane-edits">
      <span className="sasha-dim">
        {edits.length === 0
          ? "Click anything on this slide to move, resize, recolour or retype it."
          : `${edits.length} of your edit${edits.length === 1 ? "" : "s"} on this slide`}
      </span>
      {edits.length === 0 ? null : (
        <button type="button" className="sasha-secondary sasha-small" disabled={disabled} onClick={onReset}>
          Undo all of them
        </button>
      )}
      {edits.length === 0 ? null : (
        <ul className="sasha-edits">
          {edits.map((edit, position) => (
            <li key={`${edit.kind}_${edit.target}_${position}`} className="sasha-edit">
              {describeSlideEdit(edit)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
