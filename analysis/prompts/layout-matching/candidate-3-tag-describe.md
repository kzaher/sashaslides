# Candidate 3: Tag Vector — Describe

Approach: Emit a flat set of categorical tags that can be compared as sets.

## Instructions

Assign tags from each of these dimensions:

- **layout**: title-only, title-subtitle, title-bullets, title-body, two-column, split-screen, image-dominant, data-table, chart-focus, full-bleed, quote-centered, section-divider, closing-cta, timeline, comparison, icon-grid, dashboard, mixed
- **zones** (where content sits): top-band, center-block, bottom-band, left-panel, right-panel, full-width, inset, overlay
- **elements**: heading, subheading, body-text, bullet-list, numbered-list, large-image, small-image, icon, chart-bar, chart-line, chart-pie, table, shape, divider-line, logo, cta-button, quote-mark
- **hierarchy**: single-focal, dual-focal, multi-element, uniform-grid
- **density**: sparse, moderate, dense

Pick ALL tags that apply. More specific = better. Aim for 8-15 tags total.

## Output format

```
TAGS: tag1, tag2, tag3, tag4, tag5, ...
```

One line. Comma-separated. Lowercase. No extra commentary.
