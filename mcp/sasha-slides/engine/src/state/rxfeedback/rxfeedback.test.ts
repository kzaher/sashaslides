// Acceptance test 1: the RxFeedback core's ordering, error containment, ring buffer and the two
// feedback helpers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NEVER, Observable, of } from "rxjs";
import { filter, map, mergeMap } from "rxjs/operators";
import { createSystem } from "./create-system.ts";
import { react, reactSet } from "./react-feedbacks.ts";

type TestEvent = Readonly<{ name: string }>;
type TestState = Readonly<{ reduced: readonly string[] }>;

const appendName = (state: TestState, event: TestEvent): TestState => ({ reduced: [...state.reduced, event.name] });

describe("createSystem", () => {
  it("reduces an event a feedback emits while A is reduced before B, even when B was dispatched during A's drain", () => {
    let dispatchB: (() => void) | null = null;
    using system = createSystem<TestState, TestEvent>({
      initial: { reduced: [] },
      reduce: appendName,
      feedbacks: [
        // Emits "A-effect" when A is reduced; at the same moment a view-like subscriber dispatches B.
        (state$) =>
          state$.pipe(
            filter((state) => state.reduced.at(-1) === "A"),
            mergeMap(() => {
              dispatchB?.();
              return of({ name: "A-effect" });
            }),
          ),
      ],
      onReducerError: () => assert.fail("no reducer error expected"),
      onFeedbackError: () => assert.fail("no feedback error expected"),
      eventLogCapacity: 10,
      now: () => 0,
    });
    dispatchB = () => system.dispatch({ name: "B" });
    system.dispatch({ name: "A" });
    assert.deepEqual(system.currentState().reduced, ["A", "A-effect", "B"]);
  });

  it("parametric over the queue: a dispatched event arriving during a drain waits, a feedback event does not", () => {
    const rows = [
      { emitter: "feedback", expected: ["A", "feedback-follow-up", "B"] },
      { emitter: "dispatch", expected: ["A", "B", "dispatch-follow-up"] },
    ] as const;
    for (const row of rows) {
      let system: ReturnType<typeof createSystem<TestState, TestEvent>> | null = null;
      system = createSystem<TestState, TestEvent>({
        initial: { reduced: [] },
        reduce: appendName,
        feedbacks: [
          (state$) =>
            state$.pipe(
              filter((state) => state.reduced.at(-1) === "A"),
              mergeMap(() => {
                system?.dispatch({ name: "B" });
                if (row.emitter === "feedback") return of({ name: "feedback-follow-up" });
                system?.dispatch({ name: "dispatch-follow-up" });
                return NEVER;
              }),
            ),
        ],
        onReducerError: () => assert.fail("no reducer error expected"),
        onFeedbackError: () => assert.fail("no feedback error expected"),
        eventLogCapacity: 10,
        now: () => 0,
      });
      system.dispatch({ name: "A" });
      assert.deepEqual(system.currentState().reduced, row.expected, row.emitter);
      system[Symbol.dispose]();
    }
  });

  it("keeps the last good state when the reducer throws and reports the event", () => {
    const reported: Readonly<{ error: unknown; event: TestEvent }>[] = [];
    using system = createSystem<TestState, TestEvent>({
      initial: { reduced: [] },
      reduce: (state, event) => {
        if (event.name === "explode") throw new Error("boom");
        return appendName(state, event);
      },
      feedbacks: [],
      onReducerError: (error, event) => reported.push({ error, event }),
      onFeedbackError: () => assert.fail("no feedback error expected"),
      eventLogCapacity: 10,
      now: () => 0,
    });
    system.dispatch({ name: "first" });
    system.dispatch({ name: "explode" });
    system.dispatch({ name: "second" });
    assert.deepEqual(system.currentState().reduced, ["first", "second"]);
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.event.name, "explode");
    assert.equal(system.recentEvents().find((logged) => logged.event.name === "explode")?.reducerFailed, true);
  });

  // A feedback that errors is reported by index and the others keep working; the control row's
  // feedback completes normally, so nothing is reported.
  for (const row of [
    { label: "a feedback whose stream errors is reported by its index", fails: true, expectedReports: [1] },
    { label: "control: a feedback that completes is not reported", fails: false, expectedReports: [] },
  ] as const) {
    it(row.label, () => {
      const reports: number[] = [];
      using system = createSystem<TestState, TestEvent>({
        initial: { reduced: [] },
        reduce: appendName,
        feedbacks: [
          (state$) => state$.pipe(filter((state) => state.reduced.at(-1) === "ping"), map(() => ({ name: "pong" }))),
          () => (row.fails ? new Observable<TestEvent>((subscriber) => subscriber.error(new Error("effect broke"))) : of<TestEvent>()),
        ],
        onReducerError: () => assert.fail("no reducer error expected"),
        onFeedbackError: (_error, feedbackIndex) => reports.push(feedbackIndex),
        eventLogCapacity: 10,
        now: () => 0,
      });
      system.dispatch({ name: "ping" });
      assert.deepEqual(reports, row.expectedReports);
      assert.deepEqual(system.currentState().reduced, ["ping", "pong"], "the other feedback still runs");
    });
  }

  it("keeps eventLogCapacity entries in the ring buffer with their source", () => {
    let clock = 100;
    using system = createSystem<TestState, TestEvent>({
      initial: { reduced: [] },
      reduce: appendName,
      feedbacks: [(state$) => state$.pipe(filter((state) => state.reduced.at(-1) === "e3"), map(() => ({ name: "echo" })))],
      onReducerError: () => assert.fail("no reducer error expected"),
      onFeedbackError: () => assert.fail("no feedback error expected"),
      eventLogCapacity: 3,
      now: () => {
        clock += 1;
        return clock;
      },
    });
    for (const name of ["e1", "e2", "e3", "e4"]) system.dispatch({ name });
    const logged = system.recentEvents();
    assert.deepEqual(
      logged.map((entry) => ({ name: entry.event.name, source: entry.source, sequence: entry.sequence })),
      [
        { name: "e3", source: "dispatch", sequence: 3 },
        { name: "echo", source: "feedback", sequence: 4 },
        { name: "e4", source: "dispatch", sequence: 5 },
      ],
    );
    assert.ok(logged.every((entry, index) => index === 0 || entry.at > (logged[index - 1]?.at ?? 0)));
  });

  it("disposing the system unsubscribes every feedback and ignores later dispatches", () => {
    let teardowns = 0;
    const system = createSystem<TestState, TestEvent>({
      initial: { reduced: [] },
      reduce: appendName,
      feedbacks: [
        () => new Observable<TestEvent>(() => () => (teardowns += 1)),
        () => new Observable<TestEvent>(() => () => (teardowns += 1)),
      ],
      onReducerError: () => assert.fail("no reducer error expected"),
      onFeedbackError: () => assert.fail("no feedback error expected"),
      eventLogCapacity: 3,
      now: () => 0,
    });
    let completed = false;
    system.state$.subscribe({ complete: () => (completed = true) });
    system[Symbol.dispose]();
    system.dispatch({ name: "late" });
    assert.equal(teardowns, 2);
    assert.equal(completed, true);
    assert.deepEqual(system.currentState().reduced, []);
  });
});

