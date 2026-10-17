/**
 * THE TRUST BOUNDARY OF CLAUDE'S DECK TOOLS: zod schemas for every tool's input, producing the
 * contract types (assistant-deck-tools.ts, style.ts, commands.ts) with branded ids. The MCP SDK
 * parses each call's arguments with these before a handler runs, and publishes their INPUT side as
 * the tools' JSON schema, so what a model sees is what is checked.
 *
 * Choices that keep the published schema small enough to live in a model's context on every
 * `tools/list`:
 *
 *  - Defaults live here (a paragraph's style, a frame's rotation, a colour's alpha), so a model
 *    writes only what it means; defaults that depend on the deck (an omitted frame) stay null and
 *    are filled in by the expansion (edit-expansion.ts).
 *  - A paragraph may be a plain string.
 *  - `raw` commands are checked for a known `kind` only. Their full shape is the whole of
 *    commands.ts and document.ts, which would multiply the schema many times over for an escape
 *    hatch; the model validates every value of every command before writing anything
 *    (engine/src/model/command-validation.ts), and a malformed one comes back as a rejection.
 */
import { z } from "zod";
import { ANIMATION_EDGES, ANIMATION_LIMITS, ANIMATION_TRIGGERS, DEFAULT_ANIMATION_DURATION_MILLISECONDS, type ScriptedAnimationCategory } from "../engine/src/contracts/animations.ts";
import type { AssistantParagraph } from "../engine/src/contracts/assistant-deck-tools.ts";
import type { DocumentCommand, DocumentCommandKind } from "../engine/src/contracts/commands.ts";
import type { TransitionEasing } from "../engine/src/contracts/document.ts";
import { COLLABORATION_LIMITS } from "../engine/src/contracts/collaboration.ts";
import {
  parseAnimationStepId,
  parseAssetId,
  parseDeckId,
  parseElementId,
  parseLayoutId,
  parseListId,
  parseSlideId,
  parseThreadId,
  parseTransitionScriptId,
} from "../engine/src/contracts/ids.ts";
import { THEME_COLOUR_SLOTS, type ArrowHead, type DashStyle, type ListGlyph } from "../engine/src/contracts/style.ts";
import { TRANSITION_LIMITS } from "../engine/src/contracts/transition-limits.ts";
import { SHAPE_PRESETS } from "../engine/src/model/stored-values.ts";
import type { AssistantEditRequest } from "./assistant-edit-request.ts";

// --- identifiers -------------------------------------------------------------------------------

export const deckIdSchema = brandedId({ parse: parseDeckId, label: "deck id (dk_...)" });
export const slideIdSchema = brandedId({ parse: parseSlideId, label: "slide id" });
export const elementIdSchema = brandedId({ parse: parseElementId, label: "element id" });
export const layoutIdSchema = brandedId({ parse: parseLayoutId, label: "layout id" });
export const threadIdSchema = brandedId({ parse: parseThreadId, label: "thread id" });
export const transitionScriptIdSchema = brandedId({ parse: parseTransitionScriptId, label: "transition script id" });
const assetIdSchema = brandedId({ parse: parseAssetId, label: "asset id (64 lowercase hexadecimal)" });
const listIdSchema = brandedId({ parse: parseListId, label: "list id" });
const animationStepIdSchema = brandedId({ parse: parseAnimationStepId, label: "build step id" });

// --- style values (style.ts) --------------------------------------------------------------------

const alphaSchema = z.number().min(0).max(1).default(1);

export const colourSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    hexadecimal: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/u, "a colour is #rrggbb")
      .transform((value) => value.toLowerCase()),
    alpha: alphaSchema,
  }),
  z.object({ kind: z.literal("theme"), slot: z.enum(THEME_COLOUR_SLOTS), alpha: alphaSchema }),
]).meta({ id: "SashaColour" });

const gradientStopsSchema = z.array(z.object({ colour: colourSchema, offset: z.number().min(0).max(1) })).min(2).max(10);

