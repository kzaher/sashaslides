/**
 * Loss clusters for the html2slides converter, grouped by ROOT CAUSE (not by
 * slide) so the engine fixes each cause once and verdict-forks it across every
 * affected slide. Seeded from a read-only diagnostic pass (verbatim user
 * comment + root cause + file:line + proposed patch + regression guards).
 *
 * Two decks, selected by env so a single CLUSTERS import serves both runs:
 *   BUG_SOLVING_DECK=complex  (default) → clusters 1-4, /tmp/sxs-complex,
 *                                          fixtures renderer/html2slides/e2e/fixtures
 *   BUG_SOLVING_DECK=basics             → cluster 5, /tmp/sxs,
 *                                          fixtures renderer/html2slides/e2e/fixtures-basic
 * The launcher sets BUG_SOLVING_FIXTURES_DIR/SXS_DIR/RATINGS_JSON to match.
 *
 * file:line anchors are approximate (drift with edits) — treat them as
 * starting points, confirm in the worktree before patching. Do NOT trust the
 * pptx XML alone: render to Google Slides and pixel-compare (Slides
 * re-rasterizes tables / corner masks / anchored line boxes independently).
 */
import type { Cluster } from "./workspace-setup.js";

// --- Cluster 1: vertical text alignment (text too high / top-vs-middle) -----
const C1: Cluster = {
  task_id: "vertical-text-align",
  slide_ids: ["slide_06", "slide_11", "slide_17", "slide_22", "slide_25", "slide_28"],
  retry_budget: 4,
  cluster_description:
    "Multiple COMPLEX slides: text rendered TOO HIGH / wrong vertical alignment. " +
    "This is ONE systematic root cause. Verbatim user comments (do NOT paraphrase):\n" +
    "  slide_06: \"Center text is moved or aligned wrong. On the original it's lower, also the Quote is positioned too high.\"\n" +
    "  slide_17: \"Series A Founded and $15M are moved a bit up.\"\n" +
    "  slide_22: \"3 is aligned wrong (top vs middle)\"\n" +
    "  slide_25: \"The start of the text is moved up (The quick brown fox jumps ...)\"\n" +
    "  slide_28: \"100% is wrongly aligned, top vs middle\"\n" +
    "  slide_11: \"Positioning of the text is wrong, it's somehow too high.\" (the top-border half of slide_11 is owned by the clip-mask-borders cluster — fix ONLY the text position here)\n" +
    "ROOT CAUSE: the converter never compensates for the gap between Chrome's CSS line-box and Google Slides' line-box (Slides always uses line-height:normal ~1.197x font). No cap-height / ascent / half-leading correction exists in the emit path (grep finds no `cap`/`ascent`/`0.197`/`baseline` nudge). In emitStyledText (renderer/html2slides/convert-pptx-lib.ts ~362-542): the valign:'top' branch sets the text-box y to the DOM border-box top and `margin` folds only padding-top (~462-471), so Google anchors its TALLER first line-box top to y and tight-line-height big text rides up by ~((1.197 - cssLH)/2) x font (≈5px@48, 7px@72, 16px@160 — matches the proportional pattern). The valign:'middle' digit cases (slide_22 '3', slide_28 '100%') center the line BOX (lineSpacingMultiple 1.2, ~506-508), not the glyph, so descender-less digits sit visually high.\n" +
    "PROPOSED FIX (one systematic change): compute lineBoxFixPt = ((1.197 - cssLHRatio)/2) * fontSize * PX2PT, applied ONLY when cssLHRatio (= lineHeight/fontSize) < 1.197, and fold it into the existing top-inset `margin` channel at ~462-471 for valign:'top'. Add the companion downward nudge for valign:'middle' digit cells, calibrated against a REAL Slides render (not XML). Also REMOVE the leftover `console.log(\"DEBUG textblock opts:\" ...)` hard-coded to 'The quick brown' near ~515-517.\n" +
    "REGRESSION GUARD: the fix MUST be a no-op when cssLHRatio >= 1.197 (normal paragraphs/lists/code blocks at line-height 1.5-1.6 must NOT move). Verify the title->amount gap and quote position against /tmp/sxs-complex/originals/. Re-check currently-passing large-title slides (04/08/24/30) stay put.",
};

