/**
 * Wave-32 — single worker, 10 attempts, full 5-bullet scope. Baseline now
 * includes the post-table-outline-stroke-skip fix in main (the underlay
 * strip is the sole perimeter border when the table has an outer border;
 * the double-border defect on `.rounded` should now be gone or much
 * reduced).
 *
 * The worker should diagnose whatever residual defects remain against the
 * user's original 5-bullet comment, fix them, and not regress the now-
 * single perimeter line on `.rounded`/`.rounded-nb`.
 *
 * Cluster: 1 worker, retry_budget 10.
 */
import type { Cluster } from "./workspace-setup.js";

const BUG_DESCRIPTION =
  "User flagged basic_slide_17 as BAD with the following comment (verbatim, " +
  "do NOT paraphrase or infer beyond this text):" +
  "\n" +
  "\n  \"Left table:\n" +
  "  * I can see a double border on the right side of table. remove that border.\n" +
  "  * The right side of bottom left cell has pink stripe, and bottom border is a bit too high.\n" +
  "  * Top left cell has pink border on the bottom and right side.\n" +
  "  \n" +
  "  Right table:\n" +
  "  * Top left cell nas no white border on top and left.\n" +
  "  * Bottom left cell has no white border on top, bottom and left sides.\n" +
  "  \n" +
  "  For this clipped cells, all borders should be colored in the actual table as border. The corner cell should only have outer border and background embedded in the shapes. If the bottom corner cells have the same background border, then make sure they are a single shape. The same is valid for top cells. Make sure that the clipped shape (in this case cell edges) covers at least some overlap below the border and other elements to remove any visual artifacts and ghost lines.\"" +
  "\n" +
  "\nStatus note: the double-border bullet (left-table right edge) was just " +
  "addressed in main by skipping the post-table outline stroke when the " +
  "underlay already paints the border. Do NOT re-introduce that stroke. " +
  "The fixture also contains two no-outer-border variants below the " +
  "original pair (`.rounded-nb`, `.colored-nb`) — your fix must work for " +
  "both cases. The slide has a pink background behind each table for " +
  "visibility. Per-annotation zoom-crops (5 annotations) are attached at " +
  "Step 7.5.";

const SLIDE_IDS = ["basic_slide_17"];

export const CLUSTERS: Cluster[] = [
  { task_id: "wave32-A", cluster_description: BUG_DESCRIPTION, slide_ids: SLIDE_IDS, retry_budget: 10 },
];
