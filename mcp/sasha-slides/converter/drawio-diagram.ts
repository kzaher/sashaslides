/**
 * drawio-diagram.ts — what a draw.io diagram IS in this product, shared by the converter (browser),
 * the add-on (browser, HtmlService), the connector (Node) and the developer page.
 *
 * THE MODEL. A diagram on a slide is a PICTURE (the rendered PNG) that
 *   - carries the alternative-text description `drawio:<diagramId>;v=<version>`, and
 *   - links (`imageProperties.link.url`) to its editable source, a `.drawio` file (plain `<mxfile>`
 *     XML) in the presenting user's Drive at
 *       sasha_slides / slide / <presentationId> / drawio / <diagramId>.drawio
 *
 * WHERE THAT PATH COMES FROM. The previous Drive store (renderer/html2slides/drawio-store.ts, the old
 * add-on's `saveDiagram`) laid diagrams out as `drawio / <kind> / <documentId> / <id>.drawio.svg`,
 * where `<kind>` is `slide` (a Google Slides presentation) or `doc` (a Google Doc) and `<documentId>`
 * is that Google file's id. The user asked for `sasha_slides/slide/<id>/drawio/<drawio_id>.drawio`:
 * the same `<kind>` and the same `<documentId>` (the PRESENTATION id), under one product root.
 *
 * The version is a hash of the XML, so a reader can tell that the picture is older than its source
 * (an agent wrote new XML through the connector) without downloading the picture.
 *
 * Pure: no DOM, no Node, no I/O. Every caller does its own Drive and Slides calls.
 */

/** `<script type="application/vnd.drawio+xml" id="drawio-source">` in slide HTML (extract-dom.ts). */
export const DRAWIO_SOURCE_SCRIPT_TYPE = "application/vnd.drawio+xml";
export const DRAWIO_SOURCE_ELEMENT_ID = "drawio-source";
/** The attribute on the rendered `<svg>`/`<img>` that visualises the source (extract-dom.ts pairs it). */
export const DRAWIO_RENDER_ATTRIBUTE = "data-drawio";
/**
 * A placeholder the converter fills by rendering the source first (`renderDrawio` option): what the
 * connector writes when an agent hands it bare draw.io XML, which has no picture yet.
 */
export const DRAWIO_PENDING_ATTRIBUTE = "data-drawio-render";
export const DRAWIO_PENDING_VALUE = "pending";

/** What Drive and diagrams.net call a `.drawio` file. */
export const DRAWIO_FILE_MEDIA_TYPE = "application/vnd.jgraph.mxfile";
export const DRAWIO_FILE_EXTENSION = ".drawio";
/** Accepted on read only: the old store wrote `<id>.drawio.svg` (editable SVG). */
export const LEGACY_DRAWIO_SVG_EXTENSION = ".drawio.svg";

export const DRAWIO_ALT_TEXT_PREFIX = "drawio:";
/** Large enough for any hand-made diagram, small enough for one JSON request and one Apps Script call. */
export const DRAWIO_MAXIMUM_XML_CHARACTERS = 2 * 1024 * 1024;

export const SASHA_DRIVE_ROOT_FOLDER_NAME = "sasha_slides";
export const SLIDES_DOCUMENT_KIND = "slide";
export const DIAGRAM_FOLDER_NAME = "drawio";

export type DiagramStamp = Readonly<{ diagramId: string; version: string | null }>;

export type DrawioSourceParse =
  | Readonly<{ kind: "ok"; xml: string }>
  | Readonly<{ kind: "invalid"; reason: string }>;

/** A new diagram's id: stable for the same source, so re-inserting the same diagram reuses its file. */
export function diagramIdForSource(xml: string): string {
  return `dg${fnv1a8(xml)}`;
}

/** The version stamped next to the id: changes whenever the XML does. */
export function diagramVersionOf(xml: string): string {
  return fnv1a8(xml);
}

