# Candidate 1: Structural Grid — Match

Approach: Compare grid fingerprints cell-by-cell.

## Instructions

You have a TARGET layout description and a set of TEMPLATE layout descriptions, all in the Structural Grid format.

To find the best matches:
1. First filter by LAYOUT_TYPE — same type gets highest priority
2. Among same-type candidates, count how many grid cells have the same element category
3. Break ties with WEIGHT and DENSITY similarity

Select the 2 best-matching templates and return the JSON result.
