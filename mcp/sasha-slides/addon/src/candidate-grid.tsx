// THE GRID: every candidate at once, two columns, rows as needed. One of the editor's two ZOOM
// LEVELS, not a screen of its own.
//
// UI-CONTRACT.md: "`N` candidates in two columns, rows as needed. Each cell renders the candidate's
// own HTML in an iframe, scaled down, never a screenshot -- the HTML is authoritative and a
// thumbnail would lie. Cells are numbered 1..N, matching `PICK.picked`, `await_pick`, and what the
// user says out loud."
//
// FOUR SLIDES AT ONCE IS THE REQUIREMENT, not a nice-to-have. Two columns inside a ~1000 px dialog
// gives each cell about 470 px -- 1.6x the whole old sidebar -- and two rows of them fit without
// scrolling, so a four-candidate proposal is comparable in one glance. The grid scrolls rather
// than shrinking further when there are more: a cell too small to read is worse than a scroll.
//
// WHAT CHANGED, AND WHY THE CELL IS NO LONGER A BUTTON. The cell used to be one big `<button>` that
// "opened" the candidate -- which is exactly the behaviour UI-CONTRACT.md's "The popup IS the
// editor" forbids: clicking a slide entered a different screen where annotation suddenly became
// possible. Now the cell's PICTURE belongs to the current tool (`SlideStage`): the annotate tool
// gets the drag gesture right here in the grid, and the edit tool gets the visual editor on the
// selected cell. Changing the zoom level is a NAMED control in the footer, because a picture that
// is also a navigation target cannot host a gesture.

import type { JSX } from "react";
import { SlideStage } from "./slide-stage.tsx";
import type { Region } from "./protocol.ts";
import {
  describeUnresolvedCount,
  unresolvedBadgeOf,
  unresolvedCountFor,
  type UnresolvedCount,
} from "./session-log.ts";
import type { Offer, SlideFrame, SlideRendering, SlideTool } from "./picker-state.ts";

export function CandidateGrid({
  offer,
  disabled,
  editedIndex,
  onEditFrame,
  onZoom,
  onInsert,
  onReport,
  insertable,
  reportOpening,
  onDraw,
}: {
  offer: Offer;
  disabled: boolean;
  /**
   * The candidate the visual editor is attached to, or null when the edit tool cannot reach any of
   * them. Exactly one cell at a time: the editor's chrome is host-level and one instance owns it.
   */
  editedIndex: number | null;
  onEditFrame: (element: HTMLIFrameElement | null) => void;
  onZoom: (index: number) => void;
  /** Put THIS candidate in the deck. One button per cell -- see `CandidateCell`. */
  onInsert: (index: number) => void;
  /** Report a defect in THIS candidate, same reason. */
  onReport: (spec: Readonly<{ index: number }>) => void;
  /** Whether inserting is possible at all (a tab that is not an editable presentation). */
  insertable: boolean;
  /** The report window is already being opened; a second press would open a second one. */
  reportOpening: boolean;
  onDraw: (spec: Readonly<{ index: number; region: Region }>) => void;
}): JSX.Element {
  return (
    <div className="sasha-grid" role="list" aria-label={`${offer.slides.length} candidate slides`}>
      {offer.slides.map((frame) => (
        <CandidateCell
          key={frame.index}
          frame={frame}
          rendering={offer.rendering}
          /* THE GRID NEVER TAKES THE POINTER. It is where four candidates are compared, not
             where one is worked on -- marking up and selecting both happen in the editor, which
             opens on the candidate you pick. The cells still DRAW the marks already on a slide
             (slide-stage.tsx), they just do not accept the gesture. */
          tool="select"
          chosen={frame.index === offer.selectedIndex}
          unresolved={unresolvedCountFor({
            comments: offer.comments,
            proposalId: offer.proposal.proposalId,
            slideIndex: frame.index,
          })}
          disabled={disabled}
          onEditFrame={frame.index === editedIndex ? onEditFrame : null}
          onZoom={onZoom}
          onInsert={onInsert}
          onReport={onReport}
          insertable={insertable}
          reportOpening={reportOpening}
          onDraw={onDraw}
        />
      ))}
    </div>
  );
}

