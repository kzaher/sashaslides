// The "converted slide" half of the HTML <-> rendered toggle.
//
// IT IS A PROJECTION OF THE REQUESTS, NOT A GOOGLE RASTERISATION. There is no way to see the real
// thing before it exists: `presentations.pages.getThumbnail` needs the slide to already be in the
// deck, and inserting a throwaway slide to photograph it would mutate the user's deck before they
// picked anything. So the rendered pane draws the geometry the converter asked Slides for -- each
// element's box, kind and text -- which is exactly the information needed to see that a table
// landed in the wrong place or that a text box swallowed the chart. PROTOCOL.md already says the
// rendered slide is "a lossy projection" of the HTML; this is one projection further out, and the
// picker labels it as such.
//
// ASSUMED PAGE SIZE: Google Slides' 16:9 default, 10 x 5.625 in = 720 x 405 PT, because the
// converter's own mapping from the 1280x720 HTML is not part of its published interface. Elements
// whose unit is EMU are converted; anything outside the page is clamped, so a bad mapping shows up
// as everything piled in one corner rather than as an empty pane.

import type { SlidesApiRequest } from "./converter-contract.ts";
import type { Region } from "./protocol.ts";

export const PAGE_WIDTH_PT = 720;
export const PAGE_HEIGHT_PT = 405;
const EMU_PER_PT = 12700;

export type PreviewElementKind = "shape" | "table" | "image" | "line" | "video" | "unknown";

export type PreviewElement = Readonly<{
  objectId: string;
  kind: PreviewElementKind;
  /** Fractional (0-1) box on the page, so the pane scales with the viewport. */
  region: Region;
  label: string;
  text: string;
}>;

const CREATE_REQUESTS: Readonly<Record<string, PreviewElementKind>> = {
  createShape: "shape",
  createTable: "table",
  createImage: "image",
  createLine: "line",
  createVideo: "video",
  createSheetsChart: "image",
};

/**
 * Every element the batch creates, in request order, with the text later `insertText` requests put
 * into it. Request order is paint order in Slides, so the array is already back-to-front.
 */
export function previewElementsOf(requests: readonly SlidesApiRequest[]): readonly PreviewElement[] {
  const elements: PreviewElement[] = [];
  const positionById = new Map<string, number>();
  for (const request of requests) {
    for (const [name, payload] of Object.entries(request)) {
      const kind = CREATE_REQUESTS[name];
      if (kind === undefined) continue;
      const created = asRecord(payload);
      if (created === null) continue;
      const objectId = stringAt({ record: created, key: "objectId" }) ?? `anonymous_${elements.length}`;
      positionById.set(objectId, elements.length);
      elements.push({
        objectId,
        kind,
        region: regionOf(asRecord(created["elementProperties"])),
        label: stringAt({ record: created, key: "shapeType" }) ?? name.replace(/^create/, "").toLowerCase(),
        text: "",
      });
    }
    appendText({ request, elements, positionById });
  }
  return elements;
}

function appendText({
  request,
  elements,
  positionById,
}: {
  request: SlidesApiRequest;
  elements: PreviewElement[];
  positionById: ReadonlyMap<string, number>;
}): void {
  const insert = asRecord(request["insertText"]);
  if (insert === null) return;
  const objectId = stringAt({ record: insert, key: "objectId" });
  const text = stringAt({ record: insert, key: "text" });
  if (objectId === null || text === null) return;
  const position = positionById.get(objectId);
  if (position === undefined) return;
  const existing = elements[position];
  if (existing === undefined) return;
  elements[position] = { ...existing, text: existing.text + text };
}

function regionOf(elementProperties: Readonly<Record<string, unknown>> | null): Region {
  if (elementProperties === null) return { x: 0, y: 0, w: 1, h: 1 };
  const size = asRecord(elementProperties["size"]);
  const transform = asRecord(elementProperties["transform"]);
  const widthPt = pointsOf(asRecord(size?.["width"])) ?? PAGE_WIDTH_PT;
  const heightPt = pointsOf(asRecord(size?.["height"])) ?? PAGE_HEIGHT_PT;
  const scaleX = numberAt({ record: transform, key: "scaleX" }) ?? 1;
  const scaleY = numberAt({ record: transform, key: "scaleY" }) ?? 1;
  const unit = stringAt({ record: transform ?? {}, key: "unit" }) ?? "PT";
  const divisor = unit === "EMU" ? EMU_PER_PT : 1;
  const leftPt = (numberAt({ record: transform, key: "translateX" }) ?? 0) / divisor;
  const topPt = (numberAt({ record: transform, key: "translateY" }) ?? 0) / divisor;
  return clampToPage({
    x: leftPt / PAGE_WIDTH_PT,
    y: topPt / PAGE_HEIGHT_PT,
    w: (widthPt * scaleX) / PAGE_WIDTH_PT,
    h: (heightPt * scaleY) / PAGE_HEIGHT_PT,
  });
}

function clampToPage(region: Region): Region {
  const x = clamp01(region.x);
  const y = clamp01(region.y);
  return {
    x,
    y,
    w: Math.max(0.002, Math.min(region.w, 1 - x)),
    h: Math.max(0.002, Math.min(region.h, 1 - y)),
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function pointsOf(dimension: Readonly<Record<string, unknown>> | null): number | null {
  const magnitude = numberAt({ record: dimension, key: "magnitude" });
  if (magnitude === null) return null;
  return stringAt({ record: dimension ?? {}, key: "unit" }) === "EMU" ? magnitude / EMU_PER_PT : magnitude;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function numberAt({ record, key }: { record: Readonly<Record<string, unknown>> | null; key: string }): number | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
