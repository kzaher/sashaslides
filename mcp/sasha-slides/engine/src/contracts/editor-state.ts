// THE EDITOR'S ONE STATE TREE. Everything the editor shows is a function of this value; the "state"
// module owns the reducer that evolves it and the feedbacks that perform its effects, and the
// "view" module only renders it and dispatches `EditorEvent`s (editor-events.ts).
//
// Key decisions:
//
//  * THE DOCUMENT IS A PROJECTION HERE. `document` is the latest `DocumentSnapshot` the store
//    emitted; the reducer never edits it. Edits are queued in `pendingEdits` and a feedback applies
//    them (document-store.ts header). So the state is the single place that knows "what the user
//    sees" and "what is still on its way into the shared document".
//
//  * THE REDUCER IS PURE AND REPLAYABLE. It never calls a clock or a random source: ids come from
//    `idSeed` (ids.ts `mintId`), times are stamped by the stores that record them (the model's
//    `updatedAt`, the discussion authority's `at`), and timers (notice expiry, upload timeouts,
//    presence throttling) are feedbacks on the injected scheduler. Replaying the event log from the
//    same initial state reproduces the same state, ids included.
//
//  * THE CARET MOVES WHEN THE EDIT IS QUEUED, not when it settles. Queuing a text edit sets
//    `selection` to the envelope's `selectionAfter` at once, and every later document change moves
//    the caret, the composition start and the indices of queued edits through the change's text
//    deltas (text-delta.ts). Combined with the mailbox's feedback-first order (rxfeedback.ts), fast
//    typing can never compute an insert against an old caret.
//
//  * GESTURES PREVIEW LOCALLY AND COMMIT ONCE. A drag, resize or rotate updates `gesture` on every
//    pointer move and touches the document only on release, as one `setFrames` envelope. One
//    gesture is one undo step, collaborators receive one update instead of sixty per second, and
//    Escape mid-drag cancels by dropping the gesture.
//
//  * EFFECT REQUESTS ARE STATE -- EXCEPT THOSE THE BROWSER ONLY ALLOWS INSIDE A USER GESTURE.
//    Uploads, discussion requests and the presentation request are fields a feedback observes.
//    Clipboard writes, entering full screen and opening the speaker view window are performed by
//    the VIEW's own event handlers, synchronously, because Safari and popup blockers refuse them
//    after an asynchronous hop through state; the handler then dispatches what happened. The copy
//    handler reads `clipboardContentFor(state)` (editor-system.ts) instead of a round trip.

import { assertNever } from "./assert-never.ts";
import type { CollaborationStatus } from "./collaboration.ts";
import type { ElementPatch, FrameUpdate, QueuedEdit, CommandOutcome, TransitionScriptDraft } from "./commands.ts";
import type { CommentTargetDraft, DiscussionCommand, DiscussionSnapshot, Marking, Person } from "./discussion.ts";
import type { HistoryAvailability, HistoryOutcome, TextRange } from "./document-store.ts";
import type { AssetMediaType, AssetRecord, DocumentSnapshot, ElementSnapshot, ShapePreset, SlideSnapshot, TextBody, TransitionScriptRecord } from "./document.ts";
import type { Box, FractionalRegion, Point, ResizeHandle, Size } from "./geometry.ts";
import type {
  AssetId,
  CommandId,
  DeckId,
  DiscussionRequestId,
  ElementId,
  IdSeed,
  LayoutId,
  MessageId,
  NoticeId,
  PersonId,
  SlideId,
  TableColumnId,
  TableRowId,
  ThreadId,
  TransitionScriptId,
  UploadId,
} from "./ids.ts";
import type { PeerPresence } from "./presence.ts";
import type { Selection, TextTarget } from "./selection.ts";
import type { ArrowHead, Colour, LineRouting, ParagraphStylePatch, RunStylePatch } from "./style.ts";

