// VALIDATE EVERY COMMAND, THEN WRITE (commands.ts). A Yjs transaction cannot be rolled back, so an
// envelope is checked in full before its first write, and the first failure rejects the whole
// envelope with a `CommandRejection` and writes nothing.
//
// Commands in one envelope build on each other (insert a table, then type into it; delete a group,
// so its children are gone for the next command), so each command is checked against the document
// AS THE EARLIER COMMANDS WILL HAVE LEFT IT. That prospective state is a small overlay over the
// Y.Doc -- which slides, elements, layouts, scripts, assets, table lines and text lengths the
// envelope creates, deletes or changes -- recorded as each command passes. It is deliberately not a
// second document: only what a later command could check is tracked.
//
// Value checks reuse stored-values.ts, so a command can never write what the projection would
// refuse to read; a value this client would call "unsupported" is refused too, since a client
// only ever writes values it understands.

import type { AnimationEffect, AnimationStep, AnimationStepPatch } from "../contracts/animations.ts";
import type { CommandAuthor, CommandEnvelope, CommandRejection, DocumentCommand, ElementPatch, TextOperation } from "../contracts/commands.ts";
import type { ElementSnapshot, ScriptPurpose, SlideSnapshot, TextBody, ThemeSnapshot } from "../contracts/document.ts";
import type { AnimationStepId, AssetId, ElementId, LayoutId, SlideId, TransitionScriptId } from "../contracts/ids.ts";
import type { TextTarget } from "../contracts/selection.ts";
import { ANIMATION_LIMITS } from "../contracts/animations.ts";
import { assertNever } from "../contracts/assert-never.ts";
import { scriptFingerprint, textBodyLength } from "../contracts/document.ts";
import { isObjectId, parseAssetId } from "../contracts/ids.ts";
import { textTargetKey } from "../contracts/text-delta.ts";
import { ANIMATION_STEP_KEY, ELEMENT_KEY, RUN_ATTRIBUTE_NAMES, PARAGRAPH_ATTRIBUTE_NAMES, SLIDE_KEY, TRANSITION_SCRIPT_KEY } from "../contracts/yjs-schema.ts";
import { childArray, childMap, elementsMapOf, slideMapOf, textOf, type DocumentRoots } from "./document-paths.ts";
import { readSlideStructure, tableLineIds, type SlideStructure } from "./element-tree.ts";
import {
  ANIMATION_EFFECT,
  ANIMATION_TRIGGER,
  ARROW_HEAD,
  ASSET_RECORD,
  BORDER,
  CELL_BORDERS,
  checkBoolean,
  checkFrame,
  checkNumber,
  checkPoint,
  checkPositive,
  checkSerialisable,
  checkString,
  checkStylePatch,
  checkTextBoxField,
  checkTextBoxStyle,
  CORNER_RADIUS,
  CUSTOM_OUTLINE,
  FILL,
  IMAGE_CROP,
  isRecord,
  LINE_ROUTING,
  NUMBER,
  OPACITY,
  OPTIONAL_FILL,
  PARAGRAPH_ATTRIBUTE_CHECKS,
  PLACEHOLDER,
  readStored,
  RUN_ATTRIBUTE_CHECKS,
  SHADOW,
  SCRIPT_PURPOSE,
  SHAPE_PRESET,
  SLIDE_TRANSITION,
  STROKE,
  TEXT,
  TRANSITION_EASING,
  valueOr,
  type StoredValueCheck,
  type Verdict,
} from "./stored-values.ts";
import { PLACEHOLDER_ROLES } from "../contracts/document.ts";
import { THEME_COLOUR_SLOTS } from "../contracts/style.ts";

export type ValidationContext = Readonly<{ roots: DocumentRoots; revision: number }>;

/** The first reason the envelope cannot be applied, or null when every command can. */
export function validateEnvelope(options: Readonly<{ context: ValidationContext; envelope: CommandEnvelope }>): CommandRejection | null {
  const prospect = createProspect(options.context.roots);
  for (const [index, command] of options.envelope.commands.entries()) {
    const rejection = validateCommand({ prospect, command, path: `commands.${index}`, revision: options.context.revision, author: options.envelope.author });
    if (rejection !== null) return rejection;
  }
  return null;
}

/** An element as the prospective document sees it. */
type ProspectiveElement = Readonly<{ kind: string; parent: ElementId | null }>;
type ScriptState = Readonly<{ updatedAt: number; fingerprint: string; purpose: ScriptPurpose }>;
type TableLines = Readonly<{ rows: readonly string[]; columns: readonly string[] }>;

/** The document as the commands validated so far will leave it (see the header). */
type Prospect = Readonly<{
  slideExists: (slideId: SlideId) => boolean;
  recordSlide: (slideId: SlideId, exists: boolean) => void;
  element: (slideId: SlideId, elementId: ElementId) => ProspectiveElement | null;
  recordElement: (slideId: SlideId, elementId: ElementId, element: ProspectiveElement | null) => void;
  elementIds: (slideId: SlideId) => readonly ElementId[];
  layoutExists: (layoutId: LayoutId) => boolean;
  recordLayout: (layoutId: LayoutId, exists: boolean) => void;
  script: (scriptId: TransitionScriptId) => ScriptState | null;
  recordScript: (scriptId: TransitionScriptId, state: ScriptState | null) => void;
  assetExists: (assetId: AssetId) => boolean;
  recordAsset: (assetId: AssetId) => void;
  textLength: (target: TextTarget) => number | null;
  recordTextLength: (target: TextTarget, length: number | null) => void;
  tableLines: (slideId: SlideId, elementId: ElementId) => TableLines | null;
  recordTableLines: (slideId: SlideId, elementId: ElementId, lines: TableLines) => void;
  /** The slide's build steps and the element each targets, as the envelope will leave them. */
  steps: (slideId: SlideId) => ReadonlyMap<AnimationStepId, ElementId>;
  recordStep: (slideId: SlideId, stepId: AnimationStepId, elementId: ElementId | null) => void;
}>;

