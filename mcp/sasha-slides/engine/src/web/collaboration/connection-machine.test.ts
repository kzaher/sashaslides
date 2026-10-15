// THE CONNECTION REDUCER ON ITS OWN: what the page becoming visible does to a waiting connection,
// that events from an old socket generation change nothing, and that `attempt` resets only online.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOSE_CODE_BY_REASON, HEARTBEAT_INTERVAL_MILLISECONDS } from "../../contracts/collaboration.ts";
import { TEST_PERSON } from "../testing/collaboration-harness.ts";
import { initialConnectionState, reduceConnection, type DeckConnectionEvent, type DeckConnectionState } from "./connection-machine.ts";

function waiting(): DeckConnectionState {
  const closed = reduceConnection(initialConnectionState({ role: "editor", browserOnline: true }), { kind: "socketClosed", generation: 1, code: CLOSE_CODE_BY_REASON.serverShuttingDown, jitter: 0.5 });
  assert.equal(closed.phase.kind, "waiting");
  return closed;
}

function reduceAll(state: DeckConnectionState, events: readonly DeckConnectionEvent[]): DeckConnectionState {
  return events.reduce(reduceConnection, state);
}

describe("the connection reducer", () => {
  it("retries at once when the page becomes visible after being hidden past a heartbeat, and not sooner", () => {
    for (const row of [
      { hiddenFor: HEARTBEAT_INTERVAL_MILLISECONDS, phase: "connecting" },
      { hiddenFor: HEARTBEAT_INTERVAL_MILLISECONDS - 1, phase: "waiting" },
    ]) {
      const state = reduceAll(waiting(), [
        { kind: "visibilityChanged", visible: false, at: 1_000 },
        { kind: "visibilityChanged", visible: true, at: 1_000 + row.hiddenFor },
      ]);
      assert.equal(state.phase.kind, row.phase, JSON.stringify(row));
    }
  });

  it("ignores events of a socket generation that is gone", () => {
    const state = waiting();
    const stale: readonly DeckConnectionEvent[] = [
      { kind: "welcomeReceived", generation: 1, me: TEST_PERSON, role: "viewer", members: [] },
      { kind: "serverSynchronised", generation: 1 },
      { kind: "socketClosed", generation: 1, code: 4005, jitter: 0 },
      { kind: "heartbeatMissed", generation: 1 },
      { kind: "retryDue", generation: 1 },
    ];
    assert.deepEqual(reduceAll(state, stale), state);
  });

  it("counts failures until the connection is online again", () => {
    let state = waiting();
    assert.equal(state.attempt, 1);
    state = reduceConnection(state, { kind: "reconnectRequested" });
    state = reduceConnection(state, { kind: "socketClosed", generation: state.generation, code: 1006, jitter: 0 });
    assert.equal(state.attempt, 2);
    state = reduceConnection(state, { kind: "reconnectRequested" });
    const generation = state.generation;
    state = reduceAll(state, [
      { kind: "welcomeReceived", generation, me: TEST_PERSON, role: "editor", members: [] },
      { kind: "serverSynchronised", generation },
    ]);
    assert.deepEqual({ phase: state.phase.kind, attempt: state.attempt, everOnline: state.everOnline }, { phase: "online", attempt: 0, everOnline: true });
  });
});
