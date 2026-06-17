/**
 * ROUND 2 clusters — the BADs remaining after round-1 (now merged to main HEAD).
 * All COMPLEX deck (/tmp/sxs-complex, fixtures renderer/html2slides/e2e/fixtures).
 * Run with BOTH engines (claude + codex) so each cluster gets two worktrees.
 *
 * Seeded from a diagnostic pass over the round-1 renders + user re-ratings.
 * file:line anchors are for main HEAD (post-merge); confirm in the worktree.
 * Round-1 fixes are ALREADY in main — build ON them, do not revert them.
 */
import type { Cluster } from "./workspace-setup.js";

const C_CLIP: Cluster = {
  task_id: "clipping-masks",
  slide_ids: ["slide_12", "slide_14", "slide_32"],
  retry_budget: 4,
  cluster_description:
    "THREE slides, ONE shared root cause: a square-cornered coloured shape paints ON TOP of a rounded/clipped parent and is never actually clipped to the rounded boundary. Verbatim user re-ratings (round 1 did NOT fix these):\n" +
    "  slide_12: \"The top black rectangle doesn't have clipping mask applied.\"\n" +
    "  slide_14: \"Clipping mask on top border still not applied correctly.\"\n" +
    "  slide_32: \"Clipping mask on left edges isn't correctly applied.\"\n" +
    "ROOT CAUSE (renderer/html2slides/convert-pptx-lib.ts ~1466-1477): the clip is FAKE. `computeClippedPatch(b, el.clipMask)` (~1633-1686) correctly computes the clipped bounds + inherited corner radii, but that geometry is only used to draw a rounded `emitClipUnderlay` patch UNDERNEATH the host; the host is then drawn at its FULL SQUARE bounds ON TOP (`slide.addShape(shapeName, opts)`), so its square corner overhangs the parent's rounded corner. The comment claiming 'the sharp shape is covered by the rounded patch above' is false — the patch is an underlay, geometrically incapable of hiding the overhanging square corner. The host's opts.x/y/w/h and corner radii are never constrained to patch.bounds.\n" +
    "WHY ROUND 1 MISSED IT: round 1 only changed the EXTRACTION side (slide_12 Path-C child re-walk under _childClipMask at extract-dom.ts ~1980-2097; slide_14 squared the thin-stripe OUTER overlay corners outerCr.tl/tr=0 at extract-dom.ts ~1693-1763; clipMask propagation). All correct and must be KEPT — but the converter never had a real clip, so the square corners still overhang.\n" +
    "PROPOSED FIX (shared, minimal): make the clip REAL — when `patch` is non-null, emit the HOST itself as a rounded-rect constrained to `patch.bounds` + `patch.cornerRadii` (drop the separate decorative underlay), instead of a full-square shape. For slide_12 the cut corner must be transparent (page bg shows through) so clipping the host geometry is the right route. For slide_32 ALSO stop clobbering the gradient objectName: line ~1474 sets opts.objectName=hostName(gid) which overwrites the GRAD_<gid> name injectGradientsIntoZip matches (set ~1394) — keep GRAD_<gid> on the now-rounded host (round 1 added a patchObjectName param ~717/1500 for the sibling path; apply the same idea here). For slide_14 apply the same real-clip to the thin-stripe OUTER overlay: give it the parent's top corner radii (tl=pTL, tr=pTR) AND make it the topmost shape so the rounded top is a true clipped corner, not an under-drawn parent curve.\n" +
    "VERIFY: render to Google Slides and pixel-check that slide_12's status-bar top corners, slide_14's accent stripe top corners, and slide_32's pill left edges follow the parent's rounded boundary with NO square overhang; slide_32 pills still show their P0/P1/P2 gradient fills.",
};

