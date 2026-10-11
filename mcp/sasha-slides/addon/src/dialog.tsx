// THE SLIDES WINDOW: the composition root of the modeless candidates window (UI-CONTRACT.md).
//
// It is opened from the CONVERSATION and never from the menu -- the Slides menu has exactly one
// item, Ask Sasha, because a menu that lists surfaces makes the user assemble the product
// themselves. The conversation shows it automatically when slides arrive and keeps a button to
// bring it back, which is the only way back once that moment has passed.
//
// IT SHARES NOTHING WITH THE CONVERSATION. Separate HtmlService documents, separate frames,
// separate origins -- no state, no storage, no postMessage (UI-CONTRACT.md). Everything both
// surfaces need goes through the server: this window finds its proposal with the same
// `sashaScanInbox` name walk, reads the SAME candidate comments for the unresolved counts, and
// writes `PICK` plus a `slide-inserted` event, which is how the conversation learns what happened.
//
// WHAT USED TO BE HERE AND IS NOT ANY MORE:
//
//   * REVIEW MODE (marking up the deck the user already has) is GONE, not demoted. Review is
//     pre-insert, on candidates: a comment on a candidate is art direction Sasha can act on, a
//     comment on a deck page is a bug report. `Review.tsx`, `review-state.ts` and
//     `sashaCurrentPage` went with it.
//   * THE DEFECT REPORT is a third HtmlService document (`report.tsx`). The anonymiser is the
//     heaviest code in the product and this bundle has a hard ceiling -- HtmlService has been
//     observed corrupting an inlined blob of ~560 KB with "Invalid or unexpected token" -- so what
//     is left here is a button that asks the host for that window.
//
// Shape, as everywhere else in this repo: one state tree, a pure reducer, and feedback loops that
// are functions OF the state. React is a passive subscriber -- it renders the state and calls the
// actions, and decides nothing.

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import {
  appsScriptCall,
  appsScriptCandidateCommentsApi,
  appsScriptCommentThreadApi,
  appsScriptDriveApi,
  appsScriptFeedbackApi,
  appsScriptPickApi,
  appsScriptPickerWindowApi,
  appsScriptSessionLogApi,
  appsScriptSlidesApi,
  helloFromServer,
} from "./bridge-client.ts";
import { presentationIdOf, type RenderRequest } from "./bridge.ts";
import { browserSlideConverter, type ConvertSlideHtml } from "./converter-contract.ts";
import {
  createdObjectIdsOf,
  type CandidateCommentsApi,
  type CommentThreadApi,
  type DriveApi,
  type FeedbackApi,
  type PickApi,
  type PickerWindowApi,
  type SessionLogApi,
  type SlidesApi,
} from "./drive-api.ts";
import { feedbackCommentsFor, sendOutcomeOf, type ReviewNote } from "./feedback.ts";
import { checkSlideHtml, domSlideDocumentParser } from "./html-check.ts";
import { Picker, type PickerActions } from "./Picker.tsx";
import { createObserver, type Announcer, type Observer, type PollTimer } from "./observer-runtime.ts";
import { createReportWindow } from "./report-window.ts";
import { cachedRender, rememberRender, renderKeyOf } from "./render-cache.ts";
import {
  INITIAL_PICKER_STATE,
  anomaliesOf,
  anomalyIn,
  needsComments,
  nextHtmlToLoad,
  nextToConvert,
  slidesToRender,
  type SlideFrame,
  offerOf,
  reducePicker,
  type PickerEvent,
  type PickerState,
} from "./picker-state.ts";
import { createSlideEditor } from "./editor/index.ts";
import { writePick } from "./pick-writer.ts";
import { renderArtifactOf, renderRequestFor } from "./render-artifact.ts";
import { PROTOCOL_VERSION, assertNever, type Parsed } from "./protocol.ts";
import { browserKeyValueStorage, seenStore } from "./seen-store.ts";
import {
  candidateCommentsFrom,
  sessionEventFileName,
  serializeSessionEvent,
  type SessionEventBody,
} from "./session-log.ts";
import { insertRequests, newPageObjectId } from "./slide-insert.ts";

const ROOT_ELEMENT_ID = "sasha-slides-root";
/** One read of a candidate's comment threads -- a candidate with more than this is not the case. */
const CANDIDATE_COMMENT_PAGE_SIZE = 100;
/** Where the converter parks its offscreen 1280x720 staging iframe. */
const STAGE_ELEMENT_ID = "sasha-slides-stage";
/** JSON, because an event file is one JSON object (PROTOCOL.md). */
const EVENT_MIME_TYPE = "application/json";

let state: PickerState = INITIAL_PICKER_STATE;
let root: Root | null = null;
/** The composed services, or null until `sashaHello` has answered. */
let services: Services | null = null;

/** The live visual editor, so `applyMarkup` reaches the one the user actually selected in. */
let editorRef: ReturnType<typeof createSlideEditor> | null = null;
/**
 * Everything the editor could not do, in order. Read by the browser smoke test off
 * `window.__SASHA_EDITOR_WARNINGS__`; a refused attach is otherwise invisible.
 */
