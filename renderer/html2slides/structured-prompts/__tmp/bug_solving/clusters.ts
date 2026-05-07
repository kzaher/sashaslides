/**
 * Wave-9 cluster — every still-open slide bug, ONE cluster, ONE worker
 * branch. Single-slide retries kept regressing siblings because the
 * underlying issues touch shared territory in extract-dom.ts and
 * convert-pptx.ts. Letting one worker propose a coherent change and
 * validate ALL the slides at once is the safest way to land them.
 *
 * Five slides:
 *   slide_11 — top-border stroke alignment + bullet height
 *   slide_14 — rounded-card top-stripe clip
 *   slide_15 — '200 OK' / cURL chip alignment variants
 *   slide_25 — main text-block line-height (spcPct → spcPts)
 *   slide_30 — chip anchor + .code-block padding (passed wave-7 visual,
 *              included as a regression sentinel — the worker's edits
 *              must NOT break what wave-7 fixed for slide_30)
 *
 * Wave-7 verdict trail (verbatim — don't repeat the dead-ends):
 *
 *   slide_11: 3 retries each claimed to inject algn="in" but the diff
 *             showed "no structural differences". The edits hit
 *             extract-dom.ts (which only changes JSON extraction) but
 *             not convert-pptx.ts's `injectStrokeAlignment` post-
 *             processor (now at line ~1730). VERIFY the produced pptx
 *             slide1.xml differs from baseline before claiming success.
 *
 *   slide_14: every retry's visual reported "Critical regression. Thin
 *             top accent stripe was expanded into a full-width band".
 *             Workers tried to fix the clip by widening the stripe
 *             instead of clipping it through the parent's rounded
 *             geometry. Use a:custGeom with a path that follows the
 *             parent's rounded top corners — flat curve at top-left,
 *             flat curve at top-right, straight bottom. NOT roundRect
 *             with per-corner avLst.
 *
 *   slide_15: visual reported "'200 OK' pill: white text vertically
 *             off". Workers found a partial pattern but the .api-badge
 *             variant has different padding semantics than the generic
 *             .status-badge — they need separate handling, not a single
 *             unified gate that can't tell them apart.
 *
 *   slide_25: 3 retries flipped anchor=ctr→t for one paragraph but
 *             never converted spcPct → spcPts on .text-block. Walk
 *             every <a:p> in the slide's text frames and rewrite
 *             spcPct=N to spcPts=M where M = round(line_height_px *
 *             100 * 0.75). Verify the substitution lands in the
 *             emitted XML.
 *
 *   slide_30: shipped successfully in wave-7 (chip anchor + tIns
 *             padding for .code-block via existing slide_19 path).
 *             Don't break it. The wave-7 worktree (now gone) used
 *             extract-dom + convert-pptx changes that the visual
 *             check passed; aim for compatible edits.
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  {
    task_id: "wave9-multifix-all",
    cluster_description:
      "FIVE slides need a coordinated fix. Single-slide retries (waves 5-7) " +
      "kept failing because each fix regressed a sibling. Tackle them " +
      "together — one branch, one set of edits, validated across all five." +
      "\n" +
      "\nslide_11 (top borders + bullets): edits MUST land via " +
      "convert-pptx.ts's injectStrokeAlignment post-processor (line " +
      "~1730+) — that's the path that actually rewrites <a:ln> in the " +
      "produced slide XML. Wave-7 retries kept editing extract-dom.ts " +
      "and producing empty diffs. Verify the produced pptx differs from " +
      "baseline at the OOXML level before claiming success. Bullet " +
      "vertical alignment on .opportunity-card may also need a " +
      "verticallyCentered/padTop tune." +
      "\n" +
      "\nslide_14 (top stripe clip): the .logo-card has rounded corners " +
      "and an absolutely-positioned ::before stripe at top:0. Wave-7 " +
      "retries 'expanded the stripe into a full-width band' (regression). " +
      "Correct approach: emit the stripe as a:custGeom whose path follows " +
      "the parent's rounded top corners — flat curve at top-left, flat " +
      "curve at top-right, straight bottom. NOT a roundRect with per- " +
      "corner avLst. Look at convert-pptx.ts shape emission for ::before " +
      "pseudos with non-zero parent border-radius." +
      "\n" +
      "\nslide_15 (chip alignment): '200 OK' and 'cURL' chips render " +
      "with vertically-off text. The unified inline-aware horizontal- " +
      "padding gate (extract-dom.ts ~line 1832) covers most chips but " +
      "misses the .api-badge variant which has different padding. " +
      "Inspect the fixture for those specific class names, distinguish " +
      "them in the gate, apply separate handling without regressing " +
      "the .status-badge chips that already work." +
      "\n" +
      "\nslide_25 (line height): main .text-block paragraphs render " +
      "tighter than Chrome baseline. In convert-pptx.ts, walk every " +
      "<a:p> emitted for a .text-block, replace spcPct=N with spcPts=M " +
      "where M = round(line_height_px * 100 * 0.75). Verify the " +
      "substitution lands in slide XML — wave-7 retries kept reporting " +
      "'no spcPts change' in the diff." +
      "\n" +
      "\nslide_30 (regression sentinel — shipped in wave-7): tag chips " +
      "(TypeScript, Node.js, etc.) need anchor=\"ctr\", and .code-block " +
      "text needs tIns padding folded from CSS padding-top via the " +
      "slide_19 padTopPt path. Don't regress this. If your edits to " +
      "extract-dom.ts or convert-pptx.ts break slide_30, the visual " +
      "check will fail the whole task." +
      "\n" +
      "\nIMPORTANT: each slide gets its OWN verdict + visual check. The " +
      "whole 5-slide bundle retries up to 3 times if ANY one regresses. " +
      "Aim for the smallest set of changes that fixes the four broken " +
      "slides without touching slide_30's behavior — don't make 5 " +
      "independent edits that conflict.",
    slide_ids: ["slide_11", "slide_14", "slide_15", "slide_25", "slide_30"],
  },
];
