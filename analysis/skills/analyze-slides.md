---
description: Analyze a presentation's design system and mental model using one of 3 candidate prompts
command: bash analysis/skills/analyze-slides.sh
args: <extracted-dir> [prompt-candidate: 1|2|3] [output-file]
---

# Analyze Slides

Takes the output of `/extract-slides` (screenshots + structure.json + storyline.md) and runs a design analysis prompt to extract:
- Portable design rules
- Mental model of the creator
- Actionable generation spec

## Prompt Candidates

1. **Decompose & Codify** — Bottom-up: per-slide audit → cross-slide patterns → YAML design system
2. **Persona Extraction** — Top-down: infer creator persona → derive IF-THEN-BECAUSE decision rules
3. **Generative Template Extraction** — Reconstruction-first: minimal spec to regenerate equivalent quality

## Usage
```
/analyze-slides ./extraction_PRESENTATION_ID 1
/analyze-slides ./extraction_PRESENTATION_ID 2 ./my-analysis.md
/analyze-slides ./extraction_PRESENTATION_ID    # runs all 3 candidates
```

## Pipeline
1. Reads structure.json and storyline.md from the extracted directory
2. Reads slide screenshots for visual analysis
3. Applies the selected analysis prompt (or all 3)
4. Outputs analysis result as markdown
