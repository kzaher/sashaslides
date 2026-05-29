/**
 * Wave-33 — single worker, 10 attempts. Rounded-table corner masks on
 * basics slide_17 (`renderer/html2slides/e2e/fixtures-basic/slide_17_table_rounded.html`).
 *
 * Since wave-32 the corner-mask path in `convert-pptx-lib.ts` was reworked
 * (NOT by a worker — by main, this session). The worker MUST build on that
 * state, not revert it. What changed and why (the retry trail):
 *
 *   wave-32  → skipped the post-table outline stroke when the underlay
 *              already paints the border (killed the `.rounded` double
 *              border). DO NOT re-introduce that stroke.
 *
 *   session fixes since wave-32 (all in `convert-pptx-lib.ts`):
 *     a) renderTableAsShapes + the corner-mask block were made DRIFT-FREE:
 *        column/row geometry is built by quantising CUMULATIVE gridline
 *        offsets (q01 = round to 0.01") and taking per-cell sizes as the
 *        DIFFERENCE of adjacent quantised edges, then EDGE-ANCHORING the
 *        last edge to `contentW/contentH = px2in(b.w/h) - outer borders`.
 *        Quantising each size then summing (the old way) drifted short and
 *        leaked the wrapper-pink/white underlay at the right & bottom. DO
 *        NOT go back to per-cell quantise-then-sum.
 *     b) `pickRingBorder` was reverted to use the WIDER of the corner
 *        cell's own outer border and the table's outer border. For
 *        `.colored` (cells have `border:1px #fff`, table has none) this
 *        restores the 1px WHITE outer border that curves around each
 *        corner. An earlier "table-border-only" attempt DELETED that border
 *        — do NOT remove the corner cell's own border again.
 *     c) `outerOvershootBottom` was set to 0 (was px2in(3)). With drift-free
 *        rows the corner bottom now lands exactly on the table bottom; the
 *        old 3px overshoot made BL/BR poke out below the table. Keep it 0
 *        unless a real gap reappears (then use <= 1px).
 *
 * After (a)-(c) the user re-rated slide_17 BAD again. The remaining defects
 * are now SMALL (sub-pixel / 1-2 display-px edge misalignment) on the
 * corner cells of the bordered table, plus NEW white-leak + bottom-
 * misalignment on the no-outer-border companion (`.colored-nb`). The worker
 * should diagnose and close these residuals WITHOUT regressing (a)-(c) or
 * the wave-32 single-perimeter-line fix.
 *
 * slide_17 layout (top→bottom, the relevant tables):
 *   - row 1 right "top right table"  = `.colored`    (pastel cells, 1px
 *     WHITE internal + outer borders, pink rounded wrapper) — uses the
 *     native <a:tbl> + corner shape-twice masks.
 *   - row 2 right "right center table" = `.colored-nb` (same pastels, NO
 *     outer table border, cells have NO border) — corner masks should be a
 *     single cell-coloured rounded fill (ring width 0); pink wrapper behind.
 *
 * Verify against the rendered thumb at /tmp/sxs/slides/slide_17.png + the
 * pink wrapper. Cluster: 1 worker, retry_budget 10.
 */
import type { Cluster } from "./workspace-setup.js";

const BUG_DESCRIPTION =
  "User re-flagged basics slide_17 as BAD. Comment (verbatim — do NOT " +
  "paraphrase or infer beyond this text):" +
  "\n" +
  "\n  \"The problem with the top right table." +
  "\n  * top left cell - slightly misaligned left edge." +
  "\n  * top right cell - slightly misaligned right edge." +
  "\n  * bottom left cell - slightly misaligned bottom edge." +
  "\n  * bottom right cell - slightly misaligned bottom and right edge." +
  "\n  " +
  "\n  right center table:" +
  "\n  * white on edge side of table." +
  "\n  * white on top side of table." +
  "\n  * bottom left cell - misaligned bottom." +
  "\n  * bottom right cell - misaligned bottom.\"" +
  "\n" +
  "\nContext: the four cells called out on the 'top right table' (`.colored`) " +
  "are its CORNER cells, rendered by the shape-twice corner-mask block in " +
  "`renderer/html2slides/convert-pptx-lib.ts` (the `if (_tableGid && " +
  "cornerSpecs.length > 0)` block) — NOT the native <a:tbl> interior cells. " +
  "The 'right center table' is `.colored-nb` (no outer border; corner masks " +
  "should be a single cell-coloured rounded fill with ring width 0). The " +
  "misalignments are now SMALL (1-2 display px at 160dpi; 1 CSS px = 1.25 " +
  "slide px). 'white on edge/top side' on `.colored-nb` = the white full-" +
  "table underlay showing through where the corner/edge shapes fall short " +
  "of the table perimeter — tighten the shape extents so they reach the " +
  "table edges exactly (or make the underlay match the cell colour there), " +
  "with a small overlap below adjacent elements to kill ghost lines. Do NOT " +
  "regress the changes listed in the wave-33 header doc (drift-free edge-" +
  "anchored geometry; corner cells keep their own white border; " +
  "outerOvershootBottom = 0; no post-table outline stroke; no double border). " +
  "Per-annotation zoom-crops (4 annotations) are attached at Step 7.5; the " +
  "slide has a pink wrapper behind each table for visibility.";

const SLIDE_IDS = ["slide_17"];

export const CLUSTERS: Cluster[] = [
  { task_id: "wave33-A", cluster_description: BUG_DESCRIPTION, slide_ids: SLIDE_IDS, retry_budget: 10 },
];
