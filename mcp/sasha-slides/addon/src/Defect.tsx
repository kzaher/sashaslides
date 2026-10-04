// THE DEFECT REPORT: THE SAME EDITOR, SHOWING TWO SLIDES (UI-CONTRACT.md, "The defect report is the
// same editor, not a table").
//
// "Reporting a defect opens the editor you already know, with extra controls and two slides shown
// side by side: the slide as it is and the slide as it will be sent. Both rendered, both visual. A
// reader judges an anonymisation by looking at it, the same way they judge a slide."
//
// WHAT IS NOT HERE ANY MORE. The before/after table of text runs, and the model round trip that
// filled half of it. A list of thirteen rows reading `Paths in, -> Natus at,` asked the user to
// audit a diff by eye and told them nothing about whether the slide still looked like their slide.
// Everything that table was PROTECTING is kept, and kept structurally:
//
//   * nothing is sent until Send is pressed;
//   * what is sent is what the right-hand slide renders -- one function, `sentHtmlOf`, is both the
//     pane's bytes and the payload's bytes (defect-state.ts);
//   * `rejectedReplacements`, `shapeRisks` and `residualRisks` are all still on screen, as NUMBERED
//     ANNOTATIONS PINNED TO THE SLIDE THEY ARE ABOUT rather than as columns of a spreadsheet.
//
// THE THREE EXTRA CONTROLS THE CONTRACT NAMES:
//
//   EDIT THE TITLE          one field, because `<title>` is not on the slide and the visual editor
//                           cannot reach it. It goes through the anonymiser's own replacement gate,
//                           so a title that hands the original back is refused and annotated.
//   EDIT EITHER SLIDE       the visual editor, on both panes. Editing the LEFT one changes what gets
//                           anonymised, so nothing is bypassed. Editing the RIGHT one changes what
//                           is SENT, verbatim -- which is annotated as loudly as that deserves, and
//                           refused outright if it puts an original word back.
//   SEND                    two presses, and only the second leaves the browser.
//
// Passive, like Picker.tsx and Conversation.tsx: a function of `Defect` plus the callbacks the
// composition root hands it, every conditional an exhaustive switch over a discriminated union, and
// NO state of its own -- not the note, not the endpoint, not an edit. Every load state has a visible
// failure arm, because "never render a spinner that cannot end" is a contract invariant.

import type { JSX } from "react";
import type { AnonymisedSlide, IdentifierPolicy, TextRunId } from "./anonymise/index.ts";
import {
  annotationIsPinned,
  annotationsOf,
  canPrepare,
  currentAnonymised,
  describePrepareReadiness,
  editsOnSide,
  isSubmitting,
  preparable,
  previewIsStale,
  sendablePreview,
  sentFrameHtmlOf,
  sourceFrameHtmlOf,
  titleRunOf,
  type AnnotationTone,
  type Defect,
  type PassLoad,
  type PreviewLoad,
  type ReportAnnotation,
  type ReportSide,
  type ReportView,
  type RunRow,
  type SlideSource,
  type SubmitPhase,
} from "./defect-state.ts";
import { EditorPane } from "./editor-pane.tsx";
import { assertNever } from "./protocol.ts";
import type { ReportSubmission } from "./report-endpoint.ts";
import type { SlideEdit, SlideEditor } from "./slide-editor.ts";

