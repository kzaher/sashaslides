/**
 * forward-fork.test.ts — the forward fork's host-visible paths and builders (forward-fork.ts):
 *   (1) every path is under the task's SHARED dir (outside the overlay);
 *   (2) the off-target gate: the visual verdict wins, else the structural fallback;
 *   (3) the verdict header shows the BEFORE render AND step 4e's AFTER image;
 *   (4) the rating UI argv: verdict-only candidate UI, never a goldens flag;
 *   (5) writeSxsMeta reads the fork's manifest and writes next to it.
 * Only the fs is real (temp dirs).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  changedOffTargets,
  forwardAfterImages,
  forwardForkPaths,
  forwardRatingServerArguments,
  forwardVerdictHeader,
  offTargetRegressions,
  writeSxsMeta,
} from "./forward-fork.js";
import type { SlideTask, Task } from "./main.js";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const root = mkdtempSync(join(tmpdir(), "forward-fork-"));
const shared = join(root, "shared", "task-a");
const fork = forwardForkPaths(shared);

console.log("\n(1) paths\n");
ok("(1a) every path is under the shared dir", [fork.root, fork.regDiffs, fork.offtargetGate, fork.thumbnails, fork.images].every((p) => p.startsWith(shared + "/")));
const after = forwardAfterImages(fork, "slide_07");
ok("(1b) AFTER images sit with the staged images", after.after === join(shared, "images", "slide_07_after.png") && after.highlightedAfter === join(shared, "images", "slide_07_highlighted_after.png"));
ok("(1c) the AFTER thumbnail is step 4c's render", after.thumbnail === join(fork.thumbnails, "thumbs", "slide_07.png"));

console.log("\n(2) off-target gate\n");
mkdirSync(fork.regDiffs, { recursive: true });
writeFileSync(join(fork.regDiffs, "slide_01.diff"), "(no structural differences detected)\n");
writeFileSync(join(fork.regDiffs, "slide_02.diff"), "- <a:off x=1/>\n+ <a:off x=2/>\n");
writeFileSync(join(fork.regDiffs, "slide_07.diff"), "- cluster slide changed\n");
ok("(2a) structural: only changed NON-cluster slides", JSON.stringify(changedOffTargets(fork.regDiffs, ["slide_07"])) === '["slide_02"]');
ok("(2b) no gate file → structural fallback", JSON.stringify(offTargetRegressions(fork, ["slide_07"])) === '["slide_02"]');
writeFileSync(fork.offtargetGate, JSON.stringify({ regressions: [], verdicts: [], changed: ["slide_02"] }));
ok("(2c) gate judged the change benign → no regression", offTargetRegressions(fork, ["slide_07"]).length === 0);
writeFileSync(fork.offtargetGate, JSON.stringify({ regressions: ["slide_09"] }));
ok("(2d) gate regressions are returned verbatim", JSON.stringify(offTargetRegressions(fork, ["slide_07"])) === '["slide_09"]');
writeFileSync(fork.offtargetGate, "{ not json");
ok("(2e) corrupt gate file → structural fallback (fail-safe)", JSON.stringify(offTargetRegressions(fork, ["slide_07"])) === '["slide_02"]');
ok("(2f) no reg-diffs at all → nothing", changedOffTargets(join(root, "absent"), []).length === 0);

console.log("\n(3) verdict header\n");
const slide: SlideTask = {
  slide_id: "slide_07", html_file: join(root, "slide_07.html"), user_comment: "corners are square",
  rendered_png: "/tmp/sxs-complex/slides/slide_07.png", original_png: "/tmp/sxs-complex/originals/slide_07.png",
  img_original: join(fork.images, "slide_07_original.png"), img_attempt: join(fork.images, "slide_07_attempt.png"),
  img_annotations: join(fork.images, "slide_07_annotations.png"),
};
const task = { task_id: "t", shared_dir: shared, analysis_dir: "bug-solving-analysis", scratch_dir: ".bug-solving-scratch", slides: [slide] } as unknown as Task;
const header = forwardVerdictHeader(task, slide);
ok("(3a) AFTER is step 4e's _after.png in the shared dir", header.includes(`AFTER render (the post-fix Google-Slides output): ${after.after}.`), header);
ok("(3b) the pre-fix render is labelled BEFORE, not post-fix", header.includes(`BEFORE render (the pre-fix Google-Slides output the user rated BAD): ${slide.img_attempt}.`));
ok("(3c) HIGHLIGHTED AFTER listed when an annotation is staged", header.includes(after.highlightedAfter));
ok("(3d) the user's comment verbatim", header.includes(`"corners are square"`));

console.log("\n(4) rating UI argv\n");
const argv = forwardRatingServerArguments({
  resultsDirectory: fork.thumbnails, slidesDirectory: join(fork.thumbnails, "thumbs"), port: 4721, slides: ["slide_07", "slide_08"],
  analysisPath: "$ROOT/bug-solving-analysis/analysis.md", diffsDirectory: "$ROOT/.bug-solving-scratch/diffs", taskTitle: "bug_solving: t",
  historyDirectory: "/h",
});
const value = (flag: string) => argv[argv.indexOf(flag) + 1];
ok("(4a) results dir first, then the shared thumbs", argv[0] === fork.thumbnails && value("--slides-dir") === join(fork.thumbnails, "thumbs"));
ok("(4b) verdict-only candidate UI that exits when rated", ["--read-only", "--exit-when-all-rated", "--candidate"].every((f) => argv.includes(f)) && value("--history-dir") === "/h");
ok("(4c) cluster filter, analysis, diffs, title", value("--filter-slides") === "slide_07,slide_08" && value("--task-analysis").endsWith("analysis.md") && value("--task-diffs").endsWith("diffs") && value("--port") === "4721");
ok("(4d) never a goldens flag", !argv.some((a) => a.includes("goldens")));

console.log("\n(5) writeSxsMeta\n");
writeFileSync(slide.html_file, "<html></html>");
mkdirSync(join(fork.thumbnails, "thumbs"), { recursive: true });
writeFileSync(join(fork.thumbnails, "thumbs", "manifest.json"), JSON.stringify({ presentation_id: "PRES" }));
writeSxsMeta(fork.thumbnails, [slide]);
const meta = JSON.parse(readFileSync(join(fork.thumbnails, "sxs-meta.json"), "utf-8"));
ok("(5a) presentation URL from the fork's manifest", meta.slide_07?.presentation_url === "https://docs.google.com/presentation/d/PRES/edit", JSON.stringify(meta));
ok("(5b) source HTML copied next to it", meta.slide_07?.html_file === "source/slide_07.html" && existsSync(join(fork.thumbnails, "source", "slide_07.html")));
writeSxsMeta(join(root, "missing", "deep"), [slide]);
ok("(5c) a fresh results dir is created, never throws", existsSync(join(root, "missing", "deep", "sxs-meta.json")));

rmSync(root, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