export const fillSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("solid"), colour: colourSchema }),
  z.object({ kind: z.literal("linearGradient"), angle: z.number(), stops: gradientStopsSchema }),
  z.object({ kind: z.literal("radialGradient"), centreX: z.number().min(0).max(1), centreY: z.number().min(0).max(1), stops: gradientStopsSchema }),
  z.object({ kind: z.literal("image"), assetId: assetIdSchema, fit: z.enum(["cover", "contain", "stretch", "tile"]), opacity: z.number().min(0).max(1).default(1) }),
]).meta({ id: "SashaFill" });

const DASH_STYLE_VALUES = ["solid", "dot", "dash", "dashDot", "longDash", "longDashDot"] as const satisfies readonly DashStyle[];

const strokeSchema = z.object({ width: z.number().min(0).max(200), colour: colourSchema, dash: z.enum(DASH_STYLE_VALUES).default("solid") }).meta({ id: "SashaStroke" });

const strokePatchSchema = z.object({
  width: z.number().min(0).max(200).exactOptional(),
  colour: colourSchema.exactOptional(),
  dash: z.enum(DASH_STYLE_VALUES).exactOptional(),
}).meta({ id: "SashaStrokePatch" });

const borderPatchSchema = z.union([
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("perSide"), top: strokeSchema.nullable(), right: strokeSchema.nullable(), bottom: strokeSchema.nullable(), left: strokeSchema.nullable() }),
  z.object({ kind: z.literal("uniform").exactOptional(), stroke: strokePatchSchema.exactOptional() }),
]);

const cornerRadiusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uniform"), radius: z.number().min(0) }),
  z.object({ kind: z.literal("perCorner"), topLeft: z.number().min(0), topRight: z.number().min(0), bottomRight: z.number().min(0), bottomLeft: z.number().min(0) }),
]);

const shadowPatchSchema = z.object({
  offsetX: z.number().exactOptional(),
  offsetY: z.number().exactOptional(),
  blur: z.number().min(0).exactOptional(),
  spread: z.number().exactOptional(),
  colour: colourSchema.exactOptional(),
});

const textBoxPatchSchema = z.object({
  verticalAlignment: z.enum(["top", "middle", "bottom"]).exactOptional(),
  paddingTop: z.number().min(0).exactOptional(),
  paddingRight: z.number().min(0).exactOptional(),
  paddingBottom: z.number().min(0).exactOptional(),
  paddingLeft: z.number().min(0).exactOptional(),
  autofit: z.enum(["none", "shrinkText", "resizeShape"]).exactOptional(),
  wrap: z.boolean().exactOptional(),
});

const ARROW_HEAD_VALUES = ["none", "triangle", "openArrow", "stealth", "diamond", "oval", "bar"] as const satisfies readonly ArrowHead[];

/** `AssistantStylePatch`: everything optional, grouped values partial (assistant-edit-request.ts). */
export const stylePatchSchema = z
  .object({
    name: z.string().max(200).exactOptional(),
    description: z.string().max(2000).exactOptional(),
    morphKey: z.string().max(200).exactOptional(),
    fill: fillSchema.exactOptional(),
    border: borderPatchSchema.exactOptional(),
    cornerRadius: cornerRadiusSchema.exactOptional(),
    shadow: shadowPatchSchema.nullable().exactOptional(),
    opacity: z.number().min(0).max(1).exactOptional(),
    textBox: textBoxPatchSchema.exactOptional(),
    preset: z.enum(SHAPE_PRESETS).exactOptional(),
    crop: z
      .object({ left: z.number().min(0).max(1).exactOptional(), top: z.number().min(0).max(1).exactOptional(), right: z.number().min(0).max(1).exactOptional(), bottom: z.number().min(0).max(1).exactOptional() })
      .exactOptional(),
    stroke: strokePatchSchema.exactOptional(),
    startArrow: z.enum(ARROW_HEAD_VALUES).exactOptional(),
    endArrow: z.enum(ARROW_HEAD_VALUES).exactOptional(),
    routing: z.enum(["straight", "elbow", "curved"]).exactOptional(),
  })
  .meta({
    id: "SashaStylePatch",
    description: "Only what changes. Grouped values merge per element: {border:{stroke:{width:4}}} keeps each element's border colour. Sizes in slide units (1280 wide).",
  });

const runLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("webAddress"), address: z.string().url() }),
  z.object({ kind: z.literal("slide"), slideId: slideIdSchema }),
]);

export const runStylePatchSchema = z.object({
  fontFamily: z.string().min(1).max(100).exactOptional(),
  fontSize: z.number().positive().max(2000).exactOptional().describe("Slide units: 32 is 18 point."),
  fontWeight: z.number().int().min(100).max(900).exactOptional(),
  fontStyle: z.enum(["normal", "italic"]).exactOptional(),
  underline: z.boolean().exactOptional(),
  strikethrough: z.boolean().exactOptional(),
  colour: colourSchema.exactOptional(),
  highlight: z.union([colourSchema, z.object({ kind: z.literal("none") })]).exactOptional(),
  link: runLinkSchema.exactOptional(),
  baselineOffset: z.enum(["none", "superscript", "subscript"]).exactOptional(),
  letterSpacing: z.number().exactOptional(),
  textCase: z.enum(["none", "smallCaps", "allCaps"]).exactOptional(),
}).meta({ id: "SashaRunStyle" });

const LIST_GLYPH_VALUES = [
  "disc",
  "circle",
  "square",
  "arrow",
  "star",
  "checkbox",
  "decimal",
  "decimalZeroPadded",
  "upperAlphabetic",
  "lowerAlphabetic",
  "upperRoman",
  "lowerRoman",
] as const satisfies readonly ListGlyph[];

export const paragraphStylePatchSchema = z.object({
  alignment: z.enum(["start", "centre", "end", "justify"]).exactOptional(),
  lineSpacing: z.number().positive().max(10).exactOptional(),
  spaceAbove: z.number().min(0).exactOptional(),
  spaceBelow: z.number().min(0).exactOptional(),
  indentStart: z.number().min(0).exactOptional(),
  indentFirstLine: z.number().exactOptional(),
  direction: z.enum(["leftToRight", "rightToLeft"]).exactOptional(),
  list: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("list"), listId: listIdSchema.describe("Paragraphs sharing a list id number together, e.g. ls_points01."), glyph: z.enum(LIST_GLYPH_VALUES), level: z.number().int().min(0).max(8).default(0) }),
      z.object({ kind: z.literal("none") }),
    ])
    .exactOptional(),
}).meta({ id: "SashaParagraphStyle" });

const paragraphObjectSchema = z.object({
  text: z.string().max(100_000).refine((text) => !text.includes("\n"), "one paragraph per entry: a paragraph's text has no line breaks"),
  style: paragraphStylePatchSchema.default({}),
  runs: z
    .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0), style: runStylePatchSchema }))
    .default([])
    .describe("Styled stretches of `text` by character offset [start, end); unstyled text inherits the placeholder and theme."),
});

/** A paragraph, or a plain string for an unstyled one. */
export const paragraphSchema = z
  .union([z.string().max(100_000), paragraphObjectSchema])
  .meta({ id: "SashaParagraph", description: "A paragraph, or a plain string for an unstyled one." })
  .transform((value, context): AssistantParagraph => {
  if (typeof value !== "string") return value;
  if (value.includes("\n")) {
    context.addIssue({ code: "custom", message: "one paragraph per entry: a paragraph's text has no line breaks" });
    return z.NEVER;
  }
  return { text: value, style: {}, runs: [] };
});

const paragraphsSchema = z.array(paragraphSchema).max(1000).meta({ id: "SashaParagraphs" });

