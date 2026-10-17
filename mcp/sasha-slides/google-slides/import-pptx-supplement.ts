/**
 * What `presentations.get` leaves out, read from the same presentation exported as .pptx.
 *
 * WHY A SECOND READ: the Slides programming interface describes a gradient shape fill as an empty
 * `shapeBackgroundFill: {}` (no stops, no angle), so an import from it alone draws the shape with no
 * fill, and white text on it disappears. Drive's `files.export` to .pptx (read only) writes the same
 * presentation as Office XML, which keeps `<a:gradFill>` with every stop. It also keeps a few other
 * values the interface hides (text-box insets in `<a:bodyPr>`, the rounded-rectangle corner
 * adjustment, a custom shape's `<a:custGeom>` outline, table-cell margins); they are read here so each importer rule can use them, and an
 * absent value is null rather than a guessed default.
 *
 * MATCHING BY IDENTITY, NOT POSITION. The export writes each page's elements in the presentation's
 * own z order, one `<p:sp>`/`<p:pic>`/`<p:cxnSp>`/`<p:graphicFrame>`/`<p:grpSp>` per page element,
 * groups nested the same way, and slides in presentation order. Each element is matched to its
 * `presentations.get` twin by that structure (slide n, child i of the same parent), confirmed by
 * kind, so a flipped, rotated or sheared element matches exactly like any other; matching by
 * position would lose those (their export offsets differ from the transform's translation). When a
 * page's structure does not line up, the export's names are tried next: Google names an element
 * `Google Shape;<id>;<page>`, and on presentations made in Slides `<id>` is the element's object
 * id. A page that lines up neither way gets nothing and is listed in `unmatchedSlides`, so the
 * import reports the loss instead of borrowing another element's fill.
 */
import { childNamed, childrenNamed, descendantNamed, openPptxArchive, parseXml, PptxArchiveError, type PptxArchive, type XmlElement } from "./pptx-archive.ts";
import type { CustomOutline } from "../engine/src/contracts/document.ts";
import { customOutlineOf, type ShapeAdjustments } from "./import-shape-geometry.ts";
import type { SlidesColour, SlidesPageElement, SlidesPresentation, SlidesSolidFill } from "./slides-presentation.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

/** A stop at `offset` (0..1 along the gradient) in a Slides colour, so theme references survive. */
export type PptxGradientStop = Readonly<{ offset: number; fill: SlidesSolidFill }>;

export type PptxGradient =
  /** `angleDegrees` in Office's convention: 0 runs left to right, angles turn clockwise. */
  | Readonly<{ kind: "linear"; angleDegrees: number; stops: readonly PptxGradientStop[] }>
  /** The centre of the gradient as fractions of the element's box. */
  | Readonly<{ kind: "radial"; centreX: number; centreY: number; stops: readonly PptxGradientStop[] }>;

/** Insets in English metric units. */
export type PptxInsets = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/** Insets in English metric units where an absent side was not stated and inherits from the placeholder parent. */
export type PptxStatedInsets = Readonly<{ left?: number; top?: number; right?: number; bottom?: number }>;

export type PptxElementSupplement = Readonly<{
  /** The element's own gradient fill; null when it has none or names a colour this does not read. */
  gradient: PptxGradient | null;
  /**
   * `<a:bodyPr>` insets; null without a text body. A side the XML leaves out is Office's default on
   * an ordinary shape, but is left out here on a placeholder (`<p:ph>`), whose bare `<a:bodyPr/>`
   * inherits that side from its layout and master placeholders (import-presentation.ts textInsetsOf).
   */
  textInsets: PptxStatedInsets | null;
  /** The `<a:prstGeom>` guide values (`adj`, `adj1`, ...) as written; null for a custom outline or no geometry. */
  shapeAdjustments: ShapeAdjustments | null;
  /** The `<a:custGeom>` outline (import-shape-geometry.ts customOutlineOf); null for a preset, no geometry, or an outline it cannot read. */
  customOutline: CustomOutline | null;
  /** Table-cell margins, row-major over every `<a:tc>` (merged cells included); empty for a non-table. */
  cellMargins: readonly PptxInsets[];
}>;

