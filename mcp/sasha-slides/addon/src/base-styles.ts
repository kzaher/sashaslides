// THE RULES EVERY SURFACE USES: the page, the shell, the header, the tabs, the buttons and the 16:9
// stage a slide is scaled into. Nothing else belongs here.
//
// ONE SHEET PER SURFACE ON TOP OF THIS ONE. The slides dialog, the defect report and the Ask Sasha
// sidebar are separate HtmlService documents that share nothing at runtime (UI-CONTRACT.md), and
// each inlined one stylesheet for all three until 2026-10-17 -- 8 KB of rules on Dialog.html, 15 KB
// on Report.html and 14 KB on Sidebar.html that nothing in that page could match. Each surface now
// renders the sheets src/surface-stylesheets.ts lists for it, this one first.
//
// A RULE GOES HERE ONLY WHEN ALL THREE SURFACES USE IT. A rule the two wide windows share goes in
// window-styles.ts; one surface's rule goes in its own sheet. surface-stylesheets.test.ts bundles
// each surface and fails both ways: when a class its code uses lost its rules, and when it ships a
// rule nothing in it can match.
//
// The original stylesheet was written for the sidebar of the extension, where `.sasha-shell` was a
// floating panel in a shadow root; an HtmlService page is its own document, so the shell is a plain
// block that fills it. build-addon.ts minifies every sheet at bundle time.

export const BASE_CSS = `
* { box-sizing: border-box; font-family: Roboto, Arial, sans-serif; }
html, body { margin: 0; padding: 0; background: #fff; }
.sasha-shell {
  display: block; width: 100%;
  color: #202124; background: #fff;
  padding: 10px 12px 16px;
  font-size: 13px;
}
.sasha-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; font-size: 13px; }
.sasha-dim { color: #5f6368; font-size: 12px; }
.sasha-trouble { color: #c5221f; font-size: 12px; margin: 0; }
.sasha-tab {
  cursor: pointer; border: 1px solid #dadce0; background: #fff;
  border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
.sasha-tab-on { border-color: #1a73e8; color: #1a73e8; font-weight: 600; }
/* 16:9, so the 1280x720 document and the 720x405pt page are the same box on screen. */
.sasha-stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #f1f3f4; border: 1px solid #dadce0; overflow: hidden; }
/* The HTML pane is a real 1280x720 document, so it is SCALED into the stage, not clipped. The
   SCALE IS AN INLINE STYLE, not a constant here: a dialog's width is a request the browser window
   clamps and the grid reflows between two columns and one, so scaled-frame.tsx measures the box and
   renders the transform. Only the things that do not depend on the measurement live here. */
.sasha-scaled { position: absolute; inset: 0; overflow: hidden; }
.sasha-frame { position: absolute; left: 0; top: 0; border: 0; transform-origin: top left; }
.sasha-primary { cursor: pointer; border: 0; border-radius: 6px; background: #1a73e8; color: #fff; padding: 7px 14px; font-size: 13px; font-weight: 600; }
.sasha-secondary { cursor: pointer; border: 1px solid #dadce0; border-radius: 6px; background: #fff; padding: 7px 14px; font-size: 13px; }
.sasha-primary:disabled, .sasha-secondary:disabled { opacity: .5; cursor: default; }
.sasha-small { padding: 3px 8px; font-size: 12px; }
/* The spinner may not change the header's height (it used to push Refresh to a second row). */
.sasha-header { position: relative; }
@keyframes sashaSpin { to { transform: rotate(360deg); } }
`;
