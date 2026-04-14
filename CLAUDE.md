@/claude/prompts/shared_instructions.md

Important:

## General principles (apply broadly)

* **Prefer programmatic access over UI automation.** Always ask first: is there an API, a file-based approach, or a native feature that avoids clicking through a UI? Reach for UI automation only when no other path exists.
* **Fail fast, not slow.** CDP operations and DOM interactions are near-instant. If a step doesn't respond in 1–2 seconds, it's stuck — poll with a short budget (e.g., 100 ms intervals, 2 s max) and fail to diagnose rather than blindly waiting 30–45 s. Timeouts should be seconds, not tens of seconds.
* **Poll for observable state, don't sleep.** Instead of `await sleep(5000)`, poll the DOM for the condition that proves the action succeeded (`dialog closed`, `slide count increased`, etc.). Break out as soon as the condition is met.
* **Verify after every destructive action.** Before deleting slides / files / records, count what's there. After deleting, count again and confirm only the intended items were removed. Destructive loops without per-iteration verification will over-delete when an assumption is off by one.
* **Delegate code-writing to smaller models (haiku) when orchestrating.** The main model only needs to read final results (screenshots, counts, error output) and make the next high-level decision. Write a self-contained prompt with the exact task, running instructions, bash timeout, and required report format.
* **Brief sub-agents with hard runtime budgets.** Every delegated script gets a "total runtime must be under N seconds" constraint and a corresponding `Bash` timeout. Runaway scripts are a diagnosis, not a failure mode to tolerate.
* **Sub-agents need exact tab/target identifiers.** When delegating CDP work, give the tab URL substring (e.g., `1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY`, not just `1xegFC0RQiZd`) so the agent can't match a broken/duplicate tab. Sub-agents will happily create new tabs with truncated URLs that 404.
* **Screenshots beat text reports for UI state verification.** When a sub-agent says "the import succeeded," look at the screenshot yourself. Don't trust its interpretation — it may be reading DOM counts from a virtualized list or a hidden overlay.

## Google Slides / Chrome DevTools Protocol specifics

* **REST API (`slides.googleapis.com`) is blocked from this devcontainer** — neither SAPISIDHASH, cookie auth, nor `gapi.client` work (returns 400/401). Do not waste time on it.
* **Programmatic path that works:** generate `.pptx` with `pptxgenjs`, upload via Drive web UI using `DOM.setFileInputFiles` to inject the file into Drive's hidden file input, then open `https://docs.google.com/presentation/d/{fileId}/edit`. See `presentations/scripts/generate-pptx.ts` + `upload-pptx-to-slides.ts` + `find-and-open-pptx.ts`.
* **Migrating slides between presentations:** use Slides' native **`File > Import slides`** feature. This is the only clean way to move slides with styles/backgrounds/images between Google Slides files from inside the devcontainer.
* **Google Slides React widgets ignore `Input.dispatchMouseEvent`** for many custom buttons (e.g., "Select all slides", "Import slides" in the Import dialog). Use **`Runtime.evaluate` to dispatch full pointer-event sequences** via JavaScript instead:
  ```js
  const opts = { bubbles: true, cancelable: true, clientX, clientY, pointerType: 'mouse', button: 0, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  el.click();
  ```
* **Text entry in Slides placeholders:** Enter enters the placeholder for editing, Tab cycles to the next placeholder, Escape exits. Double-click via mouse events is unreliable. `Input.insertText` works for the actual text; **never** type a font name into the toolbar font picker — it ends up as text content in the slide.
* **Filmstrip uses virtualization.** `document.querySelectorAll('.punch-filmstrip-thumbnail').length` returns only rendered thumbnails. To get a true count, first set `.punch-filmstrip-scroll.scrollTop = 99999` to force-render all of them.
* **`Ctrl+A` in the main edit area selects objects on the current slide, not all slides.** To select all slides, click in the filmstrip first. `Ctrl+A` inside a Picker dialog selects page text, not dialog items — use per-thumbnail `.click()` or a native "Select all" button via PointerEvent.
* **Filename-like menu items include keyboard shortcut hints.** `File > Import slides` appears in the DOM as textContent `"Import slides(Z)"` — match with `startsWith('Import slides')`, not `=== 'Import slides'`.

## Whiteboard / visual style

* **Google Fonts "Caveat" and "Patrick Hand"** render natively in Google Slides (no font upload needed). Good for handwriting / whiteboard looks.
* **Hand-drawn icons via rough.js:** render SVG in Chrome (via a local HTML file opened with CDP), then screenshot each icon with `Page.captureScreenshot` using a clip region. `rough.svg(svg)` methods return drawables that must be **manually `appendChild`'d** to the SVG — wrap them in an auto-append shim.
* **Use a real whiteboard photo as background**, not CSS-synthesized shapes. `pptxgenjs` supports `{ image: { path, x, y, w, h } }` in slide masters. Convert webp→png with ImageMagick (`convert in.webp -resize 1920x1080\! out.png`) since pptxgenjs prefers PNG.
* **Hand-drawn lines and tables**: plain `slide.addShape("line")` and `slide.addTable()` look too clean. Pre-render them as PNGs via rough.js (one underline per slide, one table per slide with a table) and embed with `slide.addImage()`. See `presentations/scripts/render-assets.ts`.
* **Safe writing area inside a whiteboard frame**: use `SAFE_X=0.9, SAFE_Y=0.7, SAFE_W=13.33-2*0.9, SAFE_H=7.5-0.7-1.2` (bottom margin leaves room for the marker tray). All content should fit inside this to stay visible on the whiteboard surface.
* **Graph rendering library**: `presentation-templates/whiteboard/whiteboard-graphs.js` exposes `WhiteboardGraphs` with `barChart`, `lineChart`, `pieChart`, `flowDiagram`, `pillars`, `hubSpoke`, `roadmap`, `axes` — all via rough.js. Include with `<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>` then the lib.

