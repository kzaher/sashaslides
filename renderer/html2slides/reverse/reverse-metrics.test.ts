/**
 * The reverse round trip's two measures, each test parametric over the cause it claims, with a
 * CONTROL ROW where the cause is absent: a mismatch must come from the injected difference (a
 * block of the wrong colour, a lost word), never from resampling, blur or formatting alone.
 *
 * Run: npx tsx --test renderer/html2slides/reverse/reverse-metrics.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { blurImage, compareImages, flattenOnWhite, matchText, resampleImage, wordsOf, type RgbaImage } from "./reverse-metrics.ts";

type Block = Readonly<{ left: number; top: number; width: number; height: number; colour: readonly [number, number, number] }>;

describe("compareImages", () => {
  const base = paint({ width: 320, height: 180, background: [255, 255, 255], blocks: [{ left: 40, top: 40, width: 120, height: 60, colour: [30, 60, 200] }] });
  const cases: readonly Readonly<{ name: string; actual: RgbaImage; minimumPercent: number; maximumPercent: number }>[] = [
    { name: "control: the same pixels", actual: base, minimumPercent: 0, maximumPercent: 0 },
    {
      name: "control: the same picture drawn at twice the size",
      actual: paint({ width: 640, height: 360, background: [255, 255, 255], blocks: [{ left: 80, top: 80, width: 240, height: 120, colour: [30, 60, 200] }] }),
      minimumPercent: 0,
      maximumPercent: 0.5,
    },
    {
      name: "control: a one pixel shift is absorbed by the blur",
      actual: paint({ width: 320, height: 180, background: [255, 255, 255], blocks: [{ left: 41, top: 40, width: 120, height: 60, colour: [30, 60, 200] }] }),
      minimumPercent: 0,
      maximumPercent: 0.5,
    },
    {
      // 64 x 32 of 320 x 180 is 3.56 percent; the blur grows the region by its radius each side.
      name: "a missing red block",
      actual: paint({ width: 320, height: 180, background: [255, 255, 255], blocks: [{ left: 40, top: 40, width: 120, height: 60, colour: [30, 60, 200] }, { left: 200, top: 120, width: 64, height: 32, colour: [220, 20, 20] }] }),
      minimumPercent: 3,
      maximumPercent: 5,
    },
    {
      name: "the block in a different colour",
      actual: paint({ width: 320, height: 180, background: [255, 255, 255], blocks: [{ left: 40, top: 40, width: 120, height: 60, colour: [230, 140, 20] }] }),
      minimumPercent: 10,
      maximumPercent: 15,
    },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const comparison = compareImages({ expected: base, actual: testCase.actual });
      assert.ok(comparison.mismatchPercent >= testCase.minimumPercent, `${comparison.mismatchPercent} < ${testCase.minimumPercent}`);
      assert.ok(comparison.mismatchPercent <= testCase.maximumPercent, `${comparison.mismatchPercent} > ${testCase.maximumPercent}`);
      assert.equal(comparison.diffImage.width, base.width);
      assert.equal(comparison.diffImage.height, base.height);
    });
  }

  it("draws marks only where the pixels differ, transparent elsewhere", () => {
    const actual = paint({ width: 320, height: 180, background: [255, 255, 255], blocks: [{ left: 40, top: 40, width: 120, height: 60, colour: [30, 60, 200] }, { left: 200, top: 120, width: 64, height: 32, colour: [220, 20, 20] }] });
    const { diffImage, mismatchedPixels } = compareImages({ expected: base, actual });
    let opaque = 0;
    for (let offset = 3; offset < diffImage.data.length; offset += 4) if (diffImage.data[offset] !== 0) opaque += 1;
    assert.equal(opaque, mismatchedPixels);
    assert.equal(alphaAt({ image: diffImage, x: 10, y: 10 }), 0);
    assert.equal(alphaAt({ image: diffImage, x: 232, y: 136 }), 255);
  });
});

describe("resampleImage", () => {
  it("averages each 2 x 2 block when halving", () => {
    const checker = paint({ width: 4, height: 2, background: [0, 0, 0], blocks: [{ left: 0, top: 0, width: 1, height: 1, colour: [255, 255, 255] }, { left: 1, top: 1, width: 1, height: 1, colour: [255, 255, 255] }] });
    const half = resampleImage({ image: checker, width: 2, height: 1 });
    assert.deepEqual([...half.data], [128, 128, 128, 255, 0, 0, 0, 255]);
  });

  it("control: the same size is the same image", () => {
    const image = paint({ width: 3, height: 3, background: [10, 20, 30], blocks: [] });
    assert.equal(resampleImage({ image, width: 3, height: 3 }), image);
  });
});

describe("flattenOnWhite", () => {
  const cases: readonly Readonly<{ name: string; pixel: readonly [number, number, number, number]; expected: readonly [number, number, number, number] }>[] = [
    { name: "control: an opaque pixel keeps its colour", pixel: [10, 20, 30, 255], expected: [10, 20, 30, 255] },
    { name: "a transparent pixel becomes white", pixel: [10, 20, 30, 0], expected: [255, 255, 255, 255] },
    { name: "half coverage mixes half way to white", pixel: [0, 0, 0, 128], expected: [127, 127, 127, 255] },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const flattened = flattenOnWhite({ width: 1, height: 1, data: Uint8Array.from(testCase.pixel) });
      assert.deepEqual([...flattened.data], [...testCase.expected]);
    });
  }
});

describe("blurImage", () => {
  it("control: a flat image stays flat", () => {
    const flat = paint({ width: 8, height: 8, background: [90, 90, 90], blocks: [] });
    assert.deepEqual([...blurImage({ image: flat, radius: 2 }).data], [...flat.data]);
  });

  it("spreads a single bright pixel over its neighbourhood", () => {
    const dot = paint({ width: 9, height: 9, background: [0, 0, 0], blocks: [{ left: 4, top: 4, width: 1, height: 1, colour: [250, 250, 250] }] });
    const blurred = blurImage({ image: dot, radius: 1 });
    assert.equal(blurred.data[(4 * 9 + 4) * 4], Math.round(Math.round(250 / 3) / 3));
    assert.equal(blurred.data[(3 * 9 + 3) * 4], Math.round(Math.round(250 / 3) / 3));
    assert.equal(blurred.data[(0 * 9 + 0) * 4], 0);
  });
});

describe("matchText", () => {
  const cases: readonly Readonly<{ name: string; expected: string; actual: string; score: number; missingWords: readonly string[]; extraWords: readonly string[] }>[] = [
    { name: "control: the same words", expected: "Quarterly revenue grew", actual: "Quarterly revenue grew", score: 1, missingWords: [], extraWords: [] },
    { name: "control: line breaks, case and bullet glyphs are not words", expected: "Quarterly revenue\ngrew", actual: "• QUARTERLY   Revenue grew", score: 1, missingWords: [], extraWords: [] },
    { name: "control: both empty", expected: "", actual: " \n ", score: 1, missingWords: [], extraWords: [] },
    { name: "a lost word", expected: "one two three four", actual: "one two three", score: 0.8571, missingWords: ["four"], extraWords: [] },
    { name: "a duplicated word", expected: "alpha beta", actual: "alpha beta beta", score: 0.8, missingWords: [], extraWords: ["beta"] },
    { name: "no text came through", expected: "title body", actual: "", score: 0, missingWords: ["title", "body"], extraWords: [] },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const match = matchText({ expected: testCase.expected, actual: testCase.actual });
      assert.equal(match.score, testCase.score);
      assert.deepEqual(match.missingWords, testCase.missingWords);
      assert.deepEqual(match.extraWords, testCase.extraWords);
    });
  }

  it("keeps letters outside ASCII and digits as words", () => {
    assert.deepEqual(wordsOf("Größe 42% — ça va"), ["größe", "42", "ça", "va"]);
  });
});

function paint(options: Readonly<{ width: number; height: number; background: readonly [number, number, number]; blocks: readonly Block[] }>): RgbaImage {
  const data = new Uint8Array(options.width * options.height * 4);
  for (let y = 0; y < options.height; y++) {
    for (let x = 0; x < options.width; x++) {
      const block = options.blocks.findLast((candidate) => x >= candidate.left && x < candidate.left + candidate.width && y >= candidate.top && y < candidate.top + candidate.height);
      const colour = block?.colour ?? options.background;
      const offset = (y * options.width + x) * 4;
      data[offset] = colour[0];
      data[offset + 1] = colour[1];
      data[offset + 2] = colour[2];
      data[offset + 3] = 255;
    }
  }
  return { width: options.width, height: options.height, data };
}

function alphaAt(options: Readonly<{ image: RgbaImage; x: number; y: number }>): number {
  return options.image.data[(options.y * options.image.width + options.x) * 4 + 3] ?? -1;
}
