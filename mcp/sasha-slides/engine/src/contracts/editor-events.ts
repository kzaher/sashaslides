// EVERYTHING THAT CAN HAPPEN TO THE EDITOR, as one closed union. The view dispatches the user
// events; feedbacks dispatch the effect results (`editSettled`, `documentChanged`,
// `discussionSettled`, ...). The reducer's switch over this union is exhaustive, so a new event is
// a compile error until handled.
//
// Key decisions:
//
//  * THE VIEW REPORTS, THE REDUCER DECIDES. A pointer-down says WHERE (slide units) and ON WHAT (the
//    hit target) -- not "start a move". Whether it becomes a click, a move, a marquee or a resize
//    depends on the tool, the selection and the 3-pixel threshold, which only the reducer knows.
//
//  * INTENTS ARE NAMED FOR THE USER'S ACTION, not for the document command they cause
//    ("arrangeRequested align left", not "setFrames"), because one intent becomes different commands
//    depending on the selection (align one element to the slide, several to each other).
//
//  * NO EVENT CARRIES A TIME OR AN ID THE REDUCER WOULD HAVE TO INVENT. Ids come from the state's
//    `IdSeed`; times are stamped by the stores (editor-state.ts header).
//
//  * TEXT INPUT IS `beforeinput`, PARSED. The view's inline text editor prevents the browser from
//    editing the page and reports each `InputEvent.inputType` as a `TextInput` (parsed at the
//    boundary). Every input type a browser sends while editing text has a variant -- spell-check
//    replacements and autocorrect (`insertReplacementText`), drop, cut, undo and redo, and the
//    Ctrl+B family -- so nothing the browser offers silently does nothing. During an input-method
//    composition the browser draws the provisional text itself (it cannot be prevented); the view
//    reports `compositionStarted` with the range it began on and `compositionEnded` with the text.

import type { ClipboardPayload, EditSettlement, EditorDialog, HitTarget, MenuName, Modifiers, PointerButton, PointerSample, PropertiesTab, Tool, ZoomSetting, ElementMeasurement } from "./editor-state.ts";
import type { DiscussionOutcome, DiscussionSnapshot, Marking } from "./discussion.ts";
import type { DocumentChange, TextRange } from "./document-store.ts";
import type { AnimationEffect, AnimationStepPatch } from "./animations.ts";
import type { AssetMediaType, AssetRecord, Paragraph, ScriptPurpose, ShapePreset } from "./document.ts";
import type { ElementPatch, ReorderPlacement, SlidePropertiesPatch, TableCellPatch, TransitionScriptDraft } from "./commands.ts";
import type { FlipAxis, FractionalRegion, Point, Size } from "./geometry.ts";
import type { AgentRevertOutcome, CollaborationNotice, CollaborationStatus } from "./collaboration.ts";
import type { AnimationStepId, AssetId, DiscussionRequestId, ElementId, LayoutId, MessageId, NoticeId, PersonId, SlideId, ThreadId, TransitionScriptId, UploadId } from "./ids.ts";
import type { PeerPresence } from "./presence.ts";
import type { TextTarget } from "./selection.ts";
import type { Colour, ParagraphStylePatch, RunStylePatch } from "./style.ts";
import type { ParagraphAttributeName, RunAttributeName } from "./yjs-schema.ts";

