/**
 * Wave-10 — THREE parallel clusters, one per root-cause symptom family.
 *
 * Wave-9 used a single 5-slide cluster after waves 5-7's per-slide retries
 * kept regressing siblings. The wave-9 bundle DID ship 2 of 5 slides
 * (slide_15, slide_25) but introduced TWO new regressions across many
 * sibling slides:
 *   - line-height (spcPct→spcPts over-applied beyond .text-block)
 *   - vertical anchor (top vs middle for short text inside shapes)
 *
 * For wave-10, three clusters run in parallel — each targets ONE root
 * cause, validates only its own slide subset, and one cluster's
 * regressions don't gate the others' progress. The engine's parallelFork
 * runs them on separate git worktrees so file-level edits don't clash
 * during execution; merge-time conflicts in convert-pptx.ts will be
 * resolved manually after all three land.
 *
 * Slides that appear in two families (06, 11, 21) live ONLY in the
 * line-height cluster. Rationale: line-height is the more invasive root
 * cause (paragraph-level XML rewrite); fixing it likely partially
 * addresses the visible anchor symptom on those slides too. If anchor
 * is still broken on 06/11/21 after wave-10A lands, they roll into
 * wave-11.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WAVE-9 VERDICT TRAIL (verbatim — preserve across waves)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   slide_25: SHIPPED. spcPct→spcPts conversion on .text-block landed.
 *             The fix worked but appears over-applied — wave-10A
 *             narrows the gate. Don't revert wave-9's edit; tighten it.
 *
 *   slide_15: SHIPPED. .api-badge gets separate handling from
 *             .status-badge in extract-dom.ts. Don't break it.
 *
 *   slide_11: STILL BROKEN. Wave-9 worker correctly identified that
 *             top-border edits must land via convert-pptx.ts's
 *             `injectStrokeAlignment` post-processor (line ~1730+),
 *             but the produced fix didn't actually appear in slide11
 *             XML. VERIFY at the OOXML level (algn="in" present in
 *             <a:ln>) before claiming success. Bullet vertical
 *             alignment on .opportunity-card likely also needs the
 *             family-B anchor=ctr fix.
 *
 *   slide_14: PARTIAL. The custGeom path with rounded top corners
 *             fixed the top stripe clip. The new failure is chip
 *             border-color — center chips render with the wrong
 *             border color ("colored vs gray"). Inspect the
 *             border-color extraction code path for chip-class shapes;
 *             the wave-9 edits to chip handling for slide_15's
 *             .api-badge may have regressed slide_14's chips.
 *
 *   slide_30: REGRESSED. Was GOOD in wave-7 (chip anchor + tIns
 *             padding via slide_19 padTopPt path, validated visually).
 *             Wave-9's spcPts rewrite reached .code-block paragraphs
 *             and made line-height wrong. Narrowing wave-10A's gate
 *             should restore slide_30 without reverting wave-7's
 *             extract-dom + convert-pptx edits.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WAVE-7 VERDICT TRAIL TO PRESERVE (still relevant for slide_30)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   slide_30: tag chips (TypeScript, Node.js, …) need anchor="ctr";
 *             .code-block text needs tIns padding folded from CSS
 *             padding-top via the slide_19 padTopPt path. The wave-7
 *             worktree (now gone) used extract-dom + convert-pptx
 *             changes that the visual check passed. Aim for
 *             compatible edits.
 */
import type { Cluster } from "./workspace-setup.js";

