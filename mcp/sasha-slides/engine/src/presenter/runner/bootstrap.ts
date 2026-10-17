// THE RUNNER BOOTSTRAP: our code inside the sandboxed frame, bundled by build-presenter.ts into the
// runner page. It announces itself, takes the private port the host transfers, and runs one
// transition at a time against the same `TransitionContext` the in-page host builds
// (transition-context.ts).
//
//   load ─► window.parent.postMessage(runnerReady, "*")       (the host checks source and origin)
//   connect (port in event.ports) ─► everything else on the port
//   prepare ─► blob addresses for the asset bytes, tokens substituted in both slides' markup and the
//              overlay, fonts loaded with FontFace, the stage built and scaled to this viewport, the
//              script evaluated from a blob address (it must call sashaTransition.define), images
//              decoded ─► prepared   (or failed { stage: "define" | "prepare" })
//   start ─► started, then run(context) ─► finished, or failed { stage: "run" }
//   ping ─► pong with progress, ANSWERED FROM THE MESSAGE HANDLER: a script that blocks the main
//           thread blocks this too, which is exactly how the host detects a stall
//   cancel ─► abort: every animation is cancelled and nothing more is posted for that run
//
// The script's `console` output is forwarded as `log` messages (at most 50 per run, 500 characters
// each); uncaught errors and rejections too. Nothing here trusts the script: it runs in this
// opaque-origin frame with no network, and every outcome is a message the host validates.

import { ASSET_ADDRESS_SCHEME } from "../../contracts/render.ts";
import {
  TRANSITION_LIMITS,
  TRANSITION_PROTOCOL,
  hasTransitionProtocol,
  type RunnerToHostMessage,
  type TransitionAuthoringGlobal,
  type TransitionDefinition,
} from "../../contracts/transition-protocol.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { fitBox } from "../../shared/fit-box.ts";
import type { PrepareMessage } from "../sandbox/prepare-message.ts";
import { parseHostToRunnerMessage } from "../sandbox/protocol-parsing.ts";
import { buildTransitionContext, type TransitionStage } from "../transition-context.ts";

/** Distributes `Omit` over a union, so each message kind keeps its own fields. */
type WithoutEnvelope<TMessage> = TMessage extends unknown ? Omit<TMessage, "protocol" | "runId"> : never;

type RunnerRun = {
  readonly runId: string;
  readonly message: PrepareMessage;
  readonly controller: AbortController;
  readonly objectAddresses: string[];
  stage: TransitionStage | null;
  definition: TransitionDefinition | null;
  startedAt: number | null;
  logCount: number;
};

startRunner(window);

function startRunner(runnerWindow: Window): void {
  let connected = false;
  runnerWindow.addEventListener("message", (event) => {
    if (connected || event.source !== runnerWindow.parent) return;
    if (!hasTransitionProtocol(event.data) || event.data.kind !== "connect") return;
    const port = event.ports[0];
    if (port === undefined) return;
    connected = true;
    const runner = createRunner({ runnerWindow, port });
    port.addEventListener("message", (message) => runner.receive(message.data));
    port.start();
  });
  runnerWindow.parent.postMessage({ protocol: TRANSITION_PROTOCOL, kind: "runnerReady" }, "*");
}

