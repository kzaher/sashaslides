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

/* The living background: fixed, behind everything, never in the way of a click. */
.sasha-tide-ambient { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
.sasha-tide-ambient span { position: absolute; filter: blur(20px); opacity: .8; }
.sasha-tide-ambient span:nth-child(1) { left: -70px; top: 40px; width: 280px; height: 280px; background: linear-gradient(140deg, #a5f3fc, #c7d2fe); animation: sashaTideMorphA 30s ease-in-out infinite, sashaTideHue 120s ease-in-out infinite alternate; }
.sasha-tide-ambient span:nth-child(2) { right: -90px; top: 330px; width: 300px; height: 300px; background: linear-gradient(160deg, #fbcfe8, #ddd6fe); animation: sashaTideMorphB 36s ease-in-out infinite, sashaTideHue 140s ease-in-out -40s infinite alternate; }
.sasha-tide-ambient span:nth-child(3) { left: 20px; bottom: -110px; width: 260px; height: 240px; background: linear-gradient(120deg, #bbf7d0, #bae6fd); animation: sashaTideMorphA 44s ease-in-out infinite reverse, sashaTideHue 160s ease-in-out -80s infinite alternate; }
@keyframes sashaTideMorphA {
  0%, 100% { border-radius: 42% 58% 63% 37% / 41% 44% 56% 59%; transform: translate(0, 0) rotate(0deg); }
  33% { border-radius: 61% 39% 45% 55% / 55% 61% 39% 45%; transform: translate(30px, 40px) rotate(40deg); }
  66% { border-radius: 38% 62% 56% 44% / 63% 37% 63% 37%; transform: translate(-25px, 15px) rotate(-30deg); }
}
@keyframes sashaTideMorphB {
  0%, 100% { border-radius: 55% 45% 38% 62% / 47% 60% 40% 53%; transform: translate(0, 0) rotate(0deg); }
  50% { border-radius: 40% 60% 60% 40% / 60% 40% 60% 40%; transform: translate(-40px, -50px) rotate(-50deg); }
}
@keyframes sashaTideHue { 0% { filter: blur(20px) hue-rotate(0deg); } 100% { filter: blur(20px) hue-rotate(40deg); } }
@keyframes sashaTideShine { 0% { transform: translateX(-120%); } 60%, 100% { transform: translateX(260%); } }
@keyframes sashaTideBreathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.6); opacity: .35; } }

/* Header: the real logo beside the title. */
.sasha-tide .sasha-header { align-items: center; gap: 9px; padding: 2px 4px 4px; font-size: 18px; }
.sasha-tide .sasha-header strong { font-weight: 700; letter-spacing: -.2px; }
.sasha-tide-logo { display: inline-flex; width: 26px; height: 26px; flex: none; filter: drop-shadow(0 4px 10px rgba(60, 70, 120, .28)); }
.sasha-tide-logo svg { width: 100%; height: 100%; }

/* Liquid glass: translucent fill, bright top edge, soft lift. */
.sasha-tide .sasha-connection, .sasha-tide .sasha-artifact, .sasha-tide .sasha-nobody-listening {
  position: relative; overflow: hidden;
  border-radius: 22px; padding: 14px 16px;
  background: rgba(255, 255, 255, .42);
  border: 1px solid rgba(255, 255, 255, .85);
  box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, .95), inset 0 -1px 0 rgba(120, 130, 170, .18), 0 12px 32px rgba(80, 90, 140, .14);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  backdrop-filter: blur(24px) saturate(180%);
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

/* The assets card. */
.sasha-tide .sasha-artifact { gap: 10px; padding: 14px; }
.sasha-tide .sasha-artifact-head { font-size: 11px; font-weight: 700; color: #3d4659; }
.sasha-tide .sasha-tab { border-radius: 999px; border: 0; background: rgba(28, 35, 51, .07); color: #4b5468; padding: 5px 11px; font-size: 11.5px; }
.sasha-tide .sasha-tab-on { background: rgba(255, 255, 255, .95); color: #1c2333; font-weight: 700; box-shadow: 0 2px 6px rgba(28, 35, 51, .12); }
.sasha-tide .sasha-filter-count { background: rgba(28, 35, 51, .08); color: #3d4659; }
.sasha-tide .sasha-tab-on .sasha-filter-count { background: #1c2333; color: #fff; }
.sasha-tide .sasha-stack { gap: 8px; }
.sasha-tide .sasha-stack-slide { border-radius: 18px; padding: 8px; background: rgba(255, 255, 255, .55); border: 1px solid rgba(255, 255, 255, .9); }
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
