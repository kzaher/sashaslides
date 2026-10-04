// The selection chrome's CSS. It is injected into the HOST document, never into the candidate --
// the candidate's markup is what gets written back and converted, so the editor leaves no trace in
// it. One <style> element, removed by `detach()`.
//
// Class names are prefixed `sasha-ed-` so they cannot collide with the picker's own `sasha-`
// classes in the same document.

export const OVERLAY_CLASS_PREFIX = "sasha-ed";

export const OVERLAY_STYLE_ID = "sasha-ed-styles";

/** Slide-space pixels of chrome, so handles stay grabbable when the frame is scaled down. */
export const HANDLE_PX = 10;

export const OVERLAY_CSS = `
.${OVERLAY_CLASS_PREFIX}-root {
  position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
  font: 11px/1.3 "Google Sans", Roboto, Arial, sans-serif;
}
.${OVERLAY_CLASS_PREFIX}-hover {
  position: fixed; pointer-events: none; display: none;
  outline: 1px dashed rgba(26, 115, 232, 0.9); background: rgba(26, 115, 232, 0.06);
}
.${OVERLAY_CLASS_PREFIX}-select {
  position: fixed; pointer-events: auto; display: none; cursor: move;
  outline: 2px solid #1a73e8; background: rgba(26, 115, 232, 0.08);
  touch-action: none;
}
.${OVERLAY_CLASS_PREFIX}-select[data-editing="yes"] { display: none; }
.${OVERLAY_CLASS_PREFIX}-handle {
  position: absolute; width: ${HANDLE_PX}px; height: ${HANDLE_PX}px; margin: ${-HANDLE_PX / 2}px 0 0 ${-HANDLE_PX / 2}px;
  background: #ffffff; border: 2px solid #1a73e8; border-radius: 2px; pointer-events: auto;
  touch-action: none;
}
.${OVERLAY_CLASS_PREFIX}-handle[data-refused="yes"] { display: none; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="nw"] { left: 0; top: 0; cursor: nwse-resize; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="n"]  { left: 50%; top: 0; cursor: ns-resize; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="ne"] { left: 100%; top: 0; cursor: nesw-resize; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="e"]  { left: 100%; top: 50%; cursor: ew-resize; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="se"] { left: 100%; top: 100%; cursor: nwse-resize; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="s"]  { left: 50%; top: 100%; cursor: ns-resize; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="sw"] { left: 0; top: 100%; cursor: nesw-resize; }
.${OVERLAY_CLASS_PREFIX}-handle[data-edge="w"]  { left: 0; top: 50%; cursor: ew-resize; }
.${OVERLAY_CLASS_PREFIX}-bar {
  position: fixed; pointer-events: auto; display: none; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 6px; background: #202124; color: #e8eaed;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); white-space: nowrap;
}
.${OVERLAY_CLASS_PREFIX}-target {
  font-family: "Roboto Mono", Menlo, monospace; max-width: 220px; overflow: hidden; text-overflow: ellipsis;
}
.${OVERLAY_CLASS_PREFIX}-bar button {
  font: inherit; color: inherit; background: #3c4043; border: 0; border-radius: 4px;
  padding: 3px 7px; cursor: pointer;
}
.${OVERLAY_CLASS_PREFIX}-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
.${OVERLAY_CLASS_PREFIX}-bar input[type="color"] {
  width: 24px; height: 20px; padding: 0; border: 1px solid #5f6368; border-radius: 4px;
  background: none; cursor: pointer;
}
.${OVERLAY_CLASS_PREFIX}-bar input[type="color"]:disabled { opacity: 0.4; cursor: not-allowed; }
`;
