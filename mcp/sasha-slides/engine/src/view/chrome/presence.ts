// WHO ELSE IS HERE, AS THE CHROME SHOWS IT (SPEC.md 12 and 21.9): a peer whose last presence update
// is older than 30 seconds is away (drawn faded), and one older than 2 minutes is gone (not drawn
// at all), whatever the transport still holds. A peer that says it is idle is away too. The top
// bar's avatar stack lists each peer with the slide they are on ("Grace - slide 3").
//
// Pure functions of the peers, the document and the time, so the canvas cursors, the filmstrip
// avatars and the top bar agree, and a test can pin the time.

import { useEffect, useState } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DocumentSnapshot } from "../../contracts/document.ts";
import type { SlideId } from "../../contracts/ids.ts";
import { PRESENCE_STALE_AFTER_MILLISECONDS, type PeerPresence, type PresenceActivity } from "../../contracts/presence.ts";

export type PeerStatus = "here" | "away" | "gone";

/** How often a component showing peers looks at the clock again, so silence turns into "away". */
export const PRESENCE_REFRESH_MILLISECONDS = 5000;

/**
 * The time to judge peers by. A peer that goes silent changes no state, so while there are peers
 * the component re-renders every PRESENCE_REFRESH_MILLISECONDS and reads the injected clock again.
 */
export function usePresenceNow(options: Readonly<{ now: () => number; watching: boolean }>): number {
  const [, setTick] = useState(0);
  const { now, watching } = options;
  useEffect(() => {
    if (!watching) return undefined;
    const timer = setInterval(() => setTick((tick) => tick + 1), PRESENCE_REFRESH_MILLISECONDS);
    return () => clearInterval(timer);
  }, [watching, now]);
  return now();
}

/** Away after the stale interval, gone after four of them (presence.ts). */
export const PEER_GONE_AFTER_MILLISECONDS = PRESENCE_STALE_AFTER_MILLISECONDS * 4;

export function peerStatus(options: Readonly<{ peer: PeerPresence; now: number }>): PeerStatus {
  const silent = options.now - options.peer.lastSeenAt;
  if (silent > PEER_GONE_AFTER_MILLISECONDS) return "gone";
  if (silent > PRESENCE_STALE_AFTER_MILLISECONDS) return "away";
  return activityIsIdle(options.peer.activity) ? "away" : "here";
}

/** The peers still shown, each with its status; gone peers are left out. */
export function shownPeers(options: Readonly<{ peers: readonly PeerPresence[]; now: number }>): readonly Readonly<{ peer: PeerPresence; status: Exclude<PeerStatus, "gone"> }>[] {
  return options.peers.flatMap((peer) => {
    const status = peerStatus({ peer, now: options.now });
    switch (status) {
      case "gone":
        return [];
      case "here":
      case "away":
        return [{ peer, status }];
      default:
        return assertNever(status);
    }
  });
}

export type PeerLocation = Readonly<{ peer: PeerPresence; status: Exclude<PeerStatus, "gone">; slideId: SlideId | null; slideNumber: number | null; label: string }>;

/** Each shown peer with the slide they are on, in the top bar popover's words. */
export function peerLocations(options: Readonly<{ peers: readonly PeerPresence[]; document: DocumentSnapshot; now: number }>): readonly PeerLocation[] {
  return shownPeers(options).map(({ peer, status }) => {
    const index = peer.slideId === null ? -1 : options.document.slides.findIndex((slide) => slide.id === peer.slideId);
    const slideNumber = index < 0 ? null : index + 1;
    const where = slideNumber === null ? "not on a slide" : `slide ${slideNumber}`;
    return { peer, status, slideId: slideNumber === null ? null : peer.slideId, slideNumber, label: `${peer.person.displayName} - ${where}${STATUS_SUFFIX[status]}` };
  });
}

const STATUS_SUFFIX: Readonly<Record<Exclude<PeerStatus, "gone">, string>> = { here: "", away: " (away)" };

/** Whether a shown peer is drawn faded. */
export const PEER_IS_AWAY: Readonly<Record<Exclude<PeerStatus, "gone">, boolean>> = { here: false, away: true };

function activityIsIdle(activity: PresenceActivity): boolean {
  switch (activity) {
    case "idle":
      return true;
    case "editing":
    case "presenting":
      return false;
    default:
      return assertNever(activity);
  }
}
