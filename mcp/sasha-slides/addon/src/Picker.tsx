// THE SLIDES WINDOW'S UI -- the modeless popup that holds the candidates, and which IS the editor
// (UI-CONTRACT.md, "The popup IS the editor"). Pure React: every component is a function of
// PickerState plus the callbacks dialog.tsx hands it, and the only conditional rendering is an
// exhaustive switch over a discriminated union. No component fetches, decides or mutates anything
// -- the reducer in picker-state.ts owns all of that, and the feedback loops in dialog.tsx own the
// side effects.
//
// TWO INDEPENDENT AXES, AND NEITHER IS A SCREEN:
//
//   VIEW  grid | single      a ZOOM LEVEL. Every candidate at once, or one of them large.
//   TOOL  edit | annotate    what the pointer does. `edit` from the first paint.
//
// All four combinations are legal and reachable from the toolbar, which is the correction this file
// exists to carry. It used to hold ONE `surface` enum -- grid or "annotating" -- so a user had to
// click a cell to ENTER a screen before annotation became possible, and leaving that screen took
// the gesture away again. Now the zoom level and the tool are separate fields of `Offer`
// (picker-state.ts) and neither transition touches the other, so clicking a slide changes what you
// are looking at and never what you are allowed to do to it.
//
// REVIEW IS PRE-INSERT AND IT HAPPENS HERE. A mark-up SENT from the tool panel becomes a native
// Drive comment on the candidate's own `NN.html` -- not on the deck -- which is what lets Sasha
// answer it, resolve it and revise the slide. The old post-insert "review this deck" mode is gone
// (see picker-state.ts), and so is the defect-report mode: that is a third document now.

import { useMemo, useState, type JSX, type ReactNode } from "react";
import { PICKER_CSS } from "./picker-styles.ts";
import { CommentCard, CommentHead } from "./comment-card.tsx";
import { CandidateGrid } from "./candidate-grid.tsx";
import { collectDiagnostics, describeDiagnostics } from "./diagnostics.ts";
import { EditorSlot } from "./editor-slot.tsx";
import { assertNever, type Region } from "./protocol.ts";
import { describeRegion } from "./region-overlay.tsx";
import { SlideStage } from "./slide-stage.tsx";
import {
  describeUnresolvedCount,
  unresolvedBadgeOf,
  unresolvedCountFor,
  type UnresolvedCount,
} from "./session-log.ts";
import type { SlideEdit, SlideEditor } from "./slide-editor.ts";
import {
  anomaliesOf,
  editorIsLive,
  editorReachOf,
  editsSlides,
  isSendableAnomaly,
  loadedHtmlOf,
  selectedFrame,
  type AnomalySendPhase,
  type DraftAnomaly,
  type EditorReach,
  type Offer,
  type OpenPhase,
  type PickerState,
  type SlideFrame,
  type SlideRendering,
  type SlideTool,
  type SlideView,
  type SubmitStage,
} from "./picker-state.ts";

