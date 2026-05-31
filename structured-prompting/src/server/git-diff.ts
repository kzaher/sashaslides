/**
 * git-diff.ts — capture a per-node working-tree diff for the monitor UI.
 *
 * The engine calls `captureWorktreeDiff` after a file-mutating node (send /
 * executeShell) finishes. It snapshots the task's git worktree into a THROWAWAY
 * index (the worker's real index + worktree are never touched) and returns:
 *   - cumulative: everything changed since the task's worktree was created
 *     (vs HEAD — workers don't commit, so HEAD is the start point).
 *   - delta:      only what THIS node changed (vs the previous node's snapshot).
 *
 * node_modules is git-tracked in this repo AND replaced by a symlink inside
 * each worktree, so a naive `git diff HEAD` would be dominated by a spurious
 * "directory → symlink" change. We base the throwaway index on HEAD and exclude
 * node_modules from staging + diffing so it stays identical to HEAD and never
 * appears in the output.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IO } from "./io.js";
import type { NodeDiff } from "../api/wire.js";

/** Bodies larger than this are clamped so one giant diff can't bloat the
 *  graph snapshot / wire payload. */
const MAX_DIFF_BYTES = 200_000;

// Pathspecs that keep the always-noisy, symlinked node_modules trees out of
// every snapshot and diff. The "(glob)" magic is REQUIRED: a plain double-star
// pathspec does not cross a slash, and matching the directory name alone does
// not cover the files under it — so a non-glob exclude silently fails to hide a
// worktree's symlinked node_modules. We exclude the top-level dir, the dir at
// any depth, and everything under it at any depth.
const EXCLUDE_NODE_MODULES = [
  ":(exclude)node_modules",
  ":(exclude,glob)**/node_modules",
  ":(exclude,glob)**/node_modules/**",
];

/** Deterministic throwaway-index path for a worktree — one per cwd, reused
 *  across that worktree's nodes (it's overwritten by read-tree each time). */
export function indexFileForCwd(cwd: string): string {
  const h = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(tmpdir(), `sp-gitidx-${h}`);
}

function clamp(s: string): { body: string; truncated: boolean } {
  if (s.length <= MAX_DIFF_BYTES) return { body: s, truncated: false };
  return { body: s.slice(0, MAX_DIFF_BYTES) + "\n… (diff truncated)\n", truncated: true };
}

/**
 * Snapshot `cwd` and return its diff, or null when `cwd` is not a git worktree,
 * git is unavailable, or nothing changed since the task started.
 */
export async function captureWorktreeDiff(
  io: IO,
  cwd: string,
  prevTree: string | null,
  indexFile: string,
  nodeId?: string,
): Promise<NodeDiff | null> {
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const git = (args: string[]) =>
    io.spawnCapture({ command: "git", args: ["-C", cwd, ...args], cwd, env, nodeId });

  // Base the throwaway index on HEAD so node_modules (excluded from staging
  // below) stays identical to HEAD and produces no diff noise.
  const seed = await git(["read-tree", "HEAD"]);
  if (seed.spawnError || seed.exitCode !== 0) return null; // not a git repo, etc.

  const staged = await git(["add", "-A", "--", ...EXCLUDE_NODE_MODULES]);
  if (staged.spawnError || staged.exitCode !== 0) return null;

  const wt = await git(["write-tree"]);
  if (wt.spawnError || wt.exitCode !== 0) return null;
  const tree = wt.stdout.trim();
  if (!tree) return null;

  const base = prevTree ?? "HEAD";
  const [cum, del, stat] = await Promise.all([
    git(["diff", "HEAD", tree, "--", ...EXCLUDE_NODE_MODULES]),
    git(["diff", base, tree, "--", ...EXCLUDE_NODE_MODULES]),
    git(["diff", "--stat", "HEAD", tree, "--", ...EXCLUDE_NODE_MODULES]),
  ]);

  if (!cum.stdout.trim()) return null; // nothing changed since task start — skip

  const cumC = clamp(cum.stdout);
  // First mutating node (no prior snapshot) → delta IS the cumulative diff.
  const delC = del.stdout.trim() ? clamp(del.stdout) : cumC;
  return {
    cumulative: cumC.body,
    delta: delC.body,
    stat: stat.stdout.trim(),
    tree,
    truncated: cumC.truncated || delC.truncated,
  };
}
