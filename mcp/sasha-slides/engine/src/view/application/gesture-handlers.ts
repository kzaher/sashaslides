// WHAT ONLY A USER GESTURE MAY DO: write the clipboard, enter full screen, open the speaker window or
// a new tab. Browsers refuse these after an asynchronous hop (Safari refuses clipboard writes,
// popup blockers refuse `window.open`), so they cannot be effects of state: the view's own handlers
// perform them SYNCHRONOUSLY inside the click, key or clipboard event, through the injected
// `BrowserCapabilities`, and only then dispatch what happened (editor-state.ts header).
//
// Key decisions:
//
//  * COPY READS STATE, NOT A ROUND TRIP. The `copy` and `cut` handlers call
//    `clipboardContentFor(current state, operation)` (the state module's pure selector) and fills the event's DataTransfer with the engine's
//    own payload, rendered markup and plain text before it returns, then dispatches `copied`.
//  * PRESENT ENTERS FULL SCREEN FIRST, then opens the speaker window, then dispatches
//    `presentRequested`; the shell mounts the presenter into the element that went full screen with
//    the window it got. In the add-on dialog neither is delegated through the frame chain, so
//    Present opens the deck in a top-level tab instead (SPEC.md section 14).
//  * PASTE IS PARSED AT THE BOUNDARY into `PastedContent`. The engine payload gets a shallow shape
//    check here; the model validates every command built from it before writing anything
//    (commands.ts "validate everything, then write").

import { assertNever } from "../../contracts/assert-never.ts";
import type { DocumentSnapshot, Paragraph } from "../../contracts/document.ts";
import type { ChosenImageFile, EditorEvent, PastedContent } from "../../contracts/editor-events.ts";
import type { ClipboardPayload, EditorState } from "../../contracts/editor-state.ts";
import { ENGINE_CLIPBOARD_MEDIA_TYPE, type BrowserCapabilities, type ClipboardContentFor } from "../../contracts/editor-system.ts";
import type { Point } from "../../contracts/geometry.ts";
import type { RunningSystem } from "../../contracts/rxfeedback.ts";
import { renderSlideMarkup } from "../render/slide-markup.tsx";

export type GestureContext = Readonly<{
  system: RunningSystem<EditorState, EditorEvent>;
  browser: BrowserCapabilities;
  clipboardContentFor: ClipboardContentFor;
  /** The element the presenter mounts into; it is what goes full screen. */
  presentationHost: () => Element | null;
  /** Where the Present handler leaves the speaker window it opened, for the presenter to render into. */
  speakerWindow: { current: Window | null };
}>;

/** The parts of a clipboard event the copy, cut and paste handlers use. */
export type ClipboardTransferEvent = Readonly<{
  clipboardData: Readonly<{
    setData: (format: string, data: string) => void;
    getData: (format: string) => string;
    types: readonly string[];
    files: ArrayLike<File>;
  }> | null;
  preventDefault: () => void;
}>;

/** The `copy` and `cut` events outside text editing (see the header). Returns whether it wrote. */
export function handleClipboardWrite(options: Readonly<{ context: GestureContext; event: ClipboardTransferEvent; operation: "copy" | "cut" }>): boolean {
  const { context, event } = options;
  const state = context.system.currentState();
  const content = context.clipboardContentFor(state, options.operation);
  if (content === null) return false;
  if (event.clipboardData === null) {
    context.system.dispatch({ kind: "clipboardUnavailable", operation: options.operation });
    return false;
  }
  event.clipboardData.setData(ENGINE_CLIPBOARD_MEDIA_TYPE, JSON.stringify(content.payload));
  event.clipboardData.setData("text/html", clipboardMarkup({ payload: content.payload, document: state.document }));
  event.clipboardData.setData("text/plain", content.plainText);
  event.preventDefault();
  context.system.dispatch(CLIPBOARD_WRITTEN[options.operation]);
  return true;
}

/** What each clipboard write reports once the clipboard holds the selection. */
const CLIPBOARD_WRITTEN: Readonly<Record<"copy" | "cut", EditorEvent>> = { copy: { kind: "copied" }, cut: { kind: "cutRequested" } };

/** Menu copy and cut: the asynchronous clipboard, started inside the click (see the header). */
export function handleMenuClipboardWrite(options: Readonly<{ context: GestureContext; operation: "copy" | "cut" }>): void {
  const { context } = options;
  const state = context.system.currentState();
  const content = context.clipboardContentFor(state, options.operation);
  if (content === null) return;
  const written = context.browser.writeClipboard({
    plainText: content.plainText,
    markup: clipboardMarkup({ payload: content.payload, document: state.document }),
    enginePayloadText: JSON.stringify(content.payload),
  });
  written.then(
    () => context.system.dispatch(CLIPBOARD_WRITTEN[options.operation]),
    () => context.system.dispatch({ kind: "clipboardUnavailable", operation: options.operation }),
  );
}

/** The `paste` event outside text editing: the transfer parsed into what was pasted. */
export function handlePaste(options: Readonly<{
  context: GestureContext;
  event: ClipboardTransferEvent;
  at: Point | null;
  richTextFrom: (html: string) => readonly Paragraph[] | null;
  readImageFile: (file: File) => Promise<ChosenImageFile | null>;
}>): void {
  const transfer = options.event.clipboardData;
  const dispatch = options.context.system.dispatch;
  if (transfer === null) {
    dispatch({ kind: "clipboardUnavailable", operation: "paste" });
    return;
  }
  options.event.preventDefault();
  const immediate = pastedContentOf({ transfer, richTextFrom: options.richTextFrom });
  if (immediate !== null) {
    dispatch({ kind: "pasteReceived", content: immediate, at: options.at });
    return;
  }
  const image = Array.from(transfer.files).find((file) => file.type.startsWith("image/"));
  if (image === undefined) return;
  void options.readImageFile(image).then((file) => {
    if (file !== null) dispatch({ kind: "pasteReceived", content: { kind: "image", file }, at: options.at });
  });
}

