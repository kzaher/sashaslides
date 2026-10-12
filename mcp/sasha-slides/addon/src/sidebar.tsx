// THE CONVERSATION'S COMPOSITION ROOT, and the one surface the Slides menu opens: Ask Sasha.
//
// WHAT IT USED TO BE. This file was the picker: the Drive observer, the HTML fetches, the
// converter, the insert, `PICK` -- all of it crammed into a 300 px column. Those moved to
// `dialog.tsx`, where the window can be 1000 px wide. What stayed is the spine: the running
// session, as a serialized event log, in the one surface that is always there.
//
// THE SURFACES SHARE NOTHING. Separate HtmlService documents, separate frames, separate origins --
// no state, no storage, no `postMessage`, no window handle (UI-CONTRACT.md). Everything this file
// needs from another surface comes through the SERVER:
//
//   * "what is staged" -- `sashaScanInbox`, the same name walk the slides window uses.
//   * "the log" -- `sashaReadEvents` over the followed proposal's `events/` folder.
//   * "the unresolved counts" -- `sashaCandidateComments` over the candidates' own `NN.html`,
//     which is the SAME read the grid does, joined by the same `candidateCommentsFrom`.
//   * "show the slides" / "show the defect report" -- `sashaOpenPicker` /
//     `sashaOpenDefectReport`, because `showModelessDialog` is a server-side `SlidesApp.getUi()`
//     call and no amount of client JavaScript in this document can do it.
//
// THE DIALOG OPENS BY ITSELF WHEN SLIDES ARRIVE, and that decision is `proposalToAutoOpen`'s --
// state, not a side effect buried in a fetch handler -- so it happens once per proposal and a user
// who closes the window is not dragged back into it on the next poll.
//
// Shape, as everywhere else in this repo: one state tree, a pure reducer, and feedback loops that
// are functions OF the state. React is a passive subscriber.

import { createReportWindow } from "./report-window.ts";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import {
  appsScriptCall,
  appsScriptCandidateCommentsApi,
  appsScriptBatchReadApi,
  appsScriptDriveApi,
  appsScriptFeedbackApi,
  appsScriptPickerWindowApi,
  appsScriptSessionLogApi,
  helloFromServer,
} from "./bridge-client.ts";
import { presentationIdOf } from "./bridge.ts";
import { ConversationPanel, type ConversationActions } from "./Conversation.tsx";
import { storedSetupChoiceStore, type SetupEnvironment } from "./setup-guide.tsx";
import {
  INITIAL_CONVERSATION,
  followedSet,
  needsComments,
  needsLog,
  needsManifest,
  needsStaged,
  needsThread,
  nextRevisedSlideToLoad,
  outgoingMessage,
  outgoingReply,
  proposalToAutoOpen,
  reduceConversation,
  slidesOf,
  type Conversation,
  type ConversationEvent,
  type ConversationThread,
  type ThreadActionKind,
} from "./conversation-state.ts";
import type {
  BatchReadApi,
  CandidateCommentsApi,
  DriveApi,
  FeedbackApi,
  PickerWindowApi,
  SessionLogApi,
} from "./drive-api.ts";
import { feedbackCommentsFor, feedbackThreadsOf, sendOutcomeOf } from "./feedback.ts";
import {
  candidateCommentsFrom,
  serializeSessionEvent,
  sessionEventFileName,
  sessionEventsOf,
} from "./session-log.ts";
import { archiveEventBodyOf } from "./candidate-archive.ts";
import { PROTOCOL_VERSION, assertNever, parseManifest, parseReadyMarker } from "./protocol.ts";
import {
  NO_PREVIEWS,
  previewsSettled,
  previewsToLoad,
  reducePreviews,
  type PreviewEvent,
  type PreviewRequest,
  type SlidePreviews,
} from "./slide-previews.ts";
import { pickerSeedOf } from "./picker-seed.ts";

