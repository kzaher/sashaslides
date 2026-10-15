// THE SNAPSHOT: the Y.Doc projected into the immutable `DocumentSnapshot` every other layer reads
// (document.ts). Rebuilt after every transaction, but only where the transaction reached: the
// caller passes the slides (and elements) it touched and which deck-level roots changed, and
// everything else is the previous snapshot's object, by identity. That sharing is a contract, not
// an optimisation (document.ts "STRUCTURAL SHARING").
//
// Every read goes through stored-values.ts, so a damaged or newer-client value becomes a default
// here (and an issue in validation.ts), never an exception in the renderer.

import * as Y from "yjs";
import type { AnimationStep } from "../contracts/animations.ts";
import type { AssetRecord, DocumentSnapshot, ElementSnapshot, LayoutSnapshot, PlaceholderRole, PlaceholderStyle, SlideSnapshot, ThemeSnapshot, TransitionScriptRecord } from "../contracts/document.ts";
import type { AnimationStepId, DeckId, ElementId, LayoutId, SlideId, TransitionScriptId } from "../contracts/ids.ts";
import type { RunStyle, ThemeColourSlot } from "../contracts/style.ts";
import { EMPTY_TEXT_BODY, PLACEHOLDER_ROLES } from "../contracts/document.ts";
import { SLIDE_WIDTH_UNITS } from "../contracts/geometry.ts";
import { THEME_COLOUR_SLOTS } from "../contracts/style.ts";
import { ANIMATION_STEP_KEY, LAYOUT_KEY, META_KEY, SLIDE_KEY, THEME_KEY, TRANSITION_SCRIPT_KEY } from "../contracts/yjs-schema.ts";
import { DEFAULT_PLACEHOLDER_STYLES, DEFAULT_RUN_STYLE, DEFAULT_THEME } from "./blank-deck.ts";
import { childMap, childText, type DocumentRoots } from "./document-paths.ts";
import { flattenElements, projectElementTree, readSlideStructure } from "./element-tree.ts";
import { compareOrderedSiblings, type OrderedSibling } from "./order-keys.ts";
import {
  ANIMATION_EFFECT,
  ANIMATION_TRIGGER,
  ASSET_RECORD,
  BOOLEAN,
  checkTextBoxField,
  FILL,
  isRecord,
  NUMBER,
  OPTIONAL_FILL,
  OPTIONAL_TEXT,
  POSITIVE_NUMBER,
  readStored,
  SCRIPT_PURPOSE,
  SERIALISABLE_OBJECT,
  SLIDE_TRANSITION,
  TEXT,
  TRANSITION_APPROVAL,
  TRANSITION_AUTHOR,
  TRANSITION_EASING,
  valueOr,
  type Parsed,
} from "./stored-values.ts";
import { paragraphStyleOf, projectTextBody, runStyleOf } from "./text-body.ts";

/** What one transaction reached; "all" in place of a slide's element set rebuilds every element. */
export type ProjectionScope = Readonly<{
  slides: ReadonlyMap<SlideId, ReadonlySet<string> | "all">;
  meta: boolean;
  theme: boolean;
  layouts: boolean;
  assets: boolean;
  transitionScripts: boolean;
}>;

export type Projection = Readonly<{ snapshot: DocumentSnapshot; changedSlideIds: readonly SlideId[] }>;

