// THE TOP BAR AND THE TOOLBAR: two glass panels across the top of the editor. The top bar carries
// the deck's name, the menus, who else is here, save status, Comment and Present; the toolbar
// carries history, the tools, paint format and zoom (SPEC.md section 9). Buttons are Tidepool ink
// pills and round icon buttons; a tool that is on reads `aria-pressed="true"`.
//
// Present and the speaker view run `handlePresent` inside the click, so full screen and the speaker
// window are requested while the browser still counts it as the user's gesture.

import { memo, useState, type MouseEvent, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { InsertTool, Tool, ZoomSetting } from "../../contracts/editor-state.ts";
import type { PeerPresence } from "../../contracts/presence.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { arrayItemsEqual, shallowEqual, useEditorSelector, useEditorServices, useGestureContext } from "../application/editor-services.tsx";
import { handlePresent } from "../application/gesture-handlers.ts";
import { peerColour } from "../canvas/canvas-overlay.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon, type IconName } from "./icons.tsx";
import { MenuBar, MenuPopover, shortcutStyle } from "./menus.tsx";
import type { MenuEntry } from "./menu-model.ts";

export const TopBar = memo(function TopBar(): ReactElement {
  const gesture = useGestureContext();
  const view = useEditorSelector((state) => ({ title: state.document.title, saving: state.inFlightCommandIds.length > 0 || state.pendingEdits.length > 0, commentsOpen: state.ui.commentsOpen }), shallowEqual);
  const peers = useEditorSelector((state) => state.peers, arrayItemsEqual);
  const dispatch = gesture.system.dispatch;
  return (
    <header className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.topBar}`}>
      <div className={VIEW_CLASS.brand}>
        <span className={VIEW_CLASS.brandMark} aria-hidden="true">
          S
        </span>
        <div>
          <h1 className={VIEW_CLASS.deckTitle}>{view.title.length === 0 ? "Untitled deck" : view.title}</h1>
          <span className={TIDEPOOL_CLASS.subtle} role="status">
            {view.saving ? "Saving..." : "All changes saved"}
          </span>
        </div>
      </div>
      <MenuBar gesture={gesture} />
      <div className={VIEW_CLASS.topActions}>
        <PeerAvatars peers={peers} />
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} aria-pressed={view.commentsOpen} onClick={() => dispatch({ kind: "panelToggled", panel: "comments" })}>
          Comments
        </button>
        <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label="Present with speaker view" title="Present with speaker view" onClick={() => handlePresent({ context: gesture, from: "currentSlide", withSpeakerView: true })}>
          <Icon name="speaker" />
        </button>
        <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={() => handlePresent({ context: gesture, from: "currentSlide", withSpeakerView: false })}>
          Present
        </button>
      </div>
    </header>
  );
});

function PeerAvatars(properties: Readonly<{ peers: readonly PeerPresence[] }>): ReactElement | null {
  if (properties.peers.length === 0) return null;
  return (
    <div className={VIEW_CLASS.avatars} aria-label={`Also here: ${properties.peers.map((peer) => peer.person.displayName).join(", ")}`}>
      {properties.peers.slice(0, 5).map((peer) => (
        <span key={peer.clientId} className={VIEW_CLASS.avatar} style={{ backgroundColor: peerColour(peer.person.colourIndex) }} title={peer.person.displayName} data-away={peer.activity === "idle" ? "true" : "false"}>
          {initials(peer.person.displayName)}
        </span>
      ))}
    </div>
  );
}

export const Toolbar = memo(function Toolbar(): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const view = useEditorSelector((state) => ({ tool: state.tool, history: state.history, zoom: state.viewport.zoom, scale: state.viewport.scale }), shallowEqual);
  const [picker, setPicker] = useState<Readonly<{ kind: "shape" | "line"; left: number; top: number }> | null>(null);
  const choose = (tool: Tool): void => dispatch({ kind: "toolChosen", tool });
  const gesture = useGestureContext();
  return (
    <div className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.toolbar}`} role="toolbar" aria-label="Tools">
      <div className={VIEW_CLASS.toolbarGroup}>
        <ToolButton icon="undo" label="Undo" pressed={false} disabled={!view.history.canUndo} onClick={() => dispatch({ kind: "undoRequested" })} />
        <ToolButton icon="redo" label="Redo" pressed={false} disabled={!view.history.canRedo} onClick={() => dispatch({ kind: "redoRequested" })} />
      </div>
      <span className={VIEW_CLASS.toolbarDivider} />
      <div className={VIEW_CLASS.toolbarGroup}>
        <ToolButton icon="select" label="Select" pressed={toolIs(view.tool, "select")} onClick={() => choose({ kind: "select" })} />
        <ToolButton icon="textBox" label="Text box" pressed={shapePreset(view.tool) === "textBox"} onClick={() => choose({ kind: "shape", preset: "textBox" })} />
        <ToolButton
          icon="shape"
          label="Shape"
          pressed={toolIs(view.tool, "shape") && shapePreset(view.tool) !== "textBox"}
          onClick={(event) => {
            const rectangle = event.currentTarget.getBoundingClientRect();
            setPicker({ kind: "shape", left: rectangle.left, top: rectangle.bottom + 6 });
          }}
        />
        <ToolButton
          icon="line"
          label="Line"
          pressed={toolIs(view.tool, "line")}
          onClick={(event) => {
            const rectangle = event.currentTarget.getBoundingClientRect();
            setPicker({ kind: "line", left: rectangle.left, top: rectangle.bottom + 6 });
          }}
        />
        <ToolButton icon="image" label="Image" pressed={false} onClick={() => dispatch({ kind: "dialogOpened", dialog: { kind: "insertImage" } })} />
        <ToolButton icon="table" label="Table" pressed={toolIs(view.tool, "table")} onClick={() => dispatch({ kind: "dialogOpened", dialog: { kind: "insertTable" } })} />
      </div>
      <span className={VIEW_CLASS.toolbarDivider} />
      <div className={VIEW_CLASS.toolbarGroup}>
        <button
          type="button"
          className={TIDEPOOL_CLASS.iconButton}
          aria-label="Paint format (double click keeps it)"
          title="Paint format (double click keeps it)"
          aria-pressed={toolIs(view.tool, "formatPainter")}
          onClick={(event) => {
            if (event.detail <= 1) dispatch({ kind: "formatPainterRequested", sticky: false });
          }}
          onDoubleClick={() => dispatch({ kind: "formatPainterRequested", sticky: true })}
        >
          <Icon name="paintFormat" />
        </button>
        <ToolButton icon="comment" label="Comment" pressed={toolIs(view.tool, "comment")} onClick={() => choose({ kind: "comment" })} />
      </div>
      <span className={VIEW_CLASS.toolbarDivider} />
      <ZoomChooser zoom={view.zoom} scale={view.scale} onZoom={(zoom) => dispatch({ kind: "zoomRequested", zoom })} />
      {picker === null ? null : (
        <MenuPopover
          label={picker.kind === "shape" ? "Shapes" : "Lines"}
          entries={picker.kind === "shape" ? SHAPE_ENTRIES : LINE_ENTRIES}
          at={{ x: picker.left, y: picker.top }}
          gesture={gesture}
          onClose={() => setPicker(null)}
          onNeighbour={null}
          className={VIEW_CLASS.menu}
        />
      )}
      <span className={TIDEPOOL_CLASS.subtle} style={{ marginInlineStart: "auto" }}>
        {shortcutStyle(services.primaryModifier) === "macOS" ? "⌘/ for shortcuts" : "Control+/ for shortcuts"}
      </span>
    </div>
  );
});