function createRunner(options: Readonly<{ runnerWindow: Window; port: MessagePort }>): Readonly<{ receive: (data: unknown) => void }> {
  const runnerWindow = options.runnerWindow;
  let current: RunnerRun | null = null;
  const post = (run: RunnerRun, message: WithoutEnvelope<RunnerToHostMessage>): void => {
    if (run.controller.signal.aborted && message.kind !== "log") return;
    options.port.postMessage({ protocol: TRANSITION_PROTOCOL, runId: run.runId, ...message });
  };
  const log = (level: "information" | "warning" | "error", parts: readonly unknown[]): void => {
    const run = current;
    if (run === null || run.logCount >= TRANSITION_LIMITS.maximumLogMessagesPerRun) return;
    run.logCount += 1;
    post(run, { kind: "log", level, message: parts.map(describe).join(" ").slice(0, TRANSITION_LIMITS.maximumLogMessageLength) });
  };
  // The bootstrap runs in the runner window itself, so the global console is that window's.
  forwardConsole({ console: globalThis.console, log });
  runnerWindow.addEventListener("error", (event) => log("error", [event.message]));
  runnerWindow.addEventListener("unhandledrejection", (event) => log("error", ["Unhandled rejection:", event.reason]));
  return {
    receive(data) {
      const parsed = parseHostToRunnerMessage(data);
      switch (parsed.kind) {
        case "invalid":
          return;
        case "valid":
          break;
        default:
          assertNever(parsed);
      }
      const message = parsed.message;
      switch (message.kind) {
        case "prepare": {
          if (current !== null) endRun({ run: current, runnerWindow });
          const run: RunnerRun = { runId: message.runId, message, controller: new AbortController(), objectAddresses: [], stage: null, definition: null, startedAt: null, logCount: 0 };
          current = run;
          prepare({ run, runnerWindow }).then(
            () => post(run, { kind: "prepared" }),
            (error: unknown) => post(run, { kind: "failed", stage: error instanceof DefineError ? "define" : "prepare", message: describe(error) }),
          );
          return;
        }
        case "start": {
          const run = current;
          if (run === null || run.runId !== message.runId || run.definition === null || run.stage === null) return;
          post(run, { kind: "started" });
          run.startedAt = runnerWindow.performance.now();
          play({ run, runnerWindow }).then(
            () => post(run, { kind: "finished" }),
            (error: unknown) => post(run, { kind: "failed", stage: "run", message: describe(error) }),
          );
          return;
        }
        case "ping": {
          const run = current;
          if (run === null || run.runId !== message.runId) return;
          post(run, { kind: "pong", sequence: message.sequence, progress: progressOf({ run, now: runnerWindow.performance.now() }) });
          return;
        }
        case "cancel":
          if (current !== null && current.runId === message.runId) endRun({ run: current, runnerWindow });
          return;
        default:
          assertNever(message);
      }
    },
  };
}

class DefineError extends Error {}

async function prepare(options: Readonly<{ run: RunnerRun; runnerWindow: Window }>): Promise<void> {
  const { run, runnerWindow } = options;
  const document = runnerWindow.document;
  const message = run.message;
  const addresses = new Map<string, string>();
  for (const asset of message.assets) {
    const address = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mediaType }));
    run.objectAddresses.push(address);
    addresses.set(asset.assetId, address);
  }
  const substitute = (markup: string): string => markup.replace(ASSET_TOKEN_PATTERN, (_whole, assetId: string) => addresses.get(assetId) ?? "");
  await Promise.all(
    message.fonts.map(async (font) => {
      const face = new FontFace(font.family, font.bytes, { weight: String(font.weight), style: font.style });
      await face.load();
      document.fonts.add(face);
    }),
  );
  run.stage = buildStage({ document, runnerWindow, message, substitute });
  run.definition = await evaluateScript({ run, runnerWindow });
  await Promise.all([...run.stage.stage.querySelectorAll("img")].map((image) => image.decode().catch(() => undefined)));
}

// Asset tokens in markup (render.ts): the scheme followed by an asset id.
const ASSET_TOKEN_PATTERN = new RegExp(`${ASSET_ADDRESS_SCHEME.replace(/[/.]/g, "\\$&")}([A-Za-z0-9_:\\-]+)`, "g");