// --- Cluster 2: over-rasterization (text baked into images) -----------------
const C2: Cluster = {
  task_id: "over-rasterization",
  slide_ids: ["slide_07", "slide_12", "slide_13"],
  retry_budget: 4,
  cluster_description:
    "COMPLEX slides bake whole regions (INCLUDING TEXT) into PNGs instead of emitting native shapes + editable text. Text must NEVER be baked into images. Verbatim:\n" +
    "  slide_13: \"Why are there so many rendered regions on the right... text should never be rendered; if you need to render then render without text (text hidden) and then put text as children so it's editable. These 32% conversion chips should be achievable using shapes. Add support for background + clip path (transferable as path).\"\n" +
    "  slide_12: \"The entire center area is rendered as one picture instead of divided into elements. Achievable with shapes (rounded rectangles with clipping, parent mask).\"\n" +
    "  slide_07: \"Why are bottom icons rendered? Also why are top circles rendered, can't we use fonts in output?\"\n" +
    "ROOT CAUSE: three rasterization paths. PRIMARY VIOLATION — Path C in renderer/html2slides/extract-dom.ts (~1980-1983): a large-radius overflow:hidden container (slide_12 `.device`) becomes type:'visual' AND `seen`-marks EVERY descendant (`el.querySelectorAll('*').forEach(c => seen.add(c))`), so ALL child text is baked into one PNG. Path A (~1944-1962, conic-gradient / clip-path host) is the CORRECT model to copy: it sets `data-h2s-hide-text` on the host and re-emits children as editable overlays (reuses `_childClipMask` at ~1958). Path B emoji retype (renderer/html2slides/convert-pptx-io.ts ~104-167) screenshots emoji glyphs (slide_07 `.stat-icon` ⚡⚠✓⚙, slide_12 `.feature-icon`).\n" +
    "PROPOSED FIX: change Path C to mirror Path A — REMOVE the `querySelectorAll('*')` seen-mark; instead set `data-h2s-hide-text` on the host and WALK children so their text + own-background rects re-emit as editable overlays, clipped to the device mask via the existing `_childClipMask` machinery. Keep the host PNG as background/chrome only. Secondary (optional): emit clip-path chips/trapezoids as `addShape` custGeom in convert-pptx-lib.ts case 'visual' (~2661-2699) using the captured `clipPath`; narrow `isEmojiCodepoint` so Slides-renderable glyphs (✓ ▲ ■) stay text while true pictographs (🔒📊) remain raster.\n" +
    "REGRESSION GUARD: child rects must NOT protrude past the rounded device corners (that was Path C's original reason to exist) — clip them. Verify $48,290 / 12,847 / 4.2% are SELECTABLE text objects (not pixels) and there are no doubled glyphs (baked + overlay). Render to Slides + compare /tmp/sxs-complex/originals/slide_12.png.",
};

