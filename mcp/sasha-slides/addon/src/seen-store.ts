// The persisted `seen` set: proposals this account has already answered or refused to parse.
//
// It is a CACHE, not the record. The durable answer is a sibling `PICK` in the proposal folder,
// which the name walk reads on every poll; `seen` exists so a proposal is not re-offered between
// the decision and the next scan, and so a proposal rejected for an unknown `protocolVersion` is
// warned about once instead of on every poll forever.
//
// That is why losing it is survivable, and it has to be: an HtmlService sidebar is served from a
// sandboxed googleusercontent.com origin, where `localStorage` can be absent, cleared with the
// script, or throw on access. So every read and write is guarded and falls back to memory -- the
// same rule the repo applies to artifact storage. Keeping `seen` out of a server call also keeps
// Code.gs to five functions.

import type { SeenStore } from "./observer-runtime.ts";

export const SEEN_STORAGE_KEY = "sashaSlides.seenProposalIds";

/** The one-key store this needs. Injected, so the parse/serialize pair tests with no browser. */
export type KeyValueStorage = Readonly<{
  read(key: string): string | null;
  write(spec: Readonly<{ key: string; value: string }>): void;
}>;

/** Bounded: a proposal folder is disposable, so old ids can never come back. */
export const SEEN_LIMIT = 500;

export function seenStore({ storage, key = SEEN_STORAGE_KEY }: { storage: KeyValueStorage; key?: string }): SeenStore {
  return {
    async read() {
      return parseSeen(storage.read(key));
    },
    async write(seenProposalIds) {
      storage.write({ key, value: serializeSeen(seenProposalIds) });
    },
  };
}

/** Anything that is not an array of strings reads as "nothing seen", which is always safe. */
export function parseSeen(raw: string | null): readonly string[] {
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string").slice(-SEEN_LIMIT);
}

export function serializeSeen(seenProposalIds: readonly string[]): string {
  return JSON.stringify(seenProposalIds.slice(-SEEN_LIMIT));
}

/**
 * `localStorage` when it works, memory when it does not. The accessor itself can throw in a
 * sandboxed frame or with site data blocked, so even reaching `window.localStorage` is inside the
 * try -- not just the get/set.
 */
export function browserKeyValueStorage(): KeyValueStorage {
  const fallback = new Map<string, string>();
  return {
    read(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return fallback.get(key) ?? null;
      }
    },
    write({ key, value }) {
      fallback.set(key, value);
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* memory is already up to date; a sandboxed sidebar simply forgets on close */
      }
    },
  };
}