/** Everything the UI is allowed to cause. Injected, so the tree renders in a test with no ports. */
export type PickerActions = Readonly<{
  selectSlide(index: number): void;
  /** Change the ZOOM LEVEL. It may never change the tool -- that is the contract this window broke. */
  chooseView(view: SlideView): void;
  /** Change the TOOL. It may never change the zoom level, for the same reason. */
  chooseTool(tool: SlideTool): void;
  chooseRendering(rendering: SlideRendering): void;
  drawAnomaly(spec: Readonly<{ index: number; region: Region }>): void;
  noteAnomaly(spec: Readonly<{ index: number; anomalyId: string; note: string }>): void;
  removeAnomaly(spec: Readonly<{ index: number; anomalyId: string }>): void;
  /**
   * SEND one mark-up to Sasha, as a comment on the CANDIDATE. This is the pre-insert review path:
   * a comment on a candidate is art direction Sasha can act on, a comment on a deck page is a bug
   * report (UI-CONTRACT.md).
   */
  sendAnomaly(spec: Readonly<{ index: number; anomalyId: string }>): void;
  /** Show one candidate large. Selects it and changes the view; the tool is untouched. */
  zoomCandidate(index: number): void;
  /** The visual editor's list, after it changed. The editor is the authority; this records it. */
  changeEdits(spec: Readonly<{ index: number; edits: readonly SlideEdit[] }>): void;
  insertPicked(index: number): void;
  dismiss(): void;
  /**
   * ANONYMISE AND REPORT A DEFECT on one candidate. It opens a THIRD HtmlService document, not a
   * mode of this one: the anonymiser is the heaviest code in the product and this bundle has a hard
   * size ceiling. The request goes through the server, like every cross-surface signal.
   */
  openReport(spec: Readonly<{ index: number }>): void;
  /**
   * The VISUAL EDITOR, bound to one candidate's HTML. An injected FACTORY rather than an action,
   * because the editor is a dependency the composition root chooses (dialog.tsx picks the real
   * module or `nullSlideEditor`) and this tree must not know which it got. See slide-editor.ts.
   */
  createEditor(spec: Readonly<{ html: string }>): SlideEditor;
}>;

export function Picker({ state, actions }: { state: PickerState; actions: PickerActions }): JSX.Element | null {
  switch (state.status) {
    case "dormant":
      // An empty window reads as broken, because something deliberately opened it. So it says what
      // it is waiting for, and points back at the conversation -- the surface that is always there.
      return (
        <Shell>
          <section className="sasha-idle" aria-label="sasha-slides is waiting">
            <strong>Waiting for slides</strong>
            <p className="sasha-dim">
              Ask Sasha for a slide and the candidates appear here as soon as they are staged. You
              pick one, edit it or mark anything that is wrong -- which Sasha answers and revises --
              and it lands in this deck as editable objects.
            </p>
            <p className="sasha-dim">
              This window is watching your Drive. You can close it: Ask Sasha keeps the whole log,
              and &quot;See the slides&quot; brings this window back.
            </p>
          </section>
        </Shell>
      );
    case "cleared":
      // NEVER AN EMPTY GRID. A cleared proposal keeps its `READY`, so this window can be opened
      // onto a set that no longer exists -- and "it just showed nothing" is a failure this
      // protocol has already shipped once (PROTOCOL.md).
      return (
        <Shell>
          <section className="sasha-idle" aria-label="these candidates were discarded">
            <strong>Sasha discarded these slides</strong>
            <p className="sasha-dim">
              The candidates in {state.proposalId} that were not inserted are gone. Ask Sasha for
              another set in Ask Sasha -- the whole log of what happened is there.
            </p>
          </section>
        </Shell>
      );
    case "trouble":
      return (
        <Shell>
          <p className="sasha-trouble">sasha-slides: {state.message}</p>
          <p className="sasha-dim sasha-diag">{describeDiagnostics(readDiagnostics())}</p>
        </Shell>
      );
    case "settled":
      return (
        <Shell>
          <p className="sasha-settled">
            {state.picked === null
              ? `Dismissed ${state.proposalId}. Sasha has been told nothing was chosen.`
              : `Inserted option ${state.picked}. Sasha has been told.`}
          </p>
        </Shell>
      );
    case "picking":
      return (
        <Shell>
          <PickerDialog offer={state.offer} stage={null} actions={actions} />
        </Shell>
      );
    case "submitting":
      return (
        <Shell>
          <PickerDialog offer={state.offer} stage={state.stage} actions={actions} />
        </Shell>
      );
    default:
      return assertNever(state);
  }
}

/**
 * THE EDITOR, at whichever zoom level and with whichever tool the state says.
 *
 * The iframe element is held in COMPONENT state rather than the state tree on purpose: it is a DOM
 * node, not application state, and the visual editor is the only thing that wants it
 * (UI-CONTRACT.md: "the host supplies the iframe"). Everything the editor then REPORTS goes into
 * the tree through `changeEdits`, because a Drive poll re-renders this whole component and anything
 * kept in component state would be lost mid-edit.
 *
 * EXACTLY ONE STAGE IS EDITABLE AT A TIME -- the selected candidate's, and only while the edit tool
 * is live and the HTML pane is showing. The editor draws its chrome in the host document over one
 * frame, so a second attachment would fight the first for it; and the grid's other cells keep the
 * strictest sandbox, which is what UI-CONTRACT.md asks for.
 */
