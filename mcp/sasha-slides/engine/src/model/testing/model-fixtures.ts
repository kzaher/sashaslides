// TEST FIXTURES for the model: a seeded random source, a hand-moved clock, a store on a fresh
// Y.Doc, branded ids, and builders for the element trees and envelopes the tests apply. Kept free
// of node APIs so the browser typecheck accepts it next to the sources it exercises.

import { VirtualTimeScheduler } from "rxjs";
import * as Y from "yjs";
import type {
  AnimationEffect,
  AnimationStep,
  AnimationStepId,
  AnimationTrigger,
  AssetId,
  AssetRecord,
  CommandAuthor,
  CommandEnvelope,
  CommandId,
  CustomOutline,
  DocumentCommand,
  DocumentStore,
  ElementId,
  Frame,
  GroupElement,
  ImageElement,
  LineElement,
  MintedIdByKind,
  ObjectIdKind,
  PersonId,
  RandomSource,
  RepairPolicy,
  Selection,
  ShapeElement,
  TableElement,
  TextBody,
} from "../../contracts/index.ts";
import { DEFAULT_TEXT_BOX_STYLE, identityFrame, parseAssetId, parseElementId, parsePersonId, themeColour } from "../../contracts/index.ts";
import { createDocumentStore } from "../document-store.ts";
import { imageElement, lineElement, requireParsed, shapeElement } from "../../contracts/testing/snapshot-builders.ts";
import { createPrefixedIdMinter } from "../../shared/id-minter.ts";

/** Mulberry32: a small, well-mixed 32-bit generator; the same seed always gives the same sequence. */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export type ManualClock = Readonly<{ now: () => number; set: (time: number) => void; advance: (milliseconds: number) => void }>;

export function manualClock(start: number): ManualClock {
  let time = start;
  return {
    now: () => time,
    set: (next) => {
      time = next;
    },
    advance: (milliseconds) => {
      time += milliseconds;
    },
  };
}

export type TestStore = Readonly<{ store: DocumentStore; sharedDocument: Y.Doc; clock: ManualClock; scheduler: VirtualTimeScheduler }>;

export const TYPING_WINDOW = 500;

export function createTestStore(
  options: Readonly<{ seed: "blankDeck" | "none"; randomSeed?: number; repairPolicy?: RepairPolicy; clock?: ManualClock; sharedDocument?: Y.Doc }>,
): TestStore {
  const sharedDocument = options.sharedDocument ?? new Y.Doc();
  const clock = options.clock ?? manualClock(1_000);
  const scheduler = new VirtualTimeScheduler();
  const store = createDocumentStore({
    sharedDocument,
    seed: options.seed === "blankDeck" ? { kind: "blankDeck", deckId: "dk_testDeck01" } : { kind: "none" },
    now: clock.now,
    random: seededRandom(options.randomSeed ?? 7),
    scheduler,
    repairPolicy: options.repairPolicy ?? "reportOnly",
    typingMergeWindowMilliseconds: TYPING_WINDOW,
  });
  return { store, sharedDocument, clock, scheduler };
}

/** Mints branded ids from a fixed session prefix, the way the editor does (ids.ts). */
export function idMinter(sessionPrefix: string): <TKind extends ObjectIdKind>(kind: TKind) => MintedIdByKind[TKind] {
  return createPrefixedIdMinter(sessionPrefix).next;
}

export function personId(text: string): PersonId {
  return requireParsed(parsePersonId, text);
}

export function elementId(text: string): ElementId {
  return requireParsed(parseElementId, text);
}

export const ALICE: CommandAuthor = { kind: "person", personId: personId("pe_alice01") };
export const CLAUDE: CommandAuthor = { kind: "agent", name: "Claude", agentSessionId: "agentSession1" };

let commandCounter = 0;

export function envelope(
  options: Readonly<{
    commands: readonly DocumentCommand[];
    author?: CommandAuthor;
    selectionBefore?: Selection;
    selectionAfter?: Selection;
    mergeWithPrevious?: boolean;
  }>,
): CommandEnvelope {
  commandCounter += 1;
  return {
    // A fixed prefix and a counter form a valid object id (ids.ts); the brand records that.
    commandId: `cm_test${String(commandCounter).padStart(4, "0")}` as CommandId,
    author: options.author ?? ALICE,
    commands: options.commands,
    selectionBefore: options.selectionBefore ?? { kind: "none" },
    selectionAfter: options.selectionAfter ?? { kind: "none" },
    mergeWithPrevious: options.mergeWithPrevious ?? false,
  };
}

