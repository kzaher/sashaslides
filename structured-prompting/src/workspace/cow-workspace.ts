/**
 * cow-workspace.ts — a tiny, GENERIC copy-on-write workspace abstraction for
 * any structured-prompting graph (not just bug_solving).
 *
 * A COW workspace is a zero-copy overlayfs branch of some `base` tree: commands
 * run inside a namespace-local overlay mount (cwd = the merged root), their
 * edits land in an isolated `upper` layer on an ext4 `upperRoot`, and the base
 * tree is never touched. Mounts are per-command and namespace-local (they
 * vanish when the command's `unshare` exits) — the `upper` layer on disk is
 * what persists between commands of the same workspace.
 *
 * This module is a thin typed wrapper around the shell runner `workspace.sh`
 * (which owns the actual userns + overlayfs mechanics). It carries NO
 * project-specific knowledge.
 *
 * REQUIREMENTS (documented in workspace.sh): a Linux user namespace
 * (CAP_SYS_ADMIN) and an ext4 `upperRoot`. Without them, `run` fails at the
 * `unshare`/`mount` step.
 *
 * The env contract is COW_WORKSPACE_BASE / COW_WORKSPACE_ROOT (the legacy
 * OVERLAY_BRANCH_REPO / OVERLAY_BRANCH_ROOT are still honored by the shell for
 * backward compat). The script path is resolved automatically but can be
 * overridden via COW_WORKSPACE_SCRIPT (or the legacy OVERLAY_BRANCH_SCRIPT).
 */

import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the workspace.sh runner. Resolution order:
 *   1. COW_WORKSPACE_SCRIPT / OVERLAY_BRANCH_SCRIPT env override,
 *   2. beside this module (source / tsx runs — src/workspace/workspace.sh),
 *   3. cwd-relative structured-prompting/src/workspace/workspace.sh (for the
 *      esbuild bundle, whose module dir is dist/ and has no sibling .sh; the
 *      canonical launch cwd is the repo root).
 */
export const WORKSPACE_SCRIPT: string = (() => {
  const override = process.env.COW_WORKSPACE_SCRIPT ?? process.env.OVERLAY_BRANCH_SCRIPT;
  if (override) return resolve(override);
  const beside = resolve(HERE, "workspace.sh");
  if (existsSync(beside)) return beside;
  const fromCwd = resolve(process.cwd(), "structured-prompting/src/workspace/workspace.sh");
  if (existsSync(fromCwd)) return fromCwd;
  return beside; // best-effort; run() will surface a clear error if it's missing
})();

/** Default ext4 root under which workspace upper/work/merged dirs live. */
export const DEFAULT_UPPER_ROOT = "/overlays/branches";

const MAX_BUFFER = 256 * 1024 * 1024;

export interface CowWorkspaceOptions {
  /** The lower/base tree the workspace overlays (read-only from the workspace's view). */
  base: string;
  /** ext4 dir under which this workspace's upper/work/merged live. Default `/overlays/branches`. */
  upperRoot?: string;
  /** Explicit workspace id. Default: a deterministic-per-process unique id. */
  id?: string;
}

export interface CowRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code (0 = success). Non-zero does NOT throw — inspect `code`. */
  code: number;
}

export interface CowWorkspace {
  /** The workspace id (also the on-disk dir name under `upperRoot`). */
  readonly id: string;
  /** The base (lower) tree this workspace overlays. */
  readonly base: string;
  /** The ext4 root under which this workspace lives. */
  readonly upperRoot: string;
  /** Run a command inside the workspace (cwd = merged root). Never throws on non-zero exit. */
  run(command: string, args?: string[]): CowRunResult;
  /** Run a bash script inside the workspace (`bash -c <script>`). */
  runShell(bashScript: string): CowRunResult;
  /** List changed files (git-tracked + gitignore-honored if base is a git repo, else all upper files). */
  changed(): string[];
  /** Absolute path to this workspace's upper dir (where changed files land). */
  upperDir(): string;
  /** Read a changed file straight from the upper dir. Returns null if not present in upper. */
  readUpperFile(rel: string): string | null;
  /** Write a file into the upper layer WITHOUT running a command (e.g. for a merge to place files). */
  writeUpperFile(rel: string, content: string): void;
  /** Copy changed-or-listed files from upper onto `base`. */
  promote(files?: string[]): void;
  /** Drop this workspace (remove its upper/work/merged). */
  cleanup(): void;
}

function scriptEnv(base: string, upperRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, COW_WORKSPACE_BASE: base, COW_WORKSPACE_ROOT: upperRoot };
}

let idCounter = 0;
function defaultId(): string {
  idCounter += 1;
  return `cow-${process.pid}-${Date.now()}-${idCounter}`;
}

/**
 * Allocate a COW workspace handle. Does NOT mount anything — mounts are
 * per-command and namespace-local (as in the underlying primitive). The upper
 * dir is created lazily on the first `run`/`ensure`/`writeUpperFile`.
 */
