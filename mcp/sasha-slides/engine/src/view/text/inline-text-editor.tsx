// THE INLINE TEXT EDITOR: the body being edited, drawn in place by the same paragraph renderer as
// every slide (text-paragraphs.tsx), as `contenteditable` -- but React owns the page. Every
// `beforeinput` is prevented and reported (input-parser.ts); the browser keeps only the caret, the
// selection highlight and input-method composition, which a page cannot prevent.
//
// Key decisions:
//
//  * DURING A COMPOSITION THE FROZEN BODY IS RENDERED (`textEditing.composition.frozenBody`), never
//    a newer snapshot: the browser is writing provisional text into these very nodes, and React
//    reconciling a remote edit into them is the `removeChild` crash. When the composition ends the
//    reducer bumps `renderGeneration`, which is in every paragraph's key, so React remounts the
//    paragraphs from the document instead of reconciling what the browser wrote.
//  * THE CARET IS STATE. After every render (outside a composition) the page selection is set from
//    `selection`; `selectionchange` reports the user's own caret moves back as
//    `textSelectionChanged`. The two meet in the middle without loops because each side only writes
//    when the other differs.
//  * NATIVE `beforeinput`. React's synthetic `onBeforeInput` is the old `textInput` polyfill and has
//    no `inputType`, so the editor listens to the page event itself.

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { TextBody } from "../../contracts/document.ts";
import type { Selection, TextTarget } from "../../contracts/selection.ts";
import type { Composition, TextEditingState } from "../../contracts/editor-state.ts";
import { useEditorSelector, useEditorServices } from "../application/editor-services.tsx";
import { sameTextTarget } from "../render/element-view.tsx";
import type { EditableTextProperties } from "../render/render-context.ts";
import { TextParagraphs } from "../render/text-paragraphs.tsx";
import { indexFromPagePosition, pagePositionOfIndex } from "./dom-positions.ts";
import { createTextEditorHandlers, type TextSelectionReading } from "./text-editor-handlers.ts";
import { flattenBody, plainTextOfRange } from "../../shared/flat-text.ts";

/** On the editable root, so the canvas and the application keyboard handler leave its events alone. */
export const TEXT_EDITOR_ATTRIBUTE = "data-sasha-text-editor";

export type InlineTextEditorProperties = EditableTextProperties & Readonly<{ target: TextTarget; inkColour?: string }>;

