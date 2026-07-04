---
name: accept-solved-bugs
description: Accept GREEN bug_solving worker fixes ONE CLUSTER AT A TIME, with a HUMAN verifying that no UNRELATED slide regressed before each cluster is kept. Classifies every worker worktree green/red/unrated from the rating ledger, then loops: merge one green cluster onto the accepted state, render the whole deck, and diff. A cluster whose only changes are its OWN (already-approved) slides auto-accepts. A cluster that RIPPLED to other slides is presented as a regression candidate and — in a terminal — boots a rating UI filtered to just the rippled slides and PAUSES for you to rate; non-interactively it is rejected by default. On the next run it keeps a rippled cluster if every rippled slide is good, or reverts it. Resumable — you run it repeatedly, verifying between runs.
user_invocable: true
---

**Scope: html2slides converter fixes.** This is the per-cluster, human-verified acceptor. It replaces the old "merge all green at once behind an automated pixel gate" flow. Now each green fix is landed individually and **only kept if it caused no regression on slides it did NOT target**.

## The key insight — only the RIPPLE needs verifying

A cluster's **own targeted slides were ALREADY rated good by you** — that is precisely why the cluster is green in the candidate ledger. So on accept, the only slides that need FRESH verification are the **ripple** = slides that changed but are **not** in the cluster's intended set. The ripple slides ARE the potential regressions. Therefore:

- **No ripple** (only its own already-approved slides changed) → **auto-accepted**, no human input needed. The loop continues to the next pending cluster in the same run.
- **Ripple present** (it changed OTHER slides) → the rippled slides are **presented as regression candidates** and:
  - **in a terminal (TTY)** → a rating UI is booted filtered to just the rippled slides; the cluster is marked `in_review` and the run **pauses** for you to rate them. Re-run to finalize.
  - **non-interactively (no TTY)** → the cluster is **rejected by default** (reverted) — it needs human verification. Re-run in a terminal to review it. (`--interactive`/`--non-interactive` override the auto-detected mode.)

## The invariant

> A cluster is kept only if it either (a) changed **no** slides outside its own already-approved set, or (b) the user confirms **no regression on every rippled slide**. Otherwise the cluster is **reverted** and the accepted state is left untouched. You run the skill **repeatedly**, verifying between runs.

The "accepted state" is a dedicated **staging worktree** (`.claude/worktrees/accept-<ts>`) that starts at `--base` and accumulates one commit per accepted cluster. `--target` is fast-forwarded to it after each accept. The running scaffolding/monitor and the main checkout are never touched — this uses its own worktree and its own rating-UI ports.

## State machine (`.bug-solving-history/accept-state.json`)

Each green cluster is one of:
- **pending** — classified green, not yet reviewed.
- **in_review** — merged onto the accepted state + rendered; it RIPPLED to slides it did not target; a rating UI is up on its port **filtered to just the ripple**; awaiting your good/bad on **every rippled** slide. Carries `{ changed, intended, ripple, ratingDir, port, preMergeCommit }`. (No-ripple clusters never enter this state — they auto-accept.)
- **accepted** — no ripple (auto-accepted), OR you rated every rippled slide good → committed onto the staging branch and fast-forwarded into `--target`.
- **rejected** — you rated ≥1 rippled slide bad (or left one unrated), OR it rippled and there was no TTY to verify → the merge was reverted to `preMergeCommit`; accepted state unchanged.

## What one invocation does

It drives the loop until a cluster needs your verification (then **exits**, pausing) or none remain:

1. **Finalize any `in_review` cluster** from your ratings. It reads that cluster's `ratings.json` for its **`ripple`** slides (the only ones under review — its intended slides were already approved):
   - **every rippled slide good** → COMMIT the staged merge, mark **accepted**, fast-forward `--target`.
   - **any rippled slide bad (or still unrated)** → `git restore` the converter back to `preMergeCommit` (drop the merge), mark **rejected**, and report which slide you flagged.
