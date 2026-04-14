# Candidate 4: Hybrid Anchor — Match

Approach: Two-phase matching — category filter first, then semantic ranking.

## Instructions

You have a TARGET layout description and TEMPLATE layout descriptions, all in Hybrid Anchor format.

Match in two phases:

### Phase 1: Category filter
- Templates with the SAME CATEGORY as the target get priority
- If fewer than 2 same-category templates exist, also consider templates with ADJACENT categories:
  - title-bullets ↔ title-body (both are "title + content")
  - chart ↔ data-table (both are "data visualization")
  - section-divider ↔ title-only (both are "minimal text")
  - closing ↔ title-only (both can be "minimal")
  - image-dominant ↔ two-column (both can have large visual element)

### Phase 2: Semantic ranking
- Among category-matched templates, rank by:
  1. DISTINCTIVE element similarity (most important — does the distinctive element match?)
  2. SPATIAL arrangement similarity
  3. ELEMENTS overlap

Select the 2 best-matching templates and return the JSON result.

IMPORTANT: Never select a template from a completely unrelated category (e.g., don't match a chart to a title-only) unless no better option exists.