export type PptxSupplement = Readonly<{
  /** By `presentations.get` object id. */
  elements: ReadonlyMap<string, PptxElementSupplement>;
  /** Slide object ids whose elements could not be matched to the export; their elements get nothing. */
  unmatchedSlides: readonly string[];
}>;

export type PptxSupplementOutcome = Readonly<{ kind: "read"; supplement: PptxSupplement }> | Readonly<{ kind: "unreadable"; message: string }>;

export function readPptxSupplement(options: Readonly<{ archive: Uint8Array; presentation: SlidesPresentation }>): PptxSupplementOutcome {
  try {
    return { kind: "read", supplement: supplementOf({ archive: openPptxArchive(options.archive), presentation: options.presentation }) };
  } catch (cause) {
    if (cause instanceof PptxArchiveError) return { kind: "unreadable", message: cause.message };
    throw cause;
  }
}

function supplementOf(options: Readonly<{ archive: PptxArchive; presentation: SlidesPresentation }>): PptxSupplement {
  const { archive, presentation } = options;
  const slideParts = slidePartsInOrder(archive);
  const elements = new Map<string, PptxElementSupplement>();
  const unmatchedSlides: string[] = [];
  presentation.slides.forEach((slide, index) => {
    const part = slideParts.length === presentation.slides.length ? slideParts[index] : undefined;
    const text = part === undefined ? null : archive.text(part);
    const tree = text === null ? null : descendantNamed(parseXml(text), "p:spTree");
    const matched = tree === null ? null : (matchByStructure({ apiElements: slide.elements, exported: pageElementsOf(tree) }) ?? matchByName({ apiElements: slide.elements, tree }));
    if (matched === null) {
      unmatchedSlides.push(slide.objectId);
      return;
    }
    for (const [objectId, exported] of matched) elements.set(objectId, elementSupplementOf(exported));
  });
  return { elements, unmatchedSlides };
}

/** The slide parts in presentation order: presentation.xml's `sldIdLst`, resolved through its relationships. */
function slidePartsInOrder(archive: PptxArchive): readonly string[] {
  const presentationText = archive.text("ppt/presentation.xml");
  const relationshipsText = archive.text("ppt/_rels/presentation.xml.rels");
  if (presentationText === null || relationshipsText === null) throw new PptxArchiveError("the archive has no ppt/presentation.xml and its relationships");
  const targets = new Map<string, string>();
  for (const relationship of childrenNamed(parseXml(relationshipsText), "Relationship")) {
    const id = relationship.attributes.get("Id");
    const target = relationship.attributes.get("Target");
    if (id !== undefined && target !== undefined) targets.set(id, partNameOf(target));
  }
  const list = childNamed(parseXml(presentationText), "p:sldIdLst");
  return childrenNamed(list, "p:sldId").map((entry) => targets.get(entry.attributes.get("r:id") ?? "") ?? "");
}

/** A relationship target of presentation.xml as an archive entry name (`slides/slide1.xml` -> `ppt/slides/slide1.xml`). */
function partNameOf(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  return `ppt/${target}`;
}

const PAGE_ELEMENT_NAMES: ReadonlySet<string> = new Set(["p:sp", "p:pic", "p:cxnSp", "p:graphicFrame", "p:grpSp"]);

/** A container's page elements in z order; `mc:AlternateContent` contributes its first choice only. */
function pageElementsOf(container: XmlElement): readonly XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of container.children) {
    if (PAGE_ELEMENT_NAMES.has(child.name)) found.push(child);
    if (child.name === "mc:AlternateContent") {
      const choice = childNamed(child, "mc:Choice") ?? childNamed(child, "mc:Fallback");
      if (choice !== null) found.push(...pageElementsOf(choice));
    }
  }
  return found;
}

