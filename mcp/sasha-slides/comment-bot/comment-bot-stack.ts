/**
 * Wires the comment bot for `server.ts --http`: the bot over each watch owner's own Google grant
 * (`owner-drive.ts`), the `/comments/allow` page (`comment-access-page.ts`) where a user lets
 * Sasha at one deck, and the add-on's `POST /comments/access` check (`comment-access-check.ts`),
 * which asks the same per-owner Drives whether the asker's own grant already reaches the deck.
 * Always on with `--http`: it needs nothing but the connector's own OAuth
 * client and grant store. There is no shared bot account and no `--comment-bot` file any more.
 *
 * The picker on that page needs a browser API key: `SASHA_PICKER_API_KEY` (a Google Cloud API
 * key of the OAuth client's project, with the Google Picker API enabled, restricted to the
 * site). Without it the page says it is not set up, and watches still work for decks the user's
 * grant can already read (for example, ones Sasha created).
 */
import { randomBytes } from "node:crypto";
import { randomUrlSafeToken } from "../http/authorization-server";
import { DRIVE_HOOK_PATH } from "../http/http-server";
import { MCP_PATH } from "../http/oauth-metadata";
import type { GoogleClientCredentials } from "../google-auth";
import type { GoogleIdentity, RecordStore } from "../http/oauth-store";
import { exchangeAuthorizationCode } from "../google-slides/google-oauth";
import { verifyAddonIdentityToken } from "../google-slides/addon-identity";
import { createIdentityVerifier } from "../google-slides/identity-token";
import { createCommentBot, WATCH_LIFETIME_MS, type CommentBot, type CommentBotStore } from "./comment-bot";
import { createCommentAccessCheck } from "./comment-access-check";
import { allowUrlFor, COMMENTS_ALLOW_PATH, createCommentAccessPage, projectNumberOf, type CommentAccessPage, type GoogleSignIn } from "./comment-access-page";
import { googleOwnerDrives, OWNER_DRIVE_TIMEOUT_MS } from "./owner-drive";

/** `accessPage` answers both `/comments/allow*` (the picker page) and `POST /comments/access` (the add-on's check). */
export type CommentBotLoad = Readonly<{ bot: CommentBot; accessPage: CommentAccessPage; banner: readonly string[] }>;

export function loadCommentBot(
  options: Readonly<{
    publicUrl: string;
    /** The connector's registered Google redirect URI, shared with the sign-in. */
    googleCallbackUrl: string;
    googleClient: GoogleClientCredentials;
    /** `process.env.SASHA_PICKER_API_KEY`; empty or absent leaves the picker off. */
    pickerApiKey: string | undefined;
    store: CommentBotStore & Readonly<{ googleIdentities: RecordStore<GoogleIdentity> }>;
    warn: (message: string) => void;
  }>,
): CommentBotLoad {
  const { publicUrl, googleCallbackUrl, googleClient, store, warn } = options;
  const now = (): Date => new Date();
  const base = publicUrl.replace(/\/+$/, "");
  const webhookUrl = `${base}${DRIVE_HOOK_PATH}`;
  // ONE set of per-owner Drives for the bot and the add-on's check, so they share each owner's cached token.
  const drives = googleOwnerDrives({ grants: store.googleIdentities, client: googleClient, fetch, now, timeoutMs: OWNER_DRIVE_TIMEOUT_MS });
  const bot = createCommentBot({
    drives,
    store,
    webhookUrl,
    allowUrlFor: (fileId) => allowUrlFor({ publicUrl, fileId }),
    now,
    setTimer: ({ delayMs, run }) => {
      const timer = setTimeout(run, delayMs);
      // A pending sweep must not keep a shutting-down process alive.
      timer.unref();
      return { cancel: () => clearTimeout(timer) };
    },
    randomToken: () => randomBytes(24).toString("base64url"),
    warn,
  });
  const apiKey = options.pickerApiKey ?? "";
  const appId = projectNumberOf(googleClient.clientId);
  const picker = apiKey === "" || appId === null ? null : { apiKey, appId };
  const allowPage = createCommentAccessPage({
    publicUrl,
    googleCallbackUrl,
    googleClient,
    picker,
    grants: store.googleIdentities,
    signIn: googleSignIn({ client: googleClient }),
    now,
    randomToken: randomUrlSafeToken,
    warn,
  });
  const addonVerifier = createIdentityVerifier({ fetch, now: () => Date.now() });
  const accessCheck = createCommentAccessCheck({
    drives,
    verifyIdentity: (identityToken) => verifyAddonIdentityToken({ verifier: addonVerifier, identityToken, warn: (message) => warn(`comment access: ${message}`) }),
    allowUrlFor: (fileId) => allowUrlFor({ publicUrl, fileId }),
    connectUrl: `${base}${MCP_PATH}`,
    now,
    warn,
  });
  const accessPage: CommentAccessPage = {
    handleRequest: async (request) => (await allowPage.handleRequest(request)) || accessCheck.handleRequest(request),
  };
  return {
    bot,
    accessPage,
    banner: [
      `comments: on, each watch acting as its own signed-in user; Drive pushes to ${webhookUrl}`,
      `comments: watches last ${String(WATCH_LIFETIME_MS / 3_600_000)} h unless renewed; a user with no watch has no Drive channel and costs no call`,
      picker === null
        ? `comments: ${base}${COMMENTS_ALLOW_PATH} is off (set SASHA_PICKER_API_KEY${appId === null ? " and use a Web OAuth client" : ""}), so only decks a grant can already read can be watched`
        : `comments: ${base}${COMMENTS_ALLOW_PATH} opens the Google Picker for app ${appId}`,
    ],
  };
}

/** The real sign-in: the code exchange over `fetch`, then the identity token checked against Google's keys. */
function googleSignIn(options: Readonly<{ client: GoogleClientCredentials }>): GoogleSignIn {
  const { client } = options;
  const verifier = createIdentityVerifier({ fetch, now: () => Date.now() });
  return {
    finish: async ({ code, redirectAddress }) => {
      const exchanged = await exchangeAuthorizationCode({ fetch, client, code, redirectAddress, now: () => Date.now() });
      if (exchanged.kind === "failed") return { kind: "failed", reason: exchanged.message };
      if (exchanged.identityToken === null) return { kind: "failed", reason: "Google returned no identity token" };
      const verdict = await verifier.verify({ token: exchanged.identityToken, audience: client.clientId });
      if (verdict.kind === "rejected") return { kind: "failed", reason: verdict.reason };
      return {
        kind: "ok",
        subject: verdict.claims.subject,
        email: verdict.claims.email.length > 0 ? verdict.claims.email : null,
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        accessTokenExpiresAtMs: exchanged.expiresAt,
        grantedScopes: exchanged.grantedScopes,
      };
    },
  };
}
