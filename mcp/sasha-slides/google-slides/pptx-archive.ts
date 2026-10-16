/**
 * Reading a .pptx without a dependency: its zip entries and its XML parts as element trees.
 *
 * WHY HAND-WRITTEN: the connector image installs only mcp/sasha-slides/deploy/package.json, which
 * has no zip or XML library, and the parts the import reads (presentation.xml, its relationships
 * and the slides) are plain deflated XML. A .pptx Google Drive exports is a small, well-formed,
 * non-ZIP64 archive, so the central directory plus `node:zlib`'s raw inflate is all it takes.
 *
 * DEFENSIVE BY CONSTRUCTION: the archive is untrusted bytes from the network. Every offset is
 * bounds-checked, an entry may not inflate past MAXIMUM_ENTRY_BYTES (a zip bomb stops there), and
 * any malformation is a thrown `PptxArchiveError` the caller turns into a reported loss.
 */
import { inflateRawSync } from "node:zlib";

export class PptxArchiveError extends Error {}

export type PptxArchive = Readonly<{
  /** Entry names as stored, e.g. `ppt/slides/slide1.xml`. */
  names: readonly string[];
  /** The entry's text (UTF-8), or null when the archive has no such entry. */
  text(name: string): string | null;
}>;

/** One XML element: its qualified name (`p:sp`), its attributes and its child elements in order. */
export type XmlElement = Readonly<{
  name: string;
  attributes: ReadonlyMap<string, string>;
  children: readonly XmlElement[];
}>;

/** Far above any slide part; a part that inflates past this is refused, not read. */
export const MAXIMUM_ENTRY_BYTES = 32 * 1024 * 1024;

export function openPptxArchive(bytes: Uint8Array): PptxArchive {
  const entries = centralDirectoryOf(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    names: entries.map((entry) => entry.name),
    text: (name) => {
      const entry = byName.get(name);
      if (entry === undefined) return null;
      return Buffer.from(entryBytes({ archive: bytes, entry })).toString("utf-8");
    },
  };
}

/**
 * The document element of an XML part. Text content is dropped (the import reads attributes and
 * structure only); processing instructions, comments, CDATA and the doctype are skipped.
 */
export function parseXml(text: string): XmlElement {
  const root: MutableElement = { name: "#document", attributes: new Map(), children: [] };
  const open: MutableElement[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
    const name = match[2];
    if (name === undefined) continue;
    const parent = open[open.length - 1];
    if (parent === undefined) throw new PptxArchiveError(`XML closes more elements than it opened (at ${match.index})`);
    if (match[1] === "/") {
      if (parent.name !== name || open.length === 1) throw new PptxArchiveError(`XML closes <${name}> inside <${parent.name}> (at ${match.index})`);
      open.pop();
      continue;
    }
    const element: MutableElement = { name, attributes: attributesOf(match[3] ?? ""), children: [] };
    parent.children.push(element);
    if (match[4] !== "/") open.push(element);
  }
  if (open.length !== 1) throw new PptxArchiveError(`XML leaves <${open[open.length - 1]?.name ?? "?"}> unclosed`);
  const documentElement = root.children[0];
  if (documentElement === undefined) throw new PptxArchiveError("the XML part has no element");
  return documentElement;
}

/** The first child named `name`, or null. */
export function childNamed(element: XmlElement | null, name: string): XmlElement | null {
  return element?.children.find((child) => child.name === name) ?? null;
}

/** Every child named `name`, in document order. */
export function childrenNamed(element: XmlElement | null, name: string): readonly XmlElement[] {
  return element?.children.filter((child) => child.name === name) ?? [];
}

/** The first element named `name` anywhere below `element` (depth first), or null. */
export function descendantNamed(element: XmlElement | null, name: string): XmlElement | null {
  if (element === null) return null;
  for (const child of element.children) {
    if (child.name === name) return child;
    const found = descendantNamed(child, name);
    if (found !== null) return found;
  }
  return null;
}

type MutableElement = { name: string; attributes: ReadonlyMap<string, string>; children: MutableElement[] };

function attributesOf(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1];
    if (name === undefined) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? ""));
  }
  return attributes;
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES.get(body) ?? whole;
  });
}

type CentralEntry = Readonly<{ name: string; method: number; compressedSize: number; uncompressedSize: number; localHeaderOffset: number }>;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** The end record is 22 bytes plus a comment of at most 65535. */
const LONGEST_END_RECORD = 22 + 0xffff;
const STORED = 0;
const DEFLATED = 8;

function centralDirectoryOf(bytes: Uint8Array): readonly CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = endRecordOffset({ bytes, view });
  const entryCount = view.getUint16(endOffset + 10, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) throw new PptxArchiveError("ZIP64 archives are not read");
  const entries: CentralEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    requireRange({ bytes, offset, length: 46 });
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) throw new PptxArchiveError(`central directory entry ${index} is malformed`);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    requireRange({ bytes, offset: offset + 46, length: nameLength });
    entries.push({
      name: Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString("utf-8"),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function endRecordOffset(options: Readonly<{ bytes: Uint8Array; view: DataView }>): number {
  const { bytes, view } = options;
  const lowest = Math.max(0, bytes.byteLength - LONGEST_END_RECORD);
  for (let offset = bytes.byteLength - 22; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new PptxArchiveError("not a zip archive (no end of central directory record)");
}

function entryBytes(options: Readonly<{ archive: Uint8Array; entry: CentralEntry }>): Uint8Array {
  const { archive, entry } = options;
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  requireRange({ bytes: archive, offset: entry.localHeaderOffset, length: 30 });
  if (view.getUint32(entry.localHeaderOffset, true) !== LOCAL_FILE_HEADER) throw new PptxArchiveError(`${entry.name}: local header is malformed`);
  const dataOffset = entry.localHeaderOffset + 30 + view.getUint16(entry.localHeaderOffset + 26, true) + view.getUint16(entry.localHeaderOffset + 28, true);
  requireRange({ bytes: archive, offset: dataOffset, length: entry.compressedSize });
  const data = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.uncompressedSize > MAXIMUM_ENTRY_BYTES) throw new PptxArchiveError(`${entry.name}: ${entry.uncompressedSize} bytes is more than a part may hold`);
  switch (entry.method) {
    case STORED:
      return data;
    case DEFLATED:
      try {
        return inflateRawSync(data, { maxOutputLength: MAXIMUM_ENTRY_BYTES });
      } catch (cause) {
        throw new PptxArchiveError(`${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    default:
      throw new PptxArchiveError(`${entry.name}: compression method ${entry.method} is not read`);
  }
}

function requireRange(options: Readonly<{ bytes: Uint8Array; offset: number; length: number }>): void {
  if (options.offset < 0 || options.offset + options.length > options.bytes.byteLength) throw new PptxArchiveError("the archive is truncated");
}
