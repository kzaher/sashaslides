# HTML → Google Slides Converter — Evaluation & Progress

## Architecture

- **extract-dom.ts** — Injected into Chrome via CDP. Walks DOM, extracts elements as typed flat array.
  Source of truth for all rendering rules (border, corner radius, shadow, gradient, screenshot).
- **convert-slides-api.ts** — Reads extraction JSON, builds Slides API `batchUpdate` requests.
- **e2e/pipeline.ts** — Parallel pipeline: screenshot → convert → thumbnail → compare.
- **e2e/fixtures/** — HTML test slides for E2E testing.
- **rating-server.ts** — SxS comparison UI with links to HTML source and Google Slides.

## Rendering Rules (documented in extract-dom.ts)

### Corner Radius
- All 4 same → ROUND_RECTANGLE
- Top pair rounded, bottom square → ROUND_2_SAME_RECTANGLE (no rotation)
- Bottom pair rounded → ROUND_2_SAME_RECTANGLE rotated 180°
- Left/right pairs → ROUND_2_SAME_RECTANGLE rotated 90°/270°
- Circular (radius >= 40% of min dim) → ELLIPSE
- Arbitrary → approximate with best ROUND_2_SAME_RECTANGLE

### Borders
- **Uniform** (all sides same): shape outline with color, weight, dashStyle
- **Non-uniform** (per-side): create border-colored shapes BEHIND content shape.
  Each border side extends outward by border width. Content shape ON TOP covers inner area.
  Slides layers in creation order (later = on top), so border shapes must be created FIRST.
- **Transparent elements with border**: detect bgColor from ancestor DOM, use as fill for coloring trick.

### Tables with Rounded Corners
- Each rounded corner gets a separate ROUND_1_RECTANGLE shape behind the table.
- Sized to corner cell, oriented with rotation. Fill = cell bg color.
- Use coloring trick (ancestor bgColor) to hide non-existent borders between corner shape and adjacent cells.

### Gradients
- Slides API supports linearGradientFill. Extract CSS linear-gradient angle + color stops.
- Radial-gradient: solid fallback (first color).
- Conic-gradient: screenshot as visual (donut charts).

### Box Shadow
- Use Slides shadow property on shape: `{ type: "OUTER", blurRadius, color, alpha, transform }`.
- Transparent bottom-most shape as shadow layer, content shape on top.

### Text
- Use exact HTML bounding box measurements — no artificial expansion.
- Font mapping: Helvetica Neue→Arial, monospace→Courier New, etc.
- Text-in-shapes: merge text into ELLIPSE/ROUND_RECTANGLE for circles with initials, badges.

### Screenshots (require user permission for new categories)
- Only: SVG, canvas, `<img>`, conic-gradient, clip-path
- Never: circles, rounded rects, gradients (use solid fallback), shadow, buttons, badges

## Iteration History

### Iteration 1 — Initial converter
- Basic rect/text/line/table/list extraction
- Solid fills, simple borders
- Issues: no rounded corners, no circles, no gradients, no per-side borders

### Iteration 2 — Circle + rounded corner detection
- Added ELLIPSE for circular elements
- Added ROUND_RECTANGLE for border-radius > 2
- Added dashed border support (DASH, DOT)
- Added conic-gradient/clip-path screenshot detection
- Issues: border shapes rendered ON TOP instead of behind, gradient not extracted

### Iteration 3 — Border ordering + gradient extraction
- Fixed non-uniform border shapes to create BEFORE content shape (correct z-order)
- Added linear-gradient parsing with solid color fallback
- Added per-corner radii extraction (borderTopLeftRadius etc.)
- Added ROUND_2_SAME_RECTANGLE with rotation for non-uniform corner radii
- Removed emitBorderLines — borders handled by rect's borderSides data
- Exact text measurements — no artificial bounding box expansion
- TypeScript migration: extract-dom.js → extract-dom.ts with esbuild compile

### Iteration 4 — Current (in progress)
- User feedback: corner radii still wrong, gradient bg not working on buttons, border trick coloring wrong
- Need: simple E2E tests for each primitive (border, color, shadow, gradient, text) to verify basics work
- Need: iterate until primitives are perfect before testing complex layouts

## E2E Test Pipeline

```
e2e/
  fixtures/       ← HTML test slides
  snapshots/      ← blessed thumbnails from accepted runs
  runs/<ts>/      ← per-run artifacts
    originals/    ← HTML screenshots
    thumbs/       ← Slides API thumbnails
    sxs/          ← side-by-side comparison data + ratings.json
  eval-set/       ← rated slides (good+bad saved, skip ignored)
```

Run: `npx tsx e2e/pipeline.ts --parallelism 10 --port 3456`
Skill: `/e2e-test`
