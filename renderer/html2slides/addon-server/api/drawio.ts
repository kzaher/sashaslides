/**
 * Workstream D — drawio integration (server half).
 *
 *   POST /api/drawio/detect — read a PNG's tEXt/zTXt/iTXt chunks for an embedded
 *                             drawio diagram (`mxfile` / `<mxGraphModel`); return
 *                             { isDrawio, xml? }.
 *   POST /api/drawio/render — INTENTIONAL 501. Rendering is CLIENT-SIDE in the
 *                             self-hosted drawio editor (it exports a PNG with the
 *                             XML re-embedded). We do NOT run headless chrome here.
 *
 * The editor itself is served at /drawio/* (see server.ts → deps/drawio webapp).
 *
 * drawio stores the diagram XML inside the PNG as a textual chunk under the
 * keyword `mxfile` (older builds may inline `<mxGraphModel`/`<mxfile` into a
 * generic tEXt). We do a manual PNG chunk walk so we depend on nothing beyond
 * node's built-in zlib (pngjs is present in the repo root node_modules but its
 * decoder ignores ancillary text chunks, so a walk is both lighter and correct).
 *
 * PNG layout: 8-byte signature, then a sequence of chunks, each:
 *   length(4, big-endian)  type(4, ascii)  data(length)  crc(4)
 * Text chunks:
 *   tEXt: keyword \0 text                         (latin-1, uncompressed)
 *   zTXt: keyword \0 compressionMethod(1) zlib(text)
 *   iTXt: keyword \0 compFlag(1) compMethod(1) langTag \0 translatedKeyword \0
 *         (text | zlib(text))                     (utf-8)
 */
import { inflateSync } from "zlib";
import type { IncomingMessage, ServerResponse } from "http";
import { registerApi } from "../registry.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A keyword/value pair recovered from a PNG text chunk. */
interface PngText { keyword: string; value: string }

/** Walk every tEXt/zTXt/iTXt chunk in a PNG buffer, decompressing as needed. */
export function readPngTextChunks(buf: Buffer): PngText[] {
  const out: PngText[] = [];
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return out;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break; // truncated chunk → stop
    const data = buf.subarray(dataStart, dataEnd);
    try {
      if (type === "tEXt") {
        const nul = data.indexOf(0);
        if (nul >= 0) out.push({
          keyword: data.toString("latin1", 0, nul),
          value: data.toString("latin1", nul + 1),
        });
      } else if (type === "zTXt") {
        const nul = data.indexOf(0);
        // data[nul+1] = compression method (only 0 = zlib/deflate is defined)
        if (nul >= 0 && data[nul + 1] === 0) out.push({
          keyword: data.toString("latin1", 0, nul),
          value: inflateSync(data.subarray(nul + 2)).toString("latin1"),
        });
      } else if (type === "iTXt") {
        const kwNul = data.indexOf(0);
        if (kwNul >= 0) {
          const keyword = data.toString("latin1", 0, kwNul);
          const compFlag = data[kwNul + 1];
          // skip langTag\0 then translatedKeyword\0
          const langNul = data.indexOf(0, kwNul + 3);
          const transNul = langNul >= 0 ? data.indexOf(0, langNul + 1) : -1;
          if (transNul >= 0) {
            const textBuf = data.subarray(transNul + 1);
            const value = compFlag === 1
              ? inflateSync(textBuf).toString("utf8")
              : textBuf.toString("utf8");
            out.push({ keyword, value });
          }
        }
      }
    } catch {
      /* a malformed/over-truncated chunk shouldn't abort the whole scan */
    }
    if (type === "IEND") break;
    off = dataEnd + 4; // skip the 4-byte CRC
  }
  return out;
}

/**
 * Inspect PNG bytes for an embedded drawio diagram.
 * Matches the canonical `mxfile` keyword, OR any chunk whose value contains the
 * diagram root markers `<mxfile` / `<mxGraphModel` (older/edge-case exports).
 */
export function detectDrawio(buf: Buffer): { isDrawio: boolean; xml?: string } {
  const chunks = readPngTextChunks(buf);
  // drawio may URL-encode the XML it stores under the `mxfile` keyword.
  const decode = (v: string) => /^%3C|%3c/.test(v.trim()) ? safeDecodeURIComponent(v) : v;
  for (const c of chunks) {
    const v = decode(c.value);
    if (c.keyword === "mxfile" || /<mxfile[\s>]/.test(v) || /<mxGraphModel[\s>]/.test(v)) {
      return { isDrawio: true, xml: v };
    }
  }
  return { isDrawio: false };
}

function safeDecodeURIComponent(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

/** Accept either a raw PNG body or a base64 JSON envelope `{ png: "<base64>" }`. */
function pngFromBody(req: IncomingMessage, raw: Buffer): Buffer {
  const ct = (req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("application/json")) {
    const j = JSON.parse(raw.toString("utf8"));
    const b64: string = j.png || j.data || j.image || "";
    const comma = b64.indexOf(","); // strip a possible data:image/png;base64, prefix
    return Buffer.from(comma >= 0 && b64.startsWith("data:") ? b64.slice(comma + 1) : b64, "base64");
  }
  return raw; // raw image/png (or anything) body
}

registerApi("POST", "/api/drawio/detect", async (req: IncomingMessage, res: ServerResponse, _url, body) => {
  try {
    const png = pngFromBody(req, await body());
    const result = detectDrawio(png);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "detect failed: " + (e as Error).message }));
  }
  return true;
});

registerApi("POST", "/api/drawio/render", (_req, res) => {
  // PLACEHOLDER BY DESIGN — not a missing feature.
  // Rendering a drawio mxfile → PNG happens client-side: the self-hosted drawio
  // editor (served at /drawio) exports a PNG with the diagram XML re-embedded as a
  // tEXt chunk, which the add-on then inserts as the slide image. We deliberately
  // do NOT spin up headless chrome / a server-side renderer here (disk + scope).
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: "render is client-side",
    detail: "drawio PNG export happens in the editor iframe at /drawio (File ▸ Export, " +
      "or the embed export API). The exported PNG carries the XML in an 'mxfile' tEXt " +
      "chunk; POST /api/drawio/detect reads it back. No server-side rendering here.",
  }));
  return true;
});

export {};
