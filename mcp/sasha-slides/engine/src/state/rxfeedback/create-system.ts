// THE ENGINE'S RxFeedback LOOP: `state = reduce(events)`, side effects only in feedbacks that map
// `state$` to events. The engine's own tested copy of the structured-prompting core
// (structured-prompting/src/client/react/rxfeedback.ts), reshaped to the contract in
// contracts/rxfeedback.ts. What it adds, and why:
//
//  * TWO QUEUES, FEEDBACK EVENTS FIRST. `dispatch` feeds the external queue, every feedback emission
//    the internal one, and the drain always empties the internal queue first. When the view
//    dispatches two keystrokes back to back, the `documentChanged` and `editSettled` the first one
//    caused are reduced before the second keystroke, so the second insert is computed against the
//    document and caret the first produced. A single first-in-first-out queue could type "ab" as
//    "ba".
//
//  * ONE DRAIN, NEVER RE-ENTRANT. Whoever enqueues while a drain runs (a feedback reacting to a
//    published state, a view handler subscribed to `state$`) only enqueues; the running drain takes
//    it. Feedbacks are also subscribed under the drain guard, so an effect that emits synchronously
//    on its first state never re-enters the subscription that started it.
//
//  * SYNCHRONOUS PUBLICATION. Each new state is published before the next event is taken, so a
//    feedback with a synchronous effect (the document store is synchronous) completes its round trip
//    inside the same drain, in a deterministic order tests can assert without a scheduler.
//
//  * A REDUCER THAT CANNOT KILL THE SYSTEM. A throwing `reduce` is reported through
//    `onReducerError`, the event is logged as failed, and the last good state is kept.
//
//  * AN INSPECTABLE RING BUFFER of the last `eventLogCapacity` events with their source, for the
//    diagnostics panel and bug reports, and for the replay test that proves the reducer pure.
//
//  * A DEAD FEEDBACK IS REPORTED. A feedback whose stream errors stops (an RxJS stream cannot continue
//    after an error); `onFeedbackError` names it by index. The editor's feedbacks catch per effect,
//    so this is the last line, not the strategy.

import { BehaviorSubject, Subscription, type Observable } from "rxjs";
import { distinctUntilChanged } from "rxjs/operators";
import type { CreateSystem, LoggedEvent, RunningSystem, SystemOptions } from "../../contracts/index.ts";

export const createSystem: CreateSystem = <State, Event>(options: SystemOptions<State, Event>): RunningSystem<State, Event> => {
  const stateSubject = new BehaviorSubject<State>(options.initial);
  const publishedState$: Observable<State> = stateSubject.pipe(distinctUntilChanged());
  const externalQueue: Event[] = [];
  const internalQueue: Event[] = [];
  const eventLog: LoggedEvent<Event>[] = [];
  const subscriptions = new Subscription();
  let sequence = 0;
  let draining = false;
  let disposed = false;

  const enqueue = (event: Event, source: LoggedEvent<Event>["source"]): void => {
    if (disposed) return;
    switch (source) {
      case "dispatch":
        externalQueue.push(event);
        break;
      case "feedback":
        internalQueue.push(event);
        break;
      default:
        assertNeverSource(source);
    }
    drain();
  };

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        if (disposed) return;
        const next = takeNext();
        if (next === null) return;
        reduceOne(next);
      }
    } finally {
      draining = false;
    }
  };

  const takeNext = (): Readonly<{ event: Event; source: LoggedEvent<Event>["source"] }> | null => {
    if (internalQueue.length > 0) {
      // length was checked on the line above, so shift returns an element.
      return { event: internalQueue.shift() as Event, source: "feedback" };
    }
    if (externalQueue.length > 0) {
      // length was checked on the line above, so shift returns an element.
      return { event: externalQueue.shift() as Event, source: "dispatch" };
    }
    return null;
  };

  const reduceOne = (queued: Readonly<{ event: Event; source: LoggedEvent<Event>["source"] }>): void => {
    const previous = stateSubject.getValue();
    let next = previous;
    let reducerFailed = false;
    try {
      next = options.reduce(previous, queued.event);
    } catch (error: unknown) {
      reducerFailed = true;
      options.onReducerError(error, queued.event);
    }
    sequence += 1;
    eventLog.push({ sequence, at: options.now(), source: queued.source, event: queued.event, reducerFailed });
    while (eventLog.length > Math.max(0, options.eventLogCapacity)) eventLog.shift();
    if (next !== previous) stateSubject.next(next);
  };

  // Subscribing feedbacks under the drain guard: an effect that emits on its very first state only
  // enqueues, and the drain below reduces it once every feedback is listening.
  draining = true;
  try {
    options.feedbacks.forEach((feedback, feedbackIndex) => {
      subscriptions.add(
        feedback(publishedState$).subscribe({
          next: (event) => enqueue(event, "feedback"),
          error: (error: unknown) => options.onFeedbackError(error, feedbackIndex),
        }),
      );
    });
  } finally {
    draining = false;
  }
  drain();

  return {
    state$: publishedState$,
    currentState: () => stateSubject.getValue(),
    dispatch: (event: Event) => enqueue(event, "dispatch"),
    recentEvents: () => eventLog.slice(),
    [Symbol.dispose]: () => {
      if (disposed) return;
      disposed = true;
      externalQueue.length = 0;
      internalQueue.length = 0;
      subscriptions.unsubscribe();
      stateSubject.complete();
    },
  };
};

function assertNeverSource(source: never): never {
  throw new Error(`Unknown event source: ${String(source)}`);
}
