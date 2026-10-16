// SMALL DOCUMENTS FOR THE PRESENTER'S TESTS AND DEMOS: a valid `DocumentSnapshot` from a list of
// slides described in a few fields, so a test says "three slides, the second skipped, the third
// pushes in" and nothing else. Ids pass through the contract's parse guards, never a bare cast.

import { DEFAULT_ANIMATION_DURATION_MILLISECONDS, type AnimationEffect, type AnimationStep, type AnimationTrigger } from "../../contracts/animations.ts";
import {
  scriptFingerprint,
  type BuiltinTransitionEffect,
  type DocumentSnapshot,
  type ElementSnapshot,
  type PlaceholderRole,
  type PlaceholderStyle,
  type GroupElement,
  type LineElement,
  type ScriptPurpose,
  type ShapeElement,
  type SlideSnapshot,
  type SlideTransition,
  type TextBody,
  type ThemeSnapshot,
  type TransitionScriptRecord,
} from "../../contracts/document.ts";
import type { Frame } from "../../contracts/geometry.ts";
import { isObjectId, parseAnimationStepId, parseElementId, parsePersonId, parseSlideId, type AnimationStepId, type DeckId, type ElementId, type SlideId, type TransitionScriptId } from "../../contracts/ids.ts";
import type { SerialisableObject } from "../../contracts/serialisable.ts";
import { DEFAULT_TEXT_BOX_STYLE, PLAIN_BOX_STYLE, literalColour, type HexadecimalColour, type ThemeColourSlot } from "../../contracts/style.ts";

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
  return {
    deckId: fixtureDeckId("deck_fixture"),
    schemaVersion: 1,
    revision: options.revision ?? 1,
    title: "Fixture deck",
    pageSize: { width: 1280, height: 720 },
    theme: FIXTURE_THEME,
    layouts: [],
    slides: options.slides.map(fixtureSlide),
    assets: [],
    transitionScripts: (options.scripts ?? []).map(fixtureScript),
  };
}

export function fixtureSlide(slide: FixtureSlide): SlideSnapshot {
  return {
    id: slideIdOf(slide.id),
    layoutId: null,
    background: slide.background === undefined ? null : { kind: "solid", colour: literalColour({ hexadecimal: slide.background, alpha: 1 }) },
    skipped: slide.skipped ?? false,
    speakerNotes: textBodyOf(slide.notes ?? ""),
    transition: slide.transition ?? null,
    animations: slide.animations ?? [],
    elements: [...(slide.elements ?? []).map(fixtureShape), ...(slide.extraElements ?? [])],
  };
}

export function fixtureShape(element: FixtureElement): ElementSnapshot {
  const shape: ShapeElement = {
    kind: "shape",
    id: elementIdOf(element.id),
    name: "",
    description: "",
    frame: { rotation: 0, flipHorizontal: false, flipVertical: false, ...element.frame },
    groupId: null,
    morphKey: element.morphKey ?? element.id,
    placeholder: null,
    unsupportedKeys: [],
    preset: "rectangle",
    customOutline: null,
    box: { ...PLAIN_BOX_STYLE, fill: element.fill === undefined ? { kind: "none" } : { kind: "solid", colour: literalColour({ hexadecimal: element.fill, alpha: 1 }) } },
    textBox: DEFAULT_TEXT_BOX_STYLE,
    text: textBodyOf(element.text ?? ""),
  };
  return shape;
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
  const template = fixtureShape({ id: options.id, frame: { x: 0, y: 0, width: 1, height: 1 } });
  const left = Math.min(options.start.x, options.end.x);
  const top = Math.min(options.start.y, options.end.y);
  return {
    kind: "line",
    id: template.id,
    name: "",
    description: "",
    frame: { x: left, y: top, width: Math.abs(options.end.x - options.start.x), height: Math.abs(options.end.y - options.start.y), rotation: 0, flipHorizontal: false, flipVertical: false },
    groupId: null,
    morphKey: template.morphKey,
    placeholder: null,
    unsupportedKeys: [],
    start: options.start,
    end: options.end,
    routing: "straight",
    stroke: { width: 4, colour: literalColour({ hexadecimal: "#1c2333", alpha: 1 }), dash: "solid" },
    startArrow: "none",
    endArrow: "none",
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
  const id = parseSlideId(text);
  if (id === null) throw new Error(`Not a valid fixture slide id: ${text}`);
  return id;
}

export function elementIdOf(text: string): ElementId {
  const id = parseElementId(text);
  if (id === null) throw new Error(`Not a valid fixture element id: ${text}`);
  return id;
}

export function scriptIdOf(text: string): TransitionScriptId {
  if (!isObjectId(text)) throw new Error(`Not a valid fixture script id: ${text}`);
  // The pattern check above is the runtime invariant the brand records (contracts/ids.ts).
  return text as TransitionScriptId;
}

export function stepIdOf(text: string): AnimationStepId {
  const id = parseAnimationStepId(text);
  if (id === null) throw new Error(`Not a valid fixture step id: ${text}`);
  return id;
}

export function textBodyOf(text: string): TextBody {
  return { paragraphs: text.split("\n").map((line) => ({ style: {}, runs: line === "" ? [] : [{ kind: "text", text: line, style: {} }] })) };
}

function fixtureDeckId(text: string): DeckId {
  if (!isObjectId(text)) throw new Error(`Not a valid fixture deck id: ${text}`);
  // The pattern check above is the runtime invariant the brand records (contracts/ids.ts).
  return text as DeckId;
}

const EMPTY_PLACEHOLDER_STYLE: PlaceholderStyle = { run: {}, paragraph: {}, textBox: {} };

const PLACEHOLDER_STYLES: Readonly<Record<PlaceholderRole, PlaceholderStyle>> = {
  title: EMPTY_PLACEHOLDER_STYLE,
  centredTitle: EMPTY_PLACEHOLDER_STYLE,
  subtitle: EMPTY_PLACEHOLDER_STYLE,
  body: EMPTY_PLACEHOLDER_STYLE,
  slideNumber: EMPTY_PLACEHOLDER_STYLE,
  footer: EMPTY_PLACEHOLDER_STYLE,
  date: EMPTY_PLACEHOLDER_STYLE,
  picture: EMPTY_PLACEHOLDER_STYLE,
};

const FIXTURE_COLOURS: Readonly<Record<ThemeColourSlot, HexadecimalColour>> = {
  dark1: "#1c2333",
  light1: "#ffffff",
  dark2: "#3d4659",
  light2: "#eef1f6",
  accent1: "#4338ca",
  accent2: "#0e7490",
  accent3: "#be185d",
  accent4: "#047857",
  accent5: "#b45309",
  accent6: "#7c3aed",
  hyperlink: "#4338ca",
  followedHyperlink: "#7c3aed",
};

const FIXTURE_THEME: ThemeSnapshot = {
  name: "Fixture",
  colours: FIXTURE_COLOURS,
  headingFontFamily: "Manrope",
  bodyFontFamily: "Manrope",
  background: { kind: "solid", colour: literalColour({ hexadecimal: "#ffffff", alpha: 1 }) },
  placeholderStyles: PLACEHOLDER_STYLES,
  defaultRunStyle: {
    fontFamily: "Manrope",
    fontSize: 32,
    fontWeight: 400,
    fontStyle: "normal",
    underline: false,
    strikethrough: false,
    colour: literalColour({ hexadecimal: "#1c2333", alpha: 1 }),
    highlight: { kind: "none" },
    link: { kind: "none" },
    baselineOffset: "none",
    letterSpacing: 0,
    textCase: "none",
  },
};
