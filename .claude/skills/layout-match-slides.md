---
name: layout-match-slides
description: Run layout matching eval or match a slide against templates
user_invocable: true
---

Run the layout matching pipeline. Execute the script at `.claude/skills/layout-match-slides.sh`.

This skill either:
1. Runs the full eval across 3 prompt candidates to find the best layout matching strategy
2. Matches a specific slide against a template library

Arguments:
- `eval` — run the full eval pipeline (describe + match + score all candidates)
- `eval --candidate N` — eval one candidate only (1=structural, 2=semantic, 3=tag)
- `eval --step describe|match|score` — run a single step
- `describe <slide.png> --candidate N` — describe a single slide's layout
- `match <slide.png> <template-dir> --candidate N` — match a slide against templates in a directory

Examples:
  /layout-match-slides eval
  /layout-match-slides eval --candidate 2 --model sonnet
  /layout-match-slides eval --step score
