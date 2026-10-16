// THE ELEMENT COMPONENTS: one React component per element kind, shared by every renderer output
// (StaticSlide for the presenter and thumbnails, the editing canvas, and renderSlideMarkup for the
// transition sandbox), so all three draw an element identically (contracts/render.ts header).
//
// Key decisions:
//
//  * LEAVES ARE ABSOLUTE IN SLIDE UNITS; A GROUP IS AN `inset: 0` WRAPPER. A leaf sits at its
//    unrotated frame, rotated and flipped by one transform about its centre; a group carries the
//    data attributes and holds its children, whose frames are already absolute slide coordinates.
//    Nothing is ever transformed twice.
//  * MEMOISED ON SNAPSHOT IDENTITY. The model keeps untouched elements `===` between revisions, and
//    the render context changes only when what it holds changes (render-context.ts), so a drag that
//    previews one element re-renders one element.
//  * MEASURED LAYOUT IS REPORTED, NEVER WRITTEN. On the editing canvas a table reports its visible
//    row heights and a text box that grows reports the height its text needs (SPEC.md "Measured
//    layout"); the reducer decides what to do with them. Elsewhere `measurement` is null.
//  * SHRINK ON OVERFLOW is a layout effect: the text layer measures its content against the box and
//    scales the text in steps of 2.5 %, down to 25 %, before the browser paints.
//  * VALUES FROM A NEWER VERSION draw hatched, with "made with a newer version" on hover, in the
//    element's frame; an element of an unknown kind is only that placeholder.

import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ArrowHead } from "../../contracts/style.ts";
import type {
  ElementSnapshot,
  GroupElement,
  ImageElement,
  LineElement,
  ShapeElement,
  TableCell,
  TableElement,
  TextBody,
  UnsupportedElement,
} from "../../contracts/document.ts";
import type { ThemeSnapshot } from "../../contracts/document.ts";
import type { Frame } from "../../contracts/geometry.ts";
import { ELEMENT_ID_ATTRIBUTE, ELEMENT_KIND_ATTRIBUTE, MORPH_KEY_ATTRIBUTE } from "../../contracts/render.ts";
import type { TextTarget } from "../../contracts/selection.ts";
import type { Stroke, TextBoxStyle } from "../../contracts/style.ts";
import type { SlideRenderContext } from "./render-context.ts";
import { customOutlinePath, effectiveCornerRadius, isDrawnAsBox, NO_TEXT_INSET, presetTextInset, shapeOutlinePath, type TextInset } from "./shape-geometry.ts";
import {
  PLACEHOLDER_HATCHING,
  borderDeclarations,
  boxShadowValue,
  colourValue,
  cornerRadiusValue,
  dropShadowFilterValue,
  fillRendering,
  leafFrameDeclarations,
  roundNumber,
  strokeDashArray,
  textCounterFlipValue,
  verticalJustification,
} from "./inline-styles.ts";
import { textStyleContextOf, type TextStyleContext } from "./text-layout.ts";
import { TextParagraphs } from "./text-paragraphs.tsx";

/** On the text layer of every text-bearing element; its child holds the paragraphs. */
export const TEXT_LAYER_ATTRIBUTE = "data-sasha-text-layer";
export const TEXT_CONTENT_ATTRIBUTE = "data-sasha-text-content";
/** On each table row, with the row id; the table's boundaries are hit-tested by the canvas overlay. */
export const TABLE_ROW_ATTRIBUTE = "data-sasha-table-row-id";
/** On each table cell, with its column id; with the row's attribute it names the cell a double click enters. */
export const TABLE_CELL_COLUMN_ATTRIBUTE = "data-sasha-table-column-id";
/** On a hatched placeholder for an unknown element or value. */
export const UNSUPPORTED_ATTRIBUTE = "data-sasha-unsupported";
/** What a placeholder says on hover (SPEC.md section 8). */
export const NEWER_VERSION_EXPLANATION = "Made with a newer version of Sasha: shown as a placeholder and left unchanged.";

/** The smallest shrink-on-overflow factor and its step (SPEC.md section 8). */
export const SHRINK_MINIMUM_SCALE = 0.25;
export const SHRINK_STEP = 0.025;

export type ElementViewProperties = Readonly<{ element: ElementSnapshot; context: SlideRenderContext }>;

