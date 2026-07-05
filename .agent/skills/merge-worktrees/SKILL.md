---
name: merge-worktrees
description: Programmatically merge named bug_solving worker worktrees. You specify the worktrees; it extracts each one's converter diff, applies them all (3-way, resolving overlaps when two workers edit the same file), derives the intended slide set from each worktree's recorded before/pptx, typechecks, and runs the pixel-perfect merge gate (BLOCKS if any slide outside the intended set changed). Use to merge specific solved worktrees by hand.
user_invocable: true
---

**Scope: html2slides converter worktree merges.** This is the programmatic version of the manual "apply the hunks" step in `/merge-green-workers`. It does the *applying*; the gate does the *checking*.

## What it does (automatic once you name the worktrees)

1. **Extract** each worktree's converter diff — `git -C <wt> diff <base> -- 'renderer/html2slides/*.ts'` (the uncommitted worker edits; docs and out-of-scope files are excluded by the pathspec).
2. **Apply** them to the working tree with `git apply --3way --index`, so two workers that edit the same file at different points combine cleanly; a real line-level conflict aborts loudly (markers left for manual resolve).
3. **Derive intended slides** = the union of each worktree's `.bug-solving-scratch/before/pptx/<slide>.pptx` filenames (ground truth of what that worker targeted — never trust the folder name alone).
4. **Typecheck** the merged tree (`tsc --noEmit`).
5. **Gate** — runs `merge-gate.ts --intended <union>`: renders the whole deck HEAD-vs-merged sequentially and BLOCKS if any *unexpected* slide changed.
6. **--commit** lands it (only if gate PASS + tsc clean); **--rate** boots a filtered rating UI on the changed slides when BLOCKED.

## Run it

```bash
# Chrome must be on :9222 for the gate.
bash .agent/skills/merge-worktrees/merge-worktrees.sh device-frame-ring metric-pill-center-wrap colored-native-bullets
# land it if clean:
bash .agent/skills/merge-worktrees/merge-worktrees.sh device-frame-ring metric-pill-center-wrap colored-native-bullets --commit
# reproduce from a clean base (discard prior uncommitted converter edits first):
bash .agent/skills/merge-worktrees/merge-worktrees.sh <names...> --clean
```

Worktree specs are a path or a task name (globs `.claude/worktrees/bs-<name>-*`, newest wins).

**Flags:** `--base <ref>` (default HEAD) · `--clean` (reset converter to base first) · `--commit` · `--rate` · `--port N` (default 4731) · `--no-gate` (apply + tsc only) · `--out <dir>`.

**Exit:** `0` PASS (safe / committed) · `1` BLOCK (unexpected slide changed) · `2` conflict / tsc error / setup.
**Result JSON:** `/tmp/merge-worktrees/merge-worktrees.json` → `{ base, plan[], intended[], conflicts[], tscErrors, gate }`.

Note: the gate trusts sequential rendering (`RECORD_CONCURRENCY=1`). Related: the bug_solving pipeline (`/solve-bug-clusters`) now accepts solved clusters automatically via its POST-RUN rating-gated accept phase (main-scaffolding.ts → accept-orchestration.ts → merge-phase.ts); each solved thread's fix is composed onto the accepted state only after the human rates every slide good in its per-thread rating UI. `/merge-green-workers` is the older gate-only skill.