type RequestState = Readonly<{ request: string | null; keys: readonly string[] }>;
type RequestEvent = Readonly<{ kind: "set"; request: string | null } | { kind: "keys"; keys: readonly string[] }>;

const reduceRequests = (state: RequestState, event: RequestEvent): RequestState => {
  switch (event.kind) {
    case "set":
      return { ...state, request: event.request };
    case "keys":
      return { ...state, keys: event.keys };
    default:
      return event satisfies never;
  }
};

describe("react", () => {
  it("cancels the previous effect when the request changes and runs none for null", () => {
    const started: string[] = [];
    const cancelled: string[] = [];
    using system = createSystem<RequestState, RequestEvent>({
      initial: { request: null, keys: [] },
      reduce: reduceRequests,
      feedbacks: [
        react<RequestState, string, RequestEvent>({
          query: (state) => state.request,
          areEqual: (previous, next) => previous === next,
          effects: (request) =>
            new Observable<RequestEvent>(() => {
              started.push(request);
              return () => cancelled.push(request);
            }),
        }),
      ],
      onReducerError: () => assert.fail("no reducer error expected"),
      onFeedbackError: () => assert.fail("no feedback error expected"),
      eventLogCapacity: 10,
      now: () => 0,
    });
    system.dispatch({ kind: "set", request: "first" });
    system.dispatch({ kind: "set", request: "first" });
    system.dispatch({ kind: "set", request: "second" });
    system.dispatch({ kind: "set", request: null });
    assert.deepEqual(started, ["first", "second"]);
    assert.deepEqual(cancelled, ["first", "second"]);
  });
});

describe("reactSet", () => {
  it("starts an effect when a key appears and disposes it when the key leaves state", () => {
    const started: string[] = [];
    const disposed: string[] = [];
    using system = createSystem<RequestState, RequestEvent>({
      initial: { request: null, keys: [] },
      reduce: reduceRequests,
      feedbacks: [
        reactSet<RequestState, string, RequestEvent>({
          query: (state) => new Map(state.keys.map((key) => [key, key])),
          effects: (_request, key) =>
            new Observable<RequestEvent>(() => {
              started.push(key);
              return () => disposed.push(key);
            }),
        }),
      ],
      onReducerError: () => assert.fail("no reducer error expected"),
      onFeedbackError: () => assert.fail("no feedback error expected"),
      eventLogCapacity: 10,
      now: () => 0,
    });
    system.dispatch({ kind: "keys", keys: ["upload-1", "upload-2"] });
    system.dispatch({ kind: "keys", keys: ["upload-2", "upload-3"] });
    assert.deepEqual(started, ["upload-1", "upload-2", "upload-3"]);
    assert.deepEqual(disposed, ["upload-1"]);
    system[Symbol.dispose]();
    assert.deepEqual(disposed.sort(), ["upload-1", "upload-2", "upload-3"]);
  });
});
