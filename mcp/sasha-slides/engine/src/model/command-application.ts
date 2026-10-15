// WRITING ONE VALIDATED COMMAND into the Y.Doc, inside the envelope's transaction
// (document-store.ts). Validation already passed for the whole envelope (command-validation.ts),
// so every write here can assume its targets exist.
//
// The ordering rules live here:
//  * new items get keys minted in their gap (`planGapKeys`), with the random suffix from the
//    store's injected random source; a broken gap re-keys only the neighbours it must;
//  * the new group takes the front-most member's key, and its members are re-keyed among
//    themselves in their display order (commands.ts `groupElements`);
//  * ungrouping, and a group dissolved because a delete left it with one child, re-key the children
//    in order into the group's place among its siblings (yjs-schema.ts "GROUPS ARE A POINTER");
//  * elements shown in front because their group is missing (element-tree.ts "displaced") are
//    re-keyed to where they are shown before anything is inserted next to them, so the stored
//    order and the shown order agree again;
//  * build steps are ordered like slides (`planGapKeys` in the slide's `animations` map), and a
//    command that removes elements -- a delete, an ungroup, a group tidied away -- removes the steps
//    of every element it removed in the same transaction, so one undo restores both.

import * as Y from "yjs";
import type { CommandAuthor, DocumentCommand, ElementPatch, TableCellPatch, TransitionScriptSaveApproval, TransitionScriptDraft } from "../contracts/commands.ts";
import type { TransitionApproval } from "../contracts/document.ts";
import type { AnimationStepPatch } from "../contracts/animations.ts";
import type { ElementId, RandomSource, SlideId, TableColumnId, TableRowId } from "../contracts/ids.ts";
import type { StoredElementKind } from "../contracts/yjs-schema.ts";
import { assertNever } from "../contracts/assert-never.ts";
import { transitionAuthorOf } from "../contracts/commands.ts";
import { scriptFingerprint } from "../contracts/document.ts";
import { MINIMUM_FRAME_SIZE, normaliseRotation } from "../contracts/geometry.ts";
import { ANIMATION_STEP_KEY, ELEMENT_KEY, LAYOUT_KEY, META_KEY, SLIDE_KEY, TABLE_CELL_KEY, tableCellKey, TRANSITION_SCRIPT_KEY } from "../contracts/yjs-schema.ts";
import { childArray, childMap, elementsMapOf, slideMapOf, textOf, type DocumentRoots } from "./document-paths.ts";
import { orderedChildren } from "./document-projection.ts";
import { createCellMap, setTextBody, writeAnimationStep, writeElementList, writeElementTrees, writeLayout, writeSlide, writeThemePatch } from "./document-writer.ts";
import { DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT, defaultTableCell, readSlideStructure, STORED_ELEMENT_KINDS, tableLineIds, type SlideStructure } from "./element-tree.ts";
import { mintOrderKeys, planGapKeys, planReorderKeys, type OrderedSibling } from "./order-keys.ts";
import { CELL_BORDERS, FRAME, NUMBER, readStored, valueOr } from "./stored-values.ts";
import { applyTextOperations } from "./text-body.ts";

export type ApplicationContext = Readonly<{ roots: DocumentRoots; random: RandomSource; now: () => number; author: CommandAuthor }>;