const ROOT_ELEMENT_ID = "sasha-slides-root";
/** One read of the deck's comment pane. A deck with more threads than this is not the common case. */
const THREAD_PAGE_SIZE = 100;
/** One scan of the inbox. The same page size the observer uses. */
const SCAN_PAGE_SIZE = 100;
/** One read of a proposal's `events/` folder. A session with more events than this is not one. */
const EVENT_PAGE_SIZE = 500;
/** What an event file is uploaded as. The same type the slides window writes. */
const EVENT_MIME_TYPE = "application/json";
/** One read of a candidate's comment threads. */
const CANDIDATE_COMMENT_PAGE_SIZE = 100;
/**
 * How often everything is re-read while the conversation is on screen, and while it is not. A
 * sidebar the user has switched away from drops to the slow cadence -- they are not reading an
 * answer they cannot see.
 */
const VISIBLE_POLL_MS = 8_000;
const HIDDEN_POLL_MS = 60_000;
/**
 * HOW OFTEN THE ELAPSED TIMES REDRAW -- a separate, much faster cadence than the Drive polls, and
 * deliberately so. A wait that only moved every 8 s read as frozen, which is the complaint this
 * clock answers; and a tick is pure state (`clock-ticked` touches nothing but `nowMs`), so it costs
 * a re-render and never a round trip to Google. It stops while the sidebar is hidden, because
 * nobody is reading a second hand they cannot see.
 */
const CLOCK_TICK_MS = 1_000;

/**
 * `services` is null until `sashaHello` has answered, and every path below therefore has to treat
 * "not connected" as a REPORTABLE outcome. Returning silently is what made a failed hello look
 * like a hang: the panel set its loading flags, called these functions, and got nothing back -- so
 * it sat on "loading..." for ever, giving no reason. A dead connection has to say so.
 */
const NOT_CONNECTED =
  "the add-on is not connected to Google Slides. Reload the presentation and reopen Ask Sasha.";

let state: Conversation = INITIAL_CONVERSATION;
/**
 * WHAT THE NOTHING-LISTENING PANEL NEEDS TO SAY HOW TO CONNECT: two constants build-addon.ts bakes
 * in, and this viewer's remembered tab. `window.localStorage` is read lazily inside the store's
 * try, because the HtmlService sandbox may throw on the mere read.
 */
const SETUP: SetupEnvironment = {
  repoRoot: __SASHA_REPO_ROOT__,
  connectorUrl: __SASHA_CONNECTOR_URL__,
  store: storedSetupChoiceStore(() => window.localStorage),
};
/**
 * THE THUMBNAILS' BYTES, beside the conversation rather than in it (slide-previews.ts). Module-level
 * for the life of the sidebar, so a poll re-render never re-downloads a picture; keyed by file AND
 * revision, so a revision is a miss without anything having to invalidate it.
 */
let previews: SlidePreviews = NO_PREVIEWS;
let root: Root | null = null;
let services: Services | null = null;
/** The scan started before `sashaHello` answered, consumed once by the first `loadStaged`. */
let earlyScan: ReturnType<DriveApi["scanInbox"]> | null = null;
/**
 * Each proposal's `manifest.json` id, as the scan named it (build-addon.ts `sashaScanInboxRest_`),
 * so `loadManifest` can read READY and the manifest in ONE round trip instead of two in series.
 */
const manifestFileIds = new Map<string, string>();

/** The shared opener. `services` is read lazily because it is null until the host connects. */
const reportWindow = createReportWindow({ api: () => services?.window ?? null, opener: window });
let messageSerial = 0;
let pollHandle: ReturnType<typeof setTimeout> | null = null;
let clockHandle: ReturnType<typeof setInterval> | null = null;

type Services = Readonly<{
  drive: DriveApi;
  batch: BatchReadApi;
  log: SessionLogApi;
  candidateComments: CandidateCommentsApi;
  feedback: FeedbackApi;
  window: PickerWindowApi;
  presentationId: string | null;
}>;