/** Everything the report surface is allowed to cause. Injected, so the tree renders with no ports. */
export type DefectActions = Readonly<{
  /** Which of the two slides is on screen. A zoom level: it changes nothing about what is sent. */
  chooseView(view: ReportView): void;
  /** The title (and any other run the surface exposes), through the anonymiser's replacement gate. */
  editRun(spec: Readonly<{ runId: TextRunId; text: string }>): void;
  resetRun(spec: Readonly<{ runId: TextRunId }>): void;
  /**
   * The visual editor reported edits to the LEFT slide. The pass re-runs over the result, so
   * nothing here bypasses the anonymiser -- this is how a reporter cuts a slide down to the part
   * that actually reproduces the defect.
   */
  editSource(spec: Readonly<{ html: string; edits: readonly SlideEdit[] }>): void;
  resetSource(): void;
  /**
   * The visual editor reported edits to the RIGHT slide. These bytes are what gets SENT, verbatim,
   * which is why the surface annotates them and why `reintroducedOriginals` can refuse them.
   */
  editSent(spec: Readonly<{ html: string; edits: readonly SlideEdit[] }>): void;
  resetSent(): void;
  choosePolicy(spec: Readonly<{ identifiers: IdentifierPolicy }>): void;
  reanonymise(): void;
  typeNote(spec: Readonly<{ text: string }>): void;
  typeEndpoint(spec: Readonly<{ endpoint: string }>): void;
  /** Convert the bytes the right-hand slide renders and build the payload. Nothing leaves. */
  prepare(): void;
  /** POST it. The ONLY action in this product that sends anything anywhere. */
  send(): void;
  close(): void;
  /**
   * THE VISUAL EDITOR, bound to one pane's document. An injected FACTORY rather than an action,
   * because the editor is a dependency the composition root chooses and this tree must not know
   * which implementation it got -- the same seam the slides window has (slide-editor.ts).
   */
  createEditor(spec: Readonly<{ html: string }>): SlideEditor;
}>;

export function DefectPanel({ defect, actions }: { defect: Defect; actions: DefectActions }): JSX.Element {
  return (
    <section className="sasha-report" role="region" aria-label="report a defect">
      <SlideHeader slide={defect.slide} onClose={actions.close} />
      <p className="sasha-dim">
        Two slides, both real: <strong>as it is</strong> on the left, which never leaves this browser,
        and <strong>as it will be sent</strong> on the right. Edit either one -- editing the left
        slide changes what gets anonymised, editing the right one changes what is sent. The numbered
        notes are pinned to the slide they are about.
      </p>
      <ViewChoice view={defect.view} onChoose={actions.chooseView} />
      <TitleField row={titleRunOf(defect)} disabled={isSubmitting(defect)} actions={actions} />
      <PassBody pass={defect.pass} defect={defect} actions={actions} />
      <Annotations annotations={annotationsOf(defect)} />
      <CarrierTally anonymised={currentAnonymised(defect)} />
      <PolicyChoice identifiers={defect.identifiers} onChoose={actions.choosePolicy} onReanonymise={actions.reanonymise} />
      <NoteBox note={defect.note} onType={actions.typeNote} />
      <SendBar defect={defect} actions={actions} />
    </section>
  );
}

function SlideHeader({ slide, onClose }: { slide: SlideSource; onClose: () => void }): JSX.Element {
  return (
    <header className="sasha-header">
      <strong>Report a defect</strong>
      <span className="sasha-dim">{slideCaption(slide)}</span>
      <button type="button" className="sasha-secondary sasha-small" onClick={onClose}>
        Close
      </button>
    </header>
  );
}

/**
 * WHICH OF THE TWO SLIDES IS ON SCREEN -- a zoom level, exactly like the slides window's view
 * toggle, and for the same reason: a detail too small to judge at half the width needs the full
 * width, and that must not be a different screen. `pair` is the default.
 */
function ViewChoice({ view, onChoose }: { view: ReportView; onChoose: (view: ReportView) => void }): JSX.Element {
  return (
    <div className="sasha-toolbar">
      <div className="sasha-toggle" role="group" aria-label="view">
        <span className="sasha-toggle-label">view</span>
        {VIEW_ORDER.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={choice === view}
            className={choice === view ? "sasha-tab sasha-tab-on" : "sasha-tab"}
            onClick={() => onChoose(choice)}
          >
            {VIEW_LABEL[choice]}
          </button>
        ))}
      </div>
      <span className="sasha-dim sasha-toolbar-say">{VIEW_HINT[view]}</span>
    </div>
  );
}

/**
 * THE TITLE, as its own field. It is here and not in the editor because `<title>` is not ON the
 * slide -- no gesture can reach it -- and because it goes through the anonymiser's replacement gate
 * rather than straight into the bytes: `judgeReplacement` has no "the user said so" exemption, so a
 * title that hands the original back is refused, gibberished and annotated.
 */