2. **Walk the `pending` clusters.** For each, START its review:
   a. Compose THAT ONE cluster's diff onto the accepted state via git's real **3-way merge** — the cluster diff (generated against the clean `--base`) is materialised as a commit on the base in a throwaway temp worktree (where a base-relative patch always applies), then **cherry-picked** onto the staging branch. This composes with prior accepted clusters that touched the SAME file (which `git apply --3way` could not — it failed "does not match index"). A genuine line-level conflict aborts cleanly and names the file.
   b. Render the WHOLE deck sequentially (`RECORD_CONCURRENCY=1`) at the accepted baseline and post-merge, structural-diff → `changed`; `intended = changed ∩ cluster.slides`, `ripple = changed \ intended`.
   c. **No ripple** → auto-accept (commit + fast-forward) and **continue to the next pending cluster** in the same run.
   d. **Ripple present** → present the rippled slides as regression candidates, then:
      - **interactive (TTY)** → render the RIPPLE slides to Google Slides (`record-rendering --mode full`), boot a rating UI **filtered to the ripple** on a free port, mark **in_review**, print the URL + rippled slides, and EXIT — you verify, then re-run.
      - **non-interactive** → **reject by default** (revert to `preMergeCommit`), mark **rejected**, and continue to the next pending cluster.
3. **Nothing pending/in_review** → print the final accepted/rejected tally and the resulting `--target` commits.

The **human is the gate** — there is no `--yes`. Classification is unchanged: **green** (every targeted slide `good`) is accepted one at a time · **red** (any `bad`) is skipped · **neutral** (any unrated) is IGNORED with a warning (rate it, then `--reset` and re-run).

## Run it (the loop)

```bash
# Step 1: classify + walk green clusters. No-ripple clusters auto-accept; the first
#   RIPPLED cluster renders + boots a rating UI (filtered to the ripple), then pauses.
bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh
#   → open the printed http://localhost:<port>, rate EVERY RIPPLED slide good/bad.

# Step 2..N: finalize the reviewed cluster (keep-if-clean / revert-if-any-bad-ripple), then
#   walk the remaining clusters (auto-accepting no-ripple ones) until the next needs review.
bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh
#   → verify the next rippled cluster's UI, re-run … until it reports ACCEPT COMPLETE.

# land accepted clusters onto main instead of the current branch:
bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --target main

# start over (drop the staging worktree + state, re-classify):
bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --reset

# accept ONLY one cluster this run (here: just slide_04):
bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --only pseudo-glyph-center

# exclude specific clusters this run:
bash .agent/skills/accept-solved-bugs/accept-solved-bugs.sh --skip device-frame-ring,metric-pill-center-wrap
```

**Flags:** `--target <ref>` (default current branch) · `--base <ref>` (default HEAD) · `--ledger <file>` · `--port <n>` (rating-UI base port, default 4731) · `--history-dir <dir>` · `--fixtures <dir>` · `--worktrees <dir>` · `--state <file>` · `--only <task[,task...]>` (restrict eligibility to exactly these cluster task_ids — others are ignored entirely, not even classified as pending; e.g. `--only pseudo-glyph-center` accepts just slide_04) · `--skip <task[,task...]>` (exclude these cluster task_ids; both match the cluster `task` slug = the `bs-<task>-<ts>` worktree name minus prefix/timestamp) · `--reset` · `--no-commit` (report-only: classify + show the next step, never merge/keep/revert) · `--interactive` / `--non-interactive` (force the ripple-verification mode; default auto-detected from TTY — no TTY ⇒ rippled clusters rejected by default). Real merge+render+classify is the DEFAULT — your good/bad rating is the gate on rippled clusters.
**Exit:** `0` a step completed (started / finalized / all done) · `2` setup/patch-conflict · `3` nothing green.

## Notes / caveats
- **Chrome must be on `:9222`** — every step renders the deck. Renders are sequential (`RECORD_CONCURRENCY=1`) for byte-determinism.
- **Only the ripple is verified.** A cluster's own targeted slides are already approved (green ledger), so they are NOT re-reviewed — only the rippled (unrelated, potentially-regressed) slides are. A cluster with no ripple auto-accepts; a rippled cluster is shown to you filtered to exactly the rippled slides — you decide, per slide, if it's a regression. A rippled slide left unrated is treated as NOT-good, so an in_review cluster is only kept when you've explicitly rated every rippled slide good. Non-interactively (no TTY) a rippled cluster is rejected by default and must be reviewed in a terminal.
- **Reverting is clean.** A rejected cluster's converter files are restored to the pre-merge commit; the staging branch (accepted state) never gains a bad commit, so later clusters build on a known-good base.
- GREEN detection reads `candidates.json`; the canonical issue ledger is `ratings.json` — see `/merge-green-workers` and [[feedback_merge_protocol]]. Rating-UI wiring reuses `rating-server.ts --filter-slides … --history-dir .bug-solving-history` (Pen/Rect, magnifier, zoom-crops), the same UI the merge-anomaly review uses.
- **Result/state:** `.bug-solving-history/accept-state.json` (the loop state) · per-cluster reviews under `.bug-solving-history/accept-reviews/<task>/`.
