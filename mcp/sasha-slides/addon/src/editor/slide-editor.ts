// THE VISUAL EDITOR — click a thing on the candidate, drag it, resize it, recolour it, retype it.
//
// It implements the `SlideEditor` interface in ../../UI-CONTRACT.md and knows nothing about Apps
// Script, Drive, the picker's state machine or the server, so it runs in a plain browser tab (see
// harness/) and the host only has to hand it an iframe.
//
// WHERE THE CHROME LIVES. Every pixel the editor draws -- the hover outline, the selection box, its
// eight handles, the little toolbar -- is in the HOST document, `position: fixed`, over the iframe.
// Nothing is injected into the candidate. That matters for three reasons: `html()` is then a
// serialization of exactly what the user sees with no chrome to strip; the candidate keeps running
// under the strictest sandbox that still permits DOM access; and `detach()` has one subtree and one
// AbortController to drop.
//
// WHERE THE EVENTS COME FROM. Selection is a `pointerdown` on the candidate's own document (same
// origin, so the host can listen on it even though the frame may run no scripts of its own). Drags
// are handled on the HOST, because the selection box and the handles are host elements: a drag that
// leaves the iframe keeps working, and pointer capture behaves.
//
// COORDINATES. Three spaces, converted at exactly one place each:
//   host viewport px  <- `hostBoxOf`     -- for drawing chrome
//   slide fractions   <- `fractionAt`    -- for every record, and for all gesture arithmetic
//   slide px          <- `declarationsFor` (slide-edit.ts) -- only inside a CSS declaration
// The frame's on-screen rect IS the slide's 0..1 box, whatever CSS transform scaled it, so a
// fraction needs no knowledge of the scale factor and cannot drift with it.

import { assertNever } from "../protocol.ts";
import { swatchValueOf } from "./css-colour.ts";
import {
  EDITING_ATTRIBUTE,
  applyEdits,
  baselineOf,
  colourOf,
  editedHtmlOf,
  measureOf,
  slideDomOf,
  type Measurement,
  type SlideDom,
} from "./apply-edits.ts";
import { layoutFactsOf, mayMove, mayRecolour, mayRemove, mayResize, mayRetext, ownTextOf, type LayoutFacts } from "./editable.ts";
import { selectorIndexOf, type SelectorIndex } from "./stable-selector.ts";
import { OVERLAY_CLASS_PREFIX, OVERLAY_CSS, OVERLAY_STYLE_ID } from "./overlay-styles.ts";
import {
  SLIDE_HEIGHT_PX,
  SLIDE_WIDTH_PX,
  appendEdit,
  overridesOf,
  removedTargetsOf,
  type ColourProperty,
  type ElementBaseline,
  type SlideEdit,
} from "./slide-edit.ts";

/**
 * The interface the host consumes. Transcribed from ../../UI-CONTRACT.md; do not widen it here.
 *
 * TWO THINGS THE HOST MUST GET RIGHT, both of which the editor reports rather than guesses at:
 *
 *  - The frame must be SAME-ORIGIN. `sandbox=""` (what the picker's read-only pane uses) gives the
 *    document an opaque origin and `contentDocument` is null, so nothing is editable. The editable
 *    pane needs `sandbox="allow-same-origin"`, WITHOUT `allow-scripts` -- that combination still
 *    denies the candidate any script of its own while letting the host reach in.
 *  - The frame must render the whole 1280x720 document, scaled by a CSS TRANSFORM on the iframe
 *    element (`width: 1280px; height: 720px; transform: scale(k)`), which is exactly what
 *    `.sasha-frame` already does. Every coordinate here is a fraction of the frame's on-screen
 *    rect, so the editor never needs to know `k` -- but an iframe sized at 640px CSS width instead
 *    would have a 640px INTERNAL viewport, and the slide would be laid out differently inside it.
 */
