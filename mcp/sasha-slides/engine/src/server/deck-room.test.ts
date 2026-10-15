// The room over fake connections (acceptance 1, 2, 3 and 5): sync and convergence, the awareness
// relay's identity rules, the protected-field guard end to end with a third replica watching every
// transaction, read-only roles, and the rate limit on a virtual clock.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { BINARY_MESSAGE_TYPE } from "../contracts/collaboration.ts";
import type {
  CommandAuthor,
  DeckId,
  DeckMember,
  DeckRole,
  Person,
  ProtectedFieldCorrection,
  ServerMessage,
  TransitionScriptId,
} from "../contracts/index.ts";
import { scriptFingerprint } from "../contracts/index.ts";
import { DEFAULT_DECK_TITLE } from "../model/blank-deck.ts";
import { createDocumentStore } from "../model/document-store.ts";
import { documentRoots } from "../model/document-paths.ts";
import { envelope, manualClock, seededRandom, type ManualClock } from "../model/testing/model-fixtures.ts";
import { createAwarenessRelay, decodeAwarenessUpdate, encodeAwarenessUpdate, MAXIMUM_CLIENT_IDS_PER_CONNECTION } from "./awareness-relay.ts";
import { createDeckRoom, type DeckRoom } from "./deck-room.ts";
import { connectFakeClient } from "./testing/fake-client.ts";

const DECK_ID = "dk_roomTestDeck0000000001" as DeckId;
const ALICE = person("pr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Alice");
const BOB = person("pr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Bob");
const CAROL = person("pr_cccccccccccccccccccccccccccccccc", "Carol");
const DAN = person("pr_dddddddddddddddddddddddddddddddd", "Dan");

type TestRoom = Readonly<{ room: DeckRoom; clock: ManualClock; persisted: Uint8Array[] }> & Disposable;

describe("sync and awareness", () => {
  test("two editors converge, a latecomer gets the whole state, and awareness identity is the server's", () => {
    using setup = testRoom();
    const { room } = setup;
    using alice = connectFakeClient({ room, person: ALICE, role: "editor" });
    using bob = connectFakeClient({ room, person: BOB, role: "editor" });
    assert.equal(titleOf(alice.sharedDocument), DEFAULT_DECK_TITLE, "the first sync delivered the seeded deck");

    setTitle(alice.sharedDocument, "From Alice");
    roots(bob.sharedDocument).slides.forEach((slide) => {
      if (slide instanceof Y.Map) slide.set("skipped", true);
    });

    const serverState = Y.encodeStateAsUpdate(serverDocumentOf(room));
    assert.deepEqual(Y.encodeStateVector(alice.sharedDocument), Y.encodeStateVector(bob.sharedDocument));
    assert.equal(titleOf(bob.sharedDocument), "From Alice");
    assert.equal(stateDigest(alice.sharedDocument), stateDigest(bob.sharedDocument));

    using carol = connectFakeClient({ room, person: CAROL, role: "viewer" });
    assert.equal(stateDigest(carol.sharedDocument), stateDigest(alice.sharedDocument), "sync step 1 and 2 gave the latecomer everything");
    assert.ok(serverState.length > 0);

    // Alice claims to be Dan in her presence; Bob sees Alice.
    alice.awareness.setLocalState({ presence: { person: DAN, slideId: null, selection: { kind: "none" }, pointer: null, activity: "editing" } });
    alice.publishAwareness();
    const seenByBob = bob.awareness.getStates().get(alice.sharedDocument.clientID);
    assert.deepEqual(presencePerson(seenByBob), ALICE);

    // Alice cannot remove Bob's cursor.
    bob.awareness.setLocalState({ presence: { person: BOB, slideId: null, selection: { kind: "none" }, pointer: null, activity: "editing" } });
    bob.publishAwareness();
    alice.sendAwarenessUpdate(encodeAwarenessUpdate([{ clientId: bob.sharedDocument.clientID, clock: 99, stateText: "null" }]));
    assert.ok(carol.awareness.getStates().has(bob.sharedDocument.clientID), "Bob's state survives Alice's forged removal");

    // Alice leaves: Bob and Carol drop her state.
    alice.leave();
    assert.equal(bob.awareness.getStates().has(alice.sharedDocument.clientID), false);
    assert.equal(carol.awareness.getStates().has(alice.sharedDocument.clientID), false);
  });
});

