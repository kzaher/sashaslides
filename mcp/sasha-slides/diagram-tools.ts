/**
 * diagram-tools.ts — the connector's half of draw.io diagrams: turning an agent's draw.io source
 * into a candidate slide, pre-writing the source into the person's Drive, and the `deck_diagrams`
 * tool (list / read / write the diagrams already in a presentation).
 *
 * THE MODEL is converter/drawio-diagram.ts: a diagram on a slide is a PICTURE stamped
 * `drawio:<diagramId>;v=<version>` in its alternative text and linked to its editable source,
 * `sasha_slides/slide/<presentationId>/drawio/<diagramId>.drawio`, in the person's Drive.
 *
 * WHY THE CONNECTOR WRITES THE FILE AT PROPOSAL TIME (a measured design constraint): the connector
 * holds only Google's `drive.file` permission, so it can later read only files IT created. The
 * add-on (full `drive` permission) links the inserted picture to the file by name and creates it
 * only when absent, so a file the connector wrote first stays readable by `deck_diagrams read`.
 *
 * WRITING never re-draws a picture: Node has no draw.io renderer. `write` updates the source with
 * copy-on-write (converter/drawio-save-plan.ts planDiagramSave) and re-points links; the pictures
 * stay as they were (their version stamp is NOT changed, so they read as stale) until the person
 * runs SashaSlides › Edit diagram in the deck, or the agent proposes the diagram as a new candidate.
 */
import {
  DRAWIO_FILE_MEDIA_TYPE,
  DRAWIO_SOURCE_SCRIPT_TYPE,
  diagramFileName,
  diagramFolderPath,
  diagramIdForSource,
  diagramIdOfFileName,
  diagramVersionOf,
  drawioAltText,
  driveFileAddress,
  isDiagramId,
  mxfileFromPngBytes,
  parseDrawioSource,
} from "./converter/drawio-diagram.ts";
import { diagramReferencesOf, planDiagramSave, type DiagramReference, type DiagramSavePlan } from "./converter/drawio-save-plan.ts";
import type { SlidesApiRequest } from "./converter/slides-api.ts";
import { FOLDER_MIME_TYPE, type DriveChannel, type DriveFileLocation } from "./drive-channel";
import type { FeedbackChannel, SlidePicture } from "./feedback/feedback-channel";
import { assertNever } from "./engine/src/contracts/assert-never.ts";

/* ------------------------------------------------------------------ sources */

export type DiagramSourceLoad = Readonly<{ kind: "ok"; xml: string }> | Readonly<{ kind: "error"; message: string }>;

/** Reads a local file's bytes, or null when it cannot be read. Injected so tests need no disk. */
export type ReadLocalBytes = (path: string) => Uint8Array | null;

/** The file names a draw.io source is accepted from, longest suffix first. */
export const DIAGRAM_FILE_SUFFIXES: readonly string[] = [".drawio.png", ".drawio.svg", ".drawio", ".xml", ".svg", ".png"];

/**
 * A diagram given as XML text or as a local file (stdio connector only): `.drawio` / `.xml`
 * (`<mxfile>` or `<mxGraphModel>`), `.drawio.svg` / `.svg` (draw.io's editable SVG) or
 * `.drawio.png` / `.png` (a PNG exported with "Include a copy of my diagram"). Returns `<mxfile>` XML.
 */
export function loadDiagramSource(
  options: Readonly<{ xml: string | undefined; path: string | undefined; remote: boolean; readBytes: ReadLocalBytes; what: string }>,
): DiagramSourceLoad {
  const { xml, path, remote, readBytes, what } = options;
  if (xml !== undefined && path !== undefined) return { kind: "error", message: `${what}: give the diagram as XML or as a file path, not both` };
  if (xml !== undefined) return fromParse({ text: xml, what });
  if (path === undefined) return { kind: "error", message: `${what}: give the diagram as XML or as a file path` };
  if (remote) {
    return {
      kind: "error",
      message: `${what}: this connector runs remotely and cannot read files from your machine. Send the diagram's XML inline instead of a path.`,
    };
  }
  const suffix = DIAGRAM_FILE_SUFFIXES.find((candidate) => path.toLowerCase().endsWith(candidate));
  if (suffix === undefined) {
    return { kind: "error", message: `${what}: a diagram file must end in ${DIAGRAM_FILE_SUFFIXES.join(", ")}` };
  }
  const bytes = readBytes(path);
  if (bytes === null) return { kind: "error", message: `${what}: not a readable file: ${path}` };
  if (suffix.endsWith(".png")) {
    const embedded = mxfileFromPngBytes(bytes);
    if (embedded === null) {
      return {
        kind: "error",
        message: `${what}: the PNG carries no draw.io source. Export it from draw.io with "Include a copy of my diagram", or pass the .drawio file.`,
      };
    }
    return fromParse({ text: embedded, what });
  }
  return fromParse({ text: new TextDecoder("utf-8").decode(bytes), what });
}