export const ElementView = memo(function ElementView(properties: ElementViewProperties): ReactElement {
  const element = properties.element;
  switch (element.kind) {
    case "shape":
      return <ShapeView element={element} context={properties.context} />;
    case "image":
      return <ImageView element={element} context={properties.context} />;
    case "line":
      return <LineView element={element} context={properties.context} />;
    case "table":
      return <TableView element={element} context={properties.context} />;
    case "group":
      return <GroupView element={element} context={properties.context} />;
    case "unsupported":
      return <UnsupportedView element={element} />;
    default:
      return assertNever(element);
  }
});

/** The data attributes every rendered element carries (contracts/render.ts "stable data attributes"). */
export function elementAttributes(element: ElementSnapshot): Readonly<Record<string, string>> {
  return { [ELEMENT_ID_ATTRIBUTE]: element.id, [ELEMENT_KIND_ATTRIBUTE]: element.kind, [MORPH_KEY_ATTRIBUTE]: element.morphKey };
}

function ShapeView(properties: Readonly<{ element: ShapeElement; context: SlideRenderContext }>): ReactElement {
  const { element, context } = properties;
  const frame = element.frame;
  const box = element.box;
  const theme = context.theme;
  const fill = fillRendering({ fill: box.fill, theme, assetAddress: context.assetAddress });
  const leaf: CSSProperties = { ...leafFrameDeclarations(frame), ...(box.opacity < 1 ? { opacity: box.opacity } : {}) };
  const text = (
    <ShapeTextLayer element={element} context={context} inset={element.customOutline === null ? presetTextInset(element.preset) : NO_TEXT_INSET} />
  );
  if (isDrawnAsBox(element)) {
    const radius = effectiveCornerRadius({ preset: element.preset, radius: box.cornerRadius, width: frame.width, height: frame.height });
    const style: CSSProperties = {
      ...leaf,
      ...fill.background,
      ...borderDeclarations(box.border, theme),
      borderRadius: cornerRadiusValue(radius),
      ...(box.shadow === null ? {} : { boxShadow: boxShadowValue(box.shadow, theme) }),
    };
    return (
      <div style={style} {...elementAttributes(element)}>
        {fill.imageLayer === null ? null : <div style={fill.imageLayer} />}
        {text}
        <UnsupportedValues keys={element.unsupportedKeys} />
      </div>
    );
  }
  const outline = vectorOutline(element);
  const stroke = vectorStroke(element);
  return (
    <div style={leaf} {...elementAttributes(element)}>
      <div style={{ position: "absolute", inset: 0, ...(box.shadow === null ? {} : { filter: dropShadowFilterValue(box.shadow, theme) }) }}>
        {/* An empty clip path would clip nothing, so a freeform with no filled path draws no fill at all. */}
        {outline.fill === "" ? null : (
          <div style={{ position: "absolute", inset: 0, clipPath: `path(${outline.fillRule}"${outline.fill}")`, ...fill.background }}>
            {fill.imageLayer === null ? null : <div style={fill.imageLayer} />}
          </div>
        )}
        {stroke === null || outline.stroke === "" ? null : (
          <svg width={roundNumber(frame.width)} height={roundNumber(frame.height)} viewBox={`0 0 ${roundNumber(frame.width)} ${roundNumber(frame.height)}`} style={{ position: "absolute", inset: 0, overflow: "visible" }} aria-hidden="true">
            <path d={outline.stroke} fill="none" stroke={colourValue(stroke.colour, theme)} strokeWidth={roundNumber(stroke.width)} strokeDasharray={strokeDashArray(stroke.dash, stroke.width)} strokeLinejoin="round" />
          </svg>
        )}
      </div>
      {text}
      <UnsupportedValues keys={element.unsupportedKeys} />
    </div>
  );
}

type VectorOutline = Readonly<{ fill: string; stroke: string; fillRule: "" | "evenodd, " }>;

/**
 * The fill region and the stroked line of a shape drawn as a path. A preset uses one path for both.
 * A freeform fills even-odd, as Office and LibreOffice fill a multi-path outline (a combined shape's
 * hole stays open); a single closed path, the common case, fills the same under either rule.
 */
