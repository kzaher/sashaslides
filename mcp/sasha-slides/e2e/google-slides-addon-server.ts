#!/usr/bin/env npx tsx
/**
 * A LOOPBACK stand-in for the connector, for the live add-on check (never production): the Google
 * Slides interchange on decks of the real engine model (the test deck service), Google's REAL keys
 * (the identity token is verified for real), and a probe page at `/deck/<id>` in place of the web
 * application's editor, which reports what a frame inside the add-on dialog sees
 * (`location.ancestorOrigins`, its own size) back to `/probe`.
 *
 * Reached from Google's servers (Code.gs's UrlFetchApp) through a cloudflared tunnel to this port:
 *
 *   npx tsx mcp/sasha-slides/e2e/google-slides-addon-server.ts <port> <public tunnel origin> [--stand-in-handoff <presentationId>]
 *
 * `--stand-in-handoff`: measured 2026-10-15, the development deck's bound script yields NO identity
 * token (its manifest cannot gain `openid` from this browser; addon-identity.ts). With this flag a
 * handoff that carries no token is answered by this stand-in instead of the interchange: the
 * presentation is imported for real (development OAuth grant, `importIntoDeck`) and the handoff
 * answers `open` with that deck, so the dialog, the shell and the editor frame are exercised live.
 * Identity verification itself is covered by the handoff tests (google-slides/addon-handoff.test.ts).
 *
 * Logs one JSON line per event to stdout: requests, the interchange's warnings (a rejected token
 * names its audience), probe reports.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { loadClientCredentials } from "../google-auth.ts";
import { createGoogleSlidesInterchange } from "../google-slides/google-slides-interchange.ts";
import { importIntoDeck } from "../google-slides/import-into-deck.ts";
import { createSlidesClient } from "../google-slides/slides-client.ts";
import { createTestDeckService, testCaller } from "../google-slides/testing-deck-service.ts";
import { developmentGrant } from "./google-slides-development-grant.ts";
import { TIDEPOOL_TOKENS } from "../engine/src/theme/tidepool-theme.ts";

async function main(): Promise<void> {
  const [portText, publicOrigin, flag, standInPresentation] = process.argv.slice(2);
  const port = Number(portText);
  if (!Number.isInteger(port) || publicOrigin === undefined) throw new Error("usage: <port> <public origin>");
  const client = loadClientCredentials();
  if (client.kind !== "ok") throw new Error("no OAuth client");
  const service = await createTestDeckService();
  const log = (event: Readonly<Record<string, unknown>>): void => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  };
  const interchange = createGoogleSlidesInterchange({
    deckService: service,
    embedTickets: { issue: async ({ deckId }) => `development-ticket-${deckId}` },
    accounts: { accountForGoogleIdentity: async ({ subject, email }) => ({ ...testCaller(subject), person: { ...testCaller(subject).person, displayName: email } }) },
    googleGrants: { forAccount: async () => ({ kind: "notConnected", googleSubject: null }), save: async () => "saved" },
    googleClient: client.credentials,
    publicUrl: publicOrigin,
    fetch,
    now: Date.now,
    randomToken: () => randomBytes(24).toString("base64url"),
    warn: (message) => log({ warn: message }),
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", publicOrigin);
    log({ request: `${request.method ?? "GET"} ${url.pathname}` });
    response.on("finish", () => log({ answered: `${request.method ?? "GET"} ${url.pathname}`, status: response.statusCode }));
    if (url.pathname.startsWith("/deck/")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(probePage(decodeURIComponent(url.pathname.slice("/deck/".length))));
      return;
    }
    if (url.pathname === "/probe" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
      request.on("end", () => {
        log({ probe: body.slice(0, 2000) });
        response.writeHead(204);
        response.end();
      });
      return;
    }
    if (standInDeck !== null && url.pathname === "/deck-api/addon/handoff" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body || "{}");
        const token = typeof parsed === "object" && parsed !== null && "identityToken" in parsed ? parsed.identityToken : null;
        log({ standInHandoff: { identityToken: token === null ? null : "present", body: body.replace(/"bindingSecret":"[^"]+"/, '"bindingSecret":"<redacted>"').slice(0, 300) } });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ kind: "open", deckId: standInDeck, ticket: `stand-in-ticket-${standInDeck}` }));
      });
      return;
    }
    interchange
      .handleRequest({ request, response, url, caller: null })
      .then((answered) => {
        if (answered) return;
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not here");
      })
      .catch((cause: unknown) => {
        log({ error: cause instanceof Error ? cause.stack ?? cause.message : String(cause) });
        response.writeHead(500);
        response.end();
      });
  });
  const standInDeck = flag === "--stand-in-handoff" && standInPresentation !== undefined ? await importForStandIn({ service, presentationId: standInPresentation, log }) : null;
  server.listen(port, "127.0.0.1", () => log({ listening: port, publicOrigin, standInDeck }));
}

/** The development presentation, imported for real into a test deck (see the header). */
async function importForStandIn(
  options: Readonly<{ service: Awaited<ReturnType<typeof createTestDeckService>>; presentationId: string; log: (event: Readonly<Record<string, unknown>>) => void }>,
): Promise<string> {
  const grant = await developmentGrant();
  const read = await createSlidesClient({ fetch, accessToken: grant.accessToken }).getPresentation({ presentationId: options.presentationId, fields: null });
  if (read.kind !== "ok") throw new Error(`presentations.get: ${read.message}`);
  const caller = testCaller("development-owner");
  const created = await options.service.createDeck({ caller, title: "" });
  if (created.kind !== "opened") throw new Error(created.kind);
  const exported = await createSlidesClient({ fetch, accessToken: grant.accessToken }).exportPresentationPptx({ presentationId: options.presentationId });
  const imported = await importIntoDeck({
    presentationAnswer: read.body,
    deck: created.deck,
    author: { kind: "person", personId: caller.person.id },
    fetch,
    accessToken: grant.accessToken,
    pptxExport: exported.kind === "exported" ? exported.bytes : null,
    idSeed: { sessionPrefix: "StandIn0", counter: 0 },
    now: Date.now,
  });
  options.log({ standInImport: imported.kind === "imported" ? { slides: imported.report.slideCount, elements: imported.report.elementCount, losses: imported.report.losses.length } : imported });
  return created.deck.deckId;
}