function ToolButton(properties: Readonly<{ icon: IconName; label: string; pressed: boolean; disabled?: boolean; onClick: (event: MouseEvent<HTMLButtonElement>) => void }>): ReactElement {
  return (
    <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label={properties.label} title={properties.label} aria-pressed={properties.pressed} disabled={properties.disabled === true} onClick={properties.onClick}>
      <Icon name={properties.icon} />
    </button>
  );
}

function ZoomChooser(properties: Readonly<{ zoom: ZoomSetting; scale: number; onZoom: (zoom: ZoomSetting) => void }>): ReactElement {
  const value = zoomValue(properties.zoom);
  return (
    <label className={VIEW_CLASS.toolbarGroup}>
      <Icon name="zoom" />
      <span className="sasha-view-visually-hidden">Zoom</span>
      <select
        className={VIEW_CLASS.select}
        value={value}
        aria-label="Zoom"
        onChange={(event) => {
          const chosen = event.currentTarget.value;
          properties.onZoom(chosen === "fit" ? { kind: "fit" } : { kind: "fixed", scale: Number(chosen) });
        }}
      >
        <option value="fit">Fit ({Math.round(properties.scale * 100)} percent)</option>
        {[0.5, 0.75, 1, 1.5, 2].map((scale) => (
          <option key={scale} value={String(scale)}>
            {scale * 100} percent
          </option>
        ))}
      </select>
    </label>
  );
}