function vectorOutline(element: ShapeElement): VectorOutline {
  const { width, height } = element.frame;
  if (element.customOutline !== null) {
    return {
      fill: customOutlinePath({ outline: element.customOutline, width, height, part: "fill" }),
      stroke: customOutlinePath({ outline: element.customOutline, width, height, part: "stroke" }),
      fillRule: "evenodd, ",
    };
  }
  const preset = shapeOutlinePath({ preset: element.preset, width, height }) ?? "";
  return { fill: preset, stroke: preset, fillRule: "" };
}

/** A vector preset has one outline: a uniform border, or the first side of a per-side one. */
function vectorStroke(element: ShapeElement): Stroke | null {
  const border = element.box.border;
  switch (border.kind) {
    case "none":
      return null;
    case "uniform":
      return border.stroke;
    case "perSide":
      return border.top ?? border.right ?? border.bottom ?? border.left;
    default:
      return assertNever(border);
  }
}

function ShapeTextLayer(properties: Readonly<{ element: ShapeElement; context: SlideRenderContext; inset: TextInset }>): ReactElement {
  const { element, context, inset } = properties;
  const target: TextTarget = { kind: "element", slideId: context.slideId, elementId: element.id };
  const styleContext = textStyleContextOf({ theme: context.theme, element });
  const layer = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const fontScale = useShrinkToFit({ layer, content, textBox: element.textBox, body: element.text, frame: element.frame });
  useTextHeightReport({ content, element, context, inset });
  const textBox = element.textBox;
  const frame = element.frame;
  const counterFlip = textCounterFlipValue(frame);
  const style: CSSProperties = {
    position: "absolute",
    left: roundNumber(inset.left * frame.width),
    top: roundNumber(inset.top * frame.height),
    right: roundNumber(inset.right * frame.width),
    bottom: roundNumber(inset.bottom * frame.height),
    display: "flex",
    flexDirection: "column",
    justifyContent: verticalJustification(textBox.verticalAlignment),
    boxSizing: "border-box",
    ...textBoxPaddingDeclarations(textBox),
    whiteSpace: textBox.wrap ? "pre-wrap" : "pre",
    overflowWrap: "break-word",
    ...(counterFlip === undefined ? {} : { transform: counterFlip }),
  };
  return (
    <div ref={layer} style={style} {...{ [TEXT_LAYER_ATTRIBUTE]: "" }}>
      <div ref={content} style={{ flex: "none" }} {...{ [TEXT_CONTENT_ATTRIBUTE]: "" }}>
        <TextContent target={target} body={element.text} styleContext={styleContext} context={context} fontScale={fontScale} />
      </div>
    </div>
  );
}

/** The paragraphs of one body, or the inline editor when this body is the one being edited. */
function TextContent(properties: Readonly<{ target: TextTarget; body: TextBody; styleContext: TextStyleContext; context: SlideRenderContext; fontScale: number }>): ReactElement {
  const { context } = properties;
  const slot = context.editableText;
  if (slot !== null && sameTextTarget(slot.target, properties.target)) {
    return slot.render({ body: properties.body, styleContext: properties.styleContext, slideNumber: context.slideNumber, slideNumberOf: context.slideNumberOf });
  }
  return (
    <TextParagraphs
      body={properties.body}
      styleContext={properties.styleContext}
      slideNumber={context.slideNumber}
      slideNumberOf={context.slideNumberOf}
      fontScale={properties.fontScale}
      renderGeneration={0}
    />
  );
}

/** Whether two text targets name the same body. */
export function sameTextTarget(first: TextTarget, second: TextTarget): boolean {
  switch (first.kind) {
    case "element":
      return second.kind === first.kind && second.slideId === first.slideId && second.elementId === first.elementId;
    case "tableCell":
      return second.kind === first.kind && second.slideId === first.slideId && second.elementId === first.elementId && second.cell.rowId === first.cell.rowId && second.cell.columnId === first.cell.columnId;
    case "speakerNotes":
      return second.kind === first.kind && second.slideId === first.slideId;
    default:
      return assertNever(first);
  }
}

