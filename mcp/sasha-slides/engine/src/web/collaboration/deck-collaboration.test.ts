// THE COLLABORATION CLIENT against a y-protocols fake server (testing/fake-deck-server.ts), on a
// virtual-time scheduler: the handshake and both directions of document sync, the full-jitter
// backoff table, the browser's `online` event, the 40 second silence, every close reason, unsent
// changes, the discussion over the socket, malformed frames, and presence over awareness.
// Acceptance items 1 to 6 of the web application module, in that order.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Awareness } from "y-protocols/awareness";
import { Doc } from "yjs";
import {
  CLOSE_CODE_BY_REASON,
  CONNECTION_DEAD_AFTER_MILLISECONDS,
  RECONNECT_AFTER_CLOSE,
  type CloseReason,
} from "../../contracts/collaboration.ts";
import { EMPTY_DISCUSSION, type DiscussionLogEntry, type DiscussionRequest } from "../../contracts/discussion.ts";
import { mintId, type ThreadId } from "../../contracts/ids.ts";
import type { LocalPresence } from "../../contracts/presence.ts";
import { reduceDiscussionLog } from "../../model/index.ts";
import { createDeckApiClient, sessionCredentials } from "../api/deck-api-client.ts";
import { createCollaborationHarness, PEER_PERSON, TEST_DECK_ID, TEST_PERSON } from "../testing/collaboration-harness.ts";
import { awarenessFrame } from "./awareness-presence.ts";
import { CLOSE_HANDLING, reconnectDelayMilliseconds } from "./reconnect-policy.ts";

describe("1. the handshake and document sync", () => {
  it("goes connecting, then synchronising after the welcome, then online after the server's step 2", () => {
    using harness = createCollaborationHarness();
    assert.deepEqual(harness.status().connection, { kind: "connecting", attempt: 0 });
    const connection = harness.server.latest();
    assert.equal(connection.address, `wss://sashaslides.test/deck-api/sync/${TEST_DECK_ID}?discussionAfter=0`);
    assert.deepEqual(connection.protocols, ["sasha-deck.1"]);
    connection.open();
    connection.welcome();
    assert.equal(harness.server.flushOne(), true, "the welcome");
    assert.deepEqual(harness.status().connection, { kind: "synchronising" });
    harness.server.flush();
    assert.deepEqual(harness.status().connection, { kind: "online" });
    assert.deepEqual(harness.statuses.map((status) => status.connection.kind), ["synchronising", "online"]);
    assert.equal(harness.store.snapshot().deckId, TEST_DECK_ID, "the replica received the server's deck");
  });

  it("sends a local edit to the server, and applies a server edit with the remote origin", () => {
    using harness = createCollaborationHarness();
    harness.server.latest().handshake();
    harness.setTitle("Written here");
    assert.equal(harness.serverStore.snapshot().title, "Written here");

    const before = harness.origins.length;
    harness.serverStore.apply({
      commandId: mintId({ seed: { sessionPrefix: "ServerSd", counter: 1 }, kind: "command" }).id,
      author: { kind: "person", personId: PEER_PERSON.id },
      commands: [{ kind: "setTitle", title: "Written there" }],
      selectionBefore: { kind: "none" },
      selectionAfter: { kind: "none" },
      mergeWithPrevious: false,
    });
    harness.server.flush();
    assert.equal(harness.store.snapshot().title, "Written there");
    assert.deepEqual(harness.origins.slice(before), [{ kind: "remote" }]);
  });
});

