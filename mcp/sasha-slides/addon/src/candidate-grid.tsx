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
import { assertNever, type Region } from "./protocol.ts";
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
  onSelect,
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
  onSelect: (index: number) => void;
  onDraw: (spec: Readonly<{ index: number; region: Region }>) => void;
}): JSX.Element {
  return (
    <div className="sasha-grid" role="list" aria-label={`${offer.slides.length} candidate slides`}>
      {offer.slides.map((frame) => (
        <CandidateCell
          key={frame.index}
          frame={frame}
          rendering={offer.rendering}
          tool={offer.tool}
          chosen={frame.index === offer.selectedIndex}
          unresolved={unresolvedCountFor({
            comments: offer.comments,
            proposalId: offer.proposal.proposalId,
            slideIndex: frame.index,
          })}
          disabled={disabled}
          onEditFrame={frame.index === editedIndex ? onEditFrame : null}
          onZoom={onZoom}
          onSelect={onSelect}
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
  onSelect,
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
  onSelect: (index: number) => void;
  onDraw: (spec: Readonly<{ index: number; region: Region }>) => void;
}): JSX.Element {
  return (
    <div className={cellClass({ chosen, edited: onEditFrame !== null })} role="listitem">
      <span className="sasha-stage sasha-cell-stage">
        <SlideStage
          frame={frame}
          rendering={rendering}
          tool={tool}
          disabled={disabled}
          onEditFrame={onEditFrame}
          onDraw={onDraw}
        />
        <CellUnresolved count={unresolved} />
      </span>
      <footer className="sasha-cell-foot">
        <button
          type="button"
          className={chosen ? "sasha-chip sasha-chip-on" : "sasha-chip"}
          disabled={disabled}
          aria-pressed={chosen}
          aria-label={`work on candidate ${frame.index}`}
          onClick={() => onSelect(frame.index)}
        >
          <span className="sasha-chip-number">{frame.index}</span>
          <span className="sasha-chip-label">{frame.label === "" ? frame.name : frame.label}</span>
        </button>
        <button
          type="button"
          className="sasha-secondary sasha-small sasha-zoom"
          disabled={disabled}
          aria-label={`show candidate ${frame.index} large`}
          onClick={() => onZoom(frame.index)}
        >
          Show large
        </button>
        <span className="sasha-dim sasha-cell-hint">{hintFor({ frame, unresolved, edited: onEditFrame !== null })}</span>
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

/**
 * The one line under a cell: whether the editor is on it, what its open comments are, or -- when
 * there is nothing else to report -- its LOAD STATE in words, so a candidate that never arrived
 * says so on the cell rather than leaving an empty grey box (UI-CONTRACT.md: "A surface that cannot
 * reach the server says so"). A FAILED load outranks everything: a comment opened before the
 * document failed is not the thing to say first.
 */
function hintFor({
  frame,
  unresolved,
  edited,
}: {
  frame: SlideFrame;
  unresolved: UnresolvedCount;
  edited: boolean;
}): string {
  if (frame.html.kind === "failed") return "could not be loaded";
  if (edited) return "the editor is on this one";
  // AN OPEN COMMENT OUTRANKS A LOCAL MARK-UP: one is waiting for Sasha, the other is waiting for
  // the user to press Send. A mark-up not yet sent outranks the comment count's OWN state, because
  // the badge already carries that ("?" / "!") and repeating it on every cell before the first read
  // would bury the one thing the user can act on.
  if (unresolved.kind === "known" && unresolved.count > 0) return describeUnresolvedCount(unresolved);
  if (frame.anomalies.length > 0) return `${frame.anomalies.length} marked, not sent`;
  if (unresolved.kind !== "known") return describeUnresolvedCount(unresolved);
  return loadHint(frame);
}

function loadHint(frame: SlideFrame): string {
  switch (frame.html.kind) {
    case "unrequested":
    case "loading":
      return "loading";
    case "failed":
      return "could not be loaded";
    case "loaded":
      return "pick it to work on it";
    default:
      return assertNever(frame.html);
  }
}
