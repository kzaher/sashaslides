#!/usr/bin/env npx tsx
/**
 * Generate OAuth2 token for Google Slides/Drive API access.
 *
 * Usage:
 *   npx tsx .auth/generate-token.ts
 *
 * 1. Starts a local HTTP server on port 80 to catch the OAuth redirect
 * 2. Prints an auth URL — open it in a browser, sign in, authorize
 * 3. Google redirects to http://localhost?code=XXXXX — server captures it
 * 4. Tokens are saved to .auth/tokens.json
 */
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import { createServer } from "http";

const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");

const SCOPES = [
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive",
];

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost:8080");
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

server.listen(8080, () => {
  console.log("\nListening on http://localhost:8080 for OAuth redirect...");
  console.log("\n=== Open this URL in your browser ===\n");
  console.log(authUrl);
  console.log("\n=== Authorize, then the redirect will be captured automatically ===\n");
});