export function applyCommand(context: ApplicationContext, command: DocumentCommand): void {
  const { roots, random } = context;
  switch (command.kind) {
    case "setTitle":
      roots.meta.set(META_KEY.title, command.title);
      return;
    case "updateTheme":
      writeThemePatch({ theme: roots.theme, patch: command.patch });
      return;
    case "upsertLayout": {
      const existing = childMap(roots.layouts, command.layout.id);
      if (existing === null) {
        const last = orderedChildren(roots.layouts).at(-1)?.key ?? null;
        const key = mintOrderKeys({ lower: last, upper: null, count: 1, random })?.[0] ?? fallbackKey(random);
        writeLayout({ layouts: roots.layouts, layout: command.layout, key, random });
        return;
      }
      existing.set(LAYOUT_KEY.name, command.layout.name);
      existing.set(LAYOUT_KEY.background, command.layout.background);
      writeElementList({ owner: existing, elements: command.layout.elements, random });
      return;
    }
    case "deleteLayout":
      roots.layouts.delete(command.layoutId);
      return;
    case "registerAsset":
      if (!roots.assets.has(command.asset.id)) roots.assets.set(command.asset.id, command.asset);
      return;
    case "upsertTransitionScript":
      writeScript({ context, draft: command.script, saveApproval: command.approval });
      return;
    case "deleteTransitionScript":
      roots.transitionScripts.delete(command.scriptId);
      return;
    case "approveTransitionScript": {
      const script = childMap(roots.transitionScripts, command.scriptId);
      if (script === null || context.author.kind !== "person") return;
      const approval: TransitionApproval = { kind: "approved", approvedBy: context.author.personId, fingerprint: command.fingerprint };
      script.set(TRANSITION_SCRIPT_KEY.approval, approval);
      return;
    }
    case "insertSlides": {
      const siblings = slideSiblings(roots);
      const gapIndex = command.after === null ? 0 : siblings.findIndex((sibling) => sibling.id === command.after) + 1;
      const keys = planGapKeys({ siblings, gapIndex, count: command.slides.length, random });
      writeSlidePositions(roots, keys.rekeyed);
      command.slides.forEach((slide, index) => writeSlide({ slides: roots.slides, slide, key: keys.inserted[index] ?? fallbackKey(random), random }));
      return;
    }
    case "deleteSlides":
      for (const slideId of command.slideIds) roots.slides.delete(slideId);
      return;
    case "moveSlides": {
      const moving = new Set<string>(command.slideIds);
      const all = slideSiblings(roots);
      const moved = all.filter((sibling) => moving.has(sibling.id));
      const remaining = all.filter((sibling) => !moving.has(sibling.id));
      const gapIndex = command.after === null ? 0 : remaining.findIndex((sibling) => sibling.id === command.after) + 1;
      const keys = planGapKeys({ siblings: remaining, gapIndex, count: moved.length, random });
      writeSlidePositions(roots, keys.rekeyed);
      writeSlidePositions(roots, new Map(moved.map((sibling, index) => [sibling.id, keys.inserted[index] ?? sibling.key])));
      return;
    }
    case "setSlideProperties": {
      const slide = slideMapOf(roots, command.slideId);
      if (slide === null) return;
      const patch = command.patch;
      if (patch.background !== undefined) slide.set(SLIDE_KEY.background, patch.background);
      if (patch.skipped !== undefined) slide.set(SLIDE_KEY.skipped, patch.skipped);
      if (patch.transition !== undefined) slide.set(SLIDE_KEY.transition, patch.transition);
      if (patch.layoutId !== undefined) slide.set(SLIDE_KEY.layoutId, patch.layoutId);
      return;
    }
    case "insertElements":
      insertElements({ context, command });
      return;
    case "deleteElements":
      deleteElements({ context, slideId: command.slideId, elementIds: command.elementIds });
      deleteStepsOfRemovedElements({ roots, slideId: command.slideId });
      return;
    case "setFrames": {
      const elements = elementsMapOf(roots, command.slideId);
      if (elements === null) return;
      for (const update of command.frames) {
        const map = childMap(elements, update.elementId);
        if (map === null) continue;
        switch (update.kind) {
          case "box":
            map.set(ELEMENT_KEY.frame, update.frame);
            break;
          case "line":
            map.set(ELEMENT_KEY.lineGeometry, { start: update.start, end: update.end });
            break;
          case "groupRotation":
            map.set(ELEMENT_KEY.rotation, normaliseRotation(update.rotation));
            break;
          default:
            assertNever(update);
        }
      }
      return;
    }
    case "updateElements": {
      const elements = elementsMapOf(roots, command.slideId);
      if (elements === null) return;
      for (const elementId of command.elementIds) {
        const map = childMap(elements, elementId);
        if (map !== null) patchElement({ map, patch: command.patch });
      }
      return;
    }
    case "reorderElements":
      reorderElements({ context, command });
      return;
    case "groupElements":
      groupElements({ context, command });
      return;
    case "ungroupElements": {
      const elements = elementsMapOf(roots, command.slideId);
      if (elements === null) return;
      for (const groupId of command.groupIds) dissolveGroup({ elementsMap: elements, groupId, random });
      deleteStepsOfRemovedElements({ roots, slideId: command.slideId });
      return;
    }
    case "editText": {
      const text = textOf(roots, command.target) ?? createMissingCellText({ roots, target: command.target });
      if (text !== null) applyTextOperations(text, command.operations);
      return;
    }
    case "insertTableRows":
    case "insertTableColumns":
    case "deleteTableRows":
    case "deleteTableColumns":
    case "setTableColumnWidths":
    case "setTableRowHeights":
    case "updateTableCells":
      applyTableCommand({ roots, command });
      return;
    case "insertAnimationSteps": {
      const animations = animationsMapOf({ roots, slideId: command.slideId });
      if (animations === null) return;
      const siblings = orderedChildren(animations).map(({ id, key }): OrderedSibling => ({ id, key }));
      const gapIndex = command.after === null ? 0 : siblings.findIndex((sibling) => sibling.id === command.after) + 1;
      const keys = planGapKeys({ siblings, gapIndex, count: command.steps.length, random });
      writeStepPositions(animations, keys.rekeyed);
      command.steps.forEach((step, index) => writeAnimationStep({ animations, step, key: keys.inserted[index] ?? fallbackKey(random) }));
      return;
    }
    case "updateAnimationSteps": {
      const animations = animationsMapOf({ roots, slideId: command.slideId });
      if (animations === null) return;
      for (const stepId of command.stepIds) {
        const step = childMap(animations, stepId);
        if (step !== null) patchAnimationStep({ map: step, patch: command.patch });
      }
      return;
    }
    case "moveAnimationSteps": {
      const animations = animationsMapOf({ roots, slideId: command.slideId });
      if (animations === null) return;
      const moving = new Set<string>(command.stepIds);
      const all = orderedChildren(animations).map(({ id, key }): OrderedSibling => ({ id, key }));
      const moved = all.filter((sibling) => moving.has(sibling.id));
      const remaining = all.filter((sibling) => !moving.has(sibling.id));
      const gapIndex = command.after === null ? 0 : remaining.findIndex((sibling) => sibling.id === command.after) + 1;
      const keys = planGapKeys({ siblings: remaining, gapIndex, count: moved.length, random });
      writeStepPositions(animations, keys.rekeyed);
      writeStepPositions(animations, new Map(moved.map((sibling, index) => [sibling.id, keys.inserted[index] ?? sibling.key])));
      return;
    }
    case "deleteAnimationSteps": {
      const animations = animationsMapOf({ roots, slideId: command.slideId });
      if (animations === null) return;
      for (const stepId of command.stepIds) animations.delete(stepId);
      return;
    }
    default:
      assertNever(command);
  }
}

