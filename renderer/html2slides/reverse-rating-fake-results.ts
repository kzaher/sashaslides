/**
 * reverse-rating-fake-results.ts — builds a small, fully synthetic REVERSE results
 * directory for the rating server's tests and for screenshots of the reverse UI.
 *
 * Why it exists: the real reverse results come from a Google Slides round trip that
 * needs network, OAuth and minutes per deck. The rating server only needs the files'
 * layout, so the route tests and the UI screenshot run against this instead. The
 * layout is the one reverse-rating.ts documents: originals/ (Google thumbnails),
 * slides/ (Sasha screenshots), round-trip/originals/ (fixture screenshots),
 * diffs/, html/ and metrics.json.
 *
 * Cases written (ids are "<set>__<case>" or "<set>__<case>__<NN>" for a deck):
 *   basic__slide_01_solid_rect   reverse + round trip, small loss
 *   complex__slide_07            reverse + round trip, larger loss
 *   google__test_deck__01/__02   a Google-only deck: no fixture, so no round trip
 *   complex__slide_09            Google thumbnail only: the Sasha render "failed"
 *
 * CLI (screenshots): npx tsx reverse-rating-fake-results.ts <directory> [google-thumbnail.png ...]
 * With thumbnails given, they replace the synthetic Google images so the screenshot
 * shows real slide content; the Sasha and fixture images are derived from them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

export type FakeReverseCase = Readonly<{
  id: string;
  caseId: string;
  set: string;
  slideNumber: number;
  hasSashaRender: boolean;
  hasRoundTrip: boolean;
  reverseMismatchPercent: number | null;
  roundTripMismatchPercent: number | null;
  textMatch: number | null;
  notes: string;
}>;

export type FakeReverseResults = Readonly<{
  directory: string;
  cases: readonly FakeReverseCase[];
}>;

/** The cases every fake results directory holds, in deck order. */
export const fakeReverseCases: readonly FakeReverseCase[] = [
  {
    id: "basic__slide_01_solid_rect", caseId: "slide_01_solid_rect", set: "basic", slideNumber: 1,
    hasSashaRender: true, hasRoundTrip: true,
    reverseMismatchPercent: 1.4, roundTripMismatchPercent: 2.9, textMatch: 1, notes: "",
  },
  {
    id: "complex__slide_07", caseId: "slide_07", set: "complex", slideNumber: 1,
    hasSashaRender: true, hasRoundTrip: true,
    reverseMismatchPercent: 11.8, roundTripMismatchPercent: 17.2, textMatch: 0.86,
    notes: "table cell padding lost; 2 text runs merged",
  },
  {
    id: "google__test_deck__01", caseId: "test_deck", set: "google", slideNumber: 1,
    hasSashaRender: true, hasRoundTrip: false,
    reverseMismatchPercent: 6.3, roundTripMismatchPercent: null, textMatch: 0.95, notes: "no fixture: Google-only deck",
  },
  {
    id: "google__test_deck__02", caseId: "test_deck", set: "google", slideNumber: 2,
    hasSashaRender: true, hasRoundTrip: false,
    reverseMismatchPercent: 3.1, roundTripMismatchPercent: null, textMatch: 0.99, notes: "",
  },
  {
    id: "complex__slide_09", caseId: "slide_09", set: "complex", slideNumber: 1,
    hasSashaRender: false, hasRoundTrip: false,
    reverseMismatchPercent: null, roundTripMismatchPercent: null, textMatch: null, notes: "Sasha render failed",
  },
];

/**
 * Write the fake layout under `directory`. googleThumbnails, when non-empty, are
 * real PNGs used (cyclically) as the Google side; otherwise synthetic slides are drawn.
 */
