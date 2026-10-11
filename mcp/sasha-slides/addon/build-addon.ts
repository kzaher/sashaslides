#!/usr/bin/env npx tsx
/**
 * build-addon.ts — emits the ready-to-push Apps Script project for sasha-slides.
 *
 *   src/sidebar.tsx  ->  Sidebar.html   (Ask Sasha: the conversation, which is the event log)
 *   src/dialog.tsx   ->  Dialog.html    (the slides: the grid + the mark-up view)
 *   src/report.tsx   ->  Report.html    (the defect report: anonymise, review, send)
 *   CODE_GS below     ->  Code.gs       (every google.script.run function + the ONE menu item)
 *   APPSSCRIPT_JSON   ->  appsscript.json
 *
 * THREE BUNDLES, BECAUSE THERE ARE THREE DOCUMENTS, and the third one exists FOR THE SIZE.
 * HtmlService has been observed corrupting a ~560 KB inlined blob with "Uncaught SyntaxError:
 * Invalid or unexpected token", and the bundle cannot be base64'd because the sandbox's
 * content-security policy forbids `unsafe-eval` -- so what goes in which bundle is a correctness
 * decision, not a tidiness one:
 *
 *   * the CONVERTER and the base64 extractor blob are reachable from dialog.tsx and report.tsx,
 *     never from sidebar.tsx, which is why the conversation is a fraction of the size;
 *   * the ANONYMISER (src/anonymise/, ~47 KB bundled) plus Defect.tsx plus report-endpoint.ts are
 *     reachable only from report.tsx. Moving them out of Dialog.html is what brought it back under
 *     500 KB -- the same reasoning that took Sidebar.html from 439 KB to 256 KB when the surfaces
 *     were first split.
 *
 * The build prints all three so a regression in any of them is visible.
 *
 * Output goes to the repo-root dist/ (gitignored), mirroring the source path:
 *
 *   dist/mcp/sasha-slides/addon/{appsscript.json, Code.gs, Sidebar.html, Dialog.html, Report.html}
 *
 * It mirrors renderer/html2slides/browser/build-addon.ts in spirit and differs in two ways that
 * matter:
 *
 *   1. THE TYPECHECK IS ITS OWN FAILING STEP, BEFORE ANYTHING IS EMITTED. esbuild strips types
 *      without checking them (CLAUDE.md: "structured-prompting builds with esbuild only -- a
 *      misnamed object-literal field silently no-ops"), so `tsc --noEmit` runs first over BOTH
 *      projects: the shipped sources (browser types only) and the tests (which may also see
 *      @types/node). A type error here stops the build; it does not warn.
 *   2. NOTHING IS HAND-EDITED. Every emitted file carries a generated-file header and this script
 *      overwrites it wholesale. Code.gs in particular is a string in THIS file -- Apps Script's
 *      editor is not the source of truth.
 *
 * Run: cd mcp/sasha-slides/addon && npx tsx build-addon.ts
 */
import { build, transformSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_FUNCTION_NAMES } from "./src/bridge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const OUT = join(REPO_ROOT, "dist", "mcp", "sasha-slides", "addon");
const TYPECHECK_PROJECTS = ["tsconfig.json", "tsconfig.test.json"] as const;

const GENERATED_BY = "build-addon.ts (mcp/sasha-slides/addon)";
/**
 * THE PER-PAGE SIZE BUDGET, and it is evidence, not taste: this repo has recorded HtmlService
 * relaying a ~560 KB inlined bundle back CORRUPTED, as "Uncaught SyntaxError: Invalid or unexpected
 * token" in minified code. 500 KB is the ceiling the surfaces are kept under, with the margin on
 * the safe side of the only failure ever measured. Raising it needs a measurement, not an opinion.
 */
const SURFACE_BUDGET_BYTES = 500 * 1024;

