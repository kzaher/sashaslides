/**
 * rating-ui.ts — the browser client of the SxS rating page served by rating-server.ts.
 *
 * rating-page.ts renders the static markup (the editing controls only when the server
 * is not --read-only) and embeds the server's settings as JSON in #ratingConfig;
 * rating-server.ts bundles this module with esbuild at startup and serves it as
 * /rating-ui.js. Features: the original | render panes with blink-flip, the in-browser
 * diff overlay, the rendered-regions highlight, pen and rect annotation with undo, the
 * hover magnifier, Good / Bad / Skip (plus "Reject ALL"), per-annotation zoom-crops,
 * the round-1 provenance panel, the task-scoped analysis panels, the goldens report,
 * the end-of-deck popup and, in reverse mode, the view toggle and worst-first order
 * (rating-ui-reverse.ts).
 */
import type { ReverseView } from "./reverse-rating.ts";
import { parseRatingPageConfig, type DrawShape, type ForwardSummary, type RateReply, type RatingStatus, type SlideComparison } from "./rating-wire.ts";
import { assertNever, context2d, elementById, escapeHtml, imageUrl, requiredElement } from "./rating-ui-dom.ts";
import {
  applyReverseImages,
  applyReverseLabels,
  parseReverseOrder,
  refreshReverseNavigation,
  refreshReverseReport,
  renderReverseMetrics,
  reverseNavigationClass,
  reverseNavigationLabel,
  reverseNavigationTitle,
  reverseOriginalPath,
  reverseTestPath,
  sortReverse,
  type ReverseOrder,
} from "./rating-ui-reverse.ts";

type Comparison = Readonly<SlideComparison>;
type FlipSide = "left" | "right";
type DrawTool = "pen" | "rect";
type TaskPanel = "analysis" | "diff";

const config = parseRatingPageConfig(JSON.parse(requiredElement("ratingConfig", HTMLScriptElement).textContent ?? ""));
const reverseMode = config.direction === "reverse";

let comparisons: Comparison[] = [];
let currentIdx = 0;
let showAll = config.showAllDefault;
let showDiff = false;
let showRendered = false;
// --- Blink-comparator flip ---
let flipMode = false;   // false = side-by-side (DEFAULT); true = stacked/tabbed (flick between).
                        // SxS shows both panels — incl. the rendered panel's annotation canvas.
let flipSide: FlipSide = "left";  // 'left' = original (target), 'right' = rendered (Slides)
// --- Draw overlay on the render (editable pages only) ---
let drawMode = true;   // DEFAULT ON: the annotation canvas is live on load (pen
                       // ready) so reviewers can draw immediately. Toggle "Draw"
                       // off to interact with the slide / magnifier instead.
let drawTool: DrawTool = "pen";
let canvasHasStrokes = false;
let drawHistory: ImageData[] = []; // stack of ImageData snapshots, one per completed stroke
let drawShapes: DrawShape[] = [];  // committed annotation shapes (canvas coords) for per-region zoom-crops
// Cached PNG of the draw canvas, composited into the magnifier so the loupe
// shows your strokes over the render (not just the bare image). Refreshed
// whenever the drawing changes.
let drawCanvasDataUrl: string | null = null;
let loupeOn = false;
// --- Reverse mode (Google Slides -> Sasha HTML) ---
let reverseView: ReverseView = "reverse";   // 'reverse' = Google thumbnail vs Sasha; 'round-trip' = fixture vs Sasha
let reverseOrder: ReverseOrder = "deck";
let deckOrder: readonly string[] = [];      // the server's order, so "Deck order" can be restored after a worst-first sort

wireControls();
document.addEventListener("keydown", onKeyDown);
// CAPTURE phase so the draw canvas's pointer-events:auto (when Draw is on) can't block the magnifier.
document.addEventListener("mousemove", onMagnifierMove, true);
void load();

async function load(): Promise<void> {
  // The server's own /api/comparisons: JSON.stringify(findComparisons()), typed by rating-wire.ts.
  comparisons = (await (await fetch("/api/comparisons")).json()) as Comparison[];
  if (reverseMode) {
    deckOrder = comparisons.map((c) => c.id);
    comparisons = sortReverse({ comparisons, order: reverseOrder, deckOrder });
    void refreshReverseReport();
  } else {
    void refreshReport();
  }
  const visible = visibleComparisons();
  const pendingIdx = visible.findIndex((c) => c.status === "pending");
  const firstVisibleId = visible[pendingIdx >= 0 ? pendingIdx : 0]?.id;
  currentIdx = comparisons.findIndex((c) => c.id === firstVisibleId);
  if (currentIdx < 0) currentIdx = 0;
  render();
}