function fromParse(options: Readonly<{ text: string; what: string }>): DiagramSourceLoad {
  const parsed = parseDrawioSource(options.text);
  switch (parsed.kind) {
    case "ok":
      return { kind: "ok", xml: parsed.xml };
    case "invalid":
      return { kind: "error", message: `${options.what}: ${parsed.reason}` };
    default:
      return assertNever(parsed);
  }
}

/**
 * The draw.io sources carried inside candidate HTML (`<script type="application/vnd.drawio+xml">`),
 * normalised as the converter stamps them. Invalid ones are skipped: the converter reports them.
 */
export function diagramSourcesInHtml(html: string): readonly string[] {
  const sources: string[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const typeValue = /\btype\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
    if (typeValue?.toLowerCase() !== DRAWIO_SOURCE_SCRIPT_TYPE) continue;
    const parsed = parseDrawioSource((match[2] ?? "").replace(/<\\\/(script)/gi, "</$1"));
    if (parsed.kind === "ok") sources.push(parsed.xml);
  }
  return sources;
}

/* ------------------------------------------------------- Drive diagram files */

export type DiagramFileWrite = Readonly<{
  diagramId: string;
  fileId: string;
  /** `created`; `unchanged` (the same source was already there); `kept` (a different, edited source was there and was left alone). */
  file: "created" | "unchanged" | "kept";
}>;

export type DiagramFilesOutcome = Readonly<{ files: readonly DiagramFileWrite[]; warnings: readonly string[] }>;

/**
 * Writes each source to `sasha_slides/slide/<presentationId>/drawio/<diagramId>.drawio`, creating
 * missing folders. The id is a hash of the source, so an existing file of that name normally
 * holds the same source; one that differs was edited since (in the deck) and is never overwritten,
 * because pictures already in the deck show it. Best-effort: a failure becomes a warning.
 */
export async function writeDiagramSources(
  options: Readonly<{ drive: DriveChannel; presentationId: string; sources: readonly string[] }>,
): Promise<DiagramFilesOutcome> {
  const { drive, presentationId } = options;
  const unique = [...new Map(options.sources.map((xml) => [diagramIdForSource(xml), xml])).entries()];
  if (unique.length === 0) return { files: [], warnings: [] };
  let folderPath: readonly string[];
  try {
    folderPath = diagramFolderPath(presentationId);
  } catch {
    return { files: [], warnings: [`the diagram sources were not saved: "${presentationId}" is not a presentation id`] };
  }
  let folderId: string;
  try {
    folderId = await ensureFolderPath({ drive, path: folderPath });
  } catch (cause) {
    return { files: [], warnings: [`the diagram sources were not saved: could not create ${folderPath.join("/")}: ${describeCause(cause)}`] };
  }
  const files: DiagramFileWrite[] = [];
  const warnings: string[] = [];
  for (const [diagramId, xml] of unique) {
    const name = diagramFileName(diagramId);
    try {
      const existing = (await listFolder({ drive, folderId })).find((file) => file.name === name);
      if (existing === undefined) {
        const created = await drive.createFile({ name, parentId: folderId, mimeType: DRAWIO_FILE_MEDIA_TYPE, media: { kind: "text", text: xml }, appProperties: {} });
        files.push({ diagramId, fileId: created.id, file: "created" });
        continue;
      }
      const current = parseDrawioSource(await drive.readTextFile({ fileId: existing.id }));
      const same = current.kind === "ok" && current.xml === xml;
      files.push({ diagramId, fileId: existing.id, file: same ? "unchanged" : "kept" });
      if (!same) warnings.push(`${name} already holds an edited version of this diagram; it was left as it is`);
    } catch (cause) {
      warnings.push(`could not save ${name}: ${describeCause(cause)}`);
    }
  }
  return { files, warnings };
}

