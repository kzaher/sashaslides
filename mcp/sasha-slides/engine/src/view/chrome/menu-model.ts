// THE MENUS AS VALUES: what each top-bar menu and the context menu offer for the current state, as
// plain entries (label, shortcut, action, whether it is available and why not). Pure, so the
// menus, the context menu and the keyboard shortcuts dialog read one definition, and a test can
// assert "Paste in the add-on says to use the keyboard" without a page.
//
// Key decisions:
//
//  * AN ACTION IS AN EVENT OR A GESTURE. Most entries dispatch an `EditorEvent`; copy, cut, Present
//    and "Open in a new tab" must run inside the click (gesture-handlers.ts), so they are their own
//    action kinds and the menu component performs them synchronously.
//  * UNAVAILABLE IS EXPLAINED. An entry that cannot run here is disabled with a hint: paste from a
//    menu needs a clipboard read no browser grants a page without a prompt, so it says to use the
//    keyboard shortcut; in the add-on dialog copy and cut say the same (SPEC.md section 14).
//  * SHORTCUTS ARE SPELLED OUT ("Control+Z"), or with the macOS symbols, never abbreviated.
//  * A ROLE THAT CANNOT EDIT SEES WHY. For a viewer or commenter (or a closed connection) every entry
//    that would change the document is disabled with the reason as its hint (access.ts), and
//    Comment with the commenting reason; copying, presenting and the View toggles stay.
//  * THE HOST'S ITEMS END THE FILE MENU (contracts/editor-system.ts `EditorHost.fileMenuItems`),
//    in the host's order, run inside the click because one may open a window; a disabled one shows
//    its `disabledReason`.

import { assertNever } from "../../contracts/assert-never.ts";
import type { ShapePreset } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { ContextMenu, EditorState, MenuName } from "../../contracts/editor-state.ts";
import type { HostMenuItem } from "../../contracts/editor-system.ts";
import type { ElementId } from "../../contracts/ids.ts";
import { findElement } from "../canvas/canvas-geometry.ts";
import { commentingDisabledReason, editingDisabledReason } from "./access.ts";

export type MenuAction =
  | Readonly<{ kind: "dispatch"; event: EditorEvent }>
  | Readonly<{ kind: "present"; from: "beginning" | "currentSlide"; withSpeakerView: boolean }>
  | Readonly<{ kind: "clipboardWrite"; operation: "copy" | "cut" }>
  | Readonly<{ kind: "openInNewTab" }>
  /** A host's File item (EditorHost.fileMenuItems), run inside the click. */
  | Readonly<{ kind: "host"; run: () => void }>
  /** View > Show annotations: the viewer's own display choice (editor-services.tsx `ViewPreferences`). */
  | Readonly<{ kind: "toggleAnnotations" }>;

export type MenuEntry =
  | Readonly<{ kind: "item"; label: string; shortcut: string | null; action: MenuAction; disabled: boolean; hint: string | null; checked: boolean | null }>
  | Readonly<{ kind: "separator" }>;

export const MENU_ORDER: readonly MenuName[] = ["file", "edit", "view", "insert", "slide", "arrange", "help"];

export const MENU_LABEL: Readonly<Record<MenuName, string>> = {
  file: "File",
  edit: "Edit",
  view: "View",
  insert: "Insert",
  slide: "Slide",
  arrange: "Arrange",
  help: "Help",
};

/** How the primary modifier is written in shortcuts. */
export type ShortcutStyle = "control" | "macOS";

