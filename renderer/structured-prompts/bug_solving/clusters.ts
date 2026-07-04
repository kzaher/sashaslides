/**
 * ROUND 15 — the ACTUAL losses only. The user rated the fresh HEAD render and
 * marked exactly these BAD: complex 04, 12, 13, 19, 30 (+ basic 13, run
 * separately — it needs fixtures-basic). Every previous round clustered by
 * surface-symptom keyword across unrelated (good!) slides + stale history
 * hints; the user rejected all of it. This round each cluster is ONE slide with
 * a code-level root cause VERIFIED by inspecting the fixture + target + render +
 * annotation (no hypotheses, no history hints). Workers IMPLEMENT the identified
 * fix and verify it doesn't regress siblings — they do not re-diagnose.
 *
 * Launch: legacy path (DO NOT set BUG_SOLVING_USE_SCHEDULER — it nulls results).
 *   BUG_SOLVING_SXS_DIR=/tmp/sxs-complex BUG_SOLVING_RATINGS_JSON=/tmp/sxs-complex/ratings.json
 */
import type { Cluster } from "./workspace-setup.js";

const C_04: Cluster = {
  task_id: "pseudo-glyph-center",
  slide_ids: ["slide_04"],
  retry_budget: 4,
  cluster_description:
    "slide_04 (Product Roadmap) — user: 'Bad tick positioning, not centered.' The REAL defect: the ✓ checkmark glyph inside the two completed milestone dots (`.dot.done::after{content:'✓';position:absolute;inset:0;display:flex;align-items:center;justify-content:center}`) renders LEFT-aligned (hugging the left edge of the 28px circle) instead of centered. Dot placement itself is correct — only the ✓ is off.\n" +
    "ROOT CAUSE (verified): renderer/html2slides/extract-dom.ts `emitPseudoText()` ~lines 2029-2101, the explicit-left branch ~2043-2057. For an absolute pseudo it sees `hasExplicitLeft` true and HARD-SETS `textAlign='left'` (~line 2056), ignoring that `inset:0` means left==right AND `justify-content:center` — so a flex-centered glyph gets left-aligned in its full-width box.\n" +
    "FIX: keep `textAlign='center'` when the pseudo is centered — i.e. when it has BOTH explicit left AND explicit right (left==right, the `inset` case) OR `justify-content:center`. Only fall to 'left' for genuinely left-anchored `left:0`-WITHOUT-right markers.\n" +
    "CRITICAL — DO NOT REGRESS slide_19: slide_19's `.pain::before{content:'!';left:0}` / `.touchpoint::before{left:0}` are genuinely left-anchored (left only, no right) and MUST stay left. Your gate must distinguish left-only (stay left) from left+right/inset or justify-center (center). Render slide_19 too and confirm its `!` marker didn't move.\n" +
    "VERIFY: on the AFTER render the ✓ is centered in both done dots (matches target); slide_19 markers unchanged.",
};

const C_12: Cluster = {
  task_id: "device-frame-ring",
  slide_ids: ["slide_12"],
  retry_budget: 5,
  cluster_description:
    "slide_12 (phone/device mockup) — user: 'Black borders are too big, wrong corner radius. Also letter spacing is wrong on product features.' (A prior 'restore 3 injectors' fix was REJECTED — that was NOT the cause. Diagnose from the real mechanism below.)\n" +
    "ROOT CAUSE A/B — the fat black frame + wrong corner radius: the CSS ring is a box-shadow `0 0 0 2px #333` (a crisp 2px spread ring). renderer/html2slides/extract-dom.ts `emitRect` ring loop ~lines 1718-1735 materializes it as a SOLID #333 halo rect INFLATED by spread on every side (`hb={x-sp,y-sp,w+2sp,h+2sp}`, `haloR=borderRadius+sp`, borderWidth:0) — a filled block ~2.5px proud on all sides — PLUS the device roundRect also carries a redundant too-thick inside `<a:ln>` (~4px). Net: a fat black bezel where CSS wants a thin 2px ring, and the halo radius (borderRadius+spread) is rounder than the device it frames (mismatched corners). FIX: emit the spread ring as a THIN outline matching the CSS 2px (not a filled +2.5px halo), drop the redundant same-color inside stroke, and make the halo corner radius match the device's.\n" +
    "ROOT CAUSE C — letter-spacing too tight (~11% under on 'PRODUCT FEATURES', measured 165px vs target 185px): renderer/html2slides/convert-pptx-lib.ts `mapRunOptions` ~line 339 and the no-runs path ~line 628 set `charSpacing = letterSpacing * PX2PT` (PX2PT=0.5625) — the tracking factor is too small vs Google's rendering. FIX: correct the charSpacing scale so tracking matches (CSS 2px letter-spacing should render ~1.5pt, i.e. spc~150 not 113). NOTE this scale affects ALL slides with letter-spacing — render a few others and confirm NO off-target regression.\n" +
    "VERIFY: AFTER render shows a thin dark ring (not fat), matched corner radii, and 'PRODUCT FEATURES' tracking matching target; no other slide regressed.",
};

