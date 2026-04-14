#!/usr/bin/env npx tsx
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const presId = process.argv[2];
const htmlDir = resolve(process.argv[3]);
const outFile = resolve(process.argv[4]);

const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost");
oauth2.setCredentials(tokens);
const api = google.slides({ version: "v1", auth: oauth2 });

(async () => {
  const pres = await api.presentations.get({ presentationId: presId });
  const slideIds = (pres.data.slides || []).map(s => s.objectId!);
  writeFileSync(outFile, JSON.stringify({ htmlDir, presentationId: presId, slideIds }, null, 2));
  console.log(`Wrote ${outFile}: ${slideIds.length} slide ids`);
})();
