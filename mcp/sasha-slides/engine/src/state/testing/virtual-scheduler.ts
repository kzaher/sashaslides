// A VIRTUAL-TIME SCHEDULER for the editor's feedback tests. Every timer in an editor feedback runs
// on the injected `SchedulerLike` (contracts/editor-system.ts), so a test passes this one and moves
// time explicitly: upload backoff, the 20 second upload timeout, notice expiry and presence
// throttling are asserted to the millisecond without waiting.
//
// Hand-written rather than rxjs's `VirtualTimeScheduler` because tests need to ADVANCE BY a span and
// stop (that one only flushes everything), and because rescheduling an action from inside its own
// work (what `timer` with a period and `throttleTime` do) must land at the right virtual time.

import { Subscription, type SchedulerAction, type SchedulerLike } from "rxjs";

export type VirtualScheduler = SchedulerLike &
  Readonly<{
    /** Run every action due within the next `milliseconds`, in time order, then set the clock. */
    advanceBy: (milliseconds: number) => void;
    /** How many actions are waiting. */
    pendingCount: () => number;
  }>;

export function createVirtualScheduler(options: Readonly<{ startAt: number }>): VirtualScheduler {
  let clock = options.startAt;
  let insertionCounter = 0;
  const queue: ScheduledEntry[] = [];

  const enqueue = (entry: ScheduledEntry): void => {
    queue.push(entry);
    queue.sort((left, right) => left.dueAt - right.dueAt || left.order - right.order);
  };

  const scheduler: VirtualScheduler = {
    now: () => clock,
    schedule<TState>(work: (this: SchedulerAction<TState>, state?: TState) => void, delay = 0, state?: TState): Subscription {
      const cancel = (owner: unknown): void => {
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          if (queue[index]?.owner === owner) queue.splice(index, 1);
        }
      };
      const action = new VirtualAction<TState>({
        work,
        // Like rxjs's AsyncAction: a reschedule replaces the action's pending run, never adds a second.
        reschedule: (entryAction, nextState, nextDelay) => {
          cancel(entryAction);
          insertionCounter += 1;
          enqueue({ dueAt: clock + nextDelay, order: insertionCounter, run: () => entryAction.execute(nextState), owner: entryAction });
        },
        cancel,
      });
      insertionCounter += 1;
      enqueue({ dueAt: clock + delay, order: insertionCounter, run: () => action.execute(state), owner: action });
      return action;
    },
    advanceBy: (milliseconds: number) => {
      const target = clock + milliseconds;
      for (;;) {
        const next = queue[0];
        if (next === undefined || next.dueAt > target) break;
        queue.shift();
        clock = next.dueAt;
        next.run();
      }
      clock = target;
    },
    pendingCount: () => queue.length,
  };
  return scheduler;
}

type ScheduledEntry = {
  dueAt: number;
  order: number;
  run: () => void;
  owner?: unknown;
};

/** One scheduled unit of work; `schedule` from inside the work reschedules it (rxjs action protocol). */
class VirtualAction<TState> extends Subscription implements SchedulerAction<TState> {
  private readonly work: (this: SchedulerAction<TState>, state?: TState) => void;
  private readonly onReschedule: (action: VirtualAction<TState>, state: TState | undefined, delay: number) => void;

  constructor(options: Readonly<{
    work: (this: SchedulerAction<TState>, state?: TState) => void;
    reschedule: (action: VirtualAction<TState>, state: TState | undefined, delay: number) => void;
    cancel: (action: VirtualAction<TState>) => void;
  }>) {
    super();
    this.add(() => options.cancel(this));
    this.work = options.work;
    this.onReschedule = options.reschedule;
  }

  schedule(state?: TState, delay = 0): Subscription {
    if (this.closed) return this;
    this.onReschedule(this, state, delay);
    return this;
  }

  execute(state: TState | undefined): void {
    if (this.closed) return;
    this.work.call(this, state);
  }
}
