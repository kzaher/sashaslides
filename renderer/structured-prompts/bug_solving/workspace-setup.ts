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
import { readFileSync, existsSync, mkdirSync } from "fs";
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
}

const DEFAULTS: Omit<BuildOptions, "clusters"> = {
  ratings_json: "/tmp/sxs-complex/ratings.json",
  fixtures_dir: "renderer/html2slides/e2e/fixtures",
  sxs_dir: "/tmp/sxs-complex",
  port_base: 4720,
  retry_budget: 3,
  repo_root: process.cwd(),
};

function readRatings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
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
  return dir;
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
    out.push({
      task_id: c.task_id,
      workspace_dir,
      scratch_dir,
      server_port: opts.port_base + i,
      presentation_title: `bug_solving-${c.task_id}-${Date.now()}`,
      slides,
      cluster_description: c.cluster_description,
      retry_budget: opts.retry_budget,
    });
  }
  return out;
}
