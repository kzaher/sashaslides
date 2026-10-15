// THE DECK API'S ANSWERS, PARSED AT THE BOUNDARY (deck-api.ts). The client in deck-api-client.ts
// hands every 2xx body to one of these and every other body to `readDeckApiError`; a body that
// does not parse is reported as a server error, never passed on half-checked.

import type { AgentRevertOutcome } from "../../contracts/collaboration.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DeckInvitation, LinkSharing } from "../../contracts/deck-access.ts";
import type {
  AgentSessionSummary,
  AssetUploadBody,
  CreateDeckBody,
  DeckApiErrorBody,
  DeckApiErrorCode,
  DeckDetailsBody,
  DeckListBody,
  DeckSessionBody,
  DeckSummary,
  EmbedSessionBody,
  GoogleSlidesExportBody,
  GoogleSlidesExportReport,
  GoogleSlidesImportBody,
  GoogleSlidesImportReport,
  GoogleSlidesLink,
  InterchangeLoss,
  InviteBody,
} from "../../contracts/deck-api.ts";
import type { AssetMediaType } from "../../contracts/document.ts";
import { parseAssetId, parseDeckId, parseElementId, parseSlideId } from "../../contracts/ids.ts";
import { readDeckMember, readDeckRole, readPerson } from "./collaboration-values.ts";
import {
  identifierAt,
  keysOf,
  listAt,
  memberAt,
  nonNegativeIntegerAt,
  numberAt,
  numberOrNullAt,
  recordOf,
  stringAt,
  stringOrNullAt,
} from "./untrusted-values.ts";

export function readDeckApiError(value: unknown): DeckApiErrorBody {
  const record = recordOf(value, "error body");
  return {
    error: memberAt(record, "error", DECK_API_ERROR_CODES),
    message: stringAt(record, "message"),
    signInAddress: optionalStringAt(record, "signInAddress"),
    connectAddress: optionalStringAt(record, "connectAddress"),
    retryAfterSeconds: record["retryAfterSeconds"] === undefined ? null : numberOrNullAt(record, "retryAfterSeconds"),
  };
}

export function readDeckSessionBody(value: unknown): DeckSessionBody {
  const record = recordOf(value, "session");
  return {
    me: readPerson(record["me"]),
    email: stringOrNullAt(record, "email"),
    csrfToken: stringAt(record, "csrfToken"),
    expiresAt: numberAt(record, "expiresAt"),
    authentication: memberAt(record, "authentication", AUTHENTICATION_KINDS),
  };
}

export function readDeckListBody(value: unknown): DeckListBody {
  return { decks: listAt(recordOf(value, "deck list"), "decks", readDeckSummary) };
}

export function readCreateDeckBody(value: unknown): CreateDeckBody {
  return { deck: readDeckSummary(recordOf(value, "created deck")["deck"]) };
}

export function readDeckDetailsBody(value: unknown): DeckDetailsBody {
  const record = recordOf(value, "deck details");
  return {
    deck: readDeckSummary(record["deck"]),
    members: listAt(record, "members", readDeckMember),
    invitations: listAt(record, "invitations", readInvitation),
    linkSharing: readLinkSharing(record["linkSharing"]),
    agentSessions: listAt(record, "agentSessions", readAgentSession),
  };
}

export function readInviteBody(value: unknown): InviteBody {
  const record = recordOf(value, "invitation answer");
  return { outcome: memberAt(record, "outcome", INVITE_OUTCOMES), details: readDeckDetailsBody(record["details"]) };
}

export function readAssetUploadBody(value: unknown): AssetUploadBody {
  const record = recordOf(value, "asset upload");
  return {
    assetId: identifierAt(record, "assetId", parseAssetId),
    mediaType: memberAt(record, "mediaType", ASSET_MEDIA_TYPES),
    byteLength: nonNegativeIntegerAt(record, "byteLength"),
  };
}

export function readAgentRevertOutcome(value: unknown): AgentRevertOutcome {
  const record = recordOf(value, "revert outcome");
  const kind = memberAt(record, "kind", REVERT_KINDS);
  switch (kind) {
    case "reverted":
      return { kind, stepsReverted: nonNegativeIntegerAt(record, "stepsReverted"), skippedSteps: nonNegativeIntegerAt(record, "skippedSteps") };
    case "nothingToRevert":
      return { kind, skippedSteps: nonNegativeIntegerAt(record, "skippedSteps") };
    case "notPermitted":
      return { kind };
    case "failed":
      return { kind, message: stringAt(record, "message") };
    default:
      return assertNever(kind);
  }
}

export function readGoogleSlidesImportBody(value: unknown): GoogleSlidesImportBody {
  const record = recordOf(value, "import answer");
  return { deck: readDeckSummary(record["deck"]), report: readImportReport(record["report"]) };
}

export function readGoogleSlidesExportBody(value: unknown): GoogleSlidesExportBody {
  const record = recordOf(value, "export answer");
  const kind = memberAt(record, "kind", EXPORT_KINDS);
  switch (kind) {
    case "exported":
      return { kind, report: readExportReport(record["report"]) };
    case "runInAddon":
      return { kind, exportId: stringAt(record, "exportId") };
    default:
      return assertNever(kind);
  }
}