export function InlineTextEditor(properties: InlineTextEditorProperties): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const editing = useEditorSelector((state) => state.textEditing);
  const selection = useEditorSelector((state) => state.selection);
  const root = useRef<HTMLDivElement>(null);
  const body = bodyToRender({ composition: editing.composition, target: properties.target, documentBody: properties.body });
  const composing = compositionTargets({ composition: editing.composition, target: properties.target });
  const latest = useRef({ body, selection, composing, slideNumber: properties.slideNumber });
  latest.current = { body, selection, composing, slideNumber: properties.slideNumber };

  const handlers = useMemo(
    () =>
      createTextEditorHandlers({
        dispatch,
        readSelection: () => readPageSelection(root.current),
        positionOf: (container, offset) => (root.current !== null && container instanceof Node ? indexFromPagePosition({ root: root.current, container, offset }) : null),
        richTextFrom: services.richTextFrom,
        plainTextOf: (range) => plainTextOfRange({ items: flattenBody(latest.current.body), start: range.anchor, end: range.focus, slideNumber: latest.current.slideNumber }),
        primaryModifier: services.primaryModifier,
      }),
    [dispatch, services.richTextFrom, services.primaryModifier],
  );

  useEffect(() => {
    const element = root.current;
    if (element === null) return undefined;
    const listener = (event: InputEvent): void => {
      handlers.beforeInput(event);
    };
    element.addEventListener("beforeinput", listener);
    return () => element.removeEventListener("beforeinput", listener);
  }, [handlers]);

  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (element === null || latest.current.composing) return;
    placePageSelection({ root: element, selection: textRangeOf({ selection: latest.current.selection, target: properties.target }) });
  });

  useEffect(() => {
    const listener = (): void => {
      if (latest.current.composing) return;
      const reading = readPageSelection(root.current);
      if (reading === null) return;
      const current = textRangeOf({ selection: latest.current.selection, target: properties.target });
      if (current !== null && current.anchor === reading.anchor && current.focus === reading.focus) return;
      dispatch({ kind: "textSelectionChanged", anchor: reading.anchor, focus: reading.focus });
    };
    document.addEventListener("selectionchange", listener);
    return () => document.removeEventListener("selectionchange", listener);
  }, [dispatch, properties.target]);

  return (
    <div
      ref={root}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Slide text"
      spellCheck
      style={{ outline: "none", cursor: "text", minHeight: "1em" }}
      onCompositionStart={() => handlers.compositionStart()}
      onCompositionEnd={(event) => handlers.compositionEnd({ data: event.data })}
      onKeyDown={(event) => handlers.keyDown(event.nativeEvent)}
      onCopy={(event) => handlers.copy(event.nativeEvent)}
      onCut={(event) => handlers.cut(event.nativeEvent)}
      {...{ [TEXT_EDITOR_ATTRIBUTE]: "" }}
    >
      <TextParagraphs
        body={body}
        styleContext={properties.styleContext}
        slideNumber={properties.slideNumber}
        slideNumberOf={properties.slideNumberOf}
        fontScale={1}
        renderGeneration={editing.renderGeneration}
        {...(properties.inkColour === undefined ? {} : { inkColour: properties.inkColour })}
      />
    </div>
  );
}

/** The body the editor draws: the frozen one while a composition on this body lasts (see the header). */
export function bodyToRender(options: Readonly<{ composition: Composition | null; target: TextTarget; documentBody: TextBody }>): TextBody {
  if (options.composition === null || !sameTextTarget(options.composition.target, options.target)) return options.documentBody;
  return options.composition.frozenBody;
}

/** Whether a composition is running in this body. */
export function compositionTargets(options: Readonly<{ composition: TextEditingState["composition"]; target: TextTarget }>): boolean {
  return options.composition !== null && sameTextTarget(options.composition.target, options.target);
}

/** The caret or range of `selection` when it is in this body. */
export function textRangeOf(options: Readonly<{ selection: Selection; target: TextTarget }>): TextSelectionReading | null {
  const selection = options.selection;
  switch (selection.kind) {
    case "text":
      return sameTextTarget(selection.target, options.target) ? { anchor: selection.anchor, focus: selection.focus } : null;
    case "none":
    case "slides":
    case "elements":
    case "tableCells":
      return null;
    default:
      return assertNever(selection);
  }
}

function readPageSelection(root: HTMLElement | null): TextSelectionReading | null {
  if (root === null) return null;
  const pageSelection = root.ownerDocument.getSelection();
  if (pageSelection === null || pageSelection.anchorNode === null || pageSelection.focusNode === null) return null;
  const anchor = indexFromPagePosition({ root, container: pageSelection.anchorNode, offset: pageSelection.anchorOffset });
  const focus = indexFromPagePosition({ root, container: pageSelection.focusNode, offset: pageSelection.focusOffset });
  if (anchor === null || focus === null) return null;
  return { anchor, focus };
}

function placePageSelection(options: Readonly<{ root: HTMLElement; selection: TextSelectionReading | null }>): void {
  if (options.selection === null) return;
  const pageSelection = options.root.ownerDocument.getSelection();
  if (pageSelection === null) return;
  const current = readPageSelection(options.root);
  if (current !== null && current.anchor === options.selection.anchor && current.focus === options.selection.focus) return;
  const anchor = pagePositionOfIndex({ root: options.root, index: options.selection.anchor });
  const focus = pagePositionOfIndex({ root: options.root, index: options.selection.focus });
  if (anchor === null || focus === null) return;
  pageSelection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}