const C_CHEV: Cluster = {
  task_id: "chev-arrows",
  slide_ids: ["slide_34"],
  retry_budget: 3,
  cluster_description:
    "Verbatim: slide_34 \"There are blue arrows which aren't transfered.\" These are the `.chev` row markers — a CSS chevron `<` made from TWO adjacent coloured borders on a square box rotated 45deg (`border-left:4px solid #818cf8; border-bottom:4px solid #818cf8; width:11px;height:11px; transform:rotate(45deg)`). They are DISTINCT from the popup speech-bubble tail round-1 already added.\n" +
    "ROOT CAUSE (renderer/html2slides/extract-dom.ts): detectBorderTriangle (~1343-1377) requires exactly ONE coloured side (`colored.length===1`, ~1364) and transparent perpendiculars (~1374-1375). The chev has TWO adjacent coloured sides and no transparent perpendiculars, so detection returns null; the `.chev` span has no bg/text, so it is dropped entirely → the four blue markers vanish.\n" +
    "WHY ROUND 1 MISSED IT: round 1's edit to this area added only the single-coloured-side popup triangle path (~1577-1606); the two-sided-border + rotate idiom was never handled.\n" +
    "PROPOSED FIX: add a sibling detector detectBorderChevron(el, s, b): match when exactly TWO ADJACENT sides are coloured (same colour, equal width), the other two are zero/transparent, the box is ~square, and style.rotate ≈ 45/135/225/315. Emit it as a stroked open chevron — a `type:\"line\"` 2-segment polyline (or a rotated stroked L / chevron preset) rotated by s.rotate, stroke colour = the border colour, stroke width = the border width; derive direction from which two sides are coloured + rotation sign. Hook it in alongside the triangle detector call (~2240). Keep the round-1 popup triangle working.",
};

const C_CARD: Cluster = {
  task_id: "card-format",
  slide_ids: ["slide_31"],
  retry_budget: 3,
  cluster_description:
    "Verbatim: slide_31 \"Double accessible label, open to all is not bolded and high font. No padding between open to all and description text.\" Three symptoms from round-1 folding block children (<h3>,<p>) + the inline-block chip into ONE merged text box.\n" +
    "(A) DUPLICATE 'ACCESSIBLE' chip: `.chip` is a <span> so .step takes the merge path; getTextRuns still pushes the chip text into the merged box (extract-dom.ts ~1222 / baked ~2643-2644), THEN round-1's emitMergedChips->emitPillSpan (~2687 -> ~1880-1903) re-draws the same string as a standalone pill → painted twice.\n" +
    "(B) 'Open to all' (<h3>) loses bold+large font: block children are recursed at extract-dom.ts ~1223-1234 with childStyle passed only as the comparison parentStyle; the h3 text node is pushed as {text, style:null} (~1143), so h3's fontSize:20/fontWeight:700 is never attached and it inherits the ~16px/400 container baseStyle (~2500-2529).\n" +
    "(C) No padding between h3 and <p>: between block children getTextRuns inserts only a bare {text:'\\n', style:null} (~1230); the CSS margins (chip 14px, h3 8px) are discarded.\n" +
    "WHY ROUND 1 MISSED IT: round 1 added the pill re-draw (A's second drawer) and the merge, but never removed the chip run from the merged text, never preserved per-block run style, never preserved block margins.\n" +
    "PROPOSED FIX (robust, single change preferred): do NOT fold block children whose computed style differs materially from the container into the merged box — keep <h3>/<p> as separately-walked text elements (each with its own style + margin-driven y), and let emitMergedChips own ONLY the inline-block pill (remove its run from the merged text). That fixes A (single drawer), B (h3 keeps its style) and C (block margins drive spacing) at once. Keep round-1's emitPillSpan for the chip itself.",
};

const C_LINE: Cluster = {
  task_id: "line-position",
  slide_ids: ["slide_33"],
  retry_budget: 3,
  cluster_description:
    "Verbatim: slide_33 \"The border is a bit too high in the big top horizontal line going from red to green.\" It is the white dashed CENTERLINE round-1 added (the .road::before strip emitted as type:'line'), ~2px too high.\n" +
    "ROOT CAUSE (renderer/html2slides/convert-pptx-lib.ts ~1734-1740): the line case draws the horizontal stroke with `y: px2in(b.y)`, `h:0`, stroke width = b.h*PX2PT. An OOXML line stroke is CENTERED on its y, so a 4px stroke given the strip's TOP y (roadTop+5) renders centered at roadTop+5 instead of the strip's visual center roadTop+7 → ~b.h/2 (2px) too high.\n" +
    "WHY ROUND 1 MISSED IT: round 1 introduced the centerline as type:'line' and passed the strip's top-y as the line's center-y, not accounting for center-stroking.\n" +
    "PROPOSED FIX (~1735): place the line on the strip's CENTER axis — horizontal: y = px2in(b.y + b.h/2); vertical: x = px2in(b.x + b.w/2). One-line symmetric correction. Verify the red→green top line sits on the road's vertical center vs /tmp/sxs-complex/originals/slide_33.png.",
};

export const CLUSTERS: Cluster[] = [C_CLIP, C_CHEV, C_CARD, C_LINE];
