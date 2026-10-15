/**
 * WHAT `deck_edit` ACCEPTS: the contract's `AssistantEdit` vocabulary (assistant-deck-tools.ts),
 * widened in exactly the places where the right value depends on the deck and so cannot be filled
 * in by the input schema:
 *
 *  - a FRAME may be omitted (null): the layout's placeholder frame or a centred default is used;
 *  - a STYLE is a deep partial (`AssistantStylePatch`): "border width 4" keeps each element's own
 *    border colour, which is what "restyleElements merges per element" means, and a new shape's
 *    style is merged over the theme's defaults the same way;
 *  - an added slide, element or group may name its own NEW id, so later edits of the same call can
 *    address it (the contract header: "every id is optional to supply; the tool reports the ids it
 *    minted"). A model cannot learn a minted id before the call returns, and one call must stay one
 *    undo step.
 *
 * Every contract `AssistantEdit` is an `AssistantEditRequest` (`requestFromContractEdit` proves it
 * at compile time), so the vocabulary only grows.
 */
import type { AssistantEdit, AssistantFrame, AssistantParagraph } from "../engine/src/contracts/assistant-deck-tools.ts";
import type { DocumentCommand, SlidePropertiesPatch } from "../engine/src/contracts/commands.ts";
import type { ImageCrop, PlaceholderRole, ShapePreset } from "../engine/src/contracts/document.ts";
import type { Point } from "../engine/src/contracts/geometry.ts";
import type { ElementId, LayoutId, SlideId } from "../engine/src/contracts/ids.ts";
import type { ArrowHead, CornerRadius, Fill, LineRouting, Shadow, Stroke, TextBoxStyle } from "../engine/src/contracts/style.ts";

export type AssistantEditRequest =
  | Readonly<{
      kind: "addSlide";
      id?: SlideId | null;
      after: SlideId | null;
      layoutId: LayoutId | null;
      placeholderText: Partial<Readonly<Record<PlaceholderRole, readonly AssistantParagraph[]>>>;
      background: Fill | null;
      speakerNotes: string;
    }>
  | Readonly<{ kind: "deleteSlides"; slideIds: readonly SlideId[] }>
  | Readonly<{ kind: "moveSlides"; slideIds: readonly SlideId[]; after: SlideId | null }>
  | Readonly<{ kind: "setSlide"; slideId: SlideId; patch: SlidePropertiesPatch; speakerNotes: string | null }>
  | Readonly<{
      kind: "addShape";
      id?: ElementId | null;
      slideId: SlideId;
      preset: ShapePreset;
      frame: AssistantFrame | null;
      style: AssistantStylePatch;
      text: readonly AssistantParagraph[];
      name: string;
    }>
  | Readonly<{ kind: "addLine"; id?: ElementId | null; slideId: SlideId; start: Point; end: Point; style: AssistantStylePatch; name: string }>
  | Readonly<{ kind: "addImage"; id?: ElementId | null; slideId: SlideId; source: string; frame: AssistantFrame | null; description: string }>
  | Readonly<{
      kind: "addTable";
      id?: ElementId | null;
      slideId: SlideId;
      frame: AssistantFrame | null;
      cells: readonly (readonly string[])[];
      headerRow: boolean;
    }>
  | Readonly<{ kind: "moveElements"; slideId: SlideId; moves: readonly Readonly<{ elementId: ElementId; frame: Partial<AssistantFrame> }>[] }>
  | Readonly<{ kind: "restyleElements"; slideId: SlideId; elementIds: readonly ElementId[]; patch: AssistantStylePatch }>
  | Extract<AssistantEdit, { kind: "setText" | "replaceText" | "styleText" | "deleteElements" | "reorderElements" | "setTitle" }>
  | Readonly<{ kind: "groupElements"; id?: ElementId | null; slideId: SlideId; elementIds: readonly ElementId[] }>
  | Readonly<{ kind: "raw"; commands: readonly DocumentCommand[] }>;

export type AssistantEditRequestKind = AssistantEditRequest["kind"];

/**
 * A style as a model states it: every field optional, and the grouped values (border, stroke,
 * shadow, text box, crop) partial too. `mergeStylePatch` (style-merge.ts) completes it against
 * each element's own current values. A fill and a corner radius are replaced whole: their variants
 * share no fields worth keeping.
 */
export type AssistantStylePatch = Readonly<{
  name?: string;
  description?: string;
  morphKey?: string;
  fill?: Fill;
  border?: BorderPatch;
  cornerRadius?: CornerRadius;
  shadow?: Partial<Shadow> | null;
  opacity?: number;
  textBox?: Partial<TextBoxStyle>;
  preset?: ShapePreset;
  crop?: Partial<ImageCrop>;
  stroke?: Partial<Stroke>;
  startArrow?: ArrowHead;
  endArrow?: ArrowHead;
  routing?: LineRouting;
}>;

/** `{ stroke: { width: 4 } }` changes the width of whatever border each element has. */
export type BorderPatch =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind?: "uniform"; stroke?: Partial<Stroke> }>
  | Readonly<{ kind: "perSide"; top: Stroke | null; right: Stroke | null; bottom: Stroke | null; left: Stroke | null }>;

/** Compile-time proof that the contract's vocabulary is accepted unchanged (see the header). */
export function requestFromContractEdit(edit: AssistantEdit): AssistantEditRequest {
  return edit;
}
