/**
 * Wave-12 — four parallel clusters covering the 10 bad-rated slides post the
 * second-pass review of /tmp/sxs-complex.
 *
 * Themes the user surfaced this round:
 *
 *   A. Native-vs-rasterize: text and simple chips/circles are being baked
 *      into PNG images instead of emitted as native pptx shapes + native
 *      text. User: "text should never be baked into images".
 *
 *   B. Clipping masks: top-border clip on cards (.swot, .logo-card) and
 *      bottom halo on the .device come from rasterising a parent's
 *      `overflow:hidden + border-radius` region into a rectangular PNG.
 *      User: "inherit clipping mask from parent and then try to construct
 *      clipped element from the mask or render the top border".
 *
 *   C. Vertical text position: several text blocks render visibly HIGHER
 *      than the Chrome capture. Same symptom on slides 06, 17, 25; likely
 *      one root cause in the textbox baseline / line-height / padding-top
 *      interaction.
 *
 *   D. Bullet-list emission: the literal-space marker bug is still here
 *      after wave-11A's fix didn't land. slide_30 says "if you can't
 *      colour the bullets, monochrome is fine" — so the gate that disables
 *      native bullets the moment per-item colours differ is the actual
 *      bug; native bullets in the deck's default text colour are
 *      acceptable.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WAVE-11 VERDICT TRAIL (verbatim — preserve across waves)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   wave-11A (slide_11 bullets): worker authored a fix on
 *     .claude/worktrees/bs-wave11A-bullet-lists-* but it was NOT merged
 *     into main. The user still sees the bullets bug. Re-derive cleanly
 *     in wave-12D rather than pulling the worktree's WIP — the user's
 *     second-pass comment explicitly says "if bullets can't be coloured,
 *     monochrome is fine", which simplifies the fix significantly (no
 *     need for the <a:buClr> XML injection).
 *
 *   wave-11B (slide_12 bottom leftovers): worker authored a pngjs alpha
 *     mask on /workspaces/sashaslides/.claude/worktrees/bs-wave11B-* but
 *     the verification step OOM'd at JSON.stringify. The fix is the
 *     RIGHT shape (alpha-mask the captured PNG's corner cutouts) but
 *     wave-12 should consider whether the user's "use clipping mask"
 *     direction means a different solution entirely (native pptx
 *     clipping shape rather than alpha-masking a PNG).
 *
 *   wave-11C (slide_14 chip borders): worker authored a fix on
 *     bs-wave11C-chip-borders-*. Not merged. User's wave-12 comment
 *     reframes the goal: rather than fixing the border colour, FIX the
 *     ROOT cause (the top stripe shouldn't be a captured PNG at all —
 *     it should be a native shape with the parent's clipping mask
 *     applied). So wave-12B subsumes wave-11C.
 *
 *   slide_25 (wave-10A target — was Good after the line-height narrow):
 *     REGRESSED this pass. User says "the entire text is moved up".
 *     Goes in wave-12C with slide_06 + slide_17.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Slide ↔ cluster routing summary
 *   slide_06 → 12C
 *   slide_07 → 12A
 *   slide_11 → 12B + 12D  (clipping AND bullets are independent fixes)
 *   slide_12 → 12B
 *   slide_13 → 12A
 *   slide_14 → 12B
 *   slide_15 → 12A
 *   slide_17 → 12C
 *   slide_25 → 12C
 *   slide_30 → 12D
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  // ─────────────────────────────────────────────────────────────────────
  // WAVE-12A — prefer native shapes + native text over PNG rasterisation
  //
  // The user's first-principles objection: "text should never be baked
  // into images". Today's pipeline rasterises any element tagged "visual"
  // or "image" via Page.captureScreenshot (extract-dom side). For chips,
  // small icon circles, and stat tiles, this loses editability AND drops
  // resolution at thumbnail size.
  //
  // The fix is a refactor in extract-dom.ts: distinguish "genuinely
  // un-recapturable" (conic-gradient, clip-path masks, SVG filters,
  // canvas glyph art) from "complex DOM region but composable as native
  // pptx shapes + native text". Default to native; only rasterise when
  // the element CANNOT be expressed as primitives.
  // ─────────────────────────────────────────────────────────────────────
  {
    task_id: "wave12A-prefer-native",
    cluster_description:
      "Three slides where the user objects to text being baked into PNG " +
      "images. The unifying principle: pptx should emit native shapes + " +
      "native text wherever possible; only genuinely un-recapturable DOM " +
      "regions (conic-gradient, clip-path masks, complex SVG filters, " +
      "canvas glyph art) should fall back to captured PNG." +
      "\n" +
      "\nPER-SLIDE CONTEXT (verbatim user comments from " +
      "/tmp/sxs-complex/ratings.json):" +
      "\n  slide_07 — 'Why are bottom icons rendered? Also why are top " +
      "circles rendered, can't we use svgs?'  Today these are rasterised; " +
      "user wants the SVG icons forwarded as inline SVG (or extracted from " +
      "DOM as a native pptx shape with same path)." +
      "\n  slide_13 — 'Why are there so many rendered regions on the right, " +
      "this looks like it should be possible to use some shape, text should " +
      "never be rendered, if you need to render then render without text " +
      "(text hidden), and then put text as children so it's editable. these " +
      "32% conversion and other similar chips definitely look like they " +
      "should be achievable by using shapes. If not possible explain why " +
      "but make sure that the text is never baked into images.'" +
      "\n  slide_15 — 'Why can't you make the text just a single text area, " +
      "at least why can't you make each line one text? I would expect that " +
      "if there are spans inside of div, they should just mark style.'" +
      "\n" +
      "\nROOT-CAUSE INVESTIGATION (do this FIRST):" +
      "\n  1. Read extract-dom.ts and find the predicate that decides " +
      "     'visual' / 'image' vs native-decomposed. Where does an element " +
      "     get tagged with type='visual'? List every reason." +
      "\n  2. For each rasterised element on slide_13 (the .stat-card chips " +
      "     with '32% conversion' etc.), identify why extract-dom captured " +
      "     it instead of walking children. Is it because of:" +
      "\n       (a) a CSS clip-path that pptx can't represent?" +
      "\n       (b) overflow:hidden + border-radius?" +
      "\n       (c) a backdrop-filter / gradient that requires compositing?" +
      "\n       (d) something else?" +
      "\n  3. Same investigation for slide_07 icons (.icon-circle elements " +
      "     containing inline <svg>) and slide_15 .chip / .api-badge / " +
      "     .status-badge that today render as image with baked text." +
      "\n" +
      "\nFIX STRATEGY (after root-cause investigation):" +
      "\n  - For each case where extract-dom rasterises because of " +
      "    overflow:hidden + border-radius: the contained children CAN be " +
      "    emitted as native pptx elements clipped by an outer roundRect. " +
      "    pptxgenjs has no native clip-path, BUT we can fake it by " +
      "    emitting children + a roundRect with the parent's background as " +
      "    fill OVER the children's overflow region. This is the same " +
      "    direction wave-12B is taking for slide_11/12/14 — coordinate." +
      "\n  - For inline SVGs (slide_07 icons): forward as native pptx via " +
      "    pptxgenjs's existing image-from-svg path or emit the SVG as a " +
      "    custGeom path." +
      "\n  - For text-bearing chips (slide_13/15): walk DOM children, emit " +
      "    the background shape as native (with gradient + border via " +
      "    existing rect path) and overlay native text on top." +
      "\n" +
      "\nVERIFICATION: produced .pptx must contain ZERO <p:pic> elements " +
      "for slide_07's icons, slide_13's stat chips, or slide_15's badge " +
      "rows. Open the produced pptx in Slides and confirm text is " +
      "selectable (not part of an image). Don't regress slide_19 / " +
      "slide_27 (which DO have legitimate captured visuals).",
    slide_ids: ["slide_07", "slide_13", "slide_15"],
  },

  // ─────────────────────────────────────────────────────────────────────
  // WAVE-12B — clipping-mask approach for overflow:hidden parents
  //
  // The user's direction: "inherit clipping mask from parent and then
  // try to construct clipped element from the mask or render the top
  // border". The current pipeline either (a) captures the parent as a
  // rectangular PNG (slide_12 device, slide_11/14 cards) or (b) emits
  // a separate stripe shape that paints OUTSIDE the parent's rounded
  // border (slide_11 SWOT top stripe overshoot).
  //
  // Wave-11C tried a different angle (custGeom for the top stripe) but
  // wasn't accepted. Wave-12B reframes: treat overflow:hidden +
  // border-radius parents as defining a clipping shape, and emit
  // ALL their children (including pseudo-element stripes) as native
  // pptx shapes whose geometry is masked by that clipping shape.
  // ─────────────────────────────────────────────────────────────────────
  {
    task_id: "wave12B-clip-masks",
    cluster_description:
      "Three slides whose root cause is the same: the converter does not " +
      "respect the parent's overflow:hidden + border-radius as a clipping " +
      "shape. Today it either rasterises the whole parent region into a " +
      "rectangular PNG (capturing parent-background pixels in the corner " +
      "cut-outs → 'gray leftovers' on slide_12) or emits child stripes " +
      "that paint OUTSIDE the parent's rounded border (overshooting top " +
      "border on slide_11, wrong-coloured top stripe on slide_14)." +
      "\n" +
      "\nUSER'S DIRECTION (verbatim):" +
      "\n  slide_11 — 'Positioning of the text is wrong, it's somehow too " +
      "high. The top border is also wrong. It should inherit clipping mask " +
      "from parent and then try to construct clipped element from the mask " +
      "or render the top border.'  (Text-position part is ALSO in 12C — " +
      "wave-12B owns the top-border / clipping part only.)" +
      "\n  slide_12 — 'On the bottom part there are gray leftovers.'  " +
      "The .device's bbox corners contain parent-background pixels in the " +
      "captured PNG. Wave-11B alpha-masked them via pngjs but that was " +
      "never merged; the user's wave-12 direction suggests a NATIVE pptx " +
      "fix instead." +
      "\n  slide_14 — 'The top seems to be clipped like expected. Make " +
      "sure that the clipping mask passed from parent is applied correctly " +
      "and either makes the top border rendered, or ideally uses some " +
      "shape with clipping (which I think should be possible).'" +
      "\n" +
      "\nROOT-CAUSE INVESTIGATION:" +
      "\n  1. In extract-dom.ts, find where overflow:hidden parents are " +
      "     processed. Today they probably become a 'clipped-container' " +
      "     visual element (PNG capture). When does this fire?" +
      "\n  2. The SWOT-stripe-merge branch (extract-dom.ts ~line 1417-1437 " +
      "     in HEAD) merges the .card::before top stripe upward. Confirm " +
      "     whether it currently respects the .card's border-radius — " +
      "     does the merged stripe have rounded TOP corners to match the " +
      "     card's clip, or does it paint flat across the top?" +
      "\n  3. For slide_14's logo cards: same pattern, but the stripe " +
      "     colour comes from a different selector. Is wave-9's chip " +
      "     handling forwarding the wrong colour?" +
      "\n" +
      "\nFIX STRATEGY:" +
      "\n  - For overflow:hidden + border-radius parents: instead of " +
      "    rasterising the parent, emit a clipping-shape descriptor on the " +
      "    parent's rect element so child shapes know to mask their " +
      "    geometry against it. In pptx, this can be approximated by:" +
      "\n      (a) emitting the parent's rect with the same border-radius " +
      "          and `clip='in'` (where pptxgenjs supports it), OR" +
      "\n      (b) post-processing the saved XML to wrap a `<p:grpSp>` " +
      "          with a `<a:clipPath>` reference around the parent + " +
      "          children, OR" +
      "\n      (c) child shapes truncating their own geometry to the " +
      "          parent's roundRect (computed at build time)." +
      "\n  - For top stripes (.card::before, .logo-card::before): emit " +
      "    them with the parent's per-corner border-radius applied to " +
      "    the top corners only (round2SameRect preset, already used " +
      "    elsewhere in convert-pptx-lib.ts)." +
      "\n  - For slide_12's .device bottom halo: the captured PNG must " +
      "    not bleed pixels past the rounded shape. Either alpha-mask " +
      "    the PNG (wave-11B approach, fix the OOM) or emit the .device " +
      "    as a native roundRect with the same box-shadow expressed as " +
      "    a pptx shadow." +
      "\n" +
      "\nVERIFICATION:" +
      "\n  - slide_11 top edge: card top stripes render rounded at top " +
      "    corners (matching the card's border-radius), NOT overshooting " +
      "    left/right edges." +
      "\n  - slide_12: NO gray pixels visible below the rendered device's " +
      "    rounded bottom edge." +
      "\n  - slide_14: center chip top stripes render in the gray colour " +
      "    seen in the original (not the accent colour).",
    slide_ids: ["slide_11", "slide_12", "slide_14"],
  },

  // ─────────────────────────────────────────────────────────────────────
  // WAVE-12C — text rendered visibly HIGHER than the Chrome capture
  //
  // Three independent slides, one symptom: the rendered text sits a few
  // pixels above where it should. Wave-10A narrowed the line-height
  // override; wave-10B added the centred-anchor clause; both shipped.
  // The remaining offset is small enough that it's likely a different
  // root cause — probably either:
  //   (a) `padTopPt` (folded CSS padding-top into the textbox top inset)
  //       firing where it shouldn't, OR
  //   (b) the `lineSpacingMultiple=1.2` pin (the wave-1b "stable Slides
  //       default") nudging glyph baselines up at certain font sizes, OR
  //   (c) the `applySlack` symmetric vertical expansion mis-computing
  //       on rotated text.
  //
  // slide_25 went from GOOD (wave-10A landed) to BAD this pass — could
  // be a fresh regression introduced after wave-10A, or could be Slides-
  // server rendering noise. Investigate first before claiming a fix.
  // ─────────────────────────────────────────────────────────────────────
  {
    task_id: "wave12C-vertical-text-position",
    cluster_description:
      "Three slides where text renders visibly higher than the Chrome " +
      "capture. Symptom is small (a few pixels) but consistent." +
      "\n" +
      "\nUSER COMMENTS (verbatim):" +
      "\n  slide_06 — 'Center text is moved or aligned wrong. On the " +
      "original it's lower, also the Quote is positioned too high.'" +
      "\n  slide_17 — 'Series A Founded and $15M are moved a bit up. " +
      "Investigate why and fix this.'" +
      "\n  slide_25 — 'The entire text is for some reason moved up, both " +
      "main text and in the bottom banner. Understand why and fix.'  " +
      "(REGRESSION — slide_25 was Good after wave-10A; this pass it's " +
      "Bad. Worth diff'ing slide_25's current pptx XML against the " +
      "wave-10A-Good state to identify what changed.)" +
      "\n" +
      "\nROOT-CAUSE INVESTIGATION (do this first — symptom is too vague " +
      "to fix blindly):" +
      "\n  1. Capture slide_06, slide_17, slide_25 pptx XML and find the " +
      "     <p:sp> for the mis-positioned text. Compare to the original " +
      "     Chrome render's bounding box (the y / h that extract-dom " +
      "     emitted). Is the SHAPE positioned correctly but the TEXT " +
      "     inside it sitting too high, or is the entire shape at the " +
      "     wrong y?" +
      "\n  2. If shape position is correct: investigate the textbox's " +
      "     <a:bodyPr> tIns and the paragraph's <a:lnSpc>. The wave-1b/" +
      "     wave-10A formulas might be over-correcting for centred or " +
      "     measured-pitch paragraphs." +
      "\n  3. If shape position is WRONG: check whether extract-dom " +
      "     emits the bound for the parent shape with rotated children " +
      "     accounted for, or whether the bound is post-padding." +
      "\n" +
      "\nFIX STRATEGY:" +
      "\n  Defer until root cause is identified. Likely candidates:" +
      "\n    - Adjust `padTopPt` gate in emitStyledText to fire only when " +
      "      the source has padding-top AND a sibling visible inside the " +
      "      box (the slide_19 .touchpoint::before bullet case)." +
      "\n    - Restrict the `lineSpacingMultiple=1.2` pin to the wave-1b " +
      "      cases that actually need it (single-line centred shape text), " +
      "      not all centred text." +
      "\n    - Re-examine emitStyledText's `bx/by/bw/bh` computation for " +
      "      rotation symmetric-slack on slide_06 .quote-mark (which uses " +
      "      `transform: rotate(...)` + opacity)." +
      "\n" +
      "\nVERIFICATION: slide_06/_17/_25 rendered thumbnail text positions " +
      "match the Chrome capture within 1 px vertically. slide_19, slide_29 " +
      "and other slides that ride wave-10B's anchor=ctr clause must not " +
      "regress.",
    slide_ids: ["slide_06", "slide_17", "slide_25"],
  },

  // ─────────────────────────────────────────────────────────────────────
  // WAVE-12D — bullet-list emission (literal-space marker → real bullets)
  //
  // Wave-11A diagnosed this correctly: when a list has per-item ::before
  // colours, convert-pptx-lib.ts:1088 forces useNativeBullet=false and
  // falls through to a literal "•  " prefix (no <a:buChar>). Wave-11A
  // wrote a fix on disk but the user never merged it — they re-rated
  // both slide_11 and slide_30 as bad this pass.
  //
  // KEY SIMPLIFICATION (slide_30 verbatim): "It uses spacing for padding
  // between bullet and text, can't bullets be colored, it not, then it's
  // fine!" — the user accepts MONOCHROME native bullets if per-colour
  // bullets are hard. This means we can SKIP the <a:buClr> XML injection
  // wave-11A planned and just use native pptxgenjs bullets in the deck's
  // default text colour for these lists. Vastly simpler fix.
  // ─────────────────────────────────────────────────────────────────────
  {
    task_id: "wave12D-bullet-lists",
    cluster_description:
      "Two slides whose lists still render with literal-space marker " +
      "prefixes (slide_11 SWOT, slide_30 Key Priorities). The user " +
      "explicitly relaxed the requirement on slide_30: monochrome native " +
      "bullets are acceptable if per-colour bullets are hard." +
      "\n" +
      "\nUSER COMMENTS:" +
      "\n  slide_11 — 'Positioning of the text is wrong [...]. The top " +
      "border is also wrong.'  Note: slide_11's positioning + clipping " +
      "issues are in 12B/12C; THIS cluster (12D) only addresses the " +
      "bullets/list emission half of slide_11's bug." +
      "\n  slide_30 — 'It uses spacing for padding between bullet and " +
      "text, can't bullets be colored, it not, then it's fine!'" +
      "\n" +
      "\nROOT CAUSE (verified by wave-11A worker):" +
      "\nconvert-pptx-lib.ts line ~1088 gates useNativeBullet on " +
      "  !anyItemHasStyledRuns && !anyPerItemBulletColor" +
      "When any item has a per-item ::before colour (slide_11 SWOT, " +
      "slide_30 Key Priorities), useNativeBullet flips to false and the " +
      "code falls through to a marker='•  ' (bullet + 2 spaces) prefix. " +
      "No <a:buChar>, no real bulleted list, wrap-and-indent broken." +
      "\n" +
      "\nFIX STRATEGY (simpler than wave-11A):" +
      "\n  - REMOVE the anyPerItemBulletColor gate from useNativeBullet. " +
      "    Always use native pptxgenjs bullets when items aren't styled. " +
      "    pptxgenjs emits <a:buChar> tinted by the run colour. Per-item " +
      "    bullet colour is LOST (the user accepts monochrome) — bullets " +
      "    will inherit the item's text colour or the list's default " +
      "    colour, not the ::before colour." +
      "\n  - Do NOT add <a:buClr> XML post-processing — explicitly out of " +
      "    scope per the user's slide_30 comment." +
      "\n  - Confirm slide_11 SWOT bullets word-wrap correctly (the real " +
      "    user complaint that 'spaces' broke). slide_30 priorities " +
      "    likewise should wrap cleanly." +
      "\n" +
      "\nVERIFICATION:" +
      "\n  - slide_11 rendered XML: <a:buChar char=\"&#x2022;\"/> on " +
      "    every SWOT list paragraph. No <a:buClr> required." +
      "\n  - slide_30 rendered XML: same — bullets present, monochrome." +
      "\n  - The four SWOT cards on slide_11 are word-wrapped, not " +
      "    space-padded." +
      "\n  - Plain monochrome lists elsewhere in the deck (if any) still " +
      "    render correctly." +
      "\n  - SLIDE_30 anchor for chip labels (TypeScript, Node.js, …) " +
      "    must NOT regress (anchor='ctr' from wave-10B stays valid).",
    slide_ids: ["slide_11", "slide_30"],
  },
];
