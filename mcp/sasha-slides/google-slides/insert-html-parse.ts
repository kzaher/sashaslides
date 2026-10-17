/**
 * insert-html-parse.ts — the developer page's insert body, re-validated. Pure: no I/O.
 *
 * THE PAGE IS UNTRUSTED. `POST /deck-api/google-slides/insert-html` runs a batchUpdate with the
 * person's OWN Google grant, so a hostile page (or a script that stole nothing but can still post
 * with the session) must not be able to do more than "add new slides holding new objects":
 *
 *  - ONLY THE REQUEST KINDS THE PRODUCT CONVERTER EMITS (converter/slides-api.ts), each a
 *    single-key object, each field checked against an allow-list schema below. Every other key
 *    (`deleteObject`, `replaceAllText`, `duplicateObject`, `createSlide`, an unknown nested field
 *    such as a text `link`) is refused.
 *  - NO OBJECT ID FROM THE PAGE REACHES GOOGLE. Every id a `create*` request declares is rewritten
 *    to a server-chosen one under a per-insert random prefix, consistently in every later request
 *    that names it; naming an id not created earlier IN THE SAME SLIDE is refused, so no request
 *    can touch an object the person already has. Every `elementProperties.pageObjectId` is forced
 *    to the slide the server creates; within one slide they must all name the same placeholder, so
 *    a request aimed at another page is refused rather than silently moved.
 *  - PICTURES: `createImage.url` is the converter's staging placeholder with a valid sidecar (PNG,
 *    JPEG or GIF whose bytes start with that format's signature, at most SLIDES_MAX_IMAGE_BYTES), a
 *    `data:` address within SLIDES_MAX_IMAGE_URL_BYTES, or an https address. A picture's `link` may
 *    only be a Drive file viewer address (what a draw.io diagram links to).
 *  - SIZES ARE CAPPED (INSERT_HTML_LIMITS): slides, requests and staged pictures per slide.
 *
 * The result carries the requests ready to send, the staged pictures' decoded bytes for the
 * executor (insert-html.ts) to upload, and the diagrams, re-pointed at the rewritten ids.
 */
import { isDiagramId, parseDrawioSource } from "../converter/drawio-diagram.ts";
import { SLIDES_MAX_IMAGE_BYTES, SLIDES_MAX_IMAGE_URL_BYTES, STAGED_IMAGE_FIELD, STAGED_IMAGE_URL, type StagedImageMediaType } from "../converter/slide-image.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import { INSERT_HTML_LIMITS, type InsertPosition } from "./insert-html-contract.ts";
import { presentationIdFrom } from "./slides-client.ts";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

/** A picture to put on Drive before its slide's batchUpdate. The name is server-chosen. */
export type StagedImage = Readonly<{ fileName: string; mediaType: StagedImageMediaType; bytes: Uint8Array }>;

export type PlannedRequest =
  | Readonly<{ kind: "ready"; request: JsonObject }>
  /** `createImage` whose `url` is still STAGED_IMAGE_URL: the executor substitutes the staged file's address. */
  | Readonly<{ kind: "stagedImage"; createImage: JsonObject; image: StagedImage }>;

/** A diagram on an inserted slide; `objectId` is the server-chosen id of its picture. */
export type ParsedDiagram = Readonly<{ objectId: string; diagramId: string; xml: string }>;

export type ParsedSlide = Readonly<{ pageObjectId: string; requests: readonly PlannedRequest[]; diagrams: readonly ParsedDiagram[] }>;

export type ParsedInsert = Readonly<{ presentationId: string; position: InsertPosition; slides: readonly ParsedSlide[] }>;

export type InsertParse = Readonly<{ kind: "ok"; insert: ParsedInsert }> | Readonly<{ kind: "invalid"; message: string }>;

/**
 * `idPrefix` is the server's random prefix for every object id of this insert (letters, digits and
 * underscores, starting with a letter, at most 30 characters, so every id stays within Google's 50).
 */
