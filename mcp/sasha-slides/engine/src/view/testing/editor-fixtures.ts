// FAKES FOR THE VIEW'S TESTS AND THE CHROME HARNESS: an `EditorState` built from a document without
// the state module, a `RunningSystem` that records every dispatched event (optionally reducing them
// with a small harness reducer), fake browser capabilities that record call order, and the services
// bundle the application shell would otherwise build. The view is tested against the CONTRACTS, so
// it can be built, tested and screenshotted before -- and independently of -- the state module.

import { BehaviorSubject, EMPTY, asyncScheduler, of } from "rxjs";
import type { DocumentSnapshot, Paragraph } from "../../contracts/document.ts";
import { LOCAL_COLLABORATION_STATUS } from "../../contracts/collaboration.ts";
import { EMPTY_DISCUSSION, type Person } from "../../contracts/discussion.ts";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorChrome, EditorEmbedding, EditorState } from "../../contracts/editor-state.ts";
import { STANDALONE_EDITOR_HOST, type ArrangeThreads, type BrowserCapabilities, type ClipboardContentFor, type EditorHost } from "../../contracts/editor-system.ts";
import { parsePersonId, type AssetId } from "../../contracts/ids.ts";
import type { PresenterDependencies } from "../../contracts/presenter.ts";
import type { LoggedEvent, RunningSystem } from "../../contracts/rxfeedback.ts";
import { requireParsed } from "../../contracts/testing/snapshot-builders.ts";
import type { EditorServices } from "../application/editor-services.tsx";

export const FIXTURE_PERSON: Person = { id: personId("person_ada"), displayName: "Ada Lovelace", colourIndex: 0, kind: "person" };

export const CLOSED_CHROME: EditorChrome = {
  propertiesTab: "arrange",
  propertiesPanelOpen: true,
  filmstripOpen: true,
  speakerNotesOpen: true,
  commentsOpen: false,
  openMenu: null,
  contextMenu: null,
  dialog: { kind: "none" },
  composer: { kind: "closed" },
  focusedThreadId: null,
  showResolvedThreads: false,
  aspectRatioLocked: false,
  transitionPreview: null,
  selectedAnimationStepId: null,
  buildPreview: null,
  recentColours: [],
};

/** A complete editor state over `document`, as the state module's `initialEditorState` would make it. */
export function fixtureEditorState(options: Readonly<{ document: DocumentSnapshot; embedding?: EditorEmbedding; scale?: number }>): EditorState {
  const scale = options.scale ?? 0.6;
  return {
    me: FIXTURE_PERSON,
    idSeed: { sessionPrefix: "Fixture1", counter: 0 },
    embedding: options.embedding ?? { kind: "webApplication" },
    document: options.document,
    discussion: EMPTY_DISCUSSION,
    history: { canUndo: true, canRedo: false },
    currentSlideId: options.document.slides[0]?.id ?? null,
    selection: { kind: "none" },
    enteredGroupId: null,
    tool: { kind: "select" },
    gesture: { kind: "idle" },
    textEditing: { typingStyle: {}, composition: null, renderGeneration: 0 },
    viewport: { containerSize: { width: 1280 * scale + 80, height: 720 * scale + 80 }, zoom: { kind: "fit" }, scale, scroll: { x: 0, y: 0 } },
    clipboard: { pasteCascade: null },
    pendingEdits: [],
    inFlightCommandIds: [],
    pendingDiscussion: [],
    inFlightDiscussion: [],
    resolvedTextAnchors: new Map(),
    uploads: [],
    availableAssetIds: new Set<AssetId>(),
    measuredLayouts: new Map(),
    pointer: null,
    peers: [],
    collaboration: LOCAL_COLLABORATION_STATUS,
    pendingAgentReverts: [],
    chrome: CLOSED_CHROME,
    notices: [],
    presentation: null,
  };
}

export type RecordingSystem = RunningSystem<EditorState, EditorEvent> & Readonly<{ dispatched: readonly EditorEvent[] }>;

