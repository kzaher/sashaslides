// THE IN-PAGE BUILD PLAYER: one build segment of built-in effects, played with Web Animations on the
// in-page stage the transitions use -- the slide BEFORE the segment as the outgoing layer (on top),
// the slide AFTER it as the incoming layer beneath. It is an ordinary `TransitionDefinition` that
// only touches the `TransitionContext`; what it needs beyond that (the segment and the element trees
// at every step, build-states.ts `buildSegmentTimeline`) arrives by closure, so the run, its
// deadlines and its cancellation are exactly a transition's.
//
// Key decisions:
//
//  * THE AFTER SIDE DRAWS ALMOST EVERYTHING. At the start the outgoing slide's root is hidden (the
//    root resets inheritance with `all: initial`, so `visibility` is set on the root itself) and only
//    the outgoing leaves the segment still needs are made visible again: the targets of an exit (they
//    are gone from the after side) and the twins of a colour change (the old colour fades out over the
//    new one). Every other change is drawn on the incoming side, which already holds the outcome.
//
//  * EACH STEP STARTS AT ITS OWN TIME with `delay: startMilliseconds`, and the first animation of a
//    leaf fills BACKWARDS, so an entrance target stays hidden and a moving element stays where it was
//    until its turn; later animations of the same leaf fill forwards only, so they never cover an
//    earlier one while it plays.
//
//  * TRANSFORMS GO THROUGH THE INDIVIDUAL PROPERTIES `translate`, `rotate` AND `scale`, never
//    `transform`: a leaf's own `transform` carries its rotation and flips, and the individual
//    properties compose with it (applied before it, about the same centre). Every value is RELATIVE
//    to the frame the node is drawn at, so "where the leaf is at step k" is a translation of centres,
//    a turn by the degrees spun since, and a uniform scale by the size ratio (grow and shrink are
//    uniform, so the scale commutes with the leaf's own rotation).
//
//  * SPIN TURNS THE FULL `degrees`, never the short way: rotation is accumulated from the steps, not
//    read back from normalised frames, and a group's leaves follow the arc about the group's centre
//    (sampled every 15 degrees) instead of cutting across it.
//
//  * A LEAF'S OWN OPACITY IS THE VISIBLE VALUE: an element stored at 50 % fades in to 50 %, never to
//    100 %.

import { animationCategoryOf, type AnimationCategory, type AnimationEdge, type TimedAnimationStep } from "../../contracts/animations.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ElementSnapshot } from "../../contracts/document.ts";
import { boundsOfBoxes, frameCentre, rotatePoint, rotatedBounds, type Box, type PageSize, type Point } from "../../contracts/geometry.ts";
import { SLIDE_ROOT_CLASS } from "../../contracts/render.ts";
import type { StageElementHandle, TransitionContext, TransitionDefinition } from "../../contracts/transition-protocol.ts";
import { EASING_FUNCTIONS, allFinished } from "../builtin/builtin-parameters.ts";
import { findElement, leavesOf, type BuildSegmentTimeline } from "./build-states.ts";

export function createBuildPlayer(options: Readonly<{ timeline: BuildSegmentTimeline; pageSize: PageSize }>): TransitionDefinition {
  return {
    name: "Build",
    async run(context) {
      await allFinished(new SegmentPlayback({ context, timeline: options.timeline, pageSize: options.pageSize }).start());
    },
  };
}

/** How far a float-in rises, in slide units. */
export const FLOAT_DISTANCE = 40;
/** The scale a zoom starts from (in) or ends at (out). */
export const ZOOM_SCALE = 0.3;
/** How far a pulse swells at its midpoint. */
export const PULSE_SCALE = 1.08;
/** A spinning group's leaves follow their arc in keyframes this many degrees apart. */
export const ARC_SAMPLE_DEGREES = 15;

/** The opacity an element is stored at; the value it is visible at. */
export function leafOpacity(element: ElementSnapshot): number {
  switch (element.kind) {
    case "shape":
    case "image":
      return element.box.opacity;
    case "line":
    case "table":
      return element.opacity;
    case "group":
    case "unsupported":
      return 1;
    default:
      return assertNever(element);
  }
}

/** How far a box must move to sit just beyond an edge of the page. */
export function offEdgeOffset(options: Readonly<{ bounds: Box; edge: AnimationEdge; pageSize: PageSize }>): Point {
  const bounds = options.bounds;
  switch (options.edge) {
    case "left":
      return { x: -(bounds.x + bounds.width), y: 0 };
    case "right":
      return { x: options.pageSize.width - bounds.x, y: 0 };
    case "top":
      return { x: 0, y: -(bounds.y + bounds.height) };
    case "bottom":
      return { x: 0, y: options.pageSize.height - bounds.y };
    default:
      return assertNever(options.edge);
  }
}

