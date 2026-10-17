// THE DOCUMENT AS PLAIN, IMMUTABLE VALUES -- what the editor state holds, what React renders and
// what tests assert on. The stored source of truth is the Y.Doc (yjs-schema.ts); this is its
// read-only projection, rebuilt by the model after every transaction.
//
// Key decisions:
//
//  * STRUCTURAL SHARING IS A CONTRACT, NOT AN OPTIMISATION. After a transaction the model rebuilds
//    only the slides the transaction touched; every other `SlideSnapshot` (and every untouched
//    element inside a touched slide) is the SAME object as before. React's memoisation, the
//    filmstrip's thumbnail cache and the reducer's change detection all rely on `===`, so a model
//    that rebuilds everything is a bug even if every value is equal.
//
//  * GROUPS ARE A TREE HERE AND FLAT IN THE SHARED DOCUMENT. Yjs cannot move a subtree without
//    deleting and recreating it (which loses a concurrent edit inside it), so the Y.Doc stores
//    every element of a slide in one map with a `groupId` pointer, and grouping is a field write.
//    The snapshot presents the tree the renderer wants: `slide.elements` is the top level in
//    z-order (back to front) and a group carries its `children` in z-order. The projection walks
//    with a visited set, so a cycle made by two concurrent "group" commands can never recurse
//    forever: the member with the larger id is shown at the top level (and repaired, see
//    document-store.ts). Empty groups are not shown.
//
//  * EVERY ELEMENT HAS A FRAME. Shapes, images and tables store theirs. A line's frame is the
//    unrotated bounds of its end points (geometry.ts `lineFrame`). A group stores only its own
//    ROTATION, so a rotated group keeps showing rotated handles and its rotation field reads what
//    the user set; its box is the bounds of its children measured in the group's rotated axes.
//    Selection bounds, marquee hit tests and alignment never need a per-kind switch.
//
//  * VALUES FROM NEWER CLIENTS SURVIVE. A key holding a value this client does not understand (a
//    new `ShapePreset`, a new `Fill` kind) is listed in `unsupportedKeys`; the snapshot carries a
//    default in its place so rendering never fails, the view draws a "made with a newer version"
//    placeholder treatment, and the editor never writes that key unless the user explicitly
//    changes it. An element of an unknown kind becomes an `UnsupportedElement`. Nothing is
//    "repaired" to a default (document-store.ts, validation).
//
//  * TEXT IS PARAGRAPHS OF RUNS. The character index space is the Y.Text's: each paragraph's runs
//    followed by ONE paragraph mark ("\n"), the last paragraph included. An automatic field (the
//    slide number) is one embedded item of length 1. An empty body is a single empty paragraph,
//    length 1. Text selections and text commands use these indices.

import type { AnimationStep } from "./animations.ts";
import { assertNever } from "./assert-never.ts";
import type { Frame, PageSize, Point } from "./geometry.ts";
import type {
  AssetId,
  DeckId,
  ElementId,
  LayoutId,
  PersonId,
  SlideId,
  TableColumnId,
  TableRowId,
  TransitionScriptId,
} from "./ids.ts";
import type { SerialisableObject } from "./serialisable.ts";
import type {
  ArrowHead,
  BoxStyle,
  Fill,
  HexadecimalColour,
  LineRouting,
  ParagraphStylePatch,
  RunStyle,
  RunStylePatch,
  Stroke,
  TextBoxStyle,
  ThemeColourSlot,
} from "./style.ts";

/** Bumped when the Y.Doc layout changes incompatibly; the model opens a newer document read-only. */
export const DOCUMENT_SCHEMA_VERSION = 1;

export type DocumentSnapshot = Readonly<{
  deckId: DeckId;
  schemaVersion: number;
  /** Increases by one per observed transaction, local or remote. Never stored in the Y.Doc. */
  revision: number;
  title: string;
  pageSize: PageSize;
  theme: ThemeSnapshot;
  layouts: readonly LayoutSnapshot[];
  /** In presentation order. */
  slides: readonly SlideSnapshot[];
  assets: readonly AssetRecord[];
  transitionScripts: readonly TransitionScriptRecord[];
}>;

/** The text style of each placeholder role: what a run in a title or body resolves through. */
export type PlaceholderStyle = Readonly<{
  run: RunStylePatch;
  paragraph: ParagraphStylePatch;
  textBox: Partial<TextBoxStyle>;
}>;