// ---------------------------------------------------------------------------
// Code.gs — the Apps Script server side, as plain V8 JavaScript.
//
// IT IS A THIN ADAPTER AND NOTHING ELSE. Apps Script cannot be run or tested in this devcontainer,
// so every decision lives in TypeScript (src/) and every function below is straight-line I/O over
// values TypeScript computed:
//   * the inbox NAME WALK is DriveApp calls, no filtering logic -- `nextCandidate` (src/observer.ts)
//     decides which mark to open
//   * READY / manifest.json / NN.html come back as raw TEXT -- every parser is in src/protocol.ts
//   * the batchUpdate REPLY comes back raw -- `createdObjectIdsOf` (src/drive-api.ts) reads it
//   * the render artifact's folder name, file name, mime type and appProperties all arrive in the
//     request -- `renderRequestFor` (src/render-artifact.ts) computes them
// `var` and no arrow functions: the Apps Script V8 runtime accepts both, but the house style in
// renderer/html2slides/addon-server/api/export-appsscript.gs.txt is ES5-shaped .gs and this stays
// consistent with it.
// ---------------------------------------------------------------------------
const CODE_GS = `/**
 * sasha-slides — Google Slides add-on server.
 *
 * GENERATED FILE — do not edit. Emitted by ${GENERATED_BY}; the source of truth is that script
 * (for this file) and mcp/sasha-slides/addon/src/ (for the sidebar). Editing it in the Apps Script
 * editor loses the change on the next build.
 *
 * It authenticates as the SIGNED-IN USER: Apps Script supplies the user's OAuth token through
 * ScriptApp.getOAuthToken(), so there are no .auth/*.json files, no OAuth client to register and no
 * refresh token in browser storage — the user's own Slides/Drive grants apply. That is also what
 * makes the protocol work at all: appProperties are private to the writing OAuth client, so a
 * second client could never see the MCP server's files. See mcp/sasha-slides/PROTOCOL.md,
 * "Discovery is by NAME, not by appProperties" and "The UI vehicle".
 *
 * Twelve functions are exposed to the three HtmlService surfaces through google.script.run. Their
 * request and reply shapes are declared in src/bridge.ts and parsed there; nothing below validates
 * anything.
 */

var SASHA_PROTOCOL_VERSION = 1;
var SASHA_INBOX_FOLDER_NAME = 'Sasha Slides Inbox';
// THE CANDIDATES DIALOG'S SIZE, and it is a REQUEST, not a guarantee: HtmlService clamps
// setWidth/setHeight to the browser window.
//
// WIDTH 1000, so it fits inside a 1366-wide laptop viewport with the Slides window chrome. Two
// columns then measure ~480px per cell (confirmed at 468.5px in the browser smoke test) -- 1.6x
// the whole old 300px sidebar, which is what makes a candidate readable rather than a thumbnail.
//
// HEIGHT 760, chosen by measuring rather than by taste: two rows of 16:9 cells plus the header,
// the view toggle and the footer need ~600px of grid, and 700 left the second row's caption below
// the fold (seen in the smoke screenshot). Four candidates visible at once is the entire reason
// this surface exists, so the height is set to fit them. A shorter window clamps it and THE GRID
// SCROLLS -- never the shell, and never the footer (picker-styles.ts).
var SASHA_DIALOG_WIDTH = 1000;
var SASHA_DIALOG_HEIGHT = 760;
// The DEFECT-REPORT window. Wider and taller than the slides window because its whole content is
// a three-column before/after table that the 300px sidebar could not hold and the grid should not
// share (UI-CONTRACT.md, "The review surface").
var SASHA_REPORT_WIDTH = 1100;
var SASHA_REPORT_HEIGHT = 800;
var SASHA_DEFAULT_PAGE_SIZE = 100;
// WHICH CANDIDATE THE REPORT WINDOW WAS OPENED ON, parked between documents that cannot talk to
// each other. Whoever pressed the button writes it (sashaOpenDefectReport) and the report window
// reads it exactly once (sashaTakeReportTarget). UserProperties rather than a template parameter:
// the page is one big inlined <script> and running it through HtmlService's templating engine
// would put a scriptlet scanner over 400 KB of minified JavaScript for no gain.
var SASHA_REPORT_TARGET_KEY = 'sashaReportTarget';
/** Which candidate the slides window should come up on, when the sidebar asked for a specific one. */
var SASHA_PICKER_TARGET_KEY = 'sashaPickerTarget';
// The \`events/\` subfolder of a proposal folder (PROTOCOL.md). One file per event, created never
// appended: Drive has no append, so a read-modify-write from two writers loses one of them.
var SASHA_EVENTS_FOLDER_NAME = 'events';
var SASHA_DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
// Drive's comments.list returns NOTHING without an explicit \`fields\`; replies only come back
// when they are asked for by name. Parsed by parseReadFeedbackReply (src/bridge.ts).
var SASHA_COMMENT_FIELDS =
  'comments(id,content,createdTime,resolved,author/displayName,replies(id,content,createdTime,author/displayName))';

// ---------------------------------------------------------------------------
// Menu + sidebar
// ---------------------------------------------------------------------------

/**
 * createMenu(), not createAddonMenu(): a plain top-level menu shows reliably for a container-BOUND
 * script, while createAddonMenu() is for PUBLISHED editor add-ons and stays hidden for an
 * unpublished bound one.
 *
 * onOpen is a SIMPLE trigger, so it runs WITHOUT data scopes — SlidesApp.getActivePresentation()
 * throws here. Only getUi() (the script.container.ui scope) is available.
 *
 * EXACTLY ONE ITEM: Ask Sasha (UI-CONTRACT.md). A menu that lists surfaces makes the user assemble
 * the product themselves — "open the conversation" and "candidate slides" were two halves of one
 * thing. The slides window is opened BY the conversation (automatically when slides arrive, and
 * from its "See the slides" button after that), and the defect report by a button in either.
 */
function onOpen(e) {
  SlidesApp.getUi()
    .createMenu('SashaSlides')
    .addItem('Ask Sasha', 'showSidebar')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  var page = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Ask Sasha');
  SlidesApp.getUi().showSidebar(page);
}

/**
 * The candidates window. MODELESS, not modal, and that is the whole point: a modal dialog freezes
 * the deck behind it, and the user is comparing a candidate against the deck it is going into.
 * Modeless also leaves the sidebar usable while this is open — they are separate documents with
 * separate lifetimes, so the conversation keeps running (UI-CONTRACT.md).
 */
function showPicker() {
  var page = HtmlService.createHtmlOutputFromFile('Dialog')
    .setWidth(SASHA_DIALOG_WIDTH)
    .setHeight(SASHA_DIALOG_HEIGHT);
  SlidesApp.getUi().showModelessDialog(page, 'Candidate slides');
}

/** The DEFECT-REPORT window — the third document. Modeless for the same reason as the slides. */
function showReport() {
  var page = HtmlService.createHtmlOutputFromFile('Report')
    .setWidth(SASHA_REPORT_WIDTH)
    .setHeight(SASHA_REPORT_HEIGHT);
  SlidesApp.getUi().showModelessDialog(page, 'Report a conversion defect');
}

// ---------------------------------------------------------------------------
// 1/16 — sashaHello: which deck is this, and what protocol does the server speak.
// The URL rather than the id, so the only parse stays in TypeScript (presentationIdOf).
// ---------------------------------------------------------------------------
function sashaHello() {
  return {
    protocolVersion: SASHA_PROTOCOL_VERSION,
    presentationUrl: SlidesApp.getActivePresentation().getUrl()
  };
}

// ---------------------------------------------------------------------------
// 2/16 — sashaScanInbox: the NAME walk.
//   "Sasha Slides Inbox" (under My Drive) -> every child folder (named for its proposal)
//   -> is there a READY in it, is there a PICK in it
// DriveApp rather than the REST API because the walk is exactly what DriveApp expresses: a
// getFoldersByName on a folder searches that folder's children and nothing else. No appProperties
// anywhere — they are private to the MCP server's client and invisible here.
// ---------------------------------------------------------------------------
function sashaScanInbox(spec) {
  var pageSize = (spec && spec.pageSize) || SASHA_DEFAULT_PAGE_SIZE;
  var inboxes = DriveApp.getRootFolder().getFoldersByName(SASHA_INBOX_FOLDER_NAME);
  if (!inboxes.hasNext()) return { marks: [] };
  var folders = inboxes.next().getFolders();
  var marks = [];
  while (folders.hasNext() && marks.length < pageSize) {
    var folder = folders.next();
    marks.push({
      proposalId: folder.getName(),
      folderId: folder.getId(),
      readyFileId: sashaChildFileId_(folder, 'READY'),
      pickFileId: sashaChildFileId_(folder, 'PICK'),
      createdTime: folder.getDateCreated().toISOString()
    });
  }
  // Oldest first, so a backlog drains in the order Claude produced it.
  marks.sort(function (left, right) { return left.createdTime < right.createdTime ? -1 : left.createdTime > right.createdTime ? 1 : 0; });
  return { marks: marks };
}

function sashaChildFileId_(folder, name) {
  var found = folder.getFilesByName(name);
  return found.hasNext() ? found.next().getId() : null;
}

// ---------------------------------------------------------------------------
// 3/16 — sashaReadText: one primitive, three callers (READY, manifest.json, NN.html).
// Raw text out; every parser and every protocolVersion check is in src/protocol.ts.
// ---------------------------------------------------------------------------
function sashaReadText(spec) {
  return { text: DriveApp.getFileById(spec.fileId).getBlob().getDataAsString('UTF-8') };
}

// ---------------------------------------------------------------------------
// 4/16 — sashaInsert: the image bytes, then the converter's batchUpdate, then the best-effort
// render artifact.
//
// The RAW reply is returned so createdObjectIdsOf (src/drive-api.ts) can read the created ids in
// tested TypeScript. The render artifact is wrapped in try/catch and reported as null on any
// failure, NEVER as a failed insert: by the time it runs the slide is already in the user's deck
// and the user must not be invited to insert it twice.
// ---------------------------------------------------------------------------
function sashaInsert(spec) {
  // Images first: createImage takes a URL that GOOGLE fetches, so a candidate's own bytes have to
  // be somewhere fetchable before the batch runs. See sashaStageImages_ below.
  var staged = [];
  try {
    sashaStageImages_(spec, staged);

    // The ADVANCED SERVICE, not UrlFetchApp to slides.googleapis.com.
    //
    // ScriptApp.getOAuthToken() mints a token for the script's OWN auto-created Cloud project, so a
    // REST call needs the Slides API enabled THERE -- measured: "Google Slides API has not been used
    // in project 342987503423 before or it is disabled". Apps Script proxies the advanced service
    // under its own project, so it needs no Cloud console, which matters because the console is
    // unreachable for accounts without 2-step verification. Declared in appsscript.json as
    // enabledAdvancedServices[].userSymbol = "Slides".
    var batch = Slides.Presentations.batchUpdate({ requests: spec.requests }, spec.presentationId);
    var renderArtifact = null;
    if (spec.render) {
      try {
        renderArtifact = sashaWriteRender_(spec.presentationId, spec.render);
      } catch (renderError) {
        console.warn('sasha-slides: no render artifact: ' + renderError);
      }
    }
    return { batchResponse: batch, renderArtifact: renderArtifact };
  } finally {
    // UNSTAGE, ON EVERY PATH. Slides COPIES an image's bytes during the batchUpdate, so by the time
    // control reaches here nothing in the deck still points at the Drive file -- verified by
    // exporting the page thumbnail AFTER deleting it and seeing the picture still rendered. A
    // PERMANENT delete rather than setTrashed: the point is that the link stops working now, and a
    // file in the bin has not stopped existing. Per file and best effort, because a failed cleanup
    // must never turn a slide that is already in the user's deck into a failed insert.
    for (var released = 0; released < staged.length; released++) {
      try {
        sashaFetchJson_(SASHA_DRIVE_FILES + '/' + encodeURIComponent(staged[released]), { method: 'delete' });
      } catch (unstageError) {
        console.warn('sasha-slides: could not delete the staged image ' + staged[released] + ': ' + unstageError);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// sashaRenderPreviews: what GOOGLE makes of the converter's requests, as pictures.
//
// WHY IT EXISTS. The "Converted" pane used to draw the geometry the converter ASKED for -- labelled
// rectangles -- on the stated grounds that a real thumbnail needs the slide to exist and
// photographing it would mutate the user's deck. The second half is the part that was wrong: it
// does not have to be the USER's deck. This builds a THROWAWAY presentation, applies each
// candidate's requests to its own page, photographs every page and then deletes the whole file.
// What the user compares against their HTML is then the truth rather than a diagram of it.
//
// ONE DECK FOR ALL N, not one per candidate: a presentations.create plus a delete per slide is N
// times the latency and N times the litter for the same pictures.
//
// IT IS BEST EFFORT, PER PAGE. A single candidate whose batch Slides refuses must not cost the
// other three their preview, so every page is tried on its own and a failure comes back as a
// REASON on that index. The deck is deleted in a finally, so a throw mid-way cannot leave it in
// Drive -- the one side effect this function promises not to have.
// ---------------------------------------------------------------------------
function sashaRenderPreviews(spec) {
  var slides = spec && spec.slides ? spec.slides : [];
  if (slides.length === 0) return { previews: [] };

  var created = Slides.Presentations.create({ title: 'sasha-slides preview (temporary)' });
  var presentationId = created.presentationId;
  var previews = [];
  try {
    for (var at = 0; at < slides.length; at++) {
      var slide = slides[at];
      var pageObjectId = 'sashaprev' + at;
      var staged = [];
      try {
        Slides.Presentations.batchUpdate(
          { requests: [{ createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: 'BLANK' } } }] },
          presentationId
        );
        // The same staging the real insert does: createImage takes a URL GOOGLE fetches, so a
        // candidate's own data: URI has to become a fetchable file first (sashaStageImages_).
        var staging = { requests: slide.requests, render: null };
        sashaStageImages_(staging, staged);
        for (var r = 0; r < staging.requests.length; r++) {
          sashaRetargetToPage_(staging.requests[r], pageObjectId);
        }
        Slides.Presentations.batchUpdate({ requests: staging.requests }, presentationId);

        var thumb = Slides.Presentations.Pages.getThumbnail(presentationId, pageObjectId, {
          'thumbnailProperties.mimeType': 'PNG',
          'thumbnailProperties.thumbnailSize': 'MEDIUM'
        });
        // The contentUrl is a short-lived Google URL. Fetching the bytes HERE and returning a
        // data: URI keeps the picture working inside the HtmlService sandbox, which cannot be
        // relied on to carry the right cookies to googleusercontent.
        var png = UrlFetchApp.fetch(thumb.contentUrl).getBlob().getBytes();
        previews.push({
          index: slide.index,
          dataUri: 'data:image/png;base64,' + Utilities.base64Encode(png),
          message: null
        });
      } catch (pageError) {
        previews.push({ index: slide.index, dataUri: null, message: String(pageError).slice(0, 300) });
      } finally {
        for (var released = 0; released < staged.length; released++) {
          try {
            sashaFetchJson_(SASHA_DRIVE_FILES + '/' + encodeURIComponent(staged[released]), { method: 'delete' });
          } catch (unstageError) {
            console.warn('sasha-slides: could not delete the staged image ' + staged[released] + ': ' + unstageError);
          }
        }
      }
    }
    return { previews: previews };
  } finally {
    try {
      DriveApp.getFileById(presentationId).setTrashed(true);
    } catch (dropError) {
      console.warn('sasha-slides: could not remove the preview deck ' + presentationId + ': ' + dropError);
    }
  }
}

// ---------------------------------------------------------------------------
// sashaRetargetToPage_: the converter named a page id of its own, this deck has another.
//
// Every request the converter emits carries the pageObjectId it was told to use. The preview deck
// makes its own pages, so each request has to be pointed at the page it is actually being applied
// to -- otherwise the batch is refused for naming an object that does not exist.
// ---------------------------------------------------------------------------
function sashaRetargetToPage_(request, pageObjectId) {
  var createShape = request.createShape;
  if (createShape && createShape.elementProperties) createShape.elementProperties.pageObjectId = pageObjectId;
  var createTable = request.createTable;
  if (createTable && createTable.elementProperties) createTable.elementProperties.pageObjectId = pageObjectId;
  var createImage = request.createImage;
  if (createImage && createImage.elementProperties) createImage.elementProperties.pageObjectId = pageObjectId;
  var createLine = request.createLine;
  if (createLine && createLine.elementProperties) createLine.elementProperties.pageObjectId = pageObjectId;
  var createVideo = request.createVideo;
  if (createVideo && createVideo.elementProperties) createVideo.elementProperties.pageObjectId = pageObjectId;
  var createSheetsChart = request.createSheetsChart;
  if (createSheetsChart && createSheetsChart.elementProperties) createSheetsChart.elementProperties.pageObjectId = pageObjectId;
}

// ---------------------------------------------------------------------------
// 16/16 -- sashaStageImages_: an image's BYTES, somewhere Google's fetcher can reach them.
//
// createImage takes a URL and GOOGLE fetches it, from Google's own servers, WITHOUT the signed-in
// user's credentials. A candidate slide is self-contained (PROTOCOL.md), so its pictures are data:
// URIs with nothing to fetch. Every claim below was measured against the live API, with the exact
// error quoted -- the measurements and the decision both live in converter/slide-image.ts:
//
//   * a data: URI IS accepted, but the whole url is capped ("The URL must be 2K bytes or less"),
//     which is about a 1.5 KB icon. Those never reach here: the converter puts them straight in
//     createImage.url and this function leaves them alone.
//   * a PRIVATE Drive file is not fetchable in ANY url shape ("Access to the provided image was
//     forbidden" / "There was a problem retrieving the image"). The user's token does not travel.
//   * with the file shared, drive.google.com/uc?id=<id> works first time, no propagation wait.
//
// NOTHING HERE DECIDES ANYTHING. The file name, the mime type and the base64 payload all arrive on
// the request that needs them, computed in converter/slide-image.ts under its own tests, exactly as
// RenderRequest's names and tags do. This uploads what it was given, makes it fetchable, writes the
// URL into the request it rode on, and removes the sidecar so the request is wire-legal again.
//
// THE SHARE IS THE NARROWEST ONE THAT WORKS AND IT LASTS ONE CALL. ANYONE_WITH_LINK/VIEW is
// link-only -- the file is never listed, searchable or discoverable -- and sashaInsert's finally
// deletes the file as soon as the batch has run, so the window is the length of one batchUpdate.
//
// THE staged ARRAY IS AN OUT PARAMETER rather than a return value, for one reason: if an upload
// throws halfway through, the ids collected so far are already in the caller's array and still get
// deleted. A return value would lose exactly the files that most need cleaning up.
// ---------------------------------------------------------------------------
function sashaStageImages_(spec, staged) {
  var requests = spec.requests || [];
  for (var at = 0; at < requests.length; at++) {
    var instruction = requests[at].sashaStageImage;
    if (!instruction) continue;
    var blob = Utilities.newBlob(
      Utilities.base64Decode(instruction.base64),
      instruction.mimeType,
      instruction.fileName
    );
    // The proposal folder when this insert already knows one, My Drive otherwise: a file that
    // somehow outlives the finally is then sitting next to the proposal that asked for it.
    var file = spec.render
      ? DriveApp.getFolderById(spec.render.folderId).createFile(blob)
      : DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    staged.push(file.getId());
    requests[at].createImage.url = 'https://drive.google.com/uc?id=' + file.getId();
    delete requests[at].sashaStageImage;
  }
}

function sashaWriteRender_(presentationId, render) {
  // Advanced service here too, for the same reason as sashaInsert.
  var described = Slides.Presentations.Pages.getThumbnail(presentationId, render.pageObjectId, {
    'thumbnailProperties.mimeType': 'PNG',
    'thumbnailProperties.thumbnailSize': 'LARGE'
  });
  if (!described.contentUrl) throw new Error('thumbnail reply carried no contentUrl');
  // contentUrl is a short-lived, unauthenticated googleusercontent.com link — no Authorization.
  var png = UrlFetchApp.fetch(described.contentUrl).getBlob().setName(render.fileName);
  var parent = DriveApp.getFolderById(render.folderId);
  var existing = parent.getFoldersByName(render.folderName);
  var folder = existing.hasNext() ? existing.next() : parent.createFolder(render.folderName);
  var file = folder.createFile(png);
  sashaTag_(file.getId(), render.fileAppProperties);
  return render.fileName;
}

// ---------------------------------------------------------------------------
// 5/16 — sashaWritePick: the one file the picker is allowed to create.
// The BODY arrives already serialized and already validated (serializePick, src/protocol.ts).
// ---------------------------------------------------------------------------
function sashaWritePick(spec) {
  var blob = Utilities.newBlob(spec.body, spec.mimeType, spec.name);
  var file = DriveApp.getFolderById(spec.folderId).createFile(blob);
  sashaTag_(file.getId(), spec.appProperties);
  return { fileId: file.getId() };
}

// ---------------------------------------------------------------------------
// 6/16 — sashaReadEvents: ONE PROPOSAL'S WHOLE SESSION LOG, raw.
//
// \`<proposalId>/events/\` holds one JSON file per event, named \`<millis>-<6 base36>-<kind>.json\`
// (PROTOCOL.md). Every file's NAME and BYTES come back; the ordering, the name grammar and the
// per-event parse all live in src/session-log.ts, which is also where an unknown kind becomes an
// opaque line instead of a dropped one. Nothing here filters or sorts.
//
// A MISSING events/ FOLDER IS AN EMPTY LIST, not an error: a proposal staged by an older server
// has no log, and the conversation must still render the comments and the messages it does have.
// ---------------------------------------------------------------------------
function sashaReadEvents(spec) {
  var pageSize = (spec && spec.pageSize) || SASHA_DEFAULT_PAGE_SIZE;
  var folders = DriveApp.getFolderById(spec.folderId).getFoldersByName(SASHA_EVENTS_FOLDER_NAME);
  if (!folders.hasNext()) return { events: [] };
  var files = folders.next().getFiles();
  var events = [];
  while (files.hasNext() && events.length < pageSize) {
    var file = files.next();
    // The ID as well as the name: it is the last tie-break of the event sort (session-log.ts),
    // because two writers can mint the same millisecond and the same random suffix, and Drive
    // allows duplicate names. Two keys would order differently from the server.
    events.push({
      fileId: file.getId(),
      name: file.getName(),
      text: file.getBlob().getDataAsString('UTF-8')
    });
  }
  return { events: events };
}

// ---------------------------------------------------------------------------
// 7/16 — sashaWriteEvent: ONE event file, CREATED.
//
// There is no update path and there is no append, by design: Drive has no append, so a single
// events.jsonl would mean read-modify-write from two writers that cannot see each other — the MCP
// server and this add-on — and the loser's event would vanish. A create cannot clobber, which is
// why the name carries the millisecond and a random suffix (computed in TypeScript).
//
// The events/ folder is created on demand, because the add-on may write the first event of a
// proposal the server staged without one.
// ---------------------------------------------------------------------------
function sashaWriteEvent(spec) {
  var parent = DriveApp.getFolderById(spec.folderId);
  var existing = parent.getFoldersByName(SASHA_EVENTS_FOLDER_NAME);
  var folder = existing.hasNext() ? existing.next() : parent.createFolder(SASHA_EVENTS_FOLDER_NAME);
  var blob = Utilities.newBlob(spec.body, spec.mimeType, spec.name);
  return { fileId: folder.createFile(blob).getId() };
}

// ---------------------------------------------------------------------------
// 8/16 — sashaCandidateComments: the comment threads on each CANDIDATE file.
//
// Comments live on \`NN.html\`, not on the presentation, because the point is to mark a slide up
// BEFORE it is inserted (PROTOCOL.md). This is the ONE source both surfaces read for the
// unresolved counts, which is what makes them agree.
//
// PER-FILE ERRORS, NOT ONE VERDICT. Drive answers per file, so file 3 can fail after 1 and 2
// succeeded; reporting each one lets slide 2's badge say "could not be read" while slide 1's shows
// 3. Collapsing that into one failure — or worse, into an empty list — is precisely the "showing
// zero when you cannot reach it" failure the contract forbids.
// ---------------------------------------------------------------------------
function sashaCandidateComments(spec) {
  var pageSize = (spec && spec.pageSize) || SASHA_DEFAULT_PAGE_SIZE;
  var files = [];
  for (var at = 0; at < spec.fileIds.length; at++) {
    var fileId = spec.fileIds[at];
    try {
      files.push({ fileId: fileId, comments: sashaListComments_(fileId, pageSize), error: null });
    } catch (commentError) {
      files.push({ fileId: fileId, comments: [], error: String(commentError) });
    }
  }
  return { files: files };
}

// ---------------------------------------------------------------------------
// 9/16 — sashaSendFeedback: the user's words, as NATIVE GOOGLE DRIVE COMMENTS.
//
// TWO JOBS, ONE FUNCTION, and the difference is only which FILE is passed: a conversation message
// is a comment on the PRESENTATION, and a mark-up is a comment on the CANDIDATE's own NN.html.
// Nothing here knows which; the caller decides, which is what keeps "review happens before
// inserting, on the candidates" a decision in TypeScript.
//
// One Drive comment per note. The BODY arrives already rendered and already validated
// (feedbackCommentContent, src/feedback.ts) — it carries the user's words, then one sentinel line
// with the protocolVersion, the pageObjectId and the fractional region. Nothing here composes,
// formats or checks any of that; the server half of the product parses the same bodies back out and
// answers by REPLYING to the thread.
//
// PER-COMMENT RESULTS, not one verdict: Drive has no batch endpoint for comments, so comment 3 can
// fail after 1 and 2 landed. Reporting each one lets sendOutcomeOf (src/feedback.ts) tell the user
// exactly how far it got instead of implying nothing happened. A throw is caught and reported in
// place for the same reason — losing the results of the comments that DID land would be worse than
// the failure itself.
//
// No anchor field: Drive's comment \`anchor\` is an opaque per-application region descriptor whose
// shape is undocumented for a Slides file, so the region travels in the text. See src/feedback.ts.
// ---------------------------------------------------------------------------
function sashaSendFeedback(spec) {
  var results = [];
  for (var at = 0; at < spec.comments.length; at++) {
    try {
      var created = Drive.Comments.create({ content: spec.comments[at].content }, spec.fileId, { fields: 'id' });
      results.push({ commentId: created.id ? created.id : null, error: null });
    } catch (commentError) {
      results.push({ commentId: null, error: String(commentError) });
    }
  }
  return { results: results };
}

// ---------------------------------------------------------------------------
// 10/16 — sashaReadFeedback: the deck's comment threads, raw.
//
// EVERY comment on the presentation comes back, not just ours: telling them apart is reading the
// sentinel, which is feedbackThreadsOf's job (src/feedback.ts) — a comment with no sentinel is a
// human's own and is skipped there, silently and on purpose. The agent's answers are the \`replies\`
// of our own threads, which is why \`fields\` names them.
// ---------------------------------------------------------------------------
function sashaReadFeedback(spec) {
  return { comments: sashaListComments_(spec.fileId, spec.pageSize) };
}

// COMMENTS GO THROUGH THE ADVANCED DRIVE SERVICE, never UrlFetchApp. MEASURED 2026-10-04: the
// sidebar's polling spent the script's DAILY UrlFetch quota ("Service invoked too many times for
// one day: urlfetch"), after which every comment read failed until Google's daily reset and no
// thread card could render. An advanced service call is billed to the Drive API's own quota, not
// to UrlFetch, so a busy conversation cannot lock the user out of their own comments for a day.
/** One page of a file's comment threads, with the replies named in SASHA_COMMENT_FIELDS. */
function sashaListComments_(fileId, pageSize) {
  var listed = Drive.Comments.list(fileId, { pageSize: pageSize, fields: SASHA_COMMENT_FIELDS });
  return listed.comments ? listed.comments : [];
}

// ---------------------------------------------------------------------------
// 11/16 — sashaReplyComment: the user's words, as a REPLY in a thread that already exists.
//
// The card in Ask Sasha answers a thread where it lives: a deck message on the presentation, a
// mark-up on the candidate's own NN.html — the caller passes that file, as with sashaSendFeedback.
// The content is the user's own words and nothing else: no sentinel line, because nothing has to
// parse a region back out of a reply (src/bridge.ts, ReplyCommentSpec).
//
// THROWS on a Drive refusal rather than returning an error field: it is ONE post, so there is no
// partial result to keep, and the failure handler is what turns it into a visible line on the card.
// ---------------------------------------------------------------------------
function sashaReplyComment(spec) {
  return sashaPostReply_(spec.fileId, spec.commentId, { content: sashaReplyText_(spec) });
}

// ---------------------------------------------------------------------------
// 12/16 — sashaReplyToComment: the SAME post, for a caller that names the field \`text\`.
//
// Two names for one Drive call is a MIGRATION and not a design: the sidebar's conversation still
// calls sashaReplyComment with \`content\`, the slides window's thread rail calls this with \`text\`,
// and both land on sashaPostReply_. Delete the older one once sidebar.tsx has moved over -- keeping
// both is only safe because neither has any behaviour of its own (src/bridge.ts, CommentReplySpec).
// ---------------------------------------------------------------------------
function sashaReplyToComment(spec) {
  return sashaPostReply_(spec.fileId, spec.commentId, { content: sashaReplyText_(spec) });
}

// ---------------------------------------------------------------------------
// 13/16 — sashaResolveComment: Google's "Mark as resolved and hide discussion".
//
// Drive has no resolve endpoint: a resolve IS a reply carrying action "resolve", which is also how
// Google's own pane does it. Drive refuses a reply with no content, so an empty one becomes
// "Resolved." here — the one default in this file, because it is a fact about Drive's API rather
// than a decision about the product.
//
// ONE function for both surfaces, unlike the reply above, because the name did not have to change:
// sashaReplyText_ reads whichever field the caller named.
// ---------------------------------------------------------------------------
function sashaResolveComment(spec) {
  var content = sashaReplyText_(spec) ? sashaReplyText_(spec) : 'Resolved.';
  return sashaPostReply_(spec.fileId, spec.commentId, { content: content, action: 'resolve' });
}

/** The note to post, under whichever name the calling surface gave it (src/bridge.ts). */
function sashaReplyText_(spec) {
  if (spec.text) return spec.text;
  return spec.content ? spec.content : '';
}

/**
 * One POST to a comment's replies; answers with the new reply's id and whether the thread is now
 * closed (parsePostedReply, src/bridge.ts).
 *
 * \`resolved\` IS READ BACK FROM DRIVE, never assumed from which function called this. Drive echoes
 * the \`action\` it actually applied on the created reply, so asking for that field costs nothing and
 * is the honest answer -- the same discipline as the server's own path (feedback/feedback.ts, which
 * re-reads the thread because \`Comment.resolved\` is output-only). A resolve Drive declined to apply
 * therefore reports \`resolved: false\` instead of a card that says "resolved" over an open thread.
 */
function sashaPostReply_(fileId, commentId, body) {
  var created = Drive.Replies.create(body, fileId, commentId, { fields: 'id,action' });
  return { replyId: created.id ? created.id : '', resolved: created.action === 'resolve' };
}

// ---------------------------------------------------------------------------
// 14/16 — sashaOpenPicker: the CONVERSATION asking the host to show the slides window.
//
// This is the only function whose point is a side effect on the Slides UI rather than data, and it
// exists because the two surfaces cannot talk to each other: showModelessDialog is a server-side
// SlidesApp.getUi() call, so no amount of JavaScript in the sidebar's sandboxed iframe can open the
// dialog, and there is no window handle to pass between them (PROTOCOL.md's sibling, UI-CONTRACT.md:
// "They share nothing — not state, not storage").
//
// It RETURNS { opened: true } rather than nothing, for the same reason every other function returns
// something: parseOpenPickerReply (src/bridge.ts) insists on that exact field, so a stale deploy or
// a host that declined becomes a line on the sidebar's screen instead of a button that silently
// does nothing. The dialog's size is decided here, next to the call that uses it.
// ---------------------------------------------------------------------------
function sashaOpenPicker(spec) {
  /*
   * AN OPTIONAL TARGET, recorded the same way the report's is.
   *
   * The sidebar and the slides window are separate HtmlService documents that share nothing but
   * the server, so "open the slides ON this candidate" cannot be an argument to the window --
   * it is left on the server for the window to collect (sashaTakePickerTarget). Without it the
   * window opens where it last was, which for a comment about slide 3 means hunting for slide 3.
   */
  var properties = PropertiesService.getUserProperties();
  if (spec && spec.proposalId) {
    properties.setProperty(
      SASHA_PICKER_TARGET_KEY,
      JSON.stringify({ proposalId: spec.proposalId, slideIndex: spec.slideIndex || null })
    );
  } else {
    // ASKED FOR THE WHOLE SET: clear any older target, or the window would come up on one slide.
    properties.deleteProperty(SASHA_PICKER_TARGET_KEY);
  }
  showPicker();
  return { opened: true };
}

/**
 * Which candidate the slides window was asked to open on, and READING CLEARS IT -- so reopening
 * the window later comes up on the grid rather than on a slide the user finished with.
 */
function sashaTakePickerTarget() {
  var properties = PropertiesService.getUserProperties();
  var raw = properties.getProperty(SASHA_PICKER_TARGET_KEY);
  properties.deleteProperty(SASHA_PICKER_TARGET_KEY);
  if (!raw) return { proposalId: null, slideIndex: null };
  try {
    var parsed = JSON.parse(raw);
    return { proposalId: parsed.proposalId || null, slideIndex: parsed.slideIndex || null };
  } catch (targetError) {
    console.warn('sasha-slides: could not read the picker target: ' + targetError);
    return { proposalId: null, slideIndex: null };
  }
}

// ---------------------------------------------------------------------------
// 15/16 — sashaOpenDefectReport + sashaTakeReportTarget: the REPORT WINDOW, and which slide.
//
// A THIRD DOCUMENT, not a mode of the slides window — see src/report-state.ts for why (the
// anonymiser is the heaviest code in the product and Dialog.html has a hard size ceiling).
//
// The target has to be RECORDED before the window is shown: the report is a separate HtmlService
// document with no channel back to whoever opened it, so the only way to tell it which candidate
// is to leave the answer on the server and let it ask. UI-CONTRACT.md: "They share nothing".
//
// READING CLEARS IT, which is the whole contract: a report window opened later comes up on the
// first staged candidate rather than on a slide the user finished with yesterday. Both return
// { opened: true } / an object, because parseOpenPickerReply and parseReportTargetReply insist on
// the field — so a stale deploy becomes a line on screen rather than a button that does nothing.
// ---------------------------------------------------------------------------
function sashaOpenDefectReport(spec) {
  sashaSetReportTarget_(spec);
  // showDialog is false when the caller already opened a real second window. Showing the dialog
  // then would EVICT the Candidate slides window -- Slides hosts exactly one -- which is the
  // defect this path exists to fix. Undefined means an older caller: show it, as before.
  if (spec.showDialog !== false) showReport();
  return { opened: true };
}

// ---------------------------------------------------------------------------
// A SECOND WINDOW, which Slides itself cannot give.
//
// MEASURED 2026-10-04: showModelessDialog hosts exactly ONE dialog, so opening the report
// EVICTED the Candidate slides window -- the user pressed "Report a defect" and the slides they
// were reporting on disappeared, which reads as the same popup reloading. A web-app deployment
// is the only surface Apps Script offers that is a separate browser window; doGet serves the
// same Report document there.
//
// It returns null until the script is deployed as a web app. The caller falls back to the dialog,
// so nothing breaks before the deployment and nothing has to be configured after it.
// ---------------------------------------------------------------------------
function sashaReportWindowUrl() {
  try {
    var url = ScriptApp.getService().getUrl();
    return { url: url || null };
  } catch (error) {
    return { url: null };
  }
}

/** The web-app entry point. The target was recorded by sashaOpenDefectReport, as for the dialog. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Report')
    .setTitle('Report a conversion defect')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function sashaTakeReportTarget() {
  var properties = PropertiesService.getUserProperties();
  var raw = properties.getProperty(SASHA_REPORT_TARGET_KEY);
  properties.deleteProperty(SASHA_REPORT_TARGET_KEY);
  if (!raw) return { proposalId: null, slideIndex: null };
  try {
    var parsed = JSON.parse(raw);
    return { proposalId: parsed.proposalId || null, slideIndex: parsed.slideIndex || null };
  } catch (targetError) {
    console.warn('sasha-slides: could not read the report target: ' + targetError);
    return { proposalId: null, slideIndex: null };
  }
}

/**
 * Best effort, deliberately. If UserProperties is ever unavailable to this script the HANDOFF
 * degrades -- the report window comes up on the first staged candidate and SAYS SO
 * (describeChosenTarget) -- but the window must still open. A failed hint may never swallow the
 * thing the user asked for.
 */
function sashaSetReportTarget_(spec) {
  try {
    PropertiesService.getUserProperties().setProperty(
      SASHA_REPORT_TARGET_KEY,
      JSON.stringify({ proposalId: (spec && spec.proposalId) || null, slideIndex: (spec && spec.slideIndex) || null })
    );
  } catch (targetError) {
    console.warn('sasha-slides: could not record the report target: ' + targetError);
  }
}

/**
 * appProperties, best effort. DriveApp cannot set them, so this is a REST PATCH — and it is
 * deliberately non-fatal: appProperties written by THIS OAuth client are private to it, so the MCP
 * server cannot read them anyway. The protocol still specifies the tags, and discovery is by NAME,
 * so a failed tag must never throw away a PICK that is already on disk.
 */
function sashaTag_(fileId, appProperties) {
  if (!appProperties) return;
  try {
    sashaFetchJson_(SASHA_DRIVE_FILES + '/' + encodeURIComponent(fileId), {
      method: 'patch',
      contentType: 'application/json',
      payload: JSON.stringify({ appProperties: appProperties })
    });
  } catch (tagError) {
    console.warn('sasha-slides: could not tag ' + fileId + ': ' + tagError);
  }
}

/** One authorized JSON call as the signed-in user. Throws on anything but 2xx. */
function sashaFetchJson_(url, options) {
  options.headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  options.muteHttpExceptions = true;
  var response = UrlFetchApp.fetch(url, options);
  var status = response.getResponseCode();
  var text = response.getContentText();
  if (status < 200 || status > 299) throw new Error('HTTP ' + status + ': ' + text.slice(0, 400));
  return text ? JSON.parse(text) : {};
}
`;