/** Shrink on overflow (see the header); returns the factor the text is drawn at. */
function useShrinkToFit(options: Readonly<{ layer: RefObject<HTMLDivElement | null>; content: RefObject<HTMLDivElement | null>; textBox: TextBoxStyle; body: TextBody; frame: Frame }>): number {
  const [fontScale, setFontScale] = useState(1);
  const shrinks = options.textBox.autofit === "shrinkText";
  // A new body or box starts again from full size; the effect below shrinks it before paint.
  useLayoutEffect(() => {
    setFontScale(1);
  }, [options.body, options.frame.width, options.frame.height, shrinks]);
  useLayoutEffect(() => {
    if (!shrinks) return;
    const layer = options.layer.current;
    const content = options.content.current;
    if (layer === null || content === null) return;
    const available = layer.clientHeight - options.textBox.paddingTop - options.textBox.paddingBottom;
    const needed = content.offsetHeight;
    if (needed <= available + 0.5 || fontScale <= SHRINK_MINIMUM_SCALE) return;
    const estimate = Math.floor(((fontScale * available) / needed) / SHRINK_STEP) * SHRINK_STEP;
    setFontScale(Math.max(SHRINK_MINIMUM_SCALE, Math.min(fontScale - SHRINK_STEP, estimate)));
  });
  return shrinks ? fontScale : 1;
}

/** A text box that grows with its text reports the height it needs (SPEC.md "Measured layout"). */
function useTextHeightReport(options: Readonly<{ content: RefObject<HTMLDivElement | null>; element: ShapeElement; context: SlideRenderContext; inset: TextInset }>): void {
  const report = options.context.measurement;
  const textBox = options.element.textBox;
  useLayoutEffect(() => {
    if (report === null || textBox.autofit !== "resizeShape") return;
    const content = options.content.current;
    if (content === null) return;
    const textHeight = content.offsetHeight + textBox.paddingTop + textBox.paddingBottom;
    const insetFraction = Math.max(0.05, 1 - options.inset.top - options.inset.bottom);
    report({ elementId: options.element.id, measurement: { kind: "text", contentHeight: roundNumber(textHeight / insetFraction) } });
  });
}

function ImageView(properties: Readonly<{ element: ImageElement; context: SlideRenderContext }>): ReactElement {
  const { element, context } = properties;
  const frame = element.frame;
  const box = element.box;
  const theme = context.theme;
  const fill = fillRendering({ fill: box.fill, theme, assetAddress: context.assetAddress });
  const address = context.assetAddress(element.assetId);
  const style: CSSProperties = {
    ...leafFrameDeclarations(frame),
    ...(box.opacity < 1 ? { opacity: box.opacity } : {}),
    ...fill.background,
    ...borderDeclarations(box.border, theme),
    borderRadius: cornerRadiusValue(box.cornerRadius),
    ...(box.shadow === null ? {} : { boxShadow: boxShadowValue(box.shadow, theme) }),
    overflow: "hidden",
  };
  return (
    <div style={style} {...elementAttributes(element)}>
      {fill.imageLayer === null ? null : <div style={fill.imageLayer} />}
      {address === null ? (
        <div style={{ position: "absolute", inset: 0, ...PLACEHOLDER_HATCHING }} title="This image is still loading or is not available here." />
      ) : (
        <div role="img" aria-label={element.description} style={croppedImageDeclarations({ crop: element.crop, address })} />
      )}
      <UnsupportedValues keys={element.unsupportedKeys} />
    </div>
  );
}

