// THE DEFECT REPORT'S WHOLE STATE: one immutable tree, one pure reducer, the same shape as
// picker-state.ts and conversation-state.ts.
//
// IT IS THE EDITOR, SHOWING TWO SLIDES (UI-CONTRACT.md, "The defect report is the same editor, not
// a table"): the slide AS IT IS and the slide AS IT WILL BE SENT, both rendered, side by side, with
// three extra controls -- edit the title, edit the content of either slide, and send.
//
// WHAT WAS HERE BEFORE AND IS GONE.
//
//   * THE RUN-BY-RUN BEFORE/AFTER TABLE. Thirteen rows reading `Paths in, -> Natus at,` asked the
//     user to audit a diff by eye and told them nothing about whether the slide still looked like
//     their slide. The visual pair answers the question the table was pretending to. Everything the
//     table was PROTECTING is kept: nothing is sent until Send is pressed, and what is sent is what
//     the right-hand slide renders.
//   * THE MODEL ROUND TRIP (`AskPhase`, the long poll, the row filter). Anonymisation is lorem
//     ipsum, always -- "the model-assisted and generic-vocabulary modes are withdrawn" -- so there
//     were no model replacements to review, nothing was ever refused, and a whole column plus a
//     "show me only the refused ones" filter were dead weight on screen and in the bundle.
//
// THE FLOW, in the order the user meets it:
//   1. a slide to report on, and its HTML
//   2. the anonymisation pass -- every visible run lorem, every other carrier substituted
//   3. the PAIR: both slides rendered, with the anonymiser's verdicts as numbered annotations on
//      the one they are about
//   4. optional edits: the title, the left slide (which is re-anonymised), the right slide (which
//      is what is sent)
//   5. "Prepare the report" -- converts the bytes the right slide renders and checks them
//   6. "Send" -- and nothing leaves until this is pressed
//
// THE BYTE-IDENTITY GUARANTEE, AND WHY IT IS STRUCTURAL. `previewDefectReport` takes a `convert`
// FUNCTION rather than a conversion, so the only conversion that can reach a payload is the one it
// made from the html it was given -- and it is given `sentHtmlOf(defect)`, the SAME function the
// right-hand pane renders from. One definition of "what is sent", used by the picture and by the
// payload, is what makes "what you see is what is sent" true rather than careful.
//
// Converting is expensive (it stages an iframe, waits for fonts and rasterises), so it cannot run
// on every keystroke; and a preview built before an edit must never be sendable after one. Both are
// solved by recording what the preview was built FROM: `generation` (bumped by everything that
// changes the pass) and the exact `sentHtml` bytes. `sendablePreview` hands a payload back only
// when both still match, so an edit disables Send and says why.
//
// WHAT IS IN THIS TREE AND WHERE IT GOES. The original HTML and the original runs are here -- they
// have to be, they are the left-hand slide -- and they never reach the report: `DefectReport` has no
// field that could hold them. NOTHING here goes to a model: there is no model in this flow any
// more. The seed is here too and never leaves: with the seed the substitution is reversible, which
// is why `AnonymiseOptions` keeps it out of `AnonymisedSlide`.

import type {
  AnonymisedSlide,
  DefectReportPreview,
  IdentifierPolicy,
  TextRun,
  TextRunId,
  TextRunKind,
  TextRunReplacements,
} from "./anonymise/index.ts";
import { assertNever } from "./protocol.ts";
import type { ReportSubmission } from "./report-endpoint.ts";
import { DEFAULT_REPORT_ENDPOINT } from "./report-endpoint.ts";
import type { SlideEdit } from "./slide-editor.ts";

export type Defect = Readonly<{
  slide: SlideSource;
  /** The substitution key. Fresh per report, injected at `report-opened`, and it never travels. */
  seed: string;
  /**
   * `"rename"` by default and the interface says why: under `"preserve"` a class such as
   * `.acme-q3-revenue` ships verbatim, so a company name survives a slide whose every word was
   * substituted. `identifier-policy-leak.test.ts` in the anonymiser pins that trade-off.
   */
  identifiers: IdentifierPolicy;
  /**
   * WHICH OF THE TWO SLIDES IS ON SCREEN. `pair` is the default and the reason the surface exists;
   * the two single views are a zoom, for a detail too small to judge at half width. Exactly the
   * same idea as the slides window's `SlideView` -- a view, never a mode.
   */
  view: ReportView;
  /** What the user typed over a replacement, keyed by run. The TITLE is edited through this. */
  edits: readonly TextRunEdit[];
  /** Hand edits to the LEFT slide. They change what gets anonymised, so nothing is bypassed. */
  source: SourceSlide;
  /** Hand edits to the RIGHT slide. They change what gets SENT -- see `sentHtmlOf`. */
  sent: SentSlide;
  pass: PassLoad;
  note: string;
  endpoint: string;
  /** Bumped by everything that changes the anonymisation pass. See the file header. */
  generation: number;
  preview: PreviewLoad;
  send: SubmitPhase;
}>;

/** The pair, or one of its halves large. Three values, so every decision site is a switch. */
export type ReportView = "pair" | "as-is" | "as-sent";