/** Child i of each parent to child i of its twin, all the way down; null when any level disagrees. */
function matchByStructure(options: Readonly<{ apiElements: readonly SlidesPageElement[]; exported: readonly XmlElement[] }>): ReadonlyMap<string, XmlElement> | null {
  const { apiElements, exported } = options;
  if (apiElements.length !== exported.length) return null;
  const matched = new Map<string, XmlElement>();
  for (let index = 0; index < apiElements.length; index++) {
    const apiElement = apiElements[index];
    const exportedElement = exported[index];
    if (apiElement === undefined || exportedElement === undefined || !kindsAgree({ apiElement, exportedElement })) return null;
    matched.set(apiElement.objectId, exportedElement);
    if (apiElement.content.kind !== "group") continue;
    const children = matchByStructure({ apiElements: apiElement.content.children, exported: pageElementsOf(exportedElement) });
    if (children === null) return null;
    for (const [objectId, child] of children) matched.set(objectId, child);
  }
  return matched;
}

/** Whether an exported element can be the twin of an API element of this kind. */
function kindsAgree(options: Readonly<{ apiElement: SlidesPageElement; exportedElement: XmlElement }>): boolean {
  const exportedName = options.exportedElement.name;
  const content = options.apiElement.content;
  switch (content.kind) {
    case "shape":
    case "wordArt":
      return exportedName === "p:sp";
    case "image":
    case "video":
      return exportedName === "p:pic" || exportedName === "p:sp";
    case "line":
      return exportedName === "p:cxnSp" || exportedName === "p:sp";
    case "table":
      return exportedName === "p:graphicFrame";
    case "sheetsChart":
      return exportedName === "p:pic" || exportedName === "p:graphicFrame";
    case "group":
      return exportedName === "p:grpSp";
    case "speakerSpotlight":
    case "unknown":
      return true;
    default:
      return assertNever(content);
  }
}

/** `Google Shape;<object id>;<page>` names, matched to API object ids anywhere on the page; null when none match. */
function matchByName(options: Readonly<{ apiElements: readonly SlidesPageElement[]; tree: XmlElement }>): ReadonlyMap<string, XmlElement> | null {
  const named = new Map<string, XmlElement>();
  const visit = (container: XmlElement): void => {
    for (const element of pageElementsOf(container)) {
      const name = descendantNamed(element, "p:cNvPr")?.attributes.get("name") ?? "";
      const objectId = /^Google Shape;(.+);[^;]*$/.exec(name)?.[1];
      if (objectId !== undefined) named.set(objectId, element);
      if (element.name === "p:grpSp") visit(element);
    }
  };
  visit(options.tree);
  const matched = new Map<string, XmlElement>();
  const visitApi = (elements: readonly SlidesPageElement[]): void => {
    for (const element of elements) {
      const twin = named.get(element.objectId);
      if (twin !== undefined && kindsAgree({ apiElement: element, exportedElement: twin })) matched.set(element.objectId, twin);
      if (element.content.kind === "group") visitApi(element.content.children);
    }
  };
  visitApi(options.apiElements);
  return matched.size === 0 ? null : matched;
}

/** Office's defaults: 0.1 inch left and right, 0.05 inch top and bottom (ECMA-376 20.1.2.1.1, 21.1.3.15). */
const DEFAULT_HORIZONTAL_INSET = 91_440;
const DEFAULT_VERTICAL_INSET = 45_720;
/** Office percentages are thousandths of a percent; angles are sixty-thousandths of a degree. */
const OFFICE_PERCENT = 100_000;
const OFFICE_DEGREE = 60_000;

