// THE EDITOR OVER A SYNCED REPLICA (SPEC.md 21.8): the composition the view's demo does in
// compose-editor.ts, with the deck's real collaboration session, the HTTP asset store, the
// awareness presence channel and the WebSocket discussion store instead of in-memory stand-ins,
// and the viewer's recent colours kept in local storage.
//
// Key decisions:
//
//  * ONE EDITOR PER REPLICA. The deck workspace (deck-workspace.ts) composes this after the
//    replica's first sync and disposes it before a resynchronise, so the editor never outlives the
//    document it was built on.
//  * THE EDITOR'S TIMERS RUN ON THE REAL SCHEDULER, its clock is the page's; both are passed here
//    once, never reached for below (editor-system.ts header).

import { asyncScheduler, distinctUntilChanged, map, type Subscription } from "rxjs";
import type { Person } from "../../contracts/discussion.ts";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorEmbedding, EditorState } from "../../contracts/editor-state.ts";
import type { ArrangeThreads, BrowserCapabilities, ClipboardContentFor } from "../../contracts/editor-system.ts";
import { newSessionPrefix } from "../../contracts/ids.ts";
import type { PresenterDependencies } from "../../contracts/presenter.ts";
import type { RunningSystem } from "../../contracts/rxfeedback.ts";
import { arrangeThreads, clipboardContentFor, createEditorSystem, createSystem, react, reactSet } from "../../state/index.ts";
import { pageBrowserCapabilities } from "../../view/application/browser-services.ts";
import { googleFontFiles, pageVisibility } from "../../view/application/compose-editor.ts";
import { renderSlideMarkup, StaticSlide } from "../../view/index.ts";
import type { DeckReplica } from "./deck-workspace.ts";
import { readRecentColours, writeRecentColours, type ColourStorage } from "./recent-colours.ts";

export type DeckEditor = Disposable &
  Readonly<{
    system: RunningSystem<EditorState, EditorEvent>;
    assetStore: AssetStore;
    browser: BrowserCapabilities;
    presenterDependencies: PresenterDependencies;
    clipboardContentFor: ClipboardContentFor;
    arrangeThreads: ArrangeThreads;
  }>;

export function composeDeckEditor(options: Readonly<{
  page: Window;
  replica: DeckReplica;
  assetStore: AssetStore;
  me: Person;
  embedding: EditorEmbedding;
  runnerAddress: string;
  storage: () => ColourStorage;
  reportError: (error: unknown, context: string) => void;
}>): DeckEditor {
  const { page, replica, reportError } = options;
  const now = (): number => Date.now();
  const sessionPrefix = newSessionPrefix(Math.random);
  const collaboration = replica.collaboration;
  const system = createEditorSystem({
    documentStore: replica.documentStore,
    discussionStore: collaboration.discussionStore,
    assetStore: options.assetStore,
    presence: collaboration.presence,
    collaboration: collaboration.session,
    recentColours: readRecentColours(options.storage),
    scheduler: asyncScheduler,
    now,
    sessionPrefix,
    me: options.me,
    embedding: options.embedding,
    reportError,
  });
  const remembering: Subscription = system.state$
    .pipe(
      map((state) => state.chrome.recentColours),
      distinctUntilChanged(),
    )
    .subscribe((colours) => writeRecentColours({ storage: options.storage, colours }));
  const presenterDependencies: PresenterDependencies = {
    rxFeedback: { createSystem, react, reactSet },
    StaticSlide,
    renderSlideMarkup,
    assetStore: options.assetStore,
    fontFiles: (faces) => googleFontFiles({ page, faces, reportError }),
    runnerAddress: options.runnerAddress,
    scheduler: asyncScheduler,
    now,
    sessionPrefix,
    prefersReducedMotion: () => page.matchMedia("(prefers-reduced-motion: reduce)").matches,
    pageVisibility: pageVisibility(page),
    reportError,
  };
  return {
    system,
    assetStore: options.assetStore,
    browser: pageBrowserCapabilities(page),
    presenterDependencies,
    clipboardContentFor,
    arrangeThreads,
    [Symbol.dispose]: () => {
      remembering.unsubscribe();
      system[Symbol.dispose]();
    },
  };
}