export function menuEntries(options: Readonly<{ menu: MenuName; state: EditorState; shortcuts: ShortcutStyle; hostItems: readonly HostMenuItem[]; showAnnotations: boolean }>): readonly MenuEntry[] {
  const { state } = options;
  const key = shortcutWriter(options.shortcuts);
  const elementsSelected = selectedElementIds(state).length > 0;
  const groupSelected = selectionHoldsGroup(state);
  const addon = inAddonDialog(state);
  const editing = editingDisabledReason(state);
  const commenting = commentingDisabledReason(state);
  switch (options.menu) {
    case "file":
      return [
        item({ label: "Rename deck", event: { kind: "dialogOpened", dialog: { kind: "renameDeck" } }, refusal: editing }),
        separator(),
        { ...presentItem({ label: "Present from the beginning", from: "beginning", withSpeakerView: false }), shortcut: null },
        { ...presentItem({ label: "Present from this slide", from: "currentSlide", withSpeakerView: false }), shortcut: key({ primary: true, key: "Enter" }) },
        presentItem({ label: "Present with speaker view", from: "currentSlide", withSpeakerView: true }),
        ...(addon ? [separator(), { kind: "item" as const, label: "Open in a new tab", shortcut: null, action: { kind: "openInNewTab" as const }, disabled: false, hint: null, checked: null }] : []),
        separator(),
        item({ label: "Keyboard shortcuts", event: { kind: "dialogOpened", dialog: { kind: "keyboardShortcuts" } }, shortcut: key({ primary: true, key: "/" }) }),
        ...(options.hostItems.length === 0 ? [] : [separator(), ...options.hostItems.map(hostEntry)]),
      ];
    case "edit":
      return [
        item({ label: "Undo", event: { kind: "undoRequested" }, shortcut: key({ primary: true, key: "Z" }), disabled: !state.history.canUndo, refusal: editing }),
        item({ label: "Redo", event: { kind: "redoRequested" }, shortcut: key({ primary: true, shift: true, key: "Z" }), disabled: !state.history.canRedo, refusal: editing }),
        separator(),
        refused(clipboardItem({ label: "Cut", operation: "cut", shortcut: key({ primary: true, key: "X" }), addon, available: somethingCopyable(state) }), editing),
        clipboardItem({ label: "Copy", operation: "copy", shortcut: key({ primary: true, key: "C" }), addon, available: somethingCopyable(state) }),
        { kind: "item", label: "Paste", shortcut: key({ primary: true, key: "V" }), action: { kind: "dispatch", event: { kind: "menuClosed" } }, disabled: true, hint: `Use ${key({ primary: true, key: "V" })} to paste`, checked: null },
        item({ label: "Duplicate", event: { kind: "duplicateRequested" }, shortcut: key({ primary: true, key: "D" }), disabled: !somethingCopyable(state), refusal: editing }),
        item({ label: "Delete", event: { kind: "deleteRequested" }, shortcut: "Delete", disabled: !somethingCopyable(state), refusal: editing }),
        separator(),
        item({ label: "Select all", event: { kind: "selectAllRequested" }, shortcut: key({ primary: true, key: "A" }) }),
      ];
    case "view":
      return [
        toggleItem({ label: "Filmstrip", event: { kind: "panelToggled", panel: "filmstrip" }, checked: state.chrome.filmstripOpen }),
        toggleItem({ label: "Properties panel", event: { kind: "panelToggled", panel: "properties" }, checked: state.chrome.propertiesPanelOpen }),
        toggleItem({ label: "Speaker notes", event: { kind: "panelToggled", panel: "speakerNotes" }, checked: state.chrome.speakerNotesOpen }),
        toggleItem({ label: "Comments", event: { kind: "panelToggled", panel: "comments" }, checked: state.chrome.commentsOpen }),
        separator(),
        toggleItem({ label: "Fit to window", event: { kind: "zoomRequested", zoom: { kind: "fit" } }, checked: state.viewport.zoom.kind === "fit" }),
        ...[0.5, 1, 2].map((scale) => toggleItem({ label: `${scale * 100} percent`, event: { kind: "zoomRequested", zoom: { kind: "fixed", scale } }, checked: fixedZoom(state) === scale })),
        separator(),
        { kind: "item", label: "Show annotations", shortcut: null, action: { kind: "toggleAnnotations" }, disabled: false, hint: null, checked: options.showAnnotations },
      ];
    case "insert":
      return [
        item({ label: "Text box", event: { kind: "toolChosen", tool: { kind: "shape", preset: "textBox" } }, refusal: editing }),
        item({ label: "Image", event: { kind: "dialogOpened", dialog: { kind: "insertImage" } }, refusal: editing }),
        separator(),
        ...INSERTABLE_SHAPES.map((shape) => item({ label: shape.label, event: { kind: "toolChosen", tool: { kind: "shape", preset: shape.preset } }, refusal: editing })),
        item({ label: "Line", event: { kind: "toolChosen", tool: { kind: "line", routing: "straight", startArrow: "none", endArrow: "none" } }, refusal: editing }),
        item({ label: "Arrow", event: { kind: "toolChosen", tool: { kind: "line", routing: "straight", startArrow: "none", endArrow: "triangle" } }, refusal: editing }),
        item({ label: "Table", event: { kind: "dialogOpened", dialog: { kind: "insertTable" } }, refusal: editing }),
        separator(),
        item({ label: "Slide number", event: { kind: "automaticTextInsertRequested", field: "slideNumber" }, disabled: !editingText(state), hint: editingText(state) ? null : "Place the caret in a text box first", refusal: editing }),
        refused(commentItem({ state, shortcut: key({ primary: true, alt: true, key: "M" }) }), commenting),
        separator(),
        item({ label: "New slide", event: { kind: "newSlideRequested", layoutId: null }, shortcut: key({ primary: true, key: "M" }), refusal: editing }),
      ];
    case "slide":
      return slideEntries({ state, key }).map((entry) => refused(entry, editing));
    case "arrange":
      return refusedAll(editing, [
        item({ label: "Bring to front", event: arrange({ kind: "reorder", placement: "front" }), shortcut: key({ primary: true, shift: true, key: "Up" }), disabled: !elementsSelected }),
        item({ label: "Bring forward", event: arrange({ kind: "reorder", placement: "forward" }), shortcut: key({ primary: true, key: "Up" }), disabled: !elementsSelected }),
        item({ label: "Send backward", event: arrange({ kind: "reorder", placement: "backward" }), shortcut: key({ primary: true, key: "Down" }), disabled: !elementsSelected }),
        item({ label: "Send to back", event: arrange({ kind: "reorder", placement: "back" }), shortcut: key({ primary: true, shift: true, key: "Down" }), disabled: !elementsSelected }),
        separator(),
        item({ label: "Align left", event: arrange({ kind: "align", edge: "left" }), disabled: !elementsSelected }),
        item({ label: "Align centre", event: arrange({ kind: "align", edge: "horizontalCentre" }), disabled: !elementsSelected }),
        item({ label: "Align right", event: arrange({ kind: "align", edge: "right" }), disabled: !elementsSelected }),
        item({ label: "Align top", event: arrange({ kind: "align", edge: "top" }), disabled: !elementsSelected }),
        item({ label: "Align middle", event: arrange({ kind: "align", edge: "verticalCentre" }), disabled: !elementsSelected }),
        item({ label: "Align bottom", event: arrange({ kind: "align", edge: "bottom" }), disabled: !elementsSelected }),
        separator(),
        item({ label: "Distribute horizontally", event: arrange({ kind: "distribute", axis: "horizontal" }), disabled: selectedElementIds(state).length < 3, hint: selectedElementIds(state).length < 3 ? "Select three or more" : null }),
        item({ label: "Distribute vertically", event: arrange({ kind: "distribute", axis: "vertical" }), disabled: selectedElementIds(state).length < 3, hint: selectedElementIds(state).length < 3 ? "Select three or more" : null }),
        separator(),
        item({ label: "Group", event: arrange({ kind: "group" }), shortcut: key({ primary: true, key: "G" }), disabled: selectedElementIds(state).length < 2 }),
        item({ label: "Ungroup", event: arrange({ kind: "ungroup" }), shortcut: key({ primary: true, shift: true, key: "G" }), disabled: !groupSelected, hint: groupSelected ? null : UNGROUP_HINT }),
        separator(),
        item({ label: "Rotate clockwise 90 degrees", event: arrange({ kind: "rotate", degrees: 90 }), disabled: !elementsSelected }),
        item({ label: "Rotate counter-clockwise 90 degrees", event: arrange({ kind: "rotate", degrees: -90 }), disabled: !elementsSelected }),
        item({ label: "Flip horizontally", event: arrange({ kind: "flip", axis: "horizontal" }), disabled: !elementsSelected }),
        item({ label: "Flip vertically", event: arrange({ kind: "flip", axis: "vertical" }), disabled: !elementsSelected }),
        item({ label: "Centre on slide horizontally", event: arrange({ kind: "centreOnSlide", axis: "horizontal" }), disabled: !elementsSelected }),
        item({ label: "Centre on slide vertically", event: arrange({ kind: "centreOnSlide", axis: "vertical" }), disabled: !elementsSelected }),
      ]);
    case "help":
      return [item({ label: "Keyboard shortcuts", event: { kind: "dialogOpened", dialog: { kind: "keyboardShortcuts" } }, shortcut: key({ primary: true, key: "/" }) })];
    default:
      return assertNever(options.menu);
  }
}

