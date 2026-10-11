/**
 * emit-text.ts — text boxes and bulleted lists.
 *
 * The backbone of the converter, and the only part with a geometric subtlety
 * that is not simply "copy the measured box across":
 *
 * `ShapeProperties` has NO text-inset field. A Slides shape insets its text by
 * 9 CSS px on all four edges (measured against the live API — see
 * `calibration/measure-text-inset.ts`, and note that the documented PowerPoint
 * 0.1in/0.05in defaults are both wrong for Slides) and there is no request that
 * changes it, so a text box placed on the HTML box puts its first glyph 9 px
 * right and 9 px below where Chrome put it. The fix is to place the BOX outside
 * the HTML box by exactly the inset, so the TEXT lands on it. See
 * `geometry.ts`'s `outsetForTextInset` and `DEFAULT_TEXT_INSET_EMU`.
 *
 * That compensation conflicts with a fill: a fill has to sit on the HTML box
 * while the text sits on the outset box. When a text element carries its own
 * decoration (`extract-dom.ts` shares fill/border fields between `rect` and
 * `text`), the two are emitted as two objects — a background shape on the
 * measured box and a text box on the compensated one — rather than averaging
 * the two and getting both slightly wrong.
 */
import type {
  BoundsPx,
  ListElement,
  PaddingPx,
  SizePx,
  TextElement,
  TextRun,
  TypeStyle,
} from "./extraction.js";
import { outsetForTextInset, placeBox } from "./geometry.js";
import type { PageScale } from "./geometry.js";
import type { BulletGlyphPreset, SlidesApiRequest } from "./slides-api.js";
import type { ElementEmission, EmitContext } from "./emit-context.js";
import {
  contentAlignmentFor,
  featureSite,
  paragraphStyleFor,
  textRangeLength,
  textStyleFor,
} from "./emit-context.js";
import {
  decorationPaintsSomething,
  placeElement,
  reportBoxDecoration,
  shapePropertiesFor,
  updateShapePropertiesRequest,
} from "./emit-shape.js";
import type { UnsupportedFeature } from "./unsupported-feature.js";

export function emitText(
  options: Readonly<{ element: TextElement; context: EmitContext; viewportPx: SizePx }>,
): ElementEmission {
  const { element, context, viewportPx } = options;
  const composed = composeRuns({ runs: element.runs, fallbackText: element.text });
  const decorated = decorationPaintsSomething(element.decoration);

  const decorationReports = reportBoxDecoration({ element, viewportPx });
  if (composed.text.length === 0) {
    // Nothing to say: emit the background if there is one, and report the rest.
    return {
      requests: decorated ? emitBackgroundShape({ element, context }) : [],
      unsupported: decorationReports,
    };
  }

  const objectId = context.ids.next("text");
  const textBounds = textBoxBounds({
    bounds: element.bounds,
    paddingPx: element.paddingPx,
    context,
  });
  const requests: SlidesApiRequest[] = [];
  if (decorated) requests.push(...emitBackgroundShape({ element, context }));

  requests.push({
    createShape: {
      objectId,
      shapeType: "TEXT_BOX",
      elementProperties: placeBox({
        bounds: textBounds,
        pageObjectId: context.pageObjectId,
        scale: context.scale,
      }),
    },
  });
  const shape = updateShapePropertiesRequest({
    objectId,
    built: shapePropertiesFor({
      decoration: EMPTY_DECORATION,
      suppressOutline: true,
      contentAlignment: contentAlignmentFor(element.verticallyCentered),
      includeAutofit: true,
    }),
  });
  if (shape !== null) requests.push(shape);
  requests.push({ insertText: { objectId, text: composed.text, insertionIndex: 0 } });
  requests.push(...styleRequestsFor({ objectId, composed, baseStyle: element.style, scale: context.scale }));

  return {
    requests,
    unsupported: [
      ...decorationReports,
      ...reportTextLosses({
        scale: context.scale,
        bounds: element.bounds,
        viewportPx,
        elementType: "text",
        domIndex: element.domIndex,
        // The base style first: it is what an UNSTYLED run renders in, and for
        // a text element with no runs at all it is the only style there is.
        styles: [element.style, ...composed.styles],
      }),
    ],
  };
}

/**
 * A `<ul>`/`<ol>` becomes one text box with a native bullet preset rather than
 * one text box per row: Slides owns the marker glyph, the hanging indent and
 * the per-level inset, and reproducing those by hand is how a list ends up
 * looking almost right.
 *
 * Nesting is carried by leading tabs, which `createParagraphBullets` counts and
 * then strips. Because stripping them shifts every later index, that request is
 * emitted LAST, after all the text and paragraph styling.
 */
