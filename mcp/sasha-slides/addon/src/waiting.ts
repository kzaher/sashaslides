// WHETHER ANYTHING IS LISTENING -- the one honest signal behind Ask Sasha's connection line.
//
// UI-CONTRACT.md, "Waiting for Sasha must be honest": the surface has to DISTINGUISH "something is
// attached" from "nobody is listening", because Sasha answers only while a Claude session has the
// sasha-slides connector attached. With none attached nothing ever comes back, and a real user once
// watched a count-up for 1 h 47 minutes with no session on the other end. The words were true; the
// spinner above them was the lie.
//
// WHAT CAN BE KNOWN, EXACTLY, AND WHAT CANNOT.
//
//   CAN: whether Sasha has ever ACTED in the followed set, and when it last did -- every session-log
//        event in Sasha's voice. Only an attached session writes one.
//   CAN: whether a connected client has READ the user's comments. PROTOCOL.md's `feedback-delivered`
//        receipt is appended by the server the moment `read_feedback` or `await_feedback` hands a
//        comment over, so a receipt is positive evidence that something was there.
//   CANNOT: whether a session is attached RIGHT NOW. Every arm below is a past tense; evidence older
//        than the delivery threshold proves only that something WAS here (`presenceIsSilent`).
//
// THE LOG IS THE ONLY SOURCE NOW. This used to also read the deck's comment pane and every
// candidate's comments, because the sidebar rendered them. Conversation happens in the deck's own
// comments now, which the comment bot answers, so those reads went with the panels that drew them:
// two `google.script.run` calls per poll, about 0.7 s each, for evidence the log already carries --
// the server appends `comment-answered` and `feedback-delivered` for the very replies and reads
// they used to find.

import { FEEDBACK_DELIVERY_THRESHOLD_MS } from "../../feedback-delivery.ts";
import { plural } from "./plural.ts";
import { assertNever } from "./protocol.ts";
import { sessionEventVoiceOf, type SessionEvent } from "./session-log.ts";

/**
 * WHETHER ANYTHING HAS BEEN LISTENING, and the strongest evidence for it.
 *
 * There is no `attached` arm: nothing proves a session is attached *right now*. The arms are ordered
 * by the strength of the evidence, and `sashaPresenceOf` picks the strongest: an act says strictly
 * more than a read.
 */
export type SashaPresence =
  /**
   * Sasha has acted in this session. `agoMs` is since the most recent thing it did; `heardAgoMs`
   * is since the newest evidence of ANY kind, act or receipt -- a receipt newer than the last act
   * still proves something was here more recently, and only that decides `presenceIsSilent`.
   */
  | Readonly<{ kind: "acted"; at: string; agoMs: number | null; heardAgoMs: number | null }>
  /**
   * A client READ the user's comments, `agoMs` ago, and has done nothing else. Evidence that
   * something was there; evidence of nothing further.
   */
  | Readonly<{ kind: "delivered"; at: string; agoMs: number | null }>
  /** Everything needed was read, and nothing in this session ever read or answered anything. */
  | Readonly<{ kind: "never-acted" }>
  /** A read that would have proved it has not come back, or failed. NEVER reported as "never". */
  | Readonly<{ kind: "unknown"; message: string }>;

/**
 * How the reads that could carry evidence are going, reduced to the one thing this decision needs:
 * the reason the answer cannot be trusted yet, or null when they are all in.
 */
export type PresenceReads = Readonly<{ incomplete: string | null }>;

/**
 * WHETHER PRESENCE SAYS NOTHING IS LISTENING NOW: no evidence ever, or only evidence older than
 * the delivery threshold. HOW TO CONNECT IS NEEDED BEFORE ANYTHING IS STUCK, so `never-acted` is
 * silent the moment the reads are in; `unknown` deliberately is NOT -- a read that has not finished
 * is not evidence of absence.
 *
 * STALE EVIDENCE IS NO EVIDENCE (user report, 2026-10-11: "it disappears even when there is no bot
 * connected"). Every followed set's log opens with the server's own `slides-staged`, so once any
 * candidate exists presence is `acted` for ever -- however long ago the session that staged them
 * went away. A connected session reads a comment well inside one threshold (feedback-delivery.ts),
 * so older evidence proves only that something WAS here. Without a clock nothing is accused.
 */
