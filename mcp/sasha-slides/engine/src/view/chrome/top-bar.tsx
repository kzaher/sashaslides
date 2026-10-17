// THE TOP BAR AND THE TOOLBAR: two glass panels across the top of the editor. The top bar carries
// the real Sasha Slides logo (linking to the host's home, `EditorHost.homeAddress`), the deck's
// name, save and connection status, the menus, who else is here, the host's own controls (Share,
// the account), Comments and Present; the toolbar carries history, the tools, paint format and
// zoom (SPEC.md sections 9 and 21.9). Buttons are Tidepool ink pills and round icon buttons; a tool
// that is on reads `aria-pressed="true"`.
//
// Key decisions:
//
//  * THE LOGO IS THE PRODUCT'S OWN, generated from docs/brand (http/sasha-icon.generated.ts), drawn
//    inline so it needs no request and scales with the bar; never a placeholder letter.
//  * THE CONNECTION SPEAKS ONLY WHEN SOMETHING IS WRONG: nothing while online; "Offline -
//    reconnecting in 8 s" with Try now; "Changes not sent yet" while the server lacks local edits.
//    A closed connection is the shell's read-only banner, not a line in the bar.
//  * WHO IS WHERE: the avatar stack opens a popover listing each peer and their slide ("Grace -
//    slide 3"); choosing one goes to that slide. Silent peers fade, then leave (presence.ts).
//
// Present and the speaker view run `handlePresent` inside the click, so full screen and the speaker
// window are requested while the browser still counts it as the user's gesture.

import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { SASHA_ICON_SVG } from "../../../../http/sasha-icon.generated.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { CollaborationStatus } from "../../contracts/collaboration.ts";
import type { DeckRole } from "../../contracts/deck-access.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { InsertTool, Tool, ZoomSetting } from "../../contracts/editor-state.ts";
import { commentingRefusal, editingRefusal } from "../../shared/access-refusals.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { FloatingLayerContext, arrayItemsEqual, shallowEqual, useEditorSelector, useEditorServices, useGestureContext } from "../application/editor-services.tsx";
import { handlePresent } from "../application/gesture-handlers.ts";
import { peerColour } from "../canvas/canvas-overlay.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon, type IconName } from "./icons.tsx";
import { MenuBar, MenuPopover, shortcutStyle } from "./menus.tsx";
import type { MenuEntry } from "./menu-model.ts";
import { PEER_IS_AWAY, peerLocations, usePresenceNow, type PeerLocation } from "./presence.ts";

