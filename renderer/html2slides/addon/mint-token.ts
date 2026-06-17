#!/usr/bin/env npx tsx
/**
 * mint-token.ts — scripted OAuth for the Apps Script API.
 *
 * Mints (or refreshes) /workspaces/sashaslides/.auth/tokens.json with the
 * scopes the add-on deploy pipeline needs:
 *   - script.projects   (projects.create / projects.updateContent)
 *   - presentations     (read/insert into decks)
 *   - drive             (pptx -> Slides conversion)
 *
 * It starts a localhost:8080 catcher, prints the consent URL, and (because the
 * devcontainer's Chrome on :9222 is already signed in) is meant to be driven by
 * `authorize-via-cdp.ts`, which clicks through consent so the redirect lands
 * back here automatically. No manual browser steps.
 */
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import { createServer } from "http";

const OAUTH = "/workspaces/sashaslides/.auth/google_oauth.json";
const TOKENS = "/workspaces/sashaslides/.auth/tokens.json";
const REDIRECT = "http://localhost:8080";
const SCOPES = [
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive",
  // cloud-platform lets us enable script.googleapis.com on the OAuth client's
  // GCP project via the Service Usage API — the web console is 2SV-blocked.
  "https://www.googleapis.com/auth/cloud-platform",
];

const creds = JSON.parse(readFileSync(OAUTH, "utf-8")).installed;
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT);
const authUrl = oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

// Emit the URL on its own line so the CDP driver can scrape it.
console.log("AUTH_URL=" + authUrl);

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, REDIRECT);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) { res.end("auth error: " + error); console.error("AUTH_ERROR=" + error); server.close(); process.exit(1); }
  if (!code) { res.writeHead(404); res.end("no code"); return; }
  try {
    const { tokens } = await oauth2.getToken(code);
    writeFileSync(TOKENS, JSON.stringify(tokens, null, 2));
    res.end("Tokens saved. You can close this tab.");
    console.log("TOKENS_SAVED scopes=" + tokens.scope);
    server.close();
    process.exit(0);
  } catch (e) {
    res.end("token exchange failed");
    console.error("TOKEN_EXCHANGE_FAILED=" + (e as Error).message);
    server.close();
    process.exit(1);
  }
});
server.listen(8080, () => console.log("CATCHER_LISTENING=8080"));
