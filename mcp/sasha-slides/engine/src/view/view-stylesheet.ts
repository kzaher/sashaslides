// THE EDITOR'S OWN TIDEPOOL RULES, on top of the shared stylesheet (src/theme/tidepool-stylesheet.ts):
// the editor's layout -- top bar, toolbar, filmstrip, canvas, properties panel, speaker notes,
// comment rail -- and the parts only the editor has: thumbnails, selection handles, guides, presence
// cursors, comment pins, the script editor. The surfaces themselves (glass panels, popovers, scrim
// dialogs, ink pills, pill tabs, fields, notices) are the shared classes; this file only places and
// sizes them.
//
// Key decisions:
//
//  * ONLY `--sasha-` CUSTOM PROPERTIES FOR COLOURS. Every colour, shadow, radius and layer below is a
//    `var(--sasha-...)` from tidepool-theme.ts; view-stylesheet.test.ts rejects any colour literal
//    and any property that is not defined, the same gate the theme's own rules pass.
//  * NO BACKDROP FILTER. Panels are glass without blur (SPEC.md section 2): re-blurring the wash
//    behind full-height panels costs every frame of a drag.
//  * THE CALM WASH STAYS BEHIND THE CHROME. The editor root is the calm ground; the slide sits on it
//    with a lift shadow; anything over the slide is `glass-over-canvas`. The wash is drawn in the
//    editor's own box (not the viewport), so two editors side by side each keep theirs.
//  * MOTION ONLY UNDER `prefers-reduced-motion: no-preference`.
//  * CLASS NAMES ARE CONSTANTS (`VIEW_CLASS`), like the shared `TIDEPOOL_CLASS`, so a rename is a
//    compile error, not a silently unstyled control.

import { TIDEPOOL_CLASS } from "../theme/tidepool-stylesheet.ts";