function createProspect(roots: DocumentRoots): Prospect {
  const slides = new Map<SlideId, boolean>();
  const elements = new Map<string, ProspectiveElement | null>();
  const structures = new Map<SlideId, SlideStructure | null>();
  const layouts = new Map<LayoutId, boolean>();
  const scripts = new Map<TransitionScriptId, ScriptState | null>();
  const assets = new Set<AssetId>();
  const textLengths = new Map<string, number | null>();
  const tables = new Map<string, TableLines>();
  const stepOverlay = new Map<SlideId, Map<AnimationStepId, ElementId | null>>();

  const structureOf = (slideId: SlideId): SlideStructure | null => {
    if (!structures.has(slideId)) {
      const elementsMap = elementsMapOf(roots, slideId);
      structures.set(slideId, elementsMap === null ? null : readSlideStructure(elementsMap));
    }
    return structures.get(slideId) ?? null;
  };
  const slideExists = (slideId: SlideId): boolean => {
    const recorded = slides.get(slideId);
    return recorded ?? childMap(roots.slides, slideId) !== null;
  };
  const elementKey = (slideId: SlideId, elementId: ElementId): string => `${slideId}/${elementId}`;
  const element = (slideId: SlideId, elementId: ElementId): ProspectiveElement | null => {
    if (!slideExists(slideId)) return null;
    const key = elementKey(slideId, elementId);
    if (elements.has(key)) return elements.get(key) ?? null;
    if (slides.get(slideId) === true) return null;
    const record = structureOf(slideId)?.records.get(elementId);
    if (record === undefined) return null;
    return { kind: record.storedKind ?? "", parent: structureOf(slideId)?.parentOf.get(elementId) ?? null };
  };

  return {
    slideExists,
    recordSlide: (slideId, exists) => {
      slides.set(slideId, exists);
      stepOverlay.delete(slideId);
      if (exists) structures.set(slideId, null);
    },
    element,
    recordElement: (slideId, elementId, value) => elements.set(elementKey(slideId, elementId), value),
    elementIds: (slideId) => {
      const ids = new Set<ElementId>(slides.get(slideId) === true ? [] : [...(structureOf(slideId)?.records.keys() ?? [])]);
      for (const key of elements.keys()) {
        if (!key.startsWith(`${slideId}/`)) continue;
        // Overlay keys are "slideId/elementId", written by `recordElement` from element ids.
        ids.add(key.slice(slideId.length + 1) as ElementId);
      }
      return [...ids].filter((id) => element(slideId, id) !== null);
    },
    layoutExists: (layoutId) => layouts.get(layoutId) ?? childMap(roots.layouts, layoutId) !== null,
    recordLayout: (layoutId, exists) => layouts.set(layoutId, exists),
    script: (scriptId) => {
      if (scripts.has(scriptId)) return scripts.get(scriptId) ?? null;
      const map = childMap(roots.transitionScripts, scriptId);
      if (map === null) return null;
      const text = (key: string): string => valueOr(readStored({ map, key, kind: TEXT }), "");
      const purpose = valueOr(readStored({ map, key: TRANSITION_SCRIPT_KEY.purpose, kind: SCRIPT_PURPOSE }), "transition");
      return {
        updatedAt: valueOr(readStored({ map, key: TRANSITION_SCRIPT_KEY.updatedAt, kind: NUMBER }), 0),
        fingerprint: scriptFingerprint({
          script: text(TRANSITION_SCRIPT_KEY.script),
          stylesheet: text(TRANSITION_SCRIPT_KEY.stylesheet),
          markup: text(TRANSITION_SCRIPT_KEY.markup),
          purpose,
        }),
        purpose,
      };
    },
    recordScript: (scriptId, state) => scripts.set(scriptId, state),
    assetExists: (assetId) => assets.has(assetId) || roots.assets.has(assetId),
    recordAsset: (assetId) => assets.add(assetId),
    textLength: (target) => {
      const key = textTargetKey(target);
      if (textLengths.has(key)) return textLengths.get(key) ?? null;
      if (!targetExists(target)) return null;
      const text = textOf(roots, target);
      // A table cell nobody created yet is an empty body of one paragraph mark (yjs-schema.ts).
      if (text === null) return target.kind === "tableCell" ? 1 : null;
      return text.length;
    },
    recordTextLength: (target, length) => textLengths.set(textTargetKey(target), length),
    tableLines: (slideId, elementId) => {
      const known = tables.get(elementKey(slideId, elementId));
      if (known !== undefined) return known;
      if (element(slideId, elementId) === null) return null;
      const elementsMap = elementsMapOf(roots, slideId);
      const map = elementsMap === null ? null : childMap(elementsMap, elementId);
      if (map === null) return null;
      return { rows: tableLineIds(childArray(map, ELEMENT_KEY.rows)), columns: tableLineIds(childArray(map, ELEMENT_KEY.columns)) };
    },
    recordTableLines: (slideId, elementId, lines) => tables.set(elementKey(slideId, elementId), lines),
    steps: (slideId) => {
      const steps = new Map<AnimationStepId, ElementId>();
      if (!slideExists(slideId)) return steps;
      if (slides.get(slideId) !== true) {
        const slide = slideMapOf(roots, slideId);
        const stored = slide === null ? null : childMap(slide, SLIDE_KEY.animations);
        stored?.forEach((_value, id) => {
          const step = childMap(stored, id);
          const target = step === null ? null : step.get(ANIMATION_STEP_KEY.elementId);
          // Keys of a slide's animations map are step ids, and its element ids name elements (document-writer.ts).
          if (typeof target === "string") steps.set(id as AnimationStepId, target as ElementId);
        });
      }
      for (const [stepId, target] of stepOverlay.get(slideId) ?? []) {
        if (target === null) steps.delete(stepId);
        else steps.set(stepId, target);
      }
      return steps;
    },
    recordStep: (slideId, stepId, target) => {
      const overlay = stepOverlay.get(slideId) ?? new Map<AnimationStepId, ElementId | null>();
      overlay.set(stepId, target);
      stepOverlay.set(slideId, overlay);
    },
  };

  function targetExists(target: TextTarget): boolean {
    switch (target.kind) {
      case "speakerNotes":
        return slideExists(target.slideId) && slides.get(target.slideId) !== true;
      case "element":
        return element(target.slideId, target.elementId)?.kind === "shape";
      case "tableCell":
        return element(target.slideId, target.elementId)?.kind === "table";
      default:
        return assertNever(target);
    }
  }
}

type CommandCheck = Readonly<{ prospect: Prospect; command: DocumentCommand; path: string; revision: number; author: CommandAuthor }>;

