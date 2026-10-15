// THE STORED DOCUMENT: how a deck is laid out inside a Y.Doc. Yjs is the source of truth for the
// document (the user chose a conflict-free replicated data type); this file names every root type
// and key, so the model is the only code that touches Yjs and every other layer reads
// `DocumentSnapshot` (document.ts).
//
// Layout (Y.Map unless noted; `{...}` is a nested Y.Map; "value" is a plain value replaced whole,
// last writer wins):
//
//   meta               deckId, schemaVersion, title, pageHeight, createdAt
//   theme              name, colours value, headingFontFamily, bodyFontFamily, background value,
//                      placeholderStyles value, defaultRunStyle value
//   layouts            LayoutId -> { id, name, position, background value, elements {ElementId -> element} }
//   slides             SlideId  -> { id, position, layoutId, background value, skipped,
//                                    speakerNotes Y.Text, transition value, elements {ElementId -> element},
//                                    animations {AnimationStepId -> { id, position, elementId, effect value,
//                                    trigger, durationMilliseconds, delayMilliseconds, easing }} }
//   assets             AssetId  -> AssetRecord value                       (add-only, not undoable)
//   transitionScripts  TransitionScriptId -> { id, name, description, purpose, author value, script,
//                                    stylesheet, markup, defaultParameters value, approval value, updatedAt }
//
// Comments are NOT here: they are a server-authoritative log (discussion.ts), not shared state.
//
// Decisions, each against a concrete failure:
//
//  * ORDER IS A FRACTIONAL KEY, NOT AN ARRAY POSITION. Slide order and z-order are `position`
//    strings (fractional indexing: a key strictly between two neighbours always exists). Moving a
//    slide or bringing an element forward is ONE field write. With a Y.Array a move is a delete plus
//    an insert, and two people moving the same slide concurrently duplicate it. Every NEWLY MINTED
//    key ends in a random suffix (about 4 characters, from the model's injected random source), so
//    two people inserting runs of slides into the same gap at once get two contiguous runs instead
//    of A1, B1, A2, B2 interleaved, and two replicas never mint the same key. Equal keys (only from
//    old data) still sort by id; asking for a key between two EQUAL neighbours re-keys locally.
//
//  * SLIDES AND ELEMENTS ARE KEYED MAPS, so a concurrent edit to an element is never lost to a
//    reorder, and deleting a slide is one key delete that wins over edits inside it.
//
//  * THE FRAME IS ONE VALUE. x, y, width, height, rotation and flips are stored together as
//    `frame`, as Slides stores one affine transform. A concurrent move and resize by two people
//    resolve to ONE of the two chosen frames (last writer wins), never to a box nobody chose -- and
//    undo stays whole: Yjs refuses to restore a map entry another client has since overwritten, so
//    with separate keys, undoing my resize after a peer's move would restore width and height but
//    not x and y. Lines store `lineGeometry` (both end points) as one value for the same reason.
//    Style groups (fill, border, cornerRadius, shadow, textBox) are one value each (style.ts).
//
//  * TEXT IS Y.Text WITH QUILL-STYLE ATTRIBUTES. Run attributes (the keys of `RunStyle`) format
//    characters; paragraph attributes (the keys of `ParagraphStyle`) format the paragraph's
//    terminating "\n". The two key sets are disjoint (checked at compile time below). Every body
//    ends with "\n". Attribute values are primitives or FLAT objects: Yjs merges adjacent runs when
//    `equalFlat` says their attributes are equal, and a nested object would compare unequal by
//    reference and fragment runs forever. Three rules keep the namespaces apart, because Y.Text
//    gives inserted characters the attributes found at the insertion point:
//      1. Every character insert passes the COMPLETE attribute set: the run's own values, and
//         `null` for every other run key and for EVERY paragraph key (`runInsertAttributes`).
//         Otherwise text typed at the start of a paragraph inherits the previous paragraph mark's
//         `alignment` and `list` as character formatting.
//      2. Inserting a "\n" splits a paragraph: the new mark gets the split paragraph's paragraph
//         attributes and `null` for every run key.
//      3. The snapshot projection drops paragraph keys from runs and run keys from marks, so stray
//         attributes from older data never surface.
//    An automatic field (the slide number) is an embed `{ automaticText: "slideNumber" }`.
//
//  * GROUPS ARE A POINTER (`groupId`), and their children keep ABSOLUTE slide coordinates. A group
//    stores only `rotation`; its box is derived (document.ts). Ungrouping, and moving a dangling
//    child to the top level, RE-KEY the children's `position`s, in order, into the gap between the
//    group's previous and next top-level neighbours: a child's old key was only ever compared with
//    its siblings, so keeping it could drop the child anywhere in the top-level order, even behind
//    the background shapes.
//    A DISPLACED child -- its `groupId` names a map that is gone or is not a group, or it is the
//    losing member of a cycle -- has no group place to go to: the group map that held it is the
//    thing that is missing. The snapshot shows displaced children IN FRONT of the top level, in key
//    order among themselves, and the repair re-keys them to exactly that place, so the repaired
//    order is the order every replica was already showing.
//
//  * TABLE ROWS AND COLUMNS ARE ID ARRAYS; cells are keyed "rowId|columnId". A concurrent row
//    insert and cell edit both survive, and the cell lands in the row it was typed into. A MISSING
//    cell (where a row and a column inserted concurrently by two people meet) is an empty default
//    cell in the snapshot and is created on its first edit. ACCEPTED LOSS: if two people make the
//    very first edit to the same missing cell at the same moment, both create the cell map and one
//    of the two first edits is lost (last writer wins on the key). It needs a concurrent row AND
//    column insert followed by simultaneous first typing into their intersection.
//
//  * A SLIDE'S BUILD SEQUENCE IS A KEYED MAP WITH ORDER KEYS, exactly like its elements: each step
//    is a map with its own `position`, so two people adding steps at once both keep theirs, a
//    reorder is one field write, and per-field values let a duration change and a trigger change
//    made at the same moment both survive. A slide stored before builds existed has no
//    `animations` map: it reads as an empty sequence, and the repairing replica adds the empty map
//    (validation.ts), so clients never have to create it concurrently.
//
//  * THE UNDO HISTORY COVERS `UNDO_SCOPE_ROOTS` ONLY: theme, layouts, slides and transition
//    scripts. `meta` (identity, schema version) and `assets` (add-only) are never undone.