// --- geometry -----------------------------------------------------------------------------------

const pointSchema = z.object({ x: z.number(), y: z.number() }).meta({ id: "SashaPoint" });

export const assistantFrameSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), rotation: z.number().default(0) })
  .meta({ id: "SashaFrame", description: "Slide units: the slide is 1280 wide and (usually) 720 tall; x/y is the top-left corner." });

const partialFrameSchema = z.object({
  x: z.number().exactOptional(),
  y: z.number().exactOptional(),
  width: z.number().positive().exactOptional(),
  height: z.number().positive().exactOptional(),
  rotation: z.number().exactOptional(),
});

// --- slides -------------------------------------------------------------------------------------


const placeholderTextSchema = z.object({
  title: paragraphsSchema.exactOptional(),
  centredTitle: paragraphsSchema.exactOptional(),
  subtitle: paragraphsSchema.exactOptional(),
  body: paragraphsSchema.exactOptional(),
  slideNumber: paragraphsSchema.exactOptional(),
  footer: paragraphsSchema.exactOptional(),
  date: paragraphsSchema.exactOptional(),
  picture: paragraphsSchema.exactOptional(),
});

const serialisableObjectSchema = z.record(z.string(), z.json());

const slideDirectionSchema = z.enum(["fromLeft", "fromRight", "fromTop", "fromBottom"]);

const slideTransitionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("builtin"),
    effect: z.discriminatedUnion("effect", [
      z.object({ effect: z.literal("fade") }),
      z.object({ effect: z.literal("push"), direction: slideDirectionSchema }),
      z.object({ effect: z.literal("slide"), direction: slideDirectionSchema, mode: z.enum(["cover", "uncover"]) }),
      z.object({ effect: z.literal("zoom"), mode: z.enum(["in", "out"]) }),
      z.object({ effect: z.literal("morph") }),
    ]),
    durationMilliseconds: z.number().min(0).max(TRANSITION_LIMITS.maximumDurationMilliseconds),
    easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]).default("easeInOut"),
  }),
  z.object({
    kind: z.literal("scripted"),
    scriptId: transitionScriptIdSchema,
    durationMilliseconds: z.number().min(0).max(TRANSITION_LIMITS.maximumDurationMilliseconds),
    parameters: serialisableObjectSchema.default({}),
  }),
]).meta({ id: "SashaSlideTransition" });

const slidePropertiesPatchSchema = z.object({
  background: fillSchema.nullable().exactOptional(),
  skipped: z.boolean().exactOptional(),
  transition: slideTransitionSchema.nullable().exactOptional(),
  layoutId: layoutIdSchema.nullable().exactOptional(),
});

// --- builds (animations.ts) -------------------------------------------------------------------

const SCRIPTED_CATEGORY_VALUES = ["entrance", "emphasis", "exit"] as const satisfies readonly ScriptedAnimationCategory[];
const EASING_VALUES = ["linear", "easeIn", "easeOut", "easeInOut"] as const satisfies readonly TransitionEasing[];

const motionOffsetSchema = z.number().min(-ANIMATION_LIMITS.maximumMotionOffset).max(ANIMATION_LIMITS.maximumMotionOffset);

