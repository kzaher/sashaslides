/**
 * A `DeckService` FOR THE DECK TOOLS' TESTS, over the REAL engine model: every deck is a real
 * `DocumentStore` (validation, one transaction and one undo step per envelope, the yjs-schema text
 * rules) and a real discussion authority (`createMemoryDiscussionStore`'s rules and
 * `reduceDiscussionLog`). What it fakes is only the room around them: membership is a table the
 * test sets, an agent session's revert REPLAYS every other envelope onto a fresh copy of the deck
 * (the collaboration server uses one Y.UndoManager per agent session instead), and `agentEdit`
 * notices are recorded rather than broadcast.
 *
 * It stands in until the collaboration server's `decks/memory-deck-service.ts` lands; the tests
 * use only the `DeckService` contract plus the inspection helpers below, so they move over by
 * swapping the factory.
 */
import { createHash } from "node:crypto";
import type { AgentRevertOutcome } from "../../engine/src/contracts/collaboration.ts";
import { COLLABORATION_LIMITS } from "../../engine/src/contracts/collaboration.ts";
import type { CommandEnvelope, CommandOutcome, DocumentCommand } from "../../engine/src/contracts/commands.ts";
import { DECK_PERMISSIONS_BY_ROLE, type DeckPermission, type DeckRole } from "../../engine/src/contracts/deck-access.ts";
import type { DeckSummary } from "../../engine/src/contracts/deck-api.ts";
import type { DiscussionCommand, DiscussionLogEntry, DiscussionOutcome, DiscussionRequest, DiscussionSnapshot, Person } from "../../engine/src/contracts/discussion.ts";
import { EMPTY_DISCUSSION } from "../../engine/src/contracts/discussion.ts";
import type { AssetMediaType } from "../../engine/src/contracts/document.ts";
import type { DocumentStore } from "../../engine/src/contracts/document-store.ts";
import { mintId, parseAssetId, parseDeckId, parsePersonId, type AssetId, type DeckId, type IdSeed, type PersonId } from "../../engine/src/contracts/ids.ts";
import { createDocumentStore } from "../../engine/src/model/document-store.ts";
import { createMemoryDiscussionStore } from "../../engine/src/model/discussion-log.ts";
import { createTestStore, seededRandom } from "../../engine/src/model/testing/model-fixtures.ts";
import type { DeckApplyOutcome, DeckCaller, DeckHandle, DeckOpenOutcome, DeckService, AssetPutOutcome } from "../../deck-contracts/deck-service-contract.ts";

export type RecordedEnvelope = Readonly<{ envelope: CommandEnvelope; applied: boolean }>;
export type AgentNotice = Readonly<{ agentSessionId: string; agentName: string; summary: string }>;

export type FakeDeckService = DeckService &
  Readonly<{
    /** Make `caller` a member with `role` (or change their role). */
    setRole: (options: Readonly<{ deckId: DeckId; caller: DeckCaller; role: DeckRole }>) => void;
    store: (deckId: DeckId) => DocumentStore;
    envelopes: (deckId: DeckId) => readonly RecordedEnvelope[];
    agentNotices: (deckId: DeckId) => readonly AgentNotice[];
    storedAsset: (options: Readonly<{ deckId: DeckId; assetId: AssetId }>) => Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }> | null;
    /** A person's own edit, as the editor would send it. */
    personEdit: (options: Readonly<{ deckId: DeckId; caller: DeckCaller; commands: readonly DocumentCommand[] }>) => CommandOutcome;
    /** A person's comment request, as the editor would send it. */
    personDiscussion: (options: Readonly<{ deckId: DeckId; caller: DeckCaller; command: DiscussionCommand }>) => Promise<DiscussionOutcome>;
    /** Leases currently held: zero after every tool call, or a handle leaked. */
    openLeases: () => number;
  }>;

/** A signed-in account with its person and agent, ids as deck-access.ts derives them. */
export function fakeCaller(options: Readonly<{ accountId: string; displayName: string; colourIndex: number }>): DeckCaller {
  const digest = createHash("sha256").update(`sasha-person.v1:${options.accountId}`).digest("hex").slice(0, 32);
  return {
    accountId: options.accountId,
    person: { id: personId(`pr_${digest}`), displayName: options.displayName, colourIndex: options.colourIndex, kind: "person" },
    agent: { id: personId(`ag_${digest}`), displayName: "Claude", colourIndex: options.colourIndex, kind: "agent" },
  };
}

