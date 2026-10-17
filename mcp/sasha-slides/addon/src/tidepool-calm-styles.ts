// THE SLIDES WINDOW'S LOOK: Tidepool, calmer. Asked for 2026-10-14: "the popup should also have the
// same style, but with different animated background perhaps, something more subtle, just colour
// transitions". So the sidebar's glass, pills and ink buttons (tidepool-styles.ts), over a ground
// whose pastel wash only changes colour -- nothing drifts behind slides the user is comparing.
//
// DIALOG ONLY, scoped under `.sasha-calm`. Dialog.html is the surface nearest its 500 KB budget, so
// this stays small and is minified by build-addon.ts like the other stylesheets. No backdrop
// filter: the candidates are live iframes, and blurring behind several of them costs every frame.

export const TIDEPOOL_CALM_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap");

html, body { background: #eef1f6; }
.sasha-calm { position: relative; isolation: isolate; background: transparent; color: #1c2333; }
.sasha-calm, .sasha-calm button, .sasha-calm input, .sasha-calm textarea { font-family: Manrope, Roboto, Arial, sans-serif; }

/* The ground: one soft wash whose colours slowly turn, never move. */
.sasha-calm::before {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background:
    radial-gradient(60% 70% at 10% 15%, #c7f0fb 0%, rgba(199, 240, 251, 0) 70%),
    radial-gradient(55% 65% at 92% 30%, #f6d4ec 0%, rgba(246, 212, 236, 0) 70%),
    radial-gradient(70% 60% at 50% 100%, #d4f5e2 0%, rgba(212, 245, 226, 0) 70%),
    #eef1f6;
  animation: sashaCalmHue 40s ease-in-out infinite alternate;
}
@keyframes sashaCalmHue { 0% { filter: hue-rotate(0deg) saturate(1); } 100% { filter: hue-rotate(70deg) saturate(1.15); } }
@media (prefers-reduced-motion: reduce) { .sasha-calm::before { animation: none; } }

/* Candidate cells: the slide stays as it is; its frame becomes glass. */
.sasha-calm .sasha-cell { gap: 6px; padding: 8px; border-radius: 20px; background: rgba(255, 255, 255, .45); border: 1px solid rgba(255, 255, 255, .9); box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), 0 10px 26px rgba(80, 90, 140, .12); }
.sasha-calm .sasha-cell-stage { border: 2px solid rgba(255, 255, 255, .9); border-radius: 12px; overflow: hidden; }
.sasha-calm .sasha-cell-on > .sasha-cell-stage, .sasha-calm .sasha-cell:hover > .sasha-cell-stage { border-color: #6366f1; }
.sasha-calm .sasha-cell-number { background: #1c2333; color: #fff; }
.sasha-calm .sasha-cell-open:focus-visible { outline-color: #4338ca; }

/* Buttons and tabs: ink pills, as in the sidebar. */
.sasha-calm .sasha-primary { border-radius: 999px; background: #1c2333; color: #fff; }
.sasha-calm .sasha-primary:hover { background: #2d3650; }
.sasha-calm .sasha-secondary { border-radius: 999px; border: 0; background: rgba(28, 35, 51, .07); color: #1c2333; }
.sasha-calm .sasha-secondary:hover { background: rgba(28, 35, 51, .12); }
.sasha-calm .sasha-tab { border-radius: 999px; border: 0; background: rgba(28, 35, 51, .07); color: #4b5468; }
.sasha-calm .sasha-tab-on { background: rgba(255, 255, 255, .95); color: #1c2333; font-weight: 700; box-shadow: 0 2px 6px rgba(28, 35, 51, .12); }
.sasha-calm .sasha-dim { color: #3d4659; }
.sasha-calm a { color: #4338ca; }
.sasha-calm .sasha-loader-ring, .sasha-calm .sasha-header-spin { border-color: rgba(28, 35, 51, .12); border-top-color: #4338ca; }
`;
