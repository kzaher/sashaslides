/**
 * Loading and refreshing the Google OAuth client the MCP server and the auth
 * diagnostic both use.
 *
 * Credentials live in two gitignored files (.gitignore:37-39):
 *   .auth/google_oauth.json   the OAuth client downloaded from the Google Cloud console
 *   .auth/tokens.json         the user's tokens, written by .auth/generate-token.ts
 *
 * Both are untrusted input as far as the type system is concerned, so they are
 * narrowed by explicit guards here and never flow outward as `unknown`. The repo has
 * no typia/ts-patch setup and two local JSON files do not justify adding one.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { existsSync, readFileSync } from "node:fs";

export const CLIENT_PATH = "/workspaces/sashaslides/.auth/google_oauth.json";
export const TOKENS_PATH = "/workspaces/sashaslides/.auth/tokens.json";

/** The redirect the client is registered with; must match generate-token.ts. */
const REDIRECT_URI = "http://localhost:8080";

export const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";

/**
 * Either scope lets the server create and read its own staging files. `drive.file` is
 * non-sensitive and is what a published connector should ask for; full `drive` is a
 * restricted scope needing app verification plus a security assessment when a server
 * transmits the data. We accept whichever the user granted.
 */
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
] as const;

export type AuthFailure =
  | Readonly<{ kind: "missing-file"; path: string; remedy: string }>
  | Readonly<{ kind: "malformed-file"; path: string; reason: string }>
  | Readonly<{ kind: "missing-scope"; granted: readonly string[]; needed: string }>
  | Readonly<{ kind: "refresh-failed"; message: string }>;

export type AuthLoad =
  | Readonly<{ kind: "ok"; auth: OAuth2Client; granted: readonly string[]; expiresAt: string | null }>
  | AuthFailure;

export function describeAuthFailure(failure: AuthFailure): string {
  switch (failure.kind) {
    case "missing-file":
      return `missing ${failure.path} — ${failure.remedy}`;
    case "malformed-file":
      return `${failure.path} is malformed: ${failure.reason}`;
    case "missing-scope":
      return `token is missing a required scope: ${failure.needed} (granted: ${failure.granted.join(", ") || "<none>"}). Re-run: npx tsx .auth/generate-token.ts`;
    case "refresh-failed":
      return `token refresh failed: ${failure.message}. Re-run: npx tsx .auth/generate-token.ts`;
    default:
      return assertNever(failure);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

type ReadJson = Readonly<{ json: Readonly<Record<string, unknown>> }> | Readonly<{ error: string }>;

function readJsonObject(path: string): ReadJson {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const record = asRecord(parsed);
    return record !== null ? { json: record } : { error: "top level is not an object" };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** A Desktop-app client download nests under "installed"; a Web client under "web". */
function narrowClient(
  json: Readonly<Record<string, unknown>>,
): Readonly<{ clientId: string; clientSecret: string }> | null {
  const section = asRecord(json["installed"]) ?? asRecord(json["web"]);
  if (section === null) return null;
  const id = section["client_id"];
  const secret = section["client_secret"];
  return typeof id === "string" && typeof secret === "string" ? { clientId: id, clientSecret: secret } : null;
}

/** The client id/secret half of `.auth/google_oauth.json`, with no user token involved. */
export type GoogleClientCredentials = Readonly<{ clientId: string; clientSecret: string }>;

export type ClientCredentialsLoad =
  | Readonly<{ kind: "ok"; credentials: GoogleClientCredentials }>
  | AuthFailure;

/**
 * Reads only the OAuth *client* (the application's identity), never a user token.
 *
 * The remote server in `http/` needs exactly this and nothing else: it is a Google OAuth
 * client acting on behalf of whichever user is signing in, so `.auth/tokens.json` — one
 * developer's personal grant — must never be on that path.
 */
export function loadClientCredentials(): ClientCredentialsLoad {
  if (!existsSync(CLIENT_PATH)) {
    return {
      kind: "missing-file",
      path: CLIENT_PATH,
      remedy:
        'Google Cloud console -> APIs & Services -> Credentials -> Create OAuth client ID -> "Desktop app", ' +
        "download the JSON to this path. Enable the Google Slides API and Google Drive API on the project first.",
    };
  }
  const clientFile = readJsonObject(CLIENT_PATH);
  if ("error" in clientFile) return { kind: "malformed-file", path: CLIENT_PATH, reason: clientFile.error };
  const credentials = narrowClient(clientFile.json);
  if (credentials === null) {
    return {
      kind: "malformed-file",
      path: CLIENT_PATH,
      reason: 'no "installed" or "web" section with client_id + client_secret',
    };
  }
  return { kind: "ok", credentials };
}

/**
 * The single-token dev path: client plus `.auth/tokens.json`, i.e. whoever ran
 * `generate-token.ts`. Used by `--stdio` only; the remote server brokers per user instead.
 */
export async function loadOAuthClient(): Promise<AuthLoad> {
  const loadedClient = loadClientCredentials();
  if (loadedClient.kind !== "ok") return loadedClient;
  const client = loadedClient.credentials;

  if (!existsSync(TOKENS_PATH)) {
    return { kind: "missing-file", path: TOKENS_PATH, remedy: "Run: npx tsx .auth/generate-token.ts" };
  }
  const tokenFile = readJsonObject(TOKENS_PATH);
  if ("error" in tokenFile) return { kind: "malformed-file", path: TOKENS_PATH, reason: tokenFile.error };

  const scopeField = tokenFile.json["scope"];
  const granted = typeof scopeField === "string" ? scopeField.split(" ").filter(Boolean) : [];
  if (!granted.includes(SLIDES_SCOPE)) return { kind: "missing-scope", granted, needed: SLIDES_SCOPE };
  if (!DRIVE_SCOPES.some((scope) => granted.includes(scope))) {
    return { kind: "missing-scope", granted, needed: DRIVE_SCOPES.join(" or ") };
  }

  const auth = new google.auth.OAuth2(client.clientId, client.clientSecret, REDIRECT_URI);
  auth.setCredentials(tokenFile.json);

  // Forces a refresh when the access token has expired, so a dead refresh token surfaces
  // here rather than inside a tool call.
  try {
    await auth.getAccessToken();
  } catch (cause) {
    return { kind: "refresh-failed", message: cause instanceof Error ? cause.message : String(cause) };
  }

  const expiry = tokenFile.json["expiry_date"];
  return { kind: "ok", auth, granted, expiresAt: typeof expiry === "number" ? new Date(expiry).toISOString() : null };
}