export type EditorEvent =
  // --- canvas pointer (slide units; the view converts)
  | Readonly<{ kind: "canvasPointerDown"; sample: PointerSample; target: HitTarget; modifiers: Modifiers; button: PointerButton; clickCount: number }>
  | Readonly<{ kind: "canvasPointerMove"; sample: PointerSample; modifiers: Modifiers }>
  | Readonly<{ kind: "canvasPointerUp"; sample: PointerSample; modifiers: Modifiers }>
  | Readonly<{ kind: "canvasPointerCancelled" }>
  | Readonly<{ kind: "canvasPointerLeft" }>
  // --- keyboard shortcuts (keys the text editor did not consume)
  | Readonly<{ kind: "keyPressed"; chord: KeyChord }>
  // --- text editing
  /** Start typing into a text body: a shape's text, a table cell, or the current slide's speaker notes. */
  | Readonly<{ kind: "textEditingRequested"; target: TextTarget; at: "end" | "selectAll" | Readonly<{ index: number }> }>
  | Readonly<{ kind: "textInput"; input: TextInput }>
  | Readonly<{ kind: "textSelectionChanged"; anchor: number; focus: number }>
  /** The range the composition began on (a selected range is replaced by the composed text). */
  | Readonly<{ kind: "compositionStarted"; anchor: number; focus: number }>
  | Readonly<{ kind: "compositionEnded"; text: string }>
  | Readonly<{ kind: "textEditingEnded" }>
  // --- measured layout (the view's layout effects; never a document write by itself)
  | Readonly<{ kind: "layoutMeasured"; slideId: SlideId; elementId: ElementId; measurement: ElementMeasurement }>
  // --- toolbar and properties panel
  | Readonly<{ kind: "toolChosen"; tool: Tool }>
  /** Paint format: captures the selection's format; `sticky` on double click. */
  | Readonly<{ kind: "formatPainterRequested"; sticky: boolean }>
  | Readonly<{ kind: "elementPatchRequested"; patch: ElementPatch }>
  /** Fill, borders or text box of table cells: the reducer decides which cells the selection means. */
  | Readonly<{ kind: "tableCellPatchRequested"; patch: TableCellPatch }>
  | Readonly<{ kind: "runStyleRequested"; patch: RunStylePatch; clear: readonly RunAttributeName[] }>
  | Readonly<{ kind: "paragraphStyleRequested"; patch: ParagraphStylePatch; clear: readonly ParagraphAttributeName[] }>
  | Readonly<{ kind: "listToggled"; list: "bulleted" | "numbered" }>
  | Readonly<{ kind: "listIndentChanged"; delta: 1 | -1 }>
  /** A frame field typed in the panel. Font sizes in the panel are POINTS; geometry fields are slide units. */
  | Readonly<{ kind: "frameFieldEdited"; field: "x" | "y" | "width" | "height" | "rotation"; value: number }>
  | Readonly<{ kind: "aspectRatioLockToggled" }>
  | Readonly<{ kind: "arrangeRequested"; action: ArrangeAction }>
  | Readonly<{ kind: "shapePresetChanged"; preset: ShapePreset }>
  | Readonly<{ kind: "automaticTextInsertRequested"; field: "slideNumber" }>
  // --- slides and filmstrip
  | Readonly<{ kind: "slideActivated"; slideId: SlideId }>
  | Readonly<{ kind: "slidesSelected"; slideIds: readonly SlideId[]; mode: "replace" | "toggle" | "extend" }>
  | Readonly<{ kind: "newSlideRequested"; layoutId: LayoutId | null }>
  | Readonly<{ kind: "duplicateRequested" }>
  | Readonly<{ kind: "deleteRequested" }>
  | Readonly<{ kind: "selectAllRequested" }>
  | Readonly<{ kind: "slideDragStarted"; slideIds: readonly SlideId[] }>
  | Readonly<{ kind: "slideDragOver"; dropAfter: SlideId | null }>
  | Readonly<{ kind: "slideDragEnded"; dropped: boolean }>
  | Readonly<{ kind: "slidePropertiesRequested"; patch: SlidePropertiesPatch }>
  /** Changes the layout and remaps placeholders by (role, index) in one envelope. */
  | Readonly<{ kind: "slideLayoutChosen"; layoutId: LayoutId }>
  // --- transition scripts (their own dialog, plain text, never the slide text pipeline)
  /** `purpose` is what a NEW script (`scriptId` null) is for; an existing one keeps its own. */
  | Readonly<{ kind: "transitionScriptEditorOpened"; scriptId: TransitionScriptId | null; purpose: ScriptPurpose }>
  | Readonly<{ kind: "transitionScriptDraftChanged"; draft: TransitionScriptDraft }>
  | Readonly<{ kind: "transitionScriptSaveRequested"; overwrite: boolean }>
  | Readonly<{ kind: "transitionScriptReloadRequested" }>
  | Readonly<{ kind: "transitionScriptApproved"; scriptId: TransitionScriptId; fingerprint: string }>
  | Readonly<{ kind: "transitionPreviewRequested"; slideId: SlideId }>
  | Readonly<{ kind: "transitionPreviewEnded" }>
  // --- builds: the Animate tab (animations.ts)
  /** One step per selected element, after the chosen step (or at the end), triggered on click. */
  | Readonly<{ kind: "animationAddRequested"; effect: AnimationEffect }>
  | Readonly<{ kind: "animationStepSelected"; stepId: AnimationStepId | null }>
  | Readonly<{ kind: "animationStepPatchRequested"; stepId: AnimationStepId; patch: AnimationStepPatch }>
  /** Drag or keyboard reorder: the steps keep their relative order and land after `after` (first when null). */
  | Readonly<{ kind: "animationStepsMoved"; stepIds: readonly AnimationStepId[]; after: AnimationStepId | null }>
  | Readonly<{ kind: "animationStepRemoved"; stepId: AnimationStepId }>
  | Readonly<{ kind: "buildPreviewRequested"; slideId: SlideId }>
  | Readonly<{ kind: "buildPreviewEnded" }>
  // --- clipboard: the view writes the system clipboard itself (editor-state.ts header)
  | Readonly<{ kind: "copied" }>
  | Readonly<{ kind: "cutRequested" }>
  | Readonly<{ kind: "pasteReceived"; content: PastedContent; at: Point | null }>
  | Readonly<{ kind: "clipboardUnavailable"; operation: "copy" | "cut" | "paste" }>
  // --- history
  | Readonly<{ kind: "undoRequested" }>
  | Readonly<{ kind: "redoRequested" }>
  // --- images and assets
  | Readonly<{ kind: "imageFilesChosen"; files: readonly ChosenImageFile[]; at: Point | null; destination: "newImage" | "fill" | "slideBackground" }>
  | Readonly<{ kind: "assetStored"; uploadId: UploadId; asset: AssetRecord }>
  | Readonly<{ kind: "assetStoreFailed"; uploadId: UploadId; message: string; willRetry: boolean }>
  | Readonly<{ kind: "assetAvailable"; assetId: AssetId }>
  // --- comments and annotations
  | Readonly<{ kind: "commentComposerOpened"; slideId: SlideId; elementId: ElementId | null; textRange: TextRange | null; region: FractionalRegion | null }>
  | Readonly<{ kind: "commentDraftChanged"; draft: string; mentions: readonly PersonId[] }>
  | Readonly<{ kind: "markingDrawn"; marking: Marking }>
  | Readonly<{ kind: "commentSubmitted" }>
  | Readonly<{ kind: "commentComposerClosed" }>
  | Readonly<{ kind: "threadFocused"; threadId: ThreadId | null }>
  | Readonly<{ kind: "threadReplied"; threadId: ThreadId; body: string; mentions: readonly PersonId[] }>
  | Readonly<{ kind: "messageEdited"; threadId: ThreadId; messageId: MessageId; body: string; mentions: readonly PersonId[] }>
  | Readonly<{ kind: "messageDeleted"; threadId: ThreadId; messageId: MessageId }>
  | Readonly<{ kind: "threadResolved"; threadId: ThreadId }>
  | Readonly<{ kind: "threadReopened"; threadId: ThreadId }>
  | Readonly<{ kind: "threadDeleted"; threadId: ThreadId }>
  | Readonly<{ kind: "resolvedThreadsToggled" }>
  // --- chrome
  | Readonly<{ kind: "menuOpened"; menu: MenuName }>
  | Readonly<{ kind: "menuClosed" }>
  | Readonly<{ kind: "contextMenuOpened"; at: Point; scope: "canvas" | "element" | "filmstrip" }>
  | Readonly<{ kind: "contextMenuClosed" }>
  | Readonly<{ kind: "dialogOpened"; dialog: EditorDialog }>
  /** The rename dialog's new deck title (trimmed by the reducer; an empty title changes nothing). */
  | Readonly<{ kind: "deckRenamed"; title: string }>
  | Readonly<{ kind: "dialogClosed" }>
  | Readonly<{ kind: "propertiesTabChosen"; tab: PropertiesTab }>
  | Readonly<{ kind: "panelToggled"; panel: "properties" | "filmstrip" | "speakerNotes" | "comments" }>
  | Readonly<{ kind: "noticeDismissed"; noticeId: NoticeId }>
  | Readonly<{ kind: "noticeActionChosen"; noticeId: NoticeId }>
  | Readonly<{ kind: "viewportResized"; size: Size }>
  | Readonly<{ kind: "zoomRequested"; zoom: ZoomSetting }>
  | Readonly<{ kind: "scrolled"; scroll: Point }>
  /** Dispatched AFTER the view's click handler entered full screen (or opened a tab, in the add-on). */
  | Readonly<{ kind: "presentRequested"; from: "beginning" | "currentSlide"; withSpeakerView: boolean }>
  | Readonly<{ kind: "presentationEnded"; lastSlideId: SlideId | null }>
  // --- effect results (dispatched by feedbacks only)
  | Readonly<{ kind: "editSettled"; settlement: EditSettlement }>
  | Readonly<{ kind: "documentChanged"; change: DocumentChange }>
  | Readonly<{ kind: "discussionChanged"; snapshot: DiscussionSnapshot }>
  /** The discussion feedback handed this request to the authority: it moves from pending to in flight. */
  | Readonly<{ kind: "discussionRequestSent"; requestId: DiscussionRequestId }>
  | Readonly<{ kind: "discussionSettled"; outcome: DiscussionOutcome }>
  | Readonly<{ kind: "textAnchorsResolved"; ranges: ReadonlyMap<ThreadId, TextRange | null> }>
  | Readonly<{ kind: "peersChanged"; peers: readonly PeerPresence[] }>
  | Readonly<{ kind: "noticeExpired"; noticeId: NoticeId }>
  /**
   * An effect with no outcome event of its own failed (resolving comment anchors, checking an
   * asset). `context` says what was being done, for the person reading the notice ("Finding the
   * text comments point to"); `message` is the error's own text.
   */
  | Readonly<{ kind: "feedbackFailed"; context: string; message: string }>
  /** Milestone 2: the sync provider learned that an agent session changed the deck. */
  | Readonly<{ kind: "agentEditObserved"; agentSessionId: string; agentName: string; summary: string }>
  // --- collaboration (milestone 2; collaboration.ts)
  /** The collaboration feedback's report of a new status (connection, role, members, unsent changes). */
  | Readonly<{ kind: "collaborationChanged"; status: CollaborationStatus }>
  /** A one-off server notice other than `agentEdit` (which arrives as `agentEditObserved`). */
  | Readonly<{ kind: "collaborationNoticeReceived"; notice: Exclude<CollaborationNotice, { kind: "agentEdit" }> }>
  /** "Try now" on the offline indicator. */
  | Readonly<{ kind: "reconnectRequested" }>
  /** The revert an "Undo Claude's edit" action asked for has finished. */
  | Readonly<{ kind: "agentRevertSettled"; agentSessionId: string; outcome: AgentRevertOutcome }>
  /** The colour picker applied a colour; it moves to the front of `chrome.recentColours`. */
  | Readonly<{ kind: "recentColourUsed"; colour: Colour }>;

