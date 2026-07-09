/**
 * Build the list of Task objects that main.ts will iterate over. Each task:
 *   - gets an OVERLAY BRANCH id (bs-<task>-<ts>). There is NO git worktree and
 *     NO disk copy: the overlay is mounted lazily, per-command, by
 *     structured-prompting's workspace.sh (lower = the working tree, upper = /overlays).
 *     Every command the fork runs (worker model calls + record/diff shells)
 *     executes INSIDE that branch (engine `switchBranch`), so its edits +
 *     scratch land in the branch's isolated upper layer, never on the base tree.
 *   - uses REPO-RELATIVE scratch / analysis dirs, created inside the branch.
 *   - bundles the per-slide SlideTask records (html path, user comment, png
 *     paths) from ratings.json
 *   - gets a unique server port allocated in the range [4720, 4800)
 *   - gets a unique presentation_title so parallel uploads don't collide
 *
 * The caller passes `clusters`: a plain description of which slides go
 * together (from the wave-planning categorization). The ratings.json is
 * used to look up the exact user-comment strings so they travel into the
 * structured prompt verbatim.
 *
 * NOTE: the old `assertCleanTree` "no dirty files" gate was DELETED — the
 * overlay lower IS the working tree, so uncommitted changes ride into every
 * branch naturally; the gate is obsolete.
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { resolve } from "path";
import type { SlideTask, Task } from "./main.js";
import { makeAnnotationComposite } from "./scripts/annotation-composite.js";

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
  /** absolute path to the user's drawn annotation PNG (rating server writes it). */
  annotation?: string;
}

function readRatings(path: string): Record<string, RatingEntry> {
  if (!existsSync(path)) return {};
  // External untyped JSON boundary: parse once into the minimal shape we read.
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, RatingEntry>;
}

function buildSlideTasks(slideIds: string[], opts: BuildOptions): SlideTask[] {
  const ratings = readRatings(opts.ratings_json);
  // Max-contrast composites (annotation applied onto the target render) land
  // here so workers get a single image that shows BOTH the slide and where the
  // user marked. mkdir once.
  const compositesDir = resolve(opts.sxs_dir, "composites");
  try { mkdirSync(compositesDir, { recursive: true }); } catch { /* best-effort */ }
  const out: SlideTask[] = [];
  for (const id of slideIds) {
    const r = ratings[id] || {};
    const html = resolve(opts.repo_root, opts.fixtures_dir, `${id}.html`);
    if (!existsSync(html)) {
      throw new Error(`fixture not found for ${id}: ${html}`);
    }
    // Comment + annotation come ONLY from the live SxS rating (the slide you
    // actually marked). No .bug-solving-history ledger — it could be stale.
    const sxsAnnotation = resolve(opts.sxs_dir, "annotations", `${id}.png`);
    const annotation = (r.annotation && existsSync(r.annotation))
      ? r.annotation
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
      user_comment: (r.comment as string | undefined) ?? "",
      annotation_png: annotation,
      composite_png,
      rendered_png: resolve(opts.sxs_dir, "slides", `${id}.png`),
      original_png,
    });
  }
  return out;
}

/**
 * Allocate a deterministic-per-run overlay branch id. NO git worktree, NO copy,
 * NO mount here — the overlay is mounted lazily on the FIRST command the engine
 * runs inside the branch (`overlay-branch.sh run <id> …`), with the working tree
 * as the lower layer and the branch's edits captured in its upper layer on the
 * /overlays volume. node_modules ride in the shared lower layer (gitignored, so
 * never counted as a change), so no symlink dance is needed either.
 */
function createOverlayBranch(task_id: string): { branch_id: string } {
  return { branch_id: `bs-${task_id}-${Date.now()}` };
}

/**
 * Repo-relative scratch + analysis dirs. Both live INSIDE each fork's overlay
 * branch (created there at runtime), so every task can reuse the SAME relative
 * path without colliding — the branches are isolated. The record/diff scripts
 * write here (branch upper layer = disposable); the worker writes analysis.md /
 * fix-summary.md into the analysis dir.
 */
const SCRATCH_REL = ".bug-solving-scratch";
const ANALYSIS_REL = "bug-solving-analysis";

