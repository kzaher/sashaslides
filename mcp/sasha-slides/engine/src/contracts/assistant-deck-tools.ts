// CLAUDE'S DECK TOOLS (milestone 2): the MCP tools the connector registers so an assistant can
// create a deck, read its structure, edit it, write scripted transitions and take part in its
// discussion -- all through the deck server, so every collaborator sees the change live and every
// change is attributed to an agent session that a person can revert.
//
// Key decisions:
//
//  * AN EDIT VOCABULARY FOR A MODEL, EXPANDED ON THE SERVER. `DocumentCommand` (commands.ts) is the
//    editor's language: complete element trees, every style group filled in, text as Y.Text
//    operations with exact indices. A model writing that directly would spend most of its output
//    on defaults and get indices wrong. `AssistantEdit` says what a person would say ("add a
//    rounded rectangle here with this text", "make these red", "replace the title"), the tool
//    fills defaults from the deck's theme and the layout, mints ids, and expands each edit into
//    `DocumentCommand`s. `raw` remains for anything the vocabulary lacks.
//
//  * ONE CALL, ONE ENVELOPE, ONE UNDO STEP. `deck_edit` validates every edit first and applies
//    them as ONE `CommandEnvelope` with `author: { kind: "agent", agentSessionId }`: all or
//    nothing, one step for "Undo Claude's edit", one `agentEdit` notice to the editors.
//
//  * SCRIPTS STAY UNAPPROVED. `deck_write_transition` saves with approval "unapproved" whoever the
//    account is; only a person approving in the editor makes it run (collaboration.ts header).
//
//  * READ RETURNS IDS AND PLAIN TEXT, NOT THE YJS STRUCTURE. The outline is what a model needs to
//    address things (`DeckOutline`); `detail: "full"` adds the snapshot of the slides asked for.

import type { ElementPatch, SlidePropertiesPatch } from "./commands.ts";
import type { DocumentCommand } from "./commands.ts";
import type { CommentTarget } from "./discussion.ts";
import type { ElementKind, PlaceholderRole, ShapePreset, SlideSnapshot } from "./document.ts";
import type { Frame, FractionalRegion, Point } from "./geometry.ts";
import type { DeckId, ElementId, LayoutId, MessageId, SlideId, ThreadId, TransitionScriptId } from "./ids.ts";
import type { SerialisableObject } from "./serialisable.ts";
import type { Fill, ParagraphStylePatch, RunStylePatch } from "./style.ts";
import type { DeckRole } from "./deck-access.ts";

export const ASSISTANT_DECK_TOOL_NAMES = [
  "deck_list",
  "deck_create",
  "deck_read",
  "deck_edit",
  "deck_write_transition",
  "deck_revert",
  "deck_read_comments",
  "deck_reply_comment",
  "deck_resolve_comment",
  "deck_await_comments",
] as const;

export type AssistantDeckToolName = (typeof ASSISTANT_DECK_TOOL_NAMES)[number];

/** Text as a model writes it: paragraphs of runs, styles optional. */
export type AssistantParagraph = Readonly<{
  text: string;
  style: ParagraphStylePatch;
  /** Styled stretches inside `text`, by character offset; unstyled text inherits the placeholder and theme. */
  runs: readonly Readonly<{ start: number; end: number; style: RunStylePatch }>[];
}>;

/** Where on the slide, slide units (1280 wide). Omitted frames take the layout placeholder's, or a default. */
export type AssistantFrame = Readonly<{ x: number; y: number; width: number; height: number; rotation: number }>;