async function main(): Promise<void> {
  render();
  const call = appsScriptCall({ run: google.script.run });
  // THE INBOX SCAN STARTS NOW, IN PARALLEL with `sashaHello`: it needs nothing the hello answers,
  // and waiting for it put two round trips in series (measured live 2026-10-11: 0.86 s + 2.55 s).
  // The first `loadStaged` consumes it instead of asking again.
  const drive = appsScriptDriveApi({ call });
  earlyScan = drive.scanInbox({ pageSize: SCAN_PAGE_SIZE });

  // `sashaHello` first, because the sidebar cannot know its own deck: it is served from
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
      message: `the add-on speaks protocolVersion ${hello.value.protocolVersion}, this conversation ${PROTOCOL_VERSION}`,
    });
    return;
  }

  const presentationId = presentationIdOf(hello.value.presentationUrl);
  services = {
    drive,
    batch: appsScriptBatchReadApi({ call }),
    log: appsScriptSessionLogApi({ call }),
    candidateComments: appsScriptCandidateCommentsApi({ call }),
    feedback: appsScriptFeedbackApi({ call }),
    window: appsScriptPickerWindowApi({ call }),
    presentationId,
  };
  dispatch({ kind: "connected", presentationId });

  // Learned once, here, so pressing "Report a defect" can open the window synchronously inside
  // the click -- the only way a browser lets a popup through.
  void reportWindow.learn();

  // Visibility changes both cadences, so both timers are re-armed rather than left on the slow one.
  document.addEventListener("visibilitychange", () => {
    schedulePoll();
    scheduleClock();
  });
  schedulePoll();
  scheduleClock();
}

/**
 * THE CLOCK. One interval, replaced rather than stacked, and it fires once immediately so the first
 * paint already has a time: `Conversation.nowMs` starts null, and a surface with no clock says
 * "just now" rather than computing a wait from the epoch.
 */
function scheduleClock(): void {
  if (clockHandle !== null) clearInterval(clockHandle);
  dispatch({ kind: "clock-ticked", nowMs: Date.now() });
  // Hidden means nobody is reading the second hand; the elapsed time is recomputed from `Date.now()`
  // on the next tick either way, so pausing it cannot make a wait look shorter than it was.
  if (document.visibilityState !== "visible") {
    clockHandle = null;
    return;
  }
  clockHandle = setInterval(() => dispatch({ kind: "clock-ticked", nowMs: Date.now() }), CLOCK_TICK_MS);
}

/** The thumbnails' own loop: same shape as `dispatch`, a separate store. */
function dispatchPreview(event: PreviewEvent): void {
  previews = reducePreviews(previews, event);
  render();
  pump();
}

function dispatch(event: ConversationEvent): void {
  const next = reduceConversation(state, event);
  if (next === state) return;
  state = next;
  render();
  pump();
}

/**
 * The feedback loops, as functions of the state. Idempotent, because `dispatch` runs them after
 * every change; each is gated on a PREDICATE over its load union rather than on a bare
 * `kind === "unrequested"`, so a new load variant has to say whether it wants a fetch.
 *
 * The state is re-read between loops, never captured once: `dispatch` renders AND runs `pump`
 * again before returning, so a captured `Conversation` would be one event out of date and start
 * the same fetch twice.
 */
function pump(): void {
  if (needsThread(state)) {
    dispatch({ kind: "thread-requested" });
    void loadThread();
  }
  if (needsStaged(state)) {
    dispatch({ kind: "staged-requested" });
    void loadStaged();
  }
  if (needsManifest(state)) {
    dispatch({ kind: "manifest-requested" });
    void loadManifest();
  }
  if (needsLog(state)) {
    dispatch({ kind: "log-requested" });
    void loadLog();
  }
  if (needsComments(state)) {
    dispatch({ kind: "comments-requested" });
    void loadComments();
  }
  const revised = nextRevisedSlideToLoad(state);
  if (revised !== null) {
    dispatch({ kind: "slide-requested", slideIndex: revised.slideIndex });
    void loadRevisedSlide({ slideIndex: revised.slideIndex, fileId: revised.fileId });
  }
  // LAST, and as ONE batch (previewsToLoad): one round trip for every thumbnail, after the reads
  // the user is waiting on have been asked for.
  const toPreview = previewsToLoad({ conversation: state, previews });
  if (toPreview.length > 0) {
    for (const request of toPreview) dispatchPreview({ kind: "preview-requested", key: request.key });
    void loadPreviews(toPreview);
  }
  // THE AUTO-OPEN WAITS FOR THE THUMBNAILS (one batch, ~1 s), so the window is seeded with every
  // candidate's HTML (picker-seed.ts) and downloads none of it itself. Opening first made it fetch
  // all eight again in parallel with this batch (measured live 2026-10-11).
  const autoOpen = previewsSettled({ conversation: state, previews }) ? proposalToAutoOpen(state) : null;
  if (autoOpen !== null) {
    // Recorded FIRST, so a refusal cannot make the next poll try again for ever. The contract is
    // "it opens by itself when slides arrive", once -- not "it keeps trying".
    dispatch({ kind: "auto-opened", proposalId: autoOpen });
    void showSlides();
  }
}

