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

import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { PICKER_CSS } from "./picker-styles.ts";
import { ELEMENT_INSPECTOR_CSS } from "./element-inspector.tsx";
import { SlideEditorWindow } from "./slide-editor-window.tsx";
import { CommentCard, CommentHead } from "./comment-card.tsx";
import { CandidateGrid } from "./candidate-grid.tsx";
import { collectDiagnostics, describeDiagnostics } from "./diagnostics.ts";
import { EditorSlot } from "./editor-slot.tsx";
import { assertNever, type Region } from "./protocol.ts";
import { describeRegion } from "./region-overlay.tsx";
export { SlideStage } from "./slide-stage.tsx";
import {
  describeUnresolvedCount,
  unresolvedBadgeOf,
  unresolvedCountFor,
  type UnresolvedCount,
} from "./session-log.ts";
import type { SlideEdit, SlideEditor } from "./slide-editor.ts";
import {
  editorIsLive,
  editorReachOf,
  editsSlides,
  isSendableAnomaly,
  selectsElements,
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
  /** Open the editor on one candidate. The grid stays underneath, remembering the choice. */
  openEditor(index: number): void;
  /** Replace the selected element's markup with what the inspector's textarea now holds. */
  applyMarkup(spec: Readonly<{ index: number; html: string }>): void;
  /** Answer one of the user's own comment threads on a candidate, from the editor's rail. */
  replyToThread(spec: Readonly<{ index: number; commentId: string; text: string }>): void;
  /** Close a thread. Google implements this as a reply carrying a resolve action. */
  resolveThread(spec: Readonly<{ index: number; commentId: string }>): void;
  /**
   * Close it. The HOST decides whether to ask first: `unsentMarkUps` says what would be lost,
   * and a surface that threw away typed words without a question would be the one unforgivable
   * thing a review window can do.
   */
  closeEditor(): void;
  /** Change the ZOOM LEVEL. It may never change the tool -- that is the contract this window broke. */
  chooseView(view: SlideView): void;
  /** Change the TOOL. It may never change the zoom level, for the same reason. */
  chooseTool(tool: SlideTool): void;
  chooseRendering(rendering: SlideRendering): void;
  /** Paint what the converter could not carry, or stop painting it. Off by default. */
  toggleFindings(): void;
  drawAnomaly(spec: Readonly<{ index: number; region: Region }>): void;
  /**
   * COMMENT ON THE SELECTED ELEMENT: record the box, the words, and send it, as one act. This is
   * what the annotate tool does now -- see selection-composer.tsx for why it is not three.
   */
  commentOnSelection(spec: Readonly<{ index: number; region: Region; note: string }>): void;
  /** Put the slide back: Escape, Cancel, or the composer's dismiss. */
  clearSelection(): void;
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
  createEditor(spec: Readonly<{ html: string; mode: "edit" | "comment" }>): SlideEditor;
}>;