/** Every effect of `AnimationEffect` with its options; omitted options take `defaultAnimationEffect`'s values. */
export const animationEffectSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("appear") }),
    z.object({ kind: z.literal("fadeIn") }),
    z.object({ kind: z.literal("flyIn"), from: z.enum(ANIMATION_EDGES).default("left") }),
    z.object({ kind: z.literal("zoomIn") }),
    z.object({ kind: z.literal("floatIn") }),
    z.object({ kind: z.literal("wipe"), from: z.enum(ANIMATION_EDGES).default("left") }),
    z.object({ kind: z.literal("pulse") }),
    z.object({ kind: z.literal("growShrink"), scale: z.number().min(ANIMATION_LIMITS.minimumScale).max(ANIMATION_LIMITS.maximumScale).default(1.5).describe("Ends this many times its size.") }),
    z.object({
      kind: z.literal("spin"),
      degrees: z.number().min(-ANIMATION_LIMITS.maximumSpinDegrees).max(ANIMATION_LIMITS.maximumSpinDegrees).default(360).describe("Positive is clockwise; 360 is one turn."),
    }),
    z.object({ kind: z.literal("colourChange"), colour: colourSchema, part: z.enum(["fill", "text"]).default("fill") }),
    z.object({ kind: z.literal("disappear") }),
    z.object({ kind: z.literal("fadeOut") }),
    z.object({ kind: z.literal("flyOut"), to: z.enum(ANIMATION_EDGES).default("right") }),
    z.object({ kind: z.literal("zoomOut") }),
    z.object({ kind: z.literal("motionPath"), offsetX: motionOffsetSchema, offsetY: motionOffsetSchema }).describe("A straight move by the offset, in slide units."),
    z.object({
      kind: z.literal("scripted"),
      scriptId: transitionScriptIdSchema.describe("An animation script of this deck (deck_write_animation writes one)."),
      category: z.enum(SCRIPTED_CATEGORY_VALUES).describe("Where the element rests: entrance shown, exit hidden, emphasis unchanged."),
      parameters: serialisableObjectSchema.default({}),
    }),
  ])
  .meta({
    id: "SashaAnimationEffect",
    description:
      "Entrances (appear, fadeIn, flyIn, zoomIn, floatIn, wipe) hide the element until the step runs; emphasis (pulse, growShrink, spin, colourChange) " +
      "changes it; exits (disappear, fadeOut, flyOut, zoomOut) hide it after; motionPath moves it.",
  });

const animationTriggerSchema = z.enum(ANIMATION_TRIGGERS).describe("onClick: the presenter's next click; withPrevious: together with the step before; afterPrevious: when it ends.");
const animationDurationSchema = z.number().min(0).max(ANIMATION_LIMITS.maximumDurationMilliseconds);
const animationDelaySchema = z.number().min(0).max(ANIMATION_LIMITS.maximumDelayMilliseconds);

const assistantAnimationStepSchema = z
  .object({
    elementId: elementIdSchema.describe("The element (or group) it animates; may be one added earlier in the same call."),
    effect: animationEffectSchema,
    trigger: animationTriggerSchema.default("onClick"),
    durationMilliseconds: animationDurationSchema.default(DEFAULT_ANIMATION_DURATION_MILLISECONDS),
    delayMilliseconds: animationDelaySchema.default(0),
    easing: z.enum(EASING_VALUES).default("easeOut"),
  })
  .meta({ id: "SashaAnimationStep" });

const animationStepPatchSchema = z.object({
  elementId: elementIdSchema.exactOptional(),
  effect: animationEffectSchema.exactOptional(),
  trigger: animationTriggerSchema.exactOptional(),
  durationMilliseconds: animationDurationSchema.exactOptional(),
  delayMilliseconds: animationDelaySchema.exactOptional(),
  easing: z.enum(EASING_VALUES).exactOptional(),
});

const animationStepIdsSchema = z.array(animationStepIdSchema).min(1).max(ANIMATION_LIMITS.maximumStepsPerSlide);

// --- the edits ----------------------------------------------------------------------------------

const DOCUMENT_COMMAND_KIND_TABLE: Readonly<Record<DocumentCommandKind, true>> = {
  setTitle: true,
  updateTheme: true,
  upsertLayout: true,
  deleteLayout: true,
  registerAsset: true,
  upsertTransitionScript: true,
  deleteTransitionScript: true,
  approveTransitionScript: true,
  insertSlides: true,
  deleteSlides: true,
  moveSlides: true,
  setSlideProperties: true,
  insertElements: true,
  deleteElements: true,
  setFrames: true,
  updateElements: true,
  reorderElements: true,
  groupElements: true,
  ungroupElements: true,
  editText: true,
  insertTableRows: true,
  insertTableColumns: true,
  deleteTableRows: true,
  deleteTableColumns: true,
  setTableColumnWidths: true,
  setTableRowHeights: true,
  updateTableCells: true,
  insertAnimationSteps: true,
  updateAnimationSteps: true,
  moveAnimationSteps: true,
  deleteAnimationSteps: true,
};

