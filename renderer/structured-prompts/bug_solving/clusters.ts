/**
 * Wave-31 — NARROW SCOPE. The rounded left table currently renders with a
 * visible "double border" on its right edge: a doubled vertical line/stripe
 * that doesn't exist in the baseline. The user only wants this one defect
 * removed for now. All other residual issues (pink hairlines, missing
 * borders elsewhere) are out of scope for this wave.
 *
 * Baseline: current main (= wave-29-A's convert-pptx-lib.ts already in
 * main). Do NOT redesign the corner-clipping architecture — just locate
 * the source of the extra inner vertical stroke on the right edge and
 * remove/suppress it. Keep the rest of the slide visually unchanged.
 *
 * Cluster: 1 worker, retry_budget 4.
 */
import type { Cluster } from "./workspace-setup.js";

const BUG_DESCRIPTION =
  "NARROW-SCOPE wave. The user wants exactly one defect removed and " +
  "nothing else changed:" +
  "\n" +
  "\n  \"Left table: I can see a double border on the right side of " +
  "table. remove that border.\"" +
  "\n" +
  "\nThis is ONE OF FIVE bullets the user previously listed; the OTHER " +
  "FOUR are out of scope for this wave — do not attempt to fix them, " +
  "and do not let your fix make them worse." +
  "\n" +
  "\nConcretely: in the rendered `basic_slide_17`, look at the rounded " +
  "left table's right edge (the column boundary between Status and the " +
  "table's outer right border). You will see TWO vertical strokes very " +
  "close together — one is the legitimate outer table border, the other " +
  "is an extra inner stroke that shouldn't be there. Identify whichever " +
  "code path emits the second stroke and suppress it. Likely candidates: " +
  "(a) the per-corner shape-twice underlay's outer rect bleeds an inner " +
  "stroke at its inner-side edge, (b) the native `<a:tbl>` per-cell " +
  "right border is being drawn in addition to the underlay's right edge, " +
  "(c) `pickRingBorder` is double-counting a side." +
  "\n" +
  "\nVERIFICATION RULE for Step 7.5: PASS if the double border on the " +
  "left table's right edge is gone AND none of the other four bullets " +
  "(left table TL pink hairlines, BL pink stripe, right table TL/BL " +
  "missing white borders) have regressed visibly worse than the current " +
  "main render. You do NOT need to fix any other bullet to pass.";

const SLIDE_IDS = ["basic_slide_17"];

export const CLUSTERS: Cluster[] = [
  { task_id: "wave31-A", cluster_description: BUG_DESCRIPTION, slide_ids: SLIDE_IDS, retry_budget: 4 },
];