export const VIEW_CLASS = {
  editor: "sasha-view-editor",
  icon: "sasha-view-icon",
  topBar: "sasha-view-top-bar",
  brand: "sasha-view-brand",
  brandMark: "sasha-view-brand-mark",
  deckTitle: "sasha-view-deck-title",
  menuBar: "sasha-view-menu-bar",
  menuButton: "sasha-view-menu-button",
  topActions: "sasha-view-top-actions",
  avatars: "sasha-view-avatars",
  avatar: "sasha-view-avatar",
  toolbar: "sasha-view-toolbar",
  toolbarGroup: "sasha-view-toolbar-group",
  toolbarDivider: "sasha-view-toolbar-divider",
  workspace: "sasha-view-workspace",
  filmstrip: "sasha-view-filmstrip",
  filmstripScroller: "sasha-view-filmstrip-scroller",
  thumbnail: "sasha-view-thumbnail",
  thumbnailNumber: "sasha-view-thumbnail-number",
  thumbnailFrame: "sasha-view-thumbnail-frame",
  thumbnailBadges: "sasha-view-thumbnail-badges",
  dropIndicator: "sasha-view-drop-indicator",
  centre: "sasha-view-centre",
  canvasArea: "sasha-view-canvas-area",
  canvasStage: "sasha-view-canvas-stage",
  slideFrame: "sasha-view-slide-frame",
  overlay: "sasha-view-overlay",
  overlaySvg: "sasha-view-overlay-svg",
  selectionBox: "sasha-view-selection-box",
  selectionLine: "sasha-view-selection-line",
  handle: "sasha-view-handle",
  rotationHandle: "sasha-view-rotation-handle",
  rotationStem: "sasha-view-rotation-stem",
  tableBoundary: "sasha-view-table-boundary",
  guide: "sasha-view-guide",
  marquee: "sasha-view-marquee",
  creationBox: "sasha-view-creation-box",
  peerSelection: "sasha-view-peer-selection",
  peerCursor: "sasha-view-peer-cursor",
  peerLabel: "sasha-view-peer-label",
  commentPin: "sasha-view-comment-pin",
  emptyState: "sasha-view-empty-state",
  notes: "sasha-view-notes",
  notesBody: "sasha-view-notes-body",
  /** The notes when not being edited: a click target that enters them. */
  notesReader: "sasha-view-notes-reader",
  sidePanel: "sasha-view-side-panel",
  panelHeader: "sasha-view-panel-header",
  panelBody: "sasha-view-panel-body",
  section: "sasha-view-section",
  sectionTitle: "sasha-view-section-title",
  fieldGrid: "sasha-view-field-grid",
  fieldRow: "sasha-view-field-row",
  fieldLabel: "sasha-view-field-label",
  numberInput: "sasha-view-number-input",
  select: "sasha-view-select",
  segmented: "sasha-view-segmented",
  explanation: "sasha-view-explanation",
  swatch: "sasha-view-swatch",
  swatches: "sasha-view-swatches",
  colourButton: "sasha-view-colour-button",
  popoverAnchor: "sasha-view-popover-anchor",
  menu: "sasha-view-menu",
  menuSeparator: "sasha-view-menu-separator",
  menuShortcut: "sasha-view-menu-shortcut",
  menuHint: "sasha-view-menu-hint",
  contextMenu: "sasha-view-context-menu",
  dialogLayer: "sasha-view-dialog-layer",
  dialogHeader: "sasha-view-dialog-header",
  dialogTitle: "sasha-view-dialog-title",
  dialogBody: "sasha-view-dialog-body",
  dialogActions: "sasha-view-dialog-actions",
  scriptDialog: "sasha-view-script-dialog",
  scriptEditor: "sasha-view-script-editor",
  scriptReference: "sasha-view-script-reference",
  conflict: "sasha-view-conflict",
  shortcutTable: "sasha-view-shortcut-table",
  layoutChoices: "sasha-view-layout-choices",
  commentRail: "sasha-view-comment-rail",
  thread: "sasha-view-thread",
  threadHeader: "sasha-view-thread-header",
  threadMessage: "sasha-view-thread-message",
  threadActions: "sasha-view-thread-actions",
  composer: "sasha-view-composer",
  textArea: "sasha-view-text-area",
  notices: "sasha-view-notices",
  noticeRow: "sasha-view-notice-row",
  presentationHost: "sasha-view-presentation-host",
  floatingLayer: "sasha-view-floating-layer",
  previewBox: "sasha-view-preview-box",
  sideBySide: "sasha-view-side-by-side",
  demoPane: "sasha-view-demo-pane",
  demoLabel: "sasha-view-demo-label",
  visuallyHidden: "sasha-view-visually-hidden",
} as const;

