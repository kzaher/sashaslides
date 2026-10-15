// THE RxFeedback TOOLKIT for the presenter's own tests and its Chrome drivers. The presenter's
// shipped code never imports the state module (contracts/presenter.ts header: the toolkit is
// injected by the composition root); its tests take the state module's real core here, so they run
// on exactly the loop the editor runs -- two-queue mailbox, synchronous publication, contained
// reducer and feedback errors -- rather than on a second copy that could drift from it.

import type { RxFeedbackToolkit } from "../../contracts/presenter.ts";
import { createSystem, react, reactSet } from "../../state/index.ts";

export const testRxFeedbackToolkit: RxFeedbackToolkit = { createSystem, react, reactSet };
