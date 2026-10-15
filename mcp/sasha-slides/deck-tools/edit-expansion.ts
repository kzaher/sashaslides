/**
 * FROM A MODEL'S EDITS TO THE EDITOR'S COMMANDS. `deck_edit` takes edits in the words a person
 * would use (assistant-edit-request.ts) and turns them into the complete `DocumentCommand`s the
 * model writes (commands.ts): it mints ids, copies layout placeholders into new slides, fills
 * every style group a new element needs from the theme's and the editor's defaults, merges style
 * patches per element, and turns text edits into Y.Text index operations.
 *
 * WHY A WORKING COPY. One call is one envelope and one undo step, so a later edit of the call must
 * see what earlier ones did: a shape added in edit 1 is styled in edit 2; a title set in edit 3 has
 * a word bolded in edit 4, whose indices depend on the text edit 3 left. The expansion therefore
 * folds the edits over a WORKING COPY of the deck (slide order, each slide's elements, and the text
 * bodies it touched, flat-text.ts) and computes each edit against that. The copy is a convenience
 * for addressing, never the authority: the model validates the whole envelope again and writes
 * nothing if any command fails (`DocumentStore.apply`).
 *
 * BUILD STEPS ride in the same working copy: each slide's sequence (step ids in play order, with
 * the element each animates), so `addAnimations` with no `after` appends after steps added earlier
 * in the call, a step can target an element added earlier in the call, and deleting an element
 * drops its steps from the copy as the model drops them from the deck.
 *
 * Pure: the snapshot, the fetched image records and an id seed in; commands, the ids it minted
 * (slides, elements and build steps, per edit) and the next seed out. A refusal names the edit (`editIndex`) and why, in the model's own
 * rejection vocabulary where one fits ("elementMissing: ...").
 */
import type { AssistantEditOutcome, AssistantFrame, AssistantParagraph } from "../engine/src/contracts/assistant-deck-tools.ts";
import type { AnimationStep } from "../engine/src/contracts/animations.ts";
import type { CommandRejection, DocumentCommand, ElementPatch, FrameUpdate, TextOperation } from "../engine/src/contracts/commands.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import {
  PLACEHOLDER_ROLES,
  type AssetRecord,
  type DocumentSnapshot,
  type ElementSnapshot,
  type GroupElement,
  type ImageElement,
  type LayoutSnapshot,
  type LineElement,
  type PlaceholderRole,
  type ShapeElement,
  type ShapePreset,
  type SlideSnapshot,
  type TableElement,
  type TextBody,
} from "../engine/src/contracts/document.ts";
import {
  boundsOfBoxes,
  frameCentre,
  identityFrame,
  lineFrame,
  mapPointBetweenBoxes,
  normaliseRotation,
  rotatedBounds,
  rotateFrameAbout,
  rotatePoint,
  scaleFrameBetweenBoxes,
  SLIDE_WIDTH_UNITS,
  type Box,
  type Frame,
  type Point,
} from "../engine/src/contracts/geometry.ts";
import { mintId, type AnimationStepId, type ElementId, type IdSeed, type LayoutId, type MintedIdByKind, type ObjectIdKind, type SlideId } from "../engine/src/contracts/ids.ts";
import type { TextTarget } from "../engine/src/contracts/selection.ts";
import { DEFAULT_TEXT_BOX_STYLE, NEW_TEXT_BOX_STYLE, PLAIN_BOX_STYLE, themeColour, type ParagraphStylePatch, type RunStylePatch } from "../engine/src/contracts/style.ts";
import { PARAGRAPH_ATTRIBUTE_NAMES } from "../engine/src/contracts/yjs-schema.ts";
import { COLLABORATION_LIMITS } from "../engine/src/contracts/collaboration.ts";
import type { AssistantEditRequest, AssistantStylePatch } from "./assistant-edit-request.ts";
import { applyTextOperations, flattenTextBody, runStyleAt, searchableText, textBodyOfFlat, type FlatItem, type FlatText } from "./flat-text.ts";
import { applyElementPatch, DEFAULT_STROKE, mergeStylePatch } from "./style-merge.ts";

/**
 * Ids minted (or chosen by the model) for what one edit added: the contract's entry
 * (`AssistantEditOutcome` "created"), widened by the build steps an `addAnimations` minted, so the
 * next call can update, move or remove them. Every entry carries the field, empty when the edit
 * added no step, so the answer has one shape.
 */
export type CreatedIds = Extract<AssistantEditOutcome, { kind: "applied" }>["created"][number] & Readonly<{ animationStepIds: readonly AnimationStepId[] }>;

/** What one edit added, before its edit index is known. */
type CreatedByEdit = Omit<CreatedIds, "editIndex">;

export type ExpansionOutcome =
  | Readonly<{
      kind: "expanded";
      commands: readonly DocumentCommand[];
      /** For each command, the edit it came from: how a model rejection is traced back to an edit. */
      commandEditIndexes: readonly number[];
      created: readonly CreatedIds[];
      seed: IdSeed;
    }>
  | Readonly<{ kind: "rejected"; editIndex: number | null; reason: string }>;

/** The editor's defaults for a new element (engine/src/state/editor/element-factory.ts). */
export const NEW_ELEMENT_SIZES = {
  textBox: { width: 400, height: 80 },
  shape: { width: 240, height: 240 },
  tableColumnWidth: 160,
  tableRowHeight: 48,
} as const;

export function expandAssistantEdits(
  options: Readonly<{
    snapshot: DocumentSnapshot;
    edits: readonly AssistantEditRequest[];
    /** The fetched and stored image of each `addImage` edit, by edit index. */
    images: ReadonlyMap<number, AssetRecord>;
    seed: IdSeed;
  }>,
): ExpansionOutcome {
  let working = initialWorking({ snapshot: options.snapshot, seed: options.seed });
  const commands: DocumentCommand[] = [];
  const commandEditIndexes: number[] = [];
  const created: CreatedIds[] = [];
  for (const [editIndex, edit] of options.edits.entries()) {
    const step = expandEdit({ working, edit, editIndex, images: options.images });
    switch (step.kind) {
      case "rejected":
        return { kind: "rejected", editIndex, reason: step.reason };
      case "step":
        working = step.working;
        commands.push(...step.commands);
        commandEditIndexes.push(...step.commands.map(() => editIndex));
        if (step.created !== null) created.push({ editIndex, ...step.created });
        break;
      default:
        return assertNever(step);
    }
  }
  if (commands.length > COLLABORATION_LIMITS.maximumCommandsPerAgentApply) {
    return {
      kind: "rejected",
      editIndex: null,
      reason: `tooManyCommands: these edits expand to ${String(commands.length)} commands, more than the ${String(COLLABORATION_LIMITS.maximumCommandsPerAgentApply)} one deck_edit may apply; split the request into several calls`,
    };
  }
  return { kind: "expanded", commands, commandEditIndexes, created, seed: working.seed };
}

/**
 * Which edit a model rejection belongs to: the command named by an `invalidValue` path, else the
 * first command that mentions the id the rejection names; null when nothing points anywhere.
 */
