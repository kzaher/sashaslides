// THE `beforeinput` PARSER: every `InputEvent.inputType` a browser sends while the inline text
// editor has focus, mapped to what the editor does about it (SPEC.md "Text editing"). The editor
// renders its body as `contenteditable` but never lets the browser edit the page -- React owns it --
// so every input is either reported as an `EditorEvent` (usually a `TextInput`) or explicitly
// ignored, and in both cases `preventDefault()` is called. The one exception is an input-method
// composition, which a browser does not let a page prevent (section "Input method composition").
//
// Key decisions:
//
//  * PARSED AT THE BOUNDARY. The handler sees a minimal `BeforeInputLike` (the fields of InputEvent
//    it reads), so the whole mapping is a pure, table-tested function, and nothing below it ever
//    touches a page event.
//  * RANGES COME FROM `getTargetRanges()`. A spell-check replacement or autocorrect
//    (`insertReplacementText`) replaces a range the browser chose, often not the caret's; a drop
//    inserts where the pointer released. Both are translated to body indices through `positionOf`,
//    which the editor implements over the rendered paragraphs' data attributes.
//  * THE BROWSER'S UNDO IS THE EDITOR'S UNDO. `historyUndo` and `historyRedo` (the Edit menu, a
//    shake gesture) route to the editor's history; the browser's own stack would undo DOM changes
//    that React then reconciles away.
//  * KEYBOARD CHORDS DO NOT ARRIVE HERE. Primary+B and friends are prevented at `keydown` and become
//    `keyPressed` (the key map is the state module's); `formatBold` here comes from the browser's own
//    menus and touch bars, and still toggles bold.

import { assertNever } from "../../contracts/assert-never.ts";
import type { EditorEvent, PastedText, TextInput } from "../../contracts/editor-events.ts";
import type { Paragraph } from "../../contracts/document.ts";
import { parseColourText } from "../../shared/colour-text.ts";
import { literalColour, type Colour } from "../../contracts/style.ts";

/** The parts of a `DataTransfer` the parser reads. */
export type DataTransferLike = Readonly<{
  types: readonly string[];
  getData: (format: string) => string;
}>;

/** The parts of a `StaticRange` the parser reads; containers are opaque to it. */
export type StaticRangeLike = Readonly<{
  startContainer: unknown;
  startOffset: number;
  endContainer: unknown;
  endOffset: number;
}>;

/** The parts of an `InputEvent` the parser reads. */
export type BeforeInputLike = Readonly<{
  inputType: string;
  data: string | null;
  dataTransfer: DataTransferLike | null;
  getTargetRanges: () => readonly StaticRangeLike[];
}>;

export type BeforeInputContext = Readonly<{
  /** A page position inside the editor as a body index; null outside the edited body. */
  positionOf: (container: unknown, offset: number) => number | null;
  /** Rich text pasted from Docs or the web, reduced to the engine's styles; null when there is none. */
  richTextFrom: (markup: string) => readonly Paragraph[] | null;
}>;

/** What the editor does with one `beforeinput`. */
export type BeforeInputOutcome =
  /** Prevent the browser's edit and dispatch this instead. */
  | Readonly<{ kind: "dispatch"; event: EditorEvent }>
  /** Prevent the browser's edit and do nothing (an input type the engine has no meaning for). */
  | Readonly<{ kind: "ignore" }>
  /** An input-method composition: the browser draws it and cannot be prevented. */
  | Readonly<{ kind: "composition" }>;

/** The input types an input-method composition sends; they cannot be cancelled. */
export const COMPOSITION_INPUT_TYPES: readonly string[] = ["insertCompositionText", "deleteCompositionText", "insertFromComposition", "deleteByComposition"];

