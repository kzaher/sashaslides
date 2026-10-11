/**
 * ink.ts — sub-pixel ink edges in a rendered Slides thumbnail.
 *
 * The inset calibration needs to know where a glyph's ink actually starts, to
 * better than a thumbnail pixel (a LARGE thumbnail is 1600 px for a 10 in page,
 * so one pixel is 5715 EMU — a sixteenth of the inset being measured). The
 * calibration text is `HHHH`: an `H` has a flat-topped, flat-bottomed, straight
 * vertical stem on each side, so all four ink edges are straight lines and their
 * anti-aliased coverage maps linearly onto a sub-pixel position.
 *
 * Reading, per axis: find the first fully-inked line, then treat the darkness of
 * the line just outside it as the fraction of that pixel the edge covers.
 */
import { PNG } from "pngjs";

export type Image = Readonly<{ width: number; height: number; data: Buffer }>;

export type InkEdges = Readonly<{
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Peak darkness in the band, 0 (white) to 1 (black); a sanity check. */
  peak: number;
}>;

export type Band = Readonly<{ xFrom: number; xTo: number; yFrom: number; yTo: number }>;

export function decodePng(bytes: Buffer): Image {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

/** 0 for white, 1 for black. Alpha-composited onto white, since the page is white. */
function darknessAt(image: Image, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  const red = image.data[offset] ?? 255;
  const green = image.data[offset + 1] ?? 255;
  const blue = image.data[offset + 2] ?? 255;
  const alpha = (image.data[offset + 3] ?? 255) / 255;
  const luma = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return alpha * (1 - luma);
}

/**
 * Sub-pixel edges of the ink inside `band`, or null when the band is blank.
 *
 * `profile` reduces the band to one darkness value per line (max, not mean, so a
 * one-stem-wide column still reads as fully inked), then `edgeLow`/`edgeHigh`
 * locate the transition and refine it with the neighbouring partial pixel.
 */
export function inkEdges(options: Readonly<{ image: Image; band: Band }>): InkEdges | null {
  const { image, band } = options;
  const xFrom = Math.max(0, Math.floor(band.xFrom));
  const xTo = Math.min(image.width - 1, Math.ceil(band.xTo));
  const yFrom = Math.max(0, Math.floor(band.yFrom));
  const yTo = Math.min(image.height - 1, Math.ceil(band.yTo));
  if (xTo <= xFrom || yTo <= yFrom) return null;

  const columns = new Array<number>(xTo - xFrom + 1).fill(0);
  const rows = new Array<number>(yTo - yFrom + 1).fill(0);
  let peak = 0;
  for (let y = yFrom; y <= yTo; y++) {
    for (let x = xFrom; x <= xTo; x++) {
      const darkness = darknessAt(image, x, y);
      if (darkness > (columns[x - xFrom] ?? 0)) columns[x - xFrom] = darkness;
      if (darkness > (rows[y - yFrom] ?? 0)) rows[y - yFrom] = darkness;
      if (darkness > peak) peak = darkness;
    }
  }
  if (peak < 0.2) return null;

  const horizontal = refine({ profile: columns, peak, origin: xFrom });
  const vertical = refine({ profile: rows, peak, origin: yFrom });
  if (horizontal === null || vertical === null) return null;
  return { left: horizontal.low, right: horizontal.high, top: vertical.low, bottom: vertical.high, peak };
}

type Span = Readonly<{ low: number; high: number }>;

function refine(options: Readonly<{ profile: readonly number[]; peak: number; origin: number }>): Span | null {
  const { profile, peak, origin } = options;
  const solid = 0.5 * peak;
  let first = -1;
  let last = -1;
  for (let index = 0; index < profile.length; index++) {
    const value = profile[index] ?? 0;
    if (value < solid) continue;
    if (first === -1) first = index;
    last = index;
  }
  if (first === -1 || last === -1) return null;
  // Coverage of the partial pixel immediately outside the solid run. `first` is
  // the first fully-inked pixel, so its left edge is at `first`; the pixel before
  // it is inked over the fraction of its width the glyph edge reaches back into.
  const beforeCoverage = first === 0 ? 0 : Math.min(1, (profile[first - 1] ?? 0) / peak);
  const afterCoverage = last === profile.length - 1 ? 0 : Math.min(1, (profile[last + 1] ?? 0) / peak);
  return {
    low: origin + first - beforeCoverage,
    high: origin + last + 1 + afterCoverage,
  };
}

export type LinearFit = Readonly<{
  intercept: number;
  slope: number;
  /** Standard error of the intercept — the figure that says how trustworthy it is. */
  interceptStdErr: number;
  rSquared: number;
  residuals: readonly number[];
  points: number;
}>;

/** Ordinary least squares of `y = intercept + slope·x`. */
export function linearFit(samples: readonly Readonly<{ x: number; y: number }>[]): LinearFit {
  const count = samples.length;
  if (count < 2) throw new Error("linearFit needs at least two samples");
  const meanX = samples.reduce((sum, point) => sum + point.x, 0) / count;
  const meanY = samples.reduce((sum, point) => sum + point.y, 0) / count;
  const varianceX = samples.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (varianceX === 0) throw new Error("linearFit needs at least two distinct x values");
  const covariance = samples.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;
  const residuals = samples.map((point) => point.y - (intercept + slope * point.x));
  const residualSumSquares = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const totalSumSquares = samples.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const residualVariance = count > 2 ? residualSumSquares / (count - 2) : 0;
  return {
    intercept,
    slope,
    interceptStdErr: Math.sqrt(residualVariance * (1 / count + meanX ** 2 / varianceX)),
    rSquared: totalSumSquares === 0 ? 1 : 1 - residualSumSquares / totalSumSquares,
    residuals,
    points: count,
  };
}
