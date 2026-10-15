// THE MODEL'S SURFACE: what the "model" module exports and everything else depends on. The editor,
// the view's demo and (milestone 2) the sync server receive these as injected dependencies; nothing
// outside src/model/ imports Yjs to change a document.
//
// THE ARRANGEMENT WITH RxFeedback (SPEC.md "State and the document"): the Y.Doc is the stored
// truth; the editor state holds the latest `DocumentSnapshot` as a read-only projection. Changes
// flow in a circle with exactly one writer:
//
//     view intent ──► reducer queues CommandEnvelope ──► apply feedback ──► DocumentStore.apply
//          ▲                                                                     │ (Y.Doc transaction)
//          └── reducer stores snapshot ◄── documentChanged event ◄── DocumentStore.changes
//
// Remote updates enter the same way (sync applies them to the Y.Doc; `changes` emits with origin
// "remote"), so the reducer never distinguishes "my edit" from "your edit" when updating the
// snapshot. What it does with the change's `textChanges` -- moving every text index it holds -- is
// the same for both too.
//
// Synchronous on purpose: `apply` writes and returns its outcome in the same call, and `changes`
// emits inside that call (Yjs fires `afterTransaction` synchronously). RE-ENTRANCE: when `apply`,
// `undo` or `redo` is called from inside a `changes` subscriber, the outer change finishes emitting
// first; the inner call's `DocumentChange` is emitted after the inner call returns, and the
// revision it returned is the one that change carries. The RxFeedback core drains
// feedback events before the next dispatched event (rxfeedback.ts), so the change and the
// settlement of an edit are both reduced before the next keystroke is.
//
// UNDO. One `Y.UndoManager` over `UNDO_SCOPE_ROOTS` (yjs-schema.ts), tracking only
// `LOCAL_EDIT_ORIGIN`, created with `captureTimeout: Number.POSITIVE_INFINITY`: Yjs's own merge
// window reads Yjs's own clock, which no test can control. The model merges typing itself -- it
// calls `stopCapturing()` before every envelope EXCEPT one with `mergeWithPrevious` whose previous
// step edited the same body less than `typingMergeWindowMilliseconds` ago by the injected `now`.
// Each step's metadata keeps `selectionBefore`/`selectionAfter` with text positions converted to
// Yjs relative positions, resolved back to indices when the step is undone or redone (falling back
// to selecting the element, then to no selection, when the text is gone).
//
// UNDO AGAINST COLLABORATORS. Yjs does not restore a map entry another client has overwritten
// since; with the frame stored as one value (yjs-schema.ts), a step is restored whole or not at
// all. A step whose transaction changes NOTHING (everything it touched was since overwritten) is
// skipped and the next one is tried, up to the whole stack; `skippedSteps` reports how many, and
// the editor says "a collaborator changed this since" instead of silently undoing something older.
//
// VALIDATION AND REPAIR. `validate` reports; only the REPAIRING REPLICA writes repairs: the single
// replica in milestone 1, and the deck server from milestone 2 (clients run with `"reportOnly"`).
// Repairs are STRUCTURAL only -- a missing required key, a dangling `groupId`, a group cycle, an
// empty or single-child group -- and never touch a value this client merely does not understand
// (document.ts "values from newer clients survive"), so two client versions cannot fight. They are
// scheduled on the injected scheduler AFTER the transaction that revealed them, never inside an
// `observeDeep` callback.

import type { Observable, SchedulerLike } from "rxjs";
import type { Doc } from "yjs";
import type { CommandEnvelope, CommandOutcome } from "./commands.ts";
import type { AssetMediaType, DocumentSnapshot } from "./document.ts";
import type { AssetId, CommandId, RandomSource, SlideId } from "./ids.ts";
import type { Selection, TextTarget } from "./selection.ts";
import type { TextDelta, TextTargetKey } from "./text-delta.ts";

export interface DocumentStore extends Disposable {
  /** For sync providers (milestone 2) and the in-memory loopback. Never written by the editor. */
  readonly sharedDocument: Doc;
  snapshot(): DocumentSnapshot;
  /** Validate every command, then write all of them in one transaction (commands.ts header). */
  apply(envelope: CommandEnvelope): CommandOutcome;
  undo(): HistoryOutcome;
  redo(): HistoryOutcome;
  history(): HistoryAvailability;
  /** Hot: emits after every transaction that changed the document, local, remote or history. */
  readonly changes: Observable<DocumentChange>;
  /** Check the Y.Doc against yjs-schema.ts. Reports everything; repairs only per `repairPolicy`. */
  validate(): readonly ValidationIssue[];
  /**
   * Text range -> Yjs relative positions, for a comment anchored to text. null when the target or
   * the range does not exist.
   */
  encodeTextAnchor(range: TextRange): EncodedTextAnchor | null;
  /** Relative positions -> current indices; null where the anchored text is gone. */
  resolveTextAnchors(anchors: readonly EncodedTextAnchor[]): readonly (TextRange | null)[];
}

export type DocumentChangeOrigin =
  | Readonly<{ kind: "local"; commandId: CommandId }>
  | Readonly<{ kind: "remote" }>
  | Readonly<{ kind: "history"; direction: "undo" | "redo" }>
  | Readonly<{ kind: "seed" }>
  | Readonly<{ kind: "repair" }>;