/** A key with normalised modifiers; `key` is KeyboardEvent.key, `code` is KeyboardEvent.code. */
export type KeyChord = Readonly<{ key: string; code: string; modifiers: Modifiers }>;

export type DeletionUnit = "character" | "word" | "line";

/** The `InputEvent.inputType`s the inline text editor handles, parsed at the page boundary. */
export type TextInput =
  /** insertText */
  | Readonly<{ kind: "insertText"; text: string }>
  /** insertReplacementText (spell check, macOS autocorrect): the target range comes from `getTargetRanges()`. */
  | Readonly<{ kind: "replaceRange"; anchor: number; focus: number; text: string }>
  /** insertParagraph (Enter): a new paragraph inheriting the current paragraph's style. */
  | Readonly<{ kind: "insertParagraph" }>
  /** insertLineBreak (Shift+Enter): a line break inside the paragraph (U+000B, as Slides stores it). */
  | Readonly<{ kind: "insertLineBreak" }>
  /** Tab while editing: list level in a list paragraph, otherwise a tab character ("\t"). */
  | Readonly<{ kind: "insertTab"; outdent: boolean }>
  | Readonly<{ kind: "deleteBackward"; unit: DeletionUnit }>
  | Readonly<{ kind: "deleteForward"; unit: DeletionUnit }>
  /** deleteByCut: the view already wrote the clipboard; this removes the selected text. */
  | Readonly<{ kind: "deleteByCut" }>
  /** insertFromPaste while editing text: plain or rich (parsed from the pasted markup). */
  | Readonly<{ kind: "insertFromPaste"; content: PastedText }>
  /** insertFromDrop: text dragged into the body; `index` is where it was dropped. */
  | Readonly<{ kind: "insertFromDrop"; index: number; content: PastedText }>
  /** historyUndo / historyRedo: the editor's undo, never the browser's. */
  | Readonly<{ kind: "history"; direction: "undo" | "redo" }>
  /** formatBold / formatItalic / formatUnderline / formatStrikeThrough. */
  | Readonly<{ kind: "toggleFormat"; format: "bold" | "italic" | "underline" | "strikethrough" }>;