/** Apply and insist it was applied (a fixture step, not the behaviour under test). */
export function applyOrThrow(store: DocumentStore, applied: CommandEnvelope): void {
  const outcome = store.apply(applied);
  if (outcome.kind !== "applied") throw new Error(`fixture envelope rejected: ${JSON.stringify(outcome.rejection)}`);
}

/** A build step with the usual timing; the effect defaults to a fade in, the trigger to a click. */
export function buildStep(
  options: Readonly<{ id: AnimationStepId; elementId: ElementId; effect?: AnimationEffect; trigger?: AnimationTrigger; durationMilliseconds?: number; delayMilliseconds?: number }>,
): AnimationStep {
  return {
    id: options.id,
    elementId: options.elementId,
    effect: options.effect ?? { kind: "fadeIn" },
    trigger: options.trigger ?? "onClick",
    durationMilliseconds: options.durationMilliseconds ?? 500,
    delayMilliseconds: options.delayMilliseconds ?? 0,
    easing: "easeOut",
    unsupportedKeys: [],
  };
}

export function textBody(...paragraphs: readonly string[]): TextBody {
  return { paragraphs: paragraphs.map((text) => ({ style: {}, runs: text.length === 0 ? [] : [{ kind: "text", text, style: {} }] })) };
}

export function box(options: Readonly<{ x: number; y: number; width: number; height: number }>): Frame {
  return identityFrame(options);
}

export function shape(options: Readonly<{ id: ElementId; frame?: Frame; text?: TextBody; customOutline?: CustomOutline }>): ShapeElement {
  return shapeElement({
    id: options.id,
    frame: options.frame ?? box({ x: 100, y: 100, width: 200, height: 100 }),
    ...(options.customOutline === undefined ? {} : { customOutline: options.customOutline }),
    text: options.text ?? textBody(""),
  });
}

export function line(options: Readonly<{ id: ElementId }>): LineElement {
  return lineElement({
    id: options.id,
    start: { x: 10, y: 10 },
    end: { x: 210, y: 60 },
    stroke: { width: 3, colour: themeColour({ slot: "accent1", alpha: 1 }), dash: "solid" },
  });
}

export function image(options: Readonly<{ id: ElementId; assetId: AssetId }>): ImageElement {
  return imageElement({ id: options.id, assetId: options.assetId, box: { x: 400, y: 100, width: 320, height: 200 }, description: "a photo" });
}

export function group(options: Readonly<{ id: ElementId; children: GroupElement["children"]; rotation?: number }>): GroupElement {
  return {
    id: options.id,
    kind: "group",
    name: "",
    description: "",
    frame: { ...identityFrame({ x: 0, y: 0, width: 1, height: 1 }), rotation: options.rotation ?? 0 },
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    children: options.children,
  };
}

/** A table of the given row and column ids, every cell empty. */
export function table(
  options: Readonly<{ id: ElementId; rows: readonly TableElement["rows"][number]["id"][]; columns: readonly TableElement["columns"][number]["id"][] }>,
): TableElement {
  return {
    id: options.id,
    kind: "table",
    name: "",
    description: "",
    frame: box({ x: 100, y: 400, width: 120 * options.columns.length, height: 40 * options.rows.length }),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    columns: options.columns.map((id) => ({ id, width: 120 })),
    rows: options.rows.map((id) => ({ id, minimumHeight: 40 })),
    cells: options.rows.flatMap((rowId) =>
      options.columns.map((columnId) => ({
        rowId,
        columnId,
        rowSpan: 1,
        columnSpan: 1,
        fill: { kind: "none" } as const,
        borders: { top: null, right: null, bottom: null, left: null },
        textBox: DEFAULT_TEXT_BOX_STYLE,
        text: textBody(""),
      })),
    ),
    opacity: 1,
  };
}

/** An asset whose id is a valid content address derived from `label`; distinct labels give distinct ids. */
export function assetRecord(label: string): AssetRecord {
  return { id: fixtureAssetId(label), mediaType: "image/png", pixelWidth: 640, pixelHeight: 400, name: "photo.png", byteLength: 1234 };
}

/** The label's character codes in hexadecimal, padded to a SHA-256's 64 characters (labels up to 32 characters). */
export function fixtureAssetId(label: string): AssetId {
  const hexadecimal = Array.from(label, (character) => (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("");
  const assetId = parseAssetId(hexadecimal.padEnd(64, "0"));
  if (assetId === null || label.length > 32) throw new Error(`fixture asset label too long or not ASCII: ${label}`);
  return assetId;
}