const editorWarnings: string[] = [];
// Published on the window so the browser smoke test can read them; the array is the same object,
// so a warning recorded after the test looked is still there the next time it looks.
(window as unknown as { __SASHA_EDITOR_WARNINGS__?: readonly string[] }).__SASHA_EDITOR_WARNINGS__ =
  editorWarnings;
/**
 * How long one candidate's conversion may take before it is called stuck. The converter's own
 * waits are budgeted at ~1.2s each and it stages one offscreen iframe, so a slide that has not
 * converted in this long is never going to.
 */
const CONVERT_DEADLINE_MS = 15_000;

/** One conversion per candidate at a time: `pump` runs after every state change. */
const converting = new Set<number>();
/** One render call for the whole set at a time; `pump` runs again when it lands. */
let rendering = false;
/** Candidate HTML is immutable within one revision, so one fetch per fileId serves every toggle. */
const htmlByFileId = new Map<string, string>();
const parseSlideDocument = domSlideDocumentParser();

type Services = Readonly<{
  drive: DriveApi;
  slides: SlidesApi;
  pick: PickApi;
  feedback: FeedbackApi;
  candidateComments: CandidateCommentsApi;
  /** Answering and closing the user's own threads, from the editor's rail. */
  threads: CommentThreadApi;
  log: SessionLogApi;
  window: PickerWindowApi;
  observer: Observer;
  convert: ConvertSlideHtml;
  presentationId: string | null;
}>;

async function main(): Promise<void> {
  render();
  const call = appsScriptCall({ run: google.script.run });

  // `sashaHello` first, because this window cannot know its own deck: it is served from
  // googleusercontent.com, so there is no `location.href` to parse. Apps Script hands over the
  // presentation's URL and `presentationIdOf` extracts the id, which keeps the only parse in
  // tested TypeScript instead of in Code.gs.
  const hello = await helloFromServer({ call });
  if (hello.kind !== "ok") {
    dispatch({ kind: "trouble", message: hello.message });
    return;
  }
  if (hello.value.protocolVersion !== PROTOCOL_VERSION) {
    dispatch({
      kind: "trouble",
      message: `the add-on speaks protocolVersion ${hello.value.protocolVersion}, this picker ${PROTOCOL_VERSION}`,
    });
    return;
  }

  // Captured as a const, NOT read back through the mutable `services` binding: the announcer can
  // fire from the observer before `services` has been assigned, and `services?.presentationId`
  // then silently yields null, which the picker renders as "this tab is not an editable
  // presentation" on a perfectly editable deck. The id is known here, so it is closed over here.
  const presentationId = presentationIdOf(hello.value.presentationUrl);

  const drive = appsScriptDriveApi({ call });
  const announcer: Announcer = {
    proposal(proposal) {
      dispatch({ kind: "proposal-offered", proposal, presentationId });
      /*
       * OPEN ON THE CANDIDATE THE SIDEBAR ASKED FOR.
       *
       * The two documents share nothing, so "open the slides on slide 3" was left on the server
       * (build-addon.ts `sashaOpenPicker`) and is collected here, once, as the proposal lands.
       * Reading CLEARS it, so reopening the window later comes up on the grid rather than on a
       * slide the user finished with. A target for a DIFFERENT proposal is ignored: the window
       * follows the newest set, and jumping to an old one would be a surprise.
       */
      void openAtTarget(proposal.proposalId);
    },
    trouble(message) {
      dispatch({ kind: "trouble", message });
    },
  };
  const observer = createObserver({
    drive,
    announcer,
    timer: singlePollTimer(),
    seen: seenStore({ storage: browserKeyValueStorage() }),
    log: { warn: (message) => console.warn(`[sasha-slides] ${message}`) },
    nowMs: () => Date.now(),
  });

  services = {
    drive,
    slides: appsScriptSlidesApi({ call }),
    pick: appsScriptPickApi({ call }),
    feedback: appsScriptFeedbackApi({ call }),
    candidateComments: appsScriptCandidateCommentsApi({ call }),
    threads: appsScriptCommentThreadApi({ call }),
    log: appsScriptSessionLogApi({ call }),
    window: appsScriptPickerWindowApi({ call }),
    observer,
    convert: browserSlideConverter({ extractorScript: extractorSource(), container: stageElement() }),
    presentationId,
  };

  // Learned once, here, so pressing "Report a defect" can open the window synchronously inside
  // the click -- which is the only way a browser lets a popup through.
  void reportWindow.learn();

  await observer.start();
  document.addEventListener("visibilitychange", () => {
    void announceViewers(observer);
  });
  await announceViewers(observer);
}

/** Collect the sidebar's "open on this candidate" request, if there is one for this proposal. */
async function openAtTarget(proposalId: string): Promise<void> {
  const running = services;
  if (running === null) return;
  const replied = await running.window.takePickerTarget();
  if (replied.kind !== "ok") return;
  const { proposalId: wanted, slideIndex } = replied.value;
  if (wanted !== proposalId || slideIndex === null) return;
  dispatch({ kind: "editor-opened", index: slideIndex });
}

/**
 * One window is ONE viewer, which is why there is no port and no tab bookkeeping. The shape is
 * kept because it is what drives the poll cadence: a window the user has switched away from still
 * drops to the slow cadence, exactly as a hidden Slides tab did.
 */