function TitleField({
  row,
  disabled,
  actions,
}: {
  row: RunRow | null;
  disabled: boolean;
  actions: DefectActions;
}): JSX.Element | null {
  if (row === null) return null;
  return (
    <div className="sasha-titlefield">
      <label className="sasha-dim" htmlFor="sasha-report-title">
        Title, as it will be sent -- the document&apos;s own title, which is not drawn on the slide
      </label>
      {/*
        ITS OWN CLASS, not the endpoint's. Two unrelated inputs sharing one selector is how a browser
        test typed a report endpoint into the slide's title -- seen in the smoke screenshot -- and it
        would do the same to anything else that reaches for the first `.sasha-endpoint` on the page.
      */}
      <input
        id="sasha-report-title"
        className="sasha-titleinput"
        type="text"
        disabled={disabled}
        value={row.typed ?? row.after}
        onChange={(event) => actions.editRun({ runId: row.runId, text: event.target.value })}
      />
      {row.typed === undefined ? null : (
        <button
          type="button"
          className="sasha-secondary sasha-small"
          disabled={disabled}
          onClick={() => actions.resetRun({ runId: row.runId })}
        >
          Undo my title
        </button>
      )}
    </div>
  );
}

/**
 * THE PAIR, or the reason there is no pair yet. Every arm of the pass is rendered, including the one
 * where the anonymiser threw: a surface that showed two empty frames with no explanation is the
 * failure this project has already shipped once.
 */
function PassBody({
  pass,
  defect,
  actions,
}: {
  pass: PassLoad;
  defect: Defect;
  actions: DefectActions;
}): JSX.Element {
  switch (pass.kind) {
    case "unrun":
      return <p className="sasha-busy">anonymising the slide...</p>;
    case "failed":
      return <p className="sasha-trouble">the slide could not be anonymised: {pass.message}</p>;
    case "run":
      return <SlidePair defect={defect} actions={actions} />;
    default:
      return assertNever(pass);
  }
}

/**
 * THE TWO SLIDES, SIDE BY SIDE, BOTH IN THE EDITOR. The view decides which of them is on screen and
 * nothing else: both panes are the same component, so the left one is not a weaker copy of the
 * right one.
 */
function SlidePair({ defect, actions }: { defect: Defect; actions: DefectActions }): JSX.Element {
  const annotations = annotationsOf(defect);
  const disabled = isSubmitting(defect);
  return (
    <div className={`sasha-pair sasha-pair-${defect.view}`}>
      {showsSide({ view: defect.view, side: "as-is" }) ? (
        <EditorPane
          title="As it is"
          blurb="your slide, never part of the report"
          tone="source"
          html={sourceFrameHtmlOf(defect)}
          missing="reading the slide from Drive..."
          createEditor={actions.createEditor}
          edits={editsOnSide({ defect, side: "as-is" })}
          disabled={disabled}
          onChange={actions.editSource}
          onReset={actions.resetSource}
        >
          <AnnotationPins annotations={annotations} side="as-is" />
        </EditorPane>
      ) : null}
      {showsSide({ view: defect.view, side: "as-sent" }) ? (
        <EditorPane
          title="As it will be sent"
          blurb="exactly these bytes leave the browser when you press Send"
          tone="sent"
          html={sentFrameHtmlOf(defect)}
          missing="nothing has been anonymised yet"
          createEditor={actions.createEditor}
          edits={editsOnSide({ defect, side: "as-sent" })}
          disabled={disabled}
          onChange={actions.editSent}
          onReset={actions.resetSent}
        >
          <AnnotationPins annotations={annotations} side="as-sent" />
        </EditorPane>
      ) : null}
    </div>
  );
}

/**
 * THE NUMBERED PINS ON A SLIDE. They are the visual half of "the risks are annotations on the pair
 * rather than a spreadsheet": a pin carries the number and the tone, and the card below carries the
 * words. A run has no geometry -- a text run is a position in a token stream, not a box on the slide
 * -- so a pin is pinned to the SLIDE and numbered, which is honest, rather than dropped at a
 * coordinate nothing measured.
 */
function AnnotationPins({
  annotations,
  side,
}: {
  annotations: readonly ReportAnnotation[];
  side: ReportSide;
}): JSX.Element | null {
  const mine = numbered(annotations).filter(
    (entry) => entry.annotation.side === side && annotationIsPinned(entry.annotation.tone),
  );
  if (mine.length === 0) return null;
  return (
    <ol className="sasha-pins" aria-label="things to read about this slide">
      {mine.map((entry) => (
        <li
          key={entry.annotation.annotationId}
          className={`sasha-pin sasha-pin-${entry.annotation.tone}`}
          title={`${entry.annotation.heading}. ${entry.annotation.detail}`}
        >
          {entry.number}
        </li>
      ))}
    </ol>
  );
}

