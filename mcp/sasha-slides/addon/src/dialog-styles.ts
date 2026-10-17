// THE SLIDES DIALOG'S OWN RULES (Dialog.html: the candidate grid, the mark-up view, the editor
// window and its element inspector). Layered after base-styles.ts and window-styles.ts and before
// the calm Tidepool look (src/surface-stylesheets.ts). Dialog.html is the surface nearest its
// 500 KB budget, so a rule only the sidebar or the report uses must not land here --
// surface-stylesheets.test.ts fails when one does. build-addon.ts minifies it at bundle time.

export const DIALOG_CSS = `
/* Always worn with .sasha-dim (Picker.tsx), whose 12px it keeps: base-styles.ts now comes first, so
   a font-size here would win where it used to lose. */
.sasha-diag { font-family: ui-monospace, Menlo, monospace; margin-top: 6px; opacity: .85; user-select: all; }

.sasha-idle { display: flex; flex-direction: column; gap: 10px; padding: 18px 4px; }
.sasha-idle strong { font-size: 15px; }
.sasha-idle .sasha-dim { margin: 0; line-height: 1.5; }
/* A LOADER: the only honest thing a window that is waiting can show. */
.sasha-loader { display: flex; align-items: center; justify-content: center; padding: 56px 0; margin: 0; }
.sasha-loader-ring { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #dadce0; border-top-color: #1a73e8; animation: sashaSpin .8s linear infinite; }
@media (prefers-reduced-motion: reduce){ .sasha-loader-ring { animation: none; border-top-color: #dadce0; } }
/* position:relative is LOAD-BEARING: the editor window is a scrim with inset:0, and without a
   positioned ancestor it would resolve against the initial containing block and escape the
   dialog entirely. */
.sasha-dialog { position: relative; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
/* Google's own PNG of the candidate, filling the 16:9 stage exactly as the HTML frame does. */
.sasha-render { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; background: #fff; }
/* The fallback projection says what it is, across the bottom, so a diagram is never mistaken for
   the rendering -- that mistake was read as "the converter is broken" when it had not run. */
.sasha-projection-note { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; padding: 3px 6px; font-size: 10px; line-height: 1.3; color: #5f6368; background: rgba(255,255,255,.92); border-top: 1px solid #e8eaed; }
.sasha-rendered { position: absolute; inset: 0; background: #fff; }
.sasha-el { position: absolute; border: 1px solid #9aa0a6; overflow: hidden; font-size: 9px; line-height: 1.1; padding: 1px 2px; }
.sasha-el-shape { border-color: #1a73e8; background: rgba(26,115,232,.06); }
.sasha-el-table { border-color: #188038; background: rgba(24,128,56,.06); }
.sasha-el-image { border-color: #e37400; background: rgba(227,116,0,.08); }
.sasha-el-line { border-color: #5f6368; }
.sasha-el-video { border-color: #9334e6; }
.sasha-el-unknown { border-style: dashed; }
.sasha-el-text { display: block; overflow: hidden; }
.sasha-marks { position: absolute; inset: 0; pointer-events: none; }
.sasha-overlay { position: absolute; inset: 0; cursor: crosshair; }
.sasha-overlay-off { cursor: default; }
.sasha-mark { position: absolute; pointer-events: none; }
.sasha-mark-user { border: 2px solid #c5221f; background: rgba(197,34,31,.12); }
.sasha-mark-converter { border: 2px dashed #e37400; background: rgba(227,116,0,.12); }
.sasha-mark-drag { border: 2px dotted #202124; background: rgba(32,33,36,.08); }
/* 32vh: a mark-up
   row is TWO lines now, so the one-line sizing clipped the second row mid-glyph with only two
   mark-ups on screen. padding-right keeps the remove button off the scrollbar when it does scroll.
   The browser smoke test asserts the last row is fully inside this box, so the split is measured
   rather than eyeballed. */
.sasha-anomalies { list-style: none; margin: 0; padding: 0 6px 0 0; display: flex; flex-direction: column; gap: 8px; max-height: 32vh; overflow-y: auto; font-size: 13px; }
.sasha-anomaly { display: block; }

/* --- THE COMMENT CARD (comment-card.tsx) ------------------------------------------------
   The measurements are read off a real Google Slides comment card, so a mark-up in the slides
   window sits next to Google's own comment pane without looking like a different product: a 12 px white card with a soft shadow, a 28 px round
   avatar carrying one initial, the author in 500 weight with the time under it in grey, and
   the BODY AT THE CARD'S OWN LEFT EDGE -- not indented under the avatar, which is the detail
   that makes a wrapped sentence read as prose instead of as a table cell.

   The avatar is 32 px rather than Google's 40, which is Google's own comment-pane density. */
.sasha-c-card { background: #fff; border: 0; border-radius: 12px; box-shadow: 0 1px 2px rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15); padding: 12px 12px 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.sasha-c-flagged { background: #fffbf2; }
/* A RESOLVED thread, collapsed and dimmed -- what Google does once a discussion is hidden. */
.sasha-c-resolved { background: #f8f9fa; box-shadow: 0 1px 2px rgba(60,64,67,.2); }
.sasha-c-resolved .sasha-c-body, .sasha-c-resolved .sasha-c-name { color: #5f6368; }
.sasha-c-head { display: flex; align-items: flex-start; gap: 10px; }
/* 32 px, Google's comment-pane size at this density; one white initial on the author's colour. */
.sasha-c-avatar { flex: 0 0 auto; width: 32px; height: 32px; border-radius: 50%; background: #1e7b3c; color: #fff; font-size: 14px; font-weight: 500; line-height: 32px; text-align: center; user-select: none; }
/* SASHA NEVER SHARES THE USER'S COLOUR: the connector posts as the user's own account. */
.sasha-c-avatar-agent { background: #8430ce; }
.sasha-c-who { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; padding-top: 1px; }
.sasha-c-name { font-size: 15px; font-weight: 500; line-height: 20px; color: #1f1f1f; overflow-wrap: anywhere; }
.sasha-c-when { font-size: 12px; line-height: 16px; color: #5f6368; }
.sasha-c-where { color: #5f6368; }
.sasha-c-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 0; margin: -2px -6px 0 0; }
.sasha-c-body { margin: 0; font-size: 14px; line-height: 20px; color: #1f1f1f; white-space: pre-wrap; overflow-wrap: anywhere; }
.sasha-c-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }

/* THE COMPOSER IS A TEXTAREA, because a comment about a slide is often two sentences and the
   one-line input could neither wrap nor hold a newline. field-sizing:content grows it in
   Chrome, which is the only engine this add-on runs in; min-height is the floor for anything
   that ignores the property, so the box is never a single clipped line. */
.sasha-note { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 1.45; color: #202124; padding: 8px 10px; border: 1px solid #dadce0; border-radius: 10px; resize: vertical; min-height: 44px; field-sizing: content; }
.sasha-note:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 1px #1a73e8; }
.sasha-drop { cursor: pointer; border: 0; background: transparent; color: #5f6368; font-size: 13px; border-radius: 50%; width: 22px; height: 22px; }
.sasha-drop:hover:enabled { background: #f1f3f4; }
/* min-height:0 AND overflow:hidden on both: without them the flex children refuse to shrink below
   their content, the BODY grows past 100vh and the window gets a second scrollbar outside the
   grid's own -- measured in the browser smoke test, where it also pushed the last row's caption
   below the fold. Exactly one thing in this window scrolls, and it is the grid. */
.sasha-shell-wide .sasha-dialog { flex: 1 1 auto; min-height: 0; gap: 8px; overflow: hidden; }

/* TWO COLUMNS, rows as needed (UI-CONTRACT.md). minmax(0, 1fr) and not 1fr: a 1fr track takes
   its min-content from the 1280px-wide iframe inside it and would overflow the dialog. */
.sasha-grid {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-content: start;
  /* Room for a selected cell's 2px border, which would otherwise be clipped by the scroll box. */
  padding: 2px;
}
.sasha-cell { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
/* THE CELL IS NO LONGER A BUTTON (candidate-grid.tsx): its picture belongs to the current tool, so
   the frame that used to be the button's is on the stage itself, and the selected cell is outlined. */
.sasha-cell-stage { display: block; border: 2px solid #dadce0; border-radius: 8px; }
.sasha-cell-on > .sasha-cell-stage { border-color: #1a73e8; }
/* THE WHOLE PICTURE IS CLICKABLE, so it has to LOOK clickable: a pointer everywhere over the
   stage, and the stage lifts on hover. The button is transparent and fills the stage -- it sits
   over the iframe, which would otherwise swallow the click (candidate-grid.tsx). */
.sasha-cell-open { position: absolute; inset: 0; z-index: 3; border: 0; background: transparent; padding: 0; cursor: pointer; }
.sasha-cell-open:disabled { cursor: default; }
.sasha-cell-open:focus-visible { outline: 3px solid #1a73e8; outline-offset: -3px; }
.sasha-cell:hover > .sasha-cell-stage { border-color: #1a73e8; }
/* The option number, on the picture rather than in a row under it: it is what the user says out
   loud ("option 3") and it belongs to the slide, not to a caption. */
.sasha-cell-number { position: absolute; top: 6px; left: 6px; z-index: 2; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; background: rgba(32,33,36,.72); }
/* Two buttons, right-aligned, Insert last and accented. Compact on purpose: every pixel here is a
   pixel the second row of cells does not get. */
.sasha-cell-foot { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.sasha-c-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f3f4; }
/* "None of these" -- the answer, not a close button. Quiet and text-only, because the row it
   shares is an instruction and a toggle, and a bordered button here would read as a third
   control competing with Insert. It is the last thing on the row, away from the slides. */
.sasha-none { cursor: pointer; border: 0; background: transparent; padding: 4px 2px; font: inherit; font-size: 12px; color: #5f6368; text-decoration: underline; text-underline-offset: 2px; }
.sasha-none:hover:enabled { color: #202124; }
.sasha-none:disabled { opacity: .5; cursor: default; }

/* THE VISUAL EDITOR'S SLOT -- .sasha-editslot, not .sasha-editor. It used to share the name
   with the editor WINDOW below, so the window's card rules (white, rounded, shadowed, overflow
   hidden, flex:1) landed on this little panel too: it rendered as a floating card in the middle
   of the editor's column and swallowed the hint under it. Two different things, two names. */
.sasha-editslot { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #dadce0; padding-top: 8px; }
.sasha-editslot p { margin: 0; line-height: 1.5; }

/* ======== THE EDITOR: one candidate, on top of the grid ========================
   Three columns, in the order of the work: the toolbar (what the pointer is), the slide with
   its inspector under it, and the threads. The toolbar is down the LEFT EDGE because it is the
   only chrome that persists while the user works -- a row of mode buttons above the slide is
   what made the old window read as a cockpit. */
.sasha-editor-scrim { position: absolute; inset: 0; z-index: 30; display: flex; padding: 10px; background: rgba(32,33,36,.38); }
.sasha-editor { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: #fff; border-radius: 12px; box-shadow: 0 8px 28px rgba(60,64,67,.32); overflow: hidden; }
.sasha-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #e8eaed; }
.sasha-editor-title { margin: 0; font-size: 14px; }
.sasha-editor-title b { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; margin-right: 6px; border-radius: 10px; background: #202124; color: #fff; font-size: 11px; }
.sasha-editor-close { cursor: pointer; border: 0; background: transparent; color: #5f6368; font-size: 15px; width: 28px; height: 28px; border-radius: 50%; }
.sasha-editor-close:hover { background: #f1f3f4; }
.sasha-editor-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: auto minmax(0,1fr) minmax(0,310px); gap: 12px; padding: 12px; }
.sasha-editor-main { min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
/* ScaledHtmlFrame renders an inset:0 absolutely positioned box, so this wrapper MUST be a
   positioned, 16:9-sized ancestor -- exactly as .sasha-stage is. Without it the frame resolves
   against the initial containing block, escapes, and covers the editor's own header, toolbar
   and thread rail; the slide then looks full-bleed and the chrome looks missing. */
.sasha-editor-stage { position: relative; min-width: 0; width: 100%; max-width: 980px; aspect-ratio: 16 / 9; max-height: 46vh; margin: 0 auto; overflow: hidden; }
.sasha-editor-say { font-size: 12px; }

/* THE COMMENT COMPOSER, anchored on the stage to the element it is about (selection-composer.tsx).

   IT IS sasha-spot, NOT sasha-composer. The Ask Sasha sidebar's own message box has owned
   .sasha-composer since before this existed (Conversation.tsx), and the sidebar shipped this
   stylesheet too until each surface got its own -- so naming this one the same turned that
   message box into a floating card with a tail, hovering over the log. Second time a class name has collided across the two
   surfaces (.sasha-editor was the first); see the disjointness test in dialog-surface.test.ts.
   Absolute inside .sasha-editor-stage, which is the 16:9 box, so its 0-1 placement is slide
   coordinates. z-index clears the editor's own selection chrome, which draws over the frame. */
.sasha-spot { position: absolute; z-index: 12; min-width: 220px; display: flex; flex-direction: column; gap: 6px; padding: 8px 9px; background: #fff; border: 1px solid #dadce0; border-radius: 10px; box-shadow: 0 6px 20px rgba(60,64,67,.28); }
/* A tail toward the subject, so the link to the outlined element is visual and not inferred. */
.sasha-spot::before { content: ""; position: absolute; left: 16px; width: 10px; height: 10px; background: #fff; border-left: 1px solid #dadce0; border-top: 1px solid #dadce0; transform: rotate(45deg); }
.sasha-spot[data-side="below"]::before { top: -6px; }
.sasha-spot[data-side="above"]::before { bottom: -6px; transform: rotate(225deg); }
.sasha-spot-head { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 11px; color: #5f6368; }
.sasha-spot-what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sasha-spot-x { margin-left: auto; cursor: pointer; border: 0; background: transparent; color: #5f6368; font-size: 12px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
.sasha-spot-x:hover { background: #f1f3f4; }
.sasha-spot-note { width: 100%; resize: vertical; font: inherit; font-size: 13px; padding: 6px 7px; border: 1px solid #dadce0; border-radius: 6px; }
.sasha-spot-acts { display: flex; justify-content: flex-end; gap: 6px; }

/* THE TOOLBAR. One button per tool, a glyph over its name, so the column stays narrow. */
.sasha-toolrail { display: flex; flex-direction: column; gap: 6px; padding-right: 10px; border-right: 1px solid #e8eaed; }
.sasha-toolbtn { cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; width: 60px; padding: 8px 4px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: #202124; font: inherit; font-size: 11px; }
.sasha-toolbtn:hover:enabled { background: #f1f3f4; }
.sasha-toolbtn-on { border-color: #1a73e8; background: #e8f0fe; color: #1a73e8; font-weight: 600; }
.sasha-toolbtn-glyph { font-size: 17px; line-height: 1; }
.sasha-toolbtn:disabled { color: #9aa0a6; cursor: default; }

/* THE THREADS, down the right edge: the same cards the sidebar draws, from the same read. */
.sasha-threads { min-width: 0; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; padding-left: 12px; border-left: 1px solid #e8eaed; }
.sasha-threads-head { margin: 0; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #5f6368; }
.sasha-thread-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.sasha-thread-reply { margin-left: 10px; padding-left: 10px; border-left: 2px solid #e8eaed; display: flex; flex-direction: column; gap: 4px; }
.sasha-thread-compose { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.sasha-thread-resolve { cursor: pointer; border: 1px solid #dadce0; background: #fff; color: #1a73e8; border-radius: 50%; width: 22px; height: 22px; font-size: 12px; line-height: 1; }
.sasha-thread-resolve:hover:enabled { background: #e8f0fe; }
.sasha-thread-done { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #1e7b3c; }

/* LEAVING WITH WORDS UNSENT IS A QUESTION. It sits across the top of the editor, over the work,
   because it is about to throw that work away. */
.sasha-leave { margin: 10px 12px 0; padding: 10px 12px; border: 1px solid #f6d08a; background: #fffbf2; border-radius: 10px; display: flex; flex-direction: column; gap: 6px; }
.sasha-leave-head { margin: 0; font-size: 13px; font-weight: 600; }
.sasha-leave-say { margin: 0; font-size: 12px; line-height: 1.45; color: #5f6368; }
.sasha-leave-acts { display: flex; gap: 8px; justify-content: flex-end; }

@media (max-width: 900px){
  .sasha-editor-body { grid-template-columns: auto minmax(0,1fr); }
  .sasha-threads { grid-column: 1 / -1; border-left: 0; padding-left: 0; border-top: 1px solid #e8eaed; padding-top: 10px; }
}
.sasha-spot { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #dadce0; padding-top: 8px; }

/* --- UNRESOLVED COMMENT COUNTS, in both views -------------------------------------------
   One set of rules for the grid cell and the chip, because they are one
   number read from one state and must not be able to look like two different things.

   THREE TONES, because UnresolvedCount has three arms and only one of them is a number: known
   is blue, unknown ("?") is grey, unreachable ("!") is red. Showing an unread or unreachable
   count in the same ink as a real one is how the two views would start disagreeing quietly. */
.sasha-cell-unresolved { position: absolute; top: 6px; right: 6px; z-index: 2; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #fff; background: #1a73e8; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.sasha-cell-unresolved.sasha-unresolved-unknown { background: #9aa0a6; }
.sasha-cell-unresolved.sasha-unresolved-unreachable { background: #c5221f; }

/* --- sending a mark-up to Sasha (the pre-insert review path) ----------------------------- */
.sasha-send-anomaly { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid #1a73e8; background: #fff; color: #1a73e8; cursor: pointer; white-space: nowrap; }
.sasha-send-anomaly:disabled { border-color: #dadce0; color: #9aa0a6; cursor: default; }

/* --- THE ELEMENT INSPECTOR, under the slide in the editor (element-inspector.tsx) --------- */
.sasha-ei { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.sasha-ei-empty { margin: 10px 0 0; line-height: 1.5; }
.sasha-ei-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 12px; }
.sasha-ei-tag { font-size: 13px; color: #202124; }
.sasha-ei-selector {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #5f6368;
}
.sasha-ei-markup {
  width: 100%; resize: vertical; min-height: 120px;
  font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; color: #202124;
  background: #fff; border: 1px solid #dadce0; border-radius: 4px; padding: 6px 8px;
  white-space: pre; overflow-wrap: normal; overflow-x: auto;
}
.sasha-ei-markup:disabled { background: #f1f3f4; color: #5f6368; }
.sasha-ei-actions { display: flex; gap: 6px; }
.sasha-ei-apply, .sasha-ei-revert {
  cursor: pointer; border: 1px solid #dadce0; border-radius: 4px; background: #fff;
  padding: 4px 12px; font-size: 12px; color: #202124;
}
.sasha-ei-apply { border-color: #1a73e8; background: #1a73e8; color: #fff; font-weight: 600; }
.sasha-ei-apply:disabled, .sasha-ei-revert:disabled { cursor: default; opacity: .5; }
`;