const C_13: Cluster = {
  task_id: "funnel-trapezoid-native",
  slide_ids: ["slide_13"],
  retry_budget: 5,
  cluster_description:
    "slide_13 (Marketing Funnel) — user: 'Why are there so many rendered regions on the right... should be possible to use some shape; text should never be rendered.' The REAL defect: the 4 funnel stage bodies (`.stage-shape{clip-path:polygon(0 0,100% 0,95% 100%,5% 100%)}`, fixture lines 13-16) are RASTERIZED to PNGs. (The text-overlay half of the user's ask is ALREADY done — text is native; hide-text-before-capture at extract-dom ~3177-3184 + child re-walk works. The remaining fix is the SHAPE itself.)\n" +
    "ROOT CAUSE (verified): renderer/html2slides/extract-dom.ts ~lines 2266-2288, `hasCssVisual` treats ANY non-trivial `clip-path` as a rasterize trigger → one `type:'visual'` PNG per stage (convert-pptx-lib.ts `case 'visual'` ~3091). There is NO polygon/trapezoid/custGeom path anywhere in convert-pptx-lib.ts.\n" +
    "FIX: add a native trapezoid path. In extract-dom.ts before ~line 2273 parse `clipPath`: if it's a `polygon()` of 4 points forming a symmetric trapezoid (top edge full-width, bottom inset symmetrically — true for all 4 stages), emit `type:'shape', shape:'trapezoid', fill:<bg color>, adj:<inset%>` INSTEAD of `type:'visual'`; keep the bitmap branch as fallback for conic-gradient / non-trapezoidal polygons; children still re-walk for editable text. Then add a `case 'shape'` in convert-pptx-lib.ts (~alongside 3091) calling `slide.addShape('trapezoid',{x,y,w,h,fill:{color},flipV/rotate:180})` — pptxgenjs supports the `trapezoid` preset; the funnel narrows downward so use flipV/180° rotation.\n" +
    "VERIFY: AFTER render shows 4 editable solid-color trapezoids (native shapes) + native text, ZERO rasterized regions on the right; shape orientation + colors match target.",
};

const C_19: Cluster = {
  task_id: "metric-pill-center-wrap",
  slide_ids: ["slide_19"],
  retry_budget: 5,
  cluster_description:
    "slide_19 (Customer Journey Map) — user: 'CAutious not centered. bottom text is in two lines.' TWO independent defects:\n" +
    "DEFECT 1 — sentiment pills ('Cautious'/'Curious'/etc.) ride too HIGH (top of the grey pill, not middle). Mechanism: `.sentiment` is a flex row of two chromeless spans (18px emoji + 11px word) → extract-dom.ts merges it to ONE rich-text element (directText ~2786) with valign:'middle' (verticallyCentered ~3034-3037). convert-pptx-lib.ts emitText pins lineSpacingMultiple:1.2 (~595); Google centers the LINE BOX sized by the tallest run (the 18px emoji), so the 11px word sits above the pill's geometric center. FIX: for a vertically-centered mixed-font-size single line, correct the baseline so the smaller text centers (e.g. size the line box / valign off the smaller run, or add a per-run baseline nudge like the numeric `centerDigitInsetPt` at ~530-536 but for mixed runs).\n" +
    "DEFECT 2 — the 4 `.metric-pill-label` bottom labels ('Avg. Time to Purchase' etc., 11px) WRAP to 2 lines; target is 1 line each. Mechanism: emitted at glyph-tight width with only `SLACK_PX=12` (convert-pptx-lib.ts ~304, applied ~448-473); Google measures glyphs wider than Chrome so the box `w` is a hair too narrow → last word overflows. These labels aren't `isPillOverlay` so they miss the larger `bw*0.2` slack. FIX: give small multi-word single-line labels enough width slack (or margin:0/inset:0) that they stay one line.\n" +
    "VERIFY: AFTER render — sentiment words vertically centered in their pills; all 4 metric labels on ONE line. Don't over-widen and cause overlap.",
};

const C_30: Cluster = {
  task_id: "colored-native-bullets",
  slide_ids: ["slide_30"],
  retry_budget: 5,
  cluster_description:
    "slide_30 (Key Priorities) — user: 'Not a list element, just text with bullets. can't bullets in a list in slides be colored?' The REAL defect: `<ul class='bullet-list'>` has `list-style:none` with colored `li::before` dots (blue default; li.red/green/orange overrides). Our render is FLAT text with a typed '•  ' glyph run per line (not a native Slides list), bullets ~monochrome.\n" +
    "ROOT CAUSE (verified): renderer/html2slides/convert-pptx-lib.ts `case 'list'` pure-text branch ~2143-2304. `noListStyle=(listStyleType==='none')` → true, forcing `useNativeBullet=false` (~2185); the fallback (~2240-2251) emits `[{text:'•  ',color:markerColor},{text:it.text}]` — a literal glyph run, no `<a:buChar>`, no list. pptxgenjs 4.0.1 has ZERO bullet-color support (pptxgen.es.js ~5848-5894 emits buSzPct/buFont/buChar only, no `<a:buClr>`).\n" +
    "FIX (two parts): (1) in convert-pptx-lib.ts take the NATIVE bullet path even for `list-style:none` colored dot-bullets (emit real `bullet:{...}` per paragraph, drop the '•  ' text run) and record a per-slide registry `[{slide/paraIndex, bulletColorHex}]`. (2) add a new zip post-patch `injectBulletColorsIntoZip` in renderer/html2slides/convert-pptx-io.ts modeled on injectGradientsIntoZip (~231-292): for each `<a:p>` whose `<a:pPr>` contains `<a:buChar>`, insert `<a:buClr><a:srgbClr val='RRGGBB'/></a:buClr>` in the correct CT_TextParagraphProperties order (buClr BEFORE buSzPct/buFont/buChar), matched to the registry by paragraph order. Google Slides imports `<a:buClr>` as a native colored bullet (verify by render — Slides may normalize glyph/indent).\n" +
    "VERIFY: AFTER render is a NATIVE editable bulleted list (selectable list items) with per-item bullet COLORS (blue/red/green/orange) matching target — NOT flat text with typed glyphs.",
};

export const CLUSTERS: Cluster[] = [C_04, C_12, C_13, C_19, C_30];
