// "END OF PRESENTATION": the one presenter screen with nothing to edit or watch, so it gets the
// lively ground -- Tidepool's drifting pastel shapes (src/theme/lively-shapes.tsx) -- under a glass
// card, as the sidebar and the website's home screens do. Next (or a click) exits; previous goes
// back to the last slide.

import type { ReactElement } from "react";
import { LivelyShapes } from "../../theme/lively-shapes.tsx";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { PRESENTER_CLASS } from "./presenter-stylesheet.ts";

export function EndScreen(): ReactElement {
  return (
    <div className={PRESENTER_CLASS.endScreen} role="status">
      <LivelyShapes />
      <div className={`${TIDEPOOL_CLASS.livelyCard} ${PRESENTER_CLASS.endCard}`}>
        <h1>End of presentation</h1>
        <p className={TIDEPOOL_CLASS.muted}>Click or press → to exit. Press ← to go back to the last slide.</p>
      </div>
    </div>
  );
}
