// DOCUMENT FIXTURES for the state module's tests: complete snapshots built from a few numbers, so a
// test states only what it is about (a rotated shape at 100,100; a text box holding "ab"). Ids go
// through the contracts' parse functions, never a cast.

import {
  DEFAULT_TEXT_BOX_STYLE,
  EMPTY_DISCUSSION,
  LOCAL_COLLABORATION_STATUS,
  EMPTY_TEXT_BODY,
  lineFrame,
  mintId,
  NEW_TEXT_BOX_STYLE,
  parseElementId,
  parsePersonId,
  parseSlideId,
  PLACEHOLDER_ROLES,
  PLAIN_BOX_STYLE,
  THEME_COLOUR_SLOTS,
  boundsOfBoxes,
  identityFrame,
  rotatedBounds,
  type DeckId,
  type DocumentSnapshot,
  type EditorState,
  type ElementId,
  type ElementSnapshot,
  type GroupElement,
  type LayoutId,
  type LayoutSnapshot,
  type LineElement,
  type Person,
  type PlaceholderReference,
  type PlaceholderRole,
  type PlaceholderStyle,
  type ShapeElement,
  type ShapePreset,
  type SlideId,
  type SlideSnapshot,
  type TableElement,
  type TextBody,
  type ThemeSnapshot,
} from "../../contracts/index.ts";
import { isTextBoxPreset } from "../editor/element-factory.ts";
import { initialEditorState } from "../editor/initial-editor-state.ts";

export function elementId(text: string): ElementId {
  const parsed = parseElementId(text);
  if (parsed === null) throw new Error(`Not an element id: ${text}`);
  return parsed;
}

export function slideId(text: string): SlideId {
  const parsed = parseSlideId(text);
  if (parsed === null) throw new Error(`Not a slide id: ${text}`);
  return parsed;
}

export function deckId(text: string): DeckId {
  // Deck ids have no parse function in the contracts; fixtures use object-id-shaped constants only.
  return text as DeckId;
}

export function layoutId(text: string): LayoutId {
  // Layout ids have no parse function in the contracts; minted the way the editor mints them.
  return mintId({ seed: { sessionPrefix: text.padEnd(8, "0").slice(0, 8), counter: 0 }, kind: "layout" }).id;
}

export const ME: Person = { id: personId("person_me"), displayName: "Me", colourIndex: 0, kind: "person" };

export function personId(text: string): Person["id"] {
  const parsed = parsePersonId(text);
  if (parsed === null) throw new Error(`Not a person id: ${text}`);
  return parsed;
}

export function textBody(...paragraphs: readonly string[]): TextBody {
  if (paragraphs.length === 0) return EMPTY_TEXT_BODY;
  return { paragraphs: paragraphs.map((text) => ({ style: {}, runs: text.length === 0 ? [] : [{ kind: "text", text, style: {} }] })) };
}

export function shape(
  options: Readonly<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    preset?: ShapePreset;
    text?: TextBody;
    placeholder?: PlaceholderReference;
    autofit?: "none" | "shrinkText" | "resizeShape";
  }>,
): ShapeElement {
  const id = elementId(options.id);
  const preset = options.preset ?? "rectangle";
  return {
    kind: "shape",
    id,
    name: "",
    description: "",
    frame: { x: options.x, y: options.y, width: options.width, height: options.height, rotation: options.rotation ?? 0, flipHorizontal: false, flipVertical: false },
    groupId: null,
    morphKey: id,
    placeholder: options.placeholder ?? null,
    unsupportedKeys: [],
    preset,
    box: PLAIN_BOX_STYLE,
    textBox: { ...(isTextBoxPreset(preset) ? NEW_TEXT_BOX_STYLE : DEFAULT_TEXT_BOX_STYLE), ...(options.autofit === undefined ? {} : { autofit: options.autofit }) },
    text: options.text ?? EMPTY_TEXT_BODY,
  };
}

export function line(options: Readonly<{ id: string; start: Readonly<{ x: number; y: number }>; end: Readonly<{ x: number; y: number }> }>): LineElement {
  const id = elementId(options.id);
  return {
    kind: "line",
    id,
    name: "",
    description: "",
    frame: lineFrame({ start: options.start, end: options.end }),
    groupId: null,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
    start: options.start,
    end: options.end,
    routing: "straight",
    stroke: { width: 2, colour: { kind: "theme", slot: "dark1", alpha: 1 }, dash: "solid" },
    startArrow: "none",
    endArrow: "none",
    opacity: 1,
  };
}

/** A group whose frame is its children's bounds (rotation 0 unless given, as the model derives it). */
export function group(options: Readonly<{ id: string; children: readonly ElementSnapshot[]; rotation?: number }>): GroupElement {
  const id = elementId(options.id);
  const bounds = boundsOfBoxes(options.children.map((child) => rotatedBounds(child.frame))) ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    kind: "group",
    id,
    name: "",
    description: "",
    frame: { ...identityFrame(bounds), rotation: options.rotation ?? 0 },
    groupId: null,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
    children: options.children.map((child) => ({ ...child, groupId: id })),
  };
}

