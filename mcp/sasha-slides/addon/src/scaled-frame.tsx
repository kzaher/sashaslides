// A candidate's own HTML, rendered at its real 1280x720 and SCALED to whatever box it is given.
//
// WHY THIS FILE EXISTS. The sidebar could scale by a constant: an HtmlService sidebar is a fixed
// 300 px wide, so `transform: scale(0.214)` was exact (picker-styles.ts). A DIALOG cannot --
// `setWidth`/`setHeight` are a REQUEST that the browser window clamps, so the cell width is only
// known at runtime, and it changes again every time the grid reflows between two and one column.
// A constant would either crop the document or leave half the cell empty.
//
// So the scale is MEASURED and kept in React state: the component re-renders with a new transform
// rather than an effect writing `element.style.transform` behind React's back (typescript skill,
// "Render from state; don't mutate DOM"). The ref is the escape hatch for the one thing React
// cannot own -- the element's own laid-out width.
//
// NEVER A SCREENSHOT. UI-CONTRACT.md: "Each cell renders the candidate's own HTML in an iframe,
// scaled down, never a screenshot -- the HTML is authoritative and a thumbnail would lie."

import { useCallback, useEffect, useRef, useState, type JSX } from "react";

/** The staged document's own size. PROTOCOL.md: a candidate is a self-contained 1280x720 page. */
export const SLIDE_WIDTH_PX = 1280;
export const SLIDE_HEIGHT_PX = 720;

/**
 * What to scale by before the box has been measured -- on the server (`react-dom/server` has no
 * layout) and on the very first client paint. The old sidebar constant, so a frame that never gets
 * measured still shows the whole document rather than the top-left corner of it.
 */
export const UNMEASURED_SCALE = 0.214;

export function ScaledHtmlFrame({
  html,
  title,
  onFrame,
  editable,
}: {
  html: string;
  title: string;
  /**
   * The iframe element, as soon as it exists and again as null when it goes away. The ANNOTATION
   * view needs it to hand to the visual editor (UI-CONTRACT.md: "the host supplies the iframe");
   * the grid does not pass this at all, so a cell never attaches an editor.
   */
  onFrame?: (frame: HTMLIFrameElement | null) => void;
  /**
   * Grants `sandbox="allow-same-origin"` so the visual editor can reach `contentDocument`.
   *
   * Explicit, and default-off, because it is the one security-relevant attribute here. Note
   * what is NOT granted with it: `allow-scripts` stays off, so the candidate still executes
   * nothing — same-origin without scripts cannot reach the host. Only the annotation pane
   * asks for this; grid cells stay in the strictest box.
   */
  editable?: boolean;
}): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number>(UNMEASURED_SCALE);

  const measure = useCallback(() => {
    const element = box.current;
    if (element === null) return;
    const width = element.clientWidth;
    // A box with no width yet (hidden, or mid-reflow) must not latch a scale of 0: keeping the
    // last good one means the frame is never invisible, which is the failure this guard exists for.
    if (width <= 0) return;
    setScale(width / SLIDE_WIDTH_PX);
  }, []);

  useEffect(() => {
    measure();
    const element = box.current;
    // ResizeObserver is in every browser that can run Slides, but it is read defensively because
    // the fallback is correct: without it the frame keeps the scale measured on mount.
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="sasha-scaled" ref={box}>
      {/*
        An EMPTY `sandbox` gives the document no scripts, no same-origin access and no form
        submission -- it is staged HTML of unknown provenance rendered inside the user's logged-in
        Google session, so it gets the strictest box available. A visual editor that needs to reach
        into this document needs `allow-same-origin`, which is the editor module's call to make and
        is deliberately NOT granted here.

        `scrolling="no"` suppresses the STAGED DOCUMENT's own scrollbars. The frame is laid out at
        exactly 1280x720 and a candidate declares the same, but one whose content spills a pixel
        renders a real scrollbar INSIDE the iframe, and `overflow:hidden` on the box outside it
        cannot reach in. Measured in the browser smoke test: every grid cell had a vertical and a
        horizontal bar down its edges, which reads as "the slide did not scale". The attribute is
        deprecated in HTML5 and is still the only thing that crosses that boundary.
      */}
      <iframe
        className="sasha-frame"
        title={title}
        sandbox={editable === true ? "allow-same-origin" : ""}
        referrerPolicy="no-referrer"
        srcDoc={html}
        scrolling="no"
        style={frameStyle(scale)}
        ref={(element) => {
          // A block body on purpose: React 19 treats a value RETURNED from a ref callback as the
          // cleanup function, and `onFrame`'s own return value is not one.
          if (onFrame !== undefined) onFrame(element);
        }}
      />
    </div>
  );
}

/** The transform that maps the 1280x720 document onto a box of the measured width. */
export function frameStyle(scale: number): Readonly<{
  width: string;
  height: string;
  transform: string;
}> {
  return {
    width: `${SLIDE_WIDTH_PX}px`,
    height: `${SLIDE_HEIGHT_PX}px`,
    transform: `scale(${scale})`,
  };
}
