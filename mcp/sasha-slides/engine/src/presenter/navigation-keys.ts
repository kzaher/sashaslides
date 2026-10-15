// THE SLIDESHOW'S KEYS (SPEC.md section 10) as one pure table from a key chord to an intent, so the
// keyboard can be tested as a table and the page handler can ask "is this ours?" before it calls
// `preventDefault` (Space would otherwise scroll).
//
// Decisions:
//
//  * S ASKS FOR THE SPEAKER VIEW. The window may only be opened inside the key handler itself
//    (popup blockers refuse `window.open` after an asynchronous step), so the page handler calls the
//    caller's `onSpeakerViewRequested` synchronously; the reducer leaves the slide as it is.
//  * CHORDS WITH Ctrl, Cmd OR Alt ARE NOT OURS: Ctrl+R still reloads and Alt+Tab still switches.
//  * ENTER IS ITS OWN INTENT: with digits typed it goes to that slide, otherwise it is "next"; the
//    reducer decides, because only it knows the typed digits.

import type { KeyChord } from "../contracts/editor-events.ts";
import type { PresenterNavigation } from "../contracts/presenter.ts";

export type PresenterKeyIntent =
  | Readonly<{ kind: "navigate"; navigation: PresenterNavigation }>
  | Readonly<{ kind: "enter" }>
  | Readonly<{ kind: "typeDigit"; digit: string }>
  | Readonly<{ kind: "blank"; colour: "black" | "white" }>
  | Readonly<{ kind: "exit" }>
  | Readonly<{ kind: "speakerView" }>
  | Readonly<{ kind: "notHandled" }>;

export function presenterKeyIntent(chord: KeyChord): PresenterKeyIntent {
  if (chord.modifiers.primary || chord.modifiers.alt) return NOT_HANDLED;
  if (/^[0-9]$/.test(chord.key)) return { kind: "typeDigit", digit: chord.key };
  return KEY_TABLE.get(chord.key.length === 1 ? chord.key.toLowerCase() : chord.key) ?? NOT_HANDLED;
}

const NEXT: PresenterKeyIntent = { kind: "navigate", navigation: { kind: "next" } };
const PREVIOUS: PresenterKeyIntent = { kind: "navigate", navigation: { kind: "previous" } };
const NOT_HANDLED: PresenterKeyIntent = { kind: "notHandled" };

/** `KeyboardEvent.key` values; single letters lower-cased before lookup. */
const KEY_TABLE: ReadonlyMap<string, PresenterKeyIntent> = new Map<string, PresenterKeyIntent>([
  ["ArrowRight", NEXT],
  ["ArrowDown", NEXT],
  [" ", NEXT],
  ["PageDown", NEXT],
  ["n", NEXT],
  ["Enter", { kind: "enter" }],
  ["ArrowLeft", PREVIOUS],
  ["ArrowUp", PREVIOUS],
  ["PageUp", PREVIOUS],
  ["Backspace", PREVIOUS],
  ["p", PREVIOUS],
  ["Home", { kind: "navigate", navigation: { kind: "first" } }],
  ["End", { kind: "navigate", navigation: { kind: "last" } }],
  ["b", { kind: "blank", colour: "black" }],
  ["w", { kind: "blank", colour: "white" }],
  ["Escape", { kind: "exit" }],
  ["s", { kind: "speakerView" }],
]);