export function createFakeDeckService(options: Readonly<{ now: () => number }>): FakeDeckService {
  const decks = new Map<DeckId, FakeDeck>();
  let deckCounter = 0;
  let leases = 0;
  let commandSeed: IdSeed = { sessionPrefix: "fakePers", counter: 0 };

  const deckOf = (deckId: DeckId): FakeDeck => {
    const deck = decks.get(deckId);
    if (deck === undefined) throw new Error(`no fake deck ${deckId}`);
    return deck;
  };

  const summaryOf = (deck: FakeDeck, caller: DeckCaller): DeckSummary => ({
    deckId: deck.deckId,
    title: deck.store.snapshot().title,
    role: deck.roles.get(caller.accountId) ?? "viewer",
    owner: deck.owner.person,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
    googleSlides: null,
  });

  const handleFor = (deck: FakeDeck, caller: DeckCaller): DeckHandle => {
    leases += 1;
    const role = (): DeckRole => deck.roles.get(caller.accountId) ?? "viewer";
    const allows = (permission: DeckPermission): boolean => DECK_PERMISSIONS_BY_ROLE[role()][permission];
    return {
      deckId: deck.deckId,
      role,
      summary: () => summaryOf(deck, caller),
      snapshot: () => deck.store.snapshot(),
      apply: ({ envelope, summaryForCollaborators }) => Promise.resolve(applyEnvelope({ deck, envelope, summary: summaryForCollaborators, allowed: allows("editDocument"), now: options.now })),
      revertAgentSession: ({ agentSessionId }) => Promise.resolve(allows("revertAgentEdits") ? revert({ deck, agentSessionId, now: options.now }) : { kind: "notPermitted" }),
      discussion: () => deck.discussion,
      submitDiscussion: ({ as, request }) => submit({ deck, actor: as === "agent" ? caller.agent : caller.person, request, allowed: allows("comment"), now: options.now }),
      waitForDiscussion: (wait) => waitFor({ deck, ...wait }),
      putAsset: ({ bytes, mediaType }) => Promise.resolve(putAsset({ deck, bytes, mediaType, allowed: allows("editDocument") })),
      readAsset: ({ assetId }) => Promise.resolve(deck.assets.get(assetId) ?? null),
      googleSlidesLink: () => null,
      setGoogleSlidesLink: () => Promise.resolve(),
      bindAddon: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => {
        leases -= 1;
        return Promise.resolve();
      },
    };
  };

  const open = (deck: FakeDeck | undefined, caller: DeckCaller): DeckOpenOutcome => {
    if (deck === undefined || !deck.roles.has(caller.accountId)) return { kind: "notFound" };
    return { kind: "opened", deck: handleFor(deck, caller) };
  };

  return {
    listDecks: ({ caller }) => Promise.resolve([...decks.values()].filter((deck) => deck.roles.has(caller.accountId)).map((deck) => summaryOf(deck, caller))),
    createDeck: ({ caller, title }) => {
      deckCounter += 1;
      const deckId = parseDeckId(`dk_fakeDeck${String(deckCounter).padStart(12, "0")}`);
      if (deckId === null) throw new Error("fake deck id");
      const deck = newDeck({ deckId, owner: caller, title, now: options.now, randomSeed: deckCounter });
      decks.set(deckId, deck);
      return Promise.resolve(open(deck, caller));
    },
    openDeck: ({ caller, deckId }) => Promise.resolve(open(decks.get(deckId), caller)),
    findDeckByAddonBinding: () => Promise.resolve(null),
    setRole: ({ deckId, caller, role }) => {
      deckOf(deckId).roles.set(caller.accountId, role);
    },
    store: (deckId) => deckOf(deckId).store,
    envelopes: (deckId) => deckOf(deckId).envelopes,
    agentNotices: (deckId) => deckOf(deckId).agentNotices,
    storedAsset: ({ deckId, assetId }) => deckOf(deckId).assets.get(assetId) ?? null,
    personEdit: ({ deckId, caller, commands }) => {
      const minted = mintId({ seed: commandSeed, kind: "command" });
      commandSeed = minted.seed;
      const envelope: CommandEnvelope = {
        commandId: minted.id,
        author: { kind: "person", personId: caller.person.id },
        commands,
        selectionBefore: { kind: "none" },
        selectionAfter: { kind: "none" },
        mergeWithPrevious: false,
      };
      const deck = deckOf(deckId);
      const outcome = deck.store.apply(envelope);
      deck.envelopes.push({ envelope, applied: outcome.kind === "applied" });
      return outcome;
    },
    personDiscussion: ({ deckId, caller, command }) => {
      const minted = mintId({ seed: commandSeed, kind: "discussionRequest" });
      commandSeed = minted.seed;
      return submit({ deck: deckOf(deckId), actor: caller.person, request: { requestId: minted.id, command }, allowed: true, now: options.now });
    },
    openLeases: () => leases,
  };
}

