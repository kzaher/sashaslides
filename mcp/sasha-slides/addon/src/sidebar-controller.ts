// ASK SASHA'S FEEDBACK LOOPS: the state, the reads it asks for, and the boot that starts them.
//
// WHY IT IS ITS OWN FILE. It used to be sidebar.tsx's module body, which runs against the real
// `google.script.run`, `document` and React the moment it is imported -- so the one claim that
// matters most for how fast the panel opens ("a seeded boot asks for no sashaHello and starts the
// scan and the log read together") could only be checked in a browser. Here every port is
// injected (`SidebarHost`), and sidebar.tsx is reduced to wiring the real ones.
//
// THE BOOT, measured 2026-10-15 on the live deck from the click on the menu item: the page was up
// at 2.05 s, the candidates at 4.58 s and the connection line at ~6.4 s, because `sashaHello`, the
// scan and the log read ran in series. With the seed Code.gs now appends (sidebar-seed.ts) the
// panel draws the last known candidates and connection with its first paint, makes no hello round
// trip, and starts the scan, the log read and any manifest or thumbnail read in ONE pump.
//
// THE SURFACES SHARE NOTHING. Separate HtmlService documents, separate frames, separate origins --
// no state, no storage, no `postMessage`, no window handle (UI-CONTRACT.md). Everything this file
// needs from another surface comes through the SERVER:
//
//   * "what is staged" -- `sashaScanInbox`, the same name walk the slides window uses.
//   * "the log" -- `sashaReadEvents` over the followed proposal's `events/` folder: the archive
//     state, when the manifest changed, and whether anything is listening are all derived from it.
//   * "show the slides" -- `sashaOpenPicker`, because `showModelessDialog` is a server-side
//     `SlidesApp.getUi()` call and no amount of client JavaScript in this document can do it.
//
// THE DIALOG OPENS BY ITSELF WHEN SLIDES ARRIVE, and that decision is `proposalToAutoOpen`'s --
// state, not a side effect buried in a fetch handler -- so it happens once per proposal and a user
// who closes the window is not dragged back into it on the next poll.
//
// Shape, as everywhere else in this repo: one state tree, a pure reducer, and feedback loops that
// are functions OF the state. React is a passive subscriber.

import {
  appsScriptBatchReadApi,
  appsScriptDriveApi,
  appsScriptPickerWindowApi,
  appsScriptSessionLogApi,
  helloFromServer,
  type ServerCall,
} from "./bridge-client.ts";
import type { CallOutcome, HelloReply } from "./bridge.ts";
import type { ConversationActions } from "./Conversation.tsx";
import {
  INITIAL_CONVERSATION,
  followedSet,
  loadedEvents,
  needsLog,
  needsManifest,
  needsStaged,
  nextRevisedSlideToLoad,
  proposalToAutoOpen,
  reduceConversation,
  type Conversation,
  type ConversationEvent,
} from "./conversation-state.ts";
import type { BatchReadApi, DriveApi, PickerWindowApi, SessionLogApi } from "./drive-api.ts";
import { newestSetChangeIn, serializeSessionEvent, sessionEventFileName, sessionEventsOf } from "./session-log.ts";
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
import { parseSidebarBoot, sidebarSeedOf, type SidebarBoot } from "./sidebar-seed.ts";

/** One scan of the inbox. The same page size the observer uses. */
const SCAN_PAGE_SIZE = 100;
/** One read of a proposal's `events/` folder. A session with more events than this is not one. */
const EVENT_PAGE_SIZE = 500;
/** What an event file is uploaded as. The same type the slides window writes. */
const EVENT_MIME_TYPE = "application/json";
/**
 * How often everything is re-read while the panel is on screen, and while it is not. A sidebar the
 * user has switched away from drops to the slow cadence.
 */
const VISIBLE_POLL_MS = 8_000;
const HIDDEN_POLL_MS = 60_000;
/**
 * HOW OFTEN THE CLOCK TICKS -- a separate, much faster cadence than the Drive polls. A tick is pure
 * state (`clock-ticked` touches nothing but `nowMs`), so it costs a re-render and never a round
 * trip to Google; it is what ages the connection line's "heard from N ago" and makes stale evidence
 * of a listener stop counting. It stops while the sidebar is hidden.
 */
