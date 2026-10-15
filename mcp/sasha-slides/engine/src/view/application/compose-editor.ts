// THE COMPOSITION ROOT: where the real model, state and presenter are wired together for one editor
// on one page. Every effectful dependency is created here, once -- the scheduler, the clocks, the
// random session prefix, the browser capabilities, the presenter's dependencies -- and passed down
// (editor-system.ts header); nothing below reaches for a global. The demo uses it with in-memory
// stores; the deck page at sashaslides.com/deck/<id> (the web module) passes a synced document, the
// deck server's `CollaborationSession` and the viewer's remembered recent colours.
//
// Key decisions:
//
//  * THE RUNNER IS ANOTHER SITE (transition-protocol.ts header): its address comes from the page's
//    configuration, written by build-demo.ts, never guessed from the editor's own origin.
//  * FONT BYTES FOR THE SANDBOX come from Google Fonts' stylesheet for each face (the runner has no
//    network); a face that cannot be fetched is left out and the runner falls back to system fonts.

import { asyncScheduler, fromEvent, map, startWith, type Observable } from "rxjs";
import type { CollaborationSession } from "../../contracts/collaboration.ts";
import type { DiscussionStore, Person } from "../../contracts/discussion.ts";
import type { AssetStore, DocumentStore } from "../../contracts/document-store.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorEmbedding, EditorState } from "../../contracts/editor-state.ts";
import type { ArrangeThreads, BrowserCapabilities, ClipboardContentFor } from "../../contracts/editor-system.ts";
import { newSessionPrefix } from "../../contracts/ids.ts";
import type { PresenceChannel } from "../../contracts/presence.ts";
import type { PresenterDependencies } from "../../contracts/presenter.ts";
import type { FontFaceRequest } from "../../contracts/render.ts";
import type { RunningSystem } from "../../contracts/rxfeedback.ts";
import type { Colour } from "../../contracts/style.ts";
import type { TransferredFont } from "../../contracts/transition-protocol.ts";
import { arrangeThreads, clipboardContentFor, createEditorSystem, createSystem, react, reactSet } from "../../state/index.ts";
import { renderSlideMarkup } from "../render/slide-markup.tsx";
import { StaticSlide } from "../render/static-slide.tsx";
import { pageBrowserCapabilities } from "./browser-services.ts";

export type ComposedEditor = Disposable &
  Readonly<{
    system: RunningSystem<EditorState, EditorEvent>;
    browser: BrowserCapabilities;
    presenterDependencies: PresenterDependencies;
    clipboardContentFor: ClipboardContentFor;
    arrangeThreads: ArrangeThreads;
  }>;

export function composeEditor(options: Readonly<{
  page: Window;
  documentStore: DocumentStore;
  discussionStore: DiscussionStore;
  assetStore: AssetStore;
  presence: PresenceChannel | null;
  /** The deck server session; null for a local deck (the demo). */
  collaboration: CollaborationSession | null;
  /** The viewer's remembered "Recent" colours, most recent first. */
  recentColours: readonly Colour[];
  me: Person;
  embedding: EditorEmbedding;
  runnerAddress: string;
}>): ComposedEditor {
  const page = options.page;
  const now = (): number => Date.now();
  const reportError = (error: unknown, context: string): void => console.error(`[sasha engine] ${context}`, error);
  const sessionPrefix = newSessionPrefix(Math.random);
  const system = createEditorSystem({
    documentStore: options.documentStore,
    discussionStore: options.discussionStore,
    assetStore: options.assetStore,
    presence: options.presence,
    collaboration: options.collaboration,
    recentColours: options.recentColours,
    scheduler: asyncScheduler,
    now,
    sessionPrefix,
    me: options.me,
    embedding: options.embedding,
    reportError,
  });
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
    browser: pageBrowserCapabilities(page),
    presenterDependencies,
    clipboardContentFor,
    arrangeThreads,
    [Symbol.dispose]: () => system[Symbol.dispose](),
  };
}

/** `document.visibilityState === "visible"`, now and on every change. */
export function pageVisibility(page: Window): Observable<boolean> {
  return fromEvent(page.document, "visibilitychange").pipe(
    map(() => page.document.visibilityState === "visible"),
    startWith(page.document.visibilityState === "visible"),
  );
}

/** Font bytes for the runner, one Google Fonts file per face (see the header). */
export async function googleFontFiles(options: Readonly<{ page: Window; faces: readonly FontFaceRequest[]; reportError: (error: unknown, context: string) => void }>): Promise<readonly TransferredFont[]> {
  const fonts = await Promise.all(
    options.faces.map(async (face): Promise<TransferredFont | null> => {
      try {
        const italic = face.style === "italic" ? 1 : 0;
        const stylesheet = await options.page.fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(face.family).replace(/%20/g, "+")}:ital,wght@${italic},${face.weight}&display=swap`).then((response) => (response.ok ? response.text() : ""));
        const latin = /\/\* latin \*\/[^}]*?url\((https:[^)]+)\)/.exec(stylesheet)?.[1] ?? /url\((https:[^)]+)\)/.exec(stylesheet)?.[1];
        if (latin === undefined) return null;
        const bytes = await options.page.fetch(latin).then((response) => response.arrayBuffer());
        return { family: face.family, weight: face.weight, style: face.style, bytes };
      } catch (error) {
        options.reportError(error, `loading the font ${face.family} for a transition`);
        return null;
      }
    }),
  );
  return fonts.filter((font): font is TransferredFont => font !== null);
}
