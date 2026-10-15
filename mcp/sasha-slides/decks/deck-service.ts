/**
 * `DeckService` and `DeckHandle` (deck-contracts/deck-service-contract.ts) over the live rooms, for
 * the Google Slides module and Claude's deck tools. Every call goes through the deck's ROOM, so an
 * agent's edit or an import reaches open editors at once and is persisted like any other change.
 *
 * Key decisions:
 *
 *  - A HANDLE IS A LEASE. Opening a deck acquires the room (loading it); disposing the handle
 *    releases the lease, and the registry unloads the room once nothing holds it (deck-registry.ts).
 *  - THE ROLE IS RE-READ ON EVERY CALL from the cached record, so an owner lowering a role mid-session
 *    takes effect on the next call. A caller removed while holding a handle keeps reading what it
 *    already opened but every permission check fails.
 *  - A PERSON ENVELOPE MUST BE SIGNED BY THE CALLER. An import authored as someone else is refused
 *    `notPermitted`; an agent envelope carries the caller's agent session (the tools build it).
 */
import { roleAllows, type DeckPermission, type DeckRole } from "../engine/src/contracts/deck-access.ts";
import type { DeckSummary } from "../engine/src/contracts/deck-api.ts";
import type { DiscussionSnapshot, Person } from "../engine/src/contracts/discussion.ts";
import type { DeckCaller, DeckHandle, DeckOpenOutcome, DeckService } from "../deck-contracts/deck-service-contract";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { DeckManager } from "./deck-manager";
import { roleOf } from "./deck-records";
import type { DeckLease, DeckTimers } from "./deck-registry";

export function createDeckService(options: Readonly<{ manager: DeckManager; timers: DeckTimers }>): DeckService {
  const { manager } = options;
  const handleFor = async (caller: DeckCaller, lease: DeckLease): Promise<DeckHandle> => {
    const record = lease.deck.record();
    const owner = (await manager.summary({ record, role: "owner" })).owner;
    return deckHandle({ caller, lease, manager, owner, timers: options.timers });
  };
  return {
    listDecks: ({ caller }) => manager.listDecks({ accountId: caller.accountId }),
    createDeck: async ({ caller, title }): Promise<DeckOpenOutcome> => {
      const created = await manager.createDeck({ accountId: caller.accountId, title });
      switch (created.kind) {
        case "ok":
          return { kind: "opened", deck: await handleFor(caller, created.value.lease) };
        case "limitReached":
          return { kind: "limitReached", message: created.message };
        case "notFound":
        case "invalidRequest":
        case "tooLarge":
          return { kind: "notFound" };
        case "notPermitted":
          return { kind: "notPermitted" };
        default:
          return assertNever(created);
      }
    },
    openDeck: async ({ caller, deckId }) => {
      const access = await manager.access({ accountId: caller.accountId, deckId });
      if (access === null) return { kind: "notFound" };
      const lease = await manager.registry.acquire({ deckId });
      if (lease === null) return { kind: "notFound" };
      return { kind: "opened", deck: await handleFor(caller, lease) };
    },
    findDeckByAddonBinding: ({ bindingSecretHash }) => Promise.resolve(manager.findDeckByAddonBinding({ bindingSecretHash })),
  };
}

