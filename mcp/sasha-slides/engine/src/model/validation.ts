// VALIDATION AND REPAIR (document-store.ts header). `findIssues` checks the Y.Doc against
// yjs-schema.ts and returns every finding with the repair the REPAIRING replica would make;
// `applyRepairs` makes them. The store decides who repairs: the single replica in milestone 1 and
// the deck server from milestone 2 run "repairAfterTransaction", clients run "reportOnly" and see
// every issue with `repair: "none"`.
//
// Decisions, each against a concrete failure:
//
//  * STRUCTURAL ONLY. A missing required key, a value of the wrong type, a dangling `groupId`, a
//    group cycle, an empty or single-child group, a duplicate or unusable order key, a body without
//    its final paragraph mark. A value this client merely does not understand ("unsupported",
//    stored-values.ts) is reported and NEVER written, or an old client would keep erasing what a new
//    one wrote, and the two would fight forever.
//  * NOTHING IN `meta` AND NO ASSET IS EVER REPAIRED. A replica that has not synchronised yet sees
//    an empty `meta`; writing a default deck id there would race the real one. Assets are add-only.
//  * REPAIRS MATCH WHAT IS SHOWN. Elements the snapshot shows in front because their group is gone
//    or lost a cycle are moved to the top level AT that place (element-tree.ts), so a repair never
//    makes anything jump on anyone's screen.
//  * AN UNINITIALISED DOCUMENT HAS NO ISSUES. Before the seed or the first sync arrives there is
//    nothing to check, and nothing must be written.

import * as Y from "yjs";
import type { ValidationIssue, ValidationProblem } from "../contracts/document-store.ts";
import type { ElementId, RandomSource, SlideId } from "../contracts/ids.ts";
import type { ElementKey } from "../contracts/yjs-schema.ts";
import { assertNever } from "../contracts/assert-never.ts";
import { DOCUMENT_SCHEMA_VERSION, PLACEHOLDER_ROLES } from "../contracts/document.ts";
import { THEME_COLOUR_SLOTS } from "../contracts/style.ts";
import { ANIMATION_STEP_KEY, ELEMENT_KEYS_BY_KIND, ELEMENT_KEY, LAYOUT_KEY, META_KEY, RUN_ATTRIBUTE_NAMES, SLIDE_KEY, TABLE_CELL_KEY, THEME_KEY, TRANSITION_SCRIPT_KEY } from "../contracts/yjs-schema.ts";
import { DEFAULT_THEME } from "./blank-deck.ts";
import { dissolveGroup } from "./command-application.ts";
import { childMap, type DocumentRoots } from "./document-paths.ts";
import { orderedChildren } from "./document-projection.ts";
import { readSlideStructure, STORED_ELEMENT_KINDS, type ElementRecord } from "./element-tree.ts";
import { isCanonicalOrderKey, planReorderKeys, type OrderedSibling } from "./order-keys.ts";
import {
  ANIMATION_EFFECT,
  ANIMATION_TRIGGER,
  ARROW_HEAD,
  ASSET_RECORD,
  BOOLEAN,
  BORDER,
  checkTextBoxStyle,
  CORNER_RADIUS,
  CUSTOM_OUTLINE,
  FILL,
  FRAME,
  IMAGE_CROP,
  isRecord,
  LINE_GEOMETRY,
  LINE_ROUTING,
  NUMBER,
  OPACITY,
  OPTIONAL_FILL,
  OPTIONAL_TEXT,
  parseValue,
  PLACEHOLDER,
  RUN_ATTRIBUTE_CHECKS,
  SCRIPT_PURPOSE,
  SERIALISABLE_OBJECT,
  SHADOW,
  SHAPE_PRESET,
  SLIDE_TRANSITION,
  STROKE,
  TEXT,
  TRANSITION_APPROVAL,
  TRANSITION_AUTHOR,
  TRANSITION_EASING,
  type StoredValueCheck,
} from "./stored-values.ts";
import { endsWithParagraphMark, PARAGRAPH_MARK, paragraphMarkAttributes } from "./text-body.ts";

/** What a validation pass covers: every slide, or the slides a transaction touched, plus the deck level. */
export type ValidationScope = Readonly<{ slides: "all" | ReadonlySet<SlideId>; deck: boolean }>;

