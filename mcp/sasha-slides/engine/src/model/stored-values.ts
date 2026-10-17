// STORED VALUES, CHECKED AT THE BOUNDARY. Everything read out of the Y.Doc is `unknown`: it may
// have been written by this client, by an older one, by a NEWER one, or by a damaged replica. This
// file is the one place that turns a stored value into a typed one, and it answers with a three-way
// verdict instead of a boolean, because the model treats the failures differently:
//
//  * "valid"       -- the value is used as is.
//  * "unsupported" -- a value this client does not understand but a newer client could have
//                     written (an unknown `kind`, preset, slot or enum string). The snapshot shows a
//                     default in its place and lists the key in `unsupportedKeys`; validation reports
//                     it and NOTHING ever overwrites it (document.ts "values from newer clients survive").
//  * "wrongType"   -- structural damage (a number where a frame belongs, a known kind with missing
//                     fields). Reported, and repaired with the default by the repairing replica.
//
// Where a value is both, "unsupported" wins: when in doubt, never overwrite.
//
// The same checks validate command values (`invalidValue` rejections), so a command can never write
// something the projection would refuse to read.

import * as Y from "yjs";
import type { AnimationEffect, AnimationTrigger } from "../contracts/animations.ts";
import type {
  AssetRecord,
  CellBorders,
  CustomOutline,
  ImageCrop,
  PlaceholderReference,
  ScriptPurpose,
  ShapePreset,
  SlideTransition,
  TransitionApproval,
  TransitionAuthor,
  TransitionEasing,
} from "../contracts/document.ts";
import type { Frame, Point } from "../contracts/geometry.ts";
import type { SerialisableObject } from "../contracts/serialisable.ts";
import type { ArrowHead, Border, CornerRadius, Fill, LineRouting, Shadow, Stroke, TextBoxStyle } from "../contracts/style.ts";
import type { ParagraphAttributeName, RunAttributeName } from "../contracts/yjs-schema.ts";
import { assertNever } from "../contracts/assert-never.ts";
import { ANIMATION_EDGES, ANIMATION_TRIGGERS } from "../contracts/animations.ts";
import { PLACEHOLDER_ROLES } from "../contracts/document.ts";
import { THEME_COLOUR_SLOTS } from "../contracts/style.ts";
import {
  ARROW_HEADS,
  DASH_STYLES,
  IMAGE_FITS,
  LINE_ROUTINGS,
  LIST_GLYPHS,
  SHAPE_PRESETS,
  SLIDE_DIRECTIONS,
  TEXT_AUTOFITS,
  TRANSITION_EASINGS,
  VERTICAL_ALIGNMENTS,
} from "../shared/closed-sets.ts";
import { isHexadecimalColour } from "../shared/colour-values.ts";
import { ASSET_MEDIA_TYPES } from "../shared/media-types.ts";

// deck-tools/tool-input-schemas.ts reads the shape presets from here.
export { SHAPE_PRESETS } from "../shared/closed-sets.ts";

export type Verdict = "valid" | "unsupported" | "wrongType";

/** A stored value as read: present and typed, present but not usable (and why), or absent. */
export type Parsed<TValue> =
  | Readonly<{ kind: "valid"; value: TValue }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "wrongType" }>
  | Readonly<{ kind: "missing" }>;

/** How to check one kind of stored value. The type parameter is what a "valid" verdict proves. */
export type StoredValueCheck<TValue> = Readonly<{
  check: (candidate: unknown) => Verdict;
  describe: string;
  /** Never set: it only ties `TValue` to the check, so `readStored` infers what a valid read yields. */
  proves?: TValue;
}>;

export type LineGeometry = Readonly<{ start: Point; end: Point }>;

/** Read `key` of `map` through `kind`. */
export function readStored<TValue>(options: Readonly<{ map: Y.Map<unknown>; key: string; kind: StoredValueCheck<TValue> }>): Parsed<TValue> {
  if (!options.map.has(options.key)) return { kind: "missing" };
  return parseValue({ candidate: options.map.get(options.key), kind: options.kind });
}

