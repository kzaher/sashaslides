// THE GOOGLE CLIENT FILE IS CHOSABLE: production uses a Web client (.auth/google_oauth_web.json),
// while the local stdio mode and the token script keep the Desktop client at .auth/google_oauth.json.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLIENT_PATH, loadClientCredentials } from "../google-auth.ts";
import { parseServerMode } from "../server.ts";

test("loadClientCredentials reads the file it is given, Web or Desktop shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "sasha-client-"));
  const web = join(dir, "web.json");
  writeFileSync(web, JSON.stringify({ web: { client_id: "web-id", client_secret: "web-secret" } }));
  const loaded = loadClientCredentials({ path: web });
  assert.equal(loaded.kind, "ok");
  assert.equal(loaded.kind === "ok" ? loaded.credentials.clientId : null, "web-id");

  const missing = loadClientCredentials({ path: join(dir, "absent.json") });
  assert.equal(missing.kind, "missing-file");
  assert.equal("path" in missing ? missing.path : null, join(dir, "absent.json"), "the error names the file that was asked for");
});

test("--google-client picks the file for --http mode, and the default stays the Desktop client path", () => {
  const base = ["--http", "--public-url", "https://sashaslides.com"];
  const chosen = parseServerMode([...base, "--google-client", "/secrets/web.json"]);
  assert.equal(chosen.kind, "http");
  assert.equal(chosen.kind === "http" ? chosen.googleClientPath : null, "/secrets/web.json");
  const fallback = parseServerMode(base);
  assert.equal(fallback.kind === "http" ? fallback.googleClientPath : null, CLIENT_PATH);
});