export type EditorState = Readonly<{
  me: Person;
  /** Mints every id the editor creates (see the header). */
  idSeed: IdSeed;
  /** Where the editor runs; decides what Present and menu copy do (SPEC.md "Add-on embedding"). */
  embedding: EditorEmbedding;
  document: DocumentSnapshot;
  discussion: DiscussionSnapshot;
  history: HistoryAvailability;
  /** The slide shown on the canvas; null only for an empty deck. */
  currentSlideId: SlideId | null;
  selection: Selection;
  /** Inside which group clicks select children ("double-click to enter a group"); null at top level. */
  enteredGroupId: ElementId | null;
  tool: Tool;
  gesture: Gesture;
  textEditing: TextEditingState;
  viewport: Viewport;
  clipboard: ClipboardState;
  /** Edits waiting for the apply feedback, oldest first. */
  pendingEdits: readonly QueuedEdit[];
  /** Commands awaiting their outcome, for "Saving..." and to drop a selectionAfter that was rejected. */
  inFlightCommandIds: readonly CommandId[];
  /** Discussion requests waiting for the discussion feedback, oldest first. */
  pendingDiscussion: readonly PendingDiscussionRequest[];
  /** Sent to the authority, awaiting `discussionSettled`; shown as "Sending..." in the rail. */
  inFlightDiscussion: readonly PendingDiscussionRequest[];
  /** Current ranges of text-anchored threads (resolved by a feedback after each change); null: text gone. */
  resolvedTextAnchors: ReadonlyMap<ThreadId, TextRange | null>;
  uploads: readonly PendingUpload[];
  /** Assets whose bytes are loadable here; an image whose asset is absent renders a placeholder. */
  availableAssetIds: ReadonlySet<AssetId>;
  /** Layout the view measured (table rows, text height); never written to the document by itself. */
  measuredLayouts: ReadonlyMap<ElementId, ElementMeasurement>;
  /**
   * Where the pointer last was over the canvas, slide units, gesture or not; null once it left. The
   * presence feedback publishes it, so collaborators see this editor's cursor while it only hovers.
   */
  pointer: Point | null;
  peers: readonly PeerPresence[];
  /**
   * The connection, this person's role and the deck's members (collaboration.ts). The reducer
   * refuses document edits unless the role may edit (a notice says why), and discussion requests
   * unless it may comment; the server enforces the same table, this only keeps the UI honest.
   */
  collaboration: CollaborationStatus;
  /** Agent sessions whose revert ("Undo Claude's edit") the collaboration feedback is running. */
  pendingAgentReverts: readonly string[];
  chrome: EditorChrome;
  notices: readonly Notice[];
  /** Non-null while the presenter should be showing; the app shell mounts it. */
  presentation: PresentationRequest | null;
}>;

export type EditorEmbedding =
  | Readonly<{ kind: "webApplication" }>
  /**
   * Inside the Google Slides add-on's dialog: full screen and the asynchronous clipboard are not
   * delegated to nested frames there, so Present opens a top-level tab and menu copy and paste
   * point to the keyboard shortcuts.
   */
  | Readonly<{ kind: "addonDialog"; webApplicationAddress: string }>;

/** The active tool; `select` is the default and every insert tool returns to it after one use. */
export type Tool =
  | Readonly<{ kind: "select" }>
  | Readonly<{ kind: "shape"; preset: ShapePreset }>
  | Readonly<{ kind: "line"; routing: LineRouting; startArrow: ArrowHead; endArrow: ArrowHead }>
  | Readonly<{ kind: "table"; rowCount: number; columnCount: number }>
  /** Click or drag a region to start a comment thread there. */
  | Readonly<{ kind: "comment" }>
  /** Draw a marking for the comment being composed. */
  | Readonly<{ kind: "annotate"; marking: Marking["kind"] }>
  | Readonly<{ kind: "pan" }>
  /** Paint format: the next click applies `captured`; `sticky` (double click) keeps the tool. */
  | Readonly<{ kind: "formatPainter"; captured: CapturedFormat; sticky: boolean }>;

/** The tools that drag out a new element. */
export type InsertTool = Extract<Tool, { kind: "shape" | "line" | "table" }>;

/** What paint format copies from the selection. */
export type CapturedFormat = Readonly<{
  run: RunStylePatch;
  paragraph: ParagraphStylePatch;
  element: ElementPatch;
}>;

/** Normalised modifiers: `primary` is Ctrl on Windows and Linux and Cmd on macOS (the view decides). */
export type Modifiers = Readonly<{ shift: boolean; alt: boolean; primary: boolean }>;

export type PointerButton = "primary" | "secondary" | "middle";

/** One pointer position in both spaces: slide units for geometry, client pixels for thresholds. */
export type PointerSample = Readonly<{ slidePoint: Point; clientPoint: Point }>;

