// THE COLOUR PICKER'S "RECENT" ROW, REMEMBERED PER VIEWER (editor-state.ts `chrome.recentColours`):
// read from local storage when the editor is composed, written back whenever the row changes.
//
// Key decisions:
//
//  * LOCAL STORAGE CAN THROW (a private window, blocked site data, a full quota), and what it holds
//    may have been written by an older page or edited by hand. Every read and write is wrapped, the
//    value is parsed at this boundary, and a failure means "no recent colours", never a broken page.

import { RECENT_COLOUR_LIMIT } from "../../contracts/editor-state.ts";
import { THEME_COLOUR_SLOTS, type Colour } from "../../contracts/style.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { arrayOf, keysOf, MalformedValue, memberAt, numberAt, parseOrNull, parseStructuredText, recordOf, stringAt } from "../../shared/untrusted-values.ts";

export const RECENT_COLOURS_STORAGE_KEY = "sasha.recentColours.v1";

/** The slice of `Storage` used here, so tests pass a map. */
export type ColourStorage = Readonly<{ getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }>;

export function readRecentColours(storage: () => ColourStorage): readonly Colour[] {
  try {
    const text = storage().getItem(RECENT_COLOURS_STORAGE_KEY);
    if (text === null) return [];
    const entries = parseOrNull(() => arrayOf(parseStructuredText(text), "recent colours")) ?? [];
    // One unreadable entry is dropped; the rest of the row is kept.
    return entries.flatMap((entry) => parseOrNull(() => readColour(entry)) ?? []).slice(0, RECENT_COLOUR_LIMIT);
  } catch {
    return [];
  }
}

export function writeRecentColours(options: Readonly<{ storage: () => ColourStorage; colours: readonly Colour[] }>): void {
  try {
    options.storage().setItem(RECENT_COLOURS_STORAGE_KEY, JSON.stringify(options.colours.slice(0, RECENT_COLOUR_LIMIT)));
  } catch {
    // Storage refused (private window, quota): the row is simply not remembered.
  }
}

const COLOUR_KINDS = keysOf<Colour["kind"]>({ literal: true, theme: true });

function readColour(value: unknown): Colour {
  const record = recordOf(value, "colour");
  const kind = memberAt(record, "kind", COLOUR_KINDS);
  const alpha = Math.min(1, Math.max(0, numberAt(record, "alpha")));
  switch (kind) {
    case "literal": {
      const hexadecimal = stringAt(record, "hexadecimal").toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(hexadecimal)) throw new MalformedValue("not a six-digit colour");
      return { kind, hexadecimal, alpha };
    }
    case "theme":
      return { kind, slot: memberAt(record, "slot", THEME_COLOUR_SLOTS), alpha };
    default:
      return assertNever(kind);
  }
}