/** The context menu for where it was opened. */
export function contextMenuEntries(options: Readonly<{ menu: ContextMenu; state: EditorState; shortcuts: ShortcutStyle }>): readonly MenuEntry[] {
  const { state } = options;
  const key = shortcutWriter(options.shortcuts);
  const addon = inAddonDialog(state);
  const editing = editingDisabledReason(state);
  const commenting = commentingDisabledReason(state);
  const paste: MenuEntry = { kind: "item", label: "Paste", shortcut: key({ primary: true, key: "V" }), action: { kind: "dispatch", event: { kind: "contextMenuClosed" } }, disabled: true, hint: `Use ${key({ primary: true, key: "V" })} to paste`, checked: null };
  switch (options.menu.scope) {
    case "element":
      return [
        refused(clipboardItem({ label: "Cut", operation: "cut", shortcut: key({ primary: true, key: "X" }), addon, available: somethingCopyable(state) }), editing),
        clipboardItem({ label: "Copy", operation: "copy", shortcut: key({ primary: true, key: "C" }), addon, available: somethingCopyable(state) }),
        paste,
        item({ label: "Duplicate", event: { kind: "duplicateRequested" }, shortcut: key({ primary: true, key: "D" }), refusal: editing }),
        item({ label: "Delete", event: { kind: "deleteRequested" }, shortcut: "Delete", refusal: editing }),
        separator(),
        item({ label: "Bring to front", event: arrange({ kind: "reorder", placement: "front" }), refusal: editing }),
        item({ label: "Send to back", event: arrange({ kind: "reorder", placement: "back" }), refusal: editing }),
        item({ label: "Group", event: arrange({ kind: "group" }), disabled: selectedElementIds(state).length < 2, refusal: editing }),
        item({ label: "Ungroup", event: arrange({ kind: "ungroup" }), disabled: !selectionHoldsGroup(state), hint: selectionHoldsGroup(state) ? null : UNGROUP_HINT, refusal: editing }),
        separator(),
        refused(commentItem({ state, shortcut: key({ primary: true, alt: true, key: "M" }) }), commenting),
      ];
    case "canvas":
      return [
        paste,
        item({ label: "Select all", event: { kind: "selectAllRequested" }, shortcut: key({ primary: true, key: "A" }) }),
        separator(),
        item({ label: "New slide", event: { kind: "newSlideRequested", layoutId: null }, refusal: editing }),
        item({ label: "Change background", event: { kind: "propertiesTabChosen", tab: "slide" } }),
        item({ label: "Transition", event: { kind: "propertiesTabChosen", tab: "transition" } }),
        refused(commentItem({ state, shortcut: key({ primary: true, alt: true, key: "M" }) }), commenting),
      ];
    case "filmstrip":
      return slideEntries({ state, key }).map((entry) => refused(entry, editing));
    default:
      return assertNever(options.menu.scope);
  }
}

