---
name: solve-bug-clusters
description: Run the html2slides bug_solving structured-prompt pipeline against the current clusters.ts. Fixes bad-rated slides from the html2slides complex e2e set. WARNS / refuses if clusters.ts is older than ratings.json (i.e. stale relative to the latest rating pass).
user_invocable: true
---

**Scope: html2slides converter bugs only.** This skill targets the HTML→pptx→Google-Slides converter at `renderer/html2slides/convert-pptx.ts` (and `extract-dom.ts`). It is NOT a general bug-solving skill — it consumes the SxS rating output of `regen-complex.sh` (`/tmp/sxs-complex/ratings.json`), hands the bad-rated slides to Opus workers, and expects them to fix the converter so the slides re-render correctly.

Runs the bug_solving structured-prompt pipeline (`renderer/structured-prompts/bug_solving/main-scaffolding.ts`) against the clusters declared in `renderer/structured-prompts/bug_solving/clusters.ts`. The script is `.agent/skills/solve-bug-clusters/solve-bug-clusters.sh`.

## Workflow this fits into (html2slides only)

```
renderer/html2slides/regen-complex.sh        ← convert e2e/fixtures → pptx → Slides → diff vs goldens-complex
  ↓
SxS rating UI on /tmp/sxs-complex            ← user rates Good / Bad with per-slide comments
  ↓
hand-edit renderer/structured-prompts/bug_solving/clusters.ts   ← THIS STEP IS NOT AUTOMATED
  ↓
/solve-bug-clusters                          ← this skill — workers fix html2slides converter
  ↓
re-run regen-complex.sh                       ← verify the fixes against fresh thumbs
```

## CRITICAL: regenerate clusters.ts FIRST

`renderer/structured-prompts/bug_solving/clusters.ts` is the per-wave input — a hand-curated TypeScript file declaring which bad-rated html2slides fixtures go into which worker cluster, with the verbatim wave-N retry context that prevents workers from re-trying dead-ends in `renderer/html2slides/extract-dom.ts` / `convert-pptx.ts`. **It does NOT auto-update from `ratings.json`.**

Before invoking this skill:

1. Read `/tmp/sxs-complex/ratings.json` (or `BUG_SOLVING_RATINGS_JSON` override) — it carries the user's Good / Bad verdicts plus comments per slide of the html2slides complex fixture set.
2. Identify slides that are still failing (status === "bad", or new bad ratings since the last wave). All slide IDs map to `renderer/html2slides/e2e/fixtures/slide_NN.html`.
3. Hand-edit `clusters.ts`:
   - Bump the wave number in the file's header doc.
   - Replace `CLUSTERS` with the new cluster list. Each entry carries:
     - `slide_ids`: which slides go together (clusters are typically multi-slide when the bugs touch shared territory in `extract-dom.ts` / `convert-pptx.ts`).
     - `goal`: one-paragraph what to fix in the html2slides converter, including the user's comment from `ratings.json`.
     - The verbatim wave-N retry trail (last 1-2 waves) — workers MUST see what already failed and why, or they re-run the dead-ends.
4. Save. Now this skill's mtime check will pass.

If you skip the regen, `solve-bug-clusters.sh` refuses with exit code 3 unless `BUG_SOLVING_FORCE_STALE_CLUSTERS=1` is set (escape hatch for the rare case you intentionally want to re-run the same wave).

## Memory-feedback to honor

- `feedback_opus_always.md` — every send / retry in bug_solving must use Claude Opus. Do NOT downgrade to sonnet/haiku to save tokens.
- `feedback_image_analysis_precision.md` — when reviewing a worker's annotations, distinguish whether the *text* inside a box is wrong vs. the *box itself*.

## Environment

- `BUG_SOLVING_RATINGS_JSON` — override the ratings file (default `/tmp/sxs-complex/ratings.json`).
- `BUG_SOLVING_BASELINE_DIR` — reuse a pre-recorded baseline pptx dir instead of regenerating one.
- `BUG_SOLVING_FORCE_STALE_CLUSTERS=1` — bypass the staleness check.

## Outputs

- Monitor UI on http://127.0.0.1:4711 (graph of every cluster's worker chain).
- Per-task SxS server URLs printed when step 8 of `main.ts` completes.
- Graph snapshots written to `SP_GRAPH_PATH` if set (see `view-graph.ts` for read-only restore).