/**
 * The slide's `animations` map. A slide stored before builds existed gets one here if the repairing
 * replica has not added it yet (yjs-schema.ts); null when the slide is gone.
 */
function animationsMapOf(options: Readonly<{ roots: DocumentRoots; slideId: SlideId }>): Y.Map<unknown> | null {
  const slide = slideMapOf(options.roots, options.slideId);
  if (slide === null) return null;
  const existing = childMap(slide, SLIDE_KEY.animations);
  if (existing !== null) return existing;
  const created = new Y.Map<unknown>();
  slide.set(SLIDE_KEY.animations, created);
  return created;
}

function patchAnimationStep(options: Readonly<{ map: Y.Map<unknown>; patch: AnimationStepPatch }>): void {
  const { map, patch } = options;
  if (patch.elementId !== undefined) map.set(ANIMATION_STEP_KEY.elementId, patch.elementId);
  if (patch.effect !== undefined) map.set(ANIMATION_STEP_KEY.effect, patch.effect);
  if (patch.trigger !== undefined) map.set(ANIMATION_STEP_KEY.trigger, patch.trigger);
  if (patch.durationMilliseconds !== undefined) map.set(ANIMATION_STEP_KEY.durationMilliseconds, patch.durationMilliseconds);
  if (patch.delayMilliseconds !== undefined) map.set(ANIMATION_STEP_KEY.delayMilliseconds, patch.delayMilliseconds);
  if (patch.easing !== undefined) map.set(ANIMATION_STEP_KEY.easing, patch.easing);
}

function writeStepPositions(animations: Y.Map<unknown>, keys: ReadonlyMap<string, string>): void {
  for (const [id, key] of keys) childMap(animations, id)?.set(ANIMATION_STEP_KEY.position, key);
}

/** Delete every build step whose element is no longer on the slide (see the header). */
function deleteStepsOfRemovedElements(options: Readonly<{ roots: DocumentRoots; slideId: SlideId }>): void {
  const slide = slideMapOf(options.roots, options.slideId);
  const animations = slide === null ? null : childMap(slide, SLIDE_KEY.animations);
  const elements = elementsMapOf(options.roots, options.slideId);
  if (animations === null || elements === null) return;
  const doomed: string[] = [];
  animations.forEach((_value, stepId) => {
    const target: unknown = childMap(animations, stepId)?.get(ANIMATION_STEP_KEY.elementId);
    if (typeof target === "string" && !elements.has(target)) doomed.push(stepId);
  });
  for (const stepId of doomed) animations.delete(stepId);
}

