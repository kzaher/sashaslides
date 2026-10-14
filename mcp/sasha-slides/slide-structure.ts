/**
 * slide_structure: what is on ONE existing slide, in the terms a merge proposal needs.
 *
 * A merge candidate (PROTOCOL.md "Merge proposals") redesigns part of an existing slide: it names
 * the elements it deletes by object id and stacks its new elements behind or in front of the rest.
 * Claude can do neither blind, so this reads the slide and lists every top-level page element with
 * its object id, kind, a short text excerpt, its box in px on the 1280x720 frame the candidate HTML
 * is drawn on, and its z-order position.
 *
 * ACCESS. The connector's grant includes `https://www.googleapis.com/auth/presentations`
 * (google-auth.ts `SLIDES_SCOPE`, http/oauth-metadata.ts), which reads ANY deck the user can open --
 * unlike `drive.file`, which only sees files this app created. So an existing deck is readable;
 * a deck the user cannot open answers with Google's own error, which is reported as it is.
 *
 * Pure: the read is the feedback channel's (`FeedbackChannel.readSlide`), and this file only turns
 * the Slides API's page into the listing, so every geometry rule below is unit-tested.
 */
import type { slides_v1 } from "googleapis";

/** The frame candidate HTML is authored on (PROTOCOL.md: a 1280x720 document). */
export const FRAME_WIDTH_PX = 1280;

/** Google's default 16:9 page, for a presentation that reports no `pageSize`. */
const DEFAULT_PAGE_WIDTH_EMU = 9_144_000;
const DEFAULT_PAGE_HEIGHT_EMU = 5_143_500;
const EMU_PER_POINT = 12_700;
const TEXT_EXCERPT_CHARS = 120;

export type BoxPx = Readonly<{ x: number; y: number; w: number; h: number }>;

export type SlideStructureElement = Readonly<{
  objectId: string;
  /** `shape:TEXT_BOX`, `shape:RECTANGLE`, `image`, `table`, `line`, `group`, ... */
  kind: string;
  /** 0 is rearmost; the slide's `pageElements` order, which is its stacking order. */
  zOrder: number;
  /** The visible text, whitespace-collapsed and clipped, or the alt text; null when there is none. */
  text: string | null;
  /** The axis-aligned box in px on the frame, rotation and grouping included; null when unknown. */
  box: BoxPx | null;
  /** The layout placeholder this element fills (`TITLE`, `BODY`, ...), or null. */
  placeholder: string | null;
}>;

export type SlideStructure = Readonly<{
  presentationId: string;
  slideObjectId: string;
  /** 1-based filmstrip position, or null when the deck's slide list was not available. */
  slideNumber: number | null;
  /** 1280 wide; the height follows the deck's own aspect ratio (720 for 16:9). */
  frame: Readonly<{ w: number; h: number }>;
  elements: readonly SlideStructureElement[];
}>;

export function slideStructureOf(
  options: Readonly<{
    presentationId: string;
    slideObjectId: string;
    slideNumber: number | null;
    pageSize: slides_v1.Schema$Size | null;
    page: slides_v1.Schema$Page;
  }>,
): SlideStructure {
  const pageWidthEmu = emuOf(options.pageSize?.width) ?? DEFAULT_PAGE_WIDTH_EMU;
  const pageHeightEmu = emuOf(options.pageSize?.height) ?? DEFAULT_PAGE_HEIGHT_EMU;
  const pxPerEmu = FRAME_WIDTH_PX / pageWidthEmu;
  const elements: SlideStructureElement[] = [];
  for (const [zOrder, element] of (options.page.pageElements ?? []).entries()) {
    if (typeof element.objectId !== "string") continue;
    const bounds = boundsEmuOf({ element, parent: IDENTITY });
    elements.push({
      objectId: element.objectId,
      kind: kindOf(element),
      zOrder,
      text: textOf(element),
      box: bounds === null ? null : scaleBox({ bounds, pxPerEmu }),
      placeholder: element.shape?.placeholder?.type ?? null,
    });
  }
  return {
    presentationId: options.presentationId,
    slideObjectId: options.slideObjectId,
    slideNumber: options.slideNumber,
    frame: { w: FRAME_WIDTH_PX, h: round1(pageHeightEmu * pxPerEmu) },
    elements,
  };
}

/** An affine transform in EMU: x' = a·x + c·y + tx, y' = b·x + d·y + ty (Slides' AffineTransform). */
type Affine = Readonly<{ a: number; b: number; c: number; d: number; tx: number; ty: number }>;

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

type BoundsEmu = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/**
 * The element's axis-aligned bounds in page EMU. A GROUP has no size of its own: its children's
 * transforms are relative to the group, so each child is composed with the group's transform and
 * the group is the union of what they cover.
 */
