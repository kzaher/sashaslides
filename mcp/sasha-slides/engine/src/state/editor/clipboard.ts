// COPY, CUT AND PASTE (SPEC.md section 7, "Clipboard"). The browser only lets the VIEW write the
// clipboard, inside the user's event, so `clipboardContentFor` is a pure selector the view's copy
// handler calls synchronously: complete element or slide snapshots (lossless into another deck) with
// the assets and scripts they use, plus plain text. Paste rebuilds commands from that payload:
//
//  * A CUT pasted into the SAME deck keeps every element and slide id that is still free, so a move
//    through the clipboard keeps its comments on the element (arrangeThreads finds it again).
//  * Anything else is re-identified with MORPH KEYS KEPT, so a pasted copy still morphs with its
//    original across slides.
//  * Consecutive pastes of one payload onto one slide cascade by 10 units each; a copy pasted onto the
//    slide it came from starts one step out so it never hides its original.
//  * A pasted slide keeps its build sequence, remapped to the new element ids (element-factory.ts
//    `reidentifySlide`); scripted steps, like a scripted transition, follow a script renamed here.
//  * Scripts pasted from another deck arrive UNAPPROVED: the paste saves them with
//    `approval: "unapproved"`, still authored by the person pasting, because carrying a script
//    across decks is not reviewing it.
//
// `clipboardContentFor` takes the operation, so a cut's payload says "cut" and the paste above can
// tell a move from a copy.

import {
  assertNever,
  plainText,
  type AnimationEffect,
  type AssetId,
  type AssetRecord,
  type ClipboardContent,
  type ClipboardPayload,
  type DocumentCommand,
  type EditorState,
  type ElementSnapshot,
  type Fill,
  type PastedContent,
  type PastedText,
  type TextBody,
  type Point,
  type SlideId,
  type SlideSnapshot,
  type SlideTransition,
  type TransitionScriptId,
  type TransitionScriptRecord,
} from "../../contracts/index.ts";
import { boundsOfElements, findSlide, findSlideIndex, leavesOf, slideBox, subtreeOf } from "./document-lookup.ts";
import { queueEnvelope } from "./editor-queue.ts";
import { selectedElements } from "./editor-selection.ts";
import { createShape, elementIdsOf, reidentifyElement, reidentifySlide, textBodyFromPlainText, translateElement } from "./element-factory.ts";
import { createIdMinter, type IdMinter } from "./id-minter.ts";
import { startUpload } from "./uploads.ts";

/** Each further paste of the same payload onto the same slide moves this much further, slide units. */
export const PASTE_CASCADE_UNITS = 10;

/** Only a cut is a move: a copy always gets fresh ids. */
const CUT_KEEPS_IDS: Readonly<Record<ClipboardPayload["operation"], boolean>> = { copy: false, cut: true };

export const clipboardContentFor = (state: EditorState, operation: ClipboardPayload["operation"]): ClipboardContent | null => {
  const selection = state.selection;
  switch (selection.kind) {
    case "elements": {
      const selected = selectedElements(state);
      if (selected === null) return null;
      const payload: ClipboardPayload = {
        format: "sasha-engine/elements@1",
        operation,
        sourceDeckId: state.document.deckId,
        slideId: selected.slide.id,
        elements: selected.elements,
        assets: assetsUsedBy(state, selected.elements),
      };
      return { payload, plainText: plainTextOfElements(selected.elements, slideNumberOf(state, selected.slide.id)) };
    }
    case "slides": {
      const slides = state.document.slides.filter((slide) => selection.slideIds.includes(slide.id));
      if (slides.length === 0) return null;
      const payload: ClipboardPayload = {
        format: "sasha-engine/slides@1",
        operation,
        sourceDeckId: state.document.deckId,
        slides,
        assets: assetsUsedBy(state, slides.flatMap((slide) => slide.elements), slides),
        transitionScripts: scriptsUsedBy(state, slides),
      };
      return { payload, plainText: slides.map((slide) => plainTextOfElements(slide.elements, slideNumberOf(state, slide.id))).join("\n\n") };
    }
    case "none":
    case "text":
    case "tableCells":
      // Text is copied by the inline editor from the rendered body; cells are later.
      return null;
    default:
      return assertNever(selection);
  }
};

/** The view's cut handler has written the clipboard; remove what was cut. */
export function cutSelection(state: EditorState): EditorState {
  const selection = state.selection;
  switch (selection.kind) {
    case "elements":
      return queueEnvelope(state, {
        commands: [{ kind: "deleteElements", slideId: selection.slideId, elementIds: selection.elementIds }],
        selectionAfter: { kind: "none" },
        mergeWithPrevious: false,
      });
    case "slides":
      return queueEnvelope(state, { commands: [{ kind: "deleteSlides", slideIds: selection.slideIds }], selectionAfter: { kind: "none" }, mergeWithPrevious: false });
    case "none":
    case "text":
    case "tableCells":
      return state;
    default:
      return assertNever(selection);
  }
}