/** What the repairing replica does about one issue. */
export type RepairAction =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "writeDefault"; map: Y.Map<unknown>; key: string; value: () => unknown }>
  | Readonly<{ kind: "appendParagraphMark"; text: Y.Text }>
  | Readonly<{ kind: "moveToTopLevel"; elementsMap: Y.Map<unknown> }>
  | Readonly<{ kind: "deleteEmptyGroup"; elementsMap: Y.Map<unknown>; groupId: ElementId }>
  | Readonly<{ kind: "unwrapSingleChildGroup"; elementsMap: Y.Map<unknown>; groupId: ElementId }>
  | Readonly<{ kind: "rekeyOrder"; owner: Y.Map<unknown>; order: readonly OrderedSibling[]; moved: ReadonlySet<string> }>;

export type Finding = Readonly<{ path: string; problem: ValidationProblem; message: string; action: RepairAction }>;

export function findIssues(options: Readonly<{ roots: DocumentRoots; scope: ValidationScope }>): readonly Finding[] {
  const { roots, scope } = options;
  if (roots.meta.size === 0 && roots.slides.size === 0) return [];
  const findings: Finding[] = [];
  if (scope.deck) {
    findMetaIssues(roots, findings);
    findThemeIssues(roots, findings);
    findOrderIssues({ owner: roots.slides, path: "slides", findings });
    findOrderIssues({ owner: roots.layouts, path: "layouts", findings });
    roots.layouts.forEach((value, id) => {
      // Layout maps are Y.Map<unknown> (document-writer.ts); the parameter is erased at runtime.
      if (value instanceof Y.Map) findContainerIssues({ map: value as Y.Map<unknown>, path: `layouts/${id}`, id, specs: LAYOUT_KEY_SPECS, findings });
      else findings.push({ path: `layouts/${id}`, problem: "wrongType", message: "a layout must be a map", action: NO_REPAIR });
    });
    findScriptIssues(roots, findings);
    roots.assets.forEach((value, id) => {
      const parsed = parseValue({ candidate: value, kind: ASSET_RECORD });
      if (parsed.kind !== "valid") findings.push({ path: `assets/${id}`, problem: problemOf(parsed.kind), message: "an asset record is damaged; assets are never repaired", action: NO_REPAIR });
    });
  }
  roots.slides.forEach((value, id) => {
    // Slide ids are the keys of the slides root by construction (document-writer.ts).
    if (scope.slides !== "all" && !scope.slides.has(id as SlideId)) return;
    // Slide maps are Y.Map<unknown> (document-writer.ts); the parameter is erased at runtime.
    if (!(value instanceof Y.Map)) {
      findings.push({ path: `slides/${id}`, problem: "wrongType", message: "a slide must be a map", action: NO_REPAIR });
      return;
    }
    // As above: slide maps are Y.Map<unknown>.
    const slide = value as Y.Map<unknown>;
    findContainerIssues({ map: slide, path: `slides/${id}`, id, specs: SLIDE_KEY_SPECS, findings });
    findAnimationIssues({ slide, path: `slides/${id}/${SLIDE_KEY.animations}`, findings });
  });
  return findings;
}

/** The issues as `validate()` reports them: a report-only replica repairs nothing. */
export function issuesOf(options: Readonly<{ findings: readonly Finding[]; repairing: boolean }>): readonly ValidationIssue[] {
  return options.findings.map((finding) => ({
    path: finding.path,
    problem: finding.problem,
    message: finding.message,
    repair: options.repairing ? REPAIR_NAMES[finding.action.kind] : "none",
  }));
}

/** True when some finding would write something. */
export function hasRepairs(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.action.kind !== "none");
}