export function Picker({ state, actions }: { state: PickerState; actions: PickerActions }): JSX.Element | null {
  switch (state.status) {
    case "dormant":
      // A LOADER, AND NOTHING ELSE. This used to explain in two paragraphs what would appear
      // here, what could be done with it and that the window could be closed. None of it was
      // actionable -- the window is waiting, and the honest thing to show is that it is waiting.
      return (
        <Shell>
          <p className="sasha-loader" role="status" aria-label="Loading">
            <span className="sasha-loader-ring" aria-hidden="true" />
          </p>
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
  /*
   * BOTH TOOLS POINT AT ELEMENTS, so both attach the editor; only what happens NEXT differs.
   * `selectsElements` is the attach question and `editsSlides` is the "may it be changed"
   * question -- they used to be one predicate, which is why annotate had to fall back to
   * dragging a rectangle (picker-state.ts).
   */
  const pointing = selectsElements(offer.tool) && editorIsLive(reach);
  const html = loadedHtmlOf(frame) ?? "";
  const mode = editsSlides(offer.tool) ? ("edit" as const) : ("comment" as const);
  const editor = useMemo(() => actions.createEditor({ html, mode }), [actions, html, mode]);
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
      <GridChrome offer={offer} stage={stage} disabled={busy} actions={actions} />
      <CandidateGridBody offer={offer} busy={busy} actions={actions} />
      {/* THE EDITOR IS A WINDOW ON TOP, not a mode this one switches into. The grid underneath
          keeps its scroll position and its choice, so closing comes back to exactly where the
          user was -- which is the whole reason it is an overlay and not a replacement. */}
      {offer.editing === null ? null : (
        <SlideEditorWindow
          offer={offer}
          reach={reach}
          editor={editor}
          element={pointing ? element : null}
          onEditFrame={pointing ? setElement : null}
          busy={busy}
          onChange={onChange}
          actions={actions}
        />
      )}
    </section>
  );
}

/**
 * THE GRID'S CHROME: one toggle, and nothing else.
 *
 * It used to carry three groups at once -- VIEW (all candidates / one slide), TOOL (edit /
 * annotate) and SHOWING -- above four thumbnails, plus a line of hint text. Three of those are
 * decisions about ONE candidate, and the grid is where four are still being compared; a row of
 * seven buttons over a choice between four slides is what made the window feel like a cockpit.
 *
 * They moved into the editor, which opens on a candidate when you pick one. What is left here
 * is the single question the grid is actually asking: which rendering are you comparing?
 */
function GridChrome({
  offer,
  stage,
  disabled,
  actions,
}: {
  offer: Offer;
  stage: SubmitStage | null;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  return (
    <div className="sasha-toolbar">
      <Chooser
        label="showing"
        order={RENDERING_ORDER}
        current={offer.rendering}
        labels={RENDERING_LABEL}
        disabled={disabled}
        onChoose={actions.chooseRendering}
      />
      <span className="sasha-toolbar-say">To request changes for a candidate, click on it</span>
      <ReportStatus report={offer.report} />
      {offer.presentationId === null ? (
        <span className="sasha-trouble">this tab is not an editable presentation -- insert is unavailable</span>
      ) : null}
      {/*
        THE ONLY DECISION ABOUT THE SET, and the reason it is still here at all.
        The window's own title bar has an X, and a "Dismiss" button in a footer bar under it read
        as a second close -- so the bar is gone. But the X is Apps Script's `showModelessDialog`
        chrome: it closes the window and WRITES NOTHING, while this writes `PICK {picked: null}`,
        which is the only thing that unblocks a waiting `await_pick` with "none of these"
        (dialog.tsx `submit`). Dropping it would leave the agent waiting for its timeout.
        So: one row, no second bar, and worded as the answer it sends rather than as "close".
      */}
      <button type="button" className="sasha-none" disabled={stage !== null} onClick={actions.dismiss}>
        None of these
      </button>
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

/**
 * THE GRID, and only the grid.
 *
 * It used to switch between a grid and a single large pane on a `view` union. "One candidate,
 * large" is what the EDITOR is for now, so this is one shape rather than a choice: four
 * thumbnails, and picking one opens the editor on it.
 */
function CandidateGridBody({
  offer,
  busy,
  actions,
}: {
  offer: Offer;
  busy: boolean;
  actions: PickerActions;
}): JSX.Element {
  return (
    <CandidateGrid
      offer={offer}
      disabled={busy}
      editedIndex={null}
      onEditFrame={noFrame}
      onZoom={actions.openEditor}
      onInsert={actions.insertPicked}
      onReport={actions.openReport}
      insertable={offer.presentationId !== null}
      reportOpening={offer.report.kind === "opening"}
      onDraw={actions.drawAnomaly}
    />
  );
}

/** The grid never hosts the live editor -- that is the editor window's job. */
function noFrame(): void {}

/**
 * WHAT THE CURRENT TOOL NEEDS BELOW THE SLIDES, and nothing about the zoom level. The annotate tool
 * needs the boxes' notes and their Send; the edit tool needs the editor's own list. Exhaustive, so
 * a third tool cannot ship with no panel.
 */
export function ToolPanel({
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
    case "select":
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

function DialogHeader({ offer, stage }: { offer: Offer; stage: SubmitStage | null }): JSX.Element | null {
  // "4 candidate slides p_1791145806407_yig6ws" used to stand above the grid. The count is the
  // number of pictures below it and the id names a file nobody opens, so the row said nothing a
  // reader could not already see. What is left is only what has gone WRONG or what is in flight --
  // and when neither has, this renders nothing and costs no height.
  const trouble = offer.comments.kind === "failed" ? offer.comments.message : null;
  if (trouble === null && stage === null && offer.lastFailure === null) return null;
  return (
    <header className="sasha-header">
      {trouble === null ? null : <span className="sasha-trouble">open comments could not be read: {trouble}</span>}
      {stage === null ? null : <span className="sasha-busy">{STAGE_LABEL[stage]}</span>}
      {offer.lastFailure === null ? null : <span className="sasha-trouble">{offer.lastFailure}</span>}
    </header>
  );
}

/** 1-based chips. The number on the chip is the number in PICK and the number the user says out loud. */
export function SlideChips({
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
export function AnomalyList({
  offer,
  disabled,
  actions,
}: {
  offer: Offer;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  const rows = offer.slides.flatMap((frame) => frame.anomalies.map((anomaly) => ({ frame, anomaly })));
  // THE NEWEST MARK-UP IS SCROLLED INTO VIEW. A row is a whole comment card -- head, textarea,
  // Send -- and the list is a bounded scroller, so the box the user just drew landed below its
  // fold, sliced through the middle, with its note field out of reach (the browser smoke's
  // "every mark-up row fits inside its list" check). Only when the count GROWS: a list that
  // jumped to the bottom on every keystroke would yank the row being typed in away from the user.
  const list = useRef<HTMLUListElement | null>(null);
  const seenRows = useRef(rows.length);
  useEffect(() => {
    const grew = rows.length > seenRows.current;
    seenRows.current = rows.length;
    const element = list.current;
    if (!grew || element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [rows.length]);
  return (
    <ul className="sasha-anomalies" aria-label="mark-ups" ref={list}>
      {rows.length === 0 ? (
        <li className="sasha-dim">
          Nothing marked up yet. Click anything on the open candidate and say what is wrong with
          it; Sasha answers as a comment on that candidate.
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
export function AnomalyRow({
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
      {/* The inspector ships its own rules with the component rather than having them live in a
          stylesheet it does not own; one more string in the same tag costs nothing. */}
      <style>
        {PICKER_CSS}
        {ELEMENT_INSPECTOR_CSS}
      </style>
      <div className="sasha-shell sasha-shell-wide">{children}</div>
    </>
  );
}

/* THE EDITOR'S TOOLBAR, down its left edge. Two tools, named for what the pointer is. */
export const TOOL_ORDER: readonly SlideTool[] = ["select", "annotate"];
export const TOOL_LABEL: Readonly<Record<SlideTool, string>> = {
  select: "Select",
  annotate: "Annotate",
};
export const TOOL_GLYPH: Readonly<Record<SlideTool, string>> = {
  select: "\u2196",
  annotate: "\u25A2",
};
export const TOOL_HINT: Readonly<Record<SlideTool, string>> = {
  select: "Click a thing on the slide to select it, then drag or resize it. Click again to select its parent.",
  annotate: "Click a thing on the slide to comment on it. Click again to take in its container.",
};
/* THE GRID'S ONLY CHOICE, and the names are the ones that are TRUE.

   `html` is the candidate itself -- a self-contained document that renders exactly -- so that is
   the PREVIEW, and it is the default. `rendered` is NOT a rendering: rendered-preview.ts says so
   in its own first line, it is a projection of the requests the converter will send Slides,
   drawn as boxes and loose text. Calling that "Preview" and defaulting to it is why a table
   looked like one run-on blob of its cells' text. It is useful -- it shows what Slides will
   actually receive -- so it stays, under a name that says what it is. */
const RENDERING_ORDER: readonly SlideRendering[] = ["html", "rendered"];
const RENDERING_LABEL: Readonly<Record<SlideRendering, string>> = {
  html: "Preview",
  rendered: "Converted",
};
const STAGE_LABEL: Readonly<Record<SubmitStage, string>> = {
  converting: "converting...",
  inserting: "inserting into the deck...",
  "writing-pick": "telling Sasha...",
};
