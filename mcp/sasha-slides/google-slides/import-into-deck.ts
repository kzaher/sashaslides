/**
 * An import, end to end on one deck: parse, fetch and store the pictures, plan, then write the
 * whole presentation as ONE envelope on the deck's room (SPEC.md 21.12), so collaborators see it
 * arrive at once and one undo removes it.
 *
 * The envelope REPLACES the deck's content: the blank deck a new import starts from, or the bound
 * deck an add-on "Import again" refreshes, loses its slides and layouts first, inside the same
 * envelope, so there is never a moment with both or neither.
 */
import type { CommandAuthor, CommandEnvelope, DocumentCommand } from "../engine/src/contracts/commands.ts";
import type { GoogleSlidesImportReport, GoogleSlidesLink } from "../engine/src/contracts/deck-api.ts";
import type { DocumentSnapshot } from "../engine/src/contracts/document.ts";
import type { CommandId, IdSeed } from "../engine/src/contracts/ids.ts";
import { mintId } from "../engine/src/contracts/ids.ts";
import type { DeckHandle } from "../deck-contracts/deck-service-contract.ts";
import { fetchImportImages } from "./import-assets.ts";
import { imageAddressesIn, planImport, type ImportPlan } from "./import-presentation.ts";
import { presentationAddressOf } from "./slides-client.ts";
import { parsePresentation } from "./slides-presentation.ts";

export type ImportOutcome =
  | Readonly<{ kind: "imported"; report: GoogleSlidesImportReport; link: GoogleSlidesLink }>
  | Readonly<{ kind: "invalidPresentation"; message: string }>
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "notPermitted" }>;

export async function importIntoDeck(
  options: Readonly<{
    presentationAnswer: unknown;
    deck: DeckHandle;
    author: CommandAuthor;
    fetch: typeof fetch;
    /** The grant's token, for pictures Google serves only to it; null on the add-on path. */
    accessToken: string | null;
    idSeed: IdSeed;
    now: () => number;
  }>,
): Promise<ImportOutcome> {
  const parsed = parsePresentation(options.presentationAnswer);
  if (parsed.kind === "invalid") return { kind: "invalidPresentation", message: parsed.message };
  const presentation = parsed.presentation;
  const images = await fetchImportImages({ addresses: imageAddressesIn(presentation), fetch: options.fetch, deck: options.deck, accessToken: options.accessToken });
  const plan = planImport({ presentation, images, idSeed: options.idSeed });
  const envelope = importEnvelope({ plan, existing: options.deck.snapshot(), author: options.author, commandId: mintId({ seed: options.idSeed, kind: "command" }).id });
  const applied = await options.deck.apply({ envelope, summaryForCollaborators: `imported "${presentation.title}" from Google Slides` });
  switch (applied.kind) {
    case "applied":
      break;
    case "rejected":
      return { kind: "rejected", message: `The deck refused the import: ${JSON.stringify(applied.outcome.rejection)}` };
    case "notPermitted":
      return { kind: "notPermitted" };
    case "tooLarge":
      return { kind: "rejected", message: applied.message };
    default:
      return assertNever(applied);
  }
  const previous = options.deck.googleSlidesLink();
  const link: GoogleSlidesLink = {
    presentationId: presentation.presentationId,
    presentationAddress: presentationAddressOf(presentation.presentationId),
    title: presentation.title,
    lastImportedAt: options.now(),
    lastExportedAt: previous?.presentationId === presentation.presentationId ? previous.lastExportedAt : null,
    importedRevisionId: presentation.revisionId,
  };
  await options.deck.setGoogleSlidesLink({ link });
  return {
    kind: "imported",
    link,
    report: {
      presentationId: presentation.presentationId,
      title: presentation.title,
      slideCount: plan.slides.length,
      elementCount: plan.elementCount,
      losses: plan.losses,
    },
  };
}

/** The one envelope that replaces `existing`'s content with the plan (see the header). */
export function importEnvelope(
  options: Readonly<{ plan: ImportPlan; existing: DocumentSnapshot; author: CommandAuthor; commandId: CommandId }>,
): CommandEnvelope {
  const { plan, existing } = options;
  const commands: DocumentCommand[] = [
    { kind: "setTitle", title: plan.title },
    { kind: "updateTheme", patch: plan.theme },
    ...plan.assets.map((asset): DocumentCommand => ({ kind: "registerAsset", asset })),
  ];
  if (existing.slides.length > 0) commands.push({ kind: "deleteSlides", slideIds: existing.slides.map((slide) => slide.id) });
  const keptLayoutIds = new Set(plan.layouts.map((layout) => layout.id));
  for (const layout of existing.layouts) if (!keptLayoutIds.has(layout.id)) commands.push({ kind: "deleteLayout", layoutId: layout.id });
  for (const layout of plan.layouts) commands.push({ kind: "upsertLayout", layout });
  if (plan.slides.length > 0) commands.push({ kind: "insertSlides", slides: plan.slides, after: null });
  return {
    commandId: options.commandId,
    author: options.author,
    commands,
    selectionBefore: { kind: "none" },
    selectionAfter: { kind: "none" },
    mergeWithPrevious: false,
  };
}

/** A fresh, deterministic-per-call id seed from the interchange's random token source. */
export function idSeedFrom(randomToken: string): IdSeed {
  const prefix = randomToken.replace(/[^A-Za-z0-9]/g, "").padEnd(8, "0").slice(0, 8);
  return { sessionPrefix: prefix, counter: 0 };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
