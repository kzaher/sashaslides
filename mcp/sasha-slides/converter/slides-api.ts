/**
 * slides-api.ts — the subset of `presentations.batchUpdate` request shapes this
 * converter emits, typed for a browser bundle.
 *
 * Why hand-written rather than `import type { slides_v1 } from "googleapis"`:
 * this module is bundled into a Google Slides content script. `googleapis` is a
 * Node package (it pulls `node:http`, `gaxios`, `google-auth-library`), so even
 * an `import type` from it drags a Node-only type graph into the browser
 * tsconfig. The renderer's own `convert-pptx-lib.ts` has the same problem from
 * the other side — it is 194 KB of pptxgenjs-coupled code that does not compile
 * under `exactOptionalPropertyTypes`, so its exported types cannot be borrowed
 * either (verified: type-importing it reports 7+ errors inside that file).
 *
 * Every field name and enum value here is the wire name from the Slides REST v1
 * reference, so a request object can be `JSON.stringify`d straight into a
 * batchUpdate body.
 *
 * `SlidesApiRequest` is deliberately a union of single-key wrappers, exactly as
 * the wire format wants. Nothing in this codebase switches on it — the emitter
 * only ever *constructs* these — so the lack of a discriminant tag costs no
 * exhaustiveness. The tagged unions that we do branch on live in
 * `extraction.ts` and `unsupported-feature.ts`.
 */
import type { SlideImageUpload } from "./slide-image.js";

/** A batchUpdate request: exactly one operation per array entry. */
export type SlidesApiRequest =
  | Readonly<{ createShape: CreateShapeRequest }>
  | Readonly<{ createLine: CreateLineRequest }>
  | Readonly<{ createImage: CreateImageRequest }>
  /**
   * The ONE entry that is not pure wire format. `createImage.url` is fetched by
   * Google's servers, so a candidate's `data:` image has to be somewhere
   * fetchable first; `sashaStageImage` is the instruction that puts it there,
   * computed in slide-image.ts and executed by the host (`sashaInsert`), which
   * substitutes the staged file's URL and STRIPS this key before the request
   * reaches Google. A request still carrying it would be refused by batchUpdate
   * as an unknown field — loudly, which is the intended failure for a host that
   * does not know about staging.
   */
  | Readonly<{ createImage: CreateImageRequest; sashaStageImage: SlideImageUpload }>
  | Readonly<{ createTable: CreateTableRequest }>
  | Readonly<{ insertText: InsertTextRequest }>
  | Readonly<{ updateShapeProperties: UpdateShapePropertiesRequest }>
  | Readonly<{ updateLineProperties: UpdateLinePropertiesRequest }>
  | Readonly<{ updateTextStyle: UpdateTextStyleRequest }>
  | Readonly<{ updateParagraphStyle: UpdateParagraphStyleRequest }>
  | Readonly<{ createParagraphBullets: CreateParagraphBulletsRequest }>
  | Readonly<{ updateTableRowProperties: UpdateTableRowPropertiesRequest }>
  | Readonly<{ updateTableColumnProperties: UpdateTableColumnPropertiesRequest }>
  | Readonly<{ updateTableCellProperties: UpdateTableCellPropertiesRequest }>
  | Readonly<{ updateTableBorderProperties: UpdateTableBorderPropertiesRequest }>
  | Readonly<{ mergeTableCells: MergeTableCellsRequest }>;

/* ---------------------------------------------------------------- geometry */

/** Slides accepts EMU or PT for every magnitude; this converter emits EMU only. */
export type Unit = "EMU" | "PT";

export type Dimension = Readonly<{ magnitude: number; unit: Unit }>;

export type Size = Readonly<{ width: Dimension; height: Dimension }>;

/**
 * Maps element-local coordinates to page coordinates:
 *   pageX = scaleX·x + shearX·y + translateX
 *   pageY = shearY·x + scaleY·y + translateY
 * An axis-aligned element therefore uses scaleX = scaleY = 1 and the two
 * translates as its top-left corner; rotation is folded into the four
 * scale/shear terms rather than a separate angle field.
 */
export type AffineTransform = Readonly<{
  scaleX: number;
  scaleY: number;
  shearX?: number;
  shearY?: number;
  translateX: number;
  translateY: number;
  unit: Unit;
}>;

