// THE EDITOR INSIDE THE ADD-ON'S DIALOG (`/deck/<id>?embed=addon#ticket=<ticket>`, SPEC.md 21.3,
// 21.8, 21.13): no cookie reaches a third-party frame, so the page exchanges the single-use ticket
// in its address fragment for a 15-minute bearer token kept in memory, and renews that token two
// minutes before it expires.
//
// Key decisions:
//
//  * THE FRAGMENT IS REMOVED BEFORE THE EXCHANGE IS EVEN SENT (`history.replaceState`), so the
//    ticket never lingers in the address bar, the history, or a later copy of the address -- also
//    when the exchange fails. It was never sent to a server in the first place (fragments are not).
//  * THE TICKET IS EXCHANGED ONCE. A second call with the same address finds no fragment.
//  * RENEWAL RUNS ON THE INJECTED SCHEDULER, at `expiresAt - 2 minutes` by its clock; a failed
//    renewal is retried every 15 seconds until the token has expired, and then the page is told
//    (the dialog says "Reopen from the add-on menu"; the server forgot the token, e.g. a restart).

import type { SchedulerLike, Subscription } from "rxjs";
import type { EmbedSessionBody } from "../../contracts/deck-api.ts";
import { okBodyOf, problemOf, type DeckApiClient } from "../api/deck-api-client.ts";

/** Renew this long before the bearer expires (SPEC.md 21.3). */
export const BEARER_RENEW_BEFORE_EXPIRY_MILLISECONDS = 2 * 60 * 1000;
export const BEARER_RENEW_RETRY_MILLISECONDS = 15_000;

/** The slices of `location` and `history` the exchange uses. */
export type FrameAddress = Readonly<{
  hash: () => string;
  pathname: () => string;
  search: () => string;
  replaceState: (address: string) => void;
}>;

export type EmbeddedStart =
  | Readonly<{ kind: "started"; session: EmbedSessionBody }>
  | Readonly<{ kind: "noTicket" }>
  | Readonly<{ kind: "failed"; message: string }>;

/** `#ticket=<ticket>` (other fragment parameters ignored) -> the ticket, or null. */
export function ticketFromFragment(hash: string): string | null {
  const parameters = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const ticket = parameters.get("ticket");
  return ticket === null || ticket === "" ? null : ticket;
}

/** Reads and removes the ticket, then exchanges it (see the header). */
export async function startEmbeddedSession(options: Readonly<{ address: FrameAddress; api: DeckApiClient }>): Promise<EmbeddedStart> {
  const ticket = ticketFromFragment(options.address.hash());
  if (ticket === null) return { kind: "noTicket" };
  options.address.replaceState(`${options.address.pathname()}${options.address.search()}`);
  const result = await options.api.exchangeTicket({ ticket });
  const session = okBodyOf(result);
  return session === null ? { kind: "failed", message: problemOf(result) ?? "The editor could not be opened." } : { kind: "started", session };
}

/** Keeps the bearer fresh until disposed; `onExpired` once renewal is no longer possible. */
export function scheduleBearerRenewal(options: Readonly<{
  api: DeckApiClient;
  scheduler: SchedulerLike;
  expiresAt: number;
  onRenewed: (session: EmbedSessionBody) => void;
  onExpired: () => void;
}>): Disposable {
  let pending: Subscription | null = null;
  let disposed = false;
  let expiresAt = options.expiresAt;

  const schedule = (delay: number): void => {
    pending = options.scheduler.schedule(() => void renew(), Math.max(0, delay));
  };

  const renew = async (): Promise<void> => {
    const result = await options.api.renewBearer();
    if (disposed) return;
    const session = okBodyOf(result);
    if (session !== null) {
      expiresAt = session.expiresAt;
      options.onRenewed(session);
      schedule(expiresAt - BEARER_RENEW_BEFORE_EXPIRY_MILLISECONDS - options.scheduler.now());
      return;
    }
    if (options.scheduler.now() + BEARER_RENEW_RETRY_MILLISECONDS >= expiresAt) {
      options.onExpired();
      return;
    }
    schedule(BEARER_RENEW_RETRY_MILLISECONDS);
  };

  schedule(expiresAt - BEARER_RENEW_BEFORE_EXPIRY_MILLISECONDS - options.scheduler.now());
  return {
    [Symbol.dispose]: () => {
      disposed = true;
      pending?.unsubscribe();
    },
  };
}