/** Which layer a leaf is animated on. */
type Side = "incoming" | "outgoing";

/** How a step uses the two layers (see `sideFor`). */
type StepRole = "entrance" | "exit" | "inPlace" | "twin";

/** Where a leaf is at some moment, relative to the frame its node is drawn at. */
type RelativePlacement = Readonly<{ translateX: number; translateY: number; rotate: number; scale: number }>;

/** One segment's playback: the per-leaf bookkeeping lives for one `run` only. */
class SegmentPlayback {
  private readonly context: TransitionContext;
  private readonly timeline: BuildSegmentTimeline;
  private readonly pageSize: PageSize;
  private readonly nodes: Readonly<Record<Side, ReadonlyMap<string, HTMLElement>>>;
  private readonly visibleAfter: ReadonlySet<string>;
  private readonly visibleBefore: ReadonlySet<string>;
  /** Degrees each leaf has turned after each step: `turned[0]` before the first, `turned[index + 1]` after step `index`. */
  private readonly turned: readonly ReadonlyMap<string, number>[];
  /** "side|leaf|property group" already animated once (see the header on fill). */
  private readonly animatedOnce = new Set<string>();
  private readonly animations: Animation[] = [];

  constructor(options: Readonly<{ context: TransitionContext; timeline: BuildSegmentTimeline; pageSize: PageSize }>) {
    this.context = options.context;
    this.timeline = options.timeline;
    this.pageSize = options.pageSize;
    this.nodes = { incoming: nodesOf(options.context.elements("incoming")), outgoing: nodesOf(options.context.elements("outgoing")) };
    this.visibleAfter = new Set(options.timeline.after.elements.flatMap(leavesOf).map((leaf) => leaf.id));
    this.visibleBefore = new Set(options.timeline.before.elements.flatMap(leavesOf).map((leaf) => leaf.id));
    this.turned = turnedDegrees(options.timeline);
  }

  start(): readonly Animation[] {
    const root = this.context.outgoing?.querySelector<HTMLElement>(`.${SLIDE_ROOT_CLASS}`) ?? null;
    if (root !== null) root.style.visibility = "hidden";
    this.timeline.segment.steps.forEach((timed, index) => this.playStep({ timed, index }));
    return this.animations;
  }

  private playStep(options: Readonly<{ timed: TimedAnimationStep; index: number }>): void {
    const step = options.timed.step;
    const target = findElement({ elements: this.tree(options.index), elementId: step.elementId });
    if (target === null) return;
    const leaves = leavesOf(target);
    const timing: KeyframeAnimationOptions = {
      delay: options.timed.startMilliseconds,
      duration: Math.max(0, options.timed.endMilliseconds - options.timed.startMilliseconds),
      easing: EASING_FUNCTIONS[step.easing],
    };
    const effect = step.effect;
    const role = stepRole(effect);
    for (const leaf of leaves) {
      const side = this.sideFor({ leafId: leaf.id, role });
      if (side === null) continue;
      const node = this.nodes[side].get(leaf.id);
      if (node === undefined) continue;
      const play = { side, leaf, node, index: options.index, timing, target, leaves };
      switch (effect.kind) {
        case "appear":
        case "fadeIn":
          this.opacity({ ...play, from: 0, to: this.ownOpacity(play) });
          break;
        case "flyIn":
          this.transform({ ...play, keyframes: [this.offEdge({ ...play, edge: effect.from }), this.placement(play)], backwards: true });
          break;
        case "zoomIn":
          this.transform({ ...play, keyframes: [this.zoomed({ ...play, factor: ZOOM_SCALE }), this.placement(play)], backwards: true });
          this.opacity({ ...play, from: 0, to: this.ownOpacity(play) });
          break;
        case "floatIn":
          this.transform({ ...play, keyframes: [shifted({ placement: this.placement(play), x: 0, y: FLOAT_DISTANCE }), this.placement(play)], backwards: true });
          this.opacity({ ...play, from: 0, to: this.ownOpacity(play) });
          break;
        case "wipe":
          this.wipe({ ...play, edge: effect.from });
          break;
        case "pulse":
          this.transform({ ...play, keyframes: [1, PULSE_SCALE, 1].map((factor) => this.zoomed({ ...play, factor })), backwards: false });
          break;
        case "growShrink":
        case "spin":
        case "motionPath":
          this.transform({ ...play, keyframes: this.geometryKeyframes({ ...play, spinDegrees: spinDegreesOf(effect) }), backwards: false });
          break;
        case "colourChange":
          this.opacity({ ...play, from: this.ownOpacity(play), to: 0 });
          break;
        case "disappear":
        case "fadeOut":
          this.opacity({ ...play, from: this.ownOpacity(play), to: 0 });
          break;
        case "flyOut":
          this.transform({ ...play, keyframes: [this.placement(play), this.offEdge({ ...play, edge: effect.to })], backwards: true });
          break;
        case "zoomOut":
          this.transform({ ...play, keyframes: [this.placement(play), this.zoomed({ ...play, factor: ZOOM_SCALE })], backwards: true });
          this.opacity({ ...play, from: this.ownOpacity(play), to: 0 });
          break;
        case "scripted":
          // A scripted step is a segment of its own in the sandbox; it never reaches this player.
          break;
        default:
          assertNever(effect);
      }
    }
  }