/** The folder at `path` from My Drive's root, creating each missing folder. */
export async function ensureFolderPath(options: Readonly<{ drive: DriveChannel; path: readonly string[] }>): Promise<string> {
  const { drive } = options;
  let parentId: string | null = null;
  for (const name of options.path) {
    const found: string | null = await findFolder({ drive, name, parentId });
    parentId = found ?? (await drive.createFolder({ name, parentId, appProperties: {} })).id;
  }
  if (parentId === null) throw new Error("an empty folder path");
  return parentId;
}

/** The folder at `path`, or null when any part of it is missing (or invisible to this app). */
export async function findFolderPath(options: Readonly<{ drive: DriveChannel; path: readonly string[] }>): Promise<string | null> {
  let parentId: string | null = null;
  for (const name of options.path) {
    parentId = await findFolder({ drive: options.drive, name, parentId });
    if (parentId === null) return null;
  }
  return parentId;
}

/** `parentId` null is the top of what this app can see: My Drive's root, in practice. */
async function findFolder(options: Readonly<{ drive: DriveChannel; name: string; parentId: string | null }>): Promise<string | null> {
  const listed = await options.drive.listFiles({
    query: { name: options.name, parentId: options.parentId, sashaSlides: null, proposalId: null, trashed: false },
  });
  return listed.find((file) => file.mimeType === FOLDER_MIME_TYPE)?.id ?? null;
}

async function listFolder(options: Readonly<{ drive: DriveChannel; folderId: string }>): Promise<readonly Readonly<{ id: string; name: string }>[]> {
  const listed = await options.drive.listFiles({
    query: { name: null, parentId: options.folderId, sashaSlides: null, proposalId: null, trashed: false },
  });
  return listed.filter((file) => file.mimeType !== FOLDER_MIME_TYPE);
}

/* ------------------------------------------------------------ deck_diagrams */

export type DiagramDeckEnvironment = Readonly<{
  drive: DriveChannel;
  slides: Pick<FeedbackChannel, "readDeckPictures" | "updatePresentation">;
  /** True for the HTTPS connector: XML travels inline, never by path. */
  remote: boolean;
  /** Local connector: writes the XML to a file on this machine and returns its path. */
  saveLocalCopy: (options: Readonly<{ presentationId: string; diagramId: string; xml: string }>) => string;
}>;

/** Exactly one way to name a diagram: its id (from the stamp) or the picture's object id. */
export type DiagramTarget = Readonly<{ kind: "diagram-id"; diagramId: string }> | Readonly<{ kind: "object-id"; objectId: string }>;

export type DiagramRequest =
  | Readonly<{ action: "list"; presentationId: string }>
  | Readonly<{ action: "read"; presentationId: string; target: DiagramTarget }>
  | Readonly<{ action: "write"; presentationId: string; target: DiagramTarget; xml: string }>;

export type DiagramArguments = Readonly<{
  action: "list" | "read" | "write";
  presentationId: string;
  diagramId?: string | undefined;
  objectId?: string | undefined;
  xml?: string | undefined;
  path?: string | undefined;
}>;

/** The deck_diagrams argument boundary: every action takes exactly what it needs and nothing else. */
export function diagramRequestFrom(
  options: Readonly<{ args: DiagramArguments; remote: boolean; readBytes: ReadLocalBytes }>,
): Readonly<{ kind: "ok"; request: DiagramRequest }> | Readonly<{ kind: "error"; message: string }> {
  const { args, remote, readBytes } = options;
  const what = `deck_diagrams ${args.action}`;
  const presentationId = presentationIdOf(args.presentationId);
  if (presentationId === null) return { kind: "error", message: `${what}: presentationId must be a Google Slides id or its address` };
  switch (args.action) {
    case "list": {
      const stray = [args.diagramId, args.objectId, args.xml, args.path].some((value) => value !== undefined);
      return stray
        ? { kind: "error", message: `${what}: takes only presentationId` }
        : { kind: "ok", request: { action: "list", presentationId } };
    }
    case "read": {
      if (args.xml !== undefined || args.path !== undefined) return { kind: "error", message: `${what}: takes no xml or path (write does)` };
      const target = diagramTargetOf({ args, what });
      return target.kind === "error" ? target : { kind: "ok", request: { action: "read", presentationId, target: target.target } };
    }
    case "write": {
      const target = diagramTargetOf({ args, what });
      if (target.kind === "error") return target;
      const source = loadDiagramSource({ xml: args.xml, path: args.path, remote, readBytes, what });
      if (source.kind === "error") return source;
      return { kind: "ok", request: { action: "write", presentationId, target: target.target, xml: source.xml } };
    }
    default:
      return assertNever(args.action);
  }
}