/**
 * THE NOTES THEMSELVES, in the same numbers as the pins, worst first. `residualRisks` is rendered
 * WORD FOR WORD, because the sentences name the carriers precisely and a paraphrase would be a
 * second declaration that drifts. Nothing here is behind a disclosure and nothing is height-capped:
 * a sliced last sentence is worse than a long panel.
 */
function Annotations({ annotations }: { annotations: readonly ReportAnnotation[] }): JSX.Element | null {
  if (annotations.length === 0) return null;
  return (
    <section className="sasha-annots" aria-label="notes about the two slides">
      <strong>
        Read these before you send. The numbered pins beside a slide mark the ones that are about
        that slide and need a decision; the rest are what the anonymiser reports about it.
      </strong>
      {/*
        THE ANONYMISER'S SENTENCES ARE RENDERED WORD FOR WORD, including the ones about a model
        rewriting the text -- a paraphrase would be a second declaration that drifts, and this is a
        privacy disclosure. But that mode is withdrawn here ("Anonymisation: lorem ipsum, always"),
        so the standing caveat is stated once, above them, rather than by editing their words.
      */}
      <span className="sasha-dim">
        These are the anonymiser&apos;s own words, unedited. Where they describe asking a model to
        rewrite the text, that is a mode this report does not use: nothing here goes to a model, and
        the only replacements are the ones you typed.
      </span>
      <ol className="sasha-annot-list">
        {numbered(annotations).map((entry) => (
          <li key={entry.annotation.annotationId} className={`sasha-annot sasha-annot-${entry.annotation.tone}`}>
            <span className={`sasha-pin sasha-pin-${entry.annotation.tone}`}>{entry.number}</span>
            <span className="sasha-annot-body">
              <strong>{entry.annotation.heading}</strong>
              <span className={toneClass(entry.annotation.tone)}>{entry.annotation.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * WHAT HAPPENED TO EACH CARRIER, as its own compact line rather than an annotation. It is a TALLY,
 * not a warning, and the two were being read as one thing when they shared a list.
 */
function CarrierTally({ anonymised }: { anonymised: AnonymisedSlide | null }): JSX.Element | null {
  if (anonymised === null || anonymised.carriers.length === 0) return null;
  return (
    <ul className="sasha-carriers" aria-label="what happened to each carrier">
      {anonymised.carriers.map((carrier) => (
        <li key={`${carrier.carrier}:${carrier.treatment}`} className="sasha-dim">
          {carrier.carrier}: {carrier.treatment} ({carrier.count})
        </li>
      ))}
    </ul>
  );
}

/**
 * The identifier policy, as a live choice with the measured consequence spelled out. `rename` is
 * the default and the recommendation: a class such as `.acme-q3-revenue` IS content, and under
 * `preserve` it ships verbatim through a slide whose every word was substituted. The anonymiser's
 * own `identifier-policy-leak.test.ts` pins that, and the renaming is applied across the markup AND
 * the stylesheet, so the cascade still matches and the layout is unchanged. What `preserve` would
 * keep is listed as an annotation on the right-hand slide, not buried in a sub-list here.
 */
function PolicyChoice({
  identifiers,
  onChoose,
  onReanonymise,
}: {
  identifiers: IdentifierPolicy;
  onChoose: (spec: Readonly<{ identifiers: IdentifierPolicy }>) => void;
  onReanonymise: () => void;
}): JSX.Element {
  return (
    <section className="sasha-policy" aria-label="class and id policy">
      <div className="sasha-toggle">
        <span className="sasha-toggle-label">names</span>
        <button
          type="button"
          className={`sasha-tab${identifiers === "rename" ? " sasha-tab-on" : ""}`}
          onClick={() => onChoose({ identifiers: "rename" })}
        >
          Rename classes and ids
        </button>
        <button
          type="button"
          className={`sasha-tab${identifiers === "preserve" ? " sasha-tab-on" : ""}`}
          onClick={() => onChoose({ identifiers: "preserve" })}
        >
          Keep them
        </button>
      </div>
      {/* OUTSIDE the toggle: it is not a third choice of policy, it is an action. */}
      <button type="button" className="sasha-secondary sasha-small sasha-reanon" onClick={onReanonymise}>
        Anonymise it again -- a different set of lorem words, same guarantees
      </button>
      <p className="sasha-dim">{policyExplanation(identifiers)}</p>
    </section>
  );
}

function NoteBox({ note, onType }: { note: string; onType: (spec: Readonly<{ text: string }>) => void }): JSX.Element {
  return (
    <div className="sasha-composer">
      <label className="sasha-dim" htmlFor="sasha-report-note">
        What went wrong? This is the only text sent exactly as you typed it.
      </label>
      <textarea
        id="sasha-report-note"
        className="sasha-comment-text"
        rows={3}
        placeholder="the table lost its gridlines"
        value={note}
        onChange={(event) => onType({ text: event.target.value })}
      />
    </div>
  );
}

/**
 * PREPARE, then SEND. Two presses on purpose: preparing converts the bytes the RIGHT-HAND SLIDE
 * renders (which is what makes the payload) and checks them for forbidden strings, and
 * `sendablePreview` hands the payload over only while nothing has changed since. An edit after
 * preparing therefore disables Send and says why, instead of quietly sending the bytes from before
 * the edit.
 *
 * And Prepare itself can be refused: `preparable` returns `leaking` when the user's own edits to the
 * right-hand slide put the original slide's words back, which is the one thing this surface must not
 * let through.
 */
function SendBar({ defect, actions }: { defect: Defect; actions: DefectActions }): JSX.Element {
  const readiness = preparable(defect);
  // THE SAME GATE THE SEND PATH USES, and not a second condition that could drift from it:
  // `sendablePreview` is null unless a payload exists AND still describes the state on screen.
  const ready = sendablePreview(defect) !== null;
  const busy = isSubmitting(defect);
  return (
    <section className="sasha-sendbar" aria-label="send the report">
      <label className="sasha-dim" htmlFor="sasha-report-endpoint">
        Where to send it
      </label>
      <input
        id="sasha-report-endpoint"
        className="sasha-endpoint"
        type="text"
        value={defect.endpoint}
        onChange={(event) => actions.typeEndpoint({ endpoint: event.target.value })}
      />
      <div className="sasha-actions">
        <button
          type="button"
          className="sasha-secondary sasha-prepare"
          disabled={busy || !canPrepare(readiness)}
          onClick={actions.prepare}
        >
          {ready ? "Prepare again" : "Prepare the report"}
        </button>
        <button type="button" className="sasha-primary sasha-send" disabled={busy || !ready} onClick={actions.send}>
          Send
        </button>
      </div>
      <span className={canPrepare(readiness) ? "sasha-dim" : "sasha-trouble"}>
        {describePrepareReadiness(readiness)}
      </span>
      <PrepareStatus preview={defect.preview} stale={previewIsStale(defect)} />
      <SendStatus send={defect.send} />
    </section>
  );
}

function PrepareStatus({ preview, stale }: { preview: PreviewLoad; stale: boolean }): JSX.Element | null {
  switch (preview.kind) {
    case "unbuilt":
      return null;
    case "building":
      return <span className="sasha-busy">converting the slide on the right...</span>;
    case "failed":
      return <span className="sasha-trouble">the report could not be prepared: {preview.message}</span>;
    case "built":
      return stale ? (
        <span className="sasha-trouble">
          You have changed something since this was prepared. Prepare it again -- what is sent has to
          be exactly what the slide on the right says now.
        </span>
      ) : (
        <PreparedSummary preview={preview} />
      );
    default:
      return assertNever(preview);
  }
}

function PreparedSummary({ preview }: { preview: Extract<PreviewLoad, { kind: "built" }> }): JSX.Element {
  const built = preview.preview;
  return (
    <span className="sasha-dim">
      Ready: {preview.sentHtml.length} bytes of the slide on the right,{" "}
      {built.conversion.requests.length} converter request
      {built.conversion.requests.length === 1 ? "" : "s"}, {built.conversion.unsupported.length} thing
      {built.conversion.unsupported.length === 1 ? "" : "s"} the converter could not express,{" "}
      {built.redactedIdentifierCount} identifier
      {built.redactedIdentifierCount === 1 ? "" : "s"} and {built.redactedUrlCount} URL
      {built.redactedUrlCount === 1 ? "" : "s"} redacted out of that conversion.
    </span>
  );
}

function SendStatus({ send }: { send: SubmitPhase }): JSX.Element | null {
  switch (send.kind) {
    case "idle":
      return null;
    case "sending":
      return <span className="sasha-busy">sending...</span>;
    case "answered":
      return <SubmissionStatus submission={send.submission} />;
    default:
      return assertNever(send);
  }
}

function SubmissionStatus({ submission }: { submission: ReportSubmission }): JSX.Element {
  switch (submission.kind) {
    case "accepted":
      return (
        <span className="sasha-settled">
          {submission.duplicate ? "Already had this one. " : "Sent. "}Quote <strong>{submission.id}</strong> to a
          maintainer.
          {submission.deletionToken === null ? (
            <span className="sasha-dim"> No new deletion token: this report was already stored.</span>
          ) : (
            <span className="sasha-dim">
              {" "}
              To delete it later you need <strong>{submission.deletionToken}</strong> -- it is shown
              once and cannot be reissued.
            </span>
          )}
        </span>
      );
    case "refused":
      return (
        <span className="sasha-trouble">
          the service refused it ({submission.status} {submission.code}): {submission.message}
        </span>
      );
    case "unreachable":
      return <span className="sasha-trouble">{submission.message}</span>;
    default:
      return assertNever(submission);
  }
}

/** Whether one side of the pair is on screen. A switch, so a new view has to place both sides. */
function showsSide({ view, side }: { view: ReportView; side: ReportSide }): boolean {
  switch (view) {
    case "pair":
      return true;
    case "as-is":
      return side === "as-is";
    case "as-sent":
      return side === "as-sent";
    default:
      return assertNever(view);
  }
}

/**
 * The annotations with their numbers. ONE numbering for the pins and the cards, computed once, so a
 * pin and its note can never disagree about which number they are.
 */
function numbered(
  annotations: readonly ReportAnnotation[],
): readonly Readonly<{ number: number; annotation: ReportAnnotation }>[] {
  return annotations.map((annotation, position) => ({ number: position + 1, annotation }));
}

/** How loudly a note's detail is drawn. Exhaustive, so a new tone has to be given a weight. */
function toneClass(tone: AnnotationTone): string {
  switch (tone) {
    case "leak":
    case "risk":
      return "sasha-trouble";
    case "note":
      return "sasha-dim";
    default:
      return assertNever(tone);
  }
}

function slideCaption(slide: SlideSource): string {
  switch (slide.kind) {
    case "absent":
      return slide.message;
    case "unrequested":
    case "loading":
      return `reading ${slide.label}...`;
    case "loaded":
      return `${slide.label} -- ${slide.html.length} bytes of HTML`;
    case "failed":
      return `${slide.label} could not be read: ${slide.message}`;
    default:
      return assertNever(slide);
  }
}

function policyExplanation(identifiers: IdentifierPolicy): string {
  switch (identifiers) {
    case "rename":
      return (
        "Recommended. A class name is content: `.acme-q3-revenue` spells out what the slide is " +
        "about even when every word on it has been replaced. Renaming is applied to the markup and " +
        "the stylesheet together, so the cascade still matches and the layout does not move."
      );
    case "preserve":
      return (
        "Every class and id is sent exactly as written, and the slide on the right lists them as a " +
        "note. Only choose this once you have read that note and judged the names harmless."
      );
    default:
      return assertNever(identifiers);
  }
}

const VIEW_ORDER: readonly ReportView[] = ["pair", "as-is", "as-sent"];
const VIEW_LABEL: Readonly<Record<ReportView, string>> = {
  pair: "Both slides",
  "as-is": "As it is",
  "as-sent": "As it will be sent",
};
const VIEW_HINT: Readonly<Record<ReportView, string>> = {
  pair: "Both at half width. Switch to one of them for a detail too small to judge here.",
  "as-is": "Your own slide, full width. Nothing on it is part of the report.",
  "as-sent": "Full width, and these are the bytes that leave the browser when you press Send.",
};
