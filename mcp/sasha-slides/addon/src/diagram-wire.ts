// THE DIAGRAM DIALOG'S PARSE BOUNDARY: the seed Code.gs appends to Diagram.html (diagram-host.ts
// `diagramBootOf`) and the replies of the three diagram server functions. Everything crossing from
// Apps Script is `unknown` here and a typed value, or a reason, afterwards; nothing above this file
// reads a raw `presentations.get` reply or a raw Drive file.

import { mxfileFromPngBytes, parseDrawioSource } from "../../converter/drawio-diagram.ts";
import type { DeckPicture } from "../../converter/drawio-save-plan.ts";
import { asRecord, stringAt } from "./json-fields.ts";
import type { Parsed } from "./protocol.ts";

/** One picture of the deck, with what the dialog shows beside it. Sizes are EMU, as drawn. */
export type DeckPictureRow = DeckPicture &
  Readonly<{
    /** 1-based, as the filmstrip shows it. */
    slideNumber: number;
    widthEmu: number;
    heightEmu: number;
  }>;

export type EmuSize = Readonly<{ width: number; height: number }>;

/** What the dialog knows about the open presentation. */
export type DiagramModel = Readonly<{
  presentationId: string;
  pageSize: EmuSize;
  /** The deck's slide ids in order, so a new picture can say which slide it landed on. */
  slideObjectIds: readonly string[];
  pictures: readonly DeckPictureRow[];
  selection: Readonly<{ pageObjectId: string | null; objectIds: readonly string[] }>;
  /**
   * `sasha_slides/slide/<presentationId>/drawio`, when it exists: the first such folder (where new
   * files go), every such folder (the connector may have made a second tree), and the names in all.
   */
  folder: Readonly<{ folderId: string; folderIds: readonly string[]; fileNames: readonly string[] }> | null;
}>;

/** A diagram's source file, read and parsed, or why it cannot be edited. */
export type DiagramSourceRead =
  | Readonly<{ kind: "read"; fileId: string; name: string; parentFolderIds: readonly string[]; xml: string }>
  | Readonly<{ kind: "unreadable"; fileId: string; reason: string }>;

export type DiagramSeed = Readonly<{ model: DiagramModel; selectedSource: DiagramSourceRead | null }>;

/** The element Code.gs appends the seed under (diagram-code-gs.ts `sashaOpenDiagrams`). */
export const DIAGRAM_SEED_ELEMENT_ID = "sasha-diagram-seed";

/** Google's default 16:9 page, used only when the reply carries no page size. */
const DEFAULT_PAGE_SIZE: EmuSize = { width: 9_144_000, height: 5_143_500 };
const EMU_PER_POINT = 12_700;

/** The seed text, parsed. A seed that says `failed` is the reason Code.gs could not read the deck. */
export function parseDiagramSeed(text: string): Parsed<DiagramSeed> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "the dialog's seed is not JSON" };
  }
  const record = asRecord(value);
  if (record === null) return { kind: "invalid", reason: "the dialog's seed is not an object" };
  const failed = stringAt({ record, key: "failed" });
  if (failed !== null) return { kind: "invalid", reason: failed };
  const presentationId = stringAt({ record, key: "presentationId" });
  if (presentationId === null || !/^[A-Za-z0-9_-]{10,200}$/.test(presentationId)) return { kind: "invalid", reason: "the seed names no presentation" };
  const deck = asRecord(record["deck"]) ?? {};
  const selection = asRecord(record["selection"]) ?? {};
  const pageObjectId = stringAt({ record: selection, key: "pageObjectId" });
  const folder = asRecord(record["folder"]);
  const folderId = folder === null ? null : stringAt({ record: folder, key: "folderId" });
  const selected = asRecord(record["selectedSource"]);
  return {
    kind: "ok",
    value: {
      model: {
        presentationId,
        pageSize: pageSizeOf(deck["pageSize"]),
        slideObjectIds: slidesOf(deck).map((slide) => slide.objectId),
        pictures: picturesOf(deck),
        selection: { pageObjectId, objectIds: stringsOf(selection["objectIds"]) },
        folder: folder === null || folderId === null ? null : { folderId, folderIds: folderIdsOf({ folderId, listed: stringsOf(folder["folderIds"]) }), fileNames: stringsOf(folder["fileNames"]) },
      },
      selectedSource: selected === null ? null : diagramSourceOf(selected),
    },
  };
}