async function announceViewers(observer: Observer): Promise<void> {
  observer.dispatch({
    kind: "viewers-changed",
    viewers: { count: 1, anyVisible: document.visibilityState === "visible" },
    nowMs: Date.now(),
  });
  await observer.settled();
}

function dispatch(event: PickerEvent): void {
  const next = reducePicker(state, event);
  if (next === state) return;
  state = next;
  render();
  pump();
}

/**
 * The feedback loops, as functions of the state: fetch the candidates' HTML, convert each one, and
 * read the comment threads that drive the unresolved counts. Idempotent, because `dispatch` runs
 * them after every change.
 */
function pump(): void {
  const offer = offerOf(state);
  if (offer === null) return;
  if (needsComments(offer)) {
    dispatch({ kind: "comments-requested" });
    void loadCandidateComments();
  }
  // The state is re-read, never captured once: `dispatch` renders AND runs `pump` again before
  // returning, so a captured `Offer` would be one event out of date and start the same fetch twice.
  const forHtml = offerOf(state);
  if (forHtml === null) return;
  const toLoad = nextHtmlToLoad(forHtml);
  if (toLoad !== null) {
    dispatch({ kind: "html-requested", index: toLoad.index });
    void loadSlideHtml({ proposalId: forHtml.proposal.proposalId, index: toLoad.index });
    return;
  }
  const toConvert = nextToConvert(forHtml);
  if (toConvert !== null) {
    if (converting.has(toConvert.index) || toConvert.html.kind !== "loaded") return;
    void convert({ proposalId: forHtml.proposal.proposalId, index: toConvert.index, html: toConvert.html.html });
    return;
  }
  // EVERYTHING IS CONVERTED: if the user is looking at the converted rendering, go and get the
  // real pictures. One call for the whole set -- the server builds ONE throwaway deck for all of
  // them (build-addon.ts `sashaRenderPreviews`), so asking per candidate would be N decks.
  const toRender = slidesToRender(forHtml);
  if (toRender === null || rendering) return;
  void renderPreviews({ slides: toRender });
}

/**
 * EVERY candidate, not just the selected one: the grid shows all N at once, so all N documents and
 * all N conversions are wanted. They are fetched ONE AT A TIME -- each arrival dispatches, which
 * re-runs the pump, which picks the next -- because `google.script.run` is a round trip to Google
 * per call and the converter stages a real offscreen iframe per slide. The selectors are in
 * picker-state.ts so "what is next" is a tested decision rather than a loop written here.
 */
async function loadSlideHtml({ proposalId, index }: { proposalId: string; index: number }): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  const slide = offer?.proposal.proposalId === proposalId ? offer.proposal.slides[index - 1] : undefined;
  if (running === null || slide === undefined) {
    dispatch({ kind: "html-failed", index, message: `option ${index} is not part of the offered proposal` });
    return;
  }
  const cached = htmlByFileId.get(slide.fileId);
  if (cached !== undefined) {
    dispatch({ kind: "html-arrived", index, html: cached });
    return;
  }
  const downloaded = await running.drive.downloadText(slide.fileId);
  if (downloaded.kind !== "ok") {
    dispatch({ kind: "html-failed", index, message: downloaded.message });
    return;
  }
  // The protocol invariant is checked once, here, rather than in every render of it.
  for (const warning of checkSlideHtml({ html: downloaded.value, parse: parseSlideDocument }).warnings) {
    console.warn(`[sasha-slides] ${slide.name}: ${warning}`);
  }
  htmlByFileId.set(slide.fileId, downloaded.value);
  dispatch({ kind: "html-arrived", index, html: downloaded.value });
}

/**
 * The real converter, not a stub. It is ASYNC (it stages an offscreen iframe and waits for fonts
 * and images), which is the one place the extension's synchronous assumption had to give.
 */