export function pasteContent(state: EditorState, content: PastedContent, at: Point | null): EditorState {
  switch (content.kind) {
    case "engine":
      return pastePayload(state, content.payload, at);
    case "text": {
      const slideId = state.currentSlideId;
      if (slideId === null) return state;
      const minter = createIdMinter(state.idSeed);
      const id = minter.next("element");
      const centre = at ?? slideCentre(state);
      const text = bodyOfPastedText(content.text);
      const element = createShape({ id, preset: "textBox", box: { x: centre.x - 200, y: centre.y - 40, width: 400, height: 80 }, text });
      return queueEnvelope(
        { ...state, idSeed: minter.seed() },
        {
          commands: [{ kind: "insertElements", slideId, elements: [element], placement: { kind: "front" } }],
          selectionAfter: { kind: "elements", slideId, elementIds: [id] },
          mergeWithPrevious: false,
        },
      );
    }
    case "image":
      return startUpload(state, { files: [content.file], at, destination: "newImage" });
    default:
      return assertNever(content);
  }
}

function bodyOfPastedText(text: PastedText): TextBody {
  switch (text.kind) {
    case "plain":
      return textBodyFromPlainText(text.text);
    case "rich":
      return { paragraphs: text.paragraphs };
    default:
      return assertNever(text);
  }
}

function pastePayload(state: EditorState, payload: ClipboardPayload, at: Point | null): EditorState {
  switch (payload.format) {
    case "sasha-engine/elements@1":
      return pasteElements(state, payload, at);
    case "sasha-engine/slides@1":
      return pasteSlides(state, payload);
    default:
      return assertNever(payload);
  }
}

function pasteElements(state: EditorState, payload: Extract<ClipboardPayload, { format: "sasha-engine/elements@1" }>, at: Point | null): EditorState {
  const slideId = state.currentSlideId;
  const slide = slideId === null ? null : findSlide(state.document, slideId);
  if (slideId === null || slide === null || payload.elements.length === 0) return state;
  const sameDeck = payload.sourceDeckId === state.document.deckId;
  const keepIds = sameDeck && CUT_KEEPS_IDS[payload.operation];
  const taken = new Set(state.document.slides.flatMap((candidate) => elementIdsOf(candidate.elements)));
  const minter = createIdMinter(state.idSeed);
  const reidentified = payload.elements.map((element) =>
    reidentifyElement(element, { minter, keepElementId: (elementId) => keepIds && !taken.has(elementId), keepMorphKeys: true }, null),
  );
  const cascade = nextCascade(state, payload, slideId);
  const offset = placementOffset({ state, elements: reidentified, at, cascadeCount: cascade.count });
  const elements = reidentified.map((element) => translateElement(element, offset.x, offset.y));
  const commands: DocumentCommand[] = [
    ...registerMissingAssets(state, payload.assets),
    { kind: "insertElements", slideId, elements, placement: state.enteredGroupId === null ? { kind: "front" } : { kind: "insideGroup", groupId: state.enteredGroupId } },
  ];
  const queued = queueEnvelope(
    { ...state, idSeed: minter.seed(), clipboard: { pasteCascade: cascade } },
    { commands, selectionAfter: { kind: "elements", slideId, elementIds: elements.map((element) => element.id) }, mergeWithPrevious: false },
  );
  return queued;
}

function pasteSlides(state: EditorState, payload: Extract<ClipboardPayload, { format: "sasha-engine/slides@1" }>): EditorState {
  if (payload.slides.length === 0) return state;
  const sameDeck = payload.sourceDeckId === state.document.deckId;
  const keepIds = sameDeck && CUT_KEEPS_IDS[payload.operation];
  const takenSlides = new Set(state.document.slides.map((slide) => slide.id));
  const takenElements = new Set(state.document.slides.flatMap((slide) => elementIdsOf(slide.elements)));
  const minter = createIdMinter(state.idSeed);
  const scripts = sameDeck ? { commands: [], renamed: new Map<TransitionScriptId, TransitionScriptId>() } : foreignScripts(state, payload.transitionScripts, minter);
  const slides = payload.slides.map((slide) =>
    withScriptRenamed(
      reidentifySlide(slide, {
        minter,
        keepSlideId: (slideId) => keepIds && !takenSlides.has(slideId),
        keepElementId: (elementId) => keepIds && !takenElements.has(elementId),
        keepMorphKeys: true,
      }),
      scripts.renamed,
    ),
  );
  const after = lastSelectedOrCurrentSlide(state);
  const commands: DocumentCommand[] = [...registerMissingAssets(state, payload.assets), ...scripts.commands, { kind: "insertSlides", slides, after }];
  const firstSlide = slides[0];
  const queued = queueEnvelope(
    { ...state, idSeed: minter.seed(), currentSlideId: firstSlide?.id ?? state.currentSlideId },
    {
      commands,
      selectionAfter: { kind: "slides", slideIds: slides.map((slide) => slide.id) },
      mergeWithPrevious: false,
    },
  );
  return queued;
}

