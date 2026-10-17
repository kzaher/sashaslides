// WHAT THE ANIMATE TAB DRAWS ON THE CANVAS: the numbered badges on animated elements, and the
// build preview laid exactly over the slide. Both live inside the slide frame, so they share its
// origin and scale with the selection overlay (canvas-overlay.tsx) and need no layout read.
//
// Key decisions:
//
//  * BADGES ONLY WHILE THE ANIMATE TAB IS OPEN, at each element's top-left corner (rotated bounds),
//    in client pixels so they stay legible at every zoom. A badge shows every position its element
//    holds in the sequence ("1, 3"); a step whose element is gone has nothing to sit on and shows
//    only in the tab's list.
//  * THE PREVIEW IS THE PRESENTER'S (`BuildPreview`, injected as a service), keyed by its
//    generation so "Preview" again restarts it from the first build. Reduced motion is the
//    presenter's to honour; this layer only places it and reports its end.

import { memo, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DocumentSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { PropertiesTab } from "../../contracts/editor-state.ts";
import { rotatedBounds } from "../../contracts/geometry.ts";
import type { SlideId } from "../../contracts/ids.ts";
import { useEditorServices } from "../application/editor-services.tsx";
import { findInTree } from "../../shared/element-tree.ts";
import { animationBadges } from "../chrome/animate-values.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";

export const AnimationBadgeLayer = memo(function AnimationBadgeLayer(properties: Readonly<{ slide: SlideSnapshot; scale: number }>): ReactElement | null {
  const badges = animationBadges(properties.slide);
  if (badges.size === 0) return null;
  return (
    <div className={VIEW_CLASS.overlay} data-animation-badges="true">
      {[...badges].map(([elementId, positions]) => {
        const element = findInTree(properties.slide.elements, elementId);
        if (element === null) return null;
        const bounds = rotatedBounds(element.frame);
        return (
          <span key={elementId} className={VIEW_CLASS.animationBadge} role="img" aria-label={`Animation ${positions}`} data-badge-element={elementId} style={{ left: bounds.x * properties.scale, top: bounds.y * properties.scale }}>
            {positions}
          </span>
        );
      })}
    </div>
  );
});

/** True while the properties panel shows the Animate tab (the comment rail replaces the panel when open). */
export function animateTabShowing(chrome: Readonly<{ propertiesTab: PropertiesTab; propertiesPanelOpen: boolean; commentsOpen: boolean }>): boolean {
  if (chrome.commentsOpen || !chrome.propertiesPanelOpen) return false;
  switch (chrome.propertiesTab) {
    case "animate":
      return true;
    case "arrange":
    case "fill":
    case "border":
    case "effects":
    case "text":
    case "slide":
    case "transition":
      return false;
    default:
      return assertNever(chrome.propertiesTab);
  }
}

/** The slide's builds playing over the canvas, the slide frame's exact size. */
export function BuildPreviewLayer(properties: Readonly<{ document: DocumentSnapshot; slideId: SlideId; generation: number; width: number; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const services = useEditorServices();
  const Preview = services.BuildPreview;
  return (
    <div className={VIEW_CLASS.buildPreviewLayer} data-build-preview={properties.generation}>
      <Preview
        key={properties.generation}
        dependencies={services.presenterDependencies}
        document={properties.document}
        slideId={properties.slideId}
        generation={properties.generation}
        width={properties.width}
        onEnded={() => properties.dispatch({ kind: "buildPreviewEnded" })}
      />
    </div>
  );
}