/**
 * The master-like deck theme: colour slots, the two font roles, the default background, the text
 * style of each placeholder role, and the text style a run finally falls back to. Slides' master
 * and theme collapse into this one record. A run resolves: its own attributes, then its
 * placeholder role's `placeholderStyles` entry, then `defaultRunStyle`.
 */
export type ThemeSnapshot = Readonly<{
  name: string;
  colours: Readonly<Record<ThemeColourSlot, HexadecimalColour>>;
  headingFontFamily: string;
  bodyFontFamily: string;
  background: Fill;
  placeholderStyles: Readonly<Record<PlaceholderRole, PlaceholderStyle>>;
  defaultRunStyle: RunStyle;
}>;

/**
 * A layout: a named template of placeholders and decorations. Milestone 1 COPIES a layout's
 * elements into a new slide (with fresh ids and `placeholder` set). Changing a slide's layout
 * remaps its placeholders by `(role, index)`: a matched placeholder keeps its text and takes the
 * layout's frame; an unmatched one stays as it is; a layout placeholder with no match is added
 * empty. The state module computes that as one command envelope (`remapSlideToLayout`). A live
 * link, where editing the layout restyles every slide using it, is later.
 */
export type LayoutSnapshot = Readonly<{
  id: LayoutId;
  name: string;
  background: Fill | null;
  elements: readonly ElementSnapshot[];
}>;

export type SlideSnapshot = Readonly<{
  id: SlideId;
  layoutId: LayoutId | null;
  /** null: the theme background. */
  background: Fill | null;
  /** Slides' "Skip slide": kept in the deck, omitted when presenting. */
  skipped: boolean;
  speakerNotes: TextBody;
  /** The transition INTO this slide, as in Slides and Keynote. null: a cut. */
  transition: SlideTransition | null;
  /** The build sequence of this slide's objects, in play order (animations.ts). Empty: no builds. */
  animations: readonly AnimationStep[];
  /** Top level, z-order back to front. */
  elements: readonly ElementSnapshot[];
}>;

export type ElementSnapshot = ShapeElement | ImageElement | LineElement | TableElement | GroupElement | UnsupportedElement;

export type ElementKind = ElementSnapshot["kind"];

/** Fields every element kind has. */
export type ElementCommon = Readonly<{
  id: ElementId;
  /** Shown in the layers list and read by import and export; empty by default. */
  name: string;
  /** Alternative text. */
  description: string;
  /** Stored for shapes, images and tables; derived for lines and groups (see the header). */
  frame: Frame;
  /** The group this element belongs to; null at the top level. */
  groupId: ElementId | null;
  /**
   * What the morph transition pairs elements by. Defaults to the element id; DUPLICATING a slide
   * keeps the source's morph keys, so "duplicate, then move things" morphs like Keynote's Magic
   * Move even though every duplicated element has a fresh id.
   */
  morphKey: string;
  placeholder: PlaceholderReference | null;
  /** Stored keys whose values this client does not understand (see the header); usually empty. */
  unsupportedKeys: readonly string[];
}>;

/** The placeholder roles Slides layouts use. */
export type PlaceholderRole =
  | "title"
  | "centredTitle"
  | "subtitle"
  | "body"
  | "slideNumber"
  | "footer"
  | "date"
  | "picture";

export const PLACEHOLDER_ROLES: readonly PlaceholderRole[] = ["title", "centredTitle", "subtitle", "body", "slideNumber", "footer", "date", "picture"];

export type PlaceholderReference = Readonly<{ role: PlaceholderRole; index: number }>;

/** Shape presets: the Slides `ShapeType` values the editor offers, named in full. */
export type ShapePreset =
  | "textBox"
  | "rectangle"
  | "roundedRectangle"
  | "ellipse"
  | "triangle"
  | "rightTriangle"
  | "diamond"
  | "parallelogram"
  | "trapezoid"
  | "pentagon"
  | "hexagon"
  | "octagon"
  | "fivePointStar"
  | "plus"
  | "heart"
  | "cloud"
  | "speechBubble"
  | "chevron"
  | "rightArrow"
  | "leftArrow"
  | "upArrow"
  | "downArrow";

export type ShapeElement = ElementCommon &
  Readonly<{
    kind: "shape";
    /** The preset the shape is drawn as, and the one an editor or older client falls back to while `customOutline` is set. */
    preset: ShapePreset;
    /** A freeform outline drawn INSTEAD of the preset; null draws the preset (see `CustomOutline`). */
    customOutline: CustomOutline | null;
    box: BoxStyle;
    textBox: TextBoxStyle;
    text: TextBody;
  }>;

