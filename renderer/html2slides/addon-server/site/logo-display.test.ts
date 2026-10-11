// THE LOGO AS A DISPLAY: 34 sunflower cells are the pixels, and each pattern lights them along
// a structure the seeds already have (their Fibonacci spirals, rings and angle).

import assert from "node:assert/strict";
import test from "node:test";
import { PATTERNS, SEED_COUNT, TONES, seedCells } from "./logo-display.ts";

const cells = seedCells({ count: SEED_COUNT, radius: 72 });

test("there is one closed cell per seed, all inside the disc", () => {
  assert.equal(cells.length, 34);
  for (const cell of cells) {
    assert.ok(cell.polygon.length >= 3, `cell ${cell.index} has an outline`);
    for (const [x, y] of cell.polygon) assert.ok(Math.hypot(x, y) <= 72.001, `cell ${cell.index} stays in the disc`);
  }
});

test("the first pattern is the static logo: 8 spirals, alternating light and dark", () => {
  const first = PATTERNS[0];
  assert.equal(first.name, "spirals of 8");
  for (const cell of cells) assert.equal(first.tone(cell), (cell.index % 8) % 2 === 1 ? 0 : 2, `cell ${cell.index}`);
});

test("every pattern lights every cell with a known tone, and no two patterns look the same", () => {
  const seen = new Set<string>();
  for (const pattern of PATTERNS) {
    const frame = cells.map((cell) => pattern.tone(cell));
    for (const tone of frame) assert.ok(tone >= 0 && tone < TONES.length, `${pattern.name}: tone ${tone}`);
    assert.ok(new Set(frame).size >= 2, `${pattern.name} uses at least two tones`);
    const key = frame.join("");
    assert.ok(!seen.has(key), `${pattern.name} differs from the others`);
    seen.add(key);
  }
  assert.ok(PATTERNS.length >= 5);
});
