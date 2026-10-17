/**
 * The two fidelity measures of the reverse round trip, as pure functions over decoded pixels and
 * strings: a STRUCTURAL pixel mismatch and a text-content match.
 *
 * WHY THE PIXELS ARE BLURRED BEFORE THEY ARE COMPARED. The two sides of every comparison come from
 * different rasterisers: Google's thumbnail renderer against Chrome (reverse step), or Chrome on
 * the fixture against Chrome on the Sasha export (round trip). Raw pixelmatch on those lights up
 * every antialiased glyph edge and every half-pixel offset, so a perfect import would still score
 * several percent and the number would track font hinting rather than fidelity. Both images are
 * resampled to one size and box-blurred (two passes, close to a Gaussian), so what survives is a
 * missing shape, a wrong colour or a shift of a few pixels. check-goldens.ts uses the same
 * comparator for its original-versus-render diff of a slide that has no golden yet.
 *
 * WHY TEXT IS A MULTISET OF WORDS. Google's text comes from the presentation's runs, the Sasha and
 * fixture text from the DOM's `innerText`; the two disagree on line breaks, bullet glyphs, list
 * numbers and CSS `text-transform`. Lower-cased letter-and-digit words compared as a multiset
 * (F1 of the counts) ignore all of that and still drop when a word is lost, duplicated or garbled.
 */
import pixelmatch from "pixelmatch";

/** Decoded straight-alpha RGBA pixels, row by row: what pngjs's `PNG.sync.read` produces. */
export type RgbaImage = Readonly<{ width: number; height: number; data: Uint8Array }>;

export type ImageComparison = Readonly<{
  /** Percentage (0 to 100) of compared pixels that differ after resampling and blurring. */
  mismatchPercent: number;
  mismatchedPixels: number;
  /** At the expected image's size: red where the pixels differ, fully transparent elsewhere. */
  diffImage: RgbaImage;
}>;

export type TextMatch = Readonly<{
  /** F1 of the word multisets, 0 to 1; 1 when both sides have no words. */
  score: number;
  /** Words the expected side has more of than the actual side. */
  missingWords: readonly string[];
  /** Words the actual side has more of than the expected side. */
  extraWords: readonly string[];
}>;

/** Blur radius in pixels at a 1280 wide comparison; scaled with the comparison width. */
export const BLUR_RADIUS_AT_1280 = 2;
/** pixelmatch's per-pixel YIQ threshold: 0.2 tolerates the blur's soft edges, not a wrong colour. */
export const PIXEL_THRESHOLD = 0.2;

/**
 * Compares `actual` against `expected` at the expected image's size (see the header). `threshold`
 * is pixelmatch's per-pixel YIQ threshold, PIXEL_THRESHOLD unless the caller needs a looser one;
 * `blurRadius` fixes the box radius instead of scaling BLUR_RADIUS_AT_1280 with the width (two
 * passes of radius 2 have a standard deviation of exactly 2 pixels).
 */
export function compareImages(
  options: Readonly<{ expected: RgbaImage; actual: RgbaImage; threshold?: number; blurRadius?: number }>,
): ImageComparison {
  const { width, height } = options.expected;
  const blurRadius = options.blurRadius ?? Math.max(1, Math.round((BLUR_RADIUS_AT_1280 * width) / 1280));
  const prepare = (image: RgbaImage): RgbaImage => blurImage({ image: blurImage({ image: flattenOnWhite(resampleImage({ image, width, height })), radius: blurRadius }), radius: blurRadius });
  const expected = prepare(options.expected);
  const actual = prepare(options.actual);
  const diffData = new Uint8Array(width * height * 4);
  const mismatchedPixels = pixelmatch(expected.data, actual.data, diffData, width, height, {
    threshold: options.threshold ?? PIXEL_THRESHOLD,
    includeAA: true,
    alpha: 0,
    diffColor: [255, 0, 0],
  });
  keepOnlyDiffMarks(diffData);
  return {
    mismatchPercent: roundTo((100 * mismatchedPixels) / (width * height), 3),
    mismatchedPixels,
    diffImage: { width, height, data: diffData },
  };
}

/**
 * pixelmatch draws every pixel opaque (`alpha: 0` only greys the background to white); the rating
 * UI overlays the diff on the original, so every pixel except the red diff and yellow antialiasing
 * marks becomes fully transparent, in place.
 */
export function keepOnlyDiffMarks(diffData: Uint8Array): void {
  for (let offset = 0; offset < diffData.length; offset += 4) {
    const isRed = diffData[offset] === 255 && diffData[offset + 1] === 0 && diffData[offset + 2] === 0;
    const isYellow = diffData[offset] === 255 && diffData[offset + 1] === 255 && diffData[offset + 2] === 0;
    if (!isRed && !isYellow) diffData[offset + 3] = 0;
  }
}