/** A running system over a reducer (identity by default) that records every event it is given. */
export function createRecordingSystem(options: Readonly<{ initial: EditorState; reduce?: (state: EditorState, event: EditorEvent) => EditorState }>): RecordingSystem {
  const subject = new BehaviorSubject<EditorState>(options.initial);
  const dispatched: EditorEvent[] = [];
  const log: LoggedEvent<EditorEvent>[] = [];
  const reduce = options.reduce ?? ((state: EditorState) => state);
  return {
    state$: subject.asObservable(),
    dispatched,
    currentState: () => subject.getValue(),
    dispatch: (event) => {
      dispatched.push(event);
      log.push({ sequence: log.length + 1, at: 0, source: "dispatch", event, reducerFailed: false });
      const next = reduce(subject.getValue(), event);
      if (next !== subject.getValue()) subject.next(next);
    },
    recentEvents: () => log,
    [Symbol.dispose]: () => subject.complete(),
  };
}

export type CapabilityCall = Readonly<{ name: "writeClipboard" | "requestFullScreen" | "exitFullScreen" | "openSpeakerWindow" | "openTab"; detail: string }>;

/** Browser capabilities that do nothing but record what was asked of them, in order. */
export function recordingCapabilities(calls: CapabilityCall[]): BrowserCapabilities {
  return {
    writeClipboard: (content) => {
      calls.push({ name: "writeClipboard", detail: content.plainText });
      return Promise.resolve();
    },
    requestFullScreen: () => {
      calls.push({ name: "requestFullScreen", detail: "" });
      return Promise.resolve();
    },
    exitFullScreen: () => {
      calls.push({ name: "exitFullScreen", detail: "" });
      return Promise.resolve();
    },
    openSpeakerWindow: () => {
      calls.push({ name: "openSpeakerWindow", detail: "" });
      return null;
    },
    openTab: (address) => {
      calls.push({ name: "openTab", detail: address });
    },
  };
}

export const EMPTY_ASSET_STORE: AssetStore = {
  put: () => Promise.reject(new Error("The fixture asset store holds nothing.")),
  addressFor: () => null,
  available: EMPTY,
  copyBytesOf: () => Promise.resolve(null),
};

/** Services for a test or the harness; the presenter and selectors are inert unless overridden. */
export function fixtureServices(options: Readonly<{
  system: RunningSystem<EditorState, EditorEvent>;
  browser?: BrowserCapabilities;
  clipboardContentFor?: ClipboardContentFor;
  arrangeThreads?: ArrangeThreads;
  assetStore?: AssetStore;
  richTextFrom?: (markup: string) => readonly Paragraph[] | null;
  measurePointerMoves?: boolean;
  host?: EditorHost;
  now?: () => number;
}>): EditorServices {
  const assetStore = options.assetStore ?? EMPTY_ASSET_STORE;
  return {
    system: options.system,
    browser: options.browser ?? recordingCapabilities([]),
    assetStore,
    assetAddress: (assetId) => assetStore.addressFor(assetId),
    presenterDependencies: inertPresenterDependencies(),
    clipboardContentFor: options.clipboardContentFor ?? (() => null),
    arrangeThreads: options.arrangeThreads ?? (() => []),
    Presentation: () => null,
    TransitionPreview: () => null,
    BuildPreview: () => null,
    primaryModifier: "control",
    richTextFrom: options.richTextFrom ?? (() => null),
    readImageFile: () => Promise.resolve(null),
    measurePointerMoves: options.measurePointerMoves ?? false,
    host: options.host ?? STANDALONE_EDITOR_HOST,
    now: options.now ?? (() => 0),
  };
}

function inertPresenterDependencies(): PresenterDependencies {
  return {
    rxFeedback: {
      createSystem: () => {
        throw new Error("The fixture has no presenter.");
      },
      react: () => () => EMPTY,
      reactSet: () => () => EMPTY,
    },
    StaticSlide: () => null,
    renderSlideMarkup: () => ({ markup: "", elements: [], assetIds: [], fontFaces: [] }),
    assetStore: EMPTY_ASSET_STORE,
    fontFiles: () => Promise.resolve([]),
    runnerAddress: "about:blank",
    scheduler: asyncScheduler,
    now: () => 0,
    sessionPrefix: "Fixture1",
    prefersReducedMotion: () => true,
    pageVisibility: of(true),
    reportError: () => undefined,
  };
}

function personId(text: string): Person["id"] {
  return requireParsed(parsePersonId, text);
}
