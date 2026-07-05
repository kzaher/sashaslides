/**
 * rating-marker.test.ts — the rating-outcome marker path + read/validate helpers
 * (main.ts: ratingMarkerPath / readRatingMarker / RatingOutcomeMarker).
 *
 * ratingMarkerPath derives <shared_dir>/rating-outcome.json (an absolute path on
 * the shared /overlays volume, OUTSIDE the fork's overlay); readRatingMarker
 * parses+validates it, returning null for absent/malformed/wrong-typed markers
 * and sanitizing the string arrays. No engine execution — just the pure helpers.
 */
import { ratingMarkerPath, readRatingMarker, type Task, type RatingOutcomeMarker } from "./main.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

/** Minimal Task carrying only the fields ratingMarkerPath/readRatingMarker use
 *  (shared_dir + task_id); the rest are filler to satisfy the type. The marker
 *  now lives under shared_dir, so point it at the passed (real tmp) dir. */
function mkTask(sharedDir: string, taskId = "clip"): Task {
  return {
    task_id: taskId,
    branch_id: `bs-${taskId}-test`,
    workspace_dir: "/nope",
    shared_dir: sharedDir,
    scratch_dir: "/nope-scratch",
    analysis_dir: "/nope",
    fixtures_dir: "fixtures-basic",
    server_port: 0,
    presentation_title: "t",
    slides: [],
    cluster_description: "",
    retry_budget: 0,
  } as Task;
}

function main() {
  console.log("\nrating-marker tests (marker path + read/validate)\n");
  const root = mkdtempSync(join(tmpdir(), "rm-"));

  // (1) ratingMarkerPath = <shared_dir>/rating-outcome.json
  {
    const t = mkTask(join(root, "s1"));
    ok("(1) ratingMarkerPath = <shared_dir>/rating-outcome.json",
      ratingMarkerPath(t) === join(t.shared_dir, "rating-outcome.json"), ratingMarkerPath(t));
  }

  // (2) round-trip green:true
  {
    const dir = mkdtempSync(join(root, "green-"));
    const t = mkTask(dir, "greeny");
    const marker: RatingOutcomeMarker = {
      task_id: "greeny", rated: true, green: true,
      good: ["slide_01", "slide_02"], bad: [], unrated: [], slides: ["slide_01", "slide_02"],
    };
    writeFileSync(ratingMarkerPath(t), JSON.stringify(marker));
    const out = readRatingMarker(t);
    ok("(2) green:true round-trips",
      out !== null && out.green === true && out.rated === true &&
      JSON.stringify(out.good) === '["slide_01","slide_02"]' && out.bad.length === 0, JSON.stringify(out));
  }

  // (3) round-trip green:false
  {
    const dir = mkdtempSync(join(root, "red-"));
    const t = mkTask(dir, "reddy");
    writeFileSync(ratingMarkerPath(t), JSON.stringify({
      task_id: "reddy", rated: true, green: false, good: ["a"], bad: ["b"], unrated: [], slides: ["a", "b"],
    }));
    const out = readRatingMarker(t);
    ok("(3) green:false round-trips", out !== null && out.green === false && JSON.stringify(out.bad) === '["b"]', JSON.stringify(out));
  }

  // (4) missing file → null
  {
    const t = mkTask(join(root, "does-not-exist"));
    ok("(4) missing marker file → null", readRatingMarker(t) === null);
  }

  // (5) malformed JSON → null
  {
    const dir = mkdtempSync(join(root, "bad-"));
    const t = mkTask(dir);
    writeFileSync(ratingMarkerPath(t), "{ this is not json ]");
    ok("(5) malformed JSON → null", readRatingMarker(t) === null);
  }

  // (6) green not a boolean → null
  {
    const dir = mkdtempSync(join(root, "notbool-"));
    const t = mkTask(dir);
    writeFileSync(ratingMarkerPath(t), JSON.stringify({ task_id: "x", green: "true", good: [], bad: [], unrated: [], slides: [] }));
    ok("(6) green not a boolean → null", readRatingMarker(t) === null);
  }

  // (7) non-string array entries dropped (sanitized)
  {
    const dir = mkdtempSync(join(root, "sani-"));
    const t = mkTask(dir);
    writeFileSync(ratingMarkerPath(t), JSON.stringify({
      task_id: "x", rated: true, green: false,
      good: ["ok", 42, null, "ok2"], bad: [{}, "b"], unrated: ["u", 7], slides: ["s", false],
    }));
    const out = readRatingMarker(t);
    ok("(7) non-string array entries dropped",
      out !== null &&
      JSON.stringify(out.good) === '["ok","ok2"]' &&
      JSON.stringify(out.bad) === '["b"]' &&
      JSON.stringify(out.unrated) === '["u"]' &&
      JSON.stringify(out.slides) === '["s"]', JSON.stringify(out));
  }

  // (8) missing task_id in marker → falls back to task.task_id; missing arrays → []
  {
    const dir = mkdtempSync(join(root, "fallback-"));
    const t = mkTask(dir, "fallback-slug");
    writeFileSync(ratingMarkerPath(t), JSON.stringify({ green: true }));
    const out = readRatingMarker(t);
    ok("(8) missing task_id → task.task_id; missing arrays → []",
      out !== null && out.task_id === "fallback-slug" && out.rated === false &&
      out.good.length === 0 && out.bad.length === 0 && out.slides.length === 0, JSON.stringify(out));
  }

  rmSync(root, { recursive: true, force: true });
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();
