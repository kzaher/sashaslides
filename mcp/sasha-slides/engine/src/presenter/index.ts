// THE PRESENTER MODULE'S SURFACE (contracts/module-surfaces.ts `PresenterModule`): the slideshow and
// the transition preview, plus what a caller needs around them -- the event the control bar's
// speaker view button bubbles (the caller opens the window), the built-in definitions and the
// documented ink-wipe example for the script dialog's authoring reference.
//
// Everything is built against the contracts only; the RxFeedback toolkit, the renderer and the
// asset store arrive in `PresenterDependencies`.

export { Presentation } from "./view/presentation.tsx";
export { TransitionPreview } from "./view/transition-preview.tsx";
export { BuildPreview } from "./view/build-preview.tsx";
export { BUILTIN_TRANSITIONS } from "./builtin/builtin-transitions.ts";
export { INK_WIPE_EXAMPLE_SCRIPT } from "./examples/ink-wipe.ts";