/** Dissolve a group: its children take its place among its siblings, in order, and it is deleted. */
export function dissolveGroup(options: Readonly<{ elementsMap: Y.Map<unknown>; groupId: ElementId; random: RandomSource }>): void {
  const { elementsMap, groupId, random } = options;
  const structure = readSlideStructure(elementsMap);
  if (!structure.records.has(groupId)) return;
  const parent = structure.parentOf.get(groupId) ?? null;
  const children = structure.childrenOf(groupId);
  const siblings = normalisedSiblings({ elementsMap, structure, parent, random });
  const gapIndex = Math.max(0, siblings.findIndex((sibling) => sibling.id === groupId));
  const others = siblings.filter((sibling) => sibling.id !== groupId);
  const keys = planGapKeys({ siblings: others, gapIndex, count: children.length, random });
  writeElementPositions(elementsMap, keys.rekeyed);
  children.forEach((child, index) => {
    child.map.set(ELEMENT_KEY.groupId, parent);
    child.map.set(ELEMENT_KEY.position, keys.inserted[index] ?? child.key);
  });
  elementsMap.delete(groupId);
}

/**
 * Siblings under `parent` in display order with ascending keys: displaced elements shown in front
 * are re-keyed to that place first (see the header), so a gap between any two can be minted.
 */
export function normalisedSiblings(
  options: Readonly<{ elementsMap: Y.Map<unknown>; structure: SlideStructure; parent: ElementId | null; random: RandomSource }>,
): readonly OrderedSibling[] {
  const { structure, parent } = options;
  const siblings = structure.childrenOf(parent).map((record): OrderedSibling => ({ id: record.id, key: record.key }));
  const displaced = new Set<string>(parent === null ? [...structure.displaced] : []);
  if (displaced.size === 0 || isAscending(siblings)) return siblings;
  const changes = planReorderKeys({ order: siblings, moved: displaced, random: options.random });
  writeElementPositions(options.elementsMap, changes);
  return siblings.map((sibling) => ({ id: sibling.id, key: changes.get(sibling.id) ?? sibling.key }));
}

/** Which `ElementPatch` fields apply to each kind; the rest are skipped for that element (commands.ts). */
const PATCH_FIELDS_BY_KIND: Readonly<Record<StoredElementKind, readonly (keyof ElementPatch)[]>> = {
  shape: ["name", "description", "morphKey", "fill", "border", "cornerRadius", "shadow", "opacity", "textBox", "preset"],
  image: ["name", "description", "morphKey", "fill", "border", "cornerRadius", "shadow", "opacity", "assetId", "crop"],
  line: ["name", "description", "morphKey", "opacity", "stroke", "startArrow", "endArrow", "routing"],
  table: ["name", "description", "morphKey", "opacity"],
  group: ["name", "description", "morphKey"],
};

function patchElement(options: Readonly<{ map: Y.Map<unknown>; patch: ElementPatch }>): void {
  const kind = STORED_ELEMENT_KINDS.find((candidate) => candidate === options.map.get(ELEMENT_KEY.kind));
  // An element of a kind this client does not know is never edited (document.ts).
  if (kind === undefined) return;
  for (const field of PATCH_FIELDS_BY_KIND[kind]) {
    const value = options.patch[field];
    // `ElementPatch` field names are the stored ELEMENT_KEY names (yjs-schema.ts), one to one.
    if (value !== undefined) options.map.set(field, value);
  }
}