// `Object.keys` widens to string[]; the record above has exactly the DocumentCommandKind keys.
const DOCUMENT_COMMAND_KINDS = Object.keys(DOCUMENT_COMMAND_KIND_TABLE) as [DocumentCommandKind, ...DocumentCommandKind[]];

const rawCommandSchema = z
  .object({ kind: z.enum(DOCUMENT_COMMAND_KINDS) })
  .passthrough()
  .transform(
    (command): DocumentCommand =>
      // Only `kind` is checked here (see the header): the model validates every field of every
      // command against the document before writing, and rejects the whole envelope otherwise.
      command as unknown as DocumentCommand,
  );

const newElementIdSchema = elementIdSchema.nullable().default(null).describe("Optional: choose the new element's id (e.g. el_pricingCard1) to address it in later edits of this call.");
const reorderPlacementSchema = z.enum(["front", "forward", "backward", "back"]);

const assistantEditSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("addSlide"),
    id: slideIdSchema.nullable().default(null).describe("Optional: choose the new slide's id (e.g. sl_pricing01) to address it in later edits of this call."),
    after: slideIdSchema.nullable().default(null).describe("Insert after this slide; null: at the end."),
    layoutId: layoutIdSchema.nullable().default(null).describe("null: the first layout (after the title slide's) that has every placeholder you fill."),
    placeholderText: placeholderTextSchema.default({}),
    background: fillSchema.nullable().default(null),
    speakerNotes: z.string().max(100_000).default(""),
  }),
  z.object({ kind: z.literal("deleteSlides"), slideIds: z.array(slideIdSchema).min(1) }),
  z.object({ kind: z.literal("moveSlides"), slideIds: z.array(slideIdSchema).min(1), after: slideIdSchema.nullable().describe("Move to just after this slide; null: to the start.") }),
  z.object({ kind: z.literal("setSlide"), slideId: slideIdSchema, patch: slidePropertiesPatchSchema.default({}), speakerNotes: z.string().max(100_000).nullable().default(null) }),
  z.object({
    kind: z.literal("addShape"),
    id: newElementIdSchema,
    slideId: slideIdSchema,
    preset: z.enum(SHAPE_PRESETS).default("textBox"),
    frame: assistantFrameSchema.nullable().default(null),
    style: stylePatchSchema.default({}),
    text: paragraphsSchema.default([]),
    name: z.string().max(200).default(""),
  }),
  z.object({ kind: z.literal("addLine"), id: newElementIdSchema, slideId: slideIdSchema, start: pointSchema, end: pointSchema, style: stylePatchSchema.default({}), name: z.string().max(200).default("") }),
  z.object({
    kind: z.literal("addImage"),
    id: newElementIdSchema,
    slideId: slideIdSchema,
    source: z.string().max(4096).describe("An https address the server fetches: PNG, JPEG, GIF, WebP or SVG, at most 25 megabytes."),
    frame: assistantFrameSchema.nullable().default(null),
    description: z.string().max(2000).default("").describe("Alternative text."),
  }),
  z.object({
    kind: z.literal("addTable"),
    id: newElementIdSchema,
    slideId: slideIdSchema,
    frame: assistantFrameSchema.nullable().default(null),
    cells: z.array(z.array(z.string().max(10_000)).min(1).max(30)).min(1).max(60).describe("Rows of cell texts."),
    headerRow: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("moveElements"), slideId: slideIdSchema, moves: z.array(z.object({ elementId: elementIdSchema, frame: partialFrameSchema })).min(1) }),
  z.object({ kind: z.literal("restyleElements"), slideId: slideIdSchema, elementIds: z.array(elementIdSchema).min(1), patch: stylePatchSchema }),
  z.object({
    kind: z.literal("setText"),
    slideId: slideIdSchema,
    elementId: elementIdSchema,
    cell: z.object({ row: z.number().int().min(0), column: z.number().int().min(0) }).nullable().default(null).describe("For a table: the cell, 0-based."),
    paragraphs: paragraphsSchema,
  }),
  z.object({
    kind: z.literal("replaceText"),
    slideId: slideIdSchema,
    elementId: elementIdSchema,
    find: z.string().min(1).max(10_000),
    replaceWith: z.string().max(100_000),
    all: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("styleText"),
    slideId: slideIdSchema,
    elementId: elementIdSchema,
    find: z.string().min(1).max(10_000).describe("The first occurrence is styled."),
    run: runStylePatchSchema.default({}),
    paragraph: paragraphStylePatchSchema.default({}),
  }),
  z.object({ kind: z.literal("deleteElements"), slideId: slideIdSchema, elementIds: z.array(elementIdSchema).min(1) }),
  z.object({ kind: z.literal("reorderElements"), slideId: slideIdSchema, elementIds: z.array(elementIdSchema).min(1), placement: reorderPlacementSchema }),
  z.object({ kind: z.literal("groupElements"), id: newElementIdSchema, slideId: slideIdSchema, elementIds: z.array(elementIdSchema).min(2) }),
  z.object({ kind: z.literal("setTitle"), title: z.string().min(1).max(500) }),
  z.object({
    kind: z.literal("addAnimations"),
    slideId: slideIdSchema,
    after: animationStepIdSchema.nullable().default(null).describe("After this build step; null: at the end of the slide's sequence."),
    steps: z.array(assistantAnimationStepSchema).min(1).max(ANIMATION_LIMITS.maximumStepsPerSlide).describe("Played in this order; the answer reports their ids."),
  }),
  z.object({ kind: z.literal("updateAnimations"), slideId: slideIdSchema, stepIds: animationStepIdsSchema, patch: animationStepPatchSchema }),
  z.object({
    kind: z.literal("moveAnimations"),
    slideId: slideIdSchema,
    stepIds: animationStepIdsSchema,
    after: animationStepIdSchema.nullable().describe("Move to just after this step; null: to the start of the sequence."),
  }),
  z.object({ kind: z.literal("removeAnimations"), slideId: slideIdSchema, stepIds: animationStepIdsSchema }),
  z.object({ kind: z.literal("raw"), commands: z.array(rawCommandSchema).min(1).describe("Escape hatch: DocumentCommands exactly as the engine's commands.ts defines them.") }),
]);