/** FNV-1a, 32 bits, as 8 hex digits (the same function convert-pptx-lib.ts named diagrams with). */
export function fnv1a8(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A diagram id is a file-name-safe token; anything else is refused at every boundary. */
export function isDiagramId(text: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(text);
}

/** The picture's alternative-text description. */
export function drawioAltText(stamp: DiagramStamp): string {
  if (!isDiagramId(stamp.diagramId)) throw new Error(`not a diagram id: ${stamp.diagramId}`);
  return stamp.version === null ? `${DRAWIO_ALT_TEXT_PREFIX}${stamp.diagramId}` : `${DRAWIO_ALT_TEXT_PREFIX}${stamp.diagramId};v=${stamp.version}`;
}

/**
 * The stamp in a picture's description, or null. Tolerates the old `drawio:<id>` form
 * (convert-pptx-lib.ts) and text around it, since a person may have typed more alt text.
 */
export function parseDrawioAltText(description: string | null | undefined): DiagramStamp | null {
  if (typeof description !== "string") return null;
  const match = /(?:^|\s)drawio:([A-Za-z0-9_-]{1,64})(?:;v=([0-9a-f]{8}))?(?=$|\s)/.exec(description);
  const diagramId = match?.[1];
  if (diagramId === undefined) return null;
  return { diagramId, version: match?.[2] ?? null };
}

/** Folder names from My Drive's root down to the folder that holds this presentation's diagrams. */
export function diagramFolderPath(presentationId: string): readonly string[] {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(presentationId)) throw new Error(`not a presentation id: ${presentationId}`);
  return [SASHA_DRIVE_ROOT_FOLDER_NAME, SLIDES_DOCUMENT_KIND, presentationId, DIAGRAM_FOLDER_NAME];
}

export function diagramFileName(diagramId: string): string {
  if (!isDiagramId(diagramId)) throw new Error(`not a diagram id: ${diagramId}`);
  return `${diagramId}${DRAWIO_FILE_EXTENSION}`;
}

/** `<id>.drawio` or the legacy `<id>.drawio.svg` → `<id>`; null for any other name. */
export function diagramIdOfFileName(name: string): string | null {
  const stem = name.endsWith(LEGACY_DRAWIO_SVG_EXTENSION)
    ? name.slice(0, -LEGACY_DRAWIO_SVG_EXTENSION.length)
    : name.endsWith(DRAWIO_FILE_EXTENSION)
      ? name.slice(0, -DRAWIO_FILE_EXTENSION.length)
      : null;
  return stem !== null && isDiagramId(stem) ? stem : null;
}

/** The address a picture links to: Drive's own viewer, which offers "Open with diagrams.net". */
export function driveFileAddress(fileId: string): string {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new Error(`not a Drive file id: ${fileId}`);
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/** The Drive file id in a link this product (or the old add-on, or a person) put on a picture. */
export function driveFileIdOfAddress(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "drive.google.com" && url.hostname !== "docs.google.com") return null;
  const byPath = /^\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/.exec(url.pathname)?.[1];
  if (byPath !== undefined) return byPath;
  const byQuery = url.searchParams.get("id");
  return byQuery !== null && /^[A-Za-z0-9_-]{10,200}$/.test(byQuery) ? byQuery : null;
}

/**
 * Any of the shapes a diagram's source arrives in, as `<mxfile>` XML: a `.drawio` file, a bare
 * `<mxGraphModel>`, or an editable SVG (`<svg content="&lt;mxfile…">`, what draw.io's `xmlsvg` export
 * and the old `.drawio.svg` store hold). Validates only the outer shape: draw.io itself parses it.
 */
export function parseDrawioSource(text: string): DrawioSourceParse {
  if (text.length > DRAWIO_MAXIMUM_XML_CHARACTERS) return { kind: "invalid", reason: `the diagram is larger than ${DRAWIO_MAXIMUM_XML_CHARACTERS} characters` };
  const trimmed = text.replace(/^﻿/, "").trim();
  const body = trimmed.replace(/^<\?xml[^>]*\?>\s*/, "");
  if (/^<mxfile[\s>]/.test(body)) return /<\/mxfile>\s*$/.test(body) || /\/>\s*$/.test(body) ? { kind: "ok", xml: body } : { kind: "invalid", reason: "the <mxfile> element is not closed" };
  if (/^<mxGraphModel[\s>]/.test(body)) return /<\/mxGraphModel>\s*$/.test(body) ? { kind: "ok", xml: `<mxfile><diagram id="page-1" name="Page-1">${body}</diagram></mxfile>` } : { kind: "invalid", reason: "the <mxGraphModel> element is not closed" };
  if (/^<svg[\s>]/i.test(body) || /^<!DOCTYPE svg/i.test(body)) {
    const embedded = mxfileFromEditableSvg(body);
    if (embedded === null) return { kind: "invalid", reason: "the SVG carries no draw.io source (no content= attribute)" };
    return parseDrawioSource(embedded);
  }
  return { kind: "invalid", reason: "not draw.io XML: expected <mxfile>, <mxGraphModel> or an editable SVG" };
}

