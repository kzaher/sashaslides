/**
 * The Apps Script project's two hand-written files as text: Code.gs and appsscript.json.
 *
 * WHY THEY LIVE HERE, under src/, and not inside build-addon.ts where they started: the unit tests
 * read exactly what ships (the menu item, every function the surfaces call, the scopes), and a
 * string inside the build script could only be checked by running the build. build-addon.ts
 * imports these and writes them out unchanged.
 *
 * Code.gs is plain V8 Apps Script and a THIN ADAPTER (see the banner below): every decision lives
 * in TypeScript and the server; the editor's part is appended from editor-code-gs.ts.
 */
import { editorCodeGs } from "./editor-code-gs.ts";
import { insertionIndexFor } from "./slide-insert.ts";

/** Stamped into every generated file. */
export const GENERATED_BY = "build-addon.ts (mcp/sasha-slides/addon)";
/** Where the deck editor and its API live; a development build points it at a tunnel (SASHA_EDITOR_ORIGIN). */
export const DEFAULT_EDITOR_ORIGIN = "https://sashaslides.com";

/** The whole Code.gs, for one editor origin. */
export function codeGs(options: Readonly<{ editorOrigin: string }>): string {
  return `${CODE_GS_BASE}\n${editorCodeGs({ editorOrigin: options.editorOrigin })}`;
}

// ---------------------------------------------------------------------------
// appsscript.json — the four scopes PROTOCOL.md and DEPLOY.md 2c name, plus the two the editor
// handoff needs (SPEC.md 21.13), and nothing else.
// ---------------------------------------------------------------------------
export const APPS_SCRIPT_MANIFEST = `${JSON.stringify(
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
      // openid + userinfo.email: ScriptApp.getIdentityToken(), which proves to the server WHO opens
      // the editor (SPEC.md 21.13 handoff). Adding them costs every user one re-consent.
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
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

// ---------------------------------------------------------------------------
// Code.gs — the Apps Script server side, as plain V8 JavaScript (the part before the editor's,
// which editor-code-gs.ts appends).
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
const CODE_GS_BASE = `/**
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
 * TWO ITEMS. Ask Sasha (UI-CONTRACT.md) is the conversation: the slides window is opened BY it and
 * the defect report by a button in either, so neither is a menu item. "Open in Sasha editor"
 * (SPEC.md 21.13) is a different thing, the deck's own editor in a dialog, and has no other door.
 */