export function PickerDialog({
  offer,
  stage,
  actions,
}: {
  offer: Offer;
  stage: SubmitStage | null;
  actions: PickerActions;
}): JSX.Element {
  const busy = stage !== null;
  const [element, setElement] = useState<HTMLIFrameElement | null>(null);
  const frame = selectedFrame(offer);
  const reach = editorReachOf({ rendering: offer.rendering, frame });
  const editing = editsSlides(offer.tool) && editorIsLive(reach);
  const html = loadedHtmlOf(frame) ?? "";
  const editor = useMemo(() => actions.createEditor({ html }), [actions, html]);
  // Keyed on the NUMBER, not on the frame object: the frame is replaced on every recorded edit, and
  // a callback that changed identity with it would detach and re-attach the editor mid-gesture.
  const index = offer.selectedIndex;
  const onChange = useMemo(
    () => (edits: readonly SlideEdit[]) => actions.changeEdits({ index, edits }),
    [actions, index],
  );
  return (
    <section className="sasha-dialog" role="dialog" aria-label="sasha-slides candidate slides">
      <DialogHeader offer={offer} stage={stage} />
      <Toolbar offer={offer} disabled={busy} actions={actions} />
      <Workspace
        offer={offer}
        busy={busy}
        editedIndex={editing && frame !== null ? frame.index : null}
        onEditFrame={setElement}
        actions={actions}
      />
      <ToolPanel
        offer={offer}
        reach={reach}
        editor={editor}
        element={editing ? element : null}
        busy={busy}
        onChange={onChange}
        actions={actions}
      />
      <DialogActions offer={offer} stage={stage} actions={actions} />
    </section>
  );
}

/**
 * THE TOOLBAR: three independent choices, each its own group, each a total lookup table over its
 * union so adding a value is a compile error rather than a button nobody rendered.
 *
 * View and tool sit side by side BECAUSE they are independent. A single row of four buttons --
 * grid, single, annotate, edit -- would read as one four-way mode, which is the very confusion this
 * change removes.
 */