async function convert({
  proposalId,
  index,
  html,
}: {
  proposalId: string;
  index: number;
  html: string;
}): Promise<void> {
  const running = services;
  if (running === null) return;
  converting.add(index);
  try {
    /*
     * A DEADLINE, BECAUSE A SPINNER THAT NEVER STOPS IS THE WORST FAILURE THIS SURFACE HAS.
     *
     * The conversion is one-at-a-time -- the pump will not start the next candidate while one is
     * in flight (see `pump`) -- so a single conversion that never settles leaves EVERY cell on
     * "converting..." with no error, which is precisely what shipped: `nextFrame` awaited
     * `requestAnimationFrame` unbounded, and a frame the browser is not rendering never fires it.
     * That specific hang is fixed in the converter, where it belongs, and it is tested there.
     *
     * This is the backstop for the next one. Every await inside the converter is budgeted in the
     * low hundreds of ms, so a conversion that has not finished in CONVERT_DEADLINE_MS is stuck,
     * not slow -- and the honest thing to show is the failure, which the cell already renders.
     */
    const converted = await Promise.race([
      running.convert({
        html,
        presentationId: running.presentationId ?? "",
        pageObjectId: newPageObjectId({ random: Math.random }),
        objectIdPrefix: previewPrefix({ proposalId, index }),
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`the converter did not answer within ${String(CONVERT_DEADLINE_MS / 1000)}s`)),
          CONVERT_DEADLINE_MS,
        ),
      ),
    ]);
    dispatch({ kind: "converted", index, result: converted });
  } catch (cause) {
    dispatch({ kind: "conversion-failed", index, message: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    converting.delete(index);
  }
}

/**
 * `services` is null until `sashaHello` has answered, and `main()` returns early when it does
 * not. Every path therefore has to treat "not connected" as a REPORTABLE outcome. Returning
 * silently is what made a failed hello look like a hang: a panel set its loading flags, called
 * these functions, and got nothing back -- so it sat on "loading..." for ever, giving no reason.
 */
const NOT_CONNECTED =
  "the add-on is not connected to Google Slides. Reload the presentation and reopen the slides window.";

/**
 * THE UNRESOLVED COUNTS' read, and it is the SAME one the conversation does: the comment threads on
 * each candidate's own `NN.html`, joined back to the slides by the same `candidateCommentsFrom`.
 * One source and one derivation is the only way UI-CONTRACT.md's "must never disagree" is more
 * than a hope -- and a slide Drive did not answer for comes back `unreachable`, never as zero.
 */
async function loadCandidateComments(): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (offer === null) return;
  if (running === null) {
    dispatch({ kind: "comments-failed", message: NOT_CONNECTED });
    return;
  }
  const replied = await running.candidateComments.read({
    fileIds: offer.proposal.slides.map((slide) => slide.fileId),
    pageSize: CANDIDATE_COMMENT_PAGE_SIZE,
  });
  if (replied.kind !== "ok") {
    dispatch({ kind: "comments-failed", message: replied.message });
    return;
  }
  dispatch({
    kind: "comments-arrived",
    comments: {
      kind: "loaded",
      readAt: new Date().toISOString(),
      slides: candidateCommentsFrom({
        proposalId: offer.proposal.proposalId,
        slides: offer.proposal.slides.map((slide) => ({ slideIndex: slide.index, fileId: slide.fileId })),
        entries: replied.value.files,
      }),
    },
  });
}

/**
 * SEND ONE MARK-UP TO SASHA, as a native Drive comment on the CANDIDATE -- which is the whole of
 * "review happens before inserting, on the candidates" (UI-CONTRACT.md). Three steps, and the
 * order matters:
 *
 *   1. the comment on `NN.html`, because that is the thing Sasha answers and resolves and the
 *      thing both surfaces count;
 *   2. the `comment-opened` event, so the conversation shows it as part of the user's own turn;
 *   3. the comment read is marked stale, so the unresolved count moves without waiting for a poll.
 *
 * STEP 2 IS BEST EFFORT. The comment is already on the candidate by then and Sasha reads the
 * comments, not only the log -- so a failed event write is a warning, never a reason to tell the
 * user their mark-up did not land.
 */
/**
 * ANSWER ONE OF THE USER'S OWN THREADS, from the editor's rail.
 *
 * The comment lives on the CANDIDATE's `NN.html`, so the file is the proposal's slide file --
 * the same address `sendAnomaly` writes to. A failure becomes a line on screen rather than a
 * silent no-op, which is the rule every call in this file follows.
 */
async function replyToThread({
  index,
  commentId,
  text,
}: {
  index: number;
  commentId: string;
  text: string;
}): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (offer === null) return;
  const slide = offer.proposal.slides[index - 1];
  if (running === null || slide === undefined) {
    dispatch({ kind: "trouble", message: running === null ? NOT_CONNECTED : `option ${String(index)} is no longer available` });
    return;
  }
  const replied = await running.threads.reply({ fileId: slide.fileId, commentId, text });
  if (replied.kind !== "ok") {
    dispatch({ kind: "trouble", message: replied.message });
    return;
  }
  await reloadCandidateComments();
}

/**
 * CLOSE A THREAD. Google implements resolving as a reply carrying a resolve action, so a short
 * note is always posted with it -- that is Drive's shape, not a decision made here.
 */
async function resolveThread({ index, commentId }: { index: number; commentId: string }): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (offer === null) return;
  const slide = offer.proposal.slides[index - 1];
  if (running === null || slide === undefined) {
    dispatch({ kind: "trouble", message: running === null ? NOT_CONNECTED : `option ${String(index)} is no longer available` });
    return;
  }
  const replied = await running.threads.resolve({ fileId: slide.fileId, commentId, text: "Resolved." });
  if (replied.kind !== "ok") {
    dispatch({ kind: "trouble", message: replied.message });
    return;
  }
  await reloadCandidateComments();
}

/** Re-read the threads so the rail shows what Drive now holds, not what it held a moment ago. */
async function reloadCandidateComments(): Promise<void> {
  dispatch({ kind: "comments-requested" });
  await loadCandidateComments();
}

