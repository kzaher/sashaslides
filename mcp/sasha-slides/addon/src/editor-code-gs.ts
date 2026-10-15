/**
 * The DECK EDITOR's part of Code.gs (SPEC.md 21.13), appended by apps-script-project.ts.
 *
 *   sashaOpenEditor()        the menu item "Open in Sasha editor": the binding secret, the
 *                            revision, the handoff, the import when the server has no deck yet,
 *                            then EditorShell.html in a modeless dialog seeded with the answer
 *   sashaImportAgain(spec)   the shell's "Import again" after `changedSinceImport`
 *   sashaRunExport(exportId) the editor's "Export to this presentation" when the server holds no
 *                            Google grant: fetch the plan, run it with the add-on's own Slides
 *                            authorization one slide per batch, post the result
 *
 * THIN, like the rest of Code.gs: the server decided every request; the two plan instructions
 * (`sashaSlideBoundary`, `sashaSpeakerNotes`, google-slides/slides-requests.ts) are interpreted
 * here because only this side can read the notes shapes' ids after the slides exist.
 *
 * THE BINDING SECRET (SPEC.md 21.13 item 1): document properties are readable only by people who
 * can run this bound script, i.e. the presentation's editors, so possession of the secret proves
 * edit access to THIS presentation. Two `Utilities.getUuid()` values give 244 random bits; the hex
 * is packed into 32 bytes and sent base64url. The server keeps only its SHA-256.
 */
import { ADDON_REQUEST_HEADERS } from "../../engine/src/contracts/deck-api.ts";

/**
 * MEASURED, not chosen: the largest modeless dialog Slides shows (SPEC.md 21.13 "at the largest
 * size Slides accepts"). There is no fixed maximum: Slides CLAMPS the request to the browser
 * window. Measured 2026-10-15 on the development deck (e2e/google-slides-addon-live.ts
 * `open-editor`): a 4000 by 3000 request in a 1599 by 812 window showed a 1327 by 733 dialog whose
 * content frame was 1279 by 649 (the window less 272 by 79 of Slides' own margins and title bar).
 * So the request is "larger than any window" and every person gets the largest their window allows.
 */
export const EDITOR_DIALOG_SIZE: Readonly<{ width: number; height: number; measuredOn: string; measuredIn: string }> = {
  width: 4000,
  height: 3000,
  measuredOn: "2026-10-15",
  measuredIn: "window 1599x812 -> dialog 1327x733, content frame 1279x649",
};

