// THE PAGE-FACING HALF OF THE SANDBOX, behind a small interface: creating the runner frame,
// hearing the host window's messages, and opening a private channel. The sandbox feedback codes
// against `SandboxEnvironment`; the browser implementation below is the only code that touches
// iframes and `MessageChannel`, and the lifecycle tests substitute a fake with a scripted runner.
//
// THE FRAME'S ATTRIBUTES ARE THE SECURITY BOUNDARY (transition-protocol.ts header) and are a
// constant here, set before the frame is attached or given an address:
//
//  * `sandbox="allow-scripts"` and nothing else: an opaque origin, never `allow-same-origin`;
//  * `allow=""`: no powerful features;
//  * `referrerpolicy="no-referrer"`;
//  * `inert`: no focus and no pointer input, so no captured keystrokes and nothing clickable.
//
// Load events are counted from the moment the address is set, so the first `load` is the runner
// page and a second is the frame navigating itself (`runnerNavigated`).

import { Observable, Subject, fromEvent, map } from "rxjs";
import type { RunnerId } from "../../contracts/ids.ts";
import type { HostConnect, HostToRunnerMessage } from "../../contracts/transition-protocol.ts";

/** A `message` event on the host window, reduced to what the handshake checks. */
export type WindowMessage = Readonly<{ source: unknown; origin: string; data: unknown }>;

export interface RunnerFrame extends Disposable {
  /** The frame's window, compared by identity with a message's `source`. */
  readonly window: unknown;
  /** Each `load` event of the frame. */
  readonly loads: Observable<void>;
  /** Posts `connect` with the runner's end of the channel; the target origin is "*" because the runner's is opaque. */
  connect(message: HostConnect, runnerPort: Transferable): void;
  /** The frame is visible only from `started` until the run ends (SPEC.md section 11). */
  setShown(shown: boolean): void;
}

export interface HostPort extends Disposable {
  /** Raw message data, parsed by the caller. */
  readonly messages: Observable<unknown>;
  post(message: HostToRunnerMessage, transfer: readonly Transferable[]): void;
}

export type SandboxEnvironment = Readonly<{
  createRunnerFrame: (request: Readonly<{ runnerId: RunnerId; address: string }>) => RunnerFrame;
  windowMessages: Observable<WindowMessage>;
  createChannel: () => Readonly<{ hostPort: HostPort; runnerPort: Transferable }>;
}>;

/** Every attribute the runner frame gets, exactly (see the header). */
export const RUNNER_FRAME_ATTRIBUTES: Readonly<Record<string, string>> = {
  sandbox: "allow-scripts",
  allow: "",
  referrerpolicy: "no-referrer",
  inert: "",
  "aria-hidden": "true",
  tabindex: "-1",
  title: "Slide transition",
};

export const RUNNER_FRAME_CLASS = "sasha-runner-frame";
export const RUNNER_ID_ATTRIBUTE = "data-runner-id";
export const RUNNER_SHOWN_ATTRIBUTE = "data-shown";

/**
 * The browser implementation. `container` is the presentation's runner layer (frames are
 * positioned over the slide); before it exists, frames wait in a hidden holder on the body.
 */
export function createBrowserSandboxEnvironment(options: Readonly<{ hostWindow: Window; container: () => HTMLElement | null }>): SandboxEnvironment {
  return {
    createRunnerFrame: (request) => createRunnerFrameElement({ ...options, ...request }),
    windowMessages: fromEvent<MessageEvent>(options.hostWindow, "message").pipe(
      map((event): WindowMessage => ({ source: event.source, origin: event.origin, data: event.data })),
    ),
    createChannel: () => {
      const channel = new MessageChannel();
      return { hostPort: hostPortOf(channel.port1), runnerPort: channel.port2 };
    },
  };
}

function createRunnerFrameElement(
  options: Readonly<{ hostWindow: Window; container: () => HTMLElement | null; runnerId: RunnerId; address: string }>,
): RunnerFrame {
  const document = options.hostWindow.document;
  const frame = document.createElement("iframe");
  for (const [name, value] of Object.entries(RUNNER_FRAME_ATTRIBUTES)) frame.setAttribute(name, value);
  frame.className = RUNNER_FRAME_CLASS;
  frame.setAttribute(RUNNER_ID_ATTRIBUTE, options.runnerId);
  frame.setAttribute(RUNNER_SHOWN_ATTRIBUTE, "false");
  const loads = new Subject<void>();
  const onLoad = (): void => loads.next();
  frame.addEventListener("load", onLoad);
  (options.container() ?? document.body).appendChild(frame);
  frame.src = options.address;
  return {
    window: frame.contentWindow,
    loads: loads.asObservable(),
    connect(message, runnerPort) {
      frame.contentWindow?.postMessage(message, "*", [runnerPort]);
    },
    setShown(shown) {
      frame.setAttribute(RUNNER_SHOWN_ATTRIBUTE, shown ? "true" : "false");
    },
    [Symbol.dispose]() {
      frame.removeEventListener("load", onLoad);
      loads.complete();
      frame.remove();
    },
  };
}

function hostPortOf(port: MessagePort): HostPort {
  const messages = new Subject<unknown>();
  const onMessage = (event: MessageEvent): void => messages.next(event.data);
  // A message that cannot be deserialised still counts as a rejected message.
  const onMessageError = (): void => messages.next({ deserialisationFailed: true });
  port.addEventListener("message", onMessage);
  port.addEventListener("messageerror", onMessageError);
  port.start();
  return {
    messages: messages.asObservable(),
    post(message, transfer) {
      port.postMessage(message, [...transfer]);
    },
    [Symbol.dispose]() {
      port.removeEventListener("message", onMessage);
      port.removeEventListener("messageerror", onMessageError);
      port.close();
      messages.complete();
    },
  };
}
