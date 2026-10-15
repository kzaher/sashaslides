/**
 * The DEVELOPMENT account's access token for the live Google Slides scripts, never production's.
 *
 * Reads the OAuth client (`.auth/google_oauth.json`) and the developer's own grant
 * (`.auth/tokens.json`, presentations + drive) and refreshes it through the same
 * `refreshAccessToken` the interchange uses, so the live scripts exercise the module's own OAuth
 * code. The refresh token expires 7 days after `.auth/generate-token.ts` ran (CLAUDE.md); an
 * `invalid_grant` here means: run it again.
 */
import { readFileSync } from "node:fs";
import { loadClientCredentials, TOKENS_PATH } from "../google-auth.ts";
import type { GoogleClientCredentials } from "../google-auth.ts";
import { refreshAccessToken } from "../google-slides/google-oauth.ts";

export type DevelopmentGrant = Readonly<{ accessToken: string; client: GoogleClientCredentials; refreshToken: string }>;

export async function developmentGrant(): Promise<DevelopmentGrant> {
  const loaded = loadClientCredentials();
  if (loaded.kind !== "ok") throw new Error(`no OAuth client: ${loaded.kind}`);
  const tokens: unknown = JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  const refreshToken = typeof tokens === "object" && tokens !== null && "refresh_token" in tokens ? tokens.refresh_token : undefined;
  if (typeof refreshToken !== "string") throw new Error(`${TOKENS_PATH} holds no refresh token`);
  const refreshed = await refreshAccessToken({ fetch, client: loaded.credentials, refreshToken, now: Date.now });
  if (refreshed.kind !== "ok") throw new Error(`refresh failed: ${refreshed.message} (re-run npx tsx .auth/generate-token.ts)`);
  return { accessToken: refreshed.accessToken, client: loaded.credentials, refreshToken };
}
