// PRESENCE OVER YJS AWARENESS (presence.ts, collaboration.ts `AWARENESS_PRESENCE_FIELD`): the
// editor's `PresenceChannel`, carried by y-protocols' awareness on the deck's socket.
//
// Key decisions:
//
//  * ONE AWARENESS FOR THE WHOLE SESSION, ACROSS RECONNECTS. The local state survives a dropped
//    socket and is announced again after every welcome; peers' states are removed the moment the
//    socket goes, so nobody's cursor lingers while this client cannot hear about them.
//  * A PEER'S STATE IS UNTRUSTED. It is parsed at this boundary (`parseLocalPresence`); a state
//    without a valid `presence` field is not a peer the editor can draw and is left out. The server
//    has already overwritten `person` with the connection's own (SPEC.md 21.5).
//  * `lastSeenAt` IS STAMPED HERE, with the injected clock, every time a peer's update arrives --
//    including awareness's own 15-second renewals, which is what keeps an idle peer from going away.
//  * REMOTE APPLICATIONS CARRY `REMOTE_AWARENESS_ORIGIN`, so the update listener that forwards the
//    local state to the server never echoes a peer's state back.

import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { AWARENESS_PRESENCE_FIELD } from "../../contracts/collaboration.ts";
import { awarenessFrame as frameOfAwarenessUpdate } from "../../shared/sync-frames.ts";
import type { PeerPresence, PresenceChannel } from "../../contracts/presence.ts";
import { parseLocalPresence } from "../parsing/collaboration-values.ts";
import type { Doc } from "yjs";

/** What the socket effect does with presence while a connection lives. */
export type AwarenessParticipant = Readonly<{
  /** The welcome arrived: announce the local state through `send`, and forward every later change. */
  connected: (send: (frame: Uint8Array) => void) => void;
  /** An awareness payload from the server (the bytes after the message type). */
  received: (payload: Uint8Array) => void;
  /** The socket is gone: forget every peer, stop forwarding. */
  disconnected: () => void;
}>;

export type AwarenessPresence = Disposable &
  Readonly<{
    channel: PresenceChannel;
    participant: AwarenessParticipant;
    /** For tests and the diagnostics: the awareness client id, equal to the document's client id. */
    clientId: number;
  }>;

/** The origin of awareness updates that came from the server. */
export const REMOTE_AWARENESS_ORIGIN: Readonly<{ kind: "remoteAwareness" }> = Object.freeze({ kind: "remoteAwareness" });

export function createAwarenessPresence(options: Readonly<{ sharedDocument: Doc; now: () => number }>): AwarenessPresence {
  const awareness = new Awareness(options.sharedDocument);
  // Nothing is published until the editor publishes its first presence.
  awareness.setLocalState(null);
  const lastSeenAt = new Map<number, number>();
  let send: ((frame: Uint8Array) => void) | null = null;

  const onUpdate = (changes: AwarenessChanges, origin: unknown): void => {
    if (origin === REMOTE_AWARENESS_ORIGIN) {
      const at = options.now();
      for (const clientId of [...changes.added, ...changes.updated]) lastSeenAt.set(clientId, at);
      for (const clientId of changes.removed) lastSeenAt.delete(clientId);
      return;
    }
    if (send === null) return;
    send(awarenessFrame({ awareness, clientIds: [...changes.added, ...changes.updated, ...changes.removed] }));
  };
  awareness.on("update", onUpdate);

  const peers = (): readonly PeerPresence[] => {
    const result: PeerPresence[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const presence = parseLocalPresence(stateField(state));
      if (presence === null) continue;
      result.push({ ...presence, clientId, lastSeenAt: lastSeenAt.get(clientId) ?? options.now() });
    }
    return result;
  };

  const channel: PresenceChannel = {
    publish: (presence) => awareness.setLocalState({ [AWARENESS_PRESENCE_FIELD]: presence }),
    subscribe: (listener) => {
      // `update` rather than `change`: a peer's renewal changes nothing but must refresh
      // `lastSeenAt`. The local client's own updates are skipped, so publishing never loops back
      // into the editor as a peers event.
      const onChange = (changes: AwarenessChanges): void => {
        const ids = [...changes.added, ...changes.updated, ...changes.removed];
        if (ids.every((clientId) => clientId === awareness.clientID)) return;
        listener(peers());
      };
      awareness.on("update", onChange);
      listener(peers());
      return { [Symbol.dispose]: () => awareness.off("update", onChange) };
    },
  };

  const participant: AwarenessParticipant = {
    connected: (sender) => {
      send = sender;
      if (awareness.getLocalState() !== null) sender(awarenessFrame({ awareness, clientIds: [awareness.clientID] }));
    },
    received: (payload) => applyAwarenessUpdate(awareness, payload, REMOTE_AWARENESS_ORIGIN),
    disconnected: () => {
      send = null;
      const others = [...awareness.getStates().keys()].filter((clientId) => clientId !== awareness.clientID);
      removeAwarenessStates(awareness, others, REMOTE_AWARENESS_ORIGIN);
    },
  };

  return {
    channel,
    participant,
    clientId: awareness.clientID,
    [Symbol.dispose]: () => {
      awareness.off("update", onUpdate);
      awareness.destroy();
    },
  };
}

/** The binary frame carrying `clientIds`' states: y-websocket's framing (collaboration.ts). */
export function awarenessFrame(options: Readonly<{ awareness: Awareness; clientIds: readonly number[] }>): Uint8Array {
  return frameOfAwarenessUpdate(encodeAwarenessUpdate(options.awareness, [...options.clientIds]));
}

type AwarenessChanges = Readonly<{ added: readonly number[]; updated: readonly number[]; removed: readonly number[] }>;

function stateField(state: unknown): unknown {
  if (typeof state !== "object" || state === null) return undefined;
  return Reflect.get(state, AWARENESS_PRESENCE_FIELD);
}
