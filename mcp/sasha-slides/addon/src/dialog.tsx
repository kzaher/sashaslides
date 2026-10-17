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
  connect,
  notConnected,
} from "./bridge-client.ts";
import { EVENT_PAGE_SIZE, INBOX_PAGE_SIZE, presentationIdOf, type RenderRequest } from "./bridge.ts";
import { browserSlideConverter, type ConversionResult, type ConvertSlideHtml } from "./converter-contract.ts";
import {
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
import { createObserver, fetchProposal, type Announcer, type Observer, type PollTimer } from "./observer-runtime.ts";
import { createReportWindow } from "./report-window.ts";
import { SEED_ELEMENT_ID, parseBootSeed, type BootSeed } from "./picker-seed.ts";
import { cachedConversion, conversionKeyOf, rememberConversion } from "./conversion-cache.ts";
import { cachedRender, rememberRender, renderKeyOf } from "./render-cache.ts";
import {
  INITIAL_PICKER_STATE,
  anomaliesOf,
  anomalyIn,
  htmlToLoad,
  needsComments,
  needsConversion,
  needsHtml,
  nextToConvert,
  slidesToRender,
  type SlideFrame,
  offerOf,
  reducePicker,
  type PickerEvent,
  type PickerState,
  type Telling,
} from "./picker-state.ts";
import { createSlideEditor } from "./editor/index.ts";
import { writePick, type PickOutcome } from "./pick-writer.ts";
import { renderRequestFor } from "./render-artifact.ts";
import { assertNever, describeParsedFailure } from "./protocol.ts";
import { browserKeyValueStorage, seenStore } from "./seen-store.ts";
import {
  candidateCommentsFrom,
  candidateSetRevisionIn,
  sessionEventWrite,
  sessionEventsOf,
  type SessionEventBody,
} from "./session-log.ts";
import { applyMergeCandidate } from "./merge-apply.ts";
import { newPageObjectId, previewConversionSpec, type InsertPosition } from "./slide-insert.ts";
import { conversionForInsert, insertNewSlide, recordInsert, type Inserted } from "./insert-flow.ts";
import { extractorSource, seedText, stageElement, surfaceRenderer } from "./surface-host.ts";

/** One read of a candidate's comment threads -- a candidate with more than this is not the case. */
const CANDIDATE_COMMENT_PAGE_SIZE = 100;

let state: PickerState = INITIAL_PICKER_STATE;
const renderSurface = surfaceRenderer();
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

/**
 * One conversion at a time, across the set: `pump` runs after every state change. An index is in
 * here from the moment its conversion is SCHEDULED (an idle one may not have started yet) until
 * it settles, so a re-run of the pump never schedules the same candidate twice.
 */
const converting = new Set<number>();
/** The background conversion waiting for an idle browser, so a user who starts waiting can promote it. */
let idleConversion: Readonly<{ index: number; cancel: () => void }> | null = null;
/**
 * Which loaded candidates have already been looked up in the conversion cache, as
 * `proposalId:index`. The lookup hashes the whole document, and the pump runs on every dispatch.
 */
const conversionCacheChecked = new Set<string>();
/**
 * Every preview conversion this window finished, by its conversion-cache key, so an insert reuses
 * it (insert-flow.ts `conversionForInsert`) even when localStorage refused to keep it -- a private
 * window, a full quota, or a candidate too big for the shelf.
 */
const previewConversions = new Map<string, ConversionResult>();
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
  // UNLESS THE SIDEBAR SEEDED THIS WINDOW (picker-seed.ts): then Code.gs already put the answer
  // in the page, next to the proposal and its HTML, and the round trip is skipped.
  const boot = await bootSeedFromPage();
  const hello = await connect({ call, seeded: boot?.hello ?? null, surface: "picker" });
  if (hello.kind !== "ok") {
    dispatch({ kind: "trouble", message: hello.message });
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
  // ASKED NOW, IN PARALLEL with the inbox scan, not after the proposal lands: it is a round trip of
  // its own, and waiting for the proposal first put it in series with every other startup call --
  // one more second between "Open slide 2" and slide 2.
  // A SEEDED window was told its target with the seed, so there is nothing to collect.
  if (boot === null) pickerTarget = services.window.takePickerTarget();
  else {
    dispatch({
      kind: "proposal-seeded",
      proposal: boot.seed.proposal,
      presentationId,
      html: boot.seed.html,
      slideIndex: boot.seed.slideIndex,
    });
  }

  await observer.start();
  document.addEventListener("visibilitychange", () => {
    void announceViewers(observer);
  });
  await announceViewers(observer);
  followRevisions();
}

/** How often an open window checks the log for a revised set: quickly on screen, rarely behind another tab. */
const REVISION_POLL_VISIBLE_MS = 5_000;
const REVISION_POLL_HIDDEN_MS = 30_000;

/**
 * FOLLOW THE SET THIS WINDOW SHOWS. The observer only announces proposals it has not seen, so on
 * its own an open window kept the candidates it opened with: measured 2026-10-13 on sashaslides.com,
 * revise_slide made revision 3 and the window still showed revision 1 minutes later, ready to be
 * inserted. One log read per tick; the manifest is read again only when the log names a newer
 * revision than the one on screen (session-log.ts `candidateSetRevisionIn`).
 */
function followRevisions(): void {
  const tick = async (): Promise<void> => {
    try {
      // ALSO A SAFETY NET FOR THE LOADS. Measured 2026-10-13 on sashaslides.com: a window opened for
      // Claude Code's candidates sat on "loading 01.html..." for minutes with no call in flight,
      // and one click (one dispatch, so one pump) loaded both at once. `pump` only starts what is
      // missing, so running it on this clock bounds any such stall to one tick.
      reportStalledLoads();
      pump();
      await checkForRevision();
    } finally {
      const delay = document.visibilityState === "visible" ? REVISION_POLL_VISIBLE_MS : REVISION_POLL_HIDDEN_MS;
      setTimeout(() => void tick(), delay);
    }
  };
  setTimeout(() => void tick(), REVISION_POLL_VISIBLE_MS);
}

/**
 * A candidate still unrequested at a tick means the dispatch that offered it never started its load
 * -- the stall measured 2026-10-13, whose cause is not known. Say so with the events that led
 * here, so the next occurrence explains itself in the console instead of needing a witness.
 */
function reportStalledLoads(): void {
  const offer = offerOf(state);
  if (offer === null) return;
  const stalled = htmlToLoad(offer).map((frame) => frame.index);
  if (stalled.length === 0) return;
  console.warn(
    `[sasha-slides] recovered a stalled load: candidates ${stalled.join(", ")} of ${offer.proposal.proposalId} ` +
      `were never requested (status ${state.status}). Recent events:\n${recentEvents.join("\n")}`,
  );
}

async function checkForRevision(): Promise<void> {
  const offer = offerOf(state);
  if (services === null || offer === null || state.status !== "picking") return;
  const { proposal } = offer;
  const replied = await services.log.readEvents({ folderId: proposal.folderId, pageSize: EVENT_PAGE_SIZE });
  if (replied.kind !== "ok") return;
  const events = sessionEventsOf({
    files: replied.value.events.map((file) => ({ proposalId: proposal.proposalId, ...file })),
  });
  const newest = candidateSetRevisionIn(events);
  if (newest === null || (proposal.revision !== null && newest <= proposal.revision)) return;
  // A CLEAR is read like any revision: READY stays behind, and the manifest's count 0 is what says
  // the set was cleared (staged-set.ts).
  const marks = await services.drive.scanInbox({ pageSize: INBOX_PAGE_SIZE });
  if (marks.kind !== "ok") return;
  const mark = marks.value.find((candidate) => candidate.proposalId === proposal.proposalId);
  if (mark === undefined || mark.readyFileId === null) return;
  const loaded = await fetchProposal({
    drive: services.drive,
    proposalId: proposal.proposalId,
    readyFileId: mark.readyFileId,
    folderId: mark.folderId,
  });
  if (loaded.kind !== "ok") return;
  // A revision keeps each candidate's Drive file id, so the per-file caches must forget them.
  for (const slide of proposal.slides) htmlByFileId.delete(slide.fileId);
  for (const key of [...conversionCacheChecked]) if (key.startsWith(`${proposal.proposalId}:`)) conversionCacheChecked.delete(key);
  dispatch({ kind: "proposal-offered", proposal: loaded.value, presentationId: offer.presentationId });
}

/**
 * The seed Code.gs appended to this page, or null. Appended content is parsed AFTER the bundle's
 * loader has run, so it is only there once the document has finished parsing. A malformed seed is
 * dropped with a warning: the window then boots exactly as an unseeded one does.
 */
async function bootSeedFromPage(): Promise<BootSeed | null> {
  const text = await seedText(SEED_ELEMENT_ID);
  if (text === null) return null;
  const parsed = parseBootSeed(text);
  if (parsed.kind === "ok") return parsed.value;
  console.warn(`[sasha-slides] booting without ${describeParsedFailure({ parsed, what: "the slides seed" })}`);
  return null;
}

/**
 * The sidebar's "open on this candidate" request, taken ONCE per window as soon as the host has
 * answered (see `main`). Reading clears it server-side, so one read is all there is to have.
 */
let pickerTarget: ReturnType<PickerWindowApi["takePickerTarget"]> | null = null;

/** Collect the sidebar's "open on this candidate" request, if there is one for this proposal. */
async function openAtTarget(proposalId: string): Promise<void> {
  if (pickerTarget === null) return;
  const replied = await pickerTarget;
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

/** The last events, newest last, so a recovered stall can say what led to it (`reportStalledLoads`). */
const recentEvents: string[] = [];
const RECENT_EVENT_LIMIT = 40;

function dispatch(event: PickerEvent): void {
  recentEvents.push(`${new Date().toISOString().slice(11, 23)} ${event.kind}${"index" in event ? ` ${String(event.index)}` : ""}`);
  if (recentEvents.length > RECENT_EVENT_LIMIT) recentEvents.shift();
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
  // EVERY missing document AT ONCE: each `google.script.run` call is its own server execution and
  // they run concurrently. The live frame is re-checked because the nested pump inside `dispatch`
  // may already have asked for the ones after it.
  const toLoad = htmlToLoad(forHtml);
  if (toLoad.length > 0) {
    for (const frame of toLoad) {
      const live = offerOf(state)?.slides[frame.index - 1];
      if (live === undefined || !needsHtml(live)) continue;
      dispatch({ kind: "html-requested", index: frame.index });
      void loadSlideHtml({ proposalId: forHtml.proposal.proposalId, index: frame.index });
    }
    return;
  }
  if (applyCachedConversions()) return;
  const forConversion = offerOf(state);
  if (forConversion === null) return;
  const due = nextToConvert(forConversion);
  if (due !== null) {
    if (due.frame.html.kind !== "loaded") return;
    const spec = { proposalId: forConversion.proposal.proposalId, index: due.frame.index, html: due.frame.html.html };
    switch (due.urgency) {
      case "now":
        // Somebody is waiting: a background conversion still queued for idle time is promoted.
        if (idleConversion !== null) {
          idleConversion.cancel();
          converting.delete(idleConversion.index);
          idleConversion = null;
        }
        if (converting.size > 0) return;
        void convert(spec);
        return;
      case "idle":
        if (converting.size > 0) return;
        scheduleIdleConversion(spec);
        return;
      default:
        return assertNever(due.urgency);
    }
  }
  // EVERYTHING IS CONVERTED: go and get the real pictures, in the background, whatever the view (see
  // `slidesToRender`). One call for the whole set -- the server builds ONE throwaway deck for all of
  // them (build-addon.ts `sashaRenderPreviews`), so asking per candidate would be N decks.
  const toRender = slidesToRender(forHtml);
  if (toRender === null || rendering) return;
  void renderPreviews({ slides: toRender });
}

/**
 * EVERY candidate, not just the selected one: the grid shows all N at once, so all N documents and
 * all N conversions are wanted. The documents are fetched concurrently (see `pump`); the
 * conversions run one at a time, because the converter stages a real offscreen iframe per slide.
 * The selectors are in picker-state.ts so "what is next" is a tested decision, not a loop here.
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
  const asked = previewConversionSpec({ proposalId, index, html, presentationId: running.presentationId ?? "" });
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
      running.convert(asked),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`the converter did not answer within ${String(CONVERT_DEADLINE_MS / 1000)}s`)),
          CONVERT_DEADLINE_MS,
        ),
      ),
    ]);
    const key = conversionKeyOf({ build: buildStamp(), ...asked });
    rememberConversion(key, converted);
    previewConversions.set(key, converted);
    acceptConversion({ index, result: converted });
  } catch (cause) {
    dispatch({ kind: "conversion-failed", index, message: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    converting.delete(index);
    // AND PUMP AGAIN. The result was dispatched above while this index was still in flight, so the
    // pump that dispatch ran declined to start the next conversion. Without this the chain stalled
    // after every candidate until some unrelated event came along (measured live 2026-10-11:
    // eleven seconds between two conversions that each took ~20 ms, and "Converted" waited on it).
    pump();
  }
}

/**
 * A conversion is in -- from the converter or from the browser's cache -- and if Google's picture
 * of exactly these requests is remembered too, that is in as well, in any view, for free.
 */
function acceptConversion({ index, result }: { index: number; result: ConversionResult }): void {
  dispatch({ kind: "converted", index, result });
  const remembered = cachedRender(renderKeyOf(result.requests));
  if (remembered !== null) dispatch({ kind: "rendered", index, dataUri: remembered });
}

/**
 * Every loaded candidate whose conversion this browser has done before is converted NOW, from
 * localStorage (conversion-cache.ts) -- the reason reopening the window does not convert again.
 * Each candidate is looked up once per proposal. True when anything was applied, because the
 * dispatch has already re-run the pump.
 */
function applyCachedConversions(): boolean {
  const running = services;
  const offer = offerOf(state);
  if (running === null || offer === null) return false;
  let applied = false;
  for (const frame of offer.slides) {
    if (frame.html.kind !== "loaded" || !needsConversion(frame)) continue;
    const checked = `${offer.proposal.proposalId}:${String(frame.index)}`;
    if (conversionCacheChecked.has(checked)) continue;
    conversionCacheChecked.add(checked);
    const asked = previewConversionSpec({
      proposalId: offer.proposal.proposalId,
      index: frame.index,
      html: frame.html.html,
      presentationId: running.presentationId ?? "",
    });
    const remembered = cachedConversion(conversionKeyOf({ build: buildStamp(), ...asked }));
    if (remembered === null) continue;
    applied = true;
    acceptConversion({ index: frame.index, result: remembered });
  }
  return applied;
}

/**
 * A background conversion, run when the browser is idle so it never competes with a click. The
 * timeout bounds how long "idle" may take: a page that is never idle still converts.
 */
function scheduleIdleConversion(spec: { proposalId: string; index: number; html: string }): void {
  converting.add(spec.index);
  const run = (): void => {
    idleConversion = null;
    converting.delete(spec.index);
    const frame = offerOf(state)?.slides[spec.index - 1];
    // Still wanted? The proposal may have moved on, or the cache answered meanwhile.
    if (offerOf(state)?.proposal.proposalId !== spec.proposalId || frame === undefined || !needsConversion(frame)) {
      pump();
      return;
    }
    void convert(spec);
  };
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: IDLE_CONVERSION_TIMEOUT_MS });
    idleConversion = { index: spec.index, cancel: () => cancelIdleCallback(handle) };
    return;
  }
  const handle = setTimeout(run, IDLE_CONVERSION_FALLBACK_MS);
  idleConversion = { index: spec.index, cancel: () => clearTimeout(handle) };
}