export function editIndexOfRejection(
  options: Readonly<{ rejection: CommandRejection; commands: readonly DocumentCommand[]; commandEditIndexes: readonly number[] }>,
): number | null {
  const { rejection, commands, commandEditIndexes } = options;
  const atCommand = (commandIndex: number | null): number | null => (commandIndex === null ? null : (commandEditIndexes[commandIndex] ?? null));
  const mentioning = (id: string): number | null => {
    const quoted = JSON.stringify(id);
    const commandIndex = commands.findIndex((command) => JSON.stringify(command).includes(quoted));
    return atCommand(commandIndex === -1 ? null : commandIndex);
  };
  switch (rejection.reason) {
    case "invalidValue": {
      const match = /^commands\.(\d+)/u.exec(rejection.path);
      return atCommand(match?.[1] === undefined ? null : Number(match[1]));
    }
    case "slideMissing":
      return mentioning(rejection.slideId);
    case "elementMissing":
    case "wrongKind":
      return mentioning(rejection.elementId);
    case "layoutMissing":
      return mentioning(rejection.layoutId);
    case "transitionScriptMissing":
    case "staleScript":
    case "staleApproval":
    case "approvalNeedsPerson":
      return mentioning(rejection.scriptId);
    case "assetMissing":
      return mentioning(rejection.assetId);
    case "tableLineMissing":
    case "duplicateId":
    case "invalidId":
      return mentioning(rejection.id);
    case "groupCycle":
      return mentioning(rejection.groupId);
    case "animationStepMissing":
      return mentioning(rejection.stepId);
    case "textOutOfRange":
    case "staleText":
      return null;
    default:
      return assertNever(rejection);
  }
}

/** The rejection as a sentence that starts with the model's reason. */
export function describeRejection(rejection: CommandRejection): string {
  switch (rejection.reason) {
    case "slideMissing":
      return `slideMissing: there is no slide ${rejection.slideId} in this deck`;
    case "elementMissing":
      return `elementMissing: there is no element ${rejection.elementId} on slide ${rejection.slideId}`;
    case "layoutMissing":
      return `layoutMissing: there is no layout ${rejection.layoutId} in this deck`;
    case "transitionScriptMissing":
      return `transitionScriptMissing: there is no transition script ${rejection.scriptId} (it may have been deleted)`;
    case "assetMissing":
      return `assetMissing: the image ${rejection.assetId} is not registered in this deck`;
    case "tableLineMissing":
      return `tableLineMissing: table ${rejection.elementId} has no row or column ${rejection.id}`;
    case "animationStepMissing":
      return animationStepMissing({ slideId: rejection.slideId, stepId: rejection.stepId });
    case "duplicateId":
      return `duplicateId: ${rejection.id} is already used in this deck`;
    case "invalidId":
      return `invalidId: ${rejection.id} is not a valid id`;
    case "invalidValue":
      return `invalidValue: ${rejection.path}: ${rejection.message}`;
    case "wrongKind":
      return `wrongKind: ${rejection.elementId} is a ${rejection.actual}, not a ${rejection.expected}`;
    case "groupCycle":
      return `groupCycle: grouping into ${rejection.groupId} would put a group inside itself`;
    case "textOutOfRange":
      return `textOutOfRange: index ${String(rejection.index)} length ${String(rejection.length)} is outside the text (length ${String(rejection.bodyLength)})`;
    case "staleText":
      return `staleText: the deck changed while the edit was prepared (revision ${String(rejection.basedOnRevision)} -> ${String(rejection.currentRevision)}); read it and try again`;
    case "staleScript":
      return `staleScript: someone saved transition script ${rejection.scriptId} since it was read; read the deck and try again`;
    case "staleApproval":
      return `staleApproval: transition script ${rejection.scriptId} changed since it was reviewed`;
    case "approvalNeedsPerson":
      return `approvalNeedsPerson: only a person can approve transition script ${rejection.scriptId}`;
    default:
      return assertNever(rejection);
  }
}

// --- the working copy -----------------------------------------------------------------------------

type WorkingSlide = Readonly<{
  layoutId: LayoutId | null;
  /** Every element of the slide at any depth, by id. */
  elements: ReadonlyMap<ElementId, ElementSnapshot>;
  speakerNotes: TextBody;
  /** Bodies this call has edited, by `textKey`; the others are read from `elements`. */
  texts: ReadonlyMap<string, FlatText>;
  /** The build sequence in play order. */
  steps: readonly WorkingStep[];
}>;

type WorkingStep = Readonly<{ id: AnimationStepId; elementId: ElementId }>;

type Working = Readonly<{
  snapshot: DocumentSnapshot;
  slideOrder: readonly SlideId[];
  slides: ReadonlyMap<SlideId, WorkingSlide>;
  registeredAssets: ReadonlySet<string>;
  seed: IdSeed;
}>;

type Step =
  | Readonly<{ kind: "step"; working: Working; commands: readonly DocumentCommand[]; created: CreatedByEdit | null }>
  | Readonly<{ kind: "rejected"; reason: string }>;

function initialWorking(options: Readonly<{ snapshot: DocumentSnapshot; seed: IdSeed }>): Working {
  const { snapshot } = options;
  return {
    snapshot,
    slideOrder: snapshot.slides.map((slide) => slide.id),
    slides: new Map(snapshot.slides.map((slide) => [slide.id, workingSlideOf(slide)] as const)),
    registeredAssets: new Set(snapshot.assets.map((asset) => asset.id)),
    seed: options.seed,
  };
}

function workingSlideOf(slide: SlideSnapshot): WorkingSlide {
  const elements = new Map<ElementId, ElementSnapshot>();
  for (const element of flattenElements(slide.elements)) elements.set(element.id, element);
  return {
    layoutId: slide.layoutId,
    elements,
    speakerNotes: slide.speakerNotes,
    texts: new Map(),
    steps: slide.animations.map((animation) => ({ id: animation.id, elementId: animation.elementId })),
  };
}

function flattenElements(elements: readonly ElementSnapshot[]): readonly ElementSnapshot[] {
  return elements.flatMap((element) => [element, ...flattenElements(childrenOf(element))]);
}

