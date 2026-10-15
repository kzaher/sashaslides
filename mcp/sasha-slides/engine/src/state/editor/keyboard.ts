// THE KEYBOARD MAP (SPEC.md section 7, "Keyboard"): one pure function from a chord and the state to a
// named intent, tested as a table. `primary` is Ctrl, or Cmd on macOS (the view normalises it);
// shortcuts follow Google Slides where it has one.
//
// Letters are read from `KeyboardEvent.code` ("KeyB") when it names a letter, so the shortcuts sit on
// the same physical keys on every keyboard layout, and from `key` otherwise. Digits likewise, because
// primary+Shift+7 reports `key` "&" on a US layout.
//
// Some intents are performed by the VIEW, not the reducer: copy, cut and paste fill or read the
// clipboard event's DataTransfer, and Present must enter full screen inside the key handler
// (contracts/editor-system.ts `BrowserCapabilities`). The map still names them, so the view asks one
// function what a chord means; the reducer ignores those.

import { assertNever, type ArrangeAction, type EditorState, type KeyChord, type TextAlignment } from "../../contracts/index.ts";
import { textSelectionOf } from "./editor-selection.ts";
import { selectionIsInList } from "./text-editing.ts";

export type KeyIntent =
  | Readonly<{ kind: "undo" }>
  | Readonly<{ kind: "redo" }>
  /** Performed by the view's clipboard handlers. */
  | Readonly<{ kind: "copy" }>
  | Readonly<{ kind: "cut" }>
  | Readonly<{ kind: "paste" }>
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "delete" }>
  | Readonly<{ kind: "selectAll" }>
  /** Slide units: 1, or 10 with Shift. */
  | Readonly<{ kind: "nudge"; deltaX: number; deltaY: number }>
  | Readonly<{ kind: "arrange"; action: ArrangeAction }>
  /** Enter: edit the single selected element's text, or enter the selected group. */
  | Readonly<{ kind: "enter" }>
  /** Escape: cancel a gesture, close a menu, leave text, leave the group, clear the selection. */
  | Readonly<{ kind: "escape" }>
  | Readonly<{ kind: "selectSibling"; direction: "next" | "previous" }>
  /** Tab in a list paragraph. */
  | Readonly<{ kind: "listLevel"; delta: 1 | -1 }>
  /** Tab in text outside a list. */
  | Readonly<{ kind: "insertTabCharacter" }>
  | Readonly<{ kind: "toggleFormat"; format: "bold" | "italic" | "underline" | "strikethrough" }>
  | Readonly<{ kind: "alignParagraphs"; alignment: TextAlignment }>
  | Readonly<{ kind: "toggleList"; list: "bulleted" | "numbered" }>
  | Readonly<{ kind: "openLinkEditor" }>
  | Readonly<{ kind: "newSlide" }>
  | Readonly<{ kind: "comment" }>
  /** Performed by the view's key handler (full screen needs the user's gesture). */
  | Readonly<{ kind: "present" }>
  | Readonly<{ kind: "showKeyboardShortcuts" }>
  | Readonly<{ kind: "goToSlide"; step: -1 | 1 }>;

/** What a chord means in this state; null when it means nothing here (the browser keeps it). */
export function chordToIntent(chord: KeyChord, state: EditorState): KeyIntent | null {
  if (chord.key === "Escape") return { kind: "escape" };
  if (chord.modifiers.primary) return primaryIntent(chord);
  const inText = textSelectionOf(state.selection) !== null;
  switch (chord.key) {
    case "Delete":
    case "Backspace":
      // In text the inline editor consumes them as `deleteForward` / `deleteBackward` input.
      return !inText && hasDeletableSelection(state) ? { kind: "delete" } : null;
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
      return !inText && hasElementSelection(state) ? nudgeFor(chord.key, chord.modifiers.shift) : null;
    case "Enter":
      return !inText && hasElementSelection(state) ? { kind: "enter" } : null;
    case "Tab":
      if (inText) {
        if (selectionIsInList(state)) return { kind: "listLevel", delta: chord.modifiers.shift ? -1 : 1 };
        return chord.modifiers.shift ? null : { kind: "insertTabCharacter" };
      }
      return { kind: "selectSibling", direction: chord.modifiers.shift ? "previous" : "next" };
    case "PageUp":
      return { kind: "goToSlide", step: -1 };
    case "PageDown":
      return { kind: "goToSlide", step: 1 };
    default:
      return null;
  }
}

