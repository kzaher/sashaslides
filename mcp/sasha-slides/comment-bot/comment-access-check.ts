/**
 * `POST /comments/access`: the "Ask Sasha" sidebar asks whether Sasha can already read and answer
 * the comments on the open deck WITH THE USER'S OWN GOOGLE GRANT, so it can offer the one-click
 * `/comments/allow` page before the user ever asks an assistant to watch the deck.
 *
 * WHO IS ASKING is proven the way the editor handoff proves it (google-slides/addon-identity.ts):
 * Code.gs sends `ScriptApp.getIdentityToken()`, checked against Google's keys and the pinned Apps
 * Script audience, plus the presentation's binding secret (only its editors can read it). The
 * token's Google SUBJECT is the only key into the grant store, so the answer is always about the
 * asker's own grant: no other user's grant is ever looked up, whoever else watches the deck.
 *
 * ONE CHEAP DRIVE CALL: `files.get` with `capabilities/canComment` (`OwnerDrive.getFile`, the same
 * call `watch_comments` starts with in comment-bot.ts, so the two can never disagree). Under
 * `drive.file` Drive answers 404 for a deck not yet chosen in the picker, which is `needsAllow`;
 * a readable deck the user may not comment on is `viewOnly`. A grant whose scopes hold no Drive
 * access at all is `needsAllow` without any call (the allow page asks for drive.file).
 *
 * RATE LIMITED PER GOOGLE SUBJECT, after the identity check (so the key is a verified subject and
 * cannot be churned): the sidebar asks once per open and once when the user comes back from the
 * allow page, so the limit is far above honest use and only stops a loop.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MINIMUM_BINDING_SECRET_LENGTH } from "../google-slides/addon-identity";
import { answerError, answerWithBody, readRequestBody, stringFieldOf } from "../google-slides/http-answers";
import type { IdentityClaims } from "../google-slides/identity-token";
import { assertNever } from "../google-auth";
import { createThrottle, type ThrottleRule } from "../http/request-throttle";
import { parseDeckId } from "./comment-bot";
import { COMMENT_ACCESS_PATH, type CommentAccessAnswer } from "./comment-access-contract";
import type { OwnerDrives } from "./owner-drive";

/** Far above one check per sidebar open; a reducer loop stops here instead of at Google's quota. */
export const COMMENT_ACCESS_RULE: ThrottleRule = { name: "comment access check", limit: 30, windowMs: 10 * 60 * 1000 };

export type CommentAccessCheck = Readonly<{
  /** Answers `POST /comments/access`; false for every other path. */
  handleRequest(options: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL }>): Promise<boolean>;
}>;

/** What the check found: an answer for the sidebar, or a Drive failure it cannot classify. */
export type CommentAccessOutcome = Readonly<{ kind: "answered"; answer: CommentAccessAnswer }> | Readonly<{ kind: "driveFailed"; reason: string }>;

