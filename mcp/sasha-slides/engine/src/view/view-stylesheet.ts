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
//  * NO BACKDROP FILTER HERE. The panels' liquid-glass blur is the shared stylesheet's, gated on no
//    gesture being active (tidepool-stylesheet.ts); nothing in the editor's own rules blurs, so a
//    drag never re-blurs the wash (SPEC.md 21.11).
//  * THE CALM WASH STAYS BEHIND THE CHROME. The editor root is the calm ground; the slide sits on it
//    with a lift shadow; anything over the slide is `glass-over-canvas`. The wash is drawn in the
//    editor's own box (not the viewport), so two editors side by side each keep theirs.
//  * MOTION ONLY UNDER `prefers-reduced-motion: no-preference`.
//  * NOTICES STACK IN THE END CORNER, NOT OVER THE SLIDE. A column as wide as the side panel sits on
//    the panel's bottom (bottom-right), placed in the editor's own box (`position: absolute`, so the
//    add-on's smaller dialog keeps it inside its frame), newest nearest the corner, and scrolls past
//    half the editor's height instead of climbing over the canvas.
//  * CLASS NAMES ARE CONSTANTS (`VIEW_CLASS`), like the shared `TIDEPOOL_CLASS`, so a rename is a
//    compile error, not a silently unstyled control.

import { TIDEPOOL_CLASS } from "../theme/tidepool-stylesheet.ts";

