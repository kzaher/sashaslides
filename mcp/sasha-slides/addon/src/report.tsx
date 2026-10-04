// THE DEFECT-REPORT WINDOW: the third HtmlService document, and its composition root.
//
// WHY IT IS ITS OWN DOCUMENT. The anonymiser (`src/anonymise/`) plus `Defect.tsx` plus
// `report-endpoint.ts` are the heaviest code in the product, and the slides window has a hard size
// ceiling: this repo has recorded HtmlService corrupting a ~560 KB inlined blob with "Uncaught
// SyntaxError: Invalid or unexpected token", and the bundle cannot be base64'd because the
// sandbox's content-security policy forbids `unsafe-eval`. Splitting this out is what brings the
// slides window back under the size HtmlService relays intact -- the same reasoning that took the
// conversation from 439 KB to 256 KB when the surfaces were first split. See report-state.ts.
//
// IT SHARES NOTHING WITH THE OTHER TWO. Which candidate it opens on was RECORDED on the server by
// whoever pressed the button (`sashaOpenDefectReport`) and is read here exactly once
// (`sashaTakeReportTarget`), so a window opened from the menu later does not come up on a slide
// the user finished with yesterday. Nothing recorded is a normal answer: `chosenTarget` then picks
// the first candidate and the surface says that is what happened.
//
// FIVE STEPS, AND THE USER IS BETWEEN EACH PAIR OF THEM: read the slide, anonymise it, look at the
// two slides side by side and edit either one, prepare the payload, send it. Nothing leaves the
// browser before `sendReport`, and `sendReport` can only send what `sendablePreview` hands it --
// which is the preview built from the bytes the right-hand slide renders right now
// (UI-CONTRACT.md, "The defect report is the same editor, not a table").
//
// THERE IS NO MODEL IN THIS FLOW ANY MORE. Anonymisation is lorem ipsum, always: the model-assisted
// mode is withdrawn (UI-CONTRACT.md), so the comment-pane round trip that asked Sasha to rewrite the
// visible runs, its long poll and its parse are gone from here -- with them went the only reason
// this window ever sent the slide's own words anywhere.

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import {
  appsScriptCall,
  appsScriptDriveApi,
  appsScriptReportTargetApi,
  helloFromServer,
} from "./bridge-client.ts";
import { presentationIdOf } from "./bridge.ts";
import { browserReportConverter } from "./converter-contract.ts";
import {
  anonymiseSlideHtml,
  defectReportFrom,
  extractTextRuns,
  previewDefectReport,
  type ConvertForReport,
  type DefectReport,
} from "./anonymise/index.ts";
import {
  defectOnSlide,
  defectWithoutSlide,
  needsPass,
  needsSlideHtml,
  replacementsFor,
  sendableAnonymised,
  sendablePreview,
  sentHtmlOf,
  sourceHtmlOf,
  type Defect,
  type DefectEvent,
} from "./defect-state.ts";
import { DefectPanel, type DefectActions } from "./Defect.tsx";
import { PICKER_CSS } from "./picker-styles.ts";
import { createSlideEditor } from "./editor/index.ts";
import {
  browserHttpPost,
  fetchReportSubmitter,
  reportRequestBodyOf,
  serializeReportRequest,
  type ReportSubmitter,
} from "./report-endpoint.ts";
import type { DriveApi } from "./drive-api.ts";
import { newPageObjectId } from "./slide-insert.ts";
import { PROTOCOL_VERSION, assertNever, parseManifest, parseReadyMarker, type SlideEntry } from "./protocol.ts";
import {
  INITIAL_REPORT_SURFACE,
  chosenTarget,
  defectOf,
  describeChosenTarget,
  reduceReportSurface,
  type ReportSurface,
  type ReportSurfaceEvent,
} from "./report-state.ts";
import { stagedProposalsOf } from "./conversation-state.ts";

