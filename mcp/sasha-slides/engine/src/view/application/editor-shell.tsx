// THE EDITOR SHELL: the whole editor screen in Tidepool -- the calm ground under a top bar, a
// toolbar, the filmstrip, the canvas with its speaker notes, and the properties panel or the comment
// rail -- plus everything that floats (menus, dialogs, notices) and the host the presenter mounts
// into. `EditorApplication` (the module's export) is this shell with the real services; the chrome
// harness and the tests give it fakes.
//
// Key decisions:
//
//  * KEYBOARD AND CLIPBOARD LISTEN ON THE SHELL'S ROOT, not the page, so two editors side by side
//    (the presence demo) each hear only their own keys. Keys pressed in the inline text editor or in
//    a field are theirs; everything else becomes `keyPressed` for the state module's key map, except
//    primary+Enter, which must enter full screen inside the key event and so presents from here.
//  * THE PRESENTATION HOST IS ALWAYS MOUNTED, so the Present handler has an element to make full
//    screen synchronously; the presenter renders into it once `presentation` is set.
//  * `data-gesture="active"` ON THE ROOT pauses the calm wash while something is dragged and drops
//    the panels' backdrop blur (the shared stylesheet's rules): nothing moves behind a slide being
//    edited, and nothing is re-blurred per pointer move.
//  * A CLOSED CONNECTION IS A BANNER under the top bar with the reason; the editor is read-only
//    (the reducer refuses edits, the controls say why).
//  * ARROW KEYS IN A PILL GROUP STAY THERE: a focused tab or segmented choice owns the arrow keys,
//    Home and End (chrome/pill-group.ts), so they never become a nudge of the selected element.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { Gesture } from "../../contracts/editor-state.ts";
import type { SlideId } from "../../contracts/ids.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { EditableCanvas } from "../canvas/editable-canvas.tsx";
import { CLOSED_EXPLANATION, closedReason } from "../chrome/access.ts";
import { CommentRail } from "../chrome/comment-rail.tsx";
import { DialogLayer } from "../chrome/dialogs.tsx";
import { Filmstrip } from "../chrome/filmstrip.tsx";
import { ContextMenuLayer } from "../chrome/menus.tsx";
import { PropertiesPanel } from "../chrome/properties-panel.tsx";
import { Notices, SpeakerNotes } from "../chrome/speaker-notes.tsx";
import { PILL_GROUP_KEYS, PILL_GROUP_SELECTOR } from "../chrome/pill-group.ts";
import { Toolbar, TopBar } from "../chrome/top-bar.tsx";
import { TEXT_EDITOR_ATTRIBUTE } from "../text/inline-text-editor.tsx";
import { chordOf, modifiersOf } from "../text/text-editor-handlers.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { loadDeckFonts } from "./browser-services.ts";
import { EditorGestureContext, EditorServicesContext, FloatingLayerContext, ViewPreferencesContext, shallowEqual, useEditorSelector, useEditorServices, type EditorServices, type ViewPreferences } from "./editor-services.tsx";
import { handleClipboardWrite, handlePaste, handlePresent, type GestureContext } from "./gesture-handlers.ts";

export function EditorShell(properties: Readonly<{ services: EditorServices }>): ReactElement {
  const services = properties.services;
  const presentationHost = useRef<HTMLDivElement>(null);
  const speakerWindow = useRef<Window | null>(null);
  const gesture = useMemo<GestureContext>(
    () => ({ system: services.system, browser: services.browser, clipboardContentFor: services.clipboardContentFor, presentationHost: () => presentationHost.current, speakerWindow }),
    [services],
  );
  const [showAnnotations, setShowAnnotations] = useState(true);
  const toggleAnnotations = useCallback(() => setShowAnnotations((shown) => !shown), []);
  const preferences = useMemo<ViewPreferences>(() => ({ showAnnotations, toggleAnnotations }), [showAnnotations, toggleAnnotations]);
  return (
    <EditorServicesContext.Provider value={services}>
      <EditorGestureContext.Provider value={gesture}>
        <ViewPreferencesContext.Provider value={preferences}>
          <EditorScreen gesture={gesture} presentationHost={presentationHost} />
        </ViewPreferencesContext.Provider>
      </EditorGestureContext.Provider>
    </EditorServicesContext.Provider>
  );
}