describe("2. reconnecting", () => {
  it("waits exactly min(30000, 500 * 2^attempt) * random after each failure", () => {
    for (const random of [0, 0.5, 0.999]) {
      using harness = createCollaborationHarness({ random: () => random });
      for (let attempt = 0; attempt <= 6; attempt += 1) {
        const expected = Math.min(30_000, 500 * 2 ** attempt) * random;
        assert.equal(reconnectDelayMilliseconds({ attempt, random }), expected, `policy, attempt ${attempt}, random ${random}`);
        const socketsBefore = harness.server.connections().length;
        harness.server.latest().close(CLOSE_CODE_BY_REASON.serverShuttingDown);
        assert.deepEqual(
          harness.status().connection,
          { kind: "offline", reason: "serverRestarting", attempt: attempt + 1, retryInMilliseconds: expected },
          `status, attempt ${attempt}, random ${random}`,
        );
        if (expected > 0) {
          harness.scheduler.advanceBy(expected - 0.01);
          assert.equal(harness.server.connections().length, socketsBefore, `no socket before the wait ends, attempt ${attempt}`);
        }
        harness.scheduler.advanceBy(expected > 0 ? 0.01 : 0);
        assert.equal(harness.server.connections().length, socketsBefore + 1, `a socket when the wait ends, attempt ${attempt}, random ${random}`);
      }
    }
  });

  it("reconnects at once on the browser's online event during the wait (control: no event, no socket)", () => {
    for (const row of [{ onlineEvent: true, socketsAfter: 2 }, { onlineEvent: false, socketsAfter: 1 }]) {
      using harness = createCollaborationHarness({ random: () => 0.5 });
      harness.server.latest().handshake();
      harness.server.latest().close(CLOSE_CODE_BY_REASON.serverShuttingDown);
      assert.equal(harness.status().connection.kind, "offline");
      if (row.onlineEvent) harness.browserOnline.next(true);
      assert.equal(harness.server.connections().length, row.socketsAfter, JSON.stringify(row));
    }
  });

  it("shows networkLost with no timer while the browser is offline, and reconnects on the online event", () => {
    using harness = createCollaborationHarness();
    harness.server.latest().handshake();
    harness.browserOnline.next(false);
    harness.server.latest().close(1006);
    assert.deepEqual(harness.status().connection, { kind: "offline", reason: "networkLost", attempt: 1, retryInMilliseconds: null });
    harness.scheduler.advanceBy(120_000);
    assert.equal(harness.server.connections().length, 1);
    harness.browserOnline.next(true);
    assert.equal(harness.server.connections().length, 2);
  });

  it("reconnects after 40 s without any frame, and a heartbeat keeps the socket alive", () => {
    for (const row of [{ heartbeatAt: null, socketsAt40Seconds: 2 }, { heartbeatAt: 30_000, socketsAt40Seconds: 1 }]) {
      using harness = createCollaborationHarness();
      harness.server.latest().handshake();
      if (row.heartbeatAt !== null) {
        harness.scheduler.advanceBy(row.heartbeatAt);
        harness.server.latest().sendMessage({ kind: "heartbeat" });
        harness.server.flush();
        harness.scheduler.advanceBy(CONNECTION_DEAD_AFTER_MILLISECONDS - row.heartbeatAt);
      } else {
        harness.scheduler.advanceBy(CONNECTION_DEAD_AFTER_MILLISECONDS - 1);
        assert.equal(harness.server.connections().length, 1, "not yet at 39.999 s");
        harness.scheduler.advanceBy(1);
      }
      assert.equal(harness.server.connections().length, row.socketsAt40Seconds, JSON.stringify(row));
      if (row.socketsAt40Seconds === 2) assert.equal(harness.server.connections()[0]?.closedByClient(), 1000, "the silent socket was closed");
    }
  });
});

