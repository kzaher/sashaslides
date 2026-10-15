/**
 * Google Slides import and export, and the add-on handoff (SPEC.md 21.2, 21.12, 21.13, 21.16):
 * the request handler the collaboration server's router mounts for `GOOGLE_SLIDES_ROUTE_PREFIXES`,
 * the deck's `/google-slides/` segment, and the shared `/oauth/google/callback` (FIRST, and
 * answering only a `state` this module issued).
 *
 *   GET  /deck-api/google-slides/connect?return=   consent for presentations + drive.file
 *   GET  /oauth/google/callback                     that consent's answer, saved via GoogleGrantStore
 *   POST /deck-api/google-slides/import             presentations.get with the grant -> a new deck
 *   POST /deck-api/decks/<id>/google-slides/export  exported (grant) | runInAddon (embedded, no grant)
 *   GET  /deck-api/export-assets/<token>/<sha256>   a picture for Google's createImage, 30 minutes
 *   POST /deck-api/addon/handoff                    identity token + binding secret -> open | changed | needsImport
 *   POST /deck-api/addon/import                     the presentation Code.gs read -> the bound deck
 *   GET  /deck-api/addon/export/<id>                the plan Code.gs runs
 *   POST /deck-api/addon/export/<id>/result         what happened
 *
 * WHO IS WHO. Routes under `/deck-api/google-slides/` and the deck segment get the router's
 * signed-in `caller`. The add-on's routes get none: Code.gs proves the PERSON with Google's
 * identity token (identity-token.ts, audience pinned in addon-identity.ts) and proves EDIT ACCESS
 * TO THE PRESENTATION with the binding secret only its editors can read; the server stores and
 * compares only the secret's SHA-256 (`DeckService.bindAddon`). Import tokens are single use. An
 * add-on EXPORT is answered only to the account that started it: the binding secret proves the
 * presentation, not the person (every editor of it can read the secret), so the identity token's
 * Google subject is mapped to its account the way the handoff maps it and compared with the
 * export's caller.
 *
 * AN UNREADABLE DECK (its saved snapshot does not open or decode) answers 503 `deckUnreadable`
 * with the service's sentence, never a 404 or an import into a partial deck.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AddonExportPlanBody,
  AddonHandoffBody,
  AddonImportBody,
  DeckApiErrorCode,
  GoogleSlidesExportBody,
  GoogleSlidesImportBody,
  GoogleSlidesLink,
} from "../engine/src/contracts/deck-api.ts";
import { DECK_API_PATHS } from "../engine/src/contracts/deck-api.ts";
import { roleAllows } from "../engine/src/contracts/deck-access.ts";
import type { AssetId, DeckId } from "../engine/src/contracts/ids.ts";
import { parseAssetId, parseDeckId } from "../engine/src/contracts/ids.ts";
import {
  GOOGLE_CALLBACK_SHARED_PATH,
  type CreateGoogleSlidesInterchange,
  type DeckCaller,
  type DeckRouteHandler,
} from "../deck-contracts/deck-service-contract.ts";
import { ADDON_BINDING_SECRET_HEADER, ADDON_IDENTITY_HEADER, ADDON_PAGE_IDS_HEADER, MINIMUM_BINDING_SECRET_LENGTH, verifyAddonIdentityToken } from "./addon-identity.ts";
import { addonExportRequests, runExport, type ExportTarget } from "./export-run.ts";
import { createExpiringTable } from "./expiring-table.ts";
import { accessTokenForIdentity, exchangeAuthorizationCode, GOOGLE_SLIDES_CONNECT_SCOPES, googleConsentAddress } from "./google-oauth.ts";
import { answerError, answerWithBody, fieldOf, readRequestBody, redirect, stringFieldOf } from "./http-answers.ts";
import { createIdentityVerifier, type IdentityClaims } from "./identity-token.ts";
import { idSeedFrom, importIntoDeck, type ImportOutcome } from "./import-into-deck.ts";
import { createSlidesClient, googleFailureCodeOf, presentationAddressOf, presentationIdFrom } from "./slides-client.ts";

export const EXPORT_ASSET_LIFETIME_MILLISECONDS = 30 * 60 * 1000;
export const CONNECT_STATE_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
export const IMPORT_TOKEN_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
export const ADDON_EXPORT_LIFETIME_MILLISECONDS = 30 * 60 * 1000;
/** SPEC.md 21.10: JSON bodies 1 megabyte, the add-on import 48. */
const REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
const ADDON_IMPORT_BODY_LIMIT_BYTES = 48 * 1024 * 1024;
const TABLE_CAPACITY = 10_000;