const ROOT_ELEMENT_ID = "sasha-slides-root";
/** Where the converter parks its offscreen 1280x720 staging iframe. */
const STAGE_ELEMENT_ID = "sasha-slides-stage";
/** One scan of the inbox. The same page size the observer uses. */
const SCAN_PAGE_SIZE = 100;
/**
 * THE BUILD IDENTIFIERS THAT TRAVEL WITH A DEFECT REPORT, and they are the only version strings in
 * the payload. The report service's schema allows exactly three (`addon`, `converter`, `protocol`)
 * and insists each is `[A-Za-z0-9][A-Za-z0-9._+:-]*` -- build identifiers, not prose. The
 * anonymiser's own version is NOT among them: `sasha-anonymise/1` is not even a legal identifier
 * there, and `report-endpoint.ts` says what happens to it instead (it is shown, not sent).
 */
const ADDON_VERSION = "0.1.0";
const CONVERTER_VERSION = "2026.10.04";

let state: ReportSurface = INITIAL_REPORT_SURFACE;
let root: Root | null = null;
let services: Services | null = null;

type Services = Readonly<{
  drive: DriveApi;
  submitter: ReportSubmitter;
  presentationId: string | null;
  /** The proposal this report is about, for `forbiddenStrings` -- never part of a payload. */
  proposalId: string | null;
}>;

async function main(): Promise<void> {
  render();
  const call = appsScriptCall({ run: google.script.run });

  const hello = await helloFromServer({ call });
  if (hello.kind !== "ok") {
    dispatch({ kind: "trouble", message: hello.message });
    return;
  }
  if (hello.value.protocolVersion !== PROTOCOL_VERSION) {
    dispatch({
      kind: "trouble",
      message: `the add-on speaks protocolVersion ${hello.value.protocolVersion}, this report ${PROTOCOL_VERSION}`,
    });
    return;
  }
  const presentationId = presentationIdOf(hello.value.presentationUrl);
  const drive = appsScriptDriveApi({ call });

  // WHICH CANDIDATE, read once. A failure here is NOT fatal: the window falls back to the first
  // staged candidate and says so, which is better than refusing to open at all.
  dispatch({ kind: "progress", what: "finding the slide to report on..." });
  const target = await appsScriptReportTargetApi({ call }).takeTarget();
  if (target.kind !== "ok") console.warn(`[sasha-slides] ${target.message}`);
  const requested = target.kind === "ok" ? target.value : { proposalId: null, slideIndex: null };

  const found = await findCandidates({ drive, proposalId: requested.proposalId });
  services = {
    drive,
    submitter: fetchReportSubmitter({ fetchJson: browserHttpPost({ fetchImpl: window.fetch.bind(window) }) }),
    presentationId,
    proposalId: found.kind === "found" ? found.proposalId : null,
  };
  if (found.kind === "unreadable") {
    dispatch({ kind: "opened", defect: defectWithoutSlide({ seed: freshSeed(), message: found.message }) });
    return;
  }
  const chosen = chosenTarget({ requestedSlideIndex: requested.slideIndex, slides: found.slides });
  switch (chosen.kind) {
    case "nothing-staged":
      dispatch({
        kind: "opened",
        defect: defectWithoutSlide({
          seed: freshSeed(),
          message:
            "no candidate slide is staged to report on. Ask Sasha for a slide, then press Report a " +
            "defect on the one that came out wrong.",
        }),
      });
      return;
    case "chosen":
    case "substituted":
      // The explanation is WARNED rather than rendered as a failure: `Defect.slide.label` is what
      // the panel shows, so it carries the sentence instead.
      dispatch({
        kind: "opened",
        defect: defectOnSlide({
          fileId: chosen.slide.fileId,
          label: `${chosen.slide.label === "" ? chosen.slide.name : chosen.slide.label} -- ${describeChosenTarget(chosen)}`,
          seed: freshSeed(),
        }),
      });
      return;
    default:
      return assertNever(chosen);
  }
}

/**
 * The candidates to choose from: the recorded proposal when it is still staged, otherwise the
 * newest one that is. READY first, because READY names the manifest and is written LAST -- its
 * presence is the only statement that the set is complete.
 */