async function sendAnomaly({ index, anomalyId }: { index: number; anomalyId: string }): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (offer === null) return;
  if (running === null) {
    dispatch({ kind: "anomaly-send-failed", index, anomalyId, message: NOT_CONNECTED });
    return;
  }
  const anomaly = anomalyIn({ offer, index, anomalyId });
  const slide = offer.proposal.slides[index - 1];
  if (anomaly === null || slide === undefined) {
    dispatch({ kind: "anomaly-send-failed", index, anomalyId, message: `option ${index} is no longer available` });
    return;
  }
  // `pageObjectId: null` because the FILE identifies the slide -- the comment is on `NN.html`
  // itself, so there is no deck page to name. The region still travels, in the sentinel.
  const note: ReviewNote = { noteId: anomalyId, pageObjectId: null, region: anomaly.region, text: anomaly.note };
  const built = feedbackCommentsFor({ notes: [note], createdAt: new Date().toISOString() });
  if (built.contents.length === 0) {
    dispatch({ kind: "anomaly-send-failed", index, anomalyId, message: refusalOf(built.refused) });
    return;
  }
  dispatch({ kind: "anomaly-send-started", index, anomalyId });
  const replied = await running.feedback.send({
    fileId: slide.fileId,
    comments: built.contents.map((content) => ({ content })),
  });
  if (replied.kind !== "ok") {
    dispatch({ kind: "anomaly-send-failed", index, anomalyId, message: replied.message });
    return;
  }
  const outcome = sendOutcomeOf({ results: replied.value.results, requested: built.contents.length });
  switch (outcome.kind) {
    case "failed":
      dispatch({ kind: "anomaly-send-failed", index, anomalyId, message: outcome.message });
      return;
    case "sent": {
      const commentId = replied.value.results[0]?.commentId ?? anomalyId;
      dispatch({ kind: "anomaly-send-succeeded", index, anomalyId, commentId });
      await appendEvent({
        folderId: offer.proposal.folderId,
        body: {
          kind: "comment-opened",
          commentId,
          slideIndex: index,
          text: anomaly.note,
          region: anomaly.region,
        },
      });
      dispatch({ kind: "comments-requested" });
      void loadCandidateComments();
      return;
    }
    default:
      return assertNever(outcome);
  }
}

/**
 * One event file, CREATED. Best effort by contract: every caller has already done the thing the
 * event records, so a failed write is a gap in the log and never a failed action. It is warned
 * about rather than swallowed, because a log with a hole in it is exactly what PROTOCOL.md's
 * "never silently" rule is about.
 */
async function appendEvent({ folderId, body }: { folderId: string; body: SessionEventBody }): Promise<void> {
  const running = services;
  if (running === null) return;
  const at = new Date();
  const name = sessionEventFileName({ atMillis: at.getTime(), suffix: freshSuffix(), kind: eventKindOf(body) });
  const serialized = serializeSessionEvent({ body, at: at.toISOString() });
  if (name.kind !== "ok" || serialized.kind !== "ok") {
    console.warn(`[sasha-slides] could not write a ${body.kind} event: ${describeRefusal({ name, serialized })}`);
    return;
  }
  const written = await running.log.appendEvent({
    folderId,
    name: name.value,
    mimeType: EVENT_MIME_TYPE,
    body: serialized.value,
  });
  if (written.kind !== "ok") console.warn(`[sasha-slides] could not write ${name.value}: ${written.message}`);
}

/**
 * Ask the HOST for the DEFECT-REPORT window, on this candidate. The target is recorded server-side
 * before the window appears, because the documents share nothing and there is no handle to pass.
 * `opened` is read back rather than assumed, so a host that declined becomes a line on screen.
 */
async function openReportWindow({ index }: { index: number }): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (running === null || offer === null) {
    dispatch({ kind: "report-failed", message: NOT_CONNECTED });
    return;
  }
  dispatch({ kind: "report-requested" });
  // The window is opened FIRST and synchronously, before any await: see `reportWindow`.
  const opened = reportWindow.open();
  const replied = await running.window.openDefectReport({
    proposalId: offer.proposal.proposalId,
    slideIndex: index,
    // With a real second window there is nothing to show in the dialog -- and showing it would
    // evict the Candidate slides the user is reporting on, which is the whole defect.
    showDialog: !opened,
  });
  if (replied.kind !== "ok") {
    dispatch({ kind: "report-failed", message: replied.message });
    return;
  }
  dispatch({ kind: "report-succeeded" });
}

/** The shared opener. `services` is read lazily because it is null until the host connects. */
const reportWindow = createReportWindow({ api: () => services?.window ?? null, opener: window });

