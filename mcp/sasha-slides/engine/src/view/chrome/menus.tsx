// THE MENUS: the top bar's menu bar and the context menu, drawn as Tidepool popovers -- nearly opaque
// glass, because a menu often opens over the slide and must stay readable over a black one (SPEC.md
// section 2) -- with the keyboard navigation a menu needs: arrow keys, Enter and Space, Escape,
// Home and End, left and right to the neighbouring menu, and type-ahead by first letter.
//
// Which menu is open is editor state (`chrome.openMenu`, `chrome.contextMenu`); which item is highlighted is
// this component's own, because it lives exactly as long as the open menu and nothing else reads it.
// An item runs through `performMenuAction`, inside the click or key event, so copy and Present keep
// their user gesture (gesture-handlers.ts).

import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { assertNever } from "../../contracts/assert-never.ts";
import type { MenuName } from "../../contracts/editor-state.ts";
import type { Point } from "../../contracts/geometry.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { FloatingLayerContext, useEditorSelector, useEditorServices, useViewPreferences } from "../application/editor-services.tsx";
import { handleMenuClipboardWrite, handleOpenInNewTab, handlePresent, type GestureContext } from "../application/gesture-handlers.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon } from "./icons.tsx";
import { MENU_LABEL, MENU_ORDER, contextMenuEntries, menuEntries, type MenuAction, type MenuEntry, type ShortcutStyle } from "./menu-model.ts";

export function MenuBar(properties: Readonly<{ gesture: GestureContext }>): ReactElement {
  const services = useEditorServices();
  const openMenu = useEditorSelector((state) => state.chrome.openMenu);
  const buttons = useRef(new Map<MenuName, HTMLButtonElement | null>());
  return (
    <nav className={VIEW_CLASS.menuBar} aria-label="Menus">
      {MENU_ORDER.map((menu) => (
        <button
          key={menu}
          ref={(node) => {
            buttons.current.set(menu, node);
          }}
          type="button"
          className={VIEW_CLASS.menuButton}
          aria-haspopup="menu"
          aria-expanded={openMenu === menu}
          onClick={() => services.system.dispatch(openMenu === menu ? { kind: "menuClosed" } : { kind: "menuOpened", menu })}
          onPointerEnter={() => {
            if (openMenu !== null && openMenu !== menu) services.system.dispatch({ kind: "menuOpened", menu });
          }}
        >
          {MENU_LABEL[menu]}
        </button>
      ))}
      {openMenu === null ? null : <OpenMenu menu={openMenu} at={() => menuPosition(buttons.current.get(openMenu) ?? null)} gesture={properties.gesture} />}
    </nav>
  );
}

function OpenMenu(properties: Readonly<{ menu: MenuName; at: () => Point | null; gesture: GestureContext }>): ReactElement {
  const state = useEditorSelector((current) => current);
  const services = useEditorServices();
  const preferences = useViewPreferences();
  const entries = menuEntries({ menu: properties.menu, state, shortcuts: shortcutStyle(services.primaryModifier), hostItems: services.host.fileMenuItems, showAnnotations: preferences.showAnnotations });
  return (
    <MenuPopover
      label={MENU_LABEL[properties.menu]}
      entries={entries}
      at={properties.at}
      gesture={properties.gesture}
      onClose={() => services.system.dispatch({ kind: "menuClosed" })}
      onNeighbour={(direction) => services.system.dispatch({ kind: "menuOpened", menu: neighbourMenu(properties.menu, direction) })}
      className={VIEW_CLASS.menu}
    />
  );
}

export function ContextMenuLayer(properties: Readonly<{ gesture: GestureContext }>): ReactElement | null {
  const state = useEditorSelector((current) => current);
  const services = useEditorServices();
  const menu = state.chrome.contextMenu;
  if (menu === null) return null;
  return (
    <MenuPopover
      label="Context menu"
      entries={contextMenuEntries({ menu, state, shortcuts: shortcutStyle(services.primaryModifier) })}
      at={menu.at}
      gesture={properties.gesture}
      onClose={() => services.system.dispatch({ kind: "contextMenuClosed" })}
      onNeighbour={null}
      className={`${VIEW_CLASS.menu} ${VIEW_CLASS.contextMenu}`}
    />
  );
}