function validateCommand(options: CommandCheck): CommandRejection | null {
  const { prospect, command, path } = options;
  switch (command.kind) {
    case "setTitle":
      return value({ path: `${path}.title`, verdict: checkString(command.title) });
    case "updateTheme":
      return validateThemePatch({ patch: command.patch, path: `${path}.patch` });
    case "upsertLayout": {
      const layout = command.layout;
      if (!isObjectId(layout.id)) return { reason: "invalidId", id: layout.id };
      const rejection =
        value({ path: `${path}.layout.name`, verdict: checkString(layout.name) }) ??
        value({ path: `${path}.layout.background`, verdict: OPTIONAL_FILL.check(layout.background) }) ??
        validateTrees({ prospect, slideId: null, elements: layout.elements, path: `${path}.layout.elements`, seen: new Set() });
      if (rejection !== null) return rejection;
      prospect.recordLayout(layout.id, true);
      return null;
    }
    case "deleteLayout":
      if (!prospect.layoutExists(command.layoutId)) return { reason: "layoutMissing", layoutId: command.layoutId };
      prospect.recordLayout(command.layoutId, false);
      return null;
    case "registerAsset": {
      const asset = command.asset;
      const rejection = value({ path: `${path}.asset`, verdict: ASSET_RECORD.check(asset) });
      if (rejection !== null) return rejection;
      if (parseAssetId(asset.id) === null) return { reason: "invalidId", id: asset.id };
      prospect.recordAsset(asset.id);
      return null;
    }
    case "upsertTransitionScript":
      return validateScriptUpsert({ prospect, command, path, author: options.author });
    case "deleteTransitionScript":
      if (prospect.script(command.scriptId) === null) return { reason: "transitionScriptMissing", scriptId: command.scriptId };
      prospect.recordScript(command.scriptId, null);
      return null;
    case "approveTransitionScript": {
      if (options.author.kind !== "person") return { reason: "approvalNeedsPerson", scriptId: command.scriptId };
      const script = prospect.script(command.scriptId);
      if (script === null) return { reason: "transitionScriptMissing", scriptId: command.scriptId };
      if (script.fingerprint !== command.fingerprint) {
        return { reason: "staleApproval", scriptId: command.scriptId, fingerprint: command.fingerprint, currentFingerprint: script.fingerprint };
      }
      return null;
    }
    case "insertSlides":
      return validateSlideInsert({ prospect, slides: command.slides, after: command.after, path });
    case "deleteSlides":
      for (const slideId of command.slideIds) {
        if (!prospect.slideExists(slideId)) return { reason: "slideMissing", slideId };
      }
      for (const slideId of command.slideIds) prospect.recordSlide(slideId, false);
      return null;
    case "moveSlides":
      for (const slideId of command.slideIds) {
        if (!prospect.slideExists(slideId)) return { reason: "slideMissing", slideId };
      }
      if (command.after !== null && !prospect.slideExists(command.after)) return { reason: "slideMissing", slideId: command.after };
      if (command.after !== null && command.slideIds.includes(command.after)) {
        return { reason: "invalidValue", path: `${path}.after`, message: "a slide cannot move after itself" };
      }
      return null;
    case "setSlideProperties": {
      if (!prospect.slideExists(command.slideId)) return { reason: "slideMissing", slideId: command.slideId };
      const patch = command.patch;
      const layoutId = patch.layoutId;
      if (layoutId !== undefined && layoutId !== null && !prospect.layoutExists(layoutId)) return { reason: "layoutMissing", layoutId };
      return (
        (patch.background === undefined ? null : value({ path: `${path}.patch.background`, verdict: OPTIONAL_FILL.check(patch.background) })) ??
        (patch.skipped === undefined ? null : value({ path: `${path}.patch.skipped`, verdict: checkBoolean(patch.skipped) })) ??
        (patch.transition === undefined ? null : value({ path: `${path}.patch.transition`, verdict: SLIDE_TRANSITION.check(patch.transition) }))
      );
    }
    case "insertElements":
      return validateElementInsert({ prospect, command, path });
    case "deleteElements": {
      for (const elementId of command.elementIds) {
        if (prospect.element(command.slideId, elementId) === null) return elementMissing({ prospect, slideId: command.slideId, elementId });
      }
      const deleted = new Set<ElementId>();
      for (const elementId of command.elementIds) {
        for (const descendant of descendantsOf({ prospect, slideId: command.slideId, elementId })) {
          prospect.recordElement(command.slideId, descendant, null);
          deleted.add(descendant);
        }
        prospect.recordElement(command.slideId, elementId, null);
        deleted.add(elementId);
      }
      // The model deletes the steps of every deleted element with it (commands.ts `deleteElements`).
      for (const [stepId, target] of prospect.steps(command.slideId)) {
        if (deleted.has(target)) prospect.recordStep(command.slideId, stepId, null);
      }
      return null;
    }
    case "setFrames":
      return validateFrames({ prospect, command, path });
    case "updateElements": {
      for (const elementId of command.elementIds) {
        if (prospect.element(command.slideId, elementId) === null) return elementMissing({ prospect, slideId: command.slideId, elementId });
      }
      return validateElementPatch({ prospect, patch: command.patch, path: `${path}.patch` });
    }
    case "reorderElements":
      for (const elementId of command.elementIds) {
        if (prospect.element(command.slideId, elementId) === null) return elementMissing({ prospect, slideId: command.slideId, elementId });
      }
      return null;
    case "groupElements":
      return validateGroup({ prospect, command, path });
    case "ungroupElements":
      for (const groupId of command.groupIds) {
        const group = prospect.element(command.slideId, groupId);
        if (group === null) return elementMissing({ prospect, slideId: command.slideId, elementId: groupId });
        if (group.kind !== "group") return { reason: "wrongKind", elementId: groupId, expected: "group", actual: group.kind };
      }
      for (const groupId of command.groupIds) {
        const parent = prospect.element(command.slideId, groupId)?.parent ?? null;
        for (const childId of prospect.elementIds(command.slideId)) {
          const child = prospect.element(command.slideId, childId);
          if (child !== null && child.parent === groupId) prospect.recordElement(command.slideId, childId, { kind: child.kind, parent });
        }
        prospect.recordElement(command.slideId, groupId, null);
      }
      return null;
    case "editText":
      return validateTextEdit({ prospect, target: command.target, operations: command.operations, basedOnRevision: command.basedOnRevision, revision: options.revision, path });
    case "insertTableRows":
    case "insertTableColumns":
    case "deleteTableRows":
    case "deleteTableColumns":
    case "setTableColumnWidths":
    case "setTableRowHeights":
    case "updateTableCells":
      return validateTableCommand({ prospect, command, path });
    case "insertAnimationSteps":
    case "updateAnimationSteps":
    case "moveAnimationSteps":
    case "deleteAnimationSteps":
      return validateAnimationCommand({ prospect, command, path });
    default:
      return assertNever(command);
  }
}

function value(options: Readonly<{ path: string; verdict: Verdict }>): CommandRejection | null {
  switch (options.verdict) {
    case "valid":
      return null;
    case "unsupported":
      return { reason: "invalidValue", path: options.path, message: "this value is not one this editor understands" };
    case "wrongType":
      return { reason: "invalidValue", path: options.path, message: "this value has the wrong shape" };
    default:
      return assertNever(options.verdict);
  }
}

function checked<TValue>(options: Readonly<{ path: string; candidate: unknown; kind: StoredValueCheck<TValue> }>): CommandRejection | null {
  return value({ path: options.path, verdict: options.kind.check(options.candidate) });
}

function elementMissing(options: Readonly<{ prospect: Prospect; slideId: SlideId; elementId: ElementId }>): CommandRejection {
  if (!options.prospect.slideExists(options.slideId)) return { reason: "slideMissing", slideId: options.slideId };
  return { reason: "elementMissing", slideId: options.slideId, elementId: options.elementId };
}

function descendantsOf(options: Readonly<{ prospect: Prospect; slideId: SlideId; elementId: ElementId }>): readonly ElementId[] {
  const { prospect, slideId, elementId } = options;
  return prospect.elementIds(slideId).filter((candidate) => {
    const visited = new Set<ElementId>();
    let parent = prospect.element(slideId, candidate)?.parent ?? null;
    while (parent !== null && !visited.has(parent)) {
      if (parent === elementId) return true;
      visited.add(parent);
      parent = prospect.element(slideId, parent)?.parent ?? null;
    }
    return false;
  });
}

function validateThemePatch(options: Readonly<{ patch: Partial<ThemeSnapshot>; path: string }>): CommandRejection | null {
  const { patch, path } = options;
  if (patch.name !== undefined && checkString(patch.name) !== "valid") return value({ path: `${path}.name`, verdict: "wrongType" });
  if (patch.headingFontFamily !== undefined && checkString(patch.headingFontFamily) !== "valid") return value({ path: `${path}.headingFontFamily`, verdict: "wrongType" });
  if (patch.bodyFontFamily !== undefined && checkString(patch.bodyFontFamily) !== "valid") return value({ path: `${path}.bodyFontFamily`, verdict: "wrongType" });
  if (patch.background !== undefined) {
    const rejection = checked({ path: `${path}.background`, candidate: patch.background, kind: FILL });
    if (rejection !== null) return rejection;
  }
  if (patch.colours !== undefined) {
    const colours: unknown = patch.colours;
    if (!isRecord(colours)) return value({ path: `${path}.colours`, verdict: "wrongType" });
    for (const slot of THEME_COLOUR_SLOTS) {
      const colour = colours[slot];
      if (typeof colour !== "string" || !HEXADECIMAL_PATTERN.test(colour)) return value({ path: `${path}.colours.${slot}`, verdict: "wrongType" });
    }
  }
  if (patch.placeholderStyles !== undefined) {
    const styles: unknown = patch.placeholderStyles;
    if (!isRecord(styles)) return value({ path: `${path}.placeholderStyles`, verdict: "wrongType" });
    for (const role of PLACEHOLDER_ROLES) {
      const style = styles[role];
      if (!isRecord(style)) return value({ path: `${path}.placeholderStyles.${role}`, verdict: "wrongType" });
      const rejection =
        value({ path: `${path}.placeholderStyles.${role}.run`, verdict: checkStylePatch(style["run"], RUN_ATTRIBUTE_CHECKS) }) ??
        value({ path: `${path}.placeholderStyles.${role}.paragraph`, verdict: checkStylePatch(style["paragraph"], PARAGRAPH_ATTRIBUTE_CHECKS) }) ??
        value({ path: `${path}.placeholderStyles.${role}.textBox`, verdict: checkTextBoxPatch(style["textBox"]) });
      if (rejection !== null) return rejection;
    }
  }
  if (patch.defaultRunStyle !== undefined) {
    const style: unknown = patch.defaultRunStyle;
    if (!isRecord(style)) return value({ path: `${path}.defaultRunStyle`, verdict: "wrongType" });
    for (const name of RUN_ATTRIBUTE_NAMES) {
      if (RUN_ATTRIBUTE_CHECKS[name](style[name]) !== "valid") return value({ path: `${path}.defaultRunStyle.${name}`, verdict: "wrongType" });
    }
  }
  return null;
}