const actions: PickerActions = {
  selectSlide(index) {
    dispatch({ kind: "slide-selected", index });
  },
  chooseView(view) {
    dispatch({ kind: "view-chosen", view });
  },
  chooseTool(tool) {
    dispatch({ kind: "tool-chosen", tool });
  },
  chooseRendering(rendering) {
    dispatch({ kind: "rendering-chosen", rendering });
  },
  toggleFindings() {
    dispatch({ kind: "findings-toggled" });
  },
  drawAnomaly({ index, region }) {
    dispatch({ kind: "anomaly-drawn", index, anomalyId: `user_${index}_${Date.now().toString(36)}`, region });
  },
  /*
   * POINT, SAY IT, SENT -- one act, so one action.
   *
   * The pieces already existed as three (`drawAnomaly`, `noteAnomaly`, `sendAnomaly`) because
   * the old flow really was three steps: draw a rectangle, find its row, press Send. Clicking an
   * element and typing into the composer that opens on it is ONE step, and splitting it across
   * three dispatches would leave half-made anomalies in the tree whenever the user hit Escape.
   */
  commentOnSelection({ index, region, note }) {
    const anomalyId = `user_${index}_${Date.now().toString(36)}`;
    dispatch({ kind: "anomaly-drawn", index, anomalyId, region });
    dispatch({ kind: "anomaly-noted", index, anomalyId, note });
    dispatch({ kind: "selection-changed", selection: null });
    void sendAnomaly({ index, anomalyId });
  },
  clearSelection() {
    dispatch({ kind: "selection-changed", selection: null });
  },
  noteAnomaly({ index, anomalyId, note }) {
    dispatch({ kind: "anomaly-noted", index, anomalyId, note });
  },
  removeAnomaly({ index, anomalyId }) {
    dispatch({ kind: "anomaly-removed", index, anomalyId });
  },
  sendAnomaly({ index, anomalyId }) {
    void sendAnomaly({ index, anomalyId });
  },
  zoomCandidate(index) {
    dispatch({ kind: "candidate-zoomed", index });
  },
  openEditor(index) {
    dispatch({ kind: "editor-opened", index });
  },
  closeEditor() {
    dispatch({ kind: "editor-closed" });
  },
  applyMarkup({ index, html }) {
    // The editor writes into the live document, which `editor.html()` serializes -- so the
    // change travels with the candidate even though it is not one of the five described edits.
    const applied = editorRef?.replaceSelected({ html }) ?? false;
    if (!applied) dispatch({ kind: "trouble", message: "that markup could not be applied to the selected element" });
    else dispatch({ kind: "edits-changed", index, edits: editorRef?.edits() ?? [] });
  },
  replyToThread({ index, commentId, text }) {
    void replyToThread({ index, commentId, text });
  },
  resolveThread({ index, commentId }) {
    void resolveThread({ index, commentId });
  },
  changeEdits({ index, edits }) {
    dispatch({ kind: "edits-changed", index, edits });
  },
  insertPicked(index) {
    void submit({ picked: index });
  },
  dismiss() {
    void submit({ picked: null });
  },
  openReport({ index }) {
    void openReportWindow({ index });
  },
  /**
   * THE VISUAL EDITOR, chosen here and nowhere else -- the composition root is the only place that
   * may know which implementation the slot got. It serializes the live document rather than a
   * string handed in, so it needs no `html` (editor/index.ts).
   */
  createEditor({ mode }) {
    // The inspector under the slide shows whatever is selected, so the editor reports it here.
    // The instance is kept because `applyMarkup` has to reach the SAME editor the user selected in.
    editorRef = createSlideEditor({
      mode,
      onSelect: (selection) => dispatch({ kind: "selection-changed", selection }),
      /*
       * A REFUSED ATTACH MUST NOT BE SILENT. `slide-editor.ts` `attach` gives a reason when it
       * cannot reach into the candidate's document, but the default sink is `console.warn` -- so
       * to a user the editor simply did nothing when they clicked, which is indistinguishable
       * from a dead pointer handler. Keep them where both a person and the browser smoke test
       * can read them.
       */
      onWarning: (message) => {
        editorWarnings.push(message);
        console.warn(`[sasha-slides editor] ${message}`);
      },
    });
    return editorRef;
  },

};

/**
 * THE CANDIDATES AS GOOGLE DRAWS THEM, for the converted rendering.
 *
 * The server does the whole set in one throwaway deck and deletes it again, so this is one round
 * trip however many candidates there are. Each picture is reported on its own index, and a
 * candidate Google refused comes back as a REASON rather than silently missing -- the stage then
 * falls back to the geometry projection with that reason printed on it (slide-stage.tsx).
 */
async function renderPreviews({ slides: asked }: { slides: readonly SlideFrame[] }): Promise<void> {
  const running = services;
  if (running === null) return;
  rendering = true;
  let slides: readonly SlideFrame[] = asked;
  /*
   * ANYTHING ALREADY DRAWN IS ANSWERED FROM THE BROWSER, not from Google.
   *
   * A rendered preview costs a throwaway deck, a batchUpdate, a thumbnail fetch and a delete --
   * per candidate, every time this window opens. The picture cannot change while the requests
   * do not, so the cache is keyed by the requests themselves (render-cache.ts) and a revision
   * misses it without anything having to invalidate.
   */
  const wanted: SlideFrame[] = [];
  for (const frame of slides) {
    const requests = frame.conversion.kind === "converted" ? frame.conversion.requests : [];
    const remembered = cachedRender(renderKeyOf(requests));
    if (remembered === null) {
      wanted.push(frame);
      continue;
    }
    dispatch({ kind: "rendered", index: frame.index, dataUri: remembered });
  }
  if (wanted.length === 0) {
    rendering = false;
    return;
  }
  slides = wanted;
  const indices = slides.map((frame) => frame.index);
  dispatch({ kind: "render-requested", indices });
  try {
    const replied = await running.slides.renderPreviews({
      slides: slides.map((frame) => ({
        index: frame.index,
        requests: frame.conversion.kind === "converted" ? frame.conversion.requests : [],
      })),
    });
    if (replied.kind !== "ok") {
      for (const index of indices) dispatch({ kind: "render-failed", index, message: replied.message });
      return;
    }
    const answered = new Set<number>();
    for (const preview of replied.value.previews) {
      answered.add(preview.index);
      if (preview.dataUri === null) {
        dispatch({ kind: "render-failed", index: preview.index, message: preview.message ?? "no picture came back" });
        continue;
      }
      dispatch({ kind: "rendered", index: preview.index, dataUri: preview.dataUri });
      // Remembered under the requests that drew it, so the next open is instant.
      const drawn = slides.find((frame) => frame.index === preview.index);
      const requests = drawn?.conversion.kind === "converted" ? drawn.conversion.requests : [];
      rememberRender(renderKeyOf(requests), preview.dataUri);
    }
    // A CANDIDATE THE REPLY FORGOT must not sit on "rendering..." for ever.
    for (const index of indices) {
      if (!answered.has(index)) {
        dispatch({ kind: "render-failed", index, message: "the renderer did not answer for this candidate" });
      }
    }
  } finally {
    rendering = false;
  }
}