function childrenOf(element: ElementSnapshot): readonly ElementSnapshot[] {
  switch (element.kind) {
    case "group":
      return element.children;
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function step(
  options: Readonly<{
    working: Working;
    commands: readonly DocumentCommand[];
    created?: Readonly<{ slideId: SlideId | null; elementIds: readonly ElementId[]; animationStepIds?: readonly AnimationStepId[] }>;
  }>,
): Step {
  const created = options.created;
  return {
    kind: "step",
    working: options.working,
    commands: options.commands,
    created: created === undefined ? null : { slideId: created.slideId, elementIds: created.elementIds, animationStepIds: created.animationStepIds ?? [] },
  };
}

function rejected(reason: string): Step {
  return { kind: "rejected", reason };
}

function withSlide(options: Readonly<{ working: Working; slideId: SlideId; slide: WorkingSlide }>): Working {
  return { ...options.working, slides: new Map(options.working.slides).set(options.slideId, options.slide) };
}

function withElements(options: Readonly<{ working: Working; slideId: SlideId; slide: WorkingSlide; elements: readonly ElementSnapshot[] }>): Working {
  const elements = new Map(options.slide.elements);
  for (const element of flattenElements(options.elements)) elements.set(element.id, element);
  return withSlide({ working: options.working, slideId: options.slideId, slide: { ...options.slide, elements } });
}

function slideMissing(slideId: SlideId): string {
  return `slideMissing: there is no slide ${slideId} in this deck`;
}

function elementMissing(options: Readonly<{ slideId: SlideId; elementId: ElementId }>): string {
  return `elementMissing: there is no element ${options.elementId} on slide ${options.slideId}`;
}

function animationStepMissing(options: Readonly<{ slideId: SlideId; stepId: AnimationStepId }>): string {
  return `animationStepMissing: there is no build step ${options.stepId} on slide ${options.slideId} (deck_read lists each slide's animations)`;
}

function elementIdTaken(options: Readonly<{ working: Working; elementId: ElementId }>): boolean {
  for (const slide of options.working.slides.values()) if (slide.elements.has(options.elementId)) return true;
  for (const layout of options.working.snapshot.layouts) if (flattenElements(layout.elements).some((element) => element.id === options.elementId)) return true;
  return false;
}

/** Mints with the working seed; the closure's final seed is written back by `withSeed`. */
function minterFor(working: Working): Readonly<{ mint: <TKind extends ObjectIdKind>(kind: TKind) => MintedIdByKind[TKind]; seed: () => IdSeed }> {
  let seed = working.seed;
  return {
    mint: (kind) => {
      const minted = mintId({ seed, kind });
      seed = minted.seed;
      return minted.id;
    },
    seed: () => seed,
  };
}

/** The new element's id: the one the model chose (when free), else a minted one. */
function newElementId(
  options: Readonly<{ working: Working; chosen: ElementId | null | undefined; mint: <TKind extends ObjectIdKind>(kind: TKind) => MintedIdByKind[TKind] }>,
): Readonly<{ kind: "free"; id: ElementId }> | Readonly<{ kind: "taken"; reason: string }> {
  if (options.chosen === null || options.chosen === undefined) return { kind: "free", id: options.mint("element") };
  if (elementIdTaken({ working: options.working, elementId: options.chosen })) {
    return { kind: "taken", reason: `duplicateId: ${options.chosen} is already used in this deck; choose another id or omit it` };
  }
  return { kind: "free", id: options.chosen };
}

// --- one edit ---------------------------------------------------------------------------------------

function expandEdit(options: Readonly<{ working: Working; edit: AssistantEditRequest; editIndex: number; images: ReadonlyMap<number, AssetRecord> }>): Step {
  const { working, edit } = options;
  switch (edit.kind) {
    case "addSlide":
      return expandAddSlide({ working, edit });
    case "deleteSlides": {
      const removed = new Set<SlideId>(edit.slideIds);
      const slides = new Map(working.slides);
      for (const slideId of removed) slides.delete(slideId);
      return step({ working: { ...working, slideOrder: working.slideOrder.filter((slideId) => !removed.has(slideId)), slides }, commands: [edit] });
    }
    case "moveSlides": {
      const moving = new Set<SlideId>(edit.slideIds);
      const remaining = working.slideOrder.filter((slideId) => !moving.has(slideId));
      const moved = working.slideOrder.filter((slideId) => moving.has(slideId));
      const at = edit.after === null ? 0 : remaining.indexOf(edit.after) + 1;
      return step({ working: { ...working, slideOrder: [...remaining.slice(0, at), ...moved, ...remaining.slice(at)] }, commands: [{ kind: "moveSlides", slideIds: edit.slideIds, after: edit.after }] });
    }
    case "setSlide":
      return expandSetSlide({ working, edit });
    case "addShape":
      return expandAddShape({ working, edit });
    case "addLine":
      return expandAddLine({ working, edit });
    case "addImage": {
      const asset = options.images.get(options.editIndex);
      if (asset === undefined) return rejected(`invalidValue: the image ${edit.source} was not fetched`);
      return expandAddImage({ working, edit, asset });
    }
    case "addTable":
      return expandAddTable({ working, edit });
    case "moveElements":
      return expandMoveElements({ working, edit });
    case "restyleElements":
      return expandRestyle({ working, edit });
    case "setText":
      return expandSetText({ working, edit });
    case "replaceText":
      return expandReplaceText({ working, edit });
    case "styleText":
      return expandStyleText({ working, edit });
    case "deleteElements": {
      const slide = working.slides.get(edit.slideId);
      if (slide === undefined) return step({ working, commands: [edit] });
      const elements = new Map(slide.elements);
      const deleted = new Set<ElementId>();
      for (const elementId of edit.elementIds) {
        const element = elements.get(elementId);
        if (element === undefined) continue;
        for (const removed of flattenElements([element])) {
          elements.delete(removed.id);
          deleted.add(removed.id);
        }
      }
      // The model deletes the steps of every deleted element in the same transaction (commands.ts).
      const steps = slide.steps.filter((animation) => !deleted.has(animation.elementId));
      return step({ working: withSlide({ working, slideId: edit.slideId, slide: { ...slide, elements, steps } }), commands: [edit] });
    }
    case "reorderElements":
      return step({ working, commands: [{ kind: "reorderElements", slideId: edit.slideId, elementIds: edit.elementIds, placement: edit.placement }] });
    case "groupElements":
      return expandGroup({ working, edit });
    case "setTitle":
      return step({ working, commands: [{ kind: "setTitle", title: edit.title }] });
    case "addAnimations":
      return expandAddAnimations({ working, edit });
    case "updateAnimations":
      return expandUpdateAnimations({ working, edit });
    case "moveAnimations":
      return expandMoveAnimations({ working, edit });
    case "removeAnimations":
      return expandRemoveAnimations({ working, edit });
    case "raw":
      return step({ working, commands: edit.commands });
    default:
      return assertNever(edit);
  }
}

// --- slides -----------------------------------------------------------------------------------------

function expandAddSlide(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "addSlide" }> }>): Step {
  const { working, edit } = options;
  const roles = PLACEHOLDER_ROLES.filter((role) => edit.placeholderText[role] !== undefined);
  const layout = chooseLayout({ layouts: working.snapshot.layouts, layoutId: edit.layoutId, roles });
  if (typeof layout === "string") return rejected(layout);
  if (edit.after !== null && !working.slides.has(edit.after)) return rejected(slideMissing(edit.after));
  if (edit.id !== null && edit.id !== undefined && working.slides.has(edit.id)) return rejected(`duplicateId: ${edit.id} is already a slide of this deck; choose another id or omit it`);
  const minter = minterFor(working);
  const slideId = edit.id ?? minter.mint("slide");
  const elements: ElementSnapshot[] = [];
  for (const element of layout?.elements ?? []) {
    const copied = copyLayoutElement({ element, groupId: null, mint: minter.mint, placeholderText: edit.placeholderText });
    if (typeof copied === "string") return rejected(copied);
    elements.push(copied);
  }
  const speakerNotes = bodyOfPlainText({ text: edit.speakerNotes, style: {} });
  const slide: SlideSnapshot = { id: slideId, layoutId: layout?.id ?? null, background: edit.background, skipped: false, speakerNotes, transition: null, elements, animations: [] };
  // "after: null" means AT THE END for the assistant, and FIRST for the command.
  const after = edit.after ?? working.slideOrder.at(-1) ?? null;
  const at = after === null ? 0 : working.slideOrder.indexOf(after) + 1;
  const next: Working = {
    ...working,
    seed: minter.seed(),
    slideOrder: [...working.slideOrder.slice(0, at), slideId, ...working.slideOrder.slice(at)],
    slides: new Map(working.slides).set(slideId, workingSlideOf(slide)),
  };
  return step({ working: next, commands: [{ kind: "insertSlides", slides: [slide], after }], created: { slideId, elementIds: flattenElements(elements).map((element) => element.id) } });
}

/**
 * The layout for a new slide: the named one; else the first after the title slide's layout (the
 * first layout) that has a placeholder for every role given text; else the title slide's layout
 * when only it fits. With no text, the first content layout. A string is the refusal.
 */