describe("3. every close reason", () => {
  it("the wording table agrees with the contract's RECONNECT_AFTER_CLOSE", () => {
    for (const reason of Object.keys(CLOSE_CODE_BY_REASON) as CloseReason[]) assert.equal(CLOSE_HANDLING[reason].kind, RECONNECT_AFTER_CLOSE[reason], reason);
  });

  for (const reason of Object.keys(CLOSE_CODE_BY_REASON) as CloseReason[]) {
    it(`${reason} (${CLOSE_CODE_BY_REASON[reason]}) -> ${RECONNECT_AFTER_CLOSE[reason]}`, async () => {
      const requests: string[] = [];
      const api = createDeckApiClient({
        origin: "https://sashaslides.test",
        credentials: sessionCredentials("cookie"),
        fetch: (address, init) => {
          requests.push(`${init.method ?? "GET"} ${new URL(address).pathname}`);
          return Promise.resolve(new Response(JSON.stringify(sessionBody()), { status: 200, headers: { "Content-Type": "application/json" } }));
        },
      });
      using harness = createCollaborationHarness({
        random: () => 0.5,
        refreshSession: async () => {
          const result = await api.session();
          return result.kind === "ok" ? { kind: "refreshed" } : { kind: "unreachable" };
        },
      });
      harness.server.latest().handshake();
      harness.server.latest().close(CLOSE_CODE_BY_REASON[reason]);
      await settle();
      const action = RECONNECT_AFTER_CLOSE[reason];
      switch (action) {
        case "refreshSessionThenReconnect":
          assert.deepEqual(requests, ["GET /deck-api/session"]);
          assert.equal(harness.server.connections().length, 2, "reconnected after the refresh");
          break;
        case "reconnectWithBackoff": {
          const connection = harness.status().connection;
          assert.equal(connection.kind, "offline");
          assert.deepEqual(requests, []);
          harness.scheduler.advanceBy(30_000);
          assert.equal(harness.server.connections().length, 2, "retried after the wait");
          break;
        }
        case "stop":
          // Every reason that stops has a closed reason of the same name (reconnect-policy.ts).
          assert.deepEqual(harness.status().connection, { kind: "closed", reason });
          harness.scheduler.advanceBy(600_000);
          harness.browserOnline.next(true);
          harness.collaboration.session.reconnectNow();
          await settle();
          assert.equal(harness.server.connections().length, 1, "no further attempts");
          assert.deepEqual(requests, []);
          break;
        default:
          assert.fail(`unknown action ${String(action)}`);
      }
    });
  }

  it("a refresh that finds the session signed out closes with signedOut and keeps the sign-in address", async () => {
    using harness = createCollaborationHarness({ refreshSession: () => Promise.resolve({ kind: "signedOut", signInAddress: "/account/deck-session?return=/deck/x" }) });
    harness.server.latest().handshake();
    harness.server.latest().close(CLOSE_CODE_BY_REASON.unauthenticated);
    await settle();
    assert.deepEqual(harness.status().connection, { kind: "closed", reason: "signedOut" });
    assert.equal(harness.collaboration.connection.currentState().signInAddress, "/account/deck-session?return=/deck/x");
  });
});

describe("4. unsent changes", () => {
  for (const row of [
    { localEdit: true, whileOffline: true, beforeDrain: true, afterDrain: false },
    { localEdit: false, whileOffline: false, beforeDrain: false, afterDrain: false },
  ]) {
    it(`local edit while offline: ${row.localEdit}`, () => {
      using harness = createCollaborationHarness({ random: () => 0 });
      harness.server.latest().handshake();
      harness.server.latest().close(CLOSE_CODE_BY_REASON.serverShuttingDown);
      if (row.localEdit) harness.setTitle("Typed offline");
      assert.equal(harness.status().unsentChanges, row.whileOffline, "while offline");
      harness.scheduler.advanceBy(0);
      const connection = harness.server.latest();
      connection.setBufferedAmount(64);
      connection.open();
      connection.welcome();
      harness.server.flush();
      assert.equal(connection.clientStepTwoReceived(), true, "the client sent its step 2");
      harness.scheduler.advanceBy(500);
      assert.equal(harness.status().unsentChanges, row.beforeDrain, "while bufferedAmount is above 0");
      connection.setBufferedAmount(0);
      harness.scheduler.advanceBy(100);
      assert.equal(harness.status().unsentChanges, row.afterDrain, "after the buffer drained");
      if (row.localEdit) assert.equal(harness.serverStore.snapshot().title, "Typed offline", "the offline edit arrived");
    });
  }
});

