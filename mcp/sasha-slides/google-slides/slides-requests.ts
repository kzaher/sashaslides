/**
 * The `presentations.batchUpdate` requests an export sends, as wire-shaped values.
 *
 * The converter's `SlidesApiRequest` (converter/slides-api.ts) covers what a candidate HTML slide
 * needs and is reused as is for the composition path; an export also creates and deletes pages,
 * sets backgrounds and skip, groups, rotates groups, creates any of the 22 presets and sets
 * weighted fonts and links, so those shapes are declared here. Every field name is the Slides v1
 * wire name, so a request is `JSON.stringify`d straight into a batchUpdate body.
 *
 * Two entries are INSTRUCTIONS, not wire requests (the converter's `sashaStageImage` precedent):
 * `sashaSlideBoundary` separates one slide's batch from the next in the add-on's flat plan, and
 * `sashaSpeakerNotes` asks the host to write a slide's notes once it has read back the notes
 * shape's id (`createSlide` cannot choose it). The add-on's Code.gs executes and strips both; the
 * server-side runner never puts them on the wire.
 */
import type { SlidesApiRequest } from "../converter/slides-api.ts";

export type Dimension = Readonly<{ magnitude: number; unit: "EMU" | "PT" }>;

export type WireTransform = Readonly<{
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  translateX: number;
  translateY: number;
  unit: "EMU";
}>;

export type WireElementProperties = Readonly<{
  pageObjectId: string;
  size: Readonly<{ width: Dimension; height: Dimension }>;
  transform: WireTransform;
}>;

export type WireChannels = Readonly<{ red: number; green: number; blue: number }>;
export type WireOpaqueColour = Readonly<{ rgbColor: WireChannels }>;
export type WireSolidFill = Readonly<{ color: WireOpaqueColour; alpha: number }>;

export type WireTextStyle = Readonly<{
  weightedFontFamily?: Readonly<{ fontFamily: string; weight: number }>;
  fontSize?: Dimension;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  smallCaps?: boolean;
  baselineOffset?: "NONE" | "SUPERSCRIPT" | "SUBSCRIPT";
  foregroundColor?: Readonly<{ opaqueColor: WireOpaqueColour }>;
  backgroundColor?: Readonly<{ opaqueColor?: WireOpaqueColour }>;
  link?: Readonly<{ url: string }> | Readonly<{ pageObjectId: string }>;
}>;

export type WireParagraphStyle = Readonly<{
  alignment?: "START" | "CENTER" | "END" | "JUSTIFIED";
  lineSpacing?: number;
  spaceAbove?: Dimension;
  spaceBelow?: Dimension;
  indentStart?: Dimension;
  indentFirstLine?: Dimension;
  direction?: "LEFT_TO_RIGHT" | "RIGHT_TO_LEFT";
}>;

export type WireTextRange = Readonly<{ type: "ALL" }> | Readonly<{ type: "FIXED_RANGE"; startIndex: number; endIndex: number }>;
export type WireCellLocation = Readonly<{ rowIndex: number; columnIndex: number }>;
export type WireTableRange = Readonly<{ location: WireCellLocation; rowSpan: number; columnSpan: number }>;

