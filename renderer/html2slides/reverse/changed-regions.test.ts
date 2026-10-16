/**
 * changedRegions is what lets the reverse regression gate see a local regression the slide-wide
 * percentage hides, so its contract is pinned here on synthetic images: identical renders have no
 * regions, a dot that grows past Google's is ONE region whose error rises, a fix that moves toward
 * Google falls, and separate edits stay separate regions.
 *   npx tsx --test renderer/html2slides/reverse/changed-regions.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedRegions } from "./changed-regions.ts";
import type { RgbaImage } from "./reverse-metrics.ts";

const WIDTH = 80;
const HEIGHT = 40;

/** A white image with dark squares, each [x, y, size]. */
function image(squares: ReadonlyArray<readonly [number, number, number]>): RgbaImage {
  const data = new Uint8Array(WIDTH * HEIGHT * 4).fill(255);
  for (const [left, top, size] of squares) {
    for (let y = top; y < top + size; y += 1) {
      for (let x = left; x < left + size; x += 1) data.fill(30, (y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3);
    }
  }
  return { width: WIDTH, height: HEIGHT, data };
}

test("identical renders have no changed regions", () => {
  const dot = image([[10, 10, 6]]);
  assert.deepEqual(changedRegions({ google: dot, baseline: dot, candidate: image([[10, 10, 6]]) }), []);
});

test("a dot that grows past Google's is one region whose error rises", () => {
  const google = image([[10, 10, 6]]);
  const regions = changedRegions({ google, baseline: image([[10, 10, 6]]), candidate: image([[7, 7, 12]]) });
  assert.equal(regions.length, 1);
  const [region] = regions;
  assert.ok(region !== undefined);
  assert.deepEqual([region.x, region.y, region.width, region.height, region.changedPixels], [7, 7, 12, 12, 144 - 36]);
  assert.equal(region.errorBefore, 0);
  assert.ok(region.errorAfter > 300, `error after ${region.errorAfter}`);
});

test("a fix that moves toward Google lowers the region's error", () => {
  const google = image([[10, 10, 6]]);
  const [region] = changedRegions({ google, baseline: image([[7, 7, 12]]), candidate: image([[10, 10, 6]]) });
  assert.ok(region !== undefined && region.errorAfter === 0 && region.errorBefore > 300);
});

test("edits farther apart than the join distance are separate regions", () => {
  const google = image([]);
  const regions = changedRegions({ google, baseline: image([]), candidate: image([[5, 5, 4], [60, 25, 4]]) });
  assert.deepEqual(regions.map((region) => [region.x, region.y]), [[5, 5], [60, 25]]);
});

test("images of different sizes are refused", () => {
  const small: RgbaImage = { width: 10, height: 10, data: new Uint8Array(400) };
  assert.throws(() => changedRegions({ google: small, baseline: image([]), candidate: image([]) }), /google image is 10x10/);
});