/** One edit, in the words a person would use. Every id is optional to supply; the tool reports the ids it minted. */
export type AssistantEdit =
  | Readonly<{
      kind: "addSlide";
      /** After this slide; null = at the end. */
      after: SlideId | null;
      layoutId: LayoutId | null;
      /** Text for the layout's placeholders by role, e.g. { title: [...], body: [...] }. */
      placeholderText: Partial<Readonly<Record<PlaceholderRole, readonly AssistantParagraph[]>>>;
      background: Fill | null;
      speakerNotes: string;
    }>
  | Readonly<{ kind: "deleteSlides"; slideIds: readonly SlideId[] }>
  | Readonly<{ kind: "moveSlides"; slideIds: readonly SlideId[]; after: SlideId | null }>
  | Readonly<{ kind: "setSlide"; slideId: SlideId; patch: SlidePropertiesPatch; speakerNotes: string | null }>
  | Readonly<{
      kind: "addShape";
      slideId: SlideId;
      preset: ShapePreset;
      frame: AssistantFrame;
      /** Applied over the theme's defaults for a new shape. */
      style: ElementPatch;
      text: readonly AssistantParagraph[];
      name: string;
    }>
  | Readonly<{ kind: "addLine"; slideId: SlideId; start: Point; end: Point; style: ElementPatch; name: string }>
  | Readonly<{
      kind: "addImage";
      slideId: SlideId;
      /** An https address the server fetches (image media types only, COLLABORATION_LIMITS.maximumAssetBytes). */
      source: string;
      frame: AssistantFrame | null;
      description: string;
    }>
  | Readonly<{ kind: "addTable"; slideId: SlideId; frame: AssistantFrame; cells: readonly (readonly string[])[]; headerRow: boolean }>
  | Readonly<{ kind: "moveElements"; slideId: SlideId; moves: readonly Readonly<{ elementId: ElementId; frame: Partial<AssistantFrame> }>[] }>
  /** Merged PER ELEMENT: each element keeps every field the patch does not name. */
  | Readonly<{ kind: "restyleElements"; slideId: SlideId; elementIds: readonly ElementId[]; patch: ElementPatch }>
  /** Replace the whole text of a shape or table cell. */
  | Readonly<{ kind: "setText"; slideId: SlideId; elementId: ElementId; cell: Readonly<{ row: number; column: number }> | null; paragraphs: readonly AssistantParagraph[] }>
  /** Find `find` (exact, first occurrence unless `all`) and replace it, keeping the found text's style. */
  | Readonly<{ kind: "replaceText"; slideId: SlideId; elementId: ElementId; find: string; replaceWith: string; all: boolean }>
  | Readonly<{ kind: "styleText"; slideId: SlideId; elementId: ElementId; find: string; run: RunStylePatch; paragraph: ParagraphStylePatch }>
  | Readonly<{ kind: "deleteElements"; slideId: SlideId; elementIds: readonly ElementId[] }>
  | Readonly<{ kind: "reorderElements"; slideId: SlideId; elementIds: readonly ElementId[]; placement: "front" | "forward" | "backward" | "back" }>
  | Readonly<{ kind: "groupElements"; slideId: SlideId; elementIds: readonly ElementId[] }>
  | Readonly<{ kind: "setTitle"; title: string }>
  /** Escape hatch: commands exactly as commands.ts defines them, validated by the model like any other. */
  | Readonly<{ kind: "raw"; commands: readonly DocumentCommand[] }>;

/** deck_read's answer. */
export type DeckOutline = Readonly<{
  deckId: DeckId;
  title: string;
  role: DeckRole;
  address: string;
  pageWidth: number;
  pageHeight: number;
  layouts: readonly Readonly<{ layoutId: LayoutId; name: string; placeholders: readonly PlaceholderRole[] }>[];
  slides: readonly SlideOutline[];
  transitionScripts: readonly Readonly<{ scriptId: TransitionScriptId; name: string; approved: boolean; authorName: string }>[];
  openThreadCount: number;
  /** Present for the slides named in `detail: "full"`. */
  fullSlides: readonly SlideSnapshot[];
}>;

export type SlideOutline = Readonly<{
  slideId: SlideId;
  /** 1-based, as the person sees it in the filmstrip. */
  number: number;
  layoutId: LayoutId | null;
  skipped: boolean;
  transition: string;
  speakerNotes: string;
  elements: readonly ElementOutline[];
}>;

export type ElementOutline = Readonly<{
  elementId: ElementId;
  kind: ElementKind;
  name: string;
  frame: Frame;
  /** Plain text of a shape, or of each table cell row by row joined with tabs and newlines. */
  text: string;
  placeholder: PlaceholderRole | null;
  children: readonly ElementOutline[];
}>;

/** deck_edit's answer. */
export type AssistantEditOutcome =
  | Readonly<{
      kind: "applied";
      agentSessionId: string;
      /** Ids minted for added slides and elements, in edit order, so the next call can address them. */
      created: readonly Readonly<{ editIndex: number; slideId: SlideId | null; elementIds: readonly ElementId[] }>[];
    }>
  | Readonly<{ kind: "rejected"; editIndex: number | null; reason: string }>;

/** deck_write_transition's input. */
export type AssistantTransitionScript = Readonly<{
  deckId: DeckId;
  /** Omitted to create a new script; given to replace one (the save is based on its current `updatedAt`). */
  scriptId: TransitionScriptId | null;
  name: string;
  description: string;
  script: string;
  stylesheet: string;
  markup: string;
  defaultParameters: SerialisableObject;
  /** Slides that should use it; their transition becomes `{ kind: "scripted", scriptId, durationMilliseconds, parameters: {} }`. */
  assignTo: readonly Readonly<{ slideId: SlideId; durationMilliseconds: number }>[];
}>;

/** deck_read_comments' answer: threads as the agent needs them. */
export type AssistantThread = Readonly<{
  threadId: ThreadId;
  slideId: SlideId;
  slideNumber: number | null;
  target: CommentTarget["kind"];
  elementId: ElementId | null;
  quotedText: string | null;
  region: FractionalRegion | null;
  /** "pen", "rectangle", ... so the agent knows something was drawn even though it cannot see it. */
  markingKinds: readonly string[];
  status: "open" | "resolved";
  messages: readonly Readonly<{ messageId: MessageId; authorName: string; authorKind: "person" | "agent"; body: string; createdAt: number }>[];
}>;
