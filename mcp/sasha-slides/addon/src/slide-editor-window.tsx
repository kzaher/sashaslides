// THE EDITOR: one candidate, open on top of the grid.
//
// WHY IT IS A WINDOW AND NOT A MODE. The grid is where four candidates are still being compared,
// so it carries exactly one choice -- preview or original -- and nothing that is about a single
// slide. Everything that IS about one candidate lives here: the tools, the element selection and
// the comment threads. The grid stays mounted underneath with its scroll position and its
// selection, so closing comes back to where the user was.
//
// THREE COLUMNS, and the order is the order of the work:
//
//   left    the toolbar -- what the pointer is. Select, or Annotate.
//   centre  the slide, large, with the element inspector under it.
//   right   the threads: what has been asked about this candidate and what Sasha said back.
//
// The toolbar is DOWN THE LEFT EDGE rather than along the top because it is the only chrome that
// persists while the user works; a horizontal row of mode buttons above the slide is what made
// the old window read as a cockpit.

import { useState, type JSX } from "react";
import {
  AnomalyList,
  SlideStage,
  TOOL_GLYPH,
  TOOL_HINT,
  TOOL_LABEL,
  TOOL_ORDER,
  type PickerActions,
} from "./Picker.tsx";
import { EditorAttachment, EditorSlot } from "./editor-slot.tsx";
import {
  selectedFrame,
  unsentMarkUps,
  type EditorReach,
  type Offer,
  type SlideTool,
} from "./picker-state.ts";
import type { SlideEdit, SlideEditor } from "./editor/index.ts";
import { ThreadRail } from "./thread-rail.tsx";
import { ElementInspector } from "./element-inspector.tsx";
import { SelectionComposer } from "./selection-composer.tsx";