/** The deck's comment threads, filtered down to our own by `feedbackThreadsOf`. */
async function loadThread(): Promise<void> {
  const running = services;
  if (running === null) {
    dispatch({ kind: "thread-failed", message: NOT_CONNECTED });
    return;
  }
  const fileId = running.presentationId;
  if (fileId === null) {
    dispatch({ kind: "thread-failed", message: "this conversation has no presentation to read comments from" });
    return;
  }
  const replied = await running.feedback.read({ fileId, pageSize: THREAD_PAGE_SIZE });
  if (replied.kind !== "ok") {
    dispatch({ kind: "thread-failed", message: replied.message });
    return;
  }
  const walked = feedbackThreadsOf({ records: replied.value.comments });
  for (const trouble of walked.unreadable) console.warn(`[sasha-slides] ${trouble}`);
  dispatch({ kind: "thread-arrived", threads: walked.threads, readAt: new Date().toISOString() });
}

/** The inbox name walk, reduced to "what is staged and unanswered". */
async function loadStaged(): Promise<void> {
  const running = services;
  if (running === null) {
    dispatch({ kind: "staged-failed", message: NOT_CONNECTED });
    return;
  }
  const pending = earlyScan;
  earlyScan = null;
  const replied = await (pending ?? running.drive.scanInbox({ pageSize: SCAN_PAGE_SIZE }));
  if (replied.kind !== "ok") {
    dispatch({ kind: "staged-failed", message: replied.message });
    return;
  }
  for (const mark of replied.value) {
    if (mark.manifestFileId !== undefined) manifestFileIds.set(mark.proposalId, mark.manifestFileId);
  }
  dispatch({ kind: "staged-arrived", marks: replied.value, readAt: new Date().toISOString() });
}

/**
 * The followed proposal's manifest -- READY first, because READY is what names the manifest file.
 *
 * READY's PRESENCE, though, is trusted for nothing after the first staging: `clear_slides` leaves
 * the marker in place while `count` drops to 0, so the manifest's own `count` and `revision` are
 * what say whether there are candidates (PROTOCOL.md). `slidesReachability` is where that is read.
 *
 * It is read HERE as well as in the slides window because the conversation genuinely needs it: the
 * candidates' file ids are what the comment read is addressed by, and the inline revised slide is
 * fetched by the same id.
 */
async function loadManifest(): Promise<void> {
  const running = services;
  const followed = followedSet(state);
  if (followed === null) return;
  if (running === null) {
    dispatch({ kind: "manifest-failed", message: NOT_CONNECTED });
    return;
  }
  // BOTH IN ONE ROUND TRIP when the scan named the manifest. READY still decides: if it names a
  // different manifest than the one read alongside it, that one is read instead.
  const knownManifest = manifestFileIds.get(followed.proposalId);
  const together =
    knownManifest === undefined ? null : await running.batch.downloadTexts([followed.readyFileId, knownManifest]);
  const readyText =
    together?.kind === "ok"
      ? together.value.get(followed.readyFileId) ?? { kind: "failed" as const, message: "READY missing from the batch" }
      : await running.drive.downloadText(followed.readyFileId);
  if (readyText.kind !== "ok") {
    dispatch({ kind: "manifest-failed", message: readyText.message });
    return;
  }
  const ready = parseReadyMarker(readyText.value);
  if (ready.kind !== "ok") {
    dispatch({ kind: "manifest-failed", message: describeParsed({ parsed: ready, what: "READY" }) });
    return;
  }
  const readAlongside = together?.kind === "ok" ? together.value.get(ready.value.manifestFileId) : undefined;
  const manifestText = readAlongside ?? (await running.drive.downloadText(ready.value.manifestFileId));
  if (manifestText.kind !== "ok") {
    dispatch({ kind: "manifest-failed", message: manifestText.message });
    return;
  }
  const manifest = parseManifest(manifestText.value);
  if (manifest.kind !== "ok") {
    dispatch({ kind: "manifest-failed", message: describeParsed({ parsed: manifest, what: "manifest.json" }) });
    return;
  }
  dispatch({ kind: "manifest-arrived", manifest: manifest.value });
}

