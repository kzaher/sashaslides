// EDITS: the closed set of changes anyone -- the user's gestures, the keyboard, Claude, an import --
// can make to a document. The editor never touches Yjs; it queues `CommandEnvelope`s, and one
// feedback hands each to `DocumentStore.apply` (document-store.ts), which writes it to the Y.Doc in
// ONE transaction. One envelope is one undo step.
//
// Key decisions:
//
//  * COMMANDS CARRY COMPLETE VALUES AND CALLER-CHOSEN IDS. "Duplicate slide", "new slide from
//    layout" and "change this slide's layout" are expanded by the editor (which mints ids from its
//    `IdSeed`, ids.ts) into complete commands. The model never invents an element or slide id, and
//    the editor knows the new ids in time to select them (`selectionAfter`). The model does draw
//    randomness for one thing only -- the suffix of new order keys (yjs-schema.ts) -- from its own
//    injected random source.
//
//  * GEOMETRY ARRIVES EXPANDED. `setFrames` carries the final frame of every LEAF it changes (and a
//    group's own rotation), computed by the state module's gesture code with the pure rules in
//    geometry.ts. The model writes them; it never re-derives a child from a group's box, so the
//    preview the user saw during the drag is exactly what is stored.
//
//  * INSERTED TREES WIN OVER THEIR OWN FIELDS. `insertSlides`/`insertElements` take element trees.
//    The model derives each child's `groupId` from the tree (a `groupId` field that disagrees is
//    ignored), and ignores the derived `frame` of groups and lines (a group stores its frame's
//    rotation only; a line stores `start`/`end`).
//
//  * VALIDATE EVERYTHING, THEN WRITE. A Yjs transaction cannot be rolled back. The model checks
//    every command in an envelope against the current document first; any failure rejects the
//    whole envelope with a `CommandRejection` and writes nothing.
//
//  * TEXT INDICES ARE CURRENT BY CONSTRUCTION. The reducer moves every index it holds through each
//    document change (`transformIndex`, text-delta.ts) before it queues the next edit, and the
//    mailbox delivers a feedback's events before the next user event (rxfeedback.ts). So an
//    `editText` is always computed against the revision the model holds; `basedOnRevision` is a
//    guard that turns a broken invariant into a visible `staleText` rejection instead of a
//    scrambled word.
//
//  * STYLE PATCHES APPLY TO MIXED SELECTIONS. `updateElements` on a shape and a line with
//    `{ border, stroke }` sets the shape's border and the line's stroke; a field that does not
//    apply to an element's kind is skipped for that element, not an error, which is what a
//    properties panel showing "the controls the selection shares" needs.

import type { AnimationStep, AnimationStepPatch } from "./animations.ts";
import { assertNever } from "./assert-never.ts";
import type {
  AssetRecord,
  CellBorders,
  ElementSnapshot,
  ImageCrop,
  LayoutSnapshot,
  ScriptPurpose,
  ShapePreset,
  SlideSnapshot,
  SlideTransition,
  ThemeSnapshot,
  TransitionAuthor,
  AutomaticTextField,
} from "./document.ts";
import type { Frame, Point } from "./geometry.ts";
import type {
  AnimationStepId,
  AssetId,
  CommandId,
  ElementId,
  LayoutId,
  PersonId,
  SlideId,
  TableColumnId,
  TableRowId,
  TransitionScriptId,
} from "./ids.ts";
import type { CellAddress, Selection, TextTarget } from "./selection.ts";
import type { SerialisableObject } from "./serialisable.ts";
import type {
  ArrowHead,
  Border,
  BoxStyle,
  CornerRadius,
  Fill,
  LineRouting,
  ParagraphStylePatch,
  RunStylePatch,
  Shadow,
  Stroke,
  TextBoxStyle,
} from "./style.ts";
import type { ParagraphAttributeName, RunAttributeName } from "./yjs-schema.ts";

/** Who an envelope acts for: approvals and script authorship are recorded from it. */
export type CommandAuthor =
  | Readonly<{ kind: "person"; personId: PersonId }>
  /** Claude, editing through the connector (milestone 2); `agentSessionId` groups its edits for revert. */
  | Readonly<{ kind: "agent"; name: string; agentSessionId: string }>;

