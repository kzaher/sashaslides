// THE CONVERTER'S WARNINGS, as the developer page lists them and draws them over the preview. Each
// `UnsupportedFeature` carries a region as fractions of the 1280x720 slide (unsupported-feature.ts),
// so the overlay is a percentage box and survives any preview scale.

import { assertNever } from "../../../../mcp/sasha-slides/engine/src/contracts/assert-never.ts";
import {
  describeUnsupportedFeature,
  type FractionalRegion,
  type UnsupportedFallback,
  type UnsupportedFeature,
} from "../../../../mcp/sasha-slides/converter/index.ts";

export type WarningMark = Readonly<{
  /** 1-based, shown on the overlay box and in the list so the two can be matched by eye. */
  number: number;
  kind: UnsupportedFeature["kind"];
  /** `omitted` means nothing reached the slide; everything else is visible but different. */
  omitted: boolean;
  sentence: string;
  region: FractionalRegion;
  /** CSS for the overlay box, in percent of the preview. */
  box: Readonly<{ left: string; top: string; width: string; height: string }>;
}>;

export function warningMarks(unsupported: readonly UnsupportedFeature[]): readonly WarningMark[] {
  return unsupported.map((feature, index) => {
    const region = clampedRegion(feature.region);
    return {
      number: index + 1,
      kind: feature.kind,
      omitted: reachesNothing(feature.fallback),
      sentence: describeUnsupportedFeature(feature),
      region,
      box: { left: percent(region.x), top: percent(region.y), width: percent(region.w), height: percent(region.h) },
    };
  });
}

/** How many warnings of each kind, most frequent first: the one-line summary above the list. */
export function warningSummary(unsupported: readonly UnsupportedFeature[]): string {
  if (unsupported.length === 0) return "No warnings: everything converted to native Slides objects.";
  const counts = new Map<string, number>();
  for (const feature of unsupported) counts.set(feature.kind, (counts.get(feature.kind) ?? 0) + 1);
  const parts = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([kind, count]) => `${count} ${kind}`);
  return `${unsupported.length} ${unsupported.length === 1 ? "warning" : "warnings"}: ${parts.join(", ")}.`;
}

/** unsupported-feature.ts: only `omitted` means nothing at all reached the slide. */
function reachesNothing(fallback: UnsupportedFallback): boolean {
  switch (fallback) {
    case "omitted":
      return true;
    case "solid-approximation":
    case "preset-approximation":
    case "edge-lines":
    case "geometry-floor":
    case "font-substituted":
    case "rasterised":
      return false;
    default:
      return assertNever(fallback);
  }
}

/** A region that strays outside the slide (an element partly off-canvas) is cut to the slide. */
function clampedRegion(region: FractionalRegion): FractionalRegion {
  const left = clamp01(region.x);
  const top = clamp01(region.y);
  return { x: left, y: top, w: clamp01(region.x + region.w) - left, h: clamp01(region.y + region.h) - top };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}