function elementSupplementOf(element: XmlElement): PptxElementSupplement {
  const shapeProperties = childNamed(element, "p:spPr");
  const bodyProperties = element.name === "p:sp" ? (descendantNamed(childNamed(element, "p:txBody"), "a:bodyPr") ?? null) : null;
  const geometry = childNamed(shapeProperties, "a:prstGeom");
  const customGeometry = childNamed(shapeProperties, "a:custGeom");
  const extent = childNamed(childNamed(shapeProperties, "a:xfrm"), "a:ext");
  const table = element.name === "p:graphicFrame" ? descendantNamed(element, "a:tbl") : null;
  const placeholder = descendantNamed(childNamed(element, "p:nvSpPr"), "p:ph") !== null;
  const textInsetNames = { left: "lIns", top: "tIns", right: "rIns", bottom: "bIns" } as const;
  return {
    gradient: gradientOf(childNamed(shapeProperties, "a:gradFill")),
    textInsets: bodyProperties === null ? null : placeholder ? statedInsetsOf({ element: bodyProperties, names: textInsetNames }) : insetsOf({ element: bodyProperties, names: textInsetNames }),
    shapeAdjustments: geometry === null ? null : adjustmentsOf(geometry),
    customOutline:
      customGeometry === null
        ? null
        : customOutlineOf({ geometry: customGeometry, extent: { width: integerOr(extent?.attributes.get("cx"), 0), height: integerOr(extent?.attributes.get("cy"), 0) } }),
    cellMargins: childrenNamed(table, "a:tr").flatMap((row) =>
      childrenNamed(row, "a:tc").map((cell) => insetsOf({ element: childNamed(cell, "a:tcPr"), names: { left: "marL", top: "marT", right: "marR", bottom: "marB" } })),
    ),
  };
}

function insetsOf(options: Readonly<{ element: XmlElement | null; names: Readonly<Record<keyof PptxInsets, string>> }>): PptxInsets {
  const read = (name: string, fallback: number): number => integerOr(options.element?.attributes.get(name), fallback);
  return {
    left: read(options.names.left, DEFAULT_HORIZONTAL_INSET),
    top: read(options.names.top, DEFAULT_VERTICAL_INSET),
    right: read(options.names.right, DEFAULT_HORIZONTAL_INSET),
    bottom: read(options.names.bottom, DEFAULT_VERTICAL_INSET),
  };
}

/** Only the sides the XML states; a placeholder inherits the rest. */
function statedInsetsOf(options: Readonly<{ element: XmlElement; names: Readonly<Record<keyof PptxInsets, string>> }>): PptxStatedInsets {
  const stated: { left?: number; top?: number; right?: number; bottom?: number } = {};
  for (const side of ["left", "top", "right", "bottom"] as const) {
    const value = options.element.attributes.get(options.names[side]);
    if (value !== undefined && /^-?\d+$/.test(value)) stated[side] = Number(value);
  }
  return stated;
}

/**
 * Every `<a:gd name fmla="val N">` of a preset geometry, as written (100000 = the shorter side).
 * A guide given by any other formula is left out, so the preset's default applies to it
 * (import-shape-geometry.ts roundedShapeOf).
 */
function adjustmentsOf(geometry: XmlElement): ShapeAdjustments {
  const adjustments = new Map<string, number>();
  for (const guide of childrenNamed(childNamed(geometry, "a:avLst"), "a:gd")) {
    const name = guide.attributes.get("name");
    const formula = /^val\s+(-?\d+(?:\.\d+)?)$/.exec(guide.attributes.get("fmla") ?? "");
    if (name !== undefined && formula?.[1] !== undefined) adjustments.set(name, Number(formula[1]));
  }
  return adjustments;
}

/**
 * `<a:gradFill>`: `<a:lin ang>` is linear; `<a:path>` (circle, rect or shape) is drawn as radial
 * about the centre of its `fillToRect`. Null when any stop names a colour this does not read, so a
 * half-understood gradient is reported as lost rather than drawn wrong.
 */
