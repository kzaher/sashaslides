/**
 * Build the list of Task objects that main.ts will iterate over. Each task:
 *   - gets a fresh git worktree rooted at .claude/worktrees/bs-<task_id>-<ts>
 *   - gets a scratch dir under that worktree for before/after/diffs/etc.
 *   - bundles the per-slide SlideTask records (html path, user comment, png
 *     paths) from ratings.json
 *   - gets a unique server port allocated in the range [4720, 4800)
 *   - gets a unique presentation_title so parallel uploads don't collide
 *
 * The caller passes `clusters`: a plain description of which slides go
 * together (from the wave-planning categorization). The ratings.json is
 * used to look up the exact user-comment strings so they travel into the
 * structured prompt verbatim.
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import type { SlideTask, Task } from "./main.js";
import { makeAnnotationComposite } from "./scripts/annotation-composite.js";

/**
 * Fail EARLY if the main working tree is dirty under the converter paths.
 *
 * Worktrees (and the coming full-disk-copy branches) fork from HEAD, so any
 * UNCOMMITTED converter change in the main tree is silently EXCLUDED from every
 * worker — and then confuses merge/accept ("the fix isn't in the diff"). This
 * preflight refuses to run against a dirty converter tree so a human commits or
 * stashes first, rather than discovering the omission after a whole run.
 *
 * Scope: we check ONLY the paths in `paths` (default the converter dir
 * `renderer/html2slides`), so unrelated untracked scratch dirs elsewhere in the
 * repo don't block a run. `git status --porcelain -- <paths>` reports BOTH
 * tracked modifications AND untracked files UNDER those paths (so a stray new
 * .ts/.html fixture there is caught too), which is exactly the state that would
 * be lost across the HEAD fork.
 *
 * Escape hatch: BUG_SOLVING_ALLOW_DIRTY=1 downgrades the failure to a warning
 * for power users who KNOW the dirty state is intentional/irrelevant.
 */