export const createGoogleSlidesInterchange: CreateGoogleSlidesInterchange = (options) => {
  const { deckService, now } = options;
  const verifier = createIdentityVerifier({ fetch: options.fetch, now });
  const connectStates = createExpiringTable<Readonly<{ caller: DeckCaller; returnPath: string }>>({ now, capacity: TABLE_CAPACITY });
  const exportAssets = createExpiringTable<Readonly<{ caller: DeckCaller; deckId: DeckId; assetIds: ReadonlySet<string> }>>({ now, capacity: TABLE_CAPACITY });
  const importTokens = createExpiringTable<ImportTicket>({ now, capacity: TABLE_CAPACITY });
  const addonExports = createExpiringTable<AddonExport>({ now, capacity: TABLE_CAPACITY });
  const redirectAddress = `${options.publicUrl.replace(/\/$/, "")}${GOOGLE_CALLBACK_SHARED_PATH}`;
  const authorOf = (caller: DeckCaller) => ({ kind: "person" as const, personId: caller.person.id });

  /** A fresh export-asset capability for these assets (30 minutes), and the address maker over it. */
  const exportAssetAddresses = (grant: Readonly<{ caller: DeckCaller; deckId: DeckId; assetIds: readonly AssetId[] }>): ((assetId: AssetId) => string) => {
    const token = options.randomToken();
    exportAssets.put({ key: token, value: { caller: grant.caller, deckId: grant.deckId, assetIds: new Set(grant.assetIds) }, lifetimeMilliseconds: EXPORT_ASSET_LIFETIME_MILLISECONDS });
    return (assetId) => `${options.publicUrl.replace(/\/$/, "")}${DECK_API_PATHS.exportAsset(token, assetId)}`;
  };

  const verifyAddon = (identityToken: string): Promise<IdentityClaims | null> =>
    verifyAddonIdentityToken({ verifier, identityToken, warn: (message) => options.warn(`google-slides: ${message}`) });

  const handleConnect = async (request: RouteRequest): Promise<void> => {
    const { response, url, caller } = request;
    if (caller === null) return answerError({ response, status: 401, error: "signedOut", message: "Sign in to connect Google Slides.", signInAddress: "/account/deck-session?return=/decks" });
    const state = options.randomToken();
    connectStates.put({ key: state, value: { caller, returnPath: safeReturnPath(url.searchParams.get("return")) }, lifetimeMilliseconds: CONNECT_STATE_LIFETIME_MILLISECONDS });
    redirect({ response, location: googleConsentAddress({ client: options.googleClient, redirectAddress, state, scopes: GOOGLE_SLIDES_CONNECT_SCOPES }) });
  };

  /** Resolves false for a state this module did not issue: the authorization server's own callback then answers. */
  const handleCallback = async (request: RouteRequest): Promise<boolean> => {
    const { response, url } = request;
    const state = url.searchParams.get("state");
    if (state === null) return false;
    const pending = connectStates.take(state);
    if (pending === null) return false;
    const finish = (outcome: string): void => redirect({ response, location: withQuery({ path: pending.returnPath, key: "googleSlides", value: outcome }) });
    const code = url.searchParams.get("code");
    if (code === null) {
      finish("declined");
      return true;
    }
    const exchanged = await exchangeAuthorizationCode({ fetch: options.fetch, client: options.googleClient, code, redirectAddress, now });
    if (exchanged.kind === "failed" || exchanged.identityToken === null) {
      options.warn(`google-slides: connect code exchange failed: ${exchanged.kind === "failed" ? exchanged.message : "no identity token"}`);
      finish("failed");
      return true;
    }
    const verdict = await verifier.verify({ token: exchanged.identityToken, audience: options.googleClient.clientId });
    if (verdict.kind === "rejected") {
      options.warn(`google-slides: connect identity token rejected: ${verdict.reason}`);
      finish("failed");
      return true;
    }
    const saved = await options.googleGrants.save({
      accountId: pending.caller.accountId,
      identity: {
        subject: verdict.claims.subject,
        email: verdict.claims.email.length > 0 ? verdict.claims.email : null,
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        accessTokenExpiresAtMs: exchanged.expiresAt,
        grantedScopes: exchanged.grantedScopes,
      },
    });
    finish(saved === "saved" ? "connected" : "anotherAccount");
    return true;
  };

  const handleImport = async (request: RouteRequest): Promise<void> => {
    const { response, caller } = request;
    if (caller === null) return answerError({ response, status: 401, error: "signedOut", message: "Sign in to import.", signInAddress: "/account/deck-session?return=/decks" });
    const body = await readRequestBody({ request: request.request, maximumBytes: REQUEST_BODY_LIMIT_BYTES });
    if (body.kind !== "parsed") return answerError({ response, status: body.kind === "tooLarge" ? 413 : 400, error: body.kind === "tooLarge" ? "tooLarge" : "invalidRequest", message: "The request is not a JSON import request." });
    const presentationId = presentationIdFrom(stringFieldOf(body.value, "presentation") ?? "");
    if (presentationId === null) return answerError({ response, status: 400, error: "invalidRequest", message: "That is not a Google Slides address or presentation id." });
    const connectAddress = `${DECK_API_PATHS.googleSlidesConnect}?return=${encodeURIComponent("/decks")}`;
    const grant = await options.googleGrants.forAccount({ accountId: caller.accountId });
    if (grant.kind === "notConnected") return answerError({ response, status: 409, error: "googleNotConnected", message: "Connect Google Slides to import from it.", connectAddress });
    const token = await accessTokenForIdentity({ fetch: options.fetch, client: options.googleClient, identity: grant.identity, now });
    if (token.kind === "notConnected") return answerError({ response, status: 409, error: "googleNotConnected", message: token.message, connectAddress });
    const slides = createSlidesClient({ fetch: options.fetch, accessToken: token.accessToken });
    const read = await slides.getPresentation({ presentationId, fields: null });
    if (read.kind === "failed") {
      const code = googleFailureCodeOf(read.status);
      return answerError({ response, status: statusOfGoogleFailure(code), error: code, message: read.message, ...(code === "googleNotConnected" ? { connectAddress } : {}) });
    }
    const created = await deckService.createDeck({ caller, title: stringFieldOf(read.body, "title") ?? "Imported presentation" });
    switch (created.kind) {
      case "opened":
        break;
      case "limitReached":
        return answerError({ response, status: 409, error: "limitReached", message: created.message });
      case "notFound":
      case "notPermitted":
        return answerError({ response, status: 403, error: "notPermitted", message: "A deck could not be created." });
      case "deckUnreadable":
        return answerUnreadable({ response, message: created.message });
      default:
        return assertNever(created);
    }
    await using deck = created.deck;
    const imported = await importIntoDeck({ presentationAnswer: read.body, deck, author: authorOf(caller), fetch: options.fetch, accessToken: token.accessToken, idSeed: idSeedFrom(options.randomToken()), now });
    if (imported.kind !== "imported") return answerImportFailure({ response, outcome: imported });
    const answer: GoogleSlidesImportBody = { deck: deck.summary(), report: imported.report };
    answerWithBody({ response, status: 201, body: answer });
  };

  const handleExport = async (request: RouteRequest & Readonly<{ deckId: DeckId }>): Promise<void> => {
    const { response, caller, deckId } = request;
    if (caller === null) return answerError({ response, status: 401, error: "signedOut", message: "Sign in to export.", signInAddress: `/account/deck-session?return=/deck/${deckId}` });
    const body = await readRequestBody({ request: request.request, maximumBytes: REQUEST_BODY_LIMIT_BYTES });
    const targetKind = body.kind === "parsed" ? stringFieldOf(fieldOf(body.value, "target"), "kind") : null;
    if (targetKind !== "newPresentation" && targetKind !== "linkedPresentation") return answerError({ response, status: 400, error: "invalidRequest", message: "Say where to export: a new or the linked presentation." });
    const opened = await deckService.openDeck({ caller, deckId });
    if (opened.kind === "deckUnreadable") return answerUnreadable({ response, message: opened.message });
    if (opened.kind !== "opened") return answerError({ response, status: 404, error: "notFound", message: "No such deck." });
    await using deck = opened.deck;
    if (!roleAllows({ role: deck.role(), permission: "exchangeWithGoogleSlides" })) return answerError({ response, status: 403, error: "notPermitted", message: "Only editors can export this deck." });
    const link = deck.googleSlidesLink();
    if (targetKind === "linkedPresentation" && link === null) return answerError({ response, status: 409, error: "invalidRequest", message: "This deck is not linked to a presentation yet." });
    const target: ExportTarget = targetKind === "linkedPresentation" && link !== null ? { kind: "linkedPresentation", presentationId: link.presentationId, importedPageIds: link.importedPageIds } : { kind: "newPresentation" };

    const grant = await options.googleGrants.forAccount({ accountId: caller.accountId });
    const token = grant.kind === "ok" ? await accessTokenForIdentity({ fetch: options.fetch, client: options.googleClient, identity: grant.identity, now }) : null;
    if (token === null || token.kind === "notConnected") {
      if (isEmbedded(request.request) && link !== null) {
        const exportId = options.randomToken();
        addonExports.put({ key: exportId, value: { caller, deckId, presentationId: link.presentationId, finished: null }, lifetimeMilliseconds: ADDON_EXPORT_LIFETIME_MILLISECONDS });
        const answer: GoogleSlidesExportBody = { kind: "runInAddon", exportId };
        return answerWithBody({ response, status: 200, body: answer });
      }
      return answerError({ response, status: 409, error: "googleNotConnected", message: "Connect Google Slides to export to it.", connectAddress: `${DECK_API_PATHS.googleSlidesConnect}?return=${encodeURIComponent(`/deck/${deckId}`)}` });
    }
    const snapshot = deck.snapshot();
    const assetAddress = exportAssetAddresses({ caller, deckId, assetIds: snapshot.assets.map((asset) => asset.id) });
    const outcome = await runExport({ slides: createSlidesClient({ fetch: options.fetch, accessToken: token.accessToken }), snapshot, target, assetAddress });
    switch (outcome.kind) {
      case "exported": {
        await deck.setGoogleSlidesLink({ link: exportedLink({ previous: link, presentationId: outcome.report.presentationId, title: outcome.title, now: now() }) });
        const answer: GoogleSlidesExportBody = { kind: "exported", report: outcome.report };
        return answerWithBody({ response, status: 200, body: answer });
      }
      case "failed":
        if (outcome.presentationId !== null) await deck.setGoogleSlidesLink({ link: exportedLink({ previous: link, presentationId: outcome.presentationId, title: snapshot.title, now: now() }) });
        return answerError({ response, status: statusOfGoogleFailure(outcome.code), error: outcome.code, message: outcome.message });
      default:
        return assertNever(outcome);
    }
  };

  const handleExportAsset = async (request: RouteRequest & Readonly<{ token: string; assetId: AssetId }>): Promise<void> => {
    const { response } = request;
    const grant = exportAssets.get(request.token);
    if (grant === null || !grant.assetIds.has(request.assetId)) return answerError({ response, status: 404, error: "notFound", message: "No such picture." });
    const opened = await deckService.openDeck({ caller: grant.caller, deckId: grant.deckId });
    if (opened.kind === "deckUnreadable") return answerUnreadable({ response, message: opened.message });
    if (opened.kind !== "opened") return answerError({ response, status: 404, error: "notFound", message: "No such picture." });
    await using deck = opened.deck;
    const asset = await deck.readAsset({ assetId: request.assetId });
    if (asset === null) return answerError({ response, status: 404, error: "notFound", message: "No such picture." });
    response.writeHead(200, {
      "content-type": asset.mediaType,
      "content-length": String(asset.bytes.byteLength),
      "cache-control": "private, max-age=1800",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    response.end(Buffer.from(asset.bytes));
  };

  const handleHandoff = async (request: RouteRequest): Promise<void> => {
    const { response } = request;
    const body = await readRequestBody({ request: request.request, maximumBytes: REQUEST_BODY_LIMIT_BYTES });
    if (body.kind !== "parsed") return answerError({ response, status: 400, error: "invalidRequest", message: "The handoff is not JSON." });
    const identityToken = stringFieldOf(body.value, "identityToken");
    const presentationId = stringFieldOf(body.value, "presentationId");
    const bindingSecret = stringFieldOf(body.value, "bindingSecret");
    const revisionId = stringFieldOf(body.value, "revisionId");
    if (identityToken === null || presentationId === null || bindingSecret === null || revisionId === null || bindingSecret.length < MINIMUM_BINDING_SECRET_LENGTH) {
      return answerError({ response, status: 400, error: "invalidRequest", message: "The handoff needs an identity token, the presentation, its binding secret and its revision." });
    }
    const claims = await verifyAddon(identityToken);
    if (claims === null) return answerError({ response, status: 401, error: "addonIdentityRejected", message: "Sign in again: Google did not vouch for this request." });
    const caller = await options.accounts.accountForGoogleIdentity({ subject: claims.subject, email: claims.email, emailVerified: claims.emailVerified });
    const bindingSecretHash = sha256(bindingSecret);
    const ticketFor = (replaceDeckId: DeckId | null): string => {
      const importToken = options.randomToken();
      importTokens.put({ key: sha256(importToken), value: { caller, presentationId, bindingSecretHash, replaceDeckId }, lifetimeMilliseconds: IMPORT_TOKEN_LIFETIME_MILLISECONDS });
      return importToken;
    };
    const boundDeckId = await deckService.findDeckByAddonBinding({ bindingSecretHash });
    if (boundDeckId === null) {
      const answer: AddonHandoffBody = { kind: "needsImport", importToken: ticketFor(null) };
      return answerWithBody({ response, status: 200, body: answer });
    }
    const opened = await deckService.openDeck({ caller, deckId: boundDeckId });
    if (opened.kind === "deckUnreadable") return answerUnreadable({ response, message: opened.message });
    if (opened.kind !== "opened") return answerError({ response, status: 403, error: "notPermitted", message: "This presentation's Sasha deck belongs to someone who has not shared it with you." });
    await using deck = opened.deck;
    if (!roleAllows({ role: deck.role(), permission: "editDocument" })) {
      return answerError({ response, status: 403, error: "notPermitted", message: "This presentation's Sasha deck belongs to someone who has not shared it with you." });
    }
    const ticket = await options.embedTickets.issue({ accountId: caller.accountId, deckId: boundDeckId });
    const imported = deck.googleSlidesLink()?.importedRevisionId ?? null;
    const answer: AddonHandoffBody =
      imported === revisionId ? { kind: "open", deckId: boundDeckId, ticket } : { kind: "changedSinceImport", deckId: boundDeckId, ticket, importToken: ticketFor(boundDeckId) };
    answerWithBody({ response, status: 200, body: answer });
  };

  const handleAddonImport = async (request: RouteRequest): Promise<void> => {
    const { response } = request;
    const body = await readRequestBody({ request: request.request, maximumBytes: ADDON_IMPORT_BODY_LIMIT_BYTES });
    if (body.kind !== "parsed") return answerError({ response, status: body.kind === "tooLarge" ? 413 : 400, error: body.kind === "tooLarge" ? "tooLarge" : "invalidRequest", message: "The import is not JSON." });
    const importToken = stringFieldOf(body.value, "importToken");
    const ticket = importToken === null ? null : importTokens.take(sha256(importToken));
    if (ticket === null) return answerError({ response, status: 401, error: "addonIdentityRejected", message: "This import was already used or has expired; open the editor again." });
    const replaceDeckId = stringFieldOf(body.value, "replaceDeckId");
    if (replaceDeckId !== ticket.replaceDeckId) return answerError({ response, status: 400, error: "invalidRequest", message: "The import names a different deck than its handoff." });
    const presentation = fieldOf(body.value, "presentation");
    if (stringFieldOf(presentation, "presentationId") !== ticket.presentationId) return answerError({ response, status: 400, error: "invalidRequest", message: "The presentation is not the one the handoff named." });
    const { caller } = ticket;
    const opened = ticket.replaceDeckId === null ? await deckService.createDeck({ caller, title: stringFieldOf(presentation, "title") ?? "Imported presentation" }) : await deckService.openDeck({ caller, deckId: ticket.replaceDeckId });
    if (opened.kind === "deckUnreadable") return answerUnreadable({ response, message: opened.message });
    if (opened.kind !== "opened") return answerError({ response, status: opened.kind === "limitReached" ? 409 : 403, error: opened.kind === "limitReached" ? "limitReached" : "notPermitted", message: "The deck could not be opened for the import." });
    await using deck = opened.deck;
    const imported = await importIntoDeck({ presentationAnswer: presentation, deck, author: authorOf(caller), fetch: options.fetch, accessToken: null, idSeed: idSeedFrom(options.randomToken()), now });
    if (imported.kind !== "imported") return answerImportFailure({ response, outcome: imported });
    await deck.bindAddon({ bindingSecretHash: ticket.bindingSecretHash, presentationId: ticket.presentationId });
    const answer: AddonImportBody = { deckId: deck.deckId, ticket: await options.embedTickets.issue({ accountId: caller.accountId, deckId: deck.deckId }), report: imported.report };
    answerWithBody({ response, status: 201, body: answer });
  };

  /** Code.gs's own calls about an export: the identity token, and the binding secret of the export's deck. */
  const authenticateAddonExport = async (request: RouteRequest & Readonly<{ exportId: string }>): Promise<AddonExport | null> => {
    const record = addonExports.get(request.exportId);
    const identityToken = headerOf(request.request, ADDON_IDENTITY_HEADER);
    const bindingSecret = headerOf(request.request, ADDON_BINDING_SECRET_HEADER);
    if (record === null || identityToken === null || bindingSecret === null) return null;
    const claims = await verifyAddon(identityToken);
    if (claims === null) return null;
    const signedIn = await options.accounts.accountForGoogleIdentity({ subject: claims.subject, email: claims.email, emailVerified: claims.emailVerified });
    if (signedIn.accountId !== record.caller.accountId) {
      options.warn("google-slides: add-on export refused: the identity token belongs to a different account than the one that started the export");
      return null;
    }
    const boundDeckId = await deckService.findDeckByAddonBinding({ bindingSecretHash: sha256(bindingSecret) });
    return boundDeckId === record.deckId ? record : null;
  };

  const handleAddonExportPlan = async (request: RouteRequest & Readonly<{ exportId: string }>): Promise<void> => {
    const { response } = request;
    const record = await authenticateAddonExport(request);
    if (record === null) return answerError({ response, status: 401, error: "addonIdentityRejected", message: "Sign in again: this export could not be verified." });
    const opened = await deckService.openDeck({ caller: record.caller, deckId: record.deckId });
    if (opened.kind === "deckUnreadable") return answerUnreadable({ response, message: opened.message });
    if (opened.kind !== "opened") return answerError({ response, status: 404, error: "notFound", message: "No such deck." });
    await using deck = opened.deck;
    const snapshot = deck.snapshot();
    const existingPageIds = (headerOf(request.request, ADDON_PAGE_IDS_HEADER) ?? "").split(",").filter((pageId) => pageId.length > 0);
    const plan = addonExportRequests({ snapshot, existingPageIds, importedPageIds: deck.googleSlidesLink()?.importedPageIds ?? [], assetAddress: exportAssetAddresses({ caller: record.caller, deckId: record.deckId, assetIds: snapshot.assets.map((asset) => asset.id) }) });
    const answer: AddonExportPlanBody = { presentationId: record.presentationId, requests: plan.requests };
    answerWithBody({ response, status: 200, body: answer });
  };

  const handleAddonExportResult = async (request: RouteRequest & Readonly<{ exportId: string }>): Promise<void> => {
    const { response } = request;
    const record = await authenticateAddonExport(request);
    if (record === null) return answerError({ response, status: 401, error: "addonIdentityRejected", message: "Sign in again: this export could not be verified." });
    const body = await readRequestBody({ request: request.request, maximumBytes: REQUEST_BODY_LIMIT_BYTES });
    const kind = body.kind === "parsed" ? stringFieldOf(fieldOf(body.value, "outcome"), "kind") : null;
    if (kind !== "applied" && kind !== "failed") return answerError({ response, status: 400, error: "invalidRequest", message: "The result is neither applied nor failed." });
    addonExports.put({ key: request.exportId, value: { ...record, finished: kind }, lifetimeMilliseconds: ADDON_EXPORT_LIFETIME_MILLISECONDS });
    if (kind === "applied") {
      const opened = await deckService.openDeck({ caller: record.caller, deckId: record.deckId });
      if (opened.kind === "opened") {
        await using deck = opened.deck;
        await deck.setGoogleSlidesLink({ link: exportedLink({ previous: deck.googleSlidesLink(), presentationId: record.presentationId, title: deck.snapshot().title, now: now() }) });
      }
    }
    answerWithBody({ response, status: 200, body: { recorded: kind } });
  };

  const handleRequest: DeckRouteHandler = async ({ request, response, url, caller }) => {
    const routed: RouteRequest = { request, response, url, caller };
    const path = url.pathname;
    const method = request.method ?? "GET";
    if (path === GOOGLE_CALLBACK_SHARED_PATH) return method === "GET" ? handleCallback(routed) : false;
    if (path === DECK_API_PATHS.googleSlidesConnect && method === "GET") return answered(handleConnect(routed));
    if (path === DECK_API_PATHS.googleSlidesImport && method === "POST") return answered(handleImport(routed));
    if (path === DECK_API_PATHS.addonHandoff && method === "POST") return answered(handleHandoff(routed));
    if (path === DECK_API_PATHS.addonImport && method === "POST") return answered(handleAddonImport(routed));
    const exportMatch = /^\/deck-api\/decks\/([^/]+)\/google-slides\/export$/.exec(path);
    const deckId = exportMatch?.[1] === undefined ? null : parseDeckId(decodeURIComponent(exportMatch[1]));
    if (deckId !== null && method === "POST") return answered(handleExport({ ...routed, deckId }));
    const assetMatch = /^\/deck-api\/export-assets\/([A-Za-z0-9_-]+)\/([0-9a-f]{64})$/.exec(path);
    const assetId = assetMatch?.[2] === undefined ? null : parseAssetId(assetMatch[2]);
    if (assetMatch?.[1] !== undefined && assetId !== null && method === "GET") return answered(handleExportAsset({ ...routed, token: assetMatch[1], assetId }));
    const addonExportMatch = /^\/deck-api\/addon\/export\/([A-Za-z0-9_-]+)(\/result)?$/.exec(path);
    if (addonExportMatch?.[1] !== undefined) {
      const exportId = addonExportMatch[1];
      if (addonExportMatch[2] === undefined && method === "GET") return answered(handleAddonExportPlan({ ...routed, exportId }));
      if (addonExportMatch[2] !== undefined && method === "POST") return answered(handleAddonExportResult({ ...routed, exportId }));
    }
    if (isOwnedPath(path)) {
      answerError({ response, status: 404, error: "notFound", message: "No such Google Slides route." });
      return true;
    }
    return false;
  };
  return { handleRequest };
};

type RouteRequest = Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL; caller: DeckCaller | null }>;

type ImportTicket = Readonly<{ caller: DeckCaller; presentationId: string; bindingSecretHash: string; replaceDeckId: DeckId | null }>;

type AddonExport = Readonly<{ caller: DeckCaller; deckId: DeckId; presentationId: string; finished: "applied" | "failed" | null }>;

async function answered(work: Promise<void>): Promise<true> {
  await work;
  return true;
}

function isOwnedPath(path: string): boolean {
  return path.startsWith("/deck-api/google-slides/") || path.startsWith("/deck-api/addon/") || path.startsWith("/deck-api/export-assets/") || /^\/deck-api\/decks\/[^/]+\/google-slides\//.test(path);
}

/** An embedded editor session authenticates with a bearer token; the web application with the cookie (deck-api.ts). */
function isEmbedded(request: IncomingMessage): boolean {
  return (request.headers.authorization ?? "").startsWith("Bearer ");
}

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Only `/decks` or `/deck/<valid id>` (the account portal's rule for `return`, SPEC.md 21.2). */
export function safeReturnPath(candidate: string | null): string {
  if (candidate === null) return "/decks";
  if (candidate === "/decks") return candidate;
  const deck = /^\/deck\/([^/?#]+)$/.exec(candidate);
  return deck?.[1] !== undefined && parseDeckId(deck[1]) !== null ? candidate : "/decks";
}

function withQuery(options: Readonly<{ path: string; key: string; value: string }>): string {
  return `${options.path}${options.path.includes("?") ? "&" : "?"}${options.key}=${encodeURIComponent(options.value)}`;
}

function exportedLink(options: Readonly<{ previous: GoogleSlidesLink | null; presentationId: string; title: string; now: number }>): GoogleSlidesLink {
  const same = options.previous?.presentationId === options.presentationId;
  return {
    presentationId: options.presentationId,
    presentationAddress: presentationAddressOf(options.presentationId),
    title: options.title,
    lastImportedAt: same ? (options.previous?.lastImportedAt ?? null) : null,
    lastExportedAt: options.now,
    importedRevisionId: same ? (options.previous?.importedRevisionId ?? null) : null,
    importedPageIds: same ? (options.previous?.importedPageIds ?? []) : [],
  };
}

/** 503 `deckUnreadable`: the deck's saved snapshot does not open or decode, so it was refused. */
function answerUnreadable(options: Readonly<{ response: ServerResponse; message: string }>): void {
  answerError({ response: options.response, status: 503, error: "deckUnreadable", message: options.message });
}

function answerImportFailure(options: Readonly<{ response: ServerResponse; outcome: Exclude<ImportOutcome, Readonly<{ kind: "imported" }>> }>): void {
  const { response, outcome } = options;
  switch (outcome.kind) {
    case "invalidPresentation":
      return answerError({ response, status: 400, error: "invalidRequest", message: outcome.message });
    case "rejected":
      return answerError({ response, status: 422, error: "invalidRequest", message: outcome.message });
    case "notPermitted":
      return answerError({ response, status: 403, error: "notPermitted", message: "You cannot edit this deck." });
    default:
      return assertNever(outcome);
  }
}

/** The HTTP status for the error code a failed Google call became (slides-client.ts googleFailureCodeOf). */
function statusOfGoogleFailure(code: DeckApiErrorCode): number {
  switch (code) {
    case "googleNotConnected":
      return 409;
    case "googlePermissionDenied":
      return 403;
    case "googlePresentationNotFound":
      return 404;
    default:
      return 502;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