export function createCowWorkspace(opts: CowWorkspaceOptions): CowWorkspace {
  const base = resolve(opts.base);
  const upperRoot = resolve(opts.upperRoot ?? DEFAULT_UPPER_ROOT);
  const id = opts.id ?? defaultId();
  const env = scriptEnv(base, upperRoot);

  function invoke(verb: string, rest: string[]): CowRunResult {
    const r = spawnSync("bash", [WORKSPACE_SCRIPT, verb, id, ...rest], {
      env,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
  }

  const upperDir = (): string => join(upperRoot, id, "upper");

  function ensureDirs(): void {
    // `ensure` self-heals upperRoot ownership + mkdirs upper/work/merged.
    invoke("ensure", []);
  }

  return {
    id,
    base,
    upperRoot,
    run(command: string, args: string[] = []): CowRunResult {
      return invoke("run", [command, ...args]);
    },
    runShell(bashScript: string): CowRunResult {
      return invoke("run", ["bash", "-c", bashScript]);
    },
    changed(): string[] {
      const r = invoke("changed", []);
      return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    },
    upperDir,
    readUpperFile(rel: string): string | null {
      const p = join(upperDir(), rel);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    },
    writeUpperFile(rel: string, content: string): void {
      ensureDirs();
      const p = join(upperDir(), rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    },
    promote(files?: string[]): void {
      const list = files ?? this.changed();
      const up = upperDir();
      for (const rel of list) {
        const src = join(up, rel);
        if (!existsSync(src)) continue;
        const dst = join(base, rel);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst);
      }
    },
    cleanup(): void {
      invoke("rm", []);
    },
  };
}

// ---------- lifecycle cleanup (generalized from bug_solving) -----------------

/**
 * Best-effort, synchronous, never-throws reap of ALL COW workspaces under
 * `upperRoot` (unmount any leaked merged mounts + delete on-disk upper/work).
 * Safe to call from a `process.on('exit')` handler (must be sync — execSync is).
 * When `upperRoot` is omitted, the shell falls back to its env default
 * (COW_WORKSPACE_ROOT / OVERLAY_BRANCH_ROOT / `/overlays/branches`).
 */
export function cleanupAllCowWorkspaces(upperRoot?: string): void {
  try {
    const env = upperRoot
      ? { ...process.env, COW_WORKSPACE_ROOT: resolve(upperRoot) }
      : process.env;
    execSync(`bash "${WORKSPACE_SCRIPT}" cleanup-all`, { stdio: "ignore", timeout: 30_000, env });
  } catch {
    /* best-effort: a cleanup failure must never mask the real exit reason */
  }
}

/**
 * Reap exactly ONE workspace by id (unmount any leaked merged mount + delete its
 * on-disk upper/work/merged). Best-effort, synchronous, never-throws. Wraps
 * `workspace.sh rm <id>`. Used by the cleanup-ON-SUCCESS path (a green cluster's
 * fix has been merged + promoted onto the real tree, so its solve overlay is no
 * longer needed). When `upperRoot` is omitted, the shell falls back to its env
 * default (COW_WORKSPACE_ROOT / OVERLAY_BRANCH_ROOT / `/overlays/branches`).
 */
export function cleanupCowWorkspace(id: string, upperRoot?: string): void {
  try {
    const env = upperRoot
      ? { ...process.env, COW_WORKSPACE_ROOT: resolve(upperRoot) }
      : process.env;
    execSync(`bash "${WORKSPACE_SCRIPT}" rm ${id}`, { stdio: "ignore", timeout: 30_000, env });
  } catch {
    /* best-effort */
  }
}

/**
 * ⚠ PERSISTENCE CONTRACT — this is now a DELIBERATE NO-OP.
 *
 * COW workspaces used to auto-reap on a startup sweep + on every trappable death
 * path (exit/SIGINT/SIGTERM/SIGHUP/uncaughtException). That was REMOVED: overlays
 * must SURVIVE a crash/exit so in-progress solve work isn't destroyed and can be
 * resumed (bug_solving's --continue resume-merge). Nothing reaps overlays on
 * death anymore. Removal is now EXPLICIT + INTENTIONAL only:
 *   - success: `cleanupCowWorkspace(id)` reaps one merged+promoted cluster,
 *   - `--clean`: `cleanupAllCowWorkspaces()` discards ALL prior state,
 *   - manual:   `workspace.sh cleanup-all`.
 *
 * Kept as an exported no-op (rather than deleted) so existing callers/tests that
 * reference it still compile; it intentionally installs NO handlers and runs NO
 * sweep.
 */
export function registerCowCleanup(_upperRoot?: string): void {
  /* intentionally empty — see the PERSISTENCE CONTRACT above. */
  void _upperRoot;
}
