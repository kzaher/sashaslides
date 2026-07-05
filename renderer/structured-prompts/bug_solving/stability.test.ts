/**
 * stability.test.ts — the 3× stability classifier (stability.ts). ONLY the
 * recording seam is mocked; the classification, key hashing, and the on-disk
 * round-trip are real.
 *
 * Asserted:
 *   (1) 3 identical PIXEL records                 → pixelPerfect
 *   (2) identical XML but 1 differing PIXEL       → xmlStable
 *   (3) all-different                             → unstable + warning names it
 *   (4) attempts param respected (recorder called exactly `attempts` times)
 *   (5) missing PIXEL representation cannot be pixelPerfect (→ xmlStable)
 *   (6) real PNG-file hashing via pngPath         → pixelPerfect when bytes match
 *   (7) stability.json write/load round-trips; loadStability(missing) → null
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStability,
  classifiedSlides,
  loadStability,
  writeStabilityJson,
  type RenderRecord,
  type StabilityRecorder,
} from "./stability.js";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ""}`); }
}

/** A recorder driven by a per-slide, per-attempt table of records. Counts calls. */
function tableRecorder(table: Record<string, RenderRecord[]>): { record: StabilityRecorder; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const record: StabilityRecorder = (sid, i) => {
    calls[sid] = (calls[sid] ?? 0) + 1;
    const row = table[sid];
    return row[Math.min(i, row.length - 1)];
  };
  return { record, calls };
}

