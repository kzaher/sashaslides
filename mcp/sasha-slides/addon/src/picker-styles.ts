// The styles for ALL THREE SURFACES, as one string each shell renders into a <style> element.
//
// ONE STRING, TWO SHELLS. The dialog and the sidebar are separate HtmlService documents that share
// nothing at runtime (UI-CONTRACT.md), so each bundle inlines its own copy of this; the parts that
// differ are scoped by a shell class (`.sasha-shell-wide` for the dialog) rather than split into
// two files, because the chips, marks, notes and buttons are genuinely the same widgets and a
// second copy of them would drift.
//
// ORIGINALLY ADAPTED FOR THE SIDEBAR. In the extension this was injected into a SHADOW ROOT on the Slides page
// and `.sasha-shell` was a floating 760px panel pinned to the bottom-right corner, because that is
// the only way to put a panel on docs.google.com without a specificity war. An HtmlService sidebar
// is its OWN document -- roughly 300px wide, full height, nothing else in it -- so the shell is a
// plain block that fills it, `:host` (which only means anything inside a shadow root) is gone, and
// the places that assumed a wide panel wrap instead.

export const PICKER_CSS = `
.sasha-diag { font-family: ui-monospace, Menlo, monospace; font-size: 11px; margin-top: 6px; opacity: .85; user-select: all; }

.sasha-idle { display: flex; flex-direction: column; gap: 10px; padding: 18px 4px; }
.sasha-idle strong { font-size: 15px; }
.sasha-idle .sasha-dim { margin: 0; line-height: 1.5; }

* { box-sizing: border-box; font-family: Roboto, Arial, sans-serif; }
html, body { margin: 0; padding: 0; background: #fff; }
.sasha-shell {
  display: block; width: 100%;
  color: #202124; background: #fff;
  padding: 10px 12px 16px;
  font-size: 13px;
}
/* position:relative is LOAD-BEARING: the editor window is a scrim with inset:0, and without a
   positioned ancestor it would resolve against the initial containing block and escape the
   dialog entirely. */
/* A LOADER: the only honest thing a window that is waiting can show. */
.sasha-loader { display: flex; align-items: center; justify-content: center; padding: 56px 0; margin: 0; }
.sasha-loader-ring { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #dadce0; border-top-color: #1a73e8; animation: sashaSpin .8s linear infinite; }
/* The header's own small one, beside the title, for a read already in flight. */
.sasha-header-spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid #dadce0; border-top-color: #1a73e8; animation: sashaSpin .8s linear infinite; flex: none; }
.sasha-header-gap { flex: 1 1 auto; }
@media (prefers-reduced-motion: reduce){ .sasha-loader-ring, .sasha-header-spin { animation: none; border-top-color: #dadce0; } }
.sasha-dialog { position: relative; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.sasha-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; font-size: 13px; }
.sasha-dim { color: #5f6368; font-size: 12px; }
.sasha-busy { color: #1a73e8; font-size: 12px; }
.sasha-trouble { color: #c5221f; font-size: 12px; margin: 0; }
.sasha-settled { font-size: 13px; margin: 0; }
.sasha-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sasha-chip {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  border: 1px solid #dadce0; border-radius: 999px; background: #fff;
  padding: 4px 10px; font-size: 12px; max-width: 100%;
}
.sasha-chip-on { border-color: #1a73e8; background: #e8f0fe; }
.sasha-chip:disabled { cursor: default; opacity: .6; }
.sasha-chip-number { font-weight: 700; }
.sasha-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The chip's unresolved badge. A PILL, not a bare glyph: it carries one of three background tones
   (see the unresolved rules below) and a coloured background behind a 1-character glyph with no
   size of its own renders as a thin vertical sliver -- seen in the browser smoke screenshot. */
.sasha-chip-flag { min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; background: #c5221f; }
.sasha-toggle { display: flex; gap: 4px; }
.sasha-tab {
  cursor: pointer; border: 1px solid #dadce0; background: #fff;
  border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
.sasha-tab-on { border-color: #1a73e8; color: #1a73e8; font-weight: 600; }
.sasha-pane { width: 100%; }
/* 16:9, so the 1280x720 document and the 720x405pt page are the same box on screen. */
.sasha-stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #f1f3f4; border: 1px solid #dadce0; overflow: hidden; }
/* Google's own PNG of the candidate, filling the 16:9 stage exactly as the HTML frame does. */
.sasha-render { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; background: #fff; }
/* The fallback projection says what it is, across the bottom, so a diagram is never mistaken for
   the rendering -- that mistake was read as "the converter is broken" when it had not run. */
.sasha-projection-note { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; padding: 3px 6px; font-size: 10px; line-height: 1.3; color: #5f6368; background: rgba(255,255,255,.92); border-top: 1px solid #e8eaed; }
/* The HTML pane is a real 1280x720 document, so it is SCALED into the stage, not clipped. The
   SCALE IS AN INLINE STYLE, not a constant here: a dialog's width is a request the browser window
   clamps and the grid reflows between two columns and one, so scaled-frame.tsx measures the box and
   renders the transform. Only the things that do not depend on the measurement live here. */
.sasha-scaled { position: absolute; inset: 0; overflow: hidden; }
.sasha-frame { position: absolute; left: 0; top: 0; border: 0; transform-origin: top left; }
.sasha-placeholder { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; }
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
/* 32vh, and the big pane above gives up 8vh for it (see .sasha-pane-big .sasha-stage): a mark-up
   row is TWO lines now, so the one-line sizing clipped the second row mid-glyph with only two
   mark-ups on screen. padding-right keeps the remove button off the scrollbar when it does scroll.
   The browser smoke test asserts the last row is fully inside this box, so the split is measured
   rather than eyeballed. */
.sasha-anomalies { list-style: none; margin: 0; padding: 0 6px 0 0; display: flex; flex-direction: column; gap: 8px; max-height: 32vh; overflow-y: auto; font-size: 13px; }
.sasha-anomaly { display: block; }

/* --- THE COMMENT CARD, drawn by BOTH surfaces (comment-card.tsx) -------------------------
   The measurements are read off a real Google Slides comment card, so a mark-up in the slides
   window and a message in the Ask Sasha log sit next to Google's own comment pane without
   looking like a different product: a 12 px white card with a soft shadow, a 28 px round
   avatar carrying one initial, the author in 500 weight with the time under it in grey, and
   the BODY AT THE CARD'S OWN LEFT EDGE -- not indented under the avatar, which is the detail
   that makes a wrapped sentence read as prose instead of as a table cell.

   The avatar is 28 px rather than Google's 40: this renders in a 300 px sidebar, where a 40 px
   bubble plus its gap takes a sixth of the line. */
.sasha-c-card { background: #fff; border: 0; border-radius: 12px; box-shadow: 0 1px 2px rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15); padding: 12px 12px 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.sasha-c-agent { background: #f8fbff; }
.sasha-c-flagged { background: #fffbf2; }
/* AN EVENT THIS BUILD CANNOT READ, in the card shape but visibly different and never hidden: a
   reader on an older build must be able to see that something happened it cannot describe. */
.sasha-c-opaque { background: #fffbf2; box-shadow: none; border: 1px dashed #e8b931; }
/* A RESOLVED thread, collapsed and dimmed -- what Google does once a discussion is hidden. */
.sasha-c-resolved { background: #f8f9fa; box-shadow: 0 1px 2px rgba(60,64,67,.2); }
.sasha-c-resolved .sasha-c-body, .sasha-c-resolved .sasha-c-name { color: #5f6368; }
.sasha-c-resolved-label { font-size: 12px; font-weight: 500; color: #5f6368; padding: 0 4px; line-height: 28px; }
.sasha-c-collapsed { font-size: 12px; color: #5f6368; }
.sasha-c-head { display: flex; align-items: flex-start; gap: 10px; }
/* 32 px, Google's comment-pane size at this density; one white initial on the author's colour. */
.sasha-c-avatar { flex: 0 0 auto; width: 32px; height: 32px; border-radius: 50%; background: #1e7b3c; color: #fff; font-size: 14px; font-weight: 500; line-height: 32px; text-align: center; user-select: none; }
/* SASHA NEVER SHARES THE USER'S COLOUR: the connector posts as the user's own account. */
.sasha-c-avatar-agent { background: #8430ce; }
.sasha-c-avatar-deck { background: #5f6368; }
.sasha-c-avatar-delivery { background: #9aa0a6; }
.sasha-c-avatar-opaque { background: #e37400; }
.sasha-c-who { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; padding-top: 1px; }
.sasha-c-name { font-size: 15px; font-weight: 500; line-height: 20px; color: #1f1f1f; overflow-wrap: anywhere; }
.sasha-c-when { font-size: 12px; line-height: 16px; color: #5f6368; }
.sasha-c-where { color: #5f6368; }
.sasha-c-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 0; margin: -2px -6px 0 0; }
.sasha-c-body { margin: 0; font-size: 14px; line-height: 20px; color: #1f1f1f; white-space: pre-wrap; overflow-wrap: anywhere; }
/* A reply's words sit on Google's light grey strip, which is what tells it from the root. */
.sasha-c-body-reply { background: #f1f3f4; border-radius: 8px; padding: 8px 10px; }
.sasha-c-reply { display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
/* THE ICON BUTTONS: Material paths in a round 32 px hit area, the tick in Google blue. */
.sasha-c-icon { cursor: pointer; border: 0; background: transparent; color: #444746; width: 32px; height: 32px; border-radius: 50%; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.sasha-c-icon:hover:enabled { background: rgba(68,71,70,.08); }
.sasha-c-icon:disabled { cursor: default; opacity: .38; }
.sasha-c-svg { width: 20px; height: 20px; display: block; }
.sasha-c-resolve { color: #0b57d0; }
.sasha-c-resolve:hover:enabled { background: rgba(11,87,208,.08); }
/* THE THREE-DOT MENU: absolutely positioned under its button, over whatever is below. */
.sasha-c-more { position: relative; display: inline-flex; }
.sasha-c-menu { position: absolute; top: 100%; right: 0; z-index: 20; display: flex; flex-direction: column; min-width: 150px; padding: 6px 0; background: #fff; border-radius: 4px; box-shadow: 0 2px 6px 2px rgba(60,64,67,.15), 0 1px 2px rgba(60,64,67,.3); }
.sasha-c-menu-item { cursor: pointer; border: 0; background: transparent; text-align: left; padding: 8px 16px; font-size: 14px; color: #1f1f1f; white-space: nowrap; }
.sasha-c-menu-item:hover { background: #f1f3f4; }
.sasha-c-menu-note { display: block; padding: 6px 16px; max-width: 220px; line-height: 1.4; }
/* THE REPLY PILL at the foot of an open thread. field-sizing grows it as a reply wraps; Enter posts. */
.sasha-c-pill-row { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding-top: 2px; }
.sasha-c-pill { width: 100%; box-sizing: border-box; font: inherit; font-size: 14px; line-height: 20px; color: #1f1f1f; padding: 9px 16px; border: 1px solid #c4c7c5; border-radius: 20px; resize: none; min-height: 40px; field-sizing: content; background: #fff; }
.sasha-c-pill::placeholder { color: #5f6368; }
.sasha-c-pill:focus { outline: none; border-color: #0b57d0; box-shadow: 0 0 0 1px #0b57d0; }
.sasha-c-pill:disabled { background: #f8f9fa; }
.sasha-c-reply-send { cursor: pointer; border: 0; border-radius: 18px; background: #0b57d0; color: #fff; padding: 8px 18px; font-size: 14px; font-weight: 500; }
.sasha-c-reply-send:disabled { cursor: default; opacity: .38; }
.sasha-c-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }

/* THE COMPOSER IS A TEXTAREA, because a comment about a slide is often two sentences and the
   one-line input could neither wrap nor hold a newline. field-sizing:content grows it in
   Chrome, which is the only engine this add-on runs in; min-height is the floor for anything
   that ignores the property, so the box is never a single clipped line. */
.sasha-note { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 1.45; color: #202124; padding: 8px 10px; border: 1px solid #dadce0; border-radius: 10px; resize: vertical; min-height: 44px; field-sizing: content; }
.sasha-note:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 1px #1a73e8; }
.sasha-drop { cursor: pointer; border: 0; background: transparent; color: #5f6368; font-size: 13px; border-radius: 50%; width: 22px; height: 22px; }
.sasha-drop:hover:enabled { background: #f1f3f4; }
.sasha-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.sasha-actions .sasha-dim { margin-right: auto; }
.sasha-primary { cursor: pointer; border: 0; border-radius: 6px; background: #1a73e8; color: #fff; padding: 7px 14px; font-size: 13px; font-weight: 600; }
.sasha-secondary { cursor: pointer; border: 1px solid #dadce0; border-radius: 6px; background: #fff; padding: 7px 14px; font-size: 13px; }
.sasha-primary:disabled, .sasha-secondary:disabled { opacity: .5; cursor: default; }
.sasha-small { padding: 3px 8px; font-size: 12px; }
.sasha-rule { border: 0; border-top: 1px solid #dadce0; margin: 4px 0; width: 100%; }

/* --- the dialog: a roomy window, not a 300px column -------------------------------------
   setWidth/setHeight are a REQUEST the browser window clamps, so nothing below assumes it got
   the size it asked for: the shell is a full-height flex column whose GRID is the part that
   scrolls, so a clamped dialog loses scroll position rather than losing the footer. */
.sasha-shell-wide { padding: 10px 14px 12px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
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
   the frame that used to be the button's is on the stage itself. The selected cell is outlined, and
   the cell the editor is attached to is outlined more strongly -- one glance has to answer "which
   slide am I editing", because the editor's own chrome lives over the frame and nowhere else. */
.sasha-cell-stage { display: block; border: 2px solid #dadce0; border-radius: 8px; }
.sasha-cell-on > .sasha-cell-stage { border-color: #1a73e8; }
.sasha-cell-edited > .sasha-cell-stage { border-color: #188038; box-shadow: 0 0 0 2px rgba(24,128,56,.25); }
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

/* --- the toolbar: VIEW and TOOL side by side, because they are independent ------------------
   Three labelled groups on one wrapping row (Picker.tsx). They are deliberately NOT one row of
   four buttons: grid / single / edit / annotate as a single group reads as a four-way mode, which
   is exactly the confusion two independent fields exist to remove. */
/* --- THE SET ITSELF, above its comments -------------------------------------------------
   A thread is about one slide; the candidates are a GROUP, and nothing on this surface stood
   for the group. The slides are stacked vertically because that is what they are: a pile of
   candidates, in order. */
.sasha-artifact { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 10px; border: 1px solid #e8eaed; border-radius: 10px; background: #fff; box-shadow: 0 1px 4px rgba(60,64,67,.12); }
.sasha-artifact-head { margin: 0; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #5f6368; }
.sasha-stack { list-style: none; margin: 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 4px; }
.sasha-stack-slide { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 6px; border: 1px solid #e8eaed; border-radius: 6px; background: #f8f9fa; }
.sasha-stack-number { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; border-radius: 9px; background: #202124; color: #fff; font-size: 10px; font-weight: 700; flex: none; }
.sasha-stack-label { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* On a comment, not in a bar: it belongs to the thread above it. */
.sasha-open-artifact { cursor: pointer; margin: 4px 0 0 34px; border: 0; background: transparent; padding: 2px 0; font: inherit; font-size: 11px; color: #1a73e8; text-decoration: underline; text-underline-offset: 2px; }
.sasha-open-artifact:hover { color: #174ea6; }

/* --- THE COMMENTS PANEL: the sidebar's own, modelled on a document's comment pane ---------
   Open comments by default, a filter with counts, and the open ones split so the threads Sasha
   has answered lead. Replaces a yellow summary that restated the same comments in prose. */
.sasha-comments { display: flex; flex-direction: column; gap: 10px; }
/* THE CONTROLS STAY PUT. The set card and the filter govern everything under them, so a long
   thread must not scroll them away. Two sticky bands, the filter under the card. */
.sasha-artifact { position: sticky; top: 0; z-index: 3; }
.sasha-filter { position: sticky; top: 0; z-index: 2; background: var(--sasha-ground, #fff); padding: 6px 0; }
.sasha-filter { display: flex; gap: 4px; flex-wrap: wrap; }
/* The two things a thread ends with, as words: the tick in the corner is Google's convention
   but it is a 22px target nobody finds. */
.sasha-c-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f3f4; }
.sasha-c-open, .sasha-c-markdone { cursor: pointer; border: 0; background: transparent; padding: 2px 0; font: inherit; font-size: 12px; color: #1a73e8; }
.sasha-c-open:hover:enabled, .sasha-c-markdone:hover:enabled { text-decoration: underline; }
.sasha-c-markdone { margin-left: auto; }
.sasha-c-markdone:disabled { color: #9aa0a6; cursor: default; }
.sasha-c-done { margin-left: auto; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #1e7b3c; }
/* The composer, drawn as a new comment. */
.sasha-c-acts { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.sasha-c-cancel { cursor: pointer; border: 0; background: transparent; padding: 4px 8px; font: inherit; font-size: 13px; color: #1a73e8; border-radius: 6px; margin-left: auto; }
.sasha-c-cancel:hover:enabled { background: #e8f0fe; }
.sasha-c-send { cursor: pointer; border: 0; border-radius: 16px; background: #1a73e8; color: #fff; padding: 6px 16px; font: inherit; font-size: 13px; font-weight: 500; }
.sasha-c-send:disabled { background: #e8eaed; color: #9aa0a6; cursor: default; }
/* The spinner may not change the header's height (it used to push Refresh to a second row). */
.sasha-header { position: relative; }
.sasha-header-spin { position: absolute; right: 0; top: 50%; margin-top: -6px; }
.sasha-filter .sasha-tab { display: inline-flex; align-items: center; gap: 5px; }
.sasha-filter-count { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #e8eaed; color: #5f6368; font-size: 10px; font-weight: 600; }
.sasha-tab-on .sasha-filter-count { background: #1a73e8; color: #fff; }
.sasha-comment-section { display: flex; flex-direction: column; gap: 6px; }
/* The heading earns its place by naming a STATE, not by decorating: "Addressed" means Sasha has
   replied and there is something new to read; "Not addressed" is still waiting. */
.sasha-section-head { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #5f6368; }
.sasha-section-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

.sasha-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.sasha-toggle-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #5f6368; align-self: center; margin-right: 2px; }
/* THE ONE INSTRUCTION THE GRID GIVES, and it is not dim. It tells the user that the pictures are
   the control -- without it a slide looks like a thumbnail, and nobody clicks a thumbnail. */
.sasha-toolbar-say { flex: 1 1 200px; min-width: 0; font-size: 13px; font-weight: 600; color: #202124; }
/* "None of these" -- the answer, not a close button. Quiet and text-only, because the row it
   shares is an instruction and a toggle, and a bordered button here would read as a third
   control competing with Insert. It is the last thing on the row, away from the slides. */
.sasha-none { cursor: pointer; border: 0; background: transparent; padding: 4px 2px; font: inherit; font-size: 12px; color: #5f6368; text-decoration: underline; text-underline-offset: 2px; }
.sasha-none:hover:enabled { color: #202124; }
.sasha-none:disabled { opacity: .5; cursor: default; }

/* --- one candidate, large: the other zoom level, same tool ---------------------------- */
.sasha-single { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px; }
.sasha-backbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
/* Capped by HEIGHT as well as width: the pane, its notes and the editor slot all have to fit in a
   dialog whose height the window may have clamped. */
.sasha-pane-big { max-width: 920px; }
.sasha-pane-big .sasha-stage { max-height: 44vh; }
/* THE VISUAL EDITOR'S SLOT -- .sasha-editslot, not .sasha-editor. It used to share the name
   with the editor WINDOW below, so the window's card rules (white, rounded, shadowed, overflow
   hidden, flex:1) landed on this little panel too: it rendered as a floating card in the middle
   of the editor's column and swallowed the hint under it. Two different things, two names. */
.sasha-editslot { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #dadce0; padding-top: 8px; }
.sasha-editslot p { margin: 0; line-height: 1.5; }
/* BOUNDED, because the tool panel is a FIXED-HEIGHT sibling of the workspace now: the dialog hides
   its overflow and only the workspace scrolls, so an unbounded edit list would push the
   report bar and the Insert button out of the clipped shell (overflow is hidden there, so what does
   not fit is simply gone). The HEADER and the prose above it stay put; it is only the list that
   scrolls, which is the one part a reader can leave half-read without losing anything -- unlike the
   risk disclosure, see .sasha-annots. */
.sasha-edits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; max-height: 24vh; overflow-y: auto; }
.sasha-edit { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #202124; }

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
   .sasha-composer since before this existed (Conversation.tsx), and the SIDEBAR SHIPS THIS
   STYLESHEET too -- so naming this one the same turned that message box into a floating card
   with a tail, hovering over the log. Second time a class name has collided across the two
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

/* --- ASK SASHA: the conversation, which is the event log ---------------------------------
   ONE COLUMN, ONE LIST. Every entry -- an event or a message -- is a .sasha-msg, tinted by WHOSE
   turn it is, because the contract's "a comment is rendered as part of the user's turn" is a
   statement about this column and not about two panes.

   THE LOG SCROLLS; THE OPEN COMMENTS DO NOT. .sasha-msgs keeps its own bounded scroll and
   .sasha-open-comments sits below it, outside that box -- which is the whole of "open comments
   stay listed until resolved, they do not scroll away into history". */
.sasha-chat { display: flex; flex-direction: column; gap: 10px; }
/* THE OPENING STATE: one spinner, centred, and nothing else on screen. */
.sasha-opening { display: flex; align-items: center; justify-content: center; padding: 34px 0; margin: 0; }
.sasha-opening-ring { width: 22px; height: 22px; border-radius: 50%; border: 2px solid #dadce0; border-top-color: #1a73e8; animation: sashaSpin .8s linear infinite; }
@keyframes sashaSpin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce){ .sasha-opening-ring { animation: none; border-top-color: #dadce0; } }
/* Padded so the cards' shadows are not clipped by the scroller's edge. */
.sasha-msgs { list-style: none; margin: 0; padding: 3px 4px 4px 3px; display: flex; flex-direction: column; gap: 12px; max-height: 52vh; overflow-y: auto; }
/* EVERY ENTRY IS A CARD NOW -- a thread or an event, in Google's comment-card language -- so the
   row is only a wrapper. The voice classes stay on it (sasha-msg-user, -sasha, -deck, -delivery,
   -opaque) because they say WHOSE turn a row is in the markup the tests and the smoke read; the
   colour of that turn is the avatar's, inside the card. */
.sasha-msg { display: flex; flex-direction: column; font-size: 12px; }
.sasha-msg-where { font-size: 11px; color: #5f6368; }
/* The revised slide, INLINE in the log: the candidate's own HTML at the cell's measured scale. */
.sasha-inline-slide { margin: 6px 0 0; display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
/* The inline slide's 16:9 box. Capped so a revised slide is a THUMBNAIL in the log and not a
   full-column image that pushes the rest of the conversation off the screen. */
.sasha-inline-stage { display: block; max-width: 260px; }
.sasha-inline-slide figcaption { line-height: 1.4; }
.sasha-spot { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #dadce0; padding-top: 8px; }
/* THE SAME CARD AS EVERYTHING ELSE. It used to be a blue-bordered, blue-filled panel, which in
   a column of white comment cards reads as an alert or a selected row -- the user asked why the
   blue was there, and there was no answer. The colour belongs on the BUTTON inside it, which is
   the only thing here that does something. */
.sasha-staged { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; border: 1px solid #e8eaed; background: #fff; border-radius: 12px; padding: 10px 12px; box-shadow: 0 1px 3px rgba(60,64,67,.15); }
.sasha-staged strong { font-size: 13px; }

/* --- the open comments, pinned ----------------------------------------------------------- */
.sasha-open-comments { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; border: 1px solid #e8b931; background: #fef7e0; border-radius: 8px; padding: 8px 10px; }
.sasha-open-comments strong { font-size: 12px; }
.sasha-open-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; width: 100%; }
.sasha-open-row { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.sasha-open-slide { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #5f6368; }
.sasha-open-text { line-height: 1.45; overflow-wrap: anywhere; }

/* --- THE WAIT, LIVE AND HONEST (waiting.ts, Conversation.tsx) --------------------------------
   The indicator is a CSS ANIMATION and not a glyph a render cycle advances: a "spinner" driven by
   re-renders freezes exactly when a poll stalls, which is the moment the user most needs to see
   that the wait is still running. A prefers-reduced-motion viewer gets a steady dot instead -- the dot
   still has to be THERE, because it is the difference between "waiting" and "finished". */
.sasha-waiting-head { display: flex; align-items: center; gap: 6px; }
.sasha-pulse { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: #e37400; animation: sasha-breathe 1.6s ease-in-out infinite; }
.sasha-pulse-off { animation: none; opacity: .4; }
@keyframes sasha-breathe { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.72); } }
@media (prefers-reduced-motion: reduce) { .sasha-pulse { animation: none; } }
/* Monospace and tabular: the number changes every second, and a proportional font makes the whole
   row jitter sideways on every tick. */
.sasha-wait-clock { font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; font-size: 11px; color: #202124; }
/* A comment something has READ. Green, because it is the one piece of good news in this panel --
   and still only "it was read", which is why the row's words say exactly that. */
.sasha-wait-delivered { color: #137333; }
/* A comment NOTHING has read past the threshold. Red, and the pulse above it has stopped: at this
   point the number is not a progress report, it is how long the user has been alone. */
.sasha-wait-unheard { color: #c5221f; font-weight: 600; }

/* --- NOBODY IS LISTENING (feedback-delivery.ts) ----------------------------------------------
   The one place in this product that asks the user to go and start something, so it is drawn as the
   loudest thing in the panel and sits above the explanation rather than below it.

   The two commands are <code> blocks on their own lines: the sidebar has no clipboard permission,
   so "copyable verbatim" can only mean "selectable without picking words out of a sentence", and
   user-select:all makes one click select a whole command. */
.sasha-nobody-listening { display: flex; flex-direction: column; gap: 6px; width: 100%; border: 1px solid #c5221f; background: #fce8e6; border-radius: 6px; padding: 8px; }
.sasha-nobody-head { font-size: 12px; font-weight: 600; color: #c5221f; }
.sasha-copyable { display: block; user-select: all; font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; background: #fff; border: 1px solid #dadce0; border-radius: 4px; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Not clamped and not behind a disclosure: it is the sentence that stops the panel being a lie. */
.sasha-precondition { margin: 0; line-height: 1.45; }
.sasha-open-comments p { margin: 0; line-height: 1.45; }

/* --- UNRESOLVED COMMENT COUNTS, in both views -------------------------------------------
   One set of rules for the grid cell, the chip and the conversation row, because they are one
   number read from one state and must not be able to look like two different things.

   THREE TONES, because UnresolvedCount has three arms and only one of them is a number: known
   is blue, unknown ("?") is grey, unreachable ("!") is red. Showing an unread or unreachable
   count in the same ink as a real one is how the two views would start disagreeing quietly. */
.sasha-cell-unresolved { position: absolute; top: 6px; right: 6px; z-index: 2; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #fff; background: #1a73e8; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.sasha-unresolved { display: inline-flex; align-items: baseline; gap: 6px; font-size: 11px; }
.sasha-unresolved-mark { min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; background: #1a73e8; }
/* The tone goes on the BADGE, never on a wrapper that also holds prose: .sasha-unresolved is a
   pill plus its explanation, and a saturated red fill behind dark-red text is unreadable (seen in
   the browser smoke screenshot). So the standalone badges are addressed by compound selector and
   the conversation's wrapper tints only its own mark. */
.sasha-cell-unresolved.sasha-unresolved-unknown,
.sasha-chip-flag.sasha-unresolved-unknown,
.sasha-unresolved-unknown .sasha-unresolved-mark { background: #9aa0a6; }
.sasha-cell-unresolved.sasha-unresolved-unreachable,
.sasha-chip-flag.sasha-unresolved-unreachable,
.sasha-unresolved-unreachable .sasha-unresolved-mark { background: #c5221f; }
.sasha-unresolved-unreachable > .sasha-dim { color: #c5221f; }

/* --- sending a mark-up to Sasha (the pre-insert review path) ----------------------------- */
.sasha-send-anomaly { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid #1a73e8; background: #fff; color: #1a73e8; cursor: pointer; white-space: nowrap; }
.sasha-send-anomaly:disabled { border-color: #dadce0; color: #9aa0a6; cursor: default; }

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
/* The CONVERSATION's report entry. The slides window's lives in its footer row instead -- see
   Picker.tsx's ReportButton for the measurement that put it there. */
.sasha-reportentry { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px solid #e8eaed; }
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