/** One replacement the user typed, keyed by the run id `extractTextRuns` gave it. */
export type TextRunEdit = Readonly<{ runId: TextRunId; text: string }>;

/**
 * The slide being reported. `absent` is the honest answer when the flow was opened with no
 * candidate to report on, and it carries the reason rather than rendering an empty surface.
 */
export type SlideSource =
  | Readonly<{ kind: "absent"; message: string }>
  | Readonly<{ kind: "unrequested"; fileId: string; label: string }>
  | Readonly<{ kind: "loading"; fileId: string; label: string }>
  | Readonly<{ kind: "loaded"; fileId: string; label: string; html: string }>
  | Readonly<{ kind: "failed"; fileId: string; label: string; message: string }>;

/**
 * THE LEFT SLIDE, after the user's own edits to it -- the SAFE half of "edit the content of either
 * slide". Whatever they do here is still anonymised afterwards, so this is the right place to cut a
 * slide down to the part that actually reproduces the defect.
 */
export type SourceSlide =
  | Readonly<{ kind: "as-read" }>
  | Readonly<{ kind: "hand-edited"; html: string; edits: readonly SlideEdit[] }>;

/**
 * THE RIGHT SLIDE, after the user's own edits to it -- and this half ships verbatim, which is why
 * it is a named variant rather than a string field.
 *
 * `forGeneration` is the pass these edits were made against. Anything that re-anonymises (the
 * title, the policy, an edit to the left slide) moves the generation on, and these edits are then
 * DROPPED rather than reapplied to bytes they were not made from -- `discardedSentEdits` is what
 * puts that on screen instead of letting it happen quietly.
 */
export type SentSlide =
  | Readonly<{ kind: "as-anonymised" }>
  | Readonly<{ kind: "hand-edited"; html: string; edits: readonly SlideEdit[]; forGeneration: number }>;

/**
 * One anonymisation pass. Synchronous (the anonymiser is string in, string out), so there is no
 * `running` arm -- but it CAN throw on a pathological input, and a throw must reach the screen.
 *
 * `runs` is `extractTextRuns` over the ORIGINAL html and `slide.textRuns` is the same runs as they
 * came out; the ids match without anything being passed between them, because both are derived
 * from the same token stream.
 */
export type PassLoad =
  | Readonly<{ kind: "unrun" }>
  | Readonly<{ kind: "run"; generation: number; slide: AnonymisedSlide; runs: readonly TextRun[] }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * A prepared payload, and what it was prepared FROM. Both are recorded because both can go stale:
 * `generation` moves when the pass changes, and `sentHtml` moves when the right slide is hand-edited
 * without the pass changing at all.
 */
export type PreviewLoad =
  | Readonly<{ kind: "unbuilt" }>
  | Readonly<{ kind: "building" }>
  | Readonly<{ kind: "built"; generation: number; sentHtml: string; preview: DefectReportPreview }>
  | Readonly<{ kind: "failed"; message: string }>;

export type SubmitPhase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sending" }>
  /** The service's verdict, whatever it was. All three of its arms are rendered. */
  | Readonly<{ kind: "answered"; submission: ReportSubmission }>;

export type DefectEvent =
  | Readonly<{ kind: "slide-requested" }>
  | Readonly<{ kind: "slide-arrived"; html: string }>
  | Readonly<{ kind: "slide-failed"; message: string }>
  | Readonly<{ kind: "view-chosen"; view: ReportView }>
  | Readonly<{ kind: "policy-chosen"; identifiers: IdentifierPolicy }>
  | Readonly<{ kind: "pass-run"; slide: AnonymisedSlide; runs: readonly TextRun[] }>
  | Readonly<{ kind: "pass-failed"; message: string }>
  /** The title, or any other run the surface exposes. Goes through the anonymiser's own gate. */
  | Readonly<{ kind: "run-edited"; runId: TextRunId; text: string }>
  | Readonly<{ kind: "run-reset"; runId: TextRunId }>
  /** The visual editor reported edits to the LEFT slide. The pass re-runs over the result. */
  | Readonly<{ kind: "source-edited"; html: string; edits: readonly SlideEdit[] }>
  | Readonly<{ kind: "source-reset" }>
  /** The visual editor reported edits to the RIGHT slide. This is what gets sent. */
  | Readonly<{ kind: "sent-edited"; html: string; edits: readonly SlideEdit[] }>
  | Readonly<{ kind: "sent-reset" }>
  /** "Anonymise it again": run the pass over the replacements as they now stand. */
  | Readonly<{ kind: "reanonymise-requested" }>
  | Readonly<{ kind: "note-typed"; text: string }>
  | Readonly<{ kind: "endpoint-typed"; endpoint: string }>
  | Readonly<{ kind: "preview-requested" }>
  | Readonly<{ kind: "preview-built"; sentHtml: string; preview: DefectReportPreview }>
  | Readonly<{ kind: "preview-failed"; message: string }>
  | Readonly<{ kind: "send-started" }>
  | Readonly<{ kind: "send-answered"; submission: ReportSubmission }>;