/** Scripts from another deck: re-identified where the id is taken here, saved as unapproved drafts. */
function foreignScripts(
  state: EditorState,
  records: readonly TransitionScriptRecord[],
  minter: IdMinter,
): Readonly<{ commands: readonly DocumentCommand[]; renamed: ReadonlyMap<TransitionScriptId, TransitionScriptId> }> {
  const taken = new Set(state.document.transitionScripts.map((script) => script.id));
  const renamed = new Map<TransitionScriptId, TransitionScriptId>();
  const commands: DocumentCommand[] = records.map((record) => {
    const id = taken.has(record.id) ? minter.next("transitionScript") : record.id;
    if (id !== record.id) renamed.set(record.id, id);
    return {
      kind: "upsertTransitionScript",
      script: { id, name: record.name, description: record.description, purpose: record.purpose, script: record.script, stylesheet: record.stylesheet, markup: record.markup, defaultParameters: record.defaultParameters },
      basedOnUpdatedAt: null,
      approval: "unapproved",
    };
  });
  return { commands, renamed };
}

/** The slide's scripted transition and scripted build steps following scripts renamed on paste. */
function withScriptRenamed(slide: SlideSnapshot, renamed: ReadonlyMap<TransitionScriptId, TransitionScriptId>): SlideSnapshot {
  if (renamed.size === 0) return slide;
  return { ...slide, transition: transitionWithScriptRenamed(slide.transition, renamed), animations: slide.animations.map((step) => ({ ...step, effect: effectWithScriptRenamed(step.effect, renamed) })) };
}

function transitionWithScriptRenamed(transition: SlideTransition | null, renamed: ReadonlyMap<TransitionScriptId, TransitionScriptId>): SlideTransition | null {
  if (transition === null) return null;
  switch (transition.kind) {
    case "builtin":
      return transition;
    case "scripted": {
      const scriptId = renamed.get(transition.scriptId);
      return scriptId === undefined ? transition : { ...transition, scriptId };
    }
    default:
      return assertNever(transition);
  }
}

function effectWithScriptRenamed(effect: AnimationEffect, renamed: ReadonlyMap<TransitionScriptId, TransitionScriptId>): AnimationEffect {
  switch (effect.kind) {
    case "scripted": {
      const scriptId = renamed.get(effect.scriptId);
      return scriptId === undefined ? effect : { ...effect, scriptId };
    }
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "motionPath":
      return effect;
    default:
      return assertNever(effect);
  }
}

/** The cascade after this paste: one step further when the same payload lands on the same slide again. */
function nextCascade(
  state: EditorState,
  payload: Extract<ClipboardPayload, { format: "sasha-engine/elements@1" }>,
  slideId: SlideId,
): NonNullable<EditorState["clipboard"]["pasteCascade"]> {
  const payloadFingerprint = fingerprintOf(payload);
  const previous = state.clipboard.pasteCascade;
  if (previous !== null && previous.payloadFingerprint === payloadFingerprint && previous.slideId === slideId) {
    return { payloadFingerprint, slideId, count: previous.count + 1 };
  }
  const coversOriginal = !CUT_KEEPS_IDS[payload.operation] && payload.sourceDeckId === state.document.deckId && payload.slideId === slideId;
  return { payloadFingerprint, slideId, count: coversOriginal ? 1 : 0 };
}

function placementOffset(options: Readonly<{ state: EditorState; elements: readonly ElementSnapshot[]; at: Point | null; cascadeCount: number }>): Point {
  if (options.at === null) return { x: PASTE_CASCADE_UNITS * options.cascadeCount, y: PASTE_CASCADE_UNITS * options.cascadeCount };
  const bounds = boundsOfElements(options.elements, options.state.measuredLayouts);
  if (bounds === null) return { x: 0, y: 0 };
  return { x: options.at.x - (bounds.x + bounds.width / 2), y: options.at.y - (bounds.y + bounds.height / 2) };
}

