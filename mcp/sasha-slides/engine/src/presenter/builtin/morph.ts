// MORPH (Keynote's Magic Move, Slides' "morph"): leaves with the same morph key on both slides move
// and resize from where they were to where they are, while the rest cross-fade.
//
// Decisions (SPEC.md section 11):
//
//  * LEAVES ONLY. `context.pairs()` pairs leaves; a group is a wrapper with no transform of its own
//    (render.ts), so nothing is ever animated twice.
//  * THE UNROTATED FRAME AND THE ROTATION ARE INTERPOLATED SEPARATELY. Each leaf is drawn as its
//    unrotated box turned about its centre (`rotate(r) scale(flipX, flipY)`), so the keyframes are
//    `translate(centre offset) rotate(angle) scale(width ratio, height ratio)`: the translation and
//    the scale map one UNROTATED frame onto the other in the element's own axes, and the angle turns
//    by the shortest way round. Mapping rotated bounds onto rotated bounds while also rotating would
//    count the rotation twice -- a 45 degree square would swell to its bounding box and back.
//  * WHAT DOES NOT PAIR FADES: the outgoing slide fades out as a whole (its background and unpaired
//    leaves with it), unpaired incoming leaves fade in, and each paired incoming leaf fades in along
//    the shared path while its outgoing twin fades out along it -- a cross-fade of content.
//  * FRAMES ARE TRANSFORMS, never left/top/width/height: no layout per frame, and text keeps its
//    line breaks while it scales.
//  * A LEAF FADES TO ITS OWN OPACITY, never to 1: an element stored at 50 % would otherwise flash to
//    full strength for the length of the morph and snap back. The renderer writes a leaf's opacity
//    inline on the node that carries the element id (render.ts), in the page and in the runner
//    alike, so the definition reads it there and stays runnable from the `TransitionContext` alone.
//  * THE INCOMING SLIDE IS DRAWN AT ITS ARRIVAL BUILD AND THE OUTGOING ONE AT ITS FINAL BUILD
//    (in-page-run-feedback.ts), so a morph out of a built slide starts from what the audience saw.

import type { Frame } from "../../contracts/geometry.ts";
import type { TransitionDefinition } from "../../contracts/transition-protocol.ts";
import { allFinished, builtinTiming } from "./builtin-parameters.ts";

export const MORPH_TRANSITION: TransitionDefinition = {
  name: "Morph",
  async run(context) {
    const timing = builtinTiming(context);
    if (context.outgoing === null) {
      await allFinished([context.animate(context.incoming, [{ opacity: 0 }, { opacity: 1 }], timing)]);
      return;
    }
    const pairs = context.pairs();
    const pairedIncoming = new Set(pairs.map((pair) => pair.incoming.elementId));
    const pairedOutgoing = new Set(pairs.map((pair) => pair.outgoing.elementId));
    const animations: Animation[] = [context.animate(context.outgoing, [{ opacity: 1 }, { opacity: 0 }], timing)];
    for (const pair of pairs) {
      const path = morphPath({ from: pair.outgoing.frame, to: pair.incoming.frame });
      animations.push(
        context.animate(pair.incoming.node, [{ transform: path.incomingStart, opacity: 0 }, { transform: path.incomingEnd, opacity: ownOpacity(pair.incoming.node) }], timing),
      );
      animations.push(context.animate(pair.outgoing.node, [{ transform: path.outgoingStart }, { transform: path.outgoingEnd }], timing));
    }
    for (const handle of context.elements("incoming")) {
      if (pairedIncoming.has(handle.elementId)) continue;
      animations.push(context.animate(handle.node, [{ opacity: 0 }, { opacity: ownOpacity(handle.node) }], timing));
    }
    for (const handle of context.elements("outgoing")) {
      if (pairedOutgoing.has(handle.elementId)) continue;
      animations.push(context.animate(handle.node, [{ opacity: ownOpacity(handle.node) }, { opacity: 0 }], timing));
    }
    await allFinished(animations);
  },
};

/** The transforms that carry one leaf's frame onto another's (see the header). */
export type MorphPath = Readonly<{
  /** On the incoming node: drawn at the outgoing frame. */
  incomingStart: string;
  /** On the incoming node: its own rendering. */
  incomingEnd: string;
  /** On the outgoing node: its own rendering. */
  outgoingStart: string;
  /** On the outgoing node: drawn at the incoming frame. */
  outgoingEnd: string;
}>;

export function morphPath(options: Readonly<{ from: Frame; to: Frame }>): MorphPath {
  const from = options.from;
  const to = options.to;
  const offsetX = from.x + from.width / 2 - (to.x + to.width / 2);
  const offsetY = from.y + from.height / 2 - (to.y + to.height / 2);
  const turn = shortestTurn({ from: from.rotation, to: to.rotation });
  const widthRatio = safeRatio(from.width, to.width);
  const heightRatio = safeRatio(from.height, to.height);
  return {
    incomingStart: transformOf({ offsetX, offsetY, rotation: to.rotation - turn, scaleX: widthRatio * flipSign(from.flipHorizontal), scaleY: heightRatio * flipSign(from.flipVertical) }),
    incomingEnd: transformOf({ offsetX: 0, offsetY: 0, rotation: to.rotation, scaleX: flipSign(to.flipHorizontal), scaleY: flipSign(to.flipVertical) }),
    outgoingStart: transformOf({ offsetX: 0, offsetY: 0, rotation: from.rotation, scaleX: flipSign(from.flipHorizontal), scaleY: flipSign(from.flipVertical) }),
    outgoingEnd: transformOf({
      offsetX: -offsetX,
      offsetY: -offsetY,
      rotation: from.rotation + turn,
      scaleX: safeRatio(to.width, from.width) * flipSign(to.flipHorizontal),
      scaleY: safeRatio(to.height, from.height) * flipSign(to.flipVertical),
    }),
  };
}

/** The opacity a leaf is drawn at: the renderer's inline value (see the header), 1 when it sets none. */
export function ownOpacity(node: HTMLElement): number {
  const parsed = Number.parseFloat(node.style.opacity);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 1;
}

/** Signed degrees in (-180, 180] that turn `from` onto `to` the short way. */
export function shortestTurn(options: Readonly<{ from: number; to: number }>): number {
  const turn = (((options.to - options.from) % 360) + 540) % 360 - 180;
  return turn === -180 ? 180 : turn;
}

function transformOf(options: Readonly<{ offsetX: number; offsetY: number; rotation: number; scaleX: number; scaleY: number }>): string {
  return `translate(${round(options.offsetX)}px, ${round(options.offsetY)}px) rotate(${round(options.rotation)}deg) scale(${round(options.scaleX)}, ${round(options.scaleY)})`;
}

function safeRatio(numerator: number, denominator: number): number {
  // A line's frame can be zero thick; scaling a zero axis is meaningless, so it stays 1.
  if (denominator <= 0 || numerator <= 0) return 1;
  return numerator / denominator;
}

function flipSign(flipped: boolean): number {
  return flipped ? -1 : 1;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