type FakeDeck = {
  readonly deckId: DeckId;
  readonly owner: DeckCaller;
  readonly roles: Map<string, DeckRole>;
  readonly randomSeed: number;
  readonly createdAt: number;
  updatedAt: number;
  store: DocumentStore;
  readonly envelopes: RecordedEnvelope[];
  readonly agentNotices: AgentNotice[];
  discussionLog: readonly DiscussionLogEntry[];
  discussion: DiscussionSnapshot;
  readonly waiters: Set<() => void>;
  readonly assets: Map<AssetId, Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }>>;
};

function newDeck(options: Readonly<{ deckId: DeckId; owner: DeckCaller; title: string; now: () => number; randomSeed: number }>): FakeDeck {
  const store = blankStore(options);
  if (options.title !== "") {
    store.apply({
      commandId: mintId({ seed: { sessionPrefix: "fakeSeed", counter: 0 }, kind: "command" }).id,
      author: { kind: "person", personId: options.owner.person.id },
      commands: [{ kind: "setTitle", title: options.title }],
      selectionBefore: { kind: "none" },
      selectionAfter: { kind: "none" },
      mergeWithPrevious: false,
    });
  }
  return {
    deckId: options.deckId,
    owner: options.owner,
    roles: new Map([[options.owner.accountId, "owner"]]),
    randomSeed: options.randomSeed,
    createdAt: options.now(),
    updatedAt: options.now(),
    store,
    envelopes: [],
    agentNotices: [],
    discussionLog: [],
    discussion: EMPTY_DISCUSSION,
    waiters: new Set(),
    assets: new Map(),
  };
}

/**
 * A store seeded with the model's blank deck for this deck id. The Y.Doc comes from the engine's
 * own fixture (connector code never imports yjs itself, SPEC.md 21.1); its throwaway store is
 * disposed before the real one is created over the same, still empty, document.
 */
function blankStore(options: Readonly<{ deckId: DeckId; now: () => number; randomSeed: number }>): DocumentStore {
  const scratch = createTestStore({ seed: "none" });
  scratch.store[Symbol.dispose]();
  return createDocumentStore({
    sharedDocument: scratch.sharedDocument,
    seed: { kind: "blankDeck", deckId: options.deckId },
    now: options.now,
    random: seededRandom(options.randomSeed),
    scheduler: scratch.scheduler,
    repairPolicy: "repairAfterTransaction",
    typingMergeWindowMilliseconds: 500,
  });
}

function applyEnvelope(options: Readonly<{ deck: FakeDeck; envelope: CommandEnvelope; summary: string; allowed: boolean; now: () => number }>): DeckApplyOutcome {
  const { deck, envelope } = options;
  if (!options.allowed) return { kind: "notPermitted" };
  if (envelope.commands.length > COLLABORATION_LIMITS.maximumCommandsPerAgentApply) return { kind: "tooLarge", message: "too many commands" };
  const outcome = deck.store.apply(envelope);
  deck.envelopes.push({ envelope, applied: outcome.kind === "applied" });
  switch (outcome.kind) {
    case "applied":
      deck.updatedAt = options.now();
      if (envelope.author.kind === "agent") deck.agentNotices.push({ agentSessionId: envelope.author.agentSessionId, agentName: envelope.author.name, summary: options.summary });
      return { kind: "applied", outcome };
    case "rejected":
      return { kind: "rejected", outcome };
    default:
      throw new Error("unknown outcome");
  }
}

