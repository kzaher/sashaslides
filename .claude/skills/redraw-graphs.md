---
name: redraw-graphs
description: Regenerate hand-drawn graphs from graphs.json and sync to the Slides presentation. Run after editing presentations/1/graphs.json.
user_invocable: true
---

Re-render all hand-drawn assets (graphs, tables, underlines) from `presentations/1/graphs.json` and push the updates back into the original Google Slides presentation.

**Workflow for editing a graph:**

1. Open `presentations/1/graphs.json` in VSCode
2. Edit the config for the graph you want to change (e.g., change `data` values, `label`, `opts.title`)
3. Run `/redraw-graphs`
4. Wait ~20 seconds — the script regenerates the PNGs, rebuilds the .pptx, uploads it to Drive, and re-imports into the original presentation

**Identifying which graph is which in Slides:**

Each graph image has an `altText` of the form `graph:showcase_bar`. In Google Slides, right-click the image → **Alt text** → read the description to see the config key, then edit the matching entry in `graphs.json`.

**Execute:** `.claude/skills/redraw-graphs.sh`

No arguments — always operates on `presentations/1/graphs.json` and the original presentation.
