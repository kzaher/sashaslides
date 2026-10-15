// THE LIVELY GROUND's shapes: five empty spans the shared stylesheet turns into drifting, morphing
// pastel blobs (tidepool-stylesheet.ts `livelyGround`). Only for screens with nothing to edit -- the
// deck list, an empty deck, the presenter's end screen -- never behind a slide being edited. A
// component of its own so the view and the presenter render the same markup.

import type { ReactElement } from "react";
import { TIDEPOOL_CLASS } from "./tidepool-stylesheet.ts";

export function LivelyShapes(): ReactElement {
  return (
    <div className={TIDEPOOL_CLASS.livelyGround} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
