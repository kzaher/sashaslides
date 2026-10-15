/**
 * Every deck operation with its access rule (SPEC.md 21.2 and 21.5), shared by the HTTP router,
 * the WebSocket upgrade and `DeckService` -- so a rule is decided once, whoever asks.
 *
 * Key decisions:
 *
 *  - NOT A MEMBER READS AS NOT FOUND. Every operation first resolves the caller's role
 *    (`roleOf`, members and link sharing); no role is `notFound`, never `notPermitted`, so
 *    membership is not disclosed. A role without the operation's permission is `notPermitted`.
 *  - A CHANGE OF ACCESS REACHES OPEN SOCKETS AT ONCE. After any change to members or link sharing,
 *    each open connection's role is recomputed: a lowered role is applied and announced
 *    (`accessChanged`), a lost one closes the socket `accessRevoked`.
 *  - INVITATIONS BECOME MEMBERSHIPS when an account with that address signs in
 *    (`acceptInvitations`, called by the session start, the add-on's identity and the session
 *    endpoint). An address that already belongs to an account is added at once.
 *  - LIMITS ARE CHECKED HERE (COLLABORATION_LIMITS): decks per account, members per deck,
 *    invitations per account per day (counted in memory: a restart forgives the day), assets per
 *    deck, connections per deck and per account.
 */
import { createHash, randomBytes } from "node:crypto";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import { COLLABORATION_LIMITS, type AgentRevertOutcome, type CloseReason } from "../engine/src/contracts/collaboration.ts";
import { roleAllows, type DeckMember, type DeckPermission, type DeckRole, type LinkSharing } from "../engine/src/contracts/deck-access.ts";
import type { DeckDetailsBody, DeckSummary, InviteBody } from "../engine/src/contracts/deck-api.ts";
import type { AssetMediaType } from "../engine/src/contracts/document.ts";
import type { AssetId, CommandId, DeckId, PersonId } from "../engine/src/contracts/ids.ts";
import type { RoomConnection, RoomConnectionPort } from "../engine/src/server/index.ts";
import type { AccountId } from "../http/account-vault";
import type { DeckAccounts, DeckPeople } from "./deck-accounts";
import { emailHash, isEmailAddress, newDeckId, normaliseEmail, personIdFor } from "./deck-identity";
import { roleOf, type DeckRecord, type InvitationRecord } from "./deck-records";
import type { DeckLease, DeckRegistry } from "./deck-registry";
import type { DeckStorage, StoredAsset } from "./deck-storage";

/** What an operation answers when it did not do the thing. */
export type Refusal =
  | Readonly<{ kind: "notFound" }>
  | Readonly<{ kind: "notPermitted" }>
  | Readonly<{ kind: "limitReached"; message: string }>
  | Readonly<{ kind: "invalidRequest"; message: string }>
  | Readonly<{ kind: "tooLarge"; message: string }>;

export type Outcome<TValue> = Readonly<{ kind: "ok"; value: TValue }> | Refusal;

export type DeckAccess = Readonly<{ record: DeckRecord; role: DeckRole }>;