export type PageElementProperties = Readonly<{
  pageObjectId: string;
  size: Size;
  transform: AffineTransform;
}>;

/* ------------------------------------------------------------------ colour */

/** Channel values are 0–1, not 0–255. Omitted channels mean 0. */
export type RgbColor = Readonly<{ red?: number; green?: number; blue?: number }>;

export type OpaqueColor = Readonly<{ rgbColor: RgbColor }>;

export type OptionalColor = Readonly<{ opaqueColor: OpaqueColor }>;

export type SolidFill = Readonly<{ color: OpaqueColor; alpha: number }>;

/* ------------------------------------------------------------------ shapes */

/**
 * The preset shapes this converter targets. The full enum is ~150 entries; only
 * the ones an HTML box can become are listed, so a typo is a compile error.
 */
export type ShapeType =
  | "TEXT_BOX"
  | "RECTANGLE"
  | "ROUND_RECTANGLE"
  | "ELLIPSE"
  | "TRIANGLE";

export type CreateShapeRequest = Readonly<{
  objectId: string;
  shapeType: ShapeType;
  elementProperties: PageElementProperties;
}>;

export type DashStyle = "SOLID" | "DOT" | "DASH" | "DASH_DOT" | "LONG_DASH";

export type Outline = Readonly<{
  outlineFill?: Readonly<{ solidFill: SolidFill }>;
  weight?: Dimension;
  dashStyle?: DashStyle;
  propertyState?: "RENDERED" | "NOT_RENDERED" | "INHERIT";
}>;

export type ContentAlignment = "TOP" | "MIDDLE" | "BOTTOM";

export type ShapeProperties = Readonly<{
  shapeBackgroundFill?: Readonly<{
    solidFill?: SolidFill;
    propertyState?: "RENDERED" | "NOT_RENDERED" | "INHERIT";
  }>;
  outline?: Outline;
  contentAlignment?: ContentAlignment;
  /**
   * `NONE` is the only value worth writing: Slides otherwise shrinks or grows
   * text to fit, which would silently defeat the font sizes the HTML specified.
   */
  autofit?: Readonly<{ autofitType: "NONE" | "TEXT_AUTOFIT" | "SHAPE_AUTOFIT" }>;
}>;

export type UpdateShapePropertiesRequest = Readonly<{
  objectId: string;
  shapeProperties: ShapeProperties;
  /** Comma-separated field mask; `*` is legal but destroys unlisted fields. */
  fields: string;
}>;

/* ------------------------------------------------------------------- lines */

/**
 * A LINE element is defined by its bounding box: the stroke runs from the box's
 * top-left to its bottom-right. The other diagonal is expressed by a negative
 * `scaleX` (a horizontal flip), not by swapping the endpoints.
 */
export type CreateLineRequest = Readonly<{
  objectId: string;
  lineCategory: "STRAIGHT" | "BENT" | "CURVED";
  elementProperties: PageElementProperties;
}>;

export type UpdateLinePropertiesRequest = Readonly<{
  objectId: string;
  lineProperties: Readonly<{
    lineFill?: Readonly<{ solidFill: SolidFill }>;
    weight?: Dimension;
    dashStyle?: DashStyle;
  }>;
  fields: string;
}>;

/* ------------------------------------------------------------------ images */

/**
 * `url` must be a publicly fetchable http(s) URL under 50 MB / 25 megapixels —
 * Slides fetches it server-side, so `data:` and `blob:` URLs are rejected. That
 * constraint is what makes `image-source-not-fetchable` an unsupported feature
 * rather than something the emitter can work around.
 */
export type CreateImageRequest = Readonly<{
  objectId: string;
  url: string;
  elementProperties: PageElementProperties;
}>;

/* ------------------------------------------------------------------- text */

export type TextRange =
  | Readonly<{ type: "ALL" }>
  | Readonly<{ type: "FROM_START_INDEX"; startIndex: number }>
  | Readonly<{ type: "FIXED_RANGE"; startIndex: number; endIndex: number }>;

/** Omitted when the text goes into a shape rather than a table cell. */
export type TableCellLocation = Readonly<{ rowIndex: number; columnIndex: number }>;

export type InsertTextRequest = Readonly<{
  objectId: string;
  text: string;
  insertionIndex: number;
  cellLocation?: TableCellLocation;
}>;

