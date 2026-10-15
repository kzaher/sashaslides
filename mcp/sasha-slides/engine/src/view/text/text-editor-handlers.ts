// THE INLINE TEXT EDITOR'S EVENT HANDLERS, separated from the component so they are plain functions
// over injected readers and a dispatch, testable without a page (acceptance test 4).
//
// Key decisions:
//
//  * EVERY `beforeinput` IS PREVENTED and reported (input-parser.ts), except composition input.
//  * COMPOSITION REPORTS ITS START RANGE. `compositionstart` reads the selection the composition
//    began on -- a selected range will be replaced by the composed text -- and the reducer freezes
//    the body from then on; `compositionend` reports the composed text once.
//  * KEYBOARD CHORDS BECOME `keyPressed`, here, and are prevented, so the browser's own Ctrl+B,
//    Ctrl+Z and Ctrl+K never run and the key map (the state module's `chordToIntent`) is the one
//    place a chord means something. Escape leaves text editing; Tab is a `TextInput` (list level, or
//    a tab character outside lists). Plain keys -- typing, arrows -- stay with the browser, which
//    turns typing into `beforeinput` and moves the caret natively.
//  * CLIPBOARD WITHIN TEXT: copy writes the selected characters as plain text inside the event;
//    cut does the same, prevents the browser's cut and reports `deleteByCut` itself, because a
//    prevented cut never fires its `beforeinput`.

import type { EditorEvent, KeyChord, TextInput } from "../../contracts/editor-events.ts";
import type { Modifiers } from "../../contracts/editor-state.ts";
import { handleBeforeInput, type BeforeInputContext, type BeforeInputLike, type BeforeInputOutcome } from "./input-parser.ts";

/** The selection the browser holds in the editor, as body indices; null outside the edited body. */
export type TextSelectionReading = Readonly<{ anchor: number; focus: number }>;

export type TextEditorHandlerDependencies = BeforeInputContext &
  Readonly<{
    dispatch: (event: EditorEvent) => void;
    readSelection: () => TextSelectionReading | null;
    /** The plain text of a range of the body being edited (for copy and cut). */
    plainTextOf: (range: TextSelectionReading) => string;
    primaryModifier: "control" | "meta";
  }>;

/** The parts of a KeyboardEvent the key handler reads. */
export type KeyboardEventLike = Readonly<{
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  preventDefault: () => void;
}>;

/** The parts of a ClipboardEvent the copy and cut handlers read. */
export type ClipboardEventLike = Readonly<{
  clipboardData: Readonly<{ setData: (format: string, data: string) => void }> | null;
  preventDefault: () => void;
}>;

export type TextEditorHandlers = Readonly<{
  beforeInput: (event: BeforeInputLike & Readonly<{ preventDefault: () => void }>) => BeforeInputOutcome;
  compositionStart: () => void;
  compositionEnd: (event: Readonly<{ data: string }>) => void;
  keyDown: (event: KeyboardEventLike) => void;
  copy: (event: ClipboardEventLike) => void;
  cut: (event: ClipboardEventLike) => void;
}>;

export function createTextEditorHandlers(dependencies: TextEditorHandlerDependencies): TextEditorHandlers {
  const dispatch = dependencies.dispatch;
  return {
    beforeInput: (event) => handleBeforeInput({ event, context: dependencies, dispatch }),
    compositionStart: () => {
      const range = dependencies.readSelection();
      if (range === null) return;
      dispatch({ kind: "compositionStarted", anchor: range.anchor, focus: range.focus });
    },
    compositionEnd: (event) => dispatch({ kind: "compositionEnded", text: event.data }),
    keyDown: (event) => {
      if (event.isComposing) return;
      const input = keyTextInput(event);
      if (input !== null) {
        event.preventDefault();
        dispatch({ kind: "textInput", input });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ kind: "textEditingEnded" });
        return;
      }
      const modifiers = modifiersOf({ event, primaryModifier: dependencies.primaryModifier });
      if (!modifiers.primary || BROWSER_OWNED_PRIMARY_KEYS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      dispatch({ kind: "keyPressed", chord: chordOf({ event, modifiers }) });
    },
    copy: (event) => {
      const range = dependencies.readSelection();
      if (range === null || range.anchor === range.focus || event.clipboardData === null) return;
      event.clipboardData.setData("text/plain", dependencies.plainTextOf(range));
      event.preventDefault();
    },
    cut: (event) => {
      const range = dependencies.readSelection();
      if (range === null || range.anchor === range.focus || event.clipboardData === null) return;
      event.clipboardData.setData("text/plain", dependencies.plainTextOf(range));
      event.preventDefault();
      dispatch({ kind: "textInput", input: { kind: "deleteByCut" } });
    },
  };
}

/** Normalised modifiers: `primary` is Cmd on macOS and Ctrl elsewhere. */
export function modifiersOf(options: Readonly<{ event: Pick<KeyboardEventLike, "shiftKey" | "altKey" | "ctrlKey" | "metaKey">; primaryModifier: "control" | "meta" }>): Modifiers {
  return {
    shift: options.event.shiftKey,
    alt: options.event.altKey,
    primary: PRIMARY_PRESSED[options.primaryModifier](options.event),
  };
}

export function chordOf(options: Readonly<{ event: Pick<KeyboardEventLike, "key" | "code">; modifiers: Modifiers }>): KeyChord {
  return { key: options.event.key, code: options.event.code, modifiers: options.modifiers };
}

/** Primary chords the browser performs itself inside text: clipboard and select all. */
const BROWSER_OWNED_PRIMARY_KEYS: ReadonlySet<string> = new Set(["c", "x", "v", "a", "control", "meta", "shift", "alt"]);

const PRIMARY_PRESSED: Readonly<Record<"control" | "meta", (event: Pick<KeyboardEventLike, "ctrlKey" | "metaKey">) => boolean>> = {
  control: (event) => event.ctrlKey,
  meta: (event) => event.metaKey,
};

/** Tab never reaches `beforeinput` (it moves focus), so the key handler reports it. */
function keyTextInput(event: KeyboardEventLike): TextInput | null {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return null;
  return { kind: "insertTab", outdent: event.shiftKey };
}