/** Attach every static control's handler; editing controls are absent on read-only pages. */
function wireControls(): void {
  onClick("flipOriginal", () => setFlipSide("left"));
  onClick("flipRendered", () => setFlipSide("right"));
  onClick("flipToggle", toggleFlip);
  onChange("showDiff", toggleShowDiff);
  onChange("showRendered", toggleShowRendered);
  onChange("loupeToggle", toggleLoupe);
  onClick("dismissDone", dismissDone);
  onClick("rateGood", () => void rate("good"));
  onClick("rateBad", () => void rate("bad"));
  onClick("skip", () => navigate(1));
  onClick("rejectAll", () => void rejectAllStop());
  onClick("showAnalysisBtn", () => void toggleTaskPanel("analysis"));
  onClick("showDiffAnalysisBtn", () => void toggleTaskPanel("diff"));
  if (!config.readOnly) {
    onClick("drawToggle", toggleDraw);
    onClick("toolPen", () => setTool("pen"));
    onClick("toolRect", () => setTool("rect"));
    onChange("priorMarksToggle", applyPriorMarks);
    onClick("clearDraw", () => void clearDraw());
  }
  if (reverseMode) {
    onClick("viewReverse", () => setReverseView("reverse"));
    onClick("viewRoundTrip", () => setReverseView("round-trip"));
    const order = elementById("reverseOrder", HTMLSelectElement);
    order?.addEventListener("change", () => setReverseOrder(parseReverseOrder(order.value)));
  }
  // Rebuilt on every render(), so delegate: nav anchors carry data-index, the slide line's toggle data-show-all.
  requiredElement("nav", HTMLElement).addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-index]") : null;
    if (!anchor) return;
    event.preventDefault();
    currentIdx = Number(anchor.dataset.index);
    render();
  });
  requiredElement("slideId", HTMLElement).addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-show-all]") : null;
    if (!anchor) return;
    event.preventDefault();
    showAll = anchor.dataset.showAll === "true";
    render();
  });
}

function onClick(id: string, handler: () => void): void {
  elementById(id, HTMLElement)?.addEventListener("click", handler);
}

function onChange(id: string, handler: () => void): void {
  elementById(id, HTMLInputElement)?.addEventListener("change", handler);
}

function visibleComparisons(): Comparison[] {
  // By default, hide slides that match their blessed golden (status=good +
  // diffStatus=ok). Show everything else: regressed, new fixtures, bad, pending.
  if (showAll) return comparisons;
  return comparisons.filter((c) => c.status !== "good" || (c.diffStatus && c.diffStatus !== "ok"));
}

/** Replace the current comparison with `changes` applied (rows are immutable). */
function updateCurrent(changes: Partial<SlideComparison>): Comparison | null {
  const c = comparisons[currentIdx];
  if (!c) return null;
  const next: Comparison = { ...c, ...changes };
  comparisons[currentIdx] = next;
  return next;
}

function humanizeAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return (s / 3600).toFixed(1) + "h ago";
  return (s / 86400).toFixed(1) + "d ago";
}

async function refreshReport(): Promise<void> {
  // The server's own forward /api/summary, typed by rating-wire.ts.
  const r = (await (await fetch("/api/summary")).json()) as ForwardSummary;
  const age = r.oldestRenderMs != null ? humanizeAge(r.nowMs - r.oldestRenderMs) : "no render yet";
  requiredElement("goldenReport", HTMLElement).innerHTML =
    "<b>Goldens report</b> — " +
    r.matching + "/" + r.goldenTotal + " goldens still pixel-match current render" +
    (r.regressed ? ' · <span style="color:#e94560">' + r.regressed + " regressed</span>" : "") +
    (r.new ? ' · <span style="color:#8e44ad">' + r.new + " new (never blessed)</span>" : "") +
    " · oldest current-render thumbnail: " + age + " (proves re-scrape)";
}