/**
 * Note what is absent and cannot be added: letter-spacing, text-transform,
 * text-shadow and per-run line-height. Each of those becomes an
 * `UnsupportedFeature` instead.
 */
export type TextStyle = Readonly<{
  fontFamily?: string;
  fontSize?: Dimension;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  foregroundColor?: OptionalColor;
  backgroundColor?: OptionalColor;
  baselineOffset?: "NONE" | "SUPERSCRIPT" | "SUBSCRIPT";
  smallCaps?: boolean;
}>;

export type UpdateTextStyleRequest = Readonly<{
  objectId: string;
  textRange: TextRange;
  style: TextStyle;
  fields: string;
  cellLocation?: TableCellLocation;
}>;

export type Alignment = "START" | "CENTER" | "END" | "JUSTIFIED";

export type ParagraphStyle = Readonly<{
  alignment?: Alignment;
  /** Percentage of a single line box, where 100 means single-spaced. */
  lineSpacing?: number;
  spaceAbove?: Dimension;
  spaceBelow?: Dimension;
  indentStart?: Dimension;
  indentFirstLine?: Dimension;
  direction?: "LEFT_TO_RIGHT" | "RIGHT_TO_LEFT";
}>;

export type UpdateParagraphStyleRequest = Readonly<{
  objectId: string;
  textRange: TextRange;
  style: ParagraphStyle;
  fields: string;
  cellLocation?: TableCellLocation;
}>;

/**
 * Only presets exist — there is no way to set an arbitrary bullet glyph or a
 * bullet colour distinct from the run colour, which is why a CSS `::before`
 * marker degrades to `list-marker-approximated`.
 */
export type BulletGlyphPreset =
  | "BULLET_DISC_CIRCLE_SQUARE"
  | "BULLET_ARROW_DIAMOND_DISC"
  | "BULLET_CHECKBOX"
  | "NUMBERED_DIGIT_ALPHA_ROMAN"
  | "NUMBERED_DIGIT_NESTED";

export type CreateParagraphBulletsRequest = Readonly<{
  objectId: string;
  textRange: TextRange;
  bulletPreset: BulletGlyphPreset;
  cellLocation?: TableCellLocation;
}>;

/* ------------------------------------------------------------------ tables */

export type CreateTableRequest = Readonly<{
  objectId: string;
  elementProperties: PageElementProperties;
  rows: number;
  columns: number;
}>;

/**
 * `minRowHeight` is a floor, not a height: Slides grows the row when its text
 * needs more room. `geometry.ts` encodes the measured law for when that
 * happens so the emitter can report the overflow instead of hiding it.
 */
export type UpdateTableRowPropertiesRequest = Readonly<{
  objectId: string;
  rowIndices: readonly number[];
  tableRowProperties: Readonly<{ minRowHeight: Dimension }>;
  fields: string;
}>;

export type UpdateTableColumnPropertiesRequest = Readonly<{
  objectId: string;
  columnIndices: readonly number[];
  tableColumnProperties: Readonly<{ columnWidth: Dimension }>;
  fields: string;
}>;

export type TableRange = Readonly<{
  location: TableCellLocation;
  rowSpan: number;
  columnSpan: number;
}>;

export type UpdateTableCellPropertiesRequest = Readonly<{
  objectId: string;
  tableRange: TableRange;
  tableCellProperties: Readonly<{
    tableCellBackgroundFill?: Readonly<{
      solidFill?: SolidFill;
      propertyState?: "RENDERED" | "NOT_RENDERED" | "INHERIT";
    }>;
    contentAlignment?: ContentAlignment;
  }>;
  fields: string;
}>;

export type BorderPosition =
  | "ALL"
  | "BOTTOM"
  | "INNER"
  | "INNER_HORIZONTAL"
  | "INNER_VERTICAL"
  | "LEFT"
  | "OUTER"
  | "RIGHT"
  | "TOP";

export type UpdateTableBorderPropertiesRequest = Readonly<{
  objectId: string;
  tableRange: TableRange;
  borderPosition: BorderPosition;
  tableBorderProperties: Readonly<{
    tableBorderFill?: Readonly<{ solidFill: SolidFill }>;
    weight?: Dimension;
    dashStyle?: DashStyle;
  }>;
  fields: string;
}>;

export type MergeTableCellsRequest = Readonly<{
  objectId: string;
  tableRange: TableRange;
}>;