/** Rebuilds the deck from its blank seed with every applied envelope EXCEPT the session's. */
function revert(options: Readonly<{ deck: FakeDeck; agentSessionId: string; now: () => number }>): AgentRevertOutcome {
  const { deck } = options;
  const isSessions = (recorded: RecordedEnvelope): boolean => recorded.envelope.author.kind === "agent" && recorded.envelope.author.agentSessionId === options.agentSessionId;
  const reverted = deck.envelopes.filter((recorded) => recorded.applied && isSessions(recorded)).length;
  if (reverted === 0) return { kind: "nothingToRevert", skippedSteps: 0 };
  const title = deck.store.snapshot().title;
  const store = blankStore({ deckId: deck.deckId, now: options.now, randomSeed: deck.randomSeed });
  let skippedSteps = 0;
  const kept: RecordedEnvelope[] = [];
  const replays = [
    { envelope: titleEnvelope({ deck, title }), applied: true },
    ...deck.envelopes.filter((recorded) => recorded.applied && !isSessions(recorded)),
  ];
  for (const recorded of replays) {
    const replayed = withRevision({ envelope: recorded.envelope, revision: store.snapshot().revision });
    const outcome = store.apply(replayed);
    if (outcome.kind === "applied") kept.push({ envelope: recorded.envelope, applied: true });
    else skippedSteps += 1;
  }
  deck.store[Symbol.dispose]();
  deck.store = store;
  deck.envelopes.splice(0, deck.envelopes.length, ...kept.slice(1));
  return { kind: "reverted", stepsReverted: reverted, skippedSteps };
}

function titleEnvelope(options: Readonly<{ deck: FakeDeck; title: string }>): CommandEnvelope {
  return {
    commandId: mintId({ seed: { sessionPrefix: "fakeTitl", counter: 0 }, kind: "command" }).id,
    author: { kind: "person", personId: options.deck.owner.person.id },
    commands: [{ kind: "setTitle", title: options.title }],
    selectionBefore: { kind: "none" },
    selectionAfter: { kind: "none" },
    mergeWithPrevious: false,
  };
}

/** A replayed text edit names the replica's current revision (commands.ts `basedOnRevision`). */
function withRevision(options: Readonly<{ envelope: CommandEnvelope; revision: number }>): CommandEnvelope {
  return {
    ...options.envelope,
    commands: options.envelope.commands.map((command) => (command.kind === "editText" ? { ...command, basedOnRevision: options.revision } : command)),
  };
}

/** The real authority's rules (`createMemoryDiscussionStore`), run over this deck's shared log. */
async function submit(options: Readonly<{ deck: FakeDeck; actor: Person; request: DiscussionRequest; allowed: boolean; now: () => number }>): Promise<DiscussionOutcome> {
  const { deck, request } = options;
  if (!options.allowed) return { kind: "rejected", requestId: request.requestId, reason: "notPermitted", message: "this role cannot comment" };
  using authority = createMemoryDiscussionStore({ actor: options.actor, now: options.now, initialLog: deck.discussionLog });
  // The memory authority decides synchronously; the deck's log is updated before awaiting, so two
  // requests submitted together are ordered, as the real room orders them.
  const pending = authority.submit(request);
  const decided = authority.snapshot();
  if (decided.sequence > deck.discussion.sequence) {
    const entry: DiscussionLogEntry = { sequence: decided.sequence, requestId: request.requestId, actor: options.actor, at: options.now(), command: request.command };
    deck.discussionLog = [...deck.discussionLog, entry];
    deck.discussion = decided;
    for (const waiter of [...deck.waiters]) waiter();
  }
  const outcome = await pending;
  return outcome;
}

function waitFor(options: Readonly<{ deck: FakeDeck; afterSequence: number; timeoutMilliseconds: number; signal: AbortSignal }>): Promise<DiscussionSnapshot> {
  const { deck } = options;
  if (deck.discussion.sequence > options.afterSequence) return Promise.resolve(deck.discussion);
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      deck.waiters.delete(waiter);
      options.signal.removeEventListener("abort", finish);
      resolve(deck.discussion);
    };
    const waiter = (): void => {
      if (deck.discussion.sequence > options.afterSequence) finish();
    };
    const timer = setTimeout(finish, options.timeoutMilliseconds);
    deck.waiters.add(waiter);
    options.signal.addEventListener("abort", finish);
  });
}

function putAsset(options: Readonly<{ deck: FakeDeck; bytes: Uint8Array; mediaType: AssetMediaType; allowed: boolean }>): AssetPutOutcome {
  if (!options.allowed) return { kind: "notPermitted" };
  if (options.bytes.byteLength > COLLABORATION_LIMITS.maximumAssetBytes) return { kind: "tooLarge", message: "over 25 megabytes" };
  const assetId = parseAssetId(createHash("sha256").update(options.bytes).digest("hex"));
  if (assetId === null) throw new Error("a SHA-256 digest is always an asset id");
  options.deck.assets.set(assetId, { bytes: options.bytes, mediaType: options.mediaType });
  return { kind: "stored", assetId, byteLength: options.bytes.byteLength };
}

function personId(text: string): PersonId {
  const parsed = parsePersonId(text);
  if (parsed === null) throw new Error(`not a person id: ${text}`);
  return parsed;
}
