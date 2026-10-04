// The picker's styles, as one string rendered into the shadow root by <Shell>. It lives in a shadow
// root so that nothing here can be reached by -- or reach -- Google Slides' own stylesheet, which
// is the only way to put a panel on that page without a specificity war.

export const PICKER_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: Roboto, Arial, sans-serif; }
.sasha-shell {
  position: fixed; inset: auto 16px 16px auto; z-index: 2147483000;
  width: min(760px, calc(100vw - 32px));
  color: #202124; background: #fff;
  border: 1px solid #dadce0; border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 14px 16px;
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
  padding: 4px 10px; font-size: 12px; max-width: 220px;
}
.sasha-chip-on { border-color: #1a73e8; background: #e8f0fe; }
.sasha-chip:disabled { cursor: default; opacity: .6; }
.sasha-chip-number { font-weight: 700; }
.sasha-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sasha-chip-flag { color: #c5221f; font-weight: 700; }
.sasha-toggle { display: flex; gap: 4px; }
.sasha-tab {
  cursor: pointer; border: 1px solid #dadce0; background: #fff;
  border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
.sasha-tab-on { border-color: #1a73e8; color: #1a73e8; font-weight: 600; }
.sasha-pane { width: 100%; }
/* 16:9, so the 1280x720 document and the 720x405pt page are the same box on screen. */
.sasha-stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #f1f3f4; border: 1px solid #dadce0; overflow: hidden; }
.sasha-frame { position: absolute; inset: 0; width: 1280px; height: 720px; border: 0; transform-origin: top left; }
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
.sasha-overlay { position: absolute; inset: 0; cursor: crosshair; }
.sasha-overlay-off { cursor: default; }
.sasha-mark { position: absolute; pointer-events: none; }
.sasha-mark-user { border: 2px solid #c5221f; background: rgba(197,34,31,.12); }
.sasha-mark-converter { border: 2px dashed #e37400; background: rgba(227,116,0,.12); }
.sasha-mark-drag { border: 2px dotted #202124; background: rgba(32,33,36,.08); }
.sasha-anomalies { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 128px; overflow-y: auto; font-size: 12px; }
.sasha-anomaly { display: flex; align-items: center; gap: 6px; }
.sasha-source { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
.sasha-source-user { color: #c5221f; }
.sasha-source-converter { color: #e37400; }
.sasha-note { flex: 1 1 auto; min-width: 0; font-size: 12px; padding: 3px 6px; border: 1px solid #dadce0; border-radius: 4px; }
.sasha-drop { cursor: pointer; border: 0; background: transparent; color: #5f6368; font-size: 13px; }
.sasha-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.sasha-actions .sasha-dim { margin-right: auto; }
.sasha-primary { cursor: pointer; border: 0; border-radius: 6px; background: #1a73e8; color: #fff; padding: 7px 14px; font-size: 13px; font-weight: 600; }
.sasha-secondary { cursor: pointer; border: 1px solid #dadce0; border-radius: 6px; background: #fff; padding: 7px 14px; font-size: 13px; }
.sasha-primary:disabled, .sasha-secondary:disabled { opacity: .5; cursor: default; }
`;