export function emitList(
  options: Readonly<{ element: ListElement; context: EmitContext; viewportPx: SizePx }>,
): ElementEmission {
  const { element, context, viewportPx } = options;
  if (element.items.length === 0) return { requests: [], unsupported: [] };

  const requests: SlidesApiRequest[] = [];
  const unsupported: UnsupportedFeature[] = [];

  // A container that paints nothing (a bare <ul> with no card behind it) must
  // not become an invisible selectable rectangle over the list.
  if (element.container !== null && decorationPaintsSomething(element.container)) {
    const containerId = context.ids.next("listbg");
    const shape = updateShapePropertiesRequest({
      objectId: containerId,
      built: shapePropertiesFor({
        decoration: element.container,
        suppressOutline: false,
        contentAlignment: null,
        includeAutofit: false,
      }),
    });
    requests.push({
      createShape: {
        objectId: containerId,
        shapeType: "RECTANGLE",
        elementProperties: placeBox({
          bounds: element.bounds,
          pageObjectId: context.pageObjectId,
          scale: context.scale,
        }),
      },
    });
    if (shape !== null) requests.push(shape);
    unsupported.push(
      ...reportBoxDecoration({
        element: {
          kind: "list",
          bounds: element.bounds,
          domIndex: element.domIndex,
          rotateDeg: element.rotateDeg,
          naturalSizePx: element.naturalSizePx,
          decoration: element.container,
        },
        viewportPx,
      }),
    );
  }

  /*
   * THE LIST'S OWN BOX IS THE INDENT. The text box is already placed where the `<ol>` sits, so
   * the half-inch Slides adds for a bullet is indent on top of indent. Zero puts the marker at
   * the box's left edge, which is where the browser draws it for a list whose padding the page
   * has reset -- the common case, and the one every candidate uses.
   */
  const paragraphRequests: SlidesApiRequest[] = [];
  const objectId = context.ids.next("list");
  const textBounds = textBoxBounds({
    bounds: element.bounds,
    paddingPx: element.containerPaddingPx,
    context,
  });
  requests.push({
    createShape: {
      objectId,
      shapeType: "TEXT_BOX",
      elementProperties: placeBox({
        bounds: textBounds,
        pageObjectId: context.pageObjectId,
        scale: context.scale,
      }),
    },
  });
  const listShape = updateShapePropertiesRequest({
    objectId,
    built: shapePropertiesFor({
      decoration: EMPTY_DECORATION,
      suppressOutline: true,
      contentAlignment: "TOP",
      includeAutofit: true,
    }),
  });
  if (listShape !== null) requests.push(listShape);

  // One paragraph per item, nesting level as leading tabs.
  const paragraphs = element.items.map((item) => `${"\t".repeat(item.level)}${item.text}`);
  requests.push({ insertText: { objectId, text: paragraphs.join("\n"), insertionIndex: 0 } });

  let cursor = 0;
  const styles: TypeStyle[] = [];
  for (let index = 0; index < element.items.length; index++) {
    // SAFETY: index is bounded by element.items.length.
    const item = element.items[index]!;
    const paragraph = paragraphs[index]!;
    const start = cursor;
    const end = start + textRangeLength(paragraph);
    cursor = end + 1; // the "\n" between paragraphs
    styles.push(item.style);
    if (end <= start) continue;

    const text = textStyleFor(item.style, context.scale);
    requests.push({
      updateTextStyle: {
        objectId,
        textRange: { type: "FIXED_RANGE", startIndex: start, endIndex: end },
        style: text.style,
        fields: text.fields,
      },
    });
    const paragraphStyle = paragraphStyleFor(item.style, LIST_INDENT);
    // HELD BACK UNTIL AFTER THE BULLETS. `createParagraphBullets` REWRITES a paragraph's indents
    // to Slides' own bullet defaults -- half an inch of indentStart -- so a paragraph style sent
    // before it is simply overwritten. That is why the numbered list sat ~38px right of where
    // Chrome drew it however the indent was set: the request was being discarded, not ignored.
    paragraphRequests.push({
      updateParagraphStyle: {
        objectId,
        textRange: { type: "FIXED_RANGE", startIndex: start, endIndex: end },
        style: paragraphStyle.style,
        fields: paragraphStyle.fields,
      },
    });
  }

  const preset = bulletPresetFor(element.ordered);
  requests.push({
    createParagraphBullets: { objectId, textRange: { type: "ALL" }, bulletPreset: preset },
  });
  requests.push(...paragraphRequests);

  const site = featureSite({
    bounds: element.bounds,
    viewportPx,
    elementType: "list",
    domIndex: element.domIndex,
  });
  const customMarker = customMarkerOf(element);
  if (customMarker !== null) {
    unsupported.push({
      ...site,
      kind: "list-marker-approximated",
      fallback: "preset-approximation",
      requestedMarker: customMarker,
      preset,
    });
  }
  unsupported.push(
    ...reportTextLosses({
        scale: context.scale,
      bounds: element.bounds,
      viewportPx,
      elementType: "list",
      domIndex: element.domIndex,
      styles,
    }),
  );
  return { requests, unsupported };
}