/** Check an in-memory value through `kind`. */
export function parseValue<TValue>(options: Readonly<{ candidate: unknown; kind: StoredValueCheck<TValue> }>): Parsed<TValue> {
  const verdict = options.kind.check(options.candidate);
  switch (verdict) {
    case "valid":
      // `check` just proved the candidate has the shape `kind` stands for (the checks below are
      // written against the same contract types as their StoredValueCheck parameter).
      return { kind: "valid", value: options.candidate as TValue };
    case "unsupported":
      return { kind: "unsupported" };
    case "wrongType":
      return { kind: "wrongType" };
    default:
      return assertNever(verdict);
  }
}

/** The value when valid, else `fallback`. */
export function valueOr<TValue>(parsed: Parsed<TValue>, fallback: TValue): TValue {
  switch (parsed.kind) {
    case "valid":
      return parsed.value;
    case "unsupported":
    case "wrongType":
    case "missing":
      return fallback;
    default:
      return assertNever(parsed);
  }
}

export function isRecord(candidate: unknown): candidate is Readonly<Record<string, unknown>> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) && !(candidate instanceof Y.AbstractType);
}

/** The worst of several verdicts; "unsupported" dominates (see the header). */
export function combine(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("unsupported")) return "unsupported";
  if (verdicts.includes("wrongType")) return "wrongType";
  return "valid";
}

export function checkNumber(candidate: unknown): Verdict {
  return typeof candidate === "number" && Number.isFinite(candidate) ? "valid" : "wrongType";
}

export function checkString(candidate: unknown): Verdict {
  return typeof candidate === "string" ? "valid" : "wrongType";
}

export function checkBoolean(candidate: unknown): Verdict {
  return typeof candidate === "boolean" ? "valid" : "wrongType";
}

/** A string from a closed set: another string is a newer client's value, anything else damage. */
export function checkEnumeration(candidate: unknown, values: readonly string[]): Verdict {
  if (typeof candidate !== "string") return "wrongType";
  return values.includes(candidate) ? "valid" : "unsupported";
}

export function checkColour(candidate: unknown): Verdict {
  return checkKind(candidate, {
    literal: (record) => combine([checkHexadecimal(record["hexadecimal"]), checkUnit(record["alpha"])]),
    theme: (record) => combine([checkEnumeration(record["slot"], THEME_COLOUR_SLOTS), checkUnit(record["alpha"])]),
  });
}

/** A list marker's colour: "#rrggbb" or a theme slot name (style.ts `ListMarkerColour`). */
export function checkListMarkerColour(candidate: unknown): Verdict {
  if (typeof candidate !== "string") return "wrongType";
  return candidate.startsWith("#") ? checkHexadecimal(candidate) : checkEnumeration(candidate, THEME_COLOUR_SLOTS);
}

/** "#rrggbb" as text (colour-values.ts). */
function checkHexadecimal(candidate: unknown): Verdict {
  return isHexadecimalColour(candidate) ? "valid" : "wrongType";
}

export function checkColourOrNone(candidate: unknown): Verdict {
  if (isRecord(candidate) && candidate["kind"] === "none") return "valid";
  return checkColour(candidate);
}

export function checkFill(candidate: unknown): Verdict {
  return checkKind(candidate, {
    none: () => "valid",
    solid: (record) => checkColour(record["colour"]),
    linearGradient: (record) => combine([checkNumber(record["angle"]), checkStops(record["stops"])]),
    radialGradient: (record) => combine([checkNumber(record["centreX"]), checkNumber(record["centreY"]), checkStops(record["stops"])]),
    image: (record) => combine([checkString(record["assetId"]), checkEnumeration(record["fit"], IMAGE_FITS), checkUnit(record["opacity"])]),
  });
}

export function checkStroke(candidate: unknown): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  return combine([checkNonNegative(candidate["width"]), checkColour(candidate["colour"]), checkEnumeration(candidate["dash"], DASH_STYLES)]);
}

export function checkUnit(candidate: unknown): Verdict {
  return typeof candidate === "number" && candidate >= 0 && candidate <= 1 ? "valid" : "wrongType";
}

export function checkNonNegative(candidate: unknown): Verdict {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? "valid" : "wrongType";
}

export function checkPositive(candidate: unknown): Verdict {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? "valid" : "wrongType";
}

export function checkPoint(candidate: unknown): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  return combine([checkNumber(candidate["x"]), checkNumber(candidate["y"])]);
}