export function writeFakeReverseResults(options: Readonly<{
  directory: string;
  googleThumbnails: readonly string[];
}>): FakeReverseResults {
  const { directory } = options;
  for (const subdirectory of ["originals", "slides", "diffs", "html", join("round-trip", "originals"), join("round-trip", "diffs")]) {
    mkdirSync(join(directory, subdirectory), { recursive: true });
  }
  fakeReverseCases.forEach((fakeCase, index) => {
    const thumbnailPath = options.googleThumbnails.length === 0 ? null : options.googleThumbnails[index % options.googleThumbnails.length];
    const google = thumbnailPath === undefined || thumbnailPath === null
      ? syntheticSlide({ width: 1600, height: 900, seed: index })
      : PNG.sync.read(readFileSync(thumbnailPath));
    writePng({ path: join(directory, "originals", `${fakeCase.id}.png`), image: google });
    if (!fakeCase.hasSashaRender) return;
    const sasha = withLoss({ image: resized({ image: google, width: 1280, height: 720 }), severity: fakeCase.reverseMismatchPercent ?? 0 });
    writePng({ path: join(directory, "slides", `${fakeCase.id}.png`), image: sasha });
    writePng({ path: join(directory, "diffs", `${fakeCase.id}.png`), image: resized({ image: google, width: 640, height: 360 }) });
    writeFileSync(join(directory, "html", `${fakeCase.id}.html`), `<!doctype html><html><body style="margin:0;width:1280px;height:720px">${fakeCase.id}</body></html>`);
    if (!fakeCase.hasRoundTrip) return;
    writePng({ path: join(directory, "round-trip", "originals", `${fakeCase.id}.png`), image: resized({ image: google, width: 1280, height: 720 }) });
    writePng({ path: join(directory, "round-trip", "diffs", `${fakeCase.id}.png`), image: resized({ image: sasha, width: 640, height: 360 }) });
  });
  const metrics = fakeReverseCases.map((fakeCase) => ({
    caseId: fakeCase.caseId,
    set: fakeCase.set,
    slideNumber: fakeCase.slideNumber,
    reverseMismatchPercent: fakeCase.reverseMismatchPercent,
    roundTripMismatchPercent: fakeCase.roundTripMismatchPercent,
    textMatch: fakeCase.textMatch,
    notes: fakeCase.notes,
  }));
  writeFileSync(join(directory, "metrics.json"), JSON.stringify(metrics, null, 2));
  return { directory, cases: fakeReverseCases };
}

function writePng(options: Readonly<{ path: string; image: PNG }>): void {
  writeFileSync(options.path, PNG.sync.write(options.image));
}

/** A slide-like picture: a light background, a title bar and two content blocks whose colours follow the seed. */
function syntheticSlide(options: Readonly<{ width: number; height: number; seed: number }>): PNG {
  const { width, height, seed } = options;
  const image = new PNG({ width, height });
  const accent = [[30, 136, 229], [142, 36, 170], [39, 174, 96], [230, 126, 34], [233, 69, 96]][seed % 5] ?? [30, 136, 229];
  fillRectangle({ image, left: 0, top: 0, right: width, bottom: height, colour: [248, 246, 240] });
  fillRectangle({ image, left: width * 0.07, top: height * 0.1, right: width * 0.93, bottom: height * 0.22, colour: accent });
  fillRectangle({ image, left: width * 0.07, top: height * 0.32, right: width * 0.47, bottom: height * 0.86, colour: [220, 226, 236] });
  fillRectangle({ image, left: width * 0.53, top: height * 0.32, right: width * 0.93, bottom: height * 0.86, colour: accent.map((channel) => Math.round(channel * 0.6 + 100)) });
  return image;
}

/** Simulate an import loss: shift the picture right and blank a strip whose width grows with the severity. */
function withLoss(options: Readonly<{ image: PNG; severity: number }>): PNG {
  const { image } = options;
  const shift = Math.round(image.width * 0.004);
  const result = new PNG({ width: image.width, height: image.height });
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const sourceX = Math.max(0, x - shift);
      const source = (y * image.width + sourceX) * 4;
      const target = (y * image.width + x) * 4;
      for (let channel = 0; channel < 4; channel++) result.data[target + channel] = image.data[source + channel] ?? 255;
    }
  }
  const stripWidth = Math.round(image.width * Math.min(0.5, options.severity / 100));
  fillRectangle({ image: result, left: image.width - stripWidth, top: image.height * 0.32, right: image.width, bottom: image.height * 0.6, colour: [255, 255, 255] });
  return result;
}

/** Nearest-neighbour resize; enough for synthetic test pictures. */
function resized(options: Readonly<{ image: PNG; width: number; height: number }>): PNG {
  const { image, width, height } = options;
  const result = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) result.data[target + channel] = image.data[source + channel] ?? 255;
    }
  }
  return result;
}

function fillRectangle(options: Readonly<{
  image: PNG; left: number; top: number; right: number; bottom: number; colour: readonly number[];
}>): void {
  const { image } = options;
  const [red = 0, green = 0, blue = 0] = options.colour;
  for (let y = Math.max(0, Math.round(options.top)); y < Math.min(image.height, Math.round(options.bottom)); y++) {
    for (let x = Math.max(0, Math.round(options.left)); x < Math.min(image.width, Math.round(options.right)); x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }
  }
}

// CLI entry: only when run directly, never when imported by the tests.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (directory === undefined) {
    console.error("usage: npx tsx reverse-rating-fake-results.ts <directory> [google-thumbnail.png ...]");
    process.exit(2);
  }
  const written = writeFakeReverseResults({ directory: resolve(directory), googleThumbnails: process.argv.slice(3).map((path) => resolve(path)) });
  console.log(`wrote ${written.cases.length} fake reverse cases to ${written.directory}`);
}