/**
 * A flow with a slide to report on. `seed` is the composition root's randomness, never generated
 * here, so the reducer stays pure and the tests stay deterministic.
 */
export function defectOnSlide({
  fileId,
  label,
  seed,
}: {
  fileId: string;
  label: string;
  seed: string;
}): Defect {
  return { ...emptyDefect({ seed }), slide: { kind: "unrequested", fileId, label } };
}

/** A flow opened with nothing to report on. The surface says `message` instead of two blank panes. */
export function defectWithoutSlide({ seed, message }: { seed: string; message: string }): Defect {
  return { ...emptyDefect({ seed }), slide: { kind: "absent", message } };
}

export function reduceDefect(defect: Defect, event: DefectEvent): Defect {
  switch (event.kind) {
    case "slide-requested":
      return { ...defect, slide: loadingSlide(defect.slide) };

    case "slide-arrived": {
      const named = namedSlide(defect.slide);
      if (named === null) return defect;
      // A new slide invalidates everything downstream, including every hand edit: a run id is a
      // POSITION in the document's token stream (text-runs.ts) and a `SlideEdit` target is a
      // selector into a particular document, so neither means anything against other bytes.
      return {
        ...emptyDefect({ seed: defect.seed }),
        slide: { kind: "loaded", fileId: named.fileId, label: named.label, html: event.html },
        identifiers: defect.identifiers,
        endpoint: defect.endpoint,
        note: defect.note,
        view: defect.view,
        generation: defect.generation + 1,
      };
    }

    case "slide-failed": {
      const named = namedSlide(defect.slide);
      if (named === null) return defect;
      return {
        ...defect,
        slide: { kind: "failed", fileId: named.fileId, label: named.label, message: event.message },
      };
    }

    case "view-chosen":
      // NOT `edited`: which half of the pair you are looking at changes nothing about what is sent,
      // so a prepared preview stays valid. A view is not a mode.
      return { ...defect, view: event.view };

    case "policy-chosen":
      return event.identifiers === defect.identifiers
        ? defect
        : edited({ ...defect, identifiers: event.identifiers });

    case "pass-run":
      return {
        ...defect,
        pass: { kind: "run", generation: defect.generation, slide: event.slide, runs: event.runs },
      };

    case "pass-failed":
      return { ...defect, pass: { kind: "failed", message: event.message } };

    case "run-edited":
      return edited({ ...defect, edits: withEdit({ edits: defect.edits, runId: event.runId, text: event.text }) });

    case "run-reset":
      return edited({ ...defect, edits: defect.edits.filter((edit) => edit.runId !== event.runId) });

    case "source-edited":
      // The LEFT slide changed, so the whole anonymisation is stale: `edited` bumps the generation
      // and the pass re-runs over the new bytes. Nothing bypasses the anonymiser on this path.
      return edited({ ...defect, source: { kind: "hand-edited", html: event.html, edits: event.edits } });

    case "source-reset":
      return sourceEditsOf(defect.source).length === 0 ? defect : edited({ ...defect, source: { kind: "as-read" } });

    case "sent-edited":
      // The RIGHT slide changed, and the generation does NOT move: the pass that produced the bytes
      // being edited is still the current one, and bumping it would re-anonymise and throw the edit
      // away on the spot. What goes stale is the PREPARED PREVIEW, which `sendablePreview` catches
      // by comparing the bytes themselves.
      return {
        ...defect,
        sent: { kind: "hand-edited", html: event.html, edits: event.edits, forGeneration: defect.generation },
        send: { kind: "idle" },
      };

    case "sent-reset":
      // NOT `edited`: dropping a hand edit restores the bytes the current pass produced, so the
      // pass itself is untouched and only the prepared preview goes stale.
      return sentEditsOf({ sent: defect.sent, generation: defect.generation }).length === 0
        ? defect
        : { ...defect, sent: { kind: "as-anonymised" }, send: { kind: "idle" } };

    case "reanonymise-requested":
      return edited(defect);

    case "note-typed":
      // The note IS part of the payload, so it invalidates a prepared preview -- but it is NOT part
      // of the anonymisation, so it must not re-run the pass. `edited` here would re-anonymise on
      // every keystroke AND throw away the user's hand edits to the sent slide while they typed the
      // covering note, which is as bad as a bug gets on this surface. The staleness check compares
      // the note the preview was BUILT with (`DefectReportPreview.note`) instead.
      return { ...defect, note: event.text, send: { kind: "idle" } };

    case "endpoint-typed":
      // NOT `edited`: where it is sent is not what is sent, so a prepared preview stays valid.
      return { ...defect, endpoint: event.endpoint, send: { kind: "idle" } };

    case "preview-requested":
      return { ...defect, preview: { kind: "building" }, send: { kind: "idle" } };

    case "preview-built":
      return {
        ...defect,
        preview: {
          kind: "built",
          generation: defect.generation,
          sentHtml: event.sentHtml,
          preview: event.preview,
        },
      };

    case "preview-failed":
      return { ...defect, preview: { kind: "failed", message: event.message } };

    case "send-started":
      return { ...defect, send: { kind: "sending" } };

    case "send-answered":
      return { ...defect, send: { kind: "answered", submission: event.submission } };

    default:
      return assertNever(event);
  }
}

