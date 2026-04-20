/**
 * Second follow-up: clipping-curves only. User rated wave-3's clipping
 * attempt Bad on slides 11/12/14 (still no clipping), Good on slide_28
 * (round top-right now works). Workers now start from a main branch
 * that has gradient-rendering merged — more fixes upstream, cleaner
 * baseline.
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  {
    task_id: "clipping-curves",
    cluster_description:
      "Straight edges where rendering should be curved. User saw slide_28 " +
      "round top-right now works, but 11 / 12 / 14 still aren't clipping. " +
      "11: top lines of a card aren't clipped to the rounded container. " +
      "12: edges rounded 'above and below' but radii wrong. " +
      "14: top borders of elements still not clipped. " +
      "The clip-utils library in the tree uses a B/W dual-screenshot alpha " +
      "technique and is the right primitive to invoke when a parent has " +
      "overflow:hidden + border-radius and children visually cross a " +
      "rounded boundary.",
    slide_ids: ["slide_11", "slide_12", "slide_14"],
  },
];