function Toolbar({
  offer,
  disabled,
  actions,
}: {
  offer: Offer;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  return (
    <div className="sasha-toolbar">
      <Chooser
        label="view"
        order={VIEW_ORDER}
        current={offer.view}
        labels={VIEW_LABEL}
        disabled={disabled}
        onChoose={actions.chooseView}
      />
      <Chooser
        label="tool"
        order={TOOL_ORDER}
        current={offer.tool}
        labels={TOOL_LABEL}
        disabled={disabled}
        onChoose={actions.chooseTool}
      />
      <Chooser
        label="showing"
        order={RENDERING_ORDER}
        current={offer.rendering}
        labels={RENDERING_LABEL}
        disabled={disabled}
        onChoose={actions.chooseRendering}
      />
      <span className="sasha-dim sasha-toolbar-say">{TOOL_HINT[offer.tool]}</span>
    </div>
  );
}

/**
 * One labelled group of mutually exclusive buttons. Generic over the union it chooses from, with
 * the order and the labels passed as a `readonly Choice[]` plus a `Record<Choice, string>` -- the
 * record is a TOTAL lookup table, so a new member of the union fails to compile here.
 */
function Chooser<Choice extends string>({
  label,
  order,
  current,
  labels,
  disabled,
  onChoose,
}: {
  label: string;
  order: readonly Choice[];
  current: Choice;
  labels: Readonly<Record<Choice, string>>;
  disabled: boolean;
  onChoose: (choice: Choice) => void;
}): JSX.Element {
  return (
    <div className="sasha-toggle" role="group" aria-label={label}>
      <span className="sasha-toggle-label">{label}</span>
      {order.map((choice) => (
        <button
          key={choice}
          type="button"
          disabled={disabled}
          aria-pressed={choice === current}
          className={choice === current ? "sasha-tab sasha-tab-on" : "sasha-tab"}
          onClick={() => onChoose(choice)}
        >
          {labels[choice]}
        </button>
      ))}
    </div>
  );
}

/** The zoom level. Exhaustive, so a third one is a compile error rather than a blank workspace. */
function Workspace({
  offer,
  busy,
  editedIndex,
  onEditFrame,
  actions,
}: {
  offer: Offer;
  busy: boolean;
  editedIndex: number | null;
  onEditFrame: (element: HTMLIFrameElement | null) => void;
  actions: PickerActions;
}): JSX.Element {
  switch (offer.view) {
    case "grid":
      return (
        <CandidateGrid
          offer={offer}
          disabled={busy}
          editedIndex={editedIndex}
          onEditFrame={onEditFrame}
          onZoom={actions.zoomCandidate}
          onSelect={actions.selectSlide}
          onDraw={actions.drawAnomaly}
        />
      );
    case "single":
      return (
        <SinglePane
          offer={offer}
          busy={busy}
          editedIndex={editedIndex}
          onEditFrame={onEditFrame}
          actions={actions}
        />
      );
    default:
      return assertNever(offer.view);
  }
}

/**
 * ONE CANDIDATE, LARGE. The same `SlideStage` the grid's cells use, so the tool behaves identically
 * at both zoom levels -- which is the whole claim of "the popup IS the editor".
 */
function SinglePane({
  offer,
  busy,
  editedIndex,
  onEditFrame,
  actions,
}: {
  offer: Offer;
  busy: boolean;
  editedIndex: number | null;
  onEditFrame: (element: HTMLIFrameElement | null) => void;
  actions: PickerActions;
}): JSX.Element {
  const frame = selectedFrame(offer);
  if (frame === null) {
    return (
      <div className="sasha-single">
        <SlideChips offer={offer} disabled={busy} onSelect={actions.selectSlide} />
        <p className="sasha-trouble">option {offer.selectedIndex} is missing from the manifest</p>
      </div>
    );
  }
  return (
    <div className="sasha-single">
      <div className="sasha-backbar">
        <button
          type="button"
          className="sasha-secondary sasha-small"
          disabled={busy}
          onClick={() => actions.chooseView("grid")}
        >
          Back to all candidates
        </button>
        <SlideChips offer={offer} disabled={busy} onSelect={actions.selectSlide} />
      </div>
      <div className="sasha-pane sasha-pane-big">
        <div className="sasha-stage">
          <SlideStage
            frame={frame}
            rendering={offer.rendering}
            tool={offer.tool}
            disabled={busy}
            onEditFrame={frame.index === editedIndex ? onEditFrame : null}
            onDraw={actions.drawAnomaly}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * WHAT THE CURRENT TOOL NEEDS BELOW THE SLIDES, and nothing about the zoom level. The annotate tool
 * needs the boxes' notes and their Send; the edit tool needs the editor's own list. Exhaustive, so
 * a third tool cannot ship with no panel.
 */
function ToolPanel({
  offer,
  reach,
  editor,
  element,
  busy,
  onChange,
  actions,
}: {
  offer: Offer;
  reach: EditorReach;
  editor: SlideEditor;
  element: HTMLIFrameElement | null;
  busy: boolean;
  onChange: (edits: readonly SlideEdit[]) => void;
  actions: PickerActions;
}): JSX.Element {
  switch (offer.tool) {
    case "annotate":
      return <AnomalyList offer={offer} disabled={busy} actions={actions} />;
    case "edit":
      return (
        <EditorSlot
          editor={editor}
          frame={element}
          reach={reach}
          edits={selectedFrame(offer)?.edits ?? []}
          disabled={busy}
          onChange={onChange}
        />
      );
    default:
      return assertNever(offer.tool);
  }
}

/**
 * "Report a defect" on the candidate the user is working on. It is IN THE FOOTER ROW, beside
 * Dismiss and Insert, and reachable at both zoom levels: a defect is noticed whenever it is
 * noticed, and burying the entry inside one view is what made it feel like a mode.
 *
 * It is a BUTTON IN AN EXISTING ROW rather than a row of its own, and that is a measurement. The
 * edit tool's panel is always on screen now, so the chrome above the grid grew; a 22 px row plus its
 * gap here was enough to push a three-candidate proposal's last cell below the fold, which breaks
 * the grid's promise that two rows are comparable in one glance. The sentence it used to carry is
 * on the button's own `title`, and `ReportStatus` renders nothing at all until there is something
 * to say -- so the default state costs no height.
 */
function ReportButton({
  offer,
  disabled,
  onReport,
}: {
  offer: Offer;
  disabled: boolean;
  onReport: (spec: Readonly<{ index: number }>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="sasha-secondary sasha-small"
      disabled={disabled || offer.report.kind === "opening"}
      title={REPORT_EXPLANATION}
      onClick={() => onReport({ index: offer.selectedIndex })}
    >
      {offer.report.kind === "opening" ? "opening..." : `Report a defect in option ${offer.selectedIndex}`}
    </button>
  );
}

/** Whether the report window appeared. Read back, never assumed -- a host can decline. */
function ReportStatus({ report }: { report: OpenPhase }): JSX.Element | null {
  switch (report.kind) {
    case "idle":
    case "opening":
      return null;
    case "opened":
      return <span className="sasha-dim">The report opened in its own window.</span>;
    case "failed":
      return <span className="sasha-trouble">{report.message}</span>;
    default:
      return assertNever(report);
  }
}

function DialogHeader({ offer, stage }: { offer: Offer; stage: SubmitStage | null }): JSX.Element {
  return (
    <header className="sasha-header">
      <strong>
        {offer.proposal.count} candidate slide{offer.proposal.count === 1 ? "" : "s"}
      </strong>
      <span className="sasha-dim">{offer.proposal.proposalId}</span>
      {offer.comments.kind === "failed" ? (
        <span className="sasha-trouble">open comments could not be read: {offer.comments.message}</span>
      ) : null}
      {stage === null ? null : <span className="sasha-busy">{STAGE_LABEL[stage]}</span>}
      {offer.lastFailure === null ? null : <span className="sasha-trouble">{offer.lastFailure}</span>}
      {offer.presentationId === null ? (
        <span className="sasha-trouble">this tab is not an editable presentation -- insert is unavailable</span>
      ) : null}
    </header>
  );
}

/** 1-based chips. The number on the chip is the number in PICK and the number the user says out loud. */
function SlideChips({
  offer,
  disabled,
  onSelect,
}: {
  offer: Offer;
  disabled: boolean;
  onSelect: (index: number) => void;
}): JSX.Element {
  return (
    <nav className="sasha-chips" aria-label="candidate slides">
      {offer.slides.map((frame) => (
        <button
          key={frame.index}
          type="button"
          disabled={disabled}
          aria-pressed={frame.index === offer.selectedIndex}
          className={frame.index === offer.selectedIndex ? "sasha-chip sasha-chip-on" : "sasha-chip"}
          onClick={() => onSelect(frame.index)}
        >
          <span className="sasha-chip-number">{frame.index}</span>
          <span className="sasha-chip-label">{frame.label === "" ? frame.name : frame.label}</span>
          <ChipUnresolved
            count={unresolvedCountFor({
              comments: offer.comments,
              proposalId: offer.proposal.proposalId,
              slideIndex: frame.index,
            })}
          />
        </button>
      ))}
    </nav>
  );
}

/** The chip's unresolved badge. Same derivation as the cell's and the conversation's. */
function ChipUnresolved({ count }: { count: UnresolvedCount }): JSX.Element | null {
  const badge = unresolvedBadgeOf(count);
  if (badge === null) return null;
  return (
    <span className={`sasha-chip-flag sasha-unresolved-${count.kind}`} title={describeUnresolvedCount(count)}>
      {badge}
    </span>
  );
}

/**
 * EVERY MARK-UP ON EVERY CANDIDATE, each row naming its slide. It is not filtered to the selected
 * one on purpose: the annotate tool works at either zoom level, so a box dragged on cell 3 while
 * cell 1 is selected must still be visible and sendable without the user hunting for it.
 */
function AnomalyList({
  offer,
  disabled,
  actions,
}: {
  offer: Offer;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  const rows = offer.slides.flatMap((frame) => frame.anomalies.map((anomaly) => ({ frame, anomaly })));
  return (
    <ul className="sasha-anomalies" aria-label="mark-ups">
      {rows.length === 0 ? (
        <li className="sasha-dim">
          Drag a box on any candidate -- in the grid or on one slide -- then type what is wrong and
          send it. Sasha answers it as a comment on that candidate.
        </li>
      ) : null}
      {rows.map(({ frame, anomaly }) => (
        <AnomalyRow
          key={`${frame.index}_${anomaly.anomalyId}`}
          frame={frame}
          anomaly={anomaly}
          disabled={disabled}
          actions={actions}
        />
      ))}
    </ul>
  );
}

/**
 * ONE MARK-UP, AS A COMMENT CARD.
 *
 * It was a flex row -- a 10 px uppercase source label, a one-line `<input>`, two buttons -- which
 * read as a log line, not as something a person wrote. It now has the shape of a Google Slides
 * comment: a round avatar, who wrote it, which candidate and box it is about, then the words.
 *
 * THE COMPOSER IS A TEXTAREA. A comment about a slide is often two sentences, and the input could
 * neither wrap nor hold a newline. Enter inserts one; Ctrl (or Command) + Enter sends, which is
 * the same pair of keys Google's own comment box uses.
 */
function AnomalyRow({
  frame,
  anomaly,
  disabled,
  actions,
}: {
  frame: SlideFrame;
  anomaly: DraftAnomaly;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  const send = (): void => {
    if (disabled || !isSendableAnomaly(anomaly)) return;
    actions.sendAnomaly({ index: frame.index, anomalyId: anomaly.anomalyId });
  };
  return (
    <li className="sasha-anomaly">
      <CommentCard>
        <CommentHead
          author="You"
          at=""
          nowMs={null}
          where={`slide ${frame.index} -- ${describeRegion(anomaly.region)}`}
          actions={
            <button
              type="button"
              className="sasha-drop"
              disabled={disabled}
              aria-label="remove this mark-up"
              title="remove this mark-up"
              onClick={() => actions.removeAnomaly({ index: frame.index, anomalyId: anomaly.anomalyId })}
            >
              x
            </button>
          }
        />
        <textarea
          className="sasha-note"
          rows={2}
          disabled={disabled}
          placeholder="what went wrong here?"
          value={anomaly.note}
          onChange={(event) =>
            actions.noteAnomaly({ index: frame.index, anomalyId: anomaly.anomalyId, note: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            send();
          }}
        />
        <div className="sasha-c-foot">
          <AnomalySent sent={anomaly.sent} />
          <button
            type="button"
            className="sasha-send-anomaly"
            disabled={disabled || !isSendableAnomaly(anomaly)}
            onClick={send}
          >
            Send to Sasha
          </button>
        </div>
      </CommentCard>
    </li>
  );
}

/**
 * WHETHER THIS MARK-UP IS A COMMENT ON THE CANDIDATE YET. An answered comment with a revised slide
 * beneath it is what "done" looks like (UI-CONTRACT.md) and that happens in the conversation; what
 * this row owes the user is whether the comment was opened at all -- and, once it is open, that
 * Sasha only answers while a session is attached, which this window cannot see.
 */
function AnomalySent({ sent }: { sent: AnomalySendPhase }): JSX.Element | null {
  switch (sent.kind) {
    case "draft":
      return null;
    case "sending":
      return <span className="sasha-busy">sending...</span>;
    case "sent":
      return (
        <span className="sasha-dim">
          sent -- Ask Sasha shows how long it has been waiting, and whether anything is listening
        </span>
      );
    case "failed":
      return <span className="sasha-trouble">{sent.message}</span>;
    default:
      return assertNever(sent);
  }
}

function DialogActions({
  offer,
  stage,
  actions,
}: {
  offer: Offer;
  stage: SubmitStage | null;
  actions: PickerActions;
}): JSX.Element {
  const reported = anomaliesOf(offer).length;
  return (
    <footer className="sasha-actions">
      <span className="sasha-dim">
        {reported === 0 ? "nothing marked up" : `${reported} mark-up${reported === 1 ? "" : "s"} will travel with PICK`}
      </span>
      <ReportStatus report={offer.report} />
      <ReportButton offer={offer} disabled={stage !== null} onReport={actions.openReport} />
      <button type="button" className="sasha-secondary" disabled={stage !== null} onClick={actions.dismiss}>
        Dismiss
      </button>
      <button
        type="button"
        className="sasha-primary"
        disabled={stage !== null || offer.presentationId === null}
        onClick={() => actions.insertPicked(offer.selectedIndex)}
      >
        Insert option {offer.selectedIndex}
      </button>
    </footer>
  );
}

/**
 * The browser half of `collectDiagnostics`. Every read is wrapped, because the whole point is
 * to describe a BROKEN session, and a diagnostic that throws in one is worthless.
 */
function readDiagnostics(): ReturnType<typeof collectDiagnostics> {
  const href = (() => {
    try {
      return window.location.href;
    } catch {
      return "";
    }
  })();
  const visibilityState = (() => {
    try {
      return document.visibilityState;
    } catch {
      return "unknown";
    }
  })();
  return collectDiagnostics({
    href,
    visibilityState,
    readStorage: () => {
      try {
        const probe = "sashaSlides.probe";
        window.localStorage.setItem(probe, "1");
        window.localStorage.removeItem(probe);
        return true;
      } catch {
        return false;
      }
    },
    now: () => new Date(),
  });
}

/**
 * The DIALOG's shell. `sasha-shell-wide` is what distinguishes it from the sidebar's: the two are
 * separate HtmlService documents, each inlining its own copy of the same CSS, and the parts that
 * differ are scoped by this class rather than by a second stylesheet. See picker-styles.ts.
 */
function Shell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <>
      <style>{PICKER_CSS}</style>
      <div className="sasha-shell sasha-shell-wide">{children}</div>
    </>
  );
}

const VIEW_ORDER: readonly SlideView[] = ["grid", "single"];
const VIEW_LABEL: Readonly<Record<SlideView, string>> = {
  grid: "All candidates",
  single: "One slide",
};
const TOOL_ORDER: readonly SlideTool[] = ["edit", "annotate"];
const TOOL_LABEL: Readonly<Record<SlideTool, string>> = {
  edit: "Edit",
  annotate: "Annotate",
};
const TOOL_HINT: Readonly<Record<SlideTool, string>> = {
  edit: "Editing the selected candidate. Both tools work in either view -- pick whichever you need.",
  annotate: "Drag a box on any candidate, in either view, and say what is wrong with it.",
};
const RENDERING_ORDER: readonly SlideRendering[] = ["html", "rendered"];
const RENDERING_LABEL: Readonly<Record<SlideRendering, string>> = {
  html: "HTML (authoritative)",
  rendered: "Converted slide",
};
/** Why you would press Report a defect. On the button, because the footer row has no words to spare. */
const REPORT_EXPLANATION =
  "Opens the same editor on two slides -- this one as it is, and as it would be sent -- and sends only what you approve.";
const STAGE_LABEL: Readonly<Record<SubmitStage, string>> = {
  converting: "converting...",
  inserting: "inserting into the deck...",
  "writing-pick": "telling Sasha...",
};