describe("5. the discussion over the socket", () => {
  it("queues a request while offline, sends it after the next welcome, and settles it by request id", async () => {
    using harness = createCollaborationHarness({ random: () => 0 });
    const store = harness.collaboration.discussionStore;
    const first = request("dq_TestFirst01");
    const second = request("dq_TestSecond1");
    const firstOutcome = store.submit(first);
    const secondOutcome = store.submit(second);
    assert.deepEqual(harness.server.discussionRequests(), [], "nothing sent before a welcome");
    harness.server.latest().handshake();
    assert.deepEqual(harness.server.discussionRequests(), [first, second]);

    harness.server.latest().sendMessage({ kind: "discussionOutcome", outcome: { kind: "applied", requestId: second.requestId, sequence: 2 } });
    harness.server.latest().sendMessage({ kind: "discussionOutcome", outcome: { kind: "rejected", requestId: first.requestId, reason: "notPermitted", message: "No." } });
    harness.server.flush();
    assert.deepEqual(await secondOutcome, { kind: "applied", requestId: second.requestId, sequence: 2 });
    assert.deepEqual(await firstOutcome, { kind: "rejected", requestId: first.requestId, reason: "notPermitted", message: "No." });
  });

  it("resends a request that had no answer when the socket dropped, after the next welcome", () => {
    using harness = createCollaborationHarness({ random: () => 0 });
    harness.server.latest().handshake();
    const pending = request("dq_TestResend1");
    void harness.collaboration.discussionStore.submit(pending);
    harness.server.latest().close(CLOSE_CODE_BY_REASON.serverShuttingDown);
    harness.scheduler.advanceBy(0);
    harness.server.latest().handshake();
    assert.deepEqual(harness.server.discussionRequests(), [pending, pending]);
  });

  it("folds entries with reduceDiscussionLog, ignoring sequences it already holds, and asks to continue after them", () => {
    using harness = createCollaborationHarness({ random: () => 0 });
    harness.server.latest().handshake();
    const entries = [entry({ sequence: 1, threadId: "th_TestThread1" }), entry({ sequence: 2, threadId: "th_TestThread2" })];
    harness.server.latest().sendMessage({ kind: "discussionEntries", entries });
    harness.server.latest().sendMessage({ kind: "discussionEntries", entries: [entries[1] ?? assert.fail(), entry({ sequence: 3, threadId: "th_TestThread3" })] });
    harness.server.flush();
    const expected = [...entries, entry({ sequence: 3, threadId: "th_TestThread3" })].reduce(reduceDiscussionLog, EMPTY_DISCUSSION);
    assert.deepEqual(harness.collaboration.discussionStore.snapshot(), expected);
    assert.equal(expected.threads.length, 3);
    harness.server.latest().close(CLOSE_CODE_BY_REASON.serverShuttingDown);
    harness.scheduler.advanceBy(0);
    assert.match(harness.server.latest().address, /discussionAfter=3$/);
  });

  it("refuses waiting requests when the connection closes for good", async () => {
    using harness = createCollaborationHarness();
    harness.server.latest().handshake();
    const outcome = harness.collaboration.discussionStore.submit(request("dq_TestRefused"));
    harness.server.latest().close(CLOSE_CODE_BY_REASON.deckDeleted);
    const settled = await outcome;
    assert.equal(settled.kind, "rejected");
  });

  it("ignores and counts malformed server frames, and never throws", () => {
    const rows: readonly Readonly<{ label: string; frame: string | Uint8Array }>[] = [
      { label: "not JSON", frame: "{nope" },
      { label: "unknown kind", frame: JSON.stringify({ kind: "fromTheFuture", value: 1 }) },
      { label: "welcome missing fields", frame: JSON.stringify({ kind: "welcome", protocolVersion: 1 }) },
      { label: "entries with a bad entry", frame: JSON.stringify({ kind: "discussionEntries", entries: [{ sequence: "one" }] }) },
      { label: "outcome without a request id", frame: JSON.stringify({ kind: "discussionOutcome", outcome: { kind: "applied", sequence: 1 } }) },
      { label: "access changed to an unknown role", frame: JSON.stringify({ kind: "accessChanged", role: "admiral" }) },
      { label: "a JSON array", frame: "[1,2,3]" },
      { label: "binary of an unknown message type", frame: new Uint8Array([7, 1, 2]) },
      { label: "empty binary", frame: new Uint8Array([]) },
    ];
    using harness = createCollaborationHarness();
    harness.server.latest().handshake();
    rows.forEach((row, index) => {
      if (typeof row.frame === "string") harness.server.latest().sendText(row.frame);
      else harness.server.latest().sendBinary(row.frame);
      assert.doesNotThrow(() => harness.server.flush(), row.label);
      assert.equal(harness.collaboration.connection.currentState().malformedFrames, index + 1, row.label);
    });
    assert.deepEqual(harness.status().connection, { kind: "online" }, "still online");
  });
});