/**
 * THE LEFT SLIDE'S BYTES -- what the "as it is" pane renders AND what the anonymiser is run over.
 * One definition, so the picture and the input cannot be two different documents.
 *
 * The user's own edits win over Drive's copy, because editing the left slide is how a reporter cuts
 * a slide down to the part that reproduces the defect, and the pass has to see that.
 */
export function sourceHtmlOf(defect: Defect): string | null {
  switch (defect.source.kind) {
    case "hand-edited":
      return defect.source.html;
    case "as-read":
      return driveHtmlOf(defect.slide);
    default:
      return assertNever(defect.source);
  }
}

/**
 * THE RIGHT SLIDE'S BYTES -- what the "as it will be sent" pane renders AND, byte for byte, what is
 * sent. `report.tsx` hands this exact string to `previewDefectReport`, which converts it and puts
 * it in the payload, so "what is sent is what the right-hand slide renders" is one function rather
 * than a convention two call sites have to keep.
 *
 * A hand edit made against an OLDER pass is ignored here, which is the same answer
 * `discardedSentEdits` reports on screen: bytes edited from a document that has since been
 * re-anonymised are not a version of the current one.
 */
export function sentHtmlOf(defect: Defect): string | null {
  const anonymised = currentAnonymised(defect);
  if (anonymised === null) return null;
  switch (defect.sent.kind) {
    case "hand-edited":
      return defect.sent.forGeneration === defect.generation ? defect.sent.html : anonymised.html;
    case "as-anonymised":
      return anonymised.html;
    default:
      return assertNever(defect.sent);
  }
}

/**
 * WHAT EACH PANE'S IFRAME IS LOADED WITH -- and it is deliberately NOT `sourceHtmlOf` /
 * `sentHtmlOf`.
 *
 * A pane's iframe is loaded once per document and then EDITED IN PLACE: the visual editor mutates
 * the live DOM and `editor.html()` serializes the result. Feeding that serialization back into
 * `srcDoc` would reload the frame after every gesture -- resetting the editor's baseline, losing
 * the selection, and flashing the slide. So the frame keeps the document it was given, the live DOM
 * carries the edits, and the two `*HtmlOf` selectors are what the ANONYMISER and the PAYLOAD read.
 *
 * "What is sent is what the right-hand slide renders" is therefore exact rather than approximate:
 * the right-hand slide renders the live DOM, and `sentHtmlOf` is that DOM serialized.
 */
export function sourceFrameHtmlOf(defect: Defect): string | null {
  return driveHtmlOf(defect.slide);
}

/** The same, for the right-hand pane: the bytes the current anonymisation pass produced. */
export function sentFrameHtmlOf(defect: Defect): string | null {
  return currentAnonymised(defect)?.html ?? null;
}

/**
 * THE SLIDE TO HAND `previewDefectReport`, carrying the bytes the right-hand pane renders.
 *
 * `previewDefectReport` converts `anonymised.html` and `defectReportFrom` sends that same string, so
 * putting `sentHtmlOf` on it keeps the two in lockstep: the conversion is made FROM the bytes that
 * are sent, which is the rule and is not worked around. It is here rather than in the composition
 * root because it is the hinge of the byte-identity claim, and a hinge belongs where it can be
 * tested with values.
 *
 * What it does NOT do is re-derive the pass's summary from edited bytes: `carriers`,
 * `residualRisks` and the rest still describe the anonymisation the engine ran, and `annotationsOf`
 * says so on the slide. Nothing original can ride in either -- `preparable` refuses while
 * `reintroducedOriginals` finds any of the original's own words in these bytes.
 */
export function sendableAnonymised(defect: Defect): AnonymisedSlide | null {
  const anonymised = currentAnonymised(defect);
  const sentHtml = sentHtmlOf(defect);
  if (anonymised === null || sentHtml === null) return null;
  return anonymised.html === sentHtml ? anonymised : { ...anonymised, html: sentHtml };
}

/** Whether the HTML loop should read. A predicate over the union, so a new variant must answer. */
export function needsSlideHtml(defect: Defect): boolean {
  switch (defect.slide.kind) {
    case "unrequested":
      return true;
    case "absent":
    case "loading":
    case "loaded":
    case "failed":
      return false;
    default:
      return assertNever(defect.slide);
  }
}

/**
 * Whether the anonymisation pass must run. It must whenever the left slide's bytes are in and the
 * pass on screen is not the one the current state describes -- which is what makes an edit redraw
 * the right-hand slide without any component asking it to.
 */
export function needsPass(defect: Defect): boolean {
  if (sourceHtmlOf(defect) === null) return false;
  switch (defect.pass.kind) {
    case "unrun":
      return true;
    case "run":
      return defect.pass.generation !== defect.generation;
    case "failed":
      // A pass that threw is not retried on its own: the input has not changed, so it would throw
      // again. An edit bumps the generation and `edited` resets this to `unrun`.
      return false;
    default:
      return assertNever(defect.pass);
  }
}

