# Shared constraints for layout matching

You are matching a TARGET slide layout description against a set of TEMPLATE slide layout descriptions. Your job is to find the 2 most structurally similar templates.

## Matching criteria (in priority order)

1. **Layout type** — same category (e.g., title+bullets vs title+bullets) is the strongest signal
2. **Spatial zone arrangement** — similar content placement (top-left heading + right image vs top-left heading + right image)
3. **Element inventory** — similar mix of elements (both have heading + 3 bullet points + icon)
4. **Visual weight distribution** — similar balance/asymmetry
5. **Whitespace pattern** — similar density

## Output format

Return ONLY a JSON object with exactly this structure:
```json
{
  "matches": [
    {"id": "<template_id>", "reason": "<1 sentence>"},
    {"id": "<template_id>", "reason": "<1 sentence>"}
  ]
}
```

The first match is the BEST match. The second is the runner-up. Do not return more or fewer than 2 matches.