## Presentation templates as skills

* **Every presentation template is its own skill.** `presentation-templates/<name>/` holds all template assets (backgrounds, graph libraries, icons). `.claude/skills/<name>-presentation.md` + `.sh` is the user-invocable entry point. The `.sh` runs the pipeline: render assets → generate .pptx → upload to Drive → (optional) import into existing presentation.
* Template skill naming: `<template-name>-presentation` (e.g., `whiteboard-presentation`).
* **Edit-and-redraw workflow for graphs:** graph configs live in a JSON file (e.g., `presentations/1/graphs.json`); each graph image embeds `altText: "graph:<name>"` so users can identify them via right-click → Alt text in Slides. A `/redraw-graphs` skill re-renders assets → regenerates .pptx → uploads → re-imports into the target presentation. Round-trip: ~20s.

## Whiteboard companion-slide architecture (source/render pairs)

* **The whiteboard generator emits paired slides, not single slides.** For every slide whose first speaker-note line is `whiteboard=1`, `generate-pptx.ts` writes:
  1. a **source slide** (filmstrip pos N, `slide.hidden = true`) holding native editable primitives — real `addText`, `addTable`, `addChart('bar'|'line'|'pie')`, and `addShape` compositions for diagram showcases (flow / pillars / hub-spoke / roadmap), plus `addShape('line')` for title underlines and section dividers.
  2. a **render slide** (filmstrip pos N+1, visible) holding the same text plus rough.js PNG overlays for tables / charts / diagrams / underlines at the same bounds.
  This is what audiences see; the source is hidden but kept for editing.
* Slides without `whiteboard=1` get a single plain slide on a default theme — no whiteboard background, no overlays.
* **Pair linkage** lives in speaker notes. Both slides in a pair end with the sentinel line `|This is autogenerated, please don't touch={...json...}` containing `{role:"source"|"render", pairId, kind, overlays?}`. `pairId` is a deterministic hash of slide index + title so re-runs of the generator preserve pair identity. Future restyle tooling looks up the partner by `pairId`.
* **`slide.hidden = true` on pptxgenjs 4.0.1** writes `show="0"` on the slide XML (verified at `node_modules/pptxgenjs/dist/pptxgen.es.js:6496`). Google Slides imports that as native **Skip slide** — the slide stays in the filmstrip but is omitted from presentation mode.
* **Per-slide unique underlines.** The previous "one shared `underline.png` reused on every slide" approach (a) made every title look identical, and (b) at the small display height (~0.3″) the rough.js wobble at `roughness:4, bowing:3` looks like a clipped scribble. Replacement: render at flatter aspect (`2400x48`) with `roughness:1.8, bowing:1.2, strokeWidth:8/7`, and emit **6 blue variants** + **3 red variants** with different seeds. `generate-pptx.ts` cycles a `contentSlideCounter % 6` (and `sectionCounter % 3` for red dividers) so consecutive titles never share a drawing.
* **Native shape library used by source slides:** `addShape('line', {h:0, line:{endArrowType:'triangle'}})` for arrows, `addShape('roundRect')` for flow/roadmap nodes, `addShape('rect')` for pillars, `addShape('ellipse')` for hub & spoke. All are individually selectable and editable in Slides.
* **pptxgenjs 4.0.1 capabilities verified for this design:** `slide.hidden`, `addChart` (BAR/LINE/PIE), `addShape` arrow shapes (`rightArrow`, `leftArrow`, `line` with `endArrowType`), `addNotes`, `addTable` with per-cell formatting. ChartType strings are lowercase (`'bar'`, `'line'`, `'pie'`).
* **Hand-drawn lines must be fat AND rough.** rough.js `roughness: 2, strokeWidth: 4` is too subtle for big elements — use `roughness: 3.5–4, strokeWidth: 12–14, bowing: 2–3` for things drawn at large display sizes. **Underlines are the exception**: at ~0.3″ display height the wobble dominates, so they need flatter aspect + lower roughness (see above). Always render 2–4× the final display size so roughness stays crisp after Slides rescales.

## TypeScript / Node tooling gotchas

* **`pptxgenjs` ESM/CJS interop** needs `(pptxgenModule as any).default || pptxgenModule` — direct `import pptxgen from "pptxgenjs"` hits "not a constructor" under Node 22 ESM.
* **`npx tsx -e "..."` resolves modules from `cwd`**, ignoring `--prefix`. Write scripts to files under the directory that has `node_modules`, then `cd` there and run `npx tsx file.ts`.
* **Background `run_in_background` outputs are truncated.** If a long-running task writes to a log file, poll the file instead of trusting the final notification summary.
* **`claude -p --model haiku` is the cheapest way to call Claude from scripts** in this devcontainer. No ANTHROPIC_API_KEY needed — it uses the current session's auth. Use `--output-format json` to get token counts. Combine with `--dangerously-skip-permissions` for non-interactive runs.
* **`claude -p` fails silently with large stdin prompts** (>10KB). The pipe buffer fills and the process hangs until timeout. Workaround: write prompt to a file, use `claude -p < file.txt`, or use the Agent tool for large generation tasks. Small prompts (<5KB) work fine via pipe.
* **Analysis eval system** lives in `analysis/`. Three prompt candidates for design extraction; `run-eval.ts` orchestrates end-to-end eval. Renderer in `analysis/renderer/` tracks iterations with tokens/time/fidelity metrics.