export function parseInsertHtmlBody(options: Readonly<{ body: unknown; idPrefix: string }>): InsertParse {
  if (!/^[A-Za-z][A-Za-z0-9_]{3,29}$/.test(options.idPrefix)) throw new Error(`not an object id prefix: ${options.idPrefix}`);
  try {
    return { kind: "ok", insert: parseBody({ body: options.body, idPrefix: options.idPrefix }) };
  } catch (cause) {
    if (cause instanceof InvalidInsert) return { kind: "invalid", message: cause.message };
    throw cause;
  }
}

/** Thrown inside this file only, and turned into `{ kind: "invalid" }` at its one entry point. */
class InvalidInsert extends Error {}

function invalid(message: string): never {
  throw new InvalidInsert(message);
}

function parseBody(options: Readonly<{ body: unknown; idPrefix: string }>): ParsedInsert {
  const body = plainObject({ value: options.body, path: "the request" });
  onlyKeys({ record: body, allowed: ["presentation", "position", "slides"], path: "the request" });
  const presentationText = body["presentation"];
  if (typeof presentationText !== "string" || presentationText.length > MAXIMUM_ADDRESS_CHARACTERS) invalid("`presentation` must be a presentation id or its address.");
  const presentationId = presentationIdFrom(presentationText);
  if (presentationId === null) invalid("That is not a Google Slides address or presentation id.");
  const position = parsePosition(body["position"]);
  const slides = body["slides"];
  if (!Array.isArray(slides) || slides.length === 0) invalid("`slides` must list at least one slide.");
  if (slides.length > INSERT_HTML_LIMITS.maximumSlides) invalid(`At most ${INSERT_HTML_LIMITS.maximumSlides} slides can be inserted at once.`);
  return {
    presentationId,
    position,
    slides: slides.map((slide: unknown, index) => parseSlide({ value: slide, slideNumber: index + 1, idPrefix: options.idPrefix })),
  };
}

const MAXIMUM_ADDRESS_CHARACTERS = 2048;
/** Far past any real deck; `createSlide` refuses an index past the end anyway. */
const MAXIMUM_INSERTION_INDEX = 100_000;

