import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyStream } from "./key-stream.ts";
import { FALLBACK_IMAGE_SIZE, intrinsicImageSize, placeholderImageDataUri } from "./placeholder-image.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e/fixtures");
const stream = () => keyStream({ seed: "placeholder-test", label: "x" });

test("it reads the intrinsic size of the real fixture's embedded PNG", () => {
  const html = readFileSync(join(FIXTURES, "03-image.html"), "utf-8");
  const src = /<img[^>]*\ssrc="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.ok(src.startsWith("data:image/png;base64,"), "fixture 03 should embed a base64 PNG");
  assert.deepEqual(intrinsicImageSize(src), { widthPx: 240, heightPx: 150 });
});

test("it reads PNG, GIF, BMP and JPEG headers, and says null when it cannot", () => {
  const base64 = (bytes: readonly number[]): string => Buffer.from(Uint8Array.from(bytes)).toString("base64");
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 0, 0, 0, 1, 0];
  assert.deepEqual(intrinsicImageSize(`data:image/png;base64,${base64(png)}`), { widthPx: 512, heightPx: 256 });

  const gif = [...Buffer.from("GIF89a")].concat([0x40, 0x01, 0xf0, 0x00]);
  assert.deepEqual(intrinsicImageSize(`data:image/gif;base64,${base64(gif)}`), { widthPx: 320, heightPx: 240 });

  const bmp = new Array<number>(26).fill(0);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  bmp[18] = 100;
  bmp[22] = 50;
  assert.deepEqual(intrinsicImageSize(`data:image/bmp;base64,${base64(bmp)}`), { widthPx: 100, heightPx: 50 });

  // SOI, then an APP0 segment that must be skipped, then SOF0 carrying 90 high by 160 wide.
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x5a, 0x00, 0xa0, 0x03];
  assert.deepEqual(intrinsicImageSize(`data:image/jpeg;base64,${base64(jpeg)}`), { widthPx: 160, heightPx: 90 });

  assert.equal(intrinsicImageSize("https://example.com/a.png"), null);
  assert.equal(intrinsicImageSize("data:image/png;base64,not-really"), null);
});

test("an SVG source is sized from its attributes, or from its viewBox when it has none", () => {
  const withAttributes = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='x' width='300' height='120'></svg>");
  assert.deepEqual(intrinsicImageSize(withAttributes), { widthPx: 300, heightPx: 120 });
  const viewBoxOnly = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='x' viewBox='0 0 44 22'></svg>");
  assert.deepEqual(intrinsicImageSize(viewBoxOnly), { widthPx: 44, heightPx: 22 });
});

test("the placeholder declares exactly the size it was asked for and carries no input bytes", () => {
  const uri = placeholderImageDataUri({ size: { widthPx: 1234, heightPx: 567 }, stream: stream() });
  assert.ok(uri.startsWith("data:image/svg+xml,"));
  assert.deepEqual(intrinsicImageSize(uri), { widthPx: 1234, heightPx: 567 });
  // Small enough to sit inside a previewable document, unlike a re-encoded raster.
  assert.ok(uri.length < 8000, `placeholder was ${uri.length} bytes`);
});

test("a degenerate size still produces a valid image rather than throwing", () => {
  for (const size of [{ widthPx: 0, heightPx: 0 }, { widthPx: 1, heightPx: 1 }, FALLBACK_IMAGE_SIZE]) {
    const uri = placeholderImageDataUri({ size, stream: stream() });
    assert.ok(intrinsicImageSize(uri) !== null, JSON.stringify(size));
  }
});