/** Proof that a parsed edit is the request type the expansion takes (assistant-edit-request.ts). */
export function parsedEditRequest(edit: z.output<typeof assistantEditSchema>): AssistantEditRequest {
  return edit;
}

// --- the tools' input shapes (registerTool takes the object's shape) ---------------------------

export const DECK_LIST_INPUT = {};

export const DECK_CREATE_INPUT = { title: z.string().min(1).max(500).describe("The deck's title.") };

export const DECK_READ_INPUT = {
  deckId: deckIdSchema,
  detail: z.enum(["outline", "full"]).default("outline").describe("outline: ids, frames and plain text. full: also the complete slide values of `slideIds`."),
  slideIds: z.array(slideIdSchema).max(200).default([]).describe("For detail full: which slides (empty: all)."),
};

export const DECK_EDIT_INPUT = {
  deckId: deckIdSchema,
  summary: z.string().min(1).max(300).describe("One sentence collaborators see, e.g. 'added a pricing slide'."),
  edits: z
    .array(assistantEditSchema)
    .min(1)
    .max(COLLABORATION_LIMITS.maximumCommandsPerAgentApply)
    .describe("Applied together as ONE undo step, all or nothing; read the deck first for ids."),
};

export const DECK_WRITE_TRANSITION_INPUT = {
  deckId: deckIdSchema,
  scriptId: transitionScriptIdSchema.nullable().default(null).describe("null: a new script; an id: replace that script."),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  script: z.string().min(1).describe("JavaScript calling sashaTransition.define(...); at most 256 kilobytes."),
  stylesheet: z.string().default(""),
  markup: z.string().default(""),
  defaultParameters: serialisableObjectSchema.default({}),
  assignTo: z
    .array(z.object({ slideId: slideIdSchema, durationMilliseconds: z.number().min(0).max(TRANSITION_LIMITS.maximumDurationMilliseconds).default(1000) }))
    .max(500)
    .default([])
    .describe("Slides whose transition (into them) becomes this script."),
};