/** The `<mxfile>` carried on an editable SVG's root `content` attribute, or null. */
export function mxfileFromEditableSvg(svg: string): string | null {
  const openTag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (openTag === undefined) return null;
  const value = /\bcontent\s*=\s*"([^"]*)"/i.exec(openTag)?.[1] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(openTag)?.[1];
  return value === undefined ? null : unescapeXmlAttribute(value);
}

/**
 * The `<mxfile>` draw.io embeds in a PNG it exported with `xmlpng` (a `tEXt` chunk keyed `mxfile`,
 * percent-encoded), or null. Compressed `zTXt` chunks are not read: draw.io writes `tEXt`.
 */
export function mxfileFromPngBytes(bytes: Uint8Array): string | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((byte, at) => bytes[at] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return null;
    if (type === "IEND") return null;
    if (type === "tEXt") {
      const chunk = bytes.subarray(start, end);
      const separator = chunk.indexOf(0);
      if (separator > 0 && latin1(chunk.subarray(0, separator)) === "mxfile") {
        try {
          return decodeURIComponent(latin1(chunk.subarray(separator + 1)));
        } catch {
          return null;
        }
      }
    }
    offset = end + 4;
  }
  return null;
}

/**
 * The `<script>` that carries a diagram's source inside slide HTML. Valid `<mxfile>` XML holds a raw
 * `</script` only in a text node, never in the attribute values draw.io writes, so splitting that one
 * sequence keeps the element closed where it should be.
 */
export function drawioSourceScript(xml: string): string {
  return `<script type="${DRAWIO_SOURCE_SCRIPT_TYPE}" id="${DRAWIO_SOURCE_ELEMENT_ID}">${xml.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
}

/**
 * A whole 1280x720 candidate slide for a diagram an agent handed over as XML: an optional title and
 * a pending placeholder the converter renders (`renderDrawio`) before it extracts the page.
 */
export function drawioCandidateHtml(options: Readonly<{ xml: string; title: string | null }>): string {
  const title = options.title === null || options.title.trim().length === 0 ? null : options.title.trim();
  const top = title === null ? 40 : 130;
  const heading = title === null ? "" : `<h1 style="position:absolute;left:64px;top:40px;width:1152px;margin:0;font:600 44px/1.2 Arial,sans-serif;color:#1f2937">${escapeHtml(title)}</h1>`;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#slide{position:relative;width:1280px;height:720px;overflow:hidden;background:#ffffff}</style></head>',
    '<body><div id="slide">',
    heading,
    `<div ${DRAWIO_PENDING_ATTRIBUTE}="${DRAWIO_PENDING_VALUE}" style="position:absolute;left:64px;top:${top}px;width:1152px;height:${720 - top - 40}px"></div>`,
    "</div>",
    drawioSourceScript(options.xml),
    "</body></html>",
  ].join("");
}

/** draw.io's own editable-SVG form: `baseSvg` (or an empty one) with the source on `content=`. */
export function editableSvg(options: Readonly<{ xml: string; baseSvg: string | null }>): string {
  const escaped = escapeXmlAttribute(options.xml);
  const base = options.baseSvg ?? "";
  const openTag = /<svg\b[^>]*>/i.exec(base)?.[0];
  if (openTag === undefined) return `<svg xmlns="http://www.w3.org/2000/svg" content="${escaped}"></svg>`;
  const stripped = openTag.replace(/\s+content\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
  const replaced = /\/>\s*$/.test(stripped) ? stripped.replace(/\/>\s*$/, ` content="${escaped}"/>`) : stripped.replace(/>\s*$/, ` content="${escaped}">`);
  return base.replace(openTag, replaced);
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** `&` first, so an entity introduced here is never escaped twice (inverse below). */
function escapeXmlAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `&amp;` last, so a literal `&lt;` in the source (escaped to `&amp;lt;`) survives. */
function unescapeXmlAttribute(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
