// WHAT EVERY VIEW COMPONENT CAN REACH: the running editor system, the browser operations a user
// gesture performs, the presenter, and the state module's pure selectors -- injected once by the
// application shell through one React context, so a component deep in the canvas or a panel never
// imports a module it would then be impossible to replace in a test or the chrome harness.
//
// Key decisions:
//
//  * COMPONENTS SUBSCRIBE TO SLICES. `useEditorSelector` re-renders a component only when the slice
//    it selects changes (by `isEqual`), over `useSyncExternalStore`. A pointer move during a drag
//    changes `gesture` and nothing else, so the filmstrip, the panels and the menus do not render at
//    all -- which is what keeps a drag inside its 4 millisecond budget (SPEC.md section 17).
//  * THE STATE MODULE'S SELECTORS ARE SERVICES (`clipboardContentFor`, `arrangeThreads`) rather than
//    imports, because `EditorApplicationProperties` (editor-system.ts) does not carry them and the
//    view must stay testable with fakes before and after the state module exists.
//  * THE HOST'S ADDITIONS ARE A SERVICE TOO (`host`, contracts/editor-system.ts `EditorHost`): the
//    web module's Share button, account menu and File items reach the top bar and the menus without
//    the view importing the web module.
//  * VIEWING PREFERENCES THAT ARE NOT EDITOR STATE live in the shell (`ViewPreferencesContext`):
//    whether comment markings are drawn ("View > Show annotations") is this viewer's choice for
//    this page, read by the canvas and the View menu, and nothing else needs it.

import { createContext, useCallback, useContext, useRef, useSyncExternalStore, type ComponentType } from "react";
import type { Paragraph } from "../../contracts/document.ts";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { ChosenImageFile, EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorState } from "../../contracts/editor-state.ts";
import type { ArrangeThreads, BrowserCapabilities, ClipboardContentFor, EditorHost } from "../../contracts/editor-system.ts";
import type { BuildPreviewProperties, PresentationProperties, PresenterDependencies, TransitionPreviewProperties } from "../../contracts/presenter.ts";
import type { AssetAddressResolver } from "../../contracts/render.ts";
import type { RunningSystem } from "../../contracts/rxfeedback.ts";
import type { GestureContext } from "./gesture-handlers.ts";

export type EditorServices = Readonly<{
  system: RunningSystem<EditorState, EditorEvent>;
  browser: BrowserCapabilities;
  assetStore: AssetStore;
  /** `assetStore.addressFor`, bound once so the renderer's memoisation sees one function. */
  assetAddress: AssetAddressResolver;
  presenterDependencies: PresenterDependencies;
  clipboardContentFor: ClipboardContentFor;
  arrangeThreads: ArrangeThreads;
  Presentation: ComponentType<PresentationProperties>;
  TransitionPreview: ComponentType<TransitionPreviewProperties>;
  /** The Animate tab's Preview: the slide's builds, played once over the canvas. */
  BuildPreview: ComponentType<BuildPreviewProperties>;
  /** Cmd on macOS, Ctrl elsewhere (editor-state.ts `Modifiers.primary`). */
  primaryModifier: "control" | "meta";
  /** Rich text from a paste or drop, reduced to the engine's styles; null when the markup has none. */
  richTextFrom: (markup: string) => readonly Paragraph[] | null;
  /** Reads an image file's bytes and pixel size; null for a file that is not a supported image. */
  readImageFile: (file: File) => Promise<ChosenImageFile | null>;
  /** Marks every canvas pointer move and measures it to its commit (the drag budget, e2e only). */
  measurePointerMoves: boolean;
  /** The page hosting the editor: the logo's address, the top bar accessory, File menu items. */
  host: EditorHost;
  /** The clock presence reads to show a silent peer as away, then gone (chrome/presence.ts). */
  now: () => number;
}>;

/** This viewer's display choices that are not editor state (see the header). */
export type ViewPreferences = Readonly<{ showAnnotations: boolean; toggleAnnotations: () => void }>;

export const ViewPreferencesContext = createContext<ViewPreferences>({ showAnnotations: true, toggleAnnotations: () => undefined });

export function useViewPreferences(): ViewPreferences {
  return useContext(ViewPreferencesContext);
}

export const EditorServicesContext = createContext<EditorServices | null>(null);

/**
 * Where popovers render: a layer at the end of the editor root, above every panel. A popover drawn
 * inside the panel that opened it would sit in that panel's stacking context, under the next panel.
 */
export const FloatingLayerContext = createContext<HTMLElement | null>(null);

/** The shell's gesture context (gesture-handlers.ts): the presentation host and the speaker window slot. */
export const EditorGestureContext = createContext<GestureContext | null>(null);

export function useGestureContext(): GestureContext {
  const context = useContext(EditorGestureContext);
  if (context === null) throw new Error("A view component rendered outside the editor application.");
  return context;
}

export function useEditorServices(): EditorServices {
  const services = useContext(EditorServicesContext);
  if (services === null) throw new Error("A view component rendered outside the editor application.");
  return services;
}

/** A slice of the editor state; the component re-renders only when the slice changes (see the header). */
export function useEditorSelector<TSlice>(selector: (state: EditorState) => TSlice, isEqual: (previous: TSlice, next: TSlice) => boolean = Object.is): TSlice {
  const system = useEditorServices().system;
  const cache = useRef<Readonly<{ state: EditorState; selector: (state: EditorState) => TSlice; slice: TSlice }> | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      const subscription = system.state$.subscribe(() => notify());
      return () => subscription.unsubscribe();
    },
    [system],
  );
  const read = (): TSlice => {
    const state = system.currentState();
    const cached = cache.current;
    if (cached !== null && cached.state === state && cached.selector === selector) return cached.slice;
    const slice = selector(state);
    if (cached !== null && isEqual(cached.slice, slice)) {
      cache.current = { state, selector, slice: cached.slice };
      return cached.slice;
    }
    cache.current = { state, selector, slice };
    return slice;
  };
  return useSyncExternalStore(subscribe, read, read);
}

/** Shallow equality for selector results that are small records of already-shared values. */
export function shallowEqual<TRecord extends Readonly<Record<string, unknown>>>(previous: TRecord, next: TRecord): boolean {
  const previousKeys = Object.keys(previous);
  if (previousKeys.length !== Object.keys(next).length) return false;
  return previousKeys.every((key) => Object.is(previous[key], next[key]));
}

/** Element-wise identity for selector results that are arrays of shared values. */
export function arrayItemsEqual<TItem>(previous: readonly TItem[], next: readonly TItem[]): boolean {
  return previous.length === next.length && previous.every((item, index) => Object.is(item, next[index]));
}