/**
 * The stand-in for the editor page: Tidepool's ground and ink, the deck id it was opened on, and
 * what a frame in the add-on dialog can see of its ancestors (the measurement SPEC.md 14 item 3
 * asks for before frame-ancestors is written).
 */
function probePage(deckId: string): string {
  const safeDeckId = deckId.replace(/[^A-Za-z0-9_-]/g, "");
  const light = TIDEPOOL_TOKENS.light;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sasha editor probe</title>
<style>html,body{margin:0;height:100%;background:${light.ground};color:${light.text};font:16px/1.5 ${TIDEPOOL_TOKENS.typography.fontFamily}}
main{padding:32px}h1{font-size:28px;margin:0 0 8px}code{background:${light.secondaryButton};padding:2px 6px;border-radius:6px}</style></head>
<body><main><h1>Sasha editor frame</h1><p>Deck <code>${safeDeckId}</code>, opened inside the add-on dialog.</p><p id="seen"></p></main>
<script>
const report = { deckId: ${JSON.stringify(safeDeckId)}, ancestorOrigins: Array.from(location.ancestorOrigins || []), width: innerWidth, height: innerHeight, ticket: location.hash.startsWith("#ticket=") };
document.getElementById("seen").textContent = "Frame " + report.width + " by " + report.height + "; ancestors: " + report.ancestorOrigins.join(", ");
fetch("/probe", { method: "POST", body: JSON.stringify(report) });
parent.postMessage({ source: "sasha-editor", kind: "ready" }, "*");
</script></body></html>`;
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exit(1);
});
