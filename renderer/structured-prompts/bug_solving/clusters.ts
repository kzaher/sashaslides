/**
 * Wave-4 clusters — derived from regression-scan report
 * (/tmp/regression-scan/regression-report.json) + user SxS comments.
 *
 * Each cluster gathers slides whose losses share one hypothesized root
 * cause; each slide is only in ONE cluster (so the structured-prompt
 * verdict agent sees focused diffs). Duplicate-issue slides are placed by
 * primary issue — e.g. slide_14 has both a narrow "SOCIAL PROOF" label
 * (padding-inset) and unclipped top borders (clipping); clipping is the
 * more impactful visual so it lives in the clipping cluster.
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  {
    task_id: "padding-inset-compound",
    cluster_description:
      "Padding-inset compounds across merges. The regression-scan shows three " +
      "recent merges (padding, pseudo-elements-bullets, spacing-alignment) each " +
      "added their own padding-inset pass on top of the existing one, causing " +
      "auto-sized text boxes to lose 20–80 px of usable width. A Range-probe " +
      "guard was added for S17 'Milestone achieved' but is scoped too narrowly. " +
      "Task: unify the inset passes into a single gate that uses a Range-based " +
      "line-width probe everywhere (see extract-dom.ts:1639). " +
      "S15: anomalies with text in chips (tight chip labels get inset + wrap). " +
      "S19: padding too large from labels to bullets (multi-column card grid). " +
      "S21: 'Vide details' wraps to two lines. " +
      "S25: entire main text moved up (padding-inset shifts block vertically). " +
      "S30: code text alignment wrong (code block padding-inset).",
    slide_ids: ["slide_15", "slide_19", "slide_21", "slide_25", "slide_30"],
  },
  {
    task_id: "clipping-curves",
    cluster_description:
      "Overflow:hidden + border-radius parents aren't clipping children to the " +
      "rounded boundary. The clip-utils library in tree is the right primitive. " +
      "S11: top lines of a card aren't clipped to the rounded container. " +
      "S14: top borders of elements not clipped; SOCIAL PROOF label narrow. " +
      "S28: top-right card rounded corners regressed (was working in an earlier " +
      "commit per user comment — confirmed by regression-scan).",
    slide_ids: ["slide_11", "slide_14", "slide_28"],
  },
  {
    task_id: "shadow-glow",
    cluster_description:
      "Inner glow + outer card borders missing on slide_17. User comment: " +
      "'Middle glow is missing and outer borders on cards (e.g. Green Capital " +
      "card)'. Convert-pptx.ts emits single-layer box-shadow but the fixture " +
      "uses layered shadows (inner glow + outer stroke) that collapsed into one " +
      "after the gradient-rendering merge rewrote the body-level background.",
    slide_ids: ["slide_17"],
  },
];
