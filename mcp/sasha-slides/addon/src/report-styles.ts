// THE DEFECT REPORT'S OWN RULES (Report.html: anonymise, review, send -- Defect.tsx). Layered
// after base-styles.ts and window-styles.ts (src/surface-stylesheets.ts); minified by
// build-addon.ts.

export const REPORT_CSS = `
.sasha-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.sasha-actions .sasha-dim { margin-right: auto; }

.sasha-comment-text { flex: 1 1 auto; min-width: 0; font-size: 12px; padding: 4px 6px; border: 1px solid #dadce0; border-radius: 4px; resize: vertical; }

/* ---------------------------------------------------------------------------
   ANONYMISE AND REPORT A DEFECT (Defect.tsx).

   THE TWO SLIDES ARE THE SURFACE. "Both rendered, both visual" is a pair of 16:9 stages side by
   side, and it is the reason this flow lives in a 1100px window rather than the 300px sidebar: at
   300px the two stages would stack and stop being a comparison.

   THERE IS NO RUN TABLE ANY MORE -- the three-column before/after grid and its sasha-run-* rules
   are gone with it (Defect.tsx). What replaced them is a numbered PIN on the slide a note is
   about plus a numbered card below, so a verdict is read against the picture it is a verdict on.
   --------------------------------------------------------------------------- */
.sasha-report {
  display: flex; flex-direction: column; gap: 12px;
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
}
.sasha-policy { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.sasha-policy .sasha-dim { margin: 0; line-height: 1.5; }
.sasha-titlefield { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.sasha-titlefield label { flex: 1 1 100%; }
.sasha-titleinput { font: inherit; padding: 4px 6px; border: 1px solid #dadce0; border-radius: 4px; flex: 1 1 320px; min-width: 0; }

/* --- THE PAIR: two slides, side by side ------------------------------------------------------
   minmax(0, 1fr) and not 1fr: a 1fr track takes its min-content from the 1280px-wide iframe inside
   it and would overflow the window -- the same trap the grid's columns have. A single-slide view is
   one track, so the stage simply grows into the width the pair was sharing. */
.sasha-pair { display: grid; gap: 12px; align-items: start; }
.sasha-pair-pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sasha-pair-as-is, .sasha-pair-as-sent { grid-template-columns: minmax(0, 1fr); }
.sasha-pane-side { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sasha-pane-cap { display: flex; flex-direction: column; gap: 2px; }
/* The slide, then its margin. The gutter track is auto so it takes exactly the pins' width and the
   stage keeps the rest; minmax(0, 1fr) because the 1280px iframe inside would otherwise set the
   track's min-content and overflow the window. */
.sasha-pane-body { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: start; }
/* The two slides are NOT interchangeable and must not look it: the one on the right is the one
   whose bytes leave the browser, so it carries the warning colour and the one on the left does
   not. A reader glancing at the pair has to know which is which without reading the captions. */
.sasha-pane-source > .sasha-pane-stage { border-color: #dadce0; }
.sasha-pane-sent > .sasha-pane-stage { border-color: #e37400; border-width: 2px; }
.sasha-pane-sent .sasha-pane-cap strong { color: #b06000; }
.sasha-pane-edits { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; }
.sasha-pane-edits .sasha-edits { flex: 1 1 100%; }

/* --- THE PINS: a numbered note, on the slide it is about ------------------------------------
   A text run is a POSITION IN A TOKEN STREAM, not a box on the slide, so nothing here knows where
   on the picture a verdict belongs. Pretending to know -- dropping a marker at a coordinate nothing
   measured -- would be a worse lie than the table was. So the pins sit in a MARGIN beside the slide
   and carry NUMBERS, and the numbers are what tie them to the cards below. Only a leak or a risk
   gets a pin (annotationIsPinned): a dozen grey dots for a dozen residual-risk sentences said
   nothing about where anything was and buried the one pin that meant "look at this". */
.sasha-pins { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sasha-pin { min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; background: #5f6368; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.sasha-pin-leak { background: #c5221f; }
.sasha-pin-risk { background: #e37400; }
.sasha-pin-note { background: #5f6368; }
.sasha-annots { display: flex; flex-direction: column; gap: 6px; }
.sasha-annots > strong { font-size: 12px; }
.sasha-annot-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sasha-annot { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; border-left: 3px solid #dadce0; padding-left: 8px; }
.sasha-annot-leak { border-left-color: #c5221f; background: #fce8e6; }
.sasha-annot-risk { border-left-color: #e37400; background: #fef7e0; }
.sasha-annot-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sasha-annot-body strong { font-weight: 600; }
.sasha-annot-body span { line-height: 1.45; overflow-wrap: anywhere; }
.sasha-carriers { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; }

/* THE RESIDUAL RISKS ARE NOT CLIPPED, NOT SCROLLED AND NOT SUMMARISED -- see .sasha-annots above,
   which is where they live now. Three earlier attempts at a bounded box with its own scrollbar all
   read, to two independent screenshot reviews, as a panel whose last sentence had been sliced
   through the glyphs: Chrome draws an OVERLAY scrollbar that is simply absent from a rendered
   frame, and styling ::-webkit-scrollbar did not opt the element out of it in headless. So the
   annotation list has no height bound at all, and the report panel is the one scroller
   (.sasha-report). A disclosure the user has to discover a scroll gesture to finish reading is not
   a disclosure. */
.sasha-sendbar { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #e8eaed; padding-top: 8px; }
.sasha-endpoint { font: inherit; padding: 4px 6px; border: 1px solid #dadce0; border-radius: 4px; width: 100%; }
`;
