/**
 * Wave-8 cluster — ONE big cluster covering every slide that wave-7's
 * single-slide attempts couldn't land. Single-slide retries hit a
 * dead-end on each because the underlying issues are entangled
 * (top-border / clip-path / chip-anchor logic touches a shared region
 * of extract-dom.ts and convert-pptx.ts that 3 single-slide attempts
 * couldn't refactor cleanly).
 *
 * Strategy: hand every failure to ONE worker on ONE branch so it can
 * propose a refactor that addresses all four at once, validate via the
 * existing verdict + visual gates per slide, retry up to 3 times.
 *
 * Wave-7 verdict trail (kept verbatim so the worker doesn't repeat the
 * dead-ends):
 *
 *   slide_11 — "edits-not-landing": three retries each claimed to
 *              inject algn="in" into <a:ln> but the diff-pptx report
 *              consistently showed "no structural differences". Edits
 *              were not reaching the produced pptx because they were
 *              made to extract-dom.ts (which only changes the JSON
 *              extraction), while the actual injection should go
 *              through convert-pptx.ts's `injectStrokeAlignment`
 *              post-processor (which now exists at line 1730+ on main).
 *
 *   slide_14 — "clip-path-mask": every retry's visual check reported
 *              "Critical regression. Thin top accent stripe was
 *              expanded into a full-width band". The workers tried to
 *              fix the clip by expanding the stripe rather than
 *              clipping it through the parent's rounded geometry. They
 *              need to use a custGeom-based clip, NOT a roundRect with
 *              per-corner avLst.
 *
 *   slide_15 — "200ok-curl-chips": visual reported "Two chip-family
 *              alignment defects remain. '200 OK' pill: white text
 *              vertically off." Workers found a partial pattern but
 *              the .api-badge variant has different padding semantics
 *              than the generic .status-badge — they need separate
 *              handling, not a single unified gate.
 *
 *   slide_25 — "line-height-pitch": three retries all flipped
 *              anchor=ctr → t for one paragraph but never converted
 *              the spcPct → spcPts on the .text-block. The fix needs
 *              to walk every <a:p> in the slide's text frames and
 *              rewrite spcPct values to equivalent spcPts (computed
 *              from the line-height in CSS px → 100ths of pt).
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  {
    task_id: "wave8-multifix",
    cluster_description:
      "FOUR slides need fixes that wave-7's single-slide retries couldn't " +
      "land. The root issues touch shared territory in extract-dom.ts and " +
      "convert-pptx.ts; isolated single-slide attempts kept regressing one " +
      "while attempting to fix another. Tackle all four together. The four:" +
      "\n" +
      "\n  slide_11 (top borders): edits must go through " +
      "convert-pptx.ts's injectStrokeAlignment post-processor (now at " +
      "line ~1730) to add algn=\"in\" to <a:ln> stroke elements. " +
      "verticallyCentered/padTop interactions on .opportunity-card may " +
      "also need tuning for bullet height. Wave-7 retries failed to land " +
      "the pptx-XML change at all — verify the diff is non-empty before " +
      "claiming success." +
      "\n" +
      "\n  slide_14 (top stripe clip): the .logo-card has rounded corners " +
      "and a top accent stripe. Wave-7 retries 'expanded the stripe into " +
      "a full-width band' (regression). Correct approach: emit the stripe " +
      "as a custom geometry (a:custGeom) whose path follows the parent's " +
      "rounded top corners — flat curve at top-left, flat curve at " +
      "top-right, straight bottom. NOT a roundRect with per-corner avLst " +
      "(that's what the failed attempts tried). " +
      "\n" +
      "\n  slide_15 (chip alignment): '200 OK' and 'cURL' chips still " +
      "misalign. Wave-7 retries said the unified inline-aware " +
      "horizontal-padding gate fired but those specific chips have " +
      "different padding semantics. Inspect the fixture for those " +
      "specific class names (.api-badge vs .status-badge), distinguish " +
      "them in the gate, and apply separate handling without regressing " +
      "the chips that already work." +
      "\n" +
      "\n  slide_25 (line height): main .text-block paragraphs render " +
      "tighter than the Chrome baseline. Wave-7 retries kept flipping " +
      "anchor=ctr→t for one paragraph but never replaced spcPct with " +
      "spcPts. The fix: in convert-pptx.ts, walk every <a:p> emitted for " +
      "a .text-block, and rewrite spcPct=N to spcPts=M where " +
      "M = round(line_height_px * 100 * 0.75). Verify the substitution " +
      "lands in the emitted XML — wave-7 retries reported 'no spcPts " +
      "change' in the diff." +
      "\n" +
      "\n IMPORTANT: each slide gets its OWN verdict + visual check. The " +
      "wave will retry the WHOLE 4-slide cluster up to 3 times; if any " +
      "single slide regresses on a retry, the whole task retries. Make " +
      "the smallest set of changes that solves all four — don't make 4 " +
      "independent edits that conflict.",
    slide_ids: ["slide_11", "slide_14", "slide_15", "slide_25"],
  },
];