/** The keyboard shortcuts dialog's rows (SPEC.md section 7, "Keyboard"). */
export function shortcutRows(shortcuts: ShortcutStyle): readonly Readonly<{ keys: string; action: string }>[] {
  const key = shortcutWriter(shortcuts);
  return [
    { keys: `${key({ primary: true, key: "Z" })}, ${key({ primary: true, shift: true, key: "Z" })}`, action: "Undo, redo" },
    { keys: `${key({ primary: true, key: "C" })}, ${key({ primary: true, key: "X" })}, ${key({ primary: true, key: "V" })}`, action: "Copy, cut, paste" },
    { keys: key({ primary: true, key: "D" }), action: "Duplicate" },
    { keys: "Delete, Backspace", action: "Delete the selection" },
    { keys: key({ primary: true, key: "A" }), action: "Select all" },
    { keys: "Arrow keys, Shift+Arrow keys", action: "Nudge by 1 unit, by 10 units" },
    { keys: `${key({ primary: true, key: "G" })}, ${key({ primary: true, shift: true, key: "G" })}`, action: "Group, ungroup" },
    { keys: `${key({ primary: true, key: "Up" })}, ${key({ primary: true, shift: true, key: "Up" })}`, action: "Bring forward, to front" },
    { keys: "Enter", action: "Edit the text of the selected element" },
    { keys: "Escape", action: "Leave text editing, leave the group, clear the selection" },
    { keys: "Tab, Shift+Tab", action: "Next or previous element; in text, list level" },
    { keys: `${key({ primary: true, key: "B" })}, ${key({ primary: true, key: "I" })}, ${key({ primary: true, key: "U" })}`, action: "Bold, italic, underline" },
    { keys: key({ primary: true, shift: true, key: "X" }), action: "Strikethrough" },
    { keys: `${key({ primary: true, shift: true, key: "L" })}, E, R, J`, action: "Align start, centre, end, justify" },
    { keys: `${key({ primary: true, shift: true, key: "7" })}, ${key({ primary: true, shift: true, key: "8" })}`, action: "Numbered list, bulleted list" },
    { keys: key({ primary: true, key: "K" }), action: "Link" },
    { keys: key({ primary: true, key: "M" }), action: "New slide" },
    { keys: key({ primary: true, alt: true, key: "M" }), action: "Comment on the selection" },
    { keys: key({ primary: true, key: "Enter" }), action: "Present from the current slide" },
    { keys: "Page Up, Page Down", action: "Previous slide, next slide" },
  ];
}