  /**
   * The layer a leaf is animated on: an exit's target and a colour change's old twin on the outgoing
   * side (made visible there), everything else where the outcome is drawn -- the incoming side, or the
   * outgoing side for a leaf a later step of this segment takes away.
   */
  private sideFor(options: Readonly<{ leafId: string; role: StepRole }>): Side | null {
    const before = this.visibleBefore.has(options.leafId);
    const after = this.visibleAfter.has(options.leafId);
    switch (options.role) {
      case "entrance":
        return after ? "incoming" : null;
      case "exit":
        return before ? this.revealed(options.leafId) : null;
      case "twin":
        return before && after ? this.revealed(options.leafId) : null;
      case "inPlace":
        if (after) return "incoming";
        return before ? this.revealed(options.leafId) : null;
      default:
        return assertNever(options.role);
    }
  }

  private revealed(leafId: string): Side {
    const node = this.nodes.outgoing.get(leafId);
    if (node !== undefined) node.style.visibility = "visible";
    return "outgoing";
  }

  /** The tree a step starts from. */
  private tree(index: number): readonly ElementSnapshot[] {
    return this.timeline.trees[index] ?? [];
  }

  /** The tree the node on `side` is drawn from. */
  private referenceIndex(side: Side): number {
    switch (side) {
      case "incoming":
        return this.timeline.trees.length - 1;
      case "outgoing":
        return 0;
      default:
        return assertNever(side);
    }
  }

  /** Where the leaf is when step `index` starts, relative to its node. */
  private placement(options: Readonly<{ side: Side; leaf: ElementSnapshot; index: number }>): RelativePlacement {
    const current = findElement({ elements: this.tree(options.index), elementId: options.leaf.id }) ?? options.leaf;
    return this.relative({ side: options.side, leafId: options.leaf.id, centre: frameCentre(current.frame), size: sizeOf(current), turned: this.turnedAt({ index: options.index, leafId: options.leaf.id }) });
  }

  private relative(options: Readonly<{ side: Side; leafId: string; centre: Point; size: number; turned: number }>): RelativePlacement {
    const referenceIndex = this.referenceIndex(options.side);
    const reference = findElement({ elements: this.tree(referenceIndex), elementId: options.leafId });
    if (reference === null) return { translateX: 0, translateY: 0, rotate: 0, scale: 1 };
    const referenceCentre = frameCentre(reference.frame);
    const referenceSize = sizeOf(reference);
    return {
      translateX: options.centre.x - referenceCentre.x,
      translateY: options.centre.y - referenceCentre.y,
      rotate: options.turned - this.turnedAt({ index: referenceIndex, leafId: options.leafId }),
      scale: referenceSize > 0 && options.size > 0 ? options.size / referenceSize : 1,
    };
  }

  private turnedAt(options: Readonly<{ index: number; leafId: string }>): number {
    return this.turned[options.index]?.get(options.leafId) ?? 0;
  }

  /** The leaf's placement scaled by `factor` about the target's centre (a group's leaves move apart or together). */
  private zoomed(options: Readonly<{ side: Side; leaf: ElementSnapshot; index: number; target: ElementSnapshot; factor: number }>): RelativePlacement {
    const placement = this.placement(options);
    const leafNow = findElement({ elements: this.tree(options.index), elementId: options.leaf.id }) ?? options.leaf;
    const leafCentre = frameCentre(leafNow.frame);
    const targetCentre = frameCentre(options.target.frame);
    return {
      translateX: placement.translateX + (options.factor - 1) * (leafCentre.x - targetCentre.x),
      translateY: placement.translateY + (options.factor - 1) * (leafCentre.y - targetCentre.y),
      rotate: placement.rotate,
      scale: placement.scale * options.factor,
    };
  }

