/**
 * The developer Google grant: the Desktop OAuth client in `.auth/google_oauth.json` plus the token
 * in `.auth/tokens.json` that `npx tsx .auth/generate-token.ts` writes. This is the ONE loader for
 * every devcontainer harness that talks to Google as the developer: the converter's upload, the
 * thumbnail export, the reverse round trip, the table probes and the converter calibration. The
 * product never uses it; the connector brokers a grant per user (mcp/sasha-slides/google-auth.ts).
 *
 * A leaf module (googleapis and node built-ins only), so the add-on server, the converter and the
 * calibration scripts can all import it without an import cycle.
 *
 * The refresh token expires after 7 days (the OAuth client is in Testing mode); Google then answers
 * `invalid_grant`. `isExpiredGrant` recognises that and EXPIRED_GRANT_REMEDY says what a person must
 * do; no harness re-consents by itself.
 */
import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type DevOAuthClient = InstanceType<typeof google.auth.OAuth2>;

export const DEV_AUTH_DIRECTORY = fileURLToPath(new URL("../../.auth/", import.meta.url));
export const DEV_CREDENTIALS_PATH = join(DEV_AUTH_DIRECTORY, "google_oauth.json");
export const DEV_TOKENS_PATH = join(DEV_AUTH_DIRECTORY, "tokens.json");

export const EXPIRED_GRANT_REMEDY =
  'Google refused the developer token (invalid_grant: the 7 day refresh token expired). A person must re-run "npx tsx .auth/generate-token.ts"; this pipeline does not re-consent.';

export type DevOAuthOptions = Readonly<{
  /** Write a refreshed access token back to the tokens file, merged over what was read. */
  persistRefreshedTokens: boolean;
  credentialsPath?: string;
  tokensPath?: string;
}>;

/** The developer OAuth client, with the stored token set (see the header). Throws on a malformed file. */
export function loadDevOAuthClient(options: DevOAuthOptions): DevOAuthClient {
  const credentialsPath = options.credentialsPath ?? DEV_CREDENTIALS_PATH;
  const tokensPath = options.tokensPath ?? DEV_TOKENS_PATH;
  const clientFile = readJsonObject(credentialsPath);
  const section = fieldOf(clientFile, "installed") ?? fieldOf(clientFile, "web");
  const clientId = fieldOf(section, "client_id");
  const clientSecret = fieldOf(section, "client_secret");
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new Error(`${credentialsPath}: no "installed" or "web" section with client_id + client_secret`);
  }
  const tokens = readJsonObject(tokensPath);
  if (typeof tokens["refresh_token"] !== "string" && typeof tokens["access_token"] !== "string") {
    throw new Error(`${tokensPath} holds neither a refresh nor an access token. Run: npx tsx .auth/generate-token.ts`);
  }
  // The redirect address is only used to exchange an authorisation code, which no harness does.
  const client = new google.auth.OAuth2(clientId, clientSecret, "http://localhost");
  // tokens.json is the Credentials answer generate-token.ts saved from Google, checked above to hold a token.
  client.setCredentials(tokens as Credentials);
  if (options.persistRefreshedTokens) {
    client.on("tokens", (refreshed: Credentials) => {
      writeFileSync(tokensPath, JSON.stringify({ ...tokens, ...refreshed }, null, 2));
    });
  }
  return client;
}

/** True when Google refused the refresh token (`invalid_grant`), which only a person can fix. */
export function isExpiredGrant(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("invalid_grant") || fieldOf(fieldOf(fieldOf(cause, "response"), "data"), "error") === "invalid_grant";
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path}: top level is not an object`);
  // The guard above proved a non-array object; its values stay unknown.
  return parsed as Readonly<Record<string, unknown>>;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  // The guard above proved `value` is a non-null object that has `key`; its value stays unknown.
  return (value as Readonly<Record<string, unknown>>)[key];
}