/**
 * A FREEFORM OUTLINE: what Google Slides calls a custom shape and Office XML writes as
 * `<a:custGeom>` (a funnel's trapezoids, a hand-drawn polygon). Presets cannot hold it, so a shape
 * carries one of these beside its preset and is drawn by it.
 *
 * Key decisions:
 *
 *  * FRACTIONS OF THE BOX, not slide units. Office states each path in its own `w` x `h` space that
 *    is stretched to the shape's box, so a resized freeform reshapes with its box; fractions keep
 *    exactly that, and a frame edit never has to rewrite the outline. A point may lie outside 0..1:
 *    Office lets a path overhang its box.
 *  * STRAIGHT, QUADRATIC AND CUBIC SEGMENTS ONLY. Office's elliptical `arcTo` is converted to cubic
 *    curves by whoever reads it, so every renderer and exporter handles four drawing commands.
 *  * EACH PATH SAYS WHETHER IT IS FILLED AND STROKED, as Office's `<a:path fill="none" stroke="0">`
 *    does: a shape's outline and its fill region can differ (an open curve drawn over a filled body).
 *  * OPTIONAL IN STORAGE. The stored key is absent on every shape written before freeforms existed
 *    and on every preset shape; absent reads as null, so older decks need no repair.
 */
export type CustomOutline = Readonly<{ paths: readonly OutlinePath[] }>;

export type OutlinePath = Readonly<{ commands: readonly OutlineCommand[]; filled: boolean; stroked: boolean }>;

/** A point as fractions of the element's box: (0, 0) its top-left corner, (1, 1) its bottom-right. */
export type OutlinePoint = Readonly<{ x: number; y: number }>;

export type OutlineCommand =
  | Readonly<{ kind: "move"; to: OutlinePoint }>
  | Readonly<{ kind: "line"; to: OutlinePoint }>
  | Readonly<{ kind: "quadratic"; control: OutlinePoint; to: OutlinePoint }>
  | Readonly<{ kind: "cubic"; firstControl: OutlinePoint; secondControl: OutlinePoint; to: OutlinePoint }>
  | Readonly<{ kind: "close" }>;

/** Fractions of the source image trimmed from each side, 0..1. */
export type ImageCrop = Readonly<{ left: number; top: number; right: number; bottom: number }>;

export type ImageElement = ElementCommon &
  Readonly<{
    kind: "image";
    assetId: AssetId;
    crop: ImageCrop;
    /** The fill shows behind transparent pixels; border, corners, shadow and opacity apply. */
    box: BoxStyle;
  }>;

export type LineElement = ElementCommon &
  Readonly<{
    kind: "line";
    /** Slide units; `frame` is their bounding box, unrotated. */
    start: Point;
    end: Point;
    routing: LineRouting;
    stroke: Stroke;
    startArrow: ArrowHead;
    endArrow: ArrowHead;
    opacity: number;
  }>;

export type TableColumn = Readonly<{ id: TableColumnId; width: number }>;
export type TableRow = Readonly<{ id: TableRowId; minimumHeight: number }>;

export type CellBorders = Readonly<{
  top: Stroke | null;
  right: Stroke | null;
  bottom: Stroke | null;
  left: Stroke | null;
}>;

export type TableCell = Readonly<{
  rowId: TableRowId;
  columnId: TableColumnId;
  /**
   * 1 unless merged. The model keeps a cell for EVERY row and column, so a cell covered by another's
   * span is present as an empty default cell; readers that draw or export a table skip covered
   * cells themselves (writing their default borders over a merged cell erases its lines).
   */
  rowSpan: number;
  columnSpan: number;
  fill: Fill;
  borders: CellBorders;
  textBox: TextBoxStyle;
  text: TextBody;
}>;

/**
 * A table. Every row x column cell is present in the snapshot: a cell the Y.Doc does not hold yet
 * (a row and a column inserted concurrently by two people meet in a cell nobody created) is shown
 * as an empty default cell and created on its first edit (yjs-schema.ts). The visible row heights
 * are MEASURED by the view (text grows rows past `minimumHeight`), so the stored `frame.height` is
 * a lower bound; geometry uses `EditorState.measuredLayouts` when present.
 */