// --- Cluster 3: clip-mask borders & missing shapes --------------------------
const C3: Cluster = {
  task_id: "clip-mask-borders",
  slide_ids: ["slide_14", "slide_34"],
  retry_budget: 4,
  cluster_description:
    "COMPLEX slides: a top accent border renders as a rounded curve instead of a straight line clipped flat by the parent mask, and a CSS popup triangle is missing. Verbatim:\n" +
    "  slide_14: \"The top border style is transferred wrong, like rounded border vs straight top line which is clipped by the mask of the element. There is clipping code which works recursively... In this case there should be an element which can present this cut.\"\n" +
    "  slide_34: \"Missing triangle for popup.\"\n" +
    "ROOT CAUSE 1 (top border): in renderer/html2slides/extract-dom.ts the `isThinTopStripe` 'sandwich' path in emitPseudoRect (~1657-1698). A full-width thin `::before` accent bar on a `border-radius:12px; overflow:hidden` parent paints a SQUARE-cornered bar that the parent merely nips at the corners (a straight line). The converter builds the OUTER overlay using the PARENT's per-corner radii pTL/pTR (~1678-1691) -> a 12px-radius roundRect that curves the stripe colour down the corners. FIX: square off the stripe — set outerCr.tl/tr = 0 (or clamp <=2px) so the bar emits flat-topped and the parent's own roundRect supplies the card curve.\n" +
    "ROOT CAUSE 2 (missing triangle): detectBorderTriangle (~1343) + emitTriangle (~1379) + convert-pptx-lib.ts case 'triangle' (~1671-1694) all WORK, but detectBorderTriangle is only called for real host elements (~2202), NEVER inside emitPseudoRect. slide_34's tail is a `::before` border-triangle (width:0; border-width:12px 17px 12px 0; border-color: transparent #1e1b4b ...) -> it falls through to a right-border-only rect (a thin strip = looks missing). The comment at ~1597-1599 claims to skip-as-rect but there is no detection. FIX: in emitPseudoRect, right after pseudoBounds succeeds (~1578), build a minimal {border*,border*Color} struct from the pseudo's computed style and call detectBorderTriangle; on non-null, emitTriangle and `continue`.\n" +
    "REGRESSION GUARD: the triangle path is gated by detectBorderTriangle (exactly one coloured border side, transparent perpendiculars, zero content box) so normal accent stripes/rings are unaffected. Patch B (squaring the stripe) is shared by slide_14 and slide_11's border — run the goldens gate and render to Slides; watch for a 1-2px seam where the parent's border meets the square stripe top. Both fixes are extraction-only (extract-dom.ts); the converter triangle/roundRect emit paths already work.",
};

// --- Cluster 4: gradients, writing-mode, card formatting --------------------
const C4: Cluster = {
  task_id: "gradients-writing-mode",
  slide_ids: ["slide_31", "slide_32", "slide_33"],
  retry_budget: 4,
  cluster_description:
    "COMPLEX slides: gradient chip fills render transparent, vertical writing-mode text renders horizontal, a gradient-path centerline is dropped, and card inline formatting collapses. Verbatim:\n" +
    "  slide_32: \"Left text is not vertical. Missing gradient backgrounds for P0, P1 and P2.\"\n" +
    "  slide_33: \"In top gradient path middle line is missing. Bottom lines have wrong style.\"\n" +
    "  slide_31: \"Card content have broken formatting, e.g. accessible chip, open to all formatting, paddings between, everything.\"\n" +
    "ROOT CAUSE 1 (slide_32 gradient pills render TRANSPARENT — NOT missing gradient support): gradient IS extracted and tagged GRAD_<n> (convert-pptx-lib.ts ~1394), but the `.pill` sits inside an overflow:hidden row, so the clip-underlay path (~1470-1475) OVERWRITES opts.objectName = hostName(gid). injectGradientsIntoZip (~2754-2760) only matches name=\"GRAD_(\\d+)\", so the <a:gradFill> is never injected and the shape keeps its alpha:0 fallback fill = invisible. FIX: gate the clip path with `&& !el.gradient` (mirror the already-correct guard at ~1484) so gradient pills skip host renaming. (Gradient FILL emission DOES exist: buildGradFillXml ~2722, injectGradientsIntoZip ~2747 — this is a name-collision bug, not a missing feature.)\n" +
    "ROOT CAUSE 2 (slide_32 vertical axis text): writing-mode:vertical-rl is NEVER captured — extract-dom.ts reads only the transform matrix (~651-676 -> rotate:180), so the converter rotates a HORIZONTAL box 180deg = upside-down horizontal text. FIX: capture `writingMode: cs.writingMode` (~651) and, in convert-pptx-lib.ts (~377), set pptxgenjs `vert:'vert270'`/`'vert'` on commonOpts for vertical writing-mode (gated on writingMode being vertical-*), instead of box rotation.\n" +
    "ROOT CAUSE 3 (slide_33): the missing centerline is a `.road::before` pseudo (a dashed strip) — extract-dom does NOT walk ::before for box rendering. The 'bottom lines wrong style' is a thin (1px) dashed CSS border mapped to OOXML prstDash='dash' (too coarse, convert-pptx-lib.ts ~1423). FIX (small): map thin dashed borders to prstDash='sysDash'. The pseudo centerline is a larger gap — flag as scoped follow-up if general ::before box extraction is too big.\n" +
    "ROOT CAUSE 4 (slide_31 cards): styled inline-block chips (span.chip: background #ede9fe; color #7c3aed; border-radius 999px) are MERGED into one parent text block whose runs carry text only — per-run fill/color/fontSize are lost, so chip pill + heading + body all collapse to one style. FIX: do NOT merge an inline-block child that has its own non-transparent background / border-radius into the parent text run — emit it as a standalone rect+text; at minimum preserve per-run color/fontSize/fontWeight.\n" +
    "REGRESSION GUARD: fix 1 (one-line `!el.gradient` guard) is lowest risk — verify slide1.xml gains 3 <a:gradFill> (DC2626/D97706/0D9488) and the pill column is coloured. Fix 4 touches run-merging shared by many slides — run the FULL goldens gate before showing the user. Fix 2 must not disturb the existing y-axis-title rotation path (gate on writingMode).",
};