// ---------------------------------------------------------------------------
// appsscript.json — the four scopes PROTOCOL.md and DEPLOY.md 2c name, and nothing else.
// ---------------------------------------------------------------------------
const APPSSCRIPT_JSON = `${JSON.stringify(
  {
    timeZone: "Etc/UTC",
    exceptionLogging: "STACKDRIVER",
    runtimeVersion: "V8",
    oauthScopes: [
      // presentations: batchUpdate the picked candidate into the active deck.
      "https://www.googleapis.com/auth/presentations",
      // drive (not drive.file): the point of the add-on is that it runs as the USER and can
      // therefore see the files the MCP server created in that user's Drive. drive.file is
      // per-app and would show the add-on nothing.
      "https://www.googleapis.com/auth/drive",
      // script.container.ui: the Extensions menu, showSidebar() and showModelessDialog().
      "https://www.googleapis.com/auth/script.container.ui",
      // script.external_request: UrlFetchApp, for presentations:batchUpdate, the page thumbnail
      // and the appProperties PATCH.
      "https://www.googleapis.com/auth/script.external_request",
    ],
    dependencies: {
      enabledAdvancedServices: [
        // Declared so Apps Script auto-enables the Slides API in the script's GCP project; without
        // it a fresh deploy 403s on the UrlFetchApp calls to slides.googleapis.com.
        { userSymbol: "Slides", serviceId: "slides", version: "v1" },
        // Drive comments (list, create, reply, resolve) go through this rather than UrlFetchApp,
        // so they draw on the Drive API's quota instead of the script's daily UrlFetch quota.
        { userSymbol: "Drive", serviceId: "drive", version: "v3" },
      ],
    },
  },
  null,
  2,
)}\n`;