export const DECK_WRITE_ANIMATION_INPUT = {
  deckId: deckIdSchema,
  scriptId: transitionScriptIdSchema.nullable().default(null).describe("null: a new script; an id: replace that animation script."),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  script: z.string().min(1).describe("JavaScript calling sashaTransition.define(...); at most 256 kilobytes."),
  stylesheet: z.string().default(""),
  markup: z.string().default(""),
  defaultParameters: serialisableObjectSchema.default({}),
  assignTo: z
    .array(
      z.object({
        slideId: slideIdSchema,
        elementId: elementIdSchema.describe("The element the step animates (context.parameters.targetElementId)."),
        category: z.enum(SCRIPTED_CATEGORY_VALUES).describe("Where the element rests after the step: entrance shown, exit hidden, emphasis unchanged."),
        trigger: animationTriggerSchema.default("onClick"),
        durationMilliseconds: animationDurationSchema.default(1000),
      }),
    )
    .max(ANIMATION_LIMITS.maximumStepsPerSlide)
    .default([])
    .describe("Build steps appended to these slides' sequences, one per entry, each running this script on its element."),
};

export const DECK_REVERT_INPUT = {
  deckId: deckIdSchema,
  agentSessionId: z.string().min(1).max(100).exactOptional().describe("Whose edits to undo; omitted: this session's."),
};

export const DECK_READ_COMMENTS_INPUT = {
  deckId: deckIdSchema,
  status: z.enum(["open", "all"]).default("open"),
  slideId: slideIdSchema.nullable().default(null).describe("Only this slide's threads; null: every slide."),
};

export const DECK_REPLY_COMMENT_INPUT = {
  deckId: deckIdSchema,
  threadId: threadIdSchema,
  body: z.string().min(1).max(COLLABORATION_LIMITS.maximumDiscussionBodyCharacters),
};

export const DECK_RESOLVE_COMMENT_INPUT = {
  deckId: deckIdSchema,
  threadId: threadIdSchema,
  note: z.string().min(1).max(COLLABORATION_LIMITS.maximumDiscussionBodyCharacters).exactOptional().describe("Replied before resolving, e.g. what was changed."),
};

export const MAXIMUM_AWAIT_SECONDS = 3000;

export const DECK_AWAIT_COMMENTS_INPUT = {
  deckId: deckIdSchema,
  afterSequence: z.number().int().min(0).describe("The `sequence` deck_read_comments or the previous deck_await_comments returned."),
  timeoutSeconds: z.number().int().min(1).max(MAXIMUM_AWAIT_SECONDS).default(300),
};

// --- helpers ------------------------------------------------------------------------------------

function brandedId<TBranded extends string>(options: Readonly<{ parse: (candidate: string) => TBranded | null; label: string }>) {
  return z.string().transform((value, context): TBranded => {
    const parsed = options.parse(value);
    if (parsed !== null) return parsed;
    context.addIssue({ code: "custom", message: `not a valid ${options.label}: ${JSON.stringify(value)}` });
    return z.NEVER;
  });
}