function CandidateCell({
  frame,
  rendering,
  tool,
  chosen,
  unresolved,
  disabled,
  onEditFrame,
  onZoom,
  onInsert,
  onReport,
  insertable,
  reportOpening,
  onDraw,
}: {
  frame: SlideFrame;
  rendering: SlideRendering;
  tool: SlideTool;
  chosen: boolean;
  unresolved: UnresolvedCount;
  disabled: boolean;
  onEditFrame: ((element: HTMLIFrameElement | null) => void) | null;
  onZoom: (index: number) => void;
  onInsert: (index: number) => void;
  onReport: (spec: Readonly<{ index: number }>) => void;
  insertable: boolean;
  reportOpening: boolean;
  onDraw: (spec: Readonly<{ index: number; region: Region }>) => void;
}): JSX.Element {
  return (
    <div className={cellClass({ chosen, edited: onEditFrame !== null })} role="listitem">
      <span className="sasha-stage sasha-cell-stage">
        <SlideStage
          frame={frame}
          rendering={rendering}
          tool={tool}
          // THE GRID NEVER PAINTS THE CONVERTER'S FINDINGS. It is where four candidates are
          // compared, and outlining every lossy element on all of them is noise over the
          // comparison -- which is exactly what the user reported seeing.
          showFindings={false}
          disabled={disabled}
          onEditFrame={onEditFrame}
          onDraw={onDraw}
        />
        <span className="sasha-cell-number" aria-hidden="true">
          {frame.index}
        </span>
        <CellUnresolved count={unresolved} />
        {/* THE WHOLE PICTURE IS THE TARGET, and it is a transparent button over the stage rather
            than a handler on it: the slide is an IFRAME, which swallows the pointer, so a click
            on the thing the user is actually looking at would otherwise never arrive. It is last
            in the stage so it sits above the marks, and it carries the pointer cursor. */}
        <button
          type="button"
          className="sasha-cell-open"
          disabled={disabled}
          title={`Request changes for option ${String(frame.index)}`}
          aria-label={`Open option ${String(frame.index)} to request changes`}
          onClick={() => onZoom(frame.index)}
        />
      </span>
      {/* TWO BUTTONS, AND NOTHING ELSE. The cell used to carry a name chip, a "Show large" button
          and a line of status -- the index is on the picture, "large" is what clicking it does,
          and the status was a sentence nobody could act on. What is left is the two decisions a
          candidate can receive: put it in the deck, or say it is broken. */}
      <footer className="sasha-cell-foot">
        <button
          type="button"
          className="sasha-secondary sasha-small"
          disabled={disabled || reportOpening}
          title={REPORT_EXPLANATION}
          onClick={() => onReport({ index: frame.index })}
        >
          Report defect
        </button>
        <button
          type="button"
          className="sasha-primary sasha-small"
          disabled={disabled || !insertable}
          title={
            insertable
              ? `Put option ${String(frame.index)} in the deck`
              : "this tab is not an editable presentation"
          }
          onClick={() => onInsert(frame.index)}
        >
          Insert
        </button>
      </footer>
    </div>
  );
}

/**
 * THE UNRESOLVED COUNT, ON THE CELL -- the same number the conversation shows beside that slide's
 * events, from the same `unresolvedCountFor` over the same `SlideCommentsLoad` (UI-CONTRACT.md:
 * "The two are reading the same state and must never disagree").
 *
 * There is NO arm that renders a zero for an answer this surface does not have. `unresolvedBadgeOf`
 * returns "?" when the comments have not been read and "!" when they could not be, because
 * `UnresolvedCount` has no zero in those cases to render by mistake.
 */
function CellUnresolved({ count }: { count: UnresolvedCount }): JSX.Element | null {
  const badge = unresolvedBadgeOf(count);
  if (badge === null) return null;
  return (
    <span
      className={`sasha-cell-unresolved sasha-unresolved-${count.kind}`}
      title={describeUnresolvedCount(count)}
      aria-label={describeUnresolvedCount(count)}
    >
      {badge}
    </span>
  );
}

function cellClass({ chosen, edited }: { chosen: boolean; edited: boolean }): string {
  const classes = ["sasha-cell"];
  if (chosen) classes.push("sasha-cell-on");
  if (edited) classes.push("sasha-cell-edited");
  return classes.join(" ");
}

/** Why you would press Report defect. On the button, because the cell's row has no words to spare. */
const REPORT_EXPLANATION =
  "Opens the same editor on two slides -- this one as it is, and as it would be sent -- and sends only what you approve.";