/** Make the repairs (the caller holds a REPAIR_ORIGIN transaction). */
export function applyRepairs(options: Readonly<{ findings: readonly Finding[]; random: RandomSource }>): void {
  const { random } = options;
  const moved = new Set<Y.Map<unknown>>();
  const ordered = [...options.findings].sort((first, second) => REPAIR_ORDER[first.action.kind] - REPAIR_ORDER[second.action.kind]);
  for (const finding of ordered) {
    const action = finding.action;
    switch (action.kind) {
      case "none":
        break;
      case "writeDefault":
        action.map.set(action.key, action.value());
        break;
      case "appendParagraphMark":
        action.text.insert(action.text.length, PARAGRAPH_MARK, paragraphMarkAttributes({}));
        break;
      case "moveToTopLevel":
        if (!moved.has(action.elementsMap)) {
          moved.add(action.elementsMap);
          moveDisplacedToTopLevel({ elementsMap: action.elementsMap, random });
        }
        break;
      case "deleteEmptyGroup":
        if (readSlideStructure(action.elementsMap).childrenOf(action.groupId).length === 0) action.elementsMap.delete(action.groupId);
        break;
      case "unwrapSingleChildGroup":
        if (readSlideStructure(action.elementsMap).childrenOf(action.groupId).length === 1) dissolveGroup({ elementsMap: action.elementsMap, groupId: action.groupId, random });
        break;
      case "rekeyOrder":
        for (const [id, key] of planReorderKeys({ order: action.order, moved: action.moved, random })) {
          childMap(action.owner, id)?.set(SLIDE_KEY.position, key);
        }
        break;
      default:
        assertNever(action);
    }
  }
}

const NO_REPAIR: RepairAction = { kind: "none" };

const REPAIR_NAMES: Readonly<Record<RepairAction["kind"], ValidationIssue["repair"]>> = {
  none: "none",
  writeDefault: "writeDefault",
  appendParagraphMark: "appendParagraphMark",
  moveToTopLevel: "moveToTopLevel",
  deleteEmptyGroup: "deleteEmptyGroup",
  unwrapSingleChildGroup: "unwrapSingleChildGroup",
  rekeyOrder: "rekeyOrder",
};

/** Keys first, then the tree, then order: each later repair reads what the earlier ones wrote. */
const REPAIR_ORDER: Readonly<Record<RepairAction["kind"], number>> = {
  none: 0,
  writeDefault: 1,
  appendParagraphMark: 2,
  moveToTopLevel: 3,
  deleteEmptyGroup: 4,
  unwrapSingleChildGroup: 5,
  rekeyOrder: 6,
};

/** How one key of a container is checked and what its default is. */
type KeySpec =
  | Readonly<{ kind: "value"; check: StoredValueCheck<unknown>; fallback: (id: string) => unknown }>
  /** A key added after schema version 1: absent is its default and fine; a damaged value is repaired to `fallback`. */
  | Readonly<{ kind: "optionalValue"; check: StoredValueCheck<unknown>; fallback: () => unknown }>
  | Readonly<{ kind: "text" }>
  | Readonly<{ kind: "array" }>
  | Readonly<{ kind: "map" }>
  | Readonly<{ kind: "position" }>
  | Readonly<{ kind: "identity" }>
  /** Only reported: a missing kind cannot be guessed. */
  | Readonly<{ kind: "reportOnly"; check: StoredValueCheck<unknown> }>;

const DEFAULT_FRAME = { x: 0, y: 0, width: 100, height: 100, rotation: 0, flipHorizontal: false, flipVertical: false };

/** Total over ElementKey, so a new stored key is a compile error until it says how it is checked. */
const ELEMENT_KEY_SPECS: Readonly<Record<ElementKey, KeySpec>> = {
  id: { kind: "identity" },
  kind: { kind: "reportOnly", check: TEXT },
  name: { kind: "value", check: TEXT, fallback: () => "" },
  description: { kind: "value", check: TEXT, fallback: () => "" },
  groupId: { kind: "value", check: OPTIONAL_TEXT, fallback: () => null },
  position: { kind: "position" },
  morphKey: { kind: "value", check: TEXT, fallback: (id) => id },
  placeholder: { kind: "value", check: PLACEHOLDER, fallback: () => null },
  frame: { kind: "value", check: FRAME, fallback: () => DEFAULT_FRAME },
  rotation: { kind: "value", check: NUMBER, fallback: () => 0 },
  fill: { kind: "value", check: FILL, fallback: () => ({ kind: "none" }) },
  border: { kind: "value", check: BORDER, fallback: () => ({ kind: "none" }) },
  cornerRadius: { kind: "value", check: CORNER_RADIUS, fallback: () => ({ kind: "uniform", radius: 0 }) },
  shadow: { kind: "value", check: SHADOW, fallback: () => null },
  opacity: { kind: "value", check: OPACITY, fallback: () => 1 },
  preset: { kind: "value", check: SHAPE_PRESET, fallback: () => "rectangle" },
  customOutline: { kind: "optionalValue", check: CUSTOM_OUTLINE, fallback: () => null },
  textBox: { kind: "value", check: { check: checkTextBoxStyle, describe: "a text box style" }, fallback: () => DEFAULT_TEXT_BOX },
  text: { kind: "text" },
  assetId: { kind: "value", check: TEXT, fallback: () => "" },
  crop: { kind: "value", check: IMAGE_CROP, fallback: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) },
  lineGeometry: { kind: "value", check: LINE_GEOMETRY, fallback: () => ({ start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }) },
  routing: { kind: "value", check: LINE_ROUTING, fallback: () => "straight" },
  stroke: { kind: "value", check: STROKE, fallback: () => ({ width: 2, colour: { kind: "theme", slot: "dark1", alpha: 1 }, dash: "solid" }) },
  startArrow: { kind: "value", check: ARROW_HEAD, fallback: () => "none" },
  endArrow: { kind: "value", check: ARROW_HEAD, fallback: () => "none" },
  rows: { kind: "array" },
  columns: { kind: "array" },
  rowHeights: { kind: "map" },
  columnWidths: { kind: "map" },
  cells: { kind: "map" },
};