/** What the editor queues: a batch of commands that is one transaction and one undo step. */
export type CommandEnvelope = Readonly<{
  commandId: CommandId;
  author: CommandAuthor;
  commands: readonly DocumentCommand[];
  /**
   * Restored by undo. The model stores text positions in it as Yjs relative positions, so an undo
   * after other people's typing still puts the caret on the right characters (document-store.ts).
   */
  selectionBefore: Selection;
  /** Restored by redo; the editor already shows it (it moves the selection when it queues). */
  selectionAfter: Selection;
  /**
   * True for consecutive typing in the same text body (and the text box growth it causes): the
   * model merges it into the previous undo step if that step is a text edit of the same body made
   * less than `typingMergeWindowMilliseconds` ago by the model's injected clock. False for
   * everything else: a move right after typing is its own undo step.
   */
  mergeWithPrevious: boolean;
}>;

export type DocumentCommand =
  | Readonly<{ kind: "setTitle"; title: string }>
  | Readonly<{ kind: "updateTheme"; patch: Partial<ThemeSnapshot> }>
  | Readonly<{ kind: "upsertLayout"; layout: LayoutSnapshot }>
  | Readonly<{ kind: "deleteLayout"; layoutId: LayoutId }>
  /** Add-only: registering an id that exists is a no-op, never a rejection (two people pasting one image). */
  | Readonly<{ kind: "registerAsset"; asset: AssetRecord }>
  /**
   * Create or replace a script. `basedOnUpdatedAt` is the `updatedAt` the editor started from (null
   * for a new script); the model rejects `staleScript` when someone saved since, and
   * `transitionScriptMissing` when it is not null but the script was deleted since. The model stamps
   * `updatedAt`, records the envelope's author, and sets the approval per `approval`.
   */
  | Readonly<{ kind: "upsertTransitionScript"; script: TransitionScriptDraft; basedOnUpdatedAt: number | null; approval: TransitionScriptSaveApproval }>
  | Readonly<{ kind: "deleteTransitionScript"; scriptId: TransitionScriptId }>
  /** A person approves the script text they reviewed; rejected if the text changed since (`fingerprint`). */
  | Readonly<{ kind: "approveTransitionScript"; scriptId: TransitionScriptId; fingerprint: string }>
  /** Insert complete slides (fresh ids throughout) after `after`, or first when null. */
  | Readonly<{ kind: "insertSlides"; slides: readonly SlideSnapshot[]; after: SlideId | null }>
  | Readonly<{ kind: "deleteSlides"; slideIds: readonly SlideId[] }>
  /** Move the slides, keeping their relative order, to just after `after` (first when null). */
  | Readonly<{ kind: "moveSlides"; slideIds: readonly SlideId[]; after: SlideId | null }>
  | Readonly<{ kind: "setSlideProperties"; slideId: SlideId; patch: SlidePropertiesPatch }>
  /** Insert element trees (groups with their children) at `placement` (see the header on trees). */
  | Readonly<{ kind: "insertElements"; slideId: SlideId; elements: readonly ElementSnapshot[]; placement: InsertPlacement }>
  /** Deleting a group deletes its children; the build steps of every deleted element go with them (animations.ts). */
  | Readonly<{ kind: "deleteElements"; slideId: SlideId; elementIds: readonly ElementId[] }>
  /** Final geometry of leaves and group rotations: a move, resize, rotate, flip, nudge or align. */
  | Readonly<{ kind: "setFrames"; slideId: SlideId; frames: readonly FrameUpdate[] }>
  | Readonly<{ kind: "updateElements"; slideId: SlideId; elementIds: readonly ElementId[]; patch: ElementPatch }>
  | Readonly<{ kind: "reorderElements"; slideId: SlideId; elementIds: readonly ElementId[]; placement: ReorderPlacement }>
  /**
   * The new group takes the z-position of the front-most member; members are re-keyed in order.
   * Rejected `groupCycle` if a member is the new group's ancestor.
   */
  | Readonly<{ kind: "groupElements"; slideId: SlideId; elementIds: readonly ElementId[]; groupId: ElementId }>
  /** Children are re-keyed into the group's place in the top-level order (yjs-schema.ts). */
  | Readonly<{ kind: "ungroupElements"; slideId: SlideId; groupIds: readonly ElementId[] }>
  | Readonly<{ kind: "editText"; target: TextTarget; basedOnRevision: number; operations: readonly TextOperation[] }>
  | Readonly<{ kind: "insertTableRows"; slideId: SlideId; elementId: ElementId; rows: readonly TableLineInsert<TableRowId>[] }>
  | Readonly<{ kind: "insertTableColumns"; slideId: SlideId; elementId: ElementId; columns: readonly TableLineInsert<TableColumnId>[] }>
  | Readonly<{ kind: "deleteTableRows"; slideId: SlideId; elementId: ElementId; rowIds: readonly TableRowId[] }>
  | Readonly<{ kind: "deleteTableColumns"; slideId: SlideId; elementId: ElementId; columnIds: readonly TableColumnId[] }>
  | Readonly<{ kind: "setTableColumnWidths"; slideId: SlideId; elementId: ElementId; widths: readonly Readonly<{ columnId: TableColumnId; width: number }>[] }>
  | Readonly<{ kind: "setTableRowHeights"; slideId: SlideId; elementId: ElementId; heights: readonly Readonly<{ rowId: TableRowId; minimumHeight: number }>[] }>
  | Readonly<{ kind: "updateTableCells"; slideId: SlideId; elementId: ElementId; cells: readonly CellAddress[]; patch: TableCellPatch }>
  /** Insert complete build steps (fresh ids) into the slide's sequence after `after`, or first when null. */
  | Readonly<{ kind: "insertAnimationSteps"; slideId: SlideId; steps: readonly AnimationStep[]; after: AnimationStepId | null }>
  /** Set the given fields on every named step; a step's other fields keep their values. */
  | Readonly<{ kind: "updateAnimationSteps"; slideId: SlideId; stepIds: readonly AnimationStepId[]; patch: AnimationStepPatch }>
  /** Move the steps, keeping their relative order, to just after `after` (first when null). */
  | Readonly<{ kind: "moveAnimationSteps"; slideId: SlideId; stepIds: readonly AnimationStepId[]; after: AnimationStepId | null }>
  | Readonly<{ kind: "deleteAnimationSteps"; slideId: SlideId; stepIds: readonly AnimationStepId[] }>;