function render(): void {
  const c = comparisons[currentIdx];
  if (!c) return;

  // Always two panels: Original · Slides. When "Show diff" is checked we
  // compute the diff IN THE BROWSER between the exact two <img>s on screen
  // and paint it to a canvas overlay on the original, so the diff is the
  // difference between what the user actually sees.
  const diffOverlay = showDiff && c.slidesPng ? '<canvas class="diff-overlay" id="diffCanvas"></canvas>' : "";
  const renderedOverlayHtml = c.renderedRegions && c.renderedRegions.length
    ? '<canvas class="rendered-overlay" id="renderedOverlay"></canvas>'
    : "";
  // Reconstruct the prior-round annotation on the CURRENT render: overlay the
  // saved marks (same 16:9 bounds) on the Slides panel, toggleable via "Prior
  // marks". pointer-events:none so it never blocks drawing new ones on top.
  const priorAnnotHtml = c.origAnnotationPng
    ? '<img class="prior-annot" id="priorAnnot" src="' + imageUrl(c.origAnnotationPng) + '">'
    : "";
  // READ-ONLY: the Slides panel carries a static saved-annotation overlay (no
  // draw canvas). EDITABLE: it carries the live drawing canvas instead.
  const slidesExtra = config.readOnly
    ? (c.annotationPng ? '<img class="prior-annot" id="savedAnnot" src="' + imageUrl(c.annotationPng) + '">' : "")
    : '<canvas id="drawCanvas"></canvas>';
  const originalPath = reverseMode ? reverseOriginalPath(c, reverseView) : c.originalPng;
  const testPath = reverseMode ? reverseTestPath(c, reverseView) : c.slidesPng;
  requiredElement("pair", HTMLElement).innerHTML =
    '<div class="panel original"><img id="originalImg" src="' + imageUrl(originalPath) + '">' + diffOverlay + "</div>" +
    '<div class="panel slides"><img id="slidesImg" src="' + imageUrl(testPath) + '">' + renderedOverlayHtml + priorAnnotHtml + slidesExtra + "</div>";
  if (!config.readOnly) {
    setupDrawCanvas(c.annotationPng ?? null);
    applyPriorMarks(); // honor the "Prior marks" toggle on the freshly-built panel
  }
  applyFlip(); // re-apply blink-comparator state to the freshly-rebuilt panels
  if (showDiff) computeClientSideDiff();
  paintRenderedOverlay(c);

  renderBanners(c);
  const visible = visibleComparisons();
  const visIdx = visible.findIndex((x) => x.id === c.id);
  const showAllLink = showAll
    ? '<a href="#" data-show-all="false">only diffs</a>'
    : '<a href="#" data-show-all="true">show all</a>';
  requiredElement("slideId", HTMLElement).innerHTML =
    escapeHtml(c.id) + statusBadges(c) + " (" + (visIdx >= 0 ? visIdx + 1 : "-") + "/" + visible.length + " visible, " + comparisons.length + " total — " + showAllLink + ")";

  // Column headers double as links: "Original HTML" → the source fixture,
  // "Google Slides" → the live presentation.
  requiredElement("labelOriginal", HTMLElement).innerHTML = c.htmlFile
    ? '<a href="/html?path=' + encodeURIComponent(c.htmlFile) + '" target="_blank">Original HTML ↗</a>'
    : "Original HTML";
  requiredElement("labelSlides", HTMLElement).innerHTML = c.slidesUrl
    ? '<a href="' + escapeHtml(c.slidesUrl) + '" target="_blank">Google Slides ↗</a>'
    : "Google Slides";
  requiredElement("slideLinks", HTMLElement).innerHTML = ""; // links now live in the top labels
  if (reverseMode) {
    applyReverseLabels(c, reverseView);
    renderReverseMetrics(c, reverseView);
  }

  const good = comparisons.filter((x) => x.status === "good").length;
  const bad = comparisons.filter((x) => x.status === "bad").length;
  const pending = comparisons.filter((x) => x.status === "pending").length;
  requiredElement("stats", HTMLElement).textContent = good + " good / " + bad + " bad / " + pending + " pending";

  renderNavigation(visible);

  const analysisEl = requiredElement("analysis", HTMLElement);
  if (c.analysis) { analysisEl.style.display = "block"; analysisEl.textContent = c.analysis; }
  else { analysisEl.style.display = "none"; }

  requiredElement("savedComment", HTMLElement).innerHTML = c.comment
    ? '<div class="saved-comment"><div class="label">Comment</div>' + escapeHtml(c.comment) + "</div>"
    : "";

  renderProvenance(c);
  renderZoomCrops(c);

  // Pre-fill the comment box: this round's saved comment if any, otherwise the
  // prior round's comment (origComment) so the reviewer edits it in place rather
  // than retyping. READ-ONLY pages have no comment box.
  const commentEl = elementById("comment", HTMLTextAreaElement);
  if (commentEl) commentEl.value = c.comment || c.origComment || "";

  // Task-scoped reveal buttons: reset to collapsed on every slide change so
  // stale content from the previous slide doesn't flash.
  if (config.taskScoped) {
    requiredElement("taskReveals", HTMLElement).style.display = "flex";
    requiredElement("taskAnalysisPanel", HTMLElement).style.display = "none";
    requiredElement("taskDiffPanel", HTMLElement).style.display = "none";
    requiredElement("showAnalysisBtn", HTMLElement).classList.remove("active");
    requiredElement("showDiffAnalysisBtn", HTMLElement).classList.remove("active");
  }
}

function statusBadges(c: Comparison): string {
  const badge = '<span class="status-badge status-' + c.status + '">' + c.status + "</span>";
  if (!c.diffStatus) return badge;
  const diffClass = c.diffStatus === "ok" ? "good" : c.diffStatus;
  return badge + '<span class="status-badge status-' + escapeHtml(diffClass) + '">⚠ ' + escapeHtml(c.diffStatus.toUpperCase()) + (c.diffPixels ? " · " + c.diffPixels + "px" : "") + "</span>";
}

function renderBanners(c: Comparison): void {
  // Top regression banner — makes the "this is a golden that regressed" state
  // impossible to miss.
  requiredElement("regressionBanner", HTMLElement).innerHTML = c.diffStatus === "regressed"
    ? '<div class="regression-banner">⚠ REGRESSION — this slide was previously blessed as a golden but now diverges from it by ' + (c.diffPixels || 0) + " pixels. Check the yellow diff panel on the right.</div>"
    : "";
  // Rendered-regions warning — the converter fell back to a rasterized image
  // instead of native Slides primitives; the highlight overlay shows where.
  const regions = c.renderedRegions ?? [];
  if (regions.length === 0) {
    requiredElement("renderedBanner", HTMLElement).innerHTML = "";
    return;
  }
  const kinds = new Map<string, number>();
  for (const region of regions) kinds.set(region.kind, (kinds.get(region.kind) ?? 0) + 1);
  const kindStr = [...kinds].map(([kind, count]) => escapeHtml(kind) + "×" + count).join(", ");
  requiredElement("renderedBanner", HTMLElement).innerHTML =
    '<div class="rendered-banner">⚠ RENDERED CONTENT — ' + regions.length + ' region(s) emitted as rasterized image(s) instead of native Slides primitives.<span class="kinds">(' + kindStr + ') — toggle "Highlight rendered regions" to see them.</span></div>';
}

/** Nav strip: only visible comparisons, each anchor carrying its real index. */
function renderNavigation(visible: readonly Comparison[]): void {
  requiredElement("nav", HTMLElement).innerHTML = visible.map((c) => {
    const i = comparisons.findIndex((x) => x.id === c.id);
    const cls = (i === currentIdx ? "current " : "") + "status-" + c.status + " diff-" + escapeHtml(c.diffStatus || "none");
    if (reverseMode) {
      const mismatch = reverseNavigationClass(c, reverseView);
      return '<a href="#" class="' + cls + (mismatch ? " " + mismatch : "") + '" title="' + reverseNavigationTitle(c) + '" data-index="' + i + '">' + reverseNavigationLabel(c, reverseView) + "</a>";
    }
    return '<a href="#" class="' + cls + '" data-index="' + i + '">' + escapeHtml(c.id.replace("slide_", "S")) + "</a>";
  }).join("");
}