export function parseBeforeInput(event: BeforeInputLike, context: BeforeInputContext): BeforeInputOutcome {
  if (COMPOSITION_INPUT_TYPES.includes(event.inputType)) return { kind: "composition" };
  const input = textInputFor(event, context);
  if (input !== null) return input === IGNORED ? { kind: "ignore" } : { kind: "dispatch", event: { kind: "textInput", input } };
  const editorEvent = formattingEventFor(event);
  return editorEvent === null ? { kind: "ignore" } : { kind: "dispatch", event: editorEvent };
}

/**
 * Handles one `beforeinput`: parses it, prevents the browser's own edit unless it is a composition,
 * and dispatches what it means. Returns the outcome for tests and diagnostics.
 */
export function handleBeforeInput(options: Readonly<{ event: BeforeInputLike & Readonly<{ preventDefault: () => void }>; context: BeforeInputContext; dispatch: (event: EditorEvent) => void }>): BeforeInputOutcome {
  const outcome = parseBeforeInput(options.event, options.context);
  switch (outcome.kind) {
    case "composition":
      return outcome;
    case "ignore":
      options.event.preventDefault();
      return outcome;
    case "dispatch":
      options.event.preventDefault();
      options.dispatch(outcome.event);
      return outcome;
    default:
      return assertNever(outcome);
  }
}

/** Marks an input type that maps to no `TextInput` and must be prevented without a dispatch. */
const IGNORED: unique symbol = Symbol("ignored");

function textInputFor(event: BeforeInputLike, context: BeforeInputContext): TextInput | typeof IGNORED | null {
  switch (event.inputType) {
    case "insertText":
      return event.data === null || event.data.length === 0 ? IGNORED : { kind: "insertText", text: event.data };
    case "insertReplacementText":
      return replacement(event, context);
    case "insertParagraph":
      return { kind: "insertParagraph" };
    case "insertLineBreak":
      return { kind: "insertLineBreak" };
    case "insertTab":
      return { kind: "insertTab", outdent: false };
    case "deleteContentBackward":
    case "deleteContent":
      return { kind: "deleteBackward", unit: "character" };
    case "deleteWordBackward":
      return { kind: "deleteBackward", unit: "word" };
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
    case "deleteEntireSoftLine":
      return { kind: "deleteBackward", unit: "line" };
    case "deleteContentForward":
      return { kind: "deleteForward", unit: "character" };
    case "deleteWordForward":
      return { kind: "deleteForward", unit: "word" };
    case "deleteSoftLineForward":
    case "deleteHardLineForward":
      return { kind: "deleteForward", unit: "line" };
    case "deleteByCut":
      return { kind: "deleteByCut" };
    case "deleteByDrag":
      // The dragged range leaves its old place; the matching insertFromDrop inserts it at the drop.
      return removalOfTargetRange(event, context);
    case "insertFromPaste":
    case "insertFromPasteAsQuotation":
    case "insertFromYank":
      return { kind: "insertFromPaste", content: pastedText({ event, context }) };
    case "insertFromDrop": {
      const index = targetRangeStart(event, context);
      return index === null ? IGNORED : { kind: "insertFromDrop", index, content: pastedText({ event, context }) };
    }
    case "historyUndo":
      return { kind: "history", direction: "undo" };
    case "historyRedo":
      return { kind: "history", direction: "redo" };
    case "formatBold":
      return { kind: "toggleFormat", format: "bold" };
    case "formatItalic":
      return { kind: "toggleFormat", format: "italic" };
    case "formatUnderline":
      return { kind: "toggleFormat", format: "underline" };
    case "formatStrikeThrough":
      return { kind: "toggleFormat", format: "strikethrough" };
    default:
      return null;
  }
}