/** The longest a background conversion waits for an idle moment before running anyway. */
const IDLE_CONVERSION_TIMEOUT_MS = 2_000;
/** Where `requestIdleCallback` is missing, a short delay lets the first paint and clicks go first. */
const IDLE_CONVERSION_FALLBACK_MS = 300;

/**
 * Which build converted, for the conversion cache's key. The converter is compiled into this
 * bundle, so a new deploy may convert differently; the loader in build-addon.ts `surfaceHtml`
 * publishes a hash of the bundle as `window.sashaBuild`. Absent (a dev harness), every build is
 * "dev", which only means such a harness may see an older converter's cached output.
 */
function buildStamp(): string {
  // The loader assigns a string or nothing; the read is narrowed below rather than trusted.
  const published = (window as unknown as { sashaBuild?: unknown }).sashaBuild;
  return typeof published === "string" && published !== "" ? published : "dev";
}

/** `services` is null until `sashaHello` has answered; every path reports that (bridge-client.ts). */
const NOT_CONNECTED = notConnected("reopen the slides window");

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
  const write = sessionEventWrite({ body, atMillis: Date.now() });
  if (write.kind !== "ok") {
    console.warn(`[sasha-slides] could not write ${describeParsedFailure({ parsed: write, what: `a ${body.kind} event` })}`);
    return;
  }
  const written = await running.log.appendEvent({ folderId, ...write.value });
  if (written.kind !== "ok") console.warn(`[sasha-slides] could not write ${write.value.name}: ${written.message}`);
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
  insertPicked({ index, position }) {
    void submitInsert({ picked: index, position });
  },
  dismiss() {
    void submitDismissal();
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
       * A REFUSED ATTACH MUST NOT BE SILENT. `editor/slide-editor.ts` `attach` gives a reason when it
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
 * Insert -> show "Inserted" -> PICK, the `slide-inserted` event and the render artifact together.
 *
 * THE USER'S ANSWER COMES FIRST. The slide is in the deck the moment the batchUpdate succeeds, and
 * everything after it is bookkeeping the user used to sit through: the render artifact (a thumbnail,
 * its download and three Drive writes, ~1.5-2.5 s) inside the insert call, then PICK, then the event,
 * one ~0.7 s google.script.run after another. PROTOCOL.md needs none of them before the user is
 * told: `slide_images` answers "unavailable" until the render lands, and PICK carries
 * `insertedObjectIds`, which `clear_slides` honours even before the event does. See insert-flow.ts.
 */
async function submitInsert({ picked, position }: { picked: number; position: InsertPosition }): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (running === null || offer === null) return;
  const proposal = offer.proposal;
  dispatch({ kind: "submit-started", picked, stage: "converting" });

  const placed = await insertPicked({ running, picked, position });
  if (placed === null) return;
  // Read BEFORE settling: the settled state no longer holds the offer the mark-ups live on.
  const decided = offerOf(state);
  const anomalies = decided === null ? [] : anomaliesOf(decided);

  dispatch({
    kind: "settled",
    proposalId: proposal.proposalId,
    picked,
    where: placed.inserted.where,
    telling: { kind: "telling" },
  });
  // RESOLVED NOW, not once PICK lands: a poll in between would find READY without PICK and offer
  // this proposal again -- inviting a second insert of a slide that is already in the deck.
  running.observer.dispatch({ kind: "resolved", proposalId: proposal.proposalId, nowMs: Date.now() });

  const written = await recordInsert({
    slides: running.slides,
    presentationId: placed.presentationId,
    render: placed.render,
    writePick: () =>
      writePick({
        pick: running.pick,
        proposal,
        decision: { picked, insertedObjectIds: placed.inserted.objectIds, anomalies },
        decidedAt: new Date().toISOString(),
      }),
    appendEvent: () =>
      appendEvent({
        folderId: proposal.folderId,
        body: { kind: "slide-inserted", slideIndex: picked, pageObjectId: placed.inserted.pageObjectId },
      }),
    warn: (message) => console.warn(`[sasha-slides] option ${String(picked)}: ${message}`),
  });
  dispatch({ kind: "told", proposalId: proposal.proposalId, telling: tellingOf(written) });
}