describe("the awareness relay's memory per connection", () => {
  test("a connection claiming more client ids than allowed loses its oldest, and the loss is relayed", () => {
    const relay = createAwarenessRelay();
    const state = JSON.stringify({ presence: { slideId: null } });
    const claimed = Array.from({ length: MAXIMUM_CLIENT_IDS_PER_CONNECTION + 3 }, (_, index) => 1_000 + index);
    const relayed = claimed.map((clientId) => relay.receive({ connectionId: 7, person: ALICE, update: encodeAwarenessUpdate([{ clientId, clock: 1, stateText: state }]) }));
    assert.deepEqual(relay.clientIdsOf(7), claimed.slice(-MAXIMUM_CLIENT_IDS_PER_CONNECTION));
    const lastRelayed = relayed.at(-1);
    const removals = (lastRelayed === null || lastRelayed === undefined ? [] : (decodeAwarenessUpdate(lastRelayed) ?? [])).filter((entry) => entry.stateText === "null");
    assert.deepEqual(removals.map((entry) => entry.clientId), [claimed[2]], "the evicted id is removed at every peer");
    // Control: another connection is not affected by the first one's bound.
    relay.receive({ connectionId: 8, person: BOB, update: encodeAwarenessUpdate([{ clientId: 5, clock: 1, stateText: state }]) });
    assert.deepEqual(relay.clientIdsOf(8), [5]);
  });
});

describe("read-only roles never write", () => {
  type Row = Readonly<{ role: DeckRole; expectApplied: boolean }>;
  const rows: readonly Row[] = [
    { role: "viewer", expectApplied: false },
    { role: "commenter", expectApplied: false },
    { role: "editor", expectApplied: true },
  ];
  for (const row of rows) {
    test(`${row.role}: an empty step 2 is silent; a non-empty update ${row.expectApplied ? "applies (control)" : "is discarded with resynchroniseRequired"}`, () => {
      using setup = testRoom();
      using client = connectFakeClient({ room: setup.room, person: BOB, role: row.role });
      assert.deepEqual(resynchronisations(client.messages()), [], "the in-sync step 2 is accepted silently");
      const before = Y.encodeStateVector(serverDocumentOf(setup.room));

      setTitle(client.sharedDocument, "Changed by the client");

      assert.equal(titleOf(serverDocumentOf(setup.room)), row.expectApplied ? "Changed by the client" : DEFAULT_DECK_TITLE);
      assert.deepEqual(resynchronisations(client.messages()), row.expectApplied ? [] : ["updateFromReadOnlyRole"]);
      if (!row.expectApplied) assert.deepEqual(Y.encodeStateVector(serverDocumentOf(setup.room)), before, "the server document is unchanged");
    });
  }
});