function chooseLayout(options: Readonly<{ layouts: readonly LayoutSnapshot[]; layoutId: LayoutId | null; roles: readonly PlaceholderRole[] }>): LayoutSnapshot | null | string {
  const { layouts, roles } = options;
  const described = layouts.map((layout) => `${layout.id} "${layout.name}" (${placeholderRolesOf(layout).join(", ") || "no placeholders"})`).join("; ");
  if (options.layoutId !== null) {
    const named = layouts.find((layout) => layout.id === options.layoutId);
    if (named === undefined) return `layoutMissing: there is no layout ${options.layoutId}; the layouts are ${described}`;
    const missing = roles.filter((role) => !placeholderRolesOf(named).includes(role));
    return missing.length === 0 ? named : `invalidValue: layout "${named.name}" has no ${missing.join(", ")} placeholder; the layouts are ${described}`;
  }
  if (roles.length === 0) return layouts[1] ?? layouts[0] ?? null;
  const covering = layouts.filter((layout) => roles.every((role) => placeholderRolesOf(layout).includes(role)));
  const chosen = covering.find((layout) => layout !== layouts[0]) ?? covering[0];
  return chosen ?? `invalidValue: no layout has a placeholder for every one of ${roles.join(", ")}; the layouts are ${described}`;
}

function placeholderRolesOf(layout: LayoutSnapshot): readonly PlaceholderRole[] {
  return flattenElements(layout.elements).flatMap((element) => (element.placeholder === null ? [] : [element.placeholder.role]));
}

/** A layout element with fresh ids (children re-parented), placeholder shapes holding the given text. */
function copyLayoutElement(
  options: Readonly<{
    element: ElementSnapshot;
    groupId: ElementId | null;
    mint: <TKind extends ObjectIdKind>(kind: TKind) => MintedIdByKind[TKind];
    placeholderText: Partial<Readonly<Record<PlaceholderRole, readonly AssistantParagraph[]>>>;
  }>,
): ElementSnapshot | string {
  const { element } = options;
  const id = options.mint("element");
  const common = { id, morphKey: id, groupId: options.groupId };
  switch (element.kind) {
    case "shape": {
      const paragraphs = element.placeholder === null ? undefined : options.placeholderText[element.placeholder.role];
      if (paragraphs === undefined) return { ...element, ...common };
      const text = bodyOfParagraphs(paragraphs);
      return typeof text === "string" ? text : { ...element, ...common, text };
    }
    case "group": {
      const children: ElementSnapshot[] = [];
      for (const child of element.children) {
        const copied = copyLayoutElement({ ...options, element: child, groupId: id });
        if (typeof copied === "string") return copied;
        children.push(copied);
      }
      return { ...element, ...common, children };
    }
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return { ...element, ...common };
    default:
      return assertNever(element);
  }
}

function expandSetSlide(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "setSlide" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const commands: DocumentCommand[] = Object.keys(edit.patch).length === 0 ? [] : [{ kind: "setSlideProperties", slideId: edit.slideId, patch: edit.patch }];
  const withLayout: Working = edit.patch.layoutId === undefined ? working : withSlide({ working, slideId: edit.slideId, slide: { ...slide, layoutId: edit.patch.layoutId } });
  if (edit.speakerNotes === null) return step({ working: withLayout, commands });
  const notes = replaceAllText({
    working: withLayout,
    target: { kind: "speakerNotes", slideId: edit.slideId },
    paragraphs: edit.speakerNotes.split(/\r\n?|\n/u).map((text) => ({ text, style: {}, runs: [] })),
  });
  switch (notes.kind) {
    case "rejected":
      return notes;
    case "text":
      break;
    default:
      return assertNever(notes);
  }
  return step({ working: notes.working, commands: [...commands, ...notes.commands] });
}

// --- new elements -----------------------------------------------------------------------------------

function expandAddShape(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "addShape" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const minter = minterFor(working);
  const chosen = newElementId({ working, chosen: edit.id, mint: minter.mint });
  switch (chosen.kind) {
    case "taken":
      return rejected(chosen.reason);
    case "free":
      break;
    default:
      return assertNever(chosen);
  }
  const id = chosen.id;
  const text = bodyOfParagraphs(edit.text);
  if (typeof text === "string") return rejected(text);
  const isTextBox = GROWS_WITH_TEXT[edit.preset];
  const base: ShapeElement = {
    kind: "shape",
    id,
    name: edit.name,
    description: "",
    frame: edit.frame === null ? defaultShapeFrame({ working, slide, isTextBox }) : frameOf(edit.frame),
    groupId: null,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
    preset: edit.preset,
    // A drawn shape is filled with the theme's first accent; a text box is not (element-factory.ts).
    box: isTextBox ? PLAIN_BOX_STYLE : { ...PLAIN_BOX_STYLE, fill: { kind: "solid", colour: themeColour({ slot: "accent1", alpha: 1 }) } },
    textBox: isTextBox ? NEW_TEXT_BOX_STYLE : DEFAULT_TEXT_BOX_STYLE,
    text,
  };
  const element = withStyle({ element: base, style: edit.style });
  return insertNewElement({ working: { ...working, seed: minter.seed() }, slideId: edit.slideId, slide, element });
}

/** Total over presets: which start as an unfilled text box that grows with its text (element-factory.ts). */
const GROWS_WITH_TEXT: Readonly<Record<ShapePreset, boolean>> = {
  textBox: true,
  rectangle: false,
  roundedRectangle: false,
  ellipse: false,
  triangle: false,
  rightTriangle: false,
  diamond: false,
  parallelogram: false,
  trapezoid: false,
  pentagon: false,
  hexagon: false,
  octagon: false,
  fivePointStar: false,
  plus: false,
  heart: false,
  cloud: false,
  speechBubble: false,
  chevron: false,
  rightArrow: false,
  leftArrow: false,
  upArrow: false,
  downArrow: false,
};

function expandAddLine(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "addLine" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const minter = minterFor(working);
  const chosen = newElementId({ working, chosen: edit.id, mint: minter.mint });
  switch (chosen.kind) {
    case "taken":
      return rejected(chosen.reason);
    case "free":
      break;
    default:
      return assertNever(chosen);
  }
  const id = chosen.id;
  const base: LineElement = {
    kind: "line",
    id,
    name: edit.name,
    description: "",
    frame: lineFrame({ start: edit.start, end: edit.end }),
    groupId: null,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
    start: edit.start,
    end: edit.end,
    routing: "straight",
    stroke: DEFAULT_STROKE,
    startArrow: "none",
    endArrow: "none",
    opacity: 1,
  };
  return insertNewElement({ working: { ...working, seed: minter.seed() }, slideId: edit.slideId, slide, element: withStyle({ element: base, style: edit.style }) });
}

function expandAddImage(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "addImage" }>; asset: AssetRecord }>): Step {
  const { working, edit, asset } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const minter = minterFor(working);
  const chosen = newElementId({ working, chosen: edit.id, mint: minter.mint });
  switch (chosen.kind) {
    case "taken":
      return rejected(chosen.reason);
    case "free":
      break;
    default:
      return assertNever(chosen);
  }
  const id = chosen.id;
  const element: ImageElement = {
    kind: "image",
    id,
    name: asset.name,
    description: edit.description,
    frame: edit.frame === null ? fittedImageFrame({ working, asset }) : frameOf(edit.frame),
    groupId: null,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
    assetId: asset.id,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    box: PLAIN_BOX_STYLE,
  };
  // Registering is add-only and outside undo (document.ts `AssetRecord`), so it is written once.
  const register: readonly DocumentCommand[] = working.registeredAssets.has(asset.id) ? [] : [{ kind: "registerAsset", asset }];
  const inserted = insertNewElement({ working: { ...working, seed: minter.seed(), registeredAssets: new Set(working.registeredAssets).add(asset.id) }, slideId: edit.slideId, slide, element });
  switch (inserted.kind) {
    case "rejected":
      return inserted;
    case "step":
      break;
    default:
      return assertNever(inserted);
  }
  return { ...inserted, commands: [...register, ...inserted.commands] };
}