const HEXADECIMAL_PATTERN = /^#[0-9a-fA-F]{6}$/;
const AUTOMATIC_TEXT_FIELDS: readonly string[] = ["slideNumber"];

function checkTextBoxPatch(candidate: unknown): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  for (const [key, field] of Object.entries(candidate)) {
    const verdict = checkTextBoxField(key, field);
    if (verdict !== "valid") return verdict;
  }
  return "valid";
}

function validateScriptUpsert(
  options: Readonly<{ prospect: Prospect; command: Extract<DocumentCommand, { kind: "upsertTransitionScript" }>; path: string; author: CommandAuthor }>,
): CommandRejection | null {
  const { prospect, command, path } = options;
  const draft = command.script;
  if (!isObjectId(draft.id)) return { reason: "invalidId", id: draft.id };
  for (const field of ["name", "description", "script", "stylesheet", "markup"] as const) {
    if (typeof draft[field] !== "string") return value({ path: `${path}.script.${field}`, verdict: "wrongType" });
  }
  if (!isRecord(draft.defaultParameters) || checkSerialisable(draft.defaultParameters) !== "valid") {
    return value({ path: `${path}.script.defaultParameters`, verdict: "wrongType" });
  }
  const purposeRejection = checked({ path: `${path}.script.purpose`, candidate: draft.purpose, kind: SCRIPT_PURPOSE });
  if (purposeRejection !== null) return purposeRejection;
  const current = prospect.script(draft.id);
  if (current === null && command.basedOnUpdatedAt !== null) return { reason: "transitionScriptMissing", scriptId: draft.id };
  if (current !== null && command.basedOnUpdatedAt !== current.updatedAt) {
    return { reason: "staleScript", scriptId: draft.id, basedOnUpdatedAt: command.basedOnUpdatedAt, currentUpdatedAt: current.updatedAt };
  }
  // The stamp is the store's to choose; any value newer than every earlier save keeps later checks right.
  prospect.recordScript(draft.id, { updatedAt: Number.NaN, fingerprint: scriptFingerprint(draft), purpose: draft.purpose });
  return null;
}

function validateSlideInsert(
  options: Readonly<{ prospect: Prospect; slides: readonly SlideSnapshot[]; after: SlideId | null; path: string }>,
): CommandRejection | null {
  const { prospect, path } = options;
  if (options.after !== null && !prospect.slideExists(options.after)) return { reason: "slideMissing", slideId: options.after };
  const seenSlides = new Set<string>();
  for (const [index, slide] of options.slides.entries()) {
    const slidePath = `${path}.slides.${index}`;
    if (!isObjectId(slide.id)) return { reason: "invalidId", id: slide.id };
    if (seenSlides.has(slide.id) || prospect.slideExists(slide.id)) return { reason: "duplicateId", id: slide.id };
    seenSlides.add(slide.id);
    if (slide.layoutId !== null && !prospect.layoutExists(slide.layoutId)) return { reason: "layoutMissing", layoutId: slide.layoutId };
    const rejection =
      value({ path: `${slidePath}.background`, verdict: OPTIONAL_FILL.check(slide.background) }) ??
      value({ path: `${slidePath}.skipped`, verdict: checkBoolean(slide.skipped) }) ??
      value({ path: `${slidePath}.transition`, verdict: SLIDE_TRANSITION.check(slide.transition) }) ??
      validateBody({ body: slide.speakerNotes, path: `${slidePath}.speakerNotes` });
    if (rejection !== null) return rejection;
    prospect.recordSlide(slide.id, true);
    const treeRejection = validateTrees({ prospect, slideId: slide.id, elements: slide.elements, path: `${slidePath}.elements`, seen: new Set() });
    if (treeRejection !== null) return treeRejection;
    prospect.recordTextLength({ kind: "speakerNotes", slideId: slide.id }, textBodyLength(slide.speakerNotes));
    recordTrees({ prospect, slideId: slide.id, elements: slide.elements, parent: null });
    const stepRejection = validateNewSteps({ prospect, slideId: slide.id, steps: slide.animations, path: `${slidePath}.animations` });
    if (stepRejection !== null) return stepRejection;
  }
  return null;
}

function validateElementInsert(
  options: Readonly<{ prospect: Prospect; command: Extract<DocumentCommand, { kind: "insertElements" }>; path: string }>,
): CommandRejection | null {
  const { prospect, command, path } = options;
  if (!prospect.slideExists(command.slideId)) return { reason: "slideMissing", slideId: command.slideId };
  const placement = command.placement;
  let parent: ElementId | null = null;
  switch (placement.kind) {
    case "front":
    case "back":
      break;
    case "above": {
      const anchor = prospect.element(command.slideId, placement.elementId);
      if (anchor === null) return elementMissing({ prospect, slideId: command.slideId, elementId: placement.elementId });
      parent = anchor.parent;
      break;
    }
    case "insideGroup": {
      const group = prospect.element(command.slideId, placement.groupId);
      if (group === null) return elementMissing({ prospect, slideId: command.slideId, elementId: placement.groupId });
      if (group.kind !== "group") return { reason: "wrongKind", elementId: placement.groupId, expected: "group", actual: group.kind };
      parent = placement.groupId;
      break;
    }
    default:
      return assertNever(placement);
  }
  const rejection = validateTrees({ prospect, slideId: command.slideId, elements: command.elements, path: `${path}.elements`, seen: new Set() });
  if (rejection !== null) return rejection;
  recordTrees({ prospect, slideId: command.slideId, elements: command.elements, parent });
  return null;
}

/** Check element trees: ids, kinds and every stored value (`slideId` null for a layout's trees). */
function validateTrees(
  options: Readonly<{ prospect: Prospect; slideId: SlideId | null; elements: readonly ElementSnapshot[]; path: string; seen: Set<string> }>,
): CommandRejection | null {
  const { prospect, slideId, seen } = options;
  for (const [index, element] of options.elements.entries()) {
    const path = `${options.path}.${index}`;
    if (!isObjectId(element.id)) return { reason: "invalidId", id: element.id };
    if (seen.has(element.id) || (slideId !== null && prospect.element(slideId, element.id) !== null)) return { reason: "duplicateId", id: element.id };
    seen.add(element.id);
    const rejection =
      value({ path: `${path}.name`, verdict: checkString(element.name) }) ??
      value({ path: `${path}.description`, verdict: checkString(element.description) }) ??
      value({ path: `${path}.morphKey`, verdict: checkString(element.morphKey) }) ??
      checked({ path: `${path}.placeholder`, candidate: element.placeholder, kind: PLACEHOLDER }) ??
      validateElementValues({ prospect, element, path, slideId, seen });
    if (rejection !== null) return rejection;
  }
  return null;
}