/** The anonymised slide the current pass produced, or null. What the annotations describe. */
export function currentAnonymised(defect: Defect): AnonymisedSlide | null {
  return currentPass(defect)?.slide ?? null;
}

/**
 * THE TITLE, as a run -- the one piece of text the visual editor cannot reach, because `<title>` is
 * not on the slide. UI-CONTRACT.md names "edit the title" as its own control for exactly that
 * reason, and this is the run it edits.
 */
export function titleRunOf(defect: Defect): RunRow | null {
  return runRowsOf(defect).find((row) => isTitleRun(row.kind)) ?? null;
}

/**
 * THE RUNS THE ANONYMISER HAD SOMETHING TO SAY ABOUT -- a rejected replacement, or a shape risk.
 * These are the rows the old table existed for, and they become annotations on the pair.
 *
 * With lorem-always this is normally EMPTY: nothing proposes a replacement except the user, so
 * nothing is refused unless they typed something the gate would not take. That is precisely when
 * the user needs to be told, and nothing is on screen when there is nothing to say.
 */
export function flaggedRunsOf(defect: Defect): readonly RunRow[] {
  return runRowsOf(defect).filter((row) => row.rejected !== null || row.shapeRisk !== null);
}

/**
 * EVERY VISIBLE RUN, zipped by id, with the anonymiser's verdict attached to the run it is about.
 * It is built here rather than in a component because it is a decision, and decisions are tested
 * with values. It is NOT rendered as a table any more -- `titleRunOf` and `flaggedRunsOf` are the
 * two things the surface asks it for.
 */
export function runRowsOf(defect: Defect): readonly RunRow[] {
  const pass = currentPass(defect);
  if (pass === null) return [];
  const after = new Map(pass.slide.textRuns.map((run) => [run.id, run]));
  const rejected = new Map(pass.slide.rejectedReplacements.map((entry) => [entry.runId, entry]));
  const risks = new Map(pass.slide.shapeRisks.map((risk) => [risk.runId, risk]));
  const typed = new Map(defect.edits.map((edit) => [edit.runId, edit.text]));
  return pass.runs.map((run) => {
    const anonymised = after.get(run.id);
    return {
      runId: run.id,
      kind: run.kind,
      before: run.text,
      // `""` only if the anonymiser stopped emitting a run it extracted, which cannot happen while
      // both walk the same token stream -- but a row with no text would be a silent hole.
      after: anonymised?.text ?? "",
      origin: anonymised?.origin ?? "substituted",
      rejected: rejected.get(run.id) ?? null,
      shapeRisk: risks.get(run.id) ?? null,
      /** What the user typed for this run, or undefined. The input shows this when it is there. */
      typed: typed.get(run.id),
    };
  });
}

/** One visible run and every verdict about it. Everything a row renders, nothing it looks up again. */
export type RunRow = Readonly<{
  runId: TextRunId;
  kind: TextRunKind;
  before: string;
  after: string;
  origin: AnonymisedSlide["textRuns"][number]["origin"];
  rejected: AnonymisedSlide["rejectedReplacements"][number] | null;
  shapeRisk: AnonymisedSlide["shapeRisks"][number] | null;
  typed: string | undefined;
}>;

/**
 * THE ANNOTATIONS ON THE PAIR -- everything the anonymiser and this surface know about the two
 * slides, as numbered notes attached to the slide each one is about.
 *
 * UI-CONTRACT.md requires `rejectedReplacements`, `shapeRisks` and `residualRisks` to stay visible;
 * what changed is that they are annotations rather than columns of a spreadsheet. The order is the
 * order of urgency: a leak first, then a risk, then a note, because the first is the only one that
 * stops the report being sendable.
 */
export function annotationsOf(defect: Defect): readonly ReportAnnotation[] {
  const anonymised = currentAnonymised(defect);
  if (anonymised === null) return [];
  return [...leakAnnotations(defect), ...riskAnnotations({ defect, anonymised }), ...noteAnnotations(anonymised)];
}

export type ReportAnnotation = Readonly<{
  annotationId: string;
  tone: AnnotationTone;
  heading: string;
  detail: string;
  /** Which of the two slides the note is about, so it is pinned to the right one. */
  side: ReportSide;
}>;

/** `leak` blocks the send; `risk` is read before sending; `note` is a tally. */
export type AnnotationTone = "leak" | "risk" | "note";

/**
 * WHETHER AN ANNOTATION GETS A PIN ON THE SLIDE. Only the actionable ones do.
 *
 * Pinning all of them was the first attempt and it was wrong twice over: `residualRisks` is a dozen
 * long sentences, so the gutter became a column of a dozen identical grey dots that said nothing
 * about WHERE anything was, and it buried the one or two pins that mean "look at this slide before
 * you send it". The notes are still on screen, with their numbers, as cards -- it is the PIN that is
 * reserved for a leak or a risk.
 */
export function annotationIsPinned(tone: AnnotationTone): boolean {
  switch (tone) {
    case "leak":
    case "risk":
      return true;
    case "note":
      return false;
    default:
      return assertNever(tone);
  }
}