/** What a transfer holds that needs no file read: the engine payload, rich text or plain text. */
export function pastedContentOf(options: Readonly<{ transfer: Pick<NonNullable<ClipboardTransferEvent["clipboardData"]>, "getData" | "types">; richTextFrom: (html: string) => readonly Paragraph[] | null }>): PastedContent | null {
  const transfer = options.transfer;
  if (transfer.types.includes(ENGINE_CLIPBOARD_MEDIA_TYPE)) {
    const payload = parseClipboardPayload(transfer.getData(ENGINE_CLIPBOARD_MEDIA_TYPE));
    if (payload !== null) return { kind: "engine", payload };
  }
  if (transfer.types.includes("Files")) return null;
  if (transfer.types.includes("text/html")) {
    const paragraphs = options.richTextFrom(transfer.getData("text/html"));
    if (paragraphs !== null && paragraphs.length > 0) return { kind: "text", text: { kind: "rich", paragraphs } };
  }
  const plain = transfer.getData("text/plain");
  return plain.length === 0 ? null : { kind: "text", text: { kind: "plain", text: plain.replace(/\r\n?/g, "\n") } };
}

/** The engine payload from clipboard text; null for anything that is not one (see the header). */
export function parseClipboardPayload(text: string): ClipboardPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const format = Reflect.get(parsed, "format");
  const operation = Reflect.get(parsed, "operation");
  if (operation !== "copy" && operation !== "cut") return null;
  if (typeof Reflect.get(parsed, "sourceDeckId") !== "string" || !Array.isArray(Reflect.get(parsed, "assets"))) return null;
  if (format === "sasha-engine/elements@1" && typeof Reflect.get(parsed, "slideId") === "string" && Array.isArray(Reflect.get(parsed, "elements"))) {
    // The discriminating fields were checked above; element trees are validated by the model before
    // any command built from them is written (see the header).
    return parsed as ClipboardPayload;
  }
  if (format === "sasha-engine/slides@1" && Array.isArray(Reflect.get(parsed, "slides")) && Array.isArray(Reflect.get(parsed, "transitionScripts"))) {
    // As above: the shape that selects the variant is checked; the model validates the slides.
    return parsed as ClipboardPayload;
  }
  return null;
}

/** The markup a copy carries for other applications: the copied slides, or the elements on their slide's background. */
export function clipboardMarkup(options: Readonly<{ payload: ClipboardPayload; document: DocumentSnapshot }>): string {
  const payload = options.payload;
  switch (payload.format) {
    case "sasha-engine/slides@1":
      return payload.slides.map((slide, index) => renderSlideMarkup({ slide, document: options.document, slideNumber: index + 1 }).markup).join("");
    case "sasha-engine/elements@1": {
      const source = options.document.slides.find((slide) => slide.id === payload.slideId);
      const slideNumber = options.document.slides.findIndex((slide) => slide.id === payload.slideId) + 1;
      const slide = { id: payload.slideId, layoutId: source?.layoutId ?? null, background: source?.background ?? null, skipped: false, speakerNotes: { paragraphs: [{ style: {}, runs: [] }] }, transition: null, elements: payload.elements };
      return renderSlideMarkup({ slide, document: options.document, slideNumber: Math.max(1, slideNumber) }).markup;
    }
    default:
      return assertNever(payload);
  }
}

/** Present (see the header): full screen and the speaker window first, then the dispatch. */
export function handlePresent(options: Readonly<{ context: GestureContext; from: "beginning" | "currentSlide"; withSpeakerView: boolean }>): void {
  const { context } = options;
  const state = context.system.currentState();
  const embedding = state.embedding;
  switch (embedding.kind) {
    case "addonDialog":
      context.browser.openTab(presentAddress({ address: embedding.webApplicationAddress, from: options.from, currentSlideId: state.currentSlideId }));
      return;
    case "webApplication": {
      const host = context.presentationHost();
      if (host !== null) context.browser.requestFullScreen(host).catch(() => undefined);
      context.speakerWindow.current = options.withSpeakerView ? context.browser.openSpeakerWindow() : null;
      context.system.dispatch({ kind: "presentRequested", from: options.from, withSpeakerView: options.withSpeakerView && context.speakerWindow.current !== null });
      return;
    }
    default:
      assertNever(embedding);
  }
}

/** "Open in a new tab" from the add-on dialog. */
export function handleOpenInNewTab(context: GestureContext): void {
  const embedding = context.system.currentState().embedding;
  switch (embedding.kind) {
    case "addonDialog":
      context.browser.openTab(embedding.webApplicationAddress);
      return;
    case "webApplication":
      return;
    default:
      assertNever(embedding);
  }
}

/** The web application's address with what to present, for the add-on's top-level tab. */
export function presentAddress(options: Readonly<{ address: string; from: "beginning" | "currentSlide"; currentSlideId: string | null }>): string {
  try {
    const url = new URL(options.address);
    url.searchParams.set("present", options.from === "beginning" || options.currentSlideId === null ? "beginning" : options.currentSlideId);
    return url.toString();
  } catch {
    return options.address;
  }
}
