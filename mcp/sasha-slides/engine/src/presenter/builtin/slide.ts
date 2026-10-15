// SLIDE: "cover" moves the incoming slide in over the outgoing one, which stays put; "uncover" moves
// the outgoing slide away and reveals the incoming one beneath. Backward swaps cover and uncover
// and mirrors the direction, so going back retraces the same motion.

import type { TransitionDefinition } from "../../contracts/transition-protocol.ts";
import { allFinished, builtinTiming, modeOf, offStageFrom, offStageTowards, slideDirectionOf } from "./builtin-parameters.ts";

export const SLIDE_TRANSITION: TransitionDefinition = {
  name: "Slide",
  async run(context) {
    const timing = builtinTiming(context);
    const direction = slideDirectionOf({ parameters: context.parameters, direction: context.direction });
    const mode = modeOf({ parameters: context.parameters, direction: context.direction, modes: ["cover", "uncover"] });
    if (mode === "uncover" && context.outgoing !== null) {
      await allFinished([context.animate(context.outgoing, [{ transform: "translate(0px, 0px)" }, { transform: offStageTowards(direction) }], timing)]);
      return;
    }
    // Covering: the incoming slide must draw above the outgoing one for the whole move.
    context.incoming.style.zIndex = "2";
    await allFinished([context.animate(context.incoming, [{ transform: offStageFrom(direction) }, { transform: "translate(0px, 0px)" }], timing)]);
  },
};