export function readEmbedSessionBody(value: unknown): EmbedSessionBody {
  const record = recordOf(value, "embedded session");
  return {
    bearerToken: stringAt(record, "bearerToken"),
    expiresAt: numberAt(record, "expiresAt"),
    deckId: identifierAt(record, "deckId", parseDeckId),
    session: readDeckSessionBody(record["session"]),
  };
}

const DECK_API_ERROR_CODES = keysOf<DeckApiErrorCode>({
  signedOut: true,
  csrfMismatch: true,
  originRefused: true,
  notFound: true,
  notPermitted: true,
  invalidRequest: true,
  tooLarge: true,
  unsupportedMediaType: true,
  rateLimited: true,
  limitReached: true,
  googleNotConnected: true,
  googlePermissionDenied: true,
  googlePresentationNotFound: true,
  googleFailed: true,
  addonIdentityRejected: true,
  deckUnreadable: true,
  serverError: true,
});
const AUTHENTICATION_KINDS = keysOf<DeckSessionBody["authentication"]>({ cookie: true, bearer: true });
const INVITE_OUTCOMES = keysOf<InviteBody["outcome"]>({ added: true, invited: true, alreadyMember: true });
const ASSET_MEDIA_TYPES = keysOf<AssetMediaType>({ "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/svg+xml": true });
const REVERT_KINDS = keysOf<AgentRevertOutcome["kind"]>({ reverted: true, nothingToRevert: true, notPermitted: true, failed: true });
const EXPORT_KINDS = keysOf<GoogleSlidesExportBody["kind"]>({ exported: true, runInAddon: true });
const LINK_SHARING_KINDS = keysOf<LinkSharing["kind"]>({ off: true, anyoneSignedIn: true });
const LINK_SHARING_ROLES = keysOf<"viewer" | "commenter">({ viewer: true, commenter: true });
const INVITABLE_ROLES = keysOf<DeckInvitation["role"]>({ editor: true, commenter: true, viewer: true });

function optionalStringAt(record: Readonly<Record<string, unknown>>, key: string): string | null {
  return record[key] === undefined ? null : stringOrNullAt(record, key);
}

function readDeckSummary(value: unknown): DeckSummary {
  const record = recordOf(value, "deck");
  return {
    deckId: identifierAt(record, "deckId", parseDeckId),
    title: stringAt(record, "title"),
    role: readDeckRole(record["role"]),
    owner: readPerson(record["owner"]),
    createdAt: numberAt(record, "createdAt"),
    updatedAt: numberAt(record, "updatedAt"),
    googleSlides: record["googleSlides"] === null || record["googleSlides"] === undefined ? null : readGoogleSlidesLink(record["googleSlides"]),
  };
}

function readGoogleSlidesLink(value: unknown): GoogleSlidesLink {
  const record = recordOf(value, "Google Slides link");
  return {
    presentationId: stringAt(record, "presentationId"),
    presentationAddress: stringAt(record, "presentationAddress"),
    title: stringAt(record, "title"),
    lastImportedAt: numberOrNullAt(record, "lastImportedAt"),
    lastExportedAt: numberOrNullAt(record, "lastExportedAt"),
    importedRevisionId: stringOrNullAt(record, "importedRevisionId"),
  };
}

function readInvitation(value: unknown): DeckInvitation {
  const record = recordOf(value, "invitation");
  return {
    invitationId: stringAt(record, "invitationId"),
    email: stringAt(record, "email"),
    role: memberAt(record, "role", INVITABLE_ROLES),
    invitedAt: numberAt(record, "invitedAt"),
  };
}

function readLinkSharing(value: unknown): LinkSharing {
  const record = recordOf(value, "link sharing");
  const kind = memberAt(record, "kind", LINK_SHARING_KINDS);
  switch (kind) {
    case "off":
      return { kind };
    case "anyoneSignedIn":
      return { kind, role: memberAt(record, "role", LINK_SHARING_ROLES) };
    default:
      return assertNever(kind);
  }
}

function readAgentSession(value: unknown): AgentSessionSummary {
  const record = recordOf(value, "agent session");
  return {
    agentSessionId: stringAt(record, "agentSessionId"),
    agentName: stringAt(record, "agentName"),
    editCount: nonNegativeIntegerAt(record, "editCount"),
    lastEditAt: numberAt(record, "lastEditAt"),
  };
}

function readImportReport(value: unknown): GoogleSlidesImportReport {
  const record = recordOf(value, "import report");
  return {
    presentationId: stringAt(record, "presentationId"),
    title: stringAt(record, "title"),
    slideCount: nonNegativeIntegerAt(record, "slideCount"),
    elementCount: nonNegativeIntegerAt(record, "elementCount"),
    losses: listAt(record, "losses", readLoss),
  };
}

function readExportReport(value: unknown): GoogleSlidesExportReport {
  const record = recordOf(value, "export report");
  return {
    presentationId: stringAt(record, "presentationId"),
    presentationAddress: stringAt(record, "presentationAddress"),
    slideCount: nonNegativeIntegerAt(record, "slideCount"),
    requestCount: nonNegativeIntegerAt(record, "requestCount"),
    losses: listAt(record, "losses", readLoss),
  };
}

function readLoss(value: unknown): InterchangeLoss {
  const record = recordOf(value, "loss");
  return {
    slideId: record["slideId"] === null ? null : identifierAt(record, "slideId", parseSlideId),
    elementId: record["elementId"] === null ? null : identifierAt(record, "elementId", parseElementId),
    feature: stringAt(record, "feature"),
    detail: stringAt(record, "detail"),
  };
}
