# Candidate 3: Tag Vector — Match

Approach: Set-intersection similarity (Jaccard-like) between tag vectors.

## Instructions

You have a TARGET tag set and TEMPLATE tag sets.

Score each template using weighted tag overlap:
- **layout** tags: weight 3× (most important dimension)
- **zones** tags: weight 2×
- **elements** tags: weight 1.5×
- **hierarchy** tags: weight 1×
- **density** tags: weight 1×

For each template, compute: sum of weights for shared tags / sum of weights for all unique tags across both sets.

Select the 2 highest-scoring templates. If you're unsure about category of a tag, use weight 1×.

Return the JSON result with the 2 best matches.