/**
 * Losses that come from the text itself rather than its box, deduplicated per
 * element so a 20-run paragraph in one missing font reports once, not 20 times.
 *
 * Exported because the table emitter styles cell text through the same
 * `TypeStyle` values and owes the same reports.
 */
export function reportTextLosses(
  options: Readonly<{
    bounds: BoundsPx;
    viewportPx: SizePx;
    elementType: string;
    domIndex: number | null;
    styles: readonly TypeStyle[];
    scale: PageScale;
  }>,
): readonly UnsupportedFeature[] {
  const { bounds, viewportPx, elementType, domIndex, styles, scale } = options;
  const site = featureSite({ bounds, viewportPx, elementType, domIndex });
  const reports: UnsupportedFeature[] = [];
  const seenFonts = new Set<string>();
  let trackingPx = 0;
  let writingMode: string | null = null;

  for (const style of styles) {
    const resolved = textStyleFor(style, scale);
    if (resolved.fontSubstitutedFrom !== null && !seenFonts.has(resolved.fontSubstitutedFrom)) {
      seenFonts.add(resolved.fontSubstitutedFrom);
      reports.push({
        ...site,
        kind: "font-unavailable",
        fallback: "font-substituted",
        requested: resolved.fontSubstitutedFrom,
        substituted: resolved.style.fontFamily ?? "Arial",
      });
    }
    if (Math.abs(style.letterSpacingPx) > LETTER_SPACING_EPSILON_PX) {
      trackingPx = Math.abs(style.letterSpacingPx) > Math.abs(trackingPx) ? style.letterSpacingPx : trackingPx;
    }
    if (style.writingMode !== null && style.writingMode.startsWith("vertical")) {
      writingMode = style.writingMode;
    }
  }

  if (trackingPx !== 0) {
    reports.push({ ...site, kind: "letter-spacing", fallback: "omitted", trackingPx });
  }
  if (writingMode !== null) {
    reports.push({
      ...site,
      kind: "vertical-writing-mode",
      fallback: "omitted",
      cssValue: writingMode,
    });
  }
  return reports;
}

/**
 * Concatenate the runs and record each one's range, so the text that is
 * inserted and the indices that are styled are built from the same source and
 * cannot disagree. Falls back to the element's flat `text` when the extractor
 * produced no runs.
 */
export function composeRuns(
  options: Readonly<{ runs: readonly TextRun[]; fallbackText: string }>,
): ComposedText {
  const { runs, fallbackText } = options;
  if (runs.length === 0) {
    return { text: fallbackText, spans: [], styles: [] };
  }
  let text = "";
  const spans: StyledSpan[] = [];
  const styles: TypeStyle[] = [];
  for (const run of runs) {
    const start = textRangeLength(text);
    text += run.text;
    const end = textRangeLength(text);
    if (run.style === null || end <= start) continue;
    spans.push({ startIndex: start, endIndex: end, style: run.style });
    styles.push(run.style);
  }
  return { text, spans, styles };
}

export type StyledSpan = Readonly<{
  startIndex: number;
  endIndex: number;
  style: TypeStyle;
}>;

export type ComposedText = Readonly<{
  text: string;
  spans: readonly StyledSpan[];
  /** Every distinct style that contributed, for loss reporting. */
  styles: readonly TypeStyle[];
}>;

/**
 * Style the whole range from the element's base style, then overlay each styled
 * run. Overlaying is cheaper and more faithful than emitting one request per
 * run: an unstyled run inherits the base, which is what the HTML meant.
 *
 * Exported for the table emitter, which styles cell text identically but has to
 * add a `cellLocation` to every request.
 */
