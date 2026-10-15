// THE PAGE'S `PresenterEnvironment`: Web Animations, `performance.now`, `setTimeout`, the browser
// sandbox (runner frames in the presentation's runner layer) and the callbacks of the component
// that owns the system. Built by `Presentation` and `TransitionPreview` from the window their own
// element lives in -- never a global `window` -- so a presentation rendered into another window
// would host its frames there.

import type { SlideId } from "../../contracts/ids.ts";
import type { InPageStageRegistry } from "../in-page/in-page-run-feedback.ts";
import type { PresenterEnvironment } from "../presenter-system.ts";
import { createBrowserSandboxEnvironment } from "../sandbox/sandbox-environment.ts";

export function createBrowserPresenterEnvironment(
  options: Readonly<{
    hostWindow: Window;
    runnerLayer: () => HTMLElement | null;
    stages: InPageStageRegistry;
    onExit: (lastSlideId: SlideId | null) => void;
    onPreviewEnded: () => void;
  }>,
): PresenterEnvironment {
  const hostWindow = options.hostWindow;
  return {
    sandbox: createBrowserSandboxEnvironment({ hostWindow, container: options.runnerLayer }),
    stages: options.stages,
    animateNode: (node, keyframes, timing) => node.animate(keyframes, timing),
    animationClock: () => hostWindow.performance.now(),
    startTimer: (callback, milliseconds) => {
      const handle = hostWindow.setTimeout(callback, milliseconds);
      return () => hostWindow.clearTimeout(handle);
    },
    onExit: options.onExit,
    onPreviewEnded: options.onPreviewEnded,
  };
}

/** The window an element belongs to; the presenter only ever runs mounted in a document with one. */
export function windowOf(element: Element | null): Window {
  const view = element?.ownerDocument.defaultView ?? null;
  if (view === null) throw new Error("The presenter must be mounted in a document that has a window.");
  return view;
}