const CLOCK_TICK_MS = 1_000;

/**
 * `services` is null until the hello is in hand, and every path below therefore has to treat "not
 * connected" as a REPORTABLE outcome. Returning silently is what made a failed hello look like a
 * hang. A dead connection has to say so.
 */
const NOT_CONNECTED =
  "the add-on is not connected to Google Slides. Reload the presentation and reopen Ask Sasha.";

/** What the panel draws: the state, the thumbnails beside it, and what it is allowed to cause. */
export type SidebarView = Readonly<{
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
}>;

/** Every port the loops use, so a test can drive them with a fake server and no browser. */
export type SidebarHost = Readonly<{
  call: ServerCall;
  render: (view: SidebarView) => void;
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => void;
  /** The text of the seed element `showSidebar` appended, or null when there is none. */
  seedText: string | null;
}>;

/** A running panel. `stop` clears its timers; the page never calls it, a test always does. */
export type SidebarController = Readonly<{
  /** Resolves once the boot has either connected or reported why it could not. */
  started: Promise<void>;
  stop: () => void;
  state: () => Conversation;
}>;

type Services = Readonly<{
  drive: DriveApi;
  batch: BatchReadApi;
  log: SessionLogApi;
  window: PickerWindowApi;
}>;

/** The seed, or null when the page has none or it does not parse: the panel then boots as it always did. */
export function sidebarBootOf(seedText: string | null): SidebarBoot | null {
  if (seedText === null) return null;
  const parsed = parseSidebarBoot(seedText);
  return parsed.kind === "ok" ? parsed.value : null;
}