function onOpen(e) {
  SlidesApp.getUi()
    .createMenu('SashaSlides')
    .addItem('Ask Sasha', 'showSidebar')
    .addItem('Open in Sasha editor', 'sashaOpenEditor')
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
function showPicker(boot) {
  var page = HtmlService.createHtmlOutputFromFile('Dialog')
    .setWidth(SASHA_DIALOG_WIDTH)
    .setHeight(SASHA_DIALOG_HEIGHT);
  // THE SEED (src/picker-seed.ts): what the sidebar already read, plus sashaHello's answer, so the
  // window draws without six round trips. Inert text/plain, like the bundle, so HtmlService's
  // script rewriting never touches it; every '<' is escaped so the JSON cannot end the element.
  if (boot) {
    page.append('<script type="text/plain" id="sasha-seed">' + JSON.stringify(boot).replace(/</g, '\\\\u003c') + '</script>');
  }
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
// 1/14 — sashaHello: which deck is this, and what protocol does the server speak.
// The URL rather than the id, so the only parse stays in TypeScript (presentationIdOf).
// ---------------------------------------------------------------------------
function sashaHello() {
  return {
    protocolVersion: SASHA_PROTOCOL_VERSION,
    presentationUrl: SlidesApp.getActivePresentation().getUrl()
  };
}

// ---------------------------------------------------------------------------
// 2/14 — sashaScanInbox: the NAME walk.
//   "Sasha Slides Inbox" (under My Drive) -> every child folder (named for its proposal)
//   -> is there a READY in it, is there a PICK in it
// DriveApp rather than the REST API because the walk is exactly what DriveApp expresses: a
// getFoldersByName on a folder searches that folder's children and nothing else. No appProperties
// anywhere — they are private to the MCP server's client and invisible here.
// ---------------------------------------------------------------------------
function sashaScanInbox(spec) {
  var pageSize = (spec && spec.pageSize) || SASHA_DEFAULT_PAGE_SIZE;
  // THE REST WALK FIRST: measured 2026-10-11 in one execution, 662 ms for three Drive queries
  // against 1,945 ms for the DriveApp walk below (one call per folder and per marker). It also
  // names each folder's manifest.json, so READY and the manifest can be read in ONE round trip.
  // Any failure falls back to the DriveApp walk, which is the behaviour every caller was built on.
  try {
    return sashaScanInboxRest_(pageSize);
  } catch (restError) {
    console.warn('sasha-slides: REST inbox scan failed, walking with DriveApp: ' + restError);
  }
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

function sashaScanInboxRest_(pageSize) {
  var folderMime = 'application/vnd.google-apps.folder';
  var inboxes = sashaDriveList_(
    "name = '" + SASHA_INBOX_FOLDER_NAME + "' and 'root' in parents and mimeType = '" + folderMime + "' and trashed = false",
    'files(id)', 1
  );
  if (inboxes.length === 0) return { marks: [] };
  var folders = sashaDriveList_(
    "'" + inboxes[0].id + "' in parents and mimeType = '" + folderMime + "' and trashed = false",
    'files(id,name,createdTime)', pageSize
  );
  var byFolder = {};
  // A Drive query has a length limit, so the parents are asked about in chunks.
  for (var start = 0; start < folders.length; start += 40) {
    var parents = folders.slice(start, start + 40).map(function (folder) { return "'" + folder.id + "' in parents"; }).join(' or ');
    sashaDriveList_(
      "(name = 'READY' or name = 'PICK' or name = 'manifest.json') and trashed = false and (" + parents + ")",
      'files(id,name,parents)', 1000
    ).forEach(function (file) {
      (file.parents || []).forEach(function (parent) {
        var found = byFolder[parent] || (byFolder[parent] = {});
        if (!found[file.name]) found[file.name] = file.id;
      });
    });
  }
  var marks = folders.map(function (folder) {
    var found = byFolder[folder.id] || {};
    return {
      proposalId: folder.name,
      folderId: folder.id,
      readyFileId: found['READY'] || null,
      pickFileId: found['PICK'] || null,
      manifestFileId: found['manifest.json'] || null,
      createdTime: folder.createdTime
    };
  });
  marks.sort(function (left, right) { return left.createdTime < right.createdTime ? -1 : left.createdTime > right.createdTime ? 1 : 0; });
  return { marks: marks };
}

/** One Drive files.list page. Inbox-sized results only, so a single page is the whole answer. */
function sashaDriveList_(query, fields, pageSize) {
  var url = SASHA_DRIVE_FILES + '?pageSize=' + pageSize + '&fields=' + encodeURIComponent(fields) +
    '&q=' + encodeURIComponent(query);
  return sashaFetchJson_(url, { method: 'get' }).files || [];
}

function sashaChildFileId_(folder, name) {
  var found = folder.getFilesByName(name);
  return found.hasNext() ? found.next().getId() : null;
}

// ---------------------------------------------------------------------------
// 3/14 — sashaReadText: one primitive, three callers (READY, manifest.json, NN.html).
// Raw text out; every parser and every protocolVersion check is in src/protocol.ts.
// ---------------------------------------------------------------------------
function sashaReadText(spec) {
  return { text: DriveApp.getFileById(spec.fileId).getBlob().getDataAsString('UTF-8') };
}

/**
 * SEVERAL TEXTS IN ONE ROUND TRIP, fetched in parallel. Measured 2026-10-11: five files took
 * 2,723 ms read one after another with DriveApp and 580 ms with UrlFetchApp.fetchAll. A file that
 * fails is reported on its own; it never fails the batch.
 */
function sashaReadTexts(spec) {
  var fileIds = (spec && spec.fileIds) || [];
  var token = ScriptApp.getOAuthToken();
  var responses = UrlFetchApp.fetchAll(fileIds.map(function (fileId) {
    return {
      url: SASHA_DRIVE_FILES + '/' + encodeURIComponent(fileId) + '?alt=media',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    };
  }));
  return {
    texts: responses.map(function (response, at) {
      var status = response.getResponseCode();
      return status >= 200 && status <= 299
        ? { fileId: fileIds[at], text: response.getContentText('UTF-8') }
        : { fileId: fileIds[at], error: 'HTTP ' + status };
    })
  };
}

// ---------------------------------------------------------------------------
// 4/14 — sashaInsert: the image bytes, the new slide's position, then the converter's batchUpdate.
// NOTHING ELSE: the user is waiting on this call, so the render artifact is its own function
// (sashaWriteRender below), called after the window has already said "Inserted".
//
// THE POSITION IS READ HERE, NOW, from the user's own selection: the slide window may have been
// open a while and the user may have clicked another slide since. spec.position is "before",
// "after" or null (a merge, which creates no slide); the index rule is slide-insert.ts
// insertionIndexFor, embedded verbatim below. It sets createSlide.insertionIndex on the FIRST
// request, which insertRequests (src/slide-insert.ts) guarantees is the createSlide.
//
// The RAW reply is returned so createdObjectIdsOf (src/drive-api.ts) can read the created ids in
// tested TypeScript, with insertionIndex (null = appended) so the window can say where it went.
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
    var insertionIndex = spec.position ? sashaPlaceNewSlide_(spec) : null;
    var batch = Slides.Presentations.batchUpdate({ requests: spec.requests }, spec.presentationId);
    return { batchResponse: batch, insertionIndex: insertionIndex };
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

// Where the new slide goes, or null to append. Best effort by design: a selection that cannot be
// read (no slide selected, a layout or master page, another deck) appends exactly as before, and
// the window tells the user that is what happened.
function sashaPlaceNewSlide_(spec) {
  var selected = null;
  var slideCount = 0;
  try {
    var presentation = SlidesApp.getActivePresentation();
    if (presentation && presentation.getId() === spec.presentationId) {
      var slides = presentation.getSlides();
      slideCount = slides.length;
      var page = presentation.getSelection().getCurrentPage();
      var pageId = page ? page.getObjectId() : null;
      for (var at = 0; pageId !== null && at < slides.length; at++) {
        if (slides[at].getObjectId() === pageId) selected = at;
      }
    }
  } catch (selectionError) {
    console.warn('sasha-slides: could not read the selected slide: ' + selectionError);
  }
  var insertionIndex = sashaInsertionIndexFor_({ position: spec.position, selectedSlideIndex: selected, slideCount: slideCount });
  var first = spec.requests[0];
  if (insertionIndex === null || !first || !first.createSlide) return null;
  first.createSlide.insertionIndex = insertionIndex;
  return insertionIndex;
}

// slide-insert.ts insertionIndexFor, VERBATIM (its .toString()), so the rule the unit tests check
// is the rule that runs here. slide-insert.test.ts proves it needs nothing else in scope.
var sashaInsertionIndexFor_ = ${insertionIndexFor.toString()};

// ---------------------------------------------------------------------------
// sashaWriteRender: the inserted page as <proposal>/render/NN.png (PROTOCOL.md "Render artifacts").
//
// ITS OWN CALL, after the window has already said "Inserted". It used to run inside sashaInsert,
// which made the user wait for a thumbnail (0.8-1.2 s measured), its download (0.25-0.3 s) and three
// Drive writes after the slide already existed. Every name and tag arrives computed
// (src/render-artifact.ts). A throw reaches the window as a skipped artifact, never a failed insert.
// ---------------------------------------------------------------------------
function sashaWriteRender(spec) {
  return { renderArtifact: sashaWriteRender_(spec.presentationId, spec.render) };
}

// ---------------------------------------------------------------------------
// sashaPageElements: ONE slide's top-level page elements, back to front, by object id.
//
// A MERGE (src/slide-merge.ts) deletes the existing elements a candidate names and stacks new ones
// against the rest, so it checks those names against the slide as it is NOW, just before its
// batchUpdate. The advanced service, for the same reason as sashaInsert. A page that does not exist
// throws, and that failure reaches the slides window as the reason nothing was changed.
// ---------------------------------------------------------------------------
function sashaPageElements(spec) {
  var page = Slides.Presentations.Pages.get(spec.presentationId, spec.pageObjectId);
  var elements = (page && page.pageElements) || [];
  var objectIds = [];
  var fullPageObjectIds = [];
  // The page size is the presentation's; a partial-response read keeps it to one small field.
  var pageSize = Slides.Presentations.get(spec.presentationId, { fields: "pageSize" }).pageSize;
  var pageWidth = emuOf(pageSize && pageSize.width);
  var pageHeight = emuOf(pageSize && pageSize.height);
  for (var at = 0; at < elements.length; at++) {
    var element = elements[at];
    if (!element || !element.objectId) continue;
    objectIds.push(element.objectId);
    // Covers the page: unrotated, and within 1% of every edge (pptx imports round by an EMU or two).
    var t = element.transform || {};
    var w = emuOf(element.size && element.size.width) * (t.scaleX === undefined ? 1 : t.scaleX);
    var h = emuOf(element.size && element.size.height) * (t.scaleY === undefined ? 1 : t.scaleY);
    var x = t.translateX || 0;
    var y = t.translateY || 0;
    var slackX = pageWidth * 0.01;
    var slackY = pageHeight * 0.01;
    if (pageWidth > 0 && pageHeight > 0 && !t.shearX && !t.shearY &&
        x <= slackX && y <= slackY && x + w >= pageWidth - slackX && y + h >= pageHeight - slackY) {
      fullPageObjectIds.push(element.objectId);
    }
  }
  return { objectIds: objectIds, fullPageObjectIds: fullPageObjectIds };
}

// A Slides Dimension in EMU (the API answers in EMU or PT); 0 when absent.
function emuOf(dimension) {
  if (!dimension || typeof dimension.magnitude !== "number") return 0;
  return dimension.unit === "PT" ? dimension.magnitude * 12700 : dimension.magnitude;
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
// 14/14 -- sashaStageImages_: an image's BYTES, somewhere Google's fetcher can reach them.
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
// 5/14 — sashaWritePick: the one file the picker is allowed to create.
// The BODY arrives already serialized and already validated (serializePick, src/protocol.ts).
// ---------------------------------------------------------------------------
//
// A remote connector holds only drive.file, so it can read only files IT created: it stages an empty
// PICK.slot for this. Write into that and rename it PICK; create PICK only for an older proposal
// without a slot. (Measured 2026-10-12: a PICK created here was invisible to sashaslides.com.)
function sashaWritePick(spec) {
  var folder = DriveApp.getFolderById(spec.folderId);
  var slots = folder.getFilesByName('PICK.slot');
  var file;
  if (slots.hasNext()) {
    file = slots.next();
    file.setContent(spec.body);
    file.setName(spec.name);
  } else {
    file = folder.createFile(Utilities.newBlob(spec.body, spec.mimeType, spec.name));
  }
  sashaTag_(file.getId(), spec.appProperties);
  return { fileId: file.getId() };
}

// ---------------------------------------------------------------------------
// 6/14 — sashaReadEvents: ONE PROPOSAL'S WHOLE SESSION LOG, raw.
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
// 7/14 — sashaWriteEvent: ONE event file, CREATED.
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
// 8/14 — sashaCandidateComments: the comment threads on each CANDIDATE file.
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
// 9/14 — sashaSendFeedback: the user's words, as NATIVE GOOGLE DRIVE COMMENTS.
//
// The caller passes the FILE: a mark-up from the slides window is a comment on the CANDIDATE's own
// NN.html. Nothing here knows which file it is, which is what keeps "review happens before
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
// 10/14 — sashaReplyToComment: the user's words, as a REPLY in a thread that already exists.
//
// The slides window's thread rail answers a thread where it lives: the candidate's own NN.html,
// passed by the caller as with sashaSendFeedback. The text is the user's own words and nothing
// else: no sentinel line, because nothing has to parse a region back out of a reply
// (src/bridge.ts, CommentReplySpec).
//
// THROWS on a Drive refusal rather than returning an error field: it is ONE post, so there is no
// partial result to keep, and the failure handler is what turns it into a visible line.
// ---------------------------------------------------------------------------
function sashaReplyToComment(spec) {
  return sashaPostReply_(spec.fileId, spec.commentId, { content: spec.text ? spec.text : '' });
}

// ---------------------------------------------------------------------------
// 11/14 — sashaResolveComment: Google's "Mark as resolved and hide discussion".
//
// Drive has no resolve endpoint: a resolve IS a reply carrying action "resolve", which is also how
// Google's own pane does it. Drive refuses a reply with no content, so an empty one becomes
// "Resolved." here — the one default in this file, because it is a fact about Drive's API rather
// than a decision about the product.
// ---------------------------------------------------------------------------
function sashaResolveComment(spec) {
  var content = spec.text ? spec.text : 'Resolved.';
  return sashaPostReply_(spec.fileId, spec.commentId, { content: content, action: 'resolve' });
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
// 12/14 — sashaOpenPicker: Ask Sasha asking the host to show the slides window.
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
  // A SEEDED window carries its target in the page (src/picker-seed.ts), so the property round
  // trip is skipped -- measured 30-112 ms of a ~330 ms server execution on 2026-10-11.
  if (spec && spec.seed) {
    showPicker({ hello: sashaHello(), seed: spec.seed });
    return { opened: true };
  }
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
  showPicker(null);
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
// 13/14 — sashaOpenDefectReport + sashaTakeReportTarget: the REPORT WINDOW, and which slide.
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