function gradientOf(gradientFill: XmlElement | null): PptxGradient | null {
  if (gradientFill === null) return null;
  const stops: PptxGradientStop[] = [];
  for (const stop of childrenNamed(childNamed(gradientFill, "a:gsLst"), "a:gs")) {
    const fill = stopFillOf(stop);
    if (fill === null) return null;
    stops.push({ offset: clampUnit(integerOr(stop.attributes.get("pos"), 0) / OFFICE_PERCENT), fill });
  }
  if (stops.length === 0) return null;
  stops.sort((first, second) => first.offset - second.offset);
  const linear = childNamed(gradientFill, "a:lin");
  const path = childNamed(gradientFill, "a:path");
  if (linear === null && path !== null) {
    const focus = childNamed(path, "a:fillToRect");
    const left = percentOf(focus?.attributes.get("l"));
    const top = percentOf(focus?.attributes.get("t"));
    const right = percentOf(focus?.attributes.get("r"));
    const bottom = percentOf(focus?.attributes.get("b"));
    return { kind: "radial", centreX: clampUnit((left + 1 - right) / 2), centreY: clampUnit((top + 1 - bottom) / 2), stops };
  }
  return { kind: "linear", angleDegrees: integerOr(linear?.attributes.get("ang"), 0) / OFFICE_DEGREE, stops };
}

/** DrawingML scheme colour names to Slides' `ThemeColorType`. */
const THEME_TYPE_BY_SCHEME_NAME: ReadonlyMap<string, string> = new Map([
  ["dk1", "DARK1"],
  ["lt1", "LIGHT1"],
  ["dk2", "DARK2"],
  ["lt2", "LIGHT2"],
  ["accent1", "ACCENT1"],
  ["accent2", "ACCENT2"],
  ["accent3", "ACCENT3"],
  ["accent4", "ACCENT4"],
  ["accent5", "ACCENT5"],
  ["accent6", "ACCENT6"],
  ["hlink", "HYPERLINK"],
  ["folHlink", "FOLLOWED_HYPERLINK"],
  ["tx1", "TEXT1"],
  ["bg1", "BACKGROUND1"],
  ["tx2", "TEXT2"],
  ["bg2", "BACKGROUND2"],
]);

/**
 * A stop's colour: `srgbClr` or `schemeClr`, with its `alpha`. Google's export writes resolved
 * `srgbClr`s; other colour modifiers (lumMod, tint, ...) are not applied.
 */
function stopFillOf(stop: XmlElement): SlidesSolidFill | null {
  const literal = childNamed(stop, "a:srgbClr");
  const scheme = childNamed(stop, "a:schemeClr");
  const colourElement = literal ?? scheme;
  if (colourElement === null) return null;
  const alpha = clampUnit(integerOr(childNamed(colourElement, "a:alpha")?.attributes.get("val"), OFFICE_PERCENT) / OFFICE_PERCENT);
  const colour = literal !== null ? literalColourOf(literal.attributes.get("val")) : schemeColourOf(scheme?.attributes.get("val"));
  return colour === null ? null : { colour, alpha };
}

function literalColourOf(value: string | undefined): SlidesColour | null {
  if (value === undefined || !/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return { kind: "literal", hexadecimal: `#${value.toLowerCase()}` };
}

function schemeColourOf(value: string | undefined): SlidesColour | null {
  const type = value === undefined ? undefined : THEME_TYPE_BY_SCHEME_NAME.get(value);
  return type === undefined ? null : { kind: "theme", type };
}

/** An Office percentage attribute (`50%` or `50000`) as a fraction; absent is 0. */
function percentOf(value: string | undefined): number {
  if (value === undefined) return 0;
  if (value.endsWith("%")) return Number(value.slice(0, -1)) / 100 || 0;
  return integerOr(value, 0) / OFFICE_PERCENT;
}

function integerOr(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^-?\d+$/.test(value)) return fallback;
  return Number(value);
}

/** Clamped to 0..1 and rounded to a millionth, so `0.2` stays `0.2` after the percentage arithmetic. */
function clampUnit(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}