export function styleRequestsFor(
  options: Readonly<{
    objectId: string;
    composed: ComposedText;
    baseStyle: TypeStyle;
    /** The document-to-page mapping: a font size is a magnitude ON THE PAGE (geometry.ts). */
    scale: PageScale;
    cellLocation?: Readonly<{ rowIndex: number; columnIndex: number }>;
  }>,
): readonly SlidesApiRequest[] {
  const { objectId, composed, baseStyle, scale } = options;
  const cell = options.cellLocation === undefined ? {} : { cellLocation: options.cellLocation };
  const base = textStyleFor(baseStyle, scale);
  const paragraph = paragraphStyleFor(baseStyle);
  const requests: SlidesApiRequest[] = [
    {
      updateTextStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: base.style,
        fields: base.fields,
        ...cell,
      },
    },
    {
      updateParagraphStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: paragraph.style,
        fields: paragraph.fields,
        ...cell,
      },
    },
  ];
  for (const span of composed.spans) {
    const run = textStyleFor(span.style, scale);
    requests.push({
      updateTextStyle: {
        objectId,
        textRange: { type: "FIXED_RANGE", startIndex: span.startIndex, endIndex: span.endIndex },
        style: run.style,
        fields: run.fields,
        ...cell,
      },
    });
  }
  return requests;
}

/**
 * The box to create so that TEXT lands on the HTML content box: strip the CSS
 * padding (which Chrome applied inside `bounds`) and then add back the Slides
 * insets (which Slides will apply inside the shape).
 */
function textBoxBounds(
  options: Readonly<{ bounds: BoundsPx; paddingPx: PaddingPx; context: EmitContext }>,
): BoundsPx {
  const { bounds, paddingPx, context } = options;
  const contentBox: BoundsPx = {
    x: bounds.x + paddingPx.left,
    y: bounds.y + paddingPx.top,
    w: Math.max(1, bounds.w - paddingPx.left - paddingPx.right),
    h: Math.max(1, bounds.h - paddingPx.top - paddingPx.bottom),
  };
  return outsetForTextInset({
    bounds: contentBox,
    insetEmu: context.textInsetEmu,
    scale: context.scale,
  });
}

function emitBackgroundShape(
  options: Readonly<{ element: TextElement; context: EmitContext }>,
): readonly SlidesApiRequest[] {
  const { element, context } = options;
  const objectId = context.ids.next("textbg");
  const shape = shapePropertiesFor({
    decoration: element.decoration,
    suppressOutline: element.decoration.border !== null && !element.decoration.border.uniform,
    contentAlignment: null,
    includeAutofit: false,
  });
  const update = updateShapePropertiesRequest({ objectId, built: shape });
  return [
    {
      createShape: {
        objectId,
        shapeType: shapeTypeForTextBackground(element),
        elementProperties: placeElement({ element, context }),
      },
    },
    ...(update === null ? [] : [update]),
  ];
}

function shapeTypeForTextBackground(element: TextElement): "RECTANGLE" | "ROUND_RECTANGLE" {
  return element.decoration.cornerRadiiPx.some((radius) => radius > 0)
    ? "ROUND_RECTANGLE"
    : "RECTANGLE";
}

function bulletPresetFor(ordered: boolean): BulletGlyphPreset {
  return ordered ? "NUMBERED_DIGIT_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE";
}

/**
 * The marker the HTML asked for, when it is not something a preset reproduces.
 * A CSS-drawn dot or a `::before` glyph both land here; `disc`/`decimal` and
 * friends do not, because the preset genuinely matches them.
 */
function customMarkerOf(element: ListElement): string | null {
  if (element.pseudoBulletChar !== null) return element.pseudoBulletChar;
  if (element.items.some((item) => item.bulletIsDot)) return "css-drawn dot";
  const listStyle = element.listStyleType.trim().toLowerCase();
  if (listStyle === "" || PRESET_EQUIVALENT_LIST_STYLES.has(listStyle)) return null;
  return listStyle;
}

/** List styles the chosen presets reproduce closely enough to stay silent about. */
const PRESET_EQUIVALENT_LIST_STYLES: ReadonlySet<string> = new Set([
  "disc",
  "circle",
  "square",
  "decimal",
  "lower-alpha",
  "upper-alpha",
  "lower-roman",
  "upper-roman",
  "none",
]);

/** Below this, CSS tracking is a rounding artefact rather than a design choice. */
const LETTER_SPACING_EPSILON_PX = 0.01;

/** A text box's own shape carries no fill, border or radius of its own. */
const EMPTY_DECORATION = {
  fill: null,
  gradient: null,
  border: null,
  cornerRadiiPx: [0, 0, 0, 0] as const,
  shadow: null,
  backgroundImage: null,
  clipPath: null,
} as const;

/** No indent at all: the list's own box already sits where the browser put the list. */
const LIST_INDENT = { startEmu: 0, firstLineEmu: 0 } as const;
