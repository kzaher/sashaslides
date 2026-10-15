// FADE: the outgoing slide (on top) dissolves to reveal the incoming one beneath; from black, the
// incoming slide fades in. Also what the host plays as its substituted fade (150 milliseconds,
// linear) under reduced motion or for an unapproved or missing script.

import type { TransitionDefinition } from "../../contracts/transition-protocol.ts";
import { allFinished, builtinTiming } from "./builtin-parameters.ts";

export const FADE_TRANSITION: TransitionDefinition = {
  name: "Fade",
  async run(context) {
    const timing = builtinTiming(context);
    if (context.outgoing === null) {
      await allFinished([context.animate(context.incoming, [{ opacity: 0 }, { opacity: 1 }], timing)]);
      return;
    }
    await allFinished([context.animate(context.outgoing, [{ opacity: 1 }, { opacity: 0 }], timing)]);
  },
};