export type ReportSide = "as-is" | "as-sent";

/**
 * ORIGINAL WORDS THAT HAVE REAPPEARED IN THE BYTES BEING SENT, and this is the one check that
 * exists only because the right slide is editable.
 *
 * The anonymiser's guarantee is that nothing original survives. A hand edit on the right-hand pane
 * is the one path that could put an original word back, so every original visible run is looked for
 * in the bytes that would be sent. It is reported as a LEAK and it blocks Prepare -- recoverable by
 * resetting the edits, which is why it is a refusal with a named cause rather than a throw.
 *
 * Runs shorter than four characters are not checked: the four-character floor is the anonymiser's
 * own echo rule (`replacement-policy.ts`), and below it every document collides with every other.
 */
export function reintroducedOriginals(defect: Defect): readonly string[] {
  // Only a hand edit can put one back; the anonymiser's own output never does, and scanning its
  // output for every original run on every render would be work with no possible finding.
  if (editsOnSide({ defect, side: "as-sent" }).length === 0) return [];
  const sent = sentHtmlOf(defect);
  const pass = currentPass(defect);
  if (sent === null || pass === null) return [];
  const found = new Set<string>();
  for (const run of pass.runs) {
    const original = run.text.trim();
    if (original.length < MIN_ECHO_LENGTH) continue;
    if (sent.includes(original)) found.add(original);
  }
  return [...found];
}

/** How many hand edits to the right slide a re-anonymisation threw away. Never silently. */
export function discardedSentEdits(defect: Defect): number {
  switch (defect.sent.kind) {
    case "hand-edited":
      return defect.sent.forGeneration === defect.generation ? 0 : defect.sent.edits.length;
    case "as-anonymised":
      return 0;
    default:
      return assertNever(defect.sent);
  }
}

/** The edits in force on one side of the pair. The panel lists them and offers to undo them all. */
export function editsOnSide({ defect, side }: { defect: Defect; side: ReportSide }): readonly SlideEdit[] {
  switch (side) {
    case "as-is":
      return sourceEditsOf(defect.source);
    case "as-sent":
      return sentEditsOf({ sent: defect.sent, generation: defect.generation });
    default:
      return assertNever(side);
  }
}

/**
 * WHETHER A PAYLOAD MAY BE BUILT AT ALL. Separate from `sendablePreview` because they refuse for
 * different reasons and the user needs the right one: this is "the bytes are not fit to send", that
 * is "the bytes changed since you looked".
 */
export function preparable(defect: Defect): PrepareReadiness {
  if (sentHtmlOf(defect) === null) return { kind: "no-pass" };
  const leaked = reintroducedOriginals(defect);
  if (leaked.length > 0) return { kind: "leaking", strings: leaked };
  return { kind: "ready" };
}

export type PrepareReadiness =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "no-pass" }>
  | Readonly<{ kind: "leaking"; strings: readonly string[] }>;

/** Whether Prepare may be pressed. A predicate, so a new readiness arm has to answer. */
export function canPrepare(readiness: PrepareReadiness): boolean {
  switch (readiness.kind) {
    case "ready":
      return true;
    case "no-pass":
    case "leaking":
      return false;
    default:
      return assertNever(readiness);
  }
}

/** Why Prepare is unavailable, in words. Exhaustive, so a new arm has to be explained. */
export function describePrepareReadiness(readiness: PrepareReadiness): string {
  switch (readiness.kind) {
    case "ready":
      return (
        "Preparing converts the slide on the right and shows exactly what will be sent. Nothing " +
        "leaves this browser until you press Send."
      );
    case "no-pass":
      return "There is nothing to prepare yet: the slide has not been anonymised.";
    case "leaking":
      return (
        `Your edits to the slide on the right put ${readiness.strings.length} of the original ` +
        "slide's own words back into it, so it cannot be sent. Undo them, or retype those words."
      );
    default:
      return assertNever(readiness);
  }
}

/**
 * THE BYTE-IDENTITY GATE. The preview to send, or null -- and null is the answer whenever anything
 * has changed since it was prepared. Every send path goes through this one function.
 *
 * TWO comparisons, because there are two ways to go stale: the pass can change (`generation`) and
 * the right slide's bytes can change without it (a hand edit). The bytes are compared directly,
 * which needs no counter to be right.
 */
export function sendablePreview(defect: Defect): DefectReportPreview | null {
  const sent = sentHtmlOf(defect);
  if (sent === null) return null;
  switch (defect.preview.kind) {
    case "built":
      return freshPreview({ built: defect.preview, defect, sent }) ? defect.preview.preview : null;
    case "unbuilt":
    case "building":
    case "failed":
      return null;
    default:
      return assertNever(defect.preview);
  }
}

/** Whether a prepared preview went stale, so the surface says "prepare it again" rather than nothing. */
export function previewIsStale(defect: Defect): boolean {
  switch (defect.preview.kind) {
    case "built":
      return !freshPreview({ built: defect.preview, defect, sent: sentHtmlOf(defect) });
    case "unbuilt":
    case "building":
    case "failed":
      return false;
    default:
      return assertNever(defect.preview);
  }
}

