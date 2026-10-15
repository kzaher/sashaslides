// WHAT A SLIDE LOOKS LIKE AT A BUILD POSITION, derived from the steps' DECLARED outcomes alone
// (contracts/animations.ts header): no animation is replayed to find out. A jump to a slide, a step
// back, reduced motion, the speaker view, the sandbox's prepare message and the transition out of a
// built slide (a morph included) all draw the slide through `slideAtBuild`, so they agree.
//
// Key decisions:
//
//  * VISIBILITY STARTS FROM EACH ELEMENT'S FIRST VISIBILITY STEP. An element whose first entrance or
//    exit step (a scripted step by its declared `category`) is an entrance starts hidden; every
//    other element starts shown. Then each step of the first `completed` segments applies in play
//    order: an entrance shows its element, an exit hides it. HIDDEN IS REMOVED FROM THE TREE, and a
//    group left with no children disappears, exactly as the model never shows an empty group.
//
//  * GEOMETRY AND COLOUR APPLY TO THE WHOLE TREE, HIDDEN ELEMENTS INCLUDED, so a motion path played
//    while an element is hidden moves where it later appears. Grow or shrink scales a frame about its
//    centre (a line's two end points, a group's every leaf about the group's centre); spin turns a
//    frame about its centre (a line's end points, a group's leaves about the group's centre and by
//    their own rotation); a motion path translates; a fill colour change makes the fill solid (a
//    box's fill, a line's stroke colour, every table cell's fill) and a text colour change recolours
//    every run. Pulse changes nothing. Text is not resized by grow or shrink: the frame is what the
//    declared outcome names, and the in-page player animates frames the same way.
//
//  * THE STEPS THAT COUNT ARE EXACTLY THE ONES `buildSegmentsOf` PLAYS: a step whose element is gone
//    or that carries values this client does not understand is skipped by both, so the derived state
//    can never disagree with what the presenter played.
//
//  * UNTOUCHED ELEMENTS KEEP THEIR IDENTITY, and the derived slides are cached per slide snapshot and
//    position, so `StaticSlide`'s memoisation (render.ts) holds across re-renders of a built slide and
//    a slide without builds is returned as the very same object.

import {
  animationCategoryOf,
  buildSegmentsOf,
  type AnimationEffect,
  type AnimationStep,
  type BuildSegment,
  type ColourChangePart,
} from "../../contracts/animations.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ElementSnapshot, GroupElement, SlideSnapshot, TableElement, TextBody } from "../../contracts/document.ts";
import {
  MINIMUM_FRAME_SIZE,
  boundsOfPoints,
  frameCentre,
  frameCorners,
  lineFrame,
  normaliseRotation,
  rotatePoint,
  type Frame,
  type Point,
} from "../../contracts/geometry.ts";
import type { ElementId } from "../../contracts/ids.ts";
import type { Colour } from "../../contracts/style.ts";

/** The slide after its first `completed` build segments (see the header). */
export function slideAtBuild(options: Readonly<{ slide: SlideSnapshot; completed: number }>): SlideSnapshot {
  const slide = options.slide;
  const segments = slideBuildSegments(slide);
  const completed = clampBuild({ build: options.completed, segments });
  const cached = DERIVED_SLIDES.get(slide)?.get(completed);
  if (cached !== undefined) return cached;
  const progress = progressAt({ slide, segments, completed });
  const derived = visibleSlide({ slide, progress });
  const perPosition = DERIVED_SLIDES.get(slide) ?? new Map<number, SlideSnapshot>();
  perPosition.set(completed, derived);
  DERIVED_SLIDES.set(slide, perPosition);
  return derived;
}

/** The segments the presenter plays on this slide (contracts/animations.ts `buildSegmentsOf`), cached per snapshot. */
export function slideBuildSegments(slide: SlideSnapshot): readonly BuildSegment[] {
  const cached = SEGMENTS.get(slide);
  if (cached !== undefined) return cached;
  const segments = buildSegmentsOf({ steps: slide.animations, elementIds: slideElementIds(slide) });
  SEGMENTS.set(slide, segments);
  return segments;
}