function LineView(properties: Readonly<{ element: LineElement; context: SlideRenderContext }>): ReactElement {
  const { element, context } = properties;
  const frame = element.frame;
  const stroke = element.stroke;
  const colour = colourValue(stroke.colour, context.theme);
  const margin = Math.max(12, stroke.width * 4);
  const left = frame.x - margin;
  const top = frame.y - margin;
  const width = frame.width + margin * 2;
  const height = frame.height + margin * 2;
  const markerSize = Math.max(3, stroke.width * 3);
  const startMarker = arrowMarker({ id: `${element.id}-start`, head: element.startArrow, colour, size: markerSize, atStart: true });
  const endMarker = arrowMarker({ id: `${element.id}-end`, head: element.endArrow, colour, size: markerSize, atStart: false });
  const path = linePath(element);
  return (
    <div style={{ ...leafFrameDeclarations(frame), overflow: "visible", ...(element.opacity < 1 ? { opacity: element.opacity } : {}) }} {...elementAttributes(element)}>
      <svg
        width={roundNumber(width)}
        height={roundNumber(height)}
        viewBox={`${roundNumber(left)} ${roundNumber(top)} ${roundNumber(width)} ${roundNumber(height)}`}
        style={{ position: "absolute", left: -margin, top: -margin, overflow: "visible", pointerEvents: "none" }}
        aria-hidden="true"
      >
        {startMarker === null && endMarker === null ? null : (
          <defs>
            {startMarker}
            {endMarker}
          </defs>
        )}
        <path d={path} fill="none" stroke="transparent" strokeWidth={Math.max(12, stroke.width + 8)} style={{ pointerEvents: "stroke" }} />
        <path
          d={path}
          fill="none"
          stroke={colour}
          strokeWidth={roundNumber(stroke.width)}
          strokeDasharray={strokeDashArray(stroke.dash, stroke.width)}
          strokeLinecap="round"
          strokeLinejoin="round"
          {...(startMarker === null ? {} : { markerStart: `url(#${element.id}-start)` })}
          {...(endMarker === null ? {} : { markerEnd: `url(#${element.id}-end)` })}
        />
      </svg>
      <UnsupportedValues keys={element.unsupportedKeys} />
    </div>
  );
}

/**
 * The image as a background sized and positioned so the crop's visible part fills the box. A
 * background rather than an `<img>`: the server renderer would hoist an image preload link in front
 * of the slide root, and the sandbox markup must be ONE root element.
 */
export function croppedImageDeclarations(options: Readonly<{ crop: ImageElement["crop"]; address: string }>): CSSProperties {
  const crop = options.crop;
  const visibleWidth = Math.max(0.01, 1 - crop.left - crop.right);
  const visibleHeight = Math.max(0.01, 1 - crop.top - crop.bottom);
  const positionX = crop.left + crop.right === 0 ? 0 : crop.left / (crop.left + crop.right);
  const positionY = crop.top + crop.bottom === 0 ? 0 : crop.top / (crop.top + crop.bottom);
  return {
    position: "absolute",
    inset: 0,
    backgroundImage: `url("${options.address}")`,
    backgroundSize: `${roundNumber(100 / visibleWidth)}% ${roundNumber(100 / visibleHeight)}%`,
    backgroundPosition: `${roundNumber(positionX * 100)}% ${roundNumber(positionY * 100)}%`,
    backgroundRepeat: "no-repeat",
    pointerEvents: "none",
  };
}

/** A line's path in slide coordinates, by routing (milestone 1 edits straight lines, renders all three). */
export function linePath(element: LineElement): string {
  const start = element.start;
  const end = element.end;
  const point = (x: number, y: number): string => `${roundNumber(x)} ${roundNumber(y)}`;
  switch (element.routing) {
    case "straight":
      return `M ${point(start.x, start.y)} L ${point(end.x, end.y)}`;
    case "elbow": {
      const middleX = (start.x + end.x) / 2;
      return `M ${point(start.x, start.y)} L ${point(middleX, start.y)} L ${point(middleX, end.y)} L ${point(end.x, end.y)}`;
    }
    case "curved": {
      const middleX = (start.x + end.x) / 2;
      return `M ${point(start.x, start.y)} C ${point(middleX, start.y)} ${point(middleX, end.y)} ${point(end.x, end.y)}`;
    }
    default:
      return assertNever(element.routing);
  }
}

function arrowMarker(options: Readonly<{ id: string; head: ArrowHead; colour: string; size: number; atStart: boolean }>): ReactElement | null {
  const shape = arrowHeadShape({ head: options.head, colour: options.colour });
  if (shape === null) return null;
  return (
    <marker id={options.id} viewBox="0 0 10 10" refX="5" refY="5" markerWidth={roundNumber(options.size)} markerHeight={roundNumber(options.size)} orient={options.atStart ? "auto-start-reverse" : "auto"} markerUnits="userSpaceOnUse">
      {shape}
    </marker>
  );
}