export const VIEW_CLASS = {
  editor: "sasha-view-editor",
  icon: "sasha-view-icon",
  topBar: "sasha-view-top-bar",
  brand: "sasha-view-brand",
  /** The real Sasha Slides logo (http/sasha-icon.generated.ts) and the link around it. */
  logo: "sasha-view-logo",
  logoLink: "sasha-view-logo-link",
  brandText: "sasha-view-brand-text",
  deckTitle: "sasha-view-deck-title",
  statusLine: "sasha-view-status-line",
  /** The connection line: "Offline - reconnecting in 8 s - Try now"; `data-tone` says how loud. */
  connection: "sasha-view-connection",
  /** A text-sized action inside a line of text: Try now, Edit, Delete. */
  inlineAction: "sasha-view-inline-action",
  roleBadge: "sasha-view-role-badge",
  hostAccessory: "sasha-view-host-accessory",
  avatarStack: "sasha-view-avatar-stack",
  avatarMore: "sasha-view-avatar-more",
  peerPopover: "sasha-view-peer-popover",
  peerList: "sasha-view-peer-list",
  /** The read-only banner under the top bar while the connection is closed. */
  readOnlyBanner: "sasha-view-read-only-banner",
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
  thumbnailAvatar: "sasha-view-thumbnail-avatar",
  dropIndicator: "sasha-view-drop-indicator",
  centre: "sasha-view-centre",
  canvasArea: "sasha-view-canvas-area",
  canvasStage: "sasha-view-canvas-stage",
  slideFrame: "sasha-view-slide-frame",
  overlay: "sasha-view-overlay",
  overlayDrawing: "sasha-view-overlay-drawing",
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
  /** The properties tab body; disabled (with every control in it) while this person cannot edit. */
  panelFieldset: "sasha-view-panel-fieldset",
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
  /** A heading inside the rail: "On deleted slides". */
  railSection: "sasha-view-rail-section",
  /** "@Grace Hopper" inside a message. */
  mention: "sasha-view-mention",
  mentionPicker: "sasha-view-mention-picker",
  /** "Claude" next to the agent's name. */
  agentLabel: "sasha-view-agent-label",
  messageMeta: "sasha-view-message-meta",
  messageActions: "sasha-view-message-actions",
  /** The list style picker's grid of the 12 glyph presets. */
  glyphGrid: "sasha-view-glyph-grid",
  glyphChoice: "sasha-view-glyph-choice",
  gradientPreview: "sasha-view-gradient-preview",
  gradientStops: "sasha-view-gradient-stops",
  gradientStopRow: "sasha-view-gradient-stop-row",
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
  const classes = VIEW_CLASS;
  return `
html, body { margin: 0; block-size: 100%; }
#sasha-root { block-size: 100%; }
.${classes.editor} { container: sasha-editor / inline-size; position: relative; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: var(--sasha-space-small); height: 100%; min-height: 0; padding: var(--sasha-space-small); box-sizing: border-box; overflow: hidden; }
.${classes.editor}[data-banner="true"] { grid-template-rows: auto auto auto minmax(0, 1fr); }
.${classes.editor} *, .${classes.editor} *::before, .${classes.editor} *::after { box-sizing: border-box; }
.${TIDEPOOL_CLASS.root} { color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .${TIDEPOOL_CLASS.root} { color-scheme: dark; } }
:root[data-theme="dark"] .${TIDEPOOL_CLASS.root} { color-scheme: dark; }
.${classes.editor} * { scrollbar-width: thin; scrollbar-color: var(--sasha-secondary-button-hover) transparent; }
.${classes.icon} { inline-size: var(--sasha-control-icon-size); block-size: var(--sasha-control-icon-size); flex: none; vertical-align: middle; }
.${classes.editor} .${TIDEPOOL_CLASS.primaryPill}, .${classes.editor} .${TIDEPOOL_CLASS.secondaryPill}, .${classes.editor} .${TIDEPOOL_CLASS.dangerPill} { display: inline-flex; align-items: center; justify-content: center; gap: var(--sasha-space-extra-small); }

.${classes.topBar} { display: flex; align-items: center; gap: var(--sasha-space-medium); min-height: 52px; padding: var(--sasha-space-extra-small) var(--sasha-space-medium); }
.${classes.brand} { display: flex; align-items: center; gap: var(--sasha-space-small); min-width: 0; }
/* The brand mark is a dark squircle; a hairline glass ring keeps it legible on the dark scheme's glass. */
.${classes.logoLink} { flex: none; display: inline-grid; place-items: center; inline-size: 34px; block-size: 34px; border-radius: var(--sasha-radius-control); box-shadow: 0 0 0 1px var(--sasha-glass-edge); }
.${classes.logo}, .${classes.logo} > svg { display: block; inline-size: 34px; block-size: 34px; }
.${classes.brandText} { display: flex; flex-direction: column; min-width: 0; }
.${classes.statusLine} { display: flex; align-items: center; gap: var(--sasha-space-small); flex-wrap: wrap; }
.${classes.connection} { display: inline-flex; align-items: center; gap: var(--sasha-space-extra-small); font-size: var(--sasha-font-size-caption); color: var(--sasha-text-muted); }
.${classes.connection}[data-tone="warning"] { color: var(--sasha-warning); font-weight: var(--sasha-font-weight-semibold); }
.${classes.inlineAction} { border: 0; padding: 0 var(--sasha-space-extra-small); background: transparent; color: var(--sasha-accent); font-size: inherit; font-weight: var(--sasha-font-weight-bold); text-decoration: underline; cursor: pointer; }
.${classes.roleBadge} { padding: 2px var(--sasha-space-small); border-radius: var(--sasha-radius-pill); background: var(--sasha-accent-soft); color: var(--sasha-accent); font-size: var(--sasha-font-size-caption); font-weight: var(--sasha-font-weight-semibold); white-space: nowrap; }
.${classes.hostAccessory} { display: flex; align-items: center; gap: var(--sasha-space-small); }
.${classes.avatarStack} { display: flex; align-items: center; padding: 2px 4px 2px 10px; border: 0; border-radius: var(--sasha-radius-pill); background: transparent; cursor: pointer; }
.${classes.avatarStack}:hover, .${classes.avatarStack}[aria-expanded="true"] { background: var(--sasha-secondary-button); }
.${classes.avatarMore} { margin-inline-start: var(--sasha-space-extra-small); font-size: var(--sasha-font-size-caption); color: var(--sasha-text-muted); }
.${classes.peerPopover} { position: fixed; min-inline-size: 240px; }
.${classes.peerList} { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.${classes.peerList} .${TIDEPOOL_CLASS.menuItem} { inline-size: 100%; border: 0; background: transparent; color: var(--sasha-text); text-align: start; }
.${classes.peerList} .${TIDEPOOL_CLASS.menuItem}:hover:not([disabled]) { background: var(--sasha-accent-soft); color: var(--sasha-accent); }
.${classes.readOnlyBanner} { display: flex; align-items: center; gap: var(--sasha-space-small); padding: var(--sasha-space-small) var(--sasha-space-medium); border-radius: var(--sasha-radius-card); background: var(--sasha-glass-over-canvas); border: 1px solid var(--sasha-glass-edge); color: var(--sasha-text); font-weight: var(--sasha-font-weight-semibold); }
.${classes.readOnlyBanner} > strong { color: var(--sasha-warning); }
.${classes.deckTitle} { margin: 0; font-size: var(--sasha-font-size-title); font-weight: var(--sasha-font-weight-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-inline-size: 280px; }
.${classes.menuBar} { display: flex; gap: 2px; flex-wrap: wrap; }
.${classes.menuButton} { min-height: 28px; padding: 0 var(--sasha-space-small); border: 0; border-radius: var(--sasha-radius-pill); background: transparent; color: var(--sasha-text-muted); cursor: pointer; }
.${classes.menuButton}:hover, .${classes.menuButton}[aria-expanded="true"] { background: var(--sasha-secondary-button); color: var(--sasha-text); }
.${classes.topActions} { margin-inline-start: auto; display: flex; align-items: center; gap: var(--sasha-space-small); }
.${classes.avatars} { display: flex; align-items: center; }
.${classes.avatar} { inline-size: 28px; block-size: 28px; margin-inline-start: -6px; border-radius: 50%; display: grid; place-items: center; font-size: var(--sasha-font-size-caption); font-weight: var(--sasha-font-weight-bold); color: var(--sasha-peer-label-text); border: 2px solid var(--sasha-glass-edge); }
.${classes.avatar}[data-away="true"] { opacity: var(--sasha-disabled-opacity); }

.${classes.toolbar} { display: flex; align-items: center; gap: var(--sasha-space-extra-small); flex-wrap: wrap; padding: var(--sasha-space-extra-small) var(--sasha-space-small); }
.${classes.toolbarGroup} { display: flex; align-items: center; gap: 2px; }
.${classes.toolbarDivider} { inline-size: 1px; block-size: 22px; margin: 0 var(--sasha-space-extra-small); background: var(--sasha-hairline); }

.${classes.workspace} { display: grid; grid-template-columns: 200px minmax(0, 1fr) 300px; gap: var(--sasha-space-small); min-height: 0; }
.${classes.workspace}[data-filmstrip="closed"] { grid-template-columns: minmax(0, 1fr) 300px; }
.${classes.workspace}[data-side="closed"] { grid-template-columns: 200px minmax(0, 1fr); }
.${classes.workspace}[data-filmstrip="closed"][data-side="closed"] { grid-template-columns: minmax(0, 1fr); }
@container sasha-editor (max-width: 1100px) {
  .${classes.workspace} { grid-template-columns: 150px minmax(0, 1fr) 250px; }
  .${classes.workspace}[data-filmstrip="closed"] { grid-template-columns: minmax(0, 1fr) 250px; }
  .${classes.workspace}[data-side="closed"] { grid-template-columns: 150px minmax(0, 1fr); }
  .${classes.menuBar} { display: none; }
  .${classes.notices} { inline-size: min(250px, 100% - 2 * var(--sasha-space-small)); }
}
@media (max-width: 1023px) {
  .${classes.workspace}, .${classes.workspace}[data-filmstrip="closed"], .${classes.workspace}[data-side="closed"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
  .${classes.sidePanel} { max-block-size: 40vh; }
}

.${classes.filmstrip} { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.${classes.filmstripScroller} { position: relative; flex: 1; overflow-y: auto; overflow-x: hidden; padding: var(--sasha-space-small); }
.${classes.thumbnail} { position: absolute; inset-inline: var(--sasha-space-small); display: grid; grid-template-columns: 18px 1fr; gap: var(--sasha-space-extra-small); align-items: start; cursor: pointer; border: 0; background: transparent; padding: 0; color: inherit; text-align: start; }
.${classes.thumbnailNumber} { padding-block-start: 2px; font-size: var(--sasha-font-size-caption); color: var(--sasha-text-muted); text-align: end; }
.${classes.thumbnailFrame} { position: relative; border-radius: var(--sasha-radius-control); overflow: hidden; outline: 2px solid transparent; outline-offset: 1px; box-shadow: var(--sasha-tab-on-shadow); }
.${classes.thumbnail}[aria-selected="true"] .${classes.thumbnailFrame} { outline-color: var(--sasha-selection); }
.${classes.thumbnail}[data-current="true"] .${classes.thumbnailNumber} { color: var(--sasha-accent); font-weight: var(--sasha-font-weight-bold); }
.${classes.thumbnail}[data-skipped="true"] .${classes.thumbnailFrame} { opacity: var(--sasha-disabled-opacity); }
.${classes.thumbnailBadges} { position: absolute; inset-inline-end: 4px; inset-block-end: 4px; display: flex; gap: 3px; }
.${classes.thumbnailBadges} > span { min-inline-size: 18px; block-size: 18px; padding: 0 4px; border-radius: var(--sasha-radius-pill); display: inline-grid; place-items: center; background: var(--sasha-glass-over-canvas); color: var(--sasha-text); font-size: var(--sasha-font-size-caption); }
.${classes.thumbnailBadges} svg { inline-size: 12px; block-size: 12px; }
.${classes.thumbnailAvatar} { color: var(--sasha-peer-label-text); font-weight: var(--sasha-font-weight-bold); }
.${classes.dropIndicator} { position: absolute; inset-inline: var(--sasha-space-small); block-size: 3px; border-radius: var(--sasha-radius-pill); background: var(--sasha-accent); }

.${classes.centre} { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: var(--sasha-space-small); min-height: 0; min-width: 0; }
.${classes.canvasArea} { position: relative; overflow: auto; min-height: 0; outline: none; border-radius: var(--sasha-radius-panel); }
.${classes.canvasArea}:focus-visible { outline: var(--sasha-control-focus-ring-width) solid var(--sasha-focus-ring); outline-offset: -2px; }
.${classes.canvasArea}[data-tool="insert"] { cursor: crosshair; }
.${classes.canvasStage} { position: relative; }
.${classes.slideFrame} { position: absolute; z-index: var(--sasha-layer-canvas); box-shadow: var(--sasha-lift-shadow); border-radius: 2px; }
.${classes.emptyState} { position: absolute; inset: 0; display: grid; place-items: center; }

.${classes.overlay} { position: absolute; inset: 0; z-index: var(--sasha-layer-canvas-overlay); pointer-events: none; }
.${classes.overlayDrawing} { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; overflow: visible; pointer-events: none; }
.${classes.selectionBox} { position: absolute; transform-origin: 50% 50%; outline: var(--sasha-control-selection-width) solid var(--sasha-selection); box-shadow: 0 0 0 calc(var(--sasha-control-selection-width) + 1px) var(--sasha-selection-halo); pointer-events: none; }
.${classes.selectionBox}[data-subtle="true"] { outline-style: dashed; box-shadow: none; }
.${classes.selectionLine} { stroke: var(--sasha-selection); stroke-width: 1.5; stroke-dasharray: 4 3; }
.${classes.handle} { position: absolute; inline-size: var(--sasha-control-handle-size); block-size: var(--sasha-control-handle-size); transform: translate(-50%, -50%); background: var(--sasha-handle-fill); border: 1.5px solid var(--sasha-selection); border-radius: 2px; pointer-events: auto; cursor: pointer; }
.${classes.handle}[data-handle-name="topLeft"], .${classes.handle}[data-handle-name="bottomRight"] { cursor: nwse-resize; }
.${classes.handle}[data-handle-name="topRight"], .${classes.handle}[data-handle-name="bottomLeft"] { cursor: nesw-resize; }
.${classes.handle}[data-handle-name="top"], .${classes.handle}[data-handle-name="bottom"] { cursor: ns-resize; }
.${classes.handle}[data-handle-name="left"], .${classes.handle}[data-handle-name="right"] { cursor: ew-resize; }
.${classes.handle}[data-handle-name="start"], .${classes.handle}[data-handle-name="end"] { border-radius: 50%; cursor: move; }
.${classes.rotationStem} { position: absolute; inset-inline-start: 50%; inset-block-start: -22px; inline-size: 1px; block-size: 22px; background: var(--sasha-selection); }
.${classes.rotationHandle} { position: absolute; inset-inline-start: 50%; inset-block-start: -26px; inline-size: 12px; block-size: 12px; transform: translate(-50%, -50%); border-radius: 50%; background: var(--sasha-handle-fill); border: 1.5px solid var(--sasha-selection); pointer-events: auto; cursor: grab; }
.${classes.tableBoundary} { position: absolute; pointer-events: auto; }
.${classes.tableBoundary}[data-axis="column"] { inset-block: 0; inline-size: 8px; margin-inline-start: -4px; cursor: col-resize; }
.${classes.tableBoundary}[data-axis="row"] { inset-inline: 0; block-size: 8px; margin-block-start: -4px; cursor: row-resize; }
.${classes.guide} { position: absolute; background: var(--sasha-accent); }
.${classes.guide}[data-axis="vertical"] { inline-size: 1px; }
.${classes.guide}[data-axis="horizontal"] { block-size: 1px; }
.${classes.marquee} { position: absolute; border: 1px dashed var(--sasha-selection); background: var(--sasha-accent-soft); }
.${classes.creationBox} { position: absolute; border: 1.5px solid var(--sasha-selection); background: var(--sasha-accent-soft); }
.${classes.peerSelection} { position: absolute; transform-origin: 50% 50%; outline: 2px solid currentColor; outline-offset: 2px; }
.${classes.peerCursor} { position: absolute; inline-size: 16px; block-size: 20px; pointer-events: none; }
.${classes.peerCursor} > svg { display: block; inline-size: 16px; block-size: 20px; }
.${classes.peerLabel} { position: absolute; inset-inline-start: 14px; inset-block-start: 16px; padding: 1px var(--sasha-space-small); border-radius: var(--sasha-radius-pill); color: var(--sasha-peer-label-text); font-size: var(--sasha-font-size-caption); font-weight: var(--sasha-font-weight-semibold); white-space: nowrap; }
.${classes.peerCursor}[data-activity="idle"] { opacity: var(--sasha-disabled-opacity); }
.${classes.commentPin} { position: absolute; inline-size: 26px; block-size: 26px; transform: translate(-30%, -70%); border-radius: 50% 50% 50% 4px; border: 1px solid var(--sasha-glass-edge); background: var(--sasha-glass-over-canvas); color: var(--sasha-accent); font-weight: var(--sasha-font-weight-bold); font-size: var(--sasha-font-size-caption); box-shadow: var(--sasha-lift-shadow); pointer-events: auto; cursor: pointer; }
.${classes.commentPin}[data-resolved="true"] { color: var(--sasha-text-muted); }

.${classes.notes} { display: flex; flex-direction: column; min-height: 0; max-block-size: 160px; padding: var(--sasha-space-small) var(--sasha-space-medium); }
.${classes.notesBody} { overflow: auto; min-block-size: 48px; color: var(--sasha-text); }
.${classes.notesReader} { min-block-size: 48px; cursor: text; border-radius: var(--sasha-radius-control); }
.${classes.notesReader}:hover { background: var(--sasha-secondary-button); }

.${classes.sidePanel} { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.${classes.panelHeader} { padding: var(--sasha-space-medium) var(--sasha-space-medium) var(--sasha-space-small); }
.${classes.panelBody} { flex: 1; overflow-y: auto; padding: 0 var(--sasha-space-medium) var(--sasha-space-medium); display: flex; flex-direction: column; gap: var(--sasha-space-small); }
.${classes.panelFieldset} { display: flex; flex-direction: column; gap: var(--sasha-space-small); min-inline-size: 0; margin: 0; padding: 0; border: 0; }
.${TIDEPOOL_CLASS.root} .${classes.panelFieldset}[disabled] { opacity: 1; cursor: auto; }
.${classes.section} { display: flex; flex-direction: column; gap: var(--sasha-space-small); }
.${classes.sectionTitle} { margin: 0; font-size: var(--sasha-font-size-small); font-weight: var(--sasha-font-weight-bold); color: var(--sasha-text-muted); }
.${classes.fieldGrid} { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sasha-space-small); }
.${classes.fieldRow} { display: flex; align-items: center; gap: var(--sasha-space-small); flex-wrap: wrap; }
.${classes.fieldLabel} { display: flex; flex-direction: column; gap: 2px; font-size: var(--sasha-font-size-caption); color: var(--sasha-text-muted); min-inline-size: 0; }
.${classes.numberInput} { inline-size: 100%; min-inline-size: 0; color: var(--sasha-text); }
.${classes.toolbar} .${classes.select} { min-inline-size: 150px; }
.${classes.select} { min-height: var(--sasha-control-height); padding: 0 var(--sasha-space-small); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); color: var(--sasha-text); min-inline-size: 0; }
.${classes.segmented} { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--sasha-radius-pill); background: var(--sasha-secondary-button); }
.${classes.glyphGrid} { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--sasha-space-extra-small); }
.${classes.glyphChoice} { min-block-size: var(--sasha-control-height); padding: 0; border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); color: var(--sasha-text); cursor: pointer; }
.${classes.glyphChoice}[aria-checked="true"] { outline: var(--sasha-control-focus-ring-width) solid var(--sasha-focus-ring); outline-offset: 1px; }
.${classes.gradientPreview} { block-size: 18px; border-radius: var(--sasha-radius-pill); border: 1px solid var(--sasha-hairline); }
.${classes.gradientStops} { display: flex; flex-direction: column; gap: var(--sasha-space-small); }
.${classes.gradientStopRow} { display: grid; grid-template-columns: minmax(0, 1fr) 76px auto; gap: var(--sasha-space-small); align-items: end; }
.${classes.explanation} { margin: 0; font-size: var(--sasha-font-size-caption); color: var(--sasha-text-subtle); }
.${classes.swatches} { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--sasha-space-extra-small); }
/* A swatch shows a SLIDE colour, which may match the panel exactly (Dark 1 on the dark scheme), so its ring is the chrome's ink at a third. */
.${classes.swatch} { inline-size: 100%; aspect-ratio: 1; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--sasha-text) 35%, transparent); cursor: pointer; padding: 0; }
.${classes.swatch}[aria-pressed="true"] { outline: 2px solid var(--sasha-focus-ring); outline-offset: 1px; }
.${classes.colourButton} { display: inline-flex; align-items: center; gap: var(--sasha-space-small); min-height: var(--sasha-control-height); padding: 0 var(--sasha-space-small); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-pill); background: var(--sasha-card-glass); color: var(--sasha-text); cursor: pointer; }
.${classes.colourButton} > span:first-child { inline-size: 18px; block-size: 18px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--sasha-text) 35%, transparent); }
.${classes.popoverAnchor} { position: relative; }

.${classes.menu} { position: fixed; min-inline-size: 220px; max-block-size: 70vh; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.${classes.menu} .${TIDEPOOL_CLASS.menuItem} { border: 0; text-align: start; inline-size: 100%; }
.${classes.menu} .${TIDEPOOL_CLASS.menuItem}:not(:hover):not([data-active="true"]) { background: transparent; color: var(--sasha-text); }
.${classes.menuSeparator} { block-size: 1px; margin: var(--sasha-space-extra-small) var(--sasha-space-small); background: var(--sasha-hairline); }
.${classes.menuShortcut} { margin-inline-start: auto; color: var(--sasha-text-subtle); font-size: var(--sasha-font-size-caption); }
.${classes.menuHint} { padding: 0 var(--sasha-space-medium) var(--sasha-space-extra-small); color: var(--sasha-text-subtle); font-size: var(--sasha-font-size-caption); }
.${classes.contextMenu} { position: fixed; }

.${classes.dialogLayer} { position: fixed; inset: 0; z-index: var(--sasha-layer-dialog); display: grid; place-items: center; padding: var(--sasha-space-large); pointer-events: none; }
.${classes.dialogLayer} > .sasha-dialog { pointer-events: auto; inline-size: min(520px, 100%); max-block-size: 90vh; display: flex; flex-direction: column; gap: var(--sasha-space-medium); overflow: hidden; }
.${classes.dialogLayer} > .${classes.scriptDialog} { inline-size: min(1040px, 100%); }
.${classes.dialogHeader} { display: flex; align-items: center; gap: var(--sasha-space-small); }
.${classes.dialogTitle} { margin: 0; font-size: var(--sasha-font-size-heading); font-weight: var(--sasha-font-weight-bold); }
.${classes.dialogBody} { display: flex; flex-direction: column; gap: var(--sasha-space-medium); overflow: auto; min-block-size: 0; }
.${classes.dialogActions} { display: flex; justify-content: flex-end; gap: var(--sasha-space-small); flex-wrap: wrap; }
.${classes.scriptEditor} { inline-size: 100%; min-block-size: 320px; resize: vertical; padding: var(--sasha-space-medium); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); color: var(--sasha-text); line-height: 1.5; tab-size: 2; white-space: pre; }
.${classes.scriptReference} { margin: 0; padding: var(--sasha-space-medium); border-radius: var(--sasha-radius-control); background: var(--sasha-secondary-button); white-space: pre-wrap; max-block-size: 360px; overflow: auto; }
.${classes.conflict} { padding: var(--sasha-space-small) var(--sasha-space-medium); border-radius: var(--sasha-radius-control); background: var(--sasha-accent-soft); color: var(--sasha-warning); }
.${classes.shortcutTable} { inline-size: 100%; border-collapse: collapse; }
.${classes.shortcutTable} td { padding: var(--sasha-space-extra-small) var(--sasha-space-small); border-block-end: 1px solid var(--sasha-hairline); }
.${classes.shortcutTable} kbd { font-family: var(--sasha-code-font-family); font-size: var(--sasha-font-size-small); padding: 1px var(--sasha-space-extra-small); border-radius: var(--sasha-space-extra-small); background: var(--sasha-secondary-button); }
.${classes.layoutChoices} { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sasha-space-small); }

.${classes.commentRail} { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.${classes.thread} { display: flex; flex-direction: column; gap: var(--sasha-space-small); cursor: pointer; }
.${classes.thread}[data-focused="true"] { outline: var(--sasha-control-focus-ring-width) solid var(--sasha-focus-ring); outline-offset: 0; }
.${classes.thread}[data-resolved="true"] { opacity: 0.8; }
.${classes.threadHeader} { display: flex; align-items: center; gap: var(--sasha-space-small); }
.${classes.threadMessage} { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.${classes.threadActions} { display: flex; gap: var(--sasha-space-extra-small); flex-wrap: wrap; }
.${classes.composer} { display: flex; flex-direction: column; gap: var(--sasha-space-small); }
.${classes.railSection} { margin: var(--sasha-space-small) 0 0; font-size: var(--sasha-font-size-small); font-weight: var(--sasha-font-weight-bold); color: var(--sasha-text-muted); }
.${classes.mention} { padding: 0 2px; border-radius: var(--sasha-space-extra-small); background: var(--sasha-accent-soft); color: var(--sasha-accent); font-weight: var(--sasha-font-weight-semibold); }
.${classes.mentionPicker} { display: flex; flex-direction: column; gap: 1px; padding: var(--sasha-space-extra-small); border-radius: var(--sasha-radius-card); background: var(--sasha-glass-over-canvas); border: 1px solid var(--sasha-glass-edge); box-shadow: var(--sasha-lift-shadow); }
.${classes.mentionPicker} .${TIDEPOOL_CLASS.menuItem} { inline-size: 100%; border: 0; background: transparent; color: var(--sasha-text); text-align: start; }
.${classes.mentionPicker} .${TIDEPOOL_CLASS.menuItem}[aria-selected="true"] { background: var(--sasha-accent-soft); color: var(--sasha-accent); }
.${classes.agentLabel} { margin-inline-start: var(--sasha-space-extra-small); padding: 0 6px; border-radius: var(--sasha-radius-pill); background: var(--sasha-ink-button); color: var(--sasha-ink-button-text); font-size: var(--sasha-font-size-caption); font-weight: var(--sasha-font-weight-bold); }
.${classes.messageMeta} { display: flex; align-items: center; gap: var(--sasha-space-extra-small); }
.${classes.messageActions} { margin-inline-start: auto; display: flex; gap: 2px; font-size: var(--sasha-font-size-caption); }
.${classes.textArea} { inline-size: 100%; min-block-size: 72px; padding: var(--sasha-space-small); border: 1px solid var(--sasha-hairline); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); color: var(--sasha-text); resize: vertical; }

.${classes.notices} { position: absolute; inset-inline-end: var(--sasha-space-small); inset-block-end: var(--sasha-space-small); z-index: var(--sasha-layer-notice); display: flex; flex-direction: column-reverse; gap: var(--sasha-space-small); inline-size: min(300px, 100% - 2 * var(--sasha-space-small)); max-block-size: min(50%, 420px); overflow-y: auto; overscroll-behavior: contain; }
.${classes.noticeRow} { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sasha-space-small); }
/* The message keeps a readable width and the actions wrap below it; measured 2026-10-15, a nowrap
   row squeezed "Claude edited the deck: Added a hello slide" to one word per line beside its button. */
.${classes.noticeRow} > p { margin: 0; flex: 1 1 170px; min-inline-size: 0; }
.${classes.noticeRow} > button { white-space: nowrap; }

.${classes.floatingLayer} { position: fixed; inset: 0; z-index: var(--sasha-layer-popover); pointer-events: none; }
.${classes.floatingLayer}:empty { display: none; }
.${classes.floatingLayer} > * { pointer-events: auto; }
.${classes.presentationHost} { position: fixed; inset: 0; z-index: var(--sasha-layer-presenter); display: none; }
.${classes.presentationHost}[data-active="true"] { display: block; }
.${classes.previewBox} { border-radius: var(--sasha-radius-control); overflow: hidden; box-shadow: var(--sasha-tab-on-shadow); }

.${classes.sideBySide} { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sasha-space-small); block-size: 100vh; padding: var(--sasha-space-small); box-sizing: border-box; }
.${classes.demoPane} { position: relative; min-inline-size: 0; min-block-size: 0; display: flex; flex-direction: column; }
.${classes.demoPane} > .${classes.editor} { flex: 1; padding: 0; }
.${classes.demoLabel} { font-family: var(--sasha-font-family); margin: 0 0 var(--sasha-space-extra-small); font-size: var(--sasha-font-size-small); color: var(--sasha-text-muted); }
.${classes.visuallyHidden} { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

@media (prefers-reduced-motion: no-preference) {
  .${classes.menu}, .${classes.contextMenu} { animation: sasha-view-pop var(--sasha-chrome-transition-duration) ease-out; }
  .${classes.thumbnailFrame} { transition: outline-color var(--sasha-chrome-transition-duration) ease; }
  .${classes.peerCursor} { transition: left 80ms linear, top 80ms linear; }
}
@keyframes sasha-view-pop { 0% { opacity: 0; transform: translateY(-4px); } 100% { opacity: 1; transform: none; } }
`;
}