function expandAddTable(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "addTable" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const minter = minterFor(working);
  const chosen = newElementId({ working, chosen: edit.id, mint: minter.mint });
  switch (chosen.kind) {
    case "taken":
      return rejected(chosen.reason);
    case "free":
      break;
    default:
      return assertNever(chosen);
  }
  const id = chosen.id;
  const rowCount = Math.max(1, edit.cells.length);
  const columnCount = Math.max(1, ...edit.cells.map((row) => row.length));
  const frame = edit.frame === null ? defaultTableFrame({ working, rowCount, columnCount }) : frameOf(edit.frame);
  const columns = Array.from({ length: columnCount }, () => ({ id: minter.mint("tableColumn"), width: frame.width / columnCount }));
  const rows = Array.from({ length: rowCount }, () => ({ id: minter.mint("tableRow"), minimumHeight: frame.height / rowCount }));
  const stroke = { width: 1, colour: themeColour({ slot: "dark2", alpha: 1 }), dash: "solid" as const };
  const element: TableElement = {
    kind: "table",
    id,
    name: "",
    description: "",
    frame,
    groupId: null,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
    columns,
    rows,
    cells: rows.flatMap((row, rowIndex) =>
      columns.map((column, columnIndex) => {
        const isHeader = edit.headerRow && rowIndex === 0;
        const text = edit.cells[rowIndex]?.[columnIndex] ?? "";
        return {
          rowId: row.id,
          columnId: column.id,
          rowSpan: 1,
          columnSpan: 1,
          fill: isHeader ? { kind: "solid" as const, colour: themeColour({ slot: "light2", alpha: 1 }) } : { kind: "none" as const },
          borders: { top: stroke, right: stroke, bottom: stroke, left: stroke },
          textBox: { ...DEFAULT_TEXT_BOX_STYLE, paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8 },
          text: bodyOfPlainText({ text, style: isHeader ? { fontWeight: 700 } : {} }),
        };
      }),
    ),
    opacity: 1,
  };
  return insertNewElement({ working: { ...working, seed: minter.seed() }, slideId: edit.slideId, slide, element });
}

function expandGroup(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "groupElements" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const minter = minterFor(working);
  const chosen = newElementId({ working, chosen: edit.id, mint: minter.mint });
  switch (chosen.kind) {
    case "taken":
      return rejected(chosen.reason);
    case "free":
      break;
    default:
      return assertNever(chosen);
  }
  const groupId = chosen.id;
  const members = edit.elementIds.flatMap((elementId) => {
    const element = slide.elements.get(elementId);
    return element === undefined ? [] : [element];
  });
  const bounds = boundsOfBoxes(members.map((member) => rotatedBounds(member.frame))) ?? { x: 0, y: 0, width: 1, height: 1 };
  const group: GroupElement = {
    kind: "group",
    id: groupId,
    name: "",
    description: "",
    frame: identityFrame(bounds),
    groupId: null,
    morphKey: groupId,
    placeholder: null,
    unsupportedKeys: [],
    children: members.map((member) => ({ ...member, groupId })),
  };
  return step({
    working: withElements({ working: { ...working, seed: minter.seed() }, slideId: edit.slideId, slide, elements: [group] }),
    commands: [{ kind: "groupElements", slideId: edit.slideId, elementIds: edit.elementIds, groupId }],
    created: { slideId: null, elementIds: [groupId] },
  });
}

function insertNewElement(options: Readonly<{ working: Working; slideId: SlideId; slide: WorkingSlide; element: ElementSnapshot }>): Step {
  return step({
    working: withElements({ working: options.working, slideId: options.slideId, slide: options.slide, elements: [options.element] }),
    commands: [{ kind: "insertElements", slideId: options.slideId, elements: [options.element], placement: { kind: "front" } }],
    created: { slideId: null, elementIds: [options.element.id] },
  });
}

function withStyle<TElement extends ElementSnapshot>(options: Readonly<{ element: TElement; style: AssistantStylePatch }>): ElementSnapshot {
  return applyElementPatch({ element: options.element, patch: mergeStylePatch({ element: options.element, patch: options.style }) });
}

function frameOf(frame: AssistantFrame): Frame {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rotation: normaliseRotation(frame.rotation), flipHorizontal: false, flipVertical: false };
}

function pageOf(working: Working): Box {
  return { x: 0, y: 0, width: SLIDE_WIDTH_UNITS, height: working.snapshot.pageSize.height };
}

function centredFrame(options: Readonly<{ working: Working; width: number; height: number }>): Frame {
  const page = pageOf(options.working);
  const width = Math.min(options.width, page.width);
  const height = Math.min(options.height, page.height);
  return identityFrame({ x: (page.width - width) / 2, y: (page.height - height) / 2, width, height });
}

/** A text box takes the layout's body placeholder frame; any other shape the editor's default size, centred. */
function defaultShapeFrame(options: Readonly<{ working: Working; slide: WorkingSlide; isTextBox: boolean }>): Frame {
  if (options.isTextBox) {
    const layout = options.working.snapshot.layouts.find((candidate) => candidate.id === options.slide.layoutId);
    const body = flattenElements(layout?.elements ?? []).find((element) => element.placeholder !== null && TEXT_BOX_FRAME_SOURCE[element.placeholder.role]);
    if (body !== undefined) return body.frame;
    return centredFrame({ working: options.working, ...NEW_ELEMENT_SIZES.textBox });
  }
  return centredFrame({ working: options.working, ...NEW_ELEMENT_SIZES.shape });
}

/** Which layout placeholder's frame a new text box borrows: the body's. Total over roles. */
const TEXT_BOX_FRAME_SOURCE: Readonly<Record<PlaceholderRole, boolean>> = {
  title: false,
  centredTitle: false,
  subtitle: false,
  body: true,
  slideNumber: false,
  footer: false,
  date: false,
  picture: false,
};

/** The image at its pixel size, scaled down to 80% of the page, centred (element-factory.ts `createImage`). */
function fittedImageFrame(options: Readonly<{ working: Working; asset: AssetRecord }>): Frame {
  const page = pageOf(options.working);
  const pixelWidth = Math.max(1, options.asset.pixelWidth);
  const pixelHeight = Math.max(1, options.asset.pixelHeight);
  const fit = Math.min(1, (page.width * 0.8) / pixelWidth, (page.height * 0.8) / pixelHeight);
  return centredFrame({ working: options.working, width: pixelWidth * fit, height: pixelHeight * fit });
}

function defaultTableFrame(options: Readonly<{ working: Working; rowCount: number; columnCount: number }>): Frame {
  return centredFrame({
    working: options.working,
    width: NEW_ELEMENT_SIZES.tableColumnWidth * options.columnCount,
    height: NEW_ELEMENT_SIZES.tableRowHeight * options.rowCount,
  });
}

// --- moving and restyling ---------------------------------------------------------------------------

