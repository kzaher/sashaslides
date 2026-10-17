// THE ASK SASHA SIDEBAR'S OWN RULES (Sidebar.html: the connection line, the setup guide and the
// candidates card). Layered after base-styles.ts and before the Tidepool look, which restyles much
// of it (src/surface-stylesheets.ts); minified by build-addon.ts.

export const SIDEBAR_CSS = `
/* The header's own small one, beside the title, for a read already in flight. */
.sasha-header-spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid #dadce0; border-top-color: #1a73e8; animation: sashaSpin .8s linear infinite; flex: none; }
@media (prefers-reduced-motion: reduce){ .sasha-header-spin { animation: none; border-top-color: #dadce0; } }

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
/* Label above, actions below, beside the thumbnail -- so the label is never squeezed by buttons. */
.sasha-stack-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sasha-stack-body .sasha-stack-label { flex: none; }
.sasha-stack-actions { display: flex; align-items: center; gap: 6px; }
/* The thumbnail is a button that opens the candidate: no button chrome, just a pointer and a ring. */
.sasha-stack-thumb { flex: none; display: flex; padding: 0; border: 0; background: none; cursor: pointer; border-radius: 4px; }
.sasha-stack-thumb:hover, .sasha-stack-thumb:focus-visible { outline: 2px solid #1a73e8; outline-offset: 1px; }
/* WORKING / ARCHIVED: the same tabs and counts as the setup guide's. */
.sasha-candidate-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.sasha-candidate-tabs .sasha-tab { display: inline-flex; align-items: center; gap: 5px; }
/* "Show archived", inside a sentence: a quiet link. Archive / Restore are buttons styled like Open. */
.sasha-stack-archive { flex: none; cursor: pointer; border: 0; background: transparent; padding: 2px 4px; font: inherit; font-size: 11px; color: #5f6368; border-radius: 4px; }
.sasha-stack-archive:hover, .sasha-stack-archive:focus-visible { color: #1a73e8; text-decoration: underline; }
/* Archived rows read as set aside: dimmer, never hidden. */
.sasha-stack-archived .sasha-stack-slide { background: #fff; border-style: dashed; }
.sasha-stack-archived .sasha-thumb, .sasha-stack-archived .sasha-stack-label { opacity: .65; }
.sasha-candidates-empty { margin: 0; }
/* The last archived candidate stays in view on the working tab, with its way back. */
.sasha-last-archived { display: flex; align-items: center; gap: 6px; width: 100%; margin: 0; font-size: 11px; color: #5f6368; min-width: 0; }
.sasha-last-archived-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sasha-filter { display: flex; gap: 4px; flex-wrap: wrap; }
/* --- THUMBNAILS (slide-thumb.tsx): the candidate's own HTML at 64x36, in the set card, so the
   reader knows WHICH candidate without opening anything. Fixed width;
   the 16:9 height comes from .sasha-stage's aspect-ratio and ScaledHtmlFrame measures the width. */
.sasha-thumb { display: block; flex: none; width: 64px; border-radius: 3px; background: #fff; }
.sasha-thumb-wait { background: #f1f3f4; }
.sasha-thumb-none { background: repeating-linear-gradient(135deg, #f1f3f4 0 4px, #e8eaed 4px 8px); }
.sasha-header-spin { position: absolute; right: 0; top: 50%; margin-top: -6px; }
/* "Updating" while the panel shows the boot seed: absolute like the spinner, so it moves nothing. */
.sasha-header-refreshing { position: absolute; right: 0; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 400; color: #5f6368; }
.sasha-filter .sasha-tab { display: inline-flex; align-items: center; gap: 5px; }
.sasha-filter-count { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #e8eaed; color: #5f6368; font-size: 10px; font-weight: 600; }
.sasha-tab-on .sasha-filter-count { background: #1a73e8; color: #fff; }

/* --- ASK SASHA: the connection with the assistant, and the assets ---------------------------
   One column: the header, one connection line (or the setup guide), and the candidates card. */
.sasha-chat { display: flex; flex-direction: column; gap: 10px; }
/* THE CONNECTION LINE: a dot and a sentence. Green only on fresh evidence that something is
   listening; grey while the reads that could tell are not in. */
.sasha-connection { display: flex; flex-direction: column; gap: 2px; }
.sasha-connection-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: #202124; }
.sasha-connection-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; }
.sasha-connection-dot-on { background: #1e8e3e; }
.sasha-connection-hint { margin: 0 0 0 14px; }
.sasha-assets-empty { margin: 0; line-height: 1.45; }
/* THE OPENING STATE: one spinner, centred, and nothing else on screen. */
.sasha-opening { display: flex; align-items: center; justify-content: center; padding: 34px 0; margin: 0; }
.sasha-opening-ring { width: 22px; height: 22px; border-radius: 50%; border: 2px solid #dadce0; border-top-color: #1a73e8; animation: sashaSpin .8s linear infinite; }
@media (prefers-reduced-motion: reduce){ .sasha-opening-ring { animation: none; border-top-color: #dadce0; } }
/* --- NOBODY IS LISTENING (feedback-delivery.ts) ----------------------------------------------
   The one place in this product that asks the user to go and start something, so it is drawn as the
   loudest thing in the panel and sits above the explanation rather than below it.

   The two commands are <code> blocks on their own lines: the sidebar has no clipboard permission,
   so "copyable verbatim" can only mean "selectable without picking words out of a sentence", and
   user-select:all makes one click select a whole command. */
.sasha-nobody-listening { display: flex; flex-direction: column; gap: 6px; width: 100%; border: 1px solid #dadce0; border-left: 3px solid #f9ab00; background: #f8f9fa; border-radius: 6px; padding: 8px; }
.sasha-nobody-head { margin: 0; font-size: 12px; font-weight: 600; color: #3c4043; }
.sasha-setup-bots { display: flex; gap: 4px; flex-wrap: wrap; }
.sasha-setup-panel { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.5; color: #3c4043; }
.sasha-setup-steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.sasha-setup-missing { margin: 0; line-height: 1.5; }
.sasha-setup-inline { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
.sasha-copy-row { display: flex; align-items: flex-start; gap: 4px; margin-top: 4px; }
.sasha-copy-row .sasha-copyable { flex: 1; min-width: 0; }
.sasha-copy-button { flex: none; cursor: pointer; border: 1px solid #dadce0; border-radius: 4px; background: #fff; color: #1a73e8; padding: 5px 8px; font: inherit; font-size: 11px; }
.sasha-copy-button:hover { background: #e8f0fe; }
.sasha-copyable { display: block; user-select: all; font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; background: #fff; border: 1px solid #dadce0; border-radius: 4px; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
`;
