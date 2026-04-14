# Candidate 1: Structural Grid — Describe

Approach: Decompose the slide into a grid-based structural fingerprint.

## Instructions

Divide the slide mentally into a 3×3 grid (top/middle/bottom × left/center/right). For each occupied cell, note the element type and approximate size relative to the cell.

## Output format

```
LAYOUT_TYPE: <one of: title-only, title-subtitle, title-bullets, title-body, two-column, image-dominant, data-table, chart, full-bleed, quote, section-divider, closing, timeline, comparison, icon-grid, mixed>
GRID:
  TL: <element or empty>
  TC: <element or empty>
  TR: <element or empty>
  ML: <element or empty>
  MC: <element or empty>
  MR: <element or empty>
  BL: <element or empty>
  BC: <element or empty>
  BR: <element or empty>
ELEMENTS: <comma-separated list of element types present>
WEIGHT: <top-heavy | center-heavy | bottom-heavy | left-heavy | right-heavy | balanced | diagonal>
DENSITY: <sparse | moderate | dense>
```

Be terse. Each grid cell value should be ≤5 words.
