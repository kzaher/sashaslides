// PRESENCE: who else is here, where they are looking, what they have selected, where their pointer
// is. Ephemeral -- never stored in the document. Milestone 2 carries it over the Yjs awareness
// protocol (y-protocols/awareness) on the same WebSocket as document sync; milestone 1 has only
// the in-memory `PresenceChannel` the model provides for the two-editor demo and tests.
//
// The local client PUBLISHES a `LocalPresence` (derived from editor state by a feedback, throttled
// on the injected scheduler to one update per `PRESENCE_PUBLISH_INTERVAL_MILLISECONDS`) and
// RECEIVES `PeerPresence`s, which enter the editor as an event and are rendered as coloured
// cursors, selection outlines and filmstrip avatars.

import type { Person } from "./discussion.ts";
import type { Point } from "./geometry.ts";
import type { SlideId } from "./ids.ts";
import type { Selection } from "./selection.ts";

export type PresenceActivity = "editing" | "presenting" | "idle";

export type LocalPresence = Readonly<{
  person: Person;
  slideId: SlideId | null;
  selection: Selection;
  /** Pointer over the canvas, slide units; null when it is elsewhere. */
  pointer: Point | null;
  activity: PresenceActivity;
}>;

export type PeerPresence = LocalPresence &
  Readonly<{
    /** The Yjs client id of the peer's document replica. */
    clientId: number;
    /** Stamped by the channel when the update arrived. */
    lastSeenAt: number;
  }>;

/**
 * Ten updates a second: smooth enough for a cursor, and half of the deck server's 20 frames a
 * second per connection (COLLABORATION_LIMITS), so a pointer that never stops still leaves room for
 * document updates and discussion (at 50 milliseconds presence alone used the whole rate).
 */
export const PRESENCE_PUBLISH_INTERVAL_MILLISECONDS = 100;
/** A peer whose `lastSeenAt` is older than this is shown as away, then dropped after 4 times as long. */
export const PRESENCE_STALE_AFTER_MILLISECONDS = 30_000;

/**
 * The transport for presence. The model implements an in-memory one (milestone 1); milestone 2
 * implements it over Yjs awareness. Subscribing returns a disposable so the feedback that owns it
 * releases it on teardown.
 */
export interface PresenceChannel {
  publish(presence: LocalPresence): void;
  subscribe(listener: (peers: readonly PeerPresence[]) => void): Disposable;
}

/** The in-memory hub: every channel it creates sees every other channel's presence. */
export type CreateMemoryPresenceHub = (options: Readonly<{ now: () => number }>) => Readonly<{
  channelFor: (clientId: number) => PresenceChannel;
}>;
