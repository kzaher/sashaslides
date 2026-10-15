// THE RxFeedback SHAPE every engine system (the editor, the presenter) is built on, as types. The
// implementation is the "state" module's own copy (src/state/rxfeedback/) of the structured-
// prompting core (structured-prompting/src/client/react/rxfeedback.ts), with the things that core
// leaves out and this engine needs:
//
//  * A TWO-QUEUE MAILBOX, FEEDBACK EVENTS FIRST. `dispatch` enqueues into the EXTERNAL queue;
//    events a feedback emits enqueue into the INTERNAL queue; the drain always takes the internal
//    queue first and reduces one event at a time (trampolined, never re-entrant). So when the view
//    dispatches two keystrokes back to back, the `documentChanged` and `editSettled` caused by the
//    first are reduced BEFORE the second keystroke is -- the second insert is computed against the
//    document and caret the first one produced. A plain first-in-first-out mailbox would reduce the
//    second keystroke against the old snapshot and could type "ab" as "ba".
//
//  * STATE IS PUBLISHED SYNCHRONOUSLY after each reduce, before the next event is taken, so a
//    feedback with a synchronous effect (the document store is synchronous) completes its round
//    trip inside the same drain. Order is deterministic, which is what lets tests assert exact
//    event sequences without a scheduler.
//
//  * A REDUCER THAT CANNOT KILL THE SYSTEM. If `reduce` throws, the event is reported through
//    `onReducerError` and the last good state is kept (coding skill, "System design").
//
//  * A DEAD FEEDBACK IS REPORTED. An RxJS stream cannot continue after an error, so a feedback whose
//    stream errors stops for good; `onFeedbackError` says which one, so a silent loss of (say) the
//    upload feedback shows up in the error report. Feedbacks should still catch per effect.
//
//  * AN INSPECTABLE RING BUFFER of the last N events with the revision they produced, so the
//    editor's diagnostics panel (and a bug report) can show what happened.
//
// Feedbacks are functions of `state$`, and the two helpers RxFeedback.js is known for are part of
// the contract so every module writes effects the same way:
//
//  * `react`    -- one request derived from state; when it changes (by `areEqual`) the previous
//                  effect is cancelled and a new one starts; null means "no effect".
//  * `reactSet` -- a keyed set of requests (one per entity); an effect starts when its key appears
//                  and is unsubscribed when the key leaves state, so per-entity resources (a
//                  transition run, an upload, a notice's expiry timer) are released by construction.

import type { Observable } from "rxjs";

export type Reducer<State, Event> = (state: State, event: Event) => State;

/** A side effect: observes state, emits events back into the loop (into the internal queue). */
export type Feedback<State, Event> = (state$: Observable<State>) => Observable<Event>;

export type SystemOptions<State, Event> = Readonly<{
  initial: State;
  reduce: Reducer<State, Event>;
  feedbacks: readonly Feedback<State, Event>[];
  /** Called with the event that made `reduce` throw; the previous state is kept. */
  onReducerError: (error: unknown, event: Event) => void;
  /** Called once when feedback number `feedbackIndex` (its index in `feedbacks`) errors and stops. */
  onFeedbackError: (error: unknown, feedbackIndex: number) => void;
  /** How many recent events `recentEvents()` keeps. */
  eventLogCapacity: number;
  /** Clock for the event log's timestamps only; the reducer never sees it. */
  now: () => number;
}>;

export type LoggedEvent<Event> = Readonly<{
  sequence: number;
  at: number;
  /** Which queue delivered it (see the header). */
  source: "dispatch" | "feedback";
  event: Event;
  reducerFailed: boolean;
}>;

export interface RunningSystem<State, Event> extends Disposable {
  /** Replays the current state on subscribe, then every distinct new state. */
  readonly state$: Observable<State>;
  currentState(): State;
  /** Enqueue into the external queue; drains synchronously unless a drain is already running. */
  dispatch(event: Event): void;
  recentEvents(): readonly LoggedEvent<Event>[];
}

/** src/state/index.ts exports `createSystem` of this type. */
export type CreateSystem = <State, Event>(options: SystemOptions<State, Event>) => RunningSystem<State, Event>;

export type ReactOptions<State, Request, Event> = Readonly<{
  query: (state: State) => Request | null;
  areEqual: (previous: Request, next: Request) => boolean;
  effects: (request: Request) => Observable<Event>;
}>;

/** src/state/index.ts exports `react` of this type. */
export type CreateReactFeedback = <State, Request, Event>(options: ReactOptions<State, Request, Event>) => Feedback<State, Event>;

export type ReactSetOptions<State, Request, Event> = Readonly<{
  query: (state: State) => ReadonlyMap<string, Request>;
  effects: (request: Request, key: string) => Observable<Event>;
}>;

/** src/state/index.ts exports `reactSet` of this type. */
export type CreateReactSetFeedback = <State, Request, Event>(options: ReactSetOptions<State, Request, Event>) => Feedback<State, Event>;