function parsePosition(value: unknown): InsertPosition {
  const position = plainObject({ value, path: "`position`" });
  const kind = position["kind"];
  if (kind === "end") {
    onlyKeys({ record: position, allowed: ["kind"], path: "`position`" });
    return { kind: "end" };
  }
  if (kind === "index") {
    onlyKeys({ record: position, allowed: ["kind", "index"], path: "`position`" });
    const index = position["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > MAXIMUM_INSERTION_INDEX) invalid("`position.index` must be a slide index from 0.");
    return { kind: "index", index };
  }
  return invalid("`position.kind` must be `end` or `index`.");
}

/** Per slide: the ids it created (page id -> server id, and whether it is a picture). */
type SlideScope = {
  readonly slideNumber: number;
  readonly pageObjectId: string;
  readonly elementPrefix: string;
  readonly created: Map<string, Readonly<{ objectId: string; picture: boolean }>>;
  /** The placeholder page id this slide's requests use; every one must use the same. */
  pagePlaceholder: string | null;
  nextElement: number;
  stagedCount: number;
  /** The `sashaStageImage` of the request being parsed (only on a `createImage`), consumed by its url. */
  sidecar: unknown;
  staged: StagedImage | null;
};

function parseSlide(options: Readonly<{ value: unknown; slideNumber: number; idPrefix: string }>): ParsedSlide {
  const { slideNumber } = options;
  const where = `slide ${slideNumber}`;
  const slide = plainObject({ value: options.value, path: where });
  onlyKeys({ record: slide, allowed: ["requests", "diagrams"], path: where });
  const requests = slide["requests"];
  if (!Array.isArray(requests)) invalid(`${where}: \`requests\` must be a list.`);
  if (requests.length > INSERT_HTML_LIMITS.maximumRequestsPerSlide) invalid(`${where}: at most ${INSERT_HTML_LIMITS.maximumRequestsPerSlide} requests per slide.`);
  const scope: SlideScope = {
    slideNumber,
    pageObjectId: `${options.idPrefix}p${slideNumber}`,
    elementPrefix: `${options.idPrefix}s${slideNumber}e`,
    created: new Map(),
    pagePlaceholder: null,
    nextElement: 1,
    stagedCount: 0,
    sidecar: undefined,
    staged: null,
  };
  const planned = requests.map((request: unknown, index) => parseRequest({ value: request, scope, path: `${where}, request ${index + 1}` }));
  const diagrams = slide["diagrams"];
  if (!Array.isArray(diagrams)) invalid(`${where}: \`diagrams\` must be a list.`);
  if (diagrams.length > INSERT_HTML_LIMITS.maximumStagedImagesPerSlide) invalid(`${where}: at most ${INSERT_HTML_LIMITS.maximumStagedImagesPerSlide} diagrams per slide.`);
  const seen = new Set<string>();
  const parsedDiagrams = diagrams.map((diagram: unknown, index) => {
    const parsed = parseDiagram({ value: diagram, scope, path: `${where}, diagram ${index + 1}` });
    if (seen.has(parsed.objectId)) invalid(`${where}, diagram ${index + 1}: that picture already has a diagram.`);
    seen.add(parsed.objectId);
    return parsed;
  });
  return { pageObjectId: scope.pageObjectId, requests: planned, diagrams: parsedDiagrams };
}

function parseRequest(options: Readonly<{ value: unknown; scope: SlideScope; path: string }>): PlannedRequest {
  const { scope, path } = options;
  const request = plainObject({ value: options.value, path });
  const keys = Object.keys(request);
  const hasSidecar = keys.includes(STAGED_IMAGE_FIELD);
  const kinds = keys.filter((key) => key !== STAGED_IMAGE_FIELD);
  if (kinds.length !== 1) invalid(`${path}: a request has exactly one kind.`);
  // SAFETY: `kinds` has exactly one element, checked on the line above.
  const kind = kinds[0]!;
  if (!isAllowedKind(kind)) invalid(`${path}: \`${kind.slice(0, 60)}\` requests are not allowed here.`);
  if (hasSidecar && kind !== "createImage") invalid(`${path}: only a createImage may carry \`${STAGED_IMAGE_FIELD}\`.`);
  scope.sidecar = hasSidecar ? request[STAGED_IMAGE_FIELD] : undefined;
  scope.staged = null;
  const body = walkObject({ value: request[kind], schema: REQUEST_SCHEMAS[kind], path: `${path} (${kind})`, scope });
  const staged = scope.staged;
  if (scope.sidecar !== undefined) invalid(`${path}: \`${STAGED_IMAGE_FIELD}\` goes only with the staging placeholder address.`);
  return staged === null ? { kind: "ready", request: { [kind]: body } } : { kind: "stagedImage", createImage: body, image: staged };
}

function parseDiagram(options: Readonly<{ value: unknown; scope: SlideScope; path: string }>): ParsedDiagram {
  const { scope, path } = options;
  const diagram = plainObject({ value: options.value, path });
  onlyKeys({ record: diagram, allowed: ["objectId", "diagramId", "xml"], path });
  const objectId = diagram["objectId"];
  const diagramId = diagram["diagramId"];
  const xml = diagram["xml"];
  if (typeof diagramId !== "string" || !isDiagramId(diagramId)) invalid(`${path}: \`diagramId\` must be letters, digits, '-' or '_' (at most 64).`);
  const picture = typeof objectId === "string" ? scope.created.get(objectId) : undefined;
  if (picture === undefined || !picture.picture) invalid(`${path}: \`objectId\` must name a picture created on the same slide.`);
  if (typeof xml !== "string") invalid(`${path}: \`xml\` must be the diagram's draw.io source.`);
  const source = parseDrawioSource(xml);
  if (source.kind === "invalid") invalid(`${path}: ${source.reason}.`);
  return { objectId: picture.objectId, diagramId, xml: source.xml };
}

// --- the schema ------------------------------------------------------------------------------

type Schema =
  | Readonly<{ kind: "string"; maximumLength: number }>
  | Readonly<{ kind: "pattern"; pattern: RegExp; description: string }>
  | Readonly<{ kind: "number" }>
  | Readonly<{ kind: "integer"; minimum: number; maximum: number }>
  | Readonly<{ kind: "boolean" }>
  | Readonly<{ kind: "enumeration"; values: readonly string[] }>
  | Readonly<{ kind: "object"; fields: Readonly<Record<string, Field>> }>
  | Readonly<{ kind: "array"; items: Schema; maximumItems: number }>
  /** An id this request creates: rewritten to a fresh server id. */
  | Readonly<{ kind: "newObjectId"; picture: boolean }>
  /** An id an earlier request of the same slide created: rewritten to that server id. */
  | Readonly<{ kind: "objectReference" }>
  /** `elementProperties.pageObjectId`: whatever the page sent, the server's slide. */
  | Readonly<{ kind: "pageObjectId" }>
  /** `createImage.url` (with the request's sidecar). */
  | Readonly<{ kind: "imageAddress" }>
  /** `imageProperties.link.url`: a Drive file viewer address only. */
  | Readonly<{ kind: "driveFileLink" }>;

type Field = Readonly<{ schema: Schema; required: boolean }>;

const required = (schema: Schema): Field => ({ schema, required: true });
const optional = (schema: Schema): Field => ({ schema, required: false });
const objectOf = (fields: Readonly<Record<string, Field>>): Schema => ({ kind: "object", fields });
const enumeration = (...values: readonly string[]): Schema => ({ kind: "enumeration", values });

const NUMBER: Schema = { kind: "number" };
const BOOLEAN: Schema = { kind: "boolean" };
const INDEX: Schema = { kind: "integer", minimum: 0, maximum: 10_000_000 };
const SPAN: Schema = { kind: "integer", minimum: 1, maximum: 1_000 };
const TABLE_SIZE: Schema = { kind: "integer", minimum: 1, maximum: 200 };
const FIELD_MASK: Schema = { kind: "pattern", pattern: /^[A-Za-z0-9_.,*()]{1,1000}$/, description: "a field mask" };
const REFERENCE: Schema = { kind: "objectReference" };
const UNIT = enumeration("EMU", "PT");
const PROPERTY_STATE = enumeration("RENDERED", "NOT_RENDERED", "INHERIT");
const DASH_STYLE = enumeration("SOLID", "DOT", "DASH", "DASH_DOT", "LONG_DASH", "LONG_DASH_DOT");
const CONTENT_ALIGNMENT = enumeration("TOP", "MIDDLE", "BOTTOM");
const DIMENSION = objectOf({ magnitude: required(NUMBER), unit: required(UNIT) });
const ELEMENT_PROPERTIES = objectOf({
  pageObjectId: required({ kind: "pageObjectId" }),
  size: optional(objectOf({ width: required(DIMENSION), height: required(DIMENSION) })),
  transform: optional(
    objectOf({
      scaleX: required(NUMBER),
      scaleY: required(NUMBER),
      shearX: optional(NUMBER),
      shearY: optional(NUMBER),
      translateX: required(NUMBER),
      translateY: required(NUMBER),
      unit: required(UNIT),
    }),
  ),
});
const OPAQUE_COLOR = objectOf({ rgbColor: required(objectOf({ red: optional(NUMBER), green: optional(NUMBER), blue: optional(NUMBER) })) });
const OPTIONAL_COLOR = objectOf({ opaqueColor: optional(OPAQUE_COLOR) });
const SOLID_FILL = objectOf({ color: optional(OPAQUE_COLOR), alpha: optional(NUMBER) });
const OUTLINE = objectOf({
  outlineFill: optional(objectOf({ solidFill: required(SOLID_FILL) })),
  weight: optional(DIMENSION),
  dashStyle: optional(DASH_STYLE),
  propertyState: optional(PROPERTY_STATE),
});
const TEXT_RANGE = objectOf({ type: required(enumeration("ALL", "FROM_START_INDEX", "FIXED_RANGE")), startIndex: optional(INDEX), endIndex: optional(INDEX) });
const CELL_LOCATION = objectOf({ rowIndex: required(INDEX), columnIndex: required(INDEX) });
const TABLE_RANGE = objectOf({ location: required(CELL_LOCATION), rowSpan: required(SPAN), columnSpan: required(SPAN) });
const TEXT_STYLE = objectOf({
  fontFamily: optional({ kind: "string", maximumLength: 200 }),
  fontSize: optional(DIMENSION),
  bold: optional(BOOLEAN),
  italic: optional(BOOLEAN),
  underline: optional(BOOLEAN),
  strikethrough: optional(BOOLEAN),
  foregroundColor: optional(OPTIONAL_COLOR),
  backgroundColor: optional(OPTIONAL_COLOR),
  baselineOffset: optional(enumeration("NONE", "SUPERSCRIPT", "SUBSCRIPT")),
  smallCaps: optional(BOOLEAN),
});
const PARAGRAPH_STYLE = objectOf({
  alignment: optional(enumeration("START", "CENTER", "END", "JUSTIFIED")),
  lineSpacing: optional(NUMBER),
  spaceAbove: optional(DIMENSION),
  spaceBelow: optional(DIMENSION),
  indentStart: optional(DIMENSION),
  indentFirstLine: optional(DIMENSION),
  direction: optional(enumeration("LEFT_TO_RIGHT", "RIGHT_TO_LEFT")),
});
const SHAPE_TYPE = enumeration("TEXT_BOX", "RECTANGLE", "ROUND_RECTANGLE", "ELLIPSE", "TRIANGLE", "ROUND_1_RECTANGLE", "ROUND_2_SAME_RECTANGLE", "ROUND_2_DIAGONAL_RECTANGLE");
const BULLET_PRESET = enumeration("BULLET_DISC_CIRCLE_SQUARE", "BULLET_ARROW_DIAMOND_DISC", "BULLET_CHECKBOX", "NUMBERED_DIGIT_ALPHA_ROMAN", "NUMBERED_DIGIT_NESTED");
const BORDER_POSITION = enumeration("ALL", "BOTTOM", "INNER", "INNER_HORIZONTAL", "INNER_VERTICAL", "LEFT", "OUTER", "RIGHT", "TOP");
/** A whole slide's text in one box is a few thousand characters; this is a sanity ceiling. */
const TEXT = { kind: "string", maximumLength: 200_000 } as const;

type AllowedKind =
  | "createShape"
  | "createLine"
  | "createImage"
  | "createTable"
  | "insertText"
  | "updateShapeProperties"
  | "updateImageProperties"
  | "updateLineProperties"
  | "updateTextStyle"
  | "updateParagraphStyle"
  | "createParagraphBullets"
  | "updateTableRowProperties"
  | "updateTableColumnProperties"
  | "updateTableCellProperties"
  | "updateTableBorderProperties"
  | "mergeTableCells"
  | "updatePageElementAltText";

/** Every allowed kind's body. A `Record` over the union: a kind without a schema does not compile. */
const REQUEST_SCHEMAS: Readonly<Record<AllowedKind, Readonly<{ kind: "object"; fields: Readonly<Record<string, Field>> }>>> = {
  createShape: { kind: "object", fields: { objectId: required({ kind: "newObjectId", picture: false }), shapeType: required(SHAPE_TYPE), elementProperties: required(ELEMENT_PROPERTIES) } },
  createLine: { kind: "object", fields: { objectId: required({ kind: "newObjectId", picture: false }), lineCategory: required(enumeration("STRAIGHT", "BENT", "CURVED")), elementProperties: required(ELEMENT_PROPERTIES) } },
  createImage: { kind: "object", fields: { objectId: required({ kind: "newObjectId", picture: true }), url: required({ kind: "imageAddress" }), elementProperties: required(ELEMENT_PROPERTIES) } },
  createTable: { kind: "object", fields: { objectId: required({ kind: "newObjectId", picture: false }), elementProperties: required(ELEMENT_PROPERTIES), rows: required(TABLE_SIZE), columns: required(TABLE_SIZE) } },
  insertText: { kind: "object", fields: { objectId: required(REFERENCE), text: required(TEXT), insertionIndex: optional(INDEX), cellLocation: optional(CELL_LOCATION) } },
  updateShapeProperties: {
    kind: "object",
    fields: {
      objectId: required(REFERENCE),
      shapeProperties: required(
        objectOf({
          shapeBackgroundFill: optional(objectOf({ solidFill: optional(SOLID_FILL), propertyState: optional(PROPERTY_STATE) })),
          outline: optional(OUTLINE),
          contentAlignment: optional(CONTENT_ALIGNMENT),
          autofit: optional(objectOf({ autofitType: required(enumeration("NONE", "TEXT_AUTOFIT", "SHAPE_AUTOFIT")) })),
        }),
      ),
      fields: required(FIELD_MASK),
    },
  },
  updateImageProperties: {
    kind: "object",
    fields: {
      objectId: required(REFERENCE),
      imageProperties: required(objectOf({ outline: optional(OUTLINE), link: optional(objectOf({ url: required({ kind: "driveFileLink" }) })) })),
      fields: required(FIELD_MASK),
    },
  },
  updateLineProperties: {
    kind: "object",
    fields: {
      objectId: required(REFERENCE),
      lineProperties: required(objectOf({ lineFill: optional(objectOf({ solidFill: required(SOLID_FILL) })), weight: optional(DIMENSION), dashStyle: optional(DASH_STYLE) })),
      fields: required(FIELD_MASK),
    },
  },
  updateTextStyle: { kind: "object", fields: { objectId: required(REFERENCE), textRange: optional(TEXT_RANGE), style: required(TEXT_STYLE), fields: required(FIELD_MASK), cellLocation: optional(CELL_LOCATION) } },
  updateParagraphStyle: { kind: "object", fields: { objectId: required(REFERENCE), textRange: optional(TEXT_RANGE), style: required(PARAGRAPH_STYLE), fields: required(FIELD_MASK), cellLocation: optional(CELL_LOCATION) } },
  createParagraphBullets: { kind: "object", fields: { objectId: required(REFERENCE), textRange: optional(TEXT_RANGE), bulletPreset: optional(BULLET_PRESET), cellLocation: optional(CELL_LOCATION) } },
  updateTableRowProperties: {
    kind: "object",
    fields: { objectId: required(REFERENCE), rowIndices: optional({ kind: "array", items: INDEX, maximumItems: 200 }), tableRowProperties: required(objectOf({ minRowHeight: optional(DIMENSION) })), fields: required(FIELD_MASK) },
  },
  updateTableColumnProperties: {
    kind: "object",
    fields: { objectId: required(REFERENCE), columnIndices: optional({ kind: "array", items: INDEX, maximumItems: 200 }), tableColumnProperties: required(objectOf({ columnWidth: optional(DIMENSION) })), fields: required(FIELD_MASK) },
  },
  updateTableCellProperties: {
    kind: "object",
    fields: {
      objectId: required(REFERENCE),
      tableRange: optional(TABLE_RANGE),
      tableCellProperties: required(objectOf({ tableCellBackgroundFill: optional(objectOf({ solidFill: optional(SOLID_FILL), propertyState: optional(PROPERTY_STATE) })), contentAlignment: optional(CONTENT_ALIGNMENT) })),
      fields: required(FIELD_MASK),
    },
  },
  updateTableBorderProperties: {
    kind: "object",
    fields: {
      objectId: required(REFERENCE),
      tableRange: optional(TABLE_RANGE),
      borderPosition: optional(BORDER_POSITION),
      tableBorderProperties: required(objectOf({ tableBorderFill: optional(objectOf({ solidFill: required(SOLID_FILL) })), weight: optional(DIMENSION), dashStyle: optional(DASH_STYLE) })),
      fields: required(FIELD_MASK),
    },
  },
  mergeTableCells: { kind: "object", fields: { objectId: required(REFERENCE), tableRange: required(TABLE_RANGE) } },
  updatePageElementAltText: { kind: "object", fields: { objectId: required(REFERENCE), title: optional({ kind: "string", maximumLength: 1_000 }), description: optional({ kind: "string", maximumLength: 10_000 }) } },
};

/**
 * A parse-boundary guard: `kind` is untrusted text, so this cannot be an exhaustive switch; the
 * `Record` above is the exhaustive table, and this asks it.
 */
function isAllowedKind(kind: string): kind is AllowedKind {
  return Object.hasOwn(REQUEST_SCHEMAS, kind);
}

function walk(options: Readonly<{ value: unknown; schema: Schema; path: string; scope: SlideScope }>): JsonValue {
  const { value, schema, path, scope } = options;
  switch (schema.kind) {
    case "string":
      if (typeof value !== "string" || value.length > schema.maximumLength) invalid(`${path}: expected text of at most ${schema.maximumLength} characters.`);
      return value;
    case "pattern":
      if (typeof value !== "string" || !schema.pattern.test(value)) invalid(`${path}: expected ${schema.description}.`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAXIMUM_MAGNITUDE) invalid(`${path}: expected a number.`);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value) || value < schema.minimum || value > schema.maximum) invalid(`${path}: expected a whole number from ${schema.minimum} to ${schema.maximum}.`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") invalid(`${path}: expected true or false.`);
      return value;
    case "enumeration":
      if (typeof value !== "string" || !schema.values.includes(value)) invalid(`${path}: expected one of ${schema.values.join(", ")}.`);
      return value;
    case "object":
      return walkObject({ value, schema, path, scope });
    case "array": {
      if (!Array.isArray(value) || value.length > schema.maximumItems) invalid(`${path}: expected a list of at most ${schema.maximumItems}.`);
      return value.map((item: unknown, index) => walk({ value: item, schema: schema.items, path: `${path}[${index}]`, scope }));
    }
    case "newObjectId": {
      if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_PAGE_ID_CHARACTERS) invalid(`${path}: expected an object id.`);
      if (scope.created.has(value)) invalid(`${path}: the object id ${JSON.stringify(value.slice(0, 60))} is created twice.`);
      const objectId = `${scope.elementPrefix}${scope.nextElement}`;
      scope.nextElement += 1;
      scope.created.set(value, { objectId, picture: schema.picture });
      return objectId;
    }
    case "objectReference": {
      const created = typeof value === "string" ? scope.created.get(value) : undefined;
      if (created === undefined) invalid(`${path}: names an object not created earlier on this slide.`);
      return created.objectId;
    }
    case "pageObjectId":
      if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_PAGE_ID_CHARACTERS) invalid(`${path}: expected a page id.`);
      if (scope.pagePlaceholder === null) scope.pagePlaceholder = value;
      if (value !== scope.pagePlaceholder) invalid(`${path}: every request of a slide must name the same page (the server creates it).`);
      return scope.pageObjectId;
    case "imageAddress":
      return imageAddress({ value, path, scope });
    case "driveFileLink":
      if (typeof value !== "string" || !DRIVE_FILE_LINK.test(value)) invalid(`${path}: a picture may only link to a Drive file (https://drive.google.com/file/d/<id>/view).`);
      return value;
    default:
      return assertNever(schema);
  }
}