function diagramTargetOf(
  options: Readonly<{ args: DiagramArguments; what: string }>,
): Readonly<{ kind: "ok"; target: DiagramTarget }> | Readonly<{ kind: "error"; message: string }> {
  const { args, what } = options;
  if (args.diagramId !== undefined && args.objectId !== undefined) return { kind: "error", message: `${what}: give diagramId or objectId, not both` };
  if (args.diagramId !== undefined) {
    return isDiagramId(args.diagramId)
      ? { kind: "ok", target: { kind: "diagram-id", diagramId: args.diagramId } }
      : { kind: "error", message: `${what}: "${args.diagramId}" is not a diagram id (letters, digits, - and _ only)` };
  }
  if (args.objectId !== undefined) return { kind: "ok", target: { kind: "object-id", objectId: args.objectId } };
  return { kind: "error", message: `${what}: name the diagram with diagramId or objectId (from deck_diagrams list)` };
}

/** A bare id, or the id inside a docs.google.com/presentation/d/<id>/… address. */
export function presentationIdOf(text: string): string | null {
  const trimmed = text.trim();
  const fromAddress = /\/presentation\/d\/([A-Za-z0-9_-]{10,200})/.exec(trimmed)?.[1];
  const candidate = fromAddress ?? trimmed;
  return /^[A-Za-z0-9_-]{10,200}$/.test(candidate) ? candidate : null;
}

export type DiagramEntry = Readonly<{
  slideNumber: number;
  objectId: string;
  diagramId: string | null;
  /** The version stamped on the picture: what it shows. */
  pictureVersion: string | null;
  fileId: string | null;
  /** Whether this connector can read the source file (it can only read files it created). */
  readable: boolean;
  /** Whether the source lives in this presentation's own diagram folder (else a write makes a copy). */
  inThisDeckFolder: boolean;
  /** The source file's version, when readable. */
  fileVersion: string | null;
  /** True when the picture shows an older version than its source file; null when unknown. */
  stale: boolean | null;
}>;

export type DiagramListPayload = Readonly<{
  presentationId: string;
  folder: string;
  diagrams: readonly DiagramEntry[];
  note: string;
}>;

export type DiagramReadPayload =
  | Readonly<{
      status: "ok";
      diagramId: string;
      fileId: string;
      fileVersion: string;
      pictureVersion: string | null;
      stale: boolean | null;
      /** Local connector: the XML is in this file. */
      path?: string;
      /** Remote connector: the XML itself. */
      xml?: string;
    }>
  | Readonly<{ status: "not-readable" | "no-source"; diagramId: string | null; fileId: string | null; reason: string; whatToDo: string }>;

export type DiagramWritePayload = Readonly<{
  status: "written";
  diagramId: string;
  fileId: string;
  file: "updated-in-place" | "copied-into-this-deck" | "created";
  copiedFromFileId: string | null;
  /** The pictures that show this diagram here: their links point at `fileId` now. */
  pictures: readonly Readonly<{ slideNumber: number; objectId: string }>[];
  stale: true;
  next: string;
  warnings: readonly string[];
}>;

export type DiagramToolOutcome<TPayload> = Readonly<{ kind: "payload"; payload: TPayload }> | Readonly<{ kind: "error"; message: string }>;

export const NOT_READABLE_ADVICE =
  "Ask the person to open the picture with SashaSlides › Edit diagram in Google Slides, or to give you the .drawio file " +
  "(draw.io: File › Export as). To replace the diagram without reading it, call deck_diagrams write with new XML: that " +
  "writes a new source in this presentation's diagram folder and re-links the pictures to it.";

