// THE FIVE BUILT-IN TRANSITIONS, keyed by effect (transition-protocol.ts `BuiltinTransitionDefinitions`):
// our own TypeScript `TransitionDefinition`s, run by the in-page host with Web Animations on two
// rendered slides, and runnable unchanged in the sandboxed runner because they only use the
// `TransitionContext` a script gets. The host's substituted fade is the fade definition at 150
// milliseconds, linear.

import type { BuiltinTransitionDefinitions } from "../../contracts/transition-protocol.ts";
import { FADE_TRANSITION } from "./fade.ts";
import { MORPH_TRANSITION } from "./morph.ts";
import { PUSH_TRANSITION } from "./push.ts";
import { SLIDE_TRANSITION } from "./slide.ts";
import { ZOOM_TRANSITION } from "./zoom.ts";

export const BUILTIN_TRANSITIONS: BuiltinTransitionDefinitions = {
  fade: FADE_TRANSITION,
  push: PUSH_TRANSITION,
  slide: SLIDE_TRANSITION,
  zoom: ZOOM_TRANSITION,
  morph: MORPH_TRANSITION,
};

/** The parameters of the host's own fade. */
export const SUBSTITUTED_FADE_PARAMETERS = { easing: "linear" } as const;