export type TableElement = ElementCommon &
  Readonly<{
    kind: "table";
    columns: readonly TableColumn[];
    rows: readonly TableRow[];
    /** Row-major in `rows` x `columns` order. */
    cells: readonly TableCell[];
    opacity: number;
  }>;

export type GroupElement = ElementCommon &
  Readonly<{
    kind: "group";
    /** Z-order back to front. Never empty in a snapshot. */
    children: readonly ElementSnapshot[];
  }>;

/** An element of a kind this client does not know: drawn as a placeholder box at its frame, never edited. */
export type UnsupportedElement = ElementCommon &
  Readonly<{
    kind: "unsupported";
    storedKind: string;
  }>;

/** Automatic text fields, embedded in a body as one item each. */
export type AutomaticTextField = "slideNumber";

export type TextRun =
  | Readonly<{ kind: "text"; text: string; style: RunStylePatch }>
  /** Renders the live value (this slide's number); length 1 in the index space. */
  | Readonly<{ kind: "automaticText"; field: AutomaticTextField; style: RunStylePatch }>;

export type Paragraph = Readonly<{ style: ParagraphStylePatch; runs: readonly TextRun[] }>;

export type TextBody = Readonly<{ paragraphs: readonly Paragraph[] }>;

export const EMPTY_TEXT_BODY: TextBody = { paragraphs: [{ style: {}, runs: [] }] };

export type AssetMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";

/**
 * An uploaded image, by content address. The BYTES are not in the document: they live in an
 * `AssetStore` (document-store.ts), in memory for milestone 1 and in the deck server's blob store
 * from milestone 2, so a 5 megabyte photo never travels through the shared update stream. Records
 * are ADD-ONLY and outside the undo history: undoing a paste must not remove a record a
 * collaborator's later paste of the same image relies on. Unreferenced records are collected only
 * by the deck server.
 */
export type AssetRecord = Readonly<{
  id: AssetId;
  mediaType: AssetMediaType;
  /** Intrinsic pixel size, for "reset size" and crop arithmetic. */
  pixelWidth: number;
  pixelHeight: number;
  name: string;
  byteLength: number;
}>;

export type SlideDirection = "fromLeft" | "fromRight" | "fromTop" | "fromBottom";

export type BuiltinTransitionEffect =
  | Readonly<{ effect: "fade" }>
  | Readonly<{ effect: "push"; direction: SlideDirection }>
  | Readonly<{ effect: "slide"; direction: SlideDirection; mode: "cover" | "uncover" }>
  | Readonly<{ effect: "zoom"; mode: "in" | "out" }>
  | Readonly<{ effect: "morph" }>;

export type BuiltinTransitionName = BuiltinTransitionEffect["effect"];

export type TransitionEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";

export type SlideTransition =
  | Readonly<{ kind: "builtin"; effect: BuiltinTransitionEffect; durationMilliseconds: number; easing: TransitionEasing }>
  | Readonly<{ kind: "scripted"; scriptId: TransitionScriptId; durationMilliseconds: number; parameters: SerialisableObject }>;

export type ScriptedSlideTransition = Extract<SlideTransition, { kind: "scripted" }>;

/** The transition when it runs a script from the deck's store, else null (also for no transition). */
export function scriptedSlideTransitionOf(transition: SlideTransition | null): ScriptedSlideTransition | null {
  if (transition === null) return null;
  switch (transition.kind) {
    case "scripted":
      return transition;
    case "builtin":
      return null;
    default:
      return assertNever(transition);
  }
}

/** Who wrote a script. An agent session is identified so a person can find and revert its work. */
export type TransitionAuthor =
  | Readonly<{ kind: "agent"; name: string; agentSessionId: string }>
  | Readonly<{ kind: "person"; personId: PersonId }>;

/**
 * Whether a person has approved this exact script text. A script is arbitrary code, possibly
 * written by a model from a prompt someone else controls, or pasted from another deck, so the
 * presenter runs only APPROVED scripts; an unapproved one falls back to a fade with a notice. A
 * person saving a script in the script dialog approves what they saved; an agent write or a paste
 * from another deck is unapproved. The approval names the `scriptFingerprint` it covered, so any
 * later change to the text voids it without anyone having to remember to reset it.
 */
export type TransitionApproval =
  | Readonly<{ kind: "unapproved" }>
  | Readonly<{ kind: "approved"; approvedBy: PersonId; fingerprint: string }>;