export type DocumentCommandKind = DocumentCommand["kind"];

/** The commands that change a table's lines or cells; validated and applied by one function each. */
export type TableCommand = Extract<
  DocumentCommand,
  { kind: "insertTableRows" | "insertTableColumns" | "deleteTableRows" | "deleteTableColumns" | "setTableColumnWidths" | "setTableRowHeights" | "updateTableCells" }
>;

/**
 * How a save sets the script's approval. `"authorDecides"`: approved by the author when a person
 * saves (they wrote or reviewed the text they save), unapproved when an agent does. `"unapproved"`:
 * stored unapproved whoever saves -- a person pasting slides from another deck carries scripts they
 * have not read, and the paste must not count as their review.
 */
export type TransitionScriptSaveApproval = "authorDecides" | "unapproved";

/** A script as the editor or Claude writes it; the model adds author, approval and `updatedAt`. */
export type TransitionScriptDraft = Readonly<{
  id: TransitionScriptId;
  name: string;
  description: string;
  /** A slide transition or a scripted build step (document.ts `ScriptPurpose`). */
  purpose: ScriptPurpose;
  script: string;
  stylesheet: string;
  markup: string;
  defaultParameters: SerialisableObject;
}>;

/**
 * Slide fields. `layoutId` only records the link: the placeholder remapping a layout change
 * implies is computed by the editor and sent as element commands in the same envelope
 * (document.ts `LayoutSnapshot`).
 */
export type SlidePropertiesPatch = Readonly<{
  background?: Fill | null;
  skipped?: boolean;
  transition?: SlideTransition | null;
  layoutId?: LayoutId | null;
}>;

export type InsertPlacement =
  | Readonly<{ kind: "front" }>
  | Readonly<{ kind: "back" }>
  | Readonly<{ kind: "above"; elementId: ElementId }>
  /** Into a group, in front of its children (paste while inside a group). */
  | Readonly<{ kind: "insideGroup"; groupId: ElementId }>;

/** Slides' Arrange > Order: to front, forward one, backward one, to back. */
export type ReorderPlacement = "front" | "forward" | "backward" | "back";

export type FrameUpdate =
  /** A shape, image or table. */
  | Readonly<{ kind: "box"; elementId: ElementId; frame: Frame }>
  | Readonly<{ kind: "line"; elementId: ElementId; start: Point; end: Point }>
  /** A group's own rotation; its children's frames are separate `box`/`line` updates. */
  | Readonly<{ kind: "groupRotation"; elementId: ElementId; rotation: number }>;

/** Every field optional; see the header for how inapplicable fields are skipped. */
export type ElementPatch = Readonly<{
  name?: string;
  description?: string;
  morphKey?: string;
  // shape and image
  fill?: Fill;
  border?: Border;
  cornerRadius?: CornerRadius;
  shadow?: Shadow | null;
  // shape, image, line, table
  opacity?: BoxStyle["opacity"];
  // shape
  textBox?: TextBoxStyle;
  preset?: ShapePreset;
  // image
  assetId?: AssetId;
  crop?: ImageCrop;
  // line
  stroke?: Stroke;
  startArrow?: ArrowHead;
  endArrow?: ArrowHead;
  routing?: LineRouting;
}>;

