/**
 * MERGING A MODEL'S STYLE INTO EACH ELEMENT'S OWN. The document stores style GROUPS whole (a
 * border is one value, last writer wins, style.ts), so an `updateElements` patch must carry whole
 * groups. "Make these borders 4 wide" over a red and a blue shape must therefore become TWO
 * patches, red-4 and blue-4, never one patch that paints both the first element's colour
 * (SPEC.md 21.9 fix 1, the same rule for people). `mergeStylePatch` completes an
 * `AssistantStylePatch` against ONE element's current values; `applyElementPatch` writes a whole
 * patch onto an element value, for new elements (merged over their defaults) and for the
 * expansion's working copy of the deck.
 *
 * A field that does not apply to an element's kind is left out of its patch, as the model would
 * skip it anyway (commands.ts "style patches apply to mixed selections").
 */
import type { ElementPatch } from "../engine/src/contracts/commands.ts";
import type { ElementSnapshot, ImageCrop } from "../engine/src/contracts/document.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { Border, BoxStyle, Stroke } from "../engine/src/contracts/style.ts";
import { DEFAULT_SHADOW, DEFAULT_STROKE } from "../engine/src/shared/element-defaults.ts";
import type { AssistantStylePatch, BorderPatch } from "./assistant-edit-request.ts";

/** A border, a line or a shadow starts from the editor's own defaults when the element had none; the expansion's new lines too. */
export { DEFAULT_STROKE } from "../engine/src/shared/element-defaults.ts";

/** The whole-group patch for `element` (see the header). */
export function mergeStylePatch(options: Readonly<{ element: ElementSnapshot; patch: AssistantStylePatch }>): ElementPatch {
  const { element, patch } = options;
  const common: ElementPatch = {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.morphKey === undefined ? {} : { morphKey: patch.morphKey }),
  };
  switch (element.kind) {
    case "shape":
      return {
        ...common,
        ...boxPatch({ box: element.box, patch }),
        ...(patch.textBox === undefined ? {} : { textBox: { ...element.textBox, ...patch.textBox } }),
        ...(patch.preset === undefined ? {} : { preset: patch.preset }),
      };
    case "image":
      return { ...common, ...boxPatch({ box: element.box, patch }), ...(patch.crop === undefined ? {} : { crop: mergedCrop({ crop: element.crop, patch: patch.crop }) }) };
    case "line":
      return {
        ...common,
        ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
        ...(patch.stroke === undefined ? {} : { stroke: { ...element.stroke, ...patch.stroke } }),
        ...(patch.startArrow === undefined ? {} : { startArrow: patch.startArrow }),
        ...(patch.endArrow === undefined ? {} : { endArrow: patch.endArrow }),
        ...(patch.routing === undefined ? {} : { routing: patch.routing }),
      };
    case "table":
      return { ...common, ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }) };
    case "group":
    case "unsupported":
      return common;
    default:
      return assertNever(element);
  }
}

/** `element` with a whole patch written onto it (fields foreign to its kind skipped). */
export function applyElementPatch(options: Readonly<{ element: ElementSnapshot; patch: ElementPatch }>): ElementSnapshot {
  const { element, patch } = options;
  const common = {
    name: patch.name ?? element.name,
    description: patch.description ?? element.description,
    morphKey: patch.morphKey ?? element.morphKey,
  };
  switch (element.kind) {
    case "shape":
      return { ...element, ...common, box: patchedBox({ box: element.box, patch }), textBox: patch.textBox ?? element.textBox, preset: patch.preset ?? element.preset, customOutline: patch.preset === undefined ? element.customOutline : null };
    case "image":
      return { ...element, ...common, box: patchedBox({ box: element.box, patch }), crop: patch.crop ?? element.crop, assetId: patch.assetId ?? element.assetId };
    case "line":
      return {
        ...element,
        ...common,
        opacity: patch.opacity ?? element.opacity,
        stroke: patch.stroke ?? element.stroke,
        startArrow: patch.startArrow ?? element.startArrow,
        endArrow: patch.endArrow ?? element.endArrow,
        routing: patch.routing ?? element.routing,
      };
    case "table":
      return { ...element, ...common, opacity: patch.opacity ?? element.opacity };
    case "group":
    case "unsupported":
      return { ...element, ...common };
    default:
      return assertNever(element);
  }
}

function boxPatch(options: Readonly<{ box: BoxStyle; patch: AssistantStylePatch }>): ElementPatch {
  const { box, patch } = options;
  return {
    ...(patch.fill === undefined ? {} : { fill: patch.fill }),
    ...(patch.border === undefined ? {} : { border: mergedBorder({ border: box.border, patch: patch.border }) }),
    ...(patch.cornerRadius === undefined ? {} : { cornerRadius: patch.cornerRadius }),
    ...(patch.shadow === undefined ? {} : { shadow: patch.shadow === null ? null : { ...(box.shadow ?? DEFAULT_SHADOW), ...patch.shadow } }),
    ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
  };
}

/**
 * A border patch over an element's border: "none" and per-side values replace it; a uniform patch
 * changes the given stroke fields of the uniform border, of EVERY drawn side of a per-side border,
 * or of the default stroke when there was no border.
 */
function mergedBorder(options: Readonly<{ border: Border; patch: BorderPatch }>): Border {
  const { border, patch } = options;
  switch (patch.kind) {
    case "none":
      return { kind: "none" };
    case "perSide":
      return { kind: "perSide", top: patch.top, right: patch.right, bottom: patch.bottom, left: patch.left };
    case "uniform":
    case undefined:
      return uniformOver({ border, stroke: patch.stroke ?? {} });
    default:
      return assertNever(patch);
  }
}

function uniformOver(options: Readonly<{ border: Border; stroke: Partial<Stroke> }>): Border {
  const { border, stroke } = options;
  switch (border.kind) {
    case "none":
      return { kind: "uniform", stroke: { ...DEFAULT_STROKE, ...stroke } };
    case "uniform":
      return { kind: "uniform", stroke: { ...border.stroke, ...stroke } };
    case "perSide": {
      const side = (current: Stroke | null): Stroke | null => (current === null ? null : { ...current, ...stroke });
      return { kind: "perSide", top: side(border.top), right: side(border.right), bottom: side(border.bottom), left: side(border.left) };
    }
    default:
      return assertNever(border);
  }
}

function mergedCrop(options: Readonly<{ crop: ImageCrop; patch: Partial<ImageCrop> }>): ImageCrop {
  return { ...options.crop, ...options.patch };
}

function patchedBox(options: Readonly<{ box: BoxStyle; patch: ElementPatch }>): BoxStyle {
  const { box, patch } = options;
  return {
    fill: patch.fill ?? box.fill,
    border: patch.border ?? box.border,
    cornerRadius: patch.cornerRadius ?? box.cornerRadius,
    shadow: patch.shadow === undefined ? box.shadow : patch.shadow,
    opacity: patch.opacity ?? box.opacity,
  };
}