const DEFAULT_TEXT_BOX = {
  verticalAlignment: "top",
  paddingTop: 12,
  paddingRight: 12,
  paddingBottom: 12,
  paddingLeft: 12,
  autofit: "none",
  wrap: true,
};

const SLIDE_KEY_SPECS: Readonly<Record<string, KeySpec>> = {
  [SLIDE_KEY.id]: { kind: "identity" },
  [SLIDE_KEY.position]: { kind: "position" },
  [SLIDE_KEY.layoutId]: { kind: "value", check: OPTIONAL_TEXT, fallback: () => null },
  [SLIDE_KEY.background]: { kind: "value", check: OPTIONAL_FILL, fallback: () => null },
  [SLIDE_KEY.skipped]: { kind: "value", check: BOOLEAN, fallback: () => false },
  [SLIDE_KEY.speakerNotes]: { kind: "text" },
  [SLIDE_KEY.transition]: { kind: "value", check: SLIDE_TRANSITION, fallback: () => null },
  [SLIDE_KEY.elements]: { kind: "map" },
  // A slide from before builds existed lacks it; the repairing replica adds it (yjs-schema.ts).
  [SLIDE_KEY.animations]: { kind: "map" },
};

/** One build step's keys. A dangling `elementId` is not structural: the step is shown as such and skipped when presenting. */
const ANIMATION_STEP_KEY_SPECS: Readonly<Record<string, KeySpec>> = {
  [ANIMATION_STEP_KEY.id]: { kind: "identity" },
  [ANIMATION_STEP_KEY.position]: { kind: "position" },
  [ANIMATION_STEP_KEY.elementId]: { kind: "reportOnly", check: TEXT },
  [ANIMATION_STEP_KEY.effect]: { kind: "value", check: ANIMATION_EFFECT, fallback: () => ({ kind: "appear" }) },
  [ANIMATION_STEP_KEY.trigger]: { kind: "value", check: ANIMATION_TRIGGER, fallback: () => "onClick" },
  [ANIMATION_STEP_KEY.durationMilliseconds]: { kind: "value", check: NUMBER, fallback: () => 500 },
  [ANIMATION_STEP_KEY.delayMilliseconds]: { kind: "value", check: NUMBER, fallback: () => 0 },
  [ANIMATION_STEP_KEY.easing]: { kind: "value", check: TRANSITION_EASING, fallback: () => "easeOut" },
};

const LAYOUT_KEY_SPECS: Readonly<Record<string, KeySpec>> = {
  [LAYOUT_KEY.id]: { kind: "identity" },
  [LAYOUT_KEY.name]: { kind: "value", check: TEXT, fallback: () => "" },
  [LAYOUT_KEY.position]: { kind: "position" },
  [LAYOUT_KEY.background]: { kind: "value", check: OPTIONAL_FILL, fallback: () => null },
  [LAYOUT_KEY.elements]: { kind: "map" },
};