/** EMU of a 10-inch page is about 9 million; anything past this is not geometry. */
const MAXIMUM_MAGNITUDE = 1e12;
const MAXIMUM_PAGE_ID_CHARACTERS = 200;
const DRIVE_FILE_LINK = /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,200}\/view$/;

function walkObject(options: Readonly<{ value: unknown; schema: Readonly<{ fields: Readonly<Record<string, Field>> }>; path: string; scope: SlideScope }>): JsonObject {
  const { schema, path, scope } = options;
  const record = plainObject({ value: options.value, path });
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(record)) {
    const field = Object.hasOwn(schema.fields, key) ? schema.fields[key] : undefined;
    if (field === undefined) invalid(`${path}: the field \`${key.slice(0, 60)}\` is not allowed.`);
    output[key] = walk({ value: record[key], schema: field.schema, path: `${path}.${key}`, scope });
  }
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.required && !Object.hasOwn(record, key)) invalid(`${path}: \`${key}\` is required.`);
  }
  return output;
}

function imageAddress(options: Readonly<{ value: unknown; path: string; scope: SlideScope }>): string {
  const { value, path, scope } = options;
  if (typeof value !== "string" || value.length > SLIDES_MAX_IMAGE_URL_BYTES) invalid(`${path}: expected a picture address of at most ${SLIDES_MAX_IMAGE_URL_BYTES} bytes.`);
  if (value === STAGED_IMAGE_URL) {
    if (scope.sidecar === undefined) invalid(`${path}: the staging placeholder needs its \`${STAGED_IMAGE_FIELD}\`.`);
    scope.stagedCount += 1;
    if (scope.stagedCount > INSERT_HTML_LIMITS.maximumStagedImagesPerSlide) invalid(`${path}: at most ${INSERT_HTML_LIMITS.maximumStagedImagesPerSlide} staged pictures per slide.`);
    scope.staged = stagedImage({ value: scope.sidecar, path: `${path} ${STAGED_IMAGE_FIELD}`, baseName: `${scope.pageObjectId}-image${scope.stagedCount}` });
    scope.sidecar = undefined;
    return value;
  }
  if (value.startsWith("data:")) {
    const inline = /^data:(image\/png|image\/jpeg|image\/gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    const mediaType = inline?.[1];
    const base64 = inline?.[2];
    if (mediaType === undefined || base64 === undefined || !isStagedMediaType(mediaType)) invalid(`${path}: an inline picture must be a base64 PNG, JPEG or GIF.`);
    if (!hasSignature({ bytes: Buffer.from(base64, "base64"), mediaType })) invalid(`${path}: the inline picture's bytes are not a ${mediaType}.`);
    return value;
  }
  let address: URL;
  try {
    address = new URL(value);
  } catch {
    return invalid(`${path}: not a picture address.`);
  }
  if (address.protocol !== "https:" || address.username !== "" || address.password !== "") invalid(`${path}: a picture address must be https.`);
  return value;
}

function stagedImage(options: Readonly<{ value: unknown; path: string; baseName: string }>): StagedImage {
  const { path } = options;
  const sidecar = plainObject({ value: options.value, path });
  onlyKeys({ record: sidecar, allowed: ["fileName", "mimeType", "base64"], path });
  const fileName = sidecar["fileName"];
  const mediaType = sidecar["mimeType"];
  const base64 = sidecar["base64"];
  // The page's file name is checked for shape and then ignored: the server names the Drive file.
  if (typeof fileName !== "string" || fileName.length > 255) invalid(`${path}: \`fileName\` must be text.`);
  if (typeof mediaType !== "string" || !isStagedMediaType(mediaType)) invalid(`${path}: \`mimeType\` must be image/png, image/jpeg or image/gif.`);
  if (typeof base64 !== "string" || base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) invalid(`${path}: \`base64\` must be base64.`);
  if ((base64.length / 4) * 3 > SLIDES_MAX_IMAGE_BYTES + 2) invalid(`${path}: the picture is larger than ${SLIDES_MAX_IMAGE_BYTES} bytes.`);
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.byteLength > SLIDES_MAX_IMAGE_BYTES) invalid(`${path}: the picture is larger than ${SLIDES_MAX_IMAGE_BYTES} bytes.`);
  if (!hasSignature({ bytes, mediaType })) invalid(`${path}: the bytes are not a ${mediaType}.`);
  return { fileName: `${options.baseName}${EXTENSIONS[mediaType]}`, mediaType, bytes };
}