/** Whether a send is in flight, so the buttons can go read-only without re-deriving it. */
export function isSubmitting(defect: Defect): boolean {
  switch (defect.send.kind) {
    case "sending":
      return true;
    case "idle":
    case "answered":
      return false;
    default:
      return assertNever(defect.send);
  }
}

/**
 * THE REPLACEMENTS TO HAND THE ENGINE: the user's own, and nobody else's. There is no model in this
 * flow, so this is exactly `defect.edits`.
 *
 * The engine still JUDGES every entry: `judgeReplacement` has no "the user said so" exemption, so a
 * title that hands the original back is rejected and gibberished like any other, and the rejection
 * comes back as an annotation. That is the one gate a run-level edit passes through and the reason
 * the title is edited this way rather than as free bytes.
 */
export function replacementsFor(defect: Defect): TextRunReplacements {
  return new Map(defect.edits.map((edit) => [edit.runId, edit.text]));
}

/**
 * WHETHER A PREPARED PAYLOAD STILL DESCRIBES THE STATE ON SCREEN. THREE comparisons, one per way of
 * going stale, and all three are against the thing itself rather than against a counter that has to
 * be remembered to bump:
 *
 *   the PASS       -- `generation`, bumped by everything that re-anonymises;
 *   the SENT BYTES -- compared directly, because a hand edit changes them without the pass moving;
 *   the NOTE       -- read off the preview it was built with, because the note is in the payload.
 */
function freshPreview({
  built,
  defect,
  sent,
}: {
  built: Extract<PreviewLoad, { kind: "built" }>;
  defect: Defect;
  sent: string | null;
}): boolean {
  return built.generation === defect.generation && built.sentHtml === sent && built.preview.note === defect.note;
}

/** The left slide's hand edits. A switch, so a new `SourceSlide` variant cannot read as "none". */
function sourceEditsOf(source: SourceSlide): readonly SlideEdit[] {
  switch (source.kind) {
    case "hand-edited":
      return source.edits;
    case "as-read":
      return [];
    default:
      return assertNever(source);
  }
}

/**
 * The right slide's hand edits, and only the ones made against the pass that is on screen. Same
 * contract as `sourceEditsOf`, plus the generation check that `discardedSentEdits` reports on.
 */
function sentEditsOf({ sent, generation }: { sent: SentSlide; generation: number }): readonly SlideEdit[] {
  switch (sent.kind) {
    case "hand-edited":
      return sent.forGeneration === generation ? sent.edits : [];
    case "as-anonymised":
      return [];
    default:
      return assertNever(sent);
  }
}

/** Which runs a surface may expose as text. A switch, so a new `TextRunKind` has to be placed. */
function isTitleRun(kind: TextRunKind): boolean {
  switch (kind) {
    case "document-title":
      return true;
    case "body-text":
    case "svg-text":
    case "image-alternative":
    case "accessible-label":
      return false;
    default:
      return assertNever(kind);
  }
}

/** The pass that describes the state as it now is, or null while it is stale or missing. */
function currentPass(defect: Defect): Readonly<{ slide: AnonymisedSlide; runs: readonly TextRun[] }> | null {
  switch (defect.pass.kind) {
    case "run":
      return defect.pass.generation === defect.generation
        ? { slide: defect.pass.slide, runs: defect.pass.runs }
        : null;
    case "unrun":
    case "failed":
      return null;
    default:
      return assertNever(defect.pass);
  }
}

/** The one thing that stops a report being sendable. */
function leakAnnotations(defect: Defect): readonly ReportAnnotation[] {
  const leaked = reintroducedOriginals(defect);
  if (leaked.length === 0) return [];
  return [
    {
      annotationId: "leak_reintroduced",
      tone: "leak",
      side: "as-sent",
      heading: `${leaked.length} of the original slide's own words are back on this slide`,
      detail: `Your edits reintroduced: ${leaked.join(", ")}. The report cannot be prepared until they are gone.`,
    },
  ];
}

