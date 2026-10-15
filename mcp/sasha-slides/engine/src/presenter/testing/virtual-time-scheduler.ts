// A VIRTUAL CLOCK for the presenter's lifecycle tests: an rxjs `SchedulerLike` whose time moves only
// when a test says so, so "a ping unanswered for 2000 visible milliseconds" is asserted exactly and
// instantly. rxjs's own `VirtualTimeScheduler` flushes everything at once (an `interval` would never
// end) and does not let promises settle between steps, and the presenter's prepare step awaits
// promises (asset copies, font bytes) between timer steps. `advanceBy` runs due actions in time
// order and lets pending promise callbacks run before each one.

import { Subscription, type SchedulerAction, type SchedulerLike } from "rxjs";

export class VirtualTimeScheduler implements SchedulerLike {
  private current = 0;
  private insertion = 0;
  private readonly queue: VirtualAction<unknown>[] = [];

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  schedule<TState>(work: (this: SchedulerAction<TState>, state?: TState) => void, delay?: number, state?: TState): Subscription {
    const action = new VirtualAction<TState>({ scheduler: this, work });
    action.schedule(state, delay);
    return action;
  }

  /** Move time forward, running every action that falls due, letting promises settle in between. */
  async advanceBy(milliseconds: number): Promise<void> {
    const target = this.current + milliseconds;
    for (;;) {
      await settlePromises();
      const next = this.earliestDue(target);
      if (next === null) break;
      this.current = next.due;
      this.remove(next);
      next.execute();
    }
    this.current = target;
    await settlePromises();
  }

  /** Internal: (re)queue an action. */
  enqueue(action: VirtualAction<unknown>): void {
    this.remove(action);
    this.insertion += 1;
    action.insertion = this.insertion;
    this.queue.push(action);
  }

  /** Internal: drop an action. */
  remove(action: VirtualAction<unknown>): void {
    const index = this.queue.indexOf(action);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private earliestDue(limit: number): VirtualAction<unknown> | null {
    let earliest: VirtualAction<unknown> | null = null;
    for (const action of this.queue) {
      if (action.due > limit) continue;
      if (earliest === null || action.due < earliest.due || (action.due === earliest.due && action.insertion < earliest.insertion)) earliest = action;
    }
    return earliest;
  }
}

/** Resolves after every promise callback already queued (and those they queue) has run. */
export function settlePromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class VirtualAction<TState> extends Subscription implements SchedulerAction<TState> {
  due = 0;
  insertion = 0;
  private state: TState | undefined;
  private readonly scheduler: VirtualTimeScheduler;
  private readonly work: (this: SchedulerAction<TState>, state?: TState) => void;

  constructor(options: Readonly<{ scheduler: VirtualTimeScheduler; work: (this: SchedulerAction<TState>, state?: TState) => void }>) {
    super();
    this.scheduler = options.scheduler;
    this.work = options.work;
    // Same object; the queue is typed over unknown state (see `schedule`).
    this.add(() => options.scheduler.remove(this as VirtualAction<unknown>));
  }

  schedule(state?: TState, delay?: number): Subscription {
    if (this.closed) return this;
    this.state = state;
    this.due = this.scheduler.now() + (delay ?? 0);
    // The queue holds actions of any state type; each action only ever calls its own work.
    this.scheduler.enqueue(this as VirtualAction<unknown>);
    return this;
  }

  execute(): void {
    if (this.closed) return;
    this.work.call(this, this.state);
  }
}
