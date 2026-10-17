/**
 * rating-ui-reverse.ts — the browser side of the REVERSE rating page (Google Slides ->
 * Sasha HTML): which images a view shows, the pane labels, the metric chips, the
 * worst-first ordering, the nav-strip tints and the reverse summary line.
 *
 * rating-ui.ts owns the page state (the comparisons, the current slide, the view) and
 * passes what each function needs, so this module holds no state of its own. Every
 * comparison carries `reverse`: the ReverseSlide from reverse-rating.ts.
 */
import type { ReverseSummary, ReverseView } from "./reverse-rating.ts";
import type { SlideComparison } from "./rating-wire.ts";
import { assertNever, elementById, escapeHtml, imageUrl } from "./rating-ui-dom.ts";

/** The slide order the reverse bar offers: the deck's own, or worst-first by one metric. */
export type ReverseOrder = "deck" | "reverse" | "round-trip" | "text";

type Comparison = Readonly<SlideComparison>;

/** Parse the order <select>'s value (its options are the four orders). */
export function parseReverseOrder(value: string): ReverseOrder {
  switch (value) {
    case "deck":
    case "reverse":
    case "round-trip":
    case "text":
      return value;
    default:
      throw new Error(`unknown reverse order ${value}`);
  }
}

/** The left pane: the fixture screenshot in the round-trip view (when the slide has one), else the Google thumbnail. */
export function reverseOriginalPath(comparison: Comparison, view: ReverseView): string {
  return showsRoundTrip(comparison, view) && comparison.reverse?.fixturePng ? comparison.reverse.fixturePng : comparison.originalPng;
}

/** The right pane: the round trip's Sasha screenshot in the round-trip view, else the reverse step's. */
export function reverseTestPath(comparison: Comparison, view: ReverseView): string {
  return showsRoundTrip(comparison, view) && comparison.reverse?.roundTripSashaPng ? comparison.reverse.roundTripSashaPng : comparison.slidesPng;
}

/** Pane labels, flip-tab names and the view buttons' active state for `view`. */
export function applyReverseLabels(comparison: Comparison, view: ReverseView): void {
  const reverse = comparison.reverse;
  const roundTrip = showsRoundTrip(comparison, view);
  const labelOriginal = elementById("labelOriginal", HTMLElement);
  const labelSlides = elementById("labelSlides", HTMLElement);
  const missing = view === "round-trip" && !roundTrip
    ? ' <span class="reverse-missing">(no round trip for this slide: showing Google Slides)</span>'
    : "";
  if (labelOriginal) labelOriginal.innerHTML = roundTrip
    ? linkOrText(reverse?.fixtureHtmlFile ? "/html?path=" + encodeURIComponent(reverse.fixtureHtmlFile) : null, "Original: fixture HTML")
    : linkOrText(reverse?.googleSlidesUrl ?? null, "Original: Google Slides") + missing;
  if (labelSlides) labelSlides.innerHTML =
    linkOrText(reverse?.sashaHtmlFile ? "/html?path=" + encodeURIComponent(reverse.sashaHtmlFile) : null, "Test: Sasha HTML");
  const flipOriginal = elementById("flipOriginal", HTMLElement);
  const flipRendered = elementById("flipRendered", HTMLElement);
  if (flipOriginal) flipOriginal.textContent = roundTrip ? "Fixture HTML" : "Google Slides";
  if (flipRendered) flipRendered.textContent = "Sasha HTML";
  elementById("viewReverse", HTMLElement)?.classList.toggle("active", view === "reverse");
  elementById("viewRoundTrip", HTMLElement)?.classList.toggle("active", view === "round-trip");
}