function boundsEmuOf(options: Readonly<{ element: slides_v1.Schema$PageElement; parent: Affine }>): BoundsEmu | null {
  const { element, parent } = options;
  const transform = compose({ outer: parent, inner: affineOf(element.transform) });
  const children = element.elementGroup?.children;
  if (children !== undefined && children !== null) {
    return union(children.map((child) => boundsEmuOf({ element: child, parent: transform })));
  }
  const width = emuOf(element.size?.width);
  const height = emuOf(element.size?.height);
  if (width === null || height === null) return null;
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ].map(({ x, y }) => ({ x: transform.a * x + transform.c * y + transform.tx, y: transform.b * x + transform.d * y + transform.ty }));
  return {
    left: Math.min(...corners.map((corner) => corner.x)),
    top: Math.min(...corners.map((corner) => corner.y)),
    right: Math.max(...corners.map((corner) => corner.x)),
    bottom: Math.max(...corners.map((corner) => corner.y)),
  };
}

function affineOf(transform: slides_v1.Schema$AffineTransform | undefined): Affine {
  if (transform === undefined) return IDENTITY;
  const unitScale = transform.unit === "PT" ? EMU_PER_POINT : 1;
  return {
    a: transform.scaleX ?? 1,
    b: transform.shearY ?? 0,
    c: transform.shearX ?? 0,
    d: transform.scaleY ?? 1,
    tx: (transform.translateX ?? 0) * unitScale,
    ty: (transform.translateY ?? 0) * unitScale,
  };
}

/** `outer` applied after `inner`: a child's absolute transform is its group's times its own. */
function compose(options: Readonly<{ outer: Affine; inner: Affine }>): Affine {
  const { outer, inner } = options;
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

function union(parts: readonly (BoundsEmu | null)[]): BoundsEmu | null {
  const known = parts.filter((part): part is BoundsEmu => part !== null);
  if (known.length === 0) return null;
  return {
    left: Math.min(...known.map((part) => part.left)),
    top: Math.min(...known.map((part) => part.top)),
    right: Math.max(...known.map((part) => part.right)),
    bottom: Math.max(...known.map((part) => part.bottom)),
  };
}

function scaleBox(options: Readonly<{ bounds: BoundsEmu; pxPerEmu: number }>): BoxPx {
  const { bounds, pxPerEmu } = options;
  return {
    x: round1(bounds.left * pxPerEmu),
    y: round1(bounds.top * pxPerEmu),
    w: round1((bounds.right - bounds.left) * pxPerEmu),
    h: round1((bounds.bottom - bounds.top) * pxPerEmu),
  };
}

function emuOf(dimension: slides_v1.Schema$Dimension | undefined): number | null {
  const magnitude = dimension?.magnitude;
  if (typeof magnitude !== "number" || !Number.isFinite(magnitude)) return null;
  return dimension?.unit === "PT" ? magnitude * EMU_PER_POINT : magnitude;
}

function kindOf(element: slides_v1.Schema$PageElement): string {
  if (element.shape) return `shape:${element.shape.shapeType ?? "UNKNOWN"}`;
  if (element.image) return "image";
  if (element.table) return `table:${String(element.table.rows ?? 0)}x${String(element.table.columns ?? 0)}`;
  if (element.line) return "line";
  if (element.elementGroup) return `group:${String(element.elementGroup.children?.length ?? 0)}`;
  if (element.video) return "video";
  if (element.sheetsChart) return "sheetsChart";
  if (element.wordArt) return "wordArt";
  if (element.speakerSpotlight) return "speakerSpotlight";
  return "unknown";
}

/** A shape's or a table's text, else the alt text. Clipped: this is for recognising, not reading. */
function textOf(element: slides_v1.Schema$PageElement): string | null {
  const runs: string[] = [];
  collectText({ text: element.shape?.text, into: runs });
  for (const row of element.table?.tableRows ?? []) {
    for (const cell of row.tableCells ?? []) collectText({ text: cell.text, into: runs });
  }
  if (element.wordArt?.renderedText) runs.push(element.wordArt.renderedText);
  const joined = runs.join(" ").replace(/\s+/g, " ").trim();
  const text = joined !== "" ? joined : (element.title ?? element.description ?? "").trim();
  if (text === "") return null;
  return text.length > TEXT_EXCERPT_CHARS ? `${text.slice(0, TEXT_EXCERPT_CHARS - 1)}…` : text;
}

function collectText(options: Readonly<{ text: slides_v1.Schema$TextContent | undefined; into: string[] }>): void {
  for (const textElement of options.text?.textElements ?? []) {
    const content = textElement.textRun?.content ?? textElement.autoText?.content;
    if (typeof content === "string") options.into.push(content);
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
