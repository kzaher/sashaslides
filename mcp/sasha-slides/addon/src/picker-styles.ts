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
.sasha-dialog { display: flex; flex-direction: column; gap: 10px; }
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
.sasha-c-card { background: #fff; border: 1px solid #e8eaed; border-radius: 12px; box-shadow: 0 1px 3px rgba(60,64,67,.15); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.sasha-c-agent { background: #f8fbff; border-color: #d2e3fc; }
.sasha-c-flagged { background: #fffbf2; border-color: #f6d08a; }
.sasha-c-head { display: flex; align-items: flex-start; gap: 8px; }
.sasha-c-avatar { flex: 0 0 auto; width: 28px; height: 28px; border-radius: 50%; background: #1e7b3c; color: #fff; font-size: 13px; font-weight: 500; line-height: 28px; text-align: center; user-select: none; }
.sasha-c-who { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.sasha-c-name { font-size: 13px; font-weight: 500; color: #202124; overflow-wrap: anywhere; }
.sasha-c-when { font-size: 11px; color: #5f6368; }
.sasha-c-where { color: #5f6368; }
.sasha-c-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.sasha-c-body { margin: 0; font-size: 13px; line-height: 1.45; color: #202124; white-space: pre-wrap; overflow-wrap: anywhere; }
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
/* Compact on purpose: every pixel here is a pixel the second row of cells does not get. */
.sasha-cell-foot { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sasha-cell-foot .sasha-chip { padding: 2px 8px; font-size: 11px; }
.sasha-cell-foot .sasha-zoom { padding: 2px 8px; font-size: 11px; }
.sasha-cell-hint { margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* --- the toolbar: VIEW and TOOL side by side, because they are independent ------------------
   Three labelled groups on one wrapping row (Picker.tsx). They are deliberately NOT one row of
   four buttons: grid / single / edit / annotate as a single group reads as a four-way mode, which
   is exactly the confusion two independent fields exist to remove. */
.sasha-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.sasha-toggle-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #5f6368; align-self: center; margin-right: 2px; }
.sasha-toolbar-say { flex: 1 1 200px; min-width: 0; }

/* --- one candidate, large: the other zoom level, same tool ---------------------------- */
.sasha-single { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px; }
.sasha-backbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
/* Capped by HEIGHT as well as width: the pane, its notes and the editor slot all have to fit in a
   dialog whose height the window may have clamped. */
.sasha-pane-big { max-width: 920px; }
.sasha-pane-big .sasha-stage { max-height: 44vh; }
.sasha-editor { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #dadce0; padding-top: 8px; }
.sasha-editor p { margin: 0; line-height: 1.5; }
/* BOUNDED, because the tool panel is a FIXED-HEIGHT sibling of the workspace now: the dialog hides
   its overflow and only the workspace scrolls, so an unbounded edit list would push the
   report bar and the Insert button out of the clipped shell (overflow is hidden there, so what does
   not fit is simply gone). The HEADER and the prose above it stay put; it is only the list that
   scrolls, which is the one part a reader can leave half-read without losing anything -- unlike the
   risk disclosure, see .sasha-annots. */
.sasha-edits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; max-height: 24vh; overflow-y: auto; }
.sasha-edit { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #202124; }

/* --- ASK SASHA: the conversation, which is the event log ---------------------------------
   ONE COLUMN, ONE LIST. Every entry -- an event or a message -- is a .sasha-msg, tinted by WHOSE
   turn it is, because the contract's "a comment is rendered as part of the user's turn" is a
   statement about this column and not about two panes.

   THE LOG SCROLLS; THE OPEN COMMENTS DO NOT. .sasha-msgs keeps its own bounded scroll and
   .sasha-open-comments sits below it, outside that box -- which is the whole of "open comments
   stay listed until resolved, they do not scroll away into history". */
.sasha-chat { display: flex; flex-direction: column; gap: 10px; }
.sasha-msgs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow-y: auto; }
/* A MESSAGE is a comment card and carries no tint of its own; an EVENT is a quiet system line.
   The tints below therefore apply to events only -- a card that was also tinted read as a
   highlighted row rather than as something a person wrote. */
.sasha-msg { display: flex; flex-direction: column; gap: 2px; font-size: 12px; border-radius: 6px; }
/* Only an EVENT row takes the padding and the voice tint; a message row is just a wrapper
   around the card, which brings its own. The class is on the element rather than a :has()
   selector so the distinction is visible in the rendered markup the tests read. */
.sasha-msg-event { padding: 6px 8px; }
.sasha-msg-who { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #5f6368; }
.sasha-msg-text { margin: 0; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
/* What the user actually said, quoted under the line that says they said it. */
.sasha-msg-quote { margin: 2px 0 0; padding: 4px 8px; border-left: 3px solid #1a73e8; font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(255,255,255,.65); }
.sasha-msg-user { background: #e8f0fe; }
.sasha-msg-sasha { background: #f1f3f4; }
/* The DECK's own voice -- an insertion is neither the user's turn nor Sasha's. */
.sasha-msg-deck { background: #e6f4ea; }
/* AN EVENT THIS BUILD CANNOT READ. Visibly different from both voices and never hidden: a reader
   on an older build must be able to see that something happened it cannot describe. */
.sasha-msg-opaque { background: #fef7e0; border: 1px dashed #e8b931; }
/* A DELIVERY RECEIPT. Its own tone, quieter than Sasha's: it says a session read something, which
   is weaker than a session having said something, and it must not look like an answer. */
.sasha-msg-delivery { background: #f8f9fa; border-left: 3px solid #80868b; }
.sasha-msg-where { font-size: 11px; color: #5f6368; }
/* The revised slide, INLINE in the log: the candidate's own HTML at the cell's measured scale. */
.sasha-inline-slide { margin: 6px 0 0; display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
/* The inline slide's 16:9 box. Capped so a revised slide is a THUMBNAIL in the log and not a
   full-column image that pushes the rest of the conversation off the screen. */
.sasha-inline-stage { display: block; max-width: 260px; }
.sasha-inline-slide figcaption { line-height: 1.4; }
.sasha-composer { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #dadce0; padding-top: 8px; }
.sasha-staged { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; border: 1px solid #1a73e8; background: #e8f0fe; border-radius: 8px; padding: 10px; }
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
