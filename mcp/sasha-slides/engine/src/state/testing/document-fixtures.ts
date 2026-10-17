// DOCUMENT FIXTURES for the state module's tests: complete snapshots built from a few numbers, so a
// test states only what it is about (a rotated shape at 100,100; a text box holding "ab"). Ids go
// through the contracts' parse functions, never a cast.

import {
  DEFAULT_TEXT_BOX_STYLE,
  EMPTY_DISCUSSION,
  LOCAL_COLLABORATION_STATUS,
  EMPTY_TEXT_BODY,
  mintId,
  NEW_TEXT_BOX_STYLE,
  parseAnimationStepId,
  parseElementId,
  parsePersonId,
  parseSlideId,
  THEME_COLOUR_SLOTS,
  boundsOfBoxes,
  identityFrame,
  rotatedBounds,
  type AnimationEffect,
  type AnimationStep,
  type AnimationStepId,
  type AnimationTrigger,
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
  type ShapeElement,
  type ShapePreset,
  type SlideId,
  type SlideSnapshot,
  type TableElement,
  type TextBody,
  type ThemeSnapshot,
} from "../../contracts/index.ts";
import { isTextBoxPreset } from "../../shared/element-defaults.ts";
import { initialEditorState } from "../editor/initial-editor-state.ts";
import { documentSnapshot, fixtureDeckId, lineElement, plainTheme, requireParsed, shapeElement, slideSnapshot } from "../../contracts/testing/snapshot-builders.ts";

export function elementId(text: string): ElementId {
  return requireParsed(parseElementId, text);
}

export function slideId(text: string): SlideId {
  return requireParsed(parseSlideId, text);
}

export const deckId = fixtureDeckId;

export function layoutId(text: string): LayoutId {
  // Layout ids have no parse function in the contracts; minted the way the editor mints them.
  return mintId({ seed: { sessionPrefix: text.padEnd(8, "0").slice(0, 8), counter: 0 }, kind: "layout" }).id;
}

export const ME: Person = { id: personId("person_me"), displayName: "Me", colourIndex: 0, kind: "person" };

export function personId(text: string): Person["id"] {
  return requireParsed(parsePersonId, text);
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
  const preset = options.preset ?? "rectangle";
  return shapeElement({
    id: elementId(options.id),
    frame: { x: options.x, y: options.y, width: options.width, height: options.height, rotation: options.rotation ?? 0, flipHorizontal: false, flipVertical: false },
    placeholder: options.placeholder ?? null,
    preset,
    textBox: { ...(isTextBoxPreset(preset) ? NEW_TEXT_BOX_STYLE : DEFAULT_TEXT_BOX_STYLE), ...(options.autofit === undefined ? {} : { autofit: options.autofit }) },
    text: options.text ?? EMPTY_TEXT_BODY,
  });
}

export function line(options: Readonly<{ id: string; start: Readonly<{ x: number; y: number }>; end: Readonly<{ x: number; y: number }> }>): LineElement {
  return lineElement({
    id: elementId(options.id),
    start: options.start,
    end: options.end,
    stroke: { width: 2, colour: { kind: "theme", slot: "dark1", alpha: 1 }, dash: "solid" },
    endArrow: "none",
  });
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

export function slide(options: Readonly<{ id: string; elements: readonly ElementSnapshot[]; layoutId?: LayoutId; animations?: readonly AnimationStep[] }>): SlideSnapshot {
  return slideSnapshot({ id: slideId(options.id), elements: options.elements, layoutId: options.layoutId ?? null, animations: options.animations ?? [] });
}

export function animationStepId(text: string): AnimationStepId {
  return requireParsed(parseAnimationStepId, text);
}

/** A build step on `elementId`: a fade in on click unless stated. */
export function animationStep(options: Readonly<{ id: string; elementId: ElementId; effect?: AnimationEffect; trigger?: AnimationTrigger }>): AnimationStep {
  return {
    id: animationStepId(options.id),
    elementId: options.elementId,
    effect: options.effect ?? { kind: "fadeIn" },
    trigger: options.trigger ?? "onClick",
    durationMilliseconds: 500,
    delayMilliseconds: 0,
    easing: "easeOut",
    unsupportedKeys: [],
  };
}

export function layout(options: Readonly<{ id: LayoutId; elements: readonly ElementSnapshot[] }>): LayoutSnapshot {
  return { id: options.id, name: "Layout", background: null, elements: options.elements };
}

export function testDocument(
  options: Readonly<{ slides: readonly SlideSnapshot[]; layouts?: readonly LayoutSnapshot[]; deckId?: string; revision?: number }>,
): DocumentSnapshot {
  return documentSnapshot({
    deckId: deckId(options.deckId ?? "deck_first"),
    title: "Fixture",
    theme: TEST_THEME,
    slides: options.slides,
    layouts: options.layouts ?? [],
    revision: options.revision ?? 1,
  });
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

// Object.fromEntries widens to a string-keyed record; THEME_COLOUR_SLOTS lists every slot exactly once.
const TEST_THEME = plainTheme({ colours: Object.fromEntries(THEME_COLOUR_SLOTS.map((slot) => [slot, "#1c2333"])) as ThemeSnapshot["colours"] });