export const STALE_PICTURE_ADVICE =
  "The pictures still show the previous drawing: the connector cannot draw diagrams. Ask the person to open SashaSlides › " +
  "Edit diagram in this deck, which re-draws stale diagram pictures from their source, or call propose_slides with " +
  "this diagram as `drawio` to show a rendered candidate.";

export async function listDeckDiagrams(
  options: Readonly<{ env: DiagramDeckEnvironment; presentationId: string }>,
): Promise<DiagramToolOutcome<DiagramListPayload>> {
  const { env, presentationId } = options;
  const read = await env.slides.readDeckPictures({ presentationId });
  if (read.kind === "unavailable") return slidesRefused({ what: "deck_diagrams list", reason: read.reason });
  const references = diagramReferencesOf(read.pictures);
  const files = new Map<string, FileState>();
  let deckFolderId: string | null;
  try {
    deckFolderId = await findFolderPath({ drive: env.drive, path: diagramFolderPath(presentationId) });
    for (const fileId of new Set(references.flatMap((reference) => (reference.fileId === null ? [] : [reference.fileId])))) {
      files.set(fileId, await fileState({ drive: env.drive, fileId }));
    }
  } catch (cause) {
    return { kind: "error", message: `deck_diagrams list: Drive failed while reading the diagram sources: ${describeCause(cause)}` };
  }
  const diagrams = references.flatMap((reference): DiagramEntry[] => {
    const picture = pictureOf({ pictures: read.pictures, objectId: reference.objectId });
    const state = reference.fileId === null ? null : (files.get(reference.fileId) ?? null);
    const location = state?.location ?? null;
    const nameId = location === null ? null : diagramIdOfFileName(location.name);
    // A linked picture with no stamp is a diagram only when its link reaches a diagram file.
    if (reference.stamp === null && nameId === null) return [];
    const pictureVersion = reference.stamp?.version ?? null;
    const fileVersion = state?.version ?? null;
    return [
      {
        slideNumber: picture?.slideNumber ?? 0,
        objectId: reference.objectId,
        diagramId: reference.stamp?.diagramId ?? nameId,
        pictureVersion,
        fileId: reference.fileId,
        readable: location !== null,
        inThisDeckFolder: deckFolderId !== null && location !== null && location.parentIds.includes(deckFolderId),
        fileVersion,
        stale: pictureVersion === null || fileVersion === null ? null : pictureVersion !== fileVersion,
      },
    ];
  });
  return {
    kind: "payload",
    payload: {
      presentationId,
      folder: diagramFolderPath(presentationId).join("/"),
      diagrams,
      note:
        diagrams.length === 0
          ? "No diagram pictures in this deck. Insert one with propose_slides and a `drawio` slide."
          : "readable:false means the source was created outside this connector (Google's drive.file permission only reaches " +
            "files the connector created). stale:true means the picture shows an older version than its source.",
    },
  };
}

export async function readDeckDiagram(
  options: Readonly<{ env: DiagramDeckEnvironment; presentationId: string; target: DiagramTarget }>,
): Promise<DiagramToolOutcome<DiagramReadPayload>> {
  const { env, presentationId, target } = options;
  const read = await env.slides.readDeckPictures({ presentationId });
  if (read.kind === "unavailable") return slidesRefused({ what: "deck_diagrams read", reason: read.reason });
  const selected = selectReferences({ references: diagramReferencesOf(read.pictures), target });
  if (selected.kind === "error") return { kind: "error", message: `deck_diagrams read: ${selected.message}` };
  const { diagramId, fileId } = selected;
  const pictureVersion = selected.references.map((reference) => reference.stamp?.version ?? null).find((version) => version !== null) ?? null;
  if (fileId === null) {
    return {
      kind: "payload",
      payload: {
        status: "no-source",
        diagramId,
        fileId: null,
        reason: "the picture carries no link to a source file",
        whatToDo: "Write a source for it with deck_diagrams write (new XML), or ask the person to open it with SashaSlides › Edit diagram.",
      },
    };
  }
  let state: FileState;
  try {
    state = await fileState({ drive: env.drive, fileId });
  } catch (cause) {
    return { kind: "error", message: `deck_diagrams read: Drive failed while reading ${fileId}: ${describeCause(cause)}` };
  }
  if (state.location === null || state.xml === null || state.version === null) {
    return {
      kind: "payload",
      payload: {
        status: "not-readable",
        diagramId,
        fileId,
        reason:
          state.location === null
            ? "the source file was created outside this connector (the SashaSlides add-on, or by hand), and Google's drive.file permission only lets the connector read files it created"
            : "the source file is not draw.io XML",
        whatToDo: NOT_READABLE_ADVICE,
      },
    };
  }
  const id = diagramId ?? diagramIdOfFileName(state.location.name) ?? diagramIdForSource(state.xml);
  const stale = pictureVersion === null ? null : pictureVersion !== state.version;
  const common = { status: "ok" as const, diagramId: id, fileId, fileVersion: state.version, pictureVersion, stale };
  return {
    kind: "payload",
    payload: env.remote ? { ...common, xml: state.xml } : { ...common, path: env.saveLocalCopy({ presentationId, diagramId: id, xml: state.xml }) },
  };
}