function validateElementValues(
  options: Readonly<{ prospect: Prospect; element: ElementSnapshot; path: string; slideId: SlideId | null; seen: Set<string> }>,
): CommandRejection | null {
  const { prospect, element, path } = options;
  switch (element.kind) {
    case "shape":
      return (
        value({ path: `${path}.frame`, verdict: checkFrame(element.frame) }) ??
        validateBox({ box: element.box, path: `${path}.box` }) ??
        checked({ path: `${path}.preset`, candidate: element.preset, kind: SHAPE_PRESET }) ??
        // Optional: an insert from a client older than freeforms carries no such field.
        optionalChecked({ path: `${path}.customOutline`, candidate: element.customOutline, kind: CUSTOM_OUTLINE }) ??
        value({ path: `${path}.textBox`, verdict: checkTextBoxStyle(element.textBox) }) ??
        validateBody({ body: element.text, path: `${path}.text` })
      );
    case "image":
      if (!prospect.assetExists(element.assetId)) return { reason: "assetMissing", assetId: element.assetId };
      return (
        value({ path: `${path}.frame`, verdict: checkFrame(element.frame) }) ??
        validateBox({ box: element.box, path: `${path}.box` }) ??
        checked({ path: `${path}.crop`, candidate: element.crop, kind: IMAGE_CROP })
      );
    case "line":
      return (
        value({ path: `${path}.start`, verdict: checkPoint(element.start) }) ??
        value({ path: `${path}.end`, verdict: checkPoint(element.end) }) ??
        checked({ path: `${path}.routing`, candidate: element.routing, kind: LINE_ROUTING }) ??
        checked({ path: `${path}.stroke`, candidate: element.stroke, kind: STROKE }) ??
        checked({ path: `${path}.startArrow`, candidate: element.startArrow, kind: ARROW_HEAD }) ??
        checked({ path: `${path}.endArrow`, candidate: element.endArrow, kind: ARROW_HEAD }) ??
        checked({ path: `${path}.opacity`, candidate: element.opacity, kind: OPACITY })
      );
    case "table":
      return validateTable({ table: element, path });
    case "group":
      if (element.children.length === 0) return { reason: "invalidValue", path: `${path}.children`, message: "a group needs at least one child" };
      return (
        value({ path: `${path}.frame.rotation`, verdict: checkNumber(element.frame.rotation) }) ??
        validateTrees({ prospect, slideId: options.slideId, elements: element.children, path: `${path}.children`, seen: options.seen })
      );
    case "unsupported":
      return { reason: "invalidValue", path: `${path}.kind`, message: "an element of an unsupported kind cannot be inserted" };
    default:
      return assertNever(element);
  }
}

function validateBox(options: Readonly<{ box: Extract<ElementSnapshot, { kind: "shape" }>["box"]; path: string }>): CommandRejection | null {
  const { box, path } = options;
  return (
    checked({ path: `${path}.fill`, candidate: box.fill, kind: FILL }) ??
    checked({ path: `${path}.border`, candidate: box.border, kind: BORDER }) ??
    checked({ path: `${path}.cornerRadius`, candidate: box.cornerRadius, kind: CORNER_RADIUS }) ??
    checked({ path: `${path}.shadow`, candidate: box.shadow, kind: SHADOW }) ??
    checked({ path: `${path}.opacity`, candidate: box.opacity, kind: OPACITY })
  );
}

function validateTable(options: Readonly<{ table: Extract<ElementSnapshot, { kind: "table" }>; path: string }>): CommandRejection | null {
  const { table, path } = options;
  const frameRejection = value({ path: `${path}.frame`, verdict: checkFrame(table.frame) }) ?? checked({ path: `${path}.opacity`, candidate: table.opacity, kind: OPACITY });
  if (frameRejection !== null) return frameRejection;
  const rows = new Set<string>();
  for (const [index, row] of table.rows.entries()) {
    if (!isObjectId(row.id)) return { reason: "invalidId", id: row.id };
    if (rows.has(row.id)) return { reason: "duplicateId", id: row.id };
    rows.add(row.id);
    const rejection = value({ path: `${path}.rows.${index}.minimumHeight`, verdict: checkPositive(row.minimumHeight) });
    if (rejection !== null) return rejection;
  }
  const columns = new Set<string>();
  for (const [index, column] of table.columns.entries()) {
    if (!isObjectId(column.id)) return { reason: "invalidId", id: column.id };
    if (columns.has(column.id)) return { reason: "duplicateId", id: column.id };
    columns.add(column.id);
    const rejection = value({ path: `${path}.columns.${index}.width`, verdict: checkPositive(column.width) });
    if (rejection !== null) return rejection;
  }
  if (rows.size === 0 || columns.size === 0) return { reason: "invalidValue", path: `${path}.rows`, message: "a table needs at least one row and one column" };
  for (const [index, cell] of table.cells.entries()) {
    const cellPath = `${path}.cells.${index}`;
    if (!rows.has(cell.rowId)) return { reason: "tableLineMissing", elementId: table.id, id: cell.rowId };
    if (!columns.has(cell.columnId)) return { reason: "tableLineMissing", elementId: table.id, id: cell.columnId };
    const rejection =
      checked({ path: `${cellPath}.fill`, candidate: cell.fill, kind: FILL }) ??
      checked({ path: `${cellPath}.borders`, candidate: cell.borders, kind: CELL_BORDERS }) ??
      value({ path: `${cellPath}.textBox`, verdict: checkTextBoxStyle(cell.textBox) }) ??
      validateBody({ body: cell.text, path: `${cellPath}.text` });
    if (rejection !== null) return rejection;
  }
  return null;
}

function validateBody(options: Readonly<{ body: TextBody; path: string }>): CommandRejection | null {
  const { body, path } = options;
  if (body.paragraphs.length === 0) {
    return { reason: "invalidValue", path: `${path}.paragraphs`, message: "a text body has at least one paragraph" };
  }
  for (const [index, paragraph] of body.paragraphs.entries()) {
    const paragraphPath = `${path}.paragraphs.${index}`;
    const rejection = value({ path: `${paragraphPath}.style`, verdict: checkStylePatch(paragraph.style, PARAGRAPH_ATTRIBUTE_CHECKS) });
    if (rejection !== null) return rejection;
    for (const [runIndex, run] of paragraph.runs.entries()) {
      const runPath = `${paragraphPath}.runs.${runIndex}`;
      const styleRejection = value({ path: `${runPath}.style`, verdict: checkStylePatch(run.style, RUN_ATTRIBUTE_CHECKS) });
      if (styleRejection !== null) return styleRejection;
      switch (run.kind) {
        case "text":
          if (checkString(run.text) !== "valid" || run.text.includes("\n")) return { reason: "invalidValue", path: `${runPath}.text`, message: "a run holds text without paragraph marks" };
          break;
        case "automaticText":
          if (!AUTOMATIC_TEXT_FIELDS.includes(run.field)) return value({ path: `${runPath}.field`, verdict: "unsupported" });
          break;
        default:
          return assertNever(run);
      }
    }
  }
  return null;
}

/** Record inserted trees in the prospect: kinds, parents, text lengths and table lines. */
function recordTrees(options: Readonly<{ prospect: Prospect; slideId: SlideId; elements: readonly ElementSnapshot[]; parent: ElementId | null }>): void {
  const { prospect, slideId } = options;
  for (const element of options.elements) {
    prospect.recordElement(slideId, element.id, { kind: element.kind, parent: options.parent });
    switch (element.kind) {
      case "shape":
        prospect.recordTextLength({ kind: "element", slideId, elementId: element.id }, textBodyLength(element.text));
        break;
      case "table":
        prospect.recordTableLines(slideId, element.id, { rows: element.rows.map((row) => row.id), columns: element.columns.map((column) => column.id) });
        for (const cell of element.cells) {
          prospect.recordTextLength({ kind: "tableCell", slideId, elementId: element.id, cell: { rowId: cell.rowId, columnId: cell.columnId } }, textBodyLength(cell.text));
        }
        break;
      case "group":
        recordTrees({ prospect, slideId, elements: element.children, parent: element.id });
        break;
      case "image":
      case "line":
      case "unsupported":
        break;
      default:
        assertNever(element);
    }
  }
}