export function checkFrame(candidate: unknown): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  return combine([
    checkNumber(candidate["x"]),
    checkNumber(candidate["y"]),
    checkNonNegative(candidate["width"]),
    checkNonNegative(candidate["height"]),
    checkNumber(candidate["rotation"]),
    checkBoolean(candidate["flipHorizontal"]),
    checkBoolean(candidate["flipVertical"]),
  ]);
}

/** Text box field checks, total over `TextBoxStyle`: whole styles, partial ones and single fields all read through it. */
export const TEXT_BOX_FIELD_CHECKS: Readonly<Record<keyof TextBoxStyle, (candidate: unknown) => Verdict>> = {
  verticalAlignment: (candidate) => checkEnumeration(candidate, VERTICAL_ALIGNMENTS),
  paddingTop: checkNonNegative,
  paddingRight: checkNonNegative,
  paddingBottom: checkNonNegative,
  paddingLeft: checkNonNegative,
  autofit: (candidate) => checkEnumeration(candidate, TEXT_AUTOFITS),
  wrap: checkBoolean,
};

export function checkTextBoxStyle(candidate: unknown): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  return combine(Object.entries(TEXT_BOX_FIELD_CHECKS).map(([key, check]) => check(candidate[key])));
}

/** One `TextBoxStyle` field, for partial text box styles (placeholder styles); an unknown key is a newer client's. */
export function checkTextBoxField(key: string, candidate: unknown): Verdict {
  return ownCheck(TEXT_BOX_FIELD_CHECKS, key)?.(candidate) ?? "unsupported";
}

/** Run attribute checks, total over `RunAttributeName`. */
export const RUN_ATTRIBUTE_CHECKS: Readonly<Record<RunAttributeName, (candidate: unknown) => Verdict>> = {
  fontFamily: checkString,
  fontSize: checkPositive,
  fontWeight: checkPositive,
  fontStyle: (candidate) => checkEnumeration(candidate, ["normal", "italic"]),
  underline: checkBoolean,
  strikethrough: checkBoolean,
  colour: checkColour,
  highlight: checkColourOrNone,
  link: (candidate) =>
    checkKind(candidate, {
      none: () => "valid",
      webAddress: (record) => checkString(record["address"]),
      slide: (record) => checkString(record["slideId"]),
    }),
  baselineOffset: (candidate) => checkEnumeration(candidate, ["none", "superscript", "subscript"]),
  letterSpacing: checkNumber,
  textCase: (candidate) => checkEnumeration(candidate, ["none", "smallCaps", "allCaps"]),
};

/** Paragraph attribute checks, total over `ParagraphAttributeName`. */
export const PARAGRAPH_ATTRIBUTE_CHECKS: Readonly<Record<ParagraphAttributeName, (candidate: unknown) => Verdict>> = {
  alignment: (candidate) => checkEnumeration(candidate, ["start", "centre", "end", "justify"]),
  lineSpacing: checkPositive,
  spaceAbove: checkNonNegative,
  spaceBelow: checkNonNegative,
  indentStart: checkNumber,
  indentFirstLine: checkNumber,
  direction: (candidate) => checkEnumeration(candidate, ["leftToRight", "rightToLeft"]),
  list: (candidate) =>
    checkKind(candidate, {
      none: () => "valid",
      list: (record) =>
        combine([
          checkString(record["listId"]),
          checkEnumeration(record["glyph"], LIST_GLYPHS),
          typeof record["level"] === "number" && Number.isInteger(record["level"]) && record["level"] >= 0 && record["level"] <= 8 ? "valid" : "wrongType",
          record["markerColour"] === undefined ? "valid" : checkListMarkerColour(record["markerColour"]),
          record["markerFontSize"] === undefined ? "valid" : checkPositive(record["markerFontSize"]),
        ]),
    }),
};

/** A partial style whose every present key passes `checks`; unknown keys are a newer client's. */
export function checkStylePatch(candidate: unknown, checks: Readonly<Record<string, (value: unknown) => Verdict>>): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  return combine(Object.entries(candidate).map(([key, value]) => {
    const check = ownCheck(checks, key);
    return check === undefined ? "unsupported" : check(value);
  }));
}