export const TopBar = memo(function TopBar(): ReactElement {
  const gesture = useGestureContext();
  const services = useEditorServices();
  const view = useEditorSelector(
    (state) => ({ title: state.document.title, saving: state.inFlightCommandIds.length > 0 || state.pendingEdits.length > 0, commentsOpen: state.chrome.commentsOpen, collaboration: state.collaboration, document: state.document }),
    shallowEqual,
  );
  const peers = useEditorSelector((state) => state.peers, arrayItemsEqual);
  const dispatch = gesture.system.dispatch;
  const host = services.host;
  const presenceNow = usePresenceNow({ now: services.now, watching: peers.length > 0 });
  const locations = peerLocations({ peers, document: view.document, now: presenceNow });
  return (
    <header className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.topBar}`}>
      <div className={VIEW_CLASS.brand}>
        <ProductLogo homeAddress={host.homeAddress} />
        <div className={VIEW_CLASS.brandText}>
          <h1 className={VIEW_CLASS.deckTitle}>{view.title.length === 0 ? "Untitled deck" : view.title}</h1>
          <div className={VIEW_CLASS.statusLine}>
            <span className={TIDEPOOL_CLASS.subtle} role="status">
              {view.saving ? "Saving..." : "All changes saved"}
            </span>
            <ConnectionIndicator status={view.collaboration} dispatch={dispatch} />
          </div>
        </div>
      </div>
      <MenuBar gesture={gesture} />
      <div className={VIEW_CLASS.topActions}>
        <RoleBadge role={view.collaboration.role} />
        <PeerStack locations={locations} dispatch={dispatch} />
        {host.topBarAccessory === null || host.topBarAccessory === undefined ? null : <div className={VIEW_CLASS.hostAccessory}>{host.topBarAccessory}</div>}
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

/** The real Sasha Slides logo, a link home when the host has one (see the header). */
export function ProductLogo(properties: Readonly<{ homeAddress: string | null }>): ReactElement {
  // The markup is the generated brand icon (http/sasha-icon.generated.ts), a constant of this
  // repository built from docs/brand -- never user content -- so inserting it as markup is safe.
  const logo = <span className={VIEW_CLASS.logo} aria-hidden="true" dangerouslySetInnerHTML={{ __html: SASHA_ICON_SVG }} />;
  if (properties.homeAddress === null) {
    return (
      <span className={VIEW_CLASS.logoLink} role="img" aria-label="Sasha Slides">
        {logo}
      </span>
    );
  }
  return (
    <a className={VIEW_CLASS.logoLink} href={properties.homeAddress} aria-label="Sasha Slides: all decks" title="All decks">
      {logo}
    </a>
  );
}

/** What the connection indicator says; null while there is nothing to say (see the header). */
export type ConnectionNote = Readonly<{ text: string; tone: "information" | "warning"; tryNow: boolean }>;

export function connectionNote(status: CollaborationStatus): ConnectionNote | null {
  const connection = status.connection;
  switch (connection.kind) {
    case "local":
    case "online":
      return status.unsentChanges ? { text: "Changes not sent yet", tone: "warning", tryNow: false } : null;
    case "connecting":
      return { text: status.unsentChanges ? "Connecting - changes not sent yet" : "Connecting...", tone: "information", tryNow: false };
    case "synchronising":
      return { text: "Catching up with the deck...", tone: "information", tryNow: false };
    case "offline": {
      const waiting = connection.retryInMilliseconds === null ? "waiting for the network" : `reconnecting in ${Math.max(1, Math.ceil(connection.retryInMilliseconds / 1000))} s`;
      return { text: `Offline - ${waiting}${status.unsentChanges ? " - changes not sent yet" : ""}`, tone: "warning", tryNow: true };
    }
    case "closed":
      return null;
    default:
      return assertNever(connection);
  }
}

/** The connection line under the title; "Try now" asks the session to skip its backoff. */
export function ConnectionIndicator(properties: Readonly<{ status: CollaborationStatus; dispatch: (event: EditorEvent) => void }>): ReactElement | null {
  const note = connectionNote(properties.status);
  if (note === null) return null;
  return (
    <span className={VIEW_CLASS.connection} data-tone={note.tone} role="status">
      <span>{note.text}</span>
      {note.tryNow ? (
        <button type="button" className={VIEW_CLASS.inlineAction} onClick={() => properties.dispatch({ kind: "reconnectRequested" })}>
          Try now
        </button>
      ) : null}
    </span>
  );
}

/** "View only" or "Can comment" next to the peers, with the reason as its title. */
function RoleBadge(properties: Readonly<{ role: DeckRole }>): ReactElement | null {
  const label = ROLE_BADGE[properties.role];
  if (label === null) return null;
  return (
    <span className={VIEW_CLASS.roleBadge} title={label.reason}>
      {label.text}
    </span>
  );
}

const ROLE_BADGE: Readonly<Record<DeckRole, Readonly<{ text: string; reason: string }> | null>> = {
  owner: null,
  editor: null,
  commenter: { text: "Can comment", reason: "You can comment on this deck, but not edit it." },
  viewer: { text: "View only", reason: "You can view this deck, but not edit it." },
};

/** Up to five avatars; a click opens who is on which slide (see the header). */
export function PeerStack(properties: Readonly<{ locations: readonly PeerLocation[]; dispatch: (event: EditorEvent) => void }>): ReactElement | null {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (properties.locations.length === 0) return null;
  const names = properties.locations.map((location) => location.peer.person.displayName).join(", ");
  return (
    <>
      <button ref={button} type="button" className={VIEW_CLASS.avatarStack} aria-haspopup="dialog" aria-expanded={open} aria-label={`Also here: ${names}`} title={`Also here: ${names}`} onClick={() => setOpen(!open)}>
        {properties.locations.slice(0, 5).map((location) => (
          <span key={location.peer.clientId} className={VIEW_CLASS.avatar} style={{ backgroundColor: peerColour(location.peer.person.colourIndex) }} data-away={PEER_IS_AWAY[location.status] ? "true" : "false"}>
            {initials(location.peer.person.displayName)}
          </span>
        ))}
        {properties.locations.length > 5 ? <span className={VIEW_CLASS.avatarMore}>+{properties.locations.length - 5}</span> : null}
      </button>
      {open ? <PeerPopover anchor={button.current} locations={properties.locations} dispatch={properties.dispatch} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The list behind the avatar stack: "Grace - slide 3", a click goes there. */
export function PeerList(properties: Readonly<{ locations: readonly PeerLocation[]; dispatch: (event: EditorEvent) => void; onChosen: () => void }>): ReactElement {
  return (
    <ul className={VIEW_CLASS.peerList} aria-label="Who is on which slide">
      {properties.locations.map((location) => {
        const slideId = location.slideId;
        return (
          <li key={location.peer.clientId}>
            <button
              type="button"
              className={TIDEPOOL_CLASS.menuItem}
              disabled={slideId === null}
              onClick={() => {
                if (slideId === null) return;
                properties.dispatch({ kind: "slideActivated", slideId });
                properties.onChosen();
              }}
            >
              <span className={VIEW_CLASS.avatar} style={{ marginInlineStart: 0, backgroundColor: peerColour(location.peer.person.colourIndex) }} aria-hidden="true">
                {initials(location.peer.person.displayName)}
              </span>
              <span>{location.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PeerPopover(properties: Readonly<{ anchor: HTMLElement | null; locations: readonly PeerLocation[]; dispatch: (event: EditorEvent) => void; onClose: () => void }>): ReactElement {
  const floatingLayer = useContext(FloatingLayerContext);
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Readonly<{ left: number; top: number }> | null>(null);
  useLayoutEffect(() => {
    const anchor = properties.anchor?.getBoundingClientRect();
    const element = root.current;
    if (anchor === undefined || element === null) return;
    setPosition({ left: Math.max(8, Math.min(anchor.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 8)), top: anchor.bottom + 6 });
  }, [properties.anchor]);
  // Focus once placed: until then the popover is `visibility: hidden`, and a hidden element refuses
  // focus -- which left focus on the avatar button, where Escape could not close the popover.
  const placed = position !== null;
  useEffect(() => {
    if (placed) root.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [placed]);
  const popover = (
    <>
      <div style={{ position: "fixed", inset: 0 }} onPointerDown={properties.onClose} aria-hidden="true" />
      <div
        ref={root}
        role="dialog"
        aria-label="Who is here"
        className={`${TIDEPOOL_CLASS.popover} ${VIEW_CLASS.peerPopover}`}
        style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position === null ? "hidden" : "visible" }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          properties.onClose();
        }}
      >
        <PeerList locations={properties.locations} dispatch={properties.dispatch} onChosen={properties.onClose} />
      </div>
    </>
  );
  return floatingLayer === null ? popover : createPortal(popover, floatingLayer);
}

export const Toolbar = memo(function Toolbar(): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const view = useEditorSelector(
    (state) => ({ tool: state.tool, history: state.history, zoom: state.viewport.zoom, scale: state.viewport.scale, editing: editingRefusal(state), commenting: commentingRefusal(state) }),
    shallowEqual,
  );
  const [picker, setPicker] = useState<Readonly<{ kind: "shape" | "line"; left: number; top: number }> | null>(null);
  const choose = (tool: Tool): void => dispatch({ kind: "toolChosen", tool });
  const gesture = useGestureContext();
  return (
    <div className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.toolbar}`} role="toolbar" aria-label="Tools">
      <div className={VIEW_CLASS.toolbarGroup}>
        <ToolButton icon="undo" label="Undo" pressed={false} disabledReason={view.editing ?? (view.history.canUndo ? null : "Nothing to undo")} onClick={() => dispatch({ kind: "undoRequested" })} />
        <ToolButton icon="redo" label="Redo" pressed={false} disabledReason={view.editing ?? (view.history.canRedo ? null : "Nothing to redo")} onClick={() => dispatch({ kind: "redoRequested" })} />
      </div>
      <span className={VIEW_CLASS.toolbarDivider} />
      <div className={VIEW_CLASS.toolbarGroup}>
        <ToolButton icon="select" label="Select" pressed={toolIs(view.tool, "select")} onClick={() => choose({ kind: "select" })} />
        <ToolButton icon="textBox" label="Text box" pressed={shapePreset(view.tool) === "textBox"} disabledReason={view.editing} onClick={() => choose({ kind: "shape", preset: "textBox" })} />
        <ToolButton
          icon="shape"
          label="Shape"
          pressed={toolIs(view.tool, "shape") && shapePreset(view.tool) !== "textBox"}
          disabledReason={view.editing}
          onClick={(event) => {
            const rectangle = event.currentTarget.getBoundingClientRect();
            setPicker({ kind: "shape", left: rectangle.left, top: rectangle.bottom + 6 });
          }}
        />
        <ToolButton
          icon="line"
          label="Line"
          pressed={toolIs(view.tool, "line")}
          disabledReason={view.editing}
          onClick={(event) => {
            const rectangle = event.currentTarget.getBoundingClientRect();
            setPicker({ kind: "line", left: rectangle.left, top: rectangle.bottom + 6 });
          }}
        />
        <ToolButton icon="image" label="Image" pressed={false} disabledReason={view.editing} onClick={() => dispatch({ kind: "dialogOpened", dialog: { kind: "insertImage" } })} />
        <ToolButton icon="table" label="Table" pressed={toolIs(view.tool, "table")} disabledReason={view.editing} onClick={() => dispatch({ kind: "dialogOpened", dialog: { kind: "insertTable" } })} />
      </div>
      <span className={VIEW_CLASS.toolbarDivider} />
      <div className={VIEW_CLASS.toolbarGroup}>
        <button
          type="button"
          className={TIDEPOOL_CLASS.iconButton}
          aria-label="Paint format (double click keeps it)"
          title={view.editing ?? "Paint format (double click keeps it)"}
          aria-pressed={toolIs(view.tool, "formatPainter")}
          disabled={view.editing !== null}
          onClick={(event) => {
            if (event.detail <= 1) dispatch({ kind: "formatPainterRequested", sticky: false });
          }}
          onDoubleClick={() => dispatch({ kind: "formatPainterRequested", sticky: true })}
        >
          <Icon name="paintFormat" />
        </button>
        <ToolButton icon="comment" label="Comment" pressed={toolIs(view.tool, "comment")} disabledReason={view.commenting} onClick={() => choose({ kind: "comment" })} />
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

/** A round tool button; a disabled one says why in its title (SPEC.md 21.9: "disabled with the reason"). */
function ToolButton(properties: Readonly<{ icon: IconName; label: string; pressed: boolean; disabledReason?: string | null; onClick: (event: MouseEvent<HTMLButtonElement>) => void }>): ReactElement {
  const reason = properties.disabledReason ?? null;
  return (
    <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label={properties.label} title={reason === null ? properties.label : `${properties.label}: ${reason}`} aria-pressed={properties.pressed} disabled={reason !== null} onClick={properties.onClick}>
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