/**
 * Convert -> insert -> write PICK -> append `slide-inserted`, in that order, because PROTOCOL.md
 * wants the render artifact in place before the server is told the decision, and the log entry
 * records something that has already happened. A dismissal skips straight to PICK with
 * `picked: null`, which is what the server is blocked on.
 */
async function submit({ picked }: { picked: number | null }): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (running === null || offer === null) return;
  const proposal = offer.proposal;
  dispatch({ kind: "submit-started", picked, stage: picked === null ? "writing-pick" : "converting" });

  const insertedObjectIds = picked === null ? [] : await insertPicked({ running, picked });
  if (insertedObjectIds === null) return;

  dispatch({ kind: "submit-stage", stage: "writing-pick" });
  const decided = offerOf(state);
  const written = await writePick({
    pick: running.pick,
    proposal,
    decision: {
      picked,
      insertedObjectIds,
      anomalies: decided === null ? [] : anomaliesOf(decided),
    },
    decidedAt: new Date().toISOString(),
  });
  switch (written.kind) {
    case "written":
      running.observer.dispatch({ kind: "resolved", proposalId: proposal.proposalId, nowMs: Date.now() });
      dispatch({ kind: "settled", proposalId: proposal.proposalId, picked });
      // The log entry LAST and best effort: the slide is in the deck and PICK is written, so a
      // failed event write must not be reported as a failed insert.
      if (picked !== null) {
        await appendEvent({
          folderId: proposal.folderId,
          body: { kind: "slide-inserted", slideIndex: picked, pageObjectId: insertedObjectIds[0] ?? null },
        });
      }
      return;
    case "refused":
      dispatch({ kind: "submit-failed", message: written.reason });
      return;
    case "failed":
      dispatch({ kind: "submit-failed", message: written.message });
      return;
    default:
      return assertNever(written);
  }
}

/** The object ids Slides created, or null when the insert failed (the reducer has been told). */
async function insertPicked({
  running,
  picked,
}: {
  running: Services;
  picked: number;
}): Promise<readonly string[] | null> {
  const offer = offerOf(state);
  const frame = offer?.slides[picked - 1];
  if (offer === null || frame === undefined) {
    dispatch({ kind: "submit-failed", message: `option ${picked} is no longer available` });
    return null;
  }
  const presentationId = offer.presentationId;
  if (presentationId === null) {
    dispatch({ kind: "submit-failed", message: "this window has no presentation to insert into" });
    return null;
  }
  if (frame.html.kind !== "loaded") {
    dispatch({ kind: "submit-failed", message: `option ${picked}'s HTML has not loaded yet` });
    return null;
  }
  // Converted again here rather than reused: the page id has to be the one actually created, and
  // the cached conversion was made against a preview id.
  const pageObjectId = newPageObjectId({ random: Math.random });
  let converted;
  try {
    converted = await running.convert({
      html: frame.html.html,
      presentationId,
      pageObjectId,
      objectIdPrefix: pageObjectId,
    });
  } catch (cause) {
    dispatch({ kind: "submit-failed", message: cause instanceof Error ? cause.message : String(cause) });
    return null;
  }

  dispatch({ kind: "submit-stage", stage: "inserting" });
  const render: RenderRequest | null = renderRequestFor({
    proposalId: offer.proposal.proposalId,
    folderId: offer.proposal.folderId,
    index: picked,
    pageObjectId,
  });
  const inserted = await running.slides.insert({
    presentationId,
    requests: insertRequests({ pageObjectId, converted: converted.requests }),
    render,
  });
  if (inserted.kind !== "ok") {
    dispatch({ kind: "submit-failed", message: inserted.message });
    return null;
  }
  // From here on the slide IS in the user's deck, so nothing below may be reported as a failure --
  // the user must not be invited to insert it twice. See render-artifact.ts.
  const artifact = renderArtifactOf({ renderArtifact: inserted.value.renderArtifact, requested: render });
  if (artifact.kind === "skipped") {
    console.warn(`[sasha-slides] no render artifact for option ${picked}: ${artifact.reason}`);
  }
  return createdObjectIdsOf(inserted.value.batchResponse);
}