export type DeckManager = Readonly<{
  registry: DeckRegistry;
  listDecks(options: Readonly<{ accountId: AccountId }>): Promise<readonly DeckSummary[]>;
  createDeck(options: Readonly<{ accountId: AccountId; title: string }>): Promise<Outcome<Readonly<{ lease: DeckLease; summary: DeckSummary }>>>;
  /** The caller's access, or null when the deck is unknown or they may not read it. */
  access(options: Readonly<{ accountId: AccountId; deckId: DeckId }>): Promise<DeckAccess | null>;
  summary(options: Readonly<{ record: DeckRecord; role: DeckRole }>): Promise<DeckSummary>;
  details(options: Readonly<{ accountId: AccountId; deckId: DeckId }>): Promise<Outcome<DeckDetailsBody>>;
  setLinkSharing(options: Readonly<{ accountId: AccountId; deckId: DeckId; linkSharing: LinkSharing }>): Promise<Outcome<DeckDetailsBody>>;
  deleteDeck(options: Readonly<{ accountId: AccountId; deckId: DeckId }>): Promise<Outcome<null>>;
  invite(options: Readonly<{ accountId: AccountId; deckId: DeckId; email: string; role: Exclude<DeckRole, "owner"> }>): Promise<Outcome<InviteBody>>;
  changeMember(options: Readonly<{ accountId: AccountId; deckId: DeckId; personId: string; role: Exclude<DeckRole, "owner"> }>): Promise<Outcome<DeckDetailsBody>>;
  removeMember(options: Readonly<{ accountId: AccountId; deckId: DeckId; personId: string }>): Promise<Outcome<DeckDetailsBody>>;
  removeInvitation(options: Readonly<{ accountId: AccountId; deckId: DeckId; invitationId: string }>): Promise<Outcome<DeckDetailsBody>>;
  acceptInvitations(options: Readonly<{ accountId: AccountId }>): Promise<void>;
  putAsset(options: Readonly<{ accountId: AccountId; deckId: DeckId; bytes: Uint8Array; mediaType: AssetMediaType }>): Promise<Outcome<Readonly<{ assetId: AssetId; byteLength: number }>>>;
  readAsset(options: Readonly<{ accountId: AccountId; deckId: DeckId; assetId: AssetId }>): Promise<Outcome<StoredAsset>>;
  revertAgentSession(options: Readonly<{ accountId: AccountId; deckId: DeckId; agentSessionId: string }>): Promise<Outcome<AgentRevertOutcome>>;
  /** Opens a socket's room connection after the access and connection-count checks. */
  connect(
    options: Readonly<{ accountId: AccountId; deckId: DeckId; discussionAfter: number; port: RoomConnectionPort }>,
  ): Promise<Readonly<{ kind: "connected"; connection: RoomConnection }> | Readonly<{ kind: "refused"; reason: CloseReason }>>;
  findDeckByAddonBinding(options: Readonly<{ bindingSecretHash: string }>): DeckId | null;
  /** "Delete my data" for decks: owned decks deleted, memberships removed, sockets closed, profile deleted. */
  eraseAccount(options: Readonly<{ accountId: AccountId }>): Promise<void>;
}>;

