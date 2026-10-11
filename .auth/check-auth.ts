#!/usr/bin/env npx tsx
/**
 * Verify that Google OAuth actually works for Slides + Drive.
 *
 *   npx tsx .auth/check-auth.ts            read-only probes (safe, touches nothing)
 *   npx tsx .auth/check-auth.ts --write    additionally create and delete a probe presentation
 *
 * Read-only mode proves: the client file parses, the token refreshes, the granted
 * scopes cover what we need, and Drive answers as a known identity.
 * `--write` additionally proves the Slides API accepts a create and Drive accepts a
 * delete — the two calls the MCP server will actually make. It cleans up after itself.
 *
 * Exits 0 only when every probe passed, so it is usable as a gate.
 *
 * Boundary note: the two files on disk are untrusted input, so they are narrowed by
 * explicit guards below. The repo has no typia/ts-patch setup, and two local JSON
 * files do not justify introducing one.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { existsSync, readFileSync } from "node:fs";

const CLIENT_PATH = "/workspaces/sashaslides/.auth/google_oauth.json";
const TOKENS_PATH = "/workspaces/sashaslides/.auth/tokens.json";

const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";
/** Either full Drive or the per-file scope satisfies what the MCP server needs. */
const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
] as const;

type InstalledClient = Readonly<{ client_id: string; client_secret: string }>;

type Probe = Readonly<{ name: string; detail: string }>;

type CheckResult =
  | Readonly<{ kind: "missing-file"; path: string; remedy: string }>
  | Readonly<{ kind: "malformed-file"; path: string; reason: string }>
  | Readonly<{ kind: "missing-scope"; granted: readonly string[]; needed: string }>
  | Readonly<{ kind: "api-error"; api: "drive" | "slides"; message: string }>
  | Readonly<{ kind: "ok"; granted: readonly string[]; expiresAt: string | null; probes: readonly Probe[] }>;

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readJsonFile(path: string): { json: Readonly<Record<string, unknown>> } | { error: string } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const record = asRecord(parsed);
    return record ? { json: record } : { error: "top level is not an object" };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function narrowInstalledClient(json: Readonly<Record<string, unknown>>): InstalledClient | null {
  // A Desktop-app client download nests under "installed"; a Web client under "web".
  const section = asRecord(json["installed"]) ?? asRecord(json["web"]);
  if (section === null) return null;
  const id = section["client_id"];
  const secret = section["client_secret"];
  return typeof id === "string" && typeof secret === "string"
    ? { client_id: id, client_secret: secret }
    : null;
}