/** Why nothing was sent, when the mark-up was refused. The reasons come from `feedbackCommentsFor`. */
function refusalOf(refused: readonly Readonly<{ noteId: string; reason: string }>[]): string {
  const first = refused[0];
  return first === undefined ? "there is nothing to send yet" : `nothing was sent: ${first.reason}`;
}

/** Which of the two writable kinds a body is. A switch, so a third one has to be named here. */
function eventKindOf(body: SessionEventBody): "comment-opened" | "slide-inserted" {
  switch (body.kind) {
    case "comment-opened":
      return "comment-opened";
    case "slide-inserted":
      return "slide-inserted";
    case "slides-staged":
    case "comment-answered":
    case "slide-revised":
    case "comment-resolved":
    case "slides-cleared":
    case "feedback-delivered":
    case "opaque":
      // `serializeSessionEvent` refuses these, so the name is never used -- but it has to be a
      // legal kind for the filename grammar, and the refusal is what reaches the log.
      return "comment-opened";
    default:
      return assertNever(body);
  }
}

/** Both refusals in one line, so the warning says which half of the write was impossible. */
function describeRefusal({ name, serialized }: { name: Parsed<string>; serialized: Parsed<string> }): string {
  const reasons = [name, serialized].flatMap((parsed) => (parsed.kind === "ok" ? [] : [reasonOf(parsed)]));
  return reasons.length === 0 ? "both halves were fine, which cannot happen here" : reasons.join("; ");
}

/** Why one half was refused. The two failing arms of `Parsed`, through an exhaustive switch. */
function reasonOf(parsed: Parsed<string>): string {
  switch (parsed.kind) {
    case "ok":
      return "";
    case "invalid":
      return parsed.reason;
    case "unsupported-version":
      return `it declares protocolVersion ${parsed.protocolVersion}`;
    default:
      return assertNever(parsed);
  }
}

/**
 * The event name's six-base36 tie-break, from the browser's CSPRNG. It exists because two events
 * in the same millisecond would otherwise share a name, and a name collision in Drive is a lost
 * event -- the exact failure one-file-per-event is designed to prevent.
 */
function freshSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
}

/** One pending poll at a time; scheduling again replaces it, which is what a cadence change needs. */
function singlePollTimer(): PollTimer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule({ delayMs, fire }) {
      if (handle !== null) clearTimeout(handle);
      handle = setTimeout(() => {
        handle = null;
        fire();
      }, delayMs);
    },
    cancel() {
      if (handle === null) return;
      clearTimeout(handle);
      handle = null;
    },
  };
}

/** Unique per candidate within the presentation, which is what the converter's allocator needs. */
function previewPrefix({ proposalId, index }: { proposalId: string; index: number }): string {
  return `${proposalId.replace(/[^A-Za-z0-9_-]/g, "")}_${index}`;
}

function render(): void {
  if (root === null) {
    const existing = document.getElementById(ROOT_ELEMENT_ID);
    const host = existing ?? document.createElement("div");
    host.id = ROOT_ELEMENT_ID;
    if (existing === null) document.body.append(host);
    root = createRoot(host);
  }
  root.render(createElement(Picker, { state, actions }));
}

/**
 * The staging container for the converter's iframe. Kept out of the React tree on purpose: React
 * owns `#sasha-slides-root` and must never re-parent an iframe the converter is measuring.
 */
function stageElement(): HTMLElement {
  const existing = document.getElementById(STAGE_ELEMENT_ID);
  if (existing !== null) return existing;
  const stage = document.createElement("div");
  stage.id = STAGE_ELEMENT_ID;
  /*
   * IT HAS TO BE A REAL SIZE, not 0x0 with overflow hidden.
   *
   * The staged iframe is 1280x720, but a 0x0 `overflow:hidden` parent CLIPS IT AWAY ENTIRELY, and
   * a browser does not paint -- or service `requestAnimationFrame` for -- a frame with no
   * rendered area. The converter waits one frame after layout settles, so a frame that never
   * paints used to hang the conversion outright (fixed in convert-html-to-slide-requests.ts) and
   * now costs the whole frame budget on every candidate instead. Giving the stage the slide's own
   * size lets the normal path run at normal speed. It stays off-screen and inert.
   */
  stage.style.cssText =
    "position:fixed;left:-99999px;top:0;width:1280px;height:720px;overflow:hidden;pointer-events:none";
  document.body.append(stage);
  return stage;
}

/**
 * The extractor blob, decoded. It travels base64 so HtmlService's sanitiser cannot mangle it (see
 * build-addon.ts); `atob` yields LATIN-1 bytes, so it is decoded through TextDecoder rather than
 * used directly -- extract-dom.ts is not guaranteed to be pure ASCII.
 */
function extractorSource(): string {
  const binary = atob(__SASHA_EXTRACTOR_JS_B64__);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * THE ENTRY POINT, and it is LAST on purpose. `main` renders immediately, and `render` passes the
 * module-level `actions` object down; a `void main()` placed above that declaration therefore hands
 * React `undefined` for one render, which is a `TypeError` on first paint the moment any panel
 * reads an action off it. Everything a module-level initialiser needs is declared above.
 */
void main();
