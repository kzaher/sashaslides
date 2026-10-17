/**
 * The DIAGRAM DIALOG's part of Code.gs, appended by apps-script-project.ts.
 *
 *   sashaOpenDiagrams()            the menu item "Edit diagram": Diagram.html in a modeless dialog,
 *                                  seeded with the deck's pictures, the selection, this
 *                                  presentation's diagram folder and the selected picture's source
 *   sashaSaveDiagram(spec)         the dialog's save, new diagram, upload and stale refresh: ONE call
 *   sashaReadDiagramSources(spec)  the sources of diagrams the seed did not carry
 *   sashaLinkInsertedDiagrams(spec) after an insert from the candidates window: each diagram's
 *                                  source file and the picture's link and stamp
 *
 * THIN. Each public function hands its spec to a function from diagram-host.ts, embedded VERBATIM
 * with `.toString()` and unit-tested there against a fake Drive, together with `sashaDiagramDrive_`,
 * the adapter: one DriveApp, Drive REST or Slides call per method and no decisions.
 */
import { DIAGRAM_SEED_ELEMENT_ID } from "./diagram-wire.ts";
import { diagramBootOf, executeDiagramLinks, executeDiagramSave, readDiagramSources, walkFolderPaths } from "./diagram-host.ts";
import { EDITOR_DIALOG_SIZE } from "./editor-code-gs.ts";

/** The menu item's text and the function it runs. */
export const DIAGRAM_MENU_ITEM: Readonly<{ label: string; functionName: string }> = { label: "Edit diagram", functionName: "sashaOpenDiagrams" };

/**
 * What the dialog reads of the deck: the page size, and every picture's id, alternative text, size,
 * transform and link, one group level deep (a diagram inside a group of groups is not listed).
 */
export const DIAGRAM_DECK_FIELDS =
  "pageSize,slides(objectId,pageElements(objectId,description,size,transform,image(imageProperties(link(url))),elementGroup(children(objectId,description,size,transform,image(imageProperties(link(url)))))))";

