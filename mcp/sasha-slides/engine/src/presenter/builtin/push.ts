// PUSH: the incoming slide enters from one edge and pushes the outgoing slide out of the opposite
// edge, both moving together. Backward mirrors the direction (builtin-parameters.ts header).

import type { TransitionDefinition } from "../../contracts/transition-protocol.ts";
import { allFinished, builtinTiming, offStageFrom, offStageTowards, slideDirectionOf } from "./builtin-parameters.ts";

export const PUSH_TRANSITION: TransitionDefinition = {
  name: "Push",
  async run(context) {
    const timing = builtinTiming(context);
    const direction = slideDirectionOf({ parameters: context.parameters, direction: context.direction });
    const animations = [context.animate(context.incoming, [{ transform: offStageFrom(direction) }, { transform: "translate(0px, 0px)" }], timing)];
    if (context.outgoing !== null) {
      animations.push(context.animate(context.outgoing, [{ transform: "translate(0px, 0px)" }, { transform: offStageTowards(direction) }], timing));
    }
    await allFinished(animations);
  },
};
