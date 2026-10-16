/**
 * Google Slides presentation -> Sasha engine document, through the PRODUCTION import path.
 *
 * WHY importIntoDeck ON A REAL MODEL STORE, not `planImport` alone: the brokered route
 * (google-slides-interchange.ts) parses the answer, fetches and stores every picture, plans, and
 * applies the plan as one envelope to a deck whose engine model validates and repairs it. Rendering
 * the bare plan would skip that validation and measure a document no user ever sees. The test deck
 * service builds decks on the same model store (`createDocumentStore` on a fresh Y.Doc, repairing
 * like the server's replica) and keeps each picture's bytes in memory, which is exactly what the
 * HTML export needs to inline them.
 */
import type { InterchangeLoss } from "../../../mcp/sasha-slides/engine/src/contracts/deck-api.ts";
import type { AssetMediaType, DocumentSnapshot } from "../../../mcp/sasha-slides/engine/src/contracts/document.ts";
import { idSeedFrom, importIntoDeck } from "../../../mcp/sasha-slides/google-slides/import-into-deck.ts";
import { createTestDeckService, testCaller } from "../../../mcp/sasha-slides/google-slides/testing-deck-service.ts";

export type StoredAsset = Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }>;

export type SashaImport = Readonly<{
  snapshot: DocumentSnapshot;
  /** Picture bytes by asset id (a SHA-256), as the deck stored them. */
  assets: ReadonlyMap<string, StoredAsset>;
  losses: readonly InterchangeLoss[];
  elementCount: number;
}>;

export async function importIntoSashaDocument(
  options: Readonly<{
    presentationAnswer: unknown;
    /** The developer grant's token, for pictures Google serves only to it. */
    accessToken: string;
    /** The presentation's .pptx export, for its gradient stops; null reports them as lost. */
    pptxExport: Uint8Array | null;
    fetch: typeof fetch;
    /** Seeds minted ids; a fixed token re-mints the same ids for the same presentation. */
    idSeedToken: string;
    now: () => number;
  }>,
): Promise<SashaImport> {
  const service = await createTestDeckService();
  const caller = testCaller("reverse-roundtrip");
  const created = await service.createDeck({ caller, title: "" });
  if (created.kind !== "opened") throw new Error(`the in-memory deck service could not create a deck (${created.kind})`);
  await using deck = created.deck;
  const outcome = await importIntoDeck({
    presentationAnswer: options.presentationAnswer,
    deck,
    author: { kind: "person", personId: caller.person.id },
    fetch: options.fetch,
    accessToken: options.accessToken,
    pptxExport: options.pptxExport,
    idSeed: idSeedFrom(options.idSeedToken),
    now: options.now,
  });
  switch (outcome.kind) {
    case "imported":
      break;
    case "invalidPresentation":
    case "rejected":
      throw new Error(`the import failed (${outcome.kind}): ${outcome.message}`);
    case "notPermitted":
      throw new Error("the import failed: the deck refused the envelope");
    default:
      return assertNever(outcome);
  }
  const stored = service.decks.get(deck.deckId);
  if (stored === undefined) throw new Error(`the deck ${deck.deckId} vanished from the in-memory service`);
  return { snapshot: deck.snapshot(), assets: new Map(stored.assets), losses: outcome.report.losses, elementCount: outcome.report.elementCount };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