export function assertCleanTree(repoRoot: string, paths: string[] = ["renderer/html2slides"]): void {
  let porcelain = "";
  try {
    porcelain = execSync(`git status --porcelain -- ${paths.map((p) => `"${p}"`).join(" ")}`, {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    // If git itself fails (not a repo, etc.) that's a setup problem worth
    // surfacing — but don't hard-fail the run on it; warn and continue.
    console.error(`[preflight] warning: could not check working-tree cleanliness: ${(e as Error).message}`);
    return;
  }
  if (!porcelain) return; // clean under the scoped paths → proceed.

  const dirtyFiles = porcelain.split("\n").map((l) => l.trim()).filter(Boolean);
  const allowDirty = process.env.BUG_SOLVING_ALLOW_DIRTY === "1";
  const header =
    `Dirty working tree under [${paths.join(", ")}] — ${dirtyFiles.length} uncommitted change(s):\n` +
    dirtyFiles.map((f) => `    ${f}`).join("\n");
  if (allowDirty) {
    console.error(`⚠ ${header}\n  BUG_SOLVING_ALLOW_DIRTY=1 set — proceeding anyway (these changes will NOT be in the worktrees).`);
    return;
  }
  throw new Error(
    `${header}\n\n` +
    `  Worktrees (and disk-copy branches) fork from HEAD, so these UNCOMMITTED changes would be\n` +
    `  SILENTLY EXCLUDED from every worker — causing merge/accept confusion later.\n` +
    `  Commit or stash them first:\n` +
    `      git add -A && git commit -m "wip"   # or:  git stash\n` +
    `  Then re-run. To override (you know what you're doing): BUG_SOLVING_ALLOW_DIRTY=1`,
  );
}

/**
 * Turn a repo-relative fixtures dir path into a dir-safe slug so that
 * complex vs basic/simple fixture sets land in DISTINCT subdirs of the
 * consolidated per-task image dir. Any run of non-[a-z0-9] chars collapses
 * to a single dash, and leading/trailing dashes are trimmed.
 *   renderer/html2slides/e2e/fixtures       → renderer-html2slides-e2e-fixtures
 *   renderer/html2slides/e2e/fixtures-basic → renderer-html2slides-e2e-fixtures-basic
 */
export function fixtureSetSlug(fixturesDir: string): string {
  return fixturesDir
    .replace(/^\.\/+/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export interface Cluster {
  task_id: string;                  // "clipping-curves"
  cluster_description: string;      // root-cause hypothesis
  slide_ids: string[];              // ["slide_11", "slide_12", ...]
  retry_budget?: number;            // per-cluster attempt cap; falls back to the BuildOptions default
}

export interface BuildOptions {
  clusters: readonly Cluster[];
  ratings_json: string;             // default: /tmp/sxs-complex/ratings.json
  fixtures_dir: string;             // default: renderer/html2slides/e2e/fixtures
  sxs_dir: string;                  // default: /tmp/sxs-complex
  port_base: number;                // default: 4720
  retry_budget: number;             // default: 3
  repo_root: string;                // default: process.cwd()
}

const DEFAULTS: Omit<BuildOptions, "clusters"> = {
  ratings_json: "/tmp/sxs-complex/ratings.json",
  fixtures_dir: "renderer/html2slides/e2e/fixtures",
  sxs_dir: "/tmp/sxs-complex",
  port_base: 4720,
  retry_budget: 3,
  repo_root: process.cwd(),
};

/** One rating entry as stored in ratings.json. Only `comment` is consumed
 *  here; other fields (verdict, etc.) are ignored, so keep the shape minimal. */
interface RatingEntry {
  comment?: string;
}

function readRatings(path: string): Record<string, RatingEntry> {
  if (!existsSync(path)) return {};
  // External untyped JSON boundary: parse once into the minimal shape we read.
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, RatingEntry>;
}

/** Persistent per-slide ledger of the LATEST user rating (comment + annotation),
 *  written by the rating server's `--history-dir`. Survives worktree cleanup and
 *  /tmp wipes, so a follow-up round reads the most recent feedback rather than
 *  the original (possibly wiped) sxs ratings.json. */
const HISTORY_DIR = "/workspaces/sashaslides/.bug-solving-history";
interface LedgerEntry { comment?: string; annotation?: string }
function readLedger(): Record<string, LedgerEntry> {
  const f = resolve(HISTORY_DIR, "ratings.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf-8")) as Record<string, LedgerEntry>; }
  catch { return {}; }
}

function buildSlideTasks(slideIds: string[], opts: BuildOptions): SlideTask[] {
  const ratings = readRatings(opts.ratings_json);
  const ledger = readLedger();
  // Max-contrast composites (annotation applied onto the target render) land
  // here so workers get a single image that shows BOTH the slide and where the
  // user marked. mkdir once.
  const compositesDir = resolve(opts.sxs_dir, "composites");
  try { mkdirSync(compositesDir, { recursive: true }); } catch { /* best-effort */ }
  const out: SlideTask[] = [];
  for (const id of slideIds) {
    const r = ratings[id] || {};
    const led = ledger[id] || {};
    const html = resolve(opts.repo_root, opts.fixtures_dir, `${id}.html`);
    if (!existsSync(html)) {
      throw new Error(`fixture not found for ${id}: ${html}`);
    }
    // Prefer the persistent ledger (latest round's feedback) over the original
    // sxs ratings.json / annotations dir, which may be stale or /tmp-wiped.
    const sxsAnnotation = resolve(opts.sxs_dir, "annotations", `${id}.png`);
    const annotation = (led.annotation && existsSync(led.annotation))
      ? led.annotation
      : (existsSync(sxsAnnotation) ? sxsAnnotation : undefined);
    const original_png = resolve(opts.sxs_dir, "originals", `${id}.png`);
    // For any slide with an annotation, build the max-contrast composite over
    // the ORIGINAL/target render (the annotation coords align to the original,
    // since the rating UI draws the annotation over it). Only set composite_png
    // when the helper actually wrote the file.
    let composite_png: string | undefined;
    if (annotation) {
      const compositePath = resolve(compositesDir, `${id}.png`);
      if (makeAnnotationComposite(original_png, annotation, compositePath)) {
        composite_png = compositePath;
      }
    }
    out.push({
      slide_id: id,
      html_file: html,
      user_comment: (led.comment ?? (r.comment as string | undefined)) ?? "",
      annotation_png: annotation,
      composite_png,
      rendered_png: resolve(opts.sxs_dir, "slides", `${id}.png`),
      original_png,
    });
  }
  return out;
}

function createWorktree(opts: BuildOptions, task_id: string): string {
  const ts = Date.now();
  const dir = resolve(opts.repo_root, ".claude", "worktrees", `bs-${task_id}-${ts}`);
  const branch = `bug_solving/${task_id}-${ts}`;
  mkdirSync(resolve(opts.repo_root, ".claude", "worktrees"), { recursive: true });
  execSync(`git worktree add -b "${branch}" "${dir}" HEAD`, {
    cwd: opts.repo_root, stdio: "inherit",
  });

  // Replace the partially-tracked node_modules directories with symlinks
  // back to the main repo's fully-installed ones. Some packages (e.g.
  // googleapis) have only package.json/README tracked in git — the
  // worktree's checkout is missing build artifacts. Without the
  // symlinks, `npx tsx renderer/html2slides/convert-pptx.ts` fails with
  // ERR_MODULE_NOT_FOUND.
  //
  // We symlink both the repo-root node_modules and renderer/node_modules
  // (separate package there). structured-prompting/ isn't needed — the
  // worktree's worker code only runs renderer/ scripts.
  for (const rel of ["node_modules", "renderer/node_modules"]) {
    const wtNm = resolve(dir, rel);
    const mainNm = resolve(opts.repo_root, rel);
    if (!existsSync(mainNm)) continue;
    try {
      execSync(`rm -rf "${wtNm}" && ln -s "${mainNm}" "${wtNm}"`, { stdio: "inherit" });
    } catch (e) {
      console.error(`warning: failed to symlink ${rel} in worktree ${dir}: ${e}`);
    }
  }
  return dir;
}

/**
 * Consolidate every image a worker needs for each slide into ONE dir under the
 * task's worktree scratch, keyed by the fixture set:
 *   <workspace_dir>/.bug-solving-scratch/<fixtureSetSlug>/slide_NN_{original,annotations,attempt,highlighted_attempt}.png
 *
 * The scattered /tmp/sxs-complex sources (originals/ annotations/ slides/) stay
 * as the SOURCE of truth; these are COPIES inside the worktree so the worker
 * finds everything in its own workspace. Mutates each SlideTask in place with
 * the four resolved absolute `img_*` paths. Called from buildTasks AFTER the
 * worktree exists (buildSlideTasks runs before workspace_dir is known).
 */
function materializeConsolidatedImages(
  slides: SlideTask[],
  workspace_dir: string,
  scratch_dir: string,
  fixturesDir: string,
): void {
  const slug = fixtureSetSlug(fixturesDir);
  const dir = resolve(scratch_dir, slug);
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }

  for (const s of slides) {
    const id = s.slide_id; // "slide_04"
    const original = resolve(dir, `${id}_original.png`);
    const annotations = resolve(dir, `${id}_annotations.png`);
    const attempt = resolve(dir, `${id}_attempt.png`);
    const highlighted = resolve(dir, `${id}_highlighted_attempt.png`);

    // TARGET render.
    if (s.original_png && existsSync(s.original_png)) {
      try { copyFileSync(s.original_png, original); s.img_original = original; } catch { /* best-effort */ }
    }
    // RAW annotation (may be absent → skip; leave img_annotations undefined).
    if (s.annotation_png && existsSync(s.annotation_png)) {
      try { copyFileSync(s.annotation_png, annotations); s.img_annotations = annotations; } catch { /* best-effort */ }
    }
    // The render being evaluated — at build time this is OUR CURRENT render.
    // (The verify path later refreshes this from the AFTER thumbnail.)
    if (s.rendered_png && existsSync(s.rendered_png)) {
      try { copyFileSync(s.rendered_png, attempt); s.img_attempt = attempt; } catch { /* best-effort */ }
    }
    // Max-contrast composite (annotation applied over the TARGET slide). Only
    // when an annotation exists and the helper actually wrote the file.
    if (s.annotation_png && existsSync(s.annotation_png) && s.original_png && existsSync(s.original_png)) {
      if (makeAnnotationComposite(s.original_png, s.annotation_png, highlighted)) {
        s.img_highlighted = highlighted;
      }
    }
  }
}

export function buildTasks(options: Partial<BuildOptions> & Pick<BuildOptions, "clusters">): Task[] {
  const opts: BuildOptions = { ...DEFAULTS, ...options };
  const out: Task[] = [];
  for (let i = 0; i < opts.clusters.length; i++) {
    const c = opts.clusters[i];
    const slides = buildSlideTasks(c.slide_ids, opts);
    const workspace_dir = createWorktree(opts, c.task_id);
    const scratch_dir = resolve(workspace_dir, ".bug-solving-scratch");
    mkdirSync(scratch_dir, { recursive: true });
    // Consolidate every per-slide image into ONE fixture-set-keyed dir under
    // this worktree's scratch, now that workspace_dir exists. Mutates `slides`
    // in place with the four img_* absolute paths.
    materializeConsolidatedImages(slides, workspace_dir, scratch_dir, opts.fixtures_dir);
    // Model work-products (analysis.md / fix-summary.md) go here, NOT in the
    // gitignored scratch dir, so they show up in the engine's per-node git
    // diff. The binary pptx/diff artifacts stay under scratch_dir (ignored).
    const analysis_dir = resolve(workspace_dir, "bug-solving-analysis");
    mkdirSync(analysis_dir, { recursive: true });
    out.push({
      task_id: c.task_id,
      workspace_dir,
      scratch_dir,
      analysis_dir,
      fixtures_dir: opts.fixtures_dir,
      server_port: opts.port_base + i,
      presentation_title: `bug_solving-${c.task_id}-${Date.now()}`,
      slides,
      cluster_description: c.cluster_description,
      retry_budget: c.retry_budget ?? opts.retry_budget,
    });
  }
  return out;
}