const SCRIPT_KEY_SPECS: Readonly<Record<string, KeySpec>> = {
  [TRANSITION_SCRIPT_KEY.id]: { kind: "identity" },
  [TRANSITION_SCRIPT_KEY.name]: { kind: "value", check: TEXT, fallback: () => "" },
  [TRANSITION_SCRIPT_KEY.description]: { kind: "value", check: TEXT, fallback: () => "" },
  [TRANSITION_SCRIPT_KEY.purpose]: { kind: "value", check: SCRIPT_PURPOSE, fallback: () => "transition" },
  [TRANSITION_SCRIPT_KEY.author]: { kind: "value", check: TRANSITION_AUTHOR, fallback: () => ({ kind: "agent", name: "unknown", agentSessionId: "" }) },
  [TRANSITION_SCRIPT_KEY.script]: { kind: "value", check: TEXT, fallback: () => "" },
  [TRANSITION_SCRIPT_KEY.stylesheet]: { kind: "value", check: TEXT, fallback: () => "" },
  [TRANSITION_SCRIPT_KEY.markup]: { kind: "value", check: TEXT, fallback: () => "" },
  [TRANSITION_SCRIPT_KEY.defaultParameters]: { kind: "value", check: SERIALISABLE_OBJECT, fallback: () => ({}) },
  [TRANSITION_SCRIPT_KEY.approval]: { kind: "value", check: TRANSITION_APPROVAL, fallback: () => ({ kind: "unapproved" }) },
  [TRANSITION_SCRIPT_KEY.updatedAt]: { kind: "value", check: NUMBER, fallback: () => 0 },
};

function problemOf(kind: "unsupported" | "wrongType" | "missing"): ValidationProblem {
  switch (kind) {
    case "unsupported":
      return "unsupportedValue";
    case "wrongType":
      return "wrongType";
    case "missing":
      return "missingKey";
    default:
      return assertNever(kind);
  }
}

function findMetaIssues(roots: DocumentRoots, findings: Finding[]): void {
  const version = roots.meta.get(META_KEY.schemaVersion);
  if (typeof version === "number" && version > DOCUMENT_SCHEMA_VERSION) {
    findings.push({ path: `meta/${META_KEY.schemaVersion}`, problem: "schemaTooNew", message: `made with schema version ${version}; this editor knows ${DOCUMENT_SCHEMA_VERSION}`, action: NO_REPAIR });
  }
  for (const key of [META_KEY.deckId, META_KEY.schemaVersion, META_KEY.title, META_KEY.pageHeight, META_KEY.createdAt]) {
    if (!roots.meta.has(key)) findings.push({ path: `meta/${key}`, problem: "missingKey", message: "deck identity is never repaired", action: NO_REPAIR });
  }
}

function findThemeIssues(roots: DocumentRoots, findings: Finding[]): void {
  const theme = roots.theme;
  const simple: readonly Readonly<{ key: string; check: StoredValueCheck<unknown>; fallback: unknown }>[] = [
    { key: THEME_KEY.name, check: TEXT, fallback: DEFAULT_THEME.name },
    { key: THEME_KEY.headingFontFamily, check: TEXT, fallback: DEFAULT_THEME.headingFontFamily },
    { key: THEME_KEY.bodyFontFamily, check: TEXT, fallback: DEFAULT_THEME.bodyFontFamily },
    { key: THEME_KEY.background, check: FILL, fallback: DEFAULT_THEME.background },
  ];
  for (const { key, check, fallback } of simple) {
    const parsed = theme.has(key) ? parseValue({ candidate: theme.get(key), kind: check }) : ({ kind: "missing" } as const);
    if (parsed.kind === "valid") continue;
    const action: RepairAction = parsed.kind === "unsupported" ? NO_REPAIR : { kind: "writeDefault", map: theme, key, value: () => fallback };
    findings.push({ path: `theme/${key}`, problem: problemOf(parsed.kind), message: `theme ${key} is not ${check.describe}`, action });
  }
  findCompleteRecord({
    map: theme,
    key: THEME_KEY.colours,
    entries: THEME_COLOUR_SLOTS,
    isEntryValid: (entry) => typeof entry === "string" && /^#[0-9a-fA-F]{6}$/.test(entry),
    fallback: DEFAULT_THEME.colours,
    findings,
  });
  findCompleteRecord({
    map: theme,
    key: THEME_KEY.placeholderStyles,
    entries: PLACEHOLDER_ROLES,
    isEntryValid: (entry) => isRecord(entry),
    fallback: DEFAULT_THEME.placeholderStyles,
    findings,
  });
  findCompleteRecord({
    map: theme,
    key: THEME_KEY.defaultRunStyle,
    entries: RUN_ATTRIBUTE_NAMES,
    isEntryValid: (entry, name) => {
      const attribute = RUN_ATTRIBUTE_NAMES.find((candidate) => candidate === name);
      return attribute !== undefined && RUN_ATTRIBUTE_CHECKS[attribute](entry) === "valid";
    },
    fallback: DEFAULT_THEME.defaultRunStyle,
    findings,
  });
}