/**
 * THE LOG. One Drive call for the whole `events/` folder, then `sessionEventsOf` orders and parses
 * it -- including the files it cannot read, which become opaque entries rather than absences.
 */
async function loadLog(): Promise<void> {
  const running = services;
  const followed = followedSet(state);
  if (followed === null) return;
  if (running === null) {
    dispatch({ kind: "log-failed", message: NOT_CONNECTED });
    return;
  }
  const replied = await running.log.readEvents({ folderId: followed.folderId, pageSize: EVENT_PAGE_SIZE });
  if (replied.kind !== "ok") {
    dispatch({ kind: "log-failed", message: replied.message });
    return;
  }
  const events = sessionEventsOf({
    files: replied.value.events.map((file) => ({
      proposalId: followed.proposalId,
      fileId: file.fileId,
      name: file.name,
      text: file.text,
    })),
  });
  dispatch({ kind: "log-arrived", events, readAt: new Date().toISOString() });
}

/**
 * THE UNRESOLVED COUNTS. The same read the grid does -- comments on the candidates' own `NN.html`
 * -- joined back to the slides by the same `candidateCommentsFrom`, which is why the two views
 * cannot disagree about anything but how stale their own poll is.
 */
async function loadComments(): Promise<void> {
  const running = services;
  const followed = followedSet(state);
  const slides = slidesOf(state);
  if (followed === null || slides.length === 0) return;
  if (running === null) {
    dispatch({ kind: "comments-failed", message: NOT_CONNECTED });
    return;
  }
  const replied = await running.candidateComments.read({
    fileIds: slides.map((slide) => slide.fileId),
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
        proposalId: followed.proposalId,
        slides: slides.map((slide) => ({ slideIndex: slide.slideIndex, fileId: slide.fileId })),
        entries: replied.value.files,
      }),
    },
  });
}

/** One revised candidate's current HTML, so the log can render it inline where it happened. */
async function loadRevisedSlide({ slideIndex, fileId }: { slideIndex: number; fileId: string }): Promise<void> {
  const running = services;
  if (running === null) {
    dispatch({ kind: "slide-failed", slideIndex, message: NOT_CONNECTED });
    return;
  }
  const downloaded = await running.drive.downloadText(fileId);
  if (downloaded.kind !== "ok") {
    dispatch({ kind: "slide-failed", slideIndex, message: downloaded.message });
    return;
  }
  dispatch({ kind: "slide-arrived", slideIndex, html: downloaded.value });
}

/** Every missing thumbnail's HTML in one round trip. A failure is shown on its thumbnail, never retried in a loop. */
async function loadPreviews(requests: readonly PreviewRequest[]): Promise<void> {
  const running = services;
  const replied =
    running === null
      ? { kind: "failed" as const, message: NOT_CONNECTED }
      : await running.batch.downloadTexts(requests.map((request) => request.fileId));
  for (const { key, fileId } of requests) {
    const read = replied.kind === "ok" ? replied.value.get(fileId) : replied;
    if (read === undefined || read.kind !== "ok") {
      dispatchPreview({ kind: "preview-failed", key, message: read?.message ?? "not in the batch reply" });
    } else {
      dispatchPreview({ kind: "preview-arrived", key, html: read.value });
    }
  }
}

/**
 * The user's message, as one native Slides comment. `feedbackCommentsFor` decides what a sendable
 * message is and what the comment says; this function only moves bytes and reports the verdict.
 */