/**
 * Round-1 provenance panel: original source HTML, live presentation, the
 * annotation the user drew, and the comment they typed when they rated the
 * slide bad. Hidden when none exist (older runs without sxs-meta.json).
 */
function renderProvenance(c: Comparison): void {
  const parts: string[] = [];
  const links: string[] = [];
  if (c.htmlFile) links.push('<a href="/html?path=' + encodeURIComponent(c.htmlFile) + '" target="_blank">Original source HTML ↗</a>');
  if (c.slidesUrl) links.push('<a href="' + escapeHtml(c.slidesUrl) + '" target="_blank">Open rendered presentation in Slides ↗</a>');
  if (links.length) parts.push('<div class="om-links">' + links.join("") + "</div>");
  const body: string[] = [];
  if (c.origAnnotationPng) {
    // Composite the overlay onto the original slide (same 16:9 bounds) so the
    // drawn marks sit on the slide, not a black field.
    const annotImg = imageUrl(c.origAnnotationPng);
    const inner = c.originalPng
      ? '<div class="om-annot-stack"><img class="om-annot-base" src="' + imageUrl(c.originalPng) + '"><img class="om-annot-overlay" src="' + annotImg + '"></div>'
      : '<img class="om-annot-solo" src="' + annotImg + '">';
    body.push('<div class="om-annotation"><figure><figcaption>Original annotation (your marks on the target)</figcaption>' + inner + "</figure></div>");
  }
  if (c.origComment) body.push('<div class="om-comment"><div class="om-label">Original comment</div>' + escapeHtml(c.origComment) + "</div>");
  if (body.length) parts.push('<div class="om-body">' + body.join("") + "</div>");
  requiredElement("origMeta", HTMLElement).innerHTML = parts.length
    ? '<div class="orig-meta"><div class="om-title">Round-1 provenance</div>' + parts.join("") + "</div>"
    : "";
}

