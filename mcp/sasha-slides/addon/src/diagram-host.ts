// THE DIAGRAM DIALOG'S DRIVE AND SLIDES WORK, as TypeScript that Code.gs runs VERBATIM.
//
// Code.gs embeds each exported function below with `.toString()` (diagram-code-gs.ts), exactly as it
// embeds inbox-scan.ts `inboxMarkerQueries`, so the copy-on-write save that touches the user's Drive
// is the code diagram-host.test.ts runs against a fake Drive. Code.gs only supplies the adapter
// (`DiagramDrive`): straight-line DriveApp / Slides calls with no decisions.
//
// SELF-CONTAINED, every one of them: no imports, nothing from this module's scope, no named inner
// functions (the transpiler wraps those in a `__name` helper Apps Script does not have), no
// `assertNever`, and no `?.`, `??` or bare `catch {`, so the text needs nothing newer than the
// syntax Code.gs already uses. diagram-host.test.ts evaluates each one's source text on its own to prove it.
// Types are erased, so importing them is free.
//
// WHAT IS DECIDED WHERE. The PLAN (which file, which pictures, which names) is computed in the
// dialog by converter/drawio-save-plan.ts and diagram-flow.ts, with placeholders where an id only
// exists after a Drive write. These functions EXECUTE a plan: write the file, stage the picture,
// substitute the placeholders and send ONE batchUpdate. The one rule they re-check themselves is the
// one that protects other people's work: a file is only ever updated in place when it sits in THIS
// presentation's own diagram folder.

/** A Drive file as Code.gs reads it: the bytes always travel as base64, the dialog decides what they are. */
export type RawDriveFile = Readonly<{
  fileId: string;
  name: string;
  mimeType: string;
  parentFolderIds: readonly string[];
  base64: string;
}>;

/**
 * Folder lookups one level at a time, from My Drive's root (`parentId: null`). EVERY same-named
 * child comes back: the connector holds only drive.file, cannot see the folders the add-on made, and
 * so may build a second `sasha_slides/slide/<id>/drawio` tree beside this one. Both are this deck's.
 */
export type DiagramFolders = Readonly<{
  findChildFolders(options: Readonly<{ parentId: string | null; name: string }>): readonly string[];
  createChildFolder(options: Readonly<{ parentId: string | null; name: string }>): string;
}>;

/** Everything the executors below may do to Drive and Slides. Code.gs implements it; tests fake it. */
export type DiagramDrive = Readonly<{
  activePresentationId(): string;
  /** Every folder at `names` below My Drive (walkFolderPaths); empty when the path does not exist. */
  findFolderPaths(names: readonly string[]): readonly string[];
  /** The same, creating the missing levels, so it is never empty. */
  ensureFolderPaths(names: readonly string[]): readonly string[];
  listFileNames(options: Readonly<{ folderId: string }>): readonly string[];
  findFile(options: Readonly<{ folderId: string; name: string }>): string | null;
  fileParents(options: Readonly<{ fileId: string }>): readonly string[];
  readFile(options: Readonly<{ fileId: string }>): RawDriveFile;
  createFile(options: Readonly<{ folderId: string; name: string; mimeType: string; text: string }>): string;
  updateFile(options: Readonly<{ fileId: string; text: string }>): void;
  /** Uploads the bytes, shares them link-only for the one batchUpdate, and answers a URL Google can fetch. */
  stageImage(options: Readonly<{ fileName: string; mimeType: string; base64: string }>): Readonly<{ fileId: string; url: string }>;
  deleteFile(options: Readonly<{ fileId: string }>): void;
  batchUpdate(options: Readonly<{ presentationId: string; requests: readonly Readonly<Record<string, unknown>>[] }>): unknown;
}>;

/** The parts of `presentations.get` the dialog reads (DIAGRAM_DECK_FIELDS). Every field may be missing. */
export type RawDeckElement = Readonly<{
  objectId?: unknown;
  description?: unknown;
  size?: unknown;
  transform?: unknown;
  image?: Readonly<{ imageProperties?: Readonly<{ link?: Readonly<{ url?: unknown }> }> }>;
  elementGroup?: Readonly<{ children?: readonly RawDeckElement[] }>;
}>;
export type RawDeck = Readonly<{
  pageSize?: unknown;
  slides?: readonly Readonly<{ objectId?: unknown; pageElements?: readonly RawDeckElement[] }>[];
}>;