describe("the protected-field guard", () => {
  const SCRIPT_ID = "tr_guardScript1" as TransitionScriptId;
  type Row = Readonly<{
    name: string;
    write: (scriptMap: Y.Map<unknown>, meta: Y.Map<unknown>, current: string) => void;
    expectedApproval: "approved" | "unapproved";
    expectedAuthor: CommandAuthorView;
    expectedCorrections: readonly ProtectedFieldCorrection[];
    expectedMeta: Readonly<{ deckId: string; schemaVersion: number }>;
  }>;
  type CommandAuthorView = Readonly<{ kind: "agent" | "person"; id: string }>;
  const AGENT_AUTHOR: CommandAuthorView = { kind: "agent", id: "as_writer" };
  const EDITOR_AUTHOR: CommandAuthorView = { kind: "person", id: ALICE.id };
  const META = { deckId: DECK_ID, schemaVersion: 1 };
  const rows: readonly Row[] = [
    {
      name: "control: the editor approves the current text in their own name",
      write: (script, _meta, current) => script.set("approval", { kind: "approved", approvedBy: ALICE.id, fingerprint: current }),
      expectedApproval: "approved",
      expectedAuthor: AGENT_AUTHOR,
      expectedCorrections: [],
      expectedMeta: META,
    },
    {
      name: "approvedBy names another person",
      write: (script, _meta, current) => script.set("approval", { kind: "approved", approvedBy: BOB.id, fingerprint: current }),
      expectedApproval: "unapproved",
      expectedAuthor: AGENT_AUTHOR,
      expectedCorrections: [{ kind: "approvalRevoked", scriptId: SCRIPT_ID, reason: "approvedByAnotherPerson" }],
      expectedMeta: META,
    },
    {
      name: "the fingerprint is not the current text's",
      write: (script) => script.set("approval", { kind: "approved", approvedBy: ALICE.id, fingerprint: "0000000000000000" }),
      expectedApproval: "unapproved",
      expectedAuthor: AGENT_AUTHOR,
      expectedCorrections: [{ kind: "approvalRevoked", scriptId: SCRIPT_ID, reason: "fingerprintMismatch" }],
      expectedMeta: META,
    },
    {
      name: "the text changes with the author spoofed as the agent",
      write: (script) => {
        script.set("script", "sashaTransition.define({ run: () => {} }); // changed");
        script.set("author", { kind: "agent", name: "Claude", agentSessionId: "as_writer" });
      },
      expectedApproval: "unapproved",
      expectedAuthor: EDITOR_AUTHOR,
      expectedCorrections: [{ kind: "scriptAuthorRestored", scriptId: SCRIPT_ID }],
      expectedMeta: META,
    },
    {
      name: "meta.deckId changes",
      write: (_script, meta) => meta.set("deckId", "dk_somethingElse0000000001"),
      expectedApproval: "unapproved",
      expectedAuthor: AGENT_AUTHOR,
      expectedCorrections: [{ kind: "metaRestored", key: "deckId" }],
      expectedMeta: META,
    },
    {
      name: "meta.schemaVersion and createdAt change",
      write: (_script, meta) => {
        meta.set("schemaVersion", 7);
        meta.set("createdAt", 1);
      },
      expectedApproval: "unapproved",
      expectedAuthor: AGENT_AUTHOR,
      expectedCorrections: [
        { kind: "metaRestored", key: "schemaVersion" },
        { kind: "metaRestored", key: "createdAt" },
      ],
      expectedMeta: META,
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      using setup = testRoom();
      const writer: CommandAuthor = { kind: "agent", name: "Claude", agentSessionId: "as_writer" };
      const saved = setup.room.applyEnvelope({
        envelope: envelope({
          author: writer,
          commands: [
            {
              kind: "upsertTransitionScript",
              script: { id: SCRIPT_ID, name: "Wipe", description: "", script: "sashaTransition.define({ run: () => {} });", stylesheet: "", markup: "", defaultParameters: {} },
              basedOnUpdatedAt: null,
              approval: "unapproved",
            },
          ],
        }),
        summaryForCollaborators: "wrote a transition",
      });
      assert.equal(saved.kind, "applied");
      const createdAt = roots(serverDocumentOf(setup.room)).meta.get("createdAt");
      using editor = connectFakeClient({ room: setup.room, person: ALICE, role: "editor" });
      using observer = connectFakeClient({ room: setup.room, person: CAROL, role: "viewer" });
      const approvalsSeen: string[] = [];
      observer.sharedDocument.on("afterTransaction", () => approvalsSeen.push(approvalKind(observer.sharedDocument, SCRIPT_ID)));

      const scriptMap = scriptMapOf(editor.sharedDocument, SCRIPT_ID);
      const current = currentFingerprint(scriptMap);
      editor.sharedDocument.transact(() => row.write(scriptMap, roots(editor.sharedDocument).meta, current));

      for (const replica of [serverDocumentOf(setup.room), editor.sharedDocument, observer.sharedDocument]) {
        assert.equal(approvalKind(replica, SCRIPT_ID), row.expectedApproval);
        assert.deepEqual(authorView(replica, SCRIPT_ID), row.expectedAuthor);
        assert.equal(roots(replica).meta.get("deckId"), row.expectedMeta.deckId);
        assert.equal(roots(replica).meta.get("schemaVersion"), row.expectedMeta.schemaVersion);
        assert.equal(roots(replica).meta.get("createdAt"), createdAt);
      }
      assert.deepEqual(corrections(editor.messages()), row.expectedCorrections);
      assert.deepEqual(corrections(observer.messages()), [], "only the sender is told");
      if (row.expectedCorrections.length > 0 && row.expectedApproval === "unapproved") {
        assert.equal(approvalsSeen.includes("approved"), false, "the third replica never held the forbidden approval");
      }
    });
  }
});

