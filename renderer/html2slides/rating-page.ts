/**
 * rating-page.ts — the static half of the SxS rating page served by rating-server.ts:
 * the HTML markup, its stylesheet, the server settings embedded as one JSON block,
 * and the esbuild bundle of the browser client (rating-ui.ts).
 *
 * The markup carries no inline script and no handler attributes: rating-ui.ts finds
 * its controls by id. A --read-only page omits the comment box and every drawing
 * control, so the client cannot offer them; reverse mode adds the pieces from
 * reverse-rating-page.ts.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RatingPageConfig } from "./rating-wire.ts";
import { reverseBarHtml, reverseMetricsHtml, reversePageStyles, reverseZoomCropLabels } from "./reverse-rating-page.ts";

/** Where the page loads its client from; rating-server.ts serves ratingClientBundle() here. */
export const ratingClientPath = "/rating-ui.js";

/** Everything the page shows that is decided on the server. */
export type RatingPageOptions = Readonly<{
  /** --task-title; null for the default heading. */
  taskTitle: string | null;
  readOnly: boolean;
  reverseMode: boolean;
  /** --reject-all-button: one button that marks every shown slide Bad. */
  rejectAllButton: boolean;
  taskScoped: boolean;
  showAllDefault: boolean;
  /** The conversion-parameter badges (already HTML) shown in the header. */
  renderBadgeHtml: string;
}>;