function writeScript(options: Readonly<{ context: ApplicationContext; draft: TransitionScriptDraft; saveApproval: TransitionScriptSaveApproval }>): void {
  const { context, draft } = options;
  const scripts = context.roots.transitionScripts;
  const existing = childMap(scripts, draft.id);
  const map = existing ?? new Y.Map<unknown>();
  if (existing === null) scripts.set(draft.id, map);
  const previous = existing === null ? null : valueOr(readStored({ map: existing, key: TRANSITION_SCRIPT_KEY.updatedAt, kind: NUMBER }), null);
  // The injected clock stamps the save; a clock that has not moved past the last save still moves the stamp, so `staleScript` keeps working.
  const updatedAt = previous === null ? context.now() : Math.max(context.now(), previous + 1);
  const author = context.author;
  const approval = approvalOfSave({ author, draft, saveApproval: options.saveApproval });
  map.set(TRANSITION_SCRIPT_KEY.id, draft.id);
  map.set(TRANSITION_SCRIPT_KEY.name, draft.name);
  map.set(TRANSITION_SCRIPT_KEY.description, draft.description);
  map.set(TRANSITION_SCRIPT_KEY.purpose, draft.purpose);
  map.set(TRANSITION_SCRIPT_KEY.author, transitionAuthorOf(author));
  map.set(TRANSITION_SCRIPT_KEY.script, draft.script);
  map.set(TRANSITION_SCRIPT_KEY.stylesheet, draft.stylesheet);
  map.set(TRANSITION_SCRIPT_KEY.markup, draft.markup);
  map.set(TRANSITION_SCRIPT_KEY.defaultParameters, draft.defaultParameters);
  map.set(TRANSITION_SCRIPT_KEY.approval, approval);
  map.set(TRANSITION_SCRIPT_KEY.updatedAt, updatedAt);
}

function approvalOfSave(
  options: Readonly<{ author: CommandAuthor; draft: TransitionScriptDraft; saveApproval: TransitionScriptSaveApproval }>,
): TransitionApproval {
  switch (options.saveApproval) {
    case "unapproved":
      return { kind: "unapproved" };
    case "authorDecides":
      switch (options.author.kind) {
        case "person":
          return { kind: "approved", approvedBy: options.author.personId, fingerprint: scriptFingerprint(options.draft) };
        case "agent":
          return { kind: "unapproved" };
        default:
          return assertNever(options.author);
      }
    default:
      return assertNever(options.saveApproval);
  }
}

function slideSiblings(roots: DocumentRoots): readonly OrderedSibling[] {
  return orderedChildren(roots.slides).map(({ id, key }) => ({ id, key }));
}

function writeSlidePositions(roots: DocumentRoots, keys: ReadonlyMap<string, string>): void {
  for (const [id, key] of keys) childMap(roots.slides, id)?.set(SLIDE_KEY.position, key);
}

function writeElementPositions(elementsMap: Y.Map<unknown>, keys: ReadonlyMap<string, string>): void {
  for (const [id, key] of keys) childMap(elementsMap, id)?.set(ELEMENT_KEY.position, key);
}

function fallbackKey(random: RandomSource): string {
  return mintOrderKeys({ lower: null, upper: null, count: 1, random })?.[0] ?? "V";
}

function isAscending(siblings: readonly OrderedSibling[]): boolean {
  return siblings.every((sibling, index) => index === 0 || (siblings[index - 1]?.key ?? "") < sibling.key);
}

function insertElements(options: Readonly<{ context: ApplicationContext; command: Extract<DocumentCommand, { kind: "insertElements" }> }>): void {
  const { context, command } = options;
  const elementsMap = elementsMapOf(context.roots, command.slideId);
  if (elementsMap === null) return;
  const structure = readSlideStructure(elementsMap);
  const placement = command.placement;
  let parent: ElementId | null;
  let anchor: ElementId | null = null;
  switch (placement.kind) {
    case "front":
    case "back":
      parent = null;
      break;
    case "above":
      parent = structure.parentOf.get(placement.elementId) ?? null;
      anchor = placement.elementId;
      break;
    case "insideGroup":
      parent = placement.groupId;
      break;
    default:
      return assertNever(placement);
  }
  const siblings = normalisedSiblings({ elementsMap, structure, parent, random: context.random });
  const gapIndex = gapIndexFor({ placement: placement.kind, siblings, anchor });
  const keys = planGapKeys({ siblings, gapIndex, count: command.elements.length, random: context.random });
  writeElementPositions(elementsMap, keys.rekeyed);
  writeElementTrees({ elementsMap, elements: command.elements, groupId: parent, keys: keys.inserted, random: context.random });
}

function gapIndexFor(options: Readonly<{ placement: "front" | "back" | "above" | "insideGroup"; siblings: readonly OrderedSibling[]; anchor: ElementId | null }>): number {
  switch (options.placement) {
    case "back":
      return 0;
    case "front":
    case "insideGroup":
      return options.siblings.length;
    case "above":
      return options.siblings.findIndex((sibling) => sibling.id === options.anchor) + 1;
    default:
      return assertNever(options.placement);
  }
}