function validateFrames(options: Readonly<{ prospect: Prospect; command: Extract<DocumentCommand, { kind: "setFrames" }>; path: string }>): CommandRejection | null {
  const { prospect, command, path } = options;
  for (const [index, update] of command.frames.entries()) {
    const element = prospect.element(command.slideId, update.elementId);
    if (element === null) return elementMissing({ prospect, slideId: command.slideId, elementId: update.elementId });
    const updatePath = `${path}.frames.${index}`;
    switch (update.kind) {
      case "box": {
        if (element.kind !== "shape" && element.kind !== "image" && element.kind !== "table") {
          return { reason: "wrongKind", elementId: update.elementId, expected: "shape, image or table", actual: element.kind };
        }
        const rejection = value({ path: `${updatePath}.frame`, verdict: checkFrame(update.frame) });
        if (rejection !== null) return rejection;
        break;
      }
      case "line": {
        if (element.kind !== "line") return { reason: "wrongKind", elementId: update.elementId, expected: "line", actual: element.kind };
        const rejection = value({ path: `${updatePath}.start`, verdict: checkPoint(update.start) }) ?? value({ path: `${updatePath}.end`, verdict: checkPoint(update.end) });
        if (rejection !== null) return rejection;
        break;
      }
      case "groupRotation": {
        if (element.kind !== "group") return { reason: "wrongKind", elementId: update.elementId, expected: "group", actual: element.kind };
        const rejection = value({ path: `${updatePath}.rotation`, verdict: checkNumber(update.rotation) });
        if (rejection !== null) return rejection;
        break;
      }
      default:
        return assertNever(update);
    }
  }
  return null;
}

function validateElementPatch(options: Readonly<{ prospect: Prospect; patch: ElementPatch; path: string }>): CommandRejection | null {
  const { prospect, patch, path } = options;
  if (patch.assetId !== undefined && !prospect.assetExists(patch.assetId)) return { reason: "assetMissing", assetId: patch.assetId };
  return (
    (patch.name === undefined ? null : value({ path: `${path}.name`, verdict: checkString(patch.name) })) ??
    (patch.description === undefined ? null : value({ path: `${path}.description`, verdict: checkString(patch.description) })) ??
    (patch.morphKey === undefined ? null : value({ path: `${path}.morphKey`, verdict: checkString(patch.morphKey) })) ??
    optionalChecked({ path: `${path}.fill`, candidate: patch.fill, kind: FILL }) ??
    optionalChecked({ path: `${path}.border`, candidate: patch.border, kind: BORDER }) ??
    optionalChecked({ path: `${path}.cornerRadius`, candidate: patch.cornerRadius, kind: CORNER_RADIUS }) ??
    optionalChecked({ path: `${path}.shadow`, candidate: patch.shadow, kind: SHADOW }) ??
    optionalChecked({ path: `${path}.opacity`, candidate: patch.opacity, kind: OPACITY }) ??
    (patch.textBox === undefined ? null : value({ path: `${path}.textBox`, verdict: checkTextBoxStyle(patch.textBox) })) ??
    optionalChecked({ path: `${path}.preset`, candidate: patch.preset, kind: SHAPE_PRESET }) ??
    optionalChecked({ path: `${path}.crop`, candidate: patch.crop, kind: IMAGE_CROP }) ??
    optionalChecked({ path: `${path}.stroke`, candidate: patch.stroke, kind: STROKE }) ??
    optionalChecked({ path: `${path}.startArrow`, candidate: patch.startArrow, kind: ARROW_HEAD }) ??
    optionalChecked({ path: `${path}.endArrow`, candidate: patch.endArrow, kind: ARROW_HEAD }) ??
    optionalChecked({ path: `${path}.routing`, candidate: patch.routing, kind: LINE_ROUTING })
  );
}

function optionalChecked<TValue>(options: Readonly<{ path: string; candidate: unknown; kind: StoredValueCheck<TValue> }>): CommandRejection | null {
  return options.candidate === undefined ? null : checked(options);
}

function validateGroup(options: Readonly<{ prospect: Prospect; command: Extract<DocumentCommand, { kind: "groupElements" }>; path: string }>): CommandRejection | null {
  const { prospect, command, path } = options;
  const { slideId, groupId } = command;
  if (!prospect.slideExists(slideId)) return { reason: "slideMissing", slideId };
  if (!isObjectId(groupId)) return { reason: "invalidId", id: groupId };
  if (prospect.element(slideId, groupId) !== null) return { reason: "duplicateId", id: groupId };
  const members = [...new Set(command.elementIds)];
  if (members.length < 2) return { reason: "invalidValue", path: `${path}.elementIds`, message: "grouping needs at least two elements" };
  let parent: ElementId | null | undefined;
  for (const elementId of members) {
    const member = prospect.element(slideId, elementId);
    if (member === null) return elementMissing({ prospect, slideId, elementId });
    if (parent === undefined) parent = member.parent;
    if (member.parent !== parent) return { reason: "invalidValue", path: `${path}.elementIds`, message: "grouped elements must share their group" };
  }
  // The new group sits where its members are; a member that is an ancestor of that place would loop.
  const visited = new Set<ElementId>();
  let ancestor = parent ?? null;
  while (ancestor !== null && !visited.has(ancestor)) {
    if (members.includes(ancestor)) return { reason: "groupCycle", groupId };
    visited.add(ancestor);
    ancestor = prospect.element(slideId, ancestor)?.parent ?? null;
  }
  prospect.recordElement(slideId, groupId, { kind: "group", parent: parent ?? null });
  for (const elementId of members) {
    const member = prospect.element(slideId, elementId);
    if (member !== null) prospect.recordElement(slideId, elementId, { kind: member.kind, parent: groupId });
  }
  return null;
}

function validateTextEdit(
  options: Readonly<{ prospect: Prospect; target: TextTarget; operations: readonly TextOperation[]; basedOnRevision: number; revision: number; path: string }>,
): CommandRejection | null {
  const { prospect, target, path } = options;
  const targetRejection = textTargetRejection({ prospect, target });
  if (targetRejection !== null) return targetRejection;
  if (options.basedOnRevision !== options.revision) return { reason: "staleText", basedOnRevision: options.basedOnRevision, currentRevision: options.revision };
  let length = prospect.textLength(target);
  if (length === null) return { reason: "invalidValue", path: `${path}.target`, message: "this text body does not exist" };
  for (const [index, operation] of options.operations.entries()) {
    const operationPath = `${path}.operations.${index}`;
    const rejection = validateTextOperation({ operation, length, path: operationPath });
    if (rejection !== null) return rejection;
    length += lengthChange(operation);
  }
  prospect.recordTextLength(target, length);
  return null;
}