function EditorScreen(properties: Readonly<{ gesture: GestureContext; presentationHost: RefObject<HTMLDivElement | null> }>): ReactElement {
  const services = useEditorServices();
  const view = useEditorSelector(
    (state) => ({
      gestureActive: gestureIsActive(state.gesture),
      filmstripOpen: state.chrome.filmstripOpen,
      side: state.chrome.commentsOpen ? "comments" : state.chrome.propertiesPanelOpen ? "properties" : "none",
      presentation: state.presentation,
      document: state.document,
      closed: closedReason(state.collaboration),
    }),
    shallowEqual,
  );
  const loadedFonts = useRef(new Set<string>(["Manrope"]));
  const [floatingLayer, setFloatingLayer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    loadDeckFonts({ page: document, document: view.document, loaded: loadedFonts.current });
  }, [view.document]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => handleShellKey({ event, gesture: properties.gesture, primaryModifier: services.primaryModifier });
  const Presentation = services.Presentation;
  return (
    <FloatingLayerContext.Provider value={floatingLayer}>
    <div
      className={`${TIDEPOOL_CLASS.root} ${TIDEPOOL_CLASS.calmGround} ${VIEW_CLASS.editor}`}
      data-gesture={view.gestureActive ? "active" : "idle"}
      data-banner={view.closed === null ? "false" : "true"}
      onKeyDown={onKeyDown}
      onCopy={(event) => {
        if (!ownsClipboardEvent(event.target)) return;
        handleClipboardWrite({ context: properties.gesture, event: event.nativeEvent, operation: "copy" });
      }}
      onCut={(event) => {
        if (!ownsClipboardEvent(event.target)) return;
        handleClipboardWrite({ context: properties.gesture, event: event.nativeEvent, operation: "cut" });
      }}
      onPaste={(event) => {
        if (!ownsClipboardEvent(event.target)) return;
        handlePaste({ context: properties.gesture, event: event.nativeEvent, at: null, richTextFrom: services.richTextFrom, readImageFile: services.readImageFile });
      }}
    >
      <TopBar />
      {view.closed === null ? null : (
        <div className={VIEW_CLASS.readOnlyBanner} role="alert">
          <strong>Read-only.</strong>
          <span>{CLOSED_EXPLANATION[view.closed]}</span>
        </div>
      )}
      <Toolbar />
      <div className={VIEW_CLASS.workspace} data-filmstrip={view.filmstripOpen ? "open" : "closed"} data-side={view.side === "none" ? "closed" : "open"}>
        {view.filmstripOpen ? <Filmstrip /> : null}
        <main className={VIEW_CLASS.centre}>
          <EditableCanvas />
          <SpeakerNotes />
        </main>
        {view.side === "comments" ? <CommentRail /> : view.side === "properties" ? <PropertiesPanel /> : null}
      </div>
      <ContextMenuLayer gesture={properties.gesture} />
      <DialogLayer />
      <Notices />
      <div ref={setFloatingLayer} className={VIEW_CLASS.floatingLayer} />
      <div ref={properties.presentationHost} className={VIEW_CLASS.presentationHost} data-active={view.presentation === null ? "false" : "true"}>
        {view.presentation === null ? null : (
          <Presentation
            dependencies={services.presenterDependencies}
            document={view.document}
            startSlideId={view.presentation.startSlideId}
            speakerWindow={properties.gesture.speakerWindow.current}
            onSpeakerViewRequested={() => {
              const opened = properties.gesture.browser.openSpeakerWindow();
              properties.gesture.speakerWindow.current = opened;
              return opened;
            }}
            onExit={(lastSlideId: SlideId | null) => {
              properties.gesture.browser.exitFullScreen().catch((error: unknown) => services.presenterDependencies.reportError(error, "leaving full screen"));
              properties.gesture.speakerWindow.current?.close();
              properties.gesture.speakerWindow.current = null;
              services.system.dispatch({ kind: "presentationEnded", lastSlideId });
            }}
          />
        )}
      </div>
    </div>
    </FloatingLayerContext.Provider>
  );
}