async function findCandidates({
  drive,
  proposalId,
}: {
  drive: DriveApi;
  proposalId: string | null;
}): Promise<FoundCandidates> {
  const scanned = await drive.scanInbox({ pageSize: SCAN_PAGE_SIZE });
  if (scanned.kind !== "ok") return { kind: "unreadable", message: scanned.message };
  const staged = stagedProposalsOf({ marks: scanned.value });
  if (staged.length === 0) return { kind: "found", proposalId: "", slides: [] };
  const asked = proposalId === null ? undefined : staged.find((one) => one.proposalId === proposalId);
  const chosen = asked ?? staged[staged.length - 1];
  if (chosen === undefined) return { kind: "found", proposalId: "", slides: [] };
  const readyText = await drive.downloadText(chosen.readyFileId);
  if (readyText.kind !== "ok") return { kind: "unreadable", message: readyText.message };
  const ready = parseReadyMarker(readyText.value);
  if (ready.kind !== "ok") return { kind: "unreadable", message: "READY could not be read" };
  const manifestText = await drive.downloadText(ready.value.manifestFileId);
  if (manifestText.kind !== "ok") return { kind: "unreadable", message: manifestText.message };
  const manifest = parseManifest(manifestText.value);
  if (manifest.kind !== "ok") return { kind: "unreadable", message: "manifest.json could not be read" };
  return { kind: "found", proposalId: chosen.proposalId, slides: manifest.value.slides };
}

type FoundCandidates =
  | Readonly<{ kind: "found"; proposalId: string; slides: readonly SlideEntry[] }>
  | Readonly<{ kind: "unreadable"; message: string }>;

function dispatch(event: ReportSurfaceEvent): void {
  const next = reduceReportSurface(state, event);
  if (next === state) return;
  state = next;
  render();
  pump();
}

/**
 * THE REPORT FLOW'S LOOPS: the slide's HTML, and the anonymisation pass over it. Both gated on a
 * PREDICATE over their load union (defect-state.ts) rather than on a bare `kind === "unrequested"`,
 * so a new variant has to say whether it wants work done.
 *
 * The pass is run HERE rather than in the reducer even though it is synchronous, because it needs
 * the injected engine -- a reducer that reached for one would stop being pure and stop being
 * testable with values.
 */
function pump(): void {
  const forHtml = defectOf(state);
  if (forHtml !== null && needsSlideHtml(forHtml)) {
    dispatchDefect({ kind: "slide-requested" });
    void loadSlideHtml();
  }
  const forPass = defectOf(state);
  if (forPass !== null && needsPass(forPass)) runPass(forPass);
}

function dispatchDefect(event: DefectEvent): void {
  dispatch({ kind: "defect", event });
}

/** The slide's own HTML, for the before column and for the anonymiser. */
async function loadSlideHtml(): Promise<void> {
  const running = services;
  const defect = defectOf(state);
  if (defect === null) return;
  if (running === null) {
    dispatchDefect({ kind: "slide-failed", message: NOT_CONNECTED });
    return;
  }
  if (defect.slide.kind !== "loading") return;
  const downloaded = await running.drive.downloadText(defect.slide.fileId);
  if (downloaded.kind !== "ok") {
    dispatchDefect({ kind: "slide-failed", message: downloaded.message });
    return;
  }
  dispatchDefect({ kind: "slide-arrived", html: downloaded.value });
}

const NOT_CONNECTED =
  "the add-on is not connected to Google Slides. Reload the presentation and open the report again.";

/**
 * ONE ANONYMISATION PASS. Synchronous, so there is no in-flight state -- but it can throw on a
 * pathological document, and a throw has to reach the screen rather than leave the table empty.
 */
function runPass(defect: Defect): void {
  // THE LEFT SLIDE'S bytes, which are Drive's copy plus whatever the user edited on that pane --
  // so an edit there is anonymised like everything else rather than bypassing the engine.
  const html = sourceHtmlOf(defect);
  if (html === null) return;
  try {
    // The BEFORE column and the pass are derived from the SAME original bytes, so the run ids line
    // up without anything being passed between them (text-runs.ts: an id is a token position).
    // Re-extracting from the anonymised HTML would NOT work -- removed comments shift the stream.
    const runs = extractTextRuns({ html });
    const slide = anonymiseSlideHtml({
      html,
      seed: defect.seed,
      identifiers: defect.identifiers,
      replacements: replacementsFor(defect),
    });
    dispatchDefect({ kind: "pass-run", slide, runs });
  } catch (cause) {
    dispatchDefect({ kind: "pass-failed", message: cause instanceof Error ? cause.message : String(cause) });
  }
}