function textTargetRejection(options: Readonly<{ prospect: Prospect; target: TextTarget }>): CommandRejection | null {
  const { prospect, target } = options;
  if (!prospect.slideExists(target.slideId)) return { reason: "slideMissing", slideId: target.slideId };
  switch (target.kind) {
    case "speakerNotes":
      return null;
    case "element": {
      const element = prospect.element(target.slideId, target.elementId);
      if (element === null) return { reason: "elementMissing", slideId: target.slideId, elementId: target.elementId };
      return element.kind === "shape" ? null : { reason: "wrongKind", elementId: target.elementId, expected: "shape", actual: element.kind };
    }
    case "tableCell": {
      const element = prospect.element(target.slideId, target.elementId);
      if (element === null) return { reason: "elementMissing", slideId: target.slideId, elementId: target.elementId };
      if (element.kind !== "table") return { reason: "wrongKind", elementId: target.elementId, expected: "table", actual: element.kind };
      const lines = prospect.tableLines(target.slideId, target.elementId);
      if (lines === null || !lines.rows.includes(target.cell.rowId)) return { reason: "tableLineMissing", elementId: target.elementId, id: target.cell.rowId };
      if (!lines.columns.includes(target.cell.columnId)) return { reason: "tableLineMissing", elementId: target.elementId, id: target.cell.columnId };
      return null;
    }
    default:
      return assertNever(target);
  }
}

/** The final paragraph mark is never deleted and nothing is inserted after it (every body ends with "\n"). */
function validateTextOperation(options: Readonly<{ operation: TextOperation; length: number; path: string }>): CommandRejection | null {
  const { operation, length, path } = options;
  const outOfRange = (index: number, span: number, limit: number): CommandRejection | null =>
    Number.isInteger(index) && Number.isInteger(span) && index >= 0 && span >= 0 && index + span <= limit ? null : { reason: "textOutOfRange", index, length: span, bodyLength: length };
  switch (operation.kind) {
    case "insert":
      return outOfRange(operation.index, 0, length - 1) ?? value({ path: `${path}.text`, verdict: checkString(operation.text) }) ?? value({ path: `${path}.style`, verdict: checkStylePatch(operation.style, RUN_ATTRIBUTE_CHECKS) });
    case "insertAutomaticText":
      return outOfRange(operation.index, 0, length - 1) ?? (AUTOMATIC_TEXT_FIELDS.includes(operation.field) ? null : value({ path: `${path}.field`, verdict: "unsupported" })) ?? value({ path: `${path}.style`, verdict: checkStylePatch(operation.style, RUN_ATTRIBUTE_CHECKS) });
    case "delete":
      return outOfRange(operation.index, operation.length, length - 1);
    case "formatRuns":
      return (
        outOfRange(operation.index, operation.length, length) ??
        value({ path: `${path}.patch`, verdict: checkStylePatch(operation.patch, RUN_ATTRIBUTE_CHECKS) }) ??
        value({ path: `${path}.clear`, verdict: operation.clear.every((name) => (RUN_ATTRIBUTE_NAMES as readonly string[]).includes(name)) ? "valid" : "wrongType" })
      );
    case "formatParagraphs":
      return (
        outOfRange(operation.index, operation.length, length) ??
        value({ path: `${path}.patch`, verdict: checkStylePatch(operation.patch, PARAGRAPH_ATTRIBUTE_CHECKS) }) ??
        value({ path: `${path}.clear`, verdict: operation.clear.every((name) => (PARAGRAPH_ATTRIBUTE_NAMES as readonly string[]).includes(name)) ? "valid" : "wrongType" })
      );
    default:
      return assertNever(operation);
  }
}

function lengthChange(operation: TextOperation): number {
  switch (operation.kind) {
    case "insert":
      return operation.text.length;
    case "insertAutomaticText":
      return 1;
    case "delete":
      return -operation.length;
    case "formatRuns":
    case "formatParagraphs":
      return 0;
    default:
      return assertNever(operation);
  }
}

type TableCommand = Extract<
  DocumentCommand,
  { kind: "insertTableRows" | "insertTableColumns" | "deleteTableRows" | "deleteTableColumns" | "setTableColumnWidths" | "setTableRowHeights" | "updateTableCells" }
>;

function validateTableCommand(options: Readonly<{ prospect: Prospect; command: TableCommand; path: string }>): CommandRejection | null {
  const { prospect, command, path } = options;
  const table = prospect.element(command.slideId, command.elementId);
  if (table === null) return elementMissing({ prospect, slideId: command.slideId, elementId: command.elementId });
  if (table.kind !== "table") return { reason: "wrongKind", elementId: command.elementId, expected: "table", actual: table.kind };
  const lines = prospect.tableLines(command.slideId, command.elementId) ?? { rows: [], columns: [] };
  const missing = (id: string): CommandRejection => ({ reason: "tableLineMissing", elementId: command.elementId, id });
  switch (command.kind) {
    case "insertTableRows":
    case "insertTableColumns": {
      const inserts = command.kind === "insertTableRows" ? command.rows : command.columns;
      const current = [...(command.kind === "insertTableRows" ? lines.rows : lines.columns)];
      for (const [index, insert] of inserts.entries()) {
        if (!isObjectId(insert.id)) return { reason: "invalidId", id: insert.id };
        if (current.includes(insert.id)) return { reason: "duplicateId", id: insert.id };
        if (insert.after !== null && !current.includes(insert.after)) return missing(insert.after);
        const rejection = value({ path: `${path}.${command.kind === "insertTableRows" ? "rows" : "columns"}.${index}.size`, verdict: checkPositive(insert.size) });
        if (rejection !== null) return rejection;
        current.splice(insert.after === null ? 0 : current.indexOf(insert.after) + 1, 0, insert.id);
      }
      prospect.recordTableLines(command.slideId, command.elementId, command.kind === "insertTableRows" ? { rows: current, columns: lines.columns } : { rows: lines.rows, columns: current });
      return null;
    }
    case "deleteTableRows":
    case "deleteTableColumns": {
      const ids: readonly string[] = command.kind === "deleteTableRows" ? command.rowIds : command.columnIds;
      const current = command.kind === "deleteTableRows" ? lines.rows : lines.columns;
      for (const id of ids) {
        if (!current.includes(id)) return missing(id);
      }
      const remaining = current.filter((id) => !ids.includes(id));
      if (remaining.length === 0) return { reason: "invalidValue", path: `${path}.${command.kind === "deleteTableRows" ? "rowIds" : "columnIds"}`, message: "a table keeps at least one row and one column" };
      prospect.recordTableLines(command.slideId, command.elementId, command.kind === "deleteTableRows" ? { rows: remaining, columns: lines.columns } : { rows: lines.rows, columns: remaining });
      return null;
    }
    case "setTableColumnWidths":
      for (const [index, width] of command.widths.entries()) {
        if (!lines.columns.includes(width.columnId)) return missing(width.columnId);
        const rejection = value({ path: `${path}.widths.${index}.width`, verdict: checkPositive(width.width) });
        if (rejection !== null) return rejection;
      }
      return null;
    case "setTableRowHeights":
      for (const [index, height] of command.heights.entries()) {
        if (!lines.rows.includes(height.rowId)) return missing(height.rowId);
        const rejection = value({ path: `${path}.heights.${index}.minimumHeight`, verdict: checkPositive(height.minimumHeight) });
        if (rejection !== null) return rejection;
      }
      return null;
    case "updateTableCells": {
      for (const cell of command.cells) {
        if (!lines.rows.includes(cell.rowId)) return missing(cell.rowId);
        if (!lines.columns.includes(cell.columnId)) return missing(cell.columnId);
      }
      const patch = command.patch;
      if (patch.borders !== undefined) {
        for (const [side, stroke] of Object.entries(patch.borders)) {
          if (!["top", "right", "bottom", "left"].includes(side)) return value({ path: `${path}.patch.borders.${side}`, verdict: "unsupported" });
          if (stroke !== null && stroke !== undefined) {
            const rejection = checked({ path: `${path}.patch.borders.${side}`, candidate: stroke, kind: STROKE });
            if (rejection !== null) return rejection;
          }
        }
      }
      return (
        optionalChecked({ path: `${path}.patch.fill`, candidate: patch.fill, kind: FILL }) ??
        (patch.textBox === undefined ? null : value({ path: `${path}.patch.textBox`, verdict: checkTextBoxStyle(patch.textBox) }))
      );
    }
    default:
      return assertNever(command);
  }
}

