# html2slides — fixtures, regeneration, and regression gating

This pipeline converts HTML → `.pptx` → Google Slides, and uses pixel-perfect goldens to catch regressions before handing anything back to the user.

## Layout

```
e2e/
  fixtures-basic/    ← 15 narrow-scope fixtures (one feature per slide)
    slide_01_solid_rect.html         solid background + rect
    slide_02_rounded_rect.html       border-radius
    slide_03_border_uniform.html     uniform border
    slide_04_border_partial.html     per-side borders
    slide_05_gradient_bg.html        linear-gradient background
    slide_06_shadow.html             box-shadow variants
    slide_07_text_styles.html        font / weight / color
    slide_08_circle_with_text.html   circle + centered text
    slide_09_rounded_border_partial  rounded + partial borders
    slide_10_mixed.html              combined rect/text/borders
    slide_11_nested_divs.html        deeply nested containers (recursion)
    slide_12_list_simple.html        <ul> + <ol>
    slide_13_list_styled.html        list with per-item borders + inline spans
    slide_14_table_basic.html        collapsed borders
    slide_15_table_borders.html      separate / thick / dashed / per-cell borders
  fixtures/          ← 30 complex layouts
  goldens/           ← pixel-perfect blessed Slides thumbnails (created by --bless)
```

## Regenerate + regression-check (basic set)

```bash
# Rebuild everything and diff against goldens. Diff PNGs land in /tmp/sxs/diffs/.
./regen-basics.sh
```

There is intentionally no `--bless` flag. See "Blessing goldens" below.

The script does, in order:
1. `convert-pptx.ts e2e/fixtures-basic` → `.pptx` → upload to Google Slides
2. `shot-originals.ts` (HTML→PNG at 1280×720) ∥ `export-thumbs.ts` (Slides thumbnails)
3. `check-goldens.ts /tmp/sxs/slides /tmp/sxs/diffs` — pixelmatch per slide

`check-goldens.ts` writes `diff_slide_NN.png` for every slide that differs from its golden. The diff PNG is a single image highlighting changed pixels in red on a dimmed background of the current render — **this is what you eyeball**, not the before/after pair.

## Blessing goldens (USER-ONLY)

**Only the human user may promote a rendered slide into `e2e/goldens/`.** The sanctioned path is the SxS rating UI — the user clicks **Good** on a slide, and the rating server (`serve-sxs.sh` → `filtered-rating-server`, run with `--goldens-dir`) copies the current thumb into `e2e/goldens/`. That is the one and only writer, and it fires only on the user's own "Good" click.

Enforcement:
- `check-goldens.ts --bless` is disabled — the flag errors out with exit code 2.
- `regen-basics.sh` has no `--bless` and will not write to `e2e/goldens/`.
- `e2e/goldens/.BLESSED_BY_USER_ONLY` is a sentinel file documenting the rule for any tool or Claude session that lands here.
- Claude sessions: never run `cp`, `mv`, or file writes targeting `e2e/goldens/*.png`. Never check in regenerated thumbnails as goldens. Never copy `/tmp/sxs/slides/*` over goldens.

If the user's opinion diverges from the current goldens, that's a signal — fix the code, regen, hand the diff back to the user, and wait for them to bless or reject. Letting the loop promote its own output collapses the signal.

## Required workflow for any fix

**Before claiming a fix is done, gate on the goldens. No regressions = no excuses.**

1. Make the code change in `extract-dom.ts` / `convert-pptx.ts`.
2. `./regen-basics.sh` — this produces `/tmp/sxs/diffs/diff_slide_NN.png` for every regressed slide.
3. **Analyze each `diff_*.png` in a parallel sub-agent (Agent tool, one agent per diff)**. Each agent reads one diff PNG and reports whether the change is intended (the fix at hand) or a regression. Never compare original vs. new side-by-side from the main conversation — always ingest the diff image directly.
4. If all diffs are intended: `./regen-basics.sh --bless` to re-bless goldens, then show the user.
5. If any diff is an unintended regression: fix it before showing the user.

Rationale: pixel comparison catches silent regressions (a side-effect from one fix breaking an unrelated slide). Diff images focus attention on exactly where pixels changed, instead of forcing the model to re-discover the difference between two near-identical screenshots.

## Outputs

- `/tmp/sxs/basics.pptx` — generated deck
- `/tmp/sxs/originals/` — HTML screenshots (source of truth)
- `/tmp/sxs/slides/` — Google Slides thumbnails (what we rendered)
- `/tmp/sxs/diffs/diff_slide_NN.png` — per-slide diff (only on regression)
- `/tmp/sxs/diffs/regression-report.json` — machine-readable summary
- `/tmp/sxs/meta.json` — presentation id + html dir (consumed by `serve-sxs.sh`)

## Reviewing in the SxS rating UI

`./serve-sxs.sh [sxs-dir=/tmp/sxs] [port=3456]` launches the single rating UI (the `filtered-rating-server`): SxS originals vs renders, a **🔍 Magnifier** (loupe, 2–8× slider), an annotation canvas, a client-side diff overlay, and HTML/Slides deep links. Clicking **Good** blesses the golden (user-only writer; see above). `rate-slides.sh` launches the same UI for an arbitrary html dir but **without** `--goldens-dir`, so it never writes goldens.
