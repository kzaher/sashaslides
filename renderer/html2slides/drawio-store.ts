/**
 * drawio-store.ts — Foundation for a Google-Drive-backed store of drawio
 * "editable SVG" diagrams.
 *
 * An editable SVG is drawio's standard interchange format: a normal <svg>
 * whose ROOT element carries a `content="…"` attribute holding the HTML-attr-
 * escaped `<mxfile>` XML. drawio round-trips the diagram from that attribute,
 * so the SVG is both a renderable image AND the editable source.
 *
 * This module has two halves:
 *   - Pure SVG <-> XML plumbing (buildEditableSvg / extractXmlFromEditableSvg).
 *   - Drive I/O (ensureFolderPath / uploadDrawioSvg / getDrawioSvgByPath),
 *     which lays diagrams out under  My Drive / drawio / <kind> / <docId> /
 *     <diagramId>.drawio.svg  and updates-in-place on re-upload.
 *
 * Auth is the project's stored OAuth2 client (see getAuth in convert-pptx-io).
 */

import { google } from "googleapis";
import { Readable } from "stream";

// googleapis' drive() is overloaded; ReturnType resolves to the v3 Drive
// client, which is the only surface these helpers touch.
export type DriveClient = ReturnType<typeof google.drive>;

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SVG_MIME = "image/svg+xml";

// --- SVG <-> XML plumbing -------------------------------------------------