/** What the pointer went down on, as the view's hit test reports it. */
export type HitTarget =
  | Readonly<{ kind: "outside" }>
  | Readonly<{ kind: "slideBackground" }>
  /** Outermost first: [group, child] when a grouped child is under the pointer. */
  | Readonly<{ kind: "element"; elementPath: readonly ElementId[] }>
  | Readonly<{ kind: "resizeHandle"; handle: ResizeHandle }>
  | Readonly<{ kind: "rotationHandle" }>
  | Readonly<{ kind: "lineEnd"; elementId: ElementId; end: "start" | "end" }>
  | Readonly<{ kind: "tableColumnBoundary"; elementId: ElementId; columnId: TableColumnId }>
  | Readonly<{ kind: "tableRowBoundary"; elementId: ElementId; rowId: TableRowId }>
  | Readonly<{ kind: "commentPin"; threadId: ThreadId }>;

/** A snapping guide drawn while dragging; `position` on the guide's axis, slide units. */
export type SnapGuide = Readonly<{ axis: "vertical" | "horizontal"; position: number; from: number; to: number }>;

export type Gesture =
  | Readonly<{ kind: "idle" }>
  /** Down, not yet past the 3-pixel drag threshold: still a click. */
  | Readonly<{ kind: "pressed"; origin: PointerSample; target: HitTarget; modifiers: Modifiers }>
  | Readonly<{
      kind: "moving";
      origin: PointerSample;
      current: PointerSample;
      startFrames: readonly FrameUpdate[];
      preview: readonly FrameUpdate[];
      guides: readonly SnapGuide[];
    }>
  | Readonly<{
      kind: "resizing";
      handle: ResizeHandle;
      origin: PointerSample;
      current: PointerSample;
      startFrames: readonly FrameUpdate[];
      preview: readonly FrameUpdate[];
      guides: readonly SnapGuide[];
    }>
  | Readonly<{
      kind: "rotating";
      centre: Point;
      origin: PointerSample;
      current: PointerSample;
      startFrames: readonly FrameUpdate[];
      preview: readonly FrameUpdate[];
    }>
  | Readonly<{ kind: "movingLineEnd"; elementId: ElementId; end: "start" | "end"; point: Point; guides: readonly SnapGuide[] }>
  | Readonly<{ kind: "marquee"; origin: Point; current: Point; additive: boolean }>
  /** Dragging out a new element with an insert tool. */
  | Readonly<{ kind: "creating"; tool: InsertTool; origin: Point; current: Point }>
  | Readonly<{ kind: "resizingTableLine"; elementId: ElementId; line: TableLineReference; origin: Point; current: Point }>
  | Readonly<{ kind: "draggingSlides"; slideIds: readonly SlideId[]; dropAfter: SlideId | null }>
  | Readonly<{ kind: "drawingMarking"; marking: Marking }>
  | Readonly<{ kind: "panning"; origin: PointerSample; startScroll: Point }>;

export type TableLineReference =
  | Readonly<{ kind: "column"; columnId: TableColumnId }>
  | Readonly<{ kind: "row"; rowId: TableRowId }>;

export type TextEditingState = Readonly<{
  /** Run attributes the next typed character gets (Ctrl+B at a caret). Cleared when the caret moves. */
  typingStyle: RunStylePatch;
  composition: Composition | null;
  /**
   * Bumped when an input-method composition ends: the view keys the edited body's paragraphs with
   * it, so React remounts them instead of reconciling text the browser wrote into the page itself.
   */
  renderGeneration: number;
}>;

/**
 * An input-method composition in progress. The browser owns the composed text in the page while
 * it lasts, so the view renders `frozenBody` for that target -- never a newer snapshot -- and a
 * remote edit to the same body only moves `startIndex` (through its text delta) until the
 * composition ends. Then the reducer inserts the composed text at `startIndex`, bumps
 * `renderGeneration`, and the body renders from the document again.
 */
export type Composition = Readonly<{
  target: TextTarget;
  startIndex: number;
  frozenBody: TextBody;
}>;

export type ZoomSetting = Readonly<{ kind: "fit" }> | Readonly<{ kind: "fixed"; scale: number }>;

export type Viewport = Readonly<{
  /** The canvas area in client pixels, reported by the view's ResizeObserver. */
  containerSize: Size;
  zoom: ZoomSetting;
  /** Client pixels per slide unit, derived from `zoom` and `containerSize` by the reducer. */
  scale: number;
  scroll: Point;
}>;

