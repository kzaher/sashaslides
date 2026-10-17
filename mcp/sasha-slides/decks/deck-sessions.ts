/**
 * The deck web application's sessions (SPEC.md 21.3, deck-api.ts): the `sasha_deck` cookie for a
 * browser on sashaslides.com, and the single-use embed ticket that the add-on dialog exchanges for
 * an in-memory bearer token (third-party frames get no cookies).
 *
 * Key decisions:
 *
 *  - THE COOKIE IS STATELESS: `payload.HMAC-SHA256(SASHA_SESSION_SECRET, "sasha-deck-session.v1." +
 *    payload)` over `{accountId, exp, csrf}`, 12 hours, `Path=/deck-api; HttpOnly; Secure;
 *    SameSite=Strict`. Its own label keeps an `/account` cookie from ever passing as a deck cookie.
 *    The CSRF token lives inside it, so `X-Sasha-Csrf` is checked without any server state.
 *  - TICKETS AND BEARERS ARE STORED HASHED, in memory: a leaked heap snapshot or log line holding a
 *    hash opens nothing. A ticket is taken out on first use (2 minutes); a bearer is valid for ONE
 *    deck, 15 minutes, and renewing it revokes the old one. A restart forgets them all; the frame
 *    then says "Reopen from the add-on menu".
 *  - Both maps are bounded and swept of expired entries on every issue.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  DECK_SESSION_COOKIE_NAME,
  DECK_SESSION_COOKIE_PATH,
  DECK_SESSION_LIFETIME_MILLISECONDS,
  EMBED_BEARER_LIFETIME_MILLISECONDS,
  EMBED_TICKET_LIFETIME_MILLISECONDS,
} from "../engine/src/contracts/deck-api.ts";
import type { DeckId } from "../engine/src/contracts/ids.ts";
import type { EmbedTicketIssuer } from "../deck-contracts/deck-service-contract";
import type { AccountId } from "../http/account-vault";
import { clearCookie, cookieValues, setCookie, signedValues } from "../http/cookies";
import { createExpiringTable } from "../http/expiring-table";

/** A verified session, from the cookie or a bearer token. */
export type DeckSession =
  | Readonly<{ kind: "cookie"; accountId: AccountId; expiresAt: number; forgeryToken: string }>
  /** Valid for `deckId` only. */
  | Readonly<{ kind: "bearer"; accountId: AccountId; expiresAt: number; forgeryToken: string; deckId: DeckId; tokenHash: string }>;

export type DeckSessionCookies = Readonly<{
  /** The `Set-Cookie` value for a fresh 12-hour session. */
  issue(options: Readonly<{ accountId: AccountId }>): Readonly<{ setCookie: string; session: DeckSession }>;
  read(request: IncomingMessage): Extract<DeckSession, { kind: "cookie" }> | null;
  /** The cookie that removes it. */
  clear(): string;
}>;

export function deckSessionCookies(options: Readonly<{ secret: string; now: () => number; randomToken: () => string }>): DeckSessionCookies {
  const { secret, now, randomToken } = options;
  const signed = signedValues({ secret, label: COOKIE_LABEL });
  return {
    issue: ({ accountId }) => {
      const expiresAt = now() + DECK_SESSION_LIFETIME_MILLISECONDS;
      const forgeryToken = randomToken();
      // The payload's field names are the wire format SPEC.md 21.3 fixes: {accountId, exp, csrf}.
      return {
        setCookie: setCookie({
          name: DECK_SESSION_COOKIE_NAME,
          value: signed.seal({ accountId, exp: expiresAt, csrf: forgeryToken }),
          path: DECK_SESSION_COOKIE_PATH,
          maxAgeSeconds: DECK_SESSION_LIFETIME_MILLISECONDS / 1000,
          sameSite: "Strict",
        }),
        session: { kind: "cookie", accountId, expiresAt, forgeryToken },
      };
    },
    read: (request) => {
      for (const value of cookieValues({ request, name: DECK_SESSION_COOKIE_NAME })) {
        const record = signed.open(value);
        if (record === null) continue;
        const accountId = record["accountId"];
        const expiresAt = record["exp"];
        const forgeryToken = record["csrf"];
        if (typeof accountId !== "string" || typeof expiresAt !== "number" || typeof forgeryToken !== "string") continue;
        if (expiresAt <= now()) continue;
        return { kind: "cookie", accountId, expiresAt, forgeryToken };
      }
      return null;
    },
    clear: () => clearCookie({ name: DECK_SESSION_COOKIE_NAME, path: DECK_SESSION_COOKIE_PATH, sameSite: "Strict" }),
  };
}

