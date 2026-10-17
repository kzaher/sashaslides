#!/usr/bin/env npx tsx
/**
 * Mints the `--mail-sender` file: runs Google's consent screen for the `gmail.send` scope
 * alone with the Desktop OAuth client in `.auth/google_oauth.json`, and writes
 *
 *   { "clientId", "clientSecret", "refreshToken", "from" }
 *
 * to the path given, with mode 0600. Sign in as the Google account the portal's mail should
 * come from; `--from` must be that account's address or one of its Gmail "Send mail as"
 * aliases, or Gmail rewrites the From header to the account's own address.
 *
 *   npx tsx mcp/sasha-slides/e2e/gmail-sender-token.ts <output.json> --from "Sasha Slides <sasha.slides@exponent.company>" [--port 8080] [--client <oauth-client.json>]
 *
 * Then open the printed URL in a browser, consent, and Google redirects to
 * http://localhost:<port>, where this script is listening (bound to 0.0.0.0 so a port
 * forwarded from the devcontainer reaches it; see `.auth/generate-token.ts`). The container's
 * Chrome on :9223 works as well.
 *
 * REFRESH TOKEN LIFETIME: an OAuth client whose consent screen is in "Testing" publishing
 * status issues refresh tokens that expire after 7 days (Google's documented rule; this
 * repo's client shows `refresh_token_expires_in: 604799`). Mail then stops with
 * `invalid_grant` in the connector's log. For a durable sender, publish the consent screen
 * ("In production"), or re-run this script weekly.
 *
 * There is no comment bot account to mint any more: the comment bot acts as each signed-in user
 * with their own Google grant (comment-bot/owner-drive.ts), so this script only mints the mail
 * sender's file.
 *
 * The flow is authorization code + PKCE (S256) + state, written against `fetch` directly
 * so it needs no client library. Nothing secret is printed: the file is the only output.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { CLIENT_PATH, describeAuthFailure, loadClientCredentials } from "../google-auth";
import { GOOGLE_CONSENT_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../google-constants";
import { GMAIL_SEND_SCOPE, parseMailSenderConfig } from "../http/gmail-sender";

/** The consent screen is a person's pace, not a machine's: ten minutes, then give up. */
const CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

/** `clientPath` is the Desktop OAuth client to consent with; an Internal client of the sending Workspace issues refresh tokens that do not expire after 7 days. */
type Arguments = Readonly<{ outputPath: string; from: string; port: number; clientPath: string }>;

function parseArguments(argv: readonly string[]): Arguments | string {
  const positional: string[] = [];
  let from: string | null = null;
  let port = 8080;
  let clientPath = CLIENT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--from") {
      from = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--comment-bot") {
      return "--comment-bot was removed: the comment bot acts as each signed-in user, so there is no bot account to mint a token for";
    } else if (argument === "--client") {
      clientPath = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--port") {
      port = Number(argv[index + 1]);
      index += 1;
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }
  const [outputPath] = positional;
  if (outputPath === undefined || positional.length !== 1) return "give exactly one output path";
  if (from === null) return `give --from "Name <address>" (the mail sender)`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "--port must be an integer between 1 and 65535";
  if (clientPath === "") return "--client needs the path of a Desktop OAuth client JSON file";
  return { outputPath, from, port, clientPath };
}

async function main(): Promise<number> {
  const parsedArguments = parseArguments(process.argv.slice(2));
  if (typeof parsedArguments === "string") {
    process.stderr.write(`${parsedArguments}\n\nusage: npx tsx mcp/sasha-slides/e2e/gmail-sender-token.ts <output.json> --from "Name <address>" [--port 8080] [--client <oauth-client.json>]\n`);
    return 2;
  }
  const { outputPath, from, port, clientPath } = parsedArguments;
  const credentials = loadClientCredentials({ path: clientPath });
  if (credentials.kind !== "ok") {
    process.stderr.write(`${describeAuthFailure(credentials)}\n`);
    return 1;
  }
  const { clientId, clientSecret } = credentials.credentials;
  const redirectUri = `http://localhost:${String(port)}`;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = `${GOOGLE_CONSENT_ENDPOINT}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SEND_SCOPE,
    access_type: "offline",
    // Without prompt=consent Google omits the refresh token for an account that consented before.
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()}`;

  const code = await waitForCode({ port, state, redirectUri, authorizeUrl });
  if (code.kind === "failed") {
    process.stderr.write(`${code.reason}\n`);
    return 1;
  }

  const exchanged = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await exchanged.json().catch(() => null)) as Readonly<Record<string, unknown>> | null;
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : null;
  if (exchanged.status !== 200 || refreshToken === null) {
    process.stderr.write(`token exchange answered ${String(exchanged.status)} ${typeof body?.error === "string" ? body.error : "without a refresh token"}\n`);
    return 1;
  }
  const document = `${JSON.stringify({ clientId, clientSecret, refreshToken, from }, null, 2)}\n`;
  // Checked with the server's own parser, so a file that is written is a file that loads.
  const check = parseMailSenderConfig({
    text: document,
    // A refresh-token document names no key file, so a read would be a bug.
    readKeyFile: () => {
      throw new Error("a refresh-token mail sender has no key file");
    },
  });
  if (check.kind === "error") {
    process.stderr.write(`not writing ${outputPath}: ${check.message}\n`);
    return 1;
  }
  writeFileSync(outputPath, document, { encoding: "utf-8", mode: 0o600 });
  // The mode above applies only when the file is created; an existing file is narrowed too.
  chmodSync(outputPath, 0o600);
  const expiresIn = typeof body?.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : null;
  process.stdout.write(
    `Wrote ${outputPath} (mode 600). Start the connector with --mail-sender ${outputPath}.\n` +
      (expiresIn === null ? "" : `This refresh token expires in ${String(Math.round(expiresIn / 86_400))} days (the OAuth client is in Testing mode).\n`),
  );
  return 0;
}

/** Serves the redirect URI until Google sends the browser back with a code (or an error). */
function waitForCode(
  options: Readonly<{ port: number; state: string; redirectUri: string; authorizeUrl: string }>,
): Promise<Readonly<{ kind: "ok"; code: string }> | Readonly<{ kind: "failed"; reason: string }>> {
  const { redirectUri, authorizeUrl } = options;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      if (error === null && received === null) {
        response.writeHead(404).end("waiting for Google's redirect");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Done. You can close this tab.");
      clearTimeout(deadline);
      server.close();
      if (error !== null) return resolve({ kind: "failed", reason: `Google refused: ${error}` });
      if (url.searchParams.get("state") !== options.state) return resolve({ kind: "failed", reason: "state mismatch: not the redirect this run started" });
      resolve({ kind: "ok", code: received ?? "" });
    });
    const deadline = setTimeout(() => {
      server.close();
      resolve({ kind: "failed", reason: `no redirect within ${String(CONSENT_TIMEOUT_MS / 60_000)} minutes` });
    }, CONSENT_TIMEOUT_MS);
    server.listen(options.port, "0.0.0.0", () => {
      process.stdout.write(`Listening on ${redirectUri} for Google's redirect.\n\nOpen this URL, sign in as the sending (or bot) account, and allow the access asked for:\n\n${authorizeUrl}\n\n`);
    });
  });
}

void main().then((status) => {
  process.exitCode = status;
});
