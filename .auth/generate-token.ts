#!/usr/bin/env npx tsx
/**
 * Generate OAuth2 token for Google Slides/Drive API access.
 *
 * Usage:
 *   npx tsx .auth/generate-token.ts
 *
 * 1. Starts a local HTTP server on port 8080 to catch the OAuth redirect.
 *    It binds 0.0.0.0 deliberately: listen(8080) alone binds `::`, and although
 *    dual-stack still answers 127.0.0.1 inside the container, VS Code's port
 *    forwarder reads /proc/net/tcp (IPv4 only) and will not forward it — so the
 *    browser on the host never reaches the redirect and the flow hangs.
 * 2. Prints an auth URL — open it in a browser on the HOST, sign in, authorize
 * 3. Google redirects to http://localhost:8080?code=XXXXX — server captures it
 * 4. Tokens are saved to .auth/tokens.json
 *
 * Requires .auth/google_oauth.json: a "Desktop app" OAuth client downloaded from
 * the Google Cloud console, with http://localhost:8080 as an authorized redirect
 * URI. Both files are gitignored (.gitignore:37-39).
 */
import { google } from "googleapis";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "http";

const CLIENT_PATH = "/workspaces/sashaslides/.auth/google_oauth.json";
if (!existsSync(CLIENT_PATH)) {
  console.error(
    `Missing ${CLIENT_PATH}.\n\n` +
      "Google Cloud console -> APIs & Services:\n" +
      "  1. Enable the Google Slides API and the Google Drive API on the project\n" +
      "  2. Credentials -> Create OAuth client ID -> application type \"Desktop app\"\n" +
      "  3. Download the JSON and save it to the path above (it is gitignored)\n\n" +
      "Then re-run this script.",
  );
  process.exit(1);
}
// A Desktop-app download nests the client under "installed"; a Web client under "web".
const clientFile: unknown = JSON.parse(readFileSync(CLIENT_PATH, "utf-8"));
const section =
  typeof clientFile === "object" && clientFile !== null
    ? ((clientFile as Record<string, unknown>)["installed"] ?? (clientFile as Record<string, unknown>)["web"])
    : undefined;
if (typeof section !== "object" || section === null) {
  console.error(`${CLIENT_PATH} has no "installed" or "web" section — is it an OAuth client download?`);
  process.exit(1);
}
const creds = section as { client_id: string; client_secret: string };
// Google treats a Desktop ("installed") client's registered http://localhost as a loopback
// wildcard, so any port works — but the port must be reachable from the browser on the HOST.
// 8080 is not in this devcontainer's forwardPorts, so allow an override:
//   npx tsx .auth/generate-token.ts --port 8000
const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.OAUTH_PORT ?? 8080);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Bad port: ${String(PORT)}`);
  process.exit(1);
}
const REDIRECT = `http://localhost:${PORT}`;
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT);

const BASE_SCOPES = [
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive",
];

// --with-apps-script additionally requests the scopes needed to CREATE and UPDATE an Apps Script
// project through script.googleapis.com, which is what `clasp` does under the hood. That lets the
// add-on be deployed programmatically instead of by pasting into the Apps Script editor.
// The Apps Script API must also be enabled for the account at
// https://script.google.com/home/usersettings — a per-user toggle, not a project setting.
const APPS_SCRIPT_SCOPES = [
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
];

// --with-service-management additionally requests the narrow Service Usage scope, which is what
// serviceusage.services.enable needs to turn an API on for the Cloud project. It is the narrowest
// scope that works (cloud-platform would also, but grants far more than enabling one API).
const SERVICE_MANAGEMENT_SCOPES = ["https://www.googleapis.com/auth/service.management"];

const SCOPES = [
  ...BASE_SCOPES,
  ...(process.argv.includes("--with-apps-script") ? APPS_SCRIPT_SCOPES : []),
  ...(process.argv.includes("--with-service-management") ? SERVICE_MANAGEMENT_SCOPES : []),
];

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Auth failed</h1><p>${error}</p>`);
    console.error("\nAuth error:", error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(404);
    res.end("No code parameter");
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify(tokens, null, 2));

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Auth successful!</h1><p>You can close this tab. Tokens saved.</p>");

    console.log("\nTokens saved to .auth/tokens.json");
    console.log("Scopes:", tokens.scope);
    console.log("Expires:", new Date(tokens.expiry_date!).toISOString());
  } catch (err: any) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
    console.error("\nFailed to exchange code:", err.message);
  }

  server.close();
  process.exit(0);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nListening on ${REDIRECT} for OAuth redirect (bound 0.0.0.0 so the host can reach it)...`);
  console.log("\n=== Open this URL in your browser ===\n");
  console.log(authUrl);
  console.log("\n=== Authorize, then the redirect will be captured automatically ===\n");
});