describe("structures waiting for their dependencies", () => {
  test("an editor's update that waits for a colleague's next clock is judged as the editor's, never as the colleague's", () => {
    using setup = testRoom();
    const scriptId = "tr_smuggledScript1" as TransitionScriptId;
    const saved = setup.room.applyEnvelope({
      envelope: envelope({
        author: { kind: "agent", name: "Claude", agentSessionId: "as_writer" },
        commands: [
          {
            kind: "upsertTransitionScript",
            script: { id: scriptId, name: "Wipe", description: "", script: "benign();", stylesheet: "", markup: "", defaultParameters: {} },
            basedOnUpdatedAt: null,
            approval: "unapproved",
          },
        ],
      }),
      summaryForCollaborators: "wrote a transition",
    });
    assert.equal(saved.kind, "applied");
    using alice = connectFakeClient({ room: setup.room, person: ALICE, role: "editor" });
    using bob = connectFakeClient({ room: setup.room, person: BOB, role: "editor" });

    // Bob builds structures under ALICE's client id, one clock past the last one the server has.
    const forger = new Y.Doc();
    forger.clientID = alice.sharedDocument.clientID;
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(bob.sharedDocument));
    roots(forger).meta.set("placeholder", 1);
    const gap = Y.encodeStateVector(forger);
    const forgedText = "stealEverything();";
    forger.transact(() => {
      const script = scriptMapOf(forger, scriptId);
      script.set("script", forgedText);
      script.set("author", { kind: "person", personId: ALICE.id });
      script.set("approval", { kind: "approved", approvedBy: ALICE.id, fingerprint: scriptFingerprint({ script: forgedText, stylesheet: "", markup: "" }) });
    });
    bob.sendBinary(syncUpdate(Y.encodeStateAsUpdate(forger, gap)));

    // Alice's next edit fills the clock Bob's structures waited for; they do not land in her transaction.
    setTitle(alice.sharedDocument, "Alice edits the title");
    assert.equal(titleOf(serverDocumentOf(setup.room)), "Alice edits the title", "control: Alice's own edit landed");
    assert.notEqual(scriptMapOf(serverDocumentOf(setup.room), scriptId).get("script"), forgedText);
    assert.deepEqual(corrections(alice.messages()), []);

    // Bob's next update carries them in, and the guard judges them as Bob's.
    setTitle(bob.sharedDocument, "Bob edits the title");
    const server = serverDocumentOf(setup.room);
    assert.equal(approvalKind(server, scriptId), "unapproved");
    assert.deepEqual(authorView(server, scriptId), { kind: "person", id: BOB.id });
    assert.deepEqual(corrections(bob.messages()).filter((correction) => correction.kind === "approvalRevoked"), [
      { kind: "approvalRevoked", scriptId, reason: "approvedByAnotherPerson" },
    ]);
  });

  test("an editor's update that overtakes its own earlier one lands once the earlier one arrives", () => {
    using setup = testRoom();
    using alice = connectFakeClient({ room: setup.room, person: ALICE, role: "editor", sendLocalUpdates: false });
    const start = Y.encodeStateVector(alice.sharedDocument);
    setTitle(alice.sharedDocument, "First");
    const middle = Y.encodeStateVector(alice.sharedDocument);
    const first = Y.encodeStateAsUpdate(alice.sharedDocument, start);
    roots(alice.sharedDocument).meta.set("placeholder", 2);
    const second = Y.encodeStateAsUpdate(alice.sharedDocument, middle);

    alice.sendBinary(syncUpdate(second));
    assert.notEqual(roots(serverDocumentOf(setup.room)).meta.get("placeholder"), 2, "the second waits");
    alice.sendBinary(syncUpdate(first));

    const server = serverDocumentOf(setup.room);
    assert.equal(titleOf(server), "First");
    assert.equal(roots(server).meta.get("placeholder"), 2);
    assert.deepEqual(resynchronisations(alice.messages()), []);
  });
});