export function editorCodeGs(options: Readonly<{ editorOrigin: string }>): string {
  if (!/^https:\/\/[a-z0-9.-]+$/.test(options.editorOrigin)) throw new Error(`not an https origin: ${options.editorOrigin}`);
  return `
// ---------------------------------------------------------------------------
// The deck editor (SPEC.md 21.13), generated from src/editor-code-gs.ts.
// ---------------------------------------------------------------------------
var SASHA_EDITOR_ORIGIN = '${options.editorOrigin}';
var SASHA_EDITOR_WIDTH = ${EDITOR_DIALOG_SIZE.width};
var SASHA_EDITOR_HEIGHT = ${EDITOR_DIALOG_SIZE.height};
var SASHA_DECK_BINDING_KEY = 'sashaDeckBinding';
/** Slides accepts at most 500 requests per batchUpdate (deck-api.ts AddonExportPlanBody). */
var SASHA_EXPORT_CHUNK = 500;

function sashaOpenEditor() {
  var presentationId = SlidesApp.getActivePresentation().getId();
  var seed;
  try {
    var answer = sashaEditorFetch_('/deck-api/addon/handoff', {
      method: 'post',
      body: {
        identityToken: ScriptApp.getIdentityToken(),
        presentationId: presentationId,
        bindingSecret: sashaBindingSecret_(),
        revisionId: Slides.Presentations.get(presentationId, { fields: 'revisionId' }).revisionId
      }
    });
    if (answer.kind === 'needsImport') {
      var imported = sashaEditorFetch_('/deck-api/addon/import', {
        method: 'post',
        body: { importToken: answer.importToken, presentation: Slides.Presentations.get(presentationId), replaceDeckId: null }
      });
      answer = { kind: 'open', deckId: imported.deckId, ticket: imported.ticket };
    }
    seed = answer;
  } catch (error) {
    seed = { kind: 'failed', message: String((error && error.message) || error) };
  }
  seed.editorOrigin = SASHA_EDITOR_ORIGIN;
  var page = HtmlService.createHtmlOutputFromFile('EditorShell')
    .setWidth(SASHA_EDITOR_WIDTH)
    .setHeight(SASHA_EDITOR_HEIGHT);
  // Inert text/plain, like the bundle; every '<' escaped so the JSON cannot end the element.
  page.append('<script type="text/plain" id="sasha-editor-seed">' + JSON.stringify(seed).replace(/</g, '\\\\u003c') + '</script>');
  SlidesApp.getUi().showModelessDialog(page, 'Sasha editor');
}

function sashaImportAgain(spec) {
  var presentationId = SlidesApp.getActivePresentation().getId();
  var imported = sashaEditorFetch_('/deck-api/addon/import', {
    method: 'post',
    body: { importToken: spec.importToken, presentation: Slides.Presentations.get(presentationId), replaceDeckId: spec.deckId }
  });
  return { deckId: imported.deckId, ticket: imported.ticket };
}

function sashaRunExport(exportId) {
  var presentationId = SlidesApp.getActivePresentation().getId();
  var pages = Slides.Presentations.get(presentationId, { fields: 'slides(objectId)' }).slides || [];
  var headers = {
    '${ADDON_REQUEST_HEADERS.identityToken}': ScriptApp.getIdentityToken(),
    '${ADDON_REQUEST_HEADERS.bindingSecret}': sashaBindingSecret_(),
    '${ADDON_REQUEST_HEADERS.presentationPageIds}': pages.map(function (page) { return page.objectId; }).join(',')
  };
  var path = '/deck-api/addon/export/' + encodeURIComponent(exportId);
  var plan = sashaEditorFetch_(path, { method: 'get', headers: headers });
  var outcome = sashaRunPlan_(plan.presentationId, plan.requests || []);
  sashaEditorFetch_(path + '/result', { method: 'post', headers: headers, body: { outcome: outcome } });
  return { exportId: exportId, outcome: outcome.kind, message: outcome.message || '' };
}

/** One batch per sashaSlideBoundary (in chunks of 500), stopping at the first failure; notes last. */
function sashaRunPlan_(presentationId, requests) {
  var batches = [];
  var notes = [];
  var current = null;
  requests.forEach(function (request) {
    if (request.sashaSlideBoundary) {
      current = { slideNumber: request.sashaSlideBoundary.slideNumber, requests: [] };
      batches.push(current);
      return;
    }
    if (request.sashaSpeakerNotes) {
      notes.push(request.sashaSpeakerNotes);
      return;
    }
    if (!current) {
      current = { slideNumber: 0, requests: [] };
      batches.push(current);
    }
    current.requests.push(request);
  });
  for (var index = 0; index < batches.length; index++) {
    var batch = batches[index];
    for (var start = 0; start < batch.requests.length; start += SASHA_EXPORT_CHUNK) {
      try {
        Slides.Presentations.batchUpdate({ requests: batch.requests.slice(start, start + SASHA_EXPORT_CHUNK) }, presentationId);
      } catch (error) {
        var where = batch.slideNumber ? 'Slide ' + batch.slideNumber + ': ' : '';
        return { kind: 'failed', message: where + String((error && error.message) || error) };
      }
    }
  }
  if (notes.length > 0) {
    var read = Slides.Presentations.get(presentationId, { fields: 'slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))))' });
    var notesIds = {};
    (read.slides || []).forEach(function (slide) {
      var properties = slide.slideProperties && slide.slideProperties.notesPage && slide.slideProperties.notesPage.notesProperties;
      if (properties && properties.speakerNotesObjectId) notesIds[slide.objectId] = properties.speakerNotesObjectId;
    });
    var noteRequests = notes
      .filter(function (note) { return notesIds[note.slideObjectId]; })
      .map(function (note) { return { insertText: { objectId: notesIds[note.slideObjectId], text: note.text, insertionIndex: 0 } }; });
    if (noteRequests.length > 0) Slides.Presentations.batchUpdate({ requests: noteRequests }, presentationId);
  }
  return { kind: 'applied' };
}

function sashaBindingSecret_() {
  var properties = PropertiesService.getDocumentProperties();
  var secret = properties.getProperty(SASHA_DECK_BINDING_KEY);
  if (secret) return secret;
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var bytes = [];
  for (var at = 0; at < hex.length; at += 2) {
    var value = parseInt(hex.substr(at, 2), 16);
    bytes.push(value > 127 ? value - 256 : value);
  }
  secret = Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
  properties.setProperty(SASHA_DECK_BINDING_KEY, secret);
  return secret;
}

/** One JSON call to the Sasha server. Throws the server's own sentence on anything but 2xx. */
function sashaEditorFetch_(path, options) {
  var request = { method: options.method, muteHttpExceptions: true, headers: options.headers || {} };
  if (options.body !== undefined) {
    request.contentType = 'application/json';
    request.payload = JSON.stringify(options.body);
  }
  var response = UrlFetchApp.fetch(SASHA_EDITOR_ORIGIN + path, request);
  var status = response.getResponseCode();
  var text = response.getContentText();
  var parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (parseError) {
    parsed = { message: text.slice(0, 300) };
  }
  if (status < 200 || status > 299) throw new Error(parsed.message || ('HTTP ' + status));
  return parsed;
}
`;
}