async function sendMessage(): Promise<void> {
  const running = services;
  if (running === null) {
    dispatch({ kind: "send-failed", message: NOT_CONNECTED });
    return;
  }
  const fileId = running.presentationId;
  if (fileId === null) {
    dispatch({ kind: "send-failed", message: "this conversation has no presentation to comment on" });
    return;
  }
  const note = outgoingMessage({ conversation: state, messageId: newMessageId() });
  if (note === null) return;
  const built = feedbackCommentsFor({ notes: [note], createdAt: new Date().toISOString() });
  for (const refused of built.refused) {
    console.warn(`[sasha-slides] not sending ${refused.noteId}: ${refused.reason}`);
  }
  if (built.contents.length === 0) {
    dispatch({ kind: "send-failed", message: refusalOf(built.refused) });
    return;
  }
  dispatch({ kind: "send-started" });
  const replied = await running.feedback.send({
    fileId,
    comments: built.contents.map((content) => ({ content })),
  });
  if (replied.kind !== "ok") {
    dispatch({ kind: "send-failed", message: replied.message });
    return;
  }
  const outcome = sendOutcomeOf({ results: replied.value.results, requested: built.contents.length });
  switch (outcome.kind) {
    case "sent":
      dispatch({ kind: "send-succeeded" });
      return;
    case "failed":
      dispatch({ kind: "send-failed", message: outcome.message });
      return;
    default:
      return assertNever(outcome);
  }
}

/**
 * ANSWER OR RESOLVE ONE THREAD, from its card, on the Drive file the thread lives on.
 *
 * One server call per press, through the same rate-limited `call` as every poll. The read that
 * brings the result back is NOT started here: `thread-action-succeeded` raises a one-shot flag and
 * `pump` -- the single gate -- starts exactly one read for it (see `rereadWanted`). Calling a
 * loader from here as well would be the second path to a fetch that the quota incident came from.
 */
async function actOnThread({
  thread,
  action,
}: {
  thread: ConversationThread;
  action: ThreadActionKind;
}): Promise<void> {
  const running = services;
  const commentId = thread.commentId;
  if (running === null) {
    dispatch({ kind: "thread-action-failed", commentId, action, message: NOT_CONNECTED });
    return;
  }
  if (thread.fileId === null) {
    dispatch({
      kind: "thread-action-failed",
      commentId,
      action,
      message: "this comment's file is not known yet -- wait for the candidates to be read",
    });
    return;
  }
  const content = replyContentFor({ commentId, action });
  if (content === null) return;
  dispatch({ kind: "thread-action-started", commentId, action });
  const spec = { fileId: thread.fileId, commentId, content };
  const replied = await postFor({ feedback: running.feedback, action, spec });
  if (replied.kind !== "ok") {
    dispatch({ kind: "thread-action-failed", commentId, action, message: replied.message });
    return;
  }
  dispatch({ kind: "thread-action-succeeded", commentId, action, source: thread.source });
}

/**
 * What the post says. A reply is the pill's words, or nothing at all -- an empty reply is never
 * sent. A resolve sends no words of its own; Code.gs supplies the "Resolved." Drive insists on.
 */
function replyContentFor({ commentId, action }: { commentId: string; action: ThreadActionKind }): string | null {
  switch (action) {
    case "reply":
      return outgoingReply({ conversation: state, commentId });
    case "resolve":
      return "";
    default:
      return assertNever(action);
  }
}

function postFor({
  feedback,
  action,
  spec,
}: {
  feedback: FeedbackApi;
  action: ThreadActionKind;
  spec: Readonly<{ fileId: string; commentId: string; content: string }>;
}): ReturnType<FeedbackApi["reply"]> {
  switch (action) {
    case "reply":
      return feedback.reply(spec);
    case "resolve":
      return feedback.resolve(spec);
    default:
      return assertNever(action);
  }
}

/**
 * ARCHIVE OR RESTORE ONE CANDIDATE, from the set card.
 *
 * OPTIMISTIC: `archive-requested` moves the candidate on screen before anything is written. Then
 * ONE event file is CREATED in the proposal's `events/` folder -- never an update, so this writer
 * cannot clobber the server's events -- and that file is what makes the choice survive a reopen and
 * reach Sasha. A write that fails dispatches `archive-failed`, which undoes the click and says why.
 * `atMillis` names the event file AND identifies the request, so a late outcome for a click the user
 * has already changed their mind about cannot undo the newer one.
 */