/** `sashaReadDiagramSources`'s reply: one read per file asked for. */
export function parseDiagramSourcesReply(value: unknown): Parsed<readonly DiagramSourceRead[]> {
  const files = asRecord(value)?.["files"];
  if (!Array.isArray(files)) return { kind: "invalid", reason: "sashaReadDiagramSources returned no files" };
  const reads: DiagramSourceRead[] = [];
  for (const entry of files as readonly unknown[]) {
    const record = asRecord(entry);
    if (record === null) return { kind: "invalid", reason: "a diagram source entry is not an object" };
    reads.push(diagramSourceOf(record));
  }
  return { kind: "ok", value: reads };
}

/** `sashaSaveDiagram`'s reply. */
export type DiagramSaved = Readonly<{ fileId: string; folderId: string | null; created: boolean }>;

export function parseDiagramSaveReply(value: unknown): Parsed<DiagramSaved> {
  const record = asRecord(value);
  const fileId = record === null ? null : stringAt({ record, key: "fileId" });
  if (record === null || fileId === null) return { kind: "invalid", reason: "sashaSaveDiagram returned no file id" };
  return { kind: "ok", value: { fileId, folderId: stringAt({ record, key: "folderId" }), created: record["created"] === true } };
}

/** `sashaLinkInsertedDiagrams`'s reply. */
export type DiagramsLinked = Readonly<{ folderId: string; links: readonly Readonly<{ fileName: string; fileId: string; reused: boolean }>[] }>;

export function parseDiagramLinkReply(value: unknown): Parsed<DiagramsLinked> {
  const record = asRecord(value);
  const folderId = record === null ? null : stringAt({ record, key: "folderId" });
  const links = record === null ? null : record["links"];
  if (record === null || folderId === null || !Array.isArray(links)) return { kind: "invalid", reason: "sashaLinkInsertedDiagrams returned no links" };
  const parsed: Readonly<{ fileName: string; fileId: string; reused: boolean }>[] = [];
  for (const link of links as readonly unknown[]) {
    const entry = asRecord(link);
    const fileName = entry === null ? null : stringAt({ record: entry, key: "fileName" });
    const fileId = entry === null ? null : stringAt({ record: entry, key: "fileId" });
    if (entry === null || fileName === null || fileId === null) return { kind: "invalid", reason: "a diagram link names no file" };
    parsed.push({ fileName, fileId, reused: entry["reused"] === true });
  }
  return { kind: "ok", value: { folderId, links: parsed } };
}

/**
 * One `{ fileId, file, error }` entry as a source. The bytes always arrive as base64: a `.drawio.png`
 * carries its source in a PNG chunk, every other shape is text (`parseDrawioSource`).
 */
export function diagramSourceOf(record: Readonly<Record<string, unknown>>): DiagramSourceRead {
  const fileId = stringAt({ record, key: "fileId" }) ?? "";
  const error = stringAt({ record, key: "error" });
  const file = asRecord(record["file"]);
  if (file === null) return { kind: "unreadable", fileId, reason: error ?? "the file could not be read" };
  const name = stringAt({ record: file, key: "name" }) ?? "";
  const base64 = stringAt({ record: file, key: "base64" });
  if (base64 === null) return { kind: "unreadable", fileId, reason: "the file came back without its contents" };
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return { kind: "unreadable", fileId, reason: "the file's contents are not base64" };
  }
  const embedded = mxfileFromPngBytes(bytes);
  const text = embedded ?? new TextDecoder().decode(bytes);
  const parsed = parseDrawioSource(text);
  switch (parsed.kind) {
    case "ok":
      return { kind: "read", fileId, name, parentFolderIds: stringsOf(file["parentFolderIds"]), xml: parsed.xml };
    case "invalid":
      return { kind: "unreadable", fileId, reason: `${name || fileId} is not a draw.io diagram: ${parsed.reason}` };
    default: {
      const unknownParse: never = parsed;
      return unknownParse;
    }
  }
}

