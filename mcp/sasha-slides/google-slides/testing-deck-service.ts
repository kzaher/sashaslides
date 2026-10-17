/**
 * TEST ONLY: a `DeckService` whose decks are REAL engine model stores (`createDocumentStore` on a
 * fresh Y.Doc, repairing like the server's replica), so every envelope the importer builds is
 * validated by the model exactly as the deck room will validate it, without the collaboration
 * server's rooms, storage or sockets.
 *
 * WHY THE MODEL IS LOADED AT RUNTIME: the model's sources import `contracts/index.ts`, which pulls
 * in browser types this connector project does not have (deck-service-contract.ts header), so a
 * static import would fail the connector's typecheck. The test fixtures module is loaded with a
 * dynamic `import()` and typed by the model's own contract (`DocumentStore`).
 */
import { createHash } from "node:crypto";
import type { CommandEnvelope } from "../engine/src/contracts/commands.ts";
import type { GoogleSlidesLink } from "../engine/src/contracts/deck-api.ts";
import { roleAllows, type DeckPermission, type DeckRole } from "../engine/src/contracts/deck-access.ts";
import type { Person } from "../engine/src/contracts/discussion.ts";
import type { AssetMediaType } from "../engine/src/contracts/document.ts";
import type { DocumentStore, RepairPolicy } from "../engine/src/contracts/document-store.ts";
import type { AssetId, DeckId, PersonId } from "../engine/src/contracts/ids.ts";
import type { DeckCaller, DeckHandle, DeckOpenOutcome, DeckService } from "../deck-contracts/deck-service-contract.ts";
import type { AccountId } from "../http/account-vault";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export type TestDeck = {
  deckId: DeckId;
  store: DocumentStore;
  roles: Map<string, DeckRole>;
  owner: Person;
  assets: Map<string, Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }>>;
  link: GoogleSlidesLink | null;
  applied: CommandEnvelope[];
};

export type TestDeckService = DeckService &
  Readonly<{
    decks: Map<string, TestDeck>;
    bindings: Map<string, DeckId>;
    /** Gives an account a role on a deck (or takes it away with null). */
    setRole(options: Readonly<{ deckId: DeckId; accountId: AccountId; role: DeckRole | null }>): void;
  }>;

type CreateTestStore = (options: Readonly<{ seed: "blankDeck" | "none"; repairPolicy?: RepairPolicy; randomSeed?: number }>) => Readonly<{ store: DocumentStore }>;