/** Area-average resampling (a box filter): exact for downscaling, nearest-like for upscaling. */
export function resampleImage(options: Readonly<{ image: RgbaImage; width: number; height: number }>): RgbaImage {
  const { image, width, height } = options;
  if (image.width === width && image.height === height) return image;
  const output = new Uint8Array(width * height * 4);
  const horizontalRatio = image.width / width;
  const verticalRatio = image.height / height;
  for (let targetRow = 0; targetRow < height; targetRow++) {
    const sourceTop = targetRow * verticalRatio;
    const sourceBottom = sourceTop + verticalRatio;
    const firstRow = Math.floor(sourceTop);
    const lastRow = Math.min(image.height - 1, Math.ceil(sourceBottom) - 1);
    for (let targetColumn = 0; targetColumn < width; targetColumn++) {
      const sourceLeft = targetColumn * horizontalRatio;
      const sourceRight = sourceLeft + horizontalRatio;
      const firstColumn = Math.floor(sourceLeft);
      const lastColumn = Math.min(image.width - 1, Math.ceil(sourceRight) - 1);
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let totalWeight = 0;
      for (let sourceRow = firstRow; sourceRow <= lastRow; sourceRow++) {
        const rowWeight = Math.min(sourceBottom, sourceRow + 1) - Math.max(sourceTop, sourceRow);
        if (rowWeight <= 0) continue;
        for (let sourceColumn = firstColumn; sourceColumn <= lastColumn; sourceColumn++) {
          const columnWeight = Math.min(sourceRight, sourceColumn + 1) - Math.max(sourceLeft, sourceColumn);
          if (columnWeight <= 0) continue;
          const weight = rowWeight * columnWeight;
          const sourceOffset = (sourceRow * image.width + sourceColumn) * 4;
          red += (image.data[sourceOffset] ?? 0) * weight;
          green += (image.data[sourceOffset + 1] ?? 0) * weight;
          blue += (image.data[sourceOffset + 2] ?? 0) * weight;
          alpha += (image.data[sourceOffset + 3] ?? 0) * weight;
          totalWeight += weight;
        }
      }
      const targetOffset = (targetRow * width + targetColumn) * 4;
      const divisor = totalWeight > 0 ? totalWeight : 1;
      output[targetOffset] = Math.round(red / divisor);
      output[targetOffset + 1] = Math.round(green / divisor);
      output[targetOffset + 2] = Math.round(blue / divisor);
      output[targetOffset + 3] = Math.round(alpha / divisor);
    }
  }
  return { width, height, data: output };
}

/** Composites onto white and makes every pixel opaque, so transparency compares as what is seen. */
export function flattenOnWhite(image: RgbaImage): RgbaImage {
  const output = new Uint8Array(image.data.length);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const coverage = (image.data[offset + 3] ?? 255) / 255;
    for (let channel = 0; channel < 3; channel++) {
      output[offset + channel] = Math.round((image.data[offset + channel] ?? 0) * coverage + 255 * (1 - coverage));
    }
    output[offset + 3] = 255;
  }
  return { width: image.width, height: image.height, data: output };
}

/** A separable box blur of the given radius; edges clamp. */
export function blurImage(options: Readonly<{ image: RgbaImage; radius: number }>): RgbaImage {
  const horizontal = boxBlurPass({ image: options.image, radius: options.radius, direction: "horizontal" });
  return boxBlurPass({ image: horizontal, radius: options.radius, direction: "vertical" });
}

/** The word-multiset match of `actual` against `expected` (see the header). */
export function matchText(options: Readonly<{ expected: string; actual: string }>): TextMatch {
  const expectedCounts = wordCounts(options.expected);
  const actualCounts = wordCounts(options.actual);
  const expectedTotal = sumOf(expectedCounts);
  const actualTotal = sumOf(actualCounts);
  if (expectedTotal === 0 && actualTotal === 0) return { score: 1, missingWords: [], extraWords: [] };
  let common = 0;
  const missingWords: string[] = [];
  const extraWords: string[] = [];
  for (const [word, expectedCount] of expectedCounts) {
    const actualCount = actualCounts.get(word) ?? 0;
    common += Math.min(expectedCount, actualCount);
    for (let index = actualCount; index < expectedCount; index++) missingWords.push(word);
  }
  for (const [word, actualCount] of actualCounts) {
    const expectedCount = expectedCounts.get(word) ?? 0;
    for (let index = expectedCount; index < actualCount; index++) extraWords.push(word);
  }
  return { score: roundTo((2 * common) / (expectedTotal + actualTotal), 4), missingWords, extraWords };
}

/** Lower-cased runs of letters and digits, in order (see the header). */
export function wordsOf(text: string): readonly string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function boxBlurPass(options: Readonly<{ image: RgbaImage; radius: number; direction: "horizontal" | "vertical" }>): RgbaImage {
  const { image, radius } = options;
  const output = new Uint8Array(image.data.length);
  const horizontal = isHorizontal(options.direction);
  const lineCount = horizontal ? image.height : image.width;
  const lineLength = horizontal ? image.width : image.height;
  const span = 2 * radius + 1;
  const offsetOf = (line: number, position: number): number => {
    const clamped = Math.min(lineLength - 1, Math.max(0, position));
    return (horizontal ? line * image.width + clamped : clamped * image.width + line) * 4;
  };
  for (let line = 0; line < lineCount; line++) {
    for (let channel = 0; channel < 4; channel++) {
      let running = 0;
      for (let position = -radius; position <= radius; position++) running += image.data[offsetOf(line, position) + channel] ?? 0;
      for (let position = 0; position < lineLength; position++) {
        output[offsetOf(line, position) + channel] = Math.round(running / span);
        running += (image.data[offsetOf(line, position + radius + 1) + channel] ?? 0) - (image.data[offsetOf(line, position - radius) + channel] ?? 0);
      }
    }
  }
  return { width: image.width, height: image.height, data: output };
}

function isHorizontal(direction: "horizontal" | "vertical"): boolean {
  switch (direction) {
    case "horizontal":
      return true;
    case "vertical":
      return false;
    default:
      return assertNever(direction);
  }
}

function wordCounts(text: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const word of wordsOf(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

function sumOf(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
