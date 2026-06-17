/**
 * ROUND 3 clusters — the two still-BAD after round-2 (card-format + line-position
 * already merged to main). COMPLEX deck. Run with BOTH engines (claude + codex)
 * → two worktrees per cluster.
 *
 * Round-1 + the good round-2 fixes are ALREADY in main HEAD — build ON them.
 * file:line anchors are approximate; confirm in the worktree.
 */
import type { Cluster } from "./workspace-setup.js";

const C_CLIP: Cluster = {
  task_id: "clipping-masks",
  slide_ids: ["slide_12", "slide_14", "slide_32"],
  retry_budget: 5,
  cluster_description:
    "Children that overflow a rounded/clipped parent are STILL clipped wrong after two rounds. The fix must select the CORRECT PARTIAL-corner OOXML shape per clipped side — not a full round-rect and not all corners. Verbatim round-2 user re-ratings:\n" +
    "  slide_32: \"Only the left side should have rounded corners. There is appropriate shape available for sure. You need to pick correct shape after clipping.\"\n" +
    "  slide_14: \"The top border is rounded and it's not rectangle which is clipped like in the original. This is visible on the sides. There should be an element which can present this cut.\"\n" +
    "  slide_12: \"The black area on top is clipped wrong. The bottom curvatures are wrong.\"\n" +
    "ROOT CAUSE (carried from round-2 diagnosis): the converter's clip in renderer/html2slides/convert-pptx-lib.ts (~1466-1500 `emitClipUnderlay` / `computeClippedPatch` ~1633-1686) draws a rounded patch UNDER the host and the host ON TOP at full square bounds — a fake clip. Round 2 tried constraining the host to patch.bounds but applied the WRONG corner set (rounded all/ambiguous corners), which is what the user is still flagging.\n" +
    "REQUIRED FIX: when a child is clipped by a rounded parent, round ONLY the child corners that actually coincide with a rounded parent corner; leave the others square. A child flush to ONE rounded edge → its two corners on that side are rounded, the opposite two stay square → emit ROUND_2_SAME_RECTANGLE rotated to that side (per CLAUDE.md's corner-radius rules: [TL,TR,BR,BL] → ROUND_RECTANGLE / ROUND_2_SAME_RECTANGLE / ROUND_2_DIAGONAL_RECTANGLE / ROUND_1_RECTANGLE). Concretely: slide_32 `.pill.p0` is at the LEFT of a `border-radius:14px;overflow:hidden` row → round LEFT 2 corners only (TL+BL); slide_14 accent `::before` stripe spans the TOP of a `border-radius:12px` card → round TOP 2 corners only (TL+TR), flat bottom — this is the \"element which presents the cut\"; slide_12 `.status-bar` is full-width at the TOP of a `border-radius:32px` device → round TOP 2 corners only, and DO NOT round the bottom (the \"bottom curvatures are wrong\" = bottom corners are being rounded when they must stay square). REUSE the existing border-radius→preset-shape selection logic (the same [TL,TR,BR,BL]→ROUND_* mapping the converter already uses for CSS border-radius) instead of inventing new geometry. Compute the per-corner clip radius = parent corner radius ONLY where the child rect touches that parent corner, else 0.\n" +
    "VERIFY on real Slides render: slide_32 pills rounded on the LEFT only (square right); slide_14 accent stripe flat-topped with the card's rounded top corners cutting it; slide_12 status-bar rounded top corners, square bottom; gradient fills on slide_32 pills intact.",
};

const C_CHEV: Cluster = {
  task_id: "chev-arrows",
  slide_ids: ["slide_34"],
  retry_budget: 4,
  cluster_description:
    "Round 2 emitted the slide_34 `.chev` row markers but with the WRONG shape. Verbatim: \"The arrows on the left have a right angle.\" The chevrons render as an axis-aligned right-angle corner (⌐/L) instead of a rotated diagonal chevron `<`.\n" +
    "The `.chev` CSS is `border-left:4px solid #818cf8; border-bottom:4px solid #818cf8; width:11px; height:11px; transform: rotate(45deg)` — two adjacent painted borders forming an L, then ROTATED 45° so it reads as a chevron/arrowhead. There is currently NO chevron detector in main (round-2's attempt was not merged); main only has the single-coloured-side popup-triangle path (round-1) in renderer/html2slides/extract-dom.ts (`detectBorderTriangle` ~1343, called in the pseudo/host path).\n" +
    "REQUIRED FIX: add a `detectBorderChevron(el, style, bounds)` sibling detector — match exactly TWO ADJACENT coloured borders (same colour, equal width) with the other two zero/transparent on a ~square box. Emit it as a stroked open chevron (a 2-segment polyline / rotated stroked L, or a chevron preset), STROKE colour = border colour, STROKE width = border width, and — critically — APPLY the element's `transform: rotate()` (the 45° is what makes it a diagonal arrowhead, not a right angle). Derive pointing direction from which two sides are coloured plus the rotation. Hook it alongside the triangle detector for both host elements and pseudo-elements. Do NOT regress the round-1 popup speech-bubble triangle (a different, single-side idiom).\n" +
    "VERIFY: the four left-column markers render as diagonal blue chevrons `<` matching the original, correctly rotated — not axis-aligned right angles.",
};

export const CLUSTERS: Cluster[] = [C_CLIP, C_CHEV];
