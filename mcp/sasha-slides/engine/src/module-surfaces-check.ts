// COMPILE-TIME PROOF THAT THE FOUR MODULES COMPOSE. Each module's index.ts must export its whole
// surface (contracts/module-surfaces.ts); a missing or mistyped export fails `npm run typecheck`
// here, at the architect's boundary, instead of in whichever module happens to import it first.
// Owned by the architect; nothing imports it.

import type { ModelModule, PresenterModule, StateModule, ViewModule } from "./contracts/index.ts";
import * as model from "./model/index.ts";
import * as presenter from "./presenter/index.ts";
import * as state from "./state/index.ts";
import * as view from "./view/index.ts";

export const MODULE_SURFACES: Readonly<{ model: ModelModule; state: StateModule; view: ViewModule; presenter: PresenterModule }> = {
  model,
  state,
  view,
  presenter,
};