/**
 * What a script in the deck's script store is for. A transition animates from one slide to the next;
 * an animation is a scripted build step (animations.ts) animating from one build state of a slide
 * to the next. Both run in the same sandbox under the same approval rule. The purpose is part of
 * the fingerprint an approval covers (`scriptFingerprint`): code a person approved as a build step
 * is not thereby approved to run between slides, and the reverse.
 */
export type ScriptPurpose = "transition" | "animation";

/**
 * A scripted transition: JavaScript (and optional markup and stylesheet) that runs in the
 * sandboxed runner (transition-protocol.ts). Stored once per deck and referenced by any number of
 * slides, so Claude can write one "ink wipe" and the user can apply it everywhere. The source is
 * DATA the engine never evaluates in its own realm.
 *
 * The three sources are PLAIN STRINGS (last writer wins), not shared text: scripts are written
 * whole -- by Claude, or saved from the script dialog -- and character-level merging of two
 * people's code produces code neither wrote. A save names the `updatedAt` it was based on, and the
 * model rejects a save over someone else's newer one (commands.ts `staleScript`).
 */
export type TransitionScriptRecord = Readonly<{
  id: TransitionScriptId;
  name: string;
  description: string;
  /** "transition" for records stored before builds existed. */
  purpose: ScriptPurpose;
  author: TransitionAuthor;
  /** The script body; calls `sashaTransition.define(...)` (transition-protocol.ts). */
  script: string;
  /** Optional stylesheet injected into the runner's stage. */
  stylesheet: string;
  /** Optional markup injected into the runner's stage overlay (above both slides). */
  markup: string;
  /** Defaults merged under a slide's `parameters`. */
  defaultParameters: SerialisableObject;
  approval: TransitionApproval;
  /** Stamped by the model with its injected clock on every save. */
  updatedAt: number;
}>;

/** Total length of a body in the Y.Text index space (runs + one mark per paragraph). */
export function textBodyLength(body: TextBody): number {
  let length = 0;
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) length += textRunLength(run);
    length += 1;
  }
  return length;
}

export function textRunLength(run: TextRun): number {
  switch (run.kind) {
    case "text":
      return run.text.length;
    case "automaticText":
      return 1;
    default:
      return assertNever(run);
  }
}

/**
 * The body as plain text, paragraphs joined by "\n" (no trailing mark). An automatic slide number
 * prints `slideNumber`, or "#" when the caller does not know it.
 */
export function plainText(options: Readonly<{ body: TextBody; slideNumber: number | null }>): string {
  return options.body.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => plainRunText({ run, slideNumber: options.slideNumber })).join(""))
    .join("\n");
}

/** The text a run shows: its characters, or the slide number ("#" when the caller does not know it). */
export function plainRunText(options: Readonly<{ run: TextRun; slideNumber: number | null }>): string {
  switch (options.run.kind) {
    case "text":
      return options.run.text;
    case "automaticText":
      return options.slideNumber === null ? "#" : String(options.slideNumber);
    default:
      return assertNever(options.run);
  }
}

/**
 * A short, synchronous fingerprint of a script's three sources and its purpose (two 32-bit
 * Fowler-Noll-Vo hashes with different offsets, 16 hexadecimal digits). Not a security hash: it only
 * has to change when the text or the purpose changes, so an approval cannot outlive an edit
 * (`TransitionApproval`) or follow the code into another role (`ScriptPurpose`). A transition's
 * fingerprint is the three sources alone, exactly as before builds existed, so every approval given
 * then still holds.
 */
export function scriptFingerprint(sources: Readonly<{ script: string; stylesheet: string; markup: string; purpose: ScriptPurpose }>): string {
  const text = `${sources.script}\u0000${sources.stylesheet}\u0000${sources.markup}${purposeSuffix(sources.purpose)}`;
  return fowlerNollVo({ text, offset: 0x811c9dc5 }) + fowlerNollVo({ text, offset: 0x01000193 ^ 0x5bd1e995 });
}

function purposeSuffix(purpose: ScriptPurpose): string {
  switch (purpose) {
    case "transition":
      return "";
    case "animation":
      return "\u0000animation";
    default:
      return assertNever(purpose);
  }
}

function fowlerNollVo(options: Readonly<{ text: string; offset: number }>): string {
  let hash = options.offset >>> 0;
  for (let index = 0; index < options.text.length; index += 1) {
    hash ^= options.text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