/** Delete elements and their descendants; a group left empty goes too, one left with one child dissolves. */
function deleteElements(options: Readonly<{ context: ApplicationContext; slideId: SlideId; elementIds: readonly ElementId[] }>): void {
  const elementsMap = elementsMapOf(options.context.roots, options.slideId);
  if (elementsMap === null) return;
  const structure = readSlideStructure(elementsMap);
  const doomed = new Set<ElementId>();
  const visit = (id: ElementId): void => {
    if (doomed.has(id)) return;
    doomed.add(id);
    for (const child of structure.childrenOf(id)) visit(child.id);
  };
  const parents = new Set<ElementId>();
  for (const id of options.elementIds) {
    visit(id);
    const parent = structure.parentOf.get(id) ?? null;
    if (parent !== null) parents.add(parent);
  }
  for (const id of doomed) elementsMap.delete(id);
  for (const parent of parents) tidyGroup({ elementsMap, groupId: parent, random: options.context.random });
}

/** After a removal: delete a group left empty (and check its parent), dissolve one left with one child. */
function tidyGroup(options: Readonly<{ elementsMap: Y.Map<unknown>; groupId: ElementId; random: RandomSource }>): void {
  const { elementsMap, groupId, random } = options;
  const structure = readSlideStructure(elementsMap);
  if (!structure.records.has(groupId)) return;
  const remaining = structure.childrenOf(groupId).length;
  if (remaining === 0) {
    const parent = structure.parentOf.get(groupId) ?? null;
    elementsMap.delete(groupId);
    if (parent !== null) tidyGroup({ elementsMap, groupId: parent, random });
    return;
  }
  if (remaining === 1) dissolveGroup({ elementsMap, groupId, random });
}

function reorderElements(options: Readonly<{ context: ApplicationContext; command: Extract<DocumentCommand, { kind: "reorderElements" }> }>): void {
  const { context, command } = options;
  const elementsMap = elementsMapOf(context.roots, command.slideId);
  if (elementsMap === null) return;
  const structure = readSlideStructure(elementsMap);
  const selected = new Set<string>(command.elementIds);
  const parents = new Set<ElementId | null>(command.elementIds.map((id) => structure.parentOf.get(id) ?? null));
  for (const parent of parents) {
    const siblings = normalisedSiblings({ elementsMap, structure, parent, random: context.random });
    const order = reordered({ siblings, selected, placement: command.placement });
    if (order.every((sibling, index) => sibling === siblings[index])) continue;
    writeElementPositions(elementsMap, planReorderKeys({ order, moved: new Set(siblings.filter((sibling) => selected.has(sibling.id)).map((sibling) => sibling.id)), random: context.random }));
  }
}

/** Slides' Arrange > Order on one sibling list (back to front). */
function reordered(
  options: Readonly<{ siblings: readonly OrderedSibling[]; selected: ReadonlySet<string>; placement: "front" | "forward" | "backward" | "back" }>,
): readonly OrderedSibling[] {
  const { siblings, selected } = options;
  const chosen = siblings.filter((sibling) => selected.has(sibling.id));
  const others = siblings.filter((sibling) => !selected.has(sibling.id));
  const order = [...siblings];
  switch (options.placement) {
    case "front":
      return [...others, ...chosen];
    case "back":
      return [...chosen, ...others];
    case "forward":
      // Each selected element steps over the next unselected one in front of it.
      for (let index = order.length - 2; index >= 0; index -= 1) {
        const current = order[index];
        const next = order[index + 1];
        if (current === undefined || next === undefined) continue;
        if (selected.has(current.id) && !selected.has(next.id)) {
          order[index] = next;
          order[index + 1] = current;
        }
      }
      return order;
    case "backward":
      for (let index = 1; index < order.length; index += 1) {
        const current = order[index];
        const previous = order[index - 1];
        if (current === undefined || previous === undefined) continue;
        if (selected.has(current.id) && !selected.has(previous.id)) {
          order[index] = previous;
          order[index - 1] = current;
        }
      }
      return order;
    default:
      return assertNever(options.placement);
  }
}