import type { ParagraphStyle, RunStyle } from "./style.ts";

/** Root type names of the DOCUMENT Y.Doc. All are Y.Map. */
export const DOCUMENT_ROOT = {
  meta: "meta",
  theme: "theme",
  layouts: "layouts",
  slides: "slides",
  assets: "assets",
  transitionScripts: "transitionScripts",
} as const;

export type DocumentRootName = (typeof DOCUMENT_ROOT)[keyof typeof DOCUMENT_ROOT];

/** What `Y.UndoManager` is created over (see the header). */
export const UNDO_SCOPE_ROOTS: readonly DocumentRootName[] = ["theme", "layouts", "slides", "transitionScripts"];

export const META_KEY = {
  deckId: "deckId",
  schemaVersion: "schemaVersion",
  title: "title",
  pageHeight: "pageHeight",
  createdAt: "createdAt",
} as const;

export const THEME_KEY = {
  name: "name",
  colours: "colours",
  headingFontFamily: "headingFontFamily",
  bodyFontFamily: "bodyFontFamily",
  background: "background",
  placeholderStyles: "placeholderStyles",
  defaultRunStyle: "defaultRunStyle",
} as const;

export const LAYOUT_KEY = {
  id: "id",
  name: "name",
  position: "position",
  background: "background",
  elements: "elements",
} as const;

export const SLIDE_KEY = {
  id: "id",
  position: "position",
  layoutId: "layoutId",
  background: "background",
  skipped: "skipped",
  speakerNotes: "speakerNotes",
  transition: "transition",
  elements: "elements",
  animations: "animations",
} as const;

/** Keys of one build step's map under a slide's `animations` (animations.ts `AnimationStep`). */
export const ANIMATION_STEP_KEY = {
  id: "id",
  position: "position",
  elementId: "elementId",
  effect: "effect",
  trigger: "trigger",
  durationMilliseconds: "durationMilliseconds",
  delayMilliseconds: "delayMilliseconds",
  easing: "easing",
} as const;

/** Keys of every element map. Which ones are present depends on `kind` (ELEMENT_KEYS_BY_KIND). */
export const ELEMENT_KEY = {
  // common
  id: "id",
  kind: "kind",
  name: "name",
  description: "description",
  groupId: "groupId",
  position: "position",
  morphKey: "morphKey",
  placeholder: "placeholder",
  // shape, image, table: the whole frame as one value
  frame: "frame",
  // group: its own rotation (its box is derived)
  rotation: "rotation",
  // box style (shape, image)
  fill: "fill",
  border: "border",
  cornerRadius: "cornerRadius",
  shadow: "shadow",
  opacity: "opacity",
  // shape
  preset: "preset",
  textBox: "textBox",
  text: "text",
  // image
  assetId: "assetId",
  crop: "crop",
  // line: both end points as one value
  lineGeometry: "lineGeometry",
  routing: "routing",
  stroke: "stroke",
  startArrow: "startArrow",
  endArrow: "endArrow",
  // table
  rows: "rows",
  columns: "columns",
  rowHeights: "rowHeights",
  columnWidths: "columnWidths",
  cells: "cells",
} as const;

export type ElementKey = (typeof ELEMENT_KEY)[keyof typeof ELEMENT_KEY];

/** The element kinds this schema version stores; anything else projects to `UnsupportedElement`. */
export type StoredElementKind = "shape" | "image" | "line" | "table" | "group";