export function checkSerialisable(candidate: unknown): Verdict {
  if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return "valid";
  if (typeof candidate === "number") return Number.isFinite(candidate) ? "valid" : "wrongType";
  if (Array.isArray(candidate)) return combine(candidate.map((item: unknown) => checkSerialisable(item)));
  if (isRecord(candidate)) return combine(Object.values(candidate).map((item) => checkSerialisable(item)));
  return "wrongType";
}

export const FRAME: StoredValueCheck<Frame> = { check: checkFrame, describe: "a frame" };
export const LINE_GEOMETRY: StoredValueCheck<LineGeometry> = {
  check: (candidate) => (isRecord(candidate) ? combine([checkPoint(candidate["start"]), checkPoint(candidate["end"])]) : "wrongType"),
  describe: "two end points",
};
export const FILL: StoredValueCheck<Fill> = { check: checkFill, describe: "a fill" };
export const OPTIONAL_FILL: StoredValueCheck<Fill | null> = {
  check: (candidate) => (candidate === null ? "valid" : checkFill(candidate)),
  describe: "a fill or null",
};
export const BORDER: StoredValueCheck<Border> = {
  check: (candidate) =>
    checkKind(candidate, {
      none: () => "valid",
      uniform: (record) => checkStroke(record["stroke"]),
      perSide: (record) => combine(SIDES.map((side) => checkOptionalStroke(record[side]))),
    }),
  describe: "a border",
};
export const CORNER_RADIUS: StoredValueCheck<CornerRadius> = {
  check: (candidate) =>
    checkKind(candidate, {
      uniform: (record) => checkNonNegative(record["radius"]),
      perCorner: (record) => combine(CORNERS.map((corner) => checkNonNegative(record[corner]))),
    }),
  describe: "a corner radius",
};
export const SHADOW: StoredValueCheck<Shadow | null> = {
  check: (candidate) => {
    if (candidate === null) return "valid";
    if (!isRecord(candidate)) return "wrongType";
    return combine([
      checkNumber(candidate["offsetX"]),
      checkNumber(candidate["offsetY"]),
      checkNonNegative(candidate["blur"]),
      checkNumber(candidate["spread"]),
      checkColour(candidate["colour"]),
    ]);
  },
  describe: "a shadow or null",
};
export const OPACITY: StoredValueCheck<number> = { check: checkUnit, describe: "an opacity between 0 and 1" };
export const SHAPE_PRESET: StoredValueCheck<ShapePreset> = {
  check: (candidate) => checkEnumeration(candidate, SHAPE_PRESETS),
  describe: "a shape preset",
};
export const CUSTOM_OUTLINE: StoredValueCheck<CustomOutline | null> = {
  check: (candidate) => {
    if (candidate === null) return "valid";
    if (!isRecord(candidate)) return "wrongType";
    const paths = candidate["paths"];
    if (!Array.isArray(paths)) return "wrongType";
    return combine(paths.map((path: unknown) => checkOutlinePath(path)));
  },
  describe: "a custom outline or null",
};
export const TEXT_BOX_STYLE: StoredValueCheck<TextBoxStyle> = { check: checkTextBoxStyle, describe: "a text box style" };
export const IMAGE_CROP: StoredValueCheck<ImageCrop> = {
  check: (candidate) => (isRecord(candidate) ? combine(SIDES.map((side) => checkUnit(candidate[side]))) : "wrongType"),
  describe: "an image crop",
};
export const STROKE: StoredValueCheck<Stroke> = { check: checkStroke, describe: "a stroke" };
export const ARROW_HEAD: StoredValueCheck<ArrowHead> = {
  check: (candidate) => checkEnumeration(candidate, ARROW_HEADS),
  describe: "an arrow head",
};
export const LINE_ROUTING: StoredValueCheck<LineRouting> = {
  check: (candidate) => checkEnumeration(candidate, LINE_ROUTINGS),
  describe: "a line routing",
};
export const PLACEHOLDER: StoredValueCheck<PlaceholderReference | null> = {
  check: (candidate) => {
    if (candidate === null) return "valid";
    if (!isRecord(candidate)) return "wrongType";
    const index = candidate["index"];
    return combine([
      checkEnumeration(candidate["role"], PLACEHOLDER_ROLES),
      typeof index === "number" && Number.isInteger(index) && index >= 0 ? "valid" : "wrongType",
    ]);
  },
  describe: "a placeholder reference or null",
};
export const TEXT: StoredValueCheck<string> = { check: checkString, describe: "a string" };
export const NUMBER: StoredValueCheck<number> = { check: checkNumber, describe: "a number" };
export const POSITIVE_NUMBER: StoredValueCheck<number> = { check: checkPositive, describe: "a positive number" };
export const BOOLEAN: StoredValueCheck<boolean> = { check: checkBoolean, describe: "a boolean" };
export const OPTIONAL_TEXT: StoredValueCheck<string | null> = {
  check: (candidate) => (candidate === null ? "valid" : checkString(candidate)),
  describe: "a string or null",
};
export const SPAN: StoredValueCheck<number> = {
  check: (candidate) => (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1 ? "valid" : "wrongType"),
  describe: "a whole number of at least 1",
};
export const CELL_BORDERS: StoredValueCheck<CellBorders> = {
  check: (candidate) => (isRecord(candidate) ? combine(SIDES.map((side) => checkOptionalStroke(candidate[side]))) : "wrongType"),
  describe: "cell borders",
};
export const SLIDE_TRANSITION: StoredValueCheck<SlideTransition | null> = {
  check: (candidate) => {
    if (candidate === null) return "valid";
    return checkKind(candidate, {
      builtin: (record) =>
        combine([
          checkBuiltinEffect(record["effect"]),
          checkNonNegative(record["durationMilliseconds"]),
          checkEnumeration(record["easing"], TRANSITION_EASINGS),
        ]),
      scripted: (record) =>
        combine([checkString(record["scriptId"]), checkNonNegative(record["durationMilliseconds"]), isRecord(record["parameters"]) ? checkSerialisable(record["parameters"]) : "wrongType"]),
    });
  },
  describe: "a slide transition or null",
};
export const TRANSITION_EASING: StoredValueCheck<TransitionEasing> = {
  check: (candidate) => checkEnumeration(candidate, TRANSITION_EASINGS),
  describe: "an easing",
};
export const SCRIPT_PURPOSE: StoredValueCheck<ScriptPurpose> = {
  check: (candidate) => checkEnumeration(candidate, ["transition", "animation"]),
  describe: "a script purpose",
};
export const ANIMATION_TRIGGER: StoredValueCheck<AnimationTrigger> = {
  check: (candidate) => checkEnumeration(candidate, ANIMATION_TRIGGERS),
  describe: "an animation trigger",
};
/**
 * A build step's effect. The ranges of its numbers (ANIMATION_LIMITS) are a COMMAND rule, not a
 * stored one: a stored spin of 7200 degrees is still a spin, played clamped, never "repaired".
 */