/** The parts of a key event the shell's handler reads. */
export type ShellKeyEvent = Readonly<{
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
  defaultPrevented: boolean;
  preventDefault: () => void;
}>;

/** Keys outside text and fields: primary+Enter presents (a gesture), the rest go to the key map. */
export function handleShellKey(options: Readonly<{ event: ShellKeyEvent; gesture: GestureContext; primaryModifier: "control" | "meta" }>): void {
  const event = options.event;
  if (event.defaultPrevented || insideEditableField(event.target)) return;
  // A focused tab or segmented choice owns its arrow keys (chrome/pill-group.ts): never a nudge.
  if (PILL_GROUP_KEYS.has(event.key) && closestMatches(event.target, PILL_GROUP_SELECTOR)) return;
  const modifiers = modifiersOf({ event, primaryModifier: options.primaryModifier });
  // A focused button keeps the keys that operate it: Enter and Space press it, Tab moves focus on.
  // Without this every toolbar, panel and filmstrip button was unreachable from the keyboard.
  if (!modifiers.primary && CONTROL_OWNED_KEYS.has(event.key) && closestMatches(event.target, CONTROL_SELECTOR)) return;
  if (modifiers.primary && event.key === "Enter") {
    event.preventDefault();
    handlePresent({ context: options.gesture, from: "currentSlide", withSpeakerView: false });
    return;
  }
  if (modifiers.primary && CLIPBOARD_KEYS.has(event.key.toLowerCase())) return;
  if (MODIFIER_KEYS.has(event.key)) return;
  if (modifiers.primary || PREVENTED_KEYS.has(event.key)) event.preventDefault();
  options.gesture.system.dispatch({ kind: "keyPressed", chord: chordOf({ event, modifiers }) });
}

const CLIPBOARD_KEYS: ReadonlySet<string> = new Set(["c", "x", "v"]);
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
const PREVENTED_KEYS: ReadonlySet<string> = new Set(["Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "PageUp", "PageDown", "Home", "End", "Escape", "Enter", " "]);

const CONTROL_OWNED_KEYS: ReadonlySet<string> = new Set(["Enter", " ", "Tab"]);
const CONTROL_SELECTOR = "button, a[href], summary, [role='button'], [role='tab'], [role='option'], [role='switch'], [role='checkbox']";

/** The inline text editor, form fields and the script editor keep their own keys and clipboard. */
function insideEditableField(target: EventTarget | null): boolean {
  if (closestMatches(target, `[${TEXT_EDITOR_ATTRIBUTE}]`)) return true;
  return closestMatches(target, "input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']");
}

/** True when the target or an ancestor matches; structural, so tests can pass a plain object. */
function closestMatches(target: EventTarget | null, selector: string): boolean {
  if (target === null || !canSearchAncestors(target)) return false;
  const found = target.closest(selector);
  return found !== null && found !== undefined;
}

function canSearchAncestors(target: EventTarget): target is EventTarget & Readonly<{ closest: (selector: string) => unknown }> {
  return "closest" in target && typeof target.closest === "function";
}

function ownsClipboardEvent(target: EventTarget | null): boolean {
  return !insideEditableField(target);
}

function gestureIsActive(gesture: Gesture): boolean {
  switch (gesture.kind) {
    case "idle":
    case "pressed":
      return false;
    case "moving":
    case "resizing":
    case "rotating":
    case "movingLineEnd":
    case "marquee":
    case "creating":
    case "resizingTableLine":
    case "draggingSlides":
    case "drawingMarking":
    case "panning":
      return true;
    default:
      return assertNever(gesture);
  }
}