  /** The leaf's placement moved so the whole TARGET is just beyond `edge` (a group flies as one). */
  private offEdge(options: Readonly<{ side: Side; leaf: ElementSnapshot; index: number; leaves: readonly ElementSnapshot[]; edge: AnimationEdge }>): RelativePlacement {
    const placement = this.placement(options);
    const current = options.leaves.map((leaf) => findElement({ elements: this.tree(options.index), elementId: leaf.id }) ?? leaf);
    const bounds = boundsOfBoxes(current.map((leaf) => rotatedBounds(leaf.frame))) ?? { x: 0, y: 0, width: 0, height: 0 };
    const offset = offEdgeOffset({ bounds, edge: options.edge, pageSize: this.pageSize });
    return shifted({ placement, x: offset.x, y: offset.y });
  }

  /** Grow, shrink, spin or move from where step `index` starts to where it ends (see the header on arcs). */
  private geometryKeyframes(
    options: Readonly<{ side: Side; leaf: ElementSnapshot; index: number; target: ElementSnapshot; spinDegrees: number }>,
  ): readonly RelativePlacement[] {
    const start = findElement({ elements: this.tree(options.index), elementId: options.leaf.id }) ?? options.leaf;
    const end = findElement({ elements: this.tree(options.index + 1), elementId: options.leaf.id }) ?? start;
    const turnedAtStart = this.turnedAt({ index: options.index, leafId: options.leaf.id });
    const pivot = frameCentre(options.target.frame);
    const samples = options.spinDegrees === 0 ? 1 : Math.max(1, Math.ceil(Math.abs(options.spinDegrees) / ARC_SAMPLE_DEGREES));
    const startCentre = frameCentre(start.frame);
    const endCentre = frameCentre(end.frame);
    const keyframes: RelativePlacement[] = [];
    for (let sample = 0; sample <= samples; sample += 1) {
      const fraction = sample / samples;
      const centre =
        options.spinDegrees === 0
          ? { x: startCentre.x + (endCentre.x - startCentre.x) * fraction, y: startCentre.y + (endCentre.y - startCentre.y) * fraction }
          : rotatePoint({ point: startCentre, centre: pivot, degrees: options.spinDegrees * fraction });
      const size = sizeOf(start) + (sizeOf(end) - sizeOf(start)) * fraction;
      keyframes.push(this.relative({ side: options.side, leafId: options.leaf.id, centre, size, turned: turnedAtStart + options.spinDegrees * fraction }));
    }
    return keyframes;
  }

  private transform(
    options: Readonly<{ side: Side; leaf: ElementSnapshot; node: HTMLElement; timing: KeyframeAnimationOptions; keyframes: readonly RelativePlacement[]; backwards: boolean }>,
  ): void {
    const last = options.keyframes.length - 1;
    const keyframes: Keyframe[] = options.keyframes.map((placement, index) => ({ ...transformProperties(placement), offset: last === 0 ? 1 : index / last }));
    this.animate({ ...options, keyframes, group: "transform" });
  }

  private opacity(options: Readonly<{ side: Side; leaf: ElementSnapshot; node: HTMLElement; timing: KeyframeAnimationOptions; from: number; to: number }>): void {
    this.animate({ ...options, keyframes: [{ opacity: round(options.from) }, { opacity: round(options.to) }], group: "opacity", backwards: true });
  }

  private wipe(options: Readonly<{ side: Side; leaf: ElementSnapshot; node: HTMLElement; timing: KeyframeAnimationOptions; edge: AnimationEdge }>): void {
    this.animate({ ...options, keyframes: [{ clipPath: wipeStart({ edge: options.edge, leaf: options.leaf }) }, { clipPath: "inset(0% 0% 0% 0%)" }], group: "clip", backwards: true });
  }

  /** `backwards`: an entrance or exit, whose start state must show before its turn; else only a leaf's first animation fills backwards. */
  private animate(
    options: Readonly<{ side: Side; leaf: ElementSnapshot; node: HTMLElement; timing: KeyframeAnimationOptions; keyframes: Keyframe[]; group: string; backwards: boolean }>,
  ): void {
    const key = `${options.side}|${options.leaf.id}|${options.group}`;
    const first = !this.animatedOnce.has(key);
    this.animatedOnce.add(key);
    const fill: FillMode = options.backwards || first ? "both" : "forwards";
    this.animations.push(this.context.animate(options.node, options.keyframes, { ...options.timing, fill }));
  }

