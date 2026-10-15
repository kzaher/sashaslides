// THE AWARENESS RELAY: presence travels as y-protocols awareness updates, but the server decides
// whose name is on each cursor (collaboration.ts header "presence identity is the server's").
//
// Key decisions:
//
//  * THE SERVER KEEPS NO Awareness INSTANCE. y-protocols' `Awareness` runs a wall-clock interval
//    and owns a local state of its own; the relay needs neither. It decodes the wire format itself
//    (lib0: count, then per client `clientId`, `clock`, JSON state) and keeps the last accepted
//    entry per client id, which is all a newcomer needs to see everyone.
//  * A CLIENT ID BELONGS TO THE FIRST CONNECTION THAT USED IT. Later entries for it from any other
//    connection are dropped, removals included, so nobody can move or erase someone else's cursor.
//  * THE PERSON IS OVERWRITTEN. Every accepted state's `presence.person` becomes the connection's
//    own person before it is stored or relayed; a state without a `presence` record carries no
//    identity and is relayed as it is.
//  * A CLOSED CONNECTION'S CLIENT IDS ARE REMOVED (a `null` state with the next clock), exactly the
//    message y-protocols sends when a peer leaves, so every replica drops the cursor at once.
//  * OVERSIZED STATES (`maximumAwarenessStateBytes`) and malformed updates are dropped whole.
//  * AT MOST `MAXIMUM_CLIENT_IDS_PER_CONNECTION` IDS PER CONNECTION: claiming one more removes that
//    connection's oldest (relayed as a removal), so the memory one connection holds is bounded.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { AWARENESS_PRESENCE_FIELD, COLLABORATION_LIMITS } from "../contracts/collaboration.ts";
import type { Person } from "../contracts/discussion.ts";

export type AwarenessRelay = Readonly<{
  /**
   * Accepts what `connectionId` may say in `update` and returns the re-encoded update to relay to
   * every other connection, or null when nothing was accepted (or the update did not decode).
   */
  receive(options: Readonly<{ connectionId: number; person: Person; update: Uint8Array }>): Uint8Array | null;
  /** Removes the connection's client ids; returns the removal update to relay, or null when it had none. */
  removeConnection(connectionId: number): Uint8Array | null;
  /** Every stored state not from `connectionId`, for a newcomer; null when there is none. */
  statesFor(connectionId: number): Uint8Array | null;
  /** The client ids a connection owns (for tests and diagnostics). */
  clientIdsOf(connectionId: number): readonly number[];
}>;

export function createAwarenessRelay(): AwarenessRelay {
  const entries = new Map<number, StoredEntry>();
  /** Client id to owning connection, in the order the ids were claimed (a Map keeps insertion order). */
  const owners = new Map<number, number>();

  /** Frees the connection's oldest ids when it already holds the maximum (see the header); the removals to relay. */
  const evictOldestBeyondLimit = (connectionId: number): readonly AwarenessEntry[] => {
    const held = [...owners.entries()].filter(([, owner]) => owner === connectionId).map(([clientId]) => clientId);
    const removals: AwarenessEntry[] = [];
    for (const clientId of held.slice(0, Math.max(0, held.length - MAXIMUM_CLIENT_IDS_PER_CONNECTION + 1))) {
      const current = entries.get(clientId);
      owners.delete(clientId);
      entries.delete(clientId);
      if (current !== undefined && current.stateText !== "null") removals.push({ clientId, clock: current.clock + 1, stateText: "null" });
    }
    return removals;
  };

  return {
    receive: ({ connectionId, person, update }) => {
      const decoded = decodeAwarenessUpdate(update);
      if (decoded === null) return null;
      const accepted: AwarenessEntry[] = [];
      for (const entry of decoded) {
        const owner = owners.get(entry.clientId);
        if (owner !== undefined && owner !== connectionId) continue;
        if (entry.stateText.length > COLLABORATION_LIMITS.maximumAwarenessStateBytes) continue;
        const current = entries.get(entry.clientId);
        const stateText = entry.stateText === "null" ? "null" : withPerson({ stateText: entry.stateText, person });
        if (stateText === null) continue;
        const newer = current === undefined || current.clock < entry.clock || (current.clock === entry.clock && stateText === "null" && current.stateText !== "null");
        if (!newer) continue;
        if (owner === undefined) {
          // A removal for an id nobody holds says nothing; it must not claim the id either.
          if (stateText === "null") continue;
          accepted.push(...evictOldestBeyondLimit(connectionId));
          owners.set(entry.clientId, connectionId);
        }
        entries.set(entry.clientId, { clock: entry.clock, stateText, connectionId });
        accepted.push({ clientId: entry.clientId, clock: entry.clock, stateText });
      }
      return accepted.length === 0 ? null : encodeAwarenessUpdate(accepted);
    },
    removeConnection: (connectionId) => {
      const removed: AwarenessEntry[] = [];
      for (const [clientId, owner] of owners) {
        if (owner !== connectionId) continue;
        const current = entries.get(clientId);
        owners.delete(clientId);
        entries.delete(clientId);
        if (current === undefined || current.stateText === "null") continue;
        removed.push({ clientId, clock: current.clock + 1, stateText: "null" });
      }
      return removed.length === 0 ? null : encodeAwarenessUpdate(removed);
    },
    statesFor: (connectionId) => {
      const states: AwarenessEntry[] = [];
      for (const [clientId, entry] of entries) {
        if (entry.connectionId === connectionId || entry.stateText === "null") continue;
        states.push({ clientId, clock: entry.clock, stateText: entry.stateText });
      }
      return states.length === 0 ? null : encodeAwarenessUpdate(states);
    },
    clientIdsOf: (connectionId) => [...owners.entries()].filter(([, owner]) => owner === connectionId).map(([clientId]) => clientId),
  };
}

/**
 * How many awareness client ids one connection may hold. A browser uses one (its replica's), and a
 * fresh one after each resynchronisation; without a bound, one viewer could claim ids without end,
 * and every state is kept in memory and relayed to everyone.
 */
export const MAXIMUM_CLIENT_IDS_PER_CONNECTION = 4;

/** One entry of an awareness update; `stateText` is the JSON text, "null" for a removal. */
export type AwarenessEntry = Readonly<{ clientId: number; clock: number; stateText: string }>;

/** y-protocols' awareness update layout (awareness.js `encodeAwarenessUpdate`). */
export function encodeAwarenessUpdate(entries: readonly AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.stateText);
  }
  return encoding.toUint8Array(encoder);
}

/** Null when the bytes are not an awareness update (truncated, or trailing garbage). */
export function decodeAwarenessUpdate(update: Uint8Array): readonly AwarenessEntry[] | null {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const entries: AwarenessEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const stateText = decoding.readVarString(decoder);
      entries.push({ clientId, clock, stateText });
    }
    return decoding.hasContent(decoder) ? null : entries;
  } catch {
    return null;
  }
}

type StoredEntry = Readonly<{ clock: number; stateText: string; connectionId: number }>;

/** The state with `presence.person` replaced, or null when the text is not a JSON object. */
function withPerson(options: Readonly<{ stateText: string; person: Person }>): string | null {
  let state: unknown;
  try {
    state = JSON.parse(options.stateText);
  } catch {
    return null;
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(state));
  const presence = record[AWARENESS_PRESENCE_FIELD];
  if (typeof presence !== "object" || presence === null || Array.isArray(presence)) return JSON.stringify(record);
  return JSON.stringify({ ...record, [AWARENESS_PRESENCE_FIELD]: { ...presence, person: options.person } });
}