describe("rate limit", () => {
  type Row = Readonly<{ name: string; framesPerSecond: number; expectClosed: boolean }>;
  const rows: readonly Row[] = [
    { name: "control: 15 frames a second for 16 seconds stays open", framesPerSecond: 15, expectClosed: false },
    { name: "50 frames a second is closed once it has been over the rate for 10 seconds", framesPerSecond: 50, expectClosed: true },
  ];

  test("150 frames at once: the first 100 are handled, then one rateLimited", () => {
    using setup = testRoom();
    using client = connectFakeClient({ room: setup.room, person: ALICE, role: "editor" });
    const framesBefore = client.binaryFrames().length;
    const textBefore = client.messages().length;
    const stepOne = syncStepOne();
    for (let index = 0; index < 150; index += 1) client.sendBinary(stepOne);
    assert.equal(client.binaryFrames().length - framesBefore, 100 - 2, "every handled step 1 is answered (two tokens went to the opening sync)");
    const rateLimited = client.messages().slice(textBefore).filter((message) => message.kind === "rateLimited");
    assert.equal(rateLimited.length, 1);
    assert.equal(client.closedWith(), null);
  });

  test("a document update over the rate closes the connection instead of being dropped", () => {
    using setup = testRoom();
    using client = connectFakeClient({ room: setup.room, person: ALICE, role: "editor" });
    for (let index = 0; index < 150 && client.closedWith() === null; index += 1) setTitle(client.sharedDocument, `Title ${String(index)}`);
    assert.equal(client.closedWith(), "rateLimited");
    const server = titleOf(serverDocumentOf(setup.room));
    assert.equal(typeof server === "string" && server.startsWith("Title "), true, "the updates before the limit landed");
  });

  for (const row of rows) {
    test(row.name, () => {
      using setup = testRoom();
      using client = connectFakeClient({ room: setup.room, person: ALICE, role: "editor" });
      const heartbeat = JSON.stringify({ kind: "heartbeat" });
      const stepMilliseconds = 1000 / row.framesPerSecond;
      let closedAt: number | null = null;
      const start = setup.clock.now();
      for (let elapsed = 0; elapsed <= 16_000; elapsed += stepMilliseconds) {
        setup.clock.set(start + Math.round(elapsed));
        client.sendText(heartbeat);
        if (client.closedWith() !== null && closedAt === null) closedAt = setup.clock.now() - start;
      }
      assert.equal(client.closedWith(), row.expectClosed ? "rateLimited" : null);
      if (row.expectClosed) {
        // The 98 tokens left after the opening sync last 98 / (50 - 20) = 3.3 seconds; then 10 seconds over.
        assert.ok(closedAt !== null && closedAt >= 13_000 && closedAt <= 14_000, `closed at ${String(closedAt)}`);
      }
    });
  }
});

function testRoom(): TestRoom {
  const clock = manualClock(1_000_000);
  const persisted: Uint8Array[] = [];
  const members: readonly DeckMember[] = [ALICE, BOB, CAROL].map((member) => ({ person: member, role: "editor", email: null }));
  const room = createDeckRoom({
    deckId: DECK_ID,
    seed: { kind: "blankDeck" },
    storedDiscussion: [],
    members,
    now: clock.now,
    scheduler: new VirtualTimeScheduler(),
    random: seededRandom(11),
    persistUpdate: (update) => persisted.push(update),
    persistDiscussionEntry: () => Promise.resolve(),
    connectionsChanged: () => undefined,
    warn: (message) => {
      throw new Error(`unexpected warning: ${message}`);
    },
  });
  return { room, clock, persisted, [Symbol.dispose]: () => room[Symbol.dispose]() };
}

/** The room's replica, rebuilt from what it persisted plus the latest encode. */
function serverDocumentOf(room: DeckRoom): Y.Doc {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, room.encodeState());
  return replica;
}