/** Performs one menu action inside the event that chose it (see the header). */
export function performMenuAction(options: Readonly<{ action: MenuAction; gesture: GestureContext; close: () => void; toggleAnnotations: () => void }>): void {
  const action = options.action;
  switch (action.kind) {
    case "dispatch":
      options.close();
      options.gesture.system.dispatch(action.event);
      return;
    case "present":
      options.close();
      handlePresent({ context: options.gesture, from: action.from, withSpeakerView: action.withSpeakerView });
      return;
    case "clipboardWrite":
      handleMenuClipboardWrite({ context: options.gesture, operation: action.operation });
      options.close();
      return;
    case "openInNewTab":
      handleOpenInNewTab(options.gesture);
      options.close();
      return;
    case "host":
      // Inside the click: a host item may open a window (EditorHost, editor-system.ts).
      action.run();
      options.close();
      return;
    case "toggleAnnotations":
      options.close();
      options.toggleAnnotations();
      return;
    default:
      assertNever(action);
  }
}

export function shortcutStyle(primaryModifier: "control" | "meta"): ShortcutStyle {
  switch (primaryModifier) {
    case "control":
      return "control";
    case "meta":
      return "macOS";
    default:
      return assertNever(primaryModifier);
  }
}

export function MenuPopover(properties: Readonly<{
  label: string;
  entries: readonly MenuEntry[];
  /** Where it opens; a function when the anchor is only measurable after mounting. */
  at: Point | (() => Point | null);
  gesture: GestureContext;
  onClose: () => void;
  onNeighbour: ((direction: -1 | 1) => void) | null;
  className: string;
}>): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const floatingLayer = useContext(FloatingLayerContext);
  const preferences = useViewPreferences();
  const items = properties.entries.flatMap((entry, index) => (entryIsItem(entry) ? [{ entry, index }] : []));
  const [active, setActive] = useState(() => items.findIndex((item) => !item.entry.disabled));
  const [position, setPosition] = useState<Point | null>(null);
  const requested = typeof properties.at === "function" ? null : properties.at;

  useLayoutEffect(() => {
    container.current?.focus({ preventScroll: true });
    const element = container.current;
    const at = typeof properties.at === "function" ? properties.at() : properties.at;
    if (element === null || at === null) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    setPosition({ x: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)) });
  }, [requested?.x, requested?.y, properties.label]);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    element.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (index: number): void => {
    const chosen = items[index];
    if (chosen === undefined || chosen.entry.disabled) return;
    performMenuAction({ action: chosen.entry.action, gesture: properties.gesture, close: properties.onClose, toggleAnnotations: preferences.toggleAnnotations });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = menuKeyOutcome({ key: event.key, active, items: items.map((item) => ({ label: item.entry.label, disabled: item.entry.disabled })) });
    switch (next.kind) {
      case "move":
        event.preventDefault();
        setActive(next.index);
        return;
      case "choose":
        event.preventDefault();
        choose(active);
        return;
      case "close":
        event.preventDefault();
        properties.onClose();
        return;
      case "neighbour":
        if (properties.onNeighbour === null) return;
        event.preventDefault();
        properties.onNeighbour(next.direction);
        return;
      case "none":
        return;
      default:
        assertNever(next);
    }
  };

  let itemCounter = -1;
  const content = (
    <>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "auto" }} onPointerDown={properties.onClose} onContextMenu={(event) => event.preventDefault()} />
      <div
        ref={container}
        role="menu"
        aria-label={properties.label}
        tabIndex={-1}
        className={`${TIDEPOOL_CLASS.popover} ${properties.className}`}
        style={position === null ? { left: 0, top: 0, visibility: "hidden" } : { left: position.x, top: position.y }}
        onKeyDown={onKeyDown}
      >
        {properties.entries.map((entry, index) => {
          if (!entryIsItem(entry)) return <div key={index} role="separator" className={VIEW_CLASS.menuSeparator} />;
          itemCounter += 1;
          const itemIndex = itemCounter;
          const item = entry;
          return (
            <div key={index}>
              <button
                type="button"
                role={item.checked === null ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked === null ? undefined : item.checked}
                aria-disabled={item.disabled}
                tabIndex={-1}
                data-index={itemIndex}
                data-active={itemIndex === active ? "true" : "false"}
                className={TIDEPOOL_CLASS.menuItem}
                onPointerEnter={() => setActive(itemIndex)}
                onClick={() => choose(itemIndex)}
              >
                <span style={{ inlineSize: 18, display: "inline-grid", placeItems: "center" }}>{item.checked === true ? <Icon name="check" /> : null}</span>
                <span>{item.label}</span>
                {item.shortcut === null ? null : <span className={VIEW_CLASS.menuShortcut}>{item.shortcut}</span>}
              </button>
              {item.hint === null ? null : <div className={VIEW_CLASS.menuHint}>{item.hint}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
  return floatingLayer === null ? content : createPortal(content, floatingLayer);
}

/** What a key does in an open menu; pure, for the keyboard navigation (see the header). */
export type MenuKeyOutcome =
  | Readonly<{ kind: "move"; index: number }>
  | Readonly<{ kind: "choose" }>
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "neighbour"; direction: -1 | 1 }>
  | Readonly<{ kind: "none" }>;

export function menuKeyOutcome(options: Readonly<{ key: string; active: number; items: readonly Readonly<{ label: string; disabled: boolean }>[] }>): MenuKeyOutcome {
  const count = options.items.length;
  const enabled = (index: number): boolean => options.items[index]?.disabled === false;
  const step = (from: number, direction: 1 | -1): number => {
    for (let offset = 1; offset <= count; offset += 1) {
      const candidate = (from + direction * offset + count * 2) % count;
      if (enabled(candidate)) return candidate;
    }
    return from;
  };
  switch (options.key) {
    case "ArrowDown":
      return { kind: "move", index: step(options.active, 1) };
    case "ArrowUp":
      return { kind: "move", index: step(options.active, -1) };
    case "Home":
      return { kind: "move", index: step(-1, 1) };
    case "End":
      return { kind: "move", index: step(count, -1) };
    case "Enter":
    case " ":
      return { kind: "choose" };
    case "Escape":
    case "Tab":
      return { kind: "close" };
    case "ArrowLeft":
      return { kind: "neighbour", direction: -1 };
    case "ArrowRight":
      return { kind: "neighbour", direction: 1 };
    default: {
      if (options.key.length !== 1) return { kind: "none" };
      const letter = options.key.toLowerCase();
      for (let offset = 1; offset <= count; offset += 1) {
        const candidate = (options.active + offset) % count;
        if (enabled(candidate) && options.items[candidate]?.label.toLowerCase().startsWith(letter)) return { kind: "move", index: candidate };
      }
      return { kind: "none" };
    }
  }
}

function entryIsItem(entry: MenuEntry): entry is Extract<MenuEntry, { kind: "item" }> {
  switch (entry.kind) {
    case "item":
      return true;
    case "separator":
      return false;
    default:
      return assertNever(entry);
  }
}

function neighbourMenu(menu: MenuName, direction: -1 | 1): MenuName {
  const index = MENU_ORDER.indexOf(menu);
  return MENU_ORDER[(index + direction + MENU_ORDER.length) % MENU_ORDER.length] ?? menu;
}

function menuPosition(anchor: HTMLElement | null): Point | null {
  if (anchor === null) return null;
  const rectangle = anchor.getBoundingClientRect();
  return { x: rectangle.left, y: rectangle.bottom + 6 };
}