  private ownOpacity(options: Readonly<{ side: Side; leaf: ElementSnapshot }>): number {
    const reference = findElement({ elements: this.tree(this.referenceIndex(options.side)), elementId: options.leaf.id }) ?? options.leaf;
    return leafOpacity(reference);
  }
}

function stepRole(effect: TimedAnimationStep["step"]["effect"]): StepRole {
  switch (effect.kind) {
    case "colourChange":
      return "twin";
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "growShrink":
    case "spin":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "motionPath":
    case "scripted":
      return categoryRole(animationCategoryOf(effect));
    default:
      return assertNever(effect);
  }
}

function categoryRole(category: AnimationCategory): StepRole {
  switch (category) {
    case "entrance":
      return "entrance";
    case "exit":
      return "exit";
    case "emphasis":
    case "motion":
      return "inPlace";
    default:
      return assertNever(category);
  }
}

function nodesOf(handles: readonly StageElementHandle[]): ReadonlyMap<string, HTMLElement> {
  return new Map(handles.map((handle) => [handle.elementId, handle.node]));
}

/** The cumulative degrees every leaf has spun, before the first step and after each one. */
function turnedDegrees(timeline: BuildSegmentTimeline): readonly ReadonlyMap<string, number>[] {
  const turned: Map<string, number>[] = [new Map()];
  timeline.segment.steps.forEach((timed, index) => {
    const next = new Map(turned[index]);
    const degrees = spinDegreesOf(timed.step.effect);
    const target = degrees === 0 ? null : findElement({ elements: timeline.trees[index] ?? [], elementId: timed.step.elementId });
    for (const leaf of target === null ? [] : leavesOf(target)) next.set(leaf.id, (next.get(leaf.id) ?? 0) + degrees);
    turned.push(next);
  });
  return turned;
}

function spinDegreesOf(effect: TimedAnimationStep["step"]["effect"]): number {
  switch (effect.kind) {
    case "spin":
      return effect.degrees;
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "growShrink":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "motionPath":
    case "scripted":
      return 0;
    default:
      return assertNever(effect);
  }
}

/** The length a uniform scale is measured on: a line's length, else the frame's width (or height when flat). */
function sizeOf(element: ElementSnapshot): number {
  switch (element.kind) {
    case "line":
      return Math.hypot(element.end.x - element.start.x, element.end.y - element.start.y);
    case "shape":
    case "image":
    case "table":
    case "group":
    case "unsupported":
      return element.frame.width > 0 ? element.frame.width : element.frame.height;
    default:
      return assertNever(element);
  }
}

function shifted(options: Readonly<{ placement: RelativePlacement; x: number; y: number }>): RelativePlacement {
  return { ...options.placement, translateX: options.placement.translateX + options.x, translateY: options.placement.translateY + options.y };
}

function transformProperties(placement: RelativePlacement): Readonly<{ translate: string; rotate: string; scale: string }> {
  return {
    translate: `${round(placement.translateX)}px ${round(placement.translateY)}px`,
    rotate: `${round(placement.rotate)}deg`,
    scale: `${round(placement.scale)}`,
  };
}

/** A clip that hides the whole leaf, open on the side the sweep starts from (mirrored with the leaf's flips). */
function wipeStart(options: Readonly<{ edge: AnimationEdge; leaf: ElementSnapshot }>): string {
  const frame = options.leaf.frame;
  const edge = mirroredEdge({ edge: options.edge, flipHorizontal: frame.flipHorizontal, flipVertical: frame.flipVertical });
  switch (edge) {
    case "left":
      return "inset(0% 100% 0% 0%)";
    case "right":
      return "inset(0% 0% 0% 100%)";
    case "top":
      return "inset(0% 0% 100% 0%)";
    case "bottom":
      return "inset(100% 0% 0% 0%)";
    default:
      return assertNever(edge);
  }
}

/** A flipped leaf's clip is in its mirrored box, so the edge it sweeps from is mirrored too. */
function mirroredEdge(options: Readonly<{ edge: AnimationEdge; flipHorizontal: boolean; flipVertical: boolean }>): AnimationEdge {
  switch (options.edge) {
    case "left":
      return options.flipHorizontal ? "right" : "left";
    case "right":
      return options.flipHorizontal ? "left" : "right";
    case "top":
      return options.flipVertical ? "bottom" : "top";
    case "bottom":
      return options.flipVertical ? "top" : "bottom";
    default:
      return assertNever(options.edge);
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000 + 0;
}