export type DocumentChange = Readonly<{
  snapshot: DocumentSnapshot;
  origin: DocumentChangeOrigin;
  /**
   * Slides whose snapshot object changed identity in this transaction: slides REBUILT in the new
   * snapshot only. A slide deleted in the transaction is absent here; compare the slide list.
   */
  changedSlideIds: readonly SlideId[];
  /** True when theme, layouts, title, assets or transition scripts changed. */
  deckLevelChanged: boolean;
  /**
   * Every text body this transaction changed, as a delta in the body's OLD index space. The
   * reducer moves the caret, ranges, the composition start and the indices of queued text edits
   * through these (text-delta.ts). A body that was deleted is absent; the reducer drops what
   * pointed into it. A body CREATED in this transaction (a new element, or the first edit of a table
   * cell nobody had created yet) is absent too: nothing held an index into it.
   */
  textChanges: ReadonlyMap<TextTargetKey, TextDelta>;
  history: HistoryAvailability;
}>;

export type HistoryAvailability = Readonly<{ canUndo: boolean; canRedo: boolean }>;

export type HistoryOutcome =
  /** `skippedSteps`: steps passed over because collaborators had overwritten everything in them. */
  | Readonly<{ kind: "applied"; revision: number; selection: Selection; skippedSteps: number }>
  /** Nothing restorable; `skippedSteps > 0` means steps existed but collaborators had changed all of them. */
  | Readonly<{ kind: "nothingToDo"; skippedSteps: number }>;

export type TextRange = Readonly<{ target: TextTarget; start: number; end: number }>;

/** A text range as two base64 `Y.encodeRelativePosition`s plus the target they belong to. */
export type EncodedTextAnchor = Readonly<{ target: TextTarget; start: string; end: string }>;

export type ValidationProblem =
  | "missingKey"
  /** A text body whose last character is not its final paragraph mark (every body ends with "\n", yjs-schema.ts). */
  | "missingParagraphMark"
  | "wrongType"
  /** A value this client does not understand: reported, rendered as a placeholder, NEVER repaired. */
  | "unsupportedValue"
  | "danglingReference"
  | "groupCycle"
  | "emptyGroup"
  | "singleChildGroup"
  | "duplicateOrderKey"
  | "schemaTooNew";

export type ValidationIssue = Readonly<{
  /** Slash path into the Y.Doc, e.g. "slides/sl_x/elements/el_y/fill". */
  path: string;
  problem: ValidationProblem;
  message: string;
  /** What the repairing replica does about it; `"none"` on a report-only replica or for unsupported values. */
  repair:
    | "none"
    | "writeDefault"
    /** Append the final paragraph mark a text body lost, keeping its text. */
    | "appendParagraphMark"
    /** A dangling or cyclic child (the larger id of a cycle) moves to the top level, re-keyed into its group's place. */
    | "moveToTopLevel"
    | "deleteEmptyGroup"
    | "unwrapSingleChildGroup"
    | "rekeyOrder";
}>;

export type RepairPolicy = "repairAfterTransaction" | "reportOnly";

/** The model's factory. `seed` decides what an empty Y.Doc becomes. */
export type CreateDocumentStore = (options: Readonly<{
  sharedDocument: Doc;
  /** "blankDeck": default theme, layouts and one title slide, with this deck id. "none": a joining replica. */
  seed: Readonly<{ kind: "blankDeck"; deckId: string }> | Readonly<{ kind: "none" }>;
  /** Clock for `updatedAt` stamps and the typing merge window; injected for determinism. */
  now: () => number;
  /** For the random suffix of new order keys only (yjs-schema.ts). */
  random: RandomSource;
  /** Where repairs are scheduled, after the transaction that revealed them. */
  scheduler: SchedulerLike;
  repairPolicy: RepairPolicy;
  /** Typing in the same body within this window is one undo step (500 in the editor). */
  typingMergeWindowMilliseconds: number;
}>) => DocumentStore;

/**
 * Asset BYTES (document.ts `AssetRecord` holds only metadata). Milestone 1: in memory with object
 * addresses (`URL.createObjectURL`). Milestone 2: the deck server's content-addressed blob store.
 */
export interface AssetStore {
  /** Store bytes; resolves with their content address (SHA-256, hexadecimal). Idempotent. */
  put(bytes: ArrayBuffer, mediaType: AssetMediaType): Promise<AssetId>;
  /** An address an <img> in the editor's own origin can load, or null while the bytes are not here yet. */
  addressFor(assetId: AssetId): string | null;
  /**
   * Hot: emits an asset id when its bytes become loadable here (a peer's paste, fetched from the
   * server), so an image that rendered as a placeholder re-renders. The editor turns it into an
   * `assetAvailable` event.
   */
  readonly available: Observable<AssetId>;
  /**
   * A FRESH COPY of the bytes on every call (`slice(0)` of any cache), safe to put in a postMessage
   * transfer list: transferring detaches the buffer, and a cached buffer would be emptied for the
   * next transition.
   */
  copyBytesOf(assetId: AssetId): Promise<ArrayBuffer | null>;
}

/** The two-replica loopback the model provides for tests and the side-by-side demo. */
export type ConnectInMemory = (options: Readonly<{ first: Doc; second: Doc }>) => Disposable;

/** In-memory asset store for milestone 1 and tests. `createAddress` wraps `URL.createObjectURL` in the browser. */
export type CreateMemoryAssetStore = (options: Readonly<{
  createAddress: (bytes: ArrayBuffer, mediaType: AssetMediaType) => string;
  digest: (bytes: ArrayBuffer) => Promise<string>;
}>) => AssetStore;