/** The full rating page for `options`. */
export function ratingPageHtml(options: RatingPageOptions): string {
  const { readOnly, reverseMode } = options;
  const config: RatingPageConfig = {
    direction: reverseMode ? "reverse" : "forward",
    readOnly,
    taskScoped: options.taskScoped,
    showAllDefault: options.showAllDefault,
    zoomCropLabels: reverseMode
      ? reverseZoomCropLabels
      : [{ side: "original", caption: "original (target)" }, { side: "rendered", caption: "test (slides)" }],
    zoomCropTitle: reverseMode
      ? "original (Google Slides) vs test (Sasha HTML), plus the fixture HTML"
      : "original (target) vs test (Slides render)",
  };
  const title = escapeHtml(options.taskTitle || (reverseMode ? "Reverse import rating" : "html2slides Rating"));
  const heading = escapeHtml(options.taskTitle || (reverseMode ? "Reverse import fidelity: Google Slides → Sasha HTML" : "html2slides Fidelity Rating"));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
${pageStyles}${reverseMode ? reversePageStyles : ""}
</style>
</head>
<body>
<div class="header">
  <h1>${heading}</h1>
  <div class="header-right">${options.renderBadgeHtml}<div class="stats" id="stats"></div></div>
</div>
<div id="regressionBanner"></div>
<div id="renderedBanner"></div>
<div class="nav" id="nav"></div>
${reverseMode ? reverseBarHtml : ""}
<div class="labels"><span id="labelOriginal">Original HTML</span><span id="labelSlides">Google Slides</span></div>
<div class="flip-tabs" id="flipTabs">
  <button class="flip-tab" id="flipOriginal" title="Show the original (target) full-size">Original</button>
  <button class="flip-tab" id="flipRendered" title="Show the Slides render full-size">Rendered</button>
  <button class="flip-tab toggle" id="flipToggle" title="Blink-flip (stacked, tab between) vs classic side-by-side. Press f to flick.">&#9635; Flip</button>
</div>
<div class="slide-pair" id="pair"></div>
<div class="draw-toolbar" id="drawToolbar">
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;">
    <input type="checkbox" id="showDiff"> Show diff at full size (hide small diff panel)
  </label>
  <span style="width: 24px;"></span>
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;" title="Brightens rasterized regions on the Slides render by adding 128 to all RGB channels (via plus-lighter blend)">
    <input type="checkbox" id="showRendered"> Highlight rendered regions (+128 channels)
  </label>
  <span style="width: 24px;"></span>
${readOnly ? "" : drawControlsHtml(reverseMode)}
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;" title="Hover over either image to magnify the region under the cursor"><input type="checkbox" id="loupeToggle"> Magnifier</label>
  <label style="display:flex; gap:4px; align-items:center;" title="Magnifier zoom level"><input type="range" id="loupeZoomCtl" min="2" max="10" value="3" style="width:70px;"> zoom</label>
</div>
<!-- Magnifier loupe: a fixed-position lens that follows the cursor and shows a
     zoomed background-image of the image underneath. -->
<div id="loupe" style="display:none; position:fixed; pointer-events:none; border:2px solid #e94560; border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.6), 0 4px 16px rgba(0,0,0,.5); z-index:2000; background-repeat:no-repeat;"></div>
<!-- End-of-deck completion popup. Hidden until navigate() walks past the last
     slide, then overlays the page with a dismissible "all done" message. Both
     read-only and editable pages carry it. -->
<div id="donePopup" style="display:none; position:fixed; inset:0; z-index:3000; align-items:center; justify-content:center; background:rgba(10,12,24,.72);">
  <div style="background:#16213e; border:1px solid #2a3a5e; border-radius:12px; padding:32px 40px; text-align:center; box-shadow:0 12px 48px rgba(0,0,0,.6);">
    <div style="font-size:22px; font-weight:700; color:#2ecc71; margin-bottom:8px;">You are done with the rating! Thanks!</div>
    <div style="font-size:14px; color:#9fb3d1; margin-bottom:20px;">Every slide in this set has been reviewed.</div>
    <button id="dismissDone" style="padding:10px 28px; border:none; border-radius:6px; font-size:15px; font-weight:600; cursor:pointer; background:#4a90d9; color:#fff;">Dismiss</button>
  </div>
</div>
<div class="slide-id" id="slideId"></div>
${reverseMode ? reverseMetricsHtml : ""}
<div class="slide-links" id="slideLinks"></div>
<!-- Round-1 provenance panel: original source HTML link, live presentation
     link, the original annotation the user drew, and the original comment they
     typed. Populated from sxs-meta.json; empty when the slide has none. -->
<div id="origMeta"></div>
${readOnly ? "" : `<div class="comment-box">
  <textarea id="comment" placeholder="What's wrong? (optional — saved with Bad ratings)" rows="2"></textarea>
</div>`}
<div class="actions">
  <button class="btn btn-good" id="rateGood">Good ✓</button>
  <button class="btn btn-bad" id="rateBad">Bad ✗</button>
  <button class="btn btn-skip" id="skip">Skip →</button>
  ${options.rejectAllButton ? `<button class="btn btn-bad" id="rejectAll" style="background:#5a1616" title="Mark EVERY shown slide Bad in one click, then close">Reject ALL &amp; stop ✗✗</button>` : ""}
</div>
<!-- bug_solving task-scoped reveal buttons. Hidden unless the server was
     started with --task-analysis / --task-diffs. Each button toggles a
     panel with the slide-specific section (analysis.md H2 per slide,
     diffs/<slide_id>.diff + summary.json). -->
<div id="taskReveals" style="display:none; padding: 8px 24px; gap: 10px; justify-content: center;">
  <button class="btn btn-skip" id="showAnalysisBtn" style="background:#e67e22">Show analysis</button>
  <button class="btn btn-skip" id="showDiffAnalysisBtn" style="background:#f1c40f; color:#1a1a2e">Show diff analysis</button>
</div>
<div id="taskAnalysisPanel" style="display:none; margin: 8px 24px; padding: 12px; background: #2a1f0a; border-left: 4px solid #e67e22; border-radius: 0 6px 6px 0;"><pre id="taskAnalysisBody" style="white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 12px; color: #ffe9a8; max-height: 400px; overflow-y: auto;">loading…</pre></div>
<div id="taskDiffPanel" style="display:none; margin: 8px 24px; padding: 12px; background: #2a2a0a; border-left: 4px solid #f1c40f; border-radius: 0 6px 6px 0;"><pre id="taskDiffBody" style="white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 12px; color: #f5e49d; max-height: 400px; overflow-y: auto;">loading…</pre></div>
<div id="savedComment"></div>
<div id="zoomCrops"></div>
<div class="analysis" id="analysis" style="display:none"></div>
<div id="goldenReport" style="margin: 24px; padding: 12px 16px; background: #0f1a30; border-left: 4px solid #f1c40f; border-radius: 0 6px 6px 0; font-size: 13px; color: #ccc; font-family: ui-monospace, monospace;"></div>
<script type="application/json" id="ratingConfig">${jsonForScript(config)}</script>
<script src="${ratingClientPath}"></script>
</body>
</html>`;
}

/** Bundle rating-ui.ts (and what it imports) into one browser IIFE; throws on a build error. */
export async function ratingClientBundle(): Promise<string> {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "rating-ui.ts");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: false,
    sourcemap: "inline",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}

/** Pen, rect, colour, size, prior-marks and clear: the annotation tools of an editable page. */
function drawControlsHtml(reverseMode: boolean): string {
  return `  <span>Draw on ${reverseMode ? "Sasha HTML" : "Slides"} render:</span>
  <button id="drawToggle">Draw</button>
  <button id="toolPen" class="active" title="Freehand pen">&#9998; Pen</button>
  <button id="toolRect" title="Drag to draw a rectangle">&#9645; Rect</button>
  <input type="color" id="drawColor" value="#e94560">
  <label><input type="range" id="drawSize" min="2" max="20" value="6"> px</label>
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;" title="Overlay your prior-round annotation marks on the current render"><input type="checkbox" id="priorMarksToggle" checked> Prior marks</label>
  <button id="clearDraw">Clear</button>
  <span style="width: 24px;"></span>
`;
}

/** JSON safe inside a <script> element: no "</script>" or "<!--" can close or confuse it. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const pageStyles = `  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 16px 24px; background: #16213e; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .render-badge { font-size: 12px; font-weight: 700; letter-spacing: 0.3px; padding: 4px 10px; border-radius: 999px; background: #2a3a5e; color: #9fb3d1; border: 1px solid #3a4a6e; }
  .render-badge.badge-baked { background: #14532d; color: #86efac; border-color: #166534; }
  .stats { font-size: 14px; color: #888; }
  .slide-pair { display: flex; gap: 4px; padding: 12px 24px; align-items: flex-start; flex-wrap: wrap; }
  .slide-pair .panel { width: 49%; position: relative; }
  .slide-pair .panel img { width: 100%; border: 2px solid #333; border-radius: 4px; display: block; }
  .slide-pair .panel.original img { border-color: #4a90d9; }
  .slide-pair .panel.slides img { border-color: #e94560; }
  .slide-pair .panel.diff img { border-color: #f1c40f; background: #111; }
  .slide-pair .panel.slides canvas { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); cursor: crosshair; touch-action: none; border-radius: 4px; }
  .slide-pair .panel.slides canvas.rendered-overlay { pointer-events: none; mix-blend-mode: plus-lighter; cursor: default; }
  .slide-pair .panel.slides img.prior-annot { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); pointer-events: none; opacity: 0.95; border-radius: 4px; }
  .slide-pair .panel.slides img.prior-annot.hidden { display: none; }
  .slide-pair .panel.original .diff-overlay { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); border-radius: 4px; pointer-events: none; }
  .slide-pair .panel.original canvas.diff-overlay { background: transparent; }
  /* Blink-comparator: tabs stack the two panels and flick between them in
     place (press f) so pixel-level shifts pop; toggle back to side-by-side. */
  .flip-tabs { display: flex; align-items: center; gap: 4px; padding: 8px 24px 0; }
  .flip-tab { font-size: 11px; padding: 3px 12px; border-radius: 4px 4px 0 0; border: 1px solid #2a3a5a; background: #16213e; color: #9fb3d0; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; }
  .flip-tab:hover { background: #1d2d4f; color: #e0e0e0; }
  .flip-tab.active { background: #27ae60; color: #fff; border-color: #27ae60; font-weight: 600; }
  .flip-tab.toggle { border-radius: 4px; background: #0f1a30; margin-left: auto; }
  .flip-tab.toggle.active { background: #4a90d9; border-color: #4a90d9; color: #fff; }
  .slide-pair.flip { display: block; position: relative; }
  .slide-pair.flip .panel { width: 100%; position: absolute; inset: 0; opacity: 0; pointer-events: none; }
  .slide-pair.flip .panel.flip-active { position: relative; opacity: 1; pointer-events: auto; z-index: 1; }
  .draw-toolbar { display: flex; gap: 8px; padding: 0 24px; align-items: center; font-size: 12px; color: #aaa; }
  .draw-toolbar button { background: #2a2a4e; color: #e0e0e0; border: 1px solid #444; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .draw-toolbar button.active { background: #e94560; border-color: #e94560; color: white; }
  .draw-toolbar input[type=color] { width: 28px; height: 24px; border: 1px solid #444; border-radius: 4px; background: transparent; cursor: pointer; }
  .labels { display: flex; gap: 4px; padding: 0 24px; }
  .labels span { width: 49%; text-align: center; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
  .labels a { color: #4a90d9; text-decoration: none; font-weight: 600; }
  .labels a:hover { text-decoration: underline; }
  .actions { display: flex; gap: 12px; padding: 12px 24px; justify-content: center; }
  .btn { padding: 12px 36px; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; transition: 0.2s; }
  .btn-good { background: #27ae60; color: white; }
  .btn-good:hover { background: #2ecc71; }
  .btn-bad { background: #c0392b; color: white; }
  .btn-bad:hover { background: #e74c3c; }
  .btn-skip { background: #555; color: white; }
  .slide-id { text-align: center; padding: 8px; font-size: 14px; color: #888; }
  .slide-links { text-align: center; padding: 4px 24px; font-size: 13px; }
  .slide-links a { color: #4a90d9; text-decoration: none; margin: 0 12px; }
  .slide-links a:hover { text-decoration: underline; }
  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 8px; }
  .status-good { background: #27ae60; color: white; }
  .status-bad { background: #c0392b; color: white; }
  .status-pending { background: #555; color: #aaa; }
  .status-regressed { background: #e94560; color: white; animation: pulse 1.5s ease-in-out infinite; }
  .status-new { background: #8e44ad; color: white; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  .nav a.diff-regressed { box-shadow: inset 0 -3px 0 #e94560; font-weight: 700; color: #ff6b81; }
  .nav a.diff-new { box-shadow: inset 0 -3px 0 #8e44ad; color: #c39bd3; }
  .nav a.diff-ok { opacity: 0.6; }
  .regression-banner { background: #2a0a14; border-left: 4px solid #e94560; color: #ffb8c4; padding: 10px 16px; margin: 12px 24px; border-radius: 0 6px 6px 0; font-size: 14px; font-weight: 600; }
  .rendered-banner { background: #2a1f0a; border-left: 4px solid #f1c40f; color: #ffe9a8; padding: 10px 16px; margin: 12px 24px; border-radius: 0 6px 6px 0; font-size: 14px; font-weight: 600; }
  .rendered-banner .kinds { font-weight: 400; color: #c9b57a; margin-left: 8px; font-size: 13px; }
  .nav { display: flex; gap: 8px; padding: 8px 24px; flex-wrap: wrap; }
  .nav a { color: #4a90d9; text-decoration: none; font-size: 12px; padding: 4px 8px; border-radius: 4px; }
  .nav a:hover { background: #2a2a4e; }
  .nav a.current { background: #4a90d9; color: white; }
  .analysis { margin: 12px 24px; padding: 12px; background: #2a2a4e; border-radius: 6px; font-size: 13px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
  .comment-box { margin: 12px 24px; display: flex; gap: 8px; }
  .comment-box textarea { flex: 1; padding: 10px 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a4e; color: #e0e0e0; font-family: inherit; font-size: 14px; resize: vertical; min-height: 40px; }
  .comment-box textarea::placeholder { color: #666; }
  .comment-box textarea:focus { outline: none; border-color: #4a90d9; }
  .saved-comment { margin: 4px 24px; padding: 8px 12px; background: #2a2a4e; border-left: 3px solid #e94560; border-radius: 0 6px 6px 0; font-size: 13px; color: #ccc; }
  .saved-comment .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .zoom-crops { margin: 8px 24px; padding: 10px 12px; background: #0e1f2e; border-left: 4px solid #3498db; border-radius: 0 6px 6px 0; }
  .zoom-crops-label { font-size: 13px; color: #cfe4f7; margin-bottom: 8px; }
  .zoom-crops-grid { display: flex; gap: 16px; flex-wrap: wrap; }
  .zoom-crop-pair { display: flex; gap: 8px; background: #050a0e; padding: 6px; border-radius: 4px; }
  .zoom-crop figure { margin: 0; }
  .zoom-crop figcaption { color: #7dafd5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; text-align: center; }
  .zoom-crop img { display: block; max-width: 320px; max-height: 360px; image-rendering: pixelated; border: 1px solid #1f2933; }
  .orig-meta { margin: 8px 24px; padding: 10px 14px; background: #1f2a3a; border-left: 4px solid #7dafd5; border-radius: 0 6px 6px 0; }
  .orig-meta .om-title { font-size: 11px; color: #7dafd5; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .orig-meta .om-links { margin-bottom: 8px; font-size: 13px; }
  .orig-meta .om-links a { color: #4a90d9; text-decoration: none; margin-right: 16px; }
  .orig-meta .om-links a:hover { text-decoration: underline; }
  .orig-meta .om-body { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  /* Composite the annotation overlay ON TOP of the original slide so the drawn
     marks read against the slide content, not a black field. */
  .orig-meta .om-annotation .om-annot-stack { position: relative; display: inline-block; max-width: 360px; border: 1px solid #2f3b4d; border-radius: 4px; overflow: hidden; background: #050a0e; }
  .orig-meta .om-annotation .om-annot-base { display: block; width: 100%; height: auto; }
  .orig-meta .om-annotation .om-annot-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .orig-meta .om-annotation img.om-annot-solo { display: block; max-width: 360px; max-height: 280px; border: 1px solid #2f3b4d; border-radius: 4px; background: #050a0e; }
  .orig-meta .om-annotation figcaption, .orig-meta .om-comment .om-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .orig-meta .om-comment { flex: 1; min-width: 200px; font-size: 13px; color: #ddd; white-space: pre-wrap; word-break: break-word; }
  .orig-meta figure { margin: 0; }
`;
