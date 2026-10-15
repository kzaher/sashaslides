// THE EDITOR'S COMPOSITION CONTRACT: what the "state" module exports and what the app shell (the
// view's demo page now, sashaslides.com/deck/<id> and the add-on dialog later) wires together.
// Every effectful dependency is injected here, once, at the composition root -- the stores, the
// scheduler, the presence channel, the session prefix -- so the reducer and every feedback can be
// tested with fakes and nothing reaches for a global.
//
// EVERY TIMER IN AN EDITOR FEEDBACK USES `scheduler`: presence throttling, upload retry backoff and
// the 20 second upload timeout, notice expiry. Tests pass a virtual-time scheduler and assert exact
// timings; no feedback calls `setTimeout` or `Date.now`.
//
// What the BROWSER only allows inside a user gesture -- clipboard writes, entering full screen,
// opening the speaker view window or a new tab -- is not here: the view's handlers do it directly
// through `BrowserCapabilities` and then dispatch what happened (editor-state.ts header).

import type { SchedulerLike } from "rxjs";
import type { CommentThread, DiscussionSnapshot, DiscussionStore, Person } from "./discussion.ts";
import type { AssetStore, DocumentStore, TextRange } from "./document-store.ts";
import type { DocumentSnapshot } from "./document.ts";
import type { EditorEvent } from "./editor-events.ts";
import type { ClipboardContent, ClipboardPayload, EditorEmbedding, EditorState } from "./editor-state.ts";
import type { Box, Size } from "./geometry.ts";
import type { ElementId, SlideId, ThreadId } from "./ids.ts";
import type { PresenceChannel } from "./presence.ts";
import type { PresenterDependencies } from "./presenter.ts";
import type { RunningSystem } from "./rxfeedback.ts";

export type EditorDependencies = Readonly<{
  documentStore: DocumentStore;
  discussionStore: DiscussionStore;
  assetStore: AssetStore;
  /** null: no collaboration transport (single-user demo). */
  presence: PresenceChannel | null;
  /** Every timer in every feedback (see the header). */
  scheduler: SchedulerLike;
  /** For the event log's timestamps only. */
  now: () => number;
  /** 8 random characters drawn once by the composition root (ids.ts `newSessionPrefix`). */
  sessionPrefix: string;
  me: Person;
  embedding: EditorEmbedding;
  /** Where reducer failures and feedback errors are reported (console in the demo). */
  reportError: (error: unknown, context: string) => void;
}>;

/** src/state/index.ts exports `createEditorSystem` of this type. */
export type CreateEditorSystem = (dependencies: EditorDependencies) => RunningSystem<EditorState, EditorEvent>;

/** src/state/index.ts exports `initialEditorState` of this type (pure; the tests' starting point). */
export type InitialEditorState = (options: Readonly<{
  me: Person;
  sessionPrefix: string;
  embedding: EditorEmbedding;
  document: DocumentSnapshot;
  discussion: DiscussionSnapshot;
  containerSize: Size;
}>) => EditorState;

/**
 * src/state/index.ts exports `clipboardContentFor` of this type: what a copy or cut of the current
 * selection produces, or null when nothing copyable is selected. The view's copy handler calls it
 * synchronously and writes the result (plus the markup it renders) into the clipboard. The payload
 * carries `operation`, because only a cut keeps ids when pasted back into the same deck.
 */
export type ClipboardContentFor = (state: EditorState, operation: ClipboardPayload["operation"]) => ClipboardContent | null;

/** Where a thread shows, after its anchor's fate (discussion.ts "anchors degrade"). */
export type ThreadPlacement =
  | Readonly<{ kind: "onElement"; slideId: SlideId; elementId: ElementId; box: Box; textRange: TextRange | null }>
  | Readonly<{ kind: "elementRemoved"; slideId: SlideId; box: Box }>
  | Readonly<{ kind: "onSlide"; slideId: SlideId; box: Box }>
  | Readonly<{ kind: "slideRemoved" }>;

export type ArrangedThread = Readonly<{ thread: CommentThread; placement: ThreadPlacement }>;

/**
 * src/state/index.ts exports `arrangeThreads` of this type: threads in slide order, then creation
 * time, each with its placement. Pure; the comment rail and the canvas pins both read it.
 */
export type ArrangeThreads = (input: Readonly<{
  discussion: DiscussionSnapshot;
  document: DocumentSnapshot;
  resolvedTextAnchors: ReadonlyMap<ThreadId, TextRange | null>;
}>) => readonly ArrangedThread[];

/** The media type the engine's own clipboard payload travels under in a DataTransfer. */
export const ENGINE_CLIPBOARD_MEDIA_TYPE = "application/x-sasha-engine+json";

/**
 * The browser operations a user gesture must perform synchronously, injected into the view so its
 * handlers stay testable. Each is called INSIDE the click or key handler, before any dispatch.
 */
export type BrowserCapabilities = Readonly<{
  /** Asynchronous clipboard write for menu copy (keyboard copy fills the `copy` event's DataTransfer). */
  writeClipboard: (content: Readonly<{ plainText: string; markup: string; enginePayloadText: string }>) => Promise<void>;
  requestFullScreen: (element: Element) => Promise<void>;
  /** Leave full screen when the presentation ends; nothing when the page is not full screen. */
  exitFullScreen: () => Promise<void>;
  /** The speaker view window; null when a popup blocker refused it. */
  openSpeakerWindow: () => Window | null;
  /** A top-level tab (the add-on's Present, "Open in a new tab"). */
  openTab: (address: string) => void;
}>;

/** src/view/index.ts exports `EditorApplication`, a React component with these properties. */
export type EditorApplicationProperties = Readonly<{
  system: RunningSystem<EditorState, EditorEvent>;
  assetStore: AssetStore;
  browser: BrowserCapabilities;
  presenterDependencies: PresenterDependencies;
  /** The state module's pure selectors, passed in by the composition root so the view never imports the state module. */
  clipboardContentFor: ClipboardContentFor;
  arrangeThreads: ArrangeThreads;
}>;
