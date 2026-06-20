/**
 * ROUND 9 — slides 11/12/14/32, still BAD on master (ca249fe5) after round-8
 * (round-8 was killed before merge). The user re-rated MASTER in CANONICAL mode,
 * which UPDATED the per-slide issues with much more actionable guidance (verbatim
 * below). Run BOTH engines (claude + codex), each solving every cluster, up to 7
 * attempts. Harness: deterministic off-target scan, image-aware verdict, visual
 * off-target gate, candidate-mode worktree ratings. Set
 * BUG_SOLVING_SXS_DIR=/workspaces/sashaslides/.sxs-recheck and
 * BUG_SOLVING_RATINGS_JSON=/workspaces/sashaslides/.sxs-recheck/ratings.json.
 */
import type { Cluster } from "./workspace-setup.js";

// ── C1 ───────────────────────────────────────────────────────────────────────
// 11/14: STOP auto-converting a flat ::before into a curved border — if the
// clipped shape isn't achievable by built-in shape composition, skip it + warn
// (the white artifacts are worse than nothing). 32: use a 2-rounded-2-square
// corner preset + rotation so the right edge is straight.
const C_CLIP_CORNERS: Cluster = {
  task_id: "rounded-corner-clip",
  slide_ids: ["slide_11", "slide_14", "slide_32"],
  retry_budget: 7,
  cluster_description:
    "ROUNDED-CORNER CLIP — the user gave explicit, DIFFERENT remedies per slide. Image-aware verdict: VISUALLY confirm the AFTER render is clean (no white artifacts, straight edges where required).\n" +
    "slide_11 (master rating, verbatim): \"if the border is some shape which isn't achievable by built in shapes composition. Then just ignore it and print a warning, this behavior looks ugly and it's not even correct, there are white artifacts. Just remove it.\" → The colored `.card::before` top-accent bar clipped by the rounded card is currently rendered as a wrong curved shape with WHITE ARTIFACTS. FIX: when the clipped top-stripe cannot be reproduced by composing built-in shapes (roundRect etc.), DO NOT render the broken approximation — OMIT it and log a warning. Removing it is preferred over the artifacted output.\n" +
    "slide_14 (master rating, verbatim): \"if the border is some shape which isn't achievable by built in shapes composition. Then just ignore it and print a warning, this behavior looks ugly and it's not even correct, there are white artifacts. Just remove it. Don't covert flat before element into curved border automatically.\" → SAME as 11, plus the explicit rule: DO NOT auto-convert a FLAT `::before` element into a CURVED border. If it can't be clipped correctly with native shapes, drop it + warn.\n" +
    "slide_32 (master rating, verbatim): \"The right part of area needs straight edges. Since corner radiuses are less than half of dimension, then you can use the shape which has 2 pointed edges and 2 rounded edges + rotation (I think rounded edges are by default pointed up).\" → The gradient pill's RIGHT edge must be STRAIGHT (square), left rounded. Because the corner radii are < half the dimension, use a preset shape that has 2 SQUARE (pointed) corners + 2 ROUNDED corners (e.g. `round2SameRect` — two rounded on one side) plus ROTATION to orient the rounded pair to the left. Do not collapse to an all-corners roundRect.\n" +
    "CODE: renderer/html2slides/extract-dom.ts (isThinTopStripe / the flat-::before→curved conversion to DISABLE for 11/14, clipMask propagation) + renderer/html2slides/convert-pptx-lib.ts (cornerPresetFromRadii, emitClipUnderlay, emitFlatCornerOverlays — add the 2-rounded-2-square preset+rotation path for 32; gate emission so an unrepresentable clip is skipped-with-warning for 11/14).\n" +
    "VERIFY on the AFTER render: slide_11/14 show NO white-artifact curved top border (the accent is either correctly clipped via native shapes or cleanly absent); slide_32 gradient pill has a straight right edge and rounded left, no artifact.",
};

// ── C2 ───────────────────────────────────────────────────────────────────────
// 12: bottom fixable by correct radius calc; top has radius > 50% of dimension
// (roundRect only reaches halfway) → render that part as a 2x-resolution image.
const C_DEVICE: Cluster = {
  task_id: "device-corner-image",
  slide_ids: ["slide_12"],
  retry_budget: 7,
  cluster_description:
    "DEVICE FRAME ROUNDED CORNERS — split fix per the user's master rating. slide_12 (master rating, verbatim): \"The bottom shape is achievable by setting correct radius, at the moment the radiuses are wrong, so the bottom border anomaly is fixable by just correctly calculating dimensions. The top isn't fixable because corner radius is larger than 50% of dimension (using rectangle with 2 rounded edges only goes halfway). In this case just render the background into image. Make sure the rendered image is of sufficient resolution. Create 2x resolution because of retina displays.\"\n" +
    "FIX (two parts): (1) BOTTOM corners — the radii are computed WRONG; fix the dimension/radius calculation so a native roundRect reproduces the bottom corners correctly (the radius there is < 50% of the dimension, so roundRect works). (2) TOP corners — the corner radius is LARGER than 50% of the box dimension, which a roundRect CANNOT represent (a roundRect adj maxes at 50% → it 'only goes halfway'). For that case, FALL BACK to rendering the background as a rasterised IMAGE clipped to the true rounded geometry, at 2× resolution (retina-sharp). Detect radius > 0.5·min(w,h) and switch to the image path only then; otherwise use the corrected native radius.\n" +
    "CODE: renderer/html2slides/convert-pptx-lib.ts (radius/dimension calc for the clipped-container/device corners; the `case \"visual\"`/clipped-container emit — add the >50% radius → 2× image fallback) + renderer/html2slides/convert-pptx-io.ts (capture at 2× / scale for the image fallback) + renderer/html2slides/extract-dom.ts (per-corner radii the container carries).\n" +
    "VERIFY on the AFTER render: slide_12 device frame — bottom corners rounded with the CORRECT radius (no oversized black area), and the top (large-radius) corners rendered crisply via the 2× image fallback (no square notch, no overflow).",
};

export const CLUSTERS: Cluster[] = [
  C_CLIP_CORNERS,
  C_DEVICE,
];