/** Shared, outside-the-overlay root for this run's cross-boundary artifacts
 *  (rating-outcome markers). A command run INSIDE a fork's branch can write under
 *  here and the result is visible OUTSIDE the overlay (it's the ext4 upperRoot
 *  volume, not part of any branch's lower/upper). Each run gets its own subdir so
 *  parallel runs don't collide; each task gets its own subdir under that. */
const SHARED_ROOT = "/overlays/shared";

/**
 * Stage each slide's SxS images into a JAIL-VISIBLE dir and populate the
 * consolidated `img_*` fields (absolute paths) on the SlideTask.
 *
 * WHY this is required: the worker runs inside the COW jail, where `/tmp` is a
 * fresh tmpfs — the host's `/tmp/sxs-complex/{originals,slides,...}` sources are
 * INVISIBLE there, and the slide PNGs live ONLY under /tmp (not in the repo tree,
 * so the overlay lower can't surface them either). We copy them into
 * `<shared_dir>/images/` on the `/overlays` volume, which is a SEPARATE mount the
 * jail leaves readable (the same cross-boundary channel the rating-outcome
 * markers use). The `img_*` absolute paths resolve identically on the host and
 * inside the jail, so the prompt's `img_original ?? original_png` fallback now
 * lands on a file the worker can actually open. Best-effort per image: a missing
 * source (e.g. no annotation → no composite) simply leaves that field undefined.
 */
export function stageSlideImages(slides: SlideTask[], imagesDir: string): void {
  try { mkdirSync(imagesDir, { recursive: true }); } catch { /* best-effort */ }
  const copy = (src: string | undefined, name: string): string | undefined => {
    if (!src || !existsSync(src)) return undefined;
    const dst = resolve(imagesDir, name);
    try { copyFileSync(src, dst); return dst; } catch { return undefined; }
  };
  for (const s of slides) {
    s.img_original = copy(s.original_png, `${s.slide_id}_original.png`);
    s.img_attempt = copy(s.rendered_png, `${s.slide_id}_attempt.png`);
    s.img_annotations = copy(s.annotation_png, `${s.slide_id}_annotations.png`);
    s.img_highlighted = copy(s.composite_png, `${s.slide_id}_highlighted_attempt.png`);
  }
}

/**
 * Filter clusters to the one(s) matching `--only` (BUG_SOLVING_ONLY): exact
 * task_id, a substring of it, or a slide id contained in the cluster. Empty
 * `only` → all clusters (a fresh copy). Pure — no env, no process.exit; the
 * caller decides what an empty result means (main-scaffolding errors + exits 2).
 */
export function selectOnlyClusters(clusters: readonly Cluster[], only: string): Cluster[] {
  const q = (only ?? "").trim();
  if (!q) return [...clusters];
  return clusters.filter((c) => c.task_id === q || c.task_id.includes(q) || c.slide_ids.includes(q));
}

export function buildTasks(options: Partial<BuildOptions> & Pick<BuildOptions, "clusters">): Task[] {
  const opts: BuildOptions = { ...DEFAULTS, ...options };
  const runId = `run-${Date.now()}`;
  const out: Task[] = [];
  for (let i = 0; i < opts.clusters.length; i++) {
    const c = opts.clusters[i];
    const slides = buildSlideTasks(c.slide_ids, opts);
    const { branch_id } = createOverlayBranch(c.task_id);
    const shared_dir = `${SHARED_ROOT}/${runId}/${c.task_id}`;
    // Consolidate this task's per-slide SxS images into the jail-visible shared
    // dir (on the /overlays volume). The worker runs inside the COW jail, where
    // /tmp is a fresh tmpfs, so the /tmp/sxs-complex sources are UNREACHABLE by
    // their absolute paths — we must copy them somewhere the jail can read. This
    // populates SlideTask.img_* (absolute /overlays paths) which the prompts
    // prefer over the dead /tmp fallbacks.
    stageSlideImages(slides, `${shared_dir}/images`);
    out.push({
      task_id: c.task_id,
      branch_id,
      // Repo root — the branch's merged view resolves the repo-relative
      // scratch/analysis/script paths from here. Also the base tree the final
      // LLM merge overlays + promotes onto.
      workspace_dir: opts.repo_root,
      // ABSOLUTE, OUTSIDE the overlay — the fork's rating-outcome marker lands
      // here so the final merge (running outside any branch) can read it.
      shared_dir,
      scratch_dir: SCRATCH_REL,
      analysis_dir: ANALYSIS_REL,
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