export function startSidebar(host: SidebarHost): SidebarController {
  let state: Conversation = INITIAL_CONVERSATION;
  /**
   * THE THUMBNAILS' BYTES, beside the state rather than in it (slide-previews.ts). For the life of
   * the sidebar, so a poll re-render never re-downloads a picture; keyed by file AND revision, so a
   * revision is a miss without anything having to invalidate it.
   */
  let previews: SlidePreviews = NO_PREVIEWS;
  let services: Services | null = null;
  /** The scan started before `sashaHello` answered, consumed once by the first `loadStaged`. */
  let earlyScan: ReturnType<DriveApi["scanInbox"]> | null = null;
  /**
   * Each proposal's `manifest.json` id, as the scan named it (Code.gs `sashaScanInboxWalk_`), so
   * `loadManifest` can read READY and the manifest in ONE round trip instead of two in series.
   */
  const manifestFileIds = new Map<string, string>();
  let pollHandle: ReturnType<typeof setTimeout> | null = null;
  let clockHandle: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  /** `pump` is re-entered by every `dispatch` it makes; see `pump` for why that is flattened. */
  let pumping = false;
  let pumpAgain = false;

  const actions: ConversationActions = {
    openArtifact(target) {
      void showSlides(target);
    },
    setCandidateArchived(target) {
      void setCandidateArchived(target);
    },
    chooseCandidateTab(tab) {
      dispatch({ kind: "candidate-tab-chosen", tab });
    },
  };

  const started = main();
  return {
    started,
    stop() {
      stopped = true;
      if (pollHandle !== null) clearTimeout(pollHandle);
      if (clockHandle !== null) clearInterval(clockHandle);
      pollHandle = null;
      clockHandle = null;
    },
    state: () => state,
  };

  async function main(): Promise<void> {
    const call = host.call;
    const drive = appsScriptDriveApi({ call });
    // THE SEED FIRST, BEFORE THE FIRST PAINT, so the panel's first frame is the last known
    // candidates and connection rather than a spinner. Applied without `pump`: nothing can be read
    // before the hello is in hand.
    const boot = sidebarBootOf(host.seedText);
    const seed = boot === null ? null : sidebarSeedOf(boot);
    for (const mark of seed?.marks ?? []) {
      if (mark.manifestFileId !== undefined) manifestFileIds.set(mark.proposalId, mark.manifestFileId);
    }
    if (seed !== null) state = reduceConversation(state, { kind: "seeded", seed });
    render();

    // WITH A SEED THERE IS NO HELLO ROUND TRIP: Code.gs computed it while serving the page.
    // Without one, the inbox scan starts now, IN PARALLEL with `sashaHello` -- it needs nothing the
    // hello answers (measured 2026-10-11: 0.86 s + 2.55 s in series) -- and the first `loadStaged`
    // consumes it instead of asking again.
    let hello: CallOutcome<HelloReply>;
    if (boot === null) {
      earlyScan = drive.scanInbox({ pageSize: SCAN_PAGE_SIZE, rememberForSidebar: true });
      hello = await helloFromServer({ call });
    } else {
      hello = { kind: "ok", value: boot.hello };
    }
    // A host that does not answer, or speaks another protocol version, is a banner on screen rather
    // than a panel of reads that silently never land.
    if (hello.kind !== "ok") {
      dispatch({ kind: "trouble", message: hello.message });
      return;
    }
    if (hello.value.protocolVersion !== PROTOCOL_VERSION) {
      dispatch({
        kind: "trouble",
        message: `the add-on speaks protocolVersion ${hello.value.protocolVersion}, this panel ${PROTOCOL_VERSION}`,
      });
      return;
    }

    services = {
      drive,
      batch: appsScriptBatchReadApi({ call }),
      log: appsScriptSessionLogApi({ call }),
      window: appsScriptPickerWindowApi({ call }),
    };
    // ONE PUMP starts every read the state wants: the scan, and -- when the seed named a set --
    // the log, a stale manifest and the thumbnails, all before any of them answers.
    dispatch({ kind: "connected" });

    // Visibility changes both cadences, so both timers are re-armed rather than left on the slow one.
    host.onVisibilityChange(() => {
      schedulePoll();
      scheduleClock();
    });
    schedulePoll();
    scheduleClock();
  }

  function render(): void {
    host.render({ conversation: state, previews, actions });
  }

  /**
   * THE CLOCK. One interval, replaced rather than stacked, and it fires once immediately so the
   * first paint already has a time: `Conversation.nowMs` starts null.
   */
  function scheduleClock(): void {
    if (clockHandle !== null) clearInterval(clockHandle);
    clockHandle = null;
    if (stopped) return;
    dispatch({ kind: "clock-ticked", nowMs: Date.now() });
    // Hidden means nobody is reading it; the elapsed time is recomputed from `Date.now()` on the
    // next tick either way, so pausing it cannot make evidence look fresher than it is.
    if (!host.isVisible()) return;
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
   * The state is re-read between loops, never captured once: a captured `Conversation` would be one
   * event out of date and start the same fetch twice.
   *
   * NOT RE-ENTERED. Every `dispatch` below runs `pump` again, and a nested pass started the reads
   * in REVERSE: the scan's `staged-requested` ran a whole inner pass -- manifest, log, thumbnails
   * -- before the scan itself went out (seen in the seeded smoke test: ReadTexts, ReadEvents, then
   * ScanInbox). A nested call now only asks for another pass, so the reads go out in the order
   * written here: what the panel is waiting on first, the thumbnails last.
   */
  function pump(): void {
    if (stopped) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        pumpOnce();
      } while (pumpAgain && !stopped);
    } finally {
      pumping = false;
    }
  }

  function pumpOnce(): void {
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
    const revised = nextRevisedSlideToLoad(state);
    if (revised !== null) {
      dispatch({ kind: "slide-requested", slideIndex: revised.slideIndex });
      void loadRevisedSlide({ slideIndex: revised.slideIndex, fileId: revised.fileId });
    }
    // LAST, and as ONE batch (previewsToLoad): one round trip for every thumbnail, after the reads
    // the panel is waiting on have been asked for.
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

  /** The inbox name walk, reduced to "what is staged and unanswered". */
  async function loadStaged(): Promise<void> {
    const running = services;
    if (running === null) {
      dispatch({ kind: "staged-failed", message: NOT_CONNECTED });
      return;
    }
    const pending = earlyScan;
    earlyScan = null;
    const replied = await (pending ??
      running.drive.scanInbox({ pageSize: SCAN_PAGE_SIZE, rememberForSidebar: true }));
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
   * what say whether there are candidates (PROTOCOL.md).
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
    // different manifest than the one read alongside it, that one is read instead. This is the
    // read the next open is seeded with, so it is remembered with the event it was read at.
    const knownManifest = manifestFileIds.get(followed.proposalId);
    const forEventId = newestSetChangeIn(loadedEvents(state.log));
    const together =
      knownManifest === undefined
        ? null
        : await running.batch.downloadTexts([followed.readyFileId, knownManifest], {
            rememberForSidebar: { forEventId },
          });
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
   * THE LOG. One Drive call for the whole `events/` folder, then `sessionEventsOf` orders and
   * parses it -- including the files it cannot read, which become opaque entries rather than
   * absences.
   */
  async function loadLog(): Promise<void> {
    const running = services;
    const followed = followedSet(state);
    if (followed === null) return;
    if (running === null) {
      dispatch({ kind: "log-failed", message: NOT_CONNECTED });
      return;
    }
    const replied = await running.log.readEvents({
      folderId: followed.folderId,
      pageSize: EVENT_PAGE_SIZE,
      rememberForSidebar: true,
    });
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
    // NAMED FOR ITS SET: a seeded set the fresh scan replaced while this was in flight must not
    // receive the old set's log.
    dispatch({ kind: "log-arrived", events, readAt: new Date().toISOString(), proposalId: followed.proposalId });
  }

  /** One revised candidate's current HTML, so its thumbnail shows the revision. */
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
   * ARCHIVE OR RESTORE ONE CANDIDATE, from the set card.
   *
   * OPTIMISTIC: `archive-requested` moves the candidate on screen before anything is written. Then
   * ONE event file is CREATED in the proposal's `events/` folder -- never an update, so this writer
   * cannot clobber the server's events -- and that file is what makes the choice survive a reopen
   * and reach Sasha. A write that fails dispatches `archive-failed`, which undoes the click and says
   * why. `atMillis` names the event file AND identifies the request, so a late outcome for a click
   * the user has already changed their mind about cannot undo the newer one.
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

  /**
   * Ask the HOST to show the slides window. `opened` is read back rather than assumed, so a refusal
   * (an older Code.gs, a host that declined) becomes a line on screen instead of a button that
   * appears to do nothing -- and this is the only way back to the candidates.
   */
  async function showSlides(target?: Readonly<{ proposalId: string; slideIndex: number | null }>): Promise<void> {
    const running = services;
    if (running === null) {
      dispatch({ kind: "open-failed", message: NOT_CONNECTED });
      return;
    }
    dispatch({ kind: "open-requested" });
    // WITH A TARGET the window comes up ON that candidate. The two documents share nothing, so it
    // is recorded server-side first and collected by the window (Code.gs). The SEED hands the
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
   * One pending poll at a time; scheduling again replaces it, which is what a cadence change needs.
   * The tick only runs `pump`: `needs*` already says a finished read wants another one, so there is
   * exactly one place that decides whether a read is wanted.
   *
   * THE MANIFEST IS NOT RE-READ ON A CLOCK, on purpose. Listing `events/` is the "has anything
   * happened" signal and `manifest.revision` is the separate "have the candidates changed" one;
   * `needsManifest` re-reads it when the LOG shows a set-changing event.
   */
  function schedulePoll(): void {
    if (pollHandle !== null) clearTimeout(pollHandle);
    pollHandle = null;
    if (stopped) return;
    const delayMs = host.isVisible() ? VISIBLE_POLL_MS : HIDDEN_POLL_MS;
    pollHandle = setTimeout(() => {
      pollHandle = null;
      pump();
      schedulePoll();
    }, delayMs);
  }
}

/** Six base36 characters: the event name's tie-break, so two writers in one millisecond do not collide. */
function freshEventSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
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