function deckHandle(
  options: Readonly<{ caller: DeckCaller; lease: DeckLease; manager: DeckManager; owner: Person; timers: DeckTimers }>,
): DeckHandle {
  const { caller, lease, manager, owner, timers } = options;
  const { deck } = lease;
  const currentRole = (): DeckRole | null => roleOf({ record: deck.record(), accountId: caller.accountId });
  const allows = (permission: DeckPermission): boolean => {
    const role = currentRole();
    return role !== null && roleAllows({ role, permission });
  };
  const summary = (): DeckSummary => {
    const record = deck.record();
    return {
      deckId: deck.deckId,
      title: deck.room.snapshot().title,
      role: currentRole() ?? "viewer",
      owner,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      googleSlides: record.googleSlides,
    };
  };
  let released = false;

  return {
    deckId: deck.deckId,
    role: () => currentRole(),
    summary,
    snapshot: () => deck.room.snapshot(),
    apply: ({ envelope, summaryForCollaborators }) => {
      if (!allows("editDocument")) return Promise.resolve({ kind: "notPermitted" });
      const author = envelope.author;
      switch (author.kind) {
        case "person":
          if (author.personId !== caller.person.id) return Promise.resolve({ kind: "notPermitted" });
          break;
        case "agent":
          break;
        default:
          return assertNever(author);
      }
      return Promise.resolve(deck.room.applyEnvelope({ envelope, summaryForCollaborators }));
    },
    revertAgentSession: ({ agentSessionId }) => {
      if (!allows("revertAgentEdits")) return Promise.resolve({ kind: "notPermitted" });
      return Promise.resolve(deck.room.revertAgentSession({ agentSessionId }));
    },
    discussion: () => deck.room.discussion(),
    submitDiscussion: ({ as, request }) => {
      const role = currentRole();
      if (role === null) return Promise.resolve({ kind: "rejected", requestId: request.requestId, reason: "notPermitted", message: "you are no longer a member of this deck" });
      return deck.room.submitDiscussion({ actor: as === "agent" ? caller.agent : caller.person, role, request });
    },
    waitForDiscussion: ({ afterSequence, timeoutMilliseconds, signal }) =>
      new Promise<DiscussionSnapshot>((resolve) => {
        const current = deck.room.discussion();
        if (current.sequence > afterSequence || signal.aborted) {
          resolve(current);
          return;
        }
        const finish = (): void => {
          listener[Symbol.dispose]();
          timer[Symbol.dispose]();
          signal.removeEventListener("abort", finish);
          resolve(deck.room.discussion());
        };
        const listener = deck.room.onDiscussion((snapshot) => {
          if (snapshot.sequence > afterSequence) finish();
        });
        const timer = timers.schedule({ delayMilliseconds: timeoutMilliseconds, run: finish });
        signal.addEventListener("abort", finish, { once: true });
      }),
    putAsset: async ({ bytes, mediaType }) => {
      const stored = await manager.putAsset({ accountId: caller.accountId, deckId: deck.deckId, bytes, mediaType });
      switch (stored.kind) {
        case "ok":
          return { kind: "stored", assetId: stored.value.assetId, byteLength: stored.value.byteLength };
        case "tooLarge":
        case "limitReached":
          return { kind: "tooLarge", message: stored.message };
        case "notFound":
        case "notPermitted":
        case "invalidRequest":
          return { kind: "notPermitted" };
        default:
          return assertNever(stored);
      }
    },
    readAsset: async ({ assetId }) => {
      const read = await manager.readAsset({ accountId: caller.accountId, deckId: deck.deckId, assetId });
      return read.kind === "ok" ? read.value : null;
    },
    googleSlidesLink: () => deck.record().googleSlides,
    setGoogleSlidesLink: async ({ link }) => {
      if (!allows("exchangeWithGoogleSlides")) throw new Error("this caller may not exchange this deck with Google Slides");
      await manager.registry.updateRecord({ deckId: deck.deckId, change: (record) => ({ ...record, googleSlides: link }) });
    },
    bindAddon: async ({ bindingSecretHash, presentationId }) => {
      if (!allows("exchangeWithGoogleSlides")) throw new Error("this caller may not bind this deck to a presentation");
      await manager.registry.updateRecord({
        deckId: deck.deckId,
        change: (record) => ({
          ...record,
          addonBindings: [...record.addonBindings.filter((binding) => binding.bindingSecretHash !== bindingSecretHash), { bindingSecretHash, presentationId }],
        }),
      });
    },
    [Symbol.asyncDispose]: () => {
      if (!released) {
        released = true;
        lease.release();
      }
      return Promise.resolve();
    },
  };
}