// --- Cluster 5: tables & lists (BASICS deck) --------------------------------
const C5: Cluster = {
  task_id: "tables-and-lists",
  slide_ids: ["slide_07", "slide_12", "slide_14", "slide_15"],
  retry_budget: 3,
  cluster_description:
    "BASICS deck (fixtures-basic / /tmp/sxs). Table first-column over-indent, list markers not suppressed, inline spans jammed together. Verbatim:\n" +
    "  slide_14: \"Wrong padding in table column, especially the first one.\"\n" +
    "  slide_15: \"Issues with padding for txt in the first column.\"\n" +
    "  slide_12: \"Output for Styled list items contains bullets when it shouldn't for left list and center list and for right list adds numbers when it shouldn't.\"\n" +
    "  slide_07: \"Red text, blue text and green text lack gap between.\"\n" +
    "ROOT CAUSE 1 (first-column padding): convert-pptx-lib.ts ~2335-2337 bumps col0 left margin to 48px when `ci===0 && isLeftAligned && cellWidthPx>200`, overriding the symmetric CSS padding (slide_14 padding:10px 14px; slide_15 8px 10px) -> col0 text shoved right vs cols 1-3. FIX: gate with `&& p.left < 12` so the bump only fires for the halo-wrapper case (tiny/zero CSS left padding) and real CSS padding passes through.\n" +
    "ROOT CAUSE 2 (list markers): the styled-list marker gate (convert-pptx-lib.ts ~1976 `const showMarker = !el.isContainerList && !isPillLike`) never consults list-style. CSS `list-style:none` is ignored, so '•  ' (and '1.  ' for the <ol>) are injected. listStyleType IS already extracted (extract-dom.ts ~1036). FIX: `const noListStyle = (el.listStyleType||'disc')==='none'; showMarker = ... && !noListStyle;` and mirror in the non-styled branch ~1769.\n" +
    "ROOT CAUSE 3 (inline gap): extract-dom.ts getTextRuns (~1109-1223) inserts separator spaces only from each child's margin-left; a flex container's gap/columnGap is never consulted, so the three `display:flex; gap:40px` colored spans collapse to one space. FIX: when the parent is flex/grid with columnGap>2, insert separator spaces (~Math.round(gap/fontSize)) before each non-first inline run, mirroring the existing margin-left convention.\n" +
    "REGRESSION GUARD: these are BASICS goldens (slide_07/12/14/15) — run ./regen-basics.sh, eyeball each diff; do NOT write goldens. Confirm slide_16/30 still show their intended markers and complex feature-comparison tables keep breathing room. Honoring list-style:none only SUPPRESSES markers; default disc/decimal lists are unaffected.",
};

const COMPLEX: Cluster[] = [C1, C2, C3, C4];
const BASICS: Cluster[] = [C5];

const deck = (process.env.BUG_SOLVING_DECK || "complex").toLowerCase();
export const CLUSTERS: Cluster[] = deck === "basics" ? BASICS : COMPLEX;
