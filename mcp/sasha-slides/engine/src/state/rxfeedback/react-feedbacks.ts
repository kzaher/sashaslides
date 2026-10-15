// THE TWO FEEDBACK SHAPES every engine system writes its effects with (RxFeedback.js names them
// `react` and `reactSet`), so cancellation and per-entity cleanup are decided once, here, and not
// re-invented in each feedback.
//
//  * `react`: one request derived from state. When the request changes (by `areEqual`) the previous
//    effect is unsubscribed and the new one starts; `null` means "no effect". Built on `switchMap`,
//    so an effect whose request is gone can never deliver a late result.
//
//  * `reactSet`: a keyed set of requests, one per entity. An effect starts when its key appears and
//    is unsubscribed when the key leaves state, so an upload's timers or a notice's expiry timer are
//    released by construction. A request whose VALUE changes under the same key keeps its running
//    effect: per-entity progress (an upload's attempt counter) lives on the entity and must not
//    restart the work that reports it.

import { EMPTY, Observable, Subscription } from "rxjs";
import { distinctUntilChanged, map, switchMap } from "rxjs/operators";
import type { CreateReactFeedback, CreateReactSetFeedback, Feedback, ReactOptions, ReactSetOptions } from "../../contracts/index.ts";

export const react: CreateReactFeedback = <State, Request, Event>(options: ReactOptions<State, Request, Event>): Feedback<State, Event> =>
  (state$) =>
    state$.pipe(
      map((state) => options.query(state)),
      distinctUntilChanged((previous, next) => {
        if (previous === null || next === null) return previous === next;
        return options.areEqual(previous, next);
      }),
      switchMap((request) => (request === null ? EMPTY : options.effects(request))),
    );

export const reactSet: CreateReactSetFeedback = <State, Request, Event>(options: ReactSetOptions<State, Request, Event>): Feedback<State, Event> =>
  (state$) =>
    new Observable<Event>((subscriber) => {
      const running = new Map<string, Subscription>();
      const stateSubscription = state$.subscribe({
        next: (state) => {
          const requests = options.query(state);
          for (const [key, effect] of [...running]) {
            if (requests.has(key)) continue;
            running.delete(key);
            effect.unsubscribe();
          }
          for (const [key, request] of requests) {
            if (running.has(key)) continue;
            const effect = new Subscription();
            running.set(key, effect);
            effect.add(
              options.effects(request, key).subscribe({
                next: (event) => subscriber.next(event),
                error: (error: unknown) => subscriber.error(error),
              }),
            );
          }
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      return () => {
        stateSubscription.unsubscribe();
        for (const effect of running.values()) effect.unsubscribe();
        running.clear();
      };
    });