/** Per-annotation zoom-crops, grouped by region index from the file name <id>-NN-side.png. */
function renderZoomCrops(c: Comparison): void {
  const zcEl = requiredElement("zoomCrops", HTMLElement);
  const crops = c.zoomCrops ?? [];
  if (crops.length === 0) { zcEl.innerHTML = ""; return; }
  const groups = new Map<string, Map<string, string>>();
  for (const path of crops) {
    const match = path.match(/-(\d+)-(original|rendered|fixture)\.png$/);
    const key = match?.[1] ?? "00";
    const side = match?.[2] ?? "crop";
    const group = groups.get(key) ?? new Map<string, string>();
    group.set(side, path);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  let html = '<div class="zoom-crops"><div class="zoom-crops-label">🔍 Marked regions — ' + escapeHtml(config.zoomCropTitle) + ", " + keys.length + ' region(s):</div><div class="zoom-crops-grid">';
  for (const key of keys) {
    const group = groups.get(key);
    html += '<div class="zoom-crop-pair">';
    for (const label of config.zoomCropLabels) {
      const path = group?.get(label.side);
      if (path) html += '<div class="zoom-crop"><figure><figcaption>' + escapeHtml(label.caption) + '</figcaption><img src="' + imageUrl(path) + "&t=" + Date.now() + '"></figure></div>';
    }
    html += "</div>";
  }
  zcEl.innerHTML = html + "</div></div>";
}

/**
 * Toggle one of the two task-scoped reveal panels. When opening, fetch the
 * slide-specific payload from the server; when closing, just hide.
 */
async function toggleTaskPanel(kind: TaskPanel): Promise<void> {
  const c = comparisons[currentIdx];
  if (!c) return;
  const ids = taskPanelIds(kind);
  const panel = requiredElement(ids.panel, HTMLElement);
  const body = requiredElement(ids.body, HTMLElement);
  const opening = panel.style.display === "none";
  panel.style.display = opening ? "block" : "none";
  requiredElement(ids.button, HTMLElement).classList.toggle("active", opening);
  if (!opening) return;
  body.textContent = "loading…";
  const response = await fetch(ids.endpoint + "?slide=" + encodeURIComponent(c.id));
  body.textContent = await response.text();
}

function taskPanelIds(kind: TaskPanel): Readonly<{ panel: string; body: string; button: string; endpoint: string }> {
  switch (kind) {
    case "analysis":
      return { panel: "taskAnalysisPanel", body: "taskAnalysisBody", button: "showAnalysisBtn", endpoint: "/api/task-analysis" };
    case "diff":
      return { panel: "taskDiffPanel", body: "taskDiffBody", button: "showDiffAnalysisBtn", endpoint: "/api/task-diff" };
    default:
      return assertNever(kind);
  }
}

async function rejectAllStop(): Promise<void> {
  // Convenience: mark EVERY filtered slide Bad in one shot (no per-slide clicks),
  // then close. --exit-when-all-rated sees them all rated and exits the server.
  if (!confirm("Mark ALL " + comparisons.length + " shown slide(s) BAD and close?")) return;
  for (const c of comparisons) {
    await postJson("/api/rate", { id: c.id, status: "bad" }).catch(() => undefined);
  }
  comparisons = comparisons.map((c) => ({ ...c, status: "bad" }));
  document.body.innerHTML = '<h1 style="padding:40px;font-family:system-ui">All ' + comparisons.length + " slide(s) marked Bad. Closing…</h1>";
}

async function rate(status: Exclude<RatingStatus, "pending">): Promise<void> {
  const c = comparisons[currentIdx];
  if (!c) return;
  if (config.readOnly) {
    // READ-ONLY UI: a rating records ONLY the good/bad status. No comment,
    // annotation or draw-shapes are sent — the server ignores them anyway and
    // the ledger's existing comment/annotation stay untouched.
    await postJson("/api/rate", { id: c.id, status }).catch(() => undefined);
    updateCurrent({ status });
    navigate(1);
    return;
  }
  const comment = (elementById("comment", HTMLTextAreaElement)?.value ?? "").trim();
  // Export the annotation canvas if anything was drawn, with the committed
  // shapes (canvas coords) so the server can crop each marked region into an
  // original|test pair. Shapes are empty when the annotation was loaded from
  // disk rather than drawn this session → the server falls back to the
  // whole-annotation bbox.
  const canvas = elementById("drawCanvas", HTMLCanvasElement);
  const drawing = canvas && canvasHasStrokes
    ? { annotation: canvas.toDataURL("image/png"), shapes: drawShapes.slice(), canvasSize: { w: canvas.width, h: canvas.height } }
    : {};
  const response = await postJson("/api/rate", {
    id: c.id, status, comment: comment || undefined, ...drawing, pencilPadding: 24,
    view: reverseMode ? reverseView : undefined,
  });
  // The server's own editable /api/rate reply, typed by rating-wire.ts.
  const result = (await response.json().catch(() => ({}))) as RateReply;
  const changes: Partial<SlideComparison> = { status, comment: comment || undefined };
  if (Array.isArray(result.zoomCrops)) changes.zoomCrops = result.zoomCrops.length ? [...result.zoomCrops] : undefined;
  // Persist the saved annotation path back onto the comparison so the re-render
  // (navigate → render → setupDrawCanvas) RELOADS the strokes instead of showing
  // a blank canvas on single-slide sets (navigate stays on the same slide).
  if (result.annotationPath) changes.annotationPng = result.annotationPath;
  updateCurrent(changes);
  navigate(1);
}

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function setTool(tool: DrawTool): void {
  drawTool = tool;
  elementById("toolPen", HTMLElement)?.classList.toggle("active", tool === "pen");
  elementById("toolRect", HTMLElement)?.classList.toggle("active", tool === "rect");
}

/** Show/hide the prior-round annotation overlay per the "Prior marks" checkbox; called after every render too. */
function applyPriorMarks(): void {
  const overlay = elementById("priorAnnot", HTMLImageElement);
  const toggle = elementById("priorMarksToggle", HTMLInputElement);
  if (overlay && toggle) overlay.classList.toggle("hidden", !toggle.checked);
}

function applyFlip(): void {
  const pair = elementById("pair", HTMLElement);
  if (!pair) return;
  pair.classList.toggle("flip", flipMode);
  pair.querySelector(".panel.original")?.classList.toggle("flip-active", flipMode && flipSide === "left");
  pair.querySelector(".panel.slides")?.classList.toggle("flip-active", flipMode && flipSide === "right");
  elementById("flipOriginal", HTMLElement)?.classList.toggle("active", flipMode && flipSide === "left");
  elementById("flipRendered", HTMLElement)?.classList.toggle("active", flipMode && flipSide === "right");
  const toggle = elementById("flipToggle", HTMLElement);
  if (toggle) {
    toggle.classList.toggle("active", !flipMode);
    toggle.innerHTML = flipMode ? "&#9635; Flip" : "&#8644; Side-by-side";
  }
}

function setFlipSide(side: FlipSide): void { flipMode = true; flipSide = side; applyFlip(); }
function toggleFlip(): void { flipMode = !flipMode; applyFlip(); }
function flickFlip(): void { if (flipMode) { flipSide = flipSide === "left" ? "right" : "left"; applyFlip(); } }

function refreshDrawCache(): void {
  const canvas = elementById("drawCanvas", HTMLCanvasElement);
  drawCanvasDataUrl = canvas && canvasHasStrokes ? canvas.toDataURL("image/png") : null;
}

function undoDraw(): void {
  const canvas = elementById("drawCanvas", HTMLCanvasElement);
  if (!canvas || drawHistory.length === 0) return;
  const ctx = context2d(canvas);
  const prev = drawHistory.pop();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (prev) ctx.putImageData(prev, 0, 0);
  canvasHasStrokes = drawHistory.length > 0 || !!prev;
  drawShapes.pop();
  refreshDrawCache();
}

function toggleShowDiff(): void {
  showDiff = requiredElement("showDiff", HTMLInputElement).checked;
  // Toggle the diff overlay IN PLACE. A full render() would rebuild the #pair
  // innerHTML — destroying the draw canvas (losing in-progress annotations)
  // and resetting the comment box. The diff canvas lives on the ORIGINAL panel,
  // independent of the draw canvas and the comment box.
  const c = comparisons[currentIdx];
  const origPanel = document.querySelector("#pair .panel.original");
  if (!origPanel || !c) return;
  const existing = elementById("diffCanvas", HTMLCanvasElement);
  if (showDiff && c.slidesPng) {
    if (!existing) {
      const canvas = document.createElement("canvas");
      canvas.id = "diffCanvas";
      canvas.className = "diff-overlay";
      origPanel.appendChild(canvas);
    }
    computeClientSideDiff();
  } else if (existing) {
    existing.remove();
  }
}

function toggleShowRendered(): void {
  showRendered = requiredElement("showRendered", HTMLInputElement).checked;
  const c = comparisons[currentIdx];
  if (c) paintRenderedOverlay(c);
}

/**
 * Paint the rendered-region highlight overlay on the Slides panel. Each region
 * is filled with rgb(128,128,128); with the canvas's mix-blend-mode:plus-lighter
 * this adds 128 to each channel of the image below. A transparent canvas when
 * the checkbox is off leaves the panel exactly as before.
 */
function paintRenderedOverlay(c: Comparison): void {
  const canvas = elementById("renderedOverlay", HTMLCanvasElement);
  const img = elementById("slidesImg", HTMLImageElement);
  if (!canvas || !img) return;
  const init = (): void => {
    canvas.width = img.naturalWidth || img.clientWidth;
    canvas.height = img.naturalHeight || img.clientHeight;
    const ctx = context2d(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showRendered || !c.renderedRegions) return;
    ctx.fillStyle = "rgb(128,128,128)";
    for (const r of c.renderedRegions) ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
  };
  if (img.complete && img.naturalWidth) init();
  else img.addEventListener("load", init, { once: true });
}

/**
 * Per-pixel diff in the browser between the two visible <img>s. Writes red
 * pixels to the overlay canvas wherever they differ by more than THRESHOLD.
 * Both images are drawn onto a common WORK_W x WORK_H grid so different source
 * resolutions line up 1:1 before comparison.
 */
function computeClientSideDiff(): void {
  const origImg = elementById("originalImg", HTMLImageElement);
  const slidesImg = elementById("slidesImg", HTMLImageElement);
  const out = elementById("diffCanvas", HTMLCanvasElement);
  if (!origImg || !slidesImg || !out) return;
  void Promise.all([imageLoaded(origImg), imageLoaded(slidesImg)]).then(() => {
    const WORK_W = 1600, WORK_H = 900;
    const THRESHOLD = 10; // per-channel L1 sum; tuned for font-hinting noise
    const aData = pixelsAt(origImg, WORK_W, WORK_H);
    const bData = pixelsAt(slidesImg, WORK_W, WORK_H);
    out.width = WORK_W; out.height = WORK_H;
    const octx = context2d(out);
    const diffImg = octx.createImageData(WORK_W, WORK_H);
    const dData = diffImg.data;
    let count = 0;
    for (let i = 0; i < aData.length; i += 4) {
      const dr = Math.abs((aData[i] ?? 0) - (bData[i] ?? 0));
      const dg = Math.abs((aData[i + 1] ?? 0) - (bData[i + 1] ?? 0));
      const db = Math.abs((aData[i + 2] ?? 0) - (bData[i + 2] ?? 0));
      if (dr + dg + db > THRESHOLD) {
        dData[i] = 255; dData[i + 1] = 0; dData[i + 2] = 0; dData[i + 3] = 200;
        count++;
      }
      // else leave as rgba(0,0,0,0) — fully transparent
    }
    octx.putImageData(diffImg, 0, 0);
    console.log("client diff: " + count + " pixels");
  });
}

function imageLoaded(img: HTMLImageElement): Promise<void> {
  return new Promise((resolve) => {
    if (img.complete && img.naturalWidth) resolve();
    else img.addEventListener("load", () => resolve(), { once: true });
  });
}

function pixelsAt(img: HTMLImageElement, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = context2d(canvas);
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

function toggleDraw(): void {
  drawMode = !drawMode;
  elementById("drawToggle", HTMLElement)?.classList.toggle("active", drawMode);
  const canvas = elementById("drawCanvas", HTMLCanvasElement);
  if (canvas) canvas.style.pointerEvents = drawMode ? "auto" : "none";
}

async function clearDraw(): Promise<void> {
  const canvas = elementById("drawCanvas", HTMLCanvasElement);
  if (canvas) context2d(canvas).clearRect(0, 0, canvas.width, canvas.height);
  canvasHasStrokes = false;
  drawHistory = [];
  drawShapes = [];
  refreshDrawCache();
  // The drawCanvas is NOT the only place an annotation shows: the candidate view
  // ALSO overlays the prior/original annotation (<img id="priorAnnot">) and a
  // rendered-overlay. Clearing only the canvas left those on screen → "Clear
  // doesn't work". Hide them too.
  document.querySelectorAll<HTMLElement>(".rendered-overlay, .prior-annot, .om-annot-overlay").forEach((node) => { node.style.display = "none"; });
  // Also drop any LOADED/PERSISTED annotation so a re-render doesn't reload it
  // from disk and a later save doesn't preserve it, wipe the zoom-crops panel,
  // and tell the server to delete the annotation PNG + zoom-crops for this slide.
  const c = updateCurrent({ annotationPng: undefined, zoomCrops: undefined });
  if (!c) return;
  requiredElement("zoomCrops", HTMLElement).innerHTML = "";
  // Clearing the live canvas already succeeded; the server delete is best-effort.
  await postJson("/api/clear-annotation", { id: c.id }).catch(() => undefined);
}

function setupDrawCanvas(annotationPath: string | null): void {
  const img = elementById("slidesImg", HTMLImageElement);
  const canvas = elementById("drawCanvas", HTMLCanvasElement);
  if (!img || !canvas) return;
  canvas.style.pointerEvents = drawMode ? "auto" : "none";
  elementById("drawToggle", HTMLElement)?.classList.toggle("active", drawMode);
  canvasHasStrokes = false;
  drawHistory = [];
  drawShapes = [];
  const ctx = context2d(canvas);
  const init = (): void => {
    canvas.width = img.naturalWidth || img.clientWidth;
    canvas.height = img.naturalHeight || img.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (annotationPath) {
      const saved = new Image();
      saved.onload = () => { ctx.drawImage(saved, 0, 0, canvas.width, canvas.height); canvasHasStrokes = true; refreshDrawCache(); };
      saved.src = imageUrl(annotationPath) + "&t=" + Date.now();
    }
  };
  if (img.complete && img.naturalWidth) init();
  else img.onload = init;

  type Point = Readonly<{ x: number; y: number }>;
  type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
  let drawing = false;
  let rectStart: Point | null = null;         // where a rect drag began
  let rectSnapshot: ImageData | null = null;  // canvas state before the rect, restored each move for live preview
  let lastPos: Point | null = null;           // most recent pointer pos (rect end + pencil tracking)
  let penBbox: Bounds | null = null;          // accumulated bbox of the current pencil stroke
  const getPos = (event: PointerEvent): Point => {
    const r = canvas.getBoundingClientRect();
    return { x: (event.clientX - r.left) * (canvas.width / r.width), y: (event.clientY - r.top) * (canvas.height / r.height) };
  };
  canvas.onpointerdown = (event) => {
    if (!drawMode) return;
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    // Snapshot the canvas BEFORE this stroke so Ctrl+Z can revert to it; history capped at 50.
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    drawHistory.push(snap);
    if (drawHistory.length > 50) drawHistory.shift();
    ctx.strokeStyle = requiredElement("drawColor", HTMLInputElement).value;
    ctx.lineWidth = parseFloat(requiredElement("drawSize", HTMLInputElement).value) * (canvas.width / canvas.getBoundingClientRect().width);
    const p = getPos(event);
    lastPos = p;
    switch (drawTool) {
      case "rect":
        // Defer drawing to pointermove; keep the pre-rect image to redraw against.
        rectStart = p; rectSnapshot = snap;
        break;
      case "pen":
        penBbox = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
        ctx.beginPath(); ctx.moveTo(p.x, p.y);
        break;
      default:
        assertNever(drawTool);
    }
  };
  canvas.onpointermove = (event) => {
    if (!drawing) return;
    const p = getPos(event);
    lastPos = p;
    switch (drawTool) {
      case "rect":
        // Live preview: restore the pre-rect snapshot, then stroke the current box.
        if (rectSnapshot) ctx.putImageData(rectSnapshot, 0, 0);
        if (rectStart) ctx.strokeRect(rectStart.x, rectStart.y, p.x - rectStart.x, p.y - rectStart.y);
        break;
      case "pen":
        if (penBbox) {
          penBbox.minX = Math.min(penBbox.minX, p.x); penBbox.minY = Math.min(penBbox.minY, p.y);
          penBbox.maxX = Math.max(penBbox.maxX, p.x); penBbox.maxY = Math.max(penBbox.maxY, p.y);
        }
        ctx.lineTo(p.x, p.y); ctx.stroke();
        break;
      default:
        assertNever(drawTool);
    }
    canvasHasStrokes = true;
  };
  const endStroke = (): void => {
    if (drawing) {
      // Commit this stroke's region (canvas coords) so the server can crop it.
      // Rect → the box; pencil → the stroke's bounding box (padded server-side).
      if (drawTool === "rect" && rectStart && lastPos) {
        const x = Math.min(rectStart.x, lastPos.x), y = Math.min(rectStart.y, lastPos.y);
        const w = Math.abs(lastPos.x - rectStart.x), h = Math.abs(lastPos.y - rectStart.y);
        if (w > 3 && h > 3) drawShapes.push({ kind: "rect", x, y, w, h });
      } else if (penBbox) {
        const w = penBbox.maxX - penBbox.minX, h = penBbox.maxY - penBbox.minY;
        if (w > 3 || h > 3) drawShapes.push({ kind: "pencil", x: penBbox.minX, y: penBbox.minY, w, h });
      }
    }
    drawing = false; rectStart = null; rectSnapshot = null; penBbox = null;
    refreshDrawCache();
  };
  canvas.onpointerup = endStroke;
  canvas.onpointercancel = endStroke;
}

/**
 * End-of-deck completion popup, shown when navigate() would advance past the
 * last slide so the reviewer gets clear "all done" feedback. Both rate() paths
 * funnel through navigate(1).
 */
function showDone(): void {
  requiredElement("donePopup", HTMLElement).style.display = "flex";
}

function dismissDone(): void {
  requiredElement("donePopup", HTMLElement).style.display = "none";
}

function navigate(delta: number): void {
  const visible = visibleComparisons();
  // Nothing left to review (every slide handled) → completion popup.
  if (visible.length === 0) { showDone(); return; }
  const curId = comparisons[currentIdx]?.id;
  const vIdx = visible.findIndex((c) => c.id === curId);
  if (vIdx < 0) {
    // The current slide was just hidden (e.g. rated good). Land on the next
    // visible slide AFTER its position in the full list (forward delta), or the
    // previous remaining one (backward delta) — never visible[0]+delta.
    const fullIdx = currentIdx;
    const indexOf = (c: Comparison): number => comparisons.findIndex((x) => x.id === c.id);
    if (delta >= 0) {
      const next = visible.find((c) => indexOf(c) > fullIdx);
      // No slide after the one just rated → that was the last one. Done.
      if (!next) { showDone(); return; }
      currentIdx = indexOf(next);
    } else {
      const prevs = visible.filter((c) => indexOf(c) < fullIdx);
      const target = prevs[prevs.length - 1] ?? visible[0];
      if (target) currentIdx = indexOf(target);
    }
    render();
    return;
  }
  // Forward past the last visible slide (rated the final still-visible slide,
  // or Skip on the last card) → completion popup rather than clamping.
  if (delta > 0 && vIdx >= visible.length - 1) { showDone(); return; }
  const target = visible[Math.max(0, Math.min(visible.length - 1, vIdx + delta))];
  if (target) currentIdx = comparisons.findIndex((c) => c.id === target.id);
  render();
}

function onKeyDown(e: KeyboardEvent): void {
  if (config.readOnly) {
    // READ-ONLY keyboard: navigation + the two rating verdicts only. No comment
    // box to type in, no drawing undo.
    if (e.key === "ArrowRight" || e.key === "n") navigate(1);
    if (e.key === "ArrowLeft" || e.key === "p") navigate(-1);
    if (e.key === "g") void rate("good");
    if (e.key === "b") void rate("bad");
    if (e.key === "f") { flickFlip(); e.preventDefault(); } // blink-flick original↔rendered
    if (e.key === "v" && reverseMode) toggleReverseView();
    return;
  }
  // Ctrl/Cmd+Z — undo the last drawing stroke (works globally, even while typing
  // in the comment box, so the drawing workflow isn't interrupted).
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    undoDraw();
    e.preventDefault();
    return;
  }
  const commentEl = requiredElement("comment", HTMLTextAreaElement);
  // Don't intercept keys while typing in the comment box.
  if (document.activeElement === commentEl) {
    if (e.key === "Escape") { commentEl.blur(); e.preventDefault(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { void rate("bad"); e.preventDefault(); }
    return;
  }
  if (e.key === "ArrowRight" || e.key === "n") navigate(1);
  if (e.key === "ArrowLeft" || e.key === "p") navigate(-1);
  if (e.key === "g") void rate("good");
  if (e.key === "f") { flickFlip(); e.preventDefault(); } // blink-flick original↔rendered
  if (e.key === "v" && reverseMode) toggleReverseView(); // reverse step ↔ round trip
  if (e.key === "b") { commentEl.focus(); e.preventDefault(); }
  if (e.key === "Enter" && commentEl.value.trim()) void rate("bad");
}

function toggleLoupe(): void {
  loupeOn = requiredElement("loupeToggle", HTMLInputElement).checked;
  if (!loupeOn) requiredElement("loupe", HTMLElement).style.display = "none";
}

/**
 * Magnifier: hit-test the cursor against the two <img>s and show a zoomed CSS
 * background-image of whichever one is under the cursor.
 */
function onMagnifierMove(e: MouseEvent): void {
  const lens = elementById("loupe", HTMLElement);
  if (!lens) return;
  if (!loupeOn) { lens.style.display = "none"; return; }
  const size = 240;
  const zoomInput = elementById("loupeZoomCtl", HTMLInputElement);
  const zoom = zoomInput ? parseFloat(zoomInput.value) : 3;
  const images = [elementById("originalImg", HTMLImageElement), elementById("slidesImg", HTMLImageElement)];
  for (const img of images) {
    if (!img || !img.naturalWidth) continue;
    const r = img.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
    const nx = ((e.clientX - r.left) / r.width) * img.naturalWidth;
    const ny = ((e.clientY - r.top) / r.height) * img.naturalHeight;
    lens.style.display = "block";
    lens.style.left = (e.clientX - size / 2) + "px";
    lens.style.top = (e.clientY - size / 2) + "px";
    lens.style.width = size + "px";
    lens.style.height = size + "px";
    // Over the render, composite the draw-canvas (your strokes) ON TOP of the
    // image. The drawCanvas shares the image's natural resolution, so one
    // backgroundSize/Position aligns both layers. The data URL MUST be quoted —
    // it contains commas that would otherwise split the multi-background list.
    // (Always null on read-only pages: there are no strokes.)
    const drawUrl = img.id === "slidesImg" ? drawCanvasDataUrl : null;
    lens.style.backgroundImage = drawUrl ? 'url("' + drawUrl + '"), url("' + img.src + '")' : 'url("' + img.src + '")';
    lens.style.backgroundSize = (img.naturalWidth * zoom) + "px " + (img.naturalHeight * zoom) + "px";
    lens.style.backgroundPosition = (-(nx * zoom - size / 2)) + "px " + (-(ny * zoom - size / 2)) + "px";
    return;
  }
  lens.style.display = "none";
}

function toggleReverseView(): void {
  setReverseView(reverseView === "reverse" ? "round-trip" : "reverse");
}

/**
 * Switch the panes between the reverse step and the round trip IN PLACE (like
 * toggleShowDiff): a full render() would rebuild the draw canvas and lose an
 * in-progress annotation and unsaved comment text.
 */
function setReverseView(view: ReverseView): void {
  reverseView = view;
  const c = comparisons[currentIdx];
  if (!c) return;
  applyReverseImages(c, view);
  applyReverseLabels(c, view);
  renderReverseMetrics(c, view);
  refreshReverseNavigation(visibleComparisons(), view);
  if (showDiff) computeClientSideDiff();
}

/**
 * A worst-first order exists to review the worst slide first, so jump to the
 * head of the new order; going back to deck order keeps the slide being looked at.
 */
function setReverseOrder(order: ReverseOrder): void {
  reverseOrder = order;
  const select = elementById("reverseOrder", HTMLSelectElement);
  if (select && select.value !== order) select.value = order;
  const currentId = comparisons[currentIdx]?.id;
  comparisons = sortReverse({ comparisons, order, deckOrder });
  const targetId = order === "deck" ? currentId : visibleComparisons()[0]?.id;
  currentIdx = Math.max(0, comparisons.findIndex((c) => c.id === targetId));
  render();
}