export type ExportRequest =
  | SlidesApiRequest
  | Readonly<{ createSlide: Readonly<{ objectId: string; insertionIndex: number; slideLayoutReference: Readonly<{ predefinedLayout: "BLANK" }> }> }>
  | Readonly<{ deleteObject: Readonly<{ objectId: string }> }>
  | Readonly<{
      updatePageProperties: Readonly<{
        objectId: string;
        pageProperties: Readonly<{
          pageBackgroundFill:
            | Readonly<{ solidFill: WireSolidFill }>
            | Readonly<{ stretchedPictureFill: Readonly<{ contentUrl: string }> }>
            | Readonly<{ propertyState: "NOT_RENDERED" }>;
        }>;
        fields: string;
      }>;
    }>
  | Readonly<{ updateSlideProperties: Readonly<{ objectId: string; slideProperties: Readonly<{ isSkipped: boolean }>; fields: "isSkipped" }> }>
  | Readonly<{ createShape: Readonly<{ objectId: string; shapeType: string; elementProperties: WireElementProperties }> }>
  | Readonly<{
      updateShapeProperties: Readonly<{
        objectId: string;
        shapeProperties: Readonly<{
          shapeBackgroundFill?: Readonly<{ solidFill: WireSolidFill }> | Readonly<{ propertyState: "NOT_RENDERED" }>;
          outline?:
            | Readonly<{ outlineFill: Readonly<{ solidFill: WireSolidFill }>; weight: Dimension; dashStyle: string }>
            | Readonly<{ propertyState: "NOT_RENDERED" }>;
          contentAlignment?: "TOP" | "MIDDLE" | "BOTTOM";
        }>;
        fields: string;
      }>;
    }>
  | Readonly<{ insertText: Readonly<{ objectId: string; text: string; insertionIndex: number; cellLocation?: WireCellLocation }> }>
  | Readonly<{ updateTextStyle: Readonly<{ objectId: string; textRange: WireTextRange; style: WireTextStyle; fields: string; cellLocation?: WireCellLocation }> }>
  | Readonly<{ updateParagraphStyle: Readonly<{ objectId: string; textRange: WireTextRange; style: WireParagraphStyle; fields: string; cellLocation?: WireCellLocation }> }>
  | Readonly<{ createParagraphBullets: Readonly<{ objectId: string; textRange: WireTextRange; bulletPreset: string; cellLocation?: WireCellLocation }> }>
  | Readonly<{ createImage: Readonly<{ objectId: string; url: string; elementProperties: WireElementProperties }> }>
  | Readonly<{
      updateImageProperties: Readonly<{
        objectId: string;
        imageProperties: Readonly<{ outline: Readonly<{ outlineFill: Readonly<{ solidFill: WireSolidFill }>; weight: Dimension; dashStyle: string }> }>;
        fields: string;
      }>;
    }>
  | Readonly<{ createLine: Readonly<{ objectId: string; lineCategory: "STRAIGHT" | "BENT" | "CURVED"; elementProperties: WireElementProperties }> }>
  | Readonly<{
      updateLineProperties: Readonly<{
        objectId: string;
        lineProperties: Readonly<{ lineFill: Readonly<{ solidFill: WireSolidFill }>; weight: Dimension; dashStyle: string; startArrow: string; endArrow: string }>;
        fields: string;
      }>;
    }>
  | Readonly<{ createTable: Readonly<{ objectId: string; rows: number; columns: number; elementProperties: WireElementProperties }> }>
  | Readonly<{ updateTableColumnProperties: Readonly<{ objectId: string; columnIndices: readonly number[]; tableColumnProperties: Readonly<{ columnWidth: Dimension }>; fields: "columnWidth" }> }>
  | Readonly<{ updateTableRowProperties: Readonly<{ objectId: string; rowIndices: readonly number[]; tableRowProperties: Readonly<{ minRowHeight: Dimension }>; fields: "minRowHeight" }> }>
  | Readonly<{
      updateTableCellProperties: Readonly<{
        objectId: string;
        tableRange: WireTableRange;
        tableCellProperties: Readonly<{
          tableCellBackgroundFill: Readonly<{ solidFill: WireSolidFill }> | Readonly<{ propertyState: "NOT_RENDERED" }>;
          contentAlignment: "TOP" | "MIDDLE" | "BOTTOM";
        }>;
        fields: string;
      }>;
    }>
  | Readonly<{
      updateTableBorderProperties: Readonly<{
        objectId: string;
        tableRange: WireTableRange;
        borderPosition: "TOP" | "BOTTOM" | "LEFT" | "RIGHT";
        tableBorderProperties: Readonly<{ tableBorderFill: Readonly<{ solidFill: WireSolidFill }>; weight: Dimension; dashStyle: string }>;
        fields: string;
      }>;
    }>
  | Readonly<{ mergeTableCells: Readonly<{ objectId: string; tableRange: WireTableRange }> }>
  | Readonly<{ groupObjects: Readonly<{ groupObjectId: string; childrenObjectIds: readonly string[] }> }>
  | Readonly<{ updatePageElementTransform: Readonly<{ objectId: string; applyMode: "RELATIVE"; transform: WireTransform }> }>;

/** Host instructions in the add-on's flat plan (see the header). */
export type ExportInstruction =
  | Readonly<{ sashaSlideBoundary: Readonly<{ slideId: string; slideNumber: number }> }>
  | Readonly<{ sashaSpeakerNotes: Readonly<{ slideObjectId: string; text: string }> }>;