describe("6. presence over awareness", () => {
  it("turns a peer's awareness state into a PeerPresence with its client id, excludes its own, and drops a removed peer", () => {
    using harness = createCollaborationHarness();
    harness.server.latest().handshake();
    const seen: (readonly number[])[] = [];
    const peersSeen: string[][] = [];
    using _subscription = harness.collaboration.presence.subscribe((peers) => {
      seen.push(peers.map((peer) => peer.clientId));
      peersSeen.push(peers.map((peer) => peer.person.displayName));
    });
    harness.collaboration.presence.publish(presenceOf(TEST_PERSON));
    assert.equal(harness.server.latest().clientAwareness().length, 1, "the local state went to the server");

    const peerDocument = new Doc();
    const peer = new Awareness(peerDocument);
    peer.setLocalState({ presence: presenceOf(PEER_PERSON) });
    harness.server.latest().sendBinary(awarenessFrame({ awareness: peer, clientIds: [peer.clientID] }));
    harness.server.flush();
    assert.deepEqual(seen.at(-1), [peer.clientID]);
    assert.deepEqual(peersSeen.at(-1), ["Grace Hopper"], "only the peer, never this client");

    peer.setLocalState(null);
    harness.server.latest().sendBinary(awarenessFrame({ awareness: peer, clientIds: [peer.clientID] }));
    harness.server.flush();
    assert.deepEqual(seen.at(-1), []);
    peer.destroy();
  });

  it("forgets every peer when the socket drops", () => {
    using harness = createCollaborationHarness();
    harness.server.latest().handshake();
    let latest: readonly number[] = [];
    using _subscription = harness.collaboration.presence.subscribe((peers) => {
      latest = peers.map((peer) => peer.clientId);
    });
    const peer = new Awareness(new Doc());
    peer.setLocalState({ presence: presenceOf(PEER_PERSON) });
    harness.server.latest().sendBinary(awarenessFrame({ awareness: peer, clientIds: [peer.clientID] }));
    harness.server.flush();
    assert.equal(latest.length, 1);
    harness.server.latest().close(1006);
    assert.deepEqual(latest, []);
    peer.destroy();
  });
});

function request(requestId: string): DiscussionRequest {
  return {
    // The test ids match OBJECT_ID_PATTERN; the brand is a compile-time marker.
    requestId: requestId as DiscussionRequest["requestId"],
    command: { kind: "resolveThread", threadId: mintId({ seed: { sessionPrefix: "TestThrd", counter: 1 }, kind: "thread" }).id },
  };
}

function entry(options: Readonly<{ sequence: number; threadId: string }>): DiscussionLogEntry {
  return {
    sequence: options.sequence,
    requestId: mintId({ seed: { sessionPrefix: "TestRqst", counter: options.sequence }, kind: "discussionRequest" }).id,
    actor: PEER_PERSON,
    at: 1_000 + options.sequence,
    command: {
      kind: "createThread",
      // The test ids match OBJECT_ID_PATTERN; the brand is a compile-time marker.
      threadId: options.threadId as ThreadId,
      anchor: { slideId: mintId({ seed: { sessionPrefix: "TestSlid", counter: 1 }, kind: "slide" }).id, target: { kind: "slide" }, region: null, elementFrameAtCreation: null },
      markings: [],
      messageId: mintId({ seed: { sessionPrefix: "TestMssg", counter: options.sequence }, kind: "message" }).id,
      body: `Comment ${options.sequence}`,
      mentions: [],
    },
  };
}

function presenceOf(person: LocalPresence["person"]): LocalPresence {
  return { person, slideId: null, selection: { kind: "none" }, pointer: { x: 10, y: 20 }, activity: "editing" };
}

function sessionBody(): unknown {
  return { me: TEST_PERSON, email: "ada@example.com", csrfToken: "csrf-1", expiresAt: 2_000_000, authentication: "cookie" };
}

/** Lets promise callbacks (the session refresh) run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}