export function createDeckManager(
  options: Readonly<{
    registry: DeckRegistry;
    storage: DeckStorage;
    accounts: DeckAccounts;
    people: DeckPeople;
    now: () => number;
    random: (size: number) => Uint8Array;
  }>,
): DeckManager {
  const { registry, storage, accounts, people, now } = options;
  const invitationsSent = new Map<AccountId, number[]>();
  const connectingByAccount = new Map<AccountId, number>();
  const connectingByDeck = new Map<DeckId, number>();

  /** Counts one connection being opened until the returned scope ends. */
  const countConnecting = ({ accountId, deckId }: Readonly<{ accountId: AccountId; deckId: DeckId }>): Disposable => {
    const adjust = <TKey>(counts: Map<TKey, number>, key: TKey, change: number): void => {
      const next = (counts.get(key) ?? 0) + change;
      if (next <= 0) counts.delete(key);
      else counts.set(key, next);
    };
    adjust(connectingByAccount, accountId, 1);
    adjust(connectingByDeck, deckId, 1);
    return {
      [Symbol.dispose]: () => {
        adjust(connectingByAccount, accountId, -1);
        adjust(connectingByDeck, deckId, -1);
      },
    };
  };

  const access = async ({ accountId, deckId }: Readonly<{ accountId: AccountId; deckId: DeckId }>): Promise<DeckAccess | null> => {
    const record = await registry.readRecord({ deckId });
    if (record === null) return null;
    const role = roleOf({ record, accountId });
    return role === null ? null : { record, role };
  };

  /** The caller's access when they hold `permission`, else the refusal (see the header). */
  const permitted = async (request: Readonly<{ accountId: AccountId; deckId: DeckId; permission: DeckPermission }>): Promise<DeckAccess | Refusal> => {
    const found = await access(request);
    if (found === null) return { kind: "notFound" };
    if (!roleAllows({ role: found.role, permission: request.permission })) return { kind: "notPermitted" };
    return found;
  };

  const summary = async ({ record, role }: Readonly<{ record: DeckRecord; role: DeckRole }>): Promise<DeckSummary> => ({
    deckId: record.deckId,
    title: record.title,
    role,
    owner: (await people.callerFor({ accountId: record.ownerAccountId })).person,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    googleSlides: record.googleSlides,
  });

  const details = async ({ record, role }: DeckAccess): Promise<DeckDetailsBody> => {
    const sharer = roleAllows({ role, permission: "share" });
    const members = await membersOf({ record, people });
    const loaded = registry.loaded({ deckId: record.deckId });
    return {
      deck: await summary({ record, role }),
      members: sharer ? members : members.map((member) => ({ ...member, email: null })),
      invitations: sharer ? record.invitations.map(({ invitationId, email, role: invitedRole, invitedAt }) => ({ invitationId, email, role: invitedRole, invitedAt })) : [],
      linkSharing: record.linkSharing,
      agentSessions: loaded === null ? [] : loaded.room.agentSessions(),
    };
  };

  /** Recomputes every open connection's role after a change (see the header). */
  const pushAccess = (record: DeckRecord): void => {
    for (const { accountId, connection } of registry.connectionsOfDeck({ deckId: record.deckId })) {
      const role = roleOf({ record, accountId });
      if (role === null) connection.closeWith("accessRevoked");
      else if (role !== connection.role()) connection.setRole(role);
    }
  };

  const changeRecord = async (deckId: DeckId, change: (record: DeckRecord) => DeckRecord): Promise<DeckRecord | null> => {
    const next = await registry.updateRecord({ deckId, change });
    if (next !== null) pushAccess(next);
    return next;
  };

  const detailsAfter = async (accountId: AccountId, record: DeckRecord | null): Promise<Outcome<DeckDetailsBody>> => {
    if (record === null) return { kind: "notFound" };
    const role = roleOf({ record, accountId });
    if (role === null) return { kind: "notFound" };
    return { kind: "ok", value: await details({ record, role }) };
  };

  const memberWithPersonId = (record: DeckRecord, personId: string) => record.members.find((member) => personIdFor({ accountId: member.accountId }) === personId);

  return {
    registry,
    listDecks: async ({ accountId }) => {
      const summaries: DeckSummary[] = [];
      for (const [deckId, entry] of Object.entries(storage.readIndex().decks)) {
        if (entry.ownerAccountId !== accountId && !entry.memberAccountIds.includes(accountId)) continue;
        // Index keys are deck ids by construction (deck-records.ts `parseDeckIndex` checked them).
        const found = await access({ accountId, deckId: deckId as DeckId });
        if (found !== null) summaries.push(await summary(found));
      }
      return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
    },
    createDeck: async ({ accountId, title }) => {
      const owned = Object.values(storage.readIndex().decks).filter((entry) => entry.ownerAccountId === accountId).length;
      if (owned >= COLLABORATION_LIMITS.maximumDecksPerAccount) {
        return { kind: "limitReached", message: `An account can own at most ${String(COLLABORATION_LIMITS.maximumDecksPerAccount)} decks.` };
      }
      const createdAt = now();
      const record: DeckRecord = {
        version: 1,
        deckId: newDeckId(options.random),
        ownerAccountId: accountId,
        members: [{ accountId, role: "owner", addedAt: createdAt }],
        invitations: [],
        linkSharing: { kind: "off" },
        googleSlides: null,
        addonBindings: [],
        title,
        createdAt,
        updatedAt: createdAt,
      };
      const lease = await registry.createDeck({ record });
      if (title.trim() !== "" && lease.deck.room.snapshot().title !== title) {
        lease.deck.room.applyEnvelope({
          envelope: {
            // `cm_` and 18 hexadecimal characters match ids.ts OBJECT_ID_PATTERN; the brand records that.
            commandId: `cm_${randomBytes(9).toString("hex")}` as CommandId,
            author: { kind: "person", personId: personIdFor({ accountId }) },
            commands: [{ kind: "setTitle", title }],
            selectionBefore: { kind: "none" },
            selectionAfter: { kind: "none" },
            mergeWithPrevious: false,
          },
          summaryForCollaborators: "",
        });
      }
      return { kind: "ok", value: { lease, summary: await summary({ record, role: "owner" }) } };
    },
    access,
    summary,
    details: async ({ accountId, deckId }) => {
      const found = await access({ accountId, deckId });
      return found === null ? { kind: "notFound" } : { kind: "ok", value: await details(found) };
    },
    setLinkSharing: async ({ accountId, deckId, linkSharing }) => {
      const found = await permitted({ accountId, deckId, permission: "share" });
      if (!("record" in found)) return found;
      return detailsAfter(accountId, await changeRecord(deckId, (record) => ({ ...record, linkSharing })));
    },
    deleteDeck: async ({ accountId, deckId }) => {
      const found = await permitted({ accountId, deckId, permission: "deleteDeck" });
      if (!("record" in found)) return found;
      await registry.deleteDeck({ deckId, reason: "deckDeleted" });
      return { kind: "ok", value: null };
    },
    invite: async ({ accountId, deckId, email, role }) => {
      const found = await permitted({ accountId, deckId, permission: "share" });
      if (!("record" in found)) return found;
      if (!isEmailAddress(email)) return { kind: "invalidRequest", message: "That is not an email address." };
      const sentToday = (invitationsSent.get(accountId) ?? []).filter((at) => now() - at < DAY_MILLISECONDS);
      if (sentToday.length >= COLLABORATION_LIMITS.maximumInvitationsPerAccountPerDay) {
        return { kind: "limitReached", message: `You can invite at most ${String(COLLABORATION_LIMITS.maximumInvitationsPerAccountPerDay)} people a day.` };
      }
      if (found.record.members.length + found.record.invitations.length >= COLLABORATION_LIMITS.maximumMembersPerDeck) {
        return { kind: "limitReached", message: `A deck can have at most ${String(COLLABORATION_LIMITS.maximumMembersPerDeck)} people.` };
      }
      invitationsSent.set(accountId, [...sentToday, now()]);
      const invitee = await accounts.findByEmail({ email });
      if (invitee !== null && found.record.members.some((member) => member.accountId === invitee)) {
        return { kind: "ok", value: { outcome: "alreadyMember", details: await details(found) } };
      }
      const outcome: InviteBody["outcome"] = invitee === null ? "invited" : "added";
      const next = await changeRecord(deckId, (record) => {
        if (invitee !== null) return { ...record, members: [...record.members, { accountId: invitee, role, addedAt: now() }] };
        const hash = emailHash(email);
        const invitation: InvitationRecord = {
          invitationId: `iv_${Buffer.from(options.random(12)).toString("hex")}`,
          emailHash: hash,
          email: normaliseEmail(email),
          role,
          invitedAt: now(),
          invitedBy: accountId,
        };
        return { ...record, invitations: [...record.invitations.filter((existing) => existing.emailHash !== hash), invitation] };
      });
      const after = await detailsAfter(accountId, next);
      return after.kind === "ok" ? { kind: "ok", value: { outcome, details: after.value } } : after;
    },
    changeMember: async ({ accountId, deckId, personId, role }) => {
      const found = await permitted({ accountId, deckId, permission: "share" });
      if (!("record" in found)) return found;
      const member = memberWithPersonId(found.record, personId);
      if (member === undefined) return { kind: "notFound" };
      if (member.role === "owner") return { kind: "notPermitted" };
      return detailsAfter(
        accountId,
        await changeRecord(deckId, (record) => ({ ...record, members: record.members.map((candidate) => (candidate.accountId === member.accountId ? { ...candidate, role } : candidate)) })),
      );
    },
    removeMember: async ({ accountId, deckId, personId }) => {
      const found = await access({ accountId, deckId });
      if (found === null) return { kind: "notFound" };
      const member = memberWithPersonId(found.record, personId);
      if (member === undefined) return { kind: "notFound" };
      const self = member.accountId === accountId;
      if (member.role === "owner" || (!self && !roleAllows({ role: found.role, permission: "share" }))) return { kind: "notPermitted" };
      const next = await changeRecord(deckId, (record) => ({ ...record, members: record.members.filter((candidate) => candidate.accountId !== member.accountId) }));
      if (self) return next === null ? { kind: "notFound" } : { kind: "ok", value: await details({ record: next, role: roleOf({ record: next, accountId }) ?? "viewer" }) };
      return detailsAfter(accountId, next);
    },
    removeInvitation: async ({ accountId, deckId, invitationId }) => {
      const found = await permitted({ accountId, deckId, permission: "share" });
      if (!("record" in found)) return found;
      if (!found.record.invitations.some((invitation) => invitation.invitationId === invitationId)) return { kind: "notFound" };
      return detailsAfter(accountId, await changeRecord(deckId, (record) => ({ ...record, invitations: record.invitations.filter((invitation) => invitation.invitationId !== invitationId) })));
    },
    acceptInvitations: async ({ accountId }) => {
      const hashes = new Set((await accounts.emailsOf({ accountId })).map(emailHash));
      if (hashes.size === 0) return;
      for (const [deckId, entry] of Object.entries(storage.readIndex().decks)) {
        if (!entry.invitationEmailHashes.some((hash) => hashes.has(hash))) continue;
        // Index keys are deck ids by construction (deck-records.ts `parseDeckIndex`).
        await changeRecord(deckId as DeckId, (record) => {
          const accepted = record.invitations.filter((invitation) => hashes.has(invitation.emailHash));
          const [first] = accepted;
          if (first === undefined) return record;
          const already = record.members.some((member) => member.accountId === accountId);
          return {
            ...record,
            invitations: record.invitations.filter((invitation) => !hashes.has(invitation.emailHash)),
            members: already ? record.members : [...record.members, { accountId, role: first.role, addedAt: now() }],
          };
        });
      }
    },
    putAsset: async ({ accountId, deckId, bytes, mediaType }) => {
      const found = await permitted({ accountId, deckId, permission: "editDocument" });
      if (!("record" in found)) return found;
      if (bytes.length > COLLABORATION_LIMITS.maximumAssetBytes) return { kind: "tooLarge", message: "An image can be at most 25 megabytes." };
      // The content address: lowercase hexadecimal SHA-256 (ids.ts `ASSET_ID_PATTERN`).
      const assetId = createHash("sha256").update(bytes).digest("hex") as AssetId;
      const usage = await storage.assetUsage({ deckId });
      if (usage.assetIds.includes(assetId)) return { kind: "ok", value: { assetId, byteLength: bytes.length } };
      if (usage.count >= ASSETS_PER_DECK || usage.bytes + bytes.length > COLLABORATION_LIMITS.maximumAssetBytesPerDeck) {
        return { kind: "tooLarge", message: `A deck holds at most ${String(ASSETS_PER_DECK)} images.` };
      }
      await storage.putAsset({ deckId, ownerAccountId: found.record.ownerAccountId, assetId, mediaType, bytes });
      return { kind: "ok", value: { assetId, byteLength: bytes.length } };
    },
    readAsset: async ({ accountId, deckId, assetId }) => {
      const found = await access({ accountId, deckId });
      if (found === null) return { kind: "notFound" };
      const stored = await storage.readAsset({ deckId, ownerAccountId: found.record.ownerAccountId, assetId });
      return stored === null ? { kind: "notFound" } : { kind: "ok", value: stored };
    },
    revertAgentSession: async ({ accountId, deckId, agentSessionId }) => {
      const found = await permitted({ accountId, deckId, permission: "revertAgentEdits" });
      if (!("record" in found)) return found;
      const lease = await registry.acquire({ deckId });
      if (lease === null) return { kind: "notFound" };
      try {
        return { kind: "ok", value: lease.deck.room.revertAgentSession({ agentSessionId }) };
      } finally {
        lease.release();
      }
    },
    connect: async ({ accountId, deckId, discussionAfter, port }) => {
      const found = await access({ accountId, deckId });
      if (found === null) return { kind: "refused", reason: "deckNotFound" };
      // Connections still being opened count too: the awaits below would otherwise let a burst of
      // simultaneous upgrades all pass the check before any of them is registered.
      if (registry.connectionsOf({ accountId }).length + (connectingByAccount.get(accountId) ?? 0) >= COLLABORATION_LIMITS.maximumConnectionsPerAccount) {
        return { kind: "refused", reason: "tooManyConnections" };
      }
      if (registry.connectionsOfDeck({ deckId }).length + (connectingByDeck.get(deckId) ?? 0) >= COLLABORATION_LIMITS.maximumConnectionsPerDeck) {
        return { kind: "refused", reason: "tooManyConnections" };
      }
      const connecting = countConnecting({ accountId, deckId });
      try {
        const person = (await people.callerFor({ accountId })).person;
        const connection = await registry.connect({ deckId, accountId, person, role: found.role, discussionAfter, port });
        return connection === null ? { kind: "refused", reason: "deckNotFound" } : { kind: "connected", connection };
      } finally {
        connecting[Symbol.dispose]();
      }
    },
    findDeckByAddonBinding: ({ bindingSecretHash }) => {
      const match = Object.entries(storage.readIndex().decks).find(([, entry]) => entry.addonBindingHashes.includes(bindingSecretHash));
      // Index keys are deck ids by construction (deck-records.ts `parseDeckIndex`).
      return match === undefined ? null : (match[0] as DeckId);
    },
    eraseAccount: async ({ accountId }) => {
      for (const [deckId, entry] of Object.entries(storage.readIndex().decks)) {
        // Index keys are deck ids by construction (deck-records.ts `parseDeckIndex`).
        const id = deckId as DeckId;
        if (entry.ownerAccountId === accountId) {
          await registry.deleteDeck({ deckId: id, reason: "deckDeleted" });
          continue;
        }
        if (!entry.memberAccountIds.includes(accountId)) continue;
        await changeRecord(id, (record) => ({ ...record, members: record.members.filter((member) => member.accountId !== accountId) }));
      }
      for (const { connection } of registry.connectionsOf({ accountId })) connection.closeWith("accessRevoked");
      await storage.deleteProfile({ accountId });
      people.forget({ accountId });
    },
  };
}

/** The people list a room and the details body show; emails for everyone (rooms strip them per role). */
export async function membersOf(options: Readonly<{ record: DeckRecord; people: DeckPeople }>): Promise<readonly DeckMember[]> {
  const members: DeckMember[] = [];
  for (const member of options.record.members) {
    const caller = await options.people.callerFor({ accountId: member.accountId });
    members.push({ person: caller.person, role: member.role, email: await options.people.emailOf({ accountId: member.accountId }) });
  }
  return members;
}

/** `PersonId` of an account, re-exported for routes that address members by person. */
export function memberPersonId(accountId: AccountId): PersonId {
  return personIdFor({ accountId });
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
/** SPEC.md 21.10: 512 assets per deck. */
const ASSETS_PER_DECK = 512;

/** Exhaustiveness helper for callers that switch over `Refusal`. */
export function refusalStatus(refusal: Refusal): number {
  switch (refusal.kind) {
    case "notFound":
      return 404;
    case "notPermitted":
      return 403;
    case "limitReached":
      return 409;
    case "invalidRequest":
      return 400;
    case "tooLarge":
      return 413;
    default:
      return assertNever(refusal);
  }
}
