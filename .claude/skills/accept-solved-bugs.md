---
name: accept-solved-bugs
description: Automatically accept GREEN bug_solving worker fixes. Classifies every worker worktree as green/red/unrated from the rating ledger, merges the GREEN ones into an intermediate integration worktree, runs the pixel-perfect regression gate, and promotes to the target branch ONLY if no unrelated slide regressed — otherwise the intermediate worktree is discarded and the target is left untouched. Use after rating bug_solving candidates to land the good fixes hands-free.
user_invocable: true
---

**Scope: html2slides converter fixes.** This is the hands-free acceptor. You rate the bug_solving candidates (green/red); this classifies, merges the green set, gates, and promotes-or-discards. It wraps `/merge-worktrees` (which wraps `merge-gate.ts`).

## The invariant

> Green fixes land in an **intermediate worktree**, and that worktree is promoted to the target branch **only if the gate finds zero regressions on unrelated slides**. Otherwise the intermediate worktree is **discarded** and the target branch is never touched.

## What it does

1. **Classify** every `bs-*` worktree from the candidate ledger (`.bug-solving-history/candidates.json`), using each worktree's recorded `before/pptx/<slide>.pptx` as the ground-truth slide set:
   - **green** (every targeted slide `good`) → **MERGED** · **red** (any slide `bad`) → **skipped** · **neutral** (any slide unrated, none bad) → **IGNORED with a warning** (never merged, never auto-discarded — surfaced so you can rate it).
2. **Intermediate worktree** off `--base`: `.claude/worktrees/accept-<ts>` on branch `sp/accept-<ts>`.
3. **Merge the green worktrees into it** via `merge-worktrees.ts --clean --commit` — applies their diffs (3-way, overlap-safe), typechecks, and runs the gate with `--intended` = union of green slides.
4. **Promote or discard:**
   - Gate **PASS** (only intended slides changed) + `--yes` → fast-forward/merge `sp/accept-<ts>` into `--target`, remove the intermediate worktree.
   - Gate **BLOCK** (an unrelated slide changed) or conflict → **discard** the intermediate worktree (`git worktree remove --force`) + delete its branch. Target untouched.
5. `--rerecord` renders the merged slides on the target afterward for the canonical good/bad re-rate. `--discard-red` cleans up the red/unrated worktrees.

Without `--yes` it's a **dry run**: it still builds + gates the intermediate worktree so you see the real verdict, but promotes/discards nothing (worktree left for inspection).

## Run it

```bash
# dry run — classify + gate, decide nothing:
bash .claude/skills/accept-solved-bugs.sh
# land the green fixes into the current branch if the gate is clean:
bash .claude/skills/accept-solved-bugs.sh --yes
# promote to main, re-record, and clean up rejected worktrees:
bash .claude/skills/accept-solved-bugs.sh --yes --target main --rerecord --discard-red
```

**Flags:** `--base <ref>` (default HEAD) · `--target <ref>` (default current branch) · `--ledger <file>` · `--yes` · `--rerecord` · `--discard-red` · `--out <dir>` · `--ts <stamp>`.
**Exit:** `0` promoted / dry-PASS · `1` BLOCK (discarded) · `2` setup/conflict · `3` nothing green.
**Result:** `/tmp/accept-solved-bugs/{classification.json,accept.json}`.

## Notes / caveats
- The gate is **structural** (byte-identical pptx ⇒ pixel-identical), so it conservatively BLOCKS on *any* unrelated structural change — including pixel-neutral ones (e.g. a global letter-spacing or corner-radius fix that touches many slides). Such a fix will be discarded by the automatic flow; land it deliberately with `/merge-worktrees` after eyeballing the changed set if you accept the global ripple.
- `--target main` merges the integration branch (based on `--base`) into `main`; if `--base` is ahead of `main` it brings that lineage too. Keep `--base` = the point you actually want on `main`.
- Chrome must be on `:9222`. Renders are sequential (`RECORD_CONCURRENCY=1`) for determinism. GREEN detection reads `candidates.json`; the canonical issue ledger is `ratings.json` — see `/merge-green-workers` and [[feedback_merge_protocol]].
