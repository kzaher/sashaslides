/**
 * stage-slide-images.test.ts — the jail-visible image staging (workspace-setup.ts
 * stageSlideImages + its wiring in buildTasks). The worker runs in the COW jail
 * where /tmp is a fresh tmpfs, so the /tmp/sxs-complex sources are UNREACHABLE;
 * buildTasks must copy each slide's images onto the /overlays volume and point
 * SlideTask.img_* at those absolute paths.
 *
 * Edge cases:
 *   • present sources → img_original/img_attempt copied under <dir>, byte-exact;
 *   • MISSING sources (no annotation/composite) → those img_* stay undefined;
 *   • non-existent source path → best-effort, field undefined, no throw;
 *   • buildTasks end-to-end → img_* land under /overlays/shared/.../images and exist.
 * Only the fs is real (no engine, no jail).
 */
import { stageSlideImages, buildTasks } from "./workspace-setup.js";
import type { SlideTask } from "./main.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}
const sameBytes = (a: string, b: string) => existsSync(a) && existsSync(b) && Buffer.compare(readFileSync(a), readFileSync(b)) === 0;

function mkSlide(o: Partial<SlideTask> & Pick<SlideTask, "slide_id" | "rendered_png" | "original_png">): SlideTask {
  return { html_file: "/x.html", user_comment: "", ...o } as SlideTask;
}

// ---------------------------------------------------------------------------
// stageSlideImages (direct)
// ---------------------------------------------------------------------------
console.log("\nstageSlideImages — copy per-slide images into a jail-visible dir\n");

const src = mkdtempSync(join(tmpdir(), "stage-src-"));
writeFileSync(join(src, "orig.png"), "ORIGINAL-BYTES");
writeFileSync(join(src, "att.png"), "ATTEMPT-BYTES");
writeFileSync(join(src, "ann.png"), "ANNOTATION-BYTES");
const imagesDir = join(src, "out", "images"); // note: does NOT exist yet

// slide A: original + attempt + annotation present; NO composite
const a = mkSlide({ slide_id: "slide_07", original_png: join(src, "orig.png"), rendered_png: join(src, "att.png"), annotation_png: join(src, "ann.png") });
// slide B: only original + attempt; annotation source path is MISSING
const b = mkSlide({ slide_id: "slide_08", original_png: join(src, "orig.png"), rendered_png: join(src, "att.png"), annotation_png: join(src, "nope-missing.png") });

stageSlideImages([a, b], imagesDir);

ok("(0) imagesDir created on demand", existsSync(imagesDir));
ok("(1) img_original set under imagesDir", a.img_original === join(imagesDir, "slide_07_original.png"), a.img_original);
ok("(1a) img_original bytes match source", sameBytes(a.img_original!, join(src, "orig.png")));
ok("(2) img_attempt set + byte-exact", a.img_attempt === join(imagesDir, "slide_07_attempt.png") && sameBytes(a.img_attempt!, join(src, "att.png")));
ok("(3) img_annotations set when annotation present + byte-exact", a.img_annotations === join(imagesDir, "slide_07_annotations.png") && sameBytes(a.img_annotations!, join(src, "ann.png")));
ok("(4) NO composite source → img_highlighted stays undefined", a.img_highlighted === undefined);
ok("(5) MISSING annotation source → img_annotations undefined (best-effort, no throw)", b.img_annotations === undefined);
ok("(5a) …but img_original/attempt still staged for that slide", !!b.img_original && !!b.img_attempt);

// slide C: original path doesn't exist at all → img_original undefined
const c = mkSlide({ slide_id: "slide_09", original_png: join(src, "gone.png"), rendered_png: join(src, "att.png") });
stageSlideImages([c], imagesDir);
ok("(6) non-existent original source → img_original undefined", c.img_original === undefined && c.img_attempt !== undefined);

// ---------------------------------------------------------------------------
// buildTasks end-to-end → img_* land on the /overlays volume (jail-visible)
// ---------------------------------------------------------------------------
console.log("\nbuildTasks — stages onto /overlays/shared (the jail-visible channel)\n");

let sharedParent: string | null = null;
if (existsSync("/overlays")) {
  const repo = mkdtempSync(join(tmpdir(), "stage-repo-"));
  mkdirSync(join(repo, "fx"), { recursive: true });
  writeFileSync(join(repo, "fx", "slide_99.html"), "<html></html>");
  const sxs = mkdtempSync(join(tmpdir(), "stage-sxs-"));
  mkdirSync(join(sxs, "originals"), { recursive: true });
  mkdirSync(join(sxs, "slides"), { recursive: true });
  writeFileSync(join(sxs, "originals", "slide_99.png"), "T99-ORIG");
  writeFileSync(join(sxs, "slides", "slide_99.png"), "T99-ATT");

  const tasks = buildTasks({
    clusters: [{ task_id: "t99", cluster_description: "d", slide_ids: ["slide_99"] }],
    fixtures_dir: "fx",
    sxs_dir: sxs,
    repo_root: repo,
  });
  const s = tasks[0].slides[0];
  sharedParent = dirname(tasks[0].shared_dir); // /overlays/shared/<runId>
  ok("(7) buildTasks populated img_original on the /overlays volume", !!s.img_original && s.img_original.startsWith("/overlays/"), s.img_original);
  ok("(7a) staged original exists + byte-exact", sameBytes(s.img_original!, join(sxs, "originals", "slide_99.png")));
  ok("(7b) img_attempt on /overlays + byte-exact", !!s.img_attempt && s.img_attempt.startsWith("/overlays/") && sameBytes(s.img_attempt!, join(sxs, "slides", "slide_99.png")));
  ok("(7c) no annotation source → img_annotations undefined", s.img_annotations === undefined);
  rmSync(repo, { recursive: true, force: true });
  rmSync(sxs, { recursive: true, force: true });
} else {
  console.log("  ⚠ SKIP buildTasks-on-/overlays cases — no /overlays volume (not a failure)");
}

// cleanup
rmSync(src, { recursive: true, force: true });
if (sharedParent && existsSync(sharedParent)) rmSync(sharedParent, { recursive: true, force: true });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