/** The build position a slide arrives at when entered backward: every segment played. */
export function finalBuildOf(slide: SlideSnapshot): number {
  return slideBuildSegments(slide).length;
}

/** Every element id in the slide's tree, groups included. */
export function slideElementIds(slide: SlideSnapshot): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (elements: readonly ElementSnapshot[]): void => {
    for (const element of elements) {
      ids.add(element.id);
      visit(childrenOf(element));
    }
  };
  visit(slide.elements);
  return ids;
}

/** A build position within [0, number of segments], whole. */
export function clampBuild(options: Readonly<{ build: number; segments: readonly BuildSegment[] }>): number {
  if (!Number.isFinite(options.build)) return 0;
  return Math.min(Math.max(Math.floor(options.build), 0), options.segments.length);
}

/**
 * One segment as the in-page player sees it: the slide before and after it, and the WHOLE element
 * tree (hidden elements included) before its first step and after each step, so the player can
 * interpolate every step from the frames it starts and ends at.
 */
export type BuildSegmentTimeline = Readonly<{
  segment: BuildSegment;
  before: SlideSnapshot;
  after: SlideSnapshot;
  /** `trees[0]` before the first step; `trees[index + 1]` after `segment.steps[index]`. */
  trees: readonly (readonly ElementSnapshot[])[];
}>;

/**
 * The timeline of `segment` played from build `completed` (usually `slideBuildSegments(slide)[completed]`;
 * a live run passes the segment it resolved, so a document change mid-run cannot swap it).
 */
export function buildSegmentTimeline(options: Readonly<{ slide: SlideSnapshot; completed: number; segment: BuildSegment }>): BuildSegmentTimeline {
  const slide = options.slide;
  const segments = slideBuildSegments(slide);
  let progress = progressAt({ slide, segments, completed: clampBuild({ build: options.completed, segments }) });
  const before = visibleSlide({ slide, progress });
  const trees: (readonly ElementSnapshot[])[] = [progress.elements];
  for (const timed of options.segment.steps) {
    progress = applyStep({ progress, step: timed.step });
    trees.push(progress.elements);
  }
  return { segment: options.segment, before, after: visibleSlide({ slide, progress }), trees };
}

/** The element with this id anywhere in the tree; null when absent. */
export function findElement(options: Readonly<{ elements: readonly ElementSnapshot[]; elementId: string }>): ElementSnapshot | null {
  for (const element of options.elements) {
    if (element.id === options.elementId) return element;
    const inside = findElement({ elements: childrenOf(element), elementId: options.elementId });
    if (inside !== null) return inside;
  }
  return null;
}

/** The leaves of an element: itself for a leaf, every leaf below it for a group. */
export function leavesOf(element: ElementSnapshot): readonly ElementSnapshot[] {
  switch (element.kind) {
    case "group":
      return element.children.flatMap(leavesOf);
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return [element];
    default:
      return assertNever(element);
  }
}

/** The element as a group; null for a leaf. */
export function asGroup(element: ElementSnapshot): GroupElement | null {
  switch (element.kind) {
    case "group":
      return element;
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return null;
    default:
      return assertNever(element);
  }
}

