/**
 * Wave-21 — same target as wave-20 (basic_slide_17) but the cluster
 * description is now STRICTLY the user's verbatim comment. No
 * editorialising, no inferring "1-px", no "extra", no per-corner expansion.
 * The user noticed wave-20's analysis.md echoed my paraphrase ("extra 1-px
 * borders on their INNER sides") rather than their exact words and flagged
 * it as a wrong restatement that biased the fix.
 *
 * Anything beyond the user's literal text is for the worker to derive from
 * the attached PNG attachments (rendered + baseline + diff + per-annotation
 * zoom-crops). Step 7.5 carries the zoom-crops the user drew on wave-19's
 * SxS so the worker can see exactly which pixels are flagged.
 *
 * Cluster: 4 parallel attempts (same content), retry_budget 10 each.
 */
import type { Cluster } from "./workspace-setup.js";

const BUG_DESCRIPTION =
  "User flagged basic_slide_17 as BAD with the following comment (verbatim, " +
  "do NOT paraphrase or infer beyond this text):" +
  "\n" +
  "\n  \"For the left table the bottom left cell has border also on top and " +
  "right, when it shouldn't. similar for the right cell. for top left cell " +
  "it has order on right and bottom, when it shouldn't have. same for the " +
  "top right cell for left table.\"" +
  "\n" +
  "\nAttached to Step 7.5's visual-verification prompt are per-annotation " +
  "zoom-crops the user drew over the prior wave's render. Those crops are " +
  "the precise pixels the user is pointing at — use them to ground your " +
  "diagnosis, not the cluster text.";

const SLIDE_IDS = ["basic_slide_17"];

export const CLUSTERS: Cluster[] = [
  { task_id: "wave21-A", cluster_description: BUG_DESCRIPTION, slide_ids: SLIDE_IDS, retry_budget: 10 },
  { task_id: "wave21-B", cluster_description: BUG_DESCRIPTION, slide_ids: SLIDE_IDS, retry_budget: 10 },
  { task_id: "wave21-C", cluster_description: BUG_DESCRIPTION, slide_ids: SLIDE_IDS, retry_budget: 10 },
  { task_id: "wave21-D", cluster_description: BUG_DESCRIPTION, slide_ids: SLIDE_IDS, retry_budget: 10 },
];
