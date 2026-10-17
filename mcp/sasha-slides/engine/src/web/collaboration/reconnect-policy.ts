// WHEN TO TRY AGAIN, AND WHAT A CLOSE MEANS (collaboration.ts `RECONNECT_POLICY`,
// `CLOSE_CODE_BY_REASON`).
//
// Key decisions:
//
//  * FULL JITTER: the wait is `random * min(maximum, initial * multiplier^attempt)`, the random
//    draw arriving WITH the event that caused the wait (the socket's close, a failed session
//    refresh), so the connection reducer stays pure and a test fixes the draw.
//  * A CLOSE CODE THE CONTRACT DOES NOT NAME (1006 when the network drops, 1001 when a proxy goes
//    away, anything a newer server invents) is "the server could not be reached": back off and try
//    again. Only the named application codes may stop the client for good.
//  * WHAT THE CLIENT DOES AND THE EDITOR SHOWS FOR EACH REASON is one total table
//    (`CLOSE_HANDLING`): the decision (`kind`) and its wording side by side, so a new close reason
//    fails to compile until it decides both (deck-collaboration.test.ts drives every reason).

import {
  CLOSE_CODE_BY_REASON,
  RECONNECT_POLICY,
  type ClosedReason,
  type CloseReason,
  type OfflineReason,
} from "../../contracts/collaboration.ts";

/** The full-jitter wait before reconnect attempt number `attempt` (0 for the first retry). */
export function reconnectDelayMilliseconds(options: Readonly<{ attempt: number; random: number }>): number {
  const ceiling = Math.min(
    RECONNECT_POLICY.maximumDelayMilliseconds,
    RECONNECT_POLICY.initialDelayMilliseconds * RECONNECT_POLICY.multiplier ** options.attempt,
  );
  return ceiling * options.random;
}

/** The contract reason behind an application close code, or null for any other code. */
export function closeReasonOf(code: number): CloseReason | null {
  return CLOSE_REASON_BY_CODE.get(code) ?? null;
}

/** What the client does after each close reason, with what the editor shows meanwhile. */
export type CloseHandling =
  | Readonly<{ kind: "refreshSessionThenReconnect" }>
  | Readonly<{ kind: "reconnectWithBackoff"; offlineReason: OfflineReason }>
  | Readonly<{ kind: "stop"; closedReason: ClosedReason }>;

/** Total over close reasons, so a new reason must decide. */
export const CLOSE_HANDLING: Readonly<Record<CloseReason, CloseHandling>> = {
  unauthenticated: { kind: "refreshSessionThenReconnect" },
  accessRevoked: { kind: "stop", closedReason: "accessRevoked" },
  deckNotFound: { kind: "stop", closedReason: "deckNotFound" },
  deckDeleted: { kind: "stop", closedReason: "deckDeleted" },
  rateLimited: { kind: "reconnectWithBackoff", offlineReason: "rateLimited" },
  protocolVersionUnsupported: { kind: "stop", closedReason: "protocolVersionUnsupported" },
  documentSchemaTooNew: { kind: "stop", closedReason: "documentSchemaTooNew" },
  tooManyConnections: { kind: "reconnectWithBackoff", offlineReason: "tooManyConnections" },
  serverShuttingDown: { kind: "reconnectWithBackoff", offlineReason: "serverRestarting" },
  deckUnreadable: { kind: "stop", closedReason: "deckUnreadable" },
};

/** How a close with `code` is handled: a named reason's entry, or backoff for any other code. */
export function closeHandlingFor(code: number): CloseHandling {
  const reason = closeReasonOf(code);
  return reason === null ? { kind: "reconnectWithBackoff", offlineReason: "serverUnreachable" } : CLOSE_HANDLING[reason];
}

const CLOSE_REASON_BY_CODE: ReadonlyMap<number, CloseReason> = new Map(
  // Object.entries of a Record<CloseReason, number> yields exactly its CloseReason keys.
  (Object.entries(CLOSE_CODE_BY_REASON) as [CloseReason, number][]).map(([reason, code]) => [code, reason]),
);
