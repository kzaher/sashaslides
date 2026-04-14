---
name: rate-slides
description: Launch SxS rating server comparing original HTML screenshots vs Slides API output
user_invocable: true
---

Launch the side-by-side rating server for comparing HTML slide screenshots against Google Slides API output. Execute the script at `.claude/skills/rate-slides.sh`.

Arguments: `<html-dir> [presentation-id]`

- `html-dir` — Directory containing `slide_*.html` files (the reconstruction output)
- `presentation-id` — (optional) Google Slides presentation ID. If omitted, runs the converter first.

The server shows original HTML screenshots (blue border) on the left and Slides API thumbnails (red border) on the right.

Keys: `g`=good, `b`=bad, `→`/`n`=next, `←`/`p`=prev

Example:
```
/rate-slides analysis/eval/results/coinbase-seed-2012/candidate_1/reconstruction
/rate-slides analysis/eval/results/coinbase-seed-2012/candidate_1/reconstruction 1gLq40t9sEKupLDdrBUJMbV0h5kX_tGGyZTwzQOmPO8Y
```