type RawSlide = Readonly<{ objectId: string; elements: readonly unknown[] }>;

function slidesOf(deck: Readonly<Record<string, unknown>>): readonly RawSlide[] {
  const slides = deck["slides"];
  if (!Array.isArray(slides)) return [];
  return (slides as readonly unknown[]).flatMap((slide) => {
    const record = asRecord(slide);
    const objectId = record === null ? null : stringAt({ record, key: "objectId" });
    if (record === null || objectId === null) return [];
    const elements = record["pageElements"];
    return [{ objectId, elements: Array.isArray(elements) ? (elements as readonly unknown[]) : [] }];
  });
}

/** Every picture, groups opened, in slide order. */
function picturesOf(deck: Readonly<Record<string, unknown>>): readonly DeckPictureRow[] {
  const rows: DeckPictureRow[] = [];
  slidesOf(deck).forEach((slide, at) => {
    const pending = [...slide.elements];
    while (pending.length > 0) {
      const record = asRecord(pending.shift());
      if (record === null) continue;
      const children = asRecord(record["elementGroup"])?.["children"];
      if (Array.isArray(children)) pending.push(...(children as readonly unknown[]));
      const image = asRecord(record["image"]);
      const objectId = stringAt({ record, key: "objectId" });
      if (image === null || objectId === null) continue;
      const link = asRecord(asRecord(image["imageProperties"])?.["link"]);
      const size = drawnSizeOf({ size: record["size"], transform: record["transform"] });
      rows.push({
        pageObjectId: slide.objectId,
        objectId,
        description: stringAt({ record, key: "description" }),
        linkUrl: link === null ? null : stringAt({ record: link, key: "url" }),
        slideNumber: at + 1,
        widthEmu: size.width,
        heightEmu: size.height,
      });
    }
  });
  return rows;
}

function pageSizeOf(value: unknown): EmuSize {
  const record = asRecord(value);
  if (record === null) return DEFAULT_PAGE_SIZE;
  const width = emuOf(record["width"]);
  const height = emuOf(record["height"]);
  return width > 0 && height > 0 ? { width, height } : DEFAULT_PAGE_SIZE;
}

function drawnSizeOf(options: Readonly<{ size: unknown; transform: unknown }>): EmuSize {
  const size = asRecord(options.size);
  const transform = asRecord(options.transform) ?? {};
  const scaleX = typeof transform["scaleX"] === "number" ? transform["scaleX"] : 1;
  const scaleY = typeof transform["scaleY"] === "number" ? transform["scaleY"] : 1;
  if (size === null) return { width: 0, height: 0 };
  return { width: Math.abs(emuOf(size["width"]) * scaleX), height: Math.abs(emuOf(size["height"]) * scaleY) };
}

/** A Slides Dimension in EMU (the API answers in EMU or PT); 0 when absent. */
function emuOf(value: unknown): number {
  const record = asRecord(value);
  const magnitude = record === null ? null : record["magnitude"];
  if (record === null || typeof magnitude !== "number") return 0;
  return record["unit"] === "PT" ? magnitude * EMU_PER_POINT : magnitude;
}

function folderIdsOf(options: Readonly<{ folderId: string; listed: readonly string[] }>): readonly string[] {
  return options.listed.includes(options.folderId) ? options.listed : [options.folderId, ...options.listed];
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as readonly unknown[]).filter((item): item is string => typeof item === "string") : [];
}