export type DiagramBootSelection = Readonly<{ pageObjectId: string | null; objectIds: readonly string[] }>;

/** The seed of Diagram.html, before diagram-seed.ts parses it. */
export type DiagramBoot = Readonly<{
  presentationId: string;
  deck: RawDeck;
  selection: DiagramBootSelection;
  /** `sasha_slides/slide/<presentationId>/drawio` when it exists, with the names in it. */
  folder: Readonly<{ folderId: string; folderIds: readonly string[]; fileNames: readonly string[] }> | null;
  /** The selected picture's linked source, read now so Edit needs no round trip; null when none is selected. */
  selectedSource: Readonly<{ fileId: string; file: RawDriveFile | null; error: string | null }> | null;
}>;

/** How the saved diagram's source file is written. */
export type DiagramFileStep =
  /** In place: only legal for a file inside this presentation's folder, which is re-checked here. */
  | Readonly<{ kind: "update"; fileId: string; deckFolderPath: readonly string[] }>
  /** Copy on write, or a brand-new diagram: a new file in this presentation's folder. */
  | Readonly<{ kind: "create"; folderPath: readonly string[]; fileName: string }>
  /** The file is already right (a stale picture refreshed from it): only the pictures change. */
  | Readonly<{ kind: "keep"; fileId: string }>;

/** The address a picture links to, split around the file id (drawio-diagram.ts driveFileAddress). */
export type FileAddressParts = Readonly<{ prefix: string; suffix: string }>;

export type DiagramSaveSpec = Readonly<{
  presentationId: string;
  file: DiagramFileStep;
  xml: string;
  fileMimeType: string;
  picture: Readonly<{ fileName: string; mimeType: string; base64: string }>;
  /** The batchUpdate, carrying `imageUrlPlaceholder` and (for a new file) `fileAddressPlaceholder`. */
  requests: readonly Readonly<Record<string, unknown>>[];
  imageUrlPlaceholder: string;
  fileAddressPlaceholder: string;
  fileAddress: FileAddressParts;
}>;

export type DiagramSaveReply = Readonly<{ fileId: string; folderId: string | null; created: boolean; batchResponse: unknown }>;

export type DiagramLinkSpec = Readonly<{
  presentationId: string;
  folderPath: readonly string[];
  fileMimeType: string;
  entries: readonly Readonly<{ fileName: string; xml: string; fileAddressPlaceholder: string }>[];
  requests: readonly Readonly<Record<string, unknown>>[];
  fileAddress: FileAddressParts;
}>;

export type DiagramLinkReply = Readonly<{
  folderId: string;
  links: readonly Readonly<{ fileName: string; fileId: string; reused: boolean }>[];
  batchResponse: unknown;
}>;

export type DiagramSourcesReply = Readonly<{
  files: readonly Readonly<{ fileId: string; file: RawDriveFile | null; error: string | null }>[];
}>;

/**
 * Every folder at `names` below My Drive, following EVERY same-named branch at each level. With
 * `create`, a level that exists under no branch is made under the first one, so the answer is never
 * empty; without it, a missing level answers no folders.
 */
export function walkFolderPaths(options: Readonly<{ names: readonly string[]; create: boolean; folders: DiagramFolders }>): readonly string[] {
  let parents: readonly (string | null)[] = [null];
  for (const name of options.names) {
    const found: string[] = [];
    for (const parentId of parents) for (const folderId of options.folders.findChildFolders({ parentId, name })) if (found.indexOf(folderId) < 0) found.push(folderId);
    if (found.length === 0) {
      if (!options.create) return [];
      const firstParent = parents[0];
      found.push(options.folders.createChildFolder({ parentId: firstParent === undefined ? null : firstParent, name }));
    }
    parents = found;
  }
  const leaves: string[] = [];
  for (const parentId of parents) if (parentId !== null) leaves.push(parentId);
  return leaves;
}

/**
 * Diagram.html's seed: the deck's pictures as Slides reported them, the selection, this
 * presentation's diagram folder when it exists, and the selected picture's source file. Reading the
 * selected source HERE is what lets "Edit" open at once instead of after a ~0.7 s round trip.
 * The folder names are `drawio-diagram.ts diagramFolderPath` (diagram-host.test.ts asserts it).
 */