/** A record value that must hold every entry: missing entries are filled from the default, the rest kept. */
function findCompleteRecord(
  options: Readonly<{
    map: Y.Map<unknown>;
    key: string;
    entries: readonly string[];
    isEntryValid: (entry: unknown, name: string) => boolean;
    fallback: Readonly<Record<string, unknown>>;
    findings: Finding[];
  }>,
): void {
  const { map, key, fallback } = options;
  const value = map.get(key);
  if (!isRecord(value)) {
    options.findings.push({ path: `theme/${key}`, problem: map.has(key) ? "wrongType" : "missingKey", message: `theme ${key} is missing or damaged`, action: { kind: "writeDefault", map, key, value: () => fallback } });
    return;
  }
  const broken = options.entries.filter((name) => !options.isEntryValid(value[name], name));
  if (broken.length === 0) return;
  const repaired = (): unknown => {
    const merged: Record<string, unknown> = { ...value };
    for (const name of broken) merged[name] = fallback[name];
    return merged;
  };
  for (const name of broken) {
    options.findings.push({ path: `theme/${key}/${name}`, problem: name in value ? "wrongType" : "missingKey", message: `theme ${key} lacks a usable ${name}`, action: { kind: "writeDefault", map, key, value: repaired } });
  }
}

function findScriptIssues(roots: DocumentRoots, findings: Finding[]): void {
  roots.transitionScripts.forEach((value, id) => {
    // Script maps are Y.Map<unknown> (document-writer.ts); the parameter is erased at runtime.
    if (value instanceof Y.Map) findKeyIssues({ map: value as Y.Map<unknown>, path: `transitionScripts/${id}`, id, specs: SCRIPT_KEY_SPECS, findings });
    else findings.push({ path: `transitionScripts/${id}`, problem: "wrongType", message: "a transition script must be a map", action: NO_REPAIR });
  });
}

/** A slide or layout: its own keys, its speaker notes, and its element tree. */
function findContainerIssues(
  options: Readonly<{ map: Y.Map<unknown>; path: string; id: string; specs: Readonly<Record<string, KeySpec>>; findings: Finding[] }>,
): void {
  const { map, path, findings } = options;
  findKeyIssues(options);
  const elements = childMap(map, SLIDE_KEY.elements);
  if (elements === null) return;
  const structure = readSlideStructure(elements);
  for (const record of structure.records.values()) findElementIssues({ record, path: `${path}/elements/${record.id}`, findings });
  elements.forEach((value, id) => {
    if (!(value instanceof Y.Map)) findings.push({ path: `${path}/elements/${id}`, problem: "wrongType", message: "an element must be a map", action: NO_REPAIR });
  });

  for (const id of structure.displaced) {
    const cycle = structure.cycleBreaks.has(id);
    findings.push({
      path: `${path}/elements/${id}/${ELEMENT_KEY.groupId}`,
      problem: cycle ? "groupCycle" : "danglingReference",
      message: cycle ? "this group is inside one of its own members" : "this element's group does not exist",
      action: { kind: "moveToTopLevel", elementsMap: elements },
    });
  }
  for (const record of structure.records.values()) {
    if (record.storedKind !== "group") continue;
    const children = structure.childrenOf(record.id).length;
    if (children === 0) findings.push({ path: `${path}/elements/${record.id}`, problem: "emptyGroup", message: "a group without children", action: { kind: "deleteEmptyGroup", elementsMap: elements, groupId: record.id } });
    if (children === 1) findings.push({ path: `${path}/elements/${record.id}`, problem: "singleChildGroup", message: "a group with one child", action: { kind: "unwrapSingleChildGroup", elementsMap: elements, groupId: record.id } });
  }
  const parents: (ElementId | null)[] = [null, ...[...structure.records.values()].filter((record) => record.storedKind === "group").map((record) => record.id)];
  for (const parent of parents) {
    const siblings = structure.childrenOf(parent).filter((record) => !structure.displaced.has(record.id));
    findSiblingOrderIssues({ owner: elements, siblings, path: `${path}/elements`, findings });
  }
}