/** The slide-unit distance one arrow press moves: 1, or 10 with Shift. */
export const NUDGE_UNITS = 1;
export const LARGE_NUDGE_UNITS = 10;

function primaryIntent(chord: KeyChord): KeyIntent | null {
  const shift = chord.modifiers.shift;
  const letter = letterOf(chord);
  switch (letter) {
    case "z":
      return shift ? { kind: "redo" } : { kind: "undo" };
    case "y":
      return { kind: "redo" };
    case "c":
      return shift ? null : { kind: "copy" };
    case "x":
      return shift ? { kind: "toggleFormat", format: "strikethrough" } : { kind: "cut" };
    case "v":
      return { kind: "paste" };
    case "d":
      return { kind: "duplicate" };
    case "a":
      return { kind: "selectAll" };
    case "g":
      return { kind: "arrange", action: shift ? { kind: "ungroup" } : { kind: "group" } };
    case "b":
      return { kind: "toggleFormat", format: "bold" };
    case "i":
      return { kind: "toggleFormat", format: "italic" };
    case "u":
      return { kind: "toggleFormat", format: "underline" };
    case "l":
      return shift ? { kind: "alignParagraphs", alignment: "start" } : null;
    case "e":
      return shift ? { kind: "alignParagraphs", alignment: "centre" } : null;
    case "r":
      return shift ? { kind: "alignParagraphs", alignment: "end" } : null;
    case "j":
      return shift ? { kind: "alignParagraphs", alignment: "justify" } : null;
    case "k":
      return { kind: "openLinkEditor" };
    case "m":
      return chord.modifiers.alt ? { kind: "comment" } : { kind: "newSlide" };
    case "7":
      return shift ? { kind: "toggleList", list: "numbered" } : null;
    case "8":
      return shift ? { kind: "toggleList", list: "bulleted" } : null;
    default:
      break;
  }
  switch (chord.key) {
    case "Enter":
      return { kind: "present" };
    case "/":
      return { kind: "showKeyboardShortcuts" };
    case "ArrowUp":
      return { kind: "arrange", action: { kind: "reorder", placement: shift ? "front" : "forward" } };
    case "ArrowDown":
      return { kind: "arrange", action: { kind: "reorder", placement: shift ? "back" : "backward" } };
    default:
      return chord.code === "Slash" ? { kind: "showKeyboardShortcuts" } : null;
  }
}

/** The letter or digit a chord names, layout-independent where `code` says (see the header). */
function letterOf(chord: KeyChord): string {
  const letter = /^Key([A-Z])$/u.exec(chord.code);
  if (letter?.[1] !== undefined) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/u.exec(chord.code);
  if (digit?.[1] !== undefined) return digit[1];
  return chord.key.length === 1 ? chord.key.toLowerCase() : "";
}

function nudgeFor(key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown", large: boolean): KeyIntent {
  const distance = large ? LARGE_NUDGE_UNITS : NUDGE_UNITS;
  switch (key) {
    case "ArrowLeft":
      return { kind: "nudge", deltaX: -distance, deltaY: 0 };
    case "ArrowRight":
      return { kind: "nudge", deltaX: distance, deltaY: 0 };
    case "ArrowUp":
      return { kind: "nudge", deltaX: 0, deltaY: -distance };
    case "ArrowDown":
      return { kind: "nudge", deltaX: 0, deltaY: distance };
    default:
      return assertNever(key);
  }
}

function hasElementSelection(state: EditorState): boolean {
  switch (state.selection.kind) {
    case "elements":
      return true;
    case "none":
    case "slides":
    case "text":
    case "tableCells":
      return false;
    default:
      return assertNever(state.selection);
  }
}

function hasDeletableSelection(state: EditorState): boolean {
  switch (state.selection.kind) {
    case "elements":
    case "slides":
      return true;
    case "none":
    case "text":
    case "tableCells":
      return false;
    default:
      return assertNever(state.selection);
  }
}
