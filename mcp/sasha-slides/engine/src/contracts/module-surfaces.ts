// WHAT EACH MODULE'S index.ts EXPORTS, as types, so the four modules can be built in parallel and
// still compose on day one. The architect ships a STUB index.ts for each module that satisfies its
// surface and throws "not built yet"; the builder replaces the stub's insides, never its shape.
// The view's app shell (the composition root) imports the other three through these surfaces, and
// typechecks against them before any of them is built.

import type { ComponentType } from "react";
import type { ConnectInMemory, CreateDocumentStore, CreateMemoryAssetStore } from "./document-store.ts";
import type { CreateMemoryDiscussionStore, ReduceDiscussionLog } from "./discussion.ts";
import type {
  ArrangeThreads,
  ClipboardContentFor,
  CreateEditorSystem,
  EditorApplicationProperties,
  InitialEditorState,
} from "./editor-system.ts";
import type { CreateMemoryPresenceHub } from "./presence.ts";
import type { BuildPreviewProperties, PresentationProperties, TransitionPreviewProperties } from "./presenter.ts";
import type { RenderSlideMarkup, StaticSlideComponent } from "./render.ts";
import type { CreateReactFeedback, CreateReactSetFeedback, CreateSystem } from "./rxfeedback.ts";

/** src/model/index.ts */
export type ModelModule = Readonly<{
  createDocumentStore: CreateDocumentStore;
  createMemoryDiscussionStore: CreateMemoryDiscussionStore;
  reduceDiscussionLog: ReduceDiscussionLog;
  createMemoryAssetStore: CreateMemoryAssetStore;
  connectInMemory: ConnectInMemory;
  createMemoryPresenceHub: CreateMemoryPresenceHub;
}>;

/** src/state/index.ts */
export type StateModule = Readonly<{
  createSystem: CreateSystem;
  react: CreateReactFeedback;
  reactSet: CreateReactSetFeedback;
  createEditorSystem: CreateEditorSystem;
  initialEditorState: InitialEditorState;
  clipboardContentFor: ClipboardContentFor;
  arrangeThreads: ArrangeThreads;
}>;

/** src/view/index.ts */
export type ViewModule = Readonly<{
  StaticSlide: StaticSlideComponent;
  renderSlideMarkup: RenderSlideMarkup;
  EditorApplication: ComponentType<EditorApplicationProperties>;
}>;

/** src/presenter/index.ts */
export type PresenterModule = Readonly<{
  Presentation: ComponentType<PresentationProperties>;
  TransitionPreview: ComponentType<TransitionPreviewProperties>;
  BuildPreview: ComponentType<BuildPreviewProperties>;
}>;

/**
 * build-presenter.ts (presenter module) exports `buildPresenterAssets`; build-demo.ts (view
 * module) calls it. Writes the runner page and its bootstrap DIRECTLY into `outputDirectory` (no
 * subdirectory), so the caller passes the directory it serves on the runner's site (dist/runner)
 * and addresses the page by the returned `runnerPagePath`, never by a guessed file name.
 */
export type BuildPresenterAssets = (options: Readonly<{ outputDirectory: string; minify: boolean }>) => Promise<
  Readonly<{
    /** The runner page's path relative to `outputDirectory`. */
    runnerPagePath: string;
    /** The header the server must send with the runner page (transition-protocol.ts header). */
    runnerContentSecurityPolicy: string;
  }>
>;