/** A slide's build steps: each step's keys, and their order keys as one sibling list. */
function findAnimationIssues(options: Readonly<{ slide: Y.Map<unknown>; path: string; findings: Finding[] }>): void {
  const animations = childMap(options.slide, SLIDE_KEY.animations);
  if (animations === null) return;
  animations.forEach((_value, id) => {
    const step = childMap(animations, id);
    if (step === null) {
      options.findings.push({ path: `${options.path}/${id}`, problem: "wrongType", message: "a build step must be a map", action: NO_REPAIR });
      return;
    }
    findKeyIssues({ map: step, path: `${options.path}/${id}`, id, specs: ANIMATION_STEP_KEY_SPECS, findings: options.findings });
  });
  findOrderIssues({ owner: animations, path: options.path, findings: options.findings });
}

function findOrderIssues(options: Readonly<{ owner: Y.Map<unknown>; path: string; findings: Finding[] }>): void {
  const siblings = orderedChildren(options.owner).map(({ id, key }) => ({ id, key }));
  findSiblingOrderIssues({ owner: options.owner, siblings, path: options.path, findings: options.findings });
}

/** Siblings must carry canonical, strictly ascending keys in display order. */
function findSiblingOrderIssues(options: Readonly<{ owner: Y.Map<unknown>; siblings: readonly OrderedSibling[]; path: string; findings: Finding[] }>): void {
  const { siblings } = options;
  const moved = new Set<string>();
  siblings.forEach((sibling, index) => {
    const previous = siblings[index - 1];
    if (!isCanonicalOrderKey(sibling.key) || (previous !== undefined && !(previous.key < sibling.key))) moved.add(sibling.id);
  });
  if (moved.size === 0) return;
  const order = siblings.map(({ id, key }) => ({ id, key }));
  for (const id of moved) {
    const sibling = siblings.find((candidate) => candidate.id === id);
    const canonical = sibling !== undefined && isCanonicalOrderKey(sibling.key);
    options.findings.push({
      path: `${options.path}/${id}/position`,
      problem: canonical ? "duplicateOrderKey" : sibling?.key === "" ? "missingKey" : "wrongType",
      message: canonical ? "an order key equal to its neighbour's" : "an unusable order key",
      action: { kind: "rekeyOrder", owner: options.owner, order, moved },
    });
  }
}

function findElementIssues(options: Readonly<{ record: ElementRecord; path: string; findings: Finding[] }>): void {
  const { record, path, findings } = options;
  const kind = STORED_ELEMENT_KINDS.find((candidate) => candidate === record.storedKind);
  if (kind === undefined) {
    findings.push({
      path: `${path}/${ELEMENT_KEY.kind}`,
      problem: record.storedKind === null ? (record.map.has(ELEMENT_KEY.kind) ? "wrongType" : "missingKey") : "unsupportedValue",
      message: record.storedKind === null ? "an element without a usable kind" : `an element of kind "${record.storedKind}" from a newer editor`,
      action: NO_REPAIR,
    });
    return;
  }
  const specs: Readonly<Record<string, KeySpec>> = Object.fromEntries(ELEMENT_KEYS_BY_KIND[kind].map((key) => [key, ELEMENT_KEY_SPECS[key]]));
  findKeyIssues({ map: record.map, path, id: record.id, specs, findings });
  if (kind === "table") findTableIssues({ map: record.map, path, findings });
}

function findTableIssues(options: Readonly<{ map: Y.Map<unknown>; path: string; findings: Finding[] }>): void {
  const cells = childMap(options.map, ELEMENT_KEY.cells);
  if (cells === null) return;
  cells.forEach((value, key) => {
    if (!(value instanceof Y.Map)) return;
    // Cell maps are Y.Map<unknown> (document-writer.ts); the parameter is erased at runtime.
    const cell = value as Y.Map<unknown>;
    const text = cell.get(TABLE_CELL_KEY.text);
    if (text instanceof Y.Text && !endsWithParagraphMark(text)) {
      options.findings.push({ path: `${options.path}/cells/${key}/text`, problem: "missingParagraphMark", message: "a text body without its final paragraph mark", action: { kind: "appendParagraphMark", text } });
    }
  });
}

