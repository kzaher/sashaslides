/**
 * A tiny RxFeedback (RxJS) state architecture.
 *
 * RxFeedback is a unidirectional reactive loop:
 *
 *     events$ ──scan(reduce, initial)──► state$ ──► (view)
 *        ▲                                  │
 *        └──────────── feedbacks ◄──────────┘
 *
 * `state$` is derived purely from a stream of events folded through a
 * `reduce` function (like a Redux reducer). Side effects live ONLY in
 * `feedbacks`: each feedback observes `state$` and emits new events, which
 * loop back into `events$`. So a component never calls `fetch` directly — it
 * dispatches an event, a feedback reacts to the resulting state and performs
 * the effect, and the effect's outcome is dispatched back as another event.
 *
 * This keeps the whole conversation viewer genuinely reactive: "load the
 * transcript", "run the SSE send", and "watch the graph for an in-flight
 * node" are three independent feedbacks wired to the same state, instead of a
 * tangle of imperative useEffects.
 *
 * Deliberately dependency-light — only `rxjs` core operators, which esbuild
 * bundles into the classic monitor script.
 */
import { BehaviorSubject, Observable, Subject, Subscription } from "rxjs";
import { scan, startWith, distinctUntilChanged } from "rxjs/operators";

/** A feedback observes the derived state and emits events back into the loop. */
export type Feedback<State, Event> = (state$: Observable<State>) => Observable<Event>;

/** A running RxFeedback system: the derived state stream plus a `dispatch`
 *  door for the view to inject events, and `unsubscribe` to tear it down. */
export interface RunningSystem<State, Event> {
  state$: Observable<State>;
  dispatch: (event: Event) => void;
  unsubscribe: () => void;
}

/**
 * Wire up a classic RxFeedback loop.
 *
 * @param initial   seed state
 * @param reduce    pure (state, event) => state fold
 * @param feedbacks side-effecting reactions; each maps state$ → event$
 *
 * The returned system starts COLD — nothing runs until `start()` (below via
 * useSystem) subscribes. We expose the pieces so the React hook controls the
 * subscription lifecycle (subscribe on mount, unsubscribe on unmount).
 */
export function makeSystem<State, Event>(
  initial: State,
  reduce: (state: State, event: Event) => State,
  feedbacks: Array<Feedback<State, Event>>,
): RunningSystem<State, Event> {
  // The single event bus. Everything — the view's dispatch AND every
  // feedback's emissions — funnels through here.
  const events$ = new Subject<Event>();

  // Derived state: fold events through reduce, seeded with `initial`. We use
  // a BehaviorSubject as the multicast state carrier so every feedback (and
  // the view) sees the CURRENT state immediately on subscribe, not just
  // future transitions. `startWith(initial)` guarantees a value even before
  // the first event.
  const state$ = new BehaviorSubject<State>(initial);

  const subscription = new Subscription();

  // events → state. This is the reducer spine.
  subscription.add(
    events$
      .pipe(scan(reduce, initial), startWith(initial), distinctUntilChanged())
      .subscribe((s) => state$.next(s)),
  );

  // Each feedback observes state$ and emits events back into events$.
  // Subscribing them AFTER the reducer spine means their first state read is
  // the seed (or the latest, via BehaviorSubject replay).
  for (const fb of feedbacks) {
    subscription.add(fb(state$).subscribe((e) => events$.next(e)));
  }

  return {
    state$: state$.asObservable(),
    dispatch: (event: Event) => events$.next(event),
    unsubscribe: () => {
      subscription.unsubscribe();
      events$.complete();
      state$.complete();
    },
  };
}