/**
 * PREPARE: build the payload the user is about to send, and nothing else. `previewDefectReport` is
 * handed a `convert` FUNCTION, not a conversion, so the only conversion that can end up in a report
 * is the one it makes from `anonymised.html` itself -- that rule is the byte-identity guarantee and
 * it is not worked around here.
 *
 * `mustNotContain` is this window's whole stock of identifiers: the presentation it is bound to and
 * the proposal the slide belongs to. `previewDefectReport` THROWS if any of them turn up anywhere
 * in the payload, which is the right outcome -- it is a leak, not a validation failure.
 */
async function prepareReport(): Promise<void> {
  const running = services;
  const defect = defectOf(state);
  if (defect === null) return;
  // THE BYTES THE RIGHT-HAND SLIDE RENDERS, through the same selector the pane renders from. This
  // is the whole of "what is sent is what the right-hand slide renders": there is no second
  // computation of those bytes anywhere, so the picture and the payload cannot diverge.
  const anonymised = sendableAnonymised(defect);
  const sentHtml = sentHtmlOf(defect);
  if (running === null || anonymised === null || sentHtml === null) {
    dispatchDefect({ kind: "preview-failed", message: NOT_CONNECTED });
    return;
  }
  dispatchDefect({ kind: "preview-requested" });
  const convert: ConvertForReport = browserReportConverter({
    extractorScript: extractorSource(),
    container: stageElement(),
    // A report's conversion is never inserted anywhere, so the ids are this window's own and the
    // redactor rewrites every one of them to `anon-N` before the preview is shown.
    presentationId: "report",
    pageObjectId: newPageObjectId({ random: Math.random }),
    objectIdPrefix: "report",
  });
  try {
    const preview = await previewDefectReport({
      anonymised,
      identifierPolicy: defect.identifiers,
      convert,
      note: defect.note,
      versions: { converter: CONVERTER_VERSION, addon: ADDON_VERSION, protocol: String(PROTOCOL_VERSION) },
      mustNotContain: forbiddenStringsFor(running),
    });
    dispatchDefect({ kind: "preview-built", sentHtml, preview });
  } catch (cause) {
    dispatchDefect({ kind: "preview-failed", message: cause instanceof Error ? cause.message : String(cause) });
  }
}

/** The identifiers this window holds and that must never appear in a payload. */
function forbiddenStringsFor(running: Services): readonly string[] {
  return [running.presentationId, running.proposalId].flatMap((identifier) =>
    identifier === null || identifier === "" ? [] : [identifier],
  );
}

/**
 * SEND. The one action in this product that puts anything on the internet, and it sends exactly the
 * preview the user approved: `sendablePreview` returns null the moment anything has changed since it
 * was prepared -- the pass, the bytes the right-hand slide renders, or the note -- so there is no
 * path from an edit to a stale payload.
 */
async function sendReport(): Promise<void> {
  const running = services;
  const defect = defectOf(state);
  if (defect === null) return;
  const preview = sendablePreview(defect);
  if (running === null || preview === null) {
    dispatchDefect({
      kind: "preview-failed",
      message: "prepare the report again -- what is sent has to be exactly what the slide on the right says",
    });
    return;
  }
  const report: DefectReport = defectReportFrom(preview);
  const body = reportRequestBodyOf({ report, clientReportedAt: new Date().toISOString() });
  switch (body.kind) {
    case "invalid":
      dispatchDefect({ kind: "preview-failed", message: `this build cannot address that service: ${body.reason}` });
      return;
    case "unsupported-version":
      dispatchDefect({ kind: "preview-failed", message: `unsupported report schema ${body.protocolVersion}` });
      return;
    case "ok": {
      dispatchDefect({ kind: "send-started" });
      const submission = await running.submitter.submit({
        endpoint: defect.endpoint,
        body: serializeReportRequest(body.value),
      });
      dispatchDefect({ kind: "send-answered", submission });
      return;
    }
    default:
      return assertNever(body);
  }
}