/** The browser's formatting commands that are editor intents rather than text inputs. */
function formattingEventFor(event: BeforeInputLike): EditorEvent | null {
  switch (event.inputType) {
    case "formatSuperscript":
      return { kind: "runStyleRequested", patch: { baselineOffset: "superscript" }, clear: [] };
    case "formatSubscript":
      return { kind: "runStyleRequested", patch: { baselineOffset: "subscript" }, clear: [] };
    case "formatJustifyLeft":
      return { kind: "paragraphStyleRequested", patch: { alignment: "start" }, clear: [] };
    case "formatJustifyCenter":
      return { kind: "paragraphStyleRequested", patch: { alignment: "centre" }, clear: [] };
    case "formatJustifyRight":
      return { kind: "paragraphStyleRequested", patch: { alignment: "end" }, clear: [] };
    case "formatJustifyFull":
      return { kind: "paragraphStyleRequested", patch: { alignment: "justify" }, clear: [] };
    case "formatIndent":
      return { kind: "listIndentChanged", delta: 1 };
    case "formatOutdent":
      return { kind: "listIndentChanged", delta: -1 };
    case "insertOrderedList":
      return { kind: "listToggled", list: "numbered" };
    case "insertUnorderedList":
      return { kind: "listToggled", list: "bulleted" };
    case "formatRemove":
      return {
        kind: "runStyleRequested",
        patch: {},
        clear: ["fontWeight", "fontStyle", "underline", "strikethrough", "colour", "highlight", "baselineOffset", "letterSpacing", "textCase"],
      };
    case "formatFontColor": {
      const colour = colourFromBrowser(event.data);
      return colour === null ? null : { kind: "runStyleRequested", patch: { colour }, clear: [] };
    }
    case "formatBackColor": {
      const colour = colourFromBrowser(event.data);
      return colour === null ? null : { kind: "runStyleRequested", patch: { highlight: colour }, clear: [] };
    }
    case "formatSetBlockTextDirection":
      return event.data === "rtl" || event.data === "ltr" ? { kind: "paragraphStyleRequested", patch: { direction: event.data === "rtl" ? "rightToLeft" : "leftToRight" }, clear: [] } : null;
    default:
      return null;
  }
}

function replacement(event: BeforeInputLike, context: BeforeInputContext): TextInput | typeof IGNORED {
  const range = targetRange(event, context);
  if (range === null) return IGNORED;
  const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
  return { kind: "replaceRange", anchor: range.start, focus: range.end, text };
}

function removalOfTargetRange(event: BeforeInputLike, context: BeforeInputContext): TextInput | typeof IGNORED {
  const range = targetRange(event, context);
  return range === null ? IGNORED : { kind: "replaceRange", anchor: range.start, focus: range.end, text: "" };
}

function targetRange(event: BeforeInputLike, context: BeforeInputContext): Readonly<{ start: number; end: number }> | null {
  const first = event.getTargetRanges()[0];
  if (first === undefined) return null;
  const start = context.positionOf(first.startContainer, first.startOffset);
  const end = context.positionOf(first.endContainer, first.endOffset);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function targetRangeStart(event: BeforeInputLike, context: BeforeInputContext): number | null {
  return targetRange(event, context)?.start ?? null;
}

/** Pasted or dropped text: rich when the transfer carries markup the engine can read, else plain. */
function pastedText(options: Readonly<{ event: BeforeInputLike; context: BeforeInputContext }>): PastedText {
  const transfer = options.event.dataTransfer;
  if (transfer !== null && transfer.types.includes("text/html")) {
    const paragraphs = options.context.richTextFrom(transfer.getData("text/html"));
    if (paragraphs !== null && paragraphs.length > 0) return { kind: "rich", paragraphs };
  }
  const plain = transfer?.getData("text/plain") ?? options.event.data ?? "";
  return { kind: "plain", text: plain.replace(/\r\n?/g, "\n") };
}

/**
 * "rgb(r, g, b)", "rgba(r, g, b, a)" or "#rrggbb", as browsers report a chosen colour or an inline
 * style's (a pasted element's, browser-services.ts); null for anything else.
 */
export function colourFromBrowser(data: string | null): Colour | null {
  if (data === null) return null;
  const parsed = parseColourText(data);
  if (parsed === null) return null;
  const channel = (value: number): string => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return literalColour({ hexadecimal: `#${channel(parsed.red)}${channel(parsed.green)}${channel(parsed.blue)}`, alpha: parsed.alpha });
}