export type PastedText =
  | Readonly<{ kind: "plain"; text: string }>
  /** Rich text from Docs or the web, reduced to the run and paragraph styles the engine has. */
  | Readonly<{ kind: "rich"; paragraphs: readonly Paragraph[] }>;

export type ArrangeAction =
  | Readonly<{ kind: "reorder"; placement: ReorderPlacement }>
  /** One element aligns to the slide; several align to their common bounds. */
  | Readonly<{ kind: "align"; edge: "left" | "horizontalCentre" | "right" | "top" | "verticalCentre" | "bottom" }>
  /** Three or more: equal gaps between the outermost two. */
  | Readonly<{ kind: "distribute"; axis: "horizontal" | "vertical" }>
  | Readonly<{ kind: "group" }>
  | Readonly<{ kind: "ungroup" }>
  /** Mirrors about the selection's centre (geometry.ts `flipFrame`). */
  | Readonly<{ kind: "flip"; axis: FlipAxis }>
  | Readonly<{ kind: "rotate"; degrees: 90 | -90 }>
  | Readonly<{ kind: "centreOnSlide"; axis: "horizontal" | "vertical" }>;

/** What a paste outside text editing brought, parsed by the view from the DataTransfer. */
export type PastedContent =
  | Readonly<{ kind: "engine"; payload: ClipboardPayload }>
  /** Text pasted onto the canvas becomes a new text box. */
  | Readonly<{ kind: "text"; text: PastedText }>
  | Readonly<{ kind: "image"; file: ChosenImageFile }>;

export type ChosenImageFile = Readonly<{
  name: string;
  mediaType: AssetMediaType;
  bytes: ArrayBuffer;
  pixelWidth: number;
  pixelHeight: number;
}>;
