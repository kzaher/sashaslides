/**
 * ROUND 16 — the still-unsolved complex losses, solved with FABLE (budget 5).
 * 12/19/30 are already green (rated good) and excluded. Remaining:
 *   slide_04 — was fixed but never rated (neutral); re-solve for a rateable result.
 *   slide_13 — the round-15 native-trapezoid fix was REJECTED ("romboids are not
 *              shapes, they are rendered"), so it needs a genuinely-native shape.
 * Launch: LEGACY path (do NOT set BUG_SOLVING_USE_SCHEDULER). Workers now use
 * --model fable (engine fix 27e03c55 makes ctx.model sticky).
 *   BUG_SOLVING_SXS_DIR=/tmp/sxs-complex BUG_SOLVING_RATINGS_JSON=/tmp/sxs-complex/ratings.json
 */
import type { Cluster } from "./workspace-setup.js";

const C_04: Cluster = {
  task_id: "pseudo-glyph-center",
  slide_ids: ["slide_04"],
  retry_budget: 5,
  cluster_description:
    "slide_04 (Product Roadmap) — user: 'Bad tick positioning, not centered.' The ✓ checkmark glyph inside the completed milestone dots (`.dot.done::after{content:'✓';position:absolute;inset:0;display:flex;align-items:center;justify-content:center}`) renders LEFT-aligned instead of centered in the 28px circle. Dot placement is correct — only the ✓ is off.\n" +
    "ROOT CAUSE: renderer/html2slides/extract-dom.ts `emitPseudoText()` (~lines 2029-2101, explicit-left branch ~2043-2057) HARD-SETS `textAlign='left'` for any absolute pseudo with explicit `left`, ignoring that `inset:0` means left==right AND `justify-content:center` — so a flex-centered glyph gets left-aligned.\n" +
    "FIX: keep `textAlign='center'` when the pseudo has BOTH explicit left AND right (inset case) OR `justify-content:center`; only fall to 'left' for genuinely left-anchored `left:0`-WITHOUT-right markers.\n" +
    "CRITICAL — DO NOT REGRESS slide_19: its `.pain::before{left:0}`/`.touchpoint::before{left:0}` are genuinely left-anchored and must stay left. Render slide_19 too and confirm its markers didn't move.\n" +
    "VERIFY: the ✓ is centered in both done dots (matches target); slide_19 markers unchanged.",
};

const C_13: Cluster = {
  task_id: "funnel-trapezoid-native",
  slide_ids: ["slide_13"],
  retry_budget: 5,
  cluster_description:
    "slide_13 (Marketing Funnel) — user: 'Why are there so many rendered regions on the right... should be some shape; text should never be rendered.' The 4 funnel stage bodies (`.stage-shape{clip-path:polygon(0 0,100% 0,95% 100%,5% 100%)}`, fixture lines 13-16) are RASTERIZED to PNGs.\n" +
    "PRIOR ATTEMPT REJECTED (round 15): a native-trapezoid emit was tried but the user said 'romboids are not shapes, they are rendered' — i.e. the trapezoids STILL came out rasterised (or the shape/orientation was wrong). So the previous change did NOT actually stop the rasterisation for these elements. Verify by pixel-probing the AFTER render that the stage bodies are flat-color VECTOR trapezoids (crisp edges, editable), NOT bitmaps.\n" +
    "ROOT CAUSE to fix properly: extract-dom.ts ~lines 2266-2288 `hasCssVisual` treats ANY non-trivial clip-path as a rasterise trigger → `type:'visual'` PNG per stage (convert-pptx-lib.ts `case 'visual'` ~3091). There is NO polygon/trapezoid/custGeom native path.\n" +
    "FIX: for a `polygon()` clip-path of 4 points forming a symmetric trapezoid (top full-width, bottom inset symmetrically — true for all 4 stages), emit a NATIVE shape (`type:'shape', shape:'trapezoid'` → pptxgenjs `addShape('trapezoid',{fill,flipV/rotate})`) INSTEAD of `type:'visual'`, and make SURE the `hasCssVisual` bitmap branch does NOT also fire for it (else you get both). Keep the bitmap fallback only for non-trapezoidal/conic cases. Children still re-walk for native editable text.\n" +
    "VERIFY (pixel-probe, don't trust the diff): AFTER render shows 4 editable solid-color VECTOR trapezoids + native text, ZERO rasterised regions on the right; orientation + colors match target.",
};

export const CLUSTERS: Cluster[] = [C_04, C_13];