function person(id: string, displayName: string): Person {
  // Test person ids follow the deck-access.ts `pr_` + 32 hexadecimal shape by construction.
  return { id: id as Person["id"], displayName, colourIndex: 0, kind: "person" };
}

function roots(sharedDocument: Y.Doc) {
  return documentRoots(sharedDocument);
}

function titleOf(sharedDocument: Y.Doc): unknown {
  return roots(sharedDocument).meta.get("title");
}

function setTitle(sharedDocument: Y.Doc, title: string): void {
  const store = createDocumentStore({
    sharedDocument,
    seed: { kind: "none" },
    now: () => 0,
    random: seededRandom(1),
    scheduler: new VirtualTimeScheduler(),
    repairPolicy: "reportOnly",
    typingMergeWindowMilliseconds: 500,
  });
  const outcome = store.apply(envelope({ commands: [{ kind: "setTitle", title }] }));
  store[Symbol.dispose]();
  if (outcome.kind !== "applied") throw new Error("setTitle was rejected");
}

function stateDigest(sharedDocument: Y.Doc): string {
  return JSON.stringify(sharedDocument.getMap("meta").toJSON()) + JSON.stringify(sharedDocument.getMap("slides").toJSON());
}

function presencePerson(state: unknown): unknown {
  if (typeof state !== "object" || state === null || !("presence" in state)) return null;
  const presence: unknown = state.presence;
  if (typeof presence !== "object" || presence === null || !("person" in presence)) return null;
  return presence.person;
}

function resynchronisations(messages: readonly ServerMessage[]): readonly string[] {
  return messages.flatMap((message) => (message.kind === "resynchroniseRequired" ? [message.reason] : []));
}

function corrections(messages: readonly ServerMessage[]): readonly ProtectedFieldCorrection[] {
  return messages.flatMap((message) => (message.kind === "correction" ? [message.correction] : []));
}

function scriptMapOf(sharedDocument: Y.Doc, scriptId: TransitionScriptId): Y.Map<unknown> {
  const script = roots(sharedDocument).transitionScripts.get(scriptId);
  if (!(script instanceof Y.Map)) throw new Error("the script is synced");
  return script;
}

function currentFingerprint(script: Y.Map<unknown>): string {
  const text = (key: string): string => {
    const value: unknown = script.get(key);
    return typeof value === "string" ? value : "";
  };
  return scriptFingerprint({ script: text("script"), stylesheet: text("stylesheet"), markup: text("markup") });
}

function approvalKind(sharedDocument: Y.Doc, scriptId: TransitionScriptId): string {
  const script = roots(sharedDocument).transitionScripts.get(scriptId);
  if (!(script instanceof Y.Map)) return "missing";
  const approval: unknown = script.get("approval");
  return typeof approval === "object" && approval !== null && "kind" in approval && typeof approval.kind === "string" ? approval.kind : "malformed";
}

function authorView(sharedDocument: Y.Doc, scriptId: TransitionScriptId): Readonly<{ kind: string; id: string }> | null {
  const script = roots(sharedDocument).transitionScripts.get(scriptId);
  if (!(script instanceof Y.Map)) return null;
  const author: unknown = script.get("author");
  if (typeof author !== "object" || author === null || !("kind" in author)) return null;
  if (author.kind === "agent" && "agentSessionId" in author && typeof author.agentSessionId === "string") return { kind: "agent", id: author.agentSessionId };
  if (author.kind === "person" && "personId" in author && typeof author.personId === "string") return { kind: "person", id: author.personId };
  return null;
}

/** A sync update frame (y-protocols' encoder) carrying `update`. */
function syncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function syncStepOne(): Uint8Array {
  // A sync step 1 from an empty replica: [sync, step 1, state vector of nothing].
  const empty = new Y.Doc();
  const bytes = new Uint8Array([0, 0, ...lengthPrefixed(Y.encodeStateVector(empty))]);
  empty.destroy();
  return bytes;
}

function lengthPrefixed(bytes: Uint8Array): readonly number[] {
  return [bytes.length, ...bytes];
}