/** Check every key `specs` names on `map`. */
function findKeyIssues(
  options: Readonly<{ map: Y.Map<unknown>; path: string; id: string; specs: Readonly<Record<string, KeySpec>>; findings: Finding[] }>,
): void {
  const { map, path, id, findings } = options;
  for (const [key, spec] of Object.entries(options.specs)) {
    const keyPath = `${path}/${key}`;
    const present = map.has(key);
    const value = map.get(key);
    switch (spec.kind) {
      case "value": {
        const parsed = present ? parseValue({ candidate: value, kind: spec.check }) : ({ kind: "missing" } as const);
        if (parsed.kind === "valid") break;
        const action: RepairAction = parsed.kind === "unsupported" ? NO_REPAIR : { kind: "writeDefault", map, key, value: () => spec.fallback(id) };
        findings.push({ path: keyPath, problem: problemOf(parsed.kind), message: parsed.kind === "unsupported" ? `a value from a newer editor (expected ${spec.check.describe})` : `expected ${spec.check.describe}`, action });
        break;
      }
      case "optionalValue": {
        if (!present) break;
        const parsed = parseValue({ candidate: value, kind: spec.check });
        if (parsed.kind === "valid") break;
        const action: RepairAction = parsed.kind === "unsupported" ? NO_REPAIR : { kind: "writeDefault", map, key, value: spec.fallback };
        findings.push({ path: keyPath, problem: problemOf(parsed.kind), message: parsed.kind === "unsupported" ? `a value from a newer editor (expected ${spec.check.describe})` : `expected ${spec.check.describe}`, action });
        break;
      }
      case "reportOnly": {
        const parsed = present ? parseValue({ candidate: value, kind: spec.check }) : ({ kind: "missing" } as const);
        if (parsed.kind !== "valid") findings.push({ path: keyPath, problem: problemOf(parsed.kind), message: `expected ${spec.check.describe}`, action: NO_REPAIR });
        break;
      }
      case "identity":
        if (value !== id) findings.push({ path: keyPath, problem: present ? "wrongType" : "missingKey", message: "the stored id must equal the map key", action: { kind: "writeDefault", map, key, value: () => id } });
        break;
      case "position":
        // Order keys are checked per sibling list (`findSiblingOrderIssues`), which can re-key them in order.
        break;
      case "text":
        if (value instanceof Y.Text) {
          if (!endsWithParagraphMark(value)) findings.push({ path: keyPath, problem: "missingParagraphMark", message: "a text body without its final paragraph mark", action: { kind: "appendParagraphMark", text: value } });
          break;
        }
        findings.push({ path: keyPath, problem: present ? "wrongType" : "missingKey", message: "expected rich text", action: { kind: "writeDefault", map, key, value: newEmptyText } });
        break;
      case "array":
        if (!(value instanceof Y.Array)) findings.push({ path: keyPath, problem: present ? "wrongType" : "missingKey", message: "expected a list", action: { kind: "writeDefault", map, key, value: () => new Y.Array<unknown>() } });
        break;
      case "map":
        if (!(value instanceof Y.Map)) findings.push({ path: keyPath, problem: present ? "wrongType" : "missingKey", message: "expected a map", action: { kind: "writeDefault", map, key, value: () => new Y.Map<unknown>() } });
        break;
      default:
        assertNever(spec);
    }
  }
}

function newEmptyText(): Y.Text {
  // A preliminary Y.Text applies its pending insert, with the mark's attributes, when it is integrated.
  const text = new Y.Text();
  text.insert(0, PARAGRAPH_MARK, paragraphMarkAttributes({}));
  return text;
}

/** Re-key every displaced element to where it is shown (in front, in order) and clear its stale `groupId`. */
function moveDisplacedToTopLevel(options: Readonly<{ elementsMap: Y.Map<unknown>; random: RandomSource }>): void {
  const structure = readSlideStructure(options.elementsMap);
  if (structure.displaced.size === 0) return;
  const order = structure.childrenOf(null).map((record): OrderedSibling => ({ id: record.id, key: record.key }));
  const changes = planReorderKeys({ order, moved: new Set<string>(structure.displaced), random: options.random });
  for (const id of structure.displaced) {
    const map = childMap(options.elementsMap, id);
    if (map === null) continue;
    map.set(ELEMENT_KEY.groupId, null);
    const key = changes.get(id);
    if (key !== undefined) map.set(ELEMENT_KEY.position, key);
  }
  for (const [id, key] of changes) {
    if (!structure.displaced.has(id as ElementId)) childMap(options.elementsMap, id)?.set(ELEMENT_KEY.position, key);
  }
}
