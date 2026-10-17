/**
 * reverse-rating-page.ts — the REVERSE-mode markup and styles of the SxS rating page.
 *
 * Why a separate file: rating-page.ts renders one page for both directions. Reverse
 * mode adds a view toggle (reverse step vs full round trip), per-slide metric chips,
 * worst-first ordering and reverse-specific labels; keeping those strings here keeps
 * the forward page free of them. The browser behaviour behind these controls lives in
 * rating-ui-reverse.ts, wired up by id from rating-ui.ts.
 */
import type { ZoomCropLabel } from "./rating-wire.ts";

/** Styles for the view toggle, ordering control, metric chips and nav-strip tints. */
export const reversePageStyles = `
  .render-badge.badge-reverse { background: #3b1d4e; color: #e0b3ff; border-color: #8e44ad; }
  .reverse-bar { display: flex; gap: 8px; align-items: center; padding: 8px 24px 8px; font-size: 12px; color: #9fb3d0; flex-wrap: wrap; }
  .reverse-bar .view-button { font-size: 12px; padding: 4px 12px; border-radius: 4px; border: 1px solid #2a3a5a; background: #16213e; color: #9fb3d0; cursor: pointer; }
  .reverse-bar .view-button:hover { background: #1d2d4f; color: #e0e0e0; }
  .reverse-bar .view-button.active { background: #8e44ad; border-color: #8e44ad; color: #fff; font-weight: 600; }
  .reverse-bar .order { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .reverse-bar select { background: #16213e; color: #e0e0e0; border: 1px solid #2a3a5a; border-radius: 4px; padding: 3px 6px; font-size: 12px; }
  .reverse-metrics { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; padding: 4px 24px; font-size: 13px; }
  .metric-chip { padding: 3px 10px; border-radius: 999px; border: 1px solid #333; color: #888; }
  .metric-chip.metric-good { color: #86efac; border-color: #166534; background: #0f2a1a; }
  .metric-chip.metric-fair { color: #ffe9a8; border-color: #7a5b10; background: #2a1f0a; }
  .metric-chip.metric-poor { color: #ffb8c4; border-color: #7a1a2a; background: #2a0a14; }
  .metric-chip.current-view { outline: 2px solid #8e44ad; outline-offset: 1px; }
  .reverse-case { color: #7dafd5; font-size: 12px; align-self: center; }
  .reverse-notes { text-align: center; font-size: 12px; color: #9fb3d0; padding: 0 24px 4px; white-space: pre-wrap; }
  .reverse-missing { color: #e67e22; text-transform: none; letter-spacing: 0; }
  .nav a.mismatch-poor { box-shadow: inset 0 -3px 0 #e94560; }
  .nav a.mismatch-fair { box-shadow: inset 0 -3px 0 #f1c40f; }
  .nav a.mismatch-good { box-shadow: inset 0 -3px 0 #27ae60; }
  .nav a .nav-metric { font-size: 10px; opacity: 0.75; margin-left: 3px; }
`;

/** The view toggle and the ordering control, shown above the two panes. */
export const reverseBarHtml = `<div class="reverse-bar" id="reverseBar">
  <span>View:</span>
  <button class="view-button active" id="viewReverse" title="Google Slides thumbnail vs Sasha HTML screenshot (press v to switch)">Reverse step: Google Slides &rarr; Sasha HTML</button>
  <button class="view-button" id="viewRoundTrip" title="Original fixture HTML screenshot vs Sasha HTML screenshot (press v to switch)">Full round trip: fixture HTML &rarr; Sasha HTML</button>
  <label class="order">Order:
    <select id="reverseOrder">
      <option value="deck">Deck order</option>
      <option value="reverse">Worst reverse mismatch first</option>
      <option value="round-trip">Worst round-trip mismatch first</option>
      <option value="text">Worst text match first</option>
    </select>
  </label>
</div>`;

/** Containers for the current slide's metric chips and the pipeline's notes. */
export const reverseMetricsHtml = `<div class="reverse-metrics" id="reverseMetrics"></div><div class="reverse-notes" id="reverseNotes"></div>`;

/** Zoom-crop sides in reverse mode: the Google thumbnail, the Sasha screenshot and the fixture screenshot. */
export const reverseZoomCropLabels: readonly ZoomCropLabel[] = [
  { side: "original", caption: "original (Google Slides)" },
  { side: "rendered", caption: "test (Sasha HTML)" },
  { side: "fixture", caption: "round trip: original fixture HTML" },
];
