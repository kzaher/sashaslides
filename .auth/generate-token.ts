#!/usr/bin/env npx tsx
/**
 * Generate OAuth2 token for Google Slides/Drive API access.
 *
 * Usage:
 *   npx tsx .auth/generate-token.ts
 *
 * 1. Prints an auth URL — open it in a browser, sign in, authorize
 * 2. Google redirects to http://localhost?code=XXXXX (will fail to load — that's fine)
 * 3. Copy the `code` parameter from the URL bar
 * 4. Paste it when prompted
 * 5. Tokens are saved to .auth/tokens.json
 */
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";

const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost");

const SCOPES = [
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive",
];

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log("\n=== Open this URL in your browser ===\n");
console.log(authUrl);
console.log("\n=== After authorizing, copy the 'code' param from the redirect URL ===\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste the code here: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2.getToken(code.trim());
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify(tokens, null, 2));
    console.log("\nTokens saved to .auth/tokens.json");
    console.log("Scopes:", tokens.scope);
    console.log("Expires:", new Date(tokens.expiry_date!).toISOString());
  } catch (err: any) {
    console.error("Failed to exchange code:", err.message);
    process.exit(1);
  }
});