async function probeDrive(auth: OAuth2Client): Promise<Probe | Readonly<{ error: string }>> {
  const drive = google.drive({ version: "v3", auth });
  try {
    const about = await drive.about.get({ fields: "user(emailAddress),storageQuota(limit)" });
    const email = about.data.user?.emailAddress ?? "<no email in response>";
    return { name: "drive.about.get", detail: `authenticated as ${email}` };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function probeSlidesWrite(auth: OAuth2Client): Promise<Probe | Readonly<{ error: string }>> {
  const slides = google.slides({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  const title = `sasha-auth-probe-${Date.now()}`;
  try {
    const created = await slides.presentations.create({ requestBody: { title } });
    const id = created.data.presentationId;
    if (typeof id !== "string") return { error: "presentations.create returned no presentationId" };
    // Clean up immediately; a probe must not leave files behind.
    await drive.files.delete({ fileId: id });
    return { name: "slides.presentations.create + drive.files.delete", detail: `created and deleted ${id}` };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function runCheck(options: Readonly<{ write: boolean }>): Promise<CheckResult> {
  if (!existsSync(CLIENT_PATH)) {
    return {
      kind: "missing-file",
      path: CLIENT_PATH,
      remedy:
        'Google Cloud console -> APIs & Services -> Credentials -> Create OAuth client ID -> "Desktop app", ' +
        "download the JSON and save it to this path. Enable the Google Slides API and Google Drive API on the project first.",
    };
  }
  const clientFile = readJsonFile(CLIENT_PATH);
  if ("error" in clientFile) return { kind: "malformed-file", path: CLIENT_PATH, reason: clientFile.error };
  const client = narrowInstalledClient(clientFile.json);
  if (client === null) {
    return { kind: "malformed-file", path: CLIENT_PATH, reason: 'no "installed" or "web" section with client_id + client_secret' };
  }

  if (!existsSync(TOKENS_PATH)) {
    return { kind: "missing-file", path: TOKENS_PATH, remedy: "Run: npx tsx .auth/generate-token.ts" };
  }
  const tokenFile = readJsonFile(TOKENS_PATH);
  if ("error" in tokenFile) return { kind: "malformed-file", path: TOKENS_PATH, reason: tokenFile.error };

  const scopeField = tokenFile.json["scope"];
  const granted = typeof scopeField === "string" ? scopeField.split(" ").filter(Boolean) : [];
  if (!granted.includes(SLIDES_SCOPE)) return { kind: "missing-scope", granted, needed: SLIDES_SCOPE };
  if (!DRIVE_SCOPES.some((scope) => granted.includes(scope))) {
    return { kind: "missing-scope", granted, needed: DRIVE_SCOPES.join(" or ") };
  }

  const auth = new google.auth.OAuth2(client.client_id, client.client_secret, "http://localhost:8080");
  auth.setCredentials(tokenFile.json);

  // Forces a refresh when the access token has expired; throws if the refresh token is dead,
  // which is exactly the failure we want surfaced here rather than inside the MCP server.
  try {
    await auth.getAccessToken();
  } catch (cause) {
    return { kind: "api-error", api: "drive", message: `token refresh failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const probes: Probe[] = [];
  const drive = await probeDrive(auth);
  if ("error" in drive) return { kind: "api-error", api: "drive", message: drive.error };
  probes.push(drive);

  if (options.write) {
    const slides = await probeSlidesWrite(auth);
    if ("error" in slides) return { kind: "api-error", api: "slides", message: slides.error };
    probes.push(slides);
  }

  const expiry = tokenFile.json["expiry_date"];
  const expiresAt = typeof expiry === "number" ? new Date(expiry).toISOString() : null;
  return { kind: "ok", granted, expiresAt, probes };
}

function report(result: CheckResult): number {
  switch (result.kind) {
    case "missing-file":
      console.error(`FAIL  missing ${result.path}\n      ${result.remedy}`);
      return 1;
    case "malformed-file":
      console.error(`FAIL  ${result.path} is malformed: ${result.reason}`);
      return 1;
    case "missing-scope":
      console.error(
        `FAIL  token is missing a required scope: ${result.needed}\n` +
          `      granted: ${result.granted.join(", ") || "<none>"}\n` +
          "      Re-run: npx tsx .auth/generate-token.ts",
      );
      return 1;
    case "api-error":
      console.error(`FAIL  ${result.api} API call failed: ${result.message}`);
      return 1;
    case "ok":
      console.log("OK    Google auth works.");
      console.log(`      scopes:  ${result.granted.join("\n               ")}`);
      console.log(`      expires: ${result.expiresAt ?? "<not reported; refresh token still governs>"}`);
      for (const probe of result.probes) console.log(`      probe:   ${probe.name} - ${probe.detail}`);
      if (result.probes.length === 1) console.log("      (run with --write to also prove Slides create + Drive delete)");
      return 0;
    default:
      return assertNever(result);
  }
}

// Wrapped rather than top-level await: the root package.json has no "type": "module",
// so tsx transforms this to CJS, where esbuild rejects top-level await outright.
async function main(): Promise<void> {
  process.exitCode = report(await runCheck({ write: process.argv.includes("--write") }));
}

void main();
