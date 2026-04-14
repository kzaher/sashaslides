# Layout Matching System

Finds the closest template slide(s) for a given target slide based on **layout structure** (not content). This runs as a parallel optimization step after slide PNGs are extracted.

## How it works

Two-stage pipeline:

1. **Describe** — Each slide PNG is converted to a textual layout description via `claude -p --model haiku`. The description captures spatial structure (element types, positions, visual weight) while ignoring content (text, colors, brand).

2. **Match** — A target slide's description is compared against all template descriptions. The model returns the top-2 most structurally similar templates as JSON.

The best match is added to generation context as layout inspiration for that slide.

## Three candidate prompt pairs

Each candidate uses a different representation strategy for layout descriptions:

| # | Name | Describe format | Match strategy |
|---|------|----------------|----------------|
| 1 | **Structural Grid** | 3×3 grid cells + element inventory + weight/density | Cell-by-cell comparison, layout type priority |
| 2 | **Semantic Narrative** | 2-4 sentence natural-language spatial description + flow | Holistic similarity of visual rhythm |
| 3 | **Tag Vector** | Flat set of 8-15 categorical tags across 5 dimensions | Weighted Jaccard-like set intersection |

### Candidate 1: Structural Grid
Decomposes the slide into a 3×3 spatial grid (TL/TC/TR/ML/MC/MR/BL/BC/BR). Each cell gets a short label of what occupies it. Matching compares cells directly. Good for slides with clear spatial zones.

### Candidate 2: Semantic Narrative
Natural-language description of visual hierarchy and reading flow. Matching is holistic — "does this template read the same way?" Best for capturing layout intent rather than exact positions.

### Candidate 3: Tag Vector
Flat enumeration of tags from fixed vocabularies (layout type, zones, elements, hierarchy, density). Matching uses weighted set overlap. Layout tags count 3×, zones 2×, elements 1.5×. Most mechanical/reproducible.

## Eval system

### Ground truth
`ground-truth.json` contains hand-labelled layout categories for every slide across 5 decks (78 slides total). Categories: `title-only`, `title-subtitle`, `title-bullets`, `title-body`, `two-column`, `image-dominant`, `data-table`, `chart`, `section-divider`, `closing`.

### Test design
For each target slide in deck A, the template pool is **all slides from decks B, C, D, E** (cross-deck matching). A match is correct if the matched template has the same layout category as the target.

### Scoring
- 1st match is correct category → **1.0 points**
- 2nd match is correct category → **0.6 points**
- Neither matches → **0 points**

Average score across all targets = candidate's final score.

### Running the eval

```bash
# Full eval (all 3 candidates, all decks)
/layout-match-slides eval

# One candidate only
/layout-match-slides eval --candidate 2

# Step by step (useful for debugging / iterating)
/layout-match-slides eval --step describe   # PNG → text descriptions
/layout-match-slides eval --step match      # descriptions → top-2 matches
/layout-match-slides eval --step score      # score cached match results

# Use sonnet for higher quality (slower, more expensive)
/layout-match-slides eval --model sonnet

# Limit targets for fast iteration
/layout-match-slides eval --max-targets 3 --candidate 1
```

### Results structure

```
analysis/layout-matching/
  ground-truth.json              # hand-labelled layout categories
  eval-results/
    candidate_1/
      descriptions.json          # cached slide descriptions
      match-results.json         # cached match outputs
      scores.json                # per-slide scores + aggregates
    candidate_2/
      ...
    candidate_3/
      ...
    global_ranking.json          # cross-candidate ranking
```

## Files

| Path | Purpose |
|------|---------|
| `analysis/prompts/layout-matching/shared-describe.md` | Shared constraints for all describe prompts |
| `analysis/prompts/layout-matching/shared-match.md` | Shared constraints for all match prompts |
| `analysis/prompts/layout-matching/candidate-N-*-describe.md` | Per-candidate describe prompt |
| `analysis/prompts/layout-matching/candidate-N-*-match.md` | Per-candidate match prompt |
| `analysis/scripts/layout-matching.ts` | Library: `describeSlide()`, `matchLayout()` |
| `analysis/scripts/run-layout-eval.ts` | Eval orchestrator (describe → match → score) |
| `analysis/layout-matching/ground-truth.json` | Hand-labelled layout categories |
| `.claude/skills/layout-match-slides.md` | Skill definition |
| `.claude/skills/layout-match-slides.sh` | Skill entry point |

## Integration with slide generation

After the eval picks the winning candidate, use it during generation:

```typescript
import { describeSlide, matchLayout } from "./scripts/layout-matching";

// 1. Pre-describe all template slides (cached)
const templates = await describeSlides(templatePngs, winningCandidate);

// 2. For each slide to generate, describe target intent and find best template
const target = await describeSlide(targetPng, winningCandidate);
const match = await matchLayout(target, templates, winningCandidate);

// 3. Use match.matches[0].id to look up the template slide PNG
//    and include it as visual context in the generation prompt
```