export function SlideEditorWindow({
  offer,
  reach,
  editor,
  element,
  onEditFrame,
  busy,
  onChange,
  actions,
}: {
  offer: Offer;
  reach: EditorReach;
  editor: SlideEditor;
  element: HTMLIFrameElement | null;
  /**
   * Null whenever the open candidate must NOT be reachable -- the annotate tool is live, or the
   * converted rendering is showing. `sandbox="allow-same-origin"` is honoured only at load, so
   * this is what makes the grant follow the tool rather than outlive it (slide-stage.tsx).
   */
  onEditFrame: ((element: HTMLIFrameElement | null) => void) | null;
  busy: boolean;
  onChange: (edits: readonly SlideEdit[]) => void;
  actions: PickerActions;
}): JSX.Element | null {
  /*
   * LEAVING WITH WORDS TYPED AND UNSENT IS A QUESTION, not a silent loss.
   *
   * A box with no words in it is a rectangle the user drew and thought better of, and closing
   * over it costs nothing. A box WITH words that never reached Drive is work about to be thrown
   * away, and throwing it away without asking is the one thing a review surface may not do.
   */
  const [asking, setAsking] = useState(false);
  const frame = selectedFrame(offer);
  const unsent = unsentMarkUps(offer);

  const close = (): void => {
    if (unsent.length > 0) {
      setAsking(true);
      return;
    }
    actions.closeEditor();
  };

  /*
   * A CANDIDATE THE MANIFEST NO LONGER HAS is said out loud, never rendered as nothing.
   * `clampIndex` makes it unreachable through the reducer, but a proposal can be re-announced
   * with fewer slides under an open editor -- and a window that silently went blank would look
   * like the add-on had crashed.
   */
  if (frame === null) {
    return (
      <div className="sasha-editor-scrim">
        <section className="sasha-editor" role="dialog" aria-label="Candidate unavailable">
          <header className="sasha-editor-head">
            <p className="sasha-editor-title">Candidate unavailable</p>
            <button type="button" className="sasha-editor-close" onClick={actions.closeEditor} aria-label="Close the editor">
              &#x2715;
            </button>
          </header>
          <p className="sasha-trouble">
            option {offer.editing === null ? offer.selectedIndex : offer.editing} is missing from the manifest, so there
            is nothing to show. Close this and pick another candidate.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="sasha-editor-scrim">
      <section
        className="sasha-editor"
        role="dialog"
        aria-label={`Candidate ${String(frame.index)}: ${frame.label}`}
      >
        <header className="sasha-editor-head">
          <p className="sasha-editor-title">
            <b>{frame.index}</b> {frame.label}
          </p>
          <button type="button" className="sasha-editor-close" onClick={close} aria-label="Close the editor">
            &#x2715;
          </button>
        </header>

        {asking ? <LeaveWarning count={unsent.length} onStay={() => setAsking(false)} onLeave={actions.closeEditor} /> : null}

        {/* BOTH TOOLS POINT AT ELEMENTS, so the editor is attached for both. It is not inside
            either tool's panel: that is what made switching to annotate detach it. */}
        <EditorAttachment editor={editor} frame={element} onChange={onChange} />

        <div className="sasha-editor-body">
          <ToolRail tool={offer.tool} disabled={busy} onChoose={actions.chooseTool} />

          <div className="sasha-editor-main">
            <div className="sasha-editor-stage">
              <SlideStage
                frame={frame}
                tool={offer.tool}
                rendering={offer.rendering}
                showFindings={offer.showFindings}
                disabled={busy}
                onDraw={actions.drawAnomaly}
                onEditFrame={onEditFrame}
              />
              {/* THE COMPOSER OPENS ON WHAT WAS CLICKED. Inside the stage, so its 0-1 placement
                  is against the slide the comment is about (selection-comment.ts). */}
              {offer.tool === "annotate" && offer.selection !== null ? (
                <SelectionComposer
                  key={offer.selection.target}
                  target={offer.selection.target}
                  region={offer.selection.region}
                  disabled={busy}
                  onComment={({ region, note }) =>
                    actions.commentOnSelection({ index: frame.index, region, note })
                  }
                  onDismiss={actions.clearSelection}
                />
              ) : null}
            </div>

            {/* WHAT IS UNDER THE SLIDE BELONGS TO THE TOOL. The visual editor's list and the
                markup of the selected element are the SELECT tool's working area; while the
                annotate tool is live there is no selection and no edit to show, and leaving them
                there put two panels of someone else's chrome between the slide and the boxes the
                user is drawing. UNDER the slide rather than beside it, because what is selected
                is read with the thing itself and needs the width more than the slide does. */}
            {offer.tool === "select" ? (
              <>
                <EditorSlot
                  editor={editor}
                  frame={element}
                  reach={reach}
                  edits={frame.edits}
                  disabled={busy}
                  onChange={onChange}
                />
                <ElementInspector
                  html={offer.selection?.html ?? null}
                  selector={offer.selection?.target ?? null}
                  disabled={busy}
                  onApply={({ html }) => actions.applyMarkup({ index: frame.index, html })}
                />
              </>
            ) : null}
            <p className="sasha-dim sasha-editor-say">
              {TOOL_HINT[offer.tool]}
              {/* WHAT THE CONVERTER COULD NOT CARRY, on request. It used to be painted over
                  every candidate the moment it appeared, which read as marks the user had made
                  (slide-stage.tsx). */}
              <button type="button" className="sasha-findings" aria-pressed={offer.showFindings} onClick={actions.toggleFindings}>
                {offer.showFindings ? "Hide what Sasha could not carry" : "Show what Sasha could not carry"}
              </button>
            </p>
          </div>

          <ThreadRail offer={offer} frame={frame} disabled={busy} actions={actions} />
        </div>

        {/* The mark-ups drawn but not yet sent, with their note fields -- the annotate tool's own
            working area. It stays under the three columns so a box drawn on the slide and the row
            it created are on screen together. */}
        {offer.tool === "annotate" ? <AnomalyList offer={offer} disabled={busy} actions={actions} /> : null}
      </section>
    </div>
  );
}

/**
 * THE TOOLBAR, down the left edge. One button per tool, a total lookup over `SlideTool`, so a
 * third tool is a compile error here rather than a button nobody rendered.
 */
function ToolRail({
  tool,
  disabled,
  onChoose,
}: {
  tool: SlideTool;
  disabled: boolean;
  onChoose: (tool: SlideTool) => void;
}): JSX.Element {
  return (
    <nav className="sasha-toolrail" aria-label="Tools">
      {TOOL_ORDER.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className={candidate === tool ? "sasha-toolbtn sasha-toolbtn-on" : "sasha-toolbtn"}
          aria-pressed={candidate === tool}
          disabled={disabled}
          title={TOOL_HINT[candidate]}
          onClick={() => onChoose(candidate)}
        >
          <span className="sasha-toolbtn-glyph" aria-hidden="true">
            {TOOL_GLYPH[candidate]}
          </span>
          <span className="sasha-toolbtn-name">{TOOL_LABEL[candidate]}</span>
        </button>
      ))}
    </nav>
  );
}

/** What would be lost, said as a number, with the two things the user can do about it. */
function LeaveWarning({
  count,
  onStay,
  onLeave,
}: {
  count: number;
  onStay: () => void;
  onLeave: () => void;
}): JSX.Element {
  return (
    <div className="sasha-leave" role="alertdialog" aria-label="Unsent mark-ups">
      <p className="sasha-leave-head">
        {count === 1 ? "1 mark-up has not been sent." : `${String(count)} mark-ups have not been sent.`}
      </p>
      <p className="sasha-leave-say">
        Sasha has not seen {count === 1 ? "it" : "them"} yet. Close and {count === 1 ? "it stays" : "they stay"} here
        as a draft on this candidate; send first and Sasha can answer.
      </p>
      <div className="sasha-leave-acts">
        <button type="button" className="sasha-secondary" onClick={onLeave}>
          Close anyway
        </button>
        <button type="button" className="sasha-primary" onClick={onStay}>
          Keep working
        </button>
      </div>
    </div>
  );
}