export function diagramBootOf(
  options: Readonly<{ presentationId: string; deck: RawDeck; selection: DiagramBootSelection; drive: Pick<DiagramDrive, "findFolderPaths" | "listFileNames" | "readFile"> }>,
): DiagramBoot {
  const { presentationId, deck, selection, drive } = options;
  const folderIds = drive.findFolderPaths(["sasha_slides", "slide", presentationId, "drawio"]);
  const fileNames: string[] = [];
  for (const folderId of folderIds) for (const name of drive.listFileNames({ folderId })) if (fileNames.indexOf(name) < 0) fileNames.push(name);
  const firstFolderId = folderIds[0];
  const folder = firstFolderId === undefined ? null : { folderId: firstFolderId, folderIds, fileNames };
  let selectedLink: string | null = null;
  const pending: RawDeckElement[] = [];
  for (const slide of deck.slides || []) for (const element of slide.pageElements || []) pending.push(element);
  while (pending.length > 0 && selectedLink === null) {
    const element = pending.shift();
    if (element === undefined) break;
    if (element.elementGroup && element.elementGroup.children) for (const child of element.elementGroup.children) pending.push(child);
    const link = element.image && element.image.imageProperties ? element.image.imageProperties.link : undefined;
    const url = link ? link.url : undefined;
    if (typeof element.objectId === "string" && selection.objectIds.indexOf(element.objectId) >= 0 && typeof url === "string") selectedLink = url;
  }
  // drawio-diagram.ts driveFileIdOfAddress, for the two link shapes it accepts (the test compares them).
  const match = selectedLink === null ? null : /^https:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/([A-Za-z0-9_-]{10,200})(?:[/?#]|$)|[^#]*[?&]id=([A-Za-z0-9_-]{10,200})(?:[&#]|$))/.exec(selectedLink);
  const fileId = match === null ? null : match[1] || match[2] || null;
  if (fileId === null) return { presentationId, deck, selection, folder, selectedSource: null };
  try {
    return { presentationId, deck, selection, folder, selectedSource: { fileId, file: drive.readFile({ fileId }), error: null } };
  } catch (readError) {
    return { presentationId, deck, selection, folder, selectedSource: { fileId, file: null, error: String(readError) } };
  }
}

/**
 * SAVE ONE DIAGRAM: write its source (in place, as a copy-on-write file, or not at all), stage the
 * new picture, put the real addresses into the planned batchUpdate and send it.
 *
 * NEVER MODIFIES A FILE UNDER ANOTHER DOCUMENT. An `update` is refused unless the file's parents
 * include THIS presentation's diagram folder as Drive reports it now -- so a plan computed from a
 * stale seed, or a forged one, cannot overwrite another deck's diagram. A `create` refuses a name
 * that appeared in the folder since the plan was made, rather than overwrite a different diagram.
 *
 * The staged picture is deleted on every path (Slides has copied its bytes by then, as for
 * sashaInsert). A file this call created is removed again when the batchUpdate fails, so a failed
 * save leaves Drive as it found it.
 */
export function executeDiagramSave(options: Readonly<{ spec: DiagramSaveSpec; drive: DiagramDrive }>): DiagramSaveReply {
  const { spec, drive } = options;
  if (spec.presentationId !== drive.activePresentationId()) throw new Error("this diagram belongs to another presentation than the one that is open");
  let fileId: string;
  let folderId: string | null = null;
  let created = false;
  switch (spec.file.kind) {
    case "update": {
      const parents = drive.fileParents({ fileId: spec.file.fileId });
      for (const candidate of drive.findFolderPaths(spec.file.deckFolderPath)) if (folderId === null && parents.indexOf(candidate) >= 0) folderId = candidate;
      if (folderId === null) {
        throw new Error("the diagram's file is not in this presentation's diagram folder, so it is never modified in place; reopen the dialog to save a copy");
      }
      drive.updateFile({ fileId: spec.file.fileId, text: spec.xml });
      fileId = spec.file.fileId;
      break;
    }
    case "create": {
      const folders = drive.ensureFolderPaths(spec.file.folderPath);
      for (const candidate of folders) {
        if (drive.findFile({ folderId: candidate, name: spec.file.fileName }) !== null) {
          throw new Error(spec.file.fileName + " appeared in this presentation's diagram folder after the dialog opened; reopen the dialog and save again");
        }
      }
      const target = folders[0];
      if (target === undefined) throw new Error("this presentation's diagram folder could not be created");
      folderId = target;
      fileId = drive.createFile({ folderId: target, name: spec.file.fileName, mimeType: spec.fileMimeType, text: spec.xml });
      created = true;
      break;
    }
    case "keep":
      fileId = spec.file.fileId;
      break;
    default: {
      const unknownStep: never = spec.file;
      throw new Error("unknown file step " + JSON.stringify(unknownStep));
    }
  }
  const staged = drive.stageImage(spec.picture);
  try {
    // SAFETY: the text is `spec.requests` serialised a line above with two plain strings replaced, so it
    // parses back to the same array of request objects.
    const requests = JSON.parse(
      JSON.stringify(spec.requests)
        .split(spec.imageUrlPlaceholder)
        .join(staged.url)
        .split(spec.fileAddressPlaceholder)
        .join(spec.fileAddress.prefix + fileId + spec.fileAddress.suffix),
    ) as readonly Readonly<Record<string, unknown>>[];
    let batchResponse: unknown;
    try {
      batchResponse = drive.batchUpdate({ presentationId: spec.presentationId, requests });
    } catch (batchError) {
      if (created) {
        try {
          drive.deleteFile({ fileId });
        } catch (removeError) {
          // The copy stays behind; the save is still reported as failed below.
          console.warn("sasha-slides: could not remove the unused diagram copy " + fileId + ": " + String(removeError));
        }
      }
      throw batchError;
    }
    return { fileId, folderId, created, batchResponse };
  } finally {
    try {
      drive.deleteFile({ fileId: staged.fileId });
    } catch (unstageError) {
      // A staged picture that outlives its batch is link-only and harmless; the save stands.
      console.warn("sasha-slides: could not delete the staged diagram picture " + staged.fileId + ": " + String(unstageError));
    }
  }
}

/**
 * AFTER AN INSERT: give each inserted diagram picture its source file and its link. A file of the
 * same name already in any of this presentation's folders is REUSED (the connector may have written it when
 * the agent staged the slide; the name is a hash of the source); otherwise it is created. Then ONE
 * batchUpdate sets every link and stamp.
 */
export function executeDiagramLinks(options: Readonly<{ spec: DiagramLinkSpec; drive: DiagramDrive }>): DiagramLinkReply {
  const { spec, drive } = options;
  if (spec.presentationId !== drive.activePresentationId()) throw new Error("these diagrams belong to another presentation than the one that is open");
  const folders = drive.ensureFolderPaths(spec.folderPath);
  const folderId = folders[0];
  if (folderId === undefined) throw new Error("this presentation's diagram folder could not be created");
  const links: Readonly<{ fileName: string; fileId: string; reused: boolean }>[] = [];
  let text = JSON.stringify(spec.requests);
  for (const entry of spec.entries) {
    // ANY of this deck's folders: the connector may have pre-written the file in a tree of its own.
    let existing: string | null = null;
    for (const candidate of folders) if (existing === null) existing = drive.findFile({ folderId: candidate, name: entry.fileName });
    const fileId = existing !== null ? existing : drive.createFile({ folderId, name: entry.fileName, mimeType: spec.fileMimeType, text: entry.xml });
    links.push({ fileName: entry.fileName, fileId, reused: existing !== null });
    text = text.split(entry.fileAddressPlaceholder).join(spec.fileAddress.prefix + fileId + spec.fileAddress.suffix);
  }
  // SAFETY: `text` is `spec.requests` serialised above with plain-string replacements only.
  const requests = JSON.parse(text) as readonly Readonly<Record<string, unknown>>[];
  const batchResponse = requests.length === 0 ? null : drive.batchUpdate({ presentationId: spec.presentationId, requests });
  return { folderId, links, batchResponse };
}

/** Several diagram sources in one round trip, each succeeding or failing on its own. */
export function readDiagramSources(options: Readonly<{ fileIds: readonly string[]; drive: Pick<DiagramDrive, "readFile"> }>): DiagramSourcesReply {
  const files: Readonly<{ fileId: string; file: RawDriveFile | null; error: string | null }>[] = [];
  for (const fileId of options.fileIds) {
    try {
      files.push({ fileId, file: options.drive.readFile({ fileId }), error: null });
    } catch (readError) {
      files.push({ fileId, file: null, error: String(readError) });
    }
  }
  return { files };
}