export async function writeDeckDiagram(
  options: Readonly<{ env: DiagramDeckEnvironment; presentationId: string; target: DiagramTarget; xml: string }>,
): Promise<DiagramToolOutcome<DiagramWritePayload>> {
  const { env, presentationId, target, xml } = options;
  const read = await env.slides.readDeckPictures({ presentationId });
  if (read.kind === "unavailable") return slidesRefused({ what: "deck_diagrams write", reason: read.reason });
  const references = diagramReferencesOf(read.pictures);
  const selected = selectReferences({ references, target });
  if (selected.kind === "error") return { kind: "error", message: `deck_diagrams write: ${selected.message}` };

  let plan: DiagramSavePlan;
  let source: DriveFileLocation | null;
  try {
    source = selected.fileId === null ? null : await env.drive.fileLocation({ fileId: selected.fileId });
    const diagramId = selected.diagramId ?? (source === null ? null : diagramIdOfFileName(source.name)) ?? diagramIdForSource(xml);
    const deckFolderId = await findFolderPath({ drive: env.drive, path: diagramFolderPath(presentationId) });
    const names = deckFolderId === null ? [] : (await listFolder({ drive: env.drive, folderId: deckFolderId })).map((file) => file.name);
    plan = planDiagramSave({
      presentationId,
      diagramId,
      // A linked file this connector cannot see is still the source: never "owned", so it is copied.
      source: selected.fileId === null ? null : { fileId: selected.fileId, parentFolderIds: source?.parentIds ?? [] },
      deckFolderId,
      deckFolderFileNames: names,
      references,
      editedObjectId: target.kind === "object-id" ? target.objectId : null,
    });
  } catch (cause) {
    return { kind: "error", message: `deck_diagrams write: could not read the diagram's Drive folder: ${describeCause(cause)}. Nothing was changed.` };
  }

  let fileId: string;
  try {
    fileId = await executeFileAction({ drive: env.drive, plan, xml });
  } catch (cause) {
    return { kind: "error", message: `deck_diagrams write: could not save the source: ${describeCause(cause)}. Nothing was changed.` };
  }

  const warnings: string[] = [];
  const requests = relinkRequests({ plan, references, fileId });
  if (requests.length > 0) {
    const updated = await env.slides.updatePresentation({ presentationId, requests });
    if (updated.kind === "unavailable") {
      warnings.push(`the source was saved as ${diagramFileName(plan.diagramId)}, but the pictures could not be re-linked to it: ${updated.reason}`);
    }
  }
  return {
    kind: "payload",
    payload: {
      status: "written",
      diagramId: plan.diagramId,
      fileId,
      file: fileOutcomeOf(plan),
      copiedFromFileId: plan.file.kind === "create" ? plan.file.copiedFromFileId : null,
      pictures: plan.imageObjectIds.map((objectId) => ({ slideNumber: pictureOf({ pictures: read.pictures, objectId })?.slideNumber ?? 0, objectId })),
      stale: true,
      next: STALE_PICTURE_ADVICE,
      warnings,
    },
  };
}

/**
 * The batchUpdate that re-points every picture of the plan to `fileId`: the link where it differs,
 * and the stamp's id where a copy took a new name. The stamp's VERSION is kept as it was, because
 * the picture still shows that version (so it reads as stale until it is re-drawn).
 */
