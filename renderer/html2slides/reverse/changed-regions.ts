/**
 * Where a candidate render changed from a baseline render, and whether each changed region moved
 * toward Google's thumbnail or away from it.
 *
 * WHY: a whole-slide mismatch percentage hides a tight, local regression. Measured 2026-10-16 on
 * the reverse run's merge: complex slide 30's eight status dots (U+25CF) began rendering in Inter at
 * about 1.7 times the diameter Google draws, yet the slide's reverse mismatch rose only 0% to
 * 0.033%, under the gate's 0.05-point limit. Inside each dot's 12 x 12 px box, the mean error
 * against Google rose from about 8 to 150-200 (of 765).
 *
 * A pixel CHANGED when its RGB channels differ by more than CHANGE_THRESHOLD in total between the
 * two renders. Changed pixels within JOIN_DISTANCE of each other form one region, so one glyph or
 * one moved border is one region. Each region gets the mean absolute RGB error against Google over
 * its bounding box grown by CONTEXT_MARGIN, before and after.
 */
import type { RgbaImage } from "./reverse-metrics.ts";

export type ChangedRegion = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pixels inside the box that differ between the two renders. */
  changedPixels: number;
  /** Mean absolute RGB error against Google over the box plus CONTEXT_MARGIN (0-765 per pixel),
   *  baseline render. */
  errorBefore: number;
  /** The same for the candidate render. */
  errorAfter: number;
}>;

/** Summed RGB difference a pixel needs to count as changed: above anti-aliasing jitter between
 *  identical pages (0, they are byte-identical) and below any visible edit. */
const CHANGE_THRESHOLD = 24;
/** Changed pixels this close (Chebyshev distance, px) belong to one region. */
const JOIN_DISTANCE = 3;
/** Pixels of context around a region's box when scoring it. A sub-pixel shift moves anti-aliasing
 *  into the column next to a line, and scoring only that sliver reads as a regression. Measured
 *  2026-10-16, basic slide 14: a table border's new 1 x 50 px sliver rose +124 alone and +40 with
 *  one pixel of context (the line sat 1 px from Google's both before and after), while slide 30's
 *  oversized dots still rose +105 or more. */
const CONTEXT_MARGIN = 1;

export function changedRegions(options: Readonly<{ google: RgbaImage; baseline: RgbaImage; candidate: RgbaImage }>): readonly ChangedRegion[] {
  const { google, baseline, candidate } = options;
  const { width, height } = baseline;
  for (const [name, image] of [["google", google], ["candidate", candidate]] as const) {
    if (image.width !== width || image.height !== height) {
      throw new Error(`changedRegions: the ${name} image is ${image.width}x${image.height}, the baseline ${width}x${height}`);
    }
  }
  const changed = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (rgbDistance(baseline, candidate, pixel) > CHANGE_THRESHOLD) changed[pixel] = 1;
  }
  const visited = new Uint8Array(width * height);
  const regions: ChangedRegion[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < width * height; seed += 1) {
    if (changed[seed] === 0 || visited[seed] === 1) continue;
    let left = width, top = height, right = -1, bottom = -1, changedPixels = 0;
    visited[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const pixel = stack.pop() as number;
      const x = pixel % width;
      const y = (pixel - x) / width;
      changedPixels += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (let neighbourY = Math.max(0, y - JOIN_DISTANCE); neighbourY <= Math.min(height - 1, y + JOIN_DISTANCE); neighbourY += 1) {
        for (let neighbourX = Math.max(0, x - JOIN_DISTANCE); neighbourX <= Math.min(width - 1, x + JOIN_DISTANCE); neighbourX += 1) {
          const neighbour = neighbourY * width + neighbourX;
          if (changed[neighbour] === 1 && visited[neighbour] === 0) {
            visited[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }
    }
    let errorBefore = 0, errorAfter = 0;
    const scoredLeft = Math.max(0, left - CONTEXT_MARGIN), scoredRight = Math.min(width - 1, right + CONTEXT_MARGIN);
    const scoredTop = Math.max(0, top - CONTEXT_MARGIN), scoredBottom = Math.min(height - 1, bottom + CONTEXT_MARGIN);
    for (let y = scoredTop; y <= scoredBottom; y += 1) {
      for (let x = scoredLeft; x <= scoredRight; x += 1) {
        errorBefore += rgbDistance(baseline, google, y * width + x);
        errorAfter += rgbDistance(candidate, google, y * width + x);
      }
    }
    const area = (scoredRight - scoredLeft + 1) * (scoredBottom - scoredTop + 1);
    regions.push({
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
      changedPixels,
      errorBefore: Math.round((errorBefore / area) * 10) / 10,
      errorAfter: Math.round((errorAfter / area) * 10) / 10,
    });
  }
  return regions;
}

function rgbDistance(first: RgbaImage, second: RgbaImage, pixel: number): number {
  const offset = pixel * 4;
  return (
    Math.abs((first.data[offset] ?? 0) - (second.data[offset] ?? 0)) +
    Math.abs((first.data[offset + 1] ?? 0) - (second.data[offset + 1] ?? 0)) +
    Math.abs((first.data[offset + 2] ?? 0) - (second.data[offset + 2] ?? 0))
  );
}
