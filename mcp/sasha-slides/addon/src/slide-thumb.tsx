// ONE CANDIDATE'S THUMBNAIL in the sidebar: its own HTML, scaled into a small 16:9 box.
//
// `ScaledHtmlFrame` measures its box and scales the 1280x720 document to fit, so the same frame
// the slides window's grid uses works at 64 px wide with no constant to keep in step. The
// `.sasha-stage` wrapper is load-bearing for the same reason it is in `RevisedSlide`: the frame is
// `position:absolute; inset:0`, so it needs a positioned 16:9 ancestor or it escapes to the top of
// the document.
//
// Every arm of `SlidePreview` is a box of the same size, so a row never jumps when its picture
// lands; a failure carries its reason on hover instead of a spinner that cannot end.

import type { JSX } from "react";
import { assertNever } from "./protocol.ts";
import { ScaledHtmlFrame } from "./scaled-frame.tsx";
import type { SlidePreview } from "./slide-previews.ts";

export function SlideThumb({ preview, title }: { preview: SlidePreview; title: string }): JSX.Element {
  switch (preview.kind) {
    case "ready":
      return (
        <span className="sasha-stage sasha-thumb">
          <ScaledHtmlFrame html={preview.html} title={title} />
        </span>
      );
    case "loading":
      return <span className="sasha-stage sasha-thumb sasha-thumb-wait" role="img" aria-label={`${title}, loading`} />;
    case "unavailable":
      return (
        <span
          className="sasha-stage sasha-thumb sasha-thumb-none"
          role="img"
          aria-label={`${title}, no preview`}
          title={`no preview: ${preview.message}`}
        />
      );
    default:
      return assertNever(preview);
  }
}