export function createCommentAccessCheck(
  options: Readonly<{
    /** The same per-owner Drives the comment bot uses: only the asker's own grant is ever opened. */
    drives: OwnerDrives;
    /** The add-on's identity token to its verified claims, or null (addon-identity.ts `verifyAddonIdentityToken`). */
    verifyIdentity: (identityToken: string) => Promise<IdentityClaims | null>;
    /** The `/comments/allow?deck=<id>` page for a deck. */
    allowUrlFor: (fileId: string) => string;
    /** Where a Google account with no grant connects Sasha Slides: the connector's MCP address. */
    connectUrl: string;
    now: () => Date;
    warn: (message: string) => void;
  }>,
): CommentAccessCheck {
  const { drives, verifyIdentity, allowUrlFor, connectUrl, warn } = options;
  const throttle = createThrottle({ now: options.now, maxKeys: MAX_THROTTLE_KEYS });

  return {
    handleRequest: async ({ request, response, url }) => {
      if (url.pathname.replace(/\/+$/, "") !== COMMENT_ACCESS_PATH) return false;
      if ((request.method ?? "GET") !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return true;
      }
      const body = await readRequestBody({ request, maximumBytes: REQUEST_BODY_LIMIT_BYTES });
      if (body.kind !== "parsed") {
        answerError({ response, status: body.kind === "tooLarge" ? 413 : 400, error: body.kind === "tooLarge" ? "tooLarge" : "invalidRequest", message: "The check is not JSON." });
        return true;
      }
      const identityToken = stringFieldOf(body.value, "identityToken");
      const bindingSecret = stringFieldOf(body.value, "bindingSecret");
      const fileId = parseDeckId(stringFieldOf(body.value, "presentationId") ?? "");
      if (identityToken === null || fileId === null || bindingSecret === null || bindingSecret.length < MINIMUM_BINDING_SECRET_LENGTH) {
        answerError({ response, status: 400, error: "invalidRequest", message: "The check needs an identity token, the presentation and its binding secret." });
        return true;
      }
      const claims = await verifyIdentity(identityToken);
      if (claims === null) {
        answerError({ response, status: 401, error: "addonIdentityRejected", message: "Sign in again: Google did not vouch for this request." });
        return true;
      }
      const admitted = throttle.admit({ checks: [{ rule: COMMENT_ACCESS_RULE, key: claims.subject }] });
      if (admitted.kind === "refused") {
        answerError({ response, status: 429, error: "rateLimited", message: "Too many checks; try again in a few minutes." });
        return true;
      }
      const outcome = await commentAccessFor({ drives, ownerSubject: claims.subject, fileId, allowUrlFor, connectUrl });
      switch (outcome.kind) {
        case "answered":
          answerWithBody({ response, status: 200, body: outcome.answer });
          return true;
        case "driveFailed":
          warn(`comment access: the check could not reach Drive: ${outcome.reason}`);
          answerError({ response, status: 502, error: "googleFailed", message: "Google Drive did not answer; try again later." });
          return true;
        default:
          return assertNever(outcome);
      }
    },
  };
}

/**
 * The check itself, over the asker's own Drive: at most one Drive request (plus a token refresh
 * when the stored access token is due). Mirrors `watch` in comment-bot.ts.
 */
export async function commentAccessFor(
  options: Readonly<{ drives: OwnerDrives; ownerSubject: string; fileId: string; allowUrlFor: (fileId: string) => string; connectUrl: string }>,
): Promise<CommentAccessOutcome> {
  const { drives, ownerSubject, fileId, allowUrlFor, connectUrl } = options;
  const notConnected: CommentAccessOutcome = { kind: "answered", answer: { access: "notConnected", connectUrl, explanation: NOT_CONNECTED_EXPLANATION } };
  const needsAllow: CommentAccessOutcome = { kind: "answered", answer: { access: "needsAllow", allowUrl: allowUrlFor(fileId) } };
  const lookup = await drives.forOwner({ ownerSubject });
  if (lookup.kind === "no-grant") return notConnected;
  if (lookup.scopeAccess === "missing") return needsAllow;
  const file = await lookup.drive.getFile({ fileId });
  if (file.kind === "failed") {
    // 404 is what Drive answers for a file this grant cannot see: under `drive.file`, a deck not
    // yet chosen in the picker. 401 is a grant Google no longer honours (owner-drive.ts).
    if (file.status === 404 || file.status === 403) return needsAllow;
    if (file.status === 401) return notConnected;
    return { kind: "driveFailed", reason: file.reason };
  }
  return { kind: "answered", answer: file.value.canComment ? { access: "ready" } : { access: "viewOnly" } };
}

const NOT_CONNECTED_EXPLANATION =
  "This Google account has not connected Sasha Slides to an assistant yet, or its sign-in has expired. " +
  "Connect Sasha Slides with this Google account, then open Ask Sasha again.";

/** An identity token is about 1 KB; the body is three short strings. */
const REQUEST_BODY_LIMIT_BYTES = 16 * 1024;
/** One key per verified Google subject; beyond this the oldest are forgotten (request-throttle.ts). */
const MAX_THROTTLE_KEYS = 10_000;