export const ANIMATION_EFFECT: StoredValueCheck<AnimationEffect> = {
  check: (candidate) =>
    checkKind(candidate, {
      appear: () => "valid",
      fadeIn: () => "valid",
      flyIn: (record) => checkEnumeration(record["from"], ANIMATION_EDGES),
      zoomIn: () => "valid",
      floatIn: () => "valid",
      wipe: (record) => checkEnumeration(record["from"], ANIMATION_EDGES),
      pulse: () => "valid",
      growShrink: (record) => checkPositive(record["scale"]),
      spin: (record) => checkNumber(record["degrees"]),
      colourChange: (record) => combine([checkColour(record["colour"]), checkEnumeration(record["part"], ["fill", "text"])]),
      disappear: () => "valid",
      fadeOut: () => "valid",
      flyOut: (record) => checkEnumeration(record["to"], ANIMATION_EDGES),
      zoomOut: () => "valid",
      motionPath: (record) => combine([checkNumber(record["offsetX"]), checkNumber(record["offsetY"])]),
      scripted: (record) =>
        combine([
          checkString(record["scriptId"]),
          checkEnumeration(record["category"], ["entrance", "emphasis", "exit"]),
          isRecord(record["parameters"]) ? checkSerialisable(record["parameters"]) : "wrongType",
        ]),
    }),
  describe: "an animation effect",
};
export const TRANSITION_AUTHOR: StoredValueCheck<TransitionAuthor> = {
  check: (candidate) =>
    checkKind(candidate, {
      person: (record) => checkString(record["personId"]),
      agent: (record) => combine([checkString(record["name"]), checkString(record["agentSessionId"])]),
    }),
  describe: "a script author",
};
export const TRANSITION_APPROVAL: StoredValueCheck<TransitionApproval> = {
  check: (candidate) =>
    checkKind(candidate, {
      unapproved: () => "valid",
      approved: (record) => combine([checkString(record["approvedBy"]), checkString(record["fingerprint"])]),
    }),
  describe: "a script approval",
};
export const SERIALISABLE_OBJECT: StoredValueCheck<SerialisableObject> = {
  check: (candidate) => (isRecord(candidate) ? checkSerialisable(candidate) : "wrongType"),
  describe: "an object of serialisable values",
};
export const ASSET_RECORD: StoredValueCheck<AssetRecord> = {
  check: (candidate) => {
    if (!isRecord(candidate)) return "wrongType";
    return combine([
      checkString(candidate["id"]),
      checkEnumeration(candidate["mediaType"], ASSET_MEDIA_TYPES),
      checkNonNegative(candidate["pixelWidth"]),
      checkNonNegative(candidate["pixelHeight"]),
      checkString(candidate["name"]),
      checkNonNegative(candidate["byteLength"]),
    ]);
  },
  describe: "an asset record",
};

