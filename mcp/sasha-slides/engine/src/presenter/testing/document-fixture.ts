// SMALL DOCUMENTS FOR THE PRESENTER'S TESTS AND DEMOS: a valid `DocumentSnapshot` from a list of
// slides described in a few fields, so a test says "three slides, the second skipped, the third
// pushes in" and nothing else. Ids pass through the contract's parse guards, never a bare cast.

import { DEFAULT_ANIMATION_DURATION_MILLISECONDS, type AnimationEffect, type AnimationStep, type AnimationTrigger } from "../../contracts/animations.ts";
import {
  scriptFingerprint,
  type BuiltinTransitionEffect,
  type DocumentSnapshot,
  type ElementSnapshot,
  type GroupElement,
  type LineElement,
  type ScriptPurpose,
  type SlideSnapshot,
  type SlideTransition,
  type TextBody,
  type TransitionScriptRecord,
} from "../../contracts/document.ts";
import type { Frame } from "../../contracts/geometry.ts";
import { isObjectId, parseAnimationStepId, parseElementId, parsePersonId, parseSlideId, type AnimationStepId, type ElementId, type SlideId, type TransitionScriptId } from "../../contracts/ids.ts";
import type { SerialisableObject } from "../../contracts/serialisable.ts";
import { literalColour, type HexadecimalColour } from "../../contracts/style.ts";
import { documentSnapshot, fixtureDeckId, lineElement, plainBody, plainTheme, requireParsed, SAMPLE_COLOURS, shapeElement, slideSnapshot } from "../../contracts/testing/snapshot-builders.ts";

export type FixtureElement = Readonly<{
  id: string;
  frame: Partial<Frame> & Readonly<{ x: number; y: number; width: number; height: number }>;
  /** Defaults to the id. */
  morphKey?: string;
  fill?: HexadecimalColour;
  text?: string;
}>;

export type FixtureSlide = Readonly<{
  id: string;
  skipped?: boolean;
  transition?: SlideTransition | null;
  elements?: readonly FixtureElement[];
  /** Elements built by hand (groups, lines), drawn above `elements`. */
  extraElements?: readonly ElementSnapshot[];
  animations?: readonly AnimationStep[];
  background?: HexadecimalColour;
  notes?: string;
}>;

export type FixtureScript = Readonly<{
  id: string;
  script: string;
  stylesheet?: string;
  markup?: string;
  approved: boolean;
  defaultParameters?: SerialisableObject;
  /** Defaults to "transition". */
  purpose?: ScriptPurpose;
}>;

export function fixtureDocument(options: Readonly<{ slides: readonly FixtureSlide[]; scripts?: readonly FixtureScript[]; revision?: number }>): DocumentSnapshot {
  return documentSnapshot({
    deckId: fixtureDeckId("deck_fixture"),
    title: "Fixture deck",
    theme: FIXTURE_THEME,
    slides: options.slides.map(fixtureSlide),
    transitionScripts: (options.scripts ?? []).map(fixtureScript),
    revision: options.revision ?? 1,
  });
}

export function fixtureSlide(slide: FixtureSlide): SlideSnapshot {
  return slideSnapshot({
    id: slideIdOf(slide.id),
    background: slide.background === undefined ? null : { kind: "solid", colour: literalColour({ hexadecimal: slide.background, alpha: 1 }) },
    skipped: slide.skipped ?? false,
    speakerNotes: textBodyOf(slide.notes ?? ""),
    transition: slide.transition ?? null,
    animations: slide.animations ?? [],
    elements: [...(slide.elements ?? []).map(fixtureShape), ...(slide.extraElements ?? [])],
  });
}

export function fixtureShape(element: FixtureElement): ElementSnapshot {
  return shapeElement({
    id: elementIdOf(element.id),
    frame: { rotation: 0, flipHorizontal: false, flipVertical: false, ...element.frame },
    morphKey: element.morphKey ?? element.id,
    style: { fill: element.fill === undefined ? { kind: "none" } : { kind: "solid", colour: literalColour({ hexadecimal: element.fill, alpha: 1 }) } },
    text: textBodyOf(element.text ?? ""),
  });
}