/**
 * What a copy produces: the editor's own format, complete snapshots, so a paste into another deck
 * is lossless. Scripts the copied slides use travel along and arrive UNAPPROVED in another deck.
 * `operation: "cut"` pasted into the same deck keeps element and slide ids that are still free,
 * so moving an element through the clipboard keeps its comments.
 */
export type ClipboardPayload =
  | Readonly<{
      format: "sasha-engine/elements@1";
      operation: "copy" | "cut";
      sourceDeckId: DeckId;
      slideId: SlideId;
      elements: readonly ElementSnapshot[];
      assets: readonly AssetRecord[];
    }>
  | Readonly<{
      format: "sasha-engine/slides@1";
      operation: "copy" | "cut";
      sourceDeckId: DeckId;
      slides: readonly SlideSnapshot[];
      assets: readonly AssetRecord[];
      transitionScripts: readonly TransitionScriptRecord[];
    }>;

/** What the view's copy handler writes, besides the markup it renders itself. */
export type ClipboardContent = Readonly<{ payload: ClipboardPayload; plainText: string }>;

export type ClipboardState = Readonly<{
  /** Consecutive pastes of the same payload onto the same slide, for the 10-unit cascade offset. */
  pasteCascade: Readonly<{ payloadFingerprint: string; slideId: SlideId; count: number }> | null;
}>;

export type UploadDestination =
  | Readonly<{ kind: "newImage"; slideId: SlideId; centre: Point }>
  | Readonly<{ kind: "fill"; slideId: SlideId; elementIds: readonly ElementId[] }>
  | Readonly<{ kind: "slideBackground"; slideId: SlideId }>;

export type PendingUpload = Readonly<{
  uploadId: UploadId;
  name: string;
  mediaType: AssetMediaType;
  bytes: ArrayBuffer;
  pixelWidth: number;
  pixelHeight: number;
  destination: UploadDestination;
  /** 1-based; the upload feedback retries up to 3 attempts with backoff on the injected scheduler. */
  attempt: number;
}>;

/**
 * A discussion request as the editor queues it. `createThread` carries a DRAFT target (a text range
 * by indices); the discussion feedback encodes it with `DocumentStore.encodeTextAnchor`.
 */
export type PendingDiscussionRequest = Readonly<{ requestId: DiscussionRequestId; command: DiscussionCommandDraft }>;

export type DiscussionCommandDraft =
  | Exclude<DiscussionCommand, { kind: "createThread" }>
  | Readonly<{
      kind: "createThread";
      threadId: ThreadId;
      slideId: SlideId;
      target: CommentTargetDraft;
      region: FractionalRegion | null;
      elementFrameAtCreation: Box | null;
      markings: readonly Marking[];
      messageId: MessageId;
      body: string;
      mentions: readonly PersonId[];
    }>;

/** What the view measured for an element (SPEC.md "Measured layout"). */
export type ElementMeasurement =
  /** Visible row heights, slide units, in row order; text grows rows past their minimum. */
  | Readonly<{ kind: "table"; rowHeights: readonly Readonly<{ rowId: TableRowId; height: number }>[] }>
  /** Height the text needs inside the box, padding included, slide units. */
  | Readonly<{ kind: "text"; contentHeight: number }>;

export type PropertiesTab = "arrange" | "fill" | "border" | "effects" | "text" | "slide" | "transition";

export type MenuName = "file" | "edit" | "view" | "insert" | "slide" | "arrange" | "help";

export type TransitionScriptEditor = Readonly<{
  /** The draft being edited; a new script has a freshly minted id. */
  draft: TransitionScriptDraft;
  /** The `updatedAt` the draft started from; null for a new script. */
  basedOnUpdatedAt: number | null;
  /** Someone saved since (`staleScript`): the dialog offers "reload theirs" or "overwrite". */
  conflict: boolean;
  previewGeneration: number;
}>;

export type EditorDialog =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "insertImage" }>
  | Readonly<{ kind: "insertTable" }>
  | Readonly<{ kind: "linkEditor" }>
  | Readonly<{ kind: "transitionScriptEditor"; editor: TransitionScriptEditor }>
  | Readonly<{ kind: "keyboardShortcuts" }>
  | Readonly<{ kind: "renameDeck" }>
  | Readonly<{ kind: "newSlideFromLayout"; layoutIds: readonly LayoutId[] }>;