/** Project the document; `previous` null (or scope "all") rebuilds everything. */
export function projectDocument(
  options: Readonly<{ roots: DocumentRoots; previous: DocumentSnapshot | null; scope: ProjectionScope | "all"; revision: number }>,
): Projection {
  const { roots, previous, scope } = options;
  const reach = (part: keyof Omit<ProjectionScope, "slides">): boolean => scope === "all" || previous === null || scope[part];

  const previousSlides = new Map<SlideId, SlideSnapshot>();
  for (const slide of previous?.slides ?? []) previousSlides.set(slide.id, slide);

  const changedSlideIds: SlideId[] = [];
  const slides: SlideSnapshot[] = [];
  for (const { id, map } of orderedChildren(roots.slides)) {
    // Keys of the slides root are slide ids by construction (document-writer.ts).
    const slideId = id as SlideId;
    const old = previousSlides.get(slideId);
    const touched = scope === "all" || previous === null ? "all" : scope.slides.get(slideId);
    if (old !== undefined && touched === undefined) {
      slides.push(old);
      continue;
    }
    const slide = projectSlide({ id: slideId, map, previous: old ?? null, touched: touched ?? "all" });
    slides.push(slide);
    changedSlideIds.push(slideId);
  }

  const meta = roots.meta;
  const snapshot: DocumentSnapshot = {
    // The deck id is whatever the seeding replica stored; the brand records that it names this deck.
    deckId: valueOr(readStored({ map: meta, key: META_KEY.deckId, kind: TEXT }), "") as DeckId,
    schemaVersion: valueOr(readStored({ map: meta, key: META_KEY.schemaVersion, kind: NUMBER }), 0),
    revision: options.revision,
    title: reach("meta") || previous === null ? valueOr(readStored({ map: meta, key: META_KEY.title, kind: TEXT }), "") : previous.title,
    pageSize: { width: SLIDE_WIDTH_UNITS, height: valueOr(readStored({ map: meta, key: META_KEY.pageHeight, kind: POSITIVE_NUMBER }), 720) },
    theme: reach("theme") || previous === null ? projectTheme(roots.theme) : previous.theme,
    layouts: reach("layouts") || previous === null ? projectLayouts(roots.layouts) : previous.layouts,
    slides: previous !== null && sameItems(previous.slides, slides) ? previous.slides : slides,
    assets: reach("assets") || previous === null ? projectAssets(roots.assets) : previous.assets,
    transitionScripts: reach("transitionScripts") || previous === null ? projectScripts(roots.transitionScripts) : previous.transitionScripts,
  };
  return { snapshot, changedSlideIds };
}

/** The Y.Map children of a root (or a layout/slide list) in display order, by `position` then id. */
export function orderedChildren(map: Y.Map<unknown>): readonly Readonly<{ id: string; key: string; map: Y.Map<unknown> }>[] {
  const children: { id: string; key: string; map: Y.Map<unknown> }[] = [];
  map.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    // Every map in this document is a Y.Map<unknown> (document-writer.ts); the parameter is erased.
    const child = value as Y.Map<unknown>;
    const key = child.get(SLIDE_KEY.position);
    children.push({ id, key: typeof key === "string" ? key : "", map: child });
  });
  return children.sort((first: OrderedSibling, second: OrderedSibling) => compareOrderedSiblings(first, second));
}

export function projectTheme(map: Y.Map<unknown>): ThemeSnapshot {
  return {
    name: valueOr(readStored({ map, key: THEME_KEY.name, kind: TEXT }), DEFAULT_THEME.name),
    colours: projectColours(map.get(THEME_KEY.colours)),
    headingFontFamily: valueOr(readStored({ map, key: THEME_KEY.headingFontFamily, kind: TEXT }), DEFAULT_THEME.headingFontFamily),
    bodyFontFamily: valueOr(readStored({ map, key: THEME_KEY.bodyFontFamily, kind: TEXT }), DEFAULT_THEME.bodyFontFamily),
    background: valueOr(readStored({ map, key: THEME_KEY.background, kind: FILL }), DEFAULT_THEME.background),
    placeholderStyles: projectPlaceholderStyles(map.get(THEME_KEY.placeholderStyles)),
    defaultRunStyle: projectDefaultRunStyle(map.get(THEME_KEY.defaultRunStyle)),
  };
}

function projectSlide(
  options: Readonly<{ id: SlideId; map: Y.Map<unknown>; previous: SlideSnapshot | null; touched: ReadonlySet<string> | "all" }>,
): SlideSnapshot {
  const { map } = options;
  const notes = childText(map, SLIDE_KEY.speakerNotes);
  return {
    id: options.id,
    // A stored layout id names a layout of this deck when the writer stored it (commands check it).
    layoutId: valueOr(readStored({ map, key: SLIDE_KEY.layoutId, kind: OPTIONAL_TEXT }), null) as LayoutId | null,
    background: valueOr(readStored({ map, key: SLIDE_KEY.background, kind: OPTIONAL_FILL }), null),
    skipped: valueOr(readStored({ map, key: SLIDE_KEY.skipped, kind: BOOLEAN }), false),
    speakerNotes: notes === null ? EMPTY_TEXT_BODY : projectTextBody(notes),
    transition: valueOr(readStored({ map, key: SLIDE_KEY.transition, kind: SLIDE_TRANSITION }), null),
    elements: projectElements({ map, previous: options.previous?.elements ?? [], touched: options.touched }),
    animations: projectAnimations({ map, previous: options.previous?.animations ?? [] }),
  };
}