function fingerprintOf(payload: Extract<ClipboardPayload, { format: "sasha-engine/elements@1" }>): string {
  return `${payload.format}|${payload.operation}|${payload.sourceDeckId}|${payload.slideId}|${elementIdsOf(payload.elements).join(",")}`;
}

function registerMissingAssets(state: EditorState, assets: readonly AssetRecord[]): readonly DocumentCommand[] {
  const known = new Set(state.document.assets.map((asset) => asset.id));
  return assets.filter((asset) => !known.has(asset.id)).map((asset) => ({ kind: "registerAsset", asset }));
}

function assetsUsedBy(state: EditorState, elements: readonly ElementSnapshot[], slides: readonly SlideSnapshot[] = []): readonly AssetRecord[] {
  const used = new Set<AssetId>();
  for (const element of elements.flatMap(subtreeOf)) for (const assetId of assetIdsOfElement(element)) used.add(assetId);
  for (const slide of slides) for (const assetId of assetIdsOfFill(slide.background)) used.add(assetId);
  return state.document.assets.filter((asset) => used.has(asset.id));
}

function assetIdsOfElement(element: ElementSnapshot): readonly AssetId[] {
  switch (element.kind) {
    case "image":
      return [element.assetId, ...assetIdsOfFill(element.box.fill)];
    case "shape":
      return assetIdsOfFill(element.box.fill);
    case "table":
      return element.cells.flatMap((cell) => assetIdsOfFill(cell.fill));
    case "line":
    case "group":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function assetIdsOfFill(fill: Fill | null): readonly AssetId[] {
  if (fill === null) return [];
  switch (fill.kind) {
    case "image":
      return [fill.assetId];
    case "none":
    case "solid":
    case "linearGradient":
    case "radialGradient":
      return [];
    default:
      return assertNever(fill);
  }
}

/** The scripts the slides' transitions and build steps name, so a paste into another deck carries them. */
function scriptsUsedBy(state: EditorState, slides: readonly SlideSnapshot[]): readonly TransitionScriptRecord[] {
  const used = new Set<TransitionScriptId>();
  for (const slide of slides) {
    for (const step of slide.animations) {
      const scriptId = scriptIdOfEffect(step.effect);
      if (scriptId !== null) used.add(scriptId);
    }
    const transition = slide.transition;
    if (transition === null) continue;
    switch (transition.kind) {
      case "scripted":
        used.add(transition.scriptId);
        break;
      case "builtin":
        break;
      default:
        assertNever(transition);
    }
  }
  return state.document.transitionScripts.filter((script) => used.has(script.id));
}

function scriptIdOfEffect(effect: AnimationEffect): TransitionScriptId | null {
  switch (effect.kind) {
    case "scripted":
      return effect.scriptId;
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "motionPath":
      return null;
    default:
      return assertNever(effect);
  }
}

function plainTextOfElements(elements: readonly ElementSnapshot[], slideNumber: number | null): string {
  return elements
    .flatMap(leavesOf)
    .flatMap((leaf): string[] => {
      switch (leaf.kind) {
        case "shape": {
          const text = plainText({ body: leaf.text, slideNumber });
          return text.length === 0 ? [] : [text];
        }
        case "table":
          return [
            leaf.rows
              .map((row) => leaf.columns.map((column) => {
                const cell = leaf.cells.find((candidate) => candidate.rowId === row.id && candidate.columnId === column.id);
                return cell === undefined ? "" : plainText({ body: cell.text, slideNumber });
              }).join("\t"))
              .join("\n"),
          ];
        case "image":
        case "line":
        case "group":
        case "unsupported":
          return [];
        default:
          return assertNever(leaf);
      }
    })
    .join("\n");
}

function slideNumberOf(state: EditorState, slideId: SlideId): number | null {
  const index = findSlideIndex(state.document, slideId);
  return index < 0 ? null : index + 1;
}

function slideCentre(state: EditorState): Point {
  const box = slideBox(state.document);
  return { x: box.width / 2, y: box.height / 2 };
}

function lastSelectedOrCurrentSlide(state: EditorState): SlideId | null {
  const selection = state.selection;
  switch (selection.kind) {
    case "slides": {
      const indices = selection.slideIds.map((slideId) => findSlideIndex(state.document, slideId)).filter((index) => index >= 0);
      const last = state.document.slides[Math.max(...indices, -1)];
      return last?.id ?? state.currentSlideId;
    }
    case "none":
    case "elements":
    case "text":
    case "tableCells":
      return state.currentSlideId;
    default:
      return assertNever(selection);
  }
}