// HTML-attribute escaping. `&` MUST go first so we never double-escape an
// entity we just introduced. Order-symmetric with unescapeXmlAttr below.
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inverse of escapeXmlAttr. `&amp;` MUST go LAST so a literal "&lt;" in the
// source XML (escaped to "&amp;lt;") is not prematurely collapsed.
function unescapeXmlAttr(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// Match the opening <svg …> tag. Attribute values are always quoted and the
// escaped `content` value contains `&gt;` (never a raw `>`), so `[^>]*`
// terminates exactly at the tag's own closing angle bracket.
const SVG_OPEN_RE = /<svg\b[^>]*>/i;

/**
 * Produce a drawio editable SVG carrying `mxfileXml` on its root <svg>.
 * If `baseSvg` is given, its root <svg> gets a fresh `content=` attribute
 * (replacing any pre-existing one); otherwise a minimal valid wrapper is
 * emitted. The result always round-trips through extractXmlFromEditableSvg.
 */
export function buildEditableSvg(mxfileXml: string, baseSvg?: string): string {
  const escaped = escapeXmlAttr(mxfileXml);

  if (baseSvg && baseSvg.trim().length > 0) {
    const m = baseSvg.match(SVG_OPEN_RE);
    if (!m) {
      throw new Error("buildEditableSvg: baseSvg has no parseable <svg> opening tag");
    }
    let openTag = m[0];
    // Strip any existing content attribute (double- or single-quoted).
    openTag = openTag.replace(/\s+content\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
    const insert = ` content="${escaped}"`;
    // Preserve self-closing (<svg …/>) vs. paired (<svg …>) form.
    const newOpen = /\/>\s*$/.test(openTag)
      ? openTag.replace(/\/>\s*$/, `${insert}/>`)
      : openTag.replace(/>\s*$/, `${insert}>`);
    return baseSvg.replace(m[0], newOpen);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" content="${escaped}"></svg>`;
}

/**
 * Recover the `<mxfile>` XML from an editable SVG's root `content=` attribute.
 * Returns null when the root <svg> is absent or carries no content attribute.
 */
export function extractXmlFromEditableSvg(svg: string): string | null {
  const m = svg.match(SVG_OPEN_RE);
  if (!m) return null;
  const openTag = m[0];
  const attr =
    openTag.match(/\bcontent\s*=\s*"([^"]*)"/i) ||
    openTag.match(/\bcontent\s*=\s*'([^']*)'/i);
  if (!attr) return null;
  return unescapeXmlAttr(attr[1]);
}

// --- Path conventions -----------------------------------------------------

/** Folder segments (under My Drive root) for a diagram store namespace. */
export function drawioFolderSegments(kind: "slide" | "doc", docId: string): string[] {
  return ["drawio", kind, docId];
}

/** On-Drive file name for a diagram. */
export function drawioFileName(diagramId: string): string {
  return `${diagramId}.drawio.svg`;
}

// --- Drive I/O ------------------------------------------------------------

// Escape a value for interpolation into a Drive query string literal.
// Backslash first, then the single-quote delimiter.
function escapeQueryValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Find one folder by exact name under `parentId`; null if none.
async function findFolder(
  drive: DriveClient,
  name: string,
  parentId: string,
): Promise<string | null> {
  const q =
    `name = '${escapeQueryValue(name)}' and ` +
    `mimeType = '${FOLDER_MIME}' and ` +
    `'${parentId}' in parents and trashed = false`;
  const res = await drive.files.list({ q, spaces: "drive", fields: "files(id, name)" });
  const hit = res.data.files?.[0];
  return hit?.id ?? null;
}

// Resolve a segment path to its deepest folderId WITHOUT creating; null if any
// segment is missing.
async function resolveFolderPath(
  drive: DriveClient,
  segments: string[],
): Promise<string | null> {
  let parent = "root";
  for (const seg of segments) {
    const found = await findFolder(drive, seg, parent);
    if (!found) return null;
    parent = found;
  }
  return parent;
}

// Find one file by exact name under `folderId`; null if none.
async function findFile(
  drive: DriveClient,
  name: string,
  folderId: string,
): Promise<string | null> {
  const q =
    `name = '${escapeQueryValue(name)}' and ` +
    `'${folderId}' in parents and trashed = false`;
  const res = await drive.files.list({ q, spaces: "drive", fields: "files(id, name)" });
  const hit = res.data.files?.[0];
  return hit?.id ?? null;
}

/**
 * Idempotently create the nested folder path under My Drive root, one segment
 * at a time (query-then-create). Returns the deepest folderId. Any Drive API
 * error propagates — nothing is swallowed.
 */
export async function ensureFolderPath(
  drive: DriveClient,
  segments: string[],
): Promise<string> {
  let parent = "root";
  for (const seg of segments) {
    const existing = await findFolder(drive, seg, parent);
    if (existing) {
      parent = existing;
      continue;
    }
    const created = await drive.files.create({
      requestBody: { name: seg, mimeType: FOLDER_MIME, parents: [parent] },
      fields: "id",
    });
    const id = created.data.id;
    if (!id) throw new Error(`ensureFolderPath: folder create returned no id for '${seg}'`);
    parent = id;
  }
  return parent;
}

/**
 * Write `svgContent` as `fileName` inside `folderId`. Updates in place if a
 * file of that name already exists there, otherwise creates it. Returns the
 * fileId and webViewLink.
 */
export async function uploadDrawioSvg(
  drive: DriveClient,
  folderId: string,
  fileName: string,
  svgContent: string,
): Promise<{ fileId: string; webViewLink: string }> {
  const media = { mimeType: SVG_MIME, body: Readable.from(Buffer.from(svgContent, "utf-8")) };
  const existing = await findFile(drive, fileName, folderId);

  if (existing) {
    const res = await drive.files.update({ fileId: existing, media, fields: "id, webViewLink" });
    const id = res.data.id;
    if (!id) throw new Error(`uploadDrawioSvg: update returned no id for '${fileName}'`);
    return { fileId: id, webViewLink: res.data.webViewLink ?? "" };
  }

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: SVG_MIME },
    media,
    fields: "id, webViewLink",
  });
  const id = res.data.id;
  if (!id) throw new Error(`uploadDrawioSvg: create returned no id for '${fileName}'`);
  return { fileId: id, webViewLink: res.data.webViewLink ?? "" };
}

/**
 * Resolve the folder path (no-create), find `fileName`, download its bytes and
 * extract the embedded XML. Returns null if the path or file is missing.
 */
export async function getDrawioSvgByPath(
  drive: DriveClient,
  segments: string[],
  fileName: string,
): Promise<{ fileId: string; xml: string | null } | null> {
  const folderId = await resolveFolderPath(drive, segments);
  if (!folderId) return null;
  const fileId = await findFile(drive, fileName, folderId);
  if (!fileId) return null;
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
  const svg = typeof res.data === "string" ? res.data : String(res.data);
  return { fileId, xml: extractXmlFromEditableSvg(svg) };
}