function arrowHeadShape(options: Readonly<{ head: ArrowHead; colour: string }>): ReactElement | null {
  switch (options.head) {
    case "none":
      return null;
    case "triangle":
      return <path d="M 0 0 L 10 5 L 0 10 Z" fill={options.colour} />;
    case "openArrow":
      return <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke={options.colour} strokeWidth="1.5" />;
    case "stealth":
      return <path d="M 0 0 L 10 5 L 0 10 L 3 5 Z" fill={options.colour} />;
    case "diamond":
      return <path d="M 0 5 L 5 0 L 10 5 L 5 10 Z" fill={options.colour} />;
    case "oval":
      return <circle cx="5" cy="5" r="4.5" fill={options.colour} />;
    case "bar":
      return <path d="M 4 0 L 6 0 L 6 10 L 4 10 Z" fill={options.colour} />;
    default:
      return assertNever(options.head);
  }
}

function TableView(properties: Readonly<{ element: TableElement; context: SlideRenderContext }>): ReactElement {
  const { element, context } = properties;
  const rowElements = useRef<(HTMLTableRowElement | null)[]>([]);
  useTableRowReport({ element, context, rowElements });
  const styleContext = textStyleContextOf({ theme: context.theme, element });
  const columnCount = element.columns.length;
  // The table is as wide as its columns, never its frame: a fixed-layout table wider than its
  // columns hands the excess to every column (the last cell visibly stretched on the reverse SxS,
  // complex slide 30), and a column added in an HTML editor then widens the table instead of
  // squeezing its neighbours.
  const gridWidth = element.columns.reduce((total, column) => total + column.width, 0);
  return (
    <div style={{ ...leafFrameDeclarations(element.frame), height: "auto", minHeight: roundNumber(element.frame.height), ...(element.opacity < 1 ? { opacity: element.opacity } : {}) }} {...elementAttributes(element)}>
      <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: roundNumber(gridWidth), borderSpacing: 0 }}>
        <colgroup>
          {element.columns.map((column) => (
            <col key={column.id} style={{ width: roundNumber(column.width) }} />
          ))}
        </colgroup>
        <tbody>
          {element.rows.map((row, rowIndex) => (
            <tr
              key={row.id}
              ref={(node) => {
                rowElements.current[rowIndex] = node;
              }}
              style={{ height: roundNumber(row.minimumHeight) }}
              {...{ [TABLE_ROW_ATTRIBUTE]: row.id }}
            >
              {element.columns.map((column, columnIndex) => {
                const cell = element.cells[rowIndex * columnCount + columnIndex];
                return cell === undefined ? <td key={column.id} /> : <TableCellView key={column.id} element={element} cell={cell} context={context} styleContext={styleContext} rowIndex={rowIndex} columnIndex={columnIndex} />;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <UnsupportedValues keys={element.unsupportedKeys} />
    </div>
  );
}

function TableCellView(
  properties: Readonly<{ element: TableElement; cell: TableCell; context: SlideRenderContext; styleContext: TextStyleContext; rowIndex: number; columnIndex: number }>,
): ReactElement {
  const { cell, context } = properties;
  const theme = context.theme;
  const fill = fillRendering({ fill: cell.fill, theme, assetAddress: context.assetAddress });
  const borders = cell.borders;
  // The cell IS the text layer: its margins are the cell's own padding and its paragraphs sit
  // directly inside it, so an HTML editor sees a plain cell, not a positioned box inside one.
  const style: CSSProperties = {
    ...(fill.imageLayer === null ? {} : { position: "relative" }),
    ...textBoxPaddingDeclarations(cell.textBox),
    whiteSpace: cell.textBox.wrap ? "pre-wrap" : "pre",
    overflowWrap: "break-word",
    ...fill.background,
    ...cellSeamCover({ cell, theme, rowIndex: properties.rowIndex, columnIndex: properties.columnIndex, element: properties.element }),
    borderTop: borders.top === null ? "0 none" : borderDeclarations({ kind: "uniform", stroke: borders.top }, theme).borderTop,
    borderRight: borders.right === null ? "0 none" : borderDeclarations({ kind: "uniform", stroke: borders.right }, theme).borderRight,
    borderBottom: borders.bottom === null ? "0 none" : borderDeclarations({ kind: "uniform", stroke: borders.bottom }, theme).borderBottom,
    borderLeft: borders.left === null ? "0 none" : borderDeclarations({ kind: "uniform", stroke: borders.left }, theme).borderLeft,
    // The three vertical alignments are also the stylesheet's names for them.
    verticalAlign: cell.textBox.verticalAlignment,
  };
  const target: TextTarget = { kind: "tableCell", slideId: context.slideId, elementId: properties.element.id, cell: { rowId: cell.rowId, columnId: cell.columnId } };
  return (
    <td style={style} rowSpan={cell.rowSpan} colSpan={cell.columnSpan} {...{ [TABLE_CELL_COLUMN_ATTRIBUTE]: cell.columnId, [TEXT_LAYER_ATTRIBUTE]: "" }}>
      {fill.imageLayer === null ? null : <div style={fill.imageLayer} />}
      <TextContent target={target} body={cell.text} styleContext={properties.styleContext} context={context} fontScale={1} />
    </td>
  );
}

/**
 * Chrome anti-aliases every cell's fill on its own, so where two fills meet on a fractional device
 * pixel the page shows through as a hairline: light "column rules" across a dark header that Google
 * never draws (reverse SxS, complex slide 30). A half-pixel shadow of the cell's own solid colour
 * reaches under its right and lower neighbours and closes the seam; it is painted with the
 * backgrounds, so collapsed borders and text still draw over it, and it never crosses the table's
 * outer edge. Translucent fills are left alone: the overlap would double their alpha.
 */
function cellSeamCover(options: Readonly<{ element: TableElement; cell: TableCell; theme: ThemeSnapshot; rowIndex: number; columnIndex: number }>): CSSProperties {
  const fill = options.cell.fill;
  if (fill.kind !== "solid" || fill.colour.alpha < 1) return {};
  const colour = colourValue(fill.colour, options.theme);
  const shadows: string[] = [];
  if (options.columnIndex + options.cell.columnSpan < options.element.columns.length) shadows.push(`${SEAM_COVER_PX}px 0 0 ${colour}`);
  if (options.rowIndex + options.cell.rowSpan < options.element.rows.length) shadows.push(`0 ${SEAM_COVER_PX}px 0 ${colour}`);
  return shadows.length === 0 ? {} : { boxShadow: shadows.join(", ") };
}

const SEAM_COVER_PX = 0.5;

/** Reports the visible row heights after layout (rows grow with their text). */
function useTableRowReport(options: Readonly<{ element: TableElement; context: SlideRenderContext; rowElements: RefObject<(HTMLTableRowElement | null)[]> }>): void {
  const report = options.context.measurement;
  useLayoutEffect(() => {
    if (report === null) return;
    const rows = options.element.rows.map((row, index) => ({ rowId: row.id, height: roundNumber(options.rowElements.current[index]?.offsetHeight ?? row.minimumHeight) }));
    report({ elementId: options.element.id, measurement: { kind: "table", rowHeights: rows } });
  });
}

function GroupView(properties: Readonly<{ element: GroupElement; context: SlideRenderContext }>): ReactElement {
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }} {...elementAttributes(properties.element)}>
      {properties.element.children.map((child) => (
        <div key={child.id} style={{ pointerEvents: "auto" }}>
          <ElementView element={child} context={properties.context} />
        </div>
      ))}
    </div>
  );
}

function UnsupportedView(properties: Readonly<{ element: UnsupportedElement }>): ReactElement {
  const element = properties.element;
  return (
    <div style={{ ...leafFrameDeclarations(element.frame), ...PLACEHOLDER_HATCHING }} title={NEWER_VERSION_EXPLANATION} {...elementAttributes(element)} {...{ [UNSUPPORTED_ATTRIBUTE]: element.storedKind }} />
  );
}

/** The hatched overlay over an element holding values this client does not understand. */
function UnsupportedValues(properties: Readonly<{ keys: readonly string[] }>): ReactElement | null {
  if (properties.keys.length === 0) return null;
  return <div style={{ position: "absolute", inset: 0, ...PLACEHOLDER_HATCHING, pointerEvents: "none" }} title={`${NEWER_VERSION_EXPLANATION} (${properties.keys.join(", ")})`} {...{ [UNSUPPORTED_ATTRIBUTE]: properties.keys.join(" ") }} />;
}

function textBoxPaddingDeclarations(textBox: TextBoxStyle): CSSProperties {
  return {
    paddingTop: roundNumber(textBox.paddingTop),
    paddingRight: roundNumber(textBox.paddingRight),
    paddingBottom: roundNumber(textBox.paddingBottom),
    paddingLeft: roundNumber(textBox.paddingLeft),
  };
}
