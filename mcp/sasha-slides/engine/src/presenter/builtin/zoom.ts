// ZOOM: "in" grows the incoming slide from the centre over the outgoing one while it fades in;
// "out" shrinks and fades the outgoing slide away to reveal the incoming one. Backward swaps them.

import type { TransitionDefinition } from "../../contracts/transition-protocol.ts";
import { allFinished, builtinTiming, modeOf } from "./builtin-parameters.ts";

/** How small a zooming slide is at its far end. */
export const ZOOM_FAR_SCALE = 0.6;

export const ZOOM_TRANSITION: TransitionDefinition = {
  name: "Zoom",
  async run(context) {
    const timing = builtinTiming(context);
    const mode = modeOf({ parameters: context.parameters, direction: context.direction, modes: ["in", "out"] });
    if (mode === "out" && context.outgoing !== null) {
      await allFinished([
        context.animate(context.outgoing, [{ transform: "scale(1)", opacity: 1 }, { transform: `scale(${ZOOM_FAR_SCALE})`, opacity: 0 }], timing),
      ]);
      return;
    }
    context.incoming.style.zIndex = "2";
    await allFinished([
      context.animate(context.incoming, [{ transform: `scale(${ZOOM_FAR_SCALE})`, opacity: 0 }, { transform: "scale(1)", opacity: 1 }], timing),
    ]);
  },
};
