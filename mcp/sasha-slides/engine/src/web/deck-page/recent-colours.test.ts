// RECENT COLOURS IN LOCAL STORAGE: a round trip keeps the row, an unreadable entry is dropped alone,
// and a storage that throws (a private window, blocked site data) means an empty row, never an error.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Colour } from "../../contracts/style.ts";
import { readRecentColours, RECENT_COLOURS_STORAGE_KEY, writeRecentColours, type ColourStorage } from "./recent-colours.ts";

function memoryStorage(initial: Readonly<Record<string, string>> = {}): ColourStorage & Readonly<{ values: Map<string, string> }> {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

const COLOURS: readonly Colour[] = [
  { kind: "literal", hexadecimal: "#4338ca", alpha: 1 },
  { kind: "theme", slot: "accent2", alpha: 0.5 },
];

describe("recent colours", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    writeRecentColours({ storage: () => storage, colours: COLOURS });
    assert.deepEqual(readRecentColours(() => storage), COLOURS);
  });

  it("drops an unreadable entry and keeps the rest", () => {
    const storage = memoryStorage({ [RECENT_COLOURS_STORAGE_KEY]: JSON.stringify([{ kind: "literal", hexadecimal: "red", alpha: 1 }, ...COLOURS, { kind: "theme", slot: "nowhere", alpha: 1 }]) });
    assert.deepEqual(readRecentColours(() => storage), COLOURS);
  });

  it("answers an empty row when storage throws or holds nonsense", () => {
    const throwing: ColourStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    assert.deepEqual(readRecentColours(() => throwing), []);
    assert.doesNotThrow(() => writeRecentColours({ storage: () => throwing, colours: COLOURS }));
    assert.deepEqual(readRecentColours(() => memoryStorage({ [RECENT_COLOURS_STORAGE_KEY]: "{not json" })), []);
    assert.deepEqual(
      readRecentColours(() => {
        throw new Error("localStorage is not available");
      }),
      [],
    );
  });
});