type AnimationCommand = Extract<DocumentCommand, { kind: "insertAnimationSteps" | "updateAnimationSteps" | "moveAnimationSteps" | "deleteAnimationSteps" }>;

function validateAnimationCommand(options: Readonly<{ prospect: Prospect; command: AnimationCommand; path: string }>): CommandRejection | null {
  const { prospect, command, path } = options;
  if (!prospect.slideExists(command.slideId)) return { reason: "slideMissing", slideId: command.slideId };
  const existing = prospect.steps(command.slideId);
  switch (command.kind) {
    case "insertAnimationSteps":
      if (command.after !== null && !existing.has(command.after)) return { reason: "animationStepMissing", slideId: command.slideId, stepId: command.after };
      return validateNewSteps({ prospect, slideId: command.slideId, steps: command.steps, path: `${path}.steps` });
    case "updateAnimationSteps": {
      const missing = stepMissing({ slideId: command.slideId, stepIds: command.stepIds, existing });
      if (missing !== null) return missing;
      const rejection = validateStepPatch({ prospect, slideId: command.slideId, patch: command.patch, path: `${path}.patch` });
      if (rejection !== null) return rejection;
      const target = command.patch.elementId;
      if (target !== undefined) for (const stepId of command.stepIds) prospect.recordStep(command.slideId, stepId, target);
      return null;
    }
    case "moveAnimationSteps": {
      const missing = stepMissing({ slideId: command.slideId, stepIds: command.stepIds, existing });
      if (missing !== null) return missing;
      if (command.after !== null && !existing.has(command.after)) return { reason: "animationStepMissing", slideId: command.slideId, stepId: command.after };
      if (command.after !== null && command.stepIds.includes(command.after)) {
        return { reason: "invalidValue", path: `${path}.after`, message: "a step cannot move after itself" };
      }
      return null;
    }
    case "deleteAnimationSteps": {
      const missing = stepMissing({ slideId: command.slideId, stepIds: command.stepIds, existing });
      if (missing !== null) return missing;
      for (const stepId of command.stepIds) prospect.recordStep(command.slideId, stepId, null);
      return null;
    }
    default:
      return assertNever(command);
  }
}

function stepMissing(options: Readonly<{ slideId: SlideId; stepIds: readonly AnimationStepId[]; existing: ReadonlyMap<AnimationStepId, ElementId> }>): CommandRejection | null {
  const stepId = options.stepIds.find((candidate) => !options.existing.has(candidate));
  return stepId === undefined ? null : { reason: "animationStepMissing", slideId: options.slideId, stepId };
}

/** New steps: fresh ids, an element of the slide, valid values, and the slide's sequence within its limit. */
function validateNewSteps(options: Readonly<{ prospect: Prospect; slideId: SlideId; steps: readonly AnimationStep[]; path: string }>): CommandRejection | null {
  const { prospect, slideId, path } = options;
  const existing = prospect.steps(slideId);
  if (existing.size + options.steps.length > ANIMATION_LIMITS.maximumStepsPerSlide) {
    return { reason: "invalidValue", path, message: `a slide holds at most ${ANIMATION_LIMITS.maximumStepsPerSlide} build steps` };
  }
  const seen = new Set<string>();
  for (const [index, step] of options.steps.entries()) {
    if (!isObjectId(step.id)) return { reason: "invalidId", id: step.id };
    if (seen.has(step.id) || existing.has(step.id)) return { reason: "duplicateId", id: step.id };
    seen.add(step.id);
    const rejection = validateStepPatch({
      prospect,
      slideId,
      patch: { elementId: step.elementId, effect: step.effect, trigger: step.trigger, durationMilliseconds: step.durationMilliseconds, delayMilliseconds: step.delayMilliseconds, easing: step.easing },
      path: `${path}.${index}`,
    });
    if (rejection !== null) return rejection;
  }
  for (const step of options.steps) prospect.recordStep(slideId, step.id, step.elementId);
  return null;
}

function validateStepPatch(options: Readonly<{ prospect: Prospect; slideId: SlideId; patch: AnimationStepPatch; path: string }>): CommandRejection | null {
  const { prospect, slideId, patch, path } = options;
  if (patch.elementId !== undefined && prospect.element(slideId, patch.elementId) === null) return elementMissing({ prospect, slideId, elementId: patch.elementId });
  return (
    (patch.effect === undefined ? null : validateEffect({ prospect, effect: patch.effect, path: `${path}.effect` })) ??
    optionalChecked({ path: `${path}.trigger`, candidate: patch.trigger, kind: ANIMATION_TRIGGER }) ??
    optionalChecked({ path: `${path}.easing`, candidate: patch.easing, kind: TRANSITION_EASING }) ??
    withinLimit({ path: `${path}.durationMilliseconds`, candidate: patch.durationMilliseconds, minimum: 0, maximum: ANIMATION_LIMITS.maximumDurationMilliseconds }) ??
    withinLimit({ path: `${path}.delayMilliseconds`, candidate: patch.delayMilliseconds, minimum: 0, maximum: ANIMATION_LIMITS.maximumDelayMilliseconds })
  );
}

/** The stored shape, then the command-only ranges (stored-values.ts `ANIMATION_EFFECT`), then a scripted step's script. */
function validateEffect(options: Readonly<{ prospect: Prospect; effect: AnimationEffect; path: string }>): CommandRejection | null {
  const { effect, path } = options;
  const shape = checked({ path, candidate: effect, kind: ANIMATION_EFFECT });
  if (shape !== null) return shape;
  switch (effect.kind) {
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
      return null;
    case "growShrink":
      return withinLimit({ path: `${path}.scale`, candidate: effect.scale, minimum: ANIMATION_LIMITS.minimumScale, maximum: ANIMATION_LIMITS.maximumScale });
    case "spin":
      return withinLimit({ path: `${path}.degrees`, candidate: effect.degrees, minimum: -ANIMATION_LIMITS.maximumSpinDegrees, maximum: ANIMATION_LIMITS.maximumSpinDegrees });
    case "motionPath":
      return (
        withinLimit({ path: `${path}.offsetX`, candidate: effect.offsetX, minimum: -ANIMATION_LIMITS.maximumMotionOffset, maximum: ANIMATION_LIMITS.maximumMotionOffset }) ??
        withinLimit({ path: `${path}.offsetY`, candidate: effect.offsetY, minimum: -ANIMATION_LIMITS.maximumMotionOffset, maximum: ANIMATION_LIMITS.maximumMotionOffset })
      );
    case "scripted": {
      const script = options.prospect.script(effect.scriptId);
      if (script === null) return { reason: "transitionScriptMissing", scriptId: effect.scriptId };
      if (script.purpose !== "animation") return { reason: "invalidValue", path: `${path}.scriptId`, message: "a scripted build step names an animation script, not a transition" };
      return null;
    }
    default:
      return assertNever(effect);
  }
}

function withinLimit(options: Readonly<{ path: string; candidate: number | undefined; minimum: number; maximum: number }>): CommandRejection | null {
  const candidate = options.candidate;
  if (candidate === undefined) return null;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return value({ path: options.path, verdict: "wrongType" });
  if (candidate < options.minimum || candidate > options.maximum) {
    return { reason: "invalidValue", path: options.path, message: `between ${options.minimum} and ${options.maximum}` };
  }
  return null;
}