export function relinkRequests(
  options: Readonly<{ plan: DiagramSavePlan; references: readonly DiagramReference[]; fileId: string }>,
): readonly SlidesApiRequest[] {
  const { plan, references, fileId } = options;
  return plan.imageObjectIds.flatMap((objectId): SlidesApiRequest[] => {
    const reference = references.find((candidate) => candidate.objectId === objectId);
    const requests: SlidesApiRequest[] = [];
    if (reference?.fileId !== fileId) {
      requests.push({ updateImageProperties: { objectId, imageProperties: { link: { url: driveFileAddress(fileId) } }, fields: "link" } });
    }
    if (reference?.stamp?.diagramId !== plan.diagramId) {
      requests.push({
        updatePageElementAltText: { objectId, description: drawioAltText({ diagramId: plan.diagramId, version: reference?.stamp?.version ?? null }) },
      });
    }
    return requests;
  });
}

function fileOutcomeOf(plan: DiagramSavePlan): DiagramWritePayload["file"] {
  switch (plan.file.kind) {
    case "update":
      return "updated-in-place";
    case "create":
      return plan.file.copiedFromFileId === null ? "created" : "copied-into-this-deck";
    default:
      return assertNever(plan.file);
  }
}

async function executeFileAction(options: Readonly<{ drive: DriveChannel; plan: DiagramSavePlan; xml: string }>): Promise<string> {
  const { drive, plan, xml } = options;
  const media = { kind: "text" as const, text: xml };
  switch (plan.file.kind) {
    case "update":
      return (await drive.updateFileContent({ fileId: plan.file.fileId, mimeType: DRAWIO_FILE_MEDIA_TYPE, media })).id;
    case "create": {
      const folderId = await ensureFolderPath({ drive, path: plan.file.folderPath });
      return (await drive.createFile({ name: plan.file.fileName, parentId: folderId, mimeType: DRAWIO_FILE_MEDIA_TYPE, media, appProperties: {} })).id;
    }
    default:
      return assertNever(plan.file);
  }
}

type SelectedReferences = Readonly<{
  kind: "ok";
  references: readonly DiagramReference[];
  diagramId: string | null;
  fileId: string | null;
}>;

function selectReferences(
  options: Readonly<{ references: readonly DiagramReference[]; target: DiagramTarget }>,
): SelectedReferences | Readonly<{ kind: "error"; message: string }> {
  const { references, target } = options;
  switch (target.kind) {
    case "object-id": {
      const reference = references.find((candidate) => candidate.objectId === target.objectId);
      if (reference === undefined) {
        return { kind: "error", message: `no diagram picture has object id ${target.objectId}; deck_diagrams list shows the ones there are` };
      }
      return { kind: "ok", references: [reference], diagramId: reference.stamp?.diagramId ?? null, fileId: reference.fileId };
    }
    case "diagram-id": {
      const matching = references.filter((candidate) => candidate.stamp?.diagramId === target.diagramId);
      if (matching.length === 0) {
        return { kind: "error", message: `no picture in this deck is stamped with diagram ${target.diagramId}; deck_diagrams list shows the ones there are` };
      }
      const fileId = matching.find((candidate) => candidate.fileId !== null)?.fileId ?? null;
      return { kind: "ok", references: matching, diagramId: target.diagramId, fileId };
    }
    default:
      return assertNever(target);
  }
}

type FileState = Readonly<{ location: DriveFileLocation | null; xml: string | null; version: string | null }>;

async function fileState(options: Readonly<{ drive: DriveChannel; fileId: string }>): Promise<FileState> {
  const location = await options.drive.fileLocation({ fileId: options.fileId });
  if (location === null) return { location: null, xml: null, version: null };
  const parsed = parseDrawioSource(await options.drive.readTextFile({ fileId: options.fileId }));
  return parsed.kind === "ok" ? { location, xml: parsed.xml, version: diagramVersionOf(parsed.xml) } : { location, xml: null, version: null };
}

function pictureOf(options: Readonly<{ pictures: readonly SlidePicture[]; objectId: string }>): SlidePicture | null {
  return options.pictures.find((picture) => picture.objectId === options.objectId) ?? null;
}

function slidesRefused<TPayload>(options: Readonly<{ what: string; reason: string }>): DiagramToolOutcome<TPayload> {
  return {
    kind: "error",
    message:
      `${options.what}: Google Slides would not return that deck: ${options.reason}. The connector reads decks with your ` +
      "own grant, so check the deck id and that your account can open it.",
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
