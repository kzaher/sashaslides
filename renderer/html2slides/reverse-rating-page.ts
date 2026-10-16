/**
 * reverse-rating-page.ts — the REVERSE-mode pieces of the SxS rating page.
 *
 * Why a separate file: rating-server.ts serves one inline page whose client script
 * is a template string. Reverse mode adds a view toggle (reverse step vs full round
 * trip), per-slide metric chips, worst-first ordering and reverse-specific labels.
 * Keeping those strings here keeps the forward page byte-for-byte what it was when
 * the server runs forward, and keeps the reverse client readable in one place.
 *
 * The client script below runs in the browser next to rating-server.ts's own script
 * and uses its globals (comparisons, currentIdx, render, showDiff,
 * computeClientSideDiff, visibleComparisons). Every comparison object carries a
 * `reverse` field: the ReverseSlide from reverse-rating.ts, serialised as JSON.
 */

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
  <button class="view-button active" id="viewReverse" onclick="setReverseView('reverse')" title="Google Slides thumbnail vs Sasha HTML screenshot (press v to switch)">Reverse step: Google Slides &rarr; Sasha HTML</button>
  <button class="view-button" id="viewRoundTrip" onclick="setReverseView('round-trip')" title="Original fixture HTML screenshot vs Sasha HTML screenshot (press v to switch)">Full round trip: fixture HTML &rarr; Sasha HTML</button>
  <label class="order">Order:
    <select id="reverseOrder" onchange="setReverseOrder(this.value)">
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
export const reverseZoomCropLabels: readonly (readonly [string, string])[] = [
  ["original", "original (Google Slides)"],
  ["rendered", "test (Sasha HTML)"],
  ["fixture", "round trip: original fixture HTML"],
];