/** The ids of the selected elements, or none. */
export function selectedElementIds(state: EditorState): readonly ElementId[] {
  const selection = state.selection;
  switch (selection.kind) {
    case "elements":
      return selection.elementIds;
    case "none":
    case "slides":
    case "text":
    case "tableCells":
      return [];
    default:
      return assertNever(selection);
  }
}

/** Whether the selection holds at least one group: Ungroup has nothing to do on anything else. */
export function selectionHoldsGroup(state: EditorState): boolean {
  const selection = state.selection;
  if (selection.kind !== "elements") return false;
  const slide = state.document.slides.find((candidate) => candidate.id === selection.slideId);
  if (slide === undefined) return false;
  return selection.elementIds.some((id) => findElement(slide.elements, id)?.kind === "group");
}

/** Why Ungroup is unavailable, as its hint. */
export const UNGROUP_HINT = "Select a group first";

const INSERTABLE_SHAPES: readonly Readonly<{ label: string; preset: ShapePreset }>[] = [
  { label: "Rectangle", preset: "rectangle" },
  { label: "Rounded rectangle", preset: "roundedRectangle" },
  { label: "Ellipse", preset: "ellipse" },
  { label: "Triangle", preset: "triangle" },
  { label: "Star", preset: "fivePointStar" },
  { label: "Arrow shape", preset: "rightArrow" },
  { label: "Speech bubble", preset: "speechBubble" },
];

function slideEntries(options: Readonly<{ state: EditorState; key: ShortcutWriter }>): readonly MenuEntry[] {
  const { state, key } = options;
  const current = state.document.slides.find((slide) => slide.id === state.currentSlideId) ?? null;
  const scriptId = current?.transition !== null && current?.transition !== undefined ? scriptedTransitionId(current.transition) : null;
  return [
    item({ label: "New slide", event: { kind: "newSlideRequested", layoutId: null }, shortcut: key({ primary: true, key: "M" }) }),
    item({ label: "New slide from a layout", event: { kind: "dialogOpened", dialog: { kind: "newSlideFromLayout", layoutIds: state.document.layouts.map((layout) => layout.id) } }, disabled: state.document.layouts.length === 0, hint: state.document.layouts.length === 0 ? "This deck has no layouts" : null }),
    item({ label: "Duplicate slide", event: { kind: "duplicateRequested" }, disabled: current === null }),
    item({ label: "Delete slide", event: { kind: "deleteRequested" }, disabled: current === null }),
    toggleItem({ label: "Skip slide", event: { kind: "slidePropertiesRequested", patch: { skipped: !(current?.skipped ?? false) } }, checked: current?.skipped ?? false }),
    separator(),
    item({ label: "Change background", event: { kind: "propertiesTabChosen", tab: "slide" } }),
    item({ label: "Transition", event: { kind: "propertiesTabChosen", tab: "transition" } }),
    item({ label: scriptId === null ? "Write a transition script" : "Edit transition script", event: { kind: "transitionScriptEditorOpened", scriptId, purpose: "transition" } }),
  ];
}

function scriptedTransitionId(transition: NonNullable<EditorState["document"]["slides"][number]["transition"]>): NonNullable<Extract<typeof transition, { kind: "scripted" }>["scriptId"]> | null {
  switch (transition.kind) {
    case "scripted":
      return transition.scriptId;
    case "builtin":
      return null;
    default:
      return assertNever(transition);
  }
}

/** An entry that dispatches `event`; `refusal` (why this person cannot do it now) disables it with that hint. */
function item(options: Readonly<{ label: string; event: EditorEvent; shortcut?: string; disabled?: boolean; hint?: string | null; refusal?: string | null }>): MenuEntry {
  const entry: MenuEntry = { kind: "item", label: options.label, shortcut: options.shortcut ?? null, action: { kind: "dispatch", event: options.event }, disabled: options.disabled ?? false, hint: options.hint ?? null, checked: null };
  return refused(entry, options.refusal ?? null);
}