/** The current slide's metric chips, with the chip of the current view outlined. */
export function renderReverseMetrics(comparison: Comparison, view: ReverseView): void {
  const chips = elementById("reverseMetrics", HTMLElement);
  const notes = elementById("reverseNotes", HTMLElement);
  if (!chips || !notes) return;
  const metric = comparison.reverse?.metric ?? null;
  if (!metric) {
    chips.innerHTML = '<span class="metric-chip">no metrics.json row for this slide</span>';
    notes.textContent = "";
    return;
  }
  const roundTrip = showsRoundTrip(comparison, view);
  chips.innerHTML =
    '<span class="reverse-case">' + escapeHtml(metric.set) + " / " + escapeHtml(metric.caseId) + " / slide " + metric.slideNumber + "</span>" +
    '<span class="metric-chip ' + mismatchClass(metric.reverseMismatchPercent) + (roundTrip ? "" : " current-view") + '" title="Pixel mismatch: Sasha HTML vs Google Slides thumbnail">Reverse mismatch ' + formatPercent(metric.reverseMismatchPercent) + "</span>" +
    '<span class="metric-chip ' + mismatchClass(metric.roundTripMismatchPercent) + (roundTrip ? " current-view" : "") + '" title="Pixel mismatch: Sasha HTML vs the original fixture HTML">Round-trip mismatch ' + formatPercent(metric.roundTripMismatchPercent) + "</span>" +
    '<span class="metric-chip ' + textMatchClass(metric.textMatch) + '" title="Share of the slide text that survived the import">Text match ' + formatFraction(metric.textMatch) + "</span>";
  notes.textContent = metric.notes || "";
}

/**
 * `comparisons` in `order`. Worst-first: larger is worse for both mismatches; a LOWER
 * text match is worse, so it sorts on the negated fraction. Slides without the number
 * go last; ties keep the deck order.
 */
export function sortReverse(options: Readonly<{
  comparisons: readonly Comparison[];
  order: ReverseOrder;
  deckOrder: readonly string[];
}>): Comparison[] {
  const position = new Map(options.deckOrder.map((id, index) => [id, index]));
  return [...options.comparisons].sort((first, second) => {
    if (options.order !== "deck") {
      const firstValue = reverseSortValue(first, options.order);
      const secondValue = reverseSortValue(second, options.order);
      if (firstValue != null && secondValue == null) return -1;
      if (firstValue == null && secondValue != null) return 1;
      if (firstValue != null && secondValue != null && firstValue !== secondValue) return secondValue - firstValue;
    }
    return (position.get(first.id) ?? 0) - (position.get(second.id) ?? 0);
  });
}

/** The nav anchor's text: the slide's short label plus the current view's mismatch. */
export function reverseNavigationLabel(comparison: Comparison, view: ReverseView): string {
  const reverse = comparison.reverse;
  if (!reverse) return escapeHtml(comparison.id);
  const percent = viewMismatch(comparison, view);
  return escapeHtml(reverse.navigationLabel) + (percent == null ? "" : '<span class="nav-metric">' + percent.toFixed(1) + "%</span>");
}

/** The nav anchor's tint class for the current view's mismatch ("" when unknown). */
export function reverseNavigationClass(comparison: Comparison, view: ReverseView): string {
  const percent = viewMismatch(comparison, view);
  return percent == null ? "" : mismatchClass(percent).replace("metric-", "mismatch-");
}

/** The nav anchor's tooltip: every metric of the slide. */
export function reverseNavigationTitle(comparison: Comparison): string {
  const metric = comparison.reverse?.metric ?? null;
  if (!metric) return escapeHtml(comparison.id);
  return escapeHtml(comparison.id + " | reverse " + formatPercent(metric.reverseMismatchPercent) + " | round trip " + formatPercent(metric.roundTripMismatchPercent) + " | text " + formatFraction(metric.textMatch));
}

/**
 * Update the nav strip's tints and labels IN PLACE for `view` (render() would rebuild
 * the panes). The anchors are in `visible` order.
 */
export function refreshReverseNavigation(visible: readonly Comparison[], view: ReverseView): void {
  const anchors = document.querySelectorAll<HTMLAnchorElement>("#nav a");
  visible.forEach((comparison, index) => {
    const anchor = anchors[index];
    if (!anchor) return;
    anchor.classList.remove("mismatch-good", "mismatch-fair", "mismatch-poor");
    const mismatch = reverseNavigationClass(comparison, view);
    if (mismatch) anchor.classList.add(mismatch);
    anchor.innerHTML = reverseNavigationLabel(comparison, view);
  });
}