function groupElements(options: Readonly<{ context: ApplicationContext; command: Extract<DocumentCommand, { kind: "groupElements" }> }>): void {
  const { context, command } = options;
  const elementsMap = elementsMapOf(context.roots, command.slideId);
  if (elementsMap === null) return;
  const structure = readSlideStructure(elementsMap);
  const members = new Set<string>(command.elementIds);
  const parent = structure.parentOf.get(command.elementIds[0] ?? command.groupId) ?? null;
  const siblings = normalisedSiblings({ elementsMap, structure, parent, random: context.random });
  const ordered = siblings.filter((sibling) => members.has(sibling.id));
  const frontMost = ordered[ordered.length - 1];
  if (frontMost === undefined) return;
  const group = new Y.Map<unknown>();
  elementsMap.set(command.groupId, group);
  group.set(ELEMENT_KEY.id, command.groupId);
  group.set(ELEMENT_KEY.kind, "group");
  group.set(ELEMENT_KEY.name, "");
  group.set(ELEMENT_KEY.description, "");
  group.set(ELEMENT_KEY.groupId, parent);
  group.set(ELEMENT_KEY.position, frontMost.key);
  group.set(ELEMENT_KEY.morphKey, command.groupId);
  group.set(ELEMENT_KEY.placeholder, null);
  group.set(ELEMENT_KEY.rotation, 0);
  const keys = mintOrderKeys({ lower: null, upper: null, count: ordered.length, random: context.random }) ?? [];
  ordered.forEach((member, index) => {
    const map = childMap(elementsMap, member.id);
    if (map === null) return;
    map.set(ELEMENT_KEY.groupId, command.groupId);
    map.set(ELEMENT_KEY.position, keys[index] ?? member.key);
  });
}

/** The first edit of a cell nobody created yet creates it (yjs-schema.ts, tables). */
function createMissingCellText(options: Readonly<{ roots: DocumentRoots; target: Extract<DocumentCommand, { kind: "editText" }>["target"] }>): Y.Text | null {
  const { target } = options;
  if (target.kind !== "tableCell") return null;
  const cells = tableCells(options.roots, target.slideId, target.elementId);
  if (cells === null) return null;
  const existing = childMap(cells, tableCellKey(target.cell));
  if (existing !== null) return setTextBody({ map: existing, key: TABLE_CELL_KEY.text, body: { paragraphs: [{ style: {}, runs: [] }] } });
  const map = createCellMap({ cells, cell: defaultTableCell(target.cell) });
  const text = map.get(TABLE_CELL_KEY.text);
  return text instanceof Y.Text ? text : null;
}

function tableCells(roots: DocumentRoots, slideId: SlideId, elementId: ElementId): Y.Map<unknown> | null {
  const elements = elementsMapOf(roots, slideId);
  const table = elements === null ? null : childMap(elements, elementId);
  if (table === null) return null;
  const cells = childMap(table, ELEMENT_KEY.cells);
  if (cells !== null) return cells;
  const created = new Y.Map<unknown>();
  table.set(ELEMENT_KEY.cells, created);
  return created;
}

type TableCommand = Extract<
  DocumentCommand,
  { kind: "insertTableRows" | "insertTableColumns" | "deleteTableRows" | "deleteTableColumns" | "setTableColumnWidths" | "setTableRowHeights" | "updateTableCells" }
>;