function expandMoveElements(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "moveElements" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const updates: FrameUpdate[] = [];
  for (const move of edit.moves) {
    const element = slide.elements.get(move.elementId);
    if (element === undefined) return rejected(elementMissing({ slideId: edit.slideId, elementId: move.elementId }));
    const moved = frameUpdatesFor({ slide, element, frame: move.frame });
    if (typeof moved === "string") return rejected(moved);
    updates.push(...moved);
  }
  const elements = new Map(slide.elements);
  for (const update of updates) {
    const element = elements.get(update.elementId);
    if (element !== undefined) elements.set(update.elementId, withFrameUpdate({ element, update }));
  }
  return step({ working: withSlide({ working, slideId: edit.slideId, slide: { ...slide, elements } }), commands: [{ kind: "setFrames", slideId: edit.slideId, frames: updates }] });
}

/** The leaf frames (and group rotations) one move becomes (commands.ts "geometry arrives expanded"). */
function frameUpdatesFor(options: Readonly<{ slide: WorkingSlide; element: ElementSnapshot; frame: Partial<AssistantFrame> }>): readonly FrameUpdate[] | string {
  const { element, frame } = options;
  const target: Frame = {
    ...element.frame,
    ...(frame.x === undefined ? {} : { x: frame.x }),
    ...(frame.y === undefined ? {} : { y: frame.y }),
    ...(frame.width === undefined ? {} : { width: frame.width }),
    ...(frame.height === undefined ? {} : { height: frame.height }),
    ...(frame.rotation === undefined ? {} : { rotation: normaliseRotation(frame.rotation) }),
  };
  switch (element.kind) {
    case "shape":
    case "image":
    case "table":
      return [{ kind: "box", elementId: element.id, frame: target }];
    case "line": {
      const from = lineFrame({ start: element.start, end: element.end });
      const turn = frame.rotation ?? 0;
      const centre = frameCentre(target);
      const place = (point: Point): Point => rotatePoint({ point: mapPointBetweenBoxes({ point, from, to: target }), centre, degrees: turn });
      return [{ kind: "line", elementId: element.id, start: place(element.start), end: place(element.end) }];
    }
    case "group": {
      const turn = frame.rotation === undefined ? 0 : normaliseRotation(frame.rotation - element.frame.rotation);
      const pivot = frameCentre(target);
      const updates: FrameUpdate[] = [];
      for (const descendant of flattenElements(element.children)) {
        const current = options.slide.elements.get(descendant.id) ?? descendant;
        const update = descendantUpdate({ element: current, from: element.frame, to: target, pivot, turn });
        if (update !== null) updates.push(update);
      }
      if (frame.rotation !== undefined) updates.push({ kind: "groupRotation", elementId: element.id, rotation: target.rotation });
      return updates;
    }
    case "unsupported":
      return `wrongKind: ${element.id} was made by a newer version of the editor and cannot be moved here`;
    default:
      return assertNever(element);
  }
}

/** A group member moved with its group: scaled from the group's box to the new one, then turned about its centre. */
function descendantUpdate(options: Readonly<{ element: ElementSnapshot; from: Box; to: Box; pivot: Point; turn: number }>): FrameUpdate | null {
  const { element, from, to, pivot, turn } = options;
  switch (element.kind) {
    case "shape":
    case "image":
    case "table":
      return { kind: "box", elementId: element.id, frame: rotateFrameAbout({ frame: scaleFrameBetweenBoxes({ frame: element.frame, from, to }), pivot, degrees: turn }) };
    case "line": {
      const place = (point: Point): Point => rotatePoint({ point: mapPointBetweenBoxes({ point, from, to }), centre: pivot, degrees: turn });
      return { kind: "line", elementId: element.id, start: place(element.start), end: place(element.end) };
    }
    case "group":
      return turn === 0 ? null : { kind: "groupRotation", elementId: element.id, rotation: normaliseRotation(element.frame.rotation + turn) };
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

function withFrameUpdate(options: Readonly<{ element: ElementSnapshot; update: FrameUpdate }>): ElementSnapshot {
  const { element, update } = options;
  switch (update.kind) {
    case "box":
      return { ...element, frame: update.frame };
    case "line":
      return lineWithEnds({ element, start: update.start, end: update.end });
    case "groupRotation":
      return { ...element, frame: { ...element.frame, rotation: update.rotation } };
    default:
      return assertNever(update);
  }
}

function lineWithEnds(options: Readonly<{ element: ElementSnapshot; start: Point; end: Point }>): ElementSnapshot {
  const { element } = options;
  switch (element.kind) {
    case "line":
      return { ...element, start: options.start, end: options.end, frame: lineFrame({ start: options.start, end: options.end }) };
    case "shape":
    case "image":
    case "table":
    case "group":
    case "unsupported":
      return element;
    default:
      return assertNever(element);
  }
}

/** One `updateElements` per element, each with that element's own merged groups (style-merge.ts). */
function expandRestyle(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "restyleElements" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const commands: DocumentCommand[] = [];
  const elements = new Map(slide.elements);
  for (const elementId of edit.elementIds) {
    const element = elements.get(elementId);
    if (element === undefined) return rejected(elementMissing({ slideId: edit.slideId, elementId }));
    const patch: ElementPatch = mergeStylePatch({ element, patch: edit.patch });
    if (Object.keys(patch).length === 0) continue;
    commands.push({ kind: "updateElements", slideId: edit.slideId, elementIds: [elementId], patch });
    elements.set(elementId, applyElementPatch({ element, patch }));
  }
  return step({ working: withSlide({ working, slideId: edit.slideId, slide: { ...slide, elements } }), commands });
}

// --- build steps --------------------------------------------------------------------------------

/**
 * New steps with minted ids, after `after` or (null) after the slide's last step: the contract's
 * "appended" (the command's null means FIRST). Each step's element must be on the slide, counting
 * elements added earlier in the call.
 */
function expandAddAnimations(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "addAnimations" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  if (edit.after !== null && !slide.steps.some((animation) => animation.id === edit.after)) return rejected(animationStepMissing({ slideId: edit.slideId, stepId: edit.after }));
  const missingElement = edit.steps.find((animation) => !slide.elements.has(animation.elementId));
  if (missingElement !== undefined) return rejected(elementMissing({ slideId: edit.slideId, elementId: missingElement.elementId }));
  const minter = minterFor(working);
  const steps: AnimationStep[] = edit.steps.map((animation) => ({ id: minter.mint("animationStep"), ...animation, unsupportedKeys: [] }));
  const after = edit.after ?? slide.steps.at(-1)?.id ?? null;
  const at = after === null ? 0 : slide.steps.findIndex((animation) => animation.id === after) + 1;
  const added = steps.map((animation) => ({ id: animation.id, elementId: animation.elementId }));
  const next = { ...slide, steps: [...slide.steps.slice(0, at), ...added, ...slide.steps.slice(at)] };
  return step({
    working: withSlide({ working: { ...working, seed: minter.seed() }, slideId: edit.slideId, slide: next }),
    commands: [{ kind: "insertAnimationSteps", slideId: edit.slideId, steps, after }],
    created: { slideId: null, elementIds: [], animationStepIds: steps.map((animation) => animation.id) },
  });
}

function expandUpdateAnimations(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "updateAnimations" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const missing = missingStep({ slide, slideId: edit.slideId, stepIds: edit.stepIds });
  if (missing !== null) return rejected(missing);
  const elementId = edit.patch.elementId;
  if (elementId !== undefined && !slide.elements.has(elementId)) return rejected(elementMissing({ slideId: edit.slideId, elementId }));
  if (Object.keys(edit.patch).length === 0) return step({ working, commands: [] });
  const changing = new Set<AnimationStepId>(edit.stepIds);
  const steps = elementId === undefined ? slide.steps : slide.steps.map((animation) => (changing.has(animation.id) ? { ...animation, elementId } : animation));
  return step({
    working: withSlide({ working, slideId: edit.slideId, slide: { ...slide, steps } }),
    commands: [{ kind: "updateAnimationSteps", slideId: edit.slideId, stepIds: edit.stepIds, patch: edit.patch }],
  });
}

function expandMoveAnimations(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "moveAnimations" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const missing = missingStep({ slide, slideId: edit.slideId, stepIds: [...edit.stepIds, ...(edit.after === null ? [] : [edit.after])] });
  if (missing !== null) return rejected(missing);
  const moving = new Set<AnimationStepId>(edit.stepIds);
  if (edit.after !== null && moving.has(edit.after)) return rejected(`invalidValue: build step ${edit.after} cannot be moved after itself`);
  const remaining = slide.steps.filter((animation) => !moving.has(animation.id));
  const moved = slide.steps.filter((animation) => moving.has(animation.id));
  const at = edit.after === null ? 0 : remaining.findIndex((animation) => animation.id === edit.after) + 1;
  return step({
    working: withSlide({ working, slideId: edit.slideId, slide: { ...slide, steps: [...remaining.slice(0, at), ...moved, ...remaining.slice(at)] } }),
    commands: [{ kind: "moveAnimationSteps", slideId: edit.slideId, stepIds: edit.stepIds, after: edit.after }],
  });
}

function expandRemoveAnimations(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "removeAnimations" }> }>): Step {
  const { working, edit } = options;
  const slide = working.slides.get(edit.slideId);
  if (slide === undefined) return rejected(slideMissing(edit.slideId));
  const missing = missingStep({ slide, slideId: edit.slideId, stepIds: edit.stepIds });
  if (missing !== null) return rejected(missing);
  const removed = new Set<AnimationStepId>(edit.stepIds);
  return step({
    working: withSlide({ working, slideId: edit.slideId, slide: { ...slide, steps: slide.steps.filter((animation) => !removed.has(animation.id)) } }),
    commands: [{ kind: "deleteAnimationSteps", slideId: edit.slideId, stepIds: edit.stepIds }],
  });
}

