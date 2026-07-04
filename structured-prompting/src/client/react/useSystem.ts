/**
 * React binding for an RxFeedback system. Subscribes to the system's
 * `state$` in an effect, mirrors each emission into React state (so the
 * component re-renders), and tears the subscription down on unmount.
 *
 * Pure logic — no JSX — so no react/preact pragma is needed. Imports the
 * hooks from `react` explicitly.
 */
import { useState, useEffect, useRef } from "react";
import type { Observable } from "rxjs";

/**
 * Subscribe to `state$` and return the latest value. `getInitial` supplies
 * the value for the very first render (before the subscription's synchronous
 * replay lands) so we never render `undefined`.
 *
 * The subscription is created ONCE (empty dep array) — the caller is expected
 * to pass a STABLE state$ (created behind a useRef / useMemo). If the system
 * itself is recreated the component should remount (Detail keys on nodeId).
 */
export function useObservableState<State>(
  state$: Observable<State>,
  getInitial: () => State,
): State {
  const [state, setState] = useState<State>(getInitial);
  // Keep the latest state$ in a ref so the effect can read it without
  // resubscribing when identity changes are intentional (they aren't here,
  // but this guards a stale-closure warning).
  const stream = useRef(state$);
  stream.current = state$;
  useEffect(() => {
    const sub = stream.current.subscribe((s) => setState(s));
    return () => sub.unsubscribe();
  }, []);
  return state;
}
