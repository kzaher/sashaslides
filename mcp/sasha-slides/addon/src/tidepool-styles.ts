// THE SIDEBAR'S LOOK: "Tidepool", chosen by the user on 2026-10-14 from four proposals. A pearl
// ground with three pastel shapes that drift and change form behind liquid-glass cards: alive, but
// slow enough to soothe (30-44 s per shape, minutes per colour swing). The website
// (renderer/html2slides/addon-server/public/site.css) wears the same look.
//
// SIDEBAR ONLY. It is layered after picker-styles.ts and scoped under `.sasha-tide`, so the slides
// window and the defect report -- Dialog.html sits close to its 500 KB budget -- neither carry nor
// change. build-addon.ts minifies it like the other stylesheets.
//
// Motion stops for anyone who prefers reduced motion; the glass and colours stay.

export const TIDEPOOL_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap");

html, body { background: #eef1f6; }
.sasha-tide { position: relative; isolation: isolate; min-height: 100vh; background: transparent; color: #1c2333; }
.sasha-tide, .sasha-tide * { font-family: Manrope, Roboto, Arial, sans-serif; }

/* The living background: fixed, behind everything, never in the way of a click.
   ALIVE, NOT BUSY. Measured 2026-10-14 on the first version: shapes of ~300 px drifting +-40 px
   over 30-44 s and rotating read as a still picture -- a blurred round blob that turns looks
   identical, and the glass hid the rest. So the shapes now cross most of the panel (vw/vh, which
   in the sidebar's frame are the panel's own size), swell and shrink, and their colours swing in
   tens of seconds instead of minutes; each still moves at a walking pace for the eye. */
.sasha-tide-ambient { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
.sasha-tide-ambient span { position: absolute; width: 80vw; height: 80vw; filter: blur(26px); opacity: .85; will-change: transform; }
.sasha-tide-ambient span:nth-child(1) { left: -30vw; top: -10vh; background: radial-gradient(circle at 40% 40%, #67e8f9, #a5b4fc 70%); animation: sashaTideDriftA 14s ease-in-out infinite alternate, sashaTideHue 24s ease-in-out infinite alternate; }
.sasha-tide-ambient span:nth-child(2) { right: -35vw; top: 25vh; background: radial-gradient(circle at 50% 50%, #f9a8d4, #c4b5fd 70%); animation: sashaTideDriftB 17s ease-in-out infinite alternate, sashaTideHue 30s ease-in-out -8s infinite alternate; }
.sasha-tide-ambient span:nth-child(3) { left: -20vw; bottom: -25vh; background: radial-gradient(circle at 50% 50%, #86efac, #7dd3fc 70%); animation: sashaTideDriftC 20s ease-in-out infinite alternate, sashaTideHue 27s ease-in-out -15s infinite alternate; }
.sasha-tide-ambient span:nth-child(4) { right: -25vw; top: -15vh; width: 60vw; height: 60vw; background: radial-gradient(circle at 50% 50%, #fde68a, #fdba74 70%); opacity: .6; animation: sashaTideDriftC 19s ease-in-out -6s infinite alternate-reverse, sashaTideHue 33s ease-in-out -20s infinite alternate; }
.sasha-tide-ambient span:nth-child(5) { left: 10vw; top: 55vh; width: 55vw; height: 55vw; background: radial-gradient(circle at 50% 50%, #a5b4fc, #67e8f9 70%); opacity: .7; animation: sashaTideDriftA 16s ease-in-out -9s infinite alternate-reverse, sashaTideHue 21s ease-in-out -4s infinite alternate; }
@keyframes sashaTideDriftA {
  0% { border-radius: 42% 58% 63% 37% / 41% 44% 56% 59%; transform: translate(0, 0) scale(.85); }
  50% { border-radius: 61% 39% 45% 55% / 55% 61% 39% 45%; transform: translate(45vw, 30vh) scale(1.25); }
  100% { border-radius: 38% 62% 56% 44% / 63% 37% 63% 37%; transform: translate(15vw, 55vh) scale(.95); }
}
@keyframes sashaTideDriftB {
  0% { border-radius: 55% 45% 38% 62% / 47% 60% 40% 53%; transform: translate(0, 0) scale(1.15); }
  50% { border-radius: 40% 60% 60% 40% / 60% 40% 60% 40%; transform: translate(-50vw, -20vh) scale(.8); }
  100% { border-radius: 63% 37% 45% 55% / 40% 58% 42% 60%; transform: translate(-25vw, 30vh) scale(1.2); }
}
@keyframes sashaTideDriftC {
  0% { border-radius: 48% 52% 60% 40% / 52% 40% 60% 48%; transform: translate(0, 0) scale(1); }
  50% { border-radius: 60% 40% 40% 60% / 40% 60% 40% 60%; transform: translate(40vw, -35vh) scale(1.3); }
  100% { border-radius: 40% 60% 55% 45% / 60% 45% 55% 40%; transform: translate(10vw, -60vh) scale(.85); }
}
@keyframes sashaTideHue { 0% { filter: blur(26px) hue-rotate(0deg); } 100% { filter: blur(26px) hue-rotate(90deg); } }
@keyframes sashaTideShine { 0% { transform: translateX(-120%); } 60%, 100% { transform: translateX(260%); } }
@keyframes sashaTideBreathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.6); opacity: .35; } }

/* Header: the real logo beside the title. */
.sasha-tide .sasha-header { align-items: center; gap: 9px; padding: 2px 4px 4px; font-size: 18px; }
.sasha-tide .sasha-header strong { font-weight: 700; letter-spacing: -.2px; }
.sasha-tide-logo { display: inline-flex; width: 26px; height: 26px; flex: none; filter: drop-shadow(0 4px 10px rgba(60, 70, 120, .28)); }
.sasha-tide-logo svg { width: 100%; height: 100%; }

/* Liquid glass: translucent fill, bright top edge, soft lift. */
.sasha-tide .sasha-connection, .sasha-tide .sasha-artifact, .sasha-tide .sasha-nobody-listening, .sasha-tide .sasha-comment-access {
  position: relative; overflow: hidden;
  border-radius: 22px; padding: 14px 16px;
  background: rgba(255, 255, 255, .26);
  border: 1px solid rgba(255, 255, 255, .8);
  box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), inset 0 -1px 0 rgba(120, 130, 170, .18), 0 12px 32px rgba(80, 90, 140, .14);
  -webkit-backdrop-filter: blur(12px) saturate(170%);
  backdrop-filter: blur(12px) saturate(170%);
}
.sasha-tide .sasha-connection::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 45%; pointer-events: none; background: linear-gradient(100deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, .55), rgba(255, 255, 255, 0)); transform: translateX(-120%); animation: sashaTideShine 9s ease-in-out infinite; }
.sasha-tide .sasha-chat { gap: 12px; }
.sasha-tide .sasha-connection { gap: 6px; }
.sasha-tide .sasha-connection-line { font-size: 14px; font-weight: 600; color: #1c2333; gap: 9px; }
.sasha-tide .sasha-connection-dot { position: relative; width: 10px; height: 10px; }
.sasha-tide .sasha-connection-dot-on { background: #059669; }
.sasha-tide .sasha-connection-dot-on::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: #34d399; animation: sashaTideBreathe 3.6s ease-in-out infinite; }
.sasha-tide .sasha-connection-hint { margin-left: 19px; }
.sasha-tide .sasha-dim { color: #3d4659; }

/* "Let Sasha answer comments": a small glass card under the connection, only when it is needed. */
.sasha-tide .sasha-comment-access { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; }
.sasha-tide .sasha-comment-access-line { margin: 0; font-size: 13.5px; font-weight: 600; color: #1c2333; }
.sasha-tide .sasha-comment-access-hint, .sasha-tide .sasha-comment-access-note { margin: 0; font-size: 12px; }
.sasha-tide .sasha-comment-access-note { padding: 0 6px; }
.sasha-tide .sasha-comment-access-allow { align-self: flex-start; margin-top: 6px; padding: 6px 16px; font-size: 12.5px; font-weight: 600; text-decoration: none; }
.sasha-tide .sasha-comment-access-allow:hover, .sasha-tide .sasha-comment-access-allow:focus-visible { color: #fff; background: #4338ca; text-decoration: none; }

/* The assets card. */
.sasha-tide .sasha-artifact { gap: 10px; padding: 14px; }
.sasha-tide .sasha-artifact-head { font-size: 11px; font-weight: 700; color: #3d4659; }
.sasha-tide .sasha-tab { border-radius: 999px; border: 0; background: rgba(28, 35, 51, .07); color: #4b5468; padding: 5px 11px; font-size: 11.5px; }
.sasha-tide .sasha-tab-on { background: rgba(255, 255, 255, .95); color: #1c2333; font-weight: 700; box-shadow: 0 2px 6px rgba(28, 35, 51, .12); }
.sasha-tide .sasha-filter-count { background: rgba(28, 35, 51, .08); color: #3d4659; }
.sasha-tide .sasha-tab-on .sasha-filter-count { background: #1c2333; color: #fff; }
.sasha-tide .sasha-stack { gap: 8px; }
.sasha-tide .sasha-stack-slide { border-radius: 18px; padding: 8px; background: rgba(255, 255, 255, .5); border: 1px solid rgba(255, 255, 255, .9); }
.sasha-tide .sasha-stack-archived .sasha-stack-slide { border-style: dashed; border-color: rgba(28, 35, 51, .18); background: rgba(255, 255, 255, .3); }
.sasha-tide .sasha-stack-label { font-size: 13px; font-weight: 600; }
.sasha-tide .sasha-stack-number { background: #1c2333; }
.sasha-tide .sasha-stack-thumb { border-radius: 10px; overflow: hidden; }
.sasha-tide .sasha-primary { border-radius: 999px; background: #1c2333; color: #fff; }
.sasha-tide .sasha-secondary { border-radius: 999px; border: 0; background: rgba(28, 35, 51, .07); color: #1c2333; }
.sasha-tide .sasha-stack-archive { border-radius: 999px; padding: 3px 8px; color: #3d4659; }
.sasha-tide .sasha-stack-archive:hover, .sasha-tide .sasha-stack-archive:focus-visible { color: #4338ca; background: rgba(67, 56, 202, .08); text-decoration: none; }
.sasha-tide a { color: #4338ca; }
.sasha-tide .sasha-opening-ring, .sasha-tide .sasha-header-spin { border-color: rgba(28, 35, 51, .12); border-top-color: #4338ca; }

@media (prefers-reduced-motion: reduce) {
  .sasha-tide-ambient span, .sasha-tide .sasha-connection::after, .sasha-tide .sasha-connection-dot-on::before { animation: none; }
}
`;
