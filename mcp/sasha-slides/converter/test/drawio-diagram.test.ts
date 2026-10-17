/**
 * drawio-diagram.ts: the stamp, the Drive path, the link parser and the source shapes.
 * Run: npx tsx --test mcp/sasha-slides/converter/test/drawio-*.test.ts
 */
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import {
  diagramFileName,
  diagramFolderPath,
  diagramIdForSource,
  diagramIdOfFileName,
  drawioAltText,
  drawioCandidateHtml,
  drawioSourceScript,
  driveFileAddress,
  driveFileIdOfAddress,
  editableSvg,
  mxfileFromEditableSvg,
  mxfileFromPngBytes,
  parseDrawioAltText,
  parseDrawioSource,
} from "../drawio-diagram.ts";

const XML = '<mxfile><diagram id="a" name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
const PRESENTATION = "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY";

test("a diagram id is stable for the same source and differs for another", () => {
  assert.equal(diagramIdForSource(XML), diagramIdForSource(XML));
  assert.notEqual(diagramIdForSource(XML), diagramIdForSource(`${XML} `));
  assert.match(diagramIdForSource(XML), /^dg[0-9a-f]{8}$/);
});

test("the alternative-text stamp round-trips and tolerates the old form and extra text", () => {
  const stamp = { diagramId: "dg0123abcd", version: "89abcdef" };
  assert.deepEqual(parseDrawioAltText(drawioAltText(stamp)), stamp);
  assert.deepEqual(parseDrawioAltText("drawio:slide3_1a2b3c4d"), { diagramId: "slide3_1a2b3c4d", version: null });
  assert.deepEqual(parseDrawioAltText("Architecture overview drawio:dgx;v=00000000"), { diagramId: "dgx", version: "00000000" });
  assert.equal(parseDrawioAltText("a photo of a cat"), null);
  assert.equal(parseDrawioAltText(null), null);
  assert.throws(() => drawioAltText({ diagramId: "../x", version: null }));
});

test("the Drive path is sasha_slides/slide/<presentationId>/drawio/<id>.drawio", () => {
  assert.deepEqual(diagramFolderPath(PRESENTATION), ["sasha_slides", "slide", PRESENTATION, "drawio"]);
  assert.equal(diagramFileName("dg01"), "dg01.drawio");
  assert.equal(diagramIdOfFileName("dg01.drawio"), "dg01");
  assert.equal(diagramIdOfFileName("slide1_ab.drawio.svg"), "slide1_ab");
  assert.equal(diagramIdOfFileName("notes.txt"), null);
  assert.throws(() => diagramFolderPath("../../etc"));
});

test("a link's Drive file id is read from every form Drive hands out, and nothing else", () => {
  const fileId = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
  assert.equal(driveFileIdOfAddress(driveFileAddress(fileId)), fileId);
  assert.equal(driveFileIdOfAddress(`https://drive.google.com/open?id=${fileId}`), fileId);
  assert.equal(driveFileIdOfAddress(`https://drive.google.com/uc?id=${fileId}&export=download`), fileId);
  assert.equal(driveFileIdOfAddress(`https://evil.example/file/d/${fileId}/view`), null);
  assert.equal(driveFileIdOfAddress(`http://drive.google.com/file/d/${fileId}/view`), null);
  assert.equal(driveFileIdOfAddress("not a url"), null);
});

test("every source shape becomes <mxfile> XML", () => {
  assert.deepEqual(parseDrawioSource(`<?xml version="1.0"?>\n${XML}\n`), { kind: "ok", xml: XML });
  const model = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>';
  const wrapped = parseDrawioSource(model);
  assert.equal(wrapped.kind, "ok");
  assert.ok(wrapped.kind === "ok" && wrapped.xml.startsWith("<mxfile>") && wrapped.xml.includes(model));
  const svg = editableSvg({ xml: XML, baseSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>' });
  assert.equal(mxfileFromEditableSvg(svg), XML);
  assert.deepEqual(parseDrawioSource(svg), { kind: "ok", xml: XML });
  assert.equal(parseDrawioSource("<html></html>").kind, "invalid");
  assert.equal(parseDrawioSource("<mxfile><diagram>").kind, "invalid");
  assert.equal(parseDrawioSource("x".repeat(3 * 1024 * 1024)).kind, "invalid");
});

test("the mxfile chunk of a draw.io PNG is read; a PNG without one gives null", () => {
  assert.equal(mxfileFromPngBytes(pngWith([])), null);
  assert.equal(mxfileFromPngBytes(pngWith([chunk("tEXt", latin1Bytes(`mxfile\0${encodeURIComponent(XML)}`))])), XML);
  assert.equal(mxfileFromPngBytes(new Uint8Array([1, 2, 3])), null);
});

test("the candidate slide carries the source script and one pending placeholder", () => {
  const html = drawioCandidateHtml({ xml: XML, title: "Pipeline <v2>" });
  assert.match(html, /<script type="application\/vnd\.drawio\+xml" id="drawio-source">/);
  assert.match(html, /data-drawio-render="pending"/);
  assert.match(html, /Pipeline &lt;v2&gt;/);
  assert.equal(drawioSourceScript("<a></script>").includes("</script></script>"), false);
});

function pngWith(chunks: readonly Uint8Array[]): Uint8Array {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, 1);
  new DataView(header.buffer).setUint32(4, 1);
  header[8] = 8;
  header[9] = 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), ...chunks, chunk("IDAT", deflateSync(new Uint8Array(5))), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1Bytes(type), 4);
  out.set(data, 8);
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}
