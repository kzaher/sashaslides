// THE SANDBOXED RUNNER'S FEEDBACK: every runner frame in state (the warm spare, the live run's
// runner) is one `reactSet` entry keyed by `runnerId`, so a frame exists exactly while its id is in
// state and is removed when the reducer drops it -- after a finish, a fallback, a cancel or the end
// of the show. The reducer owns every decision and every deadline; this feedback only performs
// effects and reports what happened as events.
//
// One runner's life:
//
//   create frame (sandbox="allow-scripts", inert) ─► runnerCreated, then runnerLoaded per `load`
//   window message from that frame's window, origin "null", kind runnerReady
//        ─► new MessageChannel, `connect` with port 2 transferred ─► runnerReady
//   run on this runner enters `preparing` ─► gather (prepare-message.ts) ─► post `prepare`
//                                            or transitionFellBack (too large) before posting
//   `prepared` ─► post `start`;  `running` ─► show the frame, `ping` every 250 milliseconds ─► pingSent
//   port messages ─► parsed ─► runnerMessage, or runnerMessageRejected (counted, never trusted)
//
// THE HANDSHAKE IS CHECKED BY SOURCE AND ORIGIN before a port exists: `event.source` must be one of
// our frames' windows and `event.origin` must be "null" (an opaque, sandboxed origin). A message
// with our protocol from any other window or origin is rejected and counted. After `connect`, only
// the private port is listened to.

import { EMPTY, Observable, Subscription, catchError, defer, distinctUntilChanged, from, interval, map, merge, mergeMap, of, switchMap, take } from "rxjs";
import { assertNever } from "../../contracts/assert-never.ts";
import type { RunnerId, TransitionRunId } from "../../contracts/ids.ts";
import type { PresenterDependencies, PresenterEvent, TransitionRun } from "../../contracts/presenter.ts";
import type { Feedback } from "../../contracts/rxfeedback.ts";
import { TRANSITION_LIMITS, TRANSITION_PROTOCOL, hasTransitionProtocol } from "../../contracts/transition-protocol.ts";
import { hostRunnerId, slotRunnerId } from "../presenter-queries.ts";
import type { PresenterSystemState } from "../presenter-state.ts";
import { gatherPrepare } from "./prepare-message.ts";
import { parseRunnerToHostMessage } from "./protocol-parsing.ts";
import type { HostPort, RunnerFrame, SandboxEnvironment, WindowMessage } from "./sandbox-environment.ts";

export function sandboxFeedback(
  options: Readonly<{ dependencies: PresenterDependencies; environment: SandboxEnvironment }>,
): Feedback<PresenterSystemState, PresenterEvent> {
  return (state$) =>
    defer(() => {
      const registry = new Map<RunnerId, RegisteredRunner>();
      const handshakes = options.environment.windowMessages.pipe(mergeMap((message) => routeHandshake({ message, registry })));
      const runners = options.dependencies.rxFeedback.reactSet<PresenterSystemState, RunnerId, PresenterEvent>({
        query: runnersInState,
        effects: (runnerId) => runnerLifecycle({ runnerId, state$, registry, dependencies: options.dependencies, environment: options.environment }),
      })(state$);
      return merge(handshakes, runners);
    });
}

/** Every runner state holds: the spare and the live run's. */
export function runnersInState(state: PresenterSystemState): ReadonlyMap<string, RunnerId> {
  const runners = new Map<string, RunnerId>();
  const spare = slotRunnerId(state.spareRunner);
  if (spare !== null) runners.set(spare, spare);
  const live = state.run === null ? null : hostRunnerId(state.run.host);
  if (live !== null) runners.set(live, live);
  return runners;
}

type RegisteredRunner = {
  readonly window: unknown;
  connected: boolean;
  readonly connect: () => void;
};

function routeHandshake(options: Readonly<{ message: WindowMessage; registry: ReadonlyMap<RunnerId, RegisteredRunner> }>): Observable<PresenterEvent> {
  const data = options.message.data;
  if (!hasTransitionProtocol(data)) return EMPTY;
  const owner = [...options.registry].find(([, runner]) => runner.window === options.message.source);
  if (owner === undefined) {
    // Not from any runner frame. Count it against a runner still waiting to connect (or any runner):
    // that is the one an impostor would be trying to take over.
    const waiting = [...options.registry].find(([, runner]) => !runner.connected) ?? [...options.registry][0];
    if (waiting === undefined) return EMPTY;
    return of(rejected({ runnerId: waiting[0], problem: "a protocol message from a window that is not a runner frame" }));
  }
  const [runnerId, runner] = owner;
  if (options.message.origin !== "null") return of(rejected({ runnerId, problem: `an announcement from origin ${options.message.origin.slice(0, 80)}, not an opaque one` }));
  if (data.kind !== "runnerReady") return of(rejected({ runnerId, problem: `"${data.kind.slice(0, 40)}" sent to the window instead of the port` }));
  if (runner.connected) return of(rejected({ runnerId, problem: "a second runnerReady" }));
  runner.connected = true;
  runner.connect();
  return EMPTY;
}