async function main(): Promise<void> {
  // 1. THE GATE, before anything is emitted. Two projects: the shipped sources (browser types only)
  //    and the tests (which may also see @types/node). Both must be clean.
  const tsc = findBinary("tsc");
  for (const project of TYPECHECK_PROJECTS) {
    process.stdout.write(`typecheck  ${project}\n`);
    execFileSync(tsc, ["--noEmit", "-p", join(HERE, project)], { stdio: "inherit" });
  }

  // 2. The extractor, compiled exactly as the renderer compiles it (convert-pptx-io.ts:67-71) --
  //    a bare IIFE source string. It is a SCRIPT, not a module (no `export`), so the bundler is
  //    the only thing that can carry it; the converter runs it inside its staging iframe.
  const extractorTs = readFileSync(join(REPO_ROOT, "renderer/html2slides/extract-dom.ts"), "utf-8");
  // MINIFIED, and that is a size decision with a measurement behind it: base64 costs 33% on top of
  // whatever it wraps, so every byte here costs 1.33 in the two bundles that carry it. Un-minified
  // it was 93 KB -> 125 KB of base64, which is a quarter of Dialog.html's entire budget. The
  // extractor is a self-contained IIFE that reads the DOM and never looks at a function's `.name`
  // or its `toString()`, so renaming is safe -- and the browser smoke test converts a real
  // candidate through this exact base64 path, so a mangled extractor fails a test rather than a
  // user's slide.
  const extractorJs = transformSync(extractorTs, { loader: "ts", target: "es2020", minify: true }).code;
  // Base64, not a raw string literal. HtmlService sanitises and relays the sidebar document, and a
  // large inlined blob has been observed to come back corrupted ("Uncaught SyntaxError: Invalid or
  // unexpected token" -- see renderer/html2slides/browser/build-addon.ts step 3). Base64 narrows
  // the whole payload to [A-Za-z0-9+/=], which nothing in that pipeline can mangle; the 33% growth
  // is the price. sidebar.tsx decodes it with atob + TextDecoder.
  const extractorBase64 = Buffer.from(extractorJs, "utf-8").toString("base64");
  process.stdout.write(
    `extractor  extract-dom.ts -> ${extractorJs.length.toLocaleString()} bytes JS` +
      ` -> ${extractorBase64.length.toLocaleString()} bytes base64\n`,
  );

  // 3. THREE BUNDLES, one per document. IIFE, because each is inlined into one <script>.
  //
  //    The EXTRACTOR goes to the two that convert: `__SASHA_EXTRACTOR_JS_B64__` is referenced from
  //    dialog.tsx and report.tsx, never from sidebar.tsx, so the conversation's bundle neither
  //    needs nor contains the blob. The ANONYMISER goes only to report.tsx. That is the whole
  //    reason the three differ so much in size -- see the printed figures below, and the ceiling
  //    they exist to stay under.
  const dialogJs = await bundleSurface({
    entry: join(HERE, "src", "dialog.tsx"),
    define: {
      "process.env.NODE_ENV": '"production"',
      __SASHA_EXTRACTOR_JS_B64__: JSON.stringify(extractorBase64),
    },
  });
  const reportJs = await bundleSurface({
    entry: join(HERE, "src", "report.tsx"),
    define: {
      "process.env.NODE_ENV": '"production"',
      __SASHA_EXTRACTOR_JS_B64__: JSON.stringify(extractorBase64),
    },
  });
  const sidebarJs = await bundleSurface({
    entry: join(HERE, "src", "sidebar.tsx"),
    define: { "process.env.NODE_ENV": '"production"' },
  });

  // 4. The three pages. No `eval` anywhere and no external <script src>: the Slides editor serves
  //    an HtmlService document from a sandboxed googleusercontent iframe whose CSP forbids
  //    `unsafe-eval`, so the bundle is an inline <script> (which runs synchronously on parse and
  //    does not trip that CSP) and the extractor reaches its staging iframe through the
  //    inline-<script> injection path in converter/convert-html-to-slide-requests.ts -- the same
  //    fallback proven at renderer/html2slides/browser/convert-core.ts:89-113.
  const dialogHtml = surfaceHtml({ from: "src/dialog.tsx", script: dialogJs });
  const reportHtml = surfaceHtml({ from: "src/report.tsx", script: reportJs });
  const sidebarHtml = surfaceHtml({ from: "src/sidebar.tsx", script: sidebarJs });

  // 5. Emit.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "appsscript.json"), APPSSCRIPT_JSON);
  writeFileSync(join(OUT, "Code.gs"), CODE_GS);
  writeFileSync(join(OUT, "Sidebar.html"), sidebarHtml);
  writeFileSync(join(OUT, "Dialog.html"), dialogHtml);
  writeFileSync(join(OUT, "Report.html"), reportHtml);
  process.stdout.write(`\nwrote the Apps Script project to ${OUT}\n`);
  process.stdout.write(`    appsscript.json  (4 scopes)\n`);
  /*
   * CODE.GS IS PARSED BEFORE IT IS EMITTED.
   *
   * It is a template literal in this file, so TypeScript never looks inside it: a stray bracket
   * or a bad `var` shipped happily and only surfaced as a broken add-on after a deploy, with no
   * line number. esbuild parses it here for the price of nothing. V8 is the Apps Script runtime,
   * so plain-script syntax is exactly the right dialect to check against.
   */
  try {
    transformSync(CODE_GS, { loader: "js", format: "iife", target: "es2017" });
  } catch (cause: unknown) {
    throw new Error(`Code.gs does not parse: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const declared = serverFunctionsMissingFrom(CODE_GS);
  if (declared.length > 0) {
    // A name the client can call but Code.gs does not define is the "Script function not found"
    // that explainHostFailure (src/bridge.ts) exists to diagnose at RUNTIME, in a deployed add-on.
    // It is cheaper to refuse to emit.
    throw new Error(`Code.gs does not declare ${declared.join(", ")} -- SERVER_FUNCTION_NAMES lists them as callable`);
  }
  process.stdout.write(
    `    Code.gs          (${CODE_GS.length.toLocaleString()} bytes, ${SERVER_FUNCTION_NAMES.length} server functions)\n`,
  );
  process.stdout.write(`    Sidebar.html     (${kb(sidebarHtml)} KB, Ask Sasha -- the conversation)\n`);
  process.stdout.write(`    Dialog.html      (${kb(dialogHtml)} KB, the slides + converter)\n`);
  process.stdout.write(`    Report.html      (${kb(reportHtml)} KB, the defect report + anonymiser)\n`);

  // 6. THE CEILING, enforced rather than hoped for. HtmlService has been observed corrupting a
  //    ~560 KB inlined blob ("Uncaught SyntaxError: Invalid or unexpected token"), and there is no
  //    base64 escape for the page itself because the sandbox's CSP forbids `unsafe-eval`. So a
  //    bundle that grows past the budget fails the BUILD, here, rather than failing in a user's
  //    browser with a syntax error in minified code.
  const tooBig = [
    { name: "Sidebar.html", html: sidebarHtml },
    { name: "Dialog.html", html: dialogHtml },
    { name: "Report.html", html: reportHtml },
  ].filter((page) => page.html.length > SURFACE_BUDGET_BYTES);
  if (tooBig.length > 0) {
    const named = tooBig.map((page) => `${page.name} is ${kb(page.html)} KB`).join(", ");
    throw new Error(
      `${named} -- over the ${(SURFACE_BUDGET_BYTES / 1024).toFixed(0)} KB HtmlService budget. ` +
        "Move code to another surface; do NOT raise this number without new evidence.",
    );
  }
  process.stdout.write(`\nclasp:  cd ${OUT} && clasp push\n`);
}

/** One surface's inlined IIFE bundle. */
async function bundleSurface({
  entry,
  define,
}: {
  entry: string;
  define: Readonly<Record<string, string>>;
}): Promise<string> {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    define: { ...define },
  });
  const text = bundled.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error(`esbuild produced no output for ${entry}`);
  process.stdout.write(`bundle     ${entry.slice(HERE.length + 1)} -> ${text.length.toLocaleString()} bytes JS\n`);
  return text;
}

/**
 * The HtmlService page around one bundle. Identical for every surface; only the script differs.
 *
 * THE BUNDLE IS NOT AN EXECUTABLE <script>. MEASURED 2026-10-04 on the Report web app: HtmlService
 * runs a JavaScript COMMENT STRIPPER over every inline executable script before serving it. It
 * deleted `/* ... *\/` CSS comments inside template strings (harmless) and, having lost track of
 * string state once, deleted `//staged.sasha-slides.invalid/image";...` up to the next newline:
 * 9,803 bytes of code, served as "Uncaught SyntaxError: Invalid or unexpected token". That is the
 * "corruption" the size ceiling below was written against -- it depends on what the bundle
 * contains, not on how big it is, which is why it hit a 453 KB page under the budget.
 *
 * So the bundle travels in a `type="text/plain"` container, which the HTML parser keeps as raw
 * text and nothing treats as JavaScript, and a loader with no comments and no `/` copies it into a
 * real <script> element. Injecting a script element is not eval, so the sandbox's CSP (no
 * `unsafe-eval`) allows it -- the converter's extractor already relies on that path. The loader
 * runs where the inline script used to, at the end of <body>, so the bundle still sees a parsed
 * document.
 */
function surfaceHtml({ from, script }: { from: string; script: string }): string {
  if (/<\/script/i.test(script)) {
    throw new Error(`${from}: the bundle contains "</script", which would end its container early`);
  }
  return `<!DOCTYPE html>
<!-- GENERATED FILE - do not edit. Emitted by ${GENERATED_BY} from ${from}.
     Change the TypeScript source and rebuild; this file is overwritten wholesale. -->
<html>
<head>
<base target="_top">
<meta charset="utf-8">
</head>
<body>
<script type="text/plain" id="${BUNDLE_ELEMENT_ID}">
${script}
</script>
<script>
(function () { var bundle = document.getElementById("${BUNDLE_ELEMENT_ID}"); var run = document.createElement("script"); run.text = bundle.textContent; bundle.remove(); document.body.appendChild(run); })();
</script>
</body>
</html>
`;
}

/** The id of the inert container each page's bundle travels in. See surfaceHtml. */
const BUNDLE_ELEMENT_ID = "sasha-bundle";

/**
 * The callable names SERVER_FUNCTION_NAMES promises that the emitted Code.gs does not define.
 *
 * The list and the generated string are edited in different places, and nothing else compares
 * them: TypeScript cannot see inside a template literal, so a name added to one and not the other
 * builds, deploys, and fails only when a user presses the button. This is that comparison.
 */
function serverFunctionsMissingFrom(code: string): readonly string[] {
  return SERVER_FUNCTION_NAMES.filter((name) => !new RegExp(`^function ${name}\\(`, "m").test(code));
}

function kb(text: string): string {
  return (text.length / 1024).toFixed(0);
}

/** The repo root's binary, or the add-on's own if someone ran npm install here. */
function findBinary(name: string): string {
  for (const base of [join(HERE, "node_modules", ".bin"), join(REPO_ROOT, "node_modules", ".bin")]) {
    const candidate = join(base, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`build-addon.ts: no ${name} -- run 'npm install' at the repo root`);
}

main().catch((cause: unknown) => {
  process.stderr.write(`build-addon failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
