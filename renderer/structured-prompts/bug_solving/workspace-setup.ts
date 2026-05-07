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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import type { SlideTask, Task } from "./main.js";

export interface Cluster {
  task_id: string;                  // "clipping-curves"
  cluster_description: string;      // root-cause hypothesis
  slide_ids: string[];              // ["slide_11", "slide_12", ...]
}

export interface BuildOptions {
  clusters: readonly Cluster[];
  ratings_json: string;             // default: /tmp/sxs-complex/ratings.json
  fixtures_dir: string;             // default: renderer/html2slides/e2e/fixtures
  sxs_dir: string;                  // default: /tmp/sxs-complex
  port_base: number;                // default: 4720
  retry_budget: number;             // default: 3
  repo_root: string;                // default: process.cwd()
  baseline_dir: string;             // pre-recorded shared baseline (pptx + thumbs)
}

const DEFAULTS: Omit<BuildOptions, "clusters" | "baseline_dir"> = {
  ratings_json: "/tmp/sxs-complex/ratings.json",
  fixtures_dir: "renderer/html2slides/e2e/fixtures",
  sxs_dir: "/tmp/sxs-complex",
  port_base: 4720,
  retry_budget: 3,
  repo_root: process.cwd(),
};

/** Shape of a single user verdict in the SxS ratings.json — only the
 * fields we actually consume are typed; `comment` is the most important
 * one as it carries the user's free-form bug description. */
interface RawRating {
  status?: "good" | "bad" | "pending";
  comment?: string;
  annotation?: string;
}

function readRatings(path: string): Record<string, RawRating> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, RawRating>;
}

function buildSlideTasks(slideIds: string[], opts: BuildOptions): SlideTask[] {
  const ratings = readRatings(opts.ratings_json);
  const out: SlideTask[] = [];
  for (const id of slideIds) {
    const r = ratings[id] || {};
    const html = resolve(opts.repo_root, opts.fixtures_dir, `${id}.html`);
    if (!existsSync(html)) {
      throw new Error(`fixture not found for ${id}: ${html}`);
    }
    const annotation = resolve(opts.sxs_dir, "annotations", `${id}.png`);
    out.push({
      slide_id: id,
      html_file: html,
      user_comment: (r.comment as string | undefined) ?? "",
      annotation_png: existsSync(annotation) ? annotation : undefined,
      rendered_png: resolve(opts.sxs_dir, "slides", `${id}.png`),
      original_png: resolve(opts.sxs_dir, "originals", `${id}.png`),
    });
  }
  return out;
}

/**
 * Remove every `.claude/worktrees/bs-*` worktree from prior runs.
 *
 * Why: each run creates fresh worktrees from current HEAD. Without cleanup,
 * stale worktrees accumulate on disk and — more importantly — old branches
 * named `bug_solving/<id>-<old-ts>` linger in the repo. The "fresh from
 * HEAD" guarantee depends on starting clean. Best-effort: per-worktree
 * removal failures are logged but don't abort the run.
 *
 * Active SxS review servers from a prior run will fail to serve files from
 * a removed worktree — by the time you launch a new wave, the prior wave's
 * review session is assumed done.
 */
export function cleanupStaleBugSolvingWorktrees(repo_root: string): void {
  let raw: string;
  try {
    raw = execSync("git worktree list --porcelain", { cwd: repo_root, encoding: "utf-8" });
  } catch {
    return;
  }
  const wtPaths: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      if (p.includes("/.claude/worktrees/bs-")) wtPaths.push(p);
    }
  }
  for (const p of wtPaths) {
    try {
      execSync(`git worktree remove --force "${p}"`, { cwd: repo_root, stdio: "ignore" });
    } catch {
      // worktree-list and worktree-remove can disagree if the dir was
      // already deleted manually; don't abort the run on a phantom entry.
    }
  }
  // Prune any branches the removed worktrees left behind.
  try {
    const branches = execSync("git for-each-ref --format='%(refname:short)' refs/heads/bug_solving/", {
      cwd: repo_root, encoding: "utf-8",
    });
    for (const b of branches.split("\n").map(s => s.trim()).filter(Boolean)) {
      try { execSync(`git branch -D "${b}"`, { cwd: repo_root, stdio: "ignore" }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function createWorktree(opts: BuildOptions, task_id: string): string {
  const ts = Date.now();
  const dir = resolve(opts.repo_root, ".claude", "worktrees", `bs-${task_id}-${ts}`);
  const branch = `bug_solving/${task_id}-${ts}`;
  mkdirSync(resolve(opts.repo_root, ".claude", "worktrees"), { recursive: true });
  // Build a worktree from current HEAD on a new throwaway branch. The
  // worktree directory must NOT already exist.
  execSync(`git worktree add -b "${branch}" "${dir}" HEAD`, {
    cwd: opts.repo_root, stdio: "inherit",
  });
  // Git checkouts partially-track a few files under node_modules (LICENSE,
  // package.json) but not the build outputs — convert-pptx.ts then fails
  // with "Cannot find package 'googleapis/build/...'". Symlink the parent
  // repo's node_modules directories into the worktree so dependencies
  // resolve exactly as in the main checkout.
  for (const rel of ["node_modules", "renderer/node_modules"]) {
    const main = resolve(opts.repo_root, rel);
    const wt = resolve(dir, rel);
    const wtParent = resolve(wt, "..");
    if (!existsSync(main) || !existsSync(wtParent)) continue;
    execSync(`rm -rf "${wt}" && ln -s "${main}" "${wt}"`);
  }
  return dir;
}

export function buildTasks(
  options: Partial<BuildOptions> & Pick<BuildOptions, "clusters" | "baseline_dir">,
): Task[] {
  const opts: BuildOptions = { ...DEFAULTS, ...options };
  if (!opts.baseline_dir || !existsSync(opts.baseline_dir)) {
    throw new Error(`buildTasks: baseline_dir required and must exist (got ${opts.baseline_dir})`);
  }
  // Ephemeral worktrees: every run starts by removing any leftover bs-*
  // worktrees from prior runs. Bounds disk usage and prevents the "stale
  // worktree" failure mode where a worker accidentally edits last wave's
  // checkout. Fresh worktrees are then created below.
  cleanupStaleBugSolvingWorktrees(opts.repo_root);
  const out: Task[] = [];
  for (let i = 0; i < opts.clusters.length; i++) {
    const c = opts.clusters[i];
    const slides = buildSlideTasks(c.slide_ids, opts);
    const workspace_dir = createWorktree(opts, c.task_id);
    const scratch_dir = resolve(workspace_dir, ".bug-solving-scratch");
    mkdirSync(scratch_dir, { recursive: true });
    // Persist the original bug context (cluster hypothesis + per-slide
    // user comments + annotation paths) so the SxS reviewer can see WHY this
    // task exists without having to dig into the source ratings.json.
    const bugContext = {
      cluster_description: c.cluster_description,
      slides: Object.fromEntries(slides.map(s => [s.slide_id, {
        user_comment: s.user_comment,
        annotation_png: s.annotation_png ?? null,
      }])),
    };
    writeFileSync(
      resolve(scratch_dir, "bug-context.json"),
      JSON.stringify(bugContext, null, 2),
    );

    out.push({
      task_id: c.task_id,
      workspace_dir,
      scratch_dir,
      server_port: opts.port_base + i,
      presentation_title: `bug_solving-${c.task_id}-${Date.now()}`,
      slides,
      cluster_description: c.cluster_description,
      retry_budget: opts.retry_budget,
      baseline_dir: opts.baseline_dir,
    });
  }
  return out;
}