/** Everything the user is expected to read before pressing Send. */
function riskAnnotations({
  defect,
  anonymised,
}: {
  defect: Defect;
  anonymised: AnonymisedSlide;
}): readonly ReportAnnotation[] {
  const annotations: ReportAnnotation[] = [];
  for (const row of flaggedRunsOf(defect)) {
    if (row.rejected !== null) {
      annotations.push({
        annotationId: `rejected_${row.runId}`,
        tone: "risk",
        side: "as-sent",
        heading: "A replacement you typed was refused, so this run is gibberish instead",
        detail: `${row.rejected.detail} The slide says "${row.after}".`,
      });
    }
    if (row.shapeRisk !== null) {
      annotations.push({
        annotationId: `shape_${row.runId}`,
        tone: "risk",
        side: "as-sent",
        heading: "This replacement may not wrap the way the original did",
        detail: row.shapeRisk.detail,
      });
    }
  }
  // HAND EDITS TO THE SENT SLIDE SHIP VERBATIM. The anonymiser did not write them and does not vouch
  // for them, and that has to be said next to the slide rather than in a doc comment.
  const handEdits = editsOnSide({ defect, side: "as-sent" });
  if (handEdits.length > 0) {
    annotations.push({
      annotationId: "handedited_sent",
      tone: "risk",
      side: "as-sent",
      heading: `${handEdits.length} of your own edit${handEdits.length === 1 ? "" : "s"} are in what is sent`,
      detail:
        "They are sent exactly as you made them. Everything the anonymiser reports below describes " +
        "the pass it ran, not your edits -- read this slide, because it is the thing that leaves.",
    });
  }
  const discarded = discardedSentEdits(defect);
  if (discarded > 0) {
    annotations.push({
      annotationId: "discarded_sent",
      tone: "risk",
      side: "as-sent",
      heading: `${discarded} of your edits to this slide were dropped`,
      detail:
        "The slide was anonymised again, so edits made against the previous version no longer apply " +
        "to it. This slide is the fresh anonymisation; make the edits again if you still want them.",
    });
  }
  if (anonymised.retainedIdentifiers.length > 0) {
    annotations.push({
      annotationId: "retained_identifiers",
      tone: "risk",
      side: "as-sent",
      heading: `${anonymised.retainedIdentifiers.length} class or id names are sent exactly as written`,
      detail: anonymised.retainedIdentifiers
        .map((identifier) => `${identifier.namespace} ${identifier.name}`)
        .join(", "),
    });
  }
  return annotations;
}

/**
 * THE RESIDUAL RISKS, VERBATIM. `residualRisks` is one sentence per carrier the anonymiser knowingly
 * does not neutralise, and it is rendered WORD FOR WORD: the sentences name the carriers precisely,
 * and a paraphrase would be a second declaration that drifts.
 */
function noteAnnotations(anonymised: AnonymisedSlide): readonly ReportAnnotation[] {
  const annotations: ReportAnnotation[] = anonymised.residualRisks.map((risk, position) => ({
    annotationId: `residual_${position}`,
    tone: "note",
    side: "as-sent",
    heading: "The anonymiser does not neutralise this",
    detail: risk,
  }));
  if (anonymised.unrecognisedAttributes.length > 0) {
    annotations.push({
      annotationId: "unrecognised_attributes",
      tone: "note",
      side: "as-sent",
      heading: "Substituted only because nothing recognised them",
      detail: anonymised.unrecognisedAttributes.join(", "),
    });
  }
  return annotations;
}

/** Drive's own copy of the slide, or null. The left pane falls back to this when nothing is edited. */
function driveHtmlOf(slide: SlideSource): string | null {
  switch (slide.kind) {
    case "loaded":
      return slide.html;
    case "absent":
    case "unrequested":
    case "loading":
    case "failed":
      return null;
    default:
      return assertNever(slide);
  }
}

/** The anonymiser's own echo floor: below four characters every document collides with every other. */
const MIN_ECHO_LENGTH = 4;

function emptyDefect({ seed }: { seed: string }): Defect {
  return {
    slide: { kind: "absent", message: "no slide chosen" },
    seed,
    identifiers: "rename",
    // THE PAIR FIRST. Seeing both slides at once is the whole reason this surface exists, so nobody
    // has to choose a view before they can judge the anonymisation.
    view: "pair",
    edits: [],
    source: { kind: "as-read" },
    sent: { kind: "as-anonymised" },
    pass: { kind: "unrun" },
    note: "",
    endpoint: DEFAULT_REPORT_ENDPOINT,
    generation: 1,
    preview: { kind: "unbuilt" },
    send: { kind: "idle" },
  };
}

/**
 * Everything that changes the ANONYMISATION goes through here: the generation moves, the pass is
 * marked stale, and any send verdict stops applying. A prepared preview is KEPT in the tree so
 * `previewIsStale` can say "you changed something since you prepared this" -- `sendablePreview` is
 * what refuses to send it.
 */
function edited(defect: Defect): Defect {
  return {
    ...defect,
    generation: defect.generation + 1,
    pass: { kind: "unrun" },
    send: { kind: "idle" },
  };
}

function withEdit({
  edits,
  runId,
  text,
}: {
  edits: readonly TextRunEdit[];
  runId: TextRunId;
  text: string;
}): readonly TextRunEdit[] {
  const existing = edits.some((edit) => edit.runId === runId);
  if (existing) return edits.map((edit) => (edit.runId === runId ? { runId, text } : edit));
  return [...edits, { runId, text }];
}

/** The slide's identity when it has one. `absent` is the only arm without a file. */
function namedSlide(slide: SlideSource): Readonly<{ fileId: string; label: string }> | null {
  switch (slide.kind) {
    case "unrequested":
    case "loading":
    case "loaded":
    case "failed":
      return { fileId: slide.fileId, label: slide.label };
    case "absent":
      return null;
    default:
      return assertNever(slide);
  }
}

function loadingSlide(slide: SlideSource): SlideSource {
  const named = namedSlide(slide);
  return named === null ? slide : { kind: "loading", fileId: named.fileId, label: named.label };
}