/** The entry disabled with `refusal` as its hint; unchanged when there is none. Separators pass. */
function refused(entry: MenuEntry, refusal: string | null): MenuEntry {
  if (refusal === null) return entry;
  switch (entry.kind) {
    case "item":
      return { ...entry, disabled: true, hint: refusal };
    case "separator":
      return entry;
    default:
      return assertNever(entry);
  }
}

function refusedAll(refusal: string | null, entries: readonly MenuEntry[]): readonly MenuEntry[] {
  return entries.map((entry) => refused(entry, refusal));
}

/** A host's File item: runs inside the click; a disabled one explains itself. */
function hostEntry(hostItem: HostMenuItem): MenuEntry {
  return { kind: "item", label: hostItem.label, shortcut: null, action: { kind: "host", run: hostItem.run }, disabled: hostItem.disabledReason !== null, hint: hostItem.disabledReason, checked: null };
}

function toggleItem(options: Readonly<{ label: string; event: EditorEvent; checked: boolean }>): MenuEntry {
  return { kind: "item", label: options.label, shortcut: null, action: { kind: "dispatch", event: options.event }, disabled: false, hint: null, checked: options.checked };
}

function presentItem(options: Readonly<{ label: string; from: "beginning" | "currentSlide"; withSpeakerView: boolean }>): Extract<MenuEntry, { kind: "item" }> {
  return { kind: "item", label: options.label, shortcut: null, action: { kind: "present", from: options.from, withSpeakerView: options.withSpeakerView }, disabled: false, hint: null, checked: null };
}

function clipboardItem(options: Readonly<{ label: string; operation: "copy" | "cut"; shortcut: string; addon: boolean; available: boolean }>): MenuEntry {
  return {
    kind: "item",
    label: options.label,
    shortcut: options.shortcut,
    action: { kind: "clipboardWrite", operation: options.operation },
    disabled: options.addon || !options.available,
    hint: options.addon ? `In this dialog, use ${options.shortcut}` : null,
    checked: null,
  };
}

function commentItem(options: Readonly<{ state: EditorState; shortcut: string }>): MenuEntry {
  const slideId = options.state.currentSlideId;
  if (slideId === null) return { kind: "item", label: "Comment", shortcut: options.shortcut, action: { kind: "dispatch", event: { kind: "menuClosed" } }, disabled: true, hint: "Add a slide first", checked: null };
  const elementId = selectedElementIds(options.state)[0] ?? null;
  return item({ label: "Comment", event: { kind: "commentComposerOpened", slideId, elementId, textRange: null, region: null }, shortcut: options.shortcut });
}

function separator(): MenuEntry {
  return { kind: "separator" };
}

function arrange(action: Extract<EditorEvent, { kind: "arrangeRequested" }>["action"]): EditorEvent {
  return { kind: "arrangeRequested", action };
}

function somethingCopyable(state: EditorState): boolean {
  const selection = state.selection;
  switch (selection.kind) {
    case "elements":
    case "slides":
    case "text":
    case "tableCells":
      return true;
    case "none":
      return false;
    default:
      return assertNever(selection);
  }
}

function editingText(state: EditorState): boolean {
  const selection = state.selection;
  switch (selection.kind) {
    case "text":
      return true;
    case "none":
    case "slides":
    case "elements":
    case "tableCells":
      return false;
    default:
      return assertNever(selection);
  }
}

function inAddonDialog(state: EditorState): boolean {
  switch (state.embedding.kind) {
    case "addonDialog":
      return true;
    case "webApplication":
      return false;
    default:
      return assertNever(state.embedding);
  }
}

function fixedZoom(state: EditorState): number | null {
  const zoom = state.viewport.zoom;
  switch (zoom.kind) {
    case "fixed":
      return zoom.scale;
    case "fit":
      return null;
    default:
      return assertNever(zoom);
  }
}

type ShortcutWriter = (chord: Readonly<{ primary?: boolean; shift?: boolean; alt?: boolean; key: string }>) => string;

function shortcutWriter(style: ShortcutStyle): ShortcutWriter {
  return (chord) => {
    const parts: string[] = [];
    switch (style) {
      case "control":
        if (chord.primary === true) parts.push("Control");
        if (chord.alt === true) parts.push("Alt");
        if (chord.shift === true) parts.push("Shift");
        parts.push(chord.key);
        return parts.join("+");
      case "macOS":
        if (chord.alt === true) parts.push("⌥");
        if (chord.shift === true) parts.push("⇧");
        if (chord.primary === true) parts.push("⌘");
        return parts.join("") + chord.key;
      default:
        return assertNever(style);
    }
  };
}
