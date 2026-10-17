// A SCRIPTED STAND-IN FOR THE RUNNER SITE, for the sandbox lifecycle tests: frames that "load" and
// announce themselves on the virtual clock, and a runner end of the channel that answers `prepare`,
// `start` and `ping` the way a test describes -- or fails to, which is the point. Transfers go
// through `structuredClone` with the transfer list, so buffers really detach as they do in a page.

import { Subject } from "rxjs";
import { assertNever } from "../../contracts/assert-never.ts";
import type { RunnerId } from "../../contracts/ids.ts";
import { TRANSITION_PROTOCOL, type HostToRunnerMessage } from "../../contracts/transition-protocol.ts";
import type { HostPort, RunnerFrame, SandboxEnvironment, WindowMessage } from "../sandbox/sandbox-environment.ts";
import type { VirtualScheduler } from "../../state/testing/virtual-scheduler.ts";

export type FakeRunnerBehaviour = Readonly<{
  /** "never": the frame loads but its bootstrap never posts `runnerReady`. */
  announce: "normal" | "never";
  loadDelayMilliseconds: number;
  prepareDelayMilliseconds: number;
  answersPings: boolean;
  /** After `start`; null: never finishes. */
  finishAfterMilliseconds: number | null;
  /** Posts `failed` right after `started`. */
  failureOnStart: string | null;
}>;

export const COOPERATIVE_RUNNER: FakeRunnerBehaviour = {
  announce: "normal",
  loadDelayMilliseconds: 20,
  prepareDelayMilliseconds: 50,
  answersPings: true,
  finishAfterMilliseconds: 400,
  failureOnStart: null,
};

export type FakeFrame = {
  readonly runnerId: RunnerId;
  readonly window: Readonly<{ runnerId: RunnerId }>;
  readonly loads: Subject<void>;
  shown: boolean;
  disposed: boolean;
};

export type HostPost = Readonly<{ runnerId: RunnerId | null; message: HostToRunnerMessage }>;

export class FakeRunnerSite {
  readonly frames: FakeFrame[] = [];
  readonly hostPosts: HostPost[] = [];
  readonly windowMessages = new Subject<WindowMessage>();
  readonly environment: SandboxEnvironment;

  constructor(private readonly options: Readonly<{ scheduler: VirtualScheduler; behaviour: FakeRunnerBehaviour }>) {
    this.environment = {
      createRunnerFrame: (request) => this.createFrame(request.runnerId),
      windowMessages: this.windowMessages.asObservable(),
      createChannel: () => this.createChannel(),
    };
  }

  /** The frame fires `load` again: what a self-navigation looks like to the host. */
  reload(frame: FakeFrame): void {
    frame.loads.next();
  }

  postedKinds(): readonly string[] {
    return this.hostPosts.map((post) => post.message.kind);
  }

  private createFrame(runnerId: RunnerId): RunnerFrame {
    const frame: FakeFrame = { runnerId, window: { runnerId }, loads: new Subject<void>(), shown: false, disposed: false };
    this.frames.push(frame);
    this.options.scheduler.schedule(() => {
      if (frame.disposed) return;
      frame.loads.next();
      if (this.options.behaviour.announce === "never") return;
      this.windowMessages.next({ source: frame.window, origin: "null", data: { protocol: TRANSITION_PROTOCOL, kind: "runnerReady" } });
    }, this.options.behaviour.loadDelayMilliseconds);
    return {
      window: frame.window,
      loads: frame.loads.asObservable(),
      connect: (_message, runnerPort) => {
        // The runner end created by `createChannel` (see there); the frame now owns it.
        (runnerPort as unknown as FakeRunnerEnd).frame = frame;
      },
      setShown: (shown) => {
        frame.shown = shown;
      },
      [Symbol.dispose]: () => {
        frame.disposed = true;
        frame.loads.complete();
      },
    };
  }

  private createChannel(): Readonly<{ hostPort: HostPort; runnerPort: Transferable }> {
    const toHost = new Subject<unknown>();
    const runnerEnd: FakeRunnerEnd = { frame: null };
    const hostPort: HostPort = {
      messages: toHost.asObservable(),
      post: (message, transfer) => {
        const delivered = structuredClone(message, { transfer: [...transfer] });
        this.hostPosts.push({ runnerId: runnerEnd.frame?.runnerId ?? null, message: delivered });
        this.respond({ message: delivered, toHost, frame: runnerEnd.frame });
      },
      [Symbol.dispose]: () => toHost.complete(),
    };
    // Test-only widening: the fake runner end stands in for a MessagePort in the transfer list.
    return { hostPort, runnerPort: runnerEnd as unknown as Transferable };
  }

  private respond(options: Readonly<{ message: HostToRunnerMessage; toHost: Subject<unknown>; frame: FakeFrame | null }>): void {
    const behaviour = this.options.behaviour;
    const message = options.message;
    const send = (data: unknown, delay: number): void => {
      this.options.scheduler.schedule(() => {
        if (options.frame?.disposed !== true) options.toHost.next(data);
      }, delay);
    };
    const envelope = { protocol: TRANSITION_PROTOCOL, runId: message.runId };
    switch (message.kind) {
      case "prepare":
        send({ ...envelope, kind: "prepared" }, behaviour.prepareDelayMilliseconds);
        return;
      case "start":
        send({ ...envelope, kind: "started" }, 0);
        if (behaviour.failureOnStart !== null) send({ ...envelope, kind: "failed", stage: "run", message: behaviour.failureOnStart }, 1);
        else if (behaviour.finishAfterMilliseconds !== null) send({ ...envelope, kind: "finished" }, behaviour.finishAfterMilliseconds);
        return;
      case "ping":
        if (behaviour.answersPings) send({ ...envelope, kind: "pong", sequence: message.sequence, progress: 0.5 }, 1);
        return;
      case "cancel":
        return;
      default:
        assertNever(message);
    }
  }
}

type FakeRunnerEnd = { frame: FakeFrame | null };