export function table(options: Readonly<{ id: string; x: number; y: number; columnWidths: readonly number[]; rowHeights: readonly number[] }>): TableElement {
  const id = elementId(options.id);
  const seed = { sessionPrefix: options.id.replace(/[^A-Za-z0-9]/gu, "").padEnd(8, "0").slice(0, 8), counter: 0 };
  let counter = 0;
  const columns = options.columnWidths.map((width) => ({ id: mintId({ seed: { ...seed, counter: counter++ }, kind: "tableColumn" }).id, width }));
  const rows = options.rowHeights.map((minimumHeight) => ({ id: mintId({ seed: { ...seed, counter: counter++ }, kind: "tableRow" }).id, minimumHeight }));
  return {
    kind: "table",
    id,
    name: "",
    description: "",
    frame: identityFrame({ x: options.x, y: options.y, width: sum(options.columnWidths), height: sum(options.rowHeights) }),
    groupId: null,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
    columns,
    rows,
    cells: rows.flatMap((row) =>
      columns.map((column) => ({
        rowId: row.id,
        columnId: column.id,
        rowSpan: 1,
        columnSpan: 1,
        fill: { kind: "none" as const },
        borders: { top: null, right: null, bottom: null, left: null },
        textBox: DEFAULT_TEXT_BOX_STYLE,
        text: EMPTY_TEXT_BODY,
      })),
    ),
    opacity: 1,
  };
}

export function slide(options: Readonly<{ id: string; elements: readonly ElementSnapshot[]; layoutId?: LayoutId }>): SlideSnapshot {
  return {
    id: slideId(options.id),
    layoutId: options.layoutId ?? null,
    background: null,
    skipped: false,
    speakerNotes: EMPTY_TEXT_BODY,
    transition: null,
    elements: options.elements,
  };
}

export function layout(options: Readonly<{ id: LayoutId; elements: readonly ElementSnapshot[] }>): LayoutSnapshot {
  return { id: options.id, name: "Layout", background: null, elements: options.elements };
}

export function testDocument(
  options: Readonly<{ slides: readonly SlideSnapshot[]; layouts?: readonly LayoutSnapshot[]; deckId?: string; revision?: number }>,
): DocumentSnapshot {
  return {
    deckId: deckId(options.deckId ?? "deck_first"),
    schemaVersion: 1,
    revision: options.revision ?? 1,
    title: "Fixture",
    pageSize: { width: 1280, height: 720 },
    theme: TEST_THEME,
    layouts: options.layouts ?? [],
    slides: options.slides,
    assets: [],
    transitionScripts: [],
  };
}

/** The editor's starting state over a document, in a 1360 x 800 canvas (scale 1: 5 client pixels = 5 units). */
export function editorStateFor(document: DocumentSnapshot, overrides: Partial<EditorState> = {}): EditorState {
  const state = initialEditorState({
    me: ME,
    sessionPrefix: "Test0000",
    embedding: { kind: "webApplication" },
    document,
    discussion: EMPTY_DISCUSSION,
    containerSize: { width: 1360, height: 800 },
    collaboration: LOCAL_COLLABORATION_STATUS,
    recentColours: [],
  });
  return { ...state, ...overrides };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

const EMPTY_PLACEHOLDER_STYLE: PlaceholderStyle = { run: {}, paragraph: {}, textBox: {} };

const TEST_THEME: ThemeSnapshot = {
  name: "Fixture",
  // Object.fromEntries widens to a string-keyed record; THEME_COLOUR_SLOTS lists every slot exactly once.
  colours: Object.fromEntries(THEME_COLOUR_SLOTS.map((slot) => [slot, "#1c2333"])) as ThemeSnapshot["colours"],
  headingFontFamily: "Manrope",
  bodyFontFamily: "Manrope",
  background: { kind: "solid", colour: { kind: "literal", hexadecimal: "#ffffff", alpha: 1 } },
  // Object.fromEntries widens to a string-keyed record; PLACEHOLDER_ROLES lists every role exactly once.
  placeholderStyles: Object.fromEntries(PLACEHOLDER_ROLES.map((role: PlaceholderRole) => [role, EMPTY_PLACEHOLDER_STYLE])) as ThemeSnapshot["placeholderStyles"],
  defaultRunStyle: {
    fontFamily: "Manrope",
    fontSize: 32,
    fontWeight: 400,
    fontStyle: "normal",
    underline: false,
    strikethrough: false,
    colour: { kind: "literal", hexadecimal: "#1c2333", alpha: 1 },
    highlight: { kind: "none" },
    link: { kind: "none" },
    baselineOffset: "none",
    letterSpacing: 0,
    textCase: "none",
  },
};