/**
 * The slide's build steps in play order. A step equal to the previous snapshot's keeps its identity,
 * and an unchanged sequence keeps the previous array (document.ts "STRUCTURAL SHARING").
 */
function projectAnimations(options: Readonly<{ map: Y.Map<unknown>; previous: readonly AnimationStep[] }>): readonly AnimationStep[] {
  const animations = childMap(options.map, SLIDE_KEY.animations);
  if (animations === null) return options.previous.length === 0 ? options.previous : [];
  const previousById = new Map<string, AnimationStep>(options.previous.map((step) => [step.id, step]));
  const projected = orderedChildren(animations).map(({ id, map: stepMap }) => {
    const step = projectAnimationStep({ id, map: stepMap });
    const old = previousById.get(id);
    return old !== undefined && JSON.stringify(old) === JSON.stringify(step) ? old : step;
  });
  return sameItems(options.previous, projected) ? options.previous : projected;
}

function projectAnimationStep(options: Readonly<{ id: string; map: Y.Map<unknown> }>): AnimationStep {
  const { map } = options;
  const unsupportedKeys: string[] = [];
  const read = <TValue>(key: string, parsed: Parsed<TValue>, fallback: TValue): TValue => {
    if (parsed.kind === "unsupported") unsupportedKeys.push(key);
    return valueOr(parsed, fallback);
  };
  return {
    // Keys of a slide's animations map are step ids by construction (document-writer.ts).
    id: options.id as AnimationStepId,
    // A stored element id names an element of this slide when its writer stored it (commands check it).
    elementId: read(ANIMATION_STEP_KEY.elementId, readStored({ map, key: ANIMATION_STEP_KEY.elementId, kind: TEXT }), "") as ElementId,
    effect: read(ANIMATION_STEP_KEY.effect, readStored({ map, key: ANIMATION_STEP_KEY.effect, kind: ANIMATION_EFFECT }), { kind: "appear" }),
    trigger: read(ANIMATION_STEP_KEY.trigger, readStored({ map, key: ANIMATION_STEP_KEY.trigger, kind: ANIMATION_TRIGGER }), "onClick"),
    durationMilliseconds: read(ANIMATION_STEP_KEY.durationMilliseconds, readStored({ map, key: ANIMATION_STEP_KEY.durationMilliseconds, kind: NUMBER }), 500),
    delayMilliseconds: read(ANIMATION_STEP_KEY.delayMilliseconds, readStored({ map, key: ANIMATION_STEP_KEY.delayMilliseconds, kind: NUMBER }), 0),
    easing: read(ANIMATION_STEP_KEY.easing, readStored({ map, key: ANIMATION_STEP_KEY.easing, kind: TRANSITION_EASING }), "easeOut"),
    unsupportedKeys,
  };
}

function projectElements(
  options: Readonly<{ map: Y.Map<unknown>; previous: readonly ElementSnapshot[]; touched: ReadonlySet<string> | "all" }>,
): readonly ElementSnapshot[] {
  const elements = childMap(options.map, SLIDE_KEY.elements);
  if (elements === null) return [];
  const projected = projectElementTree({ structure: readSlideStructure(elements), previous: flattenElements(options.previous), touched: options.touched });
  return sameItems(options.previous, projected) ? options.previous : projected;
}

function projectLayouts(map: Y.Map<unknown>): readonly LayoutSnapshot[] {
  return orderedChildren(map).map(({ id, map: layout }) => ({
    // Keys of the layouts root are layout ids by construction (document-writer.ts).
    id: id as LayoutId,
    name: valueOr(readStored({ map: layout, key: LAYOUT_KEY.name, kind: TEXT }), ""),
    background: valueOr(readStored({ map: layout, key: LAYOUT_KEY.background, kind: OPTIONAL_FILL }), null),
    elements: projectElements({ map: layout, previous: [], touched: "all" }),
  }));
}

function projectAssets(map: Y.Map<unknown>): readonly AssetRecord[] {
  const assets: AssetRecord[] = [];
  map.forEach((_value, key) => {
    const parsed = readStored({ map, key, kind: ASSET_RECORD });
    if (parsed.kind === "valid") assets.push(parsed.value);
  });
  return assets.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
}