async function setCandidateArchived({
  proposalId,
  slideIndex,
  archived,
}: {
  proposalId: string;
  slideIndex: number;
  archived: boolean;
}): Promise<void> {
  const atMillis = Date.now();
  dispatch({ kind: "archive-requested", proposalId, slideIndex, archived, atMillis });
  const fail = (message: string): void =>
    dispatch({ kind: "archive-failed", proposalId, slideIndex, atMillis, message });
  const running = services;
  if (running === null) {
    fail(NOT_CONNECTED);
    return;
  }
  const followed = followedSet(state);
  if (followed === null || followed.proposalId !== proposalId) {
    fail("that set of candidates is no longer the one on screen");
    return;
  }
  const body = archiveEventBodyOf({ slideIndex, archived });
  const name = sessionEventFileName({ atMillis, suffix: freshEventSuffix(), kind: body.kind });
  if (name.kind !== "ok") {
    fail(describeParsed({ parsed: name, what: "the event name" }));
    return;
  }
  const serialized = serializeSessionEvent({ body, at: new Date(atMillis).toISOString() });
  if (serialized.kind !== "ok") {
    fail(describeParsed({ parsed: serialized, what: "the event" }));
    return;
  }
  const written = await running.log.appendEvent({
    folderId: followed.folderId,
    name: name.value,
    mimeType: EVENT_MIME_TYPE,
    body: serialized.value,
  });
  if (written.kind !== "ok") {
    fail(written.message);
    return;
  }
  dispatch({ kind: "archive-written", proposalId, slideIndex, atMillis, fileId: written.value.fileId });
}

/** Six base36 characters: the event name's tie-break, so two writers in one millisecond do not collide. */
function freshEventSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
}

/**
 * Ask the HOST to show the slides window. `opened` is read back rather than assumed, so a refusal
 * (an older Code.gs, a host that declined) becomes a line on screen instead of a button that
 * appears to do nothing -- and this button is the only way back to the candidates.
 */
async function showSlides(target?: Readonly<{ proposalId: string; slideIndex: number | null }>): Promise<void> {
  const running = services;
  if (running === null) {
    dispatch({ kind: "open-failed", message: NOT_CONNECTED });
    return;
  }
  dispatch({ kind: "open-requested" });
  // WITH A TARGET the window comes up ON that candidate. The two documents share nothing, so it
  // is recorded server-side first and collected by the window (build-addon.ts). The SEED hands the
  // window what this sidebar already read, so it draws without six round trips (picker-seed.ts).
  const slideIndex = target?.slideIndex ?? null;
  const replied = await running.window.openPicker({
    proposalId: target?.proposalId ?? null,
    slideIndex,
    seed: pickerSeedOf({ conversation: state, previews, slideIndex }),
  });
  if (replied.kind !== "ok") {
    dispatch({ kind: "open-failed", message: replied.message });
    return;
  }
  dispatch({ kind: "open-succeeded" });
}

/**
 * Ask the HOST to show the DEFECT-REPORT window -- a third document of its own. The target is
 * recorded server-side before the window appears, because the documents cannot talk to each other
 * (see `sashaOpenDefectReport` / `sashaTakeReportTarget`). The conversation has no slide in mind,
 * so it names the followed proposal and lets that window choose the candidate.
 */
async function reportDefect(): Promise<void> {
  const running = services;
  if (running === null) {
    dispatch({ kind: "report-failed", message: NOT_CONNECTED });
    return;
  }
  dispatch({ kind: "report-requested" });
  const followed = followedSet(state);
  // Opened FIRST and synchronously, before any await -- see report-window.ts.
  const opened = reportWindow.open();
  const replied = await running.window.openDefectReport({
    proposalId: followed === null ? null : followed.proposalId,
    slideIndex: null,
    // Without a real window the host's dialog is the fallback; with one, asking for the dialog
    // too would evict whatever dialog the user already has open.
    showDialog: !opened,
  });
  if (replied.kind !== "ok") {
    dispatch({ kind: "report-failed", message: replied.message });
    return;
  }
  dispatch({ kind: "report-succeeded" });
}

const actions: ConversationActions = {
  typeMessage(text) {
    dispatch({ kind: "draft-typed", text });
  },
  send() {
    void sendMessage();
  },
  refresh() {
    markStale();
  },
  showSlides() {
    void showSlides();
  },
  reportDefect() {
    void reportDefect();
  },
  typeReply({ commentId, text }) {
    dispatch({ kind: "reply-typed", commentId, text });
  },
  reply(thread) {
    void actOnThread({ thread, action: "reply" });
  },
  chooseCommentFilter(filter) {
    dispatch({ kind: "comment-filter-chosen", filter });
  },
  openArtifact(target) {
    void showSlides(target);
  },
  resolve(thread) {
    void actOnThread({ thread, action: "resolve" });
  },
  setCandidateArchived(target) {
    void setCandidateArchived(target);
  },
  chooseCandidateTab(tab) {
    dispatch({ kind: "candidate-tab-chosen", tab });
  },
};