/**
 * A dismissal is PICK with `picked: null`, which is what the server is blocked on. Nothing is in the
 * deck, so a failure here goes back to the grid and the user may simply dismiss again.
 */
async function submitDismissal(): Promise<void> {
  const running = services;
  const offer = offerOf(state);
  if (running === null || offer === null) return;
  const proposal = offer.proposal;
  dispatch({ kind: "submit-started", picked: null, stage: "writing-pick" });
  const written = await writePick({
    pick: running.pick,
    proposal,
    decision: { picked: null, insertedObjectIds: [], anomalies: anomaliesOf(offer) },
    decidedAt: new Date().toISOString(),
  });
  switch (written.kind) {
    case "written":
      running.observer.dispatch({ kind: "resolved", proposalId: proposal.proposalId, nowMs: Date.now() });
      dispatch({ kind: "settled", proposalId: proposal.proposalId, picked: null, where: null, telling: { kind: "told" } });
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

/** PICK's outcome as the settled line reports it. */
function tellingOf(written: PickOutcome): Telling {
  switch (written.kind) {
    case "written":
      return { kind: "told" };
    case "refused":
      return { kind: "failed", message: written.reason };
    case "failed":
      return { kind: "failed", message: written.message };
    default:
      return assertNever(written);
  }
}

/** What a pick put in the deck, and what the bookkeeping after it needs to know. */
type Placed = Readonly<{ inserted: Inserted; presentationId: string; render: RenderRequest | null }>;

/**
 * Put the picked candidate in the deck, or return null when that failed (the reducer has been
 * told). An ordinary proposal INSERTS a new slide, placed against the selected one; a merge proposal
 * redesigns its target slide in place (merge-apply.ts) and never creates a page.
 */
async function insertPicked({
  running,
  picked,
  position,
}: {
  running: Services;
  picked: number;
  position: InsertPosition;
}): Promise<Placed | null> {
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
  const html = frame.html.html;
  const renderAt = (pageObjectId: string): RenderRequest | null =>
    renderRequestFor({ proposalId: offer.proposal.proposalId, folderId: offer.proposal.folderId, index: picked, pageObjectId });
  const merge = offer.proposal.merge;
  if (merge !== null) {
    const merged = await applyMergeCandidate({
      slides: running.slides,
      convert: running.convert,
      merge,
      openPresentationId: presentationId,
      index: picked,
      html,
      // A fresh prefix per apply: the new elements must not share ids with what is on the slide.
      objectIdPrefix: newPageObjectId({ random: Math.random }),
      onSending: () => dispatch({ kind: "submit-stage", stage: "inserting" }),
    });
    switch (merged.kind) {
      case "applied":
        return {
          inserted: { objectIds: merged.createdObjectIds, pageObjectId: merged.pageObjectId, where: null },
          presentationId,
          render: renderAt(merge.slideObjectId),
        };
      case "refused":
      case "failed":
        dispatch({ kind: "submit-failed", message: merged.message });
        return null;
      default:
        return assertNever(merged);
    }
  }
  // THE PREVIEW'S CONVERSION, REUSED: the grid converted this exact HTML already, so it is only
  // renamed onto the new page id (slide-insert.ts `retargetConversion`). Converted afresh only when
  // the preview never finished or its result was evicted.
  const pageObjectId = newPageObjectId({ random: Math.random });
  const previewSpec = previewConversionSpec({
    proposalId: offer.proposal.proposalId,
    index: picked,
    html,
    presentationId: running.presentationId ?? "",
  });
  let conversion;
  try {
    conversion = await conversionForInsert({
      preview: previewConversionOf(previewSpec),
      previewPageObjectId: previewSpec.pageObjectId,
      pageObjectId,
      convert: () => running.convert({ html, presentationId, pageObjectId, objectIdPrefix: pageObjectId }),
    });
  } catch (cause) {
    dispatch({ kind: "submit-failed", message: cause instanceof Error ? cause.message : String(cause) });
    return null;
  }

  dispatch({ kind: "submit-stage", stage: "inserting" });
  const attempt = await insertNewSlide({
    slides: running.slides,
    presentationId,
    pageObjectId,
    converted: conversion.requests,
    position,
  });
  switch (attempt.kind) {
    case "inserted":
      return { inserted: attempt.inserted, presentationId, render: renderAt(pageObjectId) };
    case "failed":
      dispatch({ kind: "submit-failed", message: attempt.message });
      return null;
    default:
      return assertNever(attempt);
  }
}

/**
 * The preview's conversion of exactly this HTML, from this window's memory first and the browser's
 * conversion cache second -- the same key the preview wrote it under.
 */
function previewConversionOf(spec: ReturnType<typeof previewConversionSpec>): ConversionResult | null {
  const key = conversionKeyOf({ build: buildStamp(), ...spec });
  return previewConversions.get(key) ?? cachedConversion(key);
}

/** Why nothing was sent, when the mark-up was refused. The reasons come from `feedbackCommentsFor`. */
function refusalOf(refused: readonly Readonly<{ noteId: string; reason: string }>[]): string {
  const first = refused[0];
  return first === undefined ? "there is nothing to send yet" : `nothing was sent: ${first.reason}`;
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

function render(): void {
  renderSurface(createElement(Picker, { state, actions }));
}

/**
 * THE ENTRY POINT, and it is LAST on purpose. `main` renders immediately, and `render` passes the
 * module-level `actions` object down; a `void main()` placed above that declaration therefore hands
 * React `undefined` for one render, which is a `TypeError` on first paint the moment any panel
 * reads an action off it. Everything a module-level initialiser needs is declared above.
 */
void main();