function projectScripts(map: Y.Map<unknown>): readonly TransitionScriptRecord[] {
  const scripts: TransitionScriptRecord[] = [];
  map.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    // As in `orderedChildren`: the element type parameter of a Y.Map is erased at runtime.
    const script = value as Y.Map<unknown>;
    const text = (key: string): string => valueOr(readStored({ map: script, key, kind: TEXT }), "");
    scripts.push({
      // Keys of the transitionScripts root are script ids by construction (document-writer.ts).
      id: id as TransitionScriptId,
      name: text(TRANSITION_SCRIPT_KEY.name),
      description: text(TRANSITION_SCRIPT_KEY.description),
      purpose: valueOr(readStored({ map: script, key: TRANSITION_SCRIPT_KEY.purpose, kind: SCRIPT_PURPOSE }), "transition"),
      author: valueOr(readStored({ map: script, key: TRANSITION_SCRIPT_KEY.author, kind: TRANSITION_AUTHOR }), UNKNOWN_AUTHOR),
      script: text(TRANSITION_SCRIPT_KEY.script),
      stylesheet: text(TRANSITION_SCRIPT_KEY.stylesheet),
      markup: text(TRANSITION_SCRIPT_KEY.markup),
      defaultParameters: valueOr(readStored({ map: script, key: TRANSITION_SCRIPT_KEY.defaultParameters, kind: SERIALISABLE_OBJECT }), {}),
      approval: valueOr(readStored({ map: script, key: TRANSITION_SCRIPT_KEY.approval, kind: TRANSITION_APPROVAL }), { kind: "unapproved" }),
      updatedAt: valueOr(readStored({ map: script, key: TRANSITION_SCRIPT_KEY.updatedAt, kind: NUMBER }), 0),
    });
  });
  return scripts.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
}

/** An author nobody can be confused with: a damaged record never claims a person wrote it. */
const UNKNOWN_AUTHOR = { kind: "agent", name: "unknown", agentSessionId: "" } as const;

function projectColours(candidate: unknown): Readonly<Record<ThemeColourSlot, string>> {
  if (!isRecord(candidate)) return DEFAULT_THEME.colours;
  const colours: Record<string, string> = {};
  for (const slot of THEME_COLOUR_SLOTS) {
    const value = candidate[slot];
    colours[slot] = typeof value === "string" && HEXADECIMAL_PATTERN.test(value) ? value.toLowerCase() : DEFAULT_THEME.colours[slot];
  }
  // The loop above assigned every ThemeColourSlot.
  return colours as Readonly<Record<ThemeColourSlot, string>>;
}

function projectPlaceholderStyles(candidate: unknown): Readonly<Record<PlaceholderRole, PlaceholderStyle>> {
  if (!isRecord(candidate)) return DEFAULT_PLACEHOLDER_STYLES;
  const styles: Record<string, PlaceholderStyle> = {};
  for (const role of PLACEHOLDER_ROLES) {
    const entry = candidate[role];
    styles[role] = isRecord(entry) ? projectPlaceholderStyle(entry) : DEFAULT_PLACEHOLDER_STYLES[role];
  }
  // The loop above assigned every PlaceholderRole.
  return styles as Readonly<Record<PlaceholderRole, PlaceholderStyle>>;
}

function projectPlaceholderStyle(entry: Readonly<Record<string, unknown>>): PlaceholderStyle {
  const run = entry["run"];
  const paragraph = entry["paragraph"];
  const textBox = entry["textBox"];
  const box: Record<string, unknown> = {};
  if (isRecord(textBox)) {
    for (const [key, value] of Object.entries(textBox)) {
      if (checkTextBoxField(key, value) === "valid") box[key] = value;
    }
  }
  return {
    run: isRecord(run) ? runStyleOf(run) : {},
    paragraph: isRecord(paragraph) ? paragraphStyleOf(paragraph) : {},
    // Every key copied above passed its TextBoxStyle field check.
    textBox: box as PlaceholderStyle["textBox"],
  };
}

function projectDefaultRunStyle(candidate: unknown): RunStyle {
  if (!isRecord(candidate)) return DEFAULT_RUN_STYLE;
  return { ...DEFAULT_RUN_STYLE, ...runStyleOf(candidate) };
}

function sameItems<TItem>(first: readonly TItem[], second: readonly TItem[]): boolean {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

const HEXADECIMAL_PATTERN = /^#[0-9a-fA-F]{6}$/;