export function childrenOf(element: ElementSnapshot): readonly ElementSnapshot[] {
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

/** A group's box, as the model derives it: its children's corners measured in the group's rotated axes. */
export function groupFrameOf(options: Readonly<{ children: readonly ElementSnapshot[]; rotation: number }>): Frame {
  const corners = options.children.flatMap((child) => frameCorners(child.frame));
  const axisAligned = boundsOfPoints(corners) ?? { x: 0, y: 0, width: 0, height: 0 };
  const centre = frameCentre(axisAligned);
  const local = boundsOfPoints(corners.map((point) => rotatePoint({ point, centre, degrees: -options.rotation }))) ?? axisAligned;
  const localCentre = rotatePoint({ point: frameCentre(local), centre, degrees: options.rotation });
  return {
    x: localCentre.x - local.width / 2,
    y: localCentre.y - local.height / 2,
    width: local.width,
    height: local.height,
    rotation: options.rotation,
    flipHorizontal: false,
    flipVertical: false,
  };
}

/** The tree and which elements are hidden, part way through the sequence. */
type BuildProgress = Readonly<{ elements: readonly ElementSnapshot[]; hidden: ReadonlySet<string> }>;

const SEGMENTS = new WeakMap<SlideSnapshot, readonly BuildSegment[]>();
const DERIVED_SLIDES = new WeakMap<SlideSnapshot, Map<number, SlideSnapshot>>();

function progressAt(options: Readonly<{ slide: SlideSnapshot; segments: readonly BuildSegment[]; completed: number }>): BuildProgress {
  let progress: BuildProgress = { elements: options.slide.elements, hidden: initiallyHidden(options.segments) };
  for (const segment of options.segments.slice(0, options.completed)) {
    for (const timed of segment.steps) progress = applyStep({ progress, step: timed.step });
  }
  return progress;
}

/** Elements whose first visibility step is an entrance (see the header). */
function initiallyHidden(segments: readonly BuildSegment[]): ReadonlySet<string> {
  const decided = new Set<string>();
  const hidden = new Set<string>();
  for (const segment of segments) {
    for (const timed of segment.steps) {
      const elementId = timed.step.elementId;
      if (decided.has(elementId)) continue;
      const visibility = visibilityOutcome(timed.step.effect);
      if (visibility === null) continue;
      decided.add(elementId);
      if (visibility === "shown") hidden.add(elementId);
    }
  }
  return hidden;
}

/** Where a step leaves its element's visibility; null when it does not change it. */
function visibilityOutcome(effect: AnimationEffect): "shown" | "hidden" | null {
  const category = animationCategoryOf(effect);
  switch (category) {
    case "entrance":
      return "shown";
    case "exit":
      return "hidden";
    case "emphasis":
    case "motion":
      return null;
    default:
      return assertNever(category);
  }
}

function applyStep(options: Readonly<{ progress: BuildProgress; step: AnimationStep }>): BuildProgress {
  const progress = options.progress;
  const step = options.step;
  const effect = step.effect;
  switch (effect.kind) {
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "scripted":
      return withVisibility({ progress, elementId: step.elementId, outcome: visibilityOutcome(effect) });
    case "pulse":
      return progress;
    case "growShrink":
      return withTarget({ progress, elementId: step.elementId, change: (element) => scaleElement({ element, pivot: frameCentre(element.frame), factor: effect.scale }) });
    case "spin":
      return withTarget({ progress, elementId: step.elementId, change: (element) => rotateElement({ element, pivot: frameCentre(element.frame), degrees: effect.degrees }) });
    case "motionPath":
      return withTarget({ progress, elementId: step.elementId, change: (element) => translateElement({ element, offsetX: effect.offsetX, offsetY: effect.offsetY }) });
    case "colourChange":
      return withTarget({ progress, elementId: step.elementId, change: (element) => recolourElement({ element, colour: effect.colour, part: effect.part }) });
    default:
      return assertNever(effect);
  }
}

function withVisibility(options: Readonly<{ progress: BuildProgress; elementId: ElementId; outcome: "shown" | "hidden" | null }>): BuildProgress {
  const hidden = new Set(options.progress.hidden);
  switch (options.outcome) {
    case null:
      return options.progress;
    case "shown":
      if (!hidden.delete(options.elementId)) return options.progress;
      return { ...options.progress, hidden };
    case "hidden":
      if (hidden.has(options.elementId)) return options.progress;
      hidden.add(options.elementId);
      return { ...options.progress, hidden };
    default:
      return assertNever(options.outcome);
  }
}

function withTarget(options: Readonly<{ progress: BuildProgress; elementId: ElementId; change: (element: ElementSnapshot) => ElementSnapshot }>): BuildProgress {
  const elements = replaceInTree({ elements: options.progress.elements, elementId: options.elementId, change: options.change });
  return elements === options.progress.elements ? options.progress : { ...options.progress, elements };
}

/** The tree with one element replaced; enclosing groups get their derived frames again. Same array when absent. */
function replaceInTree(
  options: Readonly<{ elements: readonly ElementSnapshot[]; elementId: string; change: (element: ElementSnapshot) => ElementSnapshot }>,
): readonly ElementSnapshot[] {
  let changed = false;
  const next = options.elements.map((element) => {
    if (element.id === options.elementId) {
      changed = true;
      return options.change(element);
    }
    const group = asGroup(element);
    if (group === null) return element;
    const children = replaceInTree({ elements: group.children, elementId: options.elementId, change: options.change });
    if (children === group.children) return element;
    changed = true;
    return regrouped({ group, children, rotation: group.frame.rotation });
  });
  return changed ? next : options.elements;
}

function regrouped(options: Readonly<{ group: GroupElement; children: readonly ElementSnapshot[]; rotation: number }>): GroupElement {
  return { ...options.group, children: options.children, frame: groupFrameOf({ children: options.children, rotation: options.rotation }) };
}

function scaleElement(options: Readonly<{ element: ElementSnapshot; pivot: Point; factor: number }>): ElementSnapshot {
  const { element, pivot, factor } = options;
  const scalePoint = (point: Point): Point => ({ x: pivot.x + (point.x - pivot.x) * factor, y: pivot.y + (point.y - pivot.y) * factor });
  switch (element.kind) {
    case "group": {
      const children = element.children.map((child) => scaleElement({ element: child, pivot, factor }));
      return regrouped({ group: element, children, rotation: element.frame.rotation });
    }
    case "line": {
      const start = scalePoint(element.start);
      const end = scalePoint(element.end);
      return { ...element, start, end, frame: lineFrame({ start, end }) };
    }
    case "table":
      return scaledTable({ element, frame: scaledFrame({ frame: element.frame, pivot, factor }), factor });
    case "shape":
    case "image":
    case "unsupported":
      return { ...element, frame: scaledFrame({ frame: element.frame, pivot, factor }) };
    default:
      return assertNever(element);
  }
}

function scaledFrame(options: Readonly<{ frame: Frame; pivot: Point; factor: number }>): Frame {
  const centre = frameCentre(options.frame);
  const width = Math.max(options.frame.width * options.factor, MINIMUM_FRAME_SIZE);
  const height = Math.max(options.frame.height * options.factor, MINIMUM_FRAME_SIZE);
  const centreX = options.pivot.x + (centre.x - options.pivot.x) * options.factor;
  const centreY = options.pivot.y + (centre.y - options.pivot.y) * options.factor;
  return { ...options.frame, x: centreX - width / 2, y: centreY - height / 2, width, height };
}

/** A table's columns and rows scale with its frame, so the drawn grid fills the scaled box. */
function scaledTable(options: Readonly<{ element: TableElement; frame: Frame; factor: number }>): TableElement {
  return {
    ...options.element,
    frame: options.frame,
    columns: options.element.columns.map((column) => ({ ...column, width: column.width * options.factor })),
    rows: options.element.rows.map((row) => ({ ...row, minimumHeight: row.minimumHeight * options.factor })),
  };
}

function rotateElement(options: Readonly<{ element: ElementSnapshot; pivot: Point; degrees: number }>): ElementSnapshot {
  const { element, pivot, degrees } = options;
  switch (element.kind) {
    case "group": {
      const children = element.children.map((child) => rotateElement({ element: child, pivot, degrees }));
      return regrouped({ group: element, children, rotation: normaliseRotation(element.frame.rotation + degrees) });
    }
    case "line": {
      const start = rotatePoint({ point: element.start, centre: pivot, degrees });
      const end = rotatePoint({ point: element.end, centre: pivot, degrees });
      return { ...element, start, end, frame: lineFrame({ start, end }) };
    }
    case "shape":
    case "image":
    case "table":
    case "unsupported": {
      const centre = rotatePoint({ point: frameCentre(element.frame), centre: pivot, degrees });
      const frame = element.frame;
      return { ...element, frame: { ...frame, x: centre.x - frame.width / 2, y: centre.y - frame.height / 2, rotation: normaliseRotation(frame.rotation + degrees) } };
    }
    default:
      return assertNever(element);
  }
}

function translateElement(options: Readonly<{ element: ElementSnapshot; offsetX: number; offsetY: number }>): ElementSnapshot {
  const { element, offsetX, offsetY } = options;
  switch (element.kind) {
    case "group": {
      const children = element.children.map((child) => translateElement({ element: child, offsetX, offsetY }));
      return regrouped({ group: element, children, rotation: element.frame.rotation });
    }
    case "line": {
      const start = { x: element.start.x + offsetX, y: element.start.y + offsetY };
      const end = { x: element.end.x + offsetX, y: element.end.y + offsetY };
      return { ...element, start, end, frame: lineFrame({ start, end }) };
    }
    case "shape":
    case "image":
    case "table":
    case "unsupported":
      return { ...element, frame: { ...element.frame, x: element.frame.x + offsetX, y: element.frame.y + offsetY } };
    default:
      return assertNever(element);
  }
}

function recolourElement(options: Readonly<{ element: ElementSnapshot; colour: Colour; part: ColourChangePart }>): ElementSnapshot {
  const { element, colour, part } = options;
  switch (element.kind) {
    case "group":
      return { ...element, children: element.children.map((child) => recolourElement({ element: child, colour, part })) };
    case "shape":
      switch (part) {
        case "fill":
          return { ...element, box: { ...element.box, fill: { kind: "solid", colour } } };
        case "text":
          return { ...element, text: recolouredText({ body: element.text, colour }) };
        default:
          return assertNever(part);
      }
    case "image":
      switch (part) {
        case "fill":
          return { ...element, box: { ...element.box, fill: { kind: "solid", colour } } };
        case "text":
          return element;
        default:
          return assertNever(part);
      }
    case "line":
      switch (part) {
        case "fill":
          return { ...element, stroke: { ...element.stroke, colour } };
        case "text":
          return element;
        default:
          return assertNever(part);
      }
    case "table":
      switch (part) {
        case "fill":
          return { ...element, cells: element.cells.map((cell) => ({ ...cell, fill: { kind: "solid", colour } })) };
        case "text":
          return { ...element, cells: element.cells.map((cell) => ({ ...cell, text: recolouredText({ body: cell.text, colour }) })) };
        default:
          return assertNever(part);
      }
    case "unsupported":
      return element;
    default:
      return assertNever(element);
  }
}

function recolouredText(options: Readonly<{ body: TextBody; colour: Colour }>): TextBody {
  return {
    paragraphs: options.body.paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) => ({ ...run, style: { ...run.style, colour: options.colour } })),
    })),
  };
}

/** The slide with hidden elements removed; the same snapshot when nothing changed. */
function visibleSlide(options: Readonly<{ slide: SlideSnapshot; progress: BuildProgress }>): SlideSnapshot {
  const elements = withoutHidden({ elements: options.progress.elements, hidden: options.progress.hidden });
  return elements === options.slide.elements ? options.slide : { ...options.slide, elements };
}

function withoutHidden(options: Readonly<{ elements: readonly ElementSnapshot[]; hidden: ReadonlySet<string> }>): readonly ElementSnapshot[] {
  let changed = false;
  const kept: ElementSnapshot[] = [];
  for (const element of options.elements) {
    if (options.hidden.has(element.id)) {
      changed = true;
      continue;
    }
    const group = asGroup(element);
    const children = group === null ? null : withoutHidden({ elements: group.children, hidden: options.hidden });
    if (group === null || children === null || children === group.children) {
      kept.push(element);
      continue;
    }
    changed = true;
    // A group left with no children disappears, as the model never shows an empty group.
    if (children.length === 0) continue;
    kept.push(regrouped({ group, children, rotation: group.frame.rotation }));
  }
  return changed ? kept : options.elements;
}