export type SlideEditor = Readonly<{
  /** Attach to an iframe already showing the candidate. */
  attach(options: Readonly<{ frame: HTMLIFrameElement; onChange: (edits: readonly SlideEdit[]) => void }>): void;
  /** Every edit so far, in the order made. */
  edits(): readonly SlideEdit[];
  /** The candidate's HTML with the edits applied, for writing back. */
  html(): string;
  /** Undo the last edit; returns false when there is nothing to undo. */
  undo(): boolean;
  detach(): void;
}>;

export type SlideEditorOptions = Readonly<{
  /**
   * Where a refused gesture goes. The contract says an edit that is not one of the five kinds is
   * dropped WITH A WARNING -- this is the warning, and it defaults to `console.warn` so a host that
   * does not care still leaves a trail in the browser console.
   */
  onWarning?: (message: string) => void;
}>;

/** A resize handle. `n`/`w` edges move the element's origin as well as its size. */
export type Edge = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const EDGES: readonly Edge[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Smaller than this and the element cannot be grabbed again. 8 slide px. */
const MIN_FRACTION_W = 8 / SLIDE_WIDTH_PX;
const MIN_FRACTION_H = 8 / SLIDE_HEIGHT_PX;

export function createSlideEditor(options?: SlideEditorOptions): SlideEditor {
  const warn = (message: string): void => {
    const sink = options?.onWarning;
    if (sink === undefined) console.warn(`[sasha-slides editor] ${message}`);
    else sink(message);
  };

  let session: Session | null = null;
  let records: readonly SlideEdit[] = [];

  /** Null-guarded access, so every handler below reads as if attachment were proven. */
  const live = (): Session | null => session;

  const resolve = (target: string): Element | null => {
    const current = live();
    if (current === null) return null;
    const known = current.index.elementOf.get(target);
    if (known !== undefined && known.isConnected) return known;
    // A retext replaces an element's children, so a target INSIDE a retexted element can die
    // mid-session. Re-resolving by selector is the cheap recovery; null means it is really gone and
    // `applyEdits` warns rather than silently losing the edit.
    return current.dom.document.querySelector(target);
  };

  const reapply = (extra: readonly SlideEdit[]): void => {
    const current = live();
    if (current === null) return;
    applyEdits({
      edits: extra.length === 0 ? records : extra.reduce((list, edit) => appendEdit({ edits: list, edit }), records),
      resolve,
      baselines: current.baselines,
      pristineInnerHtml: current.pristineInnerHtml,
      onWarning: warn,
    });
  };

  const commit = (edits: readonly SlideEdit[]): void => {
    const current = live();
    if (current === null) return;
    records = edits.reduce((list, edit) => appendEdit({ edits: list, edit }), records);
    reapply([]);
    syncChrome();
    current.onChange(records);
  };

  const baselineFor = (target: string, element: Element): ElementBaseline => {
    const current = live();
    if (current === null) return { transform: "none", inlineStyle: "" };
    const known = current.baselines.get(target);
    if (known !== undefined) return known;
    const fresh = baselineOf({ element, view: current.dom.view });
    current.baselines.set(target, fresh);
    return fresh;
  };

  /** Chrome geometry: the selected element's fractional box, drawn in host viewport pixels. */
  const syncChrome = (): void => {
    const current = live();
    if (current === null) return;
    const selected = current.selected;
    if (selected === null) {
      current.chrome.select.style.display = "none";
      current.chrome.bar.style.display = "none";
      return;
    }
    const element = resolve(selected.target);
    if (element === null) {
      clearSelection();
      return;
    }
    const box = hostBoxOf({ frame: current.frame, measurement: measureOf({ element, view: current.dom.view }) });
    placeBox({ node: current.chrome.select, box });
    current.chrome.select.style.display = current.textEdit === null ? "block" : "none";
    const bar = current.chrome.bar;
    bar.style.display = current.textEdit === null ? "flex" : "none";
    bar.style.left = `${Math.max(4, box.left)}px`;
    bar.style.top = `${Math.max(4, box.top - 30)}px`;
  };

  const describeSelection = (selected: Selected): void => {
    const current = live();
    if (current === null) return;
    const { chrome } = current;
    chrome.targetLabel.textContent = selected.target;
    chrome.targetLabel.title = selected.target;
    const resizable = mayResize(selected.facts);
    for (const handle of chrome.handles) {
      handle.dataset["refused"] = resizable.kind === "allowed" ? "no" : "yes";
    }
    chrome.select.style.cursor = mayMove(selected.facts).kind === "allowed" ? "move" : "not-allowed";
    chrome.textButton.disabled = mayRetext(selected.facts).kind !== "allowed";
    chrome.deleteButton.disabled = mayRemove(selected.facts).kind !== "allowed";
    const recolourable = mayRecolour(selected.facts).kind === "allowed";
    chrome.textColour.disabled = !recolourable;
    chrome.backColour.disabled = !recolourable;
    chrome.parentButton.disabled = selected.element.parentElement === null;
    if (!recolourable) return;
    const view = current.dom.view;
    chrome.textColour.value = swatchValueOf({
      colour: colourOf({ element: selected.element, view, property: "color" }),
      fallback: "#000000",
    });
    chrome.backColour.value = swatchValueOf({
      colour: colourOf({ element: selected.element, view, property: "background" }),
      fallback: "#ffffff",
    });
  };

  const selectElement = (element: Element): void => {
    const current = live();
    if (current === null) return;
    const target = current.index.targetOf.get(element) ?? nearestTarget({ element, index: current.index });
    if (target === null) {
      warn("that element has no stable selector, so no edit to it could name it; nothing selected");
      return;
    }
    const resolved = resolve(target);
    if (resolved === null) return;
    const selected: Selected = {
      target,
      element: resolved,
      facts: layoutFactsOf({ element: resolved, view: current.dom.view }),
    };
    current.selected = selected;
    baselineFor(target, resolved);
    describeSelection(selected);
    syncChrome();
  };

  const clearSelection = (): void => {
    const current = live();
    if (current === null) return;
    current.selected = null;
    syncChrome();
  };

  const fractionAt = (event: Readonly<{ clientX: number; clientY: number }>): Readonly<{ fx: number; fy: number }> => {
    const current = live();
    if (current === null) return { fx: 0, fy: 0 };
    const rect = current.frame.getBoundingClientRect();
    return {
      fx: (event.clientX - rect.left) / Math.max(1, rect.width),
      fy: (event.clientY - rect.top) / Math.max(1, rect.height),
    };
  };

  const beginGesture = (gesture: Gesture): void => {
    const current = live();
    if (current === null) return;
    current.gesture = gesture;
  };

  const dragTo = (event: Readonly<{ clientX: number; clientY: number }>): void => {
    const current = live();
    if (current === null || current.gesture === null) return;
    const at = fractionAt(event);
    reapply(intendedEditsFor({ gesture: current.gesture, at }));
    syncChrome();
  };

  /**
   * Finish a drag. The record carries the MEASURED result, not what the pointer asked for: a
   * `min-content` width or a wrapping line can refuse the last few pixels of a resize, and a record
   * that claims a width the slide does not have would teach the model something false.
   */
  const endDrag = (event: Readonly<{ clientX: number; clientY: number }>): void => {
    const current = live();
    if (current === null || current.gesture === null) return;
    const gesture = current.gesture;
    current.gesture = null;
    const at = fractionAt(event);
    const intended = intendedEditsFor({ gesture, at });
    if (intended.length === 0) return;
    reapply(intended);
    const element = resolve(gesture.target);
    const actual = element === null ? null : measureOf({ element, view: current.dom.view });
    commit(actual === null ? intended : measuredEditsFor({ intended, actual }));
  };

  /**
   * A swatch drag is a gesture like any other: `input` previews, `change` commits.
   *
   * `from` therefore CANNOT be re-measured at commit time -- by then the preview has already
   * painted the new colour onto the element, `from` would read back equal to `to`, and the record
   * would be dropped as a no-op. (It was: the gesture previewed correctly and recorded nothing,
   * and only the live browser harness caught it.) So the original colour is captured when the
   * gesture STARTS, exactly like a drag captures its origin at `pointerdown`.
   */
  const applyColour = ({
    property,
    value,
    record,
  }: {
    property: ColourProperty;
    value: string;
    record: boolean;
  }): void => {
    const current = live();
    if (current === null) return;
    const selected = current.selected;
    if (selected === null) return;
    const permitted = mayRecolour(selected.facts);
    if (permitted.kind === "refused") {
      warn(`dropped a recolour: ${permitted.reason}`);
      return;
    }
    const started = current.colour;
    const resumed = started !== null && started.target === selected.target && started.property === property;
    const from = resumed && started !== null ? started.from : colourOf({ element: selected.element, view: current.dom.view, property });
    current.colour = record ? null : { target: selected.target, property, from };
    const edit: SlideEdit = { kind: "recoloured", target: selected.target, property, from, to: value };
    if (record) commit([edit]);
    else reapply([edit]);
  };

  const startTextEdit = (): void => {
    const current = live();
    if (current === null) return;
    const selected = current.selected;
    if (selected === null) return;
    const permitted = mayRetext(selected.facts);
    if (permitted.kind === "refused") {
      warn(`dropped a retext: ${permitted.reason}`);
      return;
    }
    const element = selected.element;
    if (!current.pristineInnerHtml.has(selected.target)) {
      current.pristineInnerHtml.set(selected.target, element.innerHTML);
    }
    current.textEdit = { target: selected.target, element, before: ownTextOf(element) };
    element.setAttribute(EDITING_ATTRIBUTE, "yes");
    // `plaintext-only` is what makes this honest: `retext.to` is a plain string, so the user must
    // not be able to paste markup into a field whose record cannot carry it.
    element.setAttribute("contenteditable", "plaintext-only");
    const focusable: unknown = (element as Readonly<{ focus?: unknown }>).focus;
    if (typeof focusable === "function") focusable.call(element);
    current.dom.view.getSelection()?.selectAllChildren(element);
    syncChrome();
  };

  const finishTextEdit = ({ keep }: { keep: boolean }): void => {
    const current = live();
    if (current === null || current.textEdit === null) return;
    const textEdit = current.textEdit;
    current.textEdit = null;
    const after = ownTextOf(textEdit.element);
    textEdit.element.removeAttribute("contenteditable");
    textEdit.element.removeAttribute(EDITING_ATTRIBUTE);
    if (!keep || after === textEdit.before) {
      reapply([]);
      syncChrome();
      return;
    }
    commit([{ kind: "retext", target: textEdit.target, to: after }]);
  };

  const removeSelected = (): void => {
    const current = live();
    if (current === null) return;
    const selected = current.selected;
    if (selected === null) return;
    const permitted = mayRemove(selected.facts);
    if (permitted.kind === "refused") {
      warn(`dropped a removal: ${permitted.reason}`);
      return;
    }
    const target = selected.target;
    clearSelection();
    commit([{ kind: "removed", target }]);
  };

  return {
    attach({ frame, onChange }): void {
      if (session !== null) this.detach();
      const reached = slideDomOf(frame);
      if (reached.kind === "unreachable") {
        // Said out loud, never swallowed: the host has handed over a frame this editor cannot edit,
        // and a silent no-op would look exactly like a broken pointer handler.
        warn(`cannot attach: ${reached.reason}`);
        return;
      }
      records = [];
      const dom = reached.dom;
      const hostDocument = frame.ownerDocument;
      const listeners = new AbortController();
      const chrome = mountChrome({ hostDocument });
      const fresh: Session = {
        frame,
        dom,
        onChange,
        chrome,
        listeners,
        index: selectorIndexOf({ root: dom.body }),
        baselines: new Map<string, ElementBaseline>(),
        pristineInnerHtml: new Map<string, string>(),
        selected: null,
        gesture: null,
        colour: null,
        textEdit: null,
        observer: null,
      };
      session = fresh;
      const signal = listeners.signal;

      dom.document.addEventListener(
        "pointerdown",
        (event: Event) => {
          const target = eventElementOf(event);
          if (target === null) return;
          if (fresh.textEdit !== null && fresh.textEdit.element.contains(target)) return;
          if (fresh.textEdit !== null) finishTextEdit({ keep: true });
          selectElement(target);
        },
        { signal },
      );
      dom.document.addEventListener(
        "pointermove",
        (event: Event) => {
          const target = eventElementOf(event);
          if (target === null || fresh.gesture !== null) return;
          const known = fresh.index.targetOf.get(target);
          if (known === undefined) return;
          const box = hostBoxOf({ frame, measurement: measureOf({ element: target, view: dom.view }) });
          placeBox({ node: chrome.hover, box });
          chrome.hover.style.display = "block";
        },
        { signal },
      );
      dom.document.addEventListener("pointerleave", () => (chrome.hover.style.display = "none"), { signal });
      dom.document.addEventListener(
        "keydown",
        (event: Event) => {
          if (fresh.textEdit === null) return;
          const key = keyOf(event);
          if (key === "Escape") finishTextEdit({ keep: false });
          if (key === "Enter") {
            event.preventDefault();
            finishTextEdit({ keep: true });
          }
        },
        { signal },
      );

      chrome.select.addEventListener(
        "pointerdown",
        (event: PointerEvent) => {
          const selected = fresh.selected;
          if (selected === null) return;
          // Before the refusal check, not after: a press on the overlay must never start a text
          // selection in the HOST page, and a REFUSED gesture is still a press on the overlay.
          // (It did, and only a screenshot showed it -- the right-hand panel came out highlighted.)
          event.preventDefault();
          const permitted = mayMove(selected.facts);
          if (permitted.kind === "refused") {
            warn(`dropped a move: ${permitted.reason}`);
            return;
          }
          capturePointer({ element: chrome.select, pointerId: event.pointerId, onWarning: warn });
          const at = fractionAt(event);
          beginGesture({
            kind: "move",
            target: selected.target,
            from: measureOf({ element: selected.element, view: dom.view }),
            startX: at.fx,
            startY: at.fy,
          });
        },
        { signal },
      );
      chrome.select.addEventListener("dblclick", () => startTextEdit(), { signal });
      for (const handle of chrome.handles) {
        handle.addEventListener(
          "pointerdown",
          (event: PointerEvent) => {
            const selected = fresh.selected;
            if (selected === null) return;
            event.preventDefault();
            event.stopPropagation();
            const permitted = mayResize(selected.facts);
            if (permitted.kind === "refused") {
              warn(`dropped a resize: ${permitted.reason}`);
              return;
            }
            capturePointer({ element: handle, pointerId: event.pointerId, onWarning: warn });
            const at = fractionAt(event);
            beginGesture({
              kind: "resize",
              edge: edgeOf(handle),
              target: selected.target,
              from: measureOf({ element: selected.element, view: dom.view }),
              startX: at.fx,
              startY: at.fy,
            });
          },
          { signal },
        );
      }
      hostDocument.addEventListener("pointermove", (event: PointerEvent) => dragTo(event), { signal });
      hostDocument.addEventListener("pointerup", (event: PointerEvent) => endDrag(event), { signal });
      hostDocument.addEventListener("pointercancel", (event: PointerEvent) => endDrag(event), { signal });

      chrome.textColour.addEventListener("input", () => applyColour({ property: "color", value: chrome.textColour.value, record: false }), { signal });
      chrome.textColour.addEventListener("change", () => applyColour({ property: "color", value: chrome.textColour.value, record: true }), { signal });
      chrome.backColour.addEventListener("input", () => applyColour({ property: "background", value: chrome.backColour.value, record: false }), { signal });
      chrome.backColour.addEventListener("change", () => applyColour({ property: "background", value: chrome.backColour.value, record: true }), { signal });
      chrome.textButton.addEventListener("click", () => startTextEdit(), { signal });
      chrome.deleteButton.addEventListener("click", () => removeSelected(), { signal });
      chrome.parentButton.addEventListener(
        "click",
        () => {
          const parent = fresh.selected?.element.parentElement;
          if (parent !== null && parent !== undefined) selectElement(parent);
        },
        { signal },
      );

      // The chrome is `position: fixed` over the frame, so anything that moves the frame on screen
      // has to redraw it. Scroll is captured because the frame may sit in a scrolling pane.
      hostDocument.defaultView?.addEventListener("resize", () => syncChrome(), { signal });
      hostDocument.addEventListener("scroll", () => syncChrome(), { signal, capture: true });
      const observer = new ResizeObserver(() => syncChrome());
      observer.observe(frame);
      fresh.observer = observer;
    },

    edits(): readonly SlideEdit[] {
      return records;
    },

    html(): string {
      const current = live();
      if (current === null) throw new Error("the slide editor is not attached, so there is no HTML to write back");
      if (current.textEdit !== null) finishTextEdit({ keep: true });
      return editedHtmlOf({
        document: current.dom.document,
        removedTargets: removedTargetsOf(overridesOf(records)),
      });
    },

    /**
     * Drop the last record and re-apply the rest. One record is one finished gesture, and a run of
     * same-kind gestures on the same element is ONE record (see `appendEdit`), so this steps back
     * the whole run -- "put the title back where it was", not "give me back 4 of the 60 pixels".
     */
    undo(): boolean {
      if (records.length === 0) return false;
      const current = live();
      records = records.slice(0, -1);
      reapply([]);
      syncChrome();
      if (current !== null) {
        const selected = current.selected;
        if (selected !== null) describeSelection(selected);
        current.onChange(records);
      }
      return true;
    },

    detach(): void {
      const current = live();
      if (current === null) return;
      session = null;
      if (current.textEdit !== null) {
        current.textEdit.element.removeAttribute("contenteditable");
        current.textEdit.element.removeAttribute(EDITING_ATTRIBUTE);
      }
      current.listeners.abort();
      current.observer?.disconnect();
      current.chrome.root.remove();
      // The stylesheet is SHARED and only the editor that installed it takes it away -- the defect
      // report attaches one editor per pane, so two instances are live at once over the same host
      // document, and a detach that removed a stylesheet it did not install would strip the chrome
      // off its sibling.
      if (current.chrome.ownsStyle) current.chrome.style.remove();
    },
  };
}

/** One attached editor's mutable world. Nothing outside `createSlideEditor` ever sees it. */
type Session = {
  readonly frame: HTMLIFrameElement;
  readonly dom: SlideDom;
  readonly onChange: (edits: readonly SlideEdit[]) => void;
  readonly chrome: Chrome;
  readonly listeners: AbortController;
  readonly index: SelectorIndex;
  readonly baselines: Map<string, ElementBaseline>;
  readonly pristineInnerHtml: Map<string, string>;
  selected: Selected | null;
  gesture: Gesture | null;
  /** The in-flight swatch gesture, holding the colour the element had before the preview. */
  colour: ColourGesture | null;
  textEdit: TextEdit | null;
  observer: ResizeObserver | null;
};

type Selected = Readonly<{ target: string; element: Element; facts: LayoutFacts }>;

type Gesture =
  | Readonly<{ kind: "move"; target: string; from: Measurement; startX: number; startY: number }>
  | Readonly<{ kind: "resize"; edge: Edge; target: string; from: Measurement; startX: number; startY: number }>;

type ColourGesture = Readonly<{ target: string; property: ColourProperty; from: string }>;

type TextEdit = Readonly<{ target: string; element: Element; before: string }>;

type Chrome = Readonly<{
  style: HTMLStyleElement;
  /** Whether THIS editor installed the shared stylesheet, and so is the one that may remove it. */
  ownsStyle: boolean;
  root: HTMLDivElement;
  hover: HTMLDivElement;
  select: HTMLDivElement;
  handles: readonly HTMLDivElement[];
  bar: HTMLDivElement;
  targetLabel: HTMLSpanElement;
  parentButton: HTMLButtonElement;
  textColour: HTMLInputElement;
  backColour: HTMLInputElement;
  textButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
}>;

type HostBox = Readonly<{ left: number; top: number; width: number; height: number }>;

/** The slide's 0..1 box IS the frame's on-screen rect, so no scale factor appears anywhere. */
function hostBoxOf({ frame, measurement }: { frame: HTMLIFrameElement; measurement: Measurement }): HostBox {
  const rect = frame.getBoundingClientRect();
  return {
    left: rect.left + measurement.position.x * rect.width,
    top: rect.top + measurement.position.y * rect.height,
    width: measurement.size.w * rect.width,
    height: measurement.size.h * rect.height,
  };
}

function placeBox({ node, box }: { node: HTMLElement; box: HostBox }): void {
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
}

/** What the gesture is asking for, in fractions. Pure: the same call previews and commits. */
function intendedEditsFor({ gesture, at }: { gesture: Gesture; at: Readonly<{ fx: number; fy: number }> }): readonly SlideEdit[] {
  const dx = at.fx - gesture.startX;
  const dy = at.fy - gesture.startY;
  switch (gesture.kind) {
    case "move":
      return [
        {
          kind: "moved",
          target: gesture.target,
          from: gesture.from.position,
          to: { x: round4(gesture.from.position.x + dx), y: round4(gesture.from.position.y + dy) },
        },
      ];
    case "resize": {
      const edge = gesture.edge;
      const west = edge.includes("w");
      const east = edge.includes("e");
      const north = edge.includes("n");
      const south = edge.includes("s");
      const width = Math.max(MIN_FRACTION_W, gesture.from.size.w + (east ? dx : 0) - (west ? dx : 0));
      const height = Math.max(MIN_FRACTION_H, gesture.from.size.h + (south ? dy : 0) - (north ? dy : 0));
      const edits: SlideEdit[] = [
        {
          kind: "resized",
          target: gesture.target,
          from: gesture.from.size,
          to: { w: round4(width), h: round4(height) },
        },
      ];
      if (west || north) {
        edits.push({
          kind: "moved",
          target: gesture.target,
          from: gesture.from.position,
          // The origin moves by however much the size actually changed, so a clamped drag does not
          // keep sliding the element after the box has stopped shrinking.
          to: {
            x: round4(gesture.from.position.x + (west ? gesture.from.size.w - width : 0)),
            y: round4(gesture.from.position.y + (north ? gesture.from.size.h - height : 0)),
          },
        });
      }
      return edits;
    }
    default:
      return assertNever(gesture);
  }
}

/** The same edits with `to` replaced by what the slide actually did. See `endDrag`. */
function measuredEditsFor({
  intended,
  actual,
}: {
  intended: readonly SlideEdit[];
  actual: Measurement;
}): readonly SlideEdit[] {
  return intended.map((edit) => {
    switch (edit.kind) {
      case "moved":
        return { ...edit, to: actual.position };
      case "resized":
        return { ...edit, to: actual.size };
      case "recoloured":
      case "retext":
      case "removed":
        return edit;
      default:
        return assertNever(edit);
    }
  });
}

/** The innermost element with a stable selector at or above `element`. */
function nearestTarget({ element, index }: { element: Element; index: SelectorIndex }): string | null {
  let walker: Element | null = element;
  while (walker !== null) {
    const target = index.targetOf.get(walker);
    if (target !== undefined) return target;
    walker = walker.parentElement;
  }
  return null;
}

/**
 * `event.target` is typed `EventTarget | null`, and these nodes are cross-realm so `instanceof
 * Element` is false for them. Duck-typing on `nodeType === 1` is the realm-safe check.
 */
function eventElementOf(event: Event): Element | null {
  const target: unknown = event.target;
  if (target === null || typeof target !== "object") return null;
  const nodeType: unknown = (target as Readonly<{ nodeType?: unknown }>).nodeType;
  // SAFETY: nodeType 1 is ELEMENT_NODE, so the node implements Element. The guard above is the
  // runtime proof; `instanceof` cannot be used across the iframe boundary.
  return nodeType === 1 ? (target as Element) : null;
}

function keyOf(event: Event): string | null {
  const key: unknown = (event as Readonly<{ key?: unknown }>).key;
  return typeof key === "string" ? key : null;
}

function edgeOf(handle: HTMLElement): Edge {
  const value = handle.dataset["edge"];
  const found = EDGES.find((edge) => edge === value);
  // The dataset is written by `mountChrome` from EDGES itself, so this cannot miss; `se` keeps the
  // function total rather than asserting.
  return found ?? "se";
}

/**
 * Pointer capture keeps a drag alive outside the element, and a SYNTHETIC pointer event (a test
 * harness, an assistive tool) has no active pointer, so the call throws and would take the whole
 * gesture with it. Same guard, and the same reason, as region-overlay.tsx.
 */
function capturePointer({
  element,
  pointerId,
  onWarning,
}: {
  element: Element;
  pointerId: number;
  onWarning: (message: string) => void;
}): void {
  try {
    element.setPointerCapture(pointerId);
  } catch (cause) {
    onWarning(`no pointer capture: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function mountChrome({ hostDocument }: { hostDocument: Document }): Chrome {
  // ONE STYLESHEET PER DOCUMENT, however many editors are attached to it. Two instances are live at
  // once whenever a host shows two slides side by side (the defect report), and appending a second
  // element with the same `id` is invalid markup for no gain.
  const installed = hostDocument.getElementById(OVERLAY_STYLE_ID);
  const style = installed instanceof HTMLStyleElement ? installed : hostDocument.createElement("style");
  const ownsStyle = installed === null;
  if (ownsStyle) {
    style.id = OVERLAY_STYLE_ID;
    style.textContent = OVERLAY_CSS;
    hostDocument.head.append(style);
  }

  const root = hostDocument.createElement("div");
  root.className = `${OVERLAY_CLASS_PREFIX}-root`;
  const hover = hostDocument.createElement("div");
  hover.className = `${OVERLAY_CLASS_PREFIX}-hover`;
  const select = hostDocument.createElement("div");
  select.className = `${OVERLAY_CLASS_PREFIX}-select`;
  select.setAttribute("aria-label", "selected slide element");
  const handles = EDGES.map((edge) => {
    const handle = hostDocument.createElement("div");
    handle.className = `${OVERLAY_CLASS_PREFIX}-handle`;
    handle.dataset["edge"] = edge;
    select.append(handle);
    return handle;
  });

  const bar = hostDocument.createElement("div");
  bar.className = `${OVERLAY_CLASS_PREFIX}-bar`;
  const targetLabel = hostDocument.createElement("span");
  targetLabel.className = `${OVERLAY_CLASS_PREFIX}-target`;
  const parentButton = button({ hostDocument, label: "▲", title: "select the element around this one" });
  const textColour = colourInput({ hostDocument, title: "text colour" });
  const backColour = colourInput({ hostDocument, title: "background" });
  const textButton = button({ hostDocument, label: "text", title: "edit the text in place" });
  const deleteButton = button({ hostDocument, label: "✕", title: "remove this element" });
  bar.append(targetLabel, parentButton, textColour, backColour, textButton, deleteButton);

  root.append(hover, select, bar);
  hostDocument.body.append(root);
  return { style, ownsStyle, root, hover, select, handles, bar, targetLabel, parentButton, textColour, backColour, textButton, deleteButton };
}

function button({ hostDocument, label, title }: { hostDocument: Document; label: string; title: string }): HTMLButtonElement {
  const node = hostDocument.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.title = title;
  return node;
}

function colourInput({ hostDocument, title }: { hostDocument: Document; title: string }): HTMLInputElement {
  const node = hostDocument.createElement("input");
  node.type = "color";
  node.title = title;
  return node;
}

function round4(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : 0;
}