const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

/** A discriminated object: an unknown `kind` string is a newer client's (see the header). */
function checkKind(candidate: unknown, cases: Readonly<Record<string, (record: Readonly<Record<string, unknown>>) => Verdict>>): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  const kind = candidate["kind"];
  if (typeof kind !== "string") return "wrongType";
  const check = ownCheck(cases, kind);
  return check === undefined ? "unsupported" : check(candidate);
}

/**
 * `checks[key]` when the table has `key` as its own property. A stored name such as "constructor"
 * or "toString" must read as a newer client's, not call the inherited Object method and hand its
 * result on as a verdict.
 */
function ownCheck<TCheck>(checks: Readonly<Record<string, TCheck>>, key: string): TCheck | undefined {
  return Object.hasOwn(checks, key) ? checks[key] : undefined;
}

function checkStops(candidate: unknown): Verdict {
  if (!Array.isArray(candidate) || candidate.length === 0) return "wrongType";
  return combine(candidate.map((stop: unknown) => (isRecord(stop) ? combine([checkColour(stop["colour"]), checkUnit(stop["offset"])]) : "wrongType")));
}

/** One path of a custom outline: its drawing commands (an unknown command kind is a newer client's) and its two flags. */
function checkOutlinePath(candidate: unknown): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  const commands = candidate["commands"];
  if (!Array.isArray(commands)) return "wrongType";
  return combine([
    checkBoolean(candidate["filled"]),
    checkBoolean(candidate["stroked"]),
    ...commands.map((command: unknown) =>
      checkKind(command, {
        move: (record) => checkPoint(record["to"]),
        line: (record) => checkPoint(record["to"]),
        quadratic: (record) => combine([checkPoint(record["control"]), checkPoint(record["to"])]),
        cubic: (record) => combine([checkPoint(record["firstControl"]), checkPoint(record["secondControl"]), checkPoint(record["to"])]),
        close: () => "valid",
      }),
    ),
  ]);
}

function checkOptionalStroke(candidate: unknown): Verdict {
  return candidate === null ? "valid" : checkStroke(candidate);
}

function checkBuiltinEffect(candidate: unknown): Verdict {
  if (!isRecord(candidate)) return "wrongType";
  const effect = candidate["effect"];
  switch (effect) {
    case "fade":
    case "morph":
      return "valid";
    case "push":
      return checkEnumeration(candidate["direction"], SLIDE_DIRECTIONS);
    case "slide":
      return combine([checkEnumeration(candidate["direction"], SLIDE_DIRECTIONS), checkEnumeration(candidate["mode"], ["cover", "uncover"])]);
    case "zoom":
      return checkEnumeration(candidate["mode"], ["in", "out"]);
    default:
      return typeof effect === "string" ? "unsupported" : "wrongType";
  }
}
