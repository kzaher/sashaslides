/**
 * ROUND 13 — slide_12 only. Rounds 10-12 FALSE-PASSED: a worker keeps claiming
 * "solved" while the real defect remains. A direct visual diagnosis of the
 * round-12 render vs the target + the user's annotation pins it down (below).
 * Running under the NEW state-machine scheduler (BUG_SOLVING_USE_SCHEDULER=1).
 * CLAUDE ONLY, up to 10 attempts. Set
 * BUG_SOLVING_SXS_DIR=/workspaces/sashaslides/.sxs-recheck and
 * BUG_SOLVING_RATINGS_JSON=/workspaces/sashaslides/.sxs-recheck/ratings.json.
 */
import type { Cluster } from "./workspace-setup.js";

const C_DEVICE: Cluster = {
  task_id: "device-corner-image",
  slide_ids: ["slide_12"],
  retry_budget: 10,
  cluster_description:
    "DEVICE MOCKUP slide_12 — the ONE real defect (confirmed by a direct visual diff of the current render vs the target + the user's annotation; prior rounds wrongly declared it solved): the phone SCREEN's top renders as a HARD SQUARE BLACK BAND spanning the full width with SQUARED top corners, instead of the target's soft ROUNDED top where the LIGHT gradient reaches the rounded corners. There is far TOO MUCH BLACK across the top (oversized black status band + black notch block dominate the upper screen); the target has only a THIN tinted status strip and a small notch pill.\n" +
    "ROOT CAUSE to fix: the rounded-corner clip/mask on the screen BACKGROUND is wrong, and the 2x-image rasterise gate is rasterising the WHOLE top region (the dark status bar + the squared top corners) as one big black block. CORRECT BEHAVIOUR: (1) the screen gradient background must fill all the way to the device's ROUNDED top corners (border-radius ~32px) — the top corners must be ROUNDED and show the LIGHT gradient, NOT squared black. (2) Only the genuinely un-representable thin status-bar strip / notch should be rasterised — NOT the whole top band; minimise the black so the diagonal/top matches the target. (3) The gradient direction is already acceptable — do NOT regress it.\n" +
    "Compare your AFTER render to renderer/html2slides/e2e/fixtures/slide_12.html rendered in Chrome: the top must look like the TARGET (rounded light-gradient top + thin dark status strip), not a big black rectangle.\n" +
    "CODE: renderer/html2slides/convert-pptx-lib.ts (the clipped-container/device corner-radius mask + the >50%-radius rasterise gate — currently rasterising too much; the screen-background rounding) + renderer/html2slides/convert-pptx-io.ts (the 2x image capture region — capture/rasterise ONLY the thin status strip, not the full top) + renderer/html2slides/extract-dom.ts (per-corner radii for the screen background).\n" +
    "VERIFY on the AFTER Google-Slides render (the verdict opens the user's annotation — the marks are on the TOP black band / corner region, NOT the feature icons): the phone screen's top corners are ROUNDED and show the light gradient, there is only a thin dark status strip (far less black), and nothing extra is rasterised.",
};

export const CLUSTERS: Cluster[] = [
  C_DEVICE,
];
