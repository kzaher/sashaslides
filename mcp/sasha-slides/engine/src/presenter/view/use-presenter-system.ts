// REACT'S WINDOW ONTO THE PRESENTER SYSTEM: the system is created when the component mounts and
// disposed when it unmounts (so its timers and runner frames live exactly as long as the screen
// that shows them), and the component renders from `state$` -- a passive subscriber, never a
// second copy of the state.
//
// The system is created in an effect, not during render, because creating it subscribes the
// feedbacks (timers, frames); React may render a component more than once before it commits, and
// Strict Mode mounts it twice, so construction must happen where cleanup is guaranteed.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PresenterEvent } from "../../contracts/presenter.ts";
import type { RunningSystem } from "../../contracts/rxfeedback.ts";
import type { PresenterSystemState } from "../presenter-state.ts";

export type PresenterSystemHandle = Readonly<{
  state: PresenterSystemState;
  dispatch: (event: PresenterEvent) => void;
}>;

export function usePresenterSystem(
  options: Readonly<{ initial: PresenterSystemState; create: () => RunningSystem<PresenterSystemState, PresenterEvent> }>,
): PresenterSystemHandle {
  const [state, setState] = useState(options.initial);
  const systemReference = useRef<RunningSystem<PresenterSystemState, PresenterEvent> | null>(null);
  const create = useLatest(options.create);
  useEffect(() => {
    const system = create.current();
    systemReference.current = system;
    const subscription = system.state$.subscribe(setState);
    return () => {
      subscription.unsubscribe();
      systemReference.current = null;
      system[Symbol.dispose]();
    };
  }, [create]);
  const dispatch = useCallback((event: PresenterEvent) => systemReference.current?.dispatch(event), []);
  return { state, dispatch };
}

/** A ref that always holds the latest value, for callbacks a long-lived effect must not capture stale. */
export function useLatest<TValue>(value: TValue): Readonly<{ current: TValue }> {
  const reference = useRef(value);
  useLayoutEffect(() => {
    reference.current = value;
  });
  return reference;
}