export type TableLineInsert<TId> = Readonly<{
  id: TId;
  /** Insert after this row/column; null inserts first. */
  after: TId | null;
  /** Height for a row, width for a column, in slide units. */
  size: number;
}>;

export type TableCellPatch = Readonly<{
  fill?: Fill;
  /** Only the sides given change. */
  borders?: Partial<CellBorders>;
  textBox?: TextBoxStyle;
}>;

/**
 * One change inside a text body, in Y.Text indices. Operations in one `editText` apply in order,
 * each against the result of the previous one, so two inserts at the same index in one envelope
 * read in the order given. How inserts are written so they never pick up paragraph formatting is
 * yjs-schema.ts's text rule.
 */
export type TextOperation =
  /** `text` may contain "\n": each one splits the paragraph, copying its paragraph attributes. */
  | Readonly<{ kind: "insert"; index: number; text: string; style: RunStylePatch }>
  | Readonly<{ kind: "insertAutomaticText"; index: number; field: AutomaticTextField; style: RunStylePatch }>
  | Readonly<{ kind: "delete"; index: number; length: number }>
  /** Set the given attributes on characters; `clear` removes attributes (back to inherited). */
  | Readonly<{ kind: "formatRuns"; index: number; length: number; patch: RunStylePatch; clear: readonly RunAttributeName[] }>
  /** Set attributes on every paragraph overlapping [index, index + length). */
  | Readonly<{
      kind: "formatParagraphs";
      index: number;
      length: number;
      patch: ParagraphStylePatch;
      clear: readonly ParagraphAttributeName[];
    }>;

export type CommandOutcome =
  | Readonly<{ kind: "applied"; commandId: CommandId; revision: number }>
  | Readonly<{ kind: "rejected"; commandId: CommandId; rejection: CommandRejection }>;

export type CommandRejection =
  | Readonly<{ reason: "slideMissing"; slideId: SlideId }>
  | Readonly<{ reason: "elementMissing"; slideId: SlideId; elementId: ElementId }>
  | Readonly<{ reason: "layoutMissing"; layoutId: LayoutId }>
  | Readonly<{ reason: "transitionScriptMissing"; scriptId: TransitionScriptId }>
  | Readonly<{ reason: "assetMissing"; assetId: AssetId }>
  | Readonly<{ reason: "tableLineMissing"; elementId: ElementId; id: string }>
  | Readonly<{ reason: "animationStepMissing"; slideId: SlideId; stepId: AnimationStepId }>
  | Readonly<{ reason: "duplicateId"; id: string }>
  | Readonly<{ reason: "invalidId"; id: string }>
  /** `path` is a dotted path into the command, e.g. "commands.2.patch.opacity". */
  | Readonly<{ reason: "invalidValue"; path: string; message: string }>
  | Readonly<{ reason: "wrongKind"; elementId: ElementId; expected: string; actual: string }>
  | Readonly<{ reason: "groupCycle"; groupId: ElementId }>
  | Readonly<{ reason: "textOutOfRange"; index: number; length: number; bodyLength: number }>
  /** The invariant in the header broke: the editor re-derives the caret, the keystroke shows a notice. */
  | Readonly<{ reason: "staleText"; basedOnRevision: number; currentRevision: number }>
  | Readonly<{ reason: "staleScript"; scriptId: TransitionScriptId; basedOnUpdatedAt: number | null; currentUpdatedAt: number }>
  /** `approveTransitionScript` named text that is no longer stored: someone saved a new version since it was reviewed. */
  | Readonly<{ reason: "staleApproval"; scriptId: TransitionScriptId; fingerprint: string; currentFingerprint: string }>
  /** An agent may write scripts but never approve them. */
  | Readonly<{ reason: "approvalNeedsPerson"; scriptId: TransitionScriptId }>;

/** The edits the editor queues: a command envelope, or a history step. */
export type QueuedEdit =
  | Readonly<{ kind: "apply"; envelope: CommandEnvelope }>
  | Readonly<{ kind: "undo"; commandId: CommandId }>
  | Readonly<{ kind: "redo"; commandId: CommandId }>;

export function queuedEditId(edit: QueuedEdit): CommandId {
  switch (edit.kind) {
    case "apply":
      return edit.envelope.commandId;
    case "undo":
    case "redo":
      return edit.commandId;
    default:
      return assertNever(edit);
  }
}

/** The script author an envelope's author becomes (the model records it on save). */
export function transitionAuthorOf(author: CommandAuthor): TransitionAuthor {
  switch (author.kind) {
    case "person":
      return { kind: "person", personId: author.personId };
    case "agent":
      return { kind: "agent", name: author.name, agentSessionId: author.agentSessionId };
    default:
      return assertNever(author);
  }
}