export function presenceIsSilent(presence: SashaPresence): boolean {
  switch (presence.kind) {
    case "never-acted":
      return true;
    case "unknown":
      return false;
    case "acted":
      return isStaleEvidence(presence.heardAgoMs);
    case "delivered":
      return isStaleEvidence(presence.agoMs);
    default:
      return assertNever(presence);
  }
}

/**
 * THE LAST PROOF THAT ANYTHING WAS LISTENING: the newest session-log event in Sasha's voice, or
 * failing that the newest delivery receipt.
 *
 * `reads` is how the reads are going. With no evidence AND an unfinished or failed read the answer
 * is `unknown`, never `never-acted`: "nobody has ever answered" is a claim, and a claim needs a
 * completed read behind it.
 */
export function sashaPresenceOf({
  events,
  reads,
  nowMs,
}: {
  events: readonly SessionEvent[];
  reads: PresenceReads;
  nowMs: number | null;
}): SashaPresence {
  const latest = latestSashaActivity(events);
  const read = newestDelivery(events);
  if (latest !== null) {
    const heard = read !== null && read > latest ? read : latest;
    return {
      kind: "acted",
      at: latest,
      agoMs: elapsedMsOf({ since: latest, nowMs }),
      heardAgoMs: elapsedMsOf({ since: heard, nowMs }),
    };
  }
  // SECOND, not first: an act proves a read happened too, so the stronger claim wins even when the
  // receipt is the newer file.
  if (read !== null) return { kind: "delivered", at: read, agoMs: elapsedMsOf({ since: read, nowMs }) };
  if (reads.incomplete !== null) return { kind: "unknown", message: reads.incomplete };
  return { kind: "never-acted" };
}

/** Milliseconds since an ISO timestamp, or null when the clock or the stamp cannot give one. */
export function elapsedMsOf({ since, nowMs }: { since: string; nowMs: number | null }): number | null {
  if (nowMs === null) return null;
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  // Clamped at zero: Drive's clock and the browser's are not the same clock, and "-3 s ago" reads
  // as a bug rather than as the sub-second skew it is.
  return Math.max(0, nowMs - at);
}

/**
 * A duration a person can read at a glance, and the unit a person would use for it. Seconds matter
 * in the first minute and stop mattering after an hour.
 */
export function describeElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null) return "just now";
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${pad(seconds % 60)} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${pad(minutes % 60)} min`;
  const days = Math.floor(hours / 24);
  return `${plural(days, "day")} ${pad(hours % 24)} h`;
}

/**
 * The newest timestamp only an attached session could have produced, or null. Through
 * `sessionEventVoiceOf`, so a new event kind is counted or not by its one voice declaration rather
 * than by a list of kinds copied into this file.
 */
function latestSashaActivity(events: readonly SessionEvent[]): string | null {
  const stamps = events.filter(isSashaVoice).map((event) => event.at);
  return newestUsable(stamps);
}

/**
 * The newest delivery receipt that carries a usable date. An undated receipt cannot be shown as
 * "read N ago", so it is not evidence here.
 */
function newestDelivery(events: readonly SessionEvent[]): string | null {
  const stamps = events.filter((event) => event.body.kind === "feedback-delivered").map((event) => event.at);
  return newestUsable(stamps);
}

function newestUsable(stamps: readonly string[]): string | null {
  const usable = stamps.filter((stamp) => stamp !== "" && Number.isFinite(Date.parse(stamp)));
  if (usable.length === 0) return null;
  return usable.reduce((newest, stamp) => (stamp > newest ? stamp : newest));
}

/** Whether an event was written by Sasha. A switch over the voice, so a new voice must be placed. */
function isSashaVoice(event: SessionEvent): boolean {
  const voice = sessionEventVoiceOf(event.body);
  switch (voice) {
    case "sasha":
      return true;
    case "user":
    case "deck":
    // A RECEIPT IS NOT AN ACT. It is evidence -- `sashaPresenceOf` reports it as `delivered` -- but
    // counting it here would make "Sasha last did something" mean "something looked at this".
    case "delivery":
    // An entry this build cannot read proves nothing about who wrote it, so it is not evidence.
    case "opaque":
      return false;
    default:
      return assertNever(voice);
  }
}

/** Evidence this old says something WAS here, not that it is. Null (no clock) accuses nobody. */
function isStaleEvidence(agoMs: number | null): boolean {
  return agoMs !== null && agoMs >= FEEDBACK_DELIVERY_THRESHOLD_MS;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