function applyTableCommand(options: Readonly<{ roots: DocumentRoots; command: TableCommand }>): void {
  const { roots, command } = options;
  const elements = elementsMapOf(roots, command.slideId);
  const table = elements === null ? null : childMap(elements, command.elementId);
  const cells = tableCells(roots, command.slideId, command.elementId);
  if (table === null || cells === null) return;
  const rows = ensureArray(table, ELEMENT_KEY.rows);
  const columns = ensureArray(table, ELEMENT_KEY.columns);
  const heights = ensureMap(table, ELEMENT_KEY.rowHeights);
  const widths = ensureMap(table, ELEMENT_KEY.columnWidths);
  switch (command.kind) {
    case "insertTableRows": {
      let grown = 0;
      for (const insert of command.rows) {
        insertLine({ array: rows, id: insert.id, after: insert.after });
        heights.set(insert.id, insert.size);
        grown += insert.size;
        for (const columnId of tableLineIds(columns)) {
          // Column arrays hold column ids by construction (document-writer.ts).
          createCellMap({ cells, cell: defaultTableCell({ rowId: insert.id, columnId: columnId as TableColumnId }) });
        }
      }
      resizeTableFrame({ table, width: 0, height: grown });
      return;
    }
    case "insertTableColumns": {
      let grown = 0;
      for (const insert of command.columns) {
        insertLine({ array: columns, id: insert.id, after: insert.after });
        widths.set(insert.id, insert.size);
        grown += insert.size;
        for (const rowId of tableLineIds(rows)) {
          // Row arrays hold row ids by construction (document-writer.ts).
          createCellMap({ cells, cell: defaultTableCell({ rowId: rowId as TableRowId, columnId: insert.id }) });
        }
      }
      resizeTableFrame({ table, width: grown, height: 0 });
      return;
    }
    case "deleteTableRows": {
      let shrunk = 0;
      for (const rowId of command.rowIds) {
        shrunk += valueOr(readStored({ map: heights, key: rowId, kind: NUMBER }), DEFAULT_ROW_HEIGHT);
        removeLine({ array: rows, id: rowId });
        heights.delete(rowId);
        for (const key of [...cells.keys()]) if (key.startsWith(`${rowId}|`)) cells.delete(key);
      }
      resizeTableFrame({ table, width: 0, height: -shrunk });
      return;
    }
    case "deleteTableColumns": {
      let shrunk = 0;
      for (const columnId of command.columnIds) {
        shrunk += valueOr(readStored({ map: widths, key: columnId, kind: NUMBER }), DEFAULT_COLUMN_WIDTH);
        removeLine({ array: columns, id: columnId });
        widths.delete(columnId);
        for (const key of [...cells.keys()]) if (key.endsWith(`|${columnId}`)) cells.delete(key);
      }
      resizeTableFrame({ table, width: -shrunk, height: 0 });
      return;
    }
    case "setTableColumnWidths": {
      let delta = 0;
      for (const { columnId, width } of command.widths) {
        delta += width - valueOr(readStored({ map: widths, key: columnId, kind: NUMBER }), DEFAULT_COLUMN_WIDTH);
        widths.set(columnId, width);
      }
      resizeTableFrame({ table, width: delta, height: 0 });
      return;
    }
    case "setTableRowHeights": {
      let delta = 0;
      for (const { rowId, minimumHeight } of command.heights) {
        delta += minimumHeight - valueOr(readStored({ map: heights, key: rowId, kind: NUMBER }), DEFAULT_ROW_HEIGHT);
        heights.set(rowId, minimumHeight);
      }
      resizeTableFrame({ table, width: 0, height: delta });
      return;
    }
    case "updateTableCells":
      for (const address of command.cells) {
        const cell = childMap(cells, tableCellKey(address)) ?? createCellMap({ cells, cell: defaultTableCell(address) });
        patchCell({ cell, patch: command.patch });
      }
      return;
    default:
      assertNever(command);
  }
}

function patchCell(options: Readonly<{ cell: Y.Map<unknown>; patch: TableCellPatch }>): void {
  const { cell, patch } = options;
  if (patch.fill !== undefined) cell.set(TABLE_CELL_KEY.fill, patch.fill);
  if (patch.textBox !== undefined) cell.set(TABLE_CELL_KEY.textBox, patch.textBox);
  if (patch.borders !== undefined) {
    const current = valueOr(readStored({ map: cell, key: TABLE_CELL_KEY.borders, kind: CELL_BORDERS }), { top: null, right: null, bottom: null, left: null });
    cell.set(TABLE_CELL_KEY.borders, { ...current, ...patch.borders });
  }
}

function ensureArray(map: Y.Map<unknown>, key: string): Y.Array<unknown> {
  const existing = childArray(map, key);
  if (existing !== null) return existing;
  const created = new Y.Array<unknown>();
  map.set(key, created);
  return created;
}

function ensureMap(map: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const existing = childMap(map, key);
  if (existing !== null) return existing;
  const created = new Y.Map<unknown>();
  map.set(key, created);
  return created;
}

function insertLine(options: Readonly<{ array: Y.Array<unknown>; id: string; after: string | null }>): void {
  const index = options.after === null ? 0 : options.array.toArray().indexOf(options.after) + 1;
  options.array.insert(index, [options.id]);
}

function removeLine(options: Readonly<{ array: Y.Array<unknown>; id: string }>): void {
  for (let index = options.array.length - 1; index >= 0; index -= 1) {
    if (options.array.get(index) === options.id) options.array.delete(index, 1);
  }
}

/** Keep a table's stored frame the size of its lines when rows or columns change. */
function resizeTableFrame(options: Readonly<{ table: Y.Map<unknown>; width: number; height: number }>): void {
  if (options.width === 0 && options.height === 0) return;
  const frame = readStored({ map: options.table, key: ELEMENT_KEY.frame, kind: FRAME });
  if (frame.kind !== "valid") return;
  options.table.set(ELEMENT_KEY.frame, {
    ...frame.value,
    width: Math.max(MINIMUM_FRAME_SIZE, frame.value.width + options.width),
    height: Math.max(MINIMUM_FRAME_SIZE, frame.value.height + options.height),
  });
}