/** The editor's rules (see the header). Prepend `tidepoolStylesheet(TIDEPOOL_TOKENS)` once per page. */
export function viewStylesheet(): string {
  const c = VIEW_CLASS;
  return `
html, body { margin: 0; block-size: 100%; }
#sasha-root { block-size: 100%; }
.${c.editor} { container: sasha-editor / inline-size; position: relative; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: var(--sasha-space-small); height: 100%; min-height: 0; padding: var(--sasha-space-small); box-sizing: border-box; overflow: hidden; }
.${c.editor} *, .${c.editor} *::before, .${c.editor} *::after { box-sizing: border-box; }
.${TIDEPOOL_CLASS.root} { color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .${TIDEPOOL_CLASS.root} { color-scheme: dark; } }
:root[data-theme="dark"] .${TIDEPOOL_CLASS.root} { color-scheme: dark; }
.${c.editor} * { scrollbar-width: thin; scrollbar-color: var(--sasha-secondary-button-hover) transparent; }
.${c.icon} { inline-size: var(--sasha-control-icon-size); block-size: var(--sasha-control-icon-size); flex: none; vertical-align: middle; }
.${c.editor} .${TIDEPOOL_CLASS.primaryPill}, .${c.editor} .${TIDEPOOL_CLASS.secondaryPill}, .${c.editor} .${TIDEPOOL_CLASS.dangerPill} { display: inline-flex; align-items: center; justify-content: center; gap: var(--sasha-space-extra-small); }

.${c.topBar} { display: flex; align-items: center; gap: var(--sasha-space-medium); min-height: 52px; padding: var(--sasha-space-extra-small) var(--sasha-space-medium); }
.${c.brand} { display: flex; align-items: center; gap: var(--sasha-space-small); min-width: 0; }
.${c.brandMark} { inline-size: 30px; block-size: 30px; border-radius: var(--sasha-radius-control); display: grid; place-items: center; background: var(--sasha-ink-button); color: var(--sasha-ink-button-text); font-weight: var(--sasha-font-weight-bold); }
.${c.deckTitle} { margin: 0; font-size: var(--sasha-font-size-title); font-weight: var(--sasha-font-weight-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-inline-size: 280px; }
.${c.menuBar} { display: flex; gap: 2px; flex-wrap: wrap; }
.${c.menuButton} { min-height: 28px; padding: 0 var(--sasha-space-small); border: 0; border-radius: var(--sasha-radius-pill); background: transparent; color: var(--sasha-text-muted); cursor: pointer; }
.${c.menuButton}:hover, .${c.menuButton}[aria-expanded="true"] { background: var(--sasha-secondary-button); color: var(--sasha-text); }
.${c.topActions} { margin-inline-start: auto; display: flex; align-items: center; gap: var(--sasha-space-small); }
.${c.avatars} { display: flex; align-items: center; }
.${c.avatar} { inline-size: 28px; block-size: 28px; margin-inline-start: -6px; border-radius: 50%; display: grid; place-items: center; font-size: var(--sasha-font-size-caption); font-weight: var(--sasha-font-weight-bold); color: var(--sasha-peer-label-text); border: 2px solid var(--sasha-glass-edge); }
.${c.avatar}[data-away="true"] { opacity: var(--sasha-disabled-opacity); }

.${c.toolbar} { display: flex; align-items: center; gap: var(--sasha-space-extra-small); flex-wrap: wrap; padding: var(--sasha-space-extra-small) var(--sasha-space-small); }
.${c.toolbarGroup} { display: flex; align-items: center; gap: 2px; }
.${c.toolbarDivider} { inline-size: 1px; block-size: 22px; margin: 0 var(--sasha-space-extra-small); background: var(--sasha-hairline); }

.${c.workspace} { display: grid; grid-template-columns: 200px minmax(0, 1fr) 300px; gap: var(--sasha-space-small); min-height: 0; }
.${c.workspace}[data-filmstrip="closed"] { grid-template-columns: minmax(0, 1fr) 300px; }
.${c.workspace}[data-side="closed"] { grid-template-columns: 200px minmax(0, 1fr); }
.${c.workspace}[data-filmstrip="closed"][data-side="closed"] { grid-template-columns: minmax(0, 1fr); }
@container sasha-editor (max-width: 1100px) {
  .${c.workspace} { grid-template-columns: 150px minmax(0, 1fr) 250px; }
  .${c.workspace}[data-filmstrip="closed"] { grid-template-columns: minmax(0, 1fr) 250px; }
  .${c.workspace}[data-side="closed"] { grid-template-columns: 150px minmax(0, 1fr); }
  .${c.menuBar} { display: none; }
}
@media (max-width: 1023px) {
  .${c.workspace}, .${c.workspace}[data-filmstrip="closed"], .${c.workspace}[data-side="closed"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
  .${c.sidePanel} { max-block-size: 40vh; }
}

.${c.filmstrip} { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.${c.filmstripScroller} { position: relative; flex: 1; overflow-y: auto; overflow-x: hidden; padding: var(--sasha-space-small); }
.${c.thumbnail} { position: absolute; inset-inline: var(--sasha-space-small); display: grid; grid-template-columns: 18px 1fr; gap: var(--sasha-space-extra-small); align-items: start; cursor: pointer; border: 0; background: transparent; padding: 0; color: inherit; text-align: start; }
.${c.thumbnailNumber} { padding-block-start: 2px; font-size: var(--sasha-font-size-caption); color: var(--sasha-text-muted); text-align: end; }
.${c.thumbnailFrame} { position: relative; border-radius: var(--sasha-radius-control); overflow: hidden; outline: 2px solid transparent; outline-offset: 1px; box-shadow: var(--sasha-tab-on-shadow); }
.${c.thumbnail}[aria-selected="true"] .${c.thumbnailFrame} { outline-color: var(--sasha-selection); }
.${c.thumbnail}[data-current="true"] .${c.thumbnailNumber} { color: var(--sasha-accent); font-weight: var(--sasha-font-weight-bold); }
.${c.thumbnail}[data-skipped="true"] .${c.thumbnailFrame} { opacity: var(--sasha-disabled-opacity); }
.${c.thumbnailBadges} { position: absolute; inset-inline-end: 4px; inset-block-end: 4px; display: flex; gap: 3px; }
.${c.thumbnailBadges} > span { min-inline-size: 18px; block-size: 18px; padding: 0 4px; border-radius: var(--sasha-radius-pill); display: inline-grid; place-items: center; background: var(--sasha-glass-over-canvas); color: var(--sasha-text); font-size: var(--sasha-font-size-caption); }
.${c.thumbnailBadges} svg { inline-size: 12px; block-size: 12px; }
.${c.dropIndicator} { position: absolute; inset-inline: var(--sasha-space-small); block-size: 3px; border-radius: var(--sasha-radius-pill); background: var(--sasha-accent); }

.${c.centre} { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: var(--sasha-space-small); min-height: 0; min-width: 0; }
.${c.canvasArea} { position: relative; overflow: auto; min-height: 0; outline: none; border-radius: var(--sasha-radius-panel); }
.${c.canvasArea}:focus-visible { outline: var(--sasha-control-focus-ring-width) solid var(--sasha-focus-ring); outline-offset: -2px; }
.${c.canvasArea}[data-tool="insert"] { cursor: crosshair; }
.${c.canvasStage} { position: relative; }
.${c.slideFrame} { position: absolute; z-index: var(--sasha-layer-canvas); box-shadow: var(--sasha-lift-shadow); border-radius: 2px; }
.${c.emptyState} { position: absolute; inset: 0; display: grid; place-items: center; }

.${c.overlay} { position: absolute; inset: 0; z-index: var(--sasha-layer-canvas-overlay); pointer-events: none; }
.${c.overlaySvg} { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; overflow: visible; pointer-events: none; }
.${c.selectionBox} { position: absolute; transform-origin: 50% 50%; outline: var(--sasha-control-selection-width) solid var(--sasha-selection); box-shadow: 0 0 0 calc(var(--sasha-control-selection-width) + 1px) var(--sasha-selection-halo); pointer-events: none; }
.${c.selectionBox}[data-subtle="true"] { outline-style: dashed; box-shadow: none; }
.${c.selectionLine} { stroke: var(--sasha-selection); stroke-width: 1.5; stroke-dasharray: 4 3; }
.${c.handle} { position: absolute; inline-size: var(--sasha-control-handle-size); block-size: var(--sasha-control-handle-size); transform: translate(-50%, -50%); background: var(--sasha-handle-fill); border: 1.5px solid var(--sasha-selection); border-radius: 2px; pointer-events: auto; cursor: pointer; }
.${c.handle}[data-handle-name="topLeft"], .${c.handle}[data-handle-name="bottomRight"] { cursor: nwse-resize; }
.${c.handle}[data-handle-name="topRight"], .${c.handle}[data-handle-name="bottomLeft"] { cursor: nesw-resize; }
.${c.handle}[data-handle-name="top"], .${c.handle}[data-handle-name="bottom"] { cursor: ns-resize; }
.${c.handle}[data-handle-name="left"], .${c.handle}[data-handle-name="right"] { cursor: ew-resize; }
.${c.handle}[data-handle-name="start"], .${c.handle}[data-handle-name="end"] { border-radius: 50%; cursor: move; }
.${c.rotationStem} { position: absolute; inset-inline-start: 50%; inset-block-start: -22px; inline-size: 1px; block-size: 22px; background: var(--sasha-selection); }
.${c.rotationHandle} { position: absolute; inset-inline-start: 50%; inset-block-start: -26px; inline-size: 12px; block-size: 12px; transform: translate(-50%, -50%); border-radius: 50%; background: var(--sasha-handle-fill); border: 1.5px solid var(--sasha-selection); pointer-events: auto; cursor: grab; }
.${c.tableBoundary} { position: absolute; pointer-events: auto; }
.${c.tableBoundary}[data-axis="column"] { inset-block: 0; inline-size: 8px; margin-inline-start: -4px; cursor: col-resize; }
.${c.tableBoundary}[data-axis="row"] { inset-inline: 0; block-size: 8px; margin-block-start: -4px; cursor: row-resize; }
.${c.guide} { position: absolute; background: var(--sasha-accent); }
.${c.guide}[data-axis="vertical"] { inline-size: 1px; }
.${c.guide}[data-axis="horizontal"] { block-size: 1px; }
.${c.marquee} { position: absolute; border: 1px dashed var(--sasha-selection); background: var(--sasha-accent-soft); }
.${c.creationBox} { position: absolute; border: 1.5px solid var(--sasha-selection); background: var(--sasha-accent-soft); }
.${c.peerSelection} { position: absolute; transform-origin: 50% 50%; outline: 2px solid currentColor; outline-offset: 2px; }
.${c.peerCursor} { position: absolute; inline-size: 16px; block-size: 20px; pointer-events: none; }
.${c.peerCursor} > svg { display: block; inline-size: 16px; block-size: 20px; }
.${c.peerLabel} { position: absolute; inset-inline-start: 14px; inset-block-start: 16px; padding: 1px var(--sasha-space-small); border-radius: var(--sasha-radius-pill); color: var(--sasha-peer-label-text); font-size: var(--sasha-font-size-caption); font-weight: var(--sasha-font-weight-semibold); white-space: nowrap; }
.${c.peerCursor}[data-activity="idle"] { opacity: var(--sasha-disabled-opacity); }
.${c.commentPin} { position: absolute; inline-size: 26px; block-size: 26px; transform: translate(-30%, -70%); border-radius: 50% 50% 50% 4px; border: 1px solid var(--sasha-glass-edge); background: var(--sasha-glass-over-canvas); color: var(--sasha-accent); font-weight: var(--sasha-font-weight-bold); font-size: var(--sasha-font-size-caption); box-shadow: var(--sasha-lift-shadow); pointer-events: auto; cursor: pointer; }
.${c.commentPin}[data-resolved="true"] { color: var(--sasha-text-muted); }

.${c.notes} { display: flex; flex-direction: column; min-height: 0; max-block-size: 160px; padding: var(--sasha-space-small) var(--sasha-space-medium); }
.${c.notesBody} { overflow: auto; min-block-size: 48px; color: var(--sasha-text); }
.${c.notesReader} { min-block-size: 48px; cursor: text; border-radius: var(--sasha-radius-control); }
.${c.notesReader}:hover { background: var(--sasha-secondary-button); }

.${c.sidePanel} { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.${c.panelHeader} { padding: var(--sasha-space-medium) var(--sasha-space-medium) var(--sasha-space-small); }
.${c.panelBody} { flex: 1; overflow-y: auto; padding: 0 var(--sasha-space-medium) var(--sasha-space-medium); display: flex; flex-direction: column; gap: var(--sasha-space-small); }
.${c.section} { display: flex; flex-direction: column; gap: var(--sasha-space-small); }
.${c.sectionTitle} { margin: 0; font-size: var(--sasha-font-size-small); font-weight: var(--sasha-font-weight-bold); color: var(--sasha-text-muted); }
.${c.fieldGrid} { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sasha-space-small); }
.${c.fieldRow} { display: flex; align-items: center; gap: var(--sasha-space-small); flex-wrap: wrap; }
.${c.fieldLabel} { display: flex; flex-direction: column; gap: 2px; font-size: var(--sasha-font-size-caption); color: var(--sasha-text-muted); min-inline-size: 0; }
.${c.numberInput} { inline-size: 100%; min-inline-size: 0; color: var(--sasha-text); }
.${c.toolbar} .${c.select} { min-inline-size: 150px; }
.${c.select} { min-height: var(--sasha-control-height); padding: 0 var(--sasha-space-small); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); color: var(--sasha-text); min-inline-size: 0; }
.${c.segmented} { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--sasha-radius-pill); background: var(--sasha-secondary-button); }
.${c.explanation} { margin: 0; font-size: var(--sasha-font-size-caption); color: var(--sasha-text-subtle); }
.${c.swatches} { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--sasha-space-extra-small); }
/* A swatch shows a SLIDE colour, which may match the panel exactly (Dark 1 on the dark scheme), so its ring is the chrome's ink at a third. */
.${c.swatch} { inline-size: 100%; aspect-ratio: 1; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--sasha-text) 35%, transparent); cursor: pointer; padding: 0; }
.${c.swatch}[aria-pressed="true"] { outline: 2px solid var(--sasha-focus-ring); outline-offset: 1px; }
.${c.colourButton} { display: inline-flex; align-items: center; gap: var(--sasha-space-small); min-height: var(--sasha-control-height); padding: 0 var(--sasha-space-small); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-pill); background: var(--sasha-card-glass); color: var(--sasha-text); cursor: pointer; }
.${c.colourButton} > span:first-child { inline-size: 18px; block-size: 18px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--sasha-text) 35%, transparent); }
.${c.popoverAnchor} { position: relative; }

.${c.menu} { position: fixed; min-inline-size: 220px; max-block-size: 70vh; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.${c.menu} .${TIDEPOOL_CLASS.menuItem} { border: 0; text-align: start; inline-size: 100%; }
.${c.menu} .${TIDEPOOL_CLASS.menuItem}:not(:hover):not([data-active="true"]) { background: transparent; color: var(--sasha-text); }
.${c.menuSeparator} { block-size: 1px; margin: var(--sasha-space-extra-small) var(--sasha-space-small); background: var(--sasha-hairline); }
.${c.menuShortcut} { margin-inline-start: auto; color: var(--sasha-text-subtle); font-size: var(--sasha-font-size-caption); }
.${c.menuHint} { padding: 0 var(--sasha-space-medium) var(--sasha-space-extra-small); color: var(--sasha-text-subtle); font-size: var(--sasha-font-size-caption); }
.${c.contextMenu} { position: fixed; }

.${c.dialogLayer} { position: fixed; inset: 0; z-index: var(--sasha-layer-dialog); display: grid; place-items: center; padding: var(--sasha-space-large); pointer-events: none; }
.${c.dialogLayer} > .sasha-dialog { pointer-events: auto; inline-size: min(520px, 100%); max-block-size: 90vh; display: flex; flex-direction: column; gap: var(--sasha-space-medium); overflow: hidden; }
.${c.dialogLayer} > .${c.scriptDialog} { inline-size: min(1040px, 100%); }
.${c.dialogHeader} { display: flex; align-items: center; gap: var(--sasha-space-small); }
.${c.dialogTitle} { margin: 0; font-size: var(--sasha-font-size-heading); font-weight: var(--sasha-font-weight-bold); }
.${c.dialogBody} { display: flex; flex-direction: column; gap: var(--sasha-space-medium); overflow: auto; min-block-size: 0; }
.${c.dialogActions} { display: flex; justify-content: flex-end; gap: var(--sasha-space-small); flex-wrap: wrap; }
.${c.scriptEditor} { inline-size: 100%; min-block-size: 320px; resize: vertical; padding: var(--sasha-space-medium); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); color: var(--sasha-text); line-height: 1.5; tab-size: 2; white-space: pre; }
.${c.scriptReference} { margin: 0; padding: var(--sasha-space-medium); border-radius: var(--sasha-radius-control); background: var(--sasha-secondary-button); white-space: pre-wrap; max-block-size: 360px; overflow: auto; }
.${c.conflict} { padding: var(--sasha-space-small) var(--sasha-space-medium); border-radius: var(--sasha-radius-control); background: var(--sasha-accent-soft); color: var(--sasha-warning); }
.${c.shortcutTable} { inline-size: 100%; border-collapse: collapse; }
.${c.shortcutTable} td { padding: var(--sasha-space-extra-small) var(--sasha-space-small); border-block-end: 1px solid var(--sasha-hairline); }
.${c.shortcutTable} kbd { font-family: var(--sasha-code-font-family); font-size: var(--sasha-font-size-small); padding: 1px var(--sasha-space-extra-small); border-radius: var(--sasha-space-extra-small); background: var(--sasha-secondary-button); }
.${c.layoutChoices} { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sasha-space-small); }

.${c.commentRail} { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.${c.thread} { display: flex; flex-direction: column; gap: var(--sasha-space-small); cursor: pointer; }
.${c.thread}[data-focused="true"] { outline: var(--sasha-control-focus-ring-width) solid var(--sasha-focus-ring); outline-offset: 0; }
.${c.thread}[data-resolved="true"] { opacity: 0.8; }
.${c.threadHeader} { display: flex; align-items: center; gap: var(--sasha-space-small); }
.${c.threadMessage} { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.${c.threadActions} { display: flex; gap: var(--sasha-space-extra-small); flex-wrap: wrap; }
.${c.composer} { display: flex; flex-direction: column; gap: var(--sasha-space-small); }
.${c.textArea} { inline-size: 100%; min-block-size: 72px; padding: var(--sasha-space-small); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); color: var(--sasha-text); resize: vertical; }

.${c.notices} { position: fixed; inset-inline-start: var(--sasha-space-large); inset-block-end: var(--sasha-space-large); z-index: var(--sasha-layer-notice); display: flex; flex-direction: column-reverse; gap: var(--sasha-space-small); max-inline-size: min(420px, calc(100vw - 32px)); }
.${c.noticeRow} { display: flex; align-items: center; gap: var(--sasha-space-small); }
.${c.noticeRow} > p { margin: 0; flex: 1; }

.${c.floatingLayer} { position: fixed; inset: 0; z-index: var(--sasha-layer-popover); pointer-events: none; }
.${c.floatingLayer}:empty { display: none; }
.${c.floatingLayer} > * { pointer-events: auto; }
.${c.presentationHost} { position: fixed; inset: 0; z-index: var(--sasha-layer-presenter); display: none; }
.${c.presentationHost}[data-active="true"] { display: block; }
.${c.previewBox} { border-radius: var(--sasha-radius-control); overflow: hidden; box-shadow: var(--sasha-tab-on-shadow); }

.${c.sideBySide} { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sasha-space-small); block-size: 100vh; padding: var(--sasha-space-small); box-sizing: border-box; }
.${c.demoPane} { position: relative; min-inline-size: 0; min-block-size: 0; display: flex; flex-direction: column; }
.${c.demoPane} > .${c.editor} { flex: 1; padding: 0; }
.${c.demoLabel} { font-family: var(--sasha-font-family); margin: 0 0 var(--sasha-space-extra-small); font-size: var(--sasha-font-size-small); color: var(--sasha-text-muted); }
.${c.visuallyHidden} { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

@media (prefers-reduced-motion: no-preference) {
  .${c.menu}, .${c.contextMenu} { animation: sasha-view-pop var(--sasha-chrome-transition-duration) ease-out; }
  .${c.thumbnailFrame} { transition: outline-color var(--sasha-chrome-transition-duration) ease; }
  .${c.peerCursor} { transition: left 80ms linear, top 80ms linear; }
}
@keyframes sasha-view-pop { 0% { opacity: 0; transform: translateY(-4px); } 100% { opacity: 1; transform: none; } }
`;
}
