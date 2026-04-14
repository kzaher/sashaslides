---
description: Extract screenshots + structured content from a Google Slides presentation
command: bash analysis/skills/extract-slides.sh
args: presentation-url-or-id [output-dir]
---

# Extract Slides

Screenshots every slide and extracts structured content (text, shapes, positions, styles, speaker notes) from a Google Slides presentation via Chrome DevTools Protocol.

## Outputs
- `slide_NN.png` — high-DPI screenshot of each slide
- `structure.json` — full structured content with element positions and styles
- `storyline.md` — human-readable storyline (titles + body text + notes in order)

## Usage
```
/extract-slides https://docs.google.com/presentation/d/PRESENTATION_ID/edit
/extract-slides PRESENTATION_ID ./my-output-dir
```