/** Fill #goldenReport with the deck-level reverse fidelity summary from /api/summary. */
export async function refreshReverseReport(): Promise<void> {
  // The server's own /api/summary in reverse mode returns summarizeReverse()'s ReverseSummary.
  const summary = (await (await fetch("/api/summary")).json()) as ReverseSummary;
  const parts = [
    "<b>Reverse fidelity</b> (Google Slides &rarr; Sasha HTML): " + summary.slideCount + " slides",
    summary.ratedGood + " good / " + summary.ratedBad + " bad",
    "mean reverse mismatch " + formatPercent(summary.meanReverseMismatchPercent),
    "mean round-trip mismatch " + formatPercent(summary.meanRoundTripMismatchPercent),
    "mean text match " + formatFraction(summary.meanTextMatch),
  ];
  if (summary.worstReverse) parts.push("worst reverse: " + escapeHtml(summary.worstReverse.id) + " (" + formatPercent(summary.worstReverse.mismatchPercent) + ")");
  if (summary.worstRoundTrip) parts.push("worst round trip: " + escapeHtml(summary.worstRoundTrip.id) + " (" + formatPercent(summary.worstRoundTrip.mismatchPercent) + ")");
  parts.push(summary.goldenCount + " reverse golden(s) blessed in " + escapeHtml(summary.goldensDirectory));
  parts.push("verdicts: " + escapeHtml(summary.ratingsFile));
  let html = parts.join(" &middot; ");
  if (summary.missingSashaRender.length) html += '<br><span style="color:#e94560">No Sasha render for: ' + summary.missingSashaRender.map(escapeHtml).join(", ") + "</span>";
  if (summary.problems.length) html += '<br><span style="color:#e67e22">' + summary.problems.map(escapeHtml).join("<br>") + "</span>";
  const report = elementById("goldenReport", HTMLElement);
  if (report) report.innerHTML = html;
}

/** Point the two pane images at `view`'s pair, touching only a src that changed. */
export function applyReverseImages(comparison: Comparison, view: ReverseView): void {
  const originalImg = elementById("originalImg", HTMLImageElement);
  const slidesImg = elementById("slidesImg", HTMLImageElement);
  const originalSource = imageUrl(reverseOriginalPath(comparison, view));
  const testSource = imageUrl(reverseTestPath(comparison, view));
  if (originalImg && originalImg.getAttribute("src") !== originalSource) originalImg.src = originalSource;
  if (slidesImg && slidesImg.getAttribute("src") !== testSource) slidesImg.src = testSource;
}

function showsRoundTrip(comparison: Comparison, view: ReverseView): boolean {
  return view === "round-trip" && !!comparison.reverse?.fixturePng;
}

function linkOrText(href: string | null, text: string): string {
  return href ? '<a href="' + escapeHtml(href) + '" target="_blank">' + text + " &#8599;</a>" : text;
}

function mismatchClass(percent: number | null): string {
  if (percent == null) return "";
  return percent <= 2 ? "metric-good" : percent <= 8 ? "metric-fair" : "metric-poor";
}

function textMatchClass(fraction: number | null): string {
  if (fraction == null) return "";
  return fraction >= 0.98 ? "metric-good" : fraction >= 0.9 ? "metric-fair" : "metric-poor";
}

function formatPercent(percent: number | null): string {
  return percent == null ? "n/a" : percent.toFixed(percent < 10 ? 2 : 1) + "%";
}

function formatFraction(fraction: number | null): string {
  return fraction == null ? "n/a" : (fraction * 100).toFixed(1) + "%";
}

function reverseSortValue(comparison: Comparison, order: Exclude<ReverseOrder, "deck">): number | null {
  const metric = comparison.reverse?.metric ?? null;
  if (!metric) return null;
  switch (order) {
    case "reverse":
      return metric.reverseMismatchPercent;
    case "round-trip":
      return metric.roundTripMismatchPercent;
    case "text":
      return metric.textMatch == null ? null : -metric.textMatch;
    default:
      return assertNever(order);
  }
}

function viewMismatch(comparison: Comparison, view: ReverseView): number | null {
  const metric = comparison.reverse?.metric ?? null;
  if (!metric) return null;
  switch (view) {
    case "reverse":
      return metric.reverseMismatchPercent;
    case "round-trip":
      return metric.roundTripMismatchPercent;
    default:
      return assertNever(view);
  }
}