function buildStage(
  options: Readonly<{ document: Document; runnerWindow: Window; message: PrepareMessage; substitute: (markup: string) => string }>,
): TransitionStage {
  const { document, message } = options;
  document.body.replaceChildren();
  const style = document.createElement("style");
  style.textContent = message.bundle.stylesheet;
  document.head.appendChild(style);
  const pageWidth = 1280;
  const stage = document.createElement("div");
  stage.id = "sasha-stage";
  const { scale, left, top } = fitBox({
    container: { width: options.runnerWindow.innerWidth, height: options.runnerWindow.innerHeight },
    content: { width: pageWidth, height: message.pageHeight },
  });
  Object.assign(stage.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${pageWidth}px`,
    height: `${message.pageHeight}px`,
    overflow: "hidden",
    transformOrigin: "0 0",
    transform: `translate(${left}px, ${top}px) scale(${scale})`,
  });
  const layer = (markup: string, zIndex: string): HTMLElement => {
    const element = document.createElement("div");
    Object.assign(element.style, { position: "absolute", left: "0px", top: "0px", width: `${pageWidth}px`, height: `${message.pageHeight}px`, zIndex });
    element.innerHTML = options.substitute(markup);
    stage.appendChild(element);
    return element;
  };
  // Order and stacking as the authoring interface promises: incoming beneath, outgoing above, overlay on top.
  const incoming = layer(message.incoming.markup, "");
  const outgoing = message.outgoing === null ? null : layer(message.outgoing.markup, "");
  const overlay = layer(message.bundle.markup, "3");
  overlay.style.pointerEvents = "none";
  document.body.appendChild(stage);
  return { stage, outgoing, incoming, overlay };
}

async function evaluateScript(options: Readonly<{ run: RunnerRun; runnerWindow: Window }>): Promise<TransitionDefinition> {
  const { run, runnerWindow } = options;
  let defined: TransitionDefinition | null = null;
  let thrown: string | null = null;
  const authoring: TransitionAuthoringGlobal = {
    define(candidate) {
      if (defined !== null) throw new DefineError("sashaTransition.define was called twice.");
      if (typeof candidate !== "object" || candidate === null || typeof Reflect.get(candidate, "run") !== "function") {
        throw new DefineError("sashaTransition.define needs an object with a run(context) function.");
      }
      defined = candidate;
    },
  };
  Reflect.defineProperty(runnerWindow, "sashaTransition", { value: authoring, configurable: true });
  const onError = (event: ErrorEvent): void => {
    thrown = event.message;
  };
  runnerWindow.addEventListener("error", onError);
  try {
    const address = URL.createObjectURL(new Blob([run.message.bundle.script], { type: "text/javascript" }));
    run.objectAddresses.push(address);
    await new Promise<void>((resolve, reject) => {
      const script = runnerWindow.document.createElement("script");
      script.src = address;
      script.onload = () => resolve();
      script.onerror = () => reject(new DefineError("The transition script could not be loaded."));
      runnerWindow.document.head.appendChild(script);
    });
  } finally {
    runnerWindow.removeEventListener("error", onError);
  }
  if (thrown !== null) throw new DefineError(`The transition script threw while defining itself: ${String(thrown)}`);
  if (defined === null) throw new DefineError("The transition script never called sashaTransition.define.");
  return defined;
}

async function play(options: Readonly<{ run: RunnerRun; runnerWindow: Window }>): Promise<void> {
  const { run, runnerWindow } = options;
  const message = run.message;
  // `start` is only accepted once prepare produced both (see `receive`).
  const definition = run.definition;
  const stage = run.stage;
  if (definition === null || stage === null) throw new Error("The run was started before it was prepared.");
  const context = buildTransitionContext({
    stage,
    outgoingElements: message.outgoing?.elements ?? [],
    incomingElements: message.incoming.elements,
    durationMilliseconds: message.durationMilliseconds,
    direction: message.direction,
    parameters: message.parameters,
    reducedMotion: message.reducedMotion,
    signal: run.controller.signal,
    animateNode: (node, keyframes, timing) => node.animate(keyframes, timing),
    now: () => runnerWindow.performance.now(),
    startTimer: (callback, milliseconds) => {
      const handle = runnerWindow.setTimeout(callback, milliseconds);
      return () => runnerWindow.clearTimeout(handle);
    },
  });
  await definition.run(context);
}

function endRun(options: Readonly<{ run: RunnerRun; runnerWindow: Window }>): void {
  options.run.controller.abort();
  for (const address of options.run.objectAddresses) URL.revokeObjectURL(address);
  options.run.objectAddresses.length = 0;
}

function progressOf(options: Readonly<{ run: RunnerRun; now: number }>): number {
  if (options.run.startedAt === null) return 0;
  const duration = options.run.message.durationMilliseconds;
  if (duration <= 0) return 1;
  return Math.min(1, Math.max(0, (options.now - options.run.startedAt) / duration));
}

function forwardConsole(options: Readonly<{ console: Console; log: (level: "information" | "warning" | "error", parts: readonly unknown[]) => void }>): void {
  const console = options.console;
  const levels: readonly Readonly<{ method: "log" | "info" | "warn" | "error"; level: "information" | "warning" | "error" }>[] = [
    { method: "log", level: "information" },
    { method: "info", level: "information" },
    { method: "warn", level: "warning" },
    { method: "error", level: "error" },
  ];
  for (const entry of levels) {
    const original = console[entry.method].bind(console);
    console[entry.method] = (...parts: unknown[]) => {
      original(...parts);
      options.log(entry.level, parts);
    };
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
