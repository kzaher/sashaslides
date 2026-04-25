/**
 * Wave-6 clusters — derived from user SxS ratings on the wave-5 outputs.
 * One bad slide per cluster for maximum parallelism.
 *
 * From wave-5 user verdicts (see /tmp/sxs-complex/ratings.json + per-task SxS):
 *   slide_11 — BAD: "The top border isn't rendered or trimmed. The bullets
 *              are wrong height." (round-1's bottom-corner work landed; top
 *              regressed and bullet vertical-centering is off).
 *   slide_14 — BAD: "Top border is not clipped." (round-1 chip-border-color
 *              work was orthogonal; the top-clip part still failing).
 *   slide_15 — UNRATED (SxS UI did not surface the original bug, so the
 *              reviewer had no way to evaluate). Original bug stands:
 *              status chips wrap to 2 lines.
 *   slide_17 — UNRATED (CDP dropped during wave-5's record-after; cluster
 *              never produced a SxS). Original bug stands: 'MILESTONE
 *              ACHIEVED' label still left-aligned instead of centered.
 *   slide_19 — GOOD WITH NOTE: "top right one line labels are now broken
 *              into two lines, otherwise looks good!" — the threshold tweak
 *              for bullet rows shipped, but the phase-N labels above the
 *              roadmap now wrap.
 *   slide_21 — GOOD: shipped (slide_21-btn-wrap convert-pptx + extract-dom
 *              singleLine wiring is now on main).
 *   slide_25 — UNRATED (CDP drop). Original bug stands: main text shifted up.
 *   slide_30 — UNRATED (CDP drop). Original bug stands: code block alignment.
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  {
    task_id: "slide_11-top-border-bullets",
    cluster_description:
      "On slide_11 two related issues: (1) the card's TOP BORDER is not " +
      "rendered or trimmed correctly — the user reports it's missing or " +
      "overdrawn (likely the same family as slide_14's top-border-clip bug, " +
      "but on slide_11 the wave-5 work fixed the bottom and left top in " +
      "a worse state). (2) Bullet vertical-positioning is off — bullets sit " +
      "at the wrong height inside their rows. Likely the verticallyCentered " +
      "threshold change (extract-dom.ts ~line 1886) needs further tuning, " +
      "OR the ::before bullet pseudo's pb.y shift (extract-dom.ts ~line 1378) " +
      "interacts with the parent-border half-shift just landed. Investigate " +
      "both top-border and bullet-height as a single cluster — they share " +
      "the .opportunity-card padding/border code path.",
    slide_ids: ["slide_11"],
  },
  {
    task_id: "slide_14-top-clip",
    cluster_description:
      "On slide_14 the TOP BORDER is not clipped. The card has rounded " +
      "corners and an absolutely-positioned color stripe on top; the stripe " +
      "should be clipped to match the card's border-radius. The recent " +
      "half-shift work (extract-dom.ts ~line 1378, parentBT/2) was meant to " +
      "address this but the user still reports the top edge as wrong. " +
      "Verify: (a) the rounded card emits a clip-path or PRESET_GEOMETRY " +
      "with the correct border-radius, (b) the stripe element is inside " +
      "that clipping region, (c) the half-shift correctly lands the stripe " +
      "at the inner edge of the centered OOXML stroke. If clip-utils only " +
      "applies to fills and not absolute children, fix that.",
    slide_ids: ["slide_14"],
  },
  {
    task_id: "slide_15-chip-wrap",
    cluster_description:
      "On slide_15 the status chips ('Active', 'In Review', etc.) wrap " +
      "their text onto 2 lines because the padding-inset pass shrinks the " +
      "text box below the rendered glyph width. The unified inline-aware " +
      "horizontal-padding gate (extract-dom.ts ~line 1832) should handle " +
      "this — verify it actually fires for inline .status-badge spans " +
      "(padding:3px 10px) AND that convert-pptx's inset path was removed " +
      "as the comment claims. Apply neighbor-slack widening if the chip " +
      "needs extra room beyond what the safeToInset gate gives.",
    slide_ids: ["slide_15"],
  },
  {
    task_id: "slide_17-milestone-align",
    cluster_description:
      "On slide_17 the 'MILESTONE ACHIEVED' label is LEFT-aligned instead " +
      "of CENTER-aligned. The fixture has text-align:center on that pill. " +
      "Earlier padding-inset work narrowed the text box; the Range-probe " +
      "guard may swap the align override from 'ctr' to 'l'. Verify that " +
      "the text-extent path still emits algn='ctr' for auto-sized center- " +
      "aligned labels even after the unified gate's bounds adjustment.",
    slide_ids: ["slide_17"],
  },
  {
    task_id: "slide_19-phase-labels",
    cluster_description:
      "On slide_19 the TOP-RIGHT one-line phase labels (above the roadmap) " +
      "now wrap to 2 lines after wave-5's verticallyCentered threshold " +
      "raise (padTop>=5 instead of >2). Those phase labels likely have " +
      "padding:4px or so, falling between the old and new thresholds. The " +
      "fix needs to either: (a) widen the slack budget for short labels " +
      "regardless of padTop, or (b) keep verticallyCentered but ALSO emit " +
      "singleLine slack for them. Look at the .roadmap-phase-label class " +
      "specifically. The bullet-row padding fix from wave-5 must be " +
      "preserved — don't revert that.",
    slide_ids: ["slide_19"],
  },
  {
    task_id: "slide_25-text-offset",
    cluster_description:
      "On slide_25 the entire main text block is shifted UP relative to " +
      "the fixture. Root cause is Slides under-rendering CSS line pitch " +
      "when we emit spcPct (percent-of-line-height); switching the " +
      "offending .text-block paragraphs to spcPts (absolute points) avoids " +
      "the drift. Prior wave-5 attempt's diff reported 'no structural " +
      "differences' — verify the spcPts substitution actually lands in " +
      "the emitted XML.",
    slide_ids: ["slide_25"],
  },
  {
    task_id: "slide_30-code-align",
    cluster_description:
      "On slide_30 the code block's text alignment is wrong. Expected the " +
      ".code-block to emit anchor='t' and spcPts instead of the current " +
      "anchor='ctr' + spcPct=141667. Prior wave-5 attempt only touched .tag " +
      "pills (TypeScript/Node.js/etc.) and never produced any change for " +
      "the code lines themselves. Route the fix through the code-block " +
      "path in convert-pptx.ts / extract-dom.ts specifically.",
    slide_ids: ["slide_30"],
  },
];