const SHAPE_ENTRIES: readonly MenuEntry[] = (
  [
    ["Rectangle", "rectangle"],
    ["Rounded rectangle", "roundedRectangle"],
    ["Ellipse", "ellipse"],
    ["Triangle", "triangle"],
    ["Right triangle", "rightTriangle"],
    ["Diamond", "diamond"],
    ["Parallelogram", "parallelogram"],
    ["Trapezoid", "trapezoid"],
    ["Pentagon", "pentagon"],
    ["Hexagon", "hexagon"],
    ["Octagon", "octagon"],
    ["Star", "fivePointStar"],
    ["Plus", "plus"],
    ["Heart", "heart"],
    ["Cloud", "cloud"],
    ["Speech bubble", "speechBubble"],
    ["Chevron", "chevron"],
    ["Arrow right", "rightArrow"],
    ["Arrow left", "leftArrow"],
    ["Arrow up", "upArrow"],
    ["Arrow down", "downArrow"],
  ] as const
).map(([label, preset]) => toolEntry({ label, event: { kind: "toolChosen", tool: { kind: "shape", preset } } }));

const LINE_ENTRIES: readonly MenuEntry[] = [
  toolEntry({ label: "Line", event: { kind: "toolChosen", tool: lineTool({ startArrow: "none", endArrow: "none", routing: "straight" }) } }),
  toolEntry({ label: "Arrow", event: { kind: "toolChosen", tool: lineTool({ startArrow: "none", endArrow: "triangle", routing: "straight" }) } }),
  toolEntry({ label: "Double arrow", event: { kind: "toolChosen", tool: lineTool({ startArrow: "triangle", endArrow: "triangle", routing: "straight" }) } }),
  toolEntry({ label: "Elbow connector", event: { kind: "toolChosen", tool: lineTool({ startArrow: "none", endArrow: "triangle", routing: "elbow" }) } }),
  toolEntry({ label: "Curved connector", event: { kind: "toolChosen", tool: lineTool({ startArrow: "none", endArrow: "triangle", routing: "curved" }) } }),
];

function toolEntry(options: Readonly<{ label: string; event: EditorEvent }>): MenuEntry {
  return { kind: "item", label: options.label, shortcut: null, action: { kind: "dispatch", event: options.event }, disabled: false, hint: null, checked: null };
}

function lineTool(options: Readonly<{ startArrow: Extract<InsertTool, { kind: "line" }>["startArrow"]; endArrow: Extract<InsertTool, { kind: "line" }>["endArrow"]; routing: Extract<InsertTool, { kind: "line" }>["routing"] }>): Tool {
  return { kind: "line", routing: options.routing, startArrow: options.startArrow, endArrow: options.endArrow };
}

function toolIs(tool: Tool, kind: Tool["kind"]): boolean {
  return tool.kind === kind;
}

function shapePreset(tool: Tool): string | null {
  switch (tool.kind) {
    case "shape":
      return tool.preset;
    case "select":
    case "line":
    case "table":
    case "comment":
    case "annotate":
    case "pan":
    case "formatPainter":
      return null;
    default:
      return assertNever(tool);
  }
}

function zoomValue(zoom: ZoomSetting): string {
  switch (zoom.kind) {
    case "fit":
      return "fit";
    case "fixed":
      return String(zoom.scale);
    default:
      return assertNever(zoom);
  }
}

/** Up to two initials of a display name, for avatars. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}