function missingStep(options: Readonly<{ slide: WorkingSlide; slideId: SlideId; stepIds: readonly AnimationStepId[] }>): string | null {
  const present = new Set<AnimationStepId>(options.slide.steps.map((animation) => animation.id));
  const stepId = options.stepIds.find((candidate) => !present.has(candidate));
  return stepId === undefined ? null : animationStepMissing({ slideId: options.slideId, stepId });
}

// --- text -------------------------------------------------------------------------------------------

type TextStep = Readonly<{ kind: "text"; working: Working; commands: readonly DocumentCommand[] }> | Readonly<{ kind: "rejected"; reason: string }>;

function expandSetText(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "setText" }> }>): Step {
  const { working, edit } = options;
  const target = textTargetOf({ working, slideId: edit.slideId, elementId: edit.elementId, cell: edit.cell });
  if (typeof target === "string") return rejected(target);
  return stepOfText(replaceAllText({ working, target, paragraphs: edit.paragraphs }));
}

/**
 * Replace a whole body with ONE `editText` (SPEC.md 21.14): delete everything but the final mark,
 * insert the paragraphs' text unstyled, then give every paragraph exactly its style (clearing every
 * other paragraph attribute, so nothing of the old last paragraph survives) and every run its own.
 */
function replaceAllText(options: Readonly<{ working: Working; target: TextTarget; paragraphs: readonly AssistantParagraph[] }>): TextStep {
  const { working, target } = options;
  const paragraphs: readonly AssistantParagraph[] = options.paragraphs.length === 0 ? [{ text: "", style: {}, runs: [] }] : options.paragraphs;
  const runProblem = paragraphs.map(runRangeProblem).find((problem) => problem !== null);
  if (runProblem !== undefined && runProblem !== null) return { kind: "rejected", reason: runProblem };
  const flat = currentText({ working, target });
  if (flat === null) return { kind: "rejected", reason: `invalidValue: ${describeTarget(target)} has no text` };
  const operations: TextOperation[] = [];
  if (flat.length > 1) operations.push({ kind: "delete", index: 0, length: flat.length - 1 });
  const joined = paragraphs.map((paragraph) => paragraph.text).join("\n");
  if (joined.length > 0) operations.push({ kind: "insert", index: 0, text: joined, style: {} });
  let offset = 0;
  for (const paragraph of paragraphs) {
    const markIndex = offset + paragraph.text.length;
    operations.push({ kind: "formatParagraphs", index: markIndex, length: 1, patch: paragraph.style, clear: paragraphAttributesNotIn(paragraph.style) });
    for (const run of paragraph.runs) {
      if (run.end > run.start) operations.push({ kind: "formatRuns", index: offset + run.start, length: run.end - run.start, patch: run.style, clear: [] });
    }
    offset = markIndex + 1;
  }
  return textEdit({ working, target, operations });
}

function expandReplaceText(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "replaceText" }> }>): Step {
  const { working, edit } = options;
  const target = textTargetOf({ working, slideId: edit.slideId, elementId: edit.elementId, cell: null });
  if (typeof target === "string") return rejected(target);
  const flat = currentText({ working, target });
  if (flat === null) return rejected(`invalidValue: ${describeTarget(target)} has no text`);
  const matches = occurrences({ flat, find: edit.find, all: edit.all });
  if (typeof matches === "string") return rejected(matches);
  if (matches.length === 0) return rejected(textNotFound({ find: edit.find, target, flat }));
  // Last occurrence first, so every earlier index is still where the search found it.
  const operations = [...matches].reverse().flatMap((index): TextOperation[] => [
    { kind: "delete", index, length: edit.find.length },
    ...(edit.replaceWith.length === 0 ? [] : [{ kind: "insert" as const, index, text: edit.replaceWith, style: runStyleAt({ flat, index }) }]),
  ]);
  return stepOfText(textEdit({ working, target, operations }));
}

function expandStyleText(options: Readonly<{ working: Working; edit: Extract<AssistantEditRequest, { kind: "styleText" }> }>): Step {
  const { working, edit } = options;
  if (Object.keys(edit.run).length === 0 && Object.keys(edit.paragraph).length === 0) return rejected(`invalidValue: styleText of "${edit.find}" names no run or paragraph style`);
  const target = textTargetOf({ working, slideId: edit.slideId, elementId: edit.elementId, cell: null });
  if (typeof target === "string") return rejected(target);
  const flat = currentText({ working, target });
  if (flat === null) return rejected(`invalidValue: ${describeTarget(target)} has no text`);
  const matches = occurrences({ flat, find: edit.find, all: false });
  if (typeof matches === "string") return rejected(matches);
  const index = matches[0];
  if (index === undefined) return rejected(textNotFound({ find: edit.find, target, flat }));
  const operations: TextOperation[] = [
    ...(Object.keys(edit.run).length === 0 ? [] : [{ kind: "formatRuns" as const, index, length: edit.find.length, patch: edit.run, clear: [] }]),
    ...(Object.keys(edit.paragraph).length === 0 ? [] : [{ kind: "formatParagraphs" as const, index, length: edit.find.length, patch: edit.paragraph, clear: [] }]),
  ];
  return stepOfText(textEdit({ working, target, operations }));
}