function main(): void {
  console.log("\nstability tests (classifier real; recording mocked)\n");

  // (1) 3 identical pixel records → pixelPerfect.
  {
    const { record } = tableRecorder({
      slide_01: [{ pixelHash: "P", xmlHash: "X" }, { pixelHash: "P", xmlHash: "X" }, { pixelHash: "P", xmlHash: "X" }],
    });
    const c = classifyStability(["slide_01"], { record, attempts: 3 });
    ok("(1) 3 identical pixels → pixelPerfect",
      JSON.stringify(c.pixelPerfect) === '["slide_01"]' && c.xmlStable.length === 0 && c.unstable.length === 0,
      JSON.stringify(c));
  }

  // (2) identical XML, one differing pixel → xmlStable.
  {
    const { record } = tableRecorder({
      slide_02: [{ pixelHash: "P", xmlHash: "X" }, { pixelHash: "P", xmlHash: "X" }, { pixelHash: "Q", xmlHash: "X" }],
    });
    const c = classifyStability(["slide_02"], { record, attempts: 3 });
    ok("(2) same XML, 1 differing pixel → xmlStable",
      JSON.stringify(c.xmlStable) === '["slide_02"]' && c.pixelPerfect.length === 0 && c.unstable.length === 0,
      JSON.stringify(c));
  }

  // (3) all-different → unstable + warning names it.
  {
    const { record } = tableRecorder({
      slide_03: [{ pixelHash: "P0", xmlHash: "X0" }, { pixelHash: "P1", xmlHash: "X1" }, { pixelHash: "P2", xmlHash: "X2" }],
    });
    const c = classifyStability(["slide_03"], { record, attempts: 3 });
    ok("(3) neither pixel nor xml stable → unstable",
      JSON.stringify(c.unstable) === '["slide_03"]' && c.pixelPerfect.length === 0 && c.xmlStable.length === 0,
      JSON.stringify(c));
    ok("(3b) warning names the unstable slide", /slide_03/.test(c.warning) && /NOT stable/.test(c.warning), c.warning);
  }

  // (3c) mixed deck — all three buckets + warning lists only the unstable one.
  {
    const { record } = tableRecorder({
      slide_01: [{ pixelHash: "P", xmlHash: "X" }, { pixelHash: "P", xmlHash: "X" }, { pixelHash: "P", xmlHash: "X" }],
      slide_02: [{ pixelHash: "A", xmlHash: "X" }, { pixelHash: "B", xmlHash: "X" }, { pixelHash: "C", xmlHash: "X" }],
      slide_03: [{ pixelHash: "A", xmlHash: "Y0" }, { pixelHash: "B", xmlHash: "Y1" }, { pixelHash: "C", xmlHash: "Y2" }],
    });
    const c = classifyStability(["slide_01", "slide_02", "slide_03"], { record, attempts: 3 });
    ok("(3c) mixed deck buckets correctly",
      JSON.stringify(c.pixelPerfect) === '["slide_01"]' &&
      JSON.stringify(c.xmlStable) === '["slide_02"]' &&
      JSON.stringify(c.unstable) === '["slide_03"]' &&
      JSON.stringify(classifiedSlides(c)) === '["slide_01","slide_02","slide_03"]',
      JSON.stringify(c));
    ok("(3d) warning names ONLY slide_03", /slide_03/.test(c.warning) && !/slide_01/.test(c.warning) && !/slide_02/.test(c.warning), c.warning);
  }

  // (4) attempts param respected — recorder called exactly `attempts` times.
  {
    const { record, calls } = tableRecorder({
      slide_04: [{ pixelHash: "P", xmlHash: "X" }],
    });
    classifyStability(["slide_04"], { record, attempts: 5 });
    ok("(4) attempts=5 → recorder called 5×", calls.slide_04 === 5, `calls=${calls.slide_04}`);
    const { record: r2, calls: c2 } = tableRecorder({ slide_05: [{ pixelHash: "P", xmlHash: "X" }] });
    const cl = classifyStability(["slide_05"], { record: r2 });
    ok("(4b) default attempts=3", c2.slide_05 === 3 && cl.attempts === 3, `calls=${c2.slide_05} attempts=${cl.attempts}`);
  }

  // (5) missing PIXEL representation can never be pixelPerfect (→ xmlStable).
  {
    const { record } = tableRecorder({
      slide_06: [{ xmlHash: "X" }, { xmlHash: "X" }, { xmlHash: "X" }],
    });
    const c = classifyStability(["slide_06"], { record, attempts: 3 });
    ok("(5) xml-only records → xmlStable, never pixelPerfect",
      JSON.stringify(c.xmlStable) === '["slide_06"]' && c.pixelPerfect.length === 0, JSON.stringify(c));
  }

  // (6) real PNG-byte hashing via pngPath → pixelPerfect when bytes match.
  {
    const dir = mkdtempSync(join(tmpdir(), "stab-png-"));
    const a = join(dir, "a.png"), b = join(dir, "b.png"), d = join(dir, "d.png");
    writeFileSync(a, Buffer.from([1, 2, 3, 4]));
    writeFileSync(b, Buffer.from([1, 2, 3, 4])); // identical bytes
    writeFileSync(d, Buffer.from([9, 9, 9, 9])); // different bytes
    const { record: rSame } = tableRecorder({ slide_07: [{ pngPath: a, xml: "X" }, { pngPath: b, xml: "X" }] });
    const cSame = classifyStability(["slide_07"], { record: rSame, attempts: 2 });
    ok("(6) identical PNG bytes via pngPath → pixelPerfect", JSON.stringify(cSame.pixelPerfect) === '["slide_07"]', JSON.stringify(cSame));
    const { record: rDiff } = tableRecorder({ slide_08: [{ pngPath: a, xml: "X" }, { pngPath: d, xml: "X" }] });
    const cDiff = classifyStability(["slide_08"], { record: rDiff, attempts: 2 });
    ok("(6b) differing PNG bytes but same xml → xmlStable", JSON.stringify(cDiff.xmlStable) === '["slide_08"]', JSON.stringify(cDiff));
    rmSync(dir, { recursive: true, force: true });
  }

  // (7) stability.json write/load round-trip; missing → null.
  {
    const dir = mkdtempSync(join(tmpdir(), "stab-json-"));
    const p = join(dir, "sub", "stability.json"); // sub dir created by writer
    const c = classifyStability(["slide_09"], { record: () => ({ pixelHash: "P", xmlHash: "X" }), attempts: 3 });
    writeStabilityJson(p, c);
    const back = loadStability(p);
    ok("(7) stability.json round-trips", back != null && JSON.stringify(back.pixelPerfect) === '["slide_09"]' && back.attempts === 3, JSON.stringify(back));
    ok("(7b) loadStability(missing) → null", loadStability(join(dir, "nope.json")) === null);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}

main();