export async function createTestDeckService(): Promise<TestDeckService> {
  const createTestStore = await loadCreateTestStore();
  const decks = new Map<string, TestDeck>();
  const bindings = new Map<string, DeckId>();
  let deckCounter = 0;

  const handleFor = (deck: TestDeck, caller: DeckCaller): DeckHandle => {
    const role = (): DeckRole => deck.roles.get(caller.accountId) ?? "viewer";
    const may = (permission: DeckPermission): boolean => roleAllows({ role: role(), permission });
    return {
      deckId: deck.deckId,
      role,
      summary: () => ({
        deckId: deck.deckId,
        title: deck.store.snapshot().title,
        role: role(),
        owner: deck.owner,
        createdAt: 1,
        updatedAt: 2,
        googleSlides: deck.link,
      }),
      snapshot: () => deck.store.snapshot(),
      apply: async ({ envelope }) => {
        if (!may("editDocument")) return { kind: "notPermitted" };
        const outcome = deck.store.apply(envelope);
        switch (outcome.kind) {
          case "applied":
            deck.applied.push(envelope);
            return { kind: "applied", outcome };
          case "rejected":
            return { kind: "rejected", outcome };
          default:
            return assertNever(outcome);
        }
      },
      revertAgentSession: async () => ({ kind: "nothingToRevert", skippedSteps: 0 }),
      discussion: () => {
        throw new Error("not used by the Google Slides tests");
      },
      submitDiscussion: async () => {
        throw new Error("not used by the Google Slides tests");
      },
      waitForDiscussion: async () => {
        throw new Error("not used by the Google Slides tests");
      },
      putAsset: async ({ bytes, mediaType }) => {
        if (!may("editDocument")) return { kind: "notPermitted" };
        const assetId = createHash("sha256").update(bytes).digest("hex");
        deck.assets.set(assetId, { bytes, mediaType });
        // A SHA-256 in lowercase hexadecimal is exactly ASSET_ID_PATTERN (ids.ts).
        return { kind: "stored", assetId: assetId as AssetId, byteLength: bytes.byteLength };
      },
      readAsset: async ({ assetId }) => deck.assets.get(assetId) ?? null,
      googleSlidesLink: () => deck.link,
      setGoogleSlidesLink: async ({ link }) => {
        deck.link = link;
      },
      bindAddon: async ({ bindingSecretHash }) => {
        bindings.set(bindingSecretHash, deck.deckId);
      },
      [Symbol.asyncDispose]: async () => undefined,
    };
  };

  return {
    decks,
    bindings,
    setRole: ({ deckId, accountId, role }) => {
      const deck = decks.get(deckId);
      if (deck === undefined) throw new Error(`no deck ${deckId}`);
      if (role === null) deck.roles.delete(accountId);
      else deck.roles.set(accountId, role);
    },
    listDecks: async ({ caller }) => [...decks.values()].filter((deck) => deck.roles.has(caller.accountId)).map((deck) => handleFor(deck, caller).summary()),
    createDeck: async ({ caller, title }): Promise<DeckOpenOutcome> => {
      deckCounter += 1;
      // `dk_` + 22 characters matches OBJECT_ID_PATTERN, which parseDeckId checks (ids.ts).
      const deckId = `dk_test${String(deckCounter).padStart(17, "0")}` as DeckId;
      const store = createTestStore({ seed: "blankDeck", repairPolicy: "repairAfterTransaction", randomSeed: deckCounter }).store;
      const deck: TestDeck = { deckId, store, roles: new Map([[caller.accountId, "owner"]]), owner: caller.person, assets: new Map(), link: null, applied: [] };
      decks.set(deckId, deck);
      if (title.length > 0) store.apply(titleEnvelope({ title, personId: caller.person.id }));
      return { kind: "opened", deck: handleFor(deck, caller) };
    },
    openDeck: async ({ caller, deckId }): Promise<DeckOpenOutcome> => {
      const deck = decks.get(deckId);
      if (deck === undefined || !deck.roles.has(caller.accountId)) return { kind: "notFound" };
      return { kind: "opened", deck: handleFor(deck, caller) };
    },
    findDeckByAddonBinding: async ({ bindingSecretHash }) => bindings.get(bindingSecretHash) ?? null,
  };
}

/** A caller for an account, with the person and agent ids the account portal would derive. */
export function testCaller(accountId: string): DeckCaller {
  // Test accounts are plain strings; the brands only mark that the account service minted them.
  const account = accountId as AccountId;
  const person = (prefix: string, kind: "person" | "agent"): Person => ({
    // `pr_` / `ag_` + hexadecimal matches OBJECT_ID_PATTERN (deck-access.ts person ids).
    id: `${prefix}${createHash("sha256").update(accountId).digest("hex").slice(0, 32)}` as PersonId,
    displayName: kind === "agent" ? "Claude" : accountId,
    colourIndex: 0,
    kind,
  });
  return { accountId: account, person: person("pr_", "person"), agent: person("ag_", "agent") };
}

function titleEnvelope(options: Readonly<{ title: string; personId: PersonId }>): CommandEnvelope {
  return {
    // A fixed command id of the object-id shape (ids.ts); the brand records that.
    commandId: "cm_testTitle0" as CommandEnvelope["commandId"],
    author: { kind: "person", personId: options.personId },
    commands: [{ kind: "setTitle", title: options.title }],
    selectionBefore: { kind: "none" },
    selectionAfter: { kind: "none" },
    mergeWithPrevious: false,
  };
}

async function loadCreateTestStore(): Promise<CreateTestStore> {
  // Deferred on purpose (see the header): the model cannot be imported statically here.
  const fixturesPath = new URL("../engine/src/model/testing/model-fixtures.ts", import.meta.url).href;
  const loaded: unknown = await import(fixturesPath);
  if (typeof loaded !== "object" || loaded === null || !("createTestStore" in loaded) || typeof loaded.createTestStore !== "function") {
    throw new Error("the engine model's test fixtures did not load");
  }
  // model-fixtures.ts exports `createTestStore` with exactly this shape (seed, repair policy, random seed -> { store }).
  return loaded.createTestStore as CreateTestStore;
}