/** Browser-side reverse logic; see the file header for the globals it shares with the forward script. */
export const reverseClientScript = `
// ---- Reverse mode (Google Slides -> Sasha HTML) ----
let reverseView = 'reverse';   // 'reverse' = Google thumbnail vs Sasha; 'round-trip' = fixture vs Sasha
let reverseOrder = 'deck';
let deckOrder = [];            // the server's order, so "Deck order" can be restored after a worst-first sort

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hasRoundTrip(c) { return !!(c && c.reverse && c.reverse.fixturePng); }
function showsRoundTrip(c) { return reverseView === 'round-trip' && hasRoundTrip(c); }
function reverseOriginalPath(c) { return showsRoundTrip(c) ? c.reverse.fixturePng : c.originalPng; }
function reverseTestPath(c) {
  return showsRoundTrip(c) && c.reverse.roundTripSashaPng ? c.reverse.roundTripSashaPng : c.slidesPng;
}
function linkOrText(href, text) {
  return href ? '<a href="' + escapeHtml(href) + '" target="_blank">' + text + ' &#8599;</a>' : text;
}

// Switch the left pane between the Google thumbnail and the fixture screenshot IN
// PLACE (like toggleShowDiff): a full render() would rebuild the draw canvas and
// lose an in-progress annotation and unsaved comment text.
function setReverseView(view) {
  reverseView = view;
  const c = comparisons[currentIdx];
  if (!c) return;
  const originalImg = document.getElementById('originalImg');
  const slidesImg = document.getElementById('slidesImg');
  const originalSource = '/img?path=' + encodeURIComponent(reverseOriginalPath(c));
  const testSource = '/img?path=' + encodeURIComponent(reverseTestPath(c));
  if (originalImg && originalImg.getAttribute('src') !== originalSource) originalImg.src = originalSource;
  if (slidesImg && slidesImg.getAttribute('src') !== testSource) slidesImg.src = testSource;
  applyReverseLabels(c);
  renderReverseMetrics(c);
  refreshReverseNavigation();
  if (showDiff) computeClientSideDiff();
}

// The nav strip shows the mismatch of the CURRENT view; update its anchors in place
// (render() would rebuild the panes). Anchors are in visibleComparisons() order.
function refreshReverseNavigation() {
  const anchors = document.querySelectorAll('#nav a');
  visibleComparisons().forEach((c, index) => {
    const anchor = anchors[index];
    if (!anchor) return;
    anchor.classList.remove('mismatch-good', 'mismatch-fair', 'mismatch-poor');
    const mismatch = reverseNavigationClass(c).trim();
    if (mismatch) anchor.classList.add(mismatch);
    anchor.innerHTML = reverseNavigationLabel(c);
  });
}

function applyReverseLabels(c) {
  if (!c) return;
  const reverse = c.reverse || {};
  const roundTrip = showsRoundTrip(c);
  const labelOriginal = document.getElementById('labelOriginal');
  const labelSlides = document.getElementById('labelSlides');
  const missing = reverseView === 'round-trip' && !roundTrip
    ? ' <span class="reverse-missing">(no round trip for this slide: showing Google Slides)</span>'
    : '';
  if (labelOriginal) labelOriginal.innerHTML = roundTrip
    ? linkOrText(reverse.fixtureHtmlFile ? '/html?path=' + encodeURIComponent(reverse.fixtureHtmlFile) : null, 'Original: fixture HTML')
    : linkOrText(reverse.googleSlidesUrl || null, 'Original: Google Slides') + missing;
  if (labelSlides) labelSlides.innerHTML =
    linkOrText(reverse.sashaHtmlFile ? '/html?path=' + encodeURIComponent(reverse.sashaHtmlFile) : null, 'Test: Sasha HTML');
  const flipOriginal = document.getElementById('flipOriginal');
  const flipRendered = document.getElementById('flipRendered');
  if (flipOriginal) flipOriginal.textContent = roundTrip ? 'Fixture HTML' : 'Google Slides';
  if (flipRendered) flipRendered.textContent = 'Sasha HTML';
  const viewReverse = document.getElementById('viewReverse');
  const viewRoundTrip = document.getElementById('viewRoundTrip');
  if (viewReverse) viewReverse.classList.toggle('active', reverseView === 'reverse');
  if (viewRoundTrip) viewRoundTrip.classList.toggle('active', reverseView === 'round-trip');
}

function mismatchClass(percent) {
  if (percent == null) return '';
  return percent <= 2 ? 'metric-good' : percent <= 8 ? 'metric-fair' : 'metric-poor';
}
function textMatchClass(fraction) {
  if (fraction == null) return '';
  return fraction >= 0.98 ? 'metric-good' : fraction >= 0.9 ? 'metric-fair' : 'metric-poor';
}
function formatPercent(percent) {
  return percent == null ? 'n/a' : percent.toFixed(percent < 10 ? 2 : 1) + '%';
}

function renderReverseMetrics(c) {
  const chips = document.getElementById('reverseMetrics');
  const notes = document.getElementById('reverseNotes');
  if (!chips || !notes) return;
  const metric = c && c.reverse ? c.reverse.metric : null;
  if (!metric) {
    chips.innerHTML = '<span class="metric-chip">no metrics.json row for this slide</span>';
    notes.textContent = '';
    return;
  }
  const roundTrip = showsRoundTrip(c);
  chips.innerHTML =
    '<span class="reverse-case">' + escapeHtml(metric.set) + ' / ' + escapeHtml(metric.caseId) + ' / slide ' + metric.slideNumber + '</span>' +
    '<span class="metric-chip ' + mismatchClass(metric.reverseMismatchPercent) + (roundTrip ? '' : ' current-view') + '" title="Pixel mismatch: Sasha HTML vs Google Slides thumbnail">Reverse mismatch ' + formatPercent(metric.reverseMismatchPercent) + '</span>' +
    '<span class="metric-chip ' + mismatchClass(metric.roundTripMismatchPercent) + (roundTrip ? ' current-view' : '') + '" title="Pixel mismatch: Sasha HTML vs the original fixture HTML">Round-trip mismatch ' + formatPercent(metric.roundTripMismatchPercent) + '</span>' +
    '<span class="metric-chip ' + textMatchClass(metric.textMatch) + '" title="Share of the slide text that survived the import">Text match ' + (metric.textMatch == null ? 'n/a' : (metric.textMatch * 100).toFixed(1) + '%') + '</span>';
  notes.textContent = metric.notes || '';
}

// Worst-first ordering. Larger is worse for both mismatches; a LOWER text match is
// worse, so it sorts on the negated fraction. Slides without the number go last.
function reverseSortValue(c, order) {
  const metric = c.reverse ? c.reverse.metric : null;
  if (!metric) return null;
  if (order === 'reverse') return metric.reverseMismatchPercent;
  if (order === 'round-trip') return metric.roundTripMismatchPercent;
  if (order === 'text') return metric.textMatch == null ? null : -metric.textMatch;
  return null;
}
function applyReverseOrder() {
  const position = new Map(deckOrder.map((id, index) => [id, index]));
  comparisons.sort((first, second) => {
    if (reverseOrder !== 'deck') {
      const firstValue = reverseSortValue(first, reverseOrder);
      const secondValue = reverseSortValue(second, reverseOrder);
      if (firstValue != null && secondValue == null) return -1;
      if (firstValue == null && secondValue != null) return 1;
      if (firstValue != null && secondValue != null && firstValue !== secondValue) return secondValue - firstValue;
    }
    return (position.get(first.id) || 0) - (position.get(second.id) || 0);
  });
}
// A worst-first order exists to review the worst slide first, so jump to the head
// of the new order; going back to deck order keeps the slide being looked at.
function setReverseOrder(order) {
  reverseOrder = order;
  const select = document.getElementById('reverseOrder');
  if (select && select.value !== order) select.value = order;
  const currentId = comparisons[currentIdx] && comparisons[currentIdx].id;
  applyReverseOrder();
  const visible = visibleComparisons();
  const targetId = order === 'deck' ? currentId : (visible[0] || {}).id;
  currentIdx = Math.max(0, comparisons.findIndex(c => c.id === targetId));
  render();
}

function reverseNavigationLabel(c) {
  const reverse = c.reverse;
  if (!reverse) return escapeHtml(c.id);
  const metric = reverse.metric;
  const percent = metric ? (reverseView === 'round-trip' ? metric.roundTripMismatchPercent : metric.reverseMismatchPercent) : null;
  return escapeHtml(reverse.navigationLabel) + (percent == null ? '' : '<span class="nav-metric">' + percent.toFixed(1) + '%</span>');
}
function reverseNavigationClass(c) {
  const metric = c.reverse ? c.reverse.metric : null;
  if (!metric) return '';
  const percent = reverseView === 'round-trip' ? metric.roundTripMismatchPercent : metric.reverseMismatchPercent;
  return percent == null ? '' : ' ' + mismatchClass(percent).replace('metric-', 'mismatch-');
}
function reverseNavigationTitle(c) {
  const metric = c.reverse ? c.reverse.metric : null;
  if (!metric) return escapeHtml(c.id);
  return escapeHtml(c.id + ' | reverse ' + formatPercent(metric.reverseMismatchPercent) + ' | round trip ' + formatPercent(metric.roundTripMismatchPercent) + ' | text ' + (metric.textMatch == null ? 'n/a' : (metric.textMatch * 100).toFixed(1) + '%'));
}

async function refreshReverseReport() {
  const summary = await fetch('/api/summary').then(response => response.json());
  const parts = [
    '<b>Reverse fidelity</b> (Google Slides &rarr; Sasha HTML): ' + summary.slideCount + ' slides',
    summary.ratedGood + ' good / ' + summary.ratedBad + ' bad',
    'mean reverse mismatch ' + formatPercent(summary.meanReverseMismatchPercent),
    'mean round-trip mismatch ' + formatPercent(summary.meanRoundTripMismatchPercent),
    'mean text match ' + (summary.meanTextMatch == null ? 'n/a' : (summary.meanTextMatch * 100).toFixed(1) + '%'),
  ];
  if (summary.worstReverse) parts.push('worst reverse: ' + escapeHtml(summary.worstReverse.id) + ' (' + formatPercent(summary.worstReverse.mismatchPercent) + ')');
  if (summary.worstRoundTrip) parts.push('worst round trip: ' + escapeHtml(summary.worstRoundTrip.id) + ' (' + formatPercent(summary.worstRoundTrip.mismatchPercent) + ')');
  parts.push(summary.goldenCount + ' reverse golden(s) blessed in ' + escapeHtml(summary.goldensDirectory));
  parts.push('verdicts: ' + escapeHtml(summary.ratingsFile));
  let html = parts.join(' &middot; ');
  if (summary.missingSashaRender.length) html += '<br><span style="color:#e94560">No Sasha render for: ' + summary.missingSashaRender.map(escapeHtml).join(', ') + '</span>';
  if (summary.problems.length) html += '<br><span style="color:#e67e22">' + summary.problems.map(escapeHtml).join('<br>') + '</span>';
  document.getElementById('goldenReport').innerHTML = html;
}
`;
