// THE IN-MEMORY STAND-INS for what milestone 2 puts on the network: the asset byte store, the
// two-replica document loopback, and the presence hub. Tests and the side-by-side two-editor demo
// use them; the deck server replaces each with the same interface.
//
// Key decisions:
//
//  * ASSET BYTES ARE COPIED IN AND COPIED OUT. `put` keeps its own copy (the caller may transfer or
//    reuse its buffer), and `copyBytesOf` returns a fresh `slice(0)` every time, because the
//    presenter transfers the buffer it gets into the runner frame and a transfer detaches it: a
//    shared cached buffer would arrive empty at the next transition (document-store.ts).
//  * THE LOOPBACK FORWARDS EVERYTHING, ECHOES NOTHING. Each connection applies one replica's updates
//    to the other under REMOTE_SYNC_ORIGIN and ignores the update events its own application causes,
//    while an update that arrived through ANOTHER connection is passed on, so three replicas in a
//    chain still converge. Yjs emits no update for content a replica already has, so forwarding
//    cannot loop.
//  * PRESENCE IS STAMPED BY THE HUB, with its injected clock, as the awareness protocol will stamp it.

import { Subject } from "rxjs";
import * as Y from "yjs";
import type {
  AssetId,
  AssetMediaType,
  ConnectInMemory,
  CreateMemoryAssetStore,
  CreateMemoryPresenceHub,
  PeerPresence,
  PresenceChannel,
} from "../contracts/index.ts";
import { REMOTE_SYNC_ORIGIN } from "../contracts/index.ts";

export const createMemoryAssetStore: CreateMemoryAssetStore = (options) => {
  const entries = new Map<AssetId, Readonly<{ bytes: ArrayBuffer; mediaType: AssetMediaType; address: string }>>();
  const available = new Subject<AssetId>();
  return {
    put: async (bytes, mediaType) => {
      const copy = bytes.slice(0);
      // The digest is the content address (document-store.ts `AssetStore.put`); the brand records it.
      const assetId = (await options.digest(copy.slice(0))) as AssetId;
      if (entries.has(assetId)) return assetId;
      entries.set(assetId, { bytes: copy, mediaType, address: options.createAddress(copy.slice(0), mediaType) });
      available.next(assetId);
      return assetId;
    },
    addressFor: (assetId) => entries.get(assetId)?.address ?? null,
    available: available.asObservable(),
    copyBytesOf: (assetId) => {
      const entry = entries.get(assetId);
      return Promise.resolve(entry === undefined ? null : entry.bytes.slice(0));
    },
  };
};

export const connectInMemory: ConnectInMemory = (options) => {
  const { first, second } = options;
  let applying = false;
  const forward = (target: Y.Doc) => (update: Uint8Array): void => {
    if (applying) return;
    applying = true;
    try {
      Y.applyUpdate(target, update, REMOTE_SYNC_ORIGIN);
    } finally {
      applying = false;
    }
  };
  const toSecond = forward(second);
  const toFirst = forward(first);
  first.on("update", toSecond);
  second.on("update", toFirst);
  // Bring both up to date with each other before live updates flow.
  toSecond(Y.encodeStateAsUpdate(first, Y.encodeStateVector(second)));
  toFirst(Y.encodeStateAsUpdate(second, Y.encodeStateVector(first)));
  return {
    [Symbol.dispose]: () => {
      first.off("update", toSecond);
      second.off("update", toFirst);
    },
  };
};

export const createMemoryPresenceHub: CreateMemoryPresenceHub = (options) => {
  const presences = new Map<number, PeerPresence>();
  const listeners = new Map<number, Set<(peers: readonly PeerPresence[]) => void>>();
  const peersFor = (clientId: number): readonly PeerPresence[] => [...presences.values()].filter((peer) => peer.clientId !== clientId);
  const notifyAll = (): void => {
    for (const [clientId, set] of listeners) {
      const peers = peersFor(clientId);
      for (const listener of set) listener(peers);
    }
  };
  return {
    channelFor: (clientId): PresenceChannel => ({
      publish: (presence) => {
        presences.set(clientId, { ...presence, clientId, lastSeenAt: options.now() });
        notifyAll();
      },
      subscribe: (listener) => {
        const set = listeners.get(clientId) ?? new Set();
        set.add(listener);
        listeners.set(clientId, set);
        listener(peersFor(clientId));
        return { [Symbol.dispose]: () => set.delete(listener) };
      },
    }),
  };
};