export function fixtureScript(script: FixtureScript): TransitionScriptRecord {
  const sources = { script: script.script, stylesheet: script.stylesheet ?? "", markup: script.markup ?? "", purpose: script.purpose ?? "transition" };
  const personId = parsePersonId("person_fixture");
  if (personId === null) throw new Error("fixture person id");
  return {
    id: scriptIdOf(script.id),
    name: script.id,
    description: "",
    author: { kind: "agent", name: "Claude", agentSessionId: "session_fixture" },
    ...sources,
    defaultParameters: script.defaultParameters ?? {},
    approval: script.approved ? { kind: "approved", approvedBy: personId, fingerprint: scriptFingerprint(sources) } : { kind: "unapproved" },
    updatedAt: 0,
  };
}

/** A line from `start` to `end`, 4 units wide, opaque. */
export function fixtureLine(options: Readonly<{ id: string; start: Readonly<{ x: number; y: number }>; end: Readonly<{ x: number; y: number }>; opacity?: number }>): LineElement {
  return {
    ...lineElement({
      id: elementIdOf(options.id),
      start: options.start,
      end: options.end,
      stroke: { width: 4, colour: literalColour({ hexadecimal: "#1c2333", alpha: 1 }), dash: "solid" },
      endArrow: "none",
    }),
    opacity: options.opacity ?? 1,
  };
}

/** A group of `children`; its frame is the children's bounds, unrotated. */
export function fixtureGroup(options: Readonly<{ id: string; children: readonly ElementSnapshot[] }>): GroupElement {
  const template = fixtureShape({ id: options.id, frame: { x: 0, y: 0, width: 1, height: 1 } });
  const left = Math.min(...options.children.map((child) => child.frame.x));
  const top = Math.min(...options.children.map((child) => child.frame.y));
  const right = Math.max(...options.children.map((child) => child.frame.x + child.frame.width));
  const bottom = Math.max(...options.children.map((child) => child.frame.y + child.frame.height));
  return { ...template, kind: "group", frame: { x: left, y: top, width: right - left, height: bottom - top, rotation: 0, flipHorizontal: false, flipVertical: false }, children: options.children };
}

/** A build step with the usual timing: on click, the default duration, no delay, ease in and out. */
export function animationStep(
  options: Readonly<{ id: string; elementId: string; effect: AnimationEffect; trigger?: AnimationTrigger; durationMilliseconds?: number; delayMilliseconds?: number; unsupportedKeys?: readonly string[] }>,
): AnimationStep {
  return {
    id: stepIdOf(options.id),
    elementId: elementIdOf(options.elementId),
    effect: options.effect,
    trigger: options.trigger ?? "onClick",
    durationMilliseconds: options.durationMilliseconds ?? DEFAULT_ANIMATION_DURATION_MILLISECONDS,
    delayMilliseconds: options.delayMilliseconds ?? 0,
    easing: "easeInOut",
    unsupportedKeys: options.unsupportedKeys ?? [],
  };
}

export function builtinTransition(effect: BuiltinTransitionEffect, durationMilliseconds = 600): SlideTransition {
  return { kind: "builtin", effect, durationMilliseconds, easing: "easeInOut" };
}

export function scriptedTransition(scriptId: string, durationMilliseconds = 1000, parameters: SerialisableObject = {}): SlideTransition {
  return { kind: "scripted", scriptId: scriptIdOf(scriptId), durationMilliseconds, parameters };
}

export function slideIdOf(text: string): SlideId {
  return requireParsed(parseSlideId, text);
}

export function elementIdOf(text: string): ElementId {
  return requireParsed(parseElementId, text);
}

export function scriptIdOf(text: string): TransitionScriptId {
  if (!isObjectId(text)) throw new Error(`Not a valid fixture script id: ${text}`);
  // The pattern check above is the runtime invariant the brand records (contracts/ids.ts).
  return text as TransitionScriptId;
}

export function stepIdOf(text: string): AnimationStepId {
  return requireParsed(parseAnimationStepId, text);
}

export function textBodyOf(text: string): TextBody {
  return plainBody(text);
}

const FIXTURE_THEME = plainTheme({ colours: SAMPLE_COLOURS });