const COMMON_KEYS = ["id", "kind", "name", "description", "groupId", "position", "morphKey", "placeholder"] as const;
const BOX_STYLE_KEYS = ["fill", "border", "cornerRadius", "shadow", "opacity"] as const;

/**
 * Exactly which keys each element kind stores. A missing required key is STRUCTURAL damage and is
 * reported (and, on the repairing replica only, repaired with the default). An unexpected key is
 * ignored and never deleted: a newer client may have written it.
 */
export const ELEMENT_KEYS_BY_KIND: Readonly<Record<StoredElementKind, readonly ElementKey[]>> = {
  shape: [...COMMON_KEYS, "frame", ...BOX_STYLE_KEYS, "preset", "textBox", "text"],
  image: [...COMMON_KEYS, "frame", ...BOX_STYLE_KEYS, "assetId", "crop"],
  line: [...COMMON_KEYS, "lineGeometry", "routing", "stroke", "startArrow", "endArrow", "opacity"],
  table: [...COMMON_KEYS, "frame", "opacity", "rows", "columns", "rowHeights", "columnWidths", "cells"],
  group: [...COMMON_KEYS, "rotation"],
};

/** A table cell map under `cells`, keyed by `tableCellKey`. `text` is a Y.Text. */
export const TABLE_CELL_KEY = {
  rowSpan: "rowSpan",
  columnSpan: "columnSpan",
  fill: "fill",
  borders: "borders",
  textBox: "textBox",
  text: "text",
} as const;

export const TRANSITION_SCRIPT_KEY = {
  id: "id",
  name: "name",
  description: "description",
  purpose: "purpose",
  author: "author",
  script: "script",
  stylesheet: "stylesheet",
  markup: "markup",
  defaultParameters: "defaultParameters",
  approval: "approval",
  updatedAt: "updatedAt",
} as const;

/** The embed an automatic text field is stored as inside a Y.Text. */
export const AUTOMATIC_TEXT_EMBED_KEY = "automaticText";

/** "rowId|columnId": ids never contain "|" (ids.ts OBJECT_ID_PATTERN), so the split is unambiguous. */
export function tableCellKey(options: Readonly<{ rowId: string; columnId: string }>): string {
  return `${options.rowId}|${options.columnId}`;
}

/** The Y.Text attribute names that format characters. */
export type RunAttributeName = keyof RunStyle;
/** The Y.Text attribute names that format a paragraph (set on its "\n"). */
export type ParagraphAttributeName = keyof ParagraphStyle;

/** Compile-time proof that the two attribute namespaces are disjoint (see the header). */
type AttributeNameOverlap = RunAttributeName & ParagraphAttributeName;
export const ATTRIBUTE_NAMESPACES_ARE_DISJOINT: [AttributeNameOverlap] extends [never] ? true : false = true;

/** Every run attribute name; total over `RunStyle`, so a new attribute is a compile error here. */
// `Object.keys` widens to string[]; the `satisfies` record below has exactly the RunAttributeName keys.
export const RUN_ATTRIBUTE_NAMES: readonly RunAttributeName[] = Object.keys({
  fontFamily: true,
  fontSize: true,
  fontWeight: true,
  fontStyle: true,
  underline: true,
  strikethrough: true,
  colour: true,
  highlight: true,
  link: true,
  baselineOffset: true,
  letterSpacing: true,
  textCase: true,
} satisfies Readonly<Record<RunAttributeName, true>>) as readonly RunAttributeName[];

/** Every paragraph attribute name; total over `ParagraphStyle`. */
// `Object.keys` widens to string[]; the `satisfies` record below has exactly the ParagraphAttributeName keys.
export const PARAGRAPH_ATTRIBUTE_NAMES: readonly ParagraphAttributeName[] = Object.keys({
  alignment: true,
  lineSpacing: true,
  spaceAbove: true,
  spaceBelow: true,
  indentStart: true,
  indentFirstLine: true,
  direction: true,
  list: true,
} satisfies Readonly<Record<ParagraphAttributeName, true>>) as readonly ParagraphAttributeName[];

/**
 * Transaction origins. The UndoManager tracks ONLY `LOCAL_EDIT_ORIGIN`, so remote edits and sync
 * never land on this user's undo history. During undo and redo Yjs sets the origin to the
 * UndoManager itself, which is how the model tells a history change apart.
 */
export const LOCAL_EDIT_ORIGIN: Readonly<{ kind: "localEdit" }> = Object.freeze({ kind: "localEdit" });
export const REMOTE_SYNC_ORIGIN: Readonly<{ kind: "remoteSync" }> = Object.freeze({ kind: "remoteSync" });
/** Seeding a new document (default theme, first slide): not undoable. */
export const SEED_ORIGIN: Readonly<{ kind: "seed" }> = Object.freeze({ kind: "seed" });
/** Structural repairs by the repairing replica (document-store.ts): not undoable, broadcast like any edit. */
export const REPAIR_ORIGIN: Readonly<{ kind: "repair" }> = Object.freeze({ kind: "repair" });
