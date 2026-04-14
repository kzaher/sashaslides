---
description: Convert HTML slides to Google Slides with high fidelity via DOM extraction
command: bash analysis/renderer/html2slides/run.sh
args: <html-dir> [output-dir]
---

# html2googleslides

Converts a directory of HTML slide files (1280×720px each) to a Google Slides presentation by extracting DOM elements and mapping them to native Slides elements via pptxgenjs.

## Pipeline

1. **Extract** — Open each HTML in Chrome, inject JS to walk the DOM and capture every visible element's absolute position, size, style, and text content
2. **Convert** — Map extracted elements to pptxgenjs calls (addText, addShape, addTable, addImage)
3. **Upload** — Generate .pptx, upload to Google Drive, open as Google Slides
4. **Compare** — Screenshot both original HTML and resulting Slides, launch rating server

## Element Handling

### Recursive (preserve structure)
- `<table>` → pptxgenjs `addTable()` with per-cell formatting (font, color, bg, alignment, borders, colspan/rowspan)
- `<ul>/<ol>` → pptxgenjs `addText()` with bullet options and indent levels

### Flattened (absolute positioned)
- Text elements (`<h1-h6>`, `<p>`, `<div>` with text, `<span>`) → `addText()` at exact position with font/size/color/weight/alignment
- Background rects (`<div>` with background-color) → `addShape("rect")` with fill color, border, border-radius
- Lines/HRs → `addShape("line")`
- `<img>` with data: URLs → `addImage()`
- `<svg>`, `<canvas>` → Screenshot region as PNG, `addImage()`

### Not supported
- CSS animations/transitions
- External images (CORS blocks data URL conversion)
- CSS gradients (converted to solid color of first stop)
- Box shadows

## Resolution

- HTML rendered at **1280×720px** (2× deviceScaleFactor for crisp screenshots)
- Maps to pptxgenjs **13.333" × 7.5"** (standard Google Slides widescreen 16:9)
- Conversion: 1px = 0.01041 inches

## Rating Server

After conversion, a rating server launches at `http://localhost:3456` showing:
- Side-by-side: original HTML screenshot vs Google Slides screenshot
- **Good** (g key) — saves pair to `regression-snapshots/` as a passing test
- **Bad** (b key) — logs for debugging, triggers analysis of what went wrong
- Keyboard: g=good, b=bad, →/n=next, ←/p=prev

## Usage

```bash
/html2googleslides analysis/eval/results/sequoia-template/candidate_2/reconstruction

# Or directly:
cd analysis/renderer/html2slides
npx tsx convert.ts <html-dir> <output.pptx>        # just generate .pptx
npx tsx rating-server.ts <results-dir>              # just launch rating UI
```