/**
 * One pending poll at a time; scheduling again replaces it, which is what a cadence change needs.
 * The tick marks every load stale and lets `pump` do the fetching, so there is exactly one place
 * that decides whether a read is wanted.
 */
function schedulePoll(): void {
  if (pollHandle !== null) clearTimeout(pollHandle);
  const delayMs = document.visibilityState === "visible" ? VISIBLE_POLL_MS : HIDDEN_POLL_MS;
  pollHandle = setTimeout(() => {
    pollHandle = null;
    markStale();
    schedulePoll();
  }, delayMs);
}

/**
 * Mark every poll-driven load stale. It dispatches the `*-requested` events and lets `pump` start
 * the fetches, rather than calling the loaders here: `pump` is the single gate, so a load that is
 * already in flight is not started twice and a `needs*` predicate cannot be bypassed.
 *
 * THE MANIFEST IS NOT IN THIS LIST, on purpose. Listing `events/` is the "has anything happened"
 * signal and `manifest.revision` is the separate "have the candidates changed" one -- they are not
 * the same because the add-on APPENDS events, so an event that bumped `revision` would make the
 * add-on a writer of `manifest.json` and put both writers back into the read-modify-write that one
 * file per event exists to prevent. `needsManifest` therefore re-reads it when the LOG shows a
 * set-changing event, and not on a clock.
 */
/**
 * ASK FOR A FRESH READ OF EVERYTHING -- which is just `pump`, because `needs*` already says a
 * finished read wants another one.
 *
 * It used to dispatch the four `*-requested` events itself and then call `pump`. That was
 * exactly backwards: `*-requested` means "a read is IN FLIGHT", so it parked every load in
 * `loading` and `pump` then skipped all four. The panel sat on the word "refreshing" and never
 * read Drive again after its first load (measured in the deployed add-on, 2026-10-04).
 */
function markStale(): void {
  pump();
}

/** Why nothing was sent. The reasons come from `feedbackCommentsFor`. */
function refusalOf(refused: readonly Readonly<{ noteId: string; reason: string }>[]): string {
  const first = refused[0];
  return first === undefined ? "there is nothing to send yet" : `nothing was sent: ${first.reason}`;
}

/** A protocol parse failure, in words. The same two arms `outcomeOf` has, for a file rather than a call. */
function describeParsed({
  parsed,
  what,
}: {
  parsed: Readonly<{ kind: "invalid"; reason: string }> | Readonly<{ kind: "unsupported-version"; protocolVersion: number }>;
  what: string;
}): string {
  switch (parsed.kind) {
    case "invalid":
      return `${what}: ${parsed.reason}`;
    case "unsupported-version":
      return `${what} declares protocolVersion ${parsed.protocolVersion}`;
    default:
      return assertNever(parsed);
  }
}

/**
 * Unique per message for the lifetime of the conversation. `Date.now()` alone is not enough -- two
 * messages sent in the same millisecond would share an id, and the id is what the sentinel carries.
 */
function newMessageId(): string {
  messageSerial += 1;
  return `chat_${Date.now().toString(36)}_${messageSerial}`;
}

function render(): void {
  if (root === null) {
    const existing = document.getElementById(ROOT_ELEMENT_ID);
    const host = existing ?? document.createElement("div");
    host.id = ROOT_ELEMENT_ID;
    if (existing === null) document.body.append(host);
    root = createRoot(host);
  }
  root.render(createElement(ConversationPanel, { conversation: state, previews, setup: SETUP, actions }));
}

/**
 * THE ENTRY POINT, and it is LAST on purpose. `main` renders immediately and `render` passes the
 * module-level `actions` object down; a `void main()` placed above that declaration hands React
 * `undefined` for one render, which is a `TypeError` on first paint the moment any panel reads an
 * action off it. Everything a module-level initialiser needs is declared above.
 */
void main();