export type EmbedSessions = EmbedTicketIssuer &
  Readonly<{
    /** Takes the ticket (single use) and mints a bearer for its deck; null when unknown, used or expired. */
    exchange(options: Readonly<{ ticket: string }>): Readonly<{ bearerToken: string; session: Extract<DeckSession, { kind: "bearer" }> }> | null;
    /** A fresh bearer for the same account and deck; the old one stops working. */
    renew(options: Readonly<{ session: Extract<DeckSession, { kind: "bearer" }> }>): Readonly<{ bearerToken: string; session: Extract<DeckSession, { kind: "bearer" }> }>;
    verify(options: Readonly<{ bearerToken: string }>): Extract<DeckSession, { kind: "bearer" }> | null;
    /** Erasing an account revokes its bearers and tickets. */
    revokeAccount(options: Readonly<{ accountId: AccountId }>): void;
  }>;

export function createEmbedSessions(options: Readonly<{ now: () => number; randomToken: () => string }>): EmbedSessions {
  const { now, randomToken } = options;
  const tickets = createExpiringTable<Readonly<{ accountId: AccountId; deckId: DeckId }>>({ now, capacity: MAXIMUM_ENTRIES });
  const bearers = createExpiringTable<Extract<DeckSession, { kind: "bearer" }>>({ now, capacity: MAXIMUM_ENTRIES });

  const mint = (accountId: AccountId, deckId: DeckId): Readonly<{ bearerToken: string; session: Extract<DeckSession, { kind: "bearer" }> }> => {
    const bearerToken = randomToken();
    const tokenHash = hashOf(bearerToken);
    const session: Extract<DeckSession, { kind: "bearer" }> = {
      kind: "bearer",
      accountId,
      deckId,
      expiresAt: now() + EMBED_BEARER_LIFETIME_MILLISECONDS,
      forgeryToken: randomToken(),
      tokenHash,
    };
    bearers.put({ key: tokenHash, value: session, lifetimeMilliseconds: EMBED_BEARER_LIFETIME_MILLISECONDS });
    return { bearerToken, session };
  };

  return {
    issue: ({ accountId, deckId }) => {
      const ticket = randomToken();
      tickets.put({ key: hashOf(ticket), value: { accountId, deckId }, lifetimeMilliseconds: EMBED_TICKET_LIFETIME_MILLISECONDS });
      return Promise.resolve(ticket);
    },
    exchange: ({ ticket }) => {
      const found = tickets.take(hashOf(ticket));
      if (found === null) return null;
      return mint(found.accountId, found.deckId);
    },
    renew: ({ session }) => {
      bearers.delete(session.tokenHash);
      return mint(session.accountId, session.deckId);
    },
    verify: ({ bearerToken }) => {
      return bearers.get(hashOf(bearerToken));
    },
    revokeAccount: ({ accountId }) => {
      tickets.deleteWhere((ticket) => ticket.accountId === accountId);
      bearers.deleteWhere((bearer) => bearer.accountId === accountId);
    },
  };
}

const COOKIE_LABEL = "sasha-deck-session.v1.";
const MAXIMUM_ENTRIES = 100_000;

function hashOf(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}
