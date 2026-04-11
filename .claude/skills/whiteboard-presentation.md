---
name: whiteboard-presentation
description: Build a whiteboard-style Google Slides presentation from slides.md. Uses real whiteboard photo background, Caveat + Patrick Hand handwriting fonts, blue/red color palette, and hand-drawn icons.
user_invocable: true
---

Generate a whiteboard-styled Google Slides presentation from a markdown slides file. The skill:

1. Parses slides.md into structured slides (title, body, tables, section headers, speaker notes)
2. Generates a .pptx with pptxgenjs using the `presentation-templates/whiteboard/` assets:
   - `whiteboard_background.png` as the slide background
   - `whiteboard-graphs.js` library available for hand-drawn charts/diagrams
   - 14 pre-rendered hand-drawn icons for contextual placement
3. Uploads the .pptx to Google Drive via CDP file input injection
4. Opens it as a Google Slides presentation
5. (Optional) imports the slides into an existing presentation via `File > Import slides`

**Execute:** `.claude/skills/whiteboard-presentation.sh <slides.md> [presentation-url]`

- Argument 1: path to slides.md (default: `presentations/1/slides.md`)
- Argument 2: optional — existing presentation URL to import into. If omitted, creates a new presentation from the .pptx upload.

**Style guide:**
- Titles: Caveat 34pt bold, blue (#1a5276) for content, red (#c0392b) for title/closing slides
- Body: Patrick Hand 16pt, dark slate (#2c3e50); bold lines in red for emphasis
- Tables: Caveat headers, Patrick Hand body, light blue header fill
- Section headers: centered with blue/red divider lines
- Icons: top-right corner of content slides (1.5x1.5"), center-top for title slides
- Safe writing area inside the whiteboard frame: `(0.9, 0.7)` to `(12.43, 5.6)` inches on 13.33x7.5 canvas

**Layer:** `sashaslides/presentation-templates/whiteboard/` contains all assets. Every presentation template is its own skill.