export function diagramCodeGs(): string {
  return `
// ---------------------------------------------------------------------------
// The diagram dialog, generated from src/diagram-code-gs.ts. Every decision is in
// src/diagram-host.ts (embedded below) and src/diagram-flow.ts (in the dialog).
// ---------------------------------------------------------------------------
var SASHA_DIAGRAM_DECK_FIELDS = '${DIAGRAM_DECK_FIELDS}';

/**
 * The menu item. As large as the window allows (the same request as the deck editor's, measured in
 * editor-code-gs.ts): draw.io needs the room. The seed is read HERE, so the dialog draws at once.
 */
function ${DIAGRAM_MENU_ITEM.functionName}() {
  var page = HtmlService.createHtmlOutputFromFile('Diagram')
    .setWidth(${EDITOR_DIALOG_SIZE.width})
    .setHeight(${EDITOR_DIALOG_SIZE.height});
  sashaAppendSeed_(page, ${JSON.stringify(DIAGRAM_SEED_ELEMENT_ID)}, sashaDiagramBoot_());
  SlidesApp.getUi().showModelessDialog(page, 'Diagrams');
}

/** The seed, or { failed } with the reason, which the dialog shows instead of a list. */
function sashaDiagramBoot_() {
  try {
    var presentation = SlidesApp.getActivePresentation();
    var presentationId = presentation.getId();
    return sashaDiagramBootOf_({
      presentationId: presentationId,
      deck: Slides.Presentations.get(presentationId, { fields: SASHA_DIAGRAM_DECK_FIELDS }),
      selection: sashaDiagramSelection_(presentation),
      drive: sashaDiagramDrive_()
    });
  } catch (bootError) {
    return { failed: 'The presentation could not be read: ' + String((bootError && bootError.message) || bootError) };
  }
}

/** The current slide and the selected elements' ids. Best effort: no selection is an empty one. */
function sashaDiagramSelection_(presentation) {
  var selection = { pageObjectId: null, objectIds: [] };
  try {
    var current = presentation.getSelection();
    var page = current.getCurrentPage();
    if (page) selection.pageObjectId = page.getObjectId();
    var range = current.getPageElementRange();
    if (range) selection.objectIds = range.getPageElements().map(function (element) { return element.getObjectId(); });
  } catch (selectionError) {
    console.warn('sasha-slides: could not read the selection: ' + selectionError);
  }
  return selection;
}

function sashaSaveDiagram(spec) {
  return sashaExecuteDiagramSave_({ spec: spec, drive: sashaDiagramDrive_() });
}

function sashaReadDiagramSources(spec) {
  return sashaReadDiagramSourcesOf_({ fileIds: (spec && spec.fileIds) || [], drive: sashaDiagramDrive_() });
}

function sashaLinkInsertedDiagrams(spec) {
  return sashaExecuteDiagramLinks_({ spec: spec, drive: sashaDiagramDrive_() });
}

/**
 * The DiagramDrive adapter (src/diagram-host.ts): I/O only. Trashed items are never matched, and every
 * same-named folder is returned (the connector may have made a second tree it alone can see).
 */
function sashaDiagramDrive_() {
  var folders = {
    findChildFolders: function (spec) {
      var parent = spec.parentId ? DriveApp.getFolderById(spec.parentId) : DriveApp.getRootFolder();
      var found = parent.getFoldersByName(spec.name);
      var ids = [];
      while (found.hasNext()) {
        var folder = found.next();
        if (!folder.isTrashed()) ids.push(folder.getId());
      }
      return ids;
    },
    createChildFolder: function (spec) {
      var parent = spec.parentId ? DriveApp.getFolderById(spec.parentId) : DriveApp.getRootFolder();
      return parent.createFolder(spec.name).getId();
    }
  };
  return {
    activePresentationId: function () { return SlidesApp.getActivePresentation().getId(); },
    findFolderPaths: function (names) { return sashaWalkFolderPaths_({ names: names, create: false, folders: folders }); },
    ensureFolderPaths: function (names) { return sashaWalkFolderPaths_({ names: names, create: true, folders: folders }); },
    listFileNames: function (spec) {
      var names = [];
      var files = DriveApp.getFolderById(spec.folderId).getFiles();
      while (files.hasNext()) {
        var file = files.next();
        if (!file.isTrashed()) names.push(file.getName());
      }
      return names;
    },
    findFile: function (spec) {
      var files = DriveApp.getFolderById(spec.folderId).getFilesByName(spec.name);
      while (files.hasNext()) {
        var file = files.next();
        if (!file.isTrashed()) return file.getId();
      }
      return null;
    },
    fileParents: function (spec) {
      var ids = [];
      var parents = DriveApp.getFileById(spec.fileId).getParents();
      while (parents.hasNext()) ids.push(parents.next().getId());
      return ids;
    },
    readFile: function (spec) {
      var file = DriveApp.getFileById(spec.fileId);
      var ids = [];
      var parents = file.getParents();
      while (parents.hasNext()) ids.push(parents.next().getId());
      return {
        fileId: spec.fileId,
        name: file.getName(),
        mimeType: file.getMimeType(),
        parentFolderIds: ids,
        base64: Utilities.base64Encode(file.getBlob().getBytes())
      };
    },
    createFile: function (spec) {
      return DriveApp.getFolderById(spec.folderId).createFile(Utilities.newBlob(spec.text, spec.mimeType, spec.name)).getId();
    },
    updateFile: function (spec) {
      DriveApp.getFileById(spec.fileId).setContent(spec.text);
    },
    // The same staging as sashaStageImages_: Google fetches createImage/replaceImage URLs without
    // the user's credentials, so the picture is shared link-only for the one batchUpdate.
    stageImage: function (spec) {
      var blob = Utilities.newBlob(Utilities.base64Decode(spec.base64), spec.mimeType, spec.fileName);
      var file = DriveApp.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return { fileId: file.getId(), url: 'https://drive.google.com/uc?id=' + file.getId() };
    },
    // A PERMANENT delete, as sashaInsert's: the link must stop working now, not sit in the bin.
    deleteFile: function (spec) {
      sashaFetchJson_(SASHA_DRIVE_FILES + '/' + encodeURIComponent(spec.fileId), { method: 'delete' });
    },
    batchUpdate: function (spec) {
      return Slides.Presentations.batchUpdate({ requests: spec.requests }, spec.presentationId);
    }
  };
}

// src/diagram-host.ts, VERBATIM (each one's .toString()); diagram-host.test.ts runs these copies.
var sashaWalkFolderPaths_ = ${walkFolderPaths.toString()};
var sashaDiagramBootOf_ = ${diagramBootOf.toString()};
var sashaExecuteDiagramSave_ = ${executeDiagramSave.toString()};
var sashaExecuteDiagramLinks_ = ${executeDiagramLinks.toString()};
var sashaReadDiagramSourcesOf_ = ${readDiagramSources.toString()};
`;
}
