// THE TWO WIDE WINDOWS' RULES: the slides dialog and the defect report, both modal dialogs about
// 1100 px wide, and never the 300 px sidebar. Layered after base-styles.ts and before the window's
// own sheet (src/surface-stylesheets.ts); minified by build-addon.ts.

export const WINDOW_CSS = `
.sasha-busy { color: #1a73e8; font-size: 12px; }
.sasha-settled { font-size: 13px; margin: 0; }
.sasha-toggle { display: flex; gap: 4px; }
.sasha-placeholder { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; }

/* --- the dialog: a roomy window, not a 300px column -------------------------------------
   setWidth/setHeight are a REQUEST the browser window clamps, so nothing below assumes it got
   the size it asked for: the shell is a full-height flex column whose GRID is the part that
   scrolls, so a clamped dialog loses scroll position rather than losing the footer. */
.sasha-shell-wide { padding: 10px 14px 12px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

/* --- the toolbar: VIEW and TOOL side by side, because they are independent ------------------
   Three labelled groups on one wrapping row (Picker.tsx). They are deliberately NOT one row of
   four buttons: grid / single / edit / annotate as a single group reads as a four-way mode, which
   is exactly the confusion two independent fields exist to remove. */
.sasha-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.sasha-toggle-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #5f6368; align-self: center; margin-right: 2px; }
/* THE ONE INSTRUCTION THE GRID GIVES, and it is not dim. It tells the user that the pictures are
   the control -- without it a slide looks like a thumbnail, and nobody clicks a thumbnail. */
.sasha-toolbar-say { flex: 1 1 200px; min-width: 0; font-size: 13px; font-weight: 600; color: #202124; }
/* BOUNDED, because the tool panel is a FIXED-HEIGHT sibling of the workspace now: the dialog hides
   its overflow and only the workspace scrolls, so an unbounded edit list would push the
   report bar and the Insert button out of the clipped shell (overflow is hidden there, so what does
   not fit is simply gone). The HEADER and the prose above it stay put; it is only the list that
   scrolls, which is the one part a reader can leave half-read without losing anything -- unlike the
   risk disclosure, see .sasha-annots. */
.sasha-edits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; max-height: 24vh; overflow-y: auto; }
.sasha-edit { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #202124; }
`;