export type CommentComposer =
  | Readonly<{ kind: "closed" }>
  | Readonly<{
      kind: "composing";
      slideId: SlideId;
      target: CommentTargetDraft;
      region: FractionalRegion | null;
      markings: readonly Marking[];
      draft: string;
      /** Members picked from the mention list while typing; sent with the comment. */
      mentions: readonly PersonId[];
    }>;

export type ContextMenu = Readonly<{ at: Point; scope: "canvas" | "element" | "filmstrip" }>;

export type EditorChrome = Readonly<{
  propertiesTab: PropertiesTab;
  propertiesPanelOpen: boolean;
  filmstripOpen: boolean;
  speakerNotesOpen: boolean;
  commentsOpen: boolean;
  openMenu: MenuName | null;
  contextMenu: ContextMenu | null;
  dialog: EditorDialog;
  composer: CommentComposer;
  /** The thread whose card is expanded in the comment rail. */
  focusedThreadId: ThreadId | null;
  showResolvedThreads: boolean;
  /**
   * "Lock the aspect ratio" in the properties panel: resizing with a handle keeps the proportions as
   * if Shift were held, and typing a width or height scales the other side with it. An editor
   * preference, not stored in the document (Slides has no per-element lock to export to).
   */
  aspectRatioLocked: boolean;
  /** The transition preview playing in the properties panel; `generation` restarts it. */
  transitionPreview: Readonly<{ slideId: SlideId; generation: number }> | null;
  /**
   * The colour picker's "Recent" row, most recent first, at most `RECENT_COLOUR_LIMIT`, without
   * duplicates. Per viewer, never in the document: the web module persists it in local storage and
   * passes it to `initialEditorState`.
   */
  recentColours: readonly Colour[];
}>;

export const RECENT_COLOUR_LIMIT = 10;

export type NoticeAction =
  /** Milestone 2: revert an agent session's edits (`deck_revert`). */
  | Readonly<{ kind: "undoAgentEdits"; agentSessionId: string; agentName: string }>
  | Readonly<{ kind: "retryUpload"; uploadId: UploadId }>
  /** The deck server dropped this comment over its rate; choosing it queues the same command again. */
  | Readonly<{ kind: "retryDiscussion"; command: DiscussionCommandDraft }>
  | Readonly<{ kind: "reviewTransitionScript"; scriptId: TransitionScriptId }>
  /** In the add-on dialog: open the same deck as a top-level tab. */
  | Readonly<{ kind: "openInNewTab" }>;

export type Notice = Readonly<{
  id: NoticeId;
  tone: "information" | "warning" | "error";
  message: string;
  action: NoticeAction | null;
  /** A feedback expires it on the injected scheduler; null stays until dismissed. */
  expiresAfterMilliseconds: number | null;
}>;

export type PresentationRequest = Readonly<{ startSlideId: SlideId; withSpeakerView: boolean }>;

/** What the apply feedback reports for each queued edit. */
export type EditSettlement =
  | Readonly<{ kind: "command"; outcome: CommandOutcome }>
  | Readonly<{ kind: "history"; commandId: CommandId; outcome: HistoryOutcome }>;

/** The marquee box from a marquee gesture, normalised to positive size. */
export function marqueeBox(gesture: Readonly<{ origin: Point; current: Point }>): Box {
  return {
    x: Math.min(gesture.origin.x, gesture.current.x),
    y: Math.min(gesture.origin.y, gesture.current.y),
    width: Math.abs(gesture.current.x - gesture.origin.x),
    height: Math.abs(gesture.current.y - gesture.origin.y),
  };
}

/**
 * The geometry to draw instead of the document's while a gesture is live: the renderer overlays
 * these on the slide snapshot. Exhaustive so a new gesture kind must decide whether it previews.
 */
export function gesturePreviewFrames(gesture: Gesture): readonly FrameUpdate[] {
  switch (gesture.kind) {
    case "moving":
    case "resizing":
    case "rotating":
      return gesture.preview;
    case "idle":
    case "pressed":
    case "movingLineEnd":
    case "marquee":
    case "creating":
    case "resizingTableLine":
    case "draggingSlides":
    case "drawingMarking":
    case "panning":
      return [];
    default:
      return assertNever(gesture);
  }
}
