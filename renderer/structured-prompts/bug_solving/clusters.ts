/**
 * ROUND 4 — the one remaining loss after a render-check of every still-flagged
 * slide against the current merged code. 6 of 7 candidates (01,02,15,18,21,29)
 * came back FIXED by the cumulative systematic fixes; only slide_20 is still
 * broken. COMPLEX deck. Run with BOTH engines (claude + codex).
 */
import type { Cluster } from "./workspace-setup.js";

const C_CIRCLE: Cluster = {
  task_id: "circle-bubble-ring",
  slide_ids: ["slide_20"],
  retry_budget: 4,
  cluster_description:
    "COMPLEX slide_20 (a bubble / market-share scatter chart). Verbatim user rating (BAD): \"Inner and outer circles are wrong, in the original outer circle is larger.\" A fresh render-check against the CURRENT merged code confirms it is STILL broken: the highlighted bubble's OUTER ring renders ~the same diameter as its inner fill, but in the original the outer circle is clearly LARGER.\n" +
    "LIKELY CAUSE: the bubbles are `.bubble { border-radius:50% }` circles; the 'Our Product' bubble carries a `box-shadow: 0 0 0 Npx rgba(99,102,241,0.3)` SPREAD ring (see fixture line ~52 legend + the corresponding bubble) that makes the visible outer circle larger than the fill. The converter is not transferring that box-shadow spread as a larger concentric ring — so the outer circle collapses to the fill size. Investigate box-shadow (especially spread-radius `0 0 0 Npx`, no blur) extraction for circular elements in renderer/html2slides/extract-dom.ts, and the shadow/ring emission in renderer/html2slides/convert-pptx-lib.ts; emit the spread ring as a concentric circle (ellipse) sized fill+2*spread behind/around the bubble. fixture: renderer/html2slides/e2e/fixtures/slide_20.html.\n" +
    "VERIFY on a real Google Slides render: the highlighted ('Our Product') bubble shows an outer ring visibly LARGER than its inner fill, matching the original target.",
};

export const CLUSTERS: Cluster[] = [C_CIRCLE];