const EXTENSIONS: Readonly<Record<StagedImageMediaType, string>> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif" };

/** A parse-boundary guard over untrusted text; `EXTENSIONS` is the exhaustive table. */
function isStagedMediaType(text: string): text is StagedImageMediaType {
  return Object.hasOwn(EXTENSIONS, text);
}

/** The format's own signature at the start of the bytes. */
function hasSignature(options: Readonly<{ bytes: Uint8Array; mediaType: StagedImageMediaType }>): boolean {
  const { bytes } = options;
  const startsWith = (signature: readonly number[]): boolean => signature.every((byte, index) => bytes[index] === byte);
  switch (options.mediaType) {
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    default:
      return assertNever(options.mediaType);
  }
}

function plainObject(options: Readonly<{ value: unknown; path: string }>): Readonly<Record<string, unknown>> {
  const { value } = options;
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${options.path}: expected an object.`);
  // A JSON.parse result: a plain object whose own enumerable keys are its fields.
  return value as Readonly<Record<string, unknown>>;
}

function onlyKeys(options: Readonly<{ record: Readonly<Record<string, unknown>>; allowed: readonly string[]; path: string }>): void {
  for (const key of Object.keys(options.record)) {
    if (!options.allowed.includes(key)) invalid(`${options.path}: the field \`${key.slice(0, 60)}\` is not allowed.`);
  }
}