export const CLUSTERS: Cluster[] = [
  // ─────────────────────────────────────────────────────────────────────
  // WAVE-10A — LINE-HEIGHT scope-narrowing
  //
  // Symptom: line-height is wrong on multiple paragraph kinds. Most
  // diagnostic comment: slide_24 — "Each level adds 16px is totally
  // busted and moved below, seems like line height is giantic". Strong
  // signal that wave-9's spcPts conversion is firing on paragraphs it
  // shouldn't reach.
  //
  // Slides also include 06/11/21 even though those slides have a
  // SECONDARY anchor symptom — fixing line-height first reduces the
  // sibling-regression surface for wave-10B.
  // ─────────────────────────────────────────────────────────────────────
  {
    task_id: "wave10A-line-height",
    cluster_description:
      "SEVEN slides have a line-height regression introduced by wave-9. " +
      "Wave-9 added a spcPct→spcPts conversion in convert-pptx.ts that " +
      "shipped slide_25's .text-block but appears to over-apply on " +
      "every paragraph kind. Most diagnostic user comment: slide_24 " +
      "'Each level adds 16px is totally busted and moved below, seems " +
      "like line height is giantic'. slide_30 was GOOD in wave-7 and " +
      "is now broken — strong signal the spcPts rewrite is reaching " +
      ".code-block paragraphs it shouldn't." +
      "\n" +
      "\nROOT-CAUSE FIX: read the wave-9 spcPts edit in convert-pptx.ts. " +
      "Identify which selectors / class-name predicates it gates on. " +
      "NARROW the gate so it fires ONLY on paragraph kinds that " +
      "actually need absolute spacing — almost certainly just " +
      ".text-block on slide_25's fixture. Every OTHER paragraph kind " +
      "(including .code-block, list items, body text on cards, " +
      "etc.) should keep its original spcPct OR get no spcPts " +
      "override at all." +
      "\n" +
      "\nVERIFY at the OOXML level for each affected slide: spcPts " +
      "should be present where wave-9's fix needed it (slide_25 still " +
      "rates Good after wave-10A) and ABSENT where the original wave-9 " +
      "fix should not reach. Diff produced slideNN.xml against baseline " +
      "before claiming success." +
      "\n" +
      "\nSlide-by-slide context (verbatim user comments from " +
      "/tmp/sxs-complex/ratings.json):" +
      "\n  slide_04 — wrong line height for bottom text (ML-powered " +
      "insights …)" +
      "\n  slide_06 — wrong line height for center text (also has " +
      "anchor symptom 'EW aligned wrong' — wave-10B may handle the " +
      "anchor; line-height comes first)" +
      "\n  slide_08 — line height is wrong" +
      "\n  slide_11 — line height is wrong (also clipping on top — " +
      "wave-10C handles the clipping)" +
      "\n  slide_21 — wrong line height for text (also 'A+ aligned " +
      "wrong' anchor — wave-10B may handle it after this lands)" +
      "\n  slide_24 — 'Each level adds 16px is totally busted and " +
      "moved below, seems like line height is giantic' (THE most " +
      "diagnostic comment — point of attack)" +
      "\n  slide_30 — line height of code wrong (REGRESSION from " +
      "wave-7 — wave-7's extract-dom + convert-pptx edits stay valid; " +
      "wave-10A's narrowing should restore slide_30 without reverting " +
      "wave-7)" +
      "\n" +
      "\nDo NOT regress slide_25 (Good in wave-9). Validate slide_25 " +
      "alongside the seven listed slides — if slide_25 breaks, the " +
      "narrowed gate is too tight and needs to expand by one selector.",
    slide_ids: [
      "slide_04", "slide_06", "slide_08", "slide_11",
      "slide_21", "slide_24", "slide_30",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // WAVE-10B — VERTICAL ANCHOR (top vs middle for short text in shapes)
  //
  // Symptom: single-character / short-string text inside shapes (circles,
  // chips, badges, arrows) renders anchored to the top of the shape
  // instead of vertically centered. PowerPoint defaults shape text-frame
  // anchor to TOP, but Chrome centers via flex / grid / line-height.
  //
  // Almost certainly ONE root cause across all slides — find the place
  // where shape text-frames get their anchor and emit anchor="ctr"
  // when the CSS-resolved vertical alignment is center.
  // ─────────────────────────────────────────────────────────────────────
  {
    task_id: "wave10B-anchor-shapes",
    cluster_description:
      "FIVE slides (after dropping 06/11/21 to wave-10A's line-height " +
      "cluster) show short text inside shapes anchored to the TOP of " +
      "the shape instead of vertically centered. Affected shape kinds: " +
      "circles, chips, badges, arrows, small labels." +
      "\n" +
      "\nROOT-CAUSE HYPOTHESIS: PowerPoint defaults <p:sp>'s <p:txBody>/" +
      "<a:bodyPr> anchor to top when omitted. Chrome's flex/grid/line-" +
      "height visually centers short text. Find the place in " +
      "convert-pptx.ts where shape text-frames are emitted (addText into " +
      "shape, custom <p:sp>, etc.), and emit anchor=\"ctr\" whenever the " +
      "CSS-resolved vertical alignment is center (which is the case " +
      "for every shape in this list)." +
      "\n" +
      "\nDO NOT blindly anchor=ctr everywhere — paragraphs in " +
      ".text-block / .code-block / list items need top anchor preserved. " +
      "The gate should be: shape contains a single short text run AND " +
      "the CSS resolves to vertical centering (display:flex with " +
      "align-items:center, or grid place-items:center, or text inside " +
      "a circle with line-height equal to height, etc.)." +
      "\n" +
      "\nSlide-by-slide context (verbatim user comments):" +
      "\n  slide_02 — text offset inside circle" +
      "\n  slide_17 — SV, GC, NX aligned vertically wrong (top vs middle)" +
      "\n  slide_18 — April 2025 and arrows aligned wrong (top vs middle), " +
      "numbers also aligned wrong" +
      "\n  slide_22 — 3 aligned wrong (top vs middle)" +
      "\n  slide_28 — 100% wrongly aligned (top vs middle)" +
      "\n  slide_29 — alignment of badge texts wrong" +
      "\n" +
      "\nVERIFY at OOXML level: each affected shape's <a:bodyPr> should " +
      "carry anchor=\"ctr\" after the fix. Shapes whose original CSS " +
      "didn't center vertically should NOT have anchor=\"ctr\" added.",
    slide_ids: [
      "slide_02", "slide_17", "slide_18", "slide_22", "slide_28", "slide_29",
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // WAVE-10C — CLIPPING / BORDER edge cases
  //
  // Three slides with three distinct sub-problems. Smallest cluster but
  // each is its own investigation. Slide_11 is wave-9's stuck OOXML
  // verification problem; slide_12 is a fresh ratings entry; slide_14
  // is a chip border-color regression from wave-9's chip-handling work.
  // ─────────────────────────────────────────────────────────────────────
  {
    task_id: "wave10C-clipping-borders",
    cluster_description:
      "THREE clipping/border edge cases. Each is a distinct sub-problem." +
      "\n" +
      "\nslide_11 — top borders + line height. Wave-9 worker correctly " +
      "identified that top-border edits must land via " +
      "`injectStrokeAlignment` in convert-pptx.ts (line ~1730+) but the " +
      "produced fix didn't appear in slide11.xml. VERIFY at OOXML level " +
      "that algn=\"in\" is present in the relevant <a:ln> elements after " +
      "the fix — diff slide11.xml against baseline. Bullet vertical " +
      "alignment on .opportunity-card likely also needs anchor=\"ctr\" " +
      "(coordinate with wave-10B if running concurrently — the bullet " +
      "fix may already land via wave-10B's anchor work, in which case " +
      "this cluster only needs to handle the top-border issue)." +
      "\n" +
      "\nslide_12 — clipping + corners regression, 'no black border " +
      "around'. NEW investigation — wave-9 didn't touch slide_12. Read " +
      "renderer/html2slides/e2e/fixtures/slide_12.html, identify which " +
      "container needs the black border, and check what convert-pptx.ts " +
      "emits for that container's border + corner radius. The fixture " +
      "may have a recursive / nested element pattern that the converter " +
      "is dropping borders for." +
      "\n" +
      "\nslide_14 — chip border-color wrong on center chips. Wave-9 " +
      "fixed the top stripe clip via custGeom, but center chips now " +
      "render with the wrong border color (user comment: 'colored vs " +
      "gray'). Wave-9's edits to chip handling for slide_15's " +
      ".api-badge may have regressed slide_14's chip variant. Inspect " +
      "the border-color extraction code path for chip-class shapes " +
      "in extract-dom.ts and the forwarding path in convert-pptx.ts. " +
      "Distinguish slide_14's chip variant from slide_15's .api-badge " +
      "without regressing slide_15." +
      "\n" +
      "\nVERIFY each slide's specific symptom at OOXML level before " +
      "claiming success. slide_15 (Good in wave-9) must NOT regress.",
    slide_ids: ["slide_11", "slide_12", "slide_14"],
  },
];
