// Reading the real deck back with `presentations.get`, which is what makes the insert assertion an
// assertion and not a screenshot. A thumbnail proves something was drawn; only `presentations.get`
// proves the slide is made of NATIVE objects with ids and geometry Google itself reports.
//
// Geometry is reported in POINTS, computed the way Slides composes it: a page element's rendered
// size is `size.magnitude * transform.scale`, and its position is `transform.translate`. EMU is the
// unit Slides answers in for everything the converter sends, so the conversion is divided out here
// once rather than at every assertion.
import { writeFileSync } from "node:fs";
import { google } from "googleapis";
import type { slides_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export const EMU_PER_POINT = 12700;

export type DeckElementKind = "shape" | "table" | "image" | "line" | "group" | "other";

/** One page element as Google reports it, flattened to what an assertion needs. */
export type DeckElement = Readonly<{
  objectId: string;
  kind: DeckElementKind;
  /** TEXT_BOX, RECTANGLE, … for a shape; null for anything else. */
  shapeType: string | null;
  /** Concatenated text runs, so "the text box really carries the fixture's words" is checkable. */
  text: string;
  leftPt: number;
  topPt: number;
  widthPt: number;
  heightPt: number;
}>;

export type DeckPage = Readonly<{
  objectId: string;
  /** 1-based filmstrip position. */
  position: number;
  elements: readonly DeckElement[];
}>;

export type Deck = Readonly<{
  presentationId: string;
  title: string;
  widthPt: number;
  heightPt: number;
  pages: readonly DeckPage[];
}>;

export async function readDeck({
  auth,
  presentationId,
}: {
  auth: OAuth2Client;
  presentationId: string;
}): Promise<Deck> {
  const slides = google.slides({ version: "v1", auth });
  const fetched = await slides.presentations.get({ presentationId });
  const data = fetched.data;
  return {
    presentationId,
    title: data.title ?? "<untitled>",
    widthPt: pointsOf(data.pageSize?.width),
    heightPt: pointsOf(data.pageSize?.height),
    pages: (data.slides ?? []).map((page, position) => ({
      objectId: page.objectId ?? "<no id>",
      position: position + 1,
      elements: (page.pageElements ?? []).map(deckElementOf),
    })),
  };
}

export function pageById({ deck, objectId }: { deck: Deck; objectId: string }): DeckPage | null {
  for (const page of deck.pages) {
    if (page.objectId === objectId) return page;
  }
  return null;
}

/** `NN.png` of one page, straight from Slides' own renderer, saved for visual evidence. */
export async function capturePageThumbnail({
  auth,
  presentationId,
  pageObjectId,
  path,
}: {
  auth: OAuth2Client;
  presentationId: string;
  pageObjectId: string;
  path: string;
}): Promise<Readonly<{ contentUrl: string; bytes: number }>> {
  const slides = google.slides({ version: "v1", auth });
  const described = await slides.presentations.pages.getThumbnail({
    presentationId,
    pageObjectId,
    "thumbnailProperties.mimeType": "PNG",
    "thumbnailProperties.thumbnailSize": "LARGE",
  });
  const contentUrl = described.data.contentUrl;
  if (typeof contentUrl !== "string") throw new Error("getThumbnail returned no contentUrl");
  // contentUrl is a short-lived, unauthenticated googleusercontent link — no Authorization header.
  const fetched = await fetch(contentUrl);
  if (!fetched.ok) throw new Error(`thumbnail download answered HTTP ${fetched.status}`);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  writeFileSync(path, bytes);
  return { contentUrl, bytes: bytes.byteLength };
}

export function describeElement(element: DeckElement): string {
  const where =
    `${element.leftPt.toFixed(1)},${element.topPt.toFixed(1)} ` +
    `${element.widthPt.toFixed(1)}x${element.heightPt.toFixed(1)}pt`;
  const what = element.shapeType === null ? element.kind : `${element.kind}/${element.shapeType}`;
  const said = element.text === "" ? "" : ` "${element.text.replace(/\s+/g, " ").trim().slice(0, 48)}"`;
  return `${element.objectId} ${what} ${where}${said}`;
}

function deckElementOf(element: slides_v1.Schema$PageElement): DeckElement {
  const transform = element.transform ?? {};
  const scaleX = typeof transform.scaleX === "number" ? transform.scaleX : 1;
  const scaleY = typeof transform.scaleY === "number" ? transform.scaleY : 1;
  return {
    objectId: element.objectId ?? "<no id>",
    kind: kindOf(element),
    shapeType: typeof element.shape?.shapeType === "string" ? element.shape.shapeType : null,
    text: textOf(element),
    leftPt: translatedPointsOf({ magnitude: transform.translateX, unit: transform.unit }),
    topPt: translatedPointsOf({ magnitude: transform.translateY, unit: transform.unit }),
    widthPt: pointsOf(element.size?.width) * scaleX,
    heightPt: pointsOf(element.size?.height) * scaleY,
  };
}

function kindOf(element: slides_v1.Schema$PageElement): DeckElementKind {
  if (element.shape !== undefined && element.shape !== null) return "shape";
  if (element.table !== undefined && element.table !== null) return "table";
  if (element.image !== undefined && element.image !== null) return "image";
  if (element.line !== undefined && element.line !== null) return "line";
  if (element.elementGroup !== undefined && element.elementGroup !== null) return "group";
  return "other";
}

/** Shape text plus every table cell's text, so a table's content is visible to an assertion. */
function textOf(element: slides_v1.Schema$PageElement): string {
  const fromShape = runsOf(element.shape?.text);
  const fromTable = (element.table?.tableRows ?? [])
    .flatMap((row) => row.tableCells ?? [])
    .map((cell) => runsOf(cell.text))
    .join(" ");
  return `${fromShape}${fromShape === "" || fromTable === "" ? "" : " "}${fromTable}`;
}

function runsOf(text: slides_v1.Schema$TextContent | undefined): string {
  return (text?.textElements ?? [])
    .map((run) => run.textRun?.content ?? "")
    .join("")
    .replace(/\u000b/g, " ");
}

/** A transform's translate, which is a bare number plus the transform's own unit. */
function translatedPointsOf({
  magnitude,
  unit,
}: {
  magnitude: number | null | undefined;
  unit: string | null | undefined;
}): number {
  if (typeof magnitude !== "number") return 0;
  return unit === "PT" ? magnitude : magnitude / EMU_PER_POINT;
}

/** A Slides dimension in points. Slides answers in EMU for everything the converter sends. */
function pointsOf(dimension: slides_v1.Schema$Dimension | null | undefined): number {
  const magnitude = dimension?.magnitude;
  if (typeof magnitude !== "number") return 0;
  switch (dimension?.unit) {
    case "PT":
      return magnitude;
    case "EMU":
      return magnitude / EMU_PER_POINT;
    default:
      // Slides omits `unit` on some nested dimensions; EMU is the documented default there.
      return magnitude / EMU_PER_POINT;
  }
}