const actions: DefectActions = {
  chooseView(view) {
    dispatchDefect({ kind: "view-chosen", view });
  },
  editRun({ runId, text }) {
    dispatchDefect({ kind: "run-edited", runId, text });
  },
  resetRun({ runId }) {
    dispatchDefect({ kind: "run-reset", runId });
  },
  editSource({ html, edits }) {
    dispatchDefect({ kind: "source-edited", html, edits });
  },
  resetSource() {
    dispatchDefect({ kind: "source-reset" });
  },
  editSent({ html, edits }) {
    dispatchDefect({ kind: "sent-edited", html, edits });
  },
  resetSent() {
    dispatchDefect({ kind: "sent-reset" });
  },
  reanonymise() {
    dispatchDefect({ kind: "reanonymise-requested" });
  },
  choosePolicy({ identifiers }) {
    dispatchDefect({ kind: "policy-chosen", identifiers });
  },
  typeNote({ text }) {
    dispatchDefect({ kind: "note-typed", text });
  },
  typeEndpoint({ endpoint }) {
    dispatchDefect({ kind: "endpoint-typed", endpoint });
  },
  prepare() {
    void prepareReport();
  },
  send() {
    void sendReport();
  },
  /**
   * THE VISUAL EDITOR, chosen here and nowhere else -- the composition root is the only place that
   * may know which implementation a pane got. It serializes the live document rather than a string
   * handed in, which is exactly what the two panes need: each one's bytes are its own DOM
   * (editor/index.ts).
   */
  createEditor() {
    return createSlideEditor({});
  },
  /**
   * CLOSE MEANS CLOSE THE WINDOW now, not "go back to the grid": this is a document of its own, so
   * there is nothing behind it. `google.script.host` is absent in a plain browser (the smoke
   * harness), which is why it is optional in apps-script.d.ts and read defensively here.
   */
  close() {
    const host = google.script.host;
    if (host === undefined) {
      console.warn("[sasha-slides] no Apps Script host to close -- this page is not in a dialog");
      return;
    }
    host.close();
  },
};

/**
 * THE ANONYMISER'S SUBSTITUTION KEY. Fresh per report, from the browser's CSPRNG, and it never
 * leaves this window: with the seed the substitution is reversible, which is exactly why
 * `AnonymisedSlide` and `DefectReport` have no field for it.
 */
function freshSeed(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  stage.style.cssText = "position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden";
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

function render(): void {
  if (root === null) {
    const existing = document.getElementById(ROOT_ELEMENT_ID);
    const host = existing ?? document.createElement("div");
    host.id = ROOT_ELEMENT_ID;
    if (existing === null) document.body.append(host);
    root = createRoot(host);
  }
  root.render(createElement(ReportSurfacePanel, { surface: state }));
}

/**
 * The window's three statuses. It is declared here rather than in a component file of its own
 * because it is four lines of shell around `DefectPanel`, and `Defect.tsx` is the surface.
 */
function ReportSurfacePanel({ surface }: { surface: ReportSurface }): ReturnType<typeof createElement> {
  switch (surface.status) {
    case "connecting":
      return (
        <>
          <style>{PICKER_CSS}</style>
          <div className="sasha-shell sasha-shell-wide">
            <p className="sasha-busy">{surface.what}</p>
          </div>
        </>
      );
    case "trouble":
      return (
        <>
          <style>{PICKER_CSS}</style>
          <div className="sasha-shell sasha-shell-wide">
            <p className="sasha-trouble">sasha-slides: {surface.message}</p>
          </div>
        </>
      );
    case "reporting":
      return (
        <>
          <style>{PICKER_CSS}</style>
          <div className="sasha-shell sasha-shell-wide">
            <DefectPanel defect={surface.defect} actions={actions} />
          </div>
        </>
      );
    default:
      return assertNever(surface);
  }
}

/**
 * THE ENTRY POINT, and it is LAST on purpose -- `render` reads the module-level `actions`, and a
 * `void main()` above that declaration hands React `undefined` for one render.
 */
void main();