function runnerLifecycle(
  options: Readonly<{
    runnerId: RunnerId;
    state$: Observable<PresenterSystemState>;
    registry: Map<RunnerId, RegisteredRunner>;
    dependencies: PresenterDependencies;
    environment: SandboxEnvironment;
  }>,
): Observable<PresenterEvent> {
  const runnerId = options.runnerId;
  return new Observable<PresenterEvent>((subscriber) => {
    const subscriptions = new Subscription();
    const frame = options.environment.createRunnerFrame({ runnerId, address: options.dependencies.runnerAddress });
    let port: HostPort | null = null;
    let lastRunId: TransitionRunId | null = null;
    options.registry.set(runnerId, {
      window: frame.window,
      connected: false,
      connect: () => {
        const channel = options.environment.createChannel();
        const hostPort = channel.hostPort;
        port = hostPort;
        subscriptions.add(hostPort.messages.subscribe((data) => subscriber.next(portMessageEvent({ runnerId, data }))));
        frame.connect({ protocol: TRANSITION_PROTOCOL, kind: "connect" }, channel.runnerPort);
        subscriber.next({ kind: "runnerReady", runnerId });
        subscriptions.add(
          driveRuns({
            runnerId,
            state$: options.state$,
            port: hostPort,
            frame,
            dependencies: options.dependencies,
            onRun: (runId) => {
              lastRunId = runId;
            },
          }).subscribe((event) => subscriber.next(event)),
        );
      },
    });
    subscriber.next({ kind: "runnerCreated", runnerId });
    subscriptions.add(frame.loads.subscribe(() => subscriber.next({ kind: "runnerLoaded", runnerId })));
    return () => {
      subscriptions.unsubscribe();
      options.registry.delete(runnerId);
      const openPort: HostPort | null = port;
      if (openPort !== null) {
        // Courtesy only: the frame is removed next, which stops the script whatever it does.
        if (lastRunId !== null) openPort.post({ protocol: TRANSITION_PROTOCOL, kind: "cancel", runId: lastRunId, reason: "skippedByPresenter" }, []);
        openPort[Symbol.dispose]();
      }
      frame[Symbol.dispose]();
    };
  });
}

function portMessageEvent(options: Readonly<{ runnerId: RunnerId; data: unknown }>): PresenterEvent {
  const parsed = parseRunnerToHostMessage(options.data);
  switch (parsed.kind) {
    case "valid":
      return { kind: "runnerMessage", runnerId: options.runnerId, message: parsed.message };
    case "invalid":
      return rejected({ runnerId: options.runnerId, problem: parsed.problem });
    default:
      return assertNever(parsed);
  }
}

function rejected(options: Readonly<{ runnerId: RunnerId; problem: string }>): PresenterEvent {
  return { kind: "runnerMessageRejected", runnerId: options.runnerId, problem: options.problem };
}

/** The run hosted on this runner, with the state it was read from. */
type HostedRun = Readonly<{ run: TransitionRun; state: PresenterSystemState }>;

function driveRuns(
  options: Readonly<{
    runnerId: RunnerId;
    state$: Observable<PresenterSystemState>;
    port: HostPort;
    frame: RunnerFrame;
    dependencies: PresenterDependencies;
    onRun: (runId: TransitionRunId) => void;
  }>,
): Observable<PresenterEvent> {
  return options.state$.pipe(
    map((state): HostedRun | null => (state.run !== null && hostRunnerId(state.run.host) === options.runnerId ? { run: state.run, state } : null)),
    distinctUntilChanged((previous, next) => previous?.run.runId === next?.run.runId && previous?.run.phase === next?.run.phase),
    switchMap((hosted) =>
      defer(() => {
        options.frame.setShown(hosted !== null && hosted.run.phase === "running");
        if (hosted === null) return EMPTY;
        options.onRun(hosted.run.runId);
        return phaseEffect({ ...options, hosted });
      }),
    ),
  );
}

function phaseEffect(
  options: Readonly<{ hosted: HostedRun; state$: Observable<PresenterSystemState>; port: HostPort; dependencies: PresenterDependencies }>,
): Observable<PresenterEvent> {
  const run = options.hosted.run;
  switch (run.phase) {
    case "awaitingRunner":
      return EMPTY;
    case "preparing":
      return prepare(options);
    case "prepared":
      options.port.post({ protocol: TRANSITION_PROTOCOL, kind: "start", runId: run.runId }, []);
      return EMPTY;
    case "running":
      return interval(TRANSITION_LIMITS.pingIntervalMilliseconds, options.dependencies.scheduler).pipe(
        mergeMap(() => options.state$.pipe(take(1))),
        mergeMap((state): Observable<PresenterEvent> => {
          if (state.run === null || state.run.runId !== run.runId) return EMPTY;
          const sequence = state.run.nextPingSequence;
          options.port.post({ protocol: TRANSITION_PROTOCOL, kind: "ping", runId: run.runId, sequence }, []);
          return of({ kind: "pingSent", runId: run.runId, sequence });
        }),
      );
    default:
      return assertNever(run.phase);
  }
}

function prepare(options: Readonly<{ hosted: HostedRun; port: HostPort; dependencies: PresenterDependencies }>): Observable<PresenterEvent> {
  const run = options.hosted.run;
  const gathering = gatherPrepare({
    run,
    document: options.hosted.state.document,
    reducedMotion: options.hosted.state.reducedMotion,
    renderSlideMarkup: options.dependencies.renderSlideMarkup,
    assetStore: options.dependencies.assetStore,
    fontFiles: options.dependencies.fontFiles,
  });
  return from(gathering).pipe(
    mergeMap((outcome): Observable<PresenterEvent> => {
      switch (outcome.kind) {
        case "ready":
          options.port.post(outcome.message, outcome.transfer);
          return EMPTY;
        case "fallBack":
          return of({ kind: "transitionFellBack", runId: run.runId, reason: outcome.reason, message: outcome.message });
        default:
          return assertNever(outcome);
      }
    }),
    // A host-side failure (a renderer or font source that threw) cuts like a failed script, and is reported.
    catchError((error: unknown) => {
      options.dependencies.reportError(error, "presenter: preparing a scripted transition");
      return of<PresenterEvent>({ kind: "transitionFellBack", runId: run.runId, reason: "hostPrepareFailed", message: `The host could not prepare the transition: ${String(error)}` });
    }),
  );
}
