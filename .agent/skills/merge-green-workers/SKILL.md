---
name: merge-green-workers
description: Merge rated-GREEN bug_solving converter fixes into main behind a pixel-perfect gate. Renders the whole deck at HEAD vs the working-tree merge (deterministically) and BLOCKS the commit if any slide OUTSIDE the intended green set changed. Use after rating bug_solving clusters and before committing converter fixes to main.
user_invocable: true
---

**Scope: html2slides converter merges only.** Use this when you've solved bug_solving clusters (see `/solve-bug-clusters`), the user has rated the resulting renders Good/Bad, and you're about to merge the GREEN clusters' fixes into `main`. It enforces the merging protocol so a fix can never silently regress a slide it wasn't supposed to touch.

The enforcement script is `renderer/structured-prompts/bug_solving/scripts/merge-gate.ts`; run it via `.agent/skills/merge-green-workers/merge-green-workers.sh`.

## The merging protocol (do every step)

1. **Only merge GREEN workers.** A cluster is green ONLY if EVERY one of its slides is rated `good` in the latest ledger (`.bug-solving-history/ratings.json`). One `bad` slide ⇒ the whole cluster goes back to the next round, not main.

2. **Merge ONLY the relevant fix hunks — not the whole worktree diff.** Workers over-reach: a "chip-centering" worker once also bundled in the device PNG-mask code. Read the worktree's `git diff HEAD -- renderer/html2slides` and apply only the hunks that belong to the rated-green fix. Exclude out-of-scope/leaked code and the `bug-solving-analysis/*.md` docs. When two green workers edit the same file, apply each file-scoped sub-patch and verify the combined hunk count == sum of the intended hunks.

3. **Run the pixel-perfect gate BEFORE committing.** With the merge applied to the working tree (uncommitted), run this skill with the intended slide set = the union of the green clusters' slide ids. The gate:
   - renders the WHOLE fixture deck at HEAD (baseline) and with your merge (post), **sequentially** (`RECORD_CONCURRENCY=1` — concurrent renders race on web-font load and produce phantom diffs);
   - structural-diffs every slide (a byte-identical pptx renders pixel-identically in Slides, so an empty diff IS a pixel-perfect pass);
   - **BLOCKS (exit 1) if any slide outside `--intended` changed.**

4. **If the gate BLOCKS:** the changed-but-unintended slides are anomalies. Render ONLY the changed slides to Google Slides and review them in a rating UI **filtered to the changed set** — never the whole deck (`rating-server.ts <dir> --filter-slides <changed-csv>`). Do not commit until the anomaly is understood/eliminated.

5. **If the gate PASSES** (every changed slide ∈ intended, no anomalies): commit the merge to main. Mention in the commit body which slides changed and that the gate was clean.

6. **ALWAYS re-rate on master after committing (the post-merge canonical step — do NOT skip).** The worktree ratings were `--candidate` (they did NOT update the canonical issue), and the gate is structural — neither confirms the *merged* result looks right on master. So: render ONLY the just-merged slides on current master (`record-rendering --mode full --slides <intended-csv>`) and boot a **CANONICAL** rating UI (no `--candidate`, with `--history-dir`) filtered to those slides. The user confirms each: a **good** rating flips the canonical ledger bad→good (so the next round won't re-attempt an already-fixed slide); anything still off stays bad and goes back to a round. Skipping this leaves the canonical ledger stale (still "bad" with the original issue) even though master is fixed.

6. **Determinism is the prerequisite.** The gate trusts sequential rendering. If you ever doubt it, render the baseline twice and confirm `diff-pptx-pairs` reports 0 changes (HEAD-vs-HEAD). Never gate with concurrent renders.

## Run it

```bash
# intended = union of the green clusters' slide ids (the only slides allowed to change)
bash .agent/skills/merge-green-workers/merge-green-workers.sh slide_19,slide_21,slide_27,slide_30
# add --rate to render the changed slides to Slides + boot a FILTERED rating UI on block:
bash .agent/skills/merge-green-workers/merge-green-workers.sh slide_19,slide_21,slide_27,slide_30 --rate
```

Exit code: `0` PASS (safe to commit) · `1` BLOCK (unexpected slide changed) · `2` setup error.
Result JSON: `/tmp/merge-gate/merge-gate.json` → `{ pass, intended, changed, unexpected, missingIntended }`.
`missingIntended` warns that an intended slide did NOT change (the fix may be a no-op).

## Rule to honor everywhere

**A "did anything regress" rating UI shows ONLY the slides whose render changed — never the full deck.** Surfacing 30 byte-identical slides to a human is noise. Filter to `changed` (from the gate's JSON) with `--filter-slides`.

## Prerequisites

- Chrome on `:9222` (the converter renders through CDP).
- The working tree holds ONLY the merge under test (the gate stashes the whole tree to render the HEAD baseline; unrelated uncommitted edits would be misattributed).
