/**
 * Wave-7 clusters — derived from user SxS ratings on wave-6d outputs.
 * One bad slide per cluster for maximum parallelism.
 *
 * From wave-6d user verdicts:
 *   slide_11 — FAILED (3/3 retries empty diff): worker's edits never
 *              landed in pptx XML. Carries forward; needs a different
 *              cluster framing so the worker doesn't repeat the same
 *              dead-end algn="in" injection.
 *   slide_14 — BAD: "The rounded border should create a clip area mask,
 *              and then the top border should be clipped using this
 *              mask and rendered. Right now it's just smaller." — the
 *              recent half-shift change avoided overlapping the border
 *              but leaves the stripe noticeably narrower than the card.
 *              The user wants a CLIP-PATH approach instead.
 *   slide_15 — BAD: "The alignment is off for 200 ok, cURL." — most chips
 *              fixed but specific status badges ('200 ok', 'cURL') still
 *              misalign. Likely a chip variant the unified gate misses.
 *   slide_17 — GOOD ✓ (merged in this commit's predecessor).
 *   slide_19 — GOOD ✓ (merged).
 *   slide_25 — BAD: "The line height compared to pptx is wrong in the
 *              main text, otherwise looks ok." — the spcPts substitution
 *              is partial; line pitch still drifts on .text-block.
 *   slide_30 — BAD: "Chips are aligned top and not center and text in
 *              code sample is aligned top and is missing some padding."
 *              — chips need anchor="ctr" instead of "t"; .code-block
 *              still missing tIns padding.
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  {
    task_id: "slide_11-edits-not-landing",
    cluster_description:
      "On slide_11 THREE prior retries (wave-6d) all produced EMPTY diffs " +
      "— the worker analyzed the bug, claimed to apply a fix (algn=\"in\" " +
      "injection, then 4×{x:+1,y:+1,w:-2,h:-2} on roundRects), but " +
      "diff-pptx-pairs.ts reported '(no structural differences detected)' " +
      "every time. The fix is NOT landing in convert-pptx.ts's emit path. " +
      "DIAGNOSE FIRST before fixing: " +
      "(1) Run the baseline build and the post-fix build in the worktree " +
      "and confirm the post-fix .pptx file's mtime actually changed and " +
      "the slide1.xml inside differs. " +
      "(2) If pptx is unchanged, check whether the file you edited is " +
      "actually imported by convert-pptx.ts — there may be multiple copies " +
      "of extract-dom.ts in the repo and Edit may have hit a stale one. " +
      "(3) Only after confirming edits land, address the original bug: " +
      "the SWOT card's TOP BORDER is missing/trimmed and BULLETS sit at " +
      "wrong vertical height. Top-border issue is sibling to slide_14 " +
      "(rounded-mask clip family); bullet height likely needs the " +
      "verticallyCentered/padTop interaction debugged on .opportunity-card.",
    slide_ids: ["slide_11"],
  },
  {
    task_id: "slide_14-clip-path-mask",
    cluster_description:
      "On slide_14 the .logo-card has rounded corners and an absolutely " +
      "positioned top accent stripe (::before with background-color and " +
      "top:0). The wave-6d half-shift fix kept the parent border visible " +
      "but the user reports: 'The rounded border should create a clip " +
      "area mask, and then the top border should be clipped using this " +
      "mask and rendered. Right now it's just smaller.' " +
      "The right approach is OOXML CLIP-PATH/MASK, not size reduction. " +
      "OOXML doesn't have CSS-equivalent clip-path, but you can: " +
      "(a) Emit the stripe as a CUSTOM GEOMETRY (a:custGeom) whose path " +
      "follows the parent's rounded corners — flat top-left curve, flat " +
      "top-right curve, straight bottom. This makes the stripe TRACE the " +
      "card's curve instead of being inset from it. " +
      "(b) Alternative: emit the stripe as a fully clipped roundRect with " +
      "the same border-radius as the parent at top corners, 0 at bottom " +
      "corners — Slides supports per-corner radii via avLst on roundRect. " +
      "Look at convert-pptx.ts shape emission for ::before pseudos with " +
      "non-zero parent border-radius. The current code clamps the " +
      "stripe's radius to min(w,h)/2 which produces the user's 'just " +
      "smaller' artifact. Try the per-corner radii path first.",
    slide_ids: ["slide_14"],
  },
  {
    task_id: "slide_15-200ok-curl-chips",
    cluster_description:
      "On slide_15 most status chips render correctly after the wave-6d " +
      "fix, but the user reports: 'The alignment is off for 200 ok, cURL.' " +
      "Inspect those two specific chips — '200 ok' and 'cURL' — in the " +
      "fixture and figure out what makes them different from the others " +
      "that DID get fixed. Possible variants: monospace font-family, " +
      "different padding, different background (success-green vs neutral- " +
      "gray), inline-block vs flex parent. The unified inline-aware " +
      "horizontal-padding gate (extract-dom.ts ~line 1832) handles most " +
      "chips; find the variant the gate misses and extend it. Don't " +
      "regress the chips that are already working.",
    slide_ids: ["slide_15"],
  },
  {
    task_id: "slide_25-line-height-pitch",
    cluster_description:
      "On slide_25 the user's verdict: 'The line height compared to pptx " +
      "is wrong in the main text, otherwise looks ok.' The wave-5/wave-6 " +
      "spcPts substitution was supposed to fix this — and the visual " +
      "check passed in wave-6d — but the user can still see line-pitch " +
      "drift in the main text block. Investigate: " +
      "(1) Verify the .text-block paragraphs are emitting spcPts AND that " +
      "the spcPts value matches Chrome's actual line-height (computed " +
      "style line-height in px → spcPts in 100ths of pt = px * 100 * 0.75). " +
      "(2) Check whether OTHER paragraph types on slide_25 (headers, " +
      "captions) are stuck on spcPct and need the same conversion. " +
      "(3) Confirm the conversion factor is exact — Chrome's CSS " +
      "line-height treatment vs Slides' line-spacing-points may differ " +
      "by a small constant factor (some renderers use 1.2× font-size as " +
      "default, others 1.15×). Calibrate empirically by measuring " +
      "Chrome render line pitch vs Slides scrape line pitch.",
    slide_ids: ["slide_25"],
  },
  {
    task_id: "slide_30-chip-anchor-and-code-padding",
    cluster_description:
      "On slide_30 the user's verdict: 'Chips are aligned top and not " +
      "center and text in code sample is aligned top and is missing some " +
      "padding.' Two distinct problems: " +
      "(1) Tag chips (TypeScript, Node.js, etc.) currently emit " +
      "anchor=\"t\". Should be anchor=\"ctr\" (vertically centered). " +
      "Look at the verticallyCentered detection in extract-dom.ts: the " +
      "tag chips have padding (e.g. 6px 12px) AND height ≈ line-height + " +
      "12px → padTop≈6 ≥5 should trigger verticallyCentered=true. Verify " +
      "it actually does AND that convert-pptx.ts maps verticallyCentered " +
      "→ valign=\"middle\" (which produces anchor=\"ctr\"). " +
      "(2) The .code-block text is anchored top but needs SOME tIns " +
      "padding so the first line isn't flush against the box edge. The " +
      "fixture has padding:14px on .code-block. The new convert-pptx.ts " +
      "padTopPt logic from slide_19 should fold this into margin[3], BUT " +
      "verify .code-block actually goes through the styled-text emitter " +
      "(not a different code path). If extract-dom emits .code-block " +
      "with paddingTop=0 (because of the unified gate stripping it), " +
      "you need to preserve paddingTop for code blocks specifically.",
    slide_ids: ["slide_30"],
  },
];
