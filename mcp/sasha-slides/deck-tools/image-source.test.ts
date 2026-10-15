/**
 * `addImage`'s fetch: the media type and size come from the bytes, and nothing private or plain
 * http is ever requested.
 *
 *   cd mcp/sasha-slides && npx tsx --test deck-tools/image-source.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { fetchImageSource, imagePixelSize, sniffImageMediaType } from "./image-source.ts";

describe("the media type is read from the bytes", () => {
  for (const row of [
    { name: "PNG", bytes: png({ width: 4, height: 3 }), mediaType: "image/png", size: { width: 4, height: 3 } },
    { name: "JPEG (baseline start of frame)", bytes: jpeg({ width: 640, height: 480 }), mediaType: "image/jpeg", size: { width: 640, height: 480 } },
    { name: "GIF", bytes: gif({ width: 7, height: 9 }), mediaType: "image/gif", size: { width: 7, height: 9 } },
    { name: "WebP (extended)", bytes: webpExtended({ width: 300, height: 200 }), mediaType: "image/webp", size: { width: 300, height: 200 } },
    { name: "SVG with a declaration and sizes", bytes: text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80px"></svg>'), mediaType: "image/svg+xml", size: { width: 120, height: 80 } },
    { name: "SVG with only a viewBox", bytes: text('<svg viewBox="0 0 64 32" xmlns="http://www.w3.org/2000/svg"/>'), mediaType: "image/svg+xml", size: { width: 64, height: 32 } },
    { name: "control: an HTML page", bytes: text("<!doctype html><html><body>not an image</body></html>"), mediaType: null, size: null },
  ] as const) {
    test(`${row.name} -> ${String(row.mediaType)}`, () => {
      const mediaType = sniffImageMediaType(row.bytes);
      assert.equal(mediaType, row.mediaType);
      if (mediaType !== null) assert.deepEqual(imagePixelSize({ bytes: row.bytes, mediaType }), row.size);
    });
  }
});

describe("what is fetched", () => {
  for (const row of [
    { source: "http://images.example/a.png", fetched: false, reason: /https only/u },
    { source: "https://localhost/a.png", fetched: false, reason: /not a public host/u },
    { source: "https://10.1.2.3/a.png", fetched: false, reason: /not a public host/u },
    { source: "https://169.254.169.254/latest", fetched: false, reason: /not a public host/u },
    { source: "https://[::1]/a.png", fetched: false, reason: /not a public host/u },
    { source: "not an address", fetched: false, reason: /not an address/u },
    { source: "https://images.example/a.png", fetched: true, reason: null },
  ] as const) {
    test(`${row.source}: ${row.fetched ? "fetched" : "refused before any request"}`, async () => {
      const requested: string[] = [];
      const outcome = await fetchImageSource({
        source: row.source,
        fetch: (input) => {
          requested.push(String(input));
          return Promise.resolve(new Response(new Uint8Array(png({ width: 2, height: 2 }))));
        },
      });
      assert.equal(requested.length, row.fetched ? 1 : 0);
      if (row.reason === null) {
        assert.equal(outcome.kind, "fetched");
        return;
      }
      assert.equal(outcome.kind, "refused");
      if (outcome.kind === "refused") assert.match(outcome.reason, row.reason);
    });
  }

  test("a declared length over 25 megabytes is refused without reading the body", async () => {
    let bodyRead = false;
    // highWaterMark 0: the stream pulls only when someone reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          bodyRead = true;
        },
      },
      { highWaterMark: 0 },
    );
    const outcome = await fetchImageSource({
      source: "https://images.example/huge.png",
      fetch: () => Promise.resolve(new Response(body, { headers: { "content-length": String(25 * 1024 * 1024 + 1) } })),
    });
    assert.equal(outcome.kind, "refused");
    assert.equal(bodyRead, false);
  });

  test("redirects are not followed (a public address cannot bounce the server to a private one)", async () => {
    const seen: (RequestInit | undefined)[] = [];
    await fetchImageSource({
      source: "https://images.example/a.png",
      fetch: (_input, init) => {
        seen.push(init);
        return Promise.resolve(new Response(new Uint8Array(png({ width: 1, height: 1 }))));
      },
    });
    assert.equal(seen[0]?.redirect, "error");
  });
});

function png(size: Readonly<{ width: number; height: number }>): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, size.width);
  new DataView(bytes.buffer).setUint32(20, size.height);
  return bytes;
}

/** Start of image, an application segment to skip, then a baseline start of frame. */
function jpeg(size: Readonly<{ width: number; height: number }>): Uint8Array {
  const bytes = new Uint8Array(2 + 18 + 19);
  bytes.set([0xff, 0xd8]);
  bytes.set([0xff, 0xe0, 0x00, 0x10], 2);
  const frame = 2 + 18;
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], frame);
  const view = new DataView(bytes.buffer);
  view.setUint16(frame + 5, size.height);
  view.setUint16(frame + 7, size.width);
  return bytes;
}

function gif(size: Readonly<{ width: number; height: number }>): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(text("GIF89a"));
  const view = new DataView(bytes.buffer);
  view.setUint16(6, size.width, true);
  view.setUint16(8, size.height, true);
  return bytes;
}

function webpExtended(size: Readonly<{ width: number; height: number }>): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(text("RIFF"));
  bytes.set(text("WEBP"), 8);
  bytes.set(text("VP8X"), 12);
  const width = size.width - 1;
  const height = size.height - 1;
  bytes.set([width & 0xff, (width >> 8) & 0xff, (width >> 16) & 0xff], 24);
  bytes.set([height & 0xff, (height >> 8) & 0xff, (height >> 16) & 0xff], 27);
  return bytes;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