function stepOfText(text: TextStep): Step {
  switch (text.kind) {
    case "rejected":
      return text;
    case "text":
      return step({ working: text.working, commands: text.commands });
    default:
      return assertNever(text);
  }
}

/** Start indices of `find` (exact, non-overlapping), the first only unless `all`. */
function occurrences(options: Readonly<{ flat: FlatText; find: string; all: boolean }>): readonly number[] | string {
  if (options.find.includes("\n")) return `invalidValue: the text to find cannot span paragraphs (it contains a line break)`;
  const text = searchableText(options.flat);
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(options.find, from);
    if (index === -1) return found;
    found.push(index);
    if (!options.all) return found;
    from = index + options.find.length;
  }
}

function textNotFound(options: Readonly<{ find: string; target: TextTarget; flat: FlatText }>): string {
  const text = searchableText(options.flat).replace(/\n$/u, "");
  const shown = text.length > 200 ? `${text.slice(0, 200)}...` : text;
  return `textNotFound: "${options.find}" is not in ${describeTarget(options.target)} (its text is ${JSON.stringify(shown)})`;
}

function textEdit(options: Readonly<{ working: Working; target: TextTarget; operations: readonly TextOperation[] }>): TextStep {
  const { working, target, operations } = options;
  const flat = currentText({ working, target });
  const slide = working.slides.get(target.slideId);
  if (flat === null || slide === undefined) return { kind: "rejected", reason: `invalidValue: ${describeTarget(target)} has no text` };
  const texts = new Map(slide.texts).set(textKey(target), applyTextOperations({ flat, operations }));
  return {
    kind: "text",
    working: withSlide({ working, slideId: target.slideId, slide: { ...slide, texts } }),
    commands: operations.length === 0 ? [] : [{ kind: "editText", target, basedOnRevision: working.snapshot.revision, operations }],
  };
}

function textTargetOf(
  options: Readonly<{ working: Working; slideId: SlideId; elementId: ElementId; cell: Readonly<{ row: number; column: number }> | null }>,
): TextTarget | string {
  const slide = options.working.slides.get(options.slideId);
  if (slide === undefined) return slideMissing(options.slideId);
  const element = slide.elements.get(options.elementId);
  if (element === undefined) return elementMissing({ slideId: options.slideId, elementId: options.elementId });
  switch (element.kind) {
    case "shape":
      return options.cell === null ? { kind: "element", slideId: options.slideId, elementId: element.id } : `wrongKind: ${element.id} is a shape, not a table; omit cell`;
    case "table": {
      if (options.cell === null) return `invalidValue: ${element.id} is a table; name the cell ({ row, column }, 0-based)`;
      const row = element.rows[options.cell.row];
      const column = element.columns[options.cell.column];
      if (row === undefined || column === undefined) {
        return `tableLineMissing: table ${element.id} has ${String(element.rows.length)} rows and ${String(element.columns.length)} columns, so there is no cell ${String(options.cell.row)}, ${String(options.cell.column)}`;
      }
      return { kind: "tableCell", slideId: options.slideId, elementId: element.id, cell: { rowId: row.id, columnId: column.id } };
    }
    case "image":
    case "line":
    case "group":
    case "unsupported":
      return `wrongKind: ${element.id} is a ${element.kind}, which holds no text`;
    default:
      return assertNever(element);
  }
}

function currentText(options: Readonly<{ working: Working; target: TextTarget }>): FlatText | null {
  const { working, target } = options;
  const slide = working.slides.get(target.slideId);
  if (slide === undefined) return null;
  const edited = slide.texts.get(textKey(target));
  if (edited !== undefined) return edited;
  const body = storedBody({ slide, target });
  return body === null ? null : flattenTextBody(body);
}

function storedBody(options: Readonly<{ slide: WorkingSlide; target: TextTarget }>): TextBody | null {
  const { slide, target } = options;
  switch (target.kind) {
    case "speakerNotes":
      return slide.speakerNotes;
    case "element": {
      const element = slide.elements.get(target.elementId);
      return element === undefined ? null : shapeText(element);
    }
    case "tableCell": {
      const element = slide.elements.get(target.elementId);
      return element === undefined ? null : cellText({ element, rowId: target.cell.rowId, columnId: target.cell.columnId });
    }
    default:
      return assertNever(target);
  }
}

function shapeText(element: ElementSnapshot): TextBody | null {
  switch (element.kind) {
    case "shape":
      return element.text;
    case "image":
    case "line":
    case "table":
    case "group":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

function cellText(options: Readonly<{ element: ElementSnapshot; rowId: string; columnId: string }>): TextBody | null {
  const { element } = options;
  switch (element.kind) {
    case "table":
      return element.cells.find((cell) => cell.rowId === options.rowId && cell.columnId === options.columnId)?.text ?? null;
    case "shape":
    case "image":
    case "line":
    case "group":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

function textKey(target: TextTarget): string {
  switch (target.kind) {
    case "speakerNotes":
      return "speakerNotes";
    case "element":
      return `element:${target.elementId}`;
    case "tableCell":
      return `cell:${target.elementId}|${target.cell.rowId}|${target.cell.columnId}`;
    default:
      return assertNever(target);
  }
}

function describeTarget(target: TextTarget): string {
  switch (target.kind) {
    case "speakerNotes":
      return `the speaker notes of slide ${target.slideId}`;
    case "element":
      return `element ${target.elementId}`;
    case "tableCell":
      return `a cell of table ${target.elementId}`;
    default:
      return assertNever(target);
  }
}

function paragraphAttributesNotIn(style: ParagraphStylePatch): readonly (typeof PARAGRAPH_ATTRIBUTE_NAMES)[number][] {
  return PARAGRAPH_ATTRIBUTE_NAMES.filter((name) => style[name] === undefined);
}

function runRangeProblem(paragraph: AssistantParagraph): string | null {
  for (const run of paragraph.runs) {
    if (run.start >= run.end || run.end > paragraph.text.length) {
      return `invalidValue: a run [${String(run.start)}, ${String(run.end)}) does not fit inside the paragraph "${paragraph.text}" (length ${String(paragraph.text.length)})`;
    }
  }
  return null;
}

/** Paragraphs as a stored body: each character styled by every run covering it, later runs winning. */
function bodyOfParagraphs(paragraphs: readonly AssistantParagraph[]): TextBody | string {
  const problem = paragraphs.map(runRangeProblem).find((candidate) => candidate !== null);
  if (problem !== undefined && problem !== null) return problem;
  const flat: FlatItem[] = [];
  for (const paragraph of paragraphs.length === 0 ? [{ text: "", style: {}, runs: [] }] : paragraphs) {
    for (let index = 0; index < paragraph.text.length; index += 1) {
      const style = paragraph.runs.reduce<RunStylePatch>((merged, run) => (index >= run.start && index < run.end ? { ...merged, ...run.style } : merged), {});
      flat.push({ kind: "character", character: paragraph.text.charAt(index), style });
    }
    flat.push({ kind: "paragraphMark", style: paragraph.style });
  }
  return textBodyOfFlat(flat);
}

/** Plain text (lines become paragraphs), every character with `style`. */
function bodyOfPlainText(options: Readonly<{ text: string; style: RunStylePatch }>): TextBody {
  const lines = options.text.split(/\r\n?|\n/u);
  return { paragraphs: lines.map((line) => ({ style: {}, runs: line.length === 0 ? [] : [{ kind: "text" as const, text: line, style: options.style }] })) };
}
