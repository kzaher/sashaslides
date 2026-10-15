/**
 * Deck storage on a real temporary directory with the real vault (acceptance 6): the 250 ms flush
 * cadence, losing only what was not flushed, compaction at 500 records, a crash between the two
 * compaction renames, a corrupt record, nothing readable in the files, and a reset owner key.
 *
 *   cd mcp/sasha-slides && npx tsx --test decks/deck-storage.test.ts
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { DocumentCommand } from "../engine/src/contracts/commands.ts";
import type { DocumentSnapshot } from "../engine/src/contracts/document.ts";
import { identityFrame } from "../engine/src/contracts/geometry.ts";
import type { CommandId, ElementId } from "../engine/src/contracts/ids.ts";
import { DEFAULT_TEXT_BOX_STYLE, PLAIN_BOX_STYLE } from "../engine/src/contracts/style.ts";
import type { DeckCaller, DeckHandle } from "../deck-contracts/deck-service-contract";
import { storeAccountDirectory } from "../http/account-directory";
import { createAccountEraser, withDeckErasure } from "../http/account-eraser";
import { createAccountVault, inMemoryDataKeyStore } from "../http/account-keys";
import type { AccountVault } from "../http/account-vault";
import { randomAccountId, withSealedGoogleIdentities } from "../http/accounts";
import { inMemoryAuthStore, type AuthStore } from "../http/oauth-store";
import { createDeckServer, type DeckServer } from "./deck-stack";
import { openFileDeckStorage, type DeckStorage } from "./deck-storage";
import { manualTimers, settle, type ManualTimers } from "./deck-test-support";

const SLIDE_TEXT = "Quarterly pineapple forecast";
const MEMBER_EMAIL = "secret.member@example.com";

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

type World = Readonly<{ directory: string; store: AuthStore; vault: AccountVault; timers: ManualTimers; warnings: string[] }>;

describe("deck storage", () => {
  test("updates are flushed every 250 ms, and a room dropped without a final flush reloads up to the last flush", async () => {
    const world = newWorld();
    const first = openServer(world);
    const owner = await signIn(world, first, "owner@example.com");
    const deck = await createDeck(first, owner);
    await applyTitle(deck, owner, "First flushed title");
    await settle();
    assert.equal(logLines(world, deck), 0, "nothing is written before 250 ms");
    world.timers.advance(250);
    await first.manager.registry.flushAll();
    assert.equal(logLines(world, deck), 1, "one record for everything pending at the tick");
    await applyTitle(deck, owner, "Second flushed title");
    world.timers.advance(250);
    await first.manager.registry.flushAll();
    assert.equal(logLines(world, deck), 2);
    await applyTitle(deck, owner, "Never flushed title");
    await settle();

    const second = openServer(world);
    const reopened = await openDeck(second, await signIn(world, second, "owner@example.com"), deck.deckId);
    assert.equal(reopened.snapshot().title, "Second flushed title");
  });

  test("500 records compact into the snapshot with an empty log, and a crash between the two renames reloads identically", async () => {
    const world = newWorld();
    // The log as compaction found it: every record, the 500th included, just before the renames.
    const captured: { log: string | null } = { log: null };
    const server = openServer(world, (storage) => ({
      ...storage,
      compactDocument: (location) => {
        captured.log = readFileSync(join(world.directory, "decks", location.deckId, "document.log"), "utf-8");
        return storage.compactDocument(location);
      },
    }));
    const owner = await signIn(world, server, "owner@example.com");
    const deck = await createDeck(server, owner);
    let compactedAt: number | null = null;
    for (let flush = 1; flush <= 520 && compactedAt === null; flush += 1) {
      await applyTitle(deck, owner, `Title ${String(flush)}`);
      world.timers.advance(250);
      await server.manager.registry.flushAll();
      if (captured.log !== null) compactedAt = flush;
    }
    assert.equal(compactedAt, 500, "the 500th record triggers compaction");
    assert.equal(readFileSync(logPath(world, deck), "utf-8"), "", "the log is replaced by an empty one");
    const live = withoutRevision(deck.snapshot());

    const afterCompaction = openServer(world);
    assert.deepEqual(withoutRevision((await openDeck(afterCompaction, owner, deck.deckId)).snapshot()), live);

    // The crash: the snapshot was renamed into place, the log was never replaced.
    const crashedLog = captured.log;
    assert.ok(crashedLog !== null && crashedLog.split("\n").filter((line) => line !== "").length === 500);
    writeFileSync(logPath(world, deck), crashedLog);
    const afterCrash = openServer(world);
    assert.deepEqual(withoutRevision((await openDeck(afterCrash, owner, deck.deckId)).snapshot()), live);
  });

  test("a corrupt log record is skipped with a warning naming the deck and the sequence", async () => {
    const world = newWorld();
    const server = openServer(world);
    const owner = await signIn(world, server, "owner@example.com");
    const deck = await createDeck(server, owner);
    for (const title of ["One", "Two", "Three"]) {
      await applyTitle(deck, owner, title);
      world.timers.advance(250);
      await server.manager.registry.flushAll();
    }
    const lines = readFileSync(logPath(world, deck), "utf-8").split("\n");
    const second = lines[1] ?? "";
    lines[1] = `${second.slice(0, second.length - 12)}AAAAAAAAAAAA`;
    writeFileSync(logPath(world, deck), lines.join("\n"));

    const reloaded = openServer(world);
    const reopened = await openDeck(reloaded, owner, deck.deckId);
    assert.ok(
      world.warnings.some((warning) => warning.includes(deck.deckId) && warning.includes("sequence 2")),
      world.warnings.join("\n"),
    );
    // Yjs gives each replica's changes consecutive clocks, so the records after the corrupt one
    // wait as pending structures (a client's next sync step 2 fills them); the deck loads with
    // everything before it instead of failing.
    assert.equal(reopened.snapshot().title, "One");
  });

  test("no file under the decks directory holds a slide's text or an email in the clear", async () => {
    const world = newWorld();
    const server = openServer(world);
    const owner = await signIn(world, server, "owner@example.com");
    await signIn(world, server, MEMBER_EMAIL);
    const deck = await createDeck(server, owner);
    const slideId = deck.snapshot().slides[0]?.id;
    assert.ok(slideId !== undefined);
    await apply(deck, owner, [
      {
        kind: "insertElements",
        slideId,
        placement: { kind: "front" },
        elements: [
          {
            // A valid object id (ids.ts) by construction.
            id: "el_storageText01" as ElementId,
            kind: "shape",
            name: "",
            description: "",
            frame: identityFrame({ x: 100, y: 100, width: 600, height: 120 }),
            groupId: null,
            morphKey: "el_storageText01",
            placeholder: null,
            unsupportedKeys: [],
            preset: "rectangle",
            box: PLAIN_BOX_STYLE,
            textBox: DEFAULT_TEXT_BOX_STYLE,
            text: { paragraphs: [{ style: {}, runs: [{ kind: "text", text: SLIDE_TEXT, style: {} }] }] },
          },
        ],
      },
    ]);
    const invited = await server.manager.invite({ accountId: owner.accountId, deckId: deck.deckId, email: MEMBER_EMAIL, role: "editor" });
    assert.equal(invited.kind, "ok");
    world.timers.advance(250);
    await server.manager.registry.flushAll();

    await server.people.setDisplayName({ accountId: owner.accountId, displayName: "Pineapple Owner" });
    const files = everyFile(world.directory);
    assert.ok(files.some((file) => file.includes("deck-profiles")) && files.some((file) => file.endsWith("document.log")), files.join(", "));
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      assert.equal(text.includes(SLIDE_TEXT), false, `${file} holds the slide text`);
      assert.equal(text.includes("pineapple"), false, `${file} holds a word of the slide text`);
      assert.equal(text.includes(MEMBER_EMAIL), false, `${file} holds an email`);
      assert.equal(text.includes("owner@example.com"), false, `${file} holds an email`);
    }
  });

  test("after the owner's key is reset the deck is listed nowhere, and the eraser deletes its directory", async () => {
    const world = newWorld();
    const server = openServer(world);
    const owner = await signIn(world, server, "owner@example.com");
    const member = await signIn(world, server, MEMBER_EMAIL);
    const deck = await createDeck(server, owner);
    assert.equal((await server.manager.invite({ accountId: owner.accountId, deckId: deck.deckId, email: MEMBER_EMAIL, role: "editor" })).kind, "ok");
    world.timers.advance(250);
    await server.manager.registry.flushAll();
    assert.deepEqual((await server.manager.listDecks({ accountId: member.accountId })).map((summary) => summary.deckId), [deck.deckId]);

    await world.vault.resetKey({ accountId: owner.accountId });
    const fresh = openServer(world);
    assert.deepEqual(await fresh.manager.listDecks({ accountId: owner.accountId }), []);
    assert.deepEqual(await fresh.manager.listDecks({ accountId: member.accountId }), []);
    assert.ok(existsSync(join(world.directory, "decks", deck.deckId)));

    const eraser = withDeckErasure({
      eraser: createAccountEraser({ store: world.store, vault: world.vault, revokeGoogleToken: () => Promise.resolve(false) }),
      eraseDecks: fresh.eraseAccount,
    });
    await eraser.eraseAccount({ accountId: owner.accountId });
    assert.equal(existsSync(join(world.directory, "decks", deck.deckId)), false);
    const index: unknown = JSON.parse(readFileSync(join(world.directory, "decks", "index.json"), "utf-8"));
    assert.equal(JSON.stringify(index).includes(deck.deckId), false);
  });
});

function newWorld(): World {
  const directory = mkdtempSync(join(tmpdir(), "sasha-decks-"));
  temporaryDirectories.push(directory);
  const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex") });
  const { store } = withSealedGoogleIdentities({ store: inMemoryAuthStore(), vault });
  return { directory, store, vault, timers: manualTimers(1_700_000_000_000), warnings: [] };
}

function openServer(world: World, wrapStorage: (storage: DeckStorage) => DeckStorage = (storage) => storage): DeckServer {
  const opened = openFileDeckStorage({
    decksDirectory: join(world.directory, "decks"),
    profilesDirectory: join(world.directory, "deck-profiles"),
    vault: world.vault,
    warn: (message) => world.warnings.push(message),
  });
  if (opened.kind === "failed") throw new Error(opened.message);
  return createDeckServer({
    publicUrl: "https://decks.example.test",
    storage: wrapStorage(opened.storage),
    store: world.store,
    vault: world.vault,
    directory: storeAccountDirectory({ store: world.store, vault: world.vault, now: () => new Date(world.timers.now()), newAccountId: randomAccountId }),
    sessionSecret: "a-session-secret-that-is-at-least-thirty-two-bytes-long",
    webDistributionDirectory: join(world.directory, "no-web-build"),
    googleClient: { clientId: "test.apps.googleusercontent.com", clientSecret: "secret" },
    createGoogleSlidesInterchange: () => ({ handleRequest: () => Promise.resolve(false) }),
    timers: world.timers,
    now: world.timers.now,
    random: Math.random,
    randomBytes: (size) => randomBytes(size),
    randomToken: () => randomBytes(32).toString("base64url"),
    fetch: () => Promise.reject(new Error("no network in tests")),
    warn: (message) => world.warnings.push(message),
  });
}

async function signIn(world: World, server: DeckServer, email: string): Promise<DeckCaller> {
  const directory = storeAccountDirectory({ store: world.store, vault: world.vault, now: () => new Date(world.timers.now()), newAccountId: randomAccountId });
  const accountId = await directory.findOrCreateByIdentity({ provider: "test", subject: email, email });
  return server.people.callerFor({ accountId });
}

async function createDeck(server: DeckServer, caller: DeckCaller): Promise<DeckHandle> {
  const created = await server.deckService.createDeck({ caller, title: "Storage deck" });
  if (created.kind !== "opened") throw new Error(`createDeck answered ${created.kind}`);
  return created.deck;
}

async function openDeck(server: DeckServer, caller: DeckCaller, deckId: DeckHandle["deckId"]): Promise<DeckHandle> {
  const opened = await server.deckService.openDeck({ caller, deckId });
  if (opened.kind !== "opened") throw new Error(`openDeck answered ${opened.kind}`);
  return opened.deck;
}

let commandCounter = 0;

async function apply(deck: DeckHandle, caller: DeckCaller, commands: readonly DocumentCommand[]): Promise<void> {
  commandCounter += 1;
  const outcome = await deck.apply({
    envelope: {
      // A prefix, letters and a counter: a valid object id (ids.ts); the brand records that.
      commandId: `cm_storage${String(commandCounter).padStart(5, "0")}` as CommandId,
      author: { kind: "person", personId: caller.person.id },
      commands,
      selectionBefore: { kind: "none" },
      selectionAfter: { kind: "none" },
      mergeWithPrevious: false,
    },
    summaryForCollaborators: "",
  });
  if (outcome.kind !== "applied") throw new Error(`apply answered ${outcome.kind}`);
}

function applyTitle(deck: DeckHandle, caller: DeckCaller, title: string): Promise<void> {
  return apply(deck, caller, [{ kind: "setTitle", title }]);
}

function logPath(world: World, deck: DeckHandle): string {
  return join(world.directory, "decks", deck.deckId, "document.log");
}

function logLines(world: World, deck: DeckHandle): number {
  if (!existsSync(logPath(world, deck))) return 0;
  return readFileSync(logPath(world, deck), "utf-8").split("\n").filter((line) => line.trim() !== "").length;
}

function withoutRevision(snapshot: DocumentSnapshot): Omit<DocumentSnapshot, "revision"> {
  const { revision: _revision, ...rest } = snapshot;
  return rest;
}

function everyFile(directory: string): readonly string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...everyFile(path));
    else files.push(path);
  }
  return files;
}
